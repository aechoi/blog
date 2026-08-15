import { createHrtfConvolver } from "./hrtfConvolver.js";

// Thin real-time wrapper: forwards filters into the convolver and pumps
// one render quantum through it per process() call. All the actual DSP
// lives in hrtfConvolver.js so it can be tested outside a real audio
// graph.
//
// Two ways to supply filters:
//
// - Live (default): filters arrive via port.postMessage as the source
//   moves, timing not otherwise controlled — fine for real-time playback,
//   where "prompt" is good enough and exact block alignment doesn't
//   matter perceptually.
// - Precomputed sequence (processorOptions.filterSequence, an array of
//   {left, right}): used for offline rendering (see renderOffline.js),
//   where the output must exactly reproduce the recorded automation
//   rather than whatever happened to arrive via messaging. Passing the
//   whole sequence in at construction time and walking it one entry per
//   process() call is deterministic — OfflineAudioContext always calls
//   process() once per render quantum in order, so entry N always lands
//   on block N regardless of how fast the offline render actually runs.
class HrtfProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.convolver = createHrtfConvolver();

    const sequence = options?.processorOptions?.filterSequence;
    if (sequence) {
      this.sequence = sequence;
      this.sequenceIndex = 0;
    } else {
      this.port.onmessage = (event) => {
        this.convolver.setFilter(event.data.left, event.data.right);
      };
    }
  }

  process(inputs, outputs) {
    if (this.sequence && this.sequenceIndex < this.sequence.length) {
      const filter = this.sequence[this.sequenceIndex];
      this.convolver.setFilter(filter.left, filter.right);
      this.sequenceIndex++;
    }

    const inputChannel = inputs[0] && inputs[0][0];
    const output = outputs[0];
    this.convolver.processBlock(inputChannel, output[0], output[1]);
    return true;
  }
}

registerProcessor("hrtf-processor", HrtfProcessor);
