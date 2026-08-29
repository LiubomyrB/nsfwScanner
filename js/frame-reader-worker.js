// @ts-nocheck — classic worker script; not part of the VMDB/VMScanner classic-script-globals
// app (no DOM access here, only OffscreenCanvas/VideoFrame/ReadableStream).
//
// Reads decoded VideoFrames from a MediaStreamTrackProcessor's readable stream (transferred
// in from scanner.js's createStreamFrameSource — see that function's own comment for why
// this whole approach exists: it keeps working when the tab is backgrounded, unlike the
// rAF/requestVideoFrameCallback-based seeking it replaces) and turns each requested one
// straight into a ready-to-classify ImageBitmap, entirely off the main thread — the actual
// per-frame CPU cost (canvas draw + resize) no longer competes with page/UI rendering during
// a scan, on top of not being blocked by tab visibility.
//
// Protocol (all messages plain objects via postMessage):
//   {type: "init", readable}                      — the transferred ReadableStream<VideoFrame>
//   {type: "getFrame", id, time, mode, size}       — request a bitmap for `time` (seconds);
//                                                     `mode`: "stretch" (plain resize, for
//                                                     NSFWJS) or "letterbox" (aspect-preserving
//                                                     + black-padded, for NudeNet); `size`:
//                                                     output width/height in px (square).
// Replies:
//   {id, ok: true, bitmap}  (bitmap transferred, or null if no matching frame arrived in time)
//   {id, ok: false, error}
(function () {
  // How far a delivered VideoFrame's timestamp may land *before* the requested time and
  // still count as "the frame for this sample" — mirrors scanner.js's own constant (kept as
  // a literal here rather than shared, same reasoning as CONFIRM_LABELS' duplication
  // elsewhere in this app: no module system to share a constant across the worker boundary).
  const FRAME_MATCH_EPSILON = 0.03;
  const FRAME_WAIT_TIMEOUT_MS = 1000;

  let reader = null;

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

  // Drains the stream until a frame whose timestamp is at/after `time` (within
  // FRAME_MATCH_EPSILON) arrives, discarding stale (pre-seek) frames along the way. Returns
  // null if nothing matches within FRAME_WAIT_TIMEOUT_MS (the caller's seek may have landed
  // somewhere this stream never reports, e.g. right at end-of-video) — callers treat that as
  // "skip this sample" rather than an error.
  async function getFrameAt(time) {
    const deadline = Date.now() + FRAME_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const outcome = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), remaining)),
      ]);
      if (outcome.timedOut) break;
      const { value, done } = outcome;
      if (done || !value) break;
      const frameTime = value.timestamp / 1e6;
      if (frameTime >= time - FRAME_MATCH_EPSILON) return value;
      value.close();
    }
    return null;
  }

  function grabBitmap(frame, size) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(frame, 0, 0, size, size);
    return createImageBitmap(canvas, { resizeWidth: size, resizeHeight: size });
  }

  function grabLetterboxBitmap(frame, size) {
    const vw = frame.displayWidth || 1;
    const vh = frame.displayHeight || 1;
    const { newW, newH, padLeft, padTop } = letterboxGeometry(vw, vh, size);
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(frame, 0, 0, vw, vh, padLeft, padTop, newW, newH);
    return createImageBitmap(canvas, { resizeWidth: size, resizeHeight: size });
  }

  self.onmessage = async (e) => {
    const msg = e.data;
    if (msg.type === "init") {
      reader = msg.readable.getReader();
      return;
    }
    if (msg.type === "getFrame") {
      const { id, time, mode, size } = msg;
      try {
        const frame = await getFrameAt(time);
        if (!frame) {
          self.postMessage({ id, ok: true, bitmap: null });
          return;
        }
        const bitmap = mode === "letterbox" ? await grabLetterboxBitmap(frame, size) : await grabBitmap(frame, size);
        frame.close();
        self.postMessage({ id, ok: true, bitmap }, [bitmap]);
      } catch (err) {
        self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
      }
    }
  };
})();
