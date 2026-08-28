// @ts-nocheck — classic worker script; `ort` comes from importScripts() below, not a
// typed import, and this isn't part of the VMDB/VMScanner classic-script-globals app.
// Classic (non-module) Web Worker: real body-part object detection via ONNX Runtime Web,
// using the model from vladmandic/sd-extension-nudenet (actively maintained, MIT-licensed,
// ~12MB) — NOT the archived vladmandic/nudenet TFJS port this worker used to load.
//
// Why the switch: direct benchmark on the same test images, in the same environment —
// onnxruntime-web's multi-threaded WASM backend classifies a frame in ~40-110ms here,
// versus ~25-30 SECONDS per frame for the old TFJS/WebGL model. That's not a hardware
// artifact either: it doesn't depend on WebGL or real GPU acceleration at all (pure WASM),
// so it isn't subject to the "software-rendered WebGL is catastrophically slow" problem
// the old worker had. The model is also smaller (~12MB vs ~70MB) and has a richer label
// set (explicit female-vagina/male-penis classes instead of a single blended "vagina").
//
// Trade-off worth knowing: on one borderline (non-nude, swimwear) test photo, this model
// scored "female-vagina" at 0.57 vs the old model's ~0.30 on the same image — still under
// the app's default 0.6 sensitivity, but a real difference in calibration, not just speed.
const ORT_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0-dev.20260826-b1f76d586a/dist/";
importScripts(ORT_BASE + "ort.min.js");

const MODEL_URL = "https://cdn.jsdelivr.net/gh/vladmandic/sd-extension-nudenet@main/nudenet.onnx";
const INPUT_SIZE = 320;

// ort.min.js loads its actual WASM binary + threaded-worker glue (.wasm/.mjs) via its own
// path auto-detection, which only works when it's loaded as a plain <script src> on the
// main thread (it can read that script's own URL). Inside a Worker loaded via
// importScripts(), that detection has nothing to go on and silently falls back to
// resolving those files against *this worker's own* origin/path — i.e. our domain, not the
// CDN — which 404s. Setting wasmPaths explicitly (before creating any session) is the
// documented fix for hosting ort's assets somewhere other than where the page itself is
// served from; confirmed necessary here by hitting exactly that fetch failure.
ort.env.wasm.wasmPaths = ORT_BASE;

// Index into this array = class id the model emits.
const LABELS = [
  "female-private-area", "female-face", "buttocks-bare", "female-breast-bare", "female-vagina",
  "male-breast-bare", "anus-bare", "feet-bare", "belly", "feet", "armpits", "armpits-bare",
  "male-face", "belly-bare", "male-penis", "anus-area", "female-breast", "buttocks",
];

// The classes that actually count as "breast/genitals" for our purposes — mirrors the
// previous model's scope (exposed breast/vagina/anus/male-breast) under this model's
// naming. "buttocks-bare" is deliberately left out, matching the "breast and genitals"
// scope asked for; adjust this list to widen/narrow what counts.
const CONFIRM_LABELS = ["female-breast-bare", "female-vagina", "male-penis", "anus-bare", "buttocks-bare"];
const CONFIRM_IDS = CONFIRM_LABELS.map((l) => LABELS.indexOf(l));

// The multi-threaded WASM backend needs SharedArrayBuffer, which needs the page to be
// cross-origin isolated (COOP/COEP headers). Fall back to a single thread rather than
// fail outright if that's not available.
const isCrossOriginIsolated = typeof self !== "undefined" && self.crossOriginIsolated === true && typeof SharedArrayBuffer !== "undefined";
// Capped at 4 rather than raw hardwareConcurrency — measured directly (1 vs 4 vs 16 threads,
// same file, foreground and backgrounded): 16 threads was slower than 4 in BOTH conditions
// (0.107s vs 0.070s per session.run() foreground; 1.285s vs 0.285s backgrounded) — thread
// count beyond what this model's workload actually parallelizes well just adds scheduling/
// sync overhead, which gets much worse once a backgrounded tab's CPU budget shrinks and
// those threads end up fighting over table scraps. This also confirmed background
// throttling itself isn't a threading artifact: even 1 thread (no contention possible) was
// ~6x slower backgrounded than foreground — a real OS/browser-level CPU-priority floor for
// backgrounded tabs, not something thread tuning alone escapes.
ort.env.wasm.numThreads = isCrossOriginIsolated ? Math.min(4, (self.navigator && self.navigator.hardwareConcurrency) || 4) : 1;;
ort.env.wasm.simd = true;

