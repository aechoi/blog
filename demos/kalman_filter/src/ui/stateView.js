import { eigSym } from "../linalg.js";
import {
  COLORS,
  syncCanvasSize,
  createTransform,
  drawGrid,
  drawCovEllipse,
  drawArrow,
  drawChevrons,
  drawPoint,
  drawHandle,
  drawLabel,
  distanceToPolyline,
} from "./canvas.js";
import { handlePositions, beginHandleDrag, applyHandleDrag } from "./covHandles.js";
import { attachDragger } from "./dragger.js";
import { createParticleField } from "./fieldLayer.js";
import { isVisible } from "./groups.js";
import { labelsFor } from "./labels.js";
import { SIGMA_SPREAD } from "../unscented.js";

// The main phase-plane view. Because C = I, the measurement lives in
// state space, so every quantity in the step is on one set of axes.
//
// Two visual conventions carry the whole story, and both are enforced
// from a single place so they cannot drift apart:
//
//   SOLID outline / SOLID dot  = you can change this
//   DASHED outline / WHITE dot = the filter derives this
//
// So the dashed ellipses (P1-, P1+) and hollow dots (A x0, x-hat1-,
// x-hat1+) are exactly the things that move only as a consequence of
// something else you touched.
//
// Orthogonally, the stage buttons and the legend switch groups of
// elements on and off (see ui/groups.js). Greyed elements are inert: no
// handles, no drag, no description.

const POINT_LABEL_SIZE = 15;
const ELLIPSE_LABEL_SIZE = 13;
const DIM = 0.13; // opacity of everything currently switched off

// Emphasis is driven by an explicit selection rather than by what the
// cursor happens to be over. Hover-driven dimming sounds helpful and is
// not: the picture reorganises itself under the pointer, so it is never
// stable long enough to actually read, and you cannot look at one thing
// while thinking about another. A chosen set holds still.
const ELLIPSE_HOVER_RADIUS = 9;
const TRAIL_STEPS = 30; // committed steps drawn behind the current one

// What the predict step did, in the words of the filter that did it.
// This is the one caption that changes with the selector, and it is the
// shortest honest statement of the difference between the three.
//
// The KF's entry depends on the model family because its meaning does:
// on a linear flow it is exact, and on a curved one it is a single
// linearization taken at the origin and then trusted everywhere.
function predictCaption(filterId, linear) {
  if (filterId === "ekf") {
    return linear
      ? "Derived: the prior pushed through the exact transition A."
      : "Derived: the mean pushed through the real flow; only the covariance is linearized, at the mean.";
  }
  if (filterId === "ukf") {
    return linear
      ? "Derived: the weighted mean of the propagated sigma points — exact here, since the flow is linear."
      : "Derived: the weighted mean of the propagated sigma points. No derivative is taken.";
  }
  return linear
    ? "Derived: the prior pushed through the exact transition A."
    : "Derived: the prior pushed through one A, linearized at the origin and never revisited.";
}

