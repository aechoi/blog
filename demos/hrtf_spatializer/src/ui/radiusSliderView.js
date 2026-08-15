import { syncCanvasSize } from "./timeMapping.js";

function clampValue(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

const TRACK_COLOR = "#ddd";
const BG_COLOR = "#fafafa";
const HOTKEY_LABEL_COLOR = "#999";
const INSET = 8;

// Radius slider on a diagonal track: min at the top-left corner,
// max at the bottom-right. Always uses the cursor's absolute
// projection onto the diagonal — radius doesn't wrap, so there's no
// need for the relative-delta accumulator the azimuth controls use.
export function createRadiusSliderView(
  canvas,
  { store, channel = "r", min, max, color = "#c67c1e", latch, negativeLabel = null, positiveLabel = null }
) {
  const ctx = canvas.getContext("2d");
  let dragging = false;
  let targetValue = min;
  let lastWrittenTime = null; // playhead at the last write this drag, for gap-filling

  function valueToFrac(value) {
    return (clampValue(value, min, max) - min) / (max - min);
  }

  function currentValue() {
    return store.state.path ? store.getPositionAt(store.state.playhead)[channel] : max;
  }

  function draw() {
    const { width, height, dpr } = syncCanvasSize(canvas);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = TRACK_COLOR;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(INSET, INSET);
    ctx.lineTo(width - INSET, height - INSET);
    ctx.stroke();
    ctx.lineWidth = 1;

    // Hotkey hints at top/bottom-center — off the diagonal track (which
    // runs corner to corner, x === y throughout), so they're never under
    // the handle regardless of the current value.
    if (negativeLabel || positiveLabel) {
      ctx.font = "bold 11px system-ui, sans-serif";
      ctx.fillStyle = HOTKEY_LABEL_COLOR;
      ctx.textAlign = "center";
      if (negativeLabel) {
        ctx.textBaseline = "top";
        ctx.fillText(negativeLabel, width / 2, 4);
      }
      if (positiveLabel) {
        ctx.textBaseline = "bottom";
        ctx.fillText(positiveLabel, width / 2, height - 4);
      }
    }

    const frac = valueToFrac(currentValue());
    const hx = INSET + frac * (width - 2 * INSET);
    const hy = INSET + frac * (height - 2 * INSET);
    ctx.beginPath();
    ctx.arc(hx, hy, 8, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // Re-apply the current target on every playhead tick while dragging —
  // see the identical comment in linearSliderView.js for why (otherwise
  // the display flickers between the dragged value and the unwritten
  // default sample as the playhead advances during playback).
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

  // Paints from the last write through the current playhead rather than
  // just a single point — see the identical comment in
  // linearSliderView.js: a plain per-tick point write leaves skipped
  // path samples untouched whenever a tick lands late (a lag spike),
  // which shows up as an intermittent jump back to old automation.
  function writeValue(value) {
    targetValue = value;
    const t = store.state.playhead;
    const from = lastWrittenTime ?? t;
    store.paintRange(channel, from, t, () => value);
    lastWrittenTime = t;
  }

  function valueFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const { width, height } = syncCanvasSize(canvas);
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // project the cursor onto the diagonal from (0,0) to (width,height)
    const t = clampValue((x * width + y * height) / (width * width + height * height), 0, 1);
    return min + t * (max - min);
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (!store.state.path || e.button !== 0) return;
    dragging = true;
    lastWrittenTime = null; // fresh drag session — nothing to gap-fill from yet
    latch?.notifyEditStart(channel);
    canvas.setPointerCapture(e.pointerId);
    writeValue(valueFromEvent(e));
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    writeValue(valueFromEvent(e));
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
