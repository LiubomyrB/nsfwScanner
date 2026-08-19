// Classic (non-module) Web Worker: loads TensorFlow.js + NSFWJS via importScripts()
// (works cross-origin for classic workers, unlike ES module imports — see transcoder.js's
// header comment for why that distinction matters) and classifies frames sent from the
// main thread as transferable ImageBitmaps.
//
// Backend choice: WebGL is normally fastest on real GPU hardware (tf.js auto-detects
// OffscreenCanvas in a worker context, no extra plumbing needed). But when only a
// software-rendered WebGL is available (SwiftShader/llvmpipe — common in headless/CI/some
// VM environments), WebGL is often *slower* than the WASM backend. So each worker probes
// its renderer string first and picks whichever backend should actually be faster.
importScripts(
  "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js",
  "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.20.0/dist/tf-backend-wasm.min.js",
  "https://cdn.jsdelivr.net/npm/nsfwjs@4.4.0/dist/models/mobilenet_v2/model.min.js",
  "https://cdn.jsdelivr.net/npm/nsfwjs@4.4.0/dist/models/mobilenet_v2/group1-shard1of1.min.js",
  "https://cdn.jsdelivr.net/npm/nsfwjs@4.4.0/dist/browser/nsfwjs.min.js"
);

const WASM_BASE = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.20.0/dist/";

function looksLikeSoftwareRenderer() {
  try {
    const gl = new OffscreenCanvas(1, 1).getContext("webgl2") || new OffscreenCanvas(1, 1).getContext("webgl");
    if (!gl) return true; // no WebGL at all -> treat as "not usable", fall back to wasm
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    return /swiftshader|llvmpipe|software/i.test(renderer);
  } catch (e) {
    return true;
  }
}

let modelPromise = null;
function getModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      let backend = "webgl";
      if (looksLikeSoftwareRenderer()) backend = "wasm";
      try {
        if (backend === "wasm") tf.wasm.setWasmPaths(WASM_BASE);
        await tf.setBackend(backend);
        await tf.ready();
      } catch (e) {
        // Last-resort fallback if the preferred backend fails to initialize at all.
        tf.wasm.setWasmPaths(WASM_BASE);
        await tf.setBackend("wasm");
        await tf.ready();
        backend = "wasm";
      }
      const model = await nsfwjs.load("MobileNetV2");
      return { model, backend };
    })();
  }
  return modelPromise;
}

function nudityScore(predictions) {
  let score = 0;
  for (const p of predictions) {
    if (p.className === "Porn" || p.className === "Hentai" || p.className === "Sexy") {
      score += p.probability;
    }
  }
  return Math.min(1, score);
}

self.onmessage = async (e) => {
  const { id, bitmap } = e.data;
  try {
    const { model, backend } = await getModel();
    const predictions = await model.classify(bitmap);
    bitmap.close();
    self.postMessage({ id, ok: true, probability: nudityScore(predictions), backend });
  } catch (err) {
    try { bitmap.close(); } catch (e2) { /* ignore */ }
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};

// Kick model load off immediately on startup (before the first real request arrives)
// and tell the main thread which backend won, purely for status/diagnostics.
getModel().then(({ backend }) => self.postMessage({ ready: true, backend }))
  .catch((err) => self.postMessage({ ready: true, error: String((err && err.message) || err) }));
