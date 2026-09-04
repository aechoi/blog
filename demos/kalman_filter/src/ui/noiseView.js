import { eigSym } from "../linalg.js";
import {
  COLORS,
  syncCanvasSize,
  createTransform,
  drawGrid,
  drawCovEllipse,
  drawArrow,
  drawPoint,
  drawHandle,
  drawLabel,
  drawMatrix,
} from "./canvas.js";
import { handlePositions, beginHandleDrag, applyHandleDrag } from "./covHandles.js";
import { attachDragger } from "./dragger.js";

// The Q and R side panels. Each is a little noise-space plot, centred on
// the origin, showing the distribution (the ellipse, with the same two
// semi-axis handles as P) together with the REALISATION currently drawn
// from it (the arrow).
//
// The arrow is the other half of the coupling described in store.js:
// this panel and the state plot are two views of the same w (or v), so
// dragging the arrow here slides the true next state (or the
// measurement) over there, and dragging that dot over there swings this
// arrow. Neither is the "real" control -- they both write state.w.

// Fraction of the half-window an edge-clipped marker sits at, so it
// stays clear of the canvas border.
const EDGE_INSET = 0.93;

const SPECS = {
  Q: {
    covKey: "Q",
    noiseKey: "w",
    color: COLORS.process,
    noiseLabel: "w",
    setNoise: (store, value) => store.setProcessNoise(value),
  },
  R: {
    covKey: "R",
    noiseKey: "v",
    color: COLORS.measurement,
    noiseLabel: "v",
    setNoise: (store, value) => store.setMeasurementNoise(value),
  },
};

export function createNoiseView(canvas, { store, which, scale }) {
  const spec = SPECS[which];
  const ctx = canvas.getContext("2d");

  let dirty = true;
  let hovered = null;
  let covDrag = null;
  let layout = null;
  let rafId = null;

  // Same on-demand scheduling as the state plot: these panels are
  // static most of the time and should not keep the compositor awake.
  function invalidate() {
    dirty = true;
    if (rafId === null) rafId = requestAnimationFrame(frame);
  }

  store.subscribe(invalidate);
  scale.subscribe(invalidate);

  // A realisation dragged past the edge of the window would otherwise
  // become invisible AND unreachable, with no way back except the state
  // plot. Pinning a marker to the boundary along the same bearing keeps
  // it grabbable; grabbing it snaps the draw back to the edge, which is
  // the only sensible reading of "pull this back in". Zooming out is the
  // other way to reach it, now that zoom is available again.
  function clipToPanel(p, halfW, halfH) {
    const t = Math.max(
      Math.abs(p[0]) / (halfW * EDGE_INSET),
      Math.abs(p[1]) / (halfH * EDGE_INSET),
    );
    if (t <= 1 || !Number.isFinite(t)) return { point: p, clipped: false };
    return { point: [p[0] / t, p[1] / t], clipped: true };
  }

  function niceStep(span) {
    const raw = span / 2;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const n = raw / pow;
    return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * pow;
  }

  function draw() {
    const { width, height, dpr } = syncCanvasSize(canvas);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);

    const s = store.state;
    const k = store.sigmaK();
    const halfSpan = scale.get();
    const tf = createTransform(width, height, { center: [0, 0], halfSpan });

    drawGrid(ctx, tf, width, height, niceStep(halfSpan * 2));

    const cov = s[spec.covKey];
    drawCovEllipse(ctx, tf, [0, 0], eigSym(cov), k, {
      stroke: spec.color,
      fill: spec.color + "18",
      lineWidth: 2,
    });

    const origin = tf.toScreen([0, 0]);
    const noise = s[spec.noiseKey];
    const { point: shown, clipped } = clipToPanel(
      noise,
      (width / 2) / tf.scale,
      (height / 2) / tf.scale,
    );
    const pNoise = tf.toScreen(shown);

    drawArrow(ctx, origin, pNoise, {
      color: spec.color,
      width: 2.25,
      dash: clipped ? [5, 3] : undefined,
    });

    const pHandles = handlePositions(cov, [0, 0], k).map((p) => tf.toScreen(p));
    pHandles.forEach((p, i) =>
      drawHandle(ctx, p, spec.color, hovered?.id === `cov${i}` || covDrag?.id === `cov${i}`),
    );

    drawPoint(ctx, origin, { color: COLORS.axis, r: 2.5 });
    // Stays filled even when clipped: across the whole demo a white
    // interior means "derived", and the realisation is draggable
    // wherever it happens to be. The dashed arrow and the label's arrow
    // glyph already say it is really further out this way.
    drawPoint(ctx, pNoise, { color: spec.color, r: 5, draggable: true });
    drawLabel(ctx, pNoise, clipped ? `${spec.noiseLabel} ⟶` : spec.noiseLabel, {
      color: spec.color,
      size: 14,
    });

    // Drawn last so it sits over the grid and any ellipse that has been
    // dragged large enough to reach the corner.
    drawMatrix(ctx, cov, { x: 8, y: 7, color: spec.color });

    layout = { tf, pHandles, pNoise };
  }

  function targets() {
    if (!layout) return [];
    const t = [];
    layout.pHandles.forEach((p, i) =>
      t.push({ id: `cov${i}`, kind: "cov", index: i, at: () => p }),
    );
    t.push({ id: "noise", kind: "noise", at: () => layout.pNoise });
    return t;
  }

  attachDragger(canvas, {
    targets,
    toWorld: (p) => layout.tf.toWorld(p),
    onGrab(target) {
      if (target.kind === "cov") {
        covDrag = { id: target.id, ...beginHandleDrag(store.state[spec.covKey], target.index) };
      }
      canvas.style.cursor = "grabbing";
    },
    onDrag(target, world) {
      if (target.kind === "cov") {
        const next = applyHandleDrag(covDrag, [0, 0], world, store.sigmaK());
        if (next) store.setCovariance(spec.covKey, next);
      } else {
        spec.setNoise(store, world);
      }
    },
    onRelease() {
      covDrag = null;
      canvas.style.cursor = "default";
    },
    onHover(target) {
      if (hovered?.id !== target?.id) {
        hovered = target;
        canvas.style.cursor = target ? "grab" : "default";
        invalidate();
      }
    },
  });

  function frame() {
    rafId = null;
    if (dirty) {
      draw();
      dirty = false;
    }
  }

  // Zoom is shared with the other panel and stays centred on the
  // origin: the origin is the mean of both distributions, so it is
  // the one point that should never be scrollable off the panel.
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      scale.zoomBy(Math.exp(e.deltaY * 0.0012));
    },
    { passive: false },
  );

  new ResizeObserver(invalidate).observe(canvas);
  invalidate();
}
