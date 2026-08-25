// @ts-nocheck — plain multi-file classic-script app; globals (VMDB/VMScanner/VMTranscoder/tf/nsfwjs) are wired via <script> load order, not modules.
(function () {
  const DEFAULT_SETTINGS = {
    sensitivity: 0.6,
    blurAdvance: 1.5,
    rememberState: true,
    scanInterval: 1,
    adaptiveScan: true,
    // "nsfwjs": NSFWJS only. "confirm": NSFWJS scans, NudeNet double-checks what it flags.
    // "nudenet": NudeNet is the primary/only classifier for every sampled frame.
    detectionMode: "confirm",
    // When NudeNet is involved (confirm/nudenet modes), classify every candidate/fine
    // sample individually instead of a few representatives with the rest propagated —
    // exact scene-boundary timing at the cost of more NudeNet calls. Off by default since
    // it's slower; irrelevant to plain "nsfwjs" mode.
    nudenetExactTiming: false,
  };

  /** @type {Record<string, any>} */
  const els = {};
  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let activeVideo = null; // { fileName, file, handle, samples, interval, duration, segments }
  let currentObjectUrl = null;
  let cancelToken = null;
  let transcodeCancelToken = null;
  let pendingExisting = null;
  let pendingTranscodeResolve = null;
  let lastPersistAt = 0;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheEls();
    wireStaticUI();

    settings = await loadSettings();
    applySettingsToInputs();

    if (settings.rememberState) {
      await attemptResume();
    }
  }

  function cacheEls() {
    [
      "settingsBtn", "openFileBtn",
      "startScreen", "pickFileBtn", "resumeBox", "resumeText", "resumeBtn", "resumeDismissBtn",
      "scanScreen", "scanProgressBar", "scanProgressText", "scanStatusText", "cancelScanBtn",
      "transcodeScreen", "transcodeProgressBar", "transcodeProgressText", "transcodeStatusText", "cancelTranscodeBtn",
      "playerScreen", "video", "blurBadge", "audioTrackSelect", "fileNameLabel",
      "fileInput",
      "existingDialogOverlay", "existingFileName", "useExistingBtn", "rescanBtn",
      "transcodeWarningOverlay", "transcodeWarningTitle", "transcodeReasonText", "transcodeFileName",
      "transcodeReasonSuffix", "transcodeConfirmBtn", "transcodeCancelBtn",
      "settingsDialogOverlay", "sensitivityInput", "sensitivityValue", "blurAdvanceInput",
      "scanIntervalInput", "scanIntervalComputedHint", "adaptiveScanInput", "rememberStateInput", "closeSettingsBtn",
      "modeNsfwjsInput", "modeConfirmInput", "modeNudenetInput", "nudenetExactTimingInput",
    ].forEach((id) => { els[id] = document.getElementById(id); });
    els.detectionModeInputs = [els.modeNsfwjsInput, els.modeConfirmInput, els.modeNudenetInput];
  }

  function wireStaticUI() {
    els.pickFileBtn.addEventListener("click", () => pickVideoFile().then((picked) => picked && openFileFlow(picked.file, picked.handle)));
    els.openFileBtn.addEventListener("click", () => pickVideoFile().then((picked) => picked && openFileFlow(picked.file, picked.handle)));

    els.settingsBtn.addEventListener("click", openSettingsDialog);
    els.closeSettingsBtn.addEventListener("click", closeSettingsDialog);
    els.settingsDialogOverlay.addEventListener("click", (e) => {
      if (e.target === els.settingsDialogOverlay) closeSettingsDialog();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !els.settingsDialogOverlay.classList.contains("hidden")) {
        closeSettingsDialog();
      }
    });

    els.audioTrackSelect.addEventListener("change", onAudioTrackSelectChange);
    // `video.audioTracks` is one persistent AudioTrackList tied to the element (the browser
    // clears/repopulates it in place whenever a new src loads), so these listeners only need
    // wiring once here — re-adding them per video load would just stack duplicate handlers.
    if (els.video.audioTracks) {
      els.video.audioTracks.addEventListener("addtrack", renderAudioTracks);
      els.video.audioTracks.addEventListener("removetrack", renderAudioTracks);
    }

    els.sensitivityInput.addEventListener("input", onSensitivityChange);
    els.blurAdvanceInput.addEventListener("change", onBlurAdvanceChange);
    els.scanIntervalInput.addEventListener("change", onScanIntervalChange);
    els.scanIntervalInput.addEventListener("input", updateScanIntervalComputedHint);
    els.adaptiveScanInput.addEventListener("change", onAdaptiveScanChange);
    els.detectionModeInputs.forEach((input) => input.addEventListener("change", onDetectionModeChange));
    els.nudenetExactTimingInput.addEventListener("change", onNudenetExactTimingChange);
    els.rememberStateInput.addEventListener("change", onRememberStateChange);

    els.useExistingBtn.addEventListener("click", async () => {
      const cb = pendingExisting && pendingExisting.onUseExisting;
      hideExistingDialog();
      if (cb) await cb();
    });
    els.rescanBtn.addEventListener("click", async () => {
      const cb = pendingExisting && pendingExisting.onRescan;
      hideExistingDialog();
      if (cb) await cb();
    });

    els.cancelScanBtn.addEventListener("click", () => {
      if (cancelToken) cancelToken.cancel();
    });
    els.cancelTranscodeBtn.addEventListener("click", () => {
      if (transcodeCancelToken) transcodeCancelToken.cancel();
    });

    els.transcodeConfirmBtn.addEventListener("click", () => {
      hideTranscodeWarningDialog();
      resolveTranscodeDecision(true);
    });
    els.transcodeCancelBtn.addEventListener("click", () => {
      hideTranscodeWarningDialog();
      resolveTranscodeDecision(false);
    });

    els.video.addEventListener("timeupdate", onVideoTimeUpdate);
    els.video.addEventListener("pause", () => maybePersistState(true));
    els.video.addEventListener("seeked", () => maybePersistState(true));
    window.addEventListener("beforeunload", () => maybePersistState(true));
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) maybePersistState(true);
    });
  }

  // ---------- settings ----------

  async function loadSettings() {
    const s = await VMDB.get("settings", "app");
    const merged = Object.assign({}, DEFAULT_SETTINGS, s || {});
    // Migrate the old boolean setting (pre-"NudeNet only" mode) to the new 3-way mode.
    if (s && !("detectionMode" in s) && "nudeNetConfirm" in s) {
      merged.detectionMode = s.nudeNetConfirm ? "confirm" : "nsfwjs";
    }
    delete merged.nudeNetConfirm;
    return merged;
  }

  async function persistSettings() {
    await VMDB.put("settings", Object.assign({ id: "app" }, settings));
  }

  function applySettingsToInputs() {
    els.sensitivityInput.value = settings.sensitivity;
    els.sensitivityValue.textContent = settings.sensitivity.toFixed(2);
    els.blurAdvanceInput.value = settings.blurAdvance;
    els.scanIntervalInput.value = settings.scanInterval;
    els.adaptiveScanInput.checked = !!settings.adaptiveScan;
    els.detectionModeInputs.forEach((input) => { input.checked = input.value === settings.detectionMode; });
    els.nudenetExactTimingInput.checked = !!settings.nudenetExactTiming;
    els.rememberStateInput.checked = !!settings.rememberState;
    updateScanIntervalComputedHint();
  }

  // Shows the actual gap each pass of an adaptive scan will use, computed from whatever's
  // currently typed in the scan-interval field (not just the last-saved setting) — the
  // formula itself lives in VMScanner.computeCoarseInterval so this can't drift from what
  // scanAdaptive actually does. Bound to the input's "input" event so it updates live as the
  // user types, before the value is even committed via "change"/persistSettings.
  function updateScanIntervalComputedHint() {
    const v = parseFloat(els.scanIntervalInput.value);
    const fineInterval = isFinite(v) && v >= 0.1 ? v : DEFAULT_SETTINGS.scanInterval;
    if (!els.adaptiveScanInput.checked) {
      els.scanIntervalComputedHint.textContent = `Applied everywhere: every ${fineInterval}s.`;
      return;
    }
    const coarseInterval = VMScanner.computeCoarseInterval(fineInterval);
    els.scanIntervalComputedHint.textContent =
      `1st pass (whole video): every ${coarseInterval.toFixed(2)}s. ` +
      `2nd pass (regions it flags): every ${fineInterval}s.`;
  }

  function openSettingsDialog() {
    applySettingsToInputs();
    els.settingsDialogOverlay.classList.remove("hidden");
  }

  function closeSettingsDialog() {
    els.settingsDialogOverlay.classList.add("hidden");
  }

  function onSensitivityChange(e) {
    settings.sensitivity = parseFloat(e.target.value);
    els.sensitivityValue.textContent = settings.sensitivity.toFixed(2);
    persistSettings();
    recomputeActiveSegments();
  }

  function onBlurAdvanceChange(e) {
    const v = parseFloat(e.target.value);
    settings.blurAdvance = isFinite(v) && v >= 0 ? v : 0;
    els.blurAdvanceInput.value = settings.blurAdvance;
    persistSettings();
  }

  function onScanIntervalChange(e) {
    const v = parseFloat(e.target.value);
    settings.scanInterval = isFinite(v) && v >= 0.1 ? v : DEFAULT_SETTINGS.scanInterval;
    els.scanIntervalInput.value = settings.scanInterval;
    persistSettings();
    updateScanIntervalComputedHint();
  }

  function onAdaptiveScanChange(e) {
    settings.adaptiveScan = !!e.target.checked;
    persistSettings();
    updateScanIntervalComputedHint();
  }

  function onDetectionModeChange(e) {
    if (!e.target.checked) return;
    settings.detectionMode = e.target.value;
    persistSettings();
  }

  function onNudenetExactTimingChange(e) {
    settings.nudenetExactTiming = !!e.target.checked;
    persistSettings();
  }

  function onRememberStateChange(e) {
    settings.rememberState = !!e.target.checked;
    persistSettings();
  }

  function recomputeActiveSegments() {
    if (!activeVideo) return;
    activeVideo.segments = VMScanner.mergeSegments(activeVideo.samples, settings.sensitivity, activeVideo.interval);
  }

  // ---------- file picking ----------

  async function pickVideoFile() {
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: "Video", accept: { "video/*": [".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".ogv"] } }],
          multiple: false,
        });
        const file = await handle.getFile();
        return { file, handle };
      } catch (e) {
        if (e && e.name === "AbortError") return null;
        console.warn("showOpenFilePicker failed, falling back to <input type=file>", e);
      }
    }
    return new Promise((resolve) => {
      els.fileInput.value = "";
      els.fileInput.onchange = () => {
        const file = els.fileInput.files && els.fileInput.files[0];
        resolve(file ? { file, handle: null } : null);
      };
      els.fileInput.click();
    });
  }

  // Scanning only ever seeks a hidden <video> element and grabs canvas frames — it never
  // touches audio — so a file whose video decodes fine but whose audio codec doesn't (the
  // common case: an AC3/EAC3 track Chrome has no decoder for) doesn't need transcoding
  // before it can be scanned at all. Only fix what's actually needed, when it's needed:
  //   1. If the video/container itself can't be decoded, that has to be fixed before
  //      scanning can happen at all (ensureVideoScannable, below) — full re-encode.
  //   2. If audio is the only problem, scan the original file straight away, and only ask
  //      about fixing audio afterward, right before showing the player (see
  //      finalizeAndLoadPlayer) — fast, lossless, and skipped entirely if the user declines.
  async function openFileFlow(file, handle) {
    if (!file) return;
    const originalName = file.name;

    const gate = await ensureVideoScannable(file, handle);
    if (!gate) {
      showStartScreen();
      return;
    }
    const { file: scanFile, handle: scanHandle, audioAlreadyOk } = gate;

    const existing = await VMDB.get("videos", originalName);
    if (existing && existing.samples && existing.samples.length) {
      showExistingDialog(
        originalName,
        () => usePreScanned(scanFile, scanHandle, existing, 0, true, audioAlreadyOk),
        () => startScan(scanFile, scanHandle, originalName, audioAlreadyOk)
      );
    } else {
      await startScan(scanFile, scanHandle, originalName, audioAlreadyOk);
    }
  }

  // ---------- format compatibility / ffmpeg transcode ----------

  // Gate for whether `file` can even be scanned (audio doesn't matter here — see comment
  // above). Returns { file, handle, audioAlreadyOk } — `file`/`handle` are either the
  // originals (video already fine) or a freshly full-transcoded replacement; `audioAlreadyOk`
  // tells callers whether the later audio-specific check (finalizeAndLoadPlayer) can be
  // skipped, since a full transcode fixes audio too. Returns null if the video can't be
  // played and the user declined to convert it.
  async function ensureVideoScannable(file, handle) {
    let result = { ok: false, videoOk: false };
    try {
      result = await VMTranscoder.checkPlayability(file);
    } catch (e) {
      console.warn("Playability check failed, assuming not playable.", e);
    }
    if (result.videoOk) return { file, handle, audioAlreadyOk: result.ok };

    const confirmed = await showTranscodeWarningDialog(file.name, false);
    if (!confirmed) return null;

    const refreshedFile = await refreshFileHandle(file, handle);
    const transcodeResult = await runTranscode(refreshedFile, false);
    if (!transcodeResult) return null;
    return { file: transcodeResult.file, handle: transcodeResult.handle, audioAlreadyOk: true };
  }

  // A File obtained from FileSystemFileHandle.getFile() (the resume-last-video path) can go
  // stale — reading its bytes fails with "File could not be read! Code=-1" — once too much
  // wall-clock time passes between getFile() and the actual read. checkPlayability's own
  // playback probe plus a warning dialog waiting on the user is exactly that kind of
  // open-ended delay (reproduced directly: worked before the probe/dialog were added, broke
  // after). Re-fetching right before the read that actually needs the bytes avoids it.
  async function refreshFileHandle(file, handle) {
    if (!handle) return file;
    try {
      return await handle.getFile();
    } catch (e) {
      console.warn("Could not refresh file handle before transcoding, using original snapshot.", e);
      return file;
    }
  }

  function showTranscodeWarningDialog(fileName, audioOnly) {
    els.transcodeFileName.textContent = fileName;
    if (audioOnly) {
      els.transcodeWarningTitle.textContent = "Audio format not supported";
      els.transcodeReasonText.textContent = "Your browser can play the video in";
      els.transcodeReasonSuffix.textContent =
        "but not its audio track (unsupported audio codec). Only the audio needs to be " +
        "converted — the video stays untouched, so this should be quick — done locally in " +
        "your browser using FFmpeg. Nothing is uploaded anywhere.";
    } else {
      els.transcodeWarningTitle.textContent = "Format not supported for playback";
      els.transcodeReasonText.textContent = "Your browser can't play";
      els.transcodeReasonSuffix.textContent =
        "directly (unsupported container/codec). It can be converted to MP4 (H.264/AAC) " +
        "locally in your browser using FFmpeg before scanning and playback. This runs " +
        "entirely on your device — nothing is uploaded anywhere — but it can take a while " +
        "for large files.";
    }
    els.transcodeWarningOverlay.classList.remove("hidden");
    return new Promise((resolve) => {
      pendingTranscodeResolve = resolve;
    });
  }

  function hideTranscodeWarningDialog() {
    els.transcodeWarningOverlay.classList.add("hidden");
  }

  function resolveTranscodeDecision(confirmed) {
    const resolve = pendingTranscodeResolve;
    pendingTranscodeResolve = null;
    if (resolve) resolve(confirmed);
  }

  // Returns { file, handle, savedToDisk } on success, or null if cancelled/failed.
  async function runTranscode(file, audioOnly) {
    // Best-effort: let the user pick where the transcoded output is saved on disk instead of
    // it only ever existing as an in-memory Blob for the rest of the session — meaningful for
    // a large file. Called as the very first thing here (right after the "Transcode" button's
    // click resolves the warning dialog's promise) to stay as close as possible to the
    // original user gesture, since file-picker APIs generally need one. If the picker isn't
    // available, the user cancels it, or it fails for any reason, this just falls back to
    // keeping the result in memory — same as before this feature existed.
    let saveHandle = null;
    if (window.showSaveFilePicker) {
      try {
        const ext = audioOnly ? extOf(file.name) : ".mp4";
        const suggestedName = baseName(file.name) + ext;
        const mimeType = audioOnly ? (file.type || "video/x-matroska") : "video/mp4";
        saveHandle = await window.showSaveFilePicker({
          suggestedName,
          types: [{ description: "Video", accept: { [mimeType]: [ext] } }],
        });
      } catch (e) {
        if (e && e.name !== "AbortError") {
          console.warn("Save-location picker failed, keeping transcoded file in memory instead.", e);
        }
        saveHandle = null;
      }
    }

    showTranscodeScreen();
    transcodeCancelToken = VMTranscoder.createCancelToken();
    try {
      const transcodeFn = audioOnly ? VMTranscoder.remuxAudioOnly : VMTranscoder.transcodeToMp4;
      const result = await transcodeFn(file, {
        onProgress: updateTranscodeProgress,
        onStatus: (msg) => { els.transcodeStatusText.textContent = msg; },
        token: transcodeCancelToken,
        saveHandle,
      });
      return result;
    } catch (e) {
      if (e && e.cancelled) return null;
      console.error(e);
      alert("Video conversion failed: " + (e && e.message ? e.message : e));
      return null;
    }
  }

  function updateTranscodeProgress(pct) {
    const p = Math.round(pct);
    els.transcodeProgressBar.style.width = p + "%";
    els.transcodeProgressText.textContent = p + "%";
  }

  function showExistingDialog(fileName, onUseExisting, onRescan) {
    els.existingFileName.textContent = fileName;
    pendingExisting = { onUseExisting, onRescan };
    els.existingDialogOverlay.classList.remove("hidden");
  }

  function hideExistingDialog() {
    els.existingDialogOverlay.classList.add("hidden");
    pendingExisting = null;
  }

  // `audioAlreadyOk` (from ensureVideoScannable's gate) tells finalizeAndLoadPlayer whether
  // it can skip its own audio check — true whenever a full transcode already happened, since
  // that fixes audio too; otherwise finalizeAndLoadPlayer checks fresh.
  async function usePreScanned(file, handle, record, resumeTime, resumePaused, audioAlreadyOk) {
    await VMDB.put("meta", { id: "app", lastOpenedFileName: record.fileName });
    await finalizeAndLoadPlayer(file, handle, record, resumeTime, resumePaused, audioAlreadyOk);
  }

  // ---------- scanning ----------

  async function startScan(file, handle, originalName, audioAlreadyOk) {
    const keyName = originalName || file.name;
    showScanScreen();
    cancelToken = VMScanner.createCancelToken();
    try {
      const { samples, duration, interval } = await VMScanner.scanVideoFile(file, {
        onProgress: updateScanProgress,
        onStatus: (msg) => { els.scanStatusText.textContent = msg; },
        token: cancelToken,
        sampleInterval: settings.scanInterval,
        adaptive: settings.adaptiveScan,
        sensitivity: settings.sensitivity,
        detectionMode: settings.detectionMode,
        exactTiming: settings.nudenetExactTiming,
      });

      const segments = VMScanner.mergeSegments(samples, settings.sensitivity, interval);
      const txt = VMScanner.segmentsToTxt(segments, keyName);
      downloadTxt(txt, baseName(keyName) + "_timecodes.txt");

      const record = {
        fileName: keyName,
        fileSize: file.size,
        lastModified: file.lastModified,
        duration,
        interval,
        samples,
        segmentsAtScan: segments,
        txtContent: txt,
        lastCurrentTime: 0,
        lastPaused: true,
        scannedAt: Date.now(),
        updatedAt: Date.now(),
      };
      if (handle) record.fileHandle = handle;
      if (file.name !== keyName) record.transcoded = true;

      await VMDB.put("videos", record);
      await VMDB.put("meta", { id: "app", lastOpenedFileName: keyName });

      await finalizeAndLoadPlayer(file, handle, record, 0, true, audioAlreadyOk);
    } catch (e) {
      if (e && e.cancelled) {
        showStartScreen();
        return;
      }
      console.error(e);
      alert("Scanning failed: " + (e && e.message ? e.message : e));
      showStartScreen();
    }
  }

  // Last gate before the player actually shows: unlike ensureVideoScannable (which must be
  // satisfied before scanning can even happen), an audio problem doesn't block anything
  // scanning-related, so it's only dealt with here, right before playback. If the user
  // declines the fix, they still get the player — just without sound — rather than losing
  // the scan (which could've been slow) they already sat through over something that only
  // affects audio.
  async function finalizeAndLoadPlayer(file, handle, record, resumeTime, resumePaused, audioAlreadyOk) {
    let finalFile = file;
    let finalHandle = handle;

    if (!audioAlreadyOk) {
      let result = { ok: true };
      try {
        result = await VMTranscoder.checkPlayability(file);
      } catch (e) {
        console.warn("Playability check failed before loading player, proceeding without an audio fix.", e);
      }
      if (!result.ok) {
        const confirmed = await showTranscodeWarningDialog(file.name, true);
        if (confirmed) {
          const refreshedFile = await refreshFileHandle(file, handle);
          const transcodeResult = await runTranscode(refreshedFile, true);
          if (transcodeResult) {
            finalFile = transcodeResult.file;
            finalHandle = transcodeResult.handle;
            record.transcoded = true;
            // Only overwrite a previously-stored handle when we actually got a new one (the
            // user picked a save location) — an in-memory-only result can't be silently
            // re-opened after a reload anyway, so keeping the old handle (if any) around lets
            // auto-resume still work, just re-offering this same fix next time.
            if (finalHandle) record.fileHandle = finalHandle;
            record.updatedAt = Date.now();
            await VMDB.put("videos", record);
          }
          // Failed/cancelled transcode: fall through and play the original (silent) file
          // rather than stranding the user after a successful scan.
        }
      }
    }

    await loadPlayerWithData(finalFile, finalHandle, record, resumeTime, resumePaused);
  }

  function updateScanProgress(pct) {
    const p = Math.round(pct);
    els.scanProgressBar.style.width = p + "%";
    els.scanProgressText.textContent = p + "%";
  }

  // ---------- player ----------

  async function loadPlayerWithData(file, handle, record, resumeTime, resumePaused) {
    activeVideo = {
      fileName: record.fileName,
      file,
      handle: handle || record.fileHandle || null,
      samples: record.samples,
      interval: record.interval,
      duration: record.duration,
      segments: VMScanner.mergeSegments(record.samples, settings.sensitivity, record.interval),
    };

    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = URL.createObjectURL(file);

    els.fileNameLabel.textContent = record.fileName + (record.transcoded ? " (converted for playback)" : "");
    // Hide any stale track list from a previous video immediately, rather than waiting for
    // the browser to actually clear/repopulate audioTracks after the new src loads.
    els.audioTrackSelect.classList.add("hidden");
    els.audioTrackSelect.innerHTML = "";
    els.video.src = currentObjectUrl;
    setBlur(false);
    showPlayerScreen();

    els.video.addEventListener(
      "loadedmetadata",
      () => {
        renderAudioTracks();
        if (resumeTime) {
          try {
            els.video.currentTime = Math.min(resumeTime, Math.max(0, els.video.duration - 0.1));
          } catch (e) { /* ignore */ }
        }
        if (resumePaused === false) {
          els.video.play().catch(() => {});
        }
      },
      { once: true }
    );
  }

  // Two segments' blur windows can be meant to touch exactly (one segment's end equal to
  // the next segment's advance-adjusted start), e.g. blurAdvance=1 turning a scene starting
  // at 16.6 into a window opening at 16.6-1=15.6, right where a prior scene's window ends.
  // `seg.start - advance` is float arithmetic though (16.6 - 1 === 15.600000000000001, not
  // 15.6), so a currentTime that lands on exactly 15.6 satisfies neither segment's condition
  // — reproduced directly: blur briefly clears for one frame at that exact boundary before
  // reappearing. This tolerance absorbs that kind of float noise; it's far below anything a
  // viewer could perceive as an early/late blur.
  const BLUR_BOUNDARY_EPSILON = 0.05;

  function onVideoTimeUpdate() {
    if (activeVideo) {
      const t = els.video.currentTime;
      // "Blur in advance" pads both edges of a flagged scene by the same amount: blur turns
      // on this many seconds before it starts, and stays on this many seconds after it ends
      // — a scene detected as ending abruptly (e.g. right when nudity happens to leave frame)
      // often still needs a moment of cover on the way out, same as it does coming in.
      const advance = settings.blurAdvance || 0;
      const shouldBlur = activeVideo.segments.some(
        (seg) =>
          t >= seg.start - advance - BLUR_BOUNDARY_EPSILON &&
          t < seg.end + advance + BLUR_BOUNDARY_EPSILON
      );
      setBlur(shouldBlur);
    }
    maybePersistState(false);
  }

  function setBlur(on) {
    els.video.classList.toggle("blurred", on);
    els.blurBadge.classList.toggle("hidden", !on);
  }

  // Populates the audio-track <select> from the native HTMLMediaElement.audioTracks list
  // (see js/transcoder.js for why a transcoded file can have more than one), and hides it
  // entirely for the common case of 0 or 1 tracks — nothing to switch between. Browser
  // support for this API varies (solid in Chrome/Edge, weaker in Firefox/Safari); on a
  // browser without it `els.video.audioTracks` is undefined and the control just stays
  // hidden rather than erroring.
  function renderAudioTracks() {
    const list = els.video.audioTracks;
    if (!list || list.length <= 1) {
      els.audioTrackSelect.classList.add("hidden");
      els.audioTrackSelect.innerHTML = "";
      return;
    }
    els.audioTrackSelect.innerHTML = "";
    for (let i = 0; i < list.length; i++) {
      const track = list[i];
      const opt = document.createElement("option");
      opt.value = track.id;
      opt.textContent = track.label || (track.language ? `Track ${i + 1} (${track.language})` : `Track ${i + 1}`);
      if (track.enabled) opt.selected = true;
      els.audioTrackSelect.appendChild(opt);
    }
    els.audioTrackSelect.classList.remove("hidden");
  }

  function onAudioTrackSelectChange(e) {
    const list = els.video.audioTracks;
    if (!list) return;
    const chosenId = e.target.value;
    // Explicit per the spec's "only one enabled at a time" rule — browsers are supposed to
    // auto-disable the others when one is set enabled, but setting it ourselves here doesn't
    // rely on that being implemented correctly everywhere.
    for (let i = 0; i < list.length; i++) list[i].enabled = list[i].id === chosenId;
  }

  function maybePersistState(force) {
    if (!activeVideo || !settings.rememberState) return;
    const now = Date.now();
    if (!force && now - lastPersistAt < 2000) return;
    lastPersistAt = now;
    const fileName = activeVideo.fileName;
    const currentTime = els.video.currentTime;
    const paused = els.video.paused;
    VMDB.get("videos", fileName).then((record) => {
      if (!record) return;
      record.lastCurrentTime = currentTime;
      record.lastPaused = paused;
      record.updatedAt = Date.now();
      return VMDB.put("videos", record);
    }).catch(() => {});
  }

  // ---------- resume after reload ----------

  async function attemptResume() {
    const meta = await VMDB.get("meta", "app");
    if (!meta || !meta.lastOpenedFileName) return;
    const record = await VMDB.get("videos", meta.lastOpenedFileName);
    if (!record) return;

    if (record.fileHandle && window.showOpenFilePicker) {
      let perm = "prompt";
      try {
        perm = await record.fileHandle.queryPermission({ mode: "read" });
      } catch (e) { /* ignore */ }
      if (perm === "granted") {
        try {
          const file = await record.fileHandle.getFile();
          const resumed = await resumeWithFile(file, record.fileHandle, record);
          if (resumed) return;
        } catch (e) {
          console.warn("Could not silently reopen last file, showing resume banner instead.", e);
        }
      }
    }
    showResumeBanner(record);
  }

  // Runs a re-obtained "last opened" file through the same video-scannable gate as a fresh
  // pick (video must already have been fine for this record to exist at all, but re-check
  // rather than assume), then loads the player at the remembered position — same
  // audio-fix-if-needed gate as any other path to the player, via finalizeAndLoadPlayer.
  // Returns true if the player was shown, false if the user backed out.
  async function resumeWithFile(file, handle, record) {
    const gate = await ensureVideoScannable(file, handle);
    if (!gate) return false;
    await usePreScanned(gate.file, gate.handle, record, record.lastCurrentTime, record.lastPaused, gate.audioAlreadyOk);
    return true;
  }

  function showResumeBanner(record) {
    els.resumeText.textContent = `Resume "${record.fileName}" from ${VMScanner.formatTime(record.lastCurrentTime || 0)}?`;
    els.resumeBox.classList.remove("hidden");

    els.resumeBtn.onclick = async () => {
      if (record.fileHandle && window.showOpenFilePicker) {
        try {
          const perm = await record.fileHandle.requestPermission({ mode: "read" });
          if (perm === "granted") {
            const file = await record.fileHandle.getFile();
            const resumed = await resumeWithFile(file, record.fileHandle, record);
            if (resumed) return;
            showStartScreen();
            return;
          }
        } catch (e) {
          console.warn("Permission request failed, falling back to manual file pick.", e);
        }
      }
      // Fallback (no File System Access API, or permission denied): ask user to re-select the file.
      const picked = await pickVideoFile();
      if (!picked) return;
      if (picked.file.name === record.fileName) {
        const resumed = await resumeWithFile(picked.file, picked.handle, record);
        if (!resumed) showStartScreen();
      } else {
        await openFileFlow(picked.file, picked.handle);
      }
    };

    els.resumeDismissBtn.onclick = () => {
      els.resumeBox.classList.add("hidden");
    };
  }

  // ---------- screens ----------

  function showStartScreen() {
    els.startScreen.classList.remove("hidden");
    els.scanScreen.classList.add("hidden");
    els.transcodeScreen.classList.add("hidden");
    els.playerScreen.classList.add("hidden");
  }

  function showScanScreen() {
    els.startScreen.classList.add("hidden");
    els.scanScreen.classList.remove("hidden");
    els.transcodeScreen.classList.add("hidden");
    els.playerScreen.classList.add("hidden");
    els.scanProgressBar.style.width = "0%";
    els.scanProgressText.textContent = "0%";
    els.scanStatusText.textContent = "Loading model…";
  }

  function showTranscodeScreen() {
    els.startScreen.classList.add("hidden");
    els.scanScreen.classList.add("hidden");
    els.transcodeScreen.classList.remove("hidden");
    els.playerScreen.classList.add("hidden");
    els.transcodeProgressBar.style.width = "0%";
    els.transcodeProgressText.textContent = "0%";
    els.transcodeStatusText.textContent = "Starting FFmpeg…";
  }

  function showPlayerScreen() {
    els.startScreen.classList.add("hidden");
    els.scanScreen.classList.add("hidden");
    els.transcodeScreen.classList.add("hidden");
    els.playerScreen.classList.remove("hidden");
    els.resumeBox.classList.add("hidden");
    els.openFileBtn.classList.remove("hidden");
  }

  // ---------- helpers ----------

  function downloadTxt(content, filename) {
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function baseName(name) {
    const idx = name.lastIndexOf(".");
    return idx > 0 ? name.slice(0, idx) : name;
  }

  function extOf(name) {
    const idx = name.lastIndexOf(".");
    return idx >= 0 ? name.slice(idx) : ".mkv";
  }
})();
