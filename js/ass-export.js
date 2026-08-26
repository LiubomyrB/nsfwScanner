// @ts-nocheck — plain classic-script module; VMAssExport is wired as a window global, same
// pattern as VMDB/VMScanner/VMTranscoder/VMMediabunnyPlayer.
//
// Generates an ASS (Advanced SubStation Alpha) subtitle file that shows a silent-film-style
// "intertitle" card (full-frame background + ornamental corner frame + centered text) over
// each detected scene, instead of relying on this app's own in-browser blur — for playing
// the original video file in a normal media player (VLC/mpv/etc) with the subtitle loaded
// alongside it. The card design below is authored at a 1920x1080 reference resolution;
// generate() rescales every drawing coordinate proportionally to the actual video's own
// resolution rather than relying on ASS's own PlayRes-based auto-scaling, so PlayResX/
// PlayResY in the output file always matches the real video and needs no further scaling by
// whatever plays it.
(function (global) {
  const REF_WIDTH = 1920;
  const REF_HEIGHT = 1080;
  const REF_FONTSIZE = 76;
  const REF_MARGIN = 260;
  const REF_SPACING = 1;

  // layer/style/draw exactly as in the reference template (see project notes) — draw
  // commands use ASS's vector drawing mini-language ("m x y" = move-to, "l x y..." = one or
  // more line-to points), all in the 1920x1080 reference space.
  const SHAPES = [
    { layer: 0, style: "Background", draw: "m 0 0 l 1920 0 l 1920 1080 l 0 1080 l 0 0" },

    // top-left frame lines (outer + inner)
    { layer: 1, style: "Ornament", draw: "m 110 110 l 570 110 l 570 114 l 110 114" },
    { layer: 1, style: "Ornament", draw: "m 110 110 l 110 520 l 114 520 l 114 110" },
    { layer: 1, style: "Ornament", draw: "m 135 135 l 470 135 l 470 138 l 135 138" },
    { layer: 1, style: "Ornament", draw: "m 135 135 l 135 440 l 138 440 l 138 135" },

    // top-right frame lines
    { layer: 1, style: "Ornament", draw: "m 1350 110 l 1810 110 l 1810 114 l 1350 114" },
    { layer: 1, style: "Ornament", draw: "m 1806 110 l 1806 520 l 1810 520 l 1810 110" },
    { layer: 1, style: "Ornament", draw: "m 1450 135 l 1785 135 l 1785 138 l 1450 138" },
    { layer: 1, style: "Ornament", draw: "m 1782 135 l 1782 440 l 1785 440 l 1785 135" },

    // bottom-left frame lines
    { layer: 1, style: "Ornament", draw: "m 110 970 l 570 970 l 570 974 l 110 974" },
    { layer: 1, style: "Ornament", draw: "m 110 560 l 110 970 l 114 970 l 114 560" },
    { layer: 1, style: "Ornament", draw: "m 135 942 l 470 942 l 470 945 l 135 945" },
    { layer: 1, style: "Ornament", draw: "m 135 640 l 135 945 l 138 945 l 138 640" },

    // bottom-right frame lines
    { layer: 1, style: "Ornament", draw: "m 1350 970 l 1810 970 l 1810 974 l 1350 974" },
    { layer: 1, style: "Ornament", draw: "m 1806 560 l 1806 970 l 1810 970 l 1810 560" },
    { layer: 1, style: "Ornament", draw: "m 1450 942 l 1785 942 l 1785 945 l 1450 945" },
    { layer: 1, style: "Ornament", draw: "m 1782 640 l 1782 945 l 1785 945 l 1785 640" },
];

  const INTERTITLE_TEXT = "Censored scene";

  function formatAssTime(seconds) {
    seconds = Math.max(0, seconds);
    const totalCentiseconds = Math.round(seconds * 100);
    const cs = totalCentiseconds % 100;
    const totalSeconds = Math.floor(totalCentiseconds / 100);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
  }

  // Rescales every "m x y" / "l x y [x y ...]" coordinate pair in a drawing command by
  // (scaleX, scaleY) — a small hand-rolled tokenizer rather than a single regex, since ASS's
  // "l" can be followed by any number of coordinate pairs (a polyline), not just one.
  function scaleDrawCommand(cmd, scaleX, scaleY) {
    const tokens = cmd.trim().split(/\s+/);
    const out = [];
    let i = 0;
    const isNum = (t) => /^-?\d+(\.\d+)?$/.test(t);
    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok === "m" || tok === "l") {
        out.push(tok);
        i++;
        while (i + 1 < tokens.length && isNum(tokens[i]) && isNum(tokens[i + 1])) {
          out.push(String(Math.round(parseFloat(tokens[i]) * scaleX)));
          out.push(String(Math.round(parseFloat(tokens[i + 1]) * scaleY)));
          i += 2;
        }
      } else {
        out.push(tok);
        i++;
      }
    }
    return out.join(" ");
  }

  // Merges overlapping/touching [start,end] windows so two scenes close enough that their
  // advance-padded windows touch produce one continuous cue instead of two overlapping ones.
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

  // `segments`: [{start, end}, ...] in seconds — the scenes to cover. `blurAdvance`: seconds
  // to pad on both sides (mirrors the app's own blur-in-advance behavior — see
  // handlePlaybackTimeUpdate in app.js). `videoWidth`/`videoHeight`: the actual video's frame
  // size, used for PlayResX/PlayResY and to scale every drawing coordinate/font size/margin
  // from this module's 1920x1080 reference design down (or up) to match.
  function generate(videoWidth, videoHeight, segments, blurAdvance) {
    const w = Math.max(1, Math.round(videoWidth) || REF_WIDTH);
    const h = Math.max(1, Math.round(videoHeight) || REF_HEIGHT);
    const scaleX = w / REF_WIDTH;
    const scaleY = h / REF_HEIGHT;
    const advance = Math.max(0, blurAdvance || 0);

    const fontsize = Math.max(1, Math.round(REF_FONTSIZE * scaleY));
    const margin = Math.max(0, Math.round(REF_MARGIN * scaleX));
    const spacing = (REF_SPACING * scaleX).toFixed(1);
    const centerX = Math.round(w / 2);
    const centerY = Math.round(h / 2);

    const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding

Style: Background,Arial,10,&H00141414,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
; Try UnifrakturCook / UnifrakturMaguntia if installed
Style: Intertitle,UnifrakturCook,${fontsize},&H00A0C6D6,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,${spacing},0,0,0,0,5,${margin},${margin},0,1
Style: Ornament,Arial,10,&H00A0C6D6,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    const scaledShapes = SHAPES.map((shape) => ({
      layer: shape.layer,
      style: shape.style,
      draw: scaleDrawCommand(shape.draw, scaleX, scaleY),
    }));

    const windows = (segments || []).map((seg) => ({
      start: Math.max(0, seg.start - advance),
      end: seg.end + advance,
    }));
    const merged = mergeWindows(windows);

    const lines = [];
    for (const win of merged) {
      const start = formatAssTime(win.start);
      const end = formatAssTime(win.end);
      for (const shape of scaledShapes) {
        lines.push(`Dialogue: ${shape.layer},${start},${end},${shape.style},,0,0,0,,{\\an7\\pos(0,0)\\p1}${shape.draw}{\\p0}`);
      }
      lines.push(`Dialogue: 10,${start},${end},Intertitle,,0,0,0,,{\\an5\\pos(${centerX},${centerY})}${INTERTITLE_TEXT}`);
    }

    return header + lines.join("\n") + "\n";
  }

  global.VMAssExport = { generate };
})(window);
