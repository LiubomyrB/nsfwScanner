// @ts-nocheck — classic worker script. Owns the sampling-strategy loop (uniform, or
// adaptive coarse+fine with run-dedup) for NudeNet-primary scans — moved off the main
// thread entirely, talking directly to nudenet-worker.js over a private MessagePort (see
// scanner.js's runCoordinatedNudeNetScan for how the two get wired together).
//
// Why this exists: an earlier version kept this loop on the main thread and only moved
// frame *acquisition* into a worker — that fixed the case where requestAnimationFrame/
// requestVideoFrameCallback stop firing when backgrounded, but the LOOP's own pacing was
// still main-thread JS, gated by the main thread's task queue — which Chrome also
// deprioritizes for backgrounded tabs, independent of rAF specifically. Moving the loop
// itself into a worker sidesteps that too: the only thing that still has to happen on the
// main thread is applying `video.currentTime = time` (only it has the <video> element) and
// relaying progress to the DOM — everything that decides *what* to sample next, and the
// actual frame-matching + classification, runs entirely between this worker and
// nudenet-worker.js, neither of which the browser treats as "the tab".
(function () {
  let nudenetPort = null;
  let cancelled = false;
  let mode = "stream";
  let msgId = 0;
  const pending = new Map();
  let frameMsgId = 0;
  const pendingFrames = new Map();

  // Scan-wide timing (spans both coarse and fine passes, whichever frame-acquisition mode
  // is active) — feeds the "average time per frame" / elapsed-timer progress info shown in
  // the UI alongside the plain percentage. samplesCompleted counts every sampleAtTimes loop
  // iteration actually attempted (success or not — a timed-out/skipped attempt still cost
  // real wall-clock time, so it belongs in the average same as a successful one).
  let scanStartTime = 0;
  let samplesCompleted = 0;

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // Mirrors scanner.js's own computeCoarseInterval exactly — see that function's comment
  // for the reasoning; duplicated here since there's no module system across the worker
  // boundary in this classic-script app.
  function computeCoarseInterval(fineInterval) {
    return clamp(fineInterval * 5, Math.min(Math.max(fineInterval * 2, 0.3), 5), 5);
  }

  function buildUniformTimes(duration, interval) {
    const times = [];
    for (let t = 0; t < duration; t += interval) times.push(t);
    const tail = Math.max(0, duration - Math.min(0.1, interval / 4));
    if (!times.length || times[times.length - 1] < tail) times.push(tail);
    return times;
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

  const MAX_CONFIRMS_PER_RUN = 3;

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

  // Requests a classification from nudenet-worker for `time`, over the direct port — no
  // main-thread involvement in this round trip. Resolves to null if nudenet-worker found no
  // matching frame in time (rare — see its own FRAME_WAIT_TIMEOUT_MS) rather than throwing,
  // so one missed sample doesn't abort the whole scan. `bitmap` (mode === "seek" only) is an
  // already-captured, already-letterboxed frame from the main thread — nudenet-worker
  // classifies it directly instead of matching one off its stream.
  function classifyAt(time, bitmap) {
    return new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      if (bitmap) {
        nudenetPort.postMessage({ type: "classify", id, time, bitmap, minScore: 0.2 }, [bitmap]);
      } else {
        nudenetPort.postMessage({ type: "classify", id, time, minScore: 0.2 });
      }
    });
  }

  // mode === "seek" only: asks the main thread (via the "seek" postMessage, see
  // scanner.js's runCoordinatedNudeNetScan) to seek the <video> and grab a letterboxed
  // bitmap of the frame it lands on, and waits for the matching "frameReady" reply.
  // Resolves to null if the main thread couldn't produce one (seek/grab error).
  function requestFrame(time) {
    return new Promise((resolve) => {
      const id = ++frameMsgId;
      pendingFrames.set(id, resolve);
      self.postMessage({ type: "seek", time, id });
    });
  }

  function onNudenetMessage(e) {
    const { id, ok, error, empty, matched, maxScore, label, classScores, classBoxes } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (!ok) {
      p.reject(new Error(error || "nudenet-worker classify failed."));
      return;
    }
    if (empty) {
      p.resolve(null);
      return;
    }
    p.resolve({
      probability: matched ? maxScore : 0,
      label: matched ? label : undefined,
      classScores,
      classBoxes,
    });
  }

  // Seeks to each of `times` (ascending) — via the main thread, see the "seek" postMessage
  // — and classifies what nudenet-worker finds there. Strictly sequential seek-then-match
  // (awaits each classifyAt() fully before moving on): the stream can only ever reflect one
  // <video>.currentTime at a time, so firing seeks faster than they can be matched would let
  // later seeks silently clobber earlier ones. Skips (rather than fails) a sample nudenet-
  // worker couldn't find a matching frame for.
  async function sampleAtTimes(times, onSampleDone) {
    const results = [];
    for (const time of times) {
         let time0 = performance.now();
      if (cancelled) break;
      samplesCompleted++;
      let bitmap = null;
      if (mode === "seek") {
        let timeR = performance.now();
        bitmap = await requestFrame(time);
        console.log('sampleAtTimes bitmap', (performance.now() - timeR) / 1000)
        if (!bitmap) continue; // main thread couldn't seek/grab this one — skip it
      } else if (mode === "stream") {
        self.postMessage({ type: "seek", time });
      }
      // mode === "mediabunny": nothing to do here — nudenet-worker pulls the frame itself,
      // by timestamp, straight off the source File.
      let data;
      try {
        console.log('sampleAtTimes START')
        let time1 = performance.now();
        data = await classifyAt(time, bitmap);
        console.log('sampleAtTimes classifyAt', (performance.now() - time1) / 1000)
      } catch (e) {
        data = null;
      }
      if (data) {
        const sample = Object.assign({ time }, data);
        results.push(sample);
        let timeS = performance.now();
        if (onSampleDone) onSampleDone(sample);
        console.log('sampleAtTimes onSampleDone', (performance.now() - timeS) / 1000)
      }
        console.log('sampleAtTimes FINISH', (performance.now() - time0) / 1000)
    }
    return results;
  }

  async function scanUniform(duration, interval, onProgress) {
    const times = buildUniformTimes(duration, interval);
    let done = 0;
    return sampleAtTimes(times, () => {
      done++;
      if (onProgress) onProgress(Math.min(100, (done / times.length) * 100));
    });
  }

  // Classifies only a representative subset of each run and propagates each unclassified
  // sample's result from its nearest classified neighbor within the same run — mirrors
  // scanner.js's classifyRunsWithDedup (see its own comment for the MAX_CONFIRMS_PER_RUN
  // reasoning). Only ever called without opts.exact here (nudenet-primary adaptive mode's
  // fine pass — "confirm" mode's own exact-timing path stays on the old architecture).
  async function classifyRunsWithDedup(runs, forcedTimesPerRun, onProgress) {
    const toClassify = runs.flatMap((run, i) => pickRepresentatives(run, MAX_CONFIRMS_PER_RUN, forcedTimesPerRun && forcedTimesPerRun[i]));
    const times = toClassify.map((c) => c.time);
    let done = 0;
    const classified = await sampleAtTimes(times, () => {
      done++;
      if (onProgress) onProgress(Math.min(100, (done / times.length) * 100));
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

  // Two-pass adaptive scan: fast coarse pass across the whole video, then a fine-interval
  // refine pass only in the neighborhood of anything the coarse pass found close to the
  // sensitivity threshold — mirrors scanner.js's scanAdaptive exactly (see its own comment
  // for the full reasoning); only the "how do I get a sample" mechanism differs here.
  async function scanAdaptive(duration, fineInterval, sensitivity, dedupFinePass, onProgress, onStatus) {
    const coarseInterval = computeCoarseInterval(fineInterval);
    if (onStatus) onStatus("scan.statusCoarsePass");
    const coarseTimes = buildUniformTimes(duration, coarseInterval);
    let coarseDone = 0;
    const coarseSamples = await sampleAtTimes(coarseTimes, () => {
      coarseDone++;
      if (onProgress) onProgress(Math.min(50, (coarseDone / coarseTimes.length) * 50));
    });

    if (cancelled) return coarseSamples;
    console.log('scanAdaptive coarseSamples', coarseSamples.length)
    const margin = 0.2;
    const windows = [];
    const triggerTimes = [];
    for (const s of coarseSamples) {
            console.log('scanAdaptive coarseSamples for', s.probability, Math.max(0, sensitivity - margin), sensitivity)

      // s.probability > 0 is required alongside the threshold check, not just the threshold
      // alone: Math.max(0, sensitivity - margin) clamps to exactly 0 whenever margin >=
      // sensitivity (e.g. sensitivity 0.09, margin 0.2 -> 0), and probability itself is never
      // negative (matched ? maxScore : 0) — so probability >= 0 alone is trivially true for
      // EVERY sample, including ones where nothing was detected at all, forcing a refine
      // window around literally every coarse sample. Margin exists to catch a real, weak
      // detection that might be an undersampled near-miss of a higher peak nearby — a flat 0
      // (no box, no match) isn't a near-miss, it's "found nothing here," and shouldn't be
      // treated the same as crossing the threshold just because both are >= 0.
      if (s.probability > 0 && s.probability >= Math.max(0, sensitivity - margin)) {
        windows.push({
          start: Math.max(0, s.time - coarseInterval),
          end: Math.min(duration, s.time + coarseInterval),
        });
        triggerTimes.push(s.time);
      }
    }
    const merged = mergeWindows(windows);

    if (!merged.length) {
      if (onProgress) onProgress(100);
      return coarseSamples;
    }

    if (onStatus) onStatus("scan.statusRefining", { count: merged.length });
    const fineTimesSet = new Set();
    for (const w of merged) {
      for (let t = w.start; t <= w.end; t += fineInterval) fineTimesSet.add(+t.toFixed(3));
    }
    const fineTimes = Array.from(fineTimesSet).sort((a, b) => a - b);

    let fineSamples;
    if (dedupFinePass) {
      const runs = groupConsecutiveRuns(fineTimes.map((t) => ({ time: t })), fineInterval * 3);
      const forcedTimesPerRun = runs.map((run) => {
        const runStart = run[0].time;
        const runEnd = run[run.length - 1].time;
        return triggerTimes.filter((t) => t >= runStart - fineInterval && t <= runEnd + fineInterval);
      });
      fineSamples = await classifyRunsWithDedup(runs, forcedTimesPerRun, (p) => {
        if (onProgress) onProgress(50 + Math.min(50, p * 0.5));
      });
    } else {
      let fineDone = 0;
      fineSamples = await sampleAtTimes(fineTimes, () => {
        fineDone++;
        if (onProgress) onProgress(50 + Math.min(50, (fineDone / fineTimes.length) * 50));
      });
    }

    const insideWindows = (t) => merged.some((w) => t >= w.start - 1e-6 && t <= w.end + 1e-6);
    const keptCoarse = coarseSamples.filter((s) => !insideWindows(s.time));
    const combined = keptCoarse.concat(fineSamples).sort((a, b) => a.time - b.time);
    if (onProgress) onProgress(100);
    return combined;
  }

  // Timing snapshot attached to every progress/done message — elapsed wall-clock time since
  // this scan's "start" message, and the running average per sampleAtTimes attempt so far.
  // Same shape both places so the UI can show a live version during the scan and the final
  // version once it's done without special-casing either.
  function timingSnapshot() {
    const elapsedMs = performance.now() - scanStartTime;
    return {
      elapsedMs,
      avgFrameMs: samplesCompleted > 0 ? elapsedMs / samplesCompleted : 0,
      sampleCount: samplesCompleted,
    };
  }

  function onProgress(pct) {
    self.postMessage(Object.assign({ type: "progress", pct }, timingSnapshot()));
  }
  function onStatus(key, params) {
    self.postMessage({ type: "status", key, params });
  }

  self.onmessage = async (e) => {
    const msg = e.data;
    if (msg.type === "nudenetPort") {
      nudenetPort = msg.port;
      nudenetPort.onmessage = onNudenetMessage;
      return;
    }
    if (msg.type === "frameReady") {
      const resolve = pendingFrames.get(msg.id);
      if (resolve) {
        pendingFrames.delete(msg.id);
        resolve(msg.bitmap || null);
      }
      return;
    }
    if (msg.type === "cancel") {
      cancelled = true;
      return;
    }
    if (msg.type === "start") {
      const { duration, interval, adaptive, sensitivity, dedupFinePass, mode: startMode } = msg;
      // Was `startMode === "seek" ? "seek" : "stream"` — silently collapsed "mediabunny" into
      // "stream" (wrong: it'd start posting pointless main-thread seek commands and never
      // take the mediabunny branches in sampleAtTimes). scanner.js only ever sends one of the
      // three real values, so just trust it.
      mode = startMode === "seek" || startMode === "mediabunny" ? startMode : "stream";
      scanStartTime = performance.now();
      samplesCompleted = 0;
      try {
        let samples;
        if (adaptive) {
          samples = await scanAdaptive(duration, interval, sensitivity, dedupFinePass, onProgress, onStatus);
        } else {
          onStatus("scan.statusScanningFramesNudenet");
          samples = await scanUniform(duration, interval, onProgress);
        }
        if (cancelled) {
          self.postMessage({ type: "cancelled" });
          return;
        }
        self.postMessage(Object.assign({ type: "done", samples }, timingSnapshot()));
      } catch (err) {
        self.postMessage({ type: "error", message: String((err && err.message) || err) });
      }
    }
  };
})();
