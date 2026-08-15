// Renders the full loaded audio buffer through the HRTF convolver, driven
// by whatever az/el/r path is currently recorded — this is what "download
// the modified audio" actually produces. Runs as fast as the machine can
// go (OfflineAudioContext), not in real time.
//
// The live path feeds filters to the worklet via postMessage as playback
// happens, with no guarantee about which render quantum a given message
// lands on — fine for real-time listening, not for a reproducible offline
// render. So instead: precompute one filter per render quantum up front
// (getIR is cheap — a few milliseconds for a whole track, see
// hrtfInterpolator.js) and hand the entire sequence to the worklet via
// processorOptions at construction time. OfflineAudioContext always calls
// process() exactly once per render quantum in order, so walking that
// array one entry per call deterministically reproduces the recorded
// automation regardless of how fast the offline render actually runs.
const BLOCK_SIZE = 128;

export async function renderHrtfAudio({ audioBuffer, store, interpolator }) {
  const sampleRate = audioBuffer.sampleRate;
  const totalSamples = audioBuffer.length;
  const blockCount = Math.ceil(totalSamples / BLOCK_SIZE);

  const filterSequence = new Array(blockCount);
  for (let i = 0; i < blockCount; i++) {
    const t = (i * BLOCK_SIZE) / sampleRate;
    const pos = store.getPositionAt(t);
    filterSequence[i] = interpolator.getIR(pos.az, pos.el, pos.r);
  }

  const offlineCtx = new OfflineAudioContext(2, totalSamples, sampleRate);
  await offlineCtx.audioWorklet.addModule(new URL("./hrtfWorkletProcessor.js", import.meta.url));

  const node = new AudioWorkletNode(offlineCtx, "hrtf-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { filterSequence },
  });

  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(node);
  node.connect(offlineCtx.destination);
  source.start(0);

  return offlineCtx.startRendering();
}
