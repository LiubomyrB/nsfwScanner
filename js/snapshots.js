// @ts-nocheck — plain classic-script module; VMSnapshots is wired as a window global, same
// pattern as VMDB/VMScanner/VMTranscoder/VMMediabunnyPlayer/VMAssExport/VMI18n.
//
// Captures small cropped thumbnails of whatever region of the video frame triggered a
// detected scene, for the Timecodes dialog's snapshot grid (see app.js's
// renderTimecodesSnapshotGrid). Deliberately the ONLY function used for this whether it's
// called right after a scan finishes or when restoring a previously-scanned video from
// IndexedDB: neither the samples nor the video file distinguish those two cases (both are
// just "a File" + "a list of {time, rect} descriptors" by the time this runs), and nothing
// scan-session-specific (worker pools, cancel tokens, etc) is needed to grab a frame and
// crop it — so one function serves both, rather than keeping a "fresh scan" version and a
// "restore" version in sync by hand.
(function (global) {
  // Extra margin around the raw detected box so a thumbnail isn't a razor-tight, hard-to-
  // read crop of just the box itself — a bit of surrounding context reads much better at
  // thumbnail size.
  const PADDING_FRACTION = 0.2;
  const THUMB_MAX_SIZE = 200; // px, longest edge of the output thumbnail

  function padRect(rect) {
    const padX = rect.w * PADDING_FRACTION;
    const padY = rect.h * PADDING_FRACTION;
    const x1 = Math.max(0, rect.x - padX);
    const y1 = Math.max(0, rect.y - padY);
    const x2 = Math.min(1, rect.x + rect.w + padX);
    const y2 = Math.min(1, rect.y + rect.h + padY);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  function seekTo(video, time) {
    return new Promise((resolve) => {
      function onSeeked() {
        video.removeEventListener("seeked", onSeeked);
        // double rAF so the decoded frame is actually painted before we read pixels — same
        // reasoning as scanner.js's own seekTo.
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

  // Captures one cropped thumbnail from an already-loaded `video` element at `time`, around
  // fractional `rect` {x,y,w,h} (0..1, relative to the full frame). Returns a data: URL
  // (JPEG), or null if there's no usable rect (e.g. a legacy sample with no detection box)
  // or the video has no known dimensions yet.
  async function captureOne(video, time, rect) {
    if (!rect || rect.w <= 0 || rect.h <= 0) return null;
    await seekTo(video, time);
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const padded = padRect(rect);
    const sx = padded.x * vw;
    const sy = padded.y * vh;
    const sw = padded.w * vw;
    const sh = padded.h * vh;
    if (sw <= 0 || sh <= 0) return null;
    const scale = Math.min(1, THUMB_MAX_SIZE / Math.max(sw, sh));
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));
    const canvas = document.createElement("canvas");
    canvas.width = dw;
    canvas.height = dh;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
    return canvas.toDataURL("image/jpeg", 0.85);
  }

  // Captures one thumbnail per entry in `items` ([{time, rect}, ...]) from `file`, reusing a
  // single hidden <video> element for the whole batch rather than one per item. `onOne(index,
  // dataUrlOrNull)` (optional) fires after each capture resolves, for progressive rendering
  // — a grid with dozens of segments shouldn't block on every thumbnail before showing any of
  // them. Never touches the app's own live player <video> — this is its own throwaway
  // element, so seeking here doesn't disturb whatever the user is currently watching.
  async function captureBatch(file, items, onOne) {
    if (!file || !items || !items.length) return [];
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.style.position = "fixed";
    video.style.left = "-99999px";
    video.style.top = "0";
    video.style.width = "1px";
    video.style.height = "1px";
    document.body.appendChild(video);
    video.src = url;

    const results = [];
    try {
      await new Promise((resolve, reject) => {
        video.addEventListener("loadedmetadata", resolve, { once: true });
        video.addEventListener(
          "error",
          () => reject(video.error || new Error("Could not load the video file for snapshots.")),
          { once: true }
        );
      });

      for (let i = 0; i < items.length; i++) {
        let dataUrl = null;
        try {
          dataUrl = await captureOne(video, items[i].time, items[i].rect);
        } catch (e) {
          console.warn("Snapshot capture failed for one segment.", e);
        }
        results.push(dataUrl);
        if (onOne) onOne(i, dataUrl);
      }
      return results;
    } finally {
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.remove();
      URL.revokeObjectURL(url);
    }
  }

  global.VMSnapshots = { captureBatch };
})(window);
