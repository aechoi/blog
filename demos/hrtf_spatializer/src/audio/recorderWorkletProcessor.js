// Forwards raw mono microphone samples to the main thread — batched
// into ~4096-sample groups (well under 100ms) rather than posting every
// single 128-sample render quantum (~375 messages/sec at 48kHz).
// postMessage across the audio-thread/main-thread boundary has real,
// measurable per-call overhead, and different browsers pay noticeably
// different amounts of it — batching cuts how often that happens by
// ~30x, imperceptible for both the waveform preview and the
// duration/path bookkeeping this feeds (see microphoneRecorder.js): the
// latter is only ever actually applied once per animation frame anyway
// (flushPendingUpdates() there is rAF-gated, independent of how big or
// small these batches are), so a bigger batch only means fewer, larger
// messages — not any less frequent an update to what's actually
// displayed. No sample is ever dropped — this only changes how they're
// grouped when handed off.
//
// A pending, not-yet-full batch would otherwise be lost at the exact
// moment recording stops, so the main thread explicitly asks for a
// flush before it tears the graph down (see microphoneRecorder.js's
// stop()) — always answered, even with a zero-length array if there
// was nothing pending, so the main thread has a deterministic response
// to wait for rather than guessing with a timeout.
const BATCH_SIZE = 4096;

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(BATCH_SIZE);
    this.writeIndex = 0;
    this.port.onmessage = (event) => {
      if (event.data === "flush") this.flush();
    };
  }

  flush() {
    const out = this.buffer.slice(0, this.writeIndex);
    this.port.postMessage(out, [out.buffer]);
    this.buffer = new Float32Array(BATCH_SIZE);
    this.writeIndex = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      let i = 0;
      while (i < channel.length) {
        const spaceLeft = this.buffer.length - this.writeIndex;
        const toCopy = Math.min(spaceLeft, channel.length - i);
        this.buffer.set(channel.subarray(i, i + toCopy), this.writeIndex);
        this.writeIndex += toCopy;
        i += toCopy;
        if (this.writeIndex === this.buffer.length) this.flush();
      }
    }
    return true;
  }
}

registerProcessor("recorder-processor", RecorderProcessor);