let sessionPromise = null;
function getSession() {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(MODEL_URL, { executionProviders: ["webgpu", "wasm"] });
  }
  return sessionPromise;
}

function iou(a, b) {
  const ax1 = a[0] - a[2] / 2, ay1 = a[1] - a[3] / 2, ax2 = a[0] + a[2] / 2, ay2 = a[1] + a[3] / 2;
  const bx1 = b[0] - b[2] / 2, by1 = b[1] - b[3] / 2, bx2 = b[0] + b[2] / 2, by2 = b[1] + b[3] / 2;
  const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const areaA = a[2] * a[3], areaB = b[2] * b[3];
  return inter / (areaA + areaB - inter);
}

function nms(boxes, scores, iouThresh) {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a]);
  const keep = [];
  const suppressed = new Set();
  for (const i of idx) {
    if (suppressed.has(i)) continue;
    keep.push(i);
    for (const j of idx) {
      if (j === i || suppressed.has(j)) continue;
      if (iou(boxes[i], boxes[j]) > iouThresh) suppressed.add(j);
    }
  }
  return keep;
}

// `bitmap` is expected to already be a 320x320 *letterboxed* frame (aspect-preserving,
// black-padded to a square) — see scanner.js's letterbox capture — matching exactly how
// the upstream Python reference (sd-extension-nudenet's read_image()) prepares input, so
// no further resizing happens here, just pixel extraction.
async function detect(session, bitmap, minScore) {
    let time0 = performance.now();

  const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, INPUT_SIZE, INPUT_SIZE);
  const imgData = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
let time1 = performance.now();
  // HWC RGBA -> CHW RGB, normalized 0..1.
  const plane = INPUT_SIZE * INPUT_SIZE;
  const chw = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const o = i * 4;
    chw[i] = imgData[o] / 255;
    chw[plane + i] = imgData[o + 1] / 255;
    chw[2 * plane + i] = imgData[o + 2] / 255;
  }

  let time2 = performance.now();

  const tensor = new ort.Tensor("float32", chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
console.log('detect 1', (performance.now() - time2) / 1000)


 let timeE = performance.now();
  
  const feeds = {};
  feeds[session.inputNames[0]] = tensor;

  const results = await session.run(feeds);
  console.log('detect E', (performance.now() - timeE) / 1000)

  const output = results[session.outputNames[0]]; // [1, 4+numClasses, numBoxes] (YOLO-style)
  const numAttrs = output.dims[1];
  const numBoxes = output.dims[2];
  const data = output.data;
  let time3 = performance.now();
    

  const boxes = [];
  const scores = [];
  const classIds = [];
  for (let i = 0; i < numBoxes; i++) {
    let maxScore = -Infinity;
    let maxClass = -1;
    for (let c = 4; c < numAttrs; c++) {
      const v = data[c * numBoxes + i];
      if (v > maxScore) {
        maxScore = v;
        maxClass = c - 4;
      }
    }
    if (maxScore >= minScore) {
      boxes.push([data[i], data[numBoxes + i], data[2 * numBoxes + i], data[3 * numBoxes + i]]);
      scores.push(maxScore);

      classIds.push(maxClass);
    }
  }
  const keep = nms(boxes, scores, 0.45);
    console.log('detect 2', (performance.now() - time3) / 1000)

  let maxConfirmScore = 0;
  let maxConfirmLabel;
  // Per-class max score (0 for a class this frame had nothing detected for) — lets callers
  // (scanner.js's applyClassThresholds) filter/re-threshold each of the 5 confirm classes
  // independently instead of only ever seeing one blended "matched" verdict.
  const classScores = {};
  // Per-class box ([cx, cy, w, h], in this INPUT_SIZE-square letterboxed pixel space — same
  // space grabLetterboxBitmap drew the frame into) of whichever detection gave that class
  // its max score — lets callers crop a snapshot of exactly what triggered the detection
  // (see scanner.js's letterboxBoxToVideoFraction, which maps this space back to the real
  // video frame once the actual video dimensions are known).
    let time4 = performance.now();

  const classBoxes = {};
  for (const label of CONFIRM_LABELS) {
    classScores[label] = 0;
    classBoxes[label] = null;
  }
  const parts = [];
  for (const i of keep) {
    const classId = classIds[i];
    if (CONFIRM_IDS.includes(classId)) {
      const label = LABELS[classId];
      const box = boxes[i];

      parts.push({ score: scores[i], class: label, box });
      if (scores[i] > classScores[label]) {
        classScores[label] = scores[i];
        classBoxes[label] = box;
      }
      if (scores[i] > maxConfirmScore) {
        maxConfirmScore = scores[i];
        maxConfirmLabel = label;
      }
    }
  }
    
  console.log('detect parts 1', parts, scores)
  console.log('detect parts 2', { matched: parts.length > 0, maxScore: maxConfirmScore, label: maxConfirmLabel, classScores, classBoxes, parts })

console.log('detect 3', (performance.now() - time4) / 1000)
console.log('detect F', (performance.now() - time0) / 1000)

  return { matched: parts.length > 0, maxScore: maxConfirmScore, label: maxConfirmLabel, classScores, classBoxes, parts };
}

