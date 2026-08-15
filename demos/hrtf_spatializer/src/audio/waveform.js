// Fixed time resolution for peak buckets. Fine enough to zoom in
// reasonably close; a full linear scan of the buffer either way, so
// cost is O(samples) regardless of this value.
export const BUCKETS_PER_SECOND = 1000;

export function computePeaks(audioBuffer, bucketsPerSecond = BUCKETS_PER_SECOND) {
  const duration = audioBuffer.duration;
  const count = Math.max(1, Math.ceil(duration * bucketsPerSecond));
  const min = new Float32Array(count);
  const max = new Float32Array(count);

  const channels = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    channels.push(audioBuffer.getChannelData(c));
  }
  const samplesPerBucket = audioBuffer.sampleRate / bucketsPerSecond;

  for (let b = 0; b < count; b++) {
    const startSample = Math.floor(b * samplesPerBucket);
    const endSample = Math.min(Math.floor((b + 1) * samplesPerBucket), audioBuffer.length);
    let bucketMin = 0;
    let bucketMax = 0;
    for (const data of channels) {
      for (let s = startSample; s < endSample; s++) {
        const v = data[s];
        if (v < bucketMin) bucketMin = v;
        if (v > bucketMax) bucketMax = v;
      }
    }
    min[b] = bucketMin;
    max[b] = bucketMax;
  }

  return { bucketsPerSecond, count, min, max };
}

// Reduces peaks over [tStart, tEnd) to a single {min, max} pair.
// Values are raw PCM amplitude in [-1, 1] — never normalized per-file,
// so loudness is visually comparable across different audio files.
//
// Takes an optional `out` object to write into instead of allocating a
// fresh one — the waveform view calls this once per pixel column, every
// redraw, so a caller drawing a whole strip can pass the same reused
// object across the entire loop instead of generating one throwaway
// object per column per frame.
export function getMinMaxInRange(peaks, tStart, tEnd, out = { min: 0, max: 0 }) {
  if (peaks.count === 0) {
    out.min = 0;
    out.max = 0;
    return out;
  }
  const bStart = Math.max(0, Math.floor(tStart * peaks.bucketsPerSecond));
  const bEnd = Math.min(peaks.count - 1, Math.floor(tEnd * peaks.bucketsPerSecond));
  if (bEnd < bStart) {
    const b = Math.min(peaks.count - 1, Math.max(0, bStart));
    out.min = peaks.min[b];
    out.max = peaks.max[b];
    return out;
  }
  let mn = peaks.min[bStart];
  let mx = peaks.max[bStart];
  for (let b = bStart + 1; b <= bEnd; b++) {
    if (peaks.min[b] < mn) mn = peaks.min[b];
    if (peaks.max[b] > mx) mx = peaks.max[b];
  }
  out.min = mn;
  out.max = mx;
  return out;
}

// Empty peaks structure ready for incremental filling via
// createLivePeaksWriter() — seeds a from-scratch recording that has no
// prior audio to base a waveform preview on.
export function createEmptyPeaks(bucketsPerSecond = BUCKETS_PER_SECOND) {
  return { bucketsPerSecond, min: new Float32Array(0), max: new Float32Array(0), count: 0 };
}

// A snapshot copy, so a punch-in recording's live preview can start
// from whatever peaks are already on screen without mutating the
// committed ones the rest of the app (and a cancelled recording) still
// relies on.
export function clonePeaks(peaks) {
  return {
    bucketsPerSecond: peaks.bucketsPerSecond,
    min: peaks.min.slice(0, peaks.count),
    max: peaks.max.slice(0, peaks.count),
    count: peaks.count,
  };
}

function ensurePeaksCapacity(peaks, neededCount) {
  if (neededCount <= peaks.min.length) return;
  const newCap = Math.max(peaks.min.length * 2, neededCount, 256);
  const newMin = new Float32Array(newCap);
  const newMax = new Float32Array(newCap);
  newMin.set(peaks.min);
  newMax.set(peaks.max);
  peaks.min = newMin;
  peaks.max = newMax;
}

// Streaming counterpart to computePeaks(): folds newly-captured PCM
// into `peaks` (mutated in place, growing its backing arrays as needed)
// as it arrives during recording, instead of needing the whole buffer
// up front. Returns a write(startSample, samples) function that must be
// called with samples in contiguous, non-decreasing order (one
// recording session's chunks, in arrival order) — it keeps a running
// min/max for whichever bucket is still being filled, committed into
// peaks.min/max on every call so the in-progress bucket updates live
// rather than only once it's finished, which is also what makes a
// bucket split across two chunks come out correct.
export function createLivePeaksWriter(peaks, sampleRate) {
  const samplesPerBucket = sampleRate / peaks.bucketsPerSecond;
  let pendingBucket = -1;
  let pendingMin = 0;
  let pendingMax = 0;

  function commitPending() {
    if (pendingBucket < 0) return;
    ensurePeaksCapacity(peaks, pendingBucket + 1);
    peaks.min[pendingBucket] = pendingMin;
    peaks.max[pendingBucket] = pendingMax;
    if (pendingBucket + 1 > peaks.count) peaks.count = pendingBucket + 1;
  }

  return function write(startSample, samples) {
    for (let i = 0; i < samples.length; i++) {
      const bucket = Math.floor((startSample + i) / samplesPerBucket);
      if (bucket !== pendingBucket) {
        commitPending();
        pendingBucket = bucket;
        pendingMin = 0;
        pendingMax = 0;
      }
      const v = samples[i];
      if (v < pendingMin) pendingMin = v;
      if (v > pendingMax) pendingMax = v;
    }
    commitPending();
  };
}
