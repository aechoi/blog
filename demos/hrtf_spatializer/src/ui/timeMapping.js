// Shared pixel<->time mapping for every strip that scrolls under a
// fixed center "now" marker (waveform, az/el/r channel strips, and
// anything added later). Center of the view is always the playhead.
export function pixelsPerSecond(width, timeAxis) {
  return width / timeAxis.visibleDuration;
}

export function xToTime(x, width, playhead, timeAxis) {
  const pps = pixelsPerSecond(width, timeAxis);
  return playhead + (x - width / 2) / pps;
}

export function timeToX(t, width, playhead, timeAxis) {
  const pps = pixelsPerSecond(width, timeAxis);
  return width / 2 + (t - playhead) * pps;
}

// Resizes a canvas's backing store to match its CSS size at the
// current devicePixelRatio, and returns the CSS-pixel dimensions to
// draw with (after ctx.setTransform(dpr, 0, 0, dpr, 0, 0)).
export function syncCanvasSize(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width: canvas.width / dpr, height: canvas.height / dpr, dpr };
}
