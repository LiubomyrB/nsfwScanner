// Classic (non-module) Web Worker: loads a TFJS port of NudeNet (vladmandic/nudenet,
// MIT-licensed, model files streamed from its GitHub repo via jsdelivr's GH CDN — the
// project is archived/unmaintained but the static model files are unaffected by that) and
// runs real body-part *object detection* (bounding boxes + per-box class), instead of
// NSFWJS's whole-frame classification. This is what lets us blur only on an actual
// detected exposed breast/genital/anus region instead of "this frame generally looks
// skin-heavy" (which is what causes bare-neck/shoulder false positives with NSFWJS alone).
//
// Unlike scan-worker.js, this one does NOT fall back to the WASM backend: NudeNet's graph
// (unlike NSFWJS's plain MobileNetV2) throws a tensor-rank error inside a concat op under
// tfjs's WASM kernels ("Error in concat4D: rank of tensors[3] must be the same as the rank
// of the rest") — confirmed by actually running it, not assumed. The upstream demo only
// ever targeted WebGL/WebGPU too. So this worker always uses WebGL (tf.js auto-detects
// OffscreenCanvas in a worker) and fails loudly if that's unavailable, instead of silently
// switching to a backend that produces a broken result.
importScripts("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js");

const MODEL_URL = "https://cdn.jsdelivr.net/gh/vladmandic/nudenet@main/models/default-f16/model.json";
const OUTPUT_NODES = ["output1", "output2", "output3"];

// Index into this array = class id the model emits.
const LABELS = [
  "exposed anus", "exposed armpits", "belly", "exposed belly", "buttocks", "exposed buttocks",
  "female face", "male face", "feet", "exposed feet", "breast", "exposed breast",
  "vagina", "exposed vagina", "male breast", "exposed male breast",
];

// The classes that actually count as "breast/genitals" for our purposes — deliberately
// excludes covered breast/buttocks/belly/vagina, faces, feet, and armpits, so a bare neck
// or midriff can never match no matter how confident the model is about *something* there.
// "exposed buttocks" is deliberately left out too, matching the "breast and genitals" scope
// asked for; adjust this list to widen/narrow what counts.
const CONFIRM_LABELS = ["exposed anus", "exposed breast", "exposed vagina", "exposed male breast"];
const CONFIRM_IDS = CONFIRM_LABELS.map((l) => LABELS.indexOf(l));

function rendererInfo() {
  try {
    const gl = new OffscreenCanvas(1, 1).getContext("webgl2") || new OffscreenCanvas(1, 1).getContext("webgl");
    if (!gl) return { available: false, renderer: null };
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    return { available: true, renderer, software: /swiftshader|llvmpipe|software/i.test(renderer) };
  } catch (e) {
    return { available: false, renderer: null };
  }
}

let modelPromise = null;
function getModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      const info = rendererInfo();
      if (!info.available) {
        throw new Error("WebGL is not available in this browser, so the body-part detector (NudeNet) can't run.");
      }
      await tf.setBackend("webgl");
      await tf.ready();
      const model = await tf.loadGraphModel(MODEL_URL);
      const backend = info.software ? "webgl-software (slow)" : "webgl";
      return { model, backend };
    })();
  }
  return modelPromise;
}

async function detect(model, bitmap, minScore) {
  const buffer = tf.browser.fromPixels(bitmap);
  const h = buffer.shape[0];
  const w = buffer.shape[1];
  // Preserve aspect ratio at a moderate resolution — NudeNet needs more spatial detail
  // than NSFWJS's 224x224 square crop to localize small regions.
  const targetH = 640;
  const targetW = Math.round(targetH * (w / h));
  const resized = tf.image.resizeBilinear(buffer, [targetH, targetW]);
  const cast = tf.cast(resized, "float32");
  const batch = tf.expandDims(cast, 0);

  const [boxesT, scoresT, classesT] = await model.executeAsync(batch, OUTPUT_NODES);
  const boxes = await boxesT.array();
  const scores = await scoresT.data();
  const classes = await classesT.data();
  const nmsT = await tf.image.nonMaxSuppressionAsync(boxes[0], scores, 50, 0.5, minScore);
  const nms = await nmsT.data();

  let maxScore = 0;
  const parts = [];
  for (const i of nms) {
    const classId = classes[i];
    const score = scores[i];
    if (CONFIRM_IDS.includes(classId)) {
      parts.push({ score, class: LABELS[classId] });
      if (score > maxScore) maxScore = score;
    }
  }

  tf.dispose([buffer, resized, cast, batch, boxesT, scoresT, classesT, nmsT]);
  return { matched: parts.length > 0, maxScore, parts };
}

self.onmessage = async (e) => {
  const { id, bitmap, minScore } = e.data;
  try {
    const { model, backend } = await getModel();
    const result = await detect(model, bitmap, typeof minScore === "number" ? minScore : 0.2);
    bitmap.close();
    self.postMessage({ id, ok: true, backend, ...result });
  } catch (err) {
    try { bitmap.close(); } catch (e2) { /* ignore */ }
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};

getModel().then(({ backend }) => self.postMessage({ ready: true, backend }))
  .catch((err) => self.postMessage({ ready: true, error: String((err && err.message) || err) }));
