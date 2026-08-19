// @ts-nocheck — plain multi-file classic-script app; globals (VMDB/VMScanner/VMTranscoder/tf/nsfwjs) are wired via <script> load order, not modules.
// NSFWJS-based scanning of a local video File, plus segment/text helpers.
//
// Frame classification runs in a small pool of Web Workers (js/scan-worker.js), pipelined
// with main-thread video seeking, instead of blocking the main thread on one classify()
// call at a time. Each worker picks WebGL or WASM for itself depending on whether it
// detects real GPU acceleration or a software renderer. See js/scan-worker.js for why.
(function (global) {
  const IMAGE_SIZE = 224;

  // Resolve scan-worker.js relative to *this script's* own location (same reasoning as
  // transcoder.js's vendored-module path) so it keeps working regardless of what
  // directory index.html is served from.
  const WORKER_URL = new URL(
    "./scan-worker.js",
    document.currentScript ? document.currentScript.src : document.baseURI
  ).href;

  let poolPromise = null;
  let rrCounter = 0;
  let msgId = 0;

  function poolSize() {
    const hw = navigator.hardwareConcurrency || 4;
    // Leave a core free for the main thread/UI; cap so we don't spin up an excessive
    // number of workers (each one loads its own full copy of tf.js + model weights).
    return Math.max(1, Math.min(4, hw - 1));
  }

  // Lazily spins up a pool of scan workers and waits for each to finish loading its
  // model. The pool is a module-level singleton: it survives across scans/rescans in
  // the same page session so a rescan doesn't pay worker-startup + model-load cost again.
  function getWorkerPool(onStatus) {
    if (!poolPromise) {
      poolPromise = (async () => {
        const size = poolSize();
        if (onStatus) onStatus(`Starting ${size} scan worker${size > 1 ? "s" : ""}…`);
        const entries = Array.from({ length: size }, () => ({ worker: new Worker(WORKER_URL) }));
        await Promise.all(
          entries.map(
            (entry) =>
              new Promise((resolve, reject) => {
                function onMessage(e) {
                  if (!e.data || !e.data.ready) return;
                  entry.worker.removeEventListener("message", onMessage);
                  entry.backend = e.data.backend;
                  if (e.data.error) reject(new Error(e.data.error));
                  else resolve();
                }
                entry.worker.addEventListener("message", onMessage);
                entry.worker.addEventListener(
                  "error",
                  (e) => reject(new Error(e.message || "Scan worker failed to start.")),
                  { once: true }
                );
              })
          )
        );
        if (onStatus) {
          const backend = entries[0] && entries[0].backend;
          onStatus(`Scanning with ${size} worker${size > 1 ? "s" : ""} (${backend})…`);
        }
        return entries;
      })();
    }
    return poolPromise;
  }

  // Sends one frame to the next worker (simple round-robin) and resolves with its
  // nudity-probability score.
  function classifyInPool(pool, bitmap) {
    const entry = pool[rrCounter % pool.length];
    rrCounter++;
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      function onMessage(e) {
        if (!e.data || e.data.id !== id) return;
        entry.worker.removeEventListener("message", onMessage);
        if (e.data.ok) resolve(e.data.probability);
        else reject(new Error(e.data.error || "Classification failed."));
      }
      entry.worker.addEventListener("message", onMessage);
      entry.worker.postMessage({ id, bitmap }, [bitmap]);
    });
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

  async function grabBitmap(video, canvas, ctx) {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return createImageBitmap(canvas);
  }

  // Seeks to each of `times` (ascending) and classifies the frame there, pipelined:
  // seeking the next frame doesn't wait for the previous frame's classify() to finish —
  // up to a small bounded number of classify calls are kept in flight across the worker
  // pool at once. Returns samples sorted by time (completion order isn't guaranteed).
  async function sampleAtTimes(video, canvas, ctx, times, pool, opts = {}) {
    const { token, onSampleDone } = opts;
    const results = [];
    const inFlight = [];
    const maxInFlight = pool.length * 2;

    for (const time of times) {
      if (token && token.cancelled) break;
      await seekTo(video, time);
      const bitmap = await grabBitmap(video, canvas, ctx);
      const p = classifyInPool(pool, bitmap).then((probability) => {
        const sample = { time, probability };
        results.push(sample);
        if (onSampleDone) onSampleDone(sample);
      });
      inFlight.push(p);
      if (inFlight.length >= maxInFlight) {
        await inFlight.shift();
      }
    }
    await Promise.all(inFlight);
    results.sort((a, b) => a.time - b.time);
    return results;
  }

  function buildUniformTimes(duration, interval) {
    const times = [];
    for (let t = 0; t < duration; t += interval) times.push(t);
    const tail = Math.max(0, duration - Math.min(0.1, interval / 4));
    if (!times.length || times[times.length - 1] < tail) times.push(tail);
    return times;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function mergeWindows(windows) {
    if (!windows.length) return [];
    const sorted = windows.slice().sort((a, b) => a.start - b.start);
    const out = [Object.assign({}, sorted[0])];
    for (let i = 1; i < sorted.length; i++) {
      const last = out[out.length - 1];
      if (sorted[i].start <= last.end) last.end = Math.max(last.end, sorted[i].end);
      else out.push(Object.assign({}, sorted[i]));
    }
    return out;
  }

  // Plain, uniform-interval scan — the "fully thorough" option.
  async function scanUniform(video, canvas, ctx, duration, interval, pool, opts) {
    const times = buildUniformTimes(duration, interval);
    let done = 0;
    return sampleAtTimes(video, canvas, ctx, times, pool, {
      token: opts.token,
      onSampleDone: () => {
        done++;
        if (opts.onProgress) opts.onProgress(Math.min(100, (done / times.length) * 100));
      },
    });
  }

  // Two-pass adaptive scan: a fast coarse pass across the whole video first, then a
  // fine-interval refine pass ONLY in the neighborhood of anything the coarse pass found
  // close to the sensitivity threshold. Cuts total classify() calls dramatically on
  // typical videos (most of a video is "safe") while keeping fine-interval precision at
  // detected scene boundaries. Trade-off: a scene shorter than the coarse interval that
  // falls entirely between two "clean" coarse samples can still be missed — this is the
  // same fundamental limit any interval-based scan has, just at the coarse interval's
  // resolution instead of the fine one for the (hopefully rare) regions never flagged by
  // pass 1. Keep the coarse interval modest (a few seconds) to keep that risk low.
  async function scanAdaptive(video, canvas, ctx, duration, fineInterval, pool, opts) {
    const sensitivity = typeof opts.sensitivity === "number" ? opts.sensitivity : 0.6;
    const coarseInterval = clamp(fineInterval * 5, 1.5, 5);

    if (opts.onStatus) opts.onStatus("Scanning (coarse pass)…");
    const coarseTimes = buildUniformTimes(duration, coarseInterval);
    let coarseDone = 0;
    const coarseSamples = await sampleAtTimes(video, canvas, ctx, coarseTimes, pool, {
      token: opts.token,
      onSampleDone: () => {
        coarseDone++;
        if (opts.onProgress) opts.onProgress(Math.min(50, (coarseDone / coarseTimes.length) * 50));
      },
    });

    if (opts.token && opts.token.cancelled) return coarseSamples;

    // Anything even somewhat close to the threshold gets its neighborhood re-scanned at
    // full precision — a margin below `sensitivity`, not just an exact crossing, so we
    // don't miss a scene whose peak the coarse pass just barely undersampled.
    const margin = 0.2;
    const windows = [];
    for (const s of coarseSamples) {
      if (s.probability >= Math.max(0, sensitivity - margin)) {
        windows.push({
          start: Math.max(0, s.time - coarseInterval),
          end: Math.min(duration, s.time + coarseInterval),
        });
      }
    }
    const merged = mergeWindows(windows);

    if (!merged.length) {
      if (opts.onProgress) opts.onProgress(100);
      return coarseSamples;
    }

    if (opts.onStatus) opts.onStatus(`Refining ${merged.length} detected region${merged.length > 1 ? "s" : ""}…`);
    const fineTimesSet = new Set();
    for (const w of merged) {
      for (let t = w.start; t <= w.end; t += fineInterval) fineTimesSet.add(+t.toFixed(3));
    }
    const fineTimes = Array.from(fineTimesSet).sort((a, b) => a - b);

    let fineDone = 0;
    const fineSamples = await sampleAtTimes(video, canvas, ctx, fineTimes, pool, {
      token: opts.token,
      onSampleDone: () => {
        fineDone++;
        if (opts.onProgress) opts.onProgress(50 + Math.min(50, (fineDone / fineTimes.length) * 50));
      },
    });

    // Prefer the fine samples inside refined windows; keep coarse samples elsewhere.
    const insideWindows = (t) => merged.some((w) => t >= w.start - 1e-6 && t <= w.end + 1e-6);
    const keptCoarse = coarseSamples.filter((s) => !insideWindows(s.time));
    const combined = keptCoarse.concat(fineSamples).sort((a, b) => a.time - b.time);
    if (opts.onProgress) opts.onProgress(100);
    return combined;
  }

  // Scans `file` by seeking a hidden <video> element across its duration and classifying
  // a downscaled frame at each sample point (in a worker pool — see header comment).
  //
  // `sampleInterval` (seconds) pins the exact gap between sampled frames — smaller values
  // catch scene boundaries more precisely at the cost of a slower scan. When omitted, an
  // interval is derived from `sampleTarget` (an approximate total sample count) instead.
  //
  // `adaptive: true` runs the two-pass coarse-then-refine strategy described above
  // instead of a single uniform pass at `sampleInterval`; `sensitivity` is required in
  // that case to decide which regions get refined.
  async function scanVideoFile(file, opts = {}) {
    const { onProgress, onStatus, token, sampleTarget = 240, sampleInterval, adaptive, sensitivity } = opts;
    const pool = await getWorkerPool(onStatus);
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
    // No willReadFrequently here: we hand frames off via createImageBitmap(), not
    // getImageData(), so letting the 2D context stay GPU-backed is faster.
    const ctx = canvas.getContext("2d");

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

      const interval = sampleInterval && isFinite(sampleInterval) && sampleInterval > 0
        ? Math.max(0.1, sampleInterval)
        : Math.min(3, Math.max(0.5, duration / sampleTarget));

      let samples;
      if (adaptive) {
        samples = await scanAdaptive(video, canvas, ctx, duration, interval, pool, { token, onProgress, onStatus, sensitivity });
      } else {
        if (onStatus) onStatus("Scanning frames…");
        samples = await scanUniform(video, canvas, ctx, duration, interval, pool, { token, onProgress });
      }

      if (token && token.cancelled) {
        const err = new Error("cancelled");
        err.cancelled = true;
        throw err;
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

  // Turns raw {time, probability} samples (sorted ascending by time) into merged
  // [start, end] ranges wherever probability >= sensitivity. Each range's end uses the
  // real gap to the next sample (capped, to avoid a huge tail if coverage has a hole),
  // falling back to `fallbackInterval` for an open-ended run at the very end of the
  // samples array — this also makes segment boundaries correct for adaptive scans, whose
  // samples aren't evenly spaced.
  function mergeSegments(samples, sensitivity, fallbackInterval) {
    if (!samples || !samples.length) return [];
    const gapFallback = fallbackInterval || 1;
    const segments = [];
    let start = null;
    let last = null;
    let maxProb = 0;

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (s.probability >= sensitivity) {
        if (start === null) {
          start = s.time;
          maxProb = s.probability;
        } else {
          maxProb = Math.max(maxProb, s.probability);
        }
        last = s.time;
      } else if (start !== null) {
        const gap = clamp(s.time - last, gapFallback * 0.1, gapFallback * 4);
        segments.push({ start, end: last + gap, probability: maxProb });
        start = null;
      }
    }
    if (start !== null) {
      segments.push({ start, end: last + gapFallback, probability: maxProb });
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
    scanVideoFile,
    mergeSegments,
    formatTime,
    segmentsToTxt,
    createCancelToken,
    getWorkerPool,
  };
})(window);
