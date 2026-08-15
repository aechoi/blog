import { syncCanvasSize } from "./timeMapping.js";

const GRID_COLOR = "#ddd";
const HORIZON_COLOR = "#bbb";
const FRONT_SPOKE_COLOR = "#c9a6e8";
const CURSOR_COLOR = "#e8562c";
const BG_COLOR = "#fafafa";

// Elevation 90° (straight overhead) is the plot's center; -90° (straight
// down) is the outer rim, so distance-from-center maps linearly across
// the full elevation range. Azimuth 0° points to screen-up ("North");
// positive azimuth goes clockwise (0=front, 90=right, ±180=back, -90=left),
// matching the az channel strip/slider convention.
const EL_RINGS = [60, 30, 0, -30, -60];
const AZ_SPOKES_DEG = [0, 45, 90, 135, 180, -135, -90, -45];

export function createPolarView(canvas, { store, latch }) {
  const ctx = canvas.getContext("2d");
  let dragging = false;
  let targetAz = 0;
  let targetEl = 0;
  let lastWrittenTime = null; // playhead at the last write this drag, for gap-filling

  function geometry(width, height) {
    return { cx: width / 2, cy: height / 2, radius: Math.min(width, height) / 2 - 10 };
  }

  function elToRadiusFrac(el) {
    return (90 - el) / 180;
  }

  function azElToPoint(az, el, cx, cy, radius) {
    const azRad = (az * Math.PI) / 180;
    const r = elToRadiusFrac(el) * radius;
    return { x: cx + r * Math.sin(azRad), y: cy - r * Math.cos(azRad) };
  }

  function pointToAzEl(x, y, cx, cy, radius) {
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.min(Math.sqrt(dx * dx + dy * dy), radius);
    const az = (Math.atan2(dx, -dy) * 180) / Math.PI;
    const el = 90 - (dist / radius) * 180;
    return { az, el };
  }

  function draw() {
    const { width, height, dpr } = syncCanvasSize(canvas);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, width, height);

    const { cx, cy, radius } = geometry(width, height);

    for (const el of EL_RINGS) {
      ctx.strokeStyle = el === 0 ? HORIZON_COLOR : GRID_COLOR;
      ctx.lineWidth = el === 0 ? 2 : 1;
      ctx.beginPath();
      ctx.arc(cx, cy, elToRadiusFrac(el) * radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = GRID_COLOR;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    for (const az of AZ_SPOKES_DEG) {
      const p = azElToPoint(az, -90, cx, cy, radius);
      ctx.strokeStyle = az === 0 ? FRONT_SPOKE_COLOR : GRID_COLOR;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }

    ctx.fillStyle = GRID_COLOR;
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fill();

    if (store.state.path) {
      const pos = store.getPositionAt(store.state.playhead);
      const p = azElToPoint(pos.az, pos.el, cx, cy, radius);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = CURSOR_COLOR;
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  // While dragging, re-apply the current target on every playhead tick —
  // not just on mouse movement. During playback the playhead advances
  // every animation frame regardless of whether the mouse has moved; if
  // writes only happened on pointermove, the display would flicker
  // between the dragged value (right after a mouse event) and the
  // default/unwritten sample the instant playhead ticks past it before
  // the next mouse event arrives.
  //
  // Paints from the last write through the current playhead (for both
  // az and el) rather than just a single point — a plain per-tick point
  // write leaves skipped path samples untouched whenever a tick lands
  // late (a lag spike), which shows up as an intermittent jump back to
  // old automation.
  function applyTarget() {
    const t = store.state.playhead;
    const from = lastWrittenTime ?? t;
    store.paintRange("az", from, t, () => targetAz);
    store.paintRange("el", from, t, () => targetEl);
    lastWrittenTime = t;
  }

  store.subscribe((event) => {
    if (event.type === "playhead-changed" && dragging) {
      applyTarget();
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

  function setTargetFromPoint(x, y) {
    const { width, height } = syncCanvasSize(canvas);
    const { cx, cy, radius } = geometry(width, height);
    const { az, el } = pointToAzEl(x, y, cx, cy, radius);
    targetAz = az;
    targetEl = el;
    applyTarget();
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (!store.state.path || e.button !== 0) return;
    dragging = true;
    lastWrittenTime = null; // fresh drag session — nothing to gap-fill from yet
    latch?.notifyEditStart("az");
    latch?.notifyEditStart("el");
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    setTargetFromPoint(e.clientX - rect.left, e.clientY - rect.top);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    setTargetFromPoint(e.clientX - rect.left, e.clientY - rect.top);
  });

  // In latch mode, releasing hands the channel off to the latch
  // controller (which holds it at this last value going forward); in
  // touch mode this is a no-op and release behaves as it always has.
  function finishEdit() {
    latch?.notifyEdited("az", targetAz);
    latch?.notifyEdited("el", targetEl);
  }

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    lastWrittenTime = null;
    finishEdit();
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // pointer capture may already be gone; nothing to clean up
    }
  }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // Safety net: if the window loses focus mid-drag (alt-tab, devtools,
  // an OS dialog) the pointer's actual release can happen with no
  // browser window listening at all, so no pointerup ever arrives.
  // Without this, `dragging` stays stuck true forever, and this view
  // keeps re-applying its last target on every future playhead tick —
  // silently overwriting whatever the user does next, with no visual
  // sign anything is wrong until the numbers stop matching what's on
  // screen elsewhere.
  window.addEventListener("blur", () => {
    if (!dragging) return;
    dragging = false;
    lastWrittenTime = null;
    finishEdit();
  });

  new ResizeObserver(draw).observe(canvas);
  draw();
}
