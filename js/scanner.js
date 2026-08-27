// @ts-nocheck — plain multi-file classic-script app; globals (VMDB/VMScanner/VMTranscoder/tf/nsfwjs) are wired via <script> load order, not modules.
// Nudity scanning of a local video File, plus segment/text helpers.
//
// Two classifiers are available (picked via `detectionMode`, see scanVideoFile):
//   - NSFWJS (js/scan-worker.js) — cheap whole-frame classifier. Fast, but can flag a lot
//     of visible skin (bare neck/shoulders/midriff) as nudity with no real anatomical
//     understanding.
//   - NudeNet (js/nudenet-worker.js) — a real body-part *object detector*. Only counts a
//     frame as nudity if it actually finds an exposed breast/genital/anus region — not
//     "skin in general" — but its per-call cost is much higher (see MAX_CONFIRMS_PER_RUN
//     comment) and roughly fixed regardless of input size.
// Three modes combine them differently:
//   - "nsfwjs": NSFWJS only.
//   - "confirm" (default): NSFWJS scans everything cheaply, then NudeNet double-checks only
//     the (usually small) subset of frames NSFWJS flagged — good speed/accuracy balance.
//   - "nudenet": NudeNet is the primary/only classifier for every sampled frame — most
//     accurate (NSFWJS never gets a vote), but the slowest option.
// Both run in worker pools, pipelined with main-thread video seeking, instead of blocking
// the main thread on one call at a time. NSFWJS's worker picks WebGL or WASM for itself
// depending on whether it detects real GPU acceleration or a software renderer. NudeNet's
// worker uses ONNX Runtime Web's multi-threaded WASM backend (not TensorFlow.js/WebGL) —
// verified ~40-110ms per frame here vs ~25-30 SECONDS for the previous TFJS-based model,
// and unlike WebGL that speed doesn't depend on real GPU acceleration being available.
(function (global) {
  const IMAGE_SIZE = 224;
  const NUDENET_INPUT_SIZE = 320; // fixed square input the ONNX model expects
  // How low an NSFWJS score has to be to skip NudeNet confirmation entirely — deliberately
  // generous (well below typical sensitivity settings) so confirmation isn't the thing
  // that causes a miss; it only exists to filter out the clearly-clean majority of frames.
  const PREFILTER_FLOOR = 0.15;

  // The threshold used when building the segments that get written to the exported txt file
  // and stored as the scan's permanent record — deliberately NOT `settings.sensitivity`. The
  // sensitivity slider controls blur-during-playback only (recomputed live from the raw
  // per-sample probabilities every time it's changed — see app.js's recomputeActiveSegments/
  // loadPlayerWithData), and playback is the only place it should apply; anything a scan
  // finds should be preserved on disk regardless of what the slider happens to be set to at
  // scan time; a low sensitivity later shouldn't mean data quietly never got recorded in the
  // first place. Still needs SOME positive floor (not 0) — merging on literal zero would pull
  // in essentially every sample as "detected" (near-zero noise never actually reads as
  // exactly 0) and collapse the whole video into one meaningless segment.
  const REPORT_FLOOR = 0.05;

  // Mirrors nudenet-worker.js's own CONFIRM_LABELS — the 5 body-part classes a per-sample
  // classScores map (see nudenet-worker.js's detect()) can carry a score for. Duplicated
  // here rather than shared across the worker/main-thread boundary (this classic-script app
  // has no module system to share a constant through) — keep both lists in sync if either
  // changes. `i18nKey` is the single source of truth for each class's human-readable name —
  // app.js's per-class sensitivity sliders and the snapshot grid captions, and this file's
  // own segmentsToTxt (see classDisplayName), all read the same translations through it
  // rather than keeping their own separate copies.
  const CONFIRM_CLASSES = [
    { key: "female-breast-bare", i18nKey: "settings.classFemaleBreastBare" },
    { key: "female-vagina", i18nKey: "settings.classFemaleVagina" },
    { key: "male-penis", i18nKey: "settings.classMalePenis" },
    { key: "anus-bare", i18nKey: "settings.classAnusBare" },
    { key: "buttocks-bare", i18nKey: "settings.classButtocksBare" },
  ];
  const CONFIRM_LABELS = CONFIRM_CLASSES.map((c) => c.key);
  const CONFIRM_CLASS_I18N_BY_KEY = {};
  CONFIRM_CLASSES.forEach((c) => { CONFIRM_CLASS_I18N_BY_KEY[c.key] = c.i18nKey; });

  // The human-readable name for a detected body-part class (e.g. "female-breast-bare" ->
  // "Female breast") — null if `label` isn't a recognized class (undefined/legacy samples
  // with no per-class breakdown at all).
  function classDisplayName(label) {
    const i18nKey = label && CONFIRM_CLASS_I18N_BY_KEY[label];
    if (!i18nKey) return null;
    return (global.VMI18n && global.VMI18n.t(i18nKey)) || label;
  }

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
    if (kind === "nudenet") {
      // NudeNet's ONNX Runtime Web worker already multi-threads *within* a single call
      // (ort.env.wasm.numThreads = hardwareConcurrency, set in nudenet-worker.js) — a
      // pool of several such workers would have each one trying to claim every core,
      // oversubscribing and fighting itself rather than helping. One worker is enough:
      // at ~40-110ms/call that's still ~10+ frames/sec, plenty for how this is used.
      return 1;
    }
    // Leave a core free for the main thread/UI.
    return Math.max(1, Math.min(4, hw - 1));
  }

  // Lazily spins up a pool of workers of the given kind ("nsfw" or "nudenet") and waits
  // for each to finish loading its model. Pools are module-level singletons: they survive
  // across scans/rescans in the same page session so a rescan doesn't pay worker-startup +
  // model-load cost again. The "nudenet" pool (and its ~70MB download) is never created at
  // all unless a scan actually uses NudeNet (confirmation or primary).
  //
  // `roleLabel` is purely cosmetic (what the status messages call this pool) — the same
  // "nudenet" pool serves both "confirmation" (confirmWithNudeNet) and "detector" (NudeNet
  // as the primary/only classifier) roles depending on the caller, and those deserve
  // different wording so the status text doesn't say "confirming" when nothing is actually
  // being confirmed.
  function getWorkerPool(kind, onStatus, roleLabel) {
    const roleKey = roleLabel || (kind === "nudenet" ? "confirmation" : "scan");
    if (!pools[kind]) {
      // A worker that never reports readiness (stuck CDN fetch, transient network failure,
      // etc.) would otherwise hang the whole scan silently forever — so each worker gets a
      // hard startup deadline. NudeNet gets a longer one: it downloads a much bigger model.
      const startupTimeoutMs = kind === "nudenet" ? 90000 : 45000;
      pools[kind] = (async () => {
        const size = poolSizeFor(kind);
        if (onStatus) onStatus(VMI18n.t("scan.statusStartingWorkers", { count: size, role: VMI18n.t("scan.workerRole." + roleKey) }));
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
          onStatus(VMI18n.t("scan.statusUsingWorkers", { count: size, role: VMI18n.t("scan.workerRole." + roleKey), backend }));
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
    return dispatchToPool("nsfw", pool, { bitmap }, [bitmap]).then((r) => ({ probability: r.probability, label: r.label }));
  }

  function classifyNudeNet(pool, bitmap) {
    return dispatchToPool("nudenet", pool, { bitmap, minScore: 0.2 }, [bitmap])
      .then((r) => ({ matched: r.matched, maxScore: r.maxScore, label: r.label, classScores: r.classScores, classBoxes: r.classBoxes }));
  }

  // Same shape as classifyNSFW ({probability, label}), for code paths that use NudeNet as a
  // primary/standalone classifier rather than a confirmation step. `label` (the specific
  // body-part class NudeNet matched, e.g. "female-breast-bare") is only meaningful when
  // something was actually matched — left undefined otherwise, same as classifyNSFW leaves
  // it undefined for nothing-interesting frames it never even attempts a label for.
  // `classScores`/`classBoxes` (per-class max score and the box that earned it) are always
  // present regardless of `matched` — they're what applyClassThresholds re-filters samples
  // by and reads a snapshot crop rectangle from.
  function classifyNudeNetAsProbability(pool, bitmap) {
    return classifyNudeNet(pool, bitmap).then((r) => ({
      probability: r.matched ? r.maxScore : 0,
      label: r.matched ? r.label : undefined,
      classScores: r.classScores,
      classBoxes: r.classBoxes,
    }));
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
      let settled = false;
      let fallbackTimer = null;

      function finish() {
        if (settled) return;
        settled = true;
        video.removeEventListener("seeked", onSeeked);
        if (fallbackTimer) clearTimeout(fallbackTimer);
        resolve();
      }

      function onSeeked() {
        video.removeEventListener("seeked", onSeeked);
        // Confirm the seeked frame has actually been decoded/presented before drawImage
        // reads it — reading immediately on "seeked" can still return the previous frame
        // (reproduced directly). requestVideoFrameCallback (when available) is the correct,
        // purpose-built signal for this; a double rAF is the fallback for browsers without
        // it (Safari).
        //
        // Neither is guaranteed to fire while the tab is in the background — both are tied
        // to the rendering/compositor pipeline, which gets throttled or paused entirely when
        // hidden (reproduced directly: scanning a backgrounded tab froze completely, because
        // this promise never resolved). The timer below is the actual fix: it guarantees
        // this seek resolves regardless, so a backgrounded scan keeps making progress
        // — worst case capturing a frame slightly before its paint is confirmed, rather than
        // hanging forever. In the normal foreground case it's inert: the frame-ready signal
        // above almost always wins the race well under this timeout.
        fallbackTimer = setTimeout(finish, 300);
        if (video.requestVideoFrameCallback) {
          video.requestVideoFrameCallback(finish);
        } else {
          requestAnimationFrame(() => requestAnimationFrame(finish));
        }
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
        console.log('data', data, time)
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

  // Shared with app.js (via VMScanner.computeCoarseInterval) so the settings UI can show the
  // real coarse-pass gap without duplicating — and risking drifting from — this formula.
  //
  // The lower bound (2x fineInterval) is itself clamped to at most the 5s cap: without that,
  // a fineInterval above 2.5s would make the "floor" exceed the "ceiling" (e.g. fineInterval=3
  // gives a naive floor of 6, above the 5 cap), and clamp()'s Math.max(lo, ...) would return
  // that floor uncapped — silently breaking the documented "capped at 5s" behavior.
  function computeCoarseInterval(fineInterval) {
    return clamp(fineInterval * 5, Math.min(Math.max(fineInterval * 2, 0.3), 5), 5);
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

  // Plain, uniform-interval scan — the "fully thorough" option. `classifyFn` is whichever
  // classifier (NSFWJS or NudeNet) is acting as the primary/only detector for this scan.
  // `captureFn(video)` grabs and returns a Promise<ImageBitmap> for the current frame —
  // callers pick which one (square-stretch for NSFWJS, letterboxed for NudeNet; see
  // grabBitmap/grabLetterboxBitmap below and where scanVideoFile constructs each).
  async function scanUniform(video, captureFn, duration, interval, pool, classifyFn, opts) {
    const times = buildUniformTimes(duration, interval);
    let done = 0;
    return sampleAtTimes(video, times, pool, captureFn, classifyFn, {
      token: opts.token,
      onSampleDone: () => {
        done++;
        if (opts.onProgress) opts.onProgress(Math.min(100, (done / times.length) * 100));
      },
    });
  }

  // Plain stretch-to-fill capture — used for NSFWJS's 224x224 square crop, where mild
  // aspect distortion has always been an accepted simplification.
  function grabBitmap(video, canvas, ctx) {
    const width = canvas.width;
    const height = canvas.height;
    ctx.drawImage(video, 0, 0, width, height);
    return createImageBitmap(canvas, { resizeWidth: width, resizeHeight: height });
  }

  // Aspect-preserving "letterbox" capture: fits the frame within `size`x`size`, centers
  // it, and pads the rest with black — exactly how sd-extension-nudenet's Python reference
  // (read_image()) prepares input for this model, which matters here because unlike
  // NSFWJS's crop, stretching would distort the proportions this model was trained on.
  // Shared by grabLetterboxBitmap (below, the forward direction: real video frame -> square
  // letterboxed model input) and letterboxBoxToVideoFraction (the reverse, used to turn a
  // detection box back into a snapshot crop rect) — both need the exact same
  // scale/pad numbers for a given video size, so this is the one place that computes them.
  function letterboxGeometry(vw, vh, size) {
    const aspect = vw / vh;
    let newW, newH;
    if (vh > vw) {
      newH = size;
      newW = Math.round(size * aspect);
    } else {
      newW = size;
      newH = Math.round(size / aspect);
    }
    const padLeft = Math.floor((size - newW) / 2);
    const padTop = Math.floor((size - newH) / 2);
    return { newW, newH, padLeft, padTop };
  }

  function grabLetterboxBitmap(video, canvas, ctx, size) {
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const { newW, newH, padLeft, padTop } = letterboxGeometry(vw, vh, size);
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(video, 0, 0, vw, vh, padLeft, padTop, newW, newH);
    return createImageBitmap(canvas, { resizeWidth: size, resizeHeight: size });
  }

  // Maps a NudeNet detection box ([cx, cy, w, h], in the NUDENET_INPUT_SIZE-square
  // letterboxed pixel space nudenet-worker.js's model output is in) back to a fractional
  // {x, y, w, h} rectangle (0..1, relative to the ORIGINAL video frame) — the inverse of
  // grabLetterboxBitmap's own mapping. Used by app.js to know what region of the actual
  // video frame to crop for a segment's snapshot thumbnail, once the real video dimensions
  // are known (they aren't at scan time inside the worker, only here on the main thread).
  function letterboxBoxToVideoFraction(box, videoWidth, videoHeight) {
    const vw = videoWidth || 1;
    const vh = videoHeight || 1;
    if (!box) return null;
    const { newW, newH, padLeft, padTop } = letterboxGeometry(vw, vh, NUDENET_INPUT_SIZE);
    const scaleX = newW / vw;
    const scaleY = newH / vh;
    const [cx, cy, w, h] = box;
    const x1 = (cx - w / 2 - padLeft) / scaleX;
    const y1 = (cy - h / 2 - padTop) / scaleY;
    const x2 = (cx + w / 2 - padLeft) / scaleX;
    const y2 = (cy + h / 2 - padTop) / scaleY;
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const fx1 = clamp01(x1 / vw);
    const fy1 = clamp01(y1 / vh);
    const fx2 = clamp01(x2 / vw);
    const fy2 = clamp01(y2 / vh);
    if (fx2 <= fx1 || fy2 <= fy1) return null;
    return { x: fx1, y: fy1, w: fx2 - fx1, h: fy2 - fy1 };
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
  //
  // `classifyFn` is whichever classifier is acting as the primary detector (NSFWJS or
  // NudeNet). `opts.dedupFinePass: true` additionally collapses consecutive fine-interval
  // candidates within one refine window into a handful of representatives (see
  // classifyRunsWithDedup) — worth it when `classifyFn` itself is expensive per call
  // (NudeNet), not worth the added imprecision when it's cheap (NSFWJS).
  async function scanAdaptive(video, captureFn, duration, fineInterval, pool, classifyFn, opts) {
    const sensitivity = typeof opts.sensitivity === "number" ? opts.sensitivity : 0.6;
    // Coarse pass runs at ~5x the fine interval, but never below 2x it (so "coarse" stays
    // meaningfully coarser than "fine" — the whole point of doing two passes) or below an
    // absolute 0.3s floor (avoids a degenerate near-zero coarse pass). Deliberately does
    // NOT have a fixed high floor like 1.5s: a user setting a very small "scan interval"
    // (e.g. 0.1s) is explicitly asking for finer precision, and a hard floor would silently
    // override that for most of the video (only "refine windows" ever reach the fine
    // interval; everywhere else stays at the coarse one) — previously reproduced exactly
    // this way: 0.1s fine interval produced a 1.5s coarse pass regardless.
    const coarseInterval = computeCoarseInterval(fineInterval);

    if (opts.onStatus) opts.onStatus(VMI18n.t("scan.statusCoarsePass"));
    const coarseTimes = buildUniformTimes(duration, coarseInterval);
    let coarseDone = 0;
    const coarseSamples = await sampleAtTimes(video, coarseTimes, pool, captureFn, classifyFn, {
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
    const triggerTimes = [];
    for (const s of coarseSamples) {
      if (s.probability >= Math.max(0, sensitivity - margin)) {
        windows.push({
          start: Math.max(0, s.time - coarseInterval),
          end: Math.min(duration, s.time + coarseInterval),
        });
        triggerTimes.push(s.time);
      }
    }
    const merged = mergeWindows(windows);

    if (!merged.length) {
      if (opts.onProgress) opts.onProgress(100);
      return coarseSamples;
    }

    if (opts.onStatus) opts.onStatus(VMI18n.t("scan.statusRefining", { count: merged.length }));
    const fineTimesSet = new Set();
    for (const w of merged) {
      for (let t = w.start; t <= w.end; t += fineInterval) fineTimesSet.add(+t.toFixed(3));
    }
    const fineTimes = Array.from(fineTimesSet).sort((a, b) => a - b);

    let fineSamples;
    if (opts.dedupFinePass) {
      const runs = groupConsecutiveRuns(fineTimes.map((t) => ({ time: t })), fineInterval * 3);
      // Each run corresponds to one merged window (runs are built from the same fine times,
      // grouped by continuity — since merged windows are non-overlapping with gaps between
      // them, this lines up 1:1). Attach that window's original coarse trigger times so
      // classifyRunsWithDedup can force a representative near each real detection instead of
      // only picking evenly-spaced ones that can miss short, closely-spaced scenes — see
      // pickRepresentatives.
      const forcedTimesPerRun = runs.map((run) => {
        const runStart = run[0].time;
        const runEnd = run[run.length - 1].time;
        return triggerTimes.filter((t) => t >= runStart - fineInterval && t <= runEnd + fineInterval);
      });
      fineSamples = await classifyRunsWithDedup(video, captureFn, pool, classifyFn, runs, {
        token: opts.token,
        forcedTimesPerRun,
        onProgress: (p) => { if (opts.onProgress) opts.onProgress(50 + Math.min(50, p * 0.5)); },
      });
    } else {
      let fineDone = 0;
      fineSamples = await sampleAtTimes(video, fineTimes, pool, captureFn, classifyFn, {
        token: opts.token,
        onSampleDone: () => {
          fineDone++;
          if (opts.onProgress) opts.onProgress(50 + Math.min(50, (fineDone / fineTimes.length) * 50));
        },
      });
    }

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

  // `forcedTimes` (optional): timestamps that MUST end up represented, each snapped to its
  // nearest sample in `run` — see scanAdaptive's window-merging comment for why. Without
  // this, a run built by merging multiple originally-separate coarse-detected windows (e.g.
  // two short, distinct scenes close enough together that their refine windows touch) would
  // only get `maxPerRun` *evenly-spaced* representatives regardless of how many real
  // detections got merged into it — which can land every single representative in the clean
  // gap between the real scenes and propagate a false "nothing here" across the whole run.
  // Forcing each original trigger point to have a nearby classified sample fixes that while
  // keeping the cost bounded by the number of genuine coarse detections, not the run's length.
  function pickRepresentatives(run, maxPerRun, forcedTimes) {
    const picks = new Map();
    if (forcedTimes && forcedTimes.length) {
      for (const ft of forcedTimes) {
        let nearest = run[0];
        let nearestDist = Math.abs(run[0].time - ft);
        for (const s of run) {
          const d = Math.abs(s.time - ft);
          if (d < nearestDist) {
            nearestDist = d;
            nearest = s;
          }
        }
        picks.set(nearest.time, nearest);
      }
    }
    if (run.length <= maxPerRun) {
      for (const s of run) picks.set(s.time, s);
      return Array.from(picks.values());
    }
    for (let i = 0; i < maxPerRun; i++) {
      const idx = maxPerRun === 1 ? 0 : Math.round((i * (run.length - 1)) / (maxPerRun - 1));
      picks.set(run[idx].time, run[idx]);
    }
    return Array.from(picks.values());
  }

  // Classifies only a representative subset of each run (via `classifyFn`, an expensive
  // per-call classifier like NudeNet) and propagates each unclassified sample's probability
  // from its nearest classified neighbor within the same run. Returns one {time, probability}
  // per input sample, covering every run exactly once. Shared by the NSFWJS→NudeNet
  // confirmation pass and the NudeNet-only adaptive scan's fine pass — see MAX_CONFIRMS_PER_RUN
  // comment above for why this trade-off exists.
  //
  // `opts.exact: true` classifies every sample individually instead (no representative
  // picking, no propagation) — for when you need the real per-sample scene-boundary time
  // rather than one approximated to the representative spacing.
  async function classifyRunsWithDedup(video, captureFn, pool, classifyFn, runs, opts) {
    const forcedTimesPerRun = opts.forcedTimesPerRun;
    const toClassify = opts.exact
      ? runs.flat()
      : runs.flatMap((run, i) => pickRepresentatives(run, MAX_CONFIRMS_PER_RUN, forcedTimesPerRun && forcedTimesPerRun[i]));
    const times = toClassify.map((c) => c.time);
    let done = 0;
    const classified = await sampleAtTimes(video, times, pool, captureFn, classifyFn, {
      token: opts.token,
      onSampleDone: () => {
        done++;
        if (opts.onProgress) opts.onProgress(Math.min(100, (done / times.length) * 100));
      },
    });
    const classifiedByTime = new Map(classified.map((c) => [c.time, { probability: c.probability, label: c.label, classScores: c.classScores, classBoxes: c.classBoxes }]));

    const result = [];
    for (const run of runs) {
      const knownTimesInRun = run.map((s) => s.time).filter((t) => classifiedByTime.has(t));
      for (const s of run) {
        let entry = classifiedByTime.get(s.time);
        if (entry === undefined) {
          let nearestTime = null;
          let nearestDist = Infinity;
          for (const t of knownTimesInRun) {
            const d = Math.abs(t - s.time);
            if (d < nearestDist) {
              nearestDist = d;
              nearestTime = t;
            }
          }
          entry = nearestTime !== null ? classifiedByTime.get(nearestTime) : { probability: 0, label: undefined, classScores: undefined, classBoxes: undefined };
        }
        result.push({ time: s.time, probability: entry.probability, label: entry.label, classScores: entry.classScores, classBoxes: entry.classBoxes });
      }
    }
    return result;
  }

  // Re-checks a representative subset of samples whose NSFWJS score is at least
  // PREFILTER_FLOOR against NudeNet's actual body-part detections, and replaces every
  // candidate's probability with the confirmed verdict of its nearest confirmed neighbor
  // in the same run (0 if NudeNet found nothing in the confirm-worthy classes, its max
  // confidence among them otherwise). Samples below the floor are left as-is. See
  // js/nudenet-worker.js for exactly which classes count.
  async function confirmWithNudeNet(video, captureFn, samples, interval, opts) {
    const candidates = samples.filter((s) => s.probability >= PREFILTER_FLOOR);
    if (!candidates.length) {
      if (opts.onProgress) opts.onProgress(100);
      return samples;
    }

    const runs = groupConsecutiveRuns(candidates, interval * 3);
    const toConfirmCount = opts.exact
      ? candidates.length
      : runs.reduce((sum, run) => sum + Math.min(run.length, MAX_CONFIRMS_PER_RUN), 0);

    if (opts.onStatus) {
      const skipped = candidates.length - toConfirmCount;
      const suffix = skipped > 0
        ? VMI18n.t("scan.confirmingSkippedSuffix", { count: skipped })
        : VMI18n.t("scan.confirmingNoSkippedSuffix");
      opts.onStatus(VMI18n.t("scan.statusConfirming", { count: toConfirmCount, suffix }));
    }
    const pool = await getWorkerPool("nudenet", opts.onStatus, "confirmation");
    const verdicts = await classifyRunsWithDedup(video, captureFn, pool, classifyNudeNetAsProbability, runs, opts);
    const verdictByTime = new Map(verdicts.map((v) => [v.time, { probability: v.probability, label: v.label, classScores: v.classScores, classBoxes: v.classBoxes }]));

    const result = samples.map((s) => {
      const v = verdictByTime.get(s.time);
      if (!v) return s;
      // NudeNet's own class label/scores/boxes (specific body part, e.g.
      // "female-breast-bare") replace whatever the NSFWJS primary pass had for this sample
      // — it's the more precise verdict, being what actually decided this sample's
      // confirmed probability.
      return { time: s.time, probability: v.probability, label: v.label, classScores: v.classScores, classBoxes: v.classBoxes };
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
  // `detectionMode` picks which classifier(s) decide "is this frame nudity":
  //   - "nsfwjs" (default): NSFWJS only.
  //   - "confirm": NSFWJS scans as above, then any frame it flags gets double-checked by
  //     NudeNet (confirmWithNudeNet) — good balance of speed and the accuracy fix NudeNet
  //     provides.
  //   - "nudenet": skips NSFWJS entirely and runs NudeNet as the primary/only classifier
  //     for every sampled frame. Most accurate (NSFWJS never gets a vote, so its bare-skin
  //     false positives can't leak through even indirectly), but NudeNet's per-call cost is
  //     roughly fixed regardless of input, so this is the slowest option — when combined
  //     with `adaptive`, its fine pass also gets the run-deduplication treatment (see
  //     classifyRunsWithDedup) to keep a single long scene from requiring one NudeNet call
  //     per fine-interval sample, UNLESS `exactTiming` is set (see below).
  //
  // `exactTiming: true` disables that run-deduplication wherever NudeNet is involved
  // ("confirm" mode's confirmation pass, and "nudenet" mode's adaptive fine pass) — every
  // candidate/fine-interval sample gets individually classified instead of a handful of
  // representatives with the rest propagated from the nearest one. Gives the real
  // per-sample scene-start/end time rather than one approximated to representative spacing,
  // at the cost of more NudeNet calls (still fast with the ONNX backend — see header).
  // Irrelevant to plain "nsfwjs" mode, which never deduplicates its fine pass.
  async function scanVideoFile(file, opts = {}) {
    const { onProgress, onStatus, token, sampleTarget = 240, sampleInterval, adaptive, sensitivity, detectionMode = "nsfwjs", exactTiming } = opts;
    const usesNudeNetPrimary = detectionMode === "nudenet";
    const usesNudeNetConfirm = detectionMode === "confirm";
    const pool = usesNudeNetPrimary
      ? await getWorkerPool("nudenet", onStatus, "detector")
      : await getWorkerPool("nsfw", onStatus, "scan");
    if (onStatus) onStatus(VMI18n.t("scan.statusPreparingVideo"));

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

      // Needed for NudeNet (confirmation or primary): a letterboxed square, matching what
      // the ONNX model expects (see grabLetterboxBitmap) — distorting the aspect ratio via
      // plain stretch, like the NSFWJS crop does, would depart from how this model was
      // trained/preprocessed. Cheap enough to always set up.
      const nudenetCanvas = document.createElement("canvas");
      nudenetCanvas.width = NUDENET_INPUT_SIZE;
      nudenetCanvas.height = NUDENET_INPUT_SIZE;
      const nudenetCtx = nudenetCanvas.getContext("2d");
      const nsfwCaptureFn = (v) => grabBitmap(v, canvas, ctx);
      const nudenetCaptureFn = (v) => grabLetterboxBitmap(v, nudenetCanvas, nudenetCtx, NUDENET_INPUT_SIZE);

      const primaryProgress = usesNudeNetConfirm
        ? (p) => { if (onProgress) onProgress(p * 0.8); }
        : onProgress;

      let samples;
      if (usesNudeNetPrimary) {
        if (adaptive) {
          samples = await scanAdaptive(video, nudenetCaptureFn, duration, interval, pool, classifyNudeNetAsProbability, {
            token, onProgress: primaryProgress, onStatus, sensitivity, dedupFinePass: !exactTiming,
          });
        } else {
          if (onStatus) onStatus(VMI18n.t("scan.statusScanningFramesNudenet"));
          samples = await scanUniform(video, nudenetCaptureFn, duration, interval, pool, classifyNudeNetAsProbability, {
            token, onProgress: primaryProgress,
          });
        }
      } else {
        if (adaptive) {
          samples = await scanAdaptive(video, nsfwCaptureFn, duration, interval, pool, classifyNSFW, { token, onProgress: primaryProgress, onStatus, sensitivity });
        } else {
          if (onStatus) onStatus(VMI18n.t("scan.statusScanningFrames"));
          samples = await scanUniform(video, nsfwCaptureFn, duration, interval, pool, classifyNSFW, { token, onProgress: primaryProgress });
        }

        if (!(token && token.cancelled) && usesNudeNetConfirm) {
          const confirmProgress = (p) => { if (onProgress) onProgress(80 + p * 0.2); };
          samples = await confirmWithNudeNet(video, nudenetCaptureFn, samples, interval, { token, onProgress: confirmProgress, onStatus, exact: exactTiming });
        }
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
  // samples aren't evenly spaced. Each returned segment also carries `peakTime`/`box`/
  // `label` from whichever sample inside it hit `maxProb` — the "moment that triggered the
  // detection", used by app.js to crop a snapshot thumbnail for that segment. Callers that
  // don't care (existing ones — blur playback just reads start/end) simply ignore the extra
  // fields.
  function mergeSegments(samples, sensitivity, fallbackInterval) {
    if (!samples || !samples.length) return [];
    const gapFallback = fallbackInterval || 1;
    const segments = [];
    let start = null;
    let last = null;
    let maxProb = 0;
    let peakTime = null;
    let peakBox;
    let peakLabel;

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (s.probability >= sensitivity) {
        if (start === null || s.probability > maxProb) {
          maxProb = s.probability;
          peakTime = s.time;
          peakBox = s.box;
          peakLabel = s.label;
        }
        if (start === null) start = s.time;
        last = s.time;
      } else if (start !== null) {
        const gap = clamp(s.time - last, gapFallback * 0.1, gapFallback * 4);
        segments.push({ start, end: last + gap, probability: maxProb, peakTime, box: peakBox, label: peakLabel });
        start = null;
      }
    }
    if (start !== null) {
      segments.push({ start, end: last + gapFallback, probability: maxProb, peakTime, box: peakBox, label: peakLabel });
    }
    return segments;
  }

  // Recomputes each sample's usable `probability` from its per-class NudeNet scores (see
  // nudenet-worker.js's classScores) and a set of per-class thresholds — the max score
  // among classes that individually clear their own threshold in `classThresholds`, or 0
  // ("not detected") if none do. This is how the app's per-class sensitivity sliders (see
  // app.js) turn into an actual filter: a sample only counts at all if at least one of its
  // detected body parts scores at or above that part's own slider, and the reported
  // probability for what counts is that part's own score (not some other, filtered-out
  // part's higher score). Samples with no classScores (NSFWJS-only samples, or scans from
  // before this feature existed) pass through with their original scalar probability
  // unchanged — there's no body-part breakdown on them to filter by. Returns a new array of
  // plain {time, probability, label, classScores} samples, meant to be fed straight into
  // mergeSegments in place of the raw samples.
  function applyClassThresholds(samples, classThresholds) {
    if (!samples) return [];
    return samples.map((s) => {
      if (!s.classScores) return s;
      let best = 0;
      let bestBox;
      for (const cls of CONFIRM_LABELS) {
        const score = s.classScores[cls] || 0;
        const threshold = (classThresholds && typeof classThresholds[cls] === "number") ? classThresholds[cls] : 0;
        if (score >= threshold && score > best) {
          best = score;
          bestBox = s.classBoxes && s.classBoxes[cls];
        }
      }
      // `box` (in nudenet-worker.js's letterboxed reference space) is whichever class
      // actually decided this sample's probability — the specific detection a snapshot
      // thumbnail should crop (see app.js's renderTimecodesSnapshotGrid).
      return { time: s.time, probability: best, label: s.label, classScores: s.classScores, box: bestBox || undefined };
    });
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
    lines.push(`# Format: N. start - end : probability : class`);
    if (!segments.length) {
      lines.push("# No nudity scenes detected.");
    }
    segments.forEach((seg, i) => {
      const className = classDisplayName(seg.label);
      const suffix = className ? ` : ${className}` : "";
      lines.push(`${i + 1}. ${formatTime(seg.start)} - ${formatTime(seg.end)} : ${seg.probability.toFixed(3)}${suffix}`);
    });
    return lines.join("\n") + "\n";
  }

  global.VMScanner = {
    scanVideoFile,
    mergeSegments,
    applyClassThresholds,
    letterboxBoxToVideoFraction,
    formatTime,
    computeCoarseInterval,
    segmentsToTxt,
    createCancelToken,
    getWorkerPool,
    REPORT_FLOOR,
    CONFIRM_LABELS,
    CONFIRM_CLASSES,
    classDisplayName,
  };
})(window);
