// @ts-nocheck — plain multi-file classic-script app; globals (VMDB/VMScanner/VMTranscoder/tf/nsfwjs) are wired via <script> load order, not modules.
// Nudity scanning of a local video File, plus segment/text helpers.
//
// Two-stage pipeline:
//   1. NSFWJS (js/scan-worker.js) — cheap whole-frame classifier, used as a fast filter
//      (and to pick which regions the adaptive two-pass scan bothers refining at all).
//   2. NudeNet (js/nudenet-worker.js), optional — a real body-part *object detector*.
//      When enabled, any frame NSFWJS flags gets double-checked against NudeNet's actual
//      exposed-breast/genitals/anus detections before it's allowed to count as "nudity".
//      This is what fixes NSFWJS false positives like a bare neck/shoulders/midriff
//      scoring high just because a lot of skin is visible — NudeNet only fires on frames
//      where it finds one of those specific body parts, not "skin in general". It only
//      runs on the (usually small) subset of frames NSFWJS already flagged, so its much
//      heavier cost doesn't apply to the whole video.
// Both run in worker pools, pipelined with main-thread video seeking, instead of blocking
// the main thread on one call at a time. NSFWJS's worker picks WebGL or WASM for itself
// depending on whether it detects real GPU acceleration or a software renderer; NudeNet's
// worker always uses WebGL (its model errors under WASM — see nudenet-worker.js).
(function (global) {
  const IMAGE_SIZE = 224;
  const NUDENET_CAPTURE_HEIGHT = 640;
  // How low an NSFWJS score has to be to skip NudeNet confirmation entirely — deliberately
  // generous (well below typical sensitivity settings) so confirmation isn't the thing
  // that causes a miss; it only exists to filter out the clearly-clean majority of frames.
  const PREFILTER_FLOOR = 0.15;

  // Resolve the worker scripts relative to *this script's* own location (same reasoning as
  // transcoder.js's vendored-module path) so it keeps working regardless of what directory
  // index.html is served from.
  const scriptBase = document.currentScript ? document.currentScript.src : document.baseURI;
  const WORKER_URLS = {
    nsfw: new URL("./scan-worker.js", scriptBase).href,
    nudenet: new URL("./nudenet-worker.js", scriptBase).href,
  };

  const pools = { nsfw: null, nudenet: null };
  const rrCounters = { nsfw: 0, nudenet: 0 };
  let msgId = 0;

  function poolSizeFor(kind) {
    const hw = navigator.hardwareConcurrency || 4;
    // Leave a core free for the main thread/UI. NudeNet's model is much heavier
    // (~70MB, slower per call) than NSFWJS's, so it gets a smaller pool — each worker
    // is its own full copy of tf.js + model weights in memory.
    const cap = kind === "nudenet" ? 2 : 4;
    return Math.max(1, Math.min(cap, hw - 1));
  }

  // Lazily spins up a pool of workers of the given kind ("nsfw" or "nudenet") and waits
  // for each to finish loading its model. Pools are module-level singletons: they survive
  // across scans/rescans in the same page session so a rescan doesn't pay worker-startup +
  // model-load cost again. The "nudenet" pool (and its ~70MB download) is never created at
  // all unless a scan actually asks for confirmation.
  function getWorkerPool(kind, onStatus) {
    if (!pools[kind]) {
      // A worker that never reports readiness (stuck CDN fetch, transient network failure,
      // etc.) would otherwise hang the whole scan silently forever — so each worker gets a
      // hard startup deadline. NudeNet gets a longer one: it downloads a much bigger model.
      const startupTimeoutMs = kind === "nudenet" ? 90000 : 45000;
      pools[kind] = (async () => {
        const size = poolSizeFor(kind);
        const label = kind === "nudenet" ? "confirmation" : "scan";
        if (onStatus) onStatus(`Starting ${size} ${label} worker${size > 1 ? "s" : ""}…`);
        const entries = Array.from({ length: size }, () => ({ worker: new Worker(WORKER_URLS[kind]) }));
        try {
          await Promise.all(
            entries.map(
              (entry) =>
                new Promise((resolve, reject) => {
                  const timer = setTimeout(
                    () => reject(new Error(`Timed out waiting for a ${kind} worker to start.`)),
                    startupTimeoutMs
                  );
                  function onMessage(e) {
                    if (!e.data || !e.data.ready) return;
                    clearTimeout(timer);
                    entry.worker.removeEventListener("message", onMessage);
                    entry.backend = e.data.backend;
                    if (e.data.error) reject(new Error(e.data.error));
                    else resolve();
                  }
                  entry.worker.addEventListener("message", onMessage);
                  entry.worker.addEventListener(
                    "error",
                    (e) => {
                      clearTimeout(timer);
                      reject(new Error(e.message || `${kind} worker failed to start.`));
                    },
                    { once: true }
                  );
                })
            )
          );
        } catch (e) {
          // Don't leave a permanently-broken pool cached: a transient failure (flaky CDN
          // request, etc.) should be retryable on the next scan attempt, not require a
          // page reload.
          entries.forEach((entry) => { try { entry.worker.terminate(); } catch (e2) { /* ignore */ } });
          pools[kind] = null;
          throw e;
        }
        if (onStatus) {
          const backend = entries[0] && entries[0].backend;
          onStatus(`${kind === "nudenet" ? "Confirming" : "Scanning"} with ${size} worker${size > 1 ? "s" : ""} (${backend})…`);
        }
        return entries;
      })();
    }
    return pools[kind];
  }

  // Sends one message to the next worker in `pool` (simple round-robin) and resolves with
  // its reply payload.
  function dispatchToPool(kind, pool, message, transfer) {
    const entry = pool[rrCounters[kind] % pool.length];
    rrCounters[kind]++;
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      function onMessage(e) {
        if (!e.data || e.data.id !== id) return;
        entry.worker.removeEventListener("message", onMessage);
        if (e.data.ok) resolve(e.data);
        else reject(new Error(e.data.error || "Worker call failed."));
      }
      entry.worker.addEventListener("message", onMessage);
      entry.worker.postMessage(Object.assign({ id }, message), transfer);
    });
  }

  function classifyNSFW(pool, bitmap) {
    return dispatchToPool("nsfw", pool, { bitmap }, [bitmap]).then((r) => ({ probability: r.probability }));
  }

  function classifyNudeNet(pool, bitmap) {
    return dispatchToPool("nudenet", pool, { bitmap, minScore: 0.2 }, [bitmap])
      .then((r) => ({ matched: r.matched, maxScore: r.maxScore }));
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

  // Seeks to each of `times` (ascending), captures a frame via `captureFn(video)`, and
  // classifies it via `classifyFn(pool, bitmap)` — pipelined: seeking the next frame
  // doesn't wait for the previous frame's classification to finish, up to a small bounded
  // number of in-flight calls across the worker pool at once. Returns
  // `{time, ...classifyFn's result}` samples sorted by time (completion order isn't
  // guaranteed).
  async function sampleAtTimes(video, times, pool, captureFn, classifyFn, opts = {}) {
    const { token, onSampleDone } = opts;
    const results = [];
    const inFlight = [];
    const maxInFlight = pool.length * 2;

    for (const time of times) {
      if (token && token.cancelled) break;
      await seekTo(video, time);
      const bitmap = await captureFn(video);
      const p = classifyFn(pool, bitmap).then((data) => {
        const sample = Object.assign({ time }, data);
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

  // Plain, uniform-interval NSFWJS scan — the "fully thorough" option.
  async function scanUniform(video, canvas, ctx, duration, interval, pool, opts) {
    const times = buildUniformTimes(duration, interval);
    const captureFn = (v) => grabBitmap(v, canvas, ctx);
    let done = 0;
    return sampleAtTimes(video, times, pool, captureFn, classifyNSFW, {
      token: opts.token,
      onSampleDone: () => {
        done++;
        if (opts.onProgress) opts.onProgress(Math.min(100, (done / times.length) * 100));
      },
    });
  }

  async function grabBitmap(video, canvas, ctx) {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return createImageBitmap(canvas);
  }

  // Two-pass adaptive NSFWJS scan: a fast coarse pass across the whole video first, then a
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
    const captureFn = (v) => grabBitmap(v, canvas, ctx);

    if (opts.onStatus) opts.onStatus("Scanning (coarse pass)…");
    const coarseTimes = buildUniformTimes(duration, coarseInterval);
    let coarseDone = 0;
    const coarseSamples = await sampleAtTimes(video, coarseTimes, pool, captureFn, classifyNSFW, {
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
    const fineSamples = await sampleAtTimes(video, fineTimes, pool, captureFn, classifyNSFW, {
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

  // NudeNet's cost is essentially FIXED per call (verified: dropping input resolution from
  // 640px to 256px changed its time by ~10%; running 2 workers concurrently instead of 1
  // took the same total wall time as running them sequentially — this model's per-call cost
  // doesn't scale down with less work, at least under software-rendered WebGL). That means
  // the only lever that actually helps is calling it fewer times. A long real scene can
  // produce dozens of consecutive NSFWJS candidates in a row that are all clearly "the same
  // moment" — confirming every single one is pure waste. So: group temporally-adjacent
  // candidates into runs, confirm only a handful of evenly-spaced representatives per run,
  // and propagate each unconfirmed sample's result from its nearest confirmed neighbor.
  // Trade-off: if a run's content genuinely changes partway through (someone gets dressed
  // mid-scene) and none of the representatives happen to land on that transition, the
  // propagated boundary is only as precise as the representative spacing — same flavor of
  // trade-off as the adaptive scan's coarse pass, just one level deeper.
  const MAX_CONFIRMS_PER_RUN = 3;

  function groupConsecutiveRuns(candidates, maxGapSeconds) {
    const runs = [];
    let current = [];
    for (const c of candidates) {
      if (current.length && c.time - current[current.length - 1].time > maxGapSeconds) {
        runs.push(current);
        current = [];
      }
      current.push(c);
    }
    if (current.length) runs.push(current);
    return runs;
  }

  function pickRepresentatives(run, maxPerRun) {
    if (run.length <= maxPerRun) return run;
    const picks = new Map();
    for (let i = 0; i < maxPerRun; i++) {
      const idx = maxPerRun === 1 ? 0 : Math.round((i * (run.length - 1)) / (maxPerRun - 1));
      picks.set(run[idx].time, run[idx]);
    }
    return Array.from(picks.values());
  }

  // Re-checks a representative subset of samples whose NSFWJS score is at least
  // PREFILTER_FLOOR against NudeNet's actual body-part detections, and replaces every
  // candidate's probability with the confirmed verdict of its nearest confirmed neighbor
  // in the same run (0 if NudeNet found nothing in the confirm-worthy classes, its max
  // confidence among them otherwise). Samples below the floor are left as-is. See
  // js/nudenet-worker.js for exactly which classes count.
  async function confirmWithNudeNet(video, largeCanvas, largeCtx, samples, interval, opts) {
    const candidates = samples.filter((s) => s.probability >= PREFILTER_FLOOR);
    if (!candidates.length) {
      if (opts.onProgress) opts.onProgress(100);
      return samples;
    }

    const runs = groupConsecutiveRuns(candidates, interval * 3);
    const toConfirm = runs.flatMap((run) => pickRepresentatives(run, MAX_CONFIRMS_PER_RUN));

    if (opts.onStatus) {
      const skipped = candidates.length - toConfirm.length;
      opts.onStatus(
        `Confirming ${toConfirm.length} region${toConfirm.length > 1 ? "s" : ""} with body-part detector` +
        (skipped > 0 ? ` (${skipped} nearby sample${skipped > 1 ? "s" : ""} reused from neighbors)…` : "…")
      );
    }
    const pool = await getWorkerPool("nudenet", opts.onStatus);
    const captureFn = (v) => grabBitmap(v, largeCanvas, largeCtx);
    const times = toConfirm.map((c) => c.time);
    let done = 0;
    const confirmed = await sampleAtTimes(video, times, pool, captureFn, classifyNudeNet, {
      token: opts.token,
      onSampleDone: () => {
        done++;
        if (opts.onProgress) opts.onProgress(Math.min(100, (done / times.length) * 100));
      },
    });
    const confirmedByTime = new Map(confirmed.map((c) => [c.time, c]));

    // Every candidate (not just the confirmed subset) needs a final verdict: its own if it
    // was confirmed, otherwise its nearest confirmed neighbor's within the same run.
    const verdictByTime = new Map();
    for (const run of runs) {
      const confirmedTimesInRun = run.map((s) => s.time).filter((t) => confirmedByTime.has(t));
      for (const s of run) {
        let verdict = confirmedByTime.get(s.time);
        if (!verdict) {
          let nearestTime = null;
          let nearestDist = Infinity;
          for (const t of confirmedTimesInRun) {
            const d = Math.abs(t - s.time);
            if (d < nearestDist) {
              nearestDist = d;
              nearestTime = t;
            }
          }
          verdict = nearestTime !== null ? confirmedByTime.get(nearestTime) : null;
        }
        verdictByTime.set(s.time, verdict ? (verdict.matched ? verdict.maxScore : 0) : 0);
      }
    }

    const result = samples.map((s) => {
      if (!verdictByTime.has(s.time)) return s;
      return { time: s.time, probability: verdictByTime.get(s.time) };
    });
    if (opts.onProgress) opts.onProgress(100);
    return result;
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
  //
  // `nudeNetConfirm: true` adds the NudeNet confirmation pass described above.
  async function scanVideoFile(file, opts = {}) {
    const { onProgress, onStatus, token, sampleTarget = 240, sampleInterval, adaptive, sensitivity, nudeNetConfirm } = opts;
    const pool = await getWorkerPool("nsfw", onStatus);
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

      // Only needed for NudeNet confirmation, but cheap enough to always set up: it needs
      // more spatial detail (and the video's real aspect ratio) than the 224x224 square
      // NSFWJS crop to localize small regions.
      const largeCanvas = document.createElement("canvas");
      largeCanvas.height = NUDENET_CAPTURE_HEIGHT;
      largeCanvas.width = Math.max(1, Math.round(NUDENET_CAPTURE_HEIGHT * (video.videoWidth / (video.videoHeight || 1))));
      const largeCtx = largeCanvas.getContext("2d");

      const primaryProgress = nudeNetConfirm
        ? (p) => { if (onProgress) onProgress(p * 0.8); }
        : onProgress;

      let samples;
      if (adaptive) {
        samples = await scanAdaptive(video, canvas, ctx, duration, interval, pool, { token, onProgress: primaryProgress, onStatus, sensitivity });
      } else {
        if (onStatus) onStatus("Scanning frames…");
        samples = await scanUniform(video, canvas, ctx, duration, interval, pool, { token, onProgress: primaryProgress });
      }

      if (!(token && token.cancelled) && nudeNetConfirm) {
        const confirmProgress = (p) => { if (onProgress) onProgress(80 + p * 0.2); };
        samples = await confirmWithNudeNet(video, largeCanvas, largeCtx, samples, interval, { token, onProgress: confirmProgress, onStatus });
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
