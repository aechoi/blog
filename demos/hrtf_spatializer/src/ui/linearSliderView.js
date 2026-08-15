import { syncCanvasSize } from "./timeMapping.js";

function wrapValue(v, min, max) {
  const range = max - min;
  return min + (((v - min) % range) + range) % range;
}

function clampValue(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

const TRACK_COLOR = "#ddd";
const REFERENCE_LINE_COLOR = "#ccc";
const BG_COLOR = "#fafafa";
const HOTKEY_LABEL_COLOR = "#999";

// A single-handle linear slider (vertical or horizontal) bound to one
// az/el/r channel at the current playhead. Reads the other two channels
// from the store so it only ever overwrites its own.
//
// Non-wrap channels (elevation, radius) use the cursor's absolute
// position directly — standard slider feel, no dead zone. Wrap channels
// (azimuth) instead accumulate relative movement without ever clamping
// it, so dragging past the track's end keeps going and wraps around —
// the same technique the azimuth time-series strip uses.

export function createLinearSliderView(
  canvas,
  {
    store,
    orientation,
    channel,
    min,
    max,
    wrap = false,
    color = "#3b6ea5",
    referenceValue = null,
    latch,
    negativeLabel = null, // hotkey hint shown at the min end (left/bottom)
    positiveLabel = null, // hotkey hint shown at the max end (right/top)
  }
) {
  const ctx = canvas.getContext("2d");
  let dragging = false;
  let rawAccum = 0; // only continuously meaningful while wrap-dragging
  let lastPos = 0;
  let targetValue = 0;
  let lastWrittenTime = null; // playhead at the last write this drag, for gap-filling

  function valueToFrac(value) {
    return (clampValue(value, min, max) - min) / (max - min);
  }

  function handlePosition(value, width, height) {
    const frac = valueToFrac(value);
    return orientation === "vertical"
      ? { x: width / 2, y: height - frac * height }
      : { x: frac * width, y: height / 2 };
  }

  function currentValue() {
    return store.state.path ? store.getPositionAt(store.state.playhead)[channel] : (min + max) / 2;
  }

  function draw() {
    const { width, height, dpr } = syncCanvasSize(canvas);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = TRACK_COLOR;
    ctx.lineWidth = 4;
    ctx.beginPath();
    if (orientation === "vertical") {
      ctx.moveTo(width / 2, 8);
      ctx.lineTo(width / 2, height - 8);
    } else {
      ctx.moveTo(8, height / 2);
      ctx.lineTo(width - 8, height / 2);
    }
    ctx.stroke();
    ctx.lineWidth = 1;

    if (referenceValue !== null) {
      const p = handlePosition(referenceValue, width, height);
      ctx.strokeStyle = REFERENCE_LINE_COLOR;
      ctx.beginPath();
      if (orientation === "vertical") {
        ctx.moveTo(0, p.y);
        ctx.lineTo(width, p.y);
      } else {
        ctx.moveTo(p.x, 0);
        ctx.lineTo(p.x, height);
      }
      ctx.stroke();
    }

    // Hotkey hints, offset off the handle's own axis of travel (so they
    // never sit under it regardless of the current value) rather than
    // near the track ends, where the handle can actually reach.
    if (negativeLabel || positiveLabel) {
      ctx.font = "bold 11px system-ui, sans-serif";
      ctx.fillStyle = HOTKEY_LABEL_COLOR;
      if (orientation === "vertical") {
        ctx.textAlign = "left";
        if (positiveLabel) {
          ctx.textBaseline = "top";
          ctx.fillText(positiveLabel, 4, 4);
        }
        if (negativeLabel) {
          ctx.textBaseline = "bottom";
          ctx.fillText(negativeLabel, 4, height - 4);
        }
      } else {
        ctx.textBaseline = "top";
        if (negativeLabel) {
          ctx.textAlign = "left";
          ctx.fillText(negativeLabel, 4, 4);
        }
        if (positiveLabel) {
          ctx.textAlign = "right";
          ctx.fillText(positiveLabel, width - 4, 4);
        }
      }
    }

    const p = handlePosition(currentValue(), width, height);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // While dragging, re-apply the current target on every playhead tick —
  // not just on mouse movement. During playback the playhead advances
  // every animation frame regardless of whether the mouse has moved; if
  // writes only happened on pointermove, the display would flicker
  // between the dragged value (right after a mouse event) and the
  // default/unwritten sample the instant playhead ticks past it before
  // the next mouse event arrives.
  store.subscribe((event) => {
    if (event.type === "playhead-changed" && dragging) {
      writeValue(targetValue);
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

  // Paints from the last write up through the current playhead, not
  // just a single point at the playhead — a plain per-tick point write
  // relies on ticks landing close enough together to look continuous,
  // which normally holds (the path is ~60Hz, same as animation frames)
  // but a dropped frame or a lag spike can let the playhead jump several
  // path samples in one tick, leaving whatever skipped indices untouched
  // (old automation, or the default) instead of the value being dragged
  // right then — the intermittent "jump" this fixes.
  function writeValue(value) {
    targetValue = value;
    const t = store.state.playhead;
    const from = lastWrittenTime ?? t;
    store.paintRange(channel, from, t, () => value);
    lastWrittenTime = t;
  }

  function posAlong(e, rect) {
    return orientation === "vertical" ? e.clientY - rect.top : e.clientX - rect.left;
  }

  function absoluteValue(pos, size) {
    const frac = orientation === "vertical" ? 1 - pos / size : pos / size;
    return clampValue(min + frac * (max - min), min, max);
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (!store.state.path || e.button !== 0) return;
    dragging = true;
    lastWrittenTime = null; // fresh drag session — nothing to gap-fill from yet
    latch?.notifyEditStart(channel);
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const { width, height } = syncCanvasSize(canvas);
    const size = orientation === "vertical" ? height : width;
    const pos = posAlong(e, rect);
    if (wrap) {
      rawAccum = absoluteValue(pos, size);
      lastPos = pos;
      writeValue(wrapValue(rawAccum, min, max));
    } else {
      writeValue(absoluteValue(pos, size));
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    const { width, height } = syncCanvasSize(canvas);
    const size = orientation === "vertical" ? height : width;
    const pos = posAlong(e, rect);
    if (wrap) {
      const delta = pos - lastPos;
      lastPos = pos;
      const deltaValue = orientation === "vertical" ? -(delta / size) * (max - min) : (delta / size) * (max - min);
      rawAccum += deltaValue;
      writeValue(wrapValue(rawAccum, min, max));
    } else {
      writeValue(absoluteValue(pos, size));
    }
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    lastWrittenTime = null;
    latch?.notifyEdited(channel, targetValue);
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // pointer capture may already be gone; nothing to clean up
    }
  }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // Safety net: if the window loses focus mid-drag (alt-tab, devtools,
  // an OS dialog), the pointer's actual release can happen with no
  // browser window listening at all, so no pointerup ever arrives and
  // `dragging` stays stuck true — silently re-applying a stale target
  // on every future playhead tick.
  window.addEventListener("blur", () => {
    if (!dragging) return;
    dragging = false;
    lastWrittenTime = null;
    latch?.notifyEdited(channel, targetValue);
  });

  new ResizeObserver(draw).observe(canvas);
  draw();
}
