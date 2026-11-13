import { computePeaks, createEmptyPeaks, clonePeaks, createLivePeaksWriter } from "../audio/waveform.js";

const DEFAULT_PATH_RATE = 60; // samples per second
const DEFAULT_AZ = 0;
const DEFAULT_EL = 0;
const DEFAULT_R = 5;
const DEFAULT_CHANNEL_VALUE = { az: DEFAULT_AZ, el: DEFAULT_EL, r: DEFAULT_R };

function timeToIndex(t, rate, length) {
  const i = Math.round(t * rate);
  return Math.min(Math.max(i, 0), length - 1);
}

// Number of path samples needed to cover [0, duration]. Must guarantee
// timeToIndex(duration, rate, length) never gets clamped — i.e. every
// t in [0, duration] rounds to an index < length. Math.ceil(duration *
// rate) looks right but isn't: when duration*rate's fractional part is
// >= 0.5, Math.round(duration*rate) equals Math.ceil(duration*rate),
// which is one past the last valid index. That only bites right at the
// upper boundary (t === duration exactly) — rare during ordinary
// playback, but the playhead sits pinned there almost continuously
// while recording (engine.startLoop() clamps to duration every tick),
// so the resulting off-by-one silently ate one path sample on nearly
// every tick and produced an intermittent az/el/r "gap" during
// recording. +1 guarantees headroom regardless of where the fractional
// part falls.
function pathLengthFor(duration, rate) {
  return Math.max(1, Math.round(duration * rate) + 1);
}

