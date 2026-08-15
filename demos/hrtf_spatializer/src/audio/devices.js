// Device labels are hidden by browsers until some mic permission has been
// granted (fingerprinting mitigation) — so the input/output dropdowns
// start out with generic "Microphone 1"-style names, and get relabeled
// once permission is granted (e.g. the first time the user hits record).
export async function listAudioDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    inputs: devices.filter((d) => d.kind === "audioinput"),
    outputs: devices.filter((d) => d.kind === "audiooutput"),
  };
}

// Requests mic access purely to unlock device labels, then immediately
// releases it. Safe to call speculatively (e.g. when a device dropdown is
// first opened) without actually starting a recording.
export async function requestMicrophonePermission() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of stream.getTracks()) track.stop();
}

// Two different, unrelated APIs can both route audio to a chosen output
// device: AudioContext.setSinkId (Chrome/Edge only, so far) and the
// older HTMLMediaElement.setSinkId (Chrome, Firefox 116+, Safari 18.4+).
// engine.js tries the former first and falls back to bridging through
// the latter — see AudioEngine.setOutputDevice(). This just needs to
// know whether *either* is available, to decide whether to show the
// control at all.
export function supportsOutputDeviceSelection() {
  return (
    (typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype) ||
    (typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype)
  );
}