// --- Stream + coordinator-port protocol -----------------------------------------------
// Lets this worker read decoded frames directly off a MediaStreamTrackProcessor's stream
// (transferred in from scanner.js — see createStreamFrameSource there) and classify them by
// requested time, talking directly to a scan-coordinator-worker.js instance over a private
// MessagePort — no main-thread involvement in that round trip at all. This is what actually
// keeps a NudeNet-primary scan running at full speed when the tab is backgrounded: the
// scan's own pacing loop lives in the coordinator worker (not on the main thread, which the
// browser deprioritizes when hidden), and frame acquisition happens here, off the main
// thread too — the main thread's only remaining job is applying `video.currentTime = time`
// seek commands, since only it has the actual <video> element.
let streamReader = null;
let coordinatorPort = null;

// mode === "mediabunny" counterpart to the stream/seek state above: instead of a <video>
// element feeding either a stream or main-thread seeks, this decodes straight from the
// source File — mediabunny's VideoSampleSink.getSample(time) is genuine random access (the
// last sample at/before `time`), so there's no main-thread round trip at all in this mode.
let frameAcquisitionMode = "stream"; // "stream" | "mediabunny" — "seek" mode never touches this file, it always arrives with req.bitmap already set
let mediabunnyModulePromise = null;
let mediabunnyInput = null;
let mediabunnySink = null;
let mediabunnyReadyPromise = null;
// Set by a "prefetchMediabunny" message (see scan-coordinator-worker.js's sampleAtTimes) —
// a VideoSampleSink.samplesAtTimestamps() iterator over a whole pass's times at once,
// consumed one .next() per detectAtTimeMediabunny call in the same order they were listed.
// Falls back to plain getSample(time) below when this hasn't been set (shouldn't normally
// happen in mediabunny mode, but stay correct rather than throw if it doesn't arrive first).
let mediabunnySampleIterator = null;

// Mediabunny ships ESM-only; dynamic import() works fine from a classic worker script (same
// trick mediabunny-player.js uses on the main thread — see its own comment). Named by the
// full CDN URL rather than the bare "mediabunny" specifier the page's <script type=
// "importmap"> resolves: import maps are document-scoped and don't reach into Workers, and
// the bundle itself has no further imports to resolve (verified: no bare `from "..."`
// specifiers in the bundle), so this doesn't need one either.
function loadMediabunny() {
  if (!mediabunnyModulePromise) {
    mediabunnyModulePromise = import("https://cdn.jsdelivr.net/npm/mediabunny@1.55.2/dist/bundles/mediabunny.min.mjs");
  }
  return mediabunnyModulePromise;
}

