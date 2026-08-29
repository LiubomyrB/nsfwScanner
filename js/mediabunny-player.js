// @ts-nocheck — plain classic-script module; VMMediabunnyPlayer is wired as a window global,
// same pattern as VMDB/VMScanner/VMTranscoder.
//
// Real-time playback for files the native <video> element can decode video for but not
// audio (the AC3/E-AC-3 case this was built for — see checkPlayability's comment in
// transcoder.js): demuxes and decodes entirely in-browser via mediabunny + its AC3 extension
// (a WASM build of FFmpeg's AC-3/E-AC-3 coder), rendering video frames to a <canvas> and
// scheduling decoded audio through the Web Audio API — no FFmpeg transcode step needed at
// all for files this can handle. app.js tries this BEFORE falling back to prompting for an
// FFmpeg audio-only remux (see finalizeAndLoadPlayer); the native <video> path stays exactly
// as it was and is still what's used whenever it already works on its own — this is
// specifically the fallback for when it doesn't.
//
// Both mediabunny and its AC3 extension ship only ESM bundles (no UMD/global build — see
// their unpkg listing), so this loads them the same way transcoder.js loads @ffmpeg/ffmpeg:
// dynamic import(), from inside a classic (non-module) script. Unlike @ffmpeg/ffmpeg though,
// @mediabunny/ac3's bundle imports the core "mediabunny" package via a bare specifier
// (`import ... from "mediabunny"`) instead of bundling it inline — that only resolves if the
// HOST PAGE declares an import map for it (see index.html's <script type="importmap">), so
// this module can't be dropped into a page that doesn't have one.
(function (global) {
  let modulesPromise = null;
  let ac3Registered = false;
  async function loadMediabunny() {
    if (!modulesPromise) {
      modulesPromise = Promise.all([import("mediabunny"), import("@mediabunny/ac3")]);
    }
    const [mb, ac3] = await modulesPromise;
    if (!ac3Registered) {
      // Only decoding, not encoding, since this is playback-only — we never produce AC3.
      ac3.registerAc3Decoder();
      ac3Registered = true;
    }
    return mb;
  }

  async function openInput(mb, file) {
    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    const videoTrack = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();
    return { input, videoTrack, audioTrack };
  }

  async function trackIsUsable(track) {
    if (!track) return true; // absence of a track isn't a decode failure
    if (!(await track.getCodec())) return false;
    if (!(await track.canDecode())) return false;
    return true;
  }

  // Checks whether mediabunny (with the AC3 extension registered) can actually decode
  // `file`'s primary video and audio tracks, without starting playback — used to decide
  // whether to route to this player instead of the FFmpeg-transcode prompt. Never throws;
  // a failure to even probe the file counts as "can't play it".
  async function canPlay(file) {
    try {
      const mb = await loadMediabunny();
      const { videoTrack, audioTrack } = await openInput(mb, file);
      if (!videoTrack && !audioTrack) return false;
      const videoOk = await trackIsUsable(videoTrack);
      const audioOk = await trackIsUsable(audioTrack);
      return videoOk && audioOk;
    } catch (e) {
      console.warn("Mediabunny playability check failed.", e);
      return false;
    }
  }

  // Sets up real playback into `canvas`, returning a small controller mirroring the bits of
  // HTMLMediaElement app.js's blur/persistence/resume logic needs: play(), pause(),
  // isPaused(), getCurrentTime(), setCurrentTime(t), destroy(). `opts.onTimeUpdate(t)` fires
  // on every rendered frame (this engine has no native "timeupdate" event to hook).
  async function create(canvas, file, opts) {
    const { onTimeUpdate, onEnded } = opts || {};
    const mb = await loadMediabunny();
    const { input, videoTrack, audioTrack } = await openInput(mb, file);

    if (videoTrack && !(await trackIsUsable(videoTrack))) throw new Error("Mediabunny cannot decode this file's video track.");
    if (audioTrack && !(await trackIsUsable(audioTrack))) throw new Error("Mediabunny cannot decode this file's audio track.");
    if (!videoTrack && !audioTrack) throw new Error("No audio or video track found.");

    const tracks = [videoTrack, audioTrack].filter((t) => t !== null);
    const firstTimestamp = Math.max(await input.getFirstTimestamp(tracks), 0);
    const duration = (await input.getDurationFromMetadata(tracks, { skipLiveWait: true }))
      ?? (await input.computeDuration(tracks, { skipLiveWait: true }));

    const context = canvas.getContext("2d");
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioContextCtor({ sampleRate: audioTrack ? await audioTrack.getSampleRate() : undefined });
    const gainNode = audioContext.createGain();
    gainNode.gain.value = 1;
    gainNode.connect(audioContext.destination);

    if (videoTrack) {
      canvas.width = await videoTrack.getDisplayWidth();
      canvas.height = await videoTrack.getDisplayHeight();
    }

    const videoSink = videoTrack ? new mb.CanvasSink(videoTrack, { poolSize: 2, fit: "contain" }) : null;
    const audioSink = audioTrack ? new mb.AudioBufferSink(audioTrack) : null;

    let playing = false;
    let playbackTimeAtStart = firstTimestamp;
    let audioContextStartTime = null;
    let destroyed = false;
    let asyncId = 0;

    let videoFrameIterator = null;
    let audioBufferIterator = null;
    let nextFrame = null;
    const queuedAudioNodes = new Set();

    function getPlaybackTime() {
      if (playing) return audioContext.currentTime - audioContextStartTime + playbackTimeAtStart;
      return playbackTimeAtStart;
    }

    async function startVideoIterator() {
      if (!videoSink) return;
      asyncId++;
      if (videoFrameIterator) { try { await videoFrameIterator.return(); } catch (e) { /* ignore */ } }
      videoFrameIterator = videoSink.canvases(getPlaybackTime());

      const firstFrame = (await videoFrameIterator.next()).value ?? null;
      const secondFrame = (await videoFrameIterator.next()).value ?? null;
      nextFrame = secondFrame;

      if (firstFrame && !destroyed) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(firstFrame.canvas, 0, 0);
      }
    }

    async function updateNextFrame() {
      const currentAsyncId = asyncId;
      while (true) {
        const newNextFrame = (await videoFrameIterator.next()).value ?? null;
        if (!newNextFrame || currentAsyncId !== asyncId || destroyed) break;
        const playbackTime = getPlaybackTime();
        if (newNextFrame.timestamp <= playbackTime) {
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.drawImage(newNextFrame.canvas, 0, 0);
        } else {
          nextFrame = newNextFrame;
          break;
        }
      }
    }

    function renderTick() {
      if (destroyed) return;
      const playbackTime = getPlaybackTime();
      if (playbackTime >= duration) {
        pause();
        playbackTimeAtStart = duration;
        if (onEnded) onEnded();
      }
      if (nextFrame && nextFrame.timestamp <= playbackTime) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(nextFrame.canvas, 0, 0);
        nextFrame = null;
        void updateNextFrame();
      }
      if (onTimeUpdate) onTimeUpdate(getPlaybackTime());
      requestAnimationFrame(renderTick);
    }

    async function runAudioIterator() {
      if (!audioSink) return;
      for await (const { buffer, timestamp } of audioBufferIterator) {
        if (destroyed) break;
        const node = audioContext.createBufferSource();
        node.buffer = buffer;
        node.connect(gainNode);

        let startTimestamp = audioContextStartTime + timestamp - playbackTimeAtStart;
        startTimestamp = Math.round(audioContext.sampleRate * startTimestamp) / audioContext.sampleRate;

        if (startTimestamp >= audioContext.currentTime) {
          node.start(startTimestamp);
        } else {
          node.start(audioContext.currentTime, audioContext.currentTime - startTimestamp);
        }

        queuedAudioNodes.add(node);
        node.onended = () => queuedAudioNodes.delete(node);

        if (timestamp - getPlaybackTime() >= 1) {
          await new Promise((resolve) => {
            const id = setInterval(() => {
              if (destroyed || timestamp - getPlaybackTime() < 1) {
                clearInterval(id);
                resolve();
              }
            }, 100);
          });
        }
      }
    }

    async function play() {
      if (destroyed) return;
      if (audioContext.state === "suspended") await audioContext.resume();
      if (getPlaybackTime() >= duration) {
        playbackTimeAtStart = firstTimestamp;
        await startVideoIterator();
      }
      audioContextStartTime = audioContext.currentTime;
      playing = true;
      if (audioSink) {
        if (audioBufferIterator) { try { await audioBufferIterator.return(); } catch (e) { /* ignore */ } }
        audioBufferIterator = audioSink.buffers(getPlaybackTime());
        void runAudioIterator();
      }
    }

    function pause() {
      playbackTimeAtStart = getPlaybackTime();
      playing = false;
      if (audioBufferIterator) { void audioBufferIterator.return(); audioBufferIterator = null; }
      for (const node of queuedAudioNodes) { try { node.stop(); } catch (e) { /* ignore */ } }
      queuedAudioNodes.clear();
    }

    async function setCurrentTime(seconds) {
      const wasPlaying = playing;
      if (wasPlaying) pause();
      playbackTimeAtStart = Math.max(firstTimestamp, Math.min(seconds, duration));
      await startVideoIterator();
      if (wasPlaying) await play();
    }

    await startVideoIterator();
    requestAnimationFrame(renderTick);

    return {
      duration,
      hasVideo: !!videoTrack,
      hasAudio: !!audioTrack,
      play,
      pause,
      isPaused: () => !playing,
      getCurrentTime: getPlaybackTime,
      setCurrentTime,
      // Volume is squared (matching the mediabunny example player) so the slider feels
      // linear to the ear — human loudness perception is roughly logarithmic, and gain
      // set directly to the linear slider position reads as "loud very early" otherwise.
      setVolume(v) { gainNode.gain.value = Math.max(0, Math.min(1, v)) ** 2; },
      destroy() {
        destroyed = true;
        pause();
        try { audioContext.close(); } catch (e) { /* ignore */ }
      },
    };
  }

  global.VMMediabunnyPlayer = { canPlay, create };
})(window);
