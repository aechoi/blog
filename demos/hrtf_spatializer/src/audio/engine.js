export class AudioEngine {
  constructor(store) {
    this.store = store;
    this.context = null;
    this.sourceNode = null;
    this.hrtfNode = null;
    this.workletReady = null;
    this.rafId = null;
    this.startedAtContextTime = 0; // context time when the current source started
    this.startedAtPlayhead = 0; // store.playhead value at that moment
    this.outputBridgeEl = null; // hidden <audio> el, only created if the setSinkId fallback below is needed
  }

  ensureContext() {
    if (!this.context) {
      this.context = new (window.AudioContext || window.webkitAudioContext)();
    }
    return this.context;
  }

  // Loads the HRTF convolution worklet and creates its node once. Audio
  // plays through this node (source -> hrtfNode -> destination) whether or
  // not a real HRIR has been set yet — the processor defaults to a unit
  // impulse (plain passthrough) until setFilter() is called.
  ensureWorklet() {
    if (!this.workletReady) {
      const ctx = this.ensureContext();
      this.workletReady = ctx.audioWorklet
        .addModule(new URL("./hrtfWorkletProcessor.js", import.meta.url))
        .then(() => {
          this.hrtfNode = new AudioWorkletNode(ctx, "hrtf-processor", {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
          });
          this.hrtfNode.connect(ctx.destination);
        });
    }
    return this.workletReady;
  }

  // Pushes a new left/right impulse response into the worklet. The
  // processor crossfades from whatever it was using to this over the next
  // render quantum, so this is safe to call continuously as the source
  // moves. Float32Arrays are transferred (not copied) since getIR() hands
  // back a fresh pair on every call.
  setFilter(left, right) {
    if (!this.hrtfNode) return;
    this.hrtfNode.port.postMessage({ left, right }, [left.buffer, right.buffer]);
  }

  // Routes all output to a specific device (speakers/headphones).
  // AudioContext.setSinkId (Chrome/Edge) is tried first since it needs
  // no extra plumbing; where that's missing but the older
  // HTMLMediaElement.setSinkId is available instead (Firefox 116+,
  // Safari 18.4+), falls back to bridging hrtfNode's output through a
  // MediaStreamAudioDestinationNode into a hidden <audio> element and
  // switching the sink there — same audible result, one extra hop.
  // Neither API being present (older browsers) returns false; callers
  // should also feature-detect up front (see devices.js) before even
  // offering the control.
  async setOutputDevice(deviceId) {
    const ctx = this.ensureContext();
    if (typeof ctx.setSinkId === "function") {
      await ctx.setSinkId(deviceId);
      return true;
    }
    if (typeof HTMLMediaElement.prototype.setSinkId === "function") {
      await this.ensureWorklet();
      this.ensureOutputBridge();
      await this.outputBridgeEl.setSinkId(deviceId);
      return true;
    }
    return false;
  }

  // Reroutes hrtfNode's output from the AudioContext's own destination
  // into a hidden <audio> element via a MediaStream, so
  // HTMLMediaElement.setSinkId() has something to target — built lazily,
  // the first time it's actually needed, so browsers with native
  // AudioContext.setSinkId support (or anyone who never touches the
  // output device control) never pay for the extra hop. Idempotent —
  // safe to call on every setOutputDevice() once the bridge exists.
  ensureOutputBridge() {
    if (this.outputBridgeEl) return;
    const ctx = this.ensureContext();
    const dest = ctx.createMediaStreamDestination();
    this.hrtfNode.disconnect();
    this.hrtfNode.connect(dest);
    const audioEl = new Audio();
    audioEl.srcObject = dest.stream;
    audioEl.play().catch(() => {
      // Autoplay can be blocked without a user gesture, but
      // setOutputDevice() is only ever called from a <select> "change"
      // handler, which counts as one — this is just a defensive catch.
    });
    this.outputBridgeEl = audioEl;
  }

  async loadFile(file) {
    const ctx = this.ensureContext();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    this.store.loadAudio(audioBuffer, file.name);
  }

  async play() {
    const { audio, playhead, isPlaying } = this.store.state;
    if (!audio || isPlaying) return;
    const ctx = this.ensureContext();
    if (ctx.state === "suspended") ctx.resume();
    await this.ensureWorklet();

    const source = ctx.createBufferSource();
    source.buffer = audio.buffer;
    source.connect(this.hrtfNode);
    source.start(0, playhead);
    source.onended = () => {
      // Only react if this source is still the active one (pause() stops it manually
      // and clears onended first, so a stale callback won't fire this).
      if (this.sourceNode === source) {
        this.sourceNode = null;
        this.stopLoop();
        this.store.seek(audio.duration);
        this.store.pause();
      }
    };
    this.sourceNode = source;

    this.beginPlayheadAdvance();
  }

  pause() {
    if (!this.store.state.isPlaying) return;
    if (this.sourceNode) {
      this.sourceNode.onended = null;
      this.sourceNode.stop();
      this.sourceNode = null;
    }
    this.endPlayheadAdvance();
  }

  // Starts the playhead advancing from wherever it currently is, without
  // necessarily playing anything through a source node — this is what
  // both play() and microphoneRecorder.js use, so recording (which
  // deliberately doesn't create a source node, to avoid monitoring
  // feedback) still gets a correctly-anchored, live-advancing playhead
  // rather than one computed from whatever startedAtContextTime/
  // startedAtPlayhead happened to be left at by the last real play().
  beginPlayheadAdvance() {
    const ctx = this.ensureContext();
    this.startedAtContextTime = ctx.currentTime;
    this.startedAtPlayhead = this.store.state.playhead;
    this.store.play();
    this.startLoop();
  }

  endPlayheadAdvance() {
    this.stopLoop();
    this.store.pause();
  }

  // Routes a live audio source — the mic being recorded — into the same
  // HRTF chain everything else plays through, so you can hear your own
  // voice/instrument, spatialized, as you record it. This is genuine
  // input monitoring (hearing yourself, live), not played-back material
  // — it works identically whether there's prior audio in the buffer or
  // not, since it's just an extra connection on top of whatever's
  // already captured for storage; microphoneRecorder.js's own
  // mic-capture path is untouched by this. Headphones are assumed:
  // routing live mic input back out to speakers risks acoustic feedback,
  // which is exactly why this is a connection that can be toggled off,
  // not something forced on unconditionally.
  async connectLiveInput(sourceNode) {
    await this.ensureWorklet();
    sourceNode.connect(this.hrtfNode);
  }

  disconnectLiveInput(sourceNode) {
    try {
      sourceNode.disconnect(this.hrtfNode);
    } catch {
      // already disconnected (or never was) — nothing to do
    }
  }

  seek(t) {
    const wasPlaying = this.store.state.isPlaying;
    if (wasPlaying) this.pause();
    this.store.seek(t);
    if (wasPlaying) this.play();
  }

  startLoop() {
    const tick = () => {
      const elapsed = this.context.currentTime - this.startedAtContextTime;
      const t = this.startedAtPlayhead + elapsed;
      const duration = this.store.state.audio.duration;
      this.store.seek(Math.min(t, duration));
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stopLoop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}
