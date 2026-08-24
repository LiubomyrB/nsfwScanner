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
const CONFIRM_LABELS = ["female-breast-bare", "female-vagina", "male-penis", "anus-bare", "male-breast-bare"];
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
  const parts = [];
  for (const i of keep) {
    const classId = classIds[i];
    if (CONFIRM_IDS.includes(classId)) {
      parts.push({ score: scores[i], class: LABELS[classId] });
      if (scores[i] > maxConfirmScore) maxConfirmScore = scores[i];
    }
  }
  return { matched: parts.length > 0, maxScore: maxConfirmScore, parts };
}

self.onmessage = async (e) => {
  const { id, bitmap, minScore } = e.data;
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