// Shown in the caption strip while hovering. Built per step so the
// symbols match the ones drawn on the plot.
function descriptionsFor(k, linear, filterId) {
  const l = labelsFor(k, linear);
  return {
    x0: [`${l.x0}  initial true state`, "Drag it: the flow carries everything downstream with it."],
    flowed: [
      `${l.flowed}  noiseless step`,
      linear
        ? "Where the dynamics alone would put the truth, before any process noise."
        : "Where the flow alone carries the truth in dt, before any process noise.",
    ],
    x1: [
      `${l.x1} = ${l.flowed} + ${l.w}  new true state`,
      `Drag it to choose the process-noise draw ${l.w}.`,
    ],
    z: [
      `${l.z} = ${l.x1} + ${l.v}  measurement`,
      `Drag it to choose the measurement-noise draw ${l.v}.`,
    ],
    xhat0: [`${l.xhat0}  prior mean`, "Your estimate before this step. Drag it."],
    xpred: [
      `${l.xpred} = ${predictedMeanFormula(filterId, linear, l)}  predicted mean`,
      predictCaption(filterId, linear),
    ],
    xpost: [
      `${l.xpost}  posterior mean`,
      "Derived: the prediction corrected by K times the innovation.",
    ],
    P0: [`${l.P0}  prior covariance`, "Drag a handle to reshape it."],
    Q: ["Q  process noise covariance", `${l.x1} is drawn from this, centred at ${l.flowed}. Drag a handle.`],
    R: ["R  measurement noise covariance", `${l.z} is drawn from this, centred at ${l.x1}. Drag a handle.`],
    Ppred: [
      filterId === "ukf"
        ? `${l.Ppred} = Σ wᵢ (φ(χᵢ) − ${l.xpred})(·)ᵀ + Q`
        : `${l.Ppred} = A ${l.P0} Aᵀ + Q  predicted covariance`,
      filterId === "ukf"
        ? "Refitted to where the sigma points landed, plus process noise."
        : filterId === "kf" && !linear
          ? "Derived: the prior propagated through the origin's Jacobian, plus process noise."
          : "Derived: the prior propagated through the Jacobian at the mean, plus process noise.",
    ],
    sigma: [
      `${l.sigma}  sigma points`,
      `Placed by ${l.P0} at ±${SIGMA_SPREAD.toFixed(2)}σ along its axes. Nothing is differentiated.`,
    ],
    sigmaPred: [
      `${l.sigmaPred}  propagated sigma points`,
      `Each point carried through the real flow. ${l.Ppred} is refitted to where they land.`,
    ],
    Ppost: [
      `${l.Ppost} = (I−K)${l.Ppred}(I−K)ᵀ + KRKᵀ`,
      "Derived: what the measurement leaves of the prediction.",
    ],
  };
}

// How the predicted mean was actually formed. The KF multiplies by its
// one matrix whatever the model is, so it keeps "A x-hat" on a curved
// flow too -- writing the flow map there would credit it with a
// propagation it did not do.
function predictedMeanFormula(filterId, linear, l) {
  if (filterId === "kf" || linear) return `A ${l.xhat0}`;
  if (filterId === "ukf") return `Σ wᵢ φ(χᵢ)`;
  return `φ(${l.xhat0})`;
}

// Puts a contour's name at the topmost point of that contour.
//
// The top of a rotated ellipse is not the top of its bounding box nor
// the end of either semi-axis: parametrising as c + a·cos(t)·v1 +
// b·sin(t)·v2, the world y is extremised at tan(t) = b·v2y / a·v1y,
// giving a peak offset of hypot(a·v1y, b·v2y). Solving for it directly
// keeps the label glued to the curve at every orientation, instead of
// drifting inside or outside as the ellipse rotates.
function ellipseTop(center, eig, sigma) {
  const [v1, v2] = eig.vectors;
  const a = sigma * Math.sqrt(Math.max(eig.values[0], 0));
  const b = sigma * Math.sqrt(Math.max(eig.values[1], 0));
  const ay = a * v1[1];
  const by = b * v2[1];
  const norm = Math.hypot(ay, by);
  if (norm < 1e-12) return center;
  const cosT = ay / norm;
  const sinT = by / norm;
  return [
    center[0] + a * cosT * v1[0] + b * sinT * v2[0],
    center[1] + a * cosT * v1[1] + b * sinT * v2[1],
  ];
}