// A reused worker (see scanner.js's getCoordinatedNudenetWorker) gets a fresh File every
// scan — dispose whatever the previous scan's Input was still holding first, same reasoning
// as initStream cancelling the previous streamReader.
function initMediabunny(file) {
  frameAcquisitionMode = "mediabunny";
  mediabunnySink = null;
  mediabunnySampleIterator = null;
  mediabunnyReadyPromise = (async () => {
    if (mediabunnyInput) {
      try { mediabunnyInput.dispose(); } catch (e) { /* ignore */ }
      mediabunnyInput = null;
    }
    const mb = await loadMediabunny();
    mediabunnyInput = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    const videoTrack = await mediabunnyInput.getPrimaryVideoTrack();
    if (!videoTrack || !(await videoTrack.canDecode())) {
      throw new Error("mediabunny cannot decode this file's video track.");
    }
    mediabunnySink = new mb.VideoSampleSink(videoTrack, {
            hardwareAcceleration: 'prefer-hardware',
            optimizeForLatency: true,
        });
  })();
  return mediabunnyReadyPromise;
}

// Replaces the current prefetch iterator with one covering this pass's whole (ascending)
// time list — see scan-coordinator-worker.js's sampleAtTimes for why this is sent once per
// pass rather than per frame. Queued behind mediabunnyReadyPromise since the sink might not
// exist yet (this can arrive before initMediabunny's own async setup finishes); safe to just
// overwrite mediabunnySampleIterator on every call — by the time a later pass's prefetch
// arrives, the previous pass's sampleAtTimes loop (and all its .next() calls) has always
// already finished, since classify requests are strictly sequential.
function handlePrefetchMediabunny(times) {
  mediabunnySampleIterator = mediabunnyReadyPromise.then(() => mediabunnySink.samplesAtTimestamps(times));
}

const FRAME_WAIT_TIMEOUT_MS = 1000;

// Drains the stream until a frame at/after `time` arrives, discarding stale (pre-seek)
// frames along the way. Returns null if nothing matches within the deadline.
async function getFrameAt(time) {
  let drainStart = performance.now();
  let discarded = 0;
  const deadline = Date.now() + FRAME_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const outcome = await Promise.race([
      streamReader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), remaining)),
    ]);
    if (outcome.timedOut) break;
    const { value, done } = outcome;
    if (done || !value) break;

    const frameTime = value.timestamp / 1e6;
    if (frameTime >= time) {
      console.log('getFrameAt drained', discarded, 'frames in', (performance.now() - drainStart) / 1000, 's for time', time)
      return value;
    }
    discarded++;
    value.close();
  }
  console.log('getFrameAt drained', discarded, 'frames in', (performance.now() - drainStart) / 1000, 's for time', time, '(no match / timed out)')
  return null;
}

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

// Same letterbox treatment as scanner.js's grabLetterboxBitmap, just reading straight from
// a VideoFrame pulled off the stream instead of a <video> element, and staying entirely in
// this worker (no canvas/bitmap hop back through the main thread).
async function detectAtTime(time, minScore) {
    let time1 = performance.now();
  const frame = await getFrameAt(time);
  if (!frame) return null;
  const vw = frame.displayWidth || 1;
  const vh = frame.displayHeight || 1;
  const { newW, newH, padLeft, padTop } = letterboxGeometry(vw, vh, INPUT_SIZE);
  const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(frame, 0, 0, vw, vh, padLeft, padTop, newW, newH);
  frame.close();
  const bitmap = await createImageBitmap(canvas);
    console.log('detectAtTime 1', (performance.now() - time1) / 1000)
  const session = await getSession();

    let time2 = performance.now();
  const result = await detect(session, bitmap, minScore);
    console.log('detectAtTime 2', (performance.now() - time2) / 1000)
  bitmap.close();
  return result;
}

