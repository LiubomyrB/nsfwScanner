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

  // The multithreaded core needs the page to be cross-origin isolated
  // (Cross-Origin-Opener-Policy + Cross-Origin-Embedder-Policy response headers)
  // so that SharedArrayBuffer is available.
  function isCrossOriginIsolated() {
    return typeof self !== "undefined" && self.crossOriginIsolated === true && typeof SharedArrayBuffer !== "undefined";
  }

  async function getFFmpeg(onStatus) {
    if (!isCrossOriginIsolated()) {
      throw new Error(
        "This page is not cross-origin isolated (missing Cross-Origin-Opener-Policy / " +
        "Cross-Origin-Embedder-Policy response headers), so the multithreaded FFmpeg engine " +
        "cannot start in this browser session."
      );
    }
    const [{ FFmpeg }, { toBlobURL }] = await loadModules();
    if (ffmpegInstance && ffmpegInstance.loaded) return ffmpegInstance;

    if (!ffmpegInstance) {
      ffmpegInstance = new FFmpeg();
      ffmpegInstance.on("log", ({ message }) => console.debug("[ffmpeg]", message));
    }
    if (onStatus) onStatus("Downloading FFmpeg engine…");
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
  function canBrowserPlay(file, timeoutMs = 4000) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "metadata";
      let done = false;
      const timer = setTimeout(() => finish(false), timeoutMs);
      function finish(ok) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(url);
        resolve(ok);
      }
      video.addEventListener(
        "loadedmetadata",
        () => finish(isFinite(video.duration) && video.duration > 0),
        { once: true }
      );
      video.addEventListener("error", () => finish(false), { once: true });
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

  // Transcodes `file` to an H.264/AAC MP4 File using FFmpeg.wasm (multithreaded core).
  async function transcodeToMp4(file, opts = {}) {
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

    const inputExt = (() => {
      const idx = file.name.lastIndexOf(".");
      return idx >= 0 ? file.name.slice(idx) : ".bin";
    })();
    const inputName = "input" + inputExt;
    const outputName = "output.mp4";

    try {
      const [, { fetchFile }] = await loadModules();

      if (onStatus) onStatus("Loading video into FFmpeg…");
      await ffmpeg.writeFile(inputName, await fetchFile(file));
      if (token && token.cancelled) throw makeCancelledError();

      if (onStatus) onStatus("Transcoding to MP4 (H.264/AAC)…");
      const ret = await ffmpeg.exec([
        "-i", inputName,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        // Cap libx264's own internal thread pool. Leaving this unset lets it default to
        // navigator.hardwareConcurrency threads, which reliably deadlocks partway through
        // the first encoded frame on some multi-core setups (reproduced consistently in
        // testing: 16 auto threads hangs forever, 2-4 explicit threads works instantly) —
        // most likely a libx264/Emscripten-pthreads thread-pool bug, not anything specific
        // to this app. The MT core/runtime is still used for everything else.
        "-threads", "4",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-movflags", "+faststart",
        outputName,
      ]);
      if (ret !== 0) {
        throw new Error("FFmpeg exited with a non-zero status (" + ret + ").");
      }

      const data = await ffmpeg.readFile(outputName); // Uint8Array
      const outFile = new File([data], baseName(file.name) + ".mp4", { type: "video/mp4" });

      try { await ffmpeg.deleteFile(inputName); } catch (e) { /* ignore */ }
      try { await ffmpeg.deleteFile(outputName); } catch (e) { /* ignore */ }

      return outFile;
    } catch (e) {
      if ((token && token.cancelled) || (e && e.message === "called FFmpeg.terminate()")) {
        throw makeCancelledError();
      }
      throw e;
    } finally {
      ffmpeg.off("progress", progressHandler);
    }
  }

  global.VMTranscoder = {
    canBrowserPlay,
    transcodeToMp4,
    createCancelToken,
    resetFFmpeg,
    isCrossOriginIsolated,
  };
})(window);
