import { syncCanvasSize, xToTime } from "./timeMapping.js";

const MARKER_COLOR = "#e8562c";
const REFERENCE_LINE_COLOR = "#ddd";
const BG_COLOR = "#fafafa";

function wrapValue(v, min, max) {
  const range = max - min;
  return min + (((v - min) % range) + range) % range;
}

function clampValue(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// Renders one az/el/r channel as a scrolling line synced to the same
// time axis/marker as the waveform.
//
// - Left-click-drag freehand-draws values into PathStore for this
//   channel, via the same paintRange primitive the plan calls for.
// - Middle-click-drag scrubs time instead (same feel as dragging the
//   waveform), so you don't have to go back to the waveform to scrub.
//
// `min`/`max` set the vertical axis (top = max, bottom = min, so "up"
// reads as "more" for every channel — including elevation, where that
// also happens to match physical up/down).
// `wrap`, for circular channels like azimuth, does two things: dragging
// past the top/bottom edge keeps going and wraps around (modulo the
// track height) instead of clamping, and the drawn line breaks instead
// of connecting when two samples land on opposite sides of the wrap —
// so a real wrap from +179° to -179° doesn't render as a line straight
// across the strip.
export function createChannelStripView(
  canvas,
  { store, timeAxis, seek, channel, min, max, referenceValue = null, wrap = false, color = "#3b6ea5" }
) {
  const ctx = canvas.getContext("2d");
  const wrapThreshold = wrap ? (max - min) / 2 : null;

  let mode = null; // "draw" | "scrub"
  let prevTime = 0;
  let rawAccum = 0; // unwrapped running value while drawing; only wrapped/clamped on output
  let lastClientX = 0;
  let lastClientY = 0;

  function valueToY(value, height) {
    const clamped = clampValue(value, min, max);
    return height - ((clamped - min) / (max - min)) * height;
  }

  function yToValueClamped(y, height) {
    const frac = 1 - y / height;
    return clampValue(min + frac * (max - min), min, max);
  }

  function outputValue(rawValue) {
    return wrap ? wrapValue(rawValue, min, max) : clampValue(rawValue, min, max);
  }

  function draw() {
    const { width, height, dpr } = syncCanvasSize(canvas);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, width, height);

    if (referenceValue !== null) {
      ctx.strokeStyle = REFERENCE_LINE_COLOR;
      ctx.beginPath();
      const y = valueToY(referenceValue, height);
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const { path, audio, playhead } = store.state;
    if (path && audio) {
      const pixelsPerSecond = width / timeAxis.visibleDuration;
      const centerX = width / 2;

      ctx.strokeStyle = color;
      ctx.beginPath();
      let started = false;
      let prevVal = null;
      for (let x = 0; x < width; x++) {
        const t = playhead + (x - centerX) / pixelsPerSecond;
        if (t < 0 || t > audio.duration) {
          started = false;
          prevVal = null;
          continue;
        }
        const value = store.getChannelValueAt(t, channel);
        const y = valueToY(value, height);
        const wrapped =
          wrapThreshold != null && prevVal != null && Math.abs(value - prevVal) > wrapThreshold;
        if (!started || wrapped) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
        prevVal = value;
      }
      ctx.stroke();
    }

    ctx.strokeStyle = MARKER_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(width / 2, 0);
    ctx.lineTo(width / 2, height);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  store.subscribe((event) => {
    if (event.type === "playhead-changed" && mode === "draw") {
      // During playback the playhead advances every animation frame,
      // independent of whether the mouse itself has moved. Without this,
      // a stationary drag falls behind: pointermove has already stopped
      // firing new writes, so getPositionAt(playhead) reads unwritten
      // (default) samples the instant playhead ticks past the last
      // written one, then jumps back to the drawn value on the next
      // pointermove — a rapid flicker between the two. Holding the
      // current value forward on every tick closes that gap.
      //
      // Critically, "forward" means the time under the cursor's last
      // known screen position — NOT the playhead itself. The strip
      // scrolls under a stationary cursor, so even with the mouse not
      // moving, the time at that screen position keeps advancing as
      // the marker moves past it. Using the playhead directly here
      // would yank prevTime to center on every tick regardless of
      // where the cursor actually is, so the next real pointermove
      // would interpolate across a huge, mostly-flat span from center
      // to the cursor instead of continuing the stroke smoothly —
      // exactly the choppy "everything between the cursor and center
      // becomes one value" symptom this replaced.
      const rect = canvas.getBoundingClientRect();
      const { width } = syncCanvasSize(canvas);
      const t = xToTime(lastClientX - rect.left, width, store.state.playhead, timeAxis);
      if (t !== prevTime) {
        const value = outputValue(rawAccum);
        store.paintRange(channel, prevTime, t, () => value);
        prevTime = t;
      }
    }

    if (
      event.type === "audio-loaded" ||
      event.type === "playhead-changed" ||
      event.type === "play-state-changed" ||
      event.type === "path-changed"
    ) {
      draw();
    }
  });
  timeAxis.subscribe(draw);

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      timeAxis.zoomBy(Math.pow(1.0015, e.deltaY));
    },
    { passive: false }
  );

  canvas.addEventListener("pointerdown", (e) => {
    if (!store.state.path) return;

    if (e.button === 1) {
      e.preventDefault(); // suppress the browser's middle-click autoscroll
      mode = "scrub";
      lastClientX = e.clientX;
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (e.button !== 0) return; // ignore right-click etc.

    mode = "draw";
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const { width, height } = syncCanvasSize(canvas);
    const t = xToTime(e.clientX - rect.left, width, store.state.playhead, timeAxis);
    rawAccum = yToValueClamped(e.clientY - rect.top, height);
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    store.paintRange(channel, t, t, () => outputValue(rawAccum));
    prevTime = t;
  });

  canvas.addEventListener("pointermove", (e) => {
    if (mode === "scrub") {
      const { width } = syncCanvasSize(canvas);
      const pixelsPerSecond = width / timeAxis.visibleDuration;
      const deltaX = e.clientX - lastClientX;
      lastClientX = e.clientX;
      seek(store.state.playhead - deltaX / pixelsPerSecond);
      return;
    }

    if (mode !== "draw") return;
    const rect = canvas.getBoundingClientRect();
    const { width, height } = syncCanvasSize(canvas);
    const t = xToTime(e.clientX - rect.left, width, store.state.playhead, timeAxis);
    lastClientX = e.clientX;

    // Wrap-enabled channels are driven by relative vertical movement,
    // accumulated without ever clamping the running total — only
    // wrapped when producing an output sample. That's what lets the
    // channel keep spinning past the strip's own top/bottom edge as
    // long as the drag continues. Non-wrap channels use the cursor's
    // absolute position directly instead: clamping the running total
    // on every move (rather than letting it drift while off-strip and
    // only reconciling later) avoids a dead zone where the value
    // ignores the first bit of motion after reversing direction.
    const rawStart = rawAccum;
    if (wrap) {
      const deltaY = e.clientY - lastClientY;
      rawAccum = rawAccum - (deltaY / height) * (max - min);
    } else {
      rawAccum = yToValueClamped(e.clientY - rect.top, height);
    }
    lastClientY = e.clientY;

    const t0 = prevTime;
    store.paintRange(channel, t0, t, (tt) => {
      if (t === t0) return outputValue(rawAccum);
      const frac = (tt - t0) / (t - t0);
      return outputValue(rawStart + (rawAccum - rawStart) * frac);
    });
    prevTime = t;
  });

  function endInteraction(e) {
    if (!mode) return;
    mode = null;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // pointer capture may already be gone; nothing to clean up
    }
  }
  canvas.addEventListener("pointerup", endInteraction);
  canvas.addEventListener("pointercancel", endInteraction);

  // Safety net: if the window loses focus mid-drag (alt-tab, devtools,
  // an OS dialog), the pointer's actual release can happen with no
  // browser window listening at all, so no pointerup ever arrives and
  // `mode` stays stuck at "draw" — silently painting a stale value
  // forward on every future playhead tick.
  window.addEventListener("blur", () => {
    mode = null;
  });

  new ResizeObserver(draw).observe(canvas);
  draw();
}
