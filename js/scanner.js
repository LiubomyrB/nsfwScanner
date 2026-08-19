// NSFWJS-based scanning of a local video File, plus segment/text helpers.
// Relies on the global `tf` and `nsfwjs` objects loaded via <script> tags.
(function (global) {
  const IMAGE_SIZE = 224;
  let modelPromise = null;

  async function loadModel(onStatus) {
    if (modelPromise) return modelPromise;
    modelPromise = (async () => {
      if (onStatus) onStatus("Setting up TensorFlow backend…");
      try {
        await tf.setBackend("webgl");
      } catch (e) {
        await tf.setBackend("cpu");
      }
      await tf.ready();
      if (onStatus) onStatus("Loading NSFW detection model…");
      // "MobileNetV2" is resolved from the window.model / window.group1_shard1of1
      // globals set by the model <script> tags included in index.html.
      return nsfwjs.load("MobileNetV2");
    })();
    return modelPromise;
  }

  // NSFWJS classes: Drawing, Hentai, Neutral, Porn, Sexy.
  // We treat Porn/Hentai/Sexy as contributing to "nudity" probability.
  function nudityScore(predictions) {
    let score = 0;
    for (const p of predictions) {
      if (p.className === "Porn" || p.className === "Hentai" || p.className === "Sexy") {
        score += p.probability;
      }
    }
    return Math.min(1, score);
  }

  function createCancelToken() {
    return {
      cancelled: false,
      cancel() {
        this.cancelled = true;
      },
    };
  }

  function seekTo(video, time) {
    return new Promise((resolve) => {
      function onSeeked() {
        video.removeEventListener("seeked", onSeeked);
        // double rAF so the decoded frame is actually painted before we read pixels
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }
      video.addEventListener("seeked", onSeeked);
      try {
        video.currentTime = time;
      } catch (e) {
        video.removeEventListener("seeked", onSeeked);
        resolve();
      }
    });
  }

  // Scans `file` by seeking a hidden <video> element across its duration and
  // classifying a downscaled frame at each sample point.
  async function scanVideoFile(file, opts = {}) {
    const { onProgress, onStatus, token, sampleTarget = 240 } = opts;
    const model = await loadModel(onStatus);
    if (onStatus) onStatus("Preparing video…");

    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;
    video.style.position = "fixed";
    video.style.left = "-99999px";
    video.style.top = "0";
    video.style.width = "1px";
    video.style.height = "1px";
    document.body.appendChild(video);

    const canvas = document.createElement("canvas");
    canvas.width = IMAGE_SIZE;
    canvas.height = IMAGE_SIZE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    try {
      await new Promise((resolve, reject) => {
        video.addEventListener("loadedmetadata", resolve, { once: true });
        video.addEventListener(
          "error",
          () => reject(video.error || new Error("Could not load the video file.")),
          { once: true }
        );
      });

      const duration = video.duration;
      if (!isFinite(duration) || duration <= 0) {
        throw new Error("Could not determine video duration.");
      }

      const interval = Math.min(3, Math.max(0.5, duration / sampleTarget));
      const samples = [];

      if (onStatus) onStatus("Scanning frames…");
      let t = 0;
      while (t < duration) {
        if (token && token.cancelled) {
          const err = new Error("cancelled");
          err.cancelled = true;
          throw err;
        }
        await seekTo(video, t);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const predictions = await model.classify(canvas);
        samples.push({ time: t, probability: nudityScore(predictions) });
        if (onProgress) onProgress(Math.min(100, (t / duration) * 100));
        t += interval;
      }
      // Always sample near the very end too.
      const tail = Math.max(0, duration - Math.min(0.1, interval / 4));
      if (!samples.length || samples[samples.length - 1].time < tail) {
        await seekTo(video, tail);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const predictions = await model.classify(canvas);
        samples.push({ time: tail, probability: nudityScore(predictions) });
      }
      if (onProgress) onProgress(100);

      return { samples, duration, interval };
    } finally {
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.remove();
      URL.revokeObjectURL(url);
    }
  }

  // Turns raw {time, probability} samples into merged [start, end] ranges
  // wherever probability >= sensitivity, using `interval` to close each
  // range a little past its last flagged sample.
  function mergeSegments(samples, sensitivity, interval) {
    if (!samples || !samples.length) return [];
    const gap = interval || 1;
    const segments = [];
    let start = null;
    let last = null;
    let maxProb = 0;

    for (const s of samples) {
      if (s.probability >= sensitivity) {
        if (start === null) {
          start = s.time;
          maxProb = s.probability;
        } else {
          maxProb = Math.max(maxProb, s.probability);
        }
        last = s.time;
      } else if (start !== null) {
        segments.push({ start, end: last + gap, probability: maxProb });
        start = null;
      }
    }
    if (start !== null) {
      segments.push({ start, end: last + gap, probability: maxProb });
    }
    return segments;
  }

  function formatTime(totalSeconds) {
    const clamped = Math.max(0, totalSeconds || 0);
    const ms = Math.round((clamped % 1) * 1000);
    const totalWhole = Math.floor(clamped);
    const h = Math.floor(totalWhole / 3600);
    const m = Math.floor((totalWhole % 3600) / 60);
    const s = totalWhole % 60;
    const pad = (n, l = 2) => String(n).padStart(l, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
  }

  function segmentsToTxt(segments, fileName) {
    const lines = [];
    lines.push(`# Nudity scan results for: ${fileName}`);
    lines.push(`# Generated: ${new Date().toString()}`);
    lines.push(`# Format: start - end : probability`);
    if (!segments.length) {
      lines.push("# No nudity scenes detected above the configured sensitivity.");
    }
    for (const seg of segments) {
      lines.push(`${formatTime(seg.start)} - ${formatTime(seg.end)} : ${seg.probability.toFixed(3)}`);
    }
    return lines.join("\n") + "\n";
  }

  global.VMScanner = {
    loadModel,
    scanVideoFile,
    mergeSegments,
    formatTime,
    segmentsToTxt,
    nudityScore,
    createCancelToken,
  };
})(window);
