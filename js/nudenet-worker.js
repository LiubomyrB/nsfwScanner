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
const ORT_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/";
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
ort.env.wasm.numThreads = isCrossOriginIsolated ? ((self.navigator && self.navigator.hardwareConcurrency) || 4) : 1;
ort.env.wasm.simd = true;

let sessionPromise = null;
function getSession() {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(MODEL_URL, { executionProviders: ["wasm"] });
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
  const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, INPUT_SIZE, INPUT_SIZE);
  const imgData = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;

  // HWC RGBA -> CHW RGB, normalized 0..1.
  const plane = INPUT_SIZE * INPUT_SIZE;
  const chw = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const o = i * 4;
    chw[i] = imgData[o] / 255;
    chw[plane + i] = imgData[o + 1] / 255;
    chw[2 * plane + i] = imgData[o + 2] / 255;
  }

  const tensor = new ort.Tensor("float32", chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const feeds = {};
  feeds[session.inputNames[0]] = tensor;
  const results = await session.run(feeds);
  const output = results[session.outputNames[0]]; // [1, 4+numClasses, numBoxes] (YOLO-style)
  const numAttrs = output.dims[1];
  const numBoxes = output.dims[2];
  const data = output.data;

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
  const classBoxes = {};
  for (const label of CONFIRM_LABELS) {
    classScores[label] = 0;
    classBoxes[label] = null;
  }
  const parts = [];
  for (const i of keep) {
    const classId = classIds[i];
    console.log('label', LABELS[classId])
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

  console.log('scores', scores, parts)
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

const FRAME_MATCH_EPSILON = 0.03;
const FRAME_WAIT_TIMEOUT_MS = 1000;

// Drains the stream until a frame at/after `time` (within FRAME_MATCH_EPSILON) arrives,
// discarding stale (pre-seek) frames along the way — same logic as frame-reader-worker.js,
// duplicated here rather than shared (no module system across the worker boundary in this
// classic-script app). Returns null if nothing matches within the deadline.
async function getFrameAt(time) {
    console.log('getFrameAt START', time)
  const deadline = Date.now() + FRAME_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const outcome = await Promise.race([
      streamReader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), remaining)),
    ]);
    if (outcome.timedOut) {

        console.log('getFrameAt timedOut', time)
        break;
    }
    const { value, done } = outcome;
    if (done || !value) break;
    
    const frameTime = value.timestamp / 1e6;
    if (frameTime >= time - FRAME_MATCH_EPSILON) {
        console.log('getFrameAt value', time, value)
        return value;
    }
    value.close();
  }
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
function handleCoordinatorClassify(req) {
  classifyChain = classifyChain
    .then(() => detectAtTime(req.time, typeof req.minScore === "number" ? req.minScore : 0.2))
    .then((result) => {
      if (!result) {
        coordinatorPort.postMessage({ id: req.id, ok: true, empty: true });
      } else {
        coordinatorPort.postMessage({ id: req.id, ok: true, ...result });
      }
    })
    .catch((err) => {
      coordinatorPort.postMessage({ id: req.id, ok: false, error: String((err && err.message) || err) });
    });
}

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg && msg.type === "initStream") {
    // A reused worker (see scanner.js's getCoordinatedNudenetWorker) gets a fresh stream
    // every scan — release whatever the previous scan's reader was still holding first.
    if (streamReader) {
      try { streamReader.cancel(); } catch (e) { /* ignore */ }
    }
    streamReader = msg.readable.getReader();
    return;
  }
  if (msg && msg.type === "initCoordinatorPort") {
    coordinatorPort = msg.port;
    coordinatorPort.onmessage = (ev) => {
      if (ev.data && ev.data.type === "classify") handleCoordinatorClassify(ev.data);
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