// mode === "mediabunny" counterpart to detectAtTime: pulls the frame straight out of the
// source File via VideoSampleSink.getSample(time) instead of matching one off a
// MediaStreamTrackProcessor stream — same letterbox treatment, just reading a VideoSample
// (mediabunny's near-zero-cost VideoFrame wrapper) instead of a raw VideoFrame.
async function detectAtTimeMediabunny(time, minScore) {
  let time0 = performance.now();
  await mediabunnyReadyPromise;
  let sample;
  if (mediabunnySampleIterator) {
    // mediabunnySampleIterator is a Promise<AsyncGenerator> (see handlePrefetchMediabunny) —
    // await it once to get the actual generator, then pull the next queued sample from it.
    const iterator = await mediabunnySampleIterator;
    const outcome = await iterator.next();
    sample = outcome.done ? null : outcome.value;
  } else {
    sample = await mediabunnySink.getSample(time);
  }
  console.log('detectAtTimeMediabunny getSample', (performance.now() - time0) / 1000, time)
  if (!sample) return null;
  const vw = sample.displayWidth || 1;
  const vh = sample.displayHeight || 1;
  const { newW, newH, padLeft, padTop } = letterboxGeometry(vw, vh, INPUT_SIZE);
  const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  sample.draw(ctx, padLeft, padTop, newW, newH);
  sample.close();
  let time1 = performance.now();
  const bitmap = await createImageBitmap(canvas);
    console.log('detectAtTimeMediabunny createImageBitmap', (performance.now() - time1) / 1000)

  let time2 = performance.now();
  const session = await getSession();
  const result = await detect(session, bitmap, minScore);
  bitmap.close();
    console.log('detectAtTimeMediabunny detect', (performance.now() - time2) / 1000)
    console.log('detectAtTimeMediabunny F', (performance.now() - time0) / 1000)
  return result;
}

// mode === "seek" counterpart to detectAtTime: `bitmap` was already captured and
// letterboxed on the main thread (native video.currentTime seek + canvas grab — see
// scanner.js's NUDENET_COORDINATED_FRAME_MODE), so there's no stream to drain here at all.
async function detectBitmap(bitmap, minScore) {
  const session = await getSession();
  const result = await detect(session, bitmap, minScore);
  bitmap.close();
  return result;
}

// Requests arrive one at a time in practice (the coordinator awaits each full round trip
// before sending the next — seeking has to stay strictly sequential, since the stream can
// only ever reflect one <video>.currentTime at a time), but queue defensively rather than
// assume that: overlapping reader.read() calls on the same stream would corrupt matching.
let classifyChain = Promise.resolve();

// Forces a fresh ONNX session (see getSession — sessionPromise is otherwise cached forever,
// including a REJECTED promise, which would make every future classify fail identically even
// after whatever broke it recovers) and abandons whatever's stuck in classifyChain rather
// than letting every future classify request queue up behind a link that itself never
// settles. Triggered proactively here whenever a classify attempt cleanly throws (see
// handleCoordinatorClassify's own .catch(), below — much faster than waiting on a timeout to
// notice an error that already happened), and also by the coordinator's own classify timeout
// (a request that got no response at all within CLASSIFY_TIMEOUT_MS — see scan-coordinator-
// worker.js's classifyAt, for the case a request doesn't cleanly reject, e.g. an ONNX Runtime
// Web WebGPU call left permanently awaiting a GPUBuffer.mapAsync() a lost GPU device will
// never resolve or reject — reproduced directly by an unrelated tab's video playback crashing
// the browser's whole GPU process).
function resetSession() {
  sessionPromise = null;
  classifyChain = Promise.resolve();
}

