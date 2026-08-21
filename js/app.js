// @ts-nocheck — plain multi-file classic-script app; globals (VMDB/VMScanner/VMTranscoder/tf/nsfwjs) are wired via <script> load order, not modules.
(function () {
  const DEFAULT_SETTINGS = {
    sensitivity: 0.6,
    blurAdvance: 1.5,
    rememberState: true,
    scanInterval: 1,
    adaptiveScan: true,
    nudeNetConfirm: true,
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
      "playerScreen", "video", "blurBadge", "fileNameLabel",
      "fileInput",
      "existingDialogOverlay", "existingFileName", "useExistingBtn", "rescanBtn",
      "transcodeWarningOverlay", "transcodeFileName", "transcodeConfirmBtn", "transcodeCancelBtn",
      "settingsDialogOverlay", "sensitivityInput", "sensitivityValue", "blurAdvanceInput",
      "scanIntervalInput", "adaptiveScanInput", "nudeNetConfirmInput", "rememberStateInput", "closeSettingsBtn",
    ].forEach((id) => { els[id] = document.getElementById(id); });
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

    els.sensitivityInput.addEventListener("input", onSensitivityChange);
    els.blurAdvanceInput.addEventListener("change", onBlurAdvanceChange);
    els.scanIntervalInput.addEventListener("change", onScanIntervalChange);
    els.adaptiveScanInput.addEventListener("change", onAdaptiveScanChange);
    els.nudeNetConfirmInput.addEventListener("change", onNudeNetConfirmChange);
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
    return Object.assign({}, DEFAULT_SETTINGS, s || {});
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
    els.nudeNetConfirmInput.checked = !!settings.nudeNetConfirm;
    els.rememberStateInput.checked = !!settings.rememberState;
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
  }

  function onAdaptiveScanChange(e) {
    settings.adaptiveScan = !!e.target.checked;
    persistSettings();
  }

  function onNudeNetConfirmChange(e) {
    settings.nudeNetConfirm = !!e.target.checked;
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

  async function openFileFlow(file, handle) {
    if (!file) return;
    const originalName = file.name;

    const playableFile = await ensurePlayableFile(file);
    if (!playableFile) {
      showStartScreen();
      return;
    }

    const existing = await VMDB.get("videos", originalName);
    if (existing && existing.samples && existing.samples.length) {
      showExistingDialog(
        originalName,
        () => usePreScanned(playableFile, handle, existing, 0, true),
        () => startScan(playableFile, handle, originalName)
      );
    } else {
      await startScan(playableFile, handle, originalName);
    }
  }

  // ---------- format compatibility / ffmpeg transcode ----------

  // Returns a File the <video> element can actually play: either the original
  // file (if the browser can decode it), a freshly-transcoded MP4, or null if
  // the browser can't play it and the user declined to convert it.
  async function ensurePlayableFile(file) {
    let playable = false;
    try {
      playable = await VMTranscoder.canBrowserPlay(file);
    } catch (e) {
      console.warn("Playability check failed, assuming not playable.", e);
    }
    if (playable) return file;

    const confirmed = await showTranscodeWarningDialog(file.name);
    if (!confirmed) return null;

    return runTranscode(file);
  }

  function showTranscodeWarningDialog(fileName) {
    els.transcodeFileName.textContent = fileName;
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

  async function runTranscode(file) {
    showTranscodeScreen();
    transcodeCancelToken = VMTranscoder.createCancelToken();
    try {
      const outFile = await VMTranscoder.transcodeToMp4(file, {
        onProgress: updateTranscodeProgress,
        onStatus: (msg) => { els.transcodeStatusText.textContent = msg; },
        token: transcodeCancelToken,
      });
      return outFile;
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

  async function usePreScanned(file, handle, record, resumeTime, resumePaused) {
    await VMDB.put("meta", { id: "app", lastOpenedFileName: record.fileName });
    await loadPlayerWithData(file, handle, record, resumeTime, resumePaused);
  }

  // ---------- scanning ----------

  async function startScan(file, handle, originalName) {
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
        nudeNetConfirm: settings.nudeNetConfirm,
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

      await loadPlayerWithData(file, handle, record, 0, true);
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
    els.video.src = currentObjectUrl;
    setBlur(false);
    showPlayerScreen();

    els.video.addEventListener(
      "loadedmetadata",
      () => {
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

  function onVideoTimeUpdate() {
    if (activeVideo) {
      const t = els.video.currentTime;
      const advance = settings.blurAdvance || 0;
      const shouldBlur = activeVideo.segments.some((seg) => t >= seg.start - advance && t < seg.end);
      setBlur(shouldBlur);
    }
    maybePersistState(false);
  }

  function setBlur(on) {
    els.video.classList.toggle("blurred", on);
    els.blurBadge.classList.toggle("hidden", !on);
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

  // Runs a re-obtained "last opened" file through the same playability/transcode
  // gate as a fresh pick, then loads the player at the remembered position.
  // Returns true if the player was shown, false if the user backed out.
  async function resumeWithFile(file, handle, record) {
    const playableFile = await ensurePlayableFile(file);
    if (!playableFile) return false;
    await loadPlayerWithData(playableFile, handle, record, record.lastCurrentTime, record.lastPaused);
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
})();
