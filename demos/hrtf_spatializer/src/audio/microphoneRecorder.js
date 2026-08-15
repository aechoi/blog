// Punch-in microphone recording: overwrites the audio buffer starting at
// the current playhead, growing the buffer if recording runs past the old
// end (or starts with no audio loaded at all), and leaves everything
// before the start point and after wherever you stop untouched — same
// idea as punch recording in a DAW.
//
// The playhead, position (az/el/r) automation, and the waveform preview
// all grow live as recording happens — driven by store.beginLiveRecording
// / growRecordingDuration / writeLivePeaks — rather than only becoming
// visible once recording stops. See state/store.js for how that's
// tracked; this module's job is just to feed it captured samples.
//
// Captures raw PCM via a dedicated AudioWorkletProcessor rather than
// MediaRecorder, on purpose: MediaRecorder produces encoded (compressed)
// output that has to be decoded back before it can be spliced in, which
// both loses precision and makes the exact sample position of "where
// recording started" fuzzier than we want for a punch-in. Raw capture is
// sample-accurate by construction.
//
// The recorded segment always ends up mono, and if the existing buffer
// was stereo, that gets folded down to its first channel when splicing —
// consistent with the rest of the app, where the HRTF convolver only ever
// reads channel 0 of the source anyway (see hrtfWorkletProcessor.js).
//
// Monitoring (hearing your own live mic input, HRTF-processed, while you
// record) is optional and handled by connecting the same mic source
// node used for capture into engine.js's HRTF chain too, via
// connectLiveInput()/disconnectLiveInput() — capture itself is
// unaffected either way, since that's a separate connection off the
// same source node.
export function createMicrophoneRecorder({ store, engine }) {
  let stream = null;
  let sourceNode = null;
  let recorderNode = null;
  let chunks = [];
  let recording = false;
  let monitoring = false;
  let recordStartPlayhead = 0;
  let recordStartSample = 0;
  let samplesSoFar = 0;
  let sessionSampleRate = 0;
  let hadAudioBefore = false;

  // writeLivePeaks()/growRecordingDuration() only feed things that are
  // ever displayed at animation-frame rate (the waveform preview, the
  // recording's known duration), so there's no benefit to running them
  // on every single ~2.7ms AudioWorkletProcessor message (~375/sec at
  // 48kHz) — that's far more often than anything could actually be
  // seen, and it's extra main-thread work competing with position
  // automation and redraws for the same thread right when both matter
  // most. Chunks still get pushed into `chunks` immediately, every
  // time — nothing about capture itself is batched, only this
  // display-only bookkeeping, flushed once per animation frame instead.
  let pendingPeakChunks = [];
  let samplesFedToPeaks = 0;
  let flushScheduled = false;

  function flushPendingUpdates() {
    flushScheduled = false;
    if (!recording) return;
    const batch = pendingPeakChunks;
    pendingPeakChunks = [];
    for (const chunk of batch) {
      store.writeLivePeaks(recordStartSample + samplesFedToPeaks, chunk, sessionSampleRate);
      samplesFedToPeaks += chunk.length;
    }
    store.growRecordingDuration(recordStartPlayhead + samplesSoFar / sessionSampleRate);
  }

  async function start(deviceId, monitor = true) {
    if (recording) return;
    const ctx = engine.ensureContext();
    if (ctx.state === "suspended") await ctx.resume();

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    await ctx.audioWorklet.addModule(new URL("./recorderWorkletProcessor.js", import.meta.url));
    sourceNode = ctx.createMediaStreamSource(stream);
    recorderNode = new AudioWorkletNode(ctx, "recorder-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
    });

    hadAudioBefore = !!store.state.audio;
    const fileName = hadAudioBefore ? store.state.audio.fileName : "microphone recording.wav";
    // Seeds audio/path if there was none yet, so there's a playhead and
    // automation path to advance through even on a from-scratch
    // recording — and always resets the live waveform preview for this
    // session (a clone of whatever's currently shown, so a punch-in
    // starts its preview from the existing waveform rather than blank).
    store.beginLiveRecording(fileName);

    sessionSampleRate = ctx.sampleRate;
    recordStartPlayhead = store.state.playhead;
    recordStartSample = Math.round(recordStartPlayhead * sessionSampleRate);
    samplesSoFar = 0;
    samplesFedToPeaks = 0;
    pendingPeakChunks = [];
    flushScheduled = false;

    chunks = [];
    recorderNode.port.onmessage = (event) => {
      const chunk = event.data;
      chunks.push(chunk);
      samplesSoFar += chunk.length;
      pendingPeakChunks.push(chunk);
      if (!flushScheduled) {
        flushScheduled = true;
        requestAnimationFrame(flushPendingUpdates);
      }
    };
    sourceNode.connect(recorderNode);

    recording = true;
    // Advances the playhead the same way normal playback does, so
    // position automation stays live while punching in — including past
    // the previously-known end, or from a blank slate on a from-scratch
    // recording, both made possible by beginLiveRecording()/
    // growRecordingDuration() above.
    engine.beginPlayheadAdvance();
    if (monitor) {
      monitoring = true;
      await engine.connectLiveInput(sourceNode);
    }
  }

  // Lets the monitor be flipped on/off mid-recording (e.g. a live toggle
  // button), not just decided once at start(). A no-op while not
  // recording — the `monitor` argument to start() covers that case.
  function setMonitoring(enabled) {
    if (!recording || enabled === monitoring) return;
    monitoring = enabled;
    if (enabled) engine.connectLiveInput(sourceNode);
    else engine.disconnectLiveInput(sourceNode);
  }

  async function stop() {
    if (!recording) return;
    recording = false;
    engine.endPlayheadAdvance();
    if (monitoring) {
      monitoring = false;
      engine.disconnectLiveInput(sourceNode);
    }

    // The worklet batches samples before posting them (see
    // recorderWorkletProcessor.js) — whatever's been captured since the
    // last full batch is still sitting there, unsent, so ask for it
    // explicitly before tearing the graph down. The worklet always
    // answers exactly once (even with a zero-length array if nothing
    // was pending), so this is a deterministic wait, not a guess.
    if (recorderNode) {
      await new Promise((resolve) => {
        recorderNode.port.onmessage = (event) => {
          const chunk = event.data;
          if (chunk.length > 0) chunks.push(chunk);
          resolve();
        };
        recorderNode.port.postMessage("flush");
      });
    }

    sourceNode?.disconnect();
    recorderNode?.disconnect();
    if (recorderNode) recorderNode.port.onmessage = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    sourceNode = null;
    recorderNode = null;

    const recordedSampleCount = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (recordedSampleCount === 0) {
      chunks = [];
      store.cancelLiveRecording(hadAudioBefore);
      return;
    }

    const ctx = engine.context;
    const sampleRate = sessionSampleRate;
    const recordEndSample = recordStartSample + recordedSampleCount;

    const existing = hadAudioBefore ? store.state.audio.buffer : null;
    const finalLength = Math.max(existing ? existing.length : 0, recordEndSample);

    const newBuffer = ctx.createBuffer(1, finalLength, sampleRate);
    const out = newBuffer.getChannelData(0);

    if (existing) {
      const existingData = existing.getChannelData(0);
      out.set(existingData.subarray(0, Math.min(existingData.length, finalLength)));
    }

    let writePos = recordStartSample;
    for (const chunk of chunks) {
      out.set(chunk, writePos);
      writePos += chunk.length;
    }
    chunks = [];

    const fileName = store.state.audio.fileName;
    store.replaceAudioKeepingPath(newBuffer, fileName);
  }

  return {
    start,
    stop,
    setMonitoring,
    get isRecording() {
      return recording;
    },
    get isMonitoring() {
      return monitoring;
    },
  };
}