function handleCoordinatorClassify(req) {
  const minScore = typeof req.minScore === "number" ? req.minScore : 0.2;
  console.log('handleCoordinatorClassify minScore', minScore, req.time)
  classifyChain = classifyChain
    .then(() => {
      if (req.bitmap) return detectBitmap(req.bitmap, minScore);
      let time1 = performance.now();
      if (frameAcquisitionMode === "mediabunny") return detectAtTimeMediabunny(req.time, minScore);
      console.log('handleCoordinatorClassify 1', (performance.now() - time1) / 1000)
      return detectAtTime(req.time, minScore);
    })
    .then((result) => {
      if (!result) {
        coordinatorPort.postMessage({ id: req.id, ok: true, empty: true });
      } else {
        coordinatorPort.postMessage({ id: req.id, ok: true, ...result });
      }
    })
    .catch((err) => {
      resetSession();
      coordinatorPort.postMessage({ id: req.id, ok: false, error: String((err && err.message) || err) });
    });
}

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg && msg.type === "initStream") {
    // A reused worker (see scanner.js's getCoordinatedNudenetWorker) gets a fresh stream
    // every scan — release whatever the previous scan's reader was still holding first.
    frameAcquisitionMode = "stream";
    if (streamReader) {
      try { streamReader.cancel(); } catch (e) { /* ignore */ }
    }
    streamReader = msg.readable.getReader();
    return;
  }
  if (msg && msg.type === "initMediabunny") {
    initMediabunny(msg.file).catch((err) => {
      // Surfaced to the coordinator on the next classify request instead of here — there's
      // no request id to reply to yet at init time. Logging keeps it from failing silently.
      console.error("initMediabunny failed", err);
    });
    return;
  }
  if (msg && msg.type === "initCoordinatorPort") {
    coordinatorPort = msg.port;
    coordinatorPort.onmessage = (ev) => {
      if (ev.data && ev.data.type === "classify") handleCoordinatorClassify(ev.data);
      else if (ev.data && ev.data.type === "prefetchMediabunny") handlePrefetchMediabunny(ev.data.times);
      else if (ev.data && ev.data.type === "resetSession") {
        console.warn("nudenet-worker: forced session reset (coordinator reported a stuck/timed-out classify).");
        resetSession();
      }
    };
    return;
  }

  // Original protocol: classify one already-captured bitmap (used by the pool-based
  // dispatch path — scanner.js's confirmWithNudeNet / NudeNet-as-confirmation, and the
  // NSFWJS/"confirm" detection modes generally, which stay on that architecture).
  const { id, bitmap, minScore } = msg;
  try {
    const session = await getSession();
    const result = await detect(session, bitmap, typeof minScore === "number" ? minScore : 0.2);
    bitmap.close();
    self.postMessage({ id, ok: true, backend: isCrossOriginIsolated ? "onnx-wasm-mt" : "onnx-wasm", ...result });
  } catch (err) {
    try { bitmap.close(); } catch (e2) { /* ignore */ }
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};

getSession()
  .then(() => self.postMessage({ ready: true, backend: isCrossOriginIsolated ? "onnx-wasm-mt" : "onnx-wasm" }))
  .catch((err) => self.postMessage({ ready: true, error: String((err && err.message) || err) }));

// Safety net for exactly what a lost WebGPU device looks like in practice: ONNX Runtime
// Web's WebGPU backend can leave an internal (not-awaited-by-us) promise — e.g. a GPUBuffer.
// mapAsync() reading back a result — permanently pending when the device disappears out from
// under it, which then rejects as an "AbortError: A valid external Instance reference no
// longer exists" completely detached from the classifyChain we actually await, bypassing
// handleCoordinatorClassify's own .catch() entirely (reproduced directly: an unrelated tab's
// video playback crashed the browser's whole GPU process mid-scan). This is a faster
// detection path than waiting on the coordinator's CLASSIFY_TIMEOUT_MS — it fires the moment
// the rejection surfaces instead of only once a request has gone conspicuously quiet.
self.addEventListener("unhandledrejection", (e) => {
  console.warn("nudenet-worker: unhandled rejection (likely a lost GPU device) — resetting session.", e.reason);
  resetSession();
});
