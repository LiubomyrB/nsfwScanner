(function () {
  const DEFAULT_SETTINGS = { sensitivity: 0.6, blurAdvance: 1.5, rememberState: true };

  const els = {};
  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let activeVideo = null; // { fileName, file, handle, samples, interval, duration, segments }
  let currentObjectUrl = null;
  let cancelToken = null;
  let pendingExisting = null;
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
      "playerScreen", "video", "blurBadge", "fileNameLabel",
      "fileInput",
      "existingDialogOverlay", "existingFileName", "useExistingBtn", "rescanBtn",
      "settingsDialogOverlay", "sensitivityInput", "sensitivityValue", "blurAdvanceInput",
      "rememberStateInput", "closeSettingsBtn",
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
    const existing = await VMDB.get("videos", file.name);
    if (existing && existing.samples && existing.samples.length) {
      showExistingDialog(
        file.name,
        () => usePreScanned(file, handle, existing, 0, true),
        () => startScan(file, handle)
      );
    } else {
      await startScan(file, handle);
    }
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

  async function startScan(file, handle) {
    showScanScreen();
    cancelToken = VMScanner.createCancelToken();
    try {
      const { samples, duration, interval } = await VMScanner.scanVideoFile(file, {
        onProgress: updateScanProgress,
        onStatus: (msg) => { els.scanStatusText.textContent = msg; },
        token: cancelToken,
      });

      const segments = VMScanner.mergeSegments(samples, settings.sensitivity, interval);
      const txt = VMScanner.segmentsToTxt(segments, file.name);
      downloadTxt(txt, baseName(file.name) + "_timecodes.txt");

      const record = {
        fileName: file.name,
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

      await VMDB.put("videos", record);
      await VMDB.put("meta", { id: "app", lastOpenedFileName: file.name });

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

    els.fileNameLabel.textContent = record.fileName;
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
          await loadPlayerWithData(file, record.fileHandle, record, record.lastCurrentTime, record.lastPaused);
          return;
        } catch (e) {
          console.warn("Could not silently reopen last file, showing resume banner instead.", e);
        }
      }
    }
    showResumeBanner(record);
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
            await loadPlayerWithData(file, record.fileHandle, record, record.lastCurrentTime, record.lastPaused);
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
        await loadPlayerWithData(picked.file, picked.handle, record, record.lastCurrentTime, record.lastPaused);
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
    els.playerScreen.classList.add("hidden");
  }

  function showScanScreen() {
    els.startScreen.classList.add("hidden");
    els.scanScreen.classList.remove("hidden");
    els.playerScreen.classList.add("hidden");
    els.scanProgressBar.style.width = "0%";
    els.scanProgressText.textContent = "0%";
    els.scanStatusText.textContent = "Loading model…";
  }

  function showPlayerScreen() {
    els.startScreen.classList.add("hidden");
    els.scanScreen.classList.add("hidden");
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
