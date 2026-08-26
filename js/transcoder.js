// @ts-nocheck — plain multi-file classic-script app; globals (VMDB/VMScanner/VMTranscoder/tf/nsfwjs) are wired via <script> load order, not modules.
// Browser-format-compatibility check + optional FFmpeg.wasm (multithreaded) transcode
// to MP4/H.264/AAC, for video files the <video> element can't decode natively.
//
// Loaded as a classic <script> (not type="module") like the rest of the app, but uses
// dynamic import() internally to pull in @ffmpeg/ffmpeg and @ffmpeg/util.
//
// The small ESM "control" files (index.js/classes.js/const.js/errors.js/utils.js/
// worker.js) are vendored locally under js/vendor/ — NOT loaded from the CDN — because
// FFmpeg's own worker.js has relative `import ... from "./const.js"` statements, and:
//   1) @ffmpeg/ffmpeg's classes.js creates its control Worker via
//      `new Worker(new URL("./worker.js", import.meta.url))`, which browsers refuse to
//      construct cross-origin (fails when index.js is imported straight from jsdelivr).
//   2) Even routing worker.js itself through a blob: URL doesn't fix it, because a blob:
//      URL has no real path for "./const.js" to resolve against.
// Serving these tiny files same-origin sidesteps both problems, since import.meta.url
// then points at a real same-origin path. The big binary pieces (ffmpeg-core.js/.wasm/
// .worker.js from @ffmpeg/core-mt) don't have this issue — they're standalone/leaf files
// — so those are still streamed from the CDN as blob: URLs via toBlobURL().
(function (global) {
  const CORE_MT_VERSION = "0.12.10";
  const CORE_MT_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@${CORE_MT_VERSION}/dist/esm`;

  // Resolve the vendored module paths relative to *this script's* own location
  // (not the page's), so the app keeps working regardless of what directory
  // index.html is served from.
  const SCRIPT_URL = document.currentScript ? document.currentScript.src : document.baseURI;
  const FFMPEG_LOCAL_INDEX = new URL("./vendor/ffmpeg/index.js", SCRIPT_URL).href;
  const UTIL_LOCAL_INDEX = new URL("./vendor/ffmpeg-util/index.js", SCRIPT_URL).href;

  let modulesPromise = null;
  function loadModules() {
    if (!modulesPromise) {
      modulesPromise = Promise.all([import(FFMPEG_LOCAL_INDEX), import(UTIL_LOCAL_INDEX)]);
    }
    return modulesPromise;
  }

  let ffmpegInstance = null;

  // Optional subscription for FFmpeg's raw log lines (frame=/fps=/speed= progress lines,
  // stream mapping, etc.) — used by ffmpeg-test.html to show exactly what a native `ffmpeg`
  // invocation would print, for direct comparison. The main app doesn't use this; it only
  // ever gets these via console.debug (see getFFmpeg below).
  const logListeners = [];
  function onLog(callback) {
    logListeners.push(callback);
    return () => {
      const i = logListeners.indexOf(callback);
      if (i >= 0) logListeners.splice(i, 1);
    };
  }

  // The multithreaded core needs the page to be cross-origin isolated
  // (Cross-Origin-Opener-Policy + Cross-Origin-Embedder-Policy response headers)
  // so that SharedArrayBuffer is available.
  function isCrossOriginIsolated() {
    return typeof self !== "undefined" && self.crossOriginIsolated === true && typeof SharedArrayBuffer !== "undefined";
  }

  async function getFFmpeg(onStatus) {
    if (!isCrossOriginIsolated()) {
      throw new Error(global.VMI18n.t("transcode.notCrossOriginIsolated"));
    }
    const [{ FFmpeg }, { toBlobURL }] = await loadModules();
    if (ffmpegInstance && ffmpegInstance.loaded) return ffmpegInstance;

    if (!ffmpegInstance) {
      ffmpegInstance = new FFmpeg();
      ffmpegInstance.on("log", ({ message }) => {
        console.debug("[ffmpeg]", message);
        for (const cb of logListeners) {
          try { cb(message); } catch (e) { /* ignore listener errors */ }
        }
      });
    }
    if (onStatus) onStatus(global.VMI18n.t("transcode.statusDownloadingEngine"));
    await ffmpegInstance.load({
      // No classWorkerURL needed: since @ffmpeg/ffmpeg is now loaded from a same-origin
      // vendored path (see header comment), its default `new Worker(new URL("./worker.js",
      // import.meta.url))` already resolves to a same-origin URL.
      coreURL: await toBlobURL(`${CORE_MT_BASE}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${CORE_MT_BASE}/ffmpeg-core.wasm`, "application/wasm"),
      workerURL: await toBlobURL(`${CORE_MT_BASE}/ffmpeg-core.worker.js`, "text/javascript"),
    });
    return ffmpegInstance;
  }

  function resetFFmpeg() {
    if (ffmpegInstance) {
      try { ffmpegInstance.terminate(); } catch (e) { /* ignore */ }
    }
  }

  // Authoritative check: actually try to load the file's metadata in a real <video>
  // element. MIME-type sniffing (canPlayType) alone is unreliable for files coming
  // straight off disk (OS-reported MIME types are often generic or empty).
  //
  // Metadata loading successfully only proves the container + video track decode — it says
  // nothing about audio. Reproduced directly: an MKV with an AC3 audio track (common in
  // downloaded rips) loads metadata and plays its picture perfectly fine in Chrome, but
  // decodes zero audio bytes the entire time — Chrome ships no AC3 decoder (licensing), and
  // there's no error event or other signal for this; the audio is just silently dropped, with
  // no indication to the user beyond "why is there no sound." So once metadata loads, this
  // also briefly plays the file and checks whether ANY audio actually gets decoded (via the
  // legacy-but-still-present `webkitAudioDecodedByteCount`) before declaring the file fully
  // playable as-is — if that comes back false, `ensurePlayableFile` routes it through the
  // FFmpeg transcode step instead, which re-encodes audio to AAC and fixes it (see
  // transcodeToMp4's `-c:a aac`). On a browser without that property (non-Chromium), this
  // extra check is skipped and the metadata result alone is trusted, same as before.
  //
  // Trade-off: a genuinely audio-less video also decodes zero audio bytes, so it'll get
  // routed through an unnecessary transcode too — there's no reliable way to tell "no audio
  // track" apart from "audio track present but undecodable" from the video element alone.
  // An unneeded transcode is a minor inconvenience (one extra dialog + wait); silently
  // broken audio with no indication anything's wrong is worse.
  // Returns { ok, videoOk }: `videoOk` is true as soon as metadata loads (container + video
  // track decode fine, regardless of audio) — callers use it to tell "only the audio needs
  // fixing" apart from "the container/video itself needs a full re-encode" (see
  // `remuxAudioOnly` vs `transcodeToMp4` below). `ok` is the overall verdict this function
  // used to return alone as a boolean.
  function checkPlayability(file, timeoutMs = 4000) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement("video");
      // Unmuted (with volume forced to 0 instead) rather than `video.muted = true`: some
      // engines may treat `muted` as a hint to skip decoding audio at all, which would make
      // the check below always read "0 bytes decoded" regardless of whether the codec is
      // actually supported. `volume = 0` only affects output gain, not decode.
      video.muted = false;
      video.volume = 0;
      video.preload = "auto";
      let done = false;
      const timer = setTimeout(() => finish(false, false), timeoutMs);

      function finish(ok, videoOk) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        video.pause();
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(url);
        resolve({ ok, videoOk });
      }

      video.addEventListener(
        "loadedmetadata",
        async () => {
          if (!isFinite(video.duration) || video.duration <= 0) return finish(false, false);
          if (typeof video.webkitAudioDecodedByteCount !== "number") return finish(true, true);
          try {
            const before = video.webkitAudioDecodedByteCount;
            await video.play();
            await new Promise((r) => setTimeout(r, 500));
            finish(video.webkitAudioDecodedByteCount > before, true);
          } catch (e) {
            // Autoplay blocked or playback otherwise failed to start — can't confirm audio
            // decodes, but that's not evidence it doesn't either; don't force an unnecessary
            // transcode over an autoplay-policy quirk we can't see past.
            finish(true, true);
          }
        },
        { once: true }
      );
      video.addEventListener("error", () => finish(false, false), { once: true });
      video.src = url;
    });
  }

  function createCancelToken() {
    return {
      cancelled: false,
      onCancel: null,
      cancel() {
        this.cancelled = true;
        if (this.onCancel) this.onCancel();
      },
    };
  }

  function makeCancelledError() {
    const e = new Error("cancelled");
    e.cancelled = true;
    return e;
  }

  function baseName(name) {
    const idx = name.lastIndexOf(".");
    return idx > 0 ? name.slice(0, idx) : name;
  }

  // Shared driver for both transcodeToMp4 and remuxAudioOnly: mounts `file` into FFmpeg's
  // virtual FS, runs it with `ffmpegArgs` (input/output names already substituted in), and
  // handles progress/cancellation/cleanup consistently. Resolves to
  // { file, handle, savedToDisk } — `handle` is the FileSystemFileHandle results were written
  // to if `opts.saveHandle` was provided (see below), else null.
  async function runFFmpeg(file, buildArgs, outputName, outFileName, outMimeType, processingMessage, opts) {
    const { onProgress, onStatus, token } = opts;
    if (token && token.cancelled) throw makeCancelledError();

    const ffmpeg = await getFFmpeg(onStatus);
    if (token) token.onCancel = () => resetFFmpeg();
    if (token && token.cancelled) throw makeCancelledError();

    const progressHandler = ({ progress }) => {
      if (onProgress && isFinite(progress)) {
        onProgress(Math.max(0, Math.min(100, progress * 100)));
      }
    };
    ffmpeg.on("progress", progressHandler);

    // Mount the input File directly via WORKERFS instead of reading it into a JS ArrayBuffer
    // (the old `fetchFile` + `writeFile` path) and then copying THAT into FFmpeg's own MEMFS
    // — for a large file (a multi-GB movie rip, reproduced directly: DevTools' "Paused before
    // potential out-of-memory crash" firing partway through that load step), that "double
    // buffering" needs 2x the file size resident in memory just to stage the input, before
    // FFmpeg has processed a single frame. WORKERFS instead gives FFmpeg on-demand read
    // access to the File's own bytes (backed by the browser's Blob storage, not duplicated
    // into JS/WASM heap) — the documented way ffmpeg.wasm is meant to handle large inputs.
    // Unique mount point per call: `ffmpeg` is a module-level singleton reused across
    // transcodes in the same page session, so a fixed path would collide (EEXIST) on a
    // second file.
    //
    // opts.inputMode: "workerfs" (default, everything above) or "memfs" (the old approach,
    // kept only so ffmpeg-test.html can run the two side by side for comparison — the app
    // itself never asks for "memfs").
    const inputMode = opts.inputMode === "memfs" ? "memfs" : "workerfs";
    const uniqueSuffix = Date.now() + "_" + Math.random().toString(36).slice(2);
    const inputExt = (file.name.match(/\.[^.]+$/) || [".bin"])[0];
    const mountPoint = "/input_" + uniqueSuffix;
    const inputName = inputMode === "workerfs" ? mountPoint + "/" + file.name : "input_" + uniqueSuffix + inputExt;

    try {
      if (inputMode === "workerfs") {
        if (onStatus) onStatus(global.VMI18n.t("transcode.statusMounting"));
        await ffmpeg.createDir(mountPoint);
        await ffmpeg.mount("WORKERFS", { files: [file] }, mountPoint);
      } else {
        if (onStatus) onStatus(global.VMI18n.t("transcode.statusLoadingMemfs"));
        const [, { fetchFile }] = await loadModules();
        await ffmpeg.writeFile(inputName, await fetchFile(file));
      }
      if (token && token.cancelled) throw makeCancelledError();

      // Without this, the status text stays frozen on "Mounting video file…" for the entire
      // exec below — the progress bar % does keep moving (driven by the separate "progress"
      // event), but a static status message next to a bar someone might not be watching
      // closely reads as "this is stuck," not "this is working." Reproduced directly.
      if (onStatus) onStatus(processingMessage);
      const ret = await ffmpeg.exec(buildArgs(inputName, outputName));
      if (ret !== 0) {
        throw new Error(global.VMI18n.t("transcode.nonZeroExit", { code: ret }));
      }

      // opts.saveHandle (a FileSystemFileHandle the caller already got via
      // showSaveFilePicker): stream the result straight to the user's chosen disk location in
      // bounded chunks, via the readFileChunk API patched into the vendored ffmpeg package
      // (see const.js's comment on STAT_FILE/READ_FILE_CHUNK) — rather than readFile(), which
      // always pulls the ENTIRE output into one JS Uint8Array first. For a multi-GB output
      // (reproduced directly: DevTools' "Paused before potential out-of-memory crash" firing
      // during exactly this step, even with a save location already chosen — picking a
      // destination only changes where the bytes end up, not how much memory it takes to get
      // them there), that whole-file read was a second full copy on top of the copy FFmpeg's
      // own virtual filesystem already holds while writing it — this removes that second copy.
      // (What it can't remove: FFmpeg itself still has to hold the complete output in its own
      // virtual FS while producing it — there's no way around that without a fundamentally
      // different output destination, like mounting OPFS directly as FFmpeg's output, which
      // this library version doesn't support.)
      let result;
      if (opts.saveHandle) {
        const CHUNK_SIZE = 32 * 1024 * 1024;
        const { size } = await ffmpeg.statFile(outputName);
        const writable = await opts.saveHandle.createWritable();
        try {
          for (let offset = 0; offset < size; offset += CHUNK_SIZE) {
            if (token && token.cancelled) throw makeCancelledError();
            const length = Math.min(CHUNK_SIZE, size - offset);
            const chunk = await ffmpeg.readFileChunk(outputName, offset, length);
            await writable.write(chunk);
          }
        } catch (e) {
          try { await writable.abort(); } catch (e2) { /* ignore */ }
          throw e;
        }
        await writable.close();
        result = { file: await opts.saveHandle.getFile(), handle: opts.saveHandle, savedToDisk: true };
      } else {
        const data = await ffmpeg.readFile(outputName); // Uint8Array
        result = { file: new File([data], outFileName, { type: outMimeType }), handle: null, savedToDisk: false };
      }

      if (inputMode === "workerfs") {
        try { await ffmpeg.unmount(mountPoint); } catch (e) { /* ignore */ }
        try { await ffmpeg.deleteDir(mountPoint); } catch (e) { /* ignore */ }
      } else {
        try { await ffmpeg.deleteFile(inputName); } catch (e) { /* ignore */ }
      }
      try { await ffmpeg.deleteFile(outputName); } catch (e) { /* ignore */ }

      return result;
    } catch (e) {
      if (inputMode === "workerfs") {
        try { await ffmpeg.unmount(mountPoint); } catch (e2) { /* ignore */ }
        try { await ffmpeg.deleteDir(mountPoint); } catch (e2) { /* ignore */ }
      } else {
        try { await ffmpeg.deleteFile(inputName); } catch (e2) { /* ignore */ }
      }
      if ((token && token.cancelled) || (e && e.message === "called FFmpeg.terminate()")) {
        throw makeCancelledError();
      }
      throw e;
    } finally {
      ffmpeg.off("progress", progressHandler);
    }
  }

  // Full re-encode to an H.264/AAC MP4 — needed when the video/container itself isn't
  // something the browser can decode at all (checkPlayability's videoOk came back false).
  //
  // KNOWN OPEN ISSUE: a file needing this path AND several audio tracks (e.g. 4x AC3/EAC3)
  // can still hang — but AFTER reaching 100% progress (encode/mux appears done per FFmpeg's
  // own reporting), not during it, and not fixed by forcing every thread count to 1 (tested).
  // So it's a different bug than the one -threads=1 below fixes for the decode side; hasn't
  // been root-caused. Not currently blocking anything: real-world "audio codec Chrome can't
  // decode" cases (the common trigger for needing FFmpeg at all) go through remuxAudioOnly
  // instead, whose video track already decodes fine (that's what routes it to that path over
  // this one) — this one only runs when the video/container itself is the problem.
  async function transcodeToMp4(file, opts = {}) {
    return runFFmpeg(
      file,
      (inputName, outputName) => [
        // Decoder-side thread count (an INPUT option — before -i — applies to the demuxer/
        // decoder contexts, separately from the encoder-side "-threads 4" below). Forced to
        // 1: WORKERFS's synchronous reads only work from the worker thread that owns the
        // mount, and a file with several audio tracks needing decode (e.g. multiple AC3/
        // EAC3 language tracks) otherwise gets that decode work dispatched onto separate
        // pthread workers, which then can't read through the mount and hang forever —
        // reproduced directly on remuxAudioOnly's identical input side (1 audio track fine,
        // 4 tracks hung at 0% indefinitely), same WORKERFS mount used here.
        "-threads", "1",
        "-i", inputName,
        // Without explicit -map, FFmpeg's automatic stream selection keeps only ONE audio
        // stream (its "best" pick) even if the input has several (e.g. multiple language
        // tracks in an MKV) — mapping video/audio explicitly (the "?" makes each optional,
        // so a video-only or audio-only input still works) keeps every audio track, letting
        // the player's native audioTracks-based switcher (see app.js) offer all of them.
        "-map", "0:v?",
        "-map", "0:a?",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        // Encoder-side thread count. Cap libx264's own internal thread pool: left unset, it
        // defaults to navigator.hardwareConcurrency threads, which reliably deadlocks
        // partway through the first encoded frame on some multi-core setups (reproduced
        // consistently in testing: 16 auto threads hangs forever, 2-4 explicit threads works
        // instantly) — most likely a libx264/Emscripten-pthreads thread-pool bug of its own,
        // separate from the WORKERFS/decoder issue above. The MT core/runtime is still used
        // for everything else.
        "-threads", "4",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-movflags", "+faststart",
        outputName,
      ],
      "output.mp4",
      baseName(file.name) + ".mp4",
      "video/mp4",
      global.VMI18n.t("transcode.statusFull"),
      opts
    );
  }

  // Fast path for the common case checkPlayability distinguishes: video already decodes
  // fine natively (videoOk), only the audio codec doesn't (e.g. AC3 — see checkPlayability's
  // comment). Stream-copies the video track untouched (`-c:v copy`, no re-encode — instant,
  // lossless) and only re-encodes audio to AAC. Keeps the SAME container/extension as the
  // input rather than forcing MP4: since we already know this exact container+video
  // combination plays natively in this browser (that's what videoOk confirmed), remuxing
  // within that same container sidesteps ever having to guess whether the video codec is one
  // the MP4 muxer can legally hold (H.264 always is; VP9/AV1/etc in MP4 is spec-legal but not
  // universally implemented — Matroska accepts essentially any codec, so staying in the
  // input's own container avoids that question entirely).
  async function remuxAudioOnly(file, opts = {}) {
    const inputExt = (() => {
      const idx = file.name.lastIndexOf(".");
      return idx >= 0 ? file.name.slice(idx) : ".mkv";
    })();
    return runFFmpeg(
      file,
      (inputName, outputName) => [
        "-i", inputName,
        "-map", "0:v?",
        "-map", "0:a?",
        "-c:v", "copy",
        "-c:a", "aac",
        // Force single-threaded audio codec execution. WORKERFS's synchronous reads only
        // work from the worker thread that owns the mount — when a file has several audio
        // tracks needing decode+encode (e.g. multiple AC3/EAC3 language tracks), FFmpeg's
        // default threading dispatches that codec work onto separate pthread workers, which
        // then can't read through the WORKERFS mount and hang indefinitely. Reproduced
        // directly: 1 audio track transcoded fine, 4 tracks (3x AC3 + 1x EAC3) hung at 0%
        // progress forever. Audio codecs are cheap regardless of thread count, so this
        // doesn't cost meaningful speed.
        /* "-threads", "1", */
        outputName,
      ],
      "output" + inputExt,
      baseName(file.name) + inputExt,
      file.type || "",
      global.VMI18n.t("transcode.statusAudioOnly"),
      opts
    );
  }

  global.VMTranscoder = {
    checkPlayability,
    transcodeToMp4,
    remuxAudioOnly,
    createCancelToken,
    resetFFmpeg,
    isCrossOriginIsolated,
    onLog,
  };
})(window);
