// @ts-nocheck — plain multi-file classic-script app; globals (VMDB/VMScanner/VMTranscoder/tf/nsfwjs) are wired via <script> load order, not modules.
(function () {
  // The 5 NudeNet body-part classes a sample's classScores map can carry a score for (see
  // nudenet-worker.js's CONFIRM_LABELS / scanner.js's applyClassThresholds) — each gets its
  // own sensitivity slider, built dynamically (see buildClassThresholdSliders) into both the
  // Settings dialog and the Timecodes dialog rather than hand-written 5x in each.
  const CONFIRM_CLASSES = [
    { key: "female-breast-bare", i18nKey: "settings.classFemaleBreastBare" },
    { key: "female-vagina", i18nKey: "settings.classFemaleVagina" },
    { key: "male-penis", i18nKey: "settings.classMalePenis" },
    { key: "anus-bare", i18nKey: "settings.classAnusBare" },
    { key: "buttocks-bare", i18nKey: "settings.classButtocksBare" },
  ];

  function defaultClassThresholds() {
    const obj = {};
    CONFIRM_CLASSES.forEach((c) => { obj[c.key] = 0; });
    return obj;
  }

  const DEFAULT_SETTINGS = {
    language: "uk",
    sensitivity: 0.5,
    // Per-class re-thresholds on top of NudeNet's own per-part scores — see
    // VMScanner.applyClassThresholds. 0 for every class by default: a sample counts as soon
    // as NudeNet reported anything for a class at all, identical to behavior before this
    // feature existed.
    classThresholds: defaultClassThresholds(),
    blurAdvance: 1.5,
    rememberState: true,
    scanInterval: 0.2,
    adaptiveScan: true,
    // "nsfwjs": NSFWJS only. "confirm": NSFWJS scans, NudeNet double-checks what it flags.
    // "nudenet": NudeNet is the primary/only classifier for every sampled frame.
    // NSFWJS-only/confirm modes are hidden from the Settings UI (NudeNet-only gives the
    // per-class breakdown the class-threshold sliders need) but kept in code/settings in
    // case that's revisited.
    detectionMode: "nudenet",
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
  let pendingResumeRecord = null;
  let pendingTranscodeWarningState = null;
  // Set only when openTimecodesDialog is called right after a fresh scan finishes (see
  // startScan) — shows a one-line "scanned in Xs, N scenes found" stats line at the top of
  // the dialog in that case only, not when the user opens it manually via the toolbar button.
  let lastScanStats = null;
  // "native" (plain <video>, the default/preferred path whenever it works) or "mediabunny"
  // (canvas + Web Audio playback via js/mediabunny-player.js — used only as a fallback for
  // files whose audio the browser can't decode natively but mediabunny can, e.g. AC3/E-AC-3,
  // avoiding an FFmpeg transcode entirely for those; see finalizeAndLoadPlayer). Kept as an
  // explicit, switchable option rather than replacing the native path outright.
  let activeEngine = "native";
  let mediabunnyPlayer = null; // the controller from VMMediabunnyPlayer.create(), when active

  // Player-controls overlay state (see wirePlayerControls) — modeled on the mediabunny
  // example player at https://mediabunny.dev/examples/media-player/.
  let volume = 0.7;
  let volumeMuted = false;
  let draggingProgressBar = false;
  let draggingVolumeBar = false;
  let hideControlsTimeout = null;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheEls();
    wireStaticUI();

    settings = await loadSettings();
    VMI18n.setLanguage(settings.language);
    VMI18n.applyToDom();
    applySettingsToInputs();

    if (settings.rememberState) {
      await attemptResume();
    }
  }

  function cacheEls() {
    [
      "settingsBtn", "openFileBtn", "timecodesBtn", "languageBtn", "languageBtnLabel",
      "startScreen", "pickFileBtn", "resumeBox", "resumeText", "resumeBtn", "resumeDismissBtn",
      "scanScreen", "scanProgressBar", "scanProgressText", "scanStatusText", "cancelScanBtn",
      "transcodeScreen", "transcodeProgressBar", "transcodeProgressText", "transcodeStatusText", "cancelTranscodeBtn",
      "playerScreen", "videoWrap", "video", "mediabunnyCanvas", "blurBadge", "audioTrackSelect", "fileNameLabel",
      "playerControls", "playPauseBtn", "playIcon", "pauseIcon", "currentTimeLabel", "durationLabel",
      "seekBarContainer", "seekBarFill", "seekBarHandle",
      "volumeControl", "volumeBtn", "volumeOnIcon", "volumeMutedIcon", "volumeBarContainer", "volumeBarFill", "volumeBarHandle",
      "fullscreenBtn", "enterFullscreenIcon", "exitFullscreenIcon",
      "fileInput",
      "existingDialogOverlay", "existingDialogText", "useExistingBtn", "rescanBtn",
      "timecodesDialogOverlay", "timecodesStats", "classThresholdsTimecodes", "timecodesContent",
      "downloadTimecodesBtn", "downloadSubtitlesBtn", "closeTimecodesBtn",
      "assInfoDialogOverlay", "assInfoCloseX", "assInfoSaveBtn",
      "transcodeWarningOverlay", "transcodeWarningTitle", "transcodeReasonText", "transcodeFileName",
      "transcodeReasonSuffix", "transcodeConfirmBtn", "transcodeCancelBtn",
      "settingsDialogOverlay", "sensitivityInput", "sensitivityValue", "classThresholdsSettings", "blurAdvanceInput",
      "scanIntervalInput", "scanIntervalComputedHint", "adaptiveScanInput", "rememberStateInput", "closeSettingsBtn",
      "modeNsfwjsInput", "modeConfirmInput", "modeNudenetInput", "nudenetExactTimingInput",
    ].forEach((id) => { els[id] = document.getElementById(id); });
    els.detectionModeInputs = [els.modeNsfwjsInput, els.modeConfirmInput, els.modeNudenetInput];
  }

  function wireStaticUI() {
    buildClassThresholdSliders(els.classThresholdsSettings);
    buildClassThresholdSliders(els.classThresholdsTimecodes);

    els.pickFileBtn.addEventListener("click", () => pickVideoFile().then((picked) => picked && openFileFlow(picked.file, picked.handle)));
    els.openFileBtn.addEventListener("click", () => pickVideoFile().then((picked) => picked && openFileFlow(picked.file, picked.handle)));

    els.settingsBtn.addEventListener("click", openSettingsDialog);
    els.closeSettingsBtn.addEventListener("click", closeSettingsDialog);
    els.settingsDialogOverlay.addEventListener("click", (e) => {
      if (e.target === els.settingsDialogOverlay) closeSettingsDialog();
    });

    els.languageBtn.addEventListener("click", () => {
      const next = VMI18n.getLanguage() === "uk" ? "en" : "uk";
      settings.language = next;
      VMI18n.setLanguage(next);
      VMI18n.applyToDom();
      persistSettings();
      refreshDynamicTexts();
    });

    els.timecodesBtn.addEventListener("click", () => openTimecodesDialog());
    els.closeTimecodesBtn.addEventListener("click", closeTimecodesDialog);
    els.timecodesDialogOverlay.addEventListener("click", (e) => {
      if (e.target === els.timecodesDialogOverlay) closeTimecodesDialog();
    });
    els.downloadTimecodesBtn.addEventListener("click", () => {
      if (!activeVideo) return;
      const segments = activeVideo.liveTimecodesSegments || [];
      const txt = VMScanner.segmentsToTxt(segments, activeVideo.fileName);
      downloadTxt(txt, baseName(activeVideo.fileName) + "_timecodes.txt");
    });

    els.downloadSubtitlesBtn.addEventListener("click", () => {
      if (!activeVideo) return;
      closeTimecodesDialog();
      els.assInfoDialogOverlay.classList.remove("hidden");
    });
    els.assInfoCloseX.addEventListener("click", closeAssInfoDialog);
    els.assInfoDialogOverlay.addEventListener("click", (e) => {
      if (e.target === els.assInfoDialogOverlay) closeAssInfoDialog();
    });
    els.assInfoSaveBtn.addEventListener("click", () => {
      closeAssInfoDialog();
      void saveAssSubtitles();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!els.assInfoDialogOverlay.classList.contains("hidden")) {
        closeAssInfoDialog();
      } else if (!els.timecodesDialogOverlay.classList.contains("hidden")) {
        closeTimecodesDialog();
      } else if (!els.settingsDialogOverlay.classList.contains("hidden")) {
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
    els.video.addEventListener("play", () => updatePlayerControls(els.video.currentTime));
    els.video.addEventListener("pause", () => {
      updatePlayerControls(els.video.currentTime);
      maybePersistState(true);
    });
    els.video.addEventListener("seeked", () => maybePersistState(true));

    wirePlayerControls();

    window.addEventListener("beforeunload", () => maybePersistState(true));
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) maybePersistState(true);
    });
  }

  // ---------- settings ----------

  async function loadSettings() {
    const s = await VMDB.get("settings", "app");
    const merged = Object.assign({}, DEFAULT_SETTINGS, s || {});
    // Own object, not a shared reference to DEFAULT_SETTINGS.classThresholds (which a plain
    // Object.assign would leave in place untouched whenever a persisted record predates this
    // setting) — mutating settings.classThresholds later must never mutate the module-level
    // default. Merged key-by-key so an older persisted record missing a class added later
    // still gets that class's default (0) rather than `undefined`.
    merged.classThresholds = Object.assign({}, DEFAULT_SETTINGS.classThresholds, (s && s.classThresholds) || {});
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
    syncClassThresholdInputs();
  }

  // key -> [{ input, valueEl }, ...] — one entry per dialog the sliders were built into
  // (Settings + Timecodes), kept in sync with each other since they're the same setting.
  const classThresholdInputs = {};

  // Builds one range-slider <label class="field"> per CONFIRM_CLASSES entry into `container`
  // (called once per dialog, at startup — see wireStaticUI) rather than hand-writing 5
  // nearly-identical blocks x2 dialogs in index.html. Each slider's label carries its own
  // data-i18n attribute, so VMI18n.applyToDom() (already run on every language switch) picks
  // these up automatically without any extra wiring here.
  function buildClassThresholdSliders(container) {
    if (!container) return;
    CONFIRM_CLASSES.forEach((cls) => {
      const wrapper = document.createElement("label");
      wrapper.className = "field";

      const topRow = document.createElement("span");
      const labelSpan = document.createElement("span");
      labelSpan.setAttribute("data-i18n", cls.i18nKey);
      labelSpan.textContent = VMI18n.t(cls.i18nKey);
      const valueB = document.createElement("b");
      topRow.appendChild(labelSpan);
      topRow.appendChild(document.createTextNode(" "));
      topRow.appendChild(valueB);

      const input = document.createElement("input");
      input.type = "range";
      input.min = "0";
      input.max = "1";
      input.step = "0.01";

      wrapper.appendChild(topRow);
      wrapper.appendChild(input);
      container.appendChild(wrapper);

      input.addEventListener("input", () => onClassThresholdChange(cls.key, parseFloat(input.value)));

      if (!classThresholdInputs[cls.key]) classThresholdInputs[cls.key] = [];
      classThresholdInputs[cls.key].push({ input, valueEl: valueB });
    });
  }

  // Pushes settings.classThresholds into every built slider instance (both dialogs) — called
  // on load/dialog-open and after any single slider changes, so the Settings-dialog copy and
  // the Timecodes-dialog copy of the same 5 sliders never drift apart from each other.
  function syncClassThresholdInputs() {
    CONFIRM_CLASSES.forEach((cls) => {
      const value = settings.classThresholds[cls.key] || 0;
      (classThresholdInputs[cls.key] || []).forEach(({ input, valueEl }) => {
        input.value = value;
        valueEl.textContent = value.toFixed(2);
      });
    });
  }

  function onClassThresholdChange(key, value) {
    settings.classThresholds[key] = value;
    persistSettings();
    syncClassThresholdInputs();
    recomputeActiveSegments();
    if (activeVideo && !els.timecodesDialogOverlay.classList.contains("hidden")) {
      renderTimecodesDialogContent();
    }
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
      els.scanIntervalComputedHint.textContent = VMI18n.t("settings.scanIntervalComputedSingle", { fine: fineInterval });
      return;
    }
    const coarseInterval = VMScanner.computeCoarseInterval(fineInterval);
    els.scanIntervalComputedHint.textContent = VMI18n.t("settings.scanIntervalComputedBoth", {
      coarse: coarseInterval.toFixed(2),
      fine: fineInterval,
    });
  }

  function openSettingsDialog() {
    applySettingsToInputs();
    els.settingsDialogOverlay.classList.remove("hidden");
  }

  function closeSettingsDialog() {
    els.settingsDialogOverlay.classList.add("hidden");
  }

  // `stats`, when passed, is { elapsedMs, sceneCount } from a scan that just finished — shows
  // a stats line at the top of the dialog for that one appearance. Omit it (as the toolbar
  // button's handler does) to open the dialog plain, same as before this feature existed.
  function openTimecodesDialog(stats) {
    if (!activeVideo) return;
    lastScanStats = stats || null;
    renderTimecodesDialogStats();
    syncClassThresholdInputs();
    renderTimecodesDialogContent();
    els.timecodesDialogOverlay.classList.remove("hidden");
  }

  // Recomputes the detected-scenes list shown in the Timecodes dialog from the raw samples,
  // REPORT_FLOOR (not the general/blur sensitivity — this list is meant to show everything
  // the scan found, same principle as startScan's own txt export) and the current per-class
  // thresholds — called on open and again every time a class slider moves (see
  // buildClassThresholdSliders' onChange). Cached on activeVideo.liveTimecodesSegments so the
  // download/ASS-export buttons export exactly what's currently shown, not a stale snapshot.
  function renderTimecodesDialogContent() {
    if (!activeVideo) return;
    const filtered = VMScanner.applyClassThresholds(activeVideo.samples, settings.classThresholds);
    const segments = VMScanner.mergeSegments(filtered, VMScanner.REPORT_FLOOR, activeVideo.interval);
    activeVideo.liveTimecodesSegments = segments;
    const txt = segments.length ? VMScanner.segmentsToTxt(segments, activeVideo.fileName) : "";
    els.timecodesContent.textContent = txt || VMI18n.t("timecodesDialog.none");
  }

  function renderTimecodesDialogStats() {
    if (!lastScanStats) {
      els.timecodesStats.textContent = "";
      els.timecodesStats.classList.add("hidden");
      return;
    }
    const seconds = lastScanStats.elapsedMs / 1000;
    const duration = formatControlTime(seconds, seconds >= 3600);
    els.timecodesStats.textContent = VMI18n.t("timecodesDialog.scanStats", {
      count: lastScanStats.sceneCount,
      duration,
    });
    els.timecodesStats.classList.remove("hidden");
  }

  function closeTimecodesDialog() {
    els.timecodesDialogOverlay.classList.add("hidden");
  }

  function closeAssInfoDialog() {
    els.assInfoDialogOverlay.classList.add("hidden");
  }

  // The actual pixel dimensions of the currently-playing frame — needed for the ASS file's
  // PlayResX/PlayResY (see js/ass-export.js) — sourced from whichever engine is active, since
  // native <video> and the mediabunny <canvas> expose it differently.
  function getVideoDimensions() {
    if (activeEngine === "mediabunny") {
      return { width: els.mediabunnyCanvas.width, height: els.mediabunnyCanvas.height };
    }
    return { width: els.video.videoWidth, height: els.video.videoHeight };
  }

  async function saveAssSubtitles() {
    if (!activeVideo) return;
    const { width, height } = getVideoDimensions();
    // Same list as the Timecodes dialog is currently showing (REPORT_FLOOR + per-class
    // thresholds), not the general-sensitivity-gated blur segments — the dialog's own
    // "Download as subtitles" button is the only way to reach this, so
    // liveTimecodesSegments is always populated by the time this runs.
    const segments = activeVideo.liveTimecodesSegments || VMScanner.mergeSegments(
      VMScanner.applyClassThresholds(activeVideo.samples, settings.classThresholds),
      VMScanner.REPORT_FLOOR,
      activeVideo.interval
    );
    const assContent = VMAssExport.generate(width, height, segments, settings.blurAdvance || 0);
    const suggestedName = baseName(activeVideo.fileName) + ".ass";

    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{ description: "Subtitles", accept: { "text/plain": [".ass"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(assContent);
        await writable.close();
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return; // user cancelled the save dialog
        console.warn("Save-location picker failed, falling back to a plain download.", e);
      }
    }
    downloadTxt(assContent, suggestedName);
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
    const filtered = VMScanner.applyClassThresholds(activeVideo.samples, settings.classThresholds);
    activeVideo.segments = VMScanner.mergeSegments(filtered, settings.sensitivity, activeVideo.interval);
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
    pendingTranscodeWarningState = { fileName, audioOnly };
    renderTranscodeWarningDialog();
    els.transcodeWarningOverlay.classList.remove("hidden");
    return new Promise((resolve) => {
      pendingTranscodeResolve = resolve;
    });
  }

  function renderTranscodeWarningDialog() {
    if (!pendingTranscodeWarningState) return;
    const { fileName, audioOnly } = pendingTranscodeWarningState;
    els.transcodeFileName.textContent = fileName;
    if (audioOnly) {
      els.transcodeWarningTitle.textContent = VMI18n.t("transcodeWarning.audioTitle");
      els.transcodeReasonText.textContent = VMI18n.t("transcodeWarning.audioReason");
      els.transcodeReasonSuffix.textContent = VMI18n.t("transcodeWarning.audioSuffix");
    } else {
      els.transcodeWarningTitle.textContent = VMI18n.t("transcodeWarning.videoTitle");
      els.transcodeReasonText.textContent = VMI18n.t("transcodeWarning.videoReason");
      els.transcodeReasonSuffix.textContent = VMI18n.t("transcodeWarning.videoSuffix");
    }
  }

  function hideTranscodeWarningDialog() {
    els.transcodeWarningOverlay.classList.add("hidden");
    pendingTranscodeWarningState = null;
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
      alert(VMI18n.t("transcode.failed", { message: e && e.message ? e.message : e }));
      return null;
    }
  }

  function updateTranscodeProgress(pct) {
    const p = Math.round(pct);
    els.transcodeProgressBar.style.width = p + "%";
    els.transcodeProgressText.textContent = p + "%";
  }

  function showExistingDialog(fileName, onUseExisting, onRescan) {
    pendingExisting = { fileName, onUseExisting, onRescan };
    els.existingDialogText.textContent = VMI18n.t("existingDialog.text", { fileName });
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
    const scanStartedAt = Date.now();
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

      // REPORT_FLOOR, not settings.sensitivity: the exported txt / stored record should
      // capture everything the scan actually found, independent of the (playback-only,
      // freely adjustable) sensitivity slider — see scanner.js's comment on REPORT_FLOOR.
      // Per-class thresholds DO apply here though (via applyClassThresholds) — same
      // treatment the Timecodes dialog gives this list interactively (see
      // renderTimecodesDialogContent), just using whatever the sliders are set to right now.
      const segments = VMScanner.mergeSegments(
        VMScanner.applyClassThresholds(samples, settings.classThresholds),
        VMScanner.REPORT_FLOOR,
        interval
      );
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
      openTimecodesDialog({ elapsedMs: Date.now() - scanStartedAt, sceneCount: segments.length });
    } catch (e) {
      if (e && e.cancelled) {
        showStartScreen();
        return;
      }
      console.error(e);
      alert(VMI18n.t("scan.failed", { message: e && e.message ? e.message : e }));
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
    let useMediabunny = false;

    if (!audioAlreadyOk) {
      let result = { ok: true };
      try {
        result = await VMTranscoder.checkPlayability(file);
      } catch (e) {
        console.warn("Playability check failed before loading player, proceeding without an audio fix.", e);
      }
      if (!result.ok) {
        // Before asking the user to sit through an FFmpeg transcode, check whether
        // mediabunny (js/mediabunny-player.js — canvas + Web Audio playback, with an AC3/
        // E-AC-3 decoder extension) can just play the file as-is. For the common case this
        // exists for — AC3/EAC3 audio Chrome has no native decoder for — this plays it
        // directly in real time, no transcode needed at all. Only falls back to the
        // transcode prompt if mediabunny can't handle it either.
        let mediabunnyOk = false;
        try {
          mediabunnyOk = await VMMediabunnyPlayer.canPlay(file);
        } catch (e) {
          console.warn("Mediabunny playability check failed.", e);
        }
        if (mediabunnyOk) {
          useMediabunny = true;
        } else {
          const confirmed = await showTranscodeWarningDialog(file.name, true);
          if (confirmed) {
            const refreshedFile = await refreshFileHandle(file, handle);
            const transcodeResult = await runTranscode(refreshedFile, true);
            if (transcodeResult) {
              finalFile = transcodeResult.file;
              finalHandle = transcodeResult.handle;
              record.transcoded = true;
              // Only overwrite a previously-stored handle when we actually got a new one
              // (the user picked a save location) — an in-memory-only result can't be
              // silently re-opened after a reload anyway, so keeping the old handle (if
              // any) around lets auto-resume still work, just re-offering this same fix
              // next time.
              if (finalHandle) record.fileHandle = finalHandle;
              record.updatedAt = Date.now();
              await VMDB.put("videos", record);
            }
            // Failed/cancelled transcode: fall through and play the original (silent) file
            // rather than stranding the user after a successful scan.
          }
        }
      }
    }

    await loadPlayerWithData(finalFile, finalHandle, record, resumeTime, resumePaused, useMediabunny);
  }

  function updateScanProgress(pct) {
    const p = Math.round(pct);
    els.scanProgressBar.style.width = p + "%";
    els.scanProgressText.textContent = p + "%";
  }

  // ---------- player ----------

  async function loadPlayerWithData(file, handle, record, resumeTime, resumePaused, useMediabunny) {
    activeVideo = {
      fileName: record.fileName,
      file,
      handle: handle || record.fileHandle || null,
      samples: record.samples,
      interval: record.interval,
      duration: record.duration,
      // The full detected-scenes txt from scan time (REPORT_FLOOR-based — see startScan —
      // not sensitivity-filtered). No longer read by the Timecodes dialog (which now
      // recomputes live — see renderTimecodesDialogContent) but kept as a record of what
      // was found at scan time.
      txtContent: record.txtContent,
      transcoded: !!record.transcoded,
    };
    recomputeActiveSegments();
    updatePlayerControls(resumeTime || 0);

    // Tear down whichever engine was serving a previous video before setting up this one.
    if (mediabunnyPlayer) {
      mediabunnyPlayer.destroy();
      mediabunnyPlayer = null;
    }
    els.video.pause();
    els.video.removeAttribute("src");
    els.video.load();
    els.video.classList.remove("blurred");
    els.mediabunnyCanvas.classList.remove("blurred");
    els.blurBadge.classList.add("hidden");
    els.audioTrackSelect.classList.add("hidden");
    els.audioTrackSelect.innerHTML = "";

    updateFileNameLabel();

    activeEngine = useMediabunny ? "mediabunny" : "native";
    els.video.classList.toggle("hidden", activeEngine === "mediabunny");
    els.mediabunnyCanvas.classList.toggle("hidden", activeEngine !== "mediabunny");
    showPlayerScreen();
    showControlsTemporarily();

    if (activeEngine === "mediabunny") {
      try {
        mediabunnyPlayer = await VMMediabunnyPlayer.create(els.mediabunnyCanvas, file, {
          onTimeUpdate: handlePlaybackTimeUpdate,
          onEnded: () => {},
        });
        applyVolumeToEngine(); // fresh player defaults to full volume internally otherwise
        if (resumeTime) {
          try {
            await mediabunnyPlayer.setCurrentTime(Math.min(resumeTime, Math.max(0, mediabunnyPlayer.duration - 0.1)));
          } catch (e) { /* ignore */ }
        }
        if (resumePaused === false) {
          await mediabunnyPlayer.play();
        }
      } catch (e) {
        // Passed its own canPlay() check but failed to actually set up — fall back to the
        // native player rather than leaving the player screen blank with no video at all.
        console.error("Mediabunny playback failed, falling back to the native player.", e);
        activeEngine = "native";
        els.mediabunnyCanvas.classList.add("hidden");
        els.video.classList.remove("hidden");
        loadNativeVideo(file, resumeTime, resumePaused);
      }
    } else {
      loadNativeVideo(file, resumeTime, resumePaused);
    }
  }

  function loadNativeVideo(file, resumeTime, resumePaused) {
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = URL.createObjectURL(file);
    els.video.src = currentObjectUrl;
    setBlur(false);
    applyVolumeToEngine();

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

  // Engine-agnostic accessors — both playback engines end up driven through these, rather
  // than each caller branching on activeEngine itself.
  function isPausedNow() {
    return activeEngine === "mediabunny" && mediabunnyPlayer ? mediabunnyPlayer.isPaused() : els.video.paused;
  }

  function currentPlaybackTime() {
    return activeEngine === "mediabunny" && mediabunnyPlayer ? mediabunnyPlayer.getCurrentTime() : els.video.currentTime;
  }

  async function togglePlayPause() {
    if (!activeVideo) return;
    if (activeEngine === "mediabunny" && mediabunnyPlayer) {
      if (mediabunnyPlayer.isPaused()) await mediabunnyPlayer.play(); else mediabunnyPlayer.pause();
    } else if (els.video.paused) {
      els.video.play().catch(() => {});
    } else {
      els.video.pause();
    }
    updatePlayerControls(currentPlaybackTime());
    maybePersistState(true);
  }

  async function seekToFraction(fraction) {
    if (!activeVideo || !activeVideo.duration) return;
    await seekToTime(Math.max(0, Math.min(1, fraction)) * activeVideo.duration);
  }

  async function seekToTime(target) {
    if (!activeVideo || !activeVideo.duration) return;
    target = Math.max(0, Math.min(activeVideo.duration, target));
    if (activeEngine === "mediabunny" && mediabunnyPlayer) {
      await mediabunnyPlayer.setCurrentTime(target);
    } else {
      els.video.currentTime = target;
    }
    updatePlayerControls(target);
    maybePersistState(true);
  }

  const SEEK_STEP_SECONDS = 5;

  async function seekBy(deltaSeconds) {
    await seekToTime(currentPlaybackTime() + deltaSeconds);
  }

  // Whether to include an hours component is decided from the video's total duration, not
  // each individual value being formatted — otherwise the current-time label would silently
  // grow an "0:" hours prefix mid-playback the moment it crosses the one-hour mark, while the
  // duration label (already past it) looked different the whole time.
  function shouldShowHours() {
    return !!(activeVideo && activeVideo.duration >= 3600);
  }

  function formatControlTime(seconds, showHours) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const totalSeconds = Math.floor(seconds);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (showHours) {
      return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  // Skipped while draggingProgressBar: the drag handlers in wirePlayerControls already paint
  // a live preview of the seek position as the user drags, and this would otherwise fight
  // that preview with the actual (not-yet-committed) playback position on every frame tick.
  function updatePlayerControls(t) {
    const duration = activeVideo ? activeVideo.duration : 0;
    const paused = isPausedNow();
    const showHours = shouldShowHours();
    els.playIcon.classList.toggle("hidden", !paused);
    els.pauseIcon.classList.toggle("hidden", paused);
    els.playPauseBtn.setAttribute("aria-label", paused ? VMI18n.t("player.play") : VMI18n.t("player.pause"));
    if (!draggingProgressBar) {
      els.currentTimeLabel.textContent = formatControlTime(t, showHours);
      setSeekBarPosition(duration > 0 ? t / duration : 0);
    }
    els.durationLabel.textContent = formatControlTime(duration, showHours);
  }

  function setSeekBarPosition(fraction) {
    const pct = Math.max(0, Math.min(100, fraction * 100));
    els.seekBarFill.style.width = pct + "%";
    els.seekBarHandle.style.left = pct + "%";
  }

  // ---------- player controls: show/hide, dragging, volume, fullscreen ----------
  // Modeled on the mediabunny example player (https://mediabunny.dev/examples/media-player/):
  // an overlay that appears on pointer movement over the player and fades out after a couple
  // seconds of inactivity; draggable seek and volume bars that preview live and commit on
  // release; clicking the video area itself (but not the controls) toggles play/pause.

  function showControlsTemporarily() {
    if (!activeVideo) return;
    els.playerControls.classList.add("shown");
    clearTimeout(hideControlsTimeout);
    hideControlsTimeout = setTimeout(() => {
      if (draggingProgressBar || draggingVolumeBar) return;
      els.playerControls.classList.remove("shown");
    }, 2000);
  }

  function hideControlsNow() {
    if (draggingProgressBar || draggingVolumeBar) return;
    clearTimeout(hideControlsTimeout);
    els.playerControls.classList.remove("shown");
  }

  function applyVolumeToEngine() {
    const actualVolume = volumeMuted ? 0 : volume;
    if (activeEngine === "mediabunny" && mediabunnyPlayer) {
      mediabunnyPlayer.setVolume(actualVolume);
    } else {
      // Squared for the same reason as mediabunny-player.js's setVolume: perceived loudness
      // is roughly logarithmic, so a linear slider->volume mapping feels front-loaded.
      els.video.volume = actualVolume ** 2;
    }
  }

  function updateVolumeUI() {
    const actualVolume = volumeMuted ? 0 : volume;
    const pct = actualVolume * 100;
    els.volumeBarFill.style.width = pct + "%";
    els.volumeBarHandle.style.left = pct + "%";
    els.volumeOnIcon.classList.toggle("hidden", actualVolume === 0);
    els.volumeMutedIcon.classList.toggle("hidden", actualVolume !== 0);
    els.volumeBtn.setAttribute("aria-label", actualVolume === 0 ? VMI18n.t("player.unmute") : VMI18n.t("player.mute"));
    applyVolumeToEngine();
  }

  function volumeFractionFromEvent(e) {
    const rect = els.volumeBarContainer.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  function seekFractionFromEvent(e) {
    const rect = els.seekBarContainer.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  function updateFullscreenIcon() {
    const isFs = document.fullscreenElement === els.videoWrap;
    els.enterFullscreenIcon.classList.toggle("hidden", isFs);
    els.exitFullscreenIcon.classList.toggle("hidden", !isFs);
    els.fullscreenBtn.setAttribute("aria-label", isFs ? VMI18n.t("player.exitFullscreen") : VMI18n.t("player.fullscreen"));
  }

  function wirePlayerControls() {
    els.playPauseBtn.addEventListener("click", () => { void togglePlayPause(); });

    // Stops a click/drag anywhere in the controls from also being seen by videoWrap's
    // click-to-toggle-play handler below (matching the reference player's behavior).
    els.playerControls.addEventListener("click", (e) => {
      e.stopPropagation();
      showControlsTemporarily();
    });

    // --- seek bar: live preview while dragging, commits on release ---
    els.seekBarContainer.addEventListener("pointerdown", (e) => {
      if (!activeVideo || !activeVideo.duration) return;
      draggingProgressBar = true;
      try { els.seekBarContainer.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      setSeekBarPosition(seekFractionFromEvent(e));
      els.currentTimeLabel.textContent = formatControlTime(seekFractionFromEvent(e) * activeVideo.duration, shouldShowHours());
      clearTimeout(hideControlsTimeout);
    });
    els.seekBarContainer.addEventListener("pointermove", (e) => {
      if (!draggingProgressBar || !activeVideo) return;
      const fraction = seekFractionFromEvent(e);
      setSeekBarPosition(fraction);
      els.currentTimeLabel.textContent = formatControlTime(fraction * activeVideo.duration, shouldShowHours());
    });
    els.seekBarContainer.addEventListener("pointerup", (e) => {
      if (!draggingProgressBar) return;
      draggingProgressBar = false;
      try { els.seekBarContainer.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      void seekToFraction(seekFractionFromEvent(e));
      showControlsTemporarily();
    });

    // --- volume bar: same live-preview-then-commit pattern, but volume applies instantly
    // (no cost to "committing" continuously, unlike seeking) ---
    els.volumeBarContainer.addEventListener("pointerdown", (e) => {
      draggingVolumeBar = true;
      try { els.volumeBarContainer.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      volume = volumeFractionFromEvent(e);
      volumeMuted = false;
      updateVolumeUI();
      clearTimeout(hideControlsTimeout);
    });
    els.volumeBarContainer.addEventListener("pointermove", (e) => {
      if (!draggingVolumeBar) return;
      volume = volumeFractionFromEvent(e);
      updateVolumeUI();
    });
    els.volumeBarContainer.addEventListener("pointerup", (e) => {
      if (!draggingVolumeBar) return;
      draggingVolumeBar = false;
      try { els.volumeBarContainer.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      showControlsTemporarily();
    });
    els.volumeBtn.addEventListener("click", () => {
      volumeMuted = !volumeMuted;
      updateVolumeUI();
    });

    // --- fullscreen ---
    els.fullscreenBtn.addEventListener("click", () => {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        els.videoWrap.requestFullscreen().catch((e) => console.error("Failed to enter fullscreen.", e));
      }
    });
    document.addEventListener("fullscreenchange", updateFullscreenIcon);

    // --- show/hide overlay on hover, click-video-to-toggle-play ---
    els.videoWrap.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "touch") showControlsTemporarily();
    });
    els.videoWrap.addEventListener("pointerleave", () => hideControlsNow());
    els.videoWrap.addEventListener("click", () => {
      if (!activeVideo) return;
      void togglePlayPause();
      showControlsTemporarily();
    });

    // --- keyboard: left/right seeks 5s, space toggles play/pause, escape exits fullscreen ---
    window.addEventListener("keydown", (e) => {
      if (!activeVideo || els.playerScreen.classList.contains("hidden")) return;
      // Don't hijack keys away from a focused form control (e.g. the sensitivity slider in
      // Settings, which is itself arrow-key-operable).
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

      if (e.code === "ArrowLeft") {
        void seekBy(-SEEK_STEP_SECONDS);
      } else if (e.code === "ArrowRight") {
        void seekBy(SEEK_STEP_SECONDS);
      } else if (e.code === "Space") {
        // A focused <button> (e.g. right after clicking play/pause itself) already activates
        // on Space natively — calling togglePlayPause() too would double-fire (toggle, then
        // immediately toggle back). Let the native activation handle it in that case.
        if (tag === "BUTTON") return;
        void togglePlayPause();
      } else if (e.code === "Escape" && document.fullscreenElement) {
        // Belt-and-suspenders: browsers already guarantee Escape exits fullscreen
        // unconditionally (can't be prevented by page JS), but calling it explicitly here
        // costs nothing and removes any doubt.
        document.exitFullscreen().catch(() => {});
      } else {
        return;
      }
      showControlsTemporarily();
      e.preventDefault();
    });

    updateVolumeUI();
  }

  // Shared between both playback engines: the native <video>'s "timeupdate" event calls this
  // with els.video.currentTime (see onVideoTimeUpdate below); the mediabunny engine has no
  // native timeupdate event, so js/mediabunny-player.js's render loop calls this directly via
  // the onTimeUpdate callback passed into VMMediabunnyPlayer.create().
  function handlePlaybackTimeUpdate(t) {
    if (activeVideo) {
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
    updatePlayerControls(t);
    maybePersistState(false);
  }

  function onVideoTimeUpdate() {
    handlePlaybackTimeUpdate(els.video.currentTime);
  }

  function updateFileNameLabel() {
    if (!activeVideo) return;
    els.fileNameLabel.textContent = activeVideo.fileName + (activeVideo.transcoded ? VMI18n.t("player.convertedSuffix") : "");
  }

  function setBlur(on) {
    const surface = activeEngine === "mediabunny" ? els.mediabunnyCanvas : els.video;
    surface.classList.toggle("blurred", on);
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
      opt.textContent = track.label ||
        (track.language
          ? VMI18n.t("player.audioTrackNumberedLang", { n: i + 1, lang: track.language })
          : VMI18n.t("player.audioTrackNumbered", { n: i + 1 }));
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
    const currentTime = currentPlaybackTime();
    const paused = isPausedNow();
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
    pendingResumeRecord = record;
    els.resumeText.textContent = VMI18n.t("start.resumeText", {
      fileName: record.fileName,
      time: VMScanner.formatTime(record.lastCurrentTime || 0),
    });
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
    els.timecodesBtn.classList.add("hidden");
  }

  function showScanScreen() {
    els.startScreen.classList.add("hidden");
    els.scanScreen.classList.remove("hidden");
    els.transcodeScreen.classList.add("hidden");
    els.playerScreen.classList.add("hidden");
    els.timecodesBtn.classList.add("hidden");
    els.scanProgressBar.style.width = "0%";
    els.scanProgressText.textContent = "0%";
    els.scanStatusText.textContent = VMI18n.t("scan.statusLoadingModel");
  }

  function showTranscodeScreen() {
    els.startScreen.classList.add("hidden");
    els.scanScreen.classList.add("hidden");
    els.transcodeScreen.classList.remove("hidden");
    els.playerScreen.classList.add("hidden");
    els.timecodesBtn.classList.add("hidden");
    els.transcodeProgressBar.style.width = "0%";
    els.transcodeProgressText.textContent = "0%";
    els.transcodeStatusText.textContent = VMI18n.t("transcode.statusStarting");
  }

  function showPlayerScreen() {
    els.startScreen.classList.add("hidden");
    els.scanScreen.classList.add("hidden");
    els.transcodeScreen.classList.add("hidden");
    els.playerScreen.classList.remove("hidden");
    els.resumeBox.classList.add("hidden");
    els.openFileBtn.classList.remove("hidden");
    els.timecodesBtn.classList.remove("hidden");
  }

  // ---------- language switching ----------

  // Re-renders every currently-visible piece of UI whose text was set by JS (rather than
  // picked up automatically by VMI18n.applyToDom() from a static data-i18n attribute) —
  // called right after the language toggle switches VMI18n's current language.
  function refreshDynamicTexts() {
    updateScanIntervalComputedHint();
    if (activeVideo) {
      updatePlayerControls(currentPlaybackTime());
      updateVolumeUI();
      updateFullscreenIcon();
      updateFileNameLabel();
      renderAudioTracks();
    }
    if (activeVideo && !els.timecodesDialogOverlay.classList.contains("hidden")) {
      renderTimecodesDialogContent();
      renderTimecodesDialogStats();
    }
    if (pendingExisting && !els.existingDialogOverlay.classList.contains("hidden")) {
      els.existingDialogText.textContent = VMI18n.t("existingDialog.text", { fileName: pendingExisting.fileName });
    }
    if (!els.transcodeWarningOverlay.classList.contains("hidden")) {
      renderTranscodeWarningDialog();
    }
    if (pendingResumeRecord && !els.resumeBox.classList.contains("hidden")) {
      els.resumeText.textContent = VMI18n.t("start.resumeText", {
        fileName: pendingResumeRecord.fileName,
        time: VMScanner.formatTime(pendingResumeRecord.lastCurrentTime || 0),
      });
    }
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