export class PathStore {
  constructor() {
    this.state = {
      audio: null, // { buffer, fileName, duration }
      path: null, // { rate, length, az, el, r }
      peaks: null, // waveform display data for the committed buffer, see audio/waveform.js
      livePeaks: null, // incrementally-built preview while recording; null when not recording
      playhead: 0,
      isPlaying: false,
    };
    this.listeners = new Set();
    this._livePeaksWriter = null;
    this._emitting = false;
    this._pendingEvent = null;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Re-entrancy-coalescing: several listeners (latchMode's per-tick hold,
  // polarView/channelStripView while a drag is live) call paintRange() —
  // which itself emits "path-changed" — from inside their own
  // playhead-changed handler, every single animation frame. A naive
  // `for (const l of listeners) l(event)` would recurse into a second
  // full listener pass for each of those (a third, a fourth, one per
  // held/dragged channel), and every listener here is a full canvas/WebGL
  // redraw or an HRIR recompute+postMessage — so a single tick with e.g.
  // all three channels latched was quietly costing 4x the redraw work,
  // every frame, for the entire duration of a recording. Every listener
  // in this app only branches on event.type and then re-reads live
  // store.state (see src/ui/*.js) — none of them use path-changed's
  // start/end payload — so it's safe to collapse any events raised while
  // already mid-dispatch into a single trailing pass instead of one pass
  // per emit() call.
  emit(event) {
    if (this._emitting) {
      this._pendingEvent = event;
      return;
    }
    this._emitting = true;
    try {
      for (const listener of this.listeners) listener(event);
      while (this._pendingEvent) {
        const next = this._pendingEvent;
        this._pendingEvent = null;
        for (const listener of this.listeners) listener(next);
      }
    } finally {
      this._emitting = false;
    }
  }

  loadAudio(buffer, fileName) {
    const duration = buffer.duration;
    const rate = DEFAULT_PATH_RATE;
    const length = pathLengthFor(duration, rate);
    const path = {
      rate,
      length,
      az: new Float32Array(length).fill(DEFAULT_AZ),
      el: new Float32Array(length).fill(DEFAULT_EL),
      r: new Float32Array(length).fill(DEFAULT_R),
    };

    this.state.audio = { buffer, fileName, duration };
    this.state.path = path;
    this.state.peaks = computePeaks(buffer);
    this.state.livePeaks = null;
    this._livePeaksWriter = null;
    this.state.playhead = 0;
    this.state.isPlaying = false;

    this.emit({ type: "audio-loaded", fileName, duration });
    this.emit({ type: "playhead-changed", playhead: 0 });
    this.emit({ type: "path-changed", start: 0, end: duration });
  }

  // Swaps in a new audio buffer WITHOUT resetting playback position or
  // the recorded az/el/r path — unlike loadAudio(), which is for starting
  // a fresh session. This is what punch-in recording uses: the automation
  // you've already built should survive re-recording part of the audio
  // underneath it. If the new buffer is longer (recording extended past
  // the old end), the path grows to cover the new tail, filled with the
  // same defaults loadAudio() uses; if it's the same length or shorter,
  // the existing path is left untouched.
  replaceAudioKeepingPath(buffer, fileName) {
    const duration = buffer.duration;
    const oldPath = this.state.path;
    const rate = oldPath ? oldPath.rate : DEFAULT_PATH_RATE;
    const newLength = pathLengthFor(duration, rate);

    let path;
    if (!oldPath) {
      path = {
        rate,
        length: newLength,
        az: new Float32Array(newLength).fill(DEFAULT_AZ),
        el: new Float32Array(newLength).fill(DEFAULT_EL),
        r: new Float32Array(newLength).fill(DEFAULT_R),
      };
    } else if (newLength > oldPath.length) {
      path = {
        rate,
        length: newLength,
        az: new Float32Array(newLength).fill(DEFAULT_AZ),
        el: new Float32Array(newLength).fill(DEFAULT_EL),
        r: new Float32Array(newLength).fill(DEFAULT_R),
      };
      // oldPath's arrays may be over-allocated beyond oldPath.length
      // (growRecordingDuration grows capacity by doubling) — copy only
      // the logically-valid prefix, both because the rest is meaningless
      // padding and because copying the full backing array could be
      // longer than this new one and overflow it.
      path.az.set(oldPath.az.subarray(0, oldPath.length));
      path.el.set(oldPath.el.subarray(0, oldPath.length));
      path.r.set(oldPath.r.subarray(0, oldPath.length));
    } else {
      path = oldPath;
    }

    this.state.audio = { buffer, fileName, duration };
    this.state.path = path;
    this.state.peaks = computePeaks(buffer);
    this.state.livePeaks = null;
    this._livePeaksWriter = null;
    if (this.state.playhead > duration) this.state.playhead = duration;

    this.emit({ type: "audio-loaded", fileName, duration });
    this.emit({ type: "playhead-changed", playhead: this.state.playhead });
    this.emit({ type: "path-changed", start: 0, end: duration });
  }

  // --- Live microphone recording support ---
  //
  // Recording needs the timeline (audio.duration + path) and the
  // waveform preview (livePeaks) to grow *while it's happening*, not
  // just once at the end — both so position automation has somewhere
  // to write past the previously-known end (or from a blank slate, if
  // there was no audio loaded at all yet), and so the waveform is
  // visible as it's captured. The finalized buffer and a fully
  // authoritative peaks recompute still only happen once, in
  // replaceAudioKeepingPath() when the recording stops.

  beginLiveRecording(fileName) {
    if (!this.state.audio) {
      this.state.audio = { buffer: null, fileName, duration: 0 };
      this.state.path = {
        rate: DEFAULT_PATH_RATE,
        length: 1,
        az: new Float32Array(1).fill(DEFAULT_AZ),
        el: new Float32Array(1).fill(DEFAULT_EL),
        r: new Float32Array(1).fill(DEFAULT_R),
      };
      this.state.playhead = 0;
      this.emit({ type: "audio-loaded", fileName, duration: 0 });
    }
    this.state.livePeaks = this.state.peaks ? clonePeaks(this.state.peaks) : createEmptyPeaks();
    this._livePeaksWriter = null;
  }

  // Rolls back the placeholder state beginLiveRecording() seeded, for a
  // from-scratch recording that produced zero samples (started and
  // immediately stopped, with no prior audio to fall back to) — leaves
  // nothing behind for a session that captured nothing. A punch-in
  // recording that captured nothing has real prior audio to keep as-is,
  // so only the live preview needs clearing.
  cancelLiveRecording(hadAudioBefore) {
    this.state.livePeaks = null;
    this._livePeaksWriter = null;
    if (!hadAudioBefore) {
      this.state.audio = null;
      this.state.path = null;
      this.state.peaks = null;
      this.state.playhead = 0;
      this.emit({ type: "audio-loaded", fileName: null, duration: 0 });
    }
  }

  // Extends audio.duration and, if needed, the path arrays to cover it,
  // as captured samples push the recording past what was previously
  // known. A no-op while punch-in recording is still within the
  // existing duration (the common case) — nothing to grow yet.
  //
  // During active recording this runs roughly once per animation frame
  // (see microphoneRecorder.js), so growing the backing arrays to
  // *exactly* what's needed each time — as this used to do — means
  // reallocating and copying the whole path on nearly every call, and
  // since the path keeps getting longer as recording continues, the
  // total copying work over a recording session grows quadratically
  // with its length. Growing by doubling instead (the same strategy
  // audio/waveform.js's live peaks buffer already uses) amortizes that
  // to O(1) per call: `length` (the logical, valid-index bound
  // everything else reads through) still grows one sample at a time,
  // but the arrays' actual capacity only needs reallocating O(log n)
  // times total, not once per sample.
  growRecordingDuration(duration) {
    if (!this.state.audio || duration <= this.state.audio.duration) return;
    this.state.audio.duration = duration;

    const oldPath = this.state.path;
    const neededLength = pathLengthFor(duration, oldPath.rate);
    if (neededLength <= oldPath.length) return;

    const capacity = oldPath.az.length;
    if (neededLength <= capacity) {
      // Already enough room in the backing arrays — the padding beyond
      // the old logical length is still default-filled from whenever
      // this capacity was allocated, so just extend how much of it
      // counts as valid.
      oldPath.length = neededLength;
      return;
    }

    const newCapacity = Math.max(capacity * 2, neededLength);
    const az = new Float32Array(newCapacity).fill(DEFAULT_AZ);
    const el = new Float32Array(newCapacity).fill(DEFAULT_EL);
    const r = new Float32Array(newCapacity).fill(DEFAULT_R);
    az.set(oldPath.az.subarray(0, oldPath.length));
    el.set(oldPath.el.subarray(0, oldPath.length));
    r.set(oldPath.r.subarray(0, oldPath.length));

    this.state.path = { rate: oldPath.rate, length: neededLength, az, el, r };
  }

  // Folds newly-captured PCM into the live waveform preview.
  // `startSample` is an absolute sample index from the start of the
  // buffer — the same frame the path/playhead use — so this lands in
  // the right place for a punch-in that starts partway through
  // existing audio.
  writeLivePeaks(startSample, samples, sampleRate) {
    if (!this.state.livePeaks) return;
    if (!this._livePeaksWriter) {
      this._livePeaksWriter = createLivePeaksWriter(this.state.livePeaks, sampleRate);
    }
    this._livePeaksWriter(startSample, samples);
  }

  play() {
    if (!this.state.audio || this.state.isPlaying) return;
    this.state.isPlaying = true;
    this.emit({ type: "play-state-changed", isPlaying: true });
  }

  pause() {
    if (!this.state.isPlaying) return;
    this.state.isPlaying = false;
    this.emit({ type: "play-state-changed", isPlaying: false });
  }

  seek(t) {
    if (!this.state.audio) return;
    const clamped = Math.min(Math.max(t, 0), this.state.audio.duration);
    this.state.playhead = clamped;
    this.emit({ type: "playhead-changed", playhead: clamped });
  }

  writePosition(az, el, r, t = this.state.playhead) {
    const { path } = this.state;
    if (!path) return;
    const i = timeToIndex(t, path.rate, path.length);
    path.az[i] = az;
    path.el[i] = el;
    path.r[i] = r;
    this.emit({ type: "path-changed", start: t, end: t });
  }

  paintRange(channel, tStart, tEnd, valueFn) {
    const { path } = this.state;
    if (!path) return;
    const iStart = timeToIndex(Math.min(tStart, tEnd), path.rate, path.length);
    const iEnd = timeToIndex(Math.max(tStart, tEnd), path.rate, path.length);
    const arr = path[channel];
    for (let i = iStart; i <= iEnd; i++) {
      arr[i] = valueFn(i / path.rate);
    }
    this.emit({ type: "path-changed", start: tStart, end: tEnd });
  }

  getPositionAt(t) {
    const { path } = this.state;
    if (!path) return { az: DEFAULT_AZ, el: DEFAULT_EL, r: DEFAULT_R };
    const i = timeToIndex(t, path.rate, path.length);
    return { az: path.az[i], el: path.el[i], r: path.r[i] };
  }

  // Same read as getPositionAt(t)[channel], without allocating a
  // throwaway {az,el,r} object to get there — worth it specifically for
  // hot per-pixel loops (a channel strip reads this once per column,
  // every redraw), where getPositionAt() would otherwise generate one
  // short-lived object per pixel per frame.
  getChannelValueAt(t, channel) {
    const { path } = this.state;
    if (!path) return DEFAULT_CHANNEL_VALUE[channel];
    const i = timeToIndex(t, path.rate, path.length);
    return path[channel][i];
  }
}