export function createStateView(canvas, { store }) {
  const ctx = canvas.getContext("2d");
  const particles = createParticleField();

  const HOME = { center: [0, 0], halfSpan: 2.2 };
  let halfSpan = HOME.halfSpan;
  let center = [...HOME.center];
  let dirty = true;
  let hovered = null;
  let covDrag = null;
  let lastFrame = performance.now();
  let layout = null; // screen geometry from the last draw, for hit-testing
  let rafId = null;

  // Marks the view as needing a repaint and makes sure exactly one
  // frame is queued. Every mutation path goes through here so the view
  // can sit idle the rest of the time.
  function schedule() {
    if (rafId === null) rafId = requestAnimationFrame(frame);
  }
  function invalidate() {
    dirty = true;
    schedule();
  }

  store.subscribe(invalidate);

  function bounds(tf, width, height) {
    const [x0, y1] = tf.toWorld([0, 0]);
    const [x1, y0] = tf.toWorld([width, height]);
    return { x0, x1, y0, y1 };
  }

  // Grid/quiver spacing in world units, chosen so the on-screen spacing
  // stays roughly constant as you zoom.
  function niceStep(span) {
    const raw = span / 4;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const n = raw / pow;
    return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * pow;
  }

  // Hover now only picks what the caption describes; it no longer
  // changes anything's opacity.
  function captionId() {
    return hovered?.focus ?? hovered?.id ?? null;
  }

  function drawCaption(ctx, width, id, k, linear, filterId) {
    const entry = descriptionsFor(k, linear, filterId)[id];
    if (!entry) return;
    const [title, detail] = entry;
    ctx.save();
    ctx.font = `600 13px system-ui, sans-serif`;
    const titleWidth = ctx.measureText(title).width;
    ctx.font = `12px system-ui, sans-serif`;
    const detailWidth = ctx.measureText(detail).width;
    const boxWidth = Math.min(width - 20, Math.max(titleWidth, detailWidth) + 22);

    ctx.fillStyle = "#ffffffee";
    ctx.strokeStyle = "#d8d8d8";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(10, 10, boxWidth, 46, 6);
    ctx.fill();
    ctx.stroke();

    ctx.textBaseline = "middle";
    ctx.fillStyle = "#222";
    ctx.font = `600 13px system-ui, sans-serif`;
    ctx.fillText(title, 21, 26);
    ctx.fillStyle = "#666";
    ctx.font = `12px system-ui, sans-serif`;
    ctx.fillText(detail, 21, 44);
    ctx.restore();
  }

  function draw() {
    const { width, height, dpr } = syncCanvasSize(canvas);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);

    const s = store.state;
    const d = store.derived;
    const model = store.model();
    const sigma = store.sigmaK();
    // Steps committed so far: the cycle on screen runs k -> k+1.
    const k = s.history.length;
    const L = labelsFor(k, model.linear);
    const tf = createTransform(width, height, { center, halfSpan });
    const b = bounds(tf, width, height);
    const step = niceStep(halfSpan * 2);

    const shown = (id) => isVisible(id, s.visibleGroups);
    const a = (id) => (shown(id) ? 1 : DIM);

    particles.draw(ctx, tf, b);

    drawGrid(ctx, tf, width, height, step);

    // --- committed history, faded, oldest first ---
    // Only the tail of the undo stack is drawn: the stack goes back
    // hundreds of steps so you can walk backwards a long way, but a
    // hundred faded dots is clutter rather than context.
    const trail = s.history.slice(-TRAIL_STEPS);
    trail.forEach((h, i) => {
      ctx.globalAlpha = ((i + 1) / (trail.length + 1)) * 0.5;
      drawPoint(ctx, tf.toScreen(h.xTrue), { color: COLORS.truthPrev, r: 3 });
      drawPoint(ctx, tf.toScreen(h.xHat), { color: COLORS.prior, r: 3 });
    });
    ctx.globalAlpha = 1;

    // Where the flow alone takes the truth, before the process-noise
    // kick. Taken from the solve rather than recomputed here: on a
    // curved model there is no matrix to multiply by, and a second
    // derivation would be a second chance to disagree with the one the
    // filter actually used.
    const flowed = d.flowed;
    const pHat0 = tf.toScreen(s.xHat);
    const pTrue0 = tf.toScreen(s.xTrue);
    const pFlowed = tf.toScreen(flowed);
    const pTrue1 = tf.toScreen(d.xTrueNext);
    const pPred = tf.toScreen(d.xPred);
    const pZ = tf.toScreen(d.z);
    const pPost = tf.toScreen(d.xPost);

    // --- covariance ellipses -------------------------------------------
    // Ordered back to front by how "final" each one is.
    //
    // Q and R are each drawn at the MEAN of the distribution they
    // describe, not at the sample that came out of it: x1 ~ N(A x0, Q)
    // so Q sits at A x0, and (with C = I) z ~ N(x1, R) so R sits at x1.
    // R used to be drawn at z, which quietly inverted the relationship
    // -- it showed a cloud of uncertainty around the measurement rather
    // than the distribution the measurement was a draw from, and left
    // the v arrow pointing from the centre of the ellipse to its own
    // source instead of the other way round.
    const ellipses = [
      { id: "Q", center: flowed, cov: s.Q, color: COLORS.process, editable: true, label: L.Q },
      { id: "R", center: d.xTrueNext, cov: s.R, color: COLORS.measurement, editable: true, label: L.R },
      { id: "P0", center: s.xHat, cov: s.P, color: COLORS.prior, editable: true, label: L.P0 },
      { id: "Ppred", center: d.xPred, cov: d.PPred, color: COLORS.predicted, editable: false, label: L.Ppred },
      { id: "Ppost", center: d.xPost, cov: d.PPost, color: COLORS.posterior, editable: false, label: L.Ppost },
    ];

    const contours = {};
    for (const e of ellipses) {
      ctx.globalAlpha = a(e.id);
      contours[e.id] = drawCovEllipse(ctx, tf, e.center, eigSym(e.cov), sigma, {
        stroke: e.color,
        fill: e.color + (e.editable ? "14" : "10"),
        dash: e.editable ? [] : [6, 4],
        lineWidth: e.editable ? 2 : 1.8,
      });
    }
    ctx.globalAlpha = 1;

    // --- the sigma points, when the UKF is running ----------------------
    //
    // The whole argument of the UKF is visible here and nowhere else:
    // five points placed on the prior, each carried through the REAL
    // flow, and the predicted ellipse refitted to where they land. On a
    // curved flow the images stop being an affine image of the original
    // five -- they bend -- and the gap between that bend and the ellipse
    // drawn through them is precisely the approximation the UKF is still
    // making.
    //
    // Each point is joined to its own image, because the set as a whole
    // says nothing; what carries the idea is that THIS point went THERE.
    const sigmaPts = [];
    if (d.sigmaPrior && d.sigmaPred) {
      ctx.globalAlpha = a("sigma");
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = COLORS.process + "55";
      ctx.setLineDash([3, 3]);
      for (let i = 0; i < d.sigmaPrior.length; i++) {
        const from = tf.toScreen(d.sigmaPrior[i]);
        const to = tf.toScreen(d.sigmaPred[i]);
        ctx.beginPath();
        ctx.moveTo(from[0], from[1]);
        ctx.lineTo(to[0], to[1]);
        ctx.stroke();
      }
      ctx.restore();

      // Coloured by which belief each end belongs to: the prior points
      // are blue like the ellipse they were drawn from, their images
      // crimson like the ellipse they go on to define. The centre point
      // is drawn larger since it is the mean, not a spread point.
      for (let i = 0; i < d.sigmaPrior.length; i++) {
        const r = i === 0 ? 3.6 : 2.9;
        drawPoint(ctx, tf.toScreen(d.sigmaPrior[i]), { color: COLORS.prior, r });
        drawPoint(ctx, tf.toScreen(d.sigmaPred[i]), { color: COLORS.predicted, r });
      }
      sigmaPts.push(...d.sigmaPrior.map((q) => tf.toScreen(q)));
      ctx.globalAlpha = 1;
    }

    // --- the arrows that say what happened ------------------------------
    // Two chains, each marked with chevrons so a still frame reads in
    // the right direction: the truth's chain (x0 through the flow, the
    // process-noise kick, then the measurement offset) and the filter's
    // chain (prior, prediction, posterior).
    const chain = [
      ["arrow:flow", pTrue0, pFlowed, COLORS.truthPrev + "cc", [4, 3], 1.5],
      ["arrow:w", pFlowed, pTrue1, COLORS.process, null, 2],
      ["arrow:v", pTrue1, pZ, COLORS.measurement, null, 2],
      ["arrow:predict", pHat0, pPred, COLORS.predicted + "90", [4, 3], 1.5],
      ["arrow:correct", pPred, pPost, COLORS.posterior, [4, 3], 2.5],
    ];
    for (const [id, from, to, color, dash, width] of chain) {
      ctx.globalAlpha = a(id);
      drawArrow(ctx, from, to, { color, dash: dash ?? undefined, width });
      drawChevrons(ctx, from, to, { color });
    }
    // The innovation is a comparison, not a step in either chain, so it
    // gets no chevrons.
    ctx.globalAlpha = a("arrow:innovation");
    drawArrow(ctx, pPred, pZ, { color: COLORS.measurement + "60", dash: [2, 3], width: 1.3 });
    ctx.globalAlpha = 1;

    // --- handles, on the editable ellipses only -------------------------
    // Greyed-out ellipses get no handles at all: a grabbable control on
    // something currently switched off is just a trap.
    const handles = {};
    for (const e of ellipses) {
      if (!e.editable || !shown(e.id)) continue;
      handles[e.id] = handlePositions(e.cov, e.center, sigma).map((p) => tf.toScreen(p));
      ctx.globalAlpha = a(e.id);
      handles[e.id].forEach((p, i) =>
        drawHandle(ctx, p, e.color, hovered?.id === `${e.id}h${i}` || covDrag?.id === `${e.id}h${i}`),
      );
    }
    ctx.globalAlpha = 1;

    // --- the dots: filled = draggable, white = derived ------------------
    const dots = [
      { id: "flowed", p: pFlowed, color: COLORS.truthFlowed, r: 4.5, hollow: true },
      { id: "xpred", p: pPred, color: COLORS.predicted, r: 5.5, hollow: true },
      { id: "xpost", p: pPost, color: COLORS.posterior, r: 6.5, hollow: true },
      { id: "z", p: pZ, color: COLORS.measurement, r: 5.5, draggable: true },
      { id: "x0", p: pTrue0, color: COLORS.truthPrev, r: 6, draggable: true },
      { id: "x1", p: pTrue1, color: COLORS.truthNow, r: 6, draggable: true },
      { id: "xhat0", p: pHat0, color: COLORS.prior, r: 6, draggable: true },
    ];
    for (const dot of dots) {
      ctx.globalAlpha = a(dot.id);
      drawPoint(ctx, dot.p, dot);
    }
    ctx.globalAlpha = 1;

    // --- labels ----------------------------------------------------------
    // Symbols only, pushed radially outward from the centroid of the
    // labelled points. They sit almost on top of each other whenever the
    // filter is confident — which is most of the time, and exactly when
    // you most want to read them — so fixed offsets and spelt-out names
    // overlap into an unreadable pile. The names live in the legend and
    // in the hover caption instead, where they have room.
    const labelled = [
      ["x0", pTrue0, L.x0, COLORS.truthPrev],
      ["flowed", pFlowed, L.flowed, COLORS.truthFlowed],
      ["x1", pTrue1, L.x1, COLORS.truthNow],
      ["xhat0", pHat0, L.xhat0, COLORS.prior],
      ["xpred", pPred, L.xpred, COLORS.predicted],
      ["z", pZ, L.z, COLORS.measurement],
      ["xpost", pPost, L.xpost, COLORS.posterior],
    ];
    const cx = labelled.reduce((acc, l) => acc + l[1][0], 0) / labelled.length;
    const cy = labelled.reduce((acc, l) => acc + l[1][1], 0) / labelled.length;
    for (const [id, p, text, color] of labelled) {
      let ux = p[0] - cx;
      let uy = p[1] - cy;
      const n = Math.hypot(ux, uy);
      // A point sitting exactly at the centroid has no outward
      // direction to use; send it up-right rather than divide by zero.
      if (n < 1e-6) {
        ux = 0.7071;
        uy = -0.7071;
      } else {
        ux /= n;
        uy /= n;
      }
      ctx.globalAlpha = a(id);
      drawLabel(ctx, p, text, {
        color,
        size: POINT_LABEL_SIZE,
        dx: ux * 14 - (ux < 0 ? 26 : 0),
        dy: uy * 14,
      });
    }

    for (const e of ellipses) {
      ctx.globalAlpha = a(e.id);
      drawLabel(ctx, tf.toScreen(ellipseTop(e.center, eigSym(e.cov), sigma)), e.label, {
        color: e.color,
        size: ELLIPSE_LABEL_SIZE,
        dx: -9,
        dy: -12,
      });
    }
    ctx.globalAlpha = 1;

    const caption = captionId();
    if (caption) drawCaption(ctx, width, caption, k, model.linear, d.filterId);

    layout = {
      tf,
      visibleGroups: s.visibleGroups,
      contours,
      handles,
      dots: Object.fromEntries(dots.map((x) => [x.id, x.p])),
      // Hover targets only. They are computed by the filter, so there is
      // nothing to grab -- but they are the least self-explanatory thing
      // on the plot, so they had better be able to describe themselves.
      sigma: sigmaPts,
      sigmaPred: d.sigmaPred ? d.sigmaPred.map((q) => tf.toScreen(q)) : [],
    };
  }

  // Targets read from the last frame's `layout`, so a grab point is
  // always exactly where it was drawn.
  function targets() {
    if (!layout) return [];
    const t = [];

    // Contours first: hover-only, and lowest priority, so a handle or a
    // dot sitting on top of one always wins. Anything greyed out is not
    // a target at all -- it cannot be grabbed and it does not describe
    // itself.
    const live = (id) => isVisible(id, layout.visibleGroups);
    for (const [id, poly] of Object.entries(layout.contours)) {
      if (!live(id)) continue;
      t.push({
        id,
        kind: "contour",
        focus: id,
        hoverOnly: true,
        radius: ELLIPSE_HOVER_RADIUS,
        distance: (p) => distanceToPolyline(p, poly),
        at: () => poly[0],
      });
    }

    for (const [covId, points] of Object.entries(layout.handles)) {
      points.forEach((p, i) =>
        t.push({ id: `${covId}h${i}`, kind: "cov", covId, index: i, focus: covId, at: () => p }),
      );
    }

    for (const [id, points] of [["sigma", layout.sigma], ["sigmaPred", layout.sigmaPred]]) {
      if (!live(id)) continue;
      points.forEach((p, i) =>
        t.push({ id: `${id}${i}`, kind: "readonly", focus: id, hoverOnly: true, radius: 7, at: () => p }),
      );
    }

    // Dots last: with a small covariance the handles sit almost on top
    // of the centre, and grabbing the point is the more common intent,
    // so it should win the tie (see dragger.js).
    for (const [id, p] of Object.entries(layout.dots)) {
      if (!live(id)) continue;
      // The deterministic image is a derived marker, not a control.
      if (id === "flowed" || id === "xpred" || id === "xpost") {
        t.push({ id, kind: "readonly", focus: id, hoverOnly: true, at: () => p });
      } else {
        t.push({ id, kind: "point", focus: id, at: () => p });
      }
    }
    return t;
  }

  // Which store field each editable ellipse writes to, and where its
  // handles are anchored. Q is centred on A x0 and R on x1, so the
  // handle drag has to be measured from those, not from the origin.
  function covCenterFor(covId) {
    const s = store.state;
    const d = store.derived;
    if (covId === "P0") return s.xHat;
    if (covId === "Q") return d.flowed;
    return d.xTrueNext;
  }

  // Screen delta to world delta. Dragging right moves the content
  // right, which means the window moved left, hence the signs.
  function panBy(dx, dy) {
    if (!layout) return;
    const scale = layout.tf.scale;
    center = [center[0] - dx / scale, center[1] + dy / scale];
    invalidate();
  }

  // Zoom about a screen point rather than the centre of the canvas: pin
  // whatever world point is under it and solve for the centre that
  // keeps it there at the new scale. Zooming about the canvas centre
  // instead would shove the thing you are pointing at off-screen, which
  // matters much more now that the view pans and the interesting
  // cluster is rarely centred.
  //
  // `factor` is how much BIGGER things get, so the span it maps to is
  // the reciprocal. Clamped so one flick of a trackpad or one fast
  // pinch cannot strand the view somewhere with nothing in it.
  function zoomAbout([px, py], factor) {
    const { width, height } = syncCanvasSize(canvas);
    const anchor = createTransform(width, height, { center, halfSpan }).toWorld([px, py]);
    halfSpan = Math.min(12, Math.max(0.35, halfSpan / factor));
    const scale = Math.min(width, height) / (2 * halfSpan);
    center = [anchor[0] - (px - width / 2) / scale, anchor[1] + (py - height / 2) / scale];
    invalidate();
  }

  attachDragger(canvas, {
    targets,
    toWorld: (p) => layout.tf.toWorld(p),
    onGrab(target) {
      if (target.kind === "cov") {
        covDrag = {
          id: target.id,
          covId: target.covId,
          focus: target.covId,
          ...beginHandleDrag(store.state[target.covId === "P0" ? "P" : target.covId], target.index),
        };
      }
      canvas.style.cursor = "grabbing";
    },
    onDrag(target, world) {
      if (target.kind === "cov") {
        const key = covDrag.covId === "P0" ? "P" : covDrag.covId;
        const cov = applyHandleDrag(covDrag, covCenterFor(covDrag.covId), world, store.sigmaK());
        if (cov) store.setCovariance(key, cov);
        return;
      }
      if (target.id === "x0") store.update({ xTrue: world });
      else if (target.id === "xhat0") store.update({ xHat: world });
      else if (target.id === "x1") store.setTrueNext(world);
      else if (target.id === "z") store.setMeasurement(world);
    },
    onRelease() {
      covDrag = null;
      canvas.style.cursor = "default";
      invalidate();
    },
    onHover(target) {
      if (hovered?.id !== target?.id) {
        hovered = target;
        canvas.style.cursor = target && !target.hoverOnly ? "grab" : target ? "help" : "move";
        invalidate();
      }
    },
    onBackgroundDrag: panBy,
    // Two fingers pan and zoom at once, which is the whole gesture on a
    // phone: the midpoint's travel is the pan, its separation is the
    // zoom, and both are applied about the midpoint so whatever sits
    // between the fingers stays put under them.
    onPinch({ factor, mid, dx, dy }) {
      panBy(dx, dy);
      zoomAbout(mid, factor);
    },
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      // A wheel notch is a zoom about the cursor with no pan; a pinch is
      // the same zoom about the midpoint of two fingers. Both go through
      // zoomAbout so the mouse and the touch path cannot drift apart.
      zoomAbout([e.clientX - rect.left, e.clientY - rect.top], Math.exp(-e.deltaY * 0.0012));
    },
    { passive: false },
  );

  // The flow field animates continuously, so this loop always re-arms.
  // invalidate() still exists for the paths that change the picture
  // between frames (drags, zoom, resize) — it keeps a single frame
  // queued rather than several, and it is what would let the view idle
  // again if the field ever became switchable off.
  function frame(now) {
    rafId = null;
    const dt = (now - lastFrame) / 1000;
    lastFrame = now;
    const { width, height } = syncCanvasSize(canvas);
    const tf = createTransform(width, height, { center, halfSpan });
    particles.step(store.model(), bounds(tf, width, height), dt);
    draw();
    dirty = false;
    schedule();
  }

  new ResizeObserver(invalidate).observe(canvas);
  invalidate();

  return {
    resetField: () => particles.reset(),
    resetView() {
      center = [...HOME.center];
      halfSpan = HOME.halfSpan;
      invalidate();
    },
  };
}
