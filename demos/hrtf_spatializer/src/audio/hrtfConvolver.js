// Pure, testable core of the real-time HRTF convolution: direct
// time-domain convolution of a mono input against a pair of (left/right
// ear) impulse responses that can change between calls, crossfading
// across exactly the block in which a change lands so a filter switch
// never clicks.
//
// Direct time-domain convolution rather than FFT. For a 128-tap filter at
// a 128-sample render quantum this is cheap either way (a few tens of
// thousands of multiply-adds per channel per block — trivial for any
// modern CPU), and it avoids FFT block-size bookkeeping entirely, which
// matters more here: the filter is time-varying (the source moves), and
// blending old/new filter is just "convolve with both, crossfade the two
// outputs" in the time domain. Doing that with FFT convolution would mean
// running two whole separate overlap-add pipelines through every
// transition — much more machinery for the same result at this length.
//
// The old Python prototype used FFT convolution and switched to each new
// filter with no crossfade, relying on tiny chunks (30 samples) to keep
// any resulting discontinuity small/inaudible. This instead crossfades
// explicitly: whenever a new filter arrives, the one block spanning the
// change linearly blends the old and new filter's output sample-by-
// sample, so a real filter change (a source that jumped somewhere new)
// never produces an audible click, and a continuously-moving source gets
// a fresh smooth crossfade every block.
//
// Deliberately has no AudioWorkletProcessor API in it, so it can be
// exercised directly from a plain script or test — see
// hrtfWorkletProcessor.js for the thin real-time wrapper around this.
export function createHrtfConvolver() {
  // Unit impulse = pure passthrough, so audio isn't silent before the
  // first real HRIR is set.
  let filterLength = 1;
  let activeLeft = new Float32Array([1]);
  let activeRight = new Float32Array([1]);
  let tail = new Float32Array(0); // filterLength - 1 samples of input history

  let pendingLeft = null;
  let pendingRight = null;

  function setFilter(left, right) {
    pendingLeft = left;
    pendingRight = right;
  }

  function processBlock(inputChannel, outLeft, outRight) {
    const blockSize = outLeft.length;

    let transitionFrom = null;
    if (pendingLeft) {
      if (pendingLeft.length !== filterLength) {
        // New filter length invalidates old history; start clean rather
        // than trying to resize/reinterpret a tail built for a different
        // length. (In practice this only happens once, when the first
        // real HRIR replaces the length-1 startup passthrough.)
        filterLength = pendingLeft.length;
        tail = new Float32Array(filterLength - 1);
      } else {
        transitionFrom = { left: activeLeft, right: activeRight };
      }
      activeLeft = pendingLeft;
      activeRight = pendingRight;
      pendingLeft = null;
      pendingRight = null;
    }

    const historyLength = filterLength - 1;
    const extended = new Float32Array(historyLength + blockSize);
    extended.set(tail, 0);
    if (inputChannel) {
      extended.set(inputChannel, historyLength);
    } // else leave zeros: silence in, silence out

    for (let n = 0; n < blockSize; n++) {
      const base = historyLength + n;
      let left = 0;
      let right = 0;
      for (let k = 0; k < filterLength; k++) {
        const sample = extended[base - k];
        left += activeLeft[k] * sample;
        right += activeRight[k] * sample;
      }

      if (transitionFrom) {
        let leftOld = 0;
        let rightOld = 0;
        for (let k = 0; k < filterLength; k++) {
          const sample = extended[base - k];
          leftOld += transitionFrom.left[k] * sample;
          rightOld += transitionFrom.right[k] * sample;
        }
        const mix = blockSize > 1 ? n / (blockSize - 1) : 1;
        left = leftOld * (1 - mix) + left * mix;
        right = rightOld * (1 - mix) + right * mix;
      }

      outLeft[n] = left;
      outRight[n] = right;
    }

    if (historyLength > 0) {
      tail.set(extended.subarray(blockSize, blockSize + historyLength));
    }
  }

  return { setFilter, processBlock };
}
