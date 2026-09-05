// Canvas plumbing shared by the state plot and the two noise panels:
// DPR-correct sizing, a world<->screen transform, and the drawing
// primitives (ellipses, arrows, handles) that all three panels use.

// One colour per ROLE in the filter, used identically everywhere. The
// point of fixing them here is that the Q panel's ellipse and the Q
// contribution to the predicted ellipse are the same colour on purpose;
// so are the R panel and the ring drawn around the measurement.
export const COLORS = {
  // The truth chain stays achromatic while every filter quantity gets a
  // hue -- that separation is doing real work, since the true state is
  // the one thing on the plot the filter does not know. Three points in
  // one colour were impossible to tell apart though, so they step in
  // lightness instead, weighted toward the present: x_{k+1} is the
  // darkest, x_k has receded, and A x_k is lightest because it is a
  // construction rather than a state the system was ever in.
  //
  // The three are spaced by measured contrast, not by eye: adjacent
  // greys off a standard ramp came out at 1.6:1, which is exactly the
  // "which dot is which" problem this is meant to solve. These sit at
  // 2.5:1 or better against each other while the lightest still holds
  // 2.1:1 against the page.
  truthNow: "#212529",
  truthPrev: "#5c636a",
  truthFlowed: "#adb5bd",
  prior: "#2a78d6",
  // Purple belongs to the process noise alone -- the Q panel, the w
  // kick, and the Q ellipse drawn at A x0 are one idea in three places.
  // The prediction used to share this purple, which made "the ellipse
  // Q contributes" and "the ellipse Q was folded into" the same colour;
  // it gets its own hue so the prediction step reads as prior + process
  // rather than as more of the same thing.
  process: "#7048e8",
  predicted: "#c2255c",
  measurement: "#e8590c",
  posterior: "#099268",
  grid: "#e9e9e9",
  axis: "#c4c4c4",
  field: "#cfd8e3",
  bg: "#fafafa",
  label: "#555",
};

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

// World units are the state-space coordinates; screen units are CSS
// pixels with y flipped, so that positive x2 points UP the way it does
// in every phase-plane drawing in every textbook.
export function createTransform(width, height, { center, halfSpan }) {
  const scale = Math.min(width, height) / (2 * halfSpan);
  return {
    scale,
    toScreen([x, y]) {
      return [width / 2 + (x - center[0]) * scale, height / 2 - (y - center[1]) * scale];
    },
    toWorld([px, py]) {
      return [center[0] + (px - width / 2) / scale, center[1] - (py - height / 2) / scale];
    },
  };
}

export function drawGrid(ctx, tf, width, height, step) {
  const [x0, y1] = tf.toWorld([0, 0]);
  const [x1, y0] = tf.toWorld([width, height]);

  ctx.lineWidth = 1;
  ctx.strokeStyle = COLORS.grid;
  ctx.beginPath();
  for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
    const [sx] = tf.toScreen([x, 0]);
    ctx.moveTo(Math.round(sx) + 0.5, 0);
    ctx.lineTo(Math.round(sx) + 0.5, height);
  }
  for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
    const [, sy] = tf.toScreen([0, y]);
    ctx.moveTo(0, Math.round(sy) + 0.5);
    ctx.lineTo(width, Math.round(sy) + 0.5);
  }
  ctx.stroke();

  ctx.strokeStyle = COLORS.axis;
  ctx.beginPath();
  const [ox, oy] = tf.toScreen([0, 0]);
  ctx.moveTo(Math.round(ox) + 0.5, 0);
  ctx.lineTo(Math.round(ox) + 0.5, height);
  ctx.moveTo(0, Math.round(oy) + 0.5);
  ctx.lineTo(width, Math.round(oy) + 0.5);
  ctx.stroke();
}

// Draws the k-sigma contour of `cov` centred at `center`.
//
// The two conversions that this exists to get right, once, in one place:
// the eigenvalues are VARIANCES so the semi-axis is k*sqrt(lambda), and
// the ellipse is traced parametrically from the eigenVECTORS rather than
// handed to a rotate()-plus-arc() that would need the angle extracted
// correctly from an eigenvector matrix.
// Returns the traced contour in screen coordinates, so callers can
// hit-test against exactly the curve that was drawn rather than
// re-deriving it from the covariance.
export function drawCovEllipse(ctx, tf, center, eig, k, { stroke, fill, dash, lineWidth = 2 }) {
  const [v1, v2] = eig.vectors;
  const a = k * Math.sqrt(Math.max(eig.values[0], 0));
  const b = k * Math.sqrt(Math.max(eig.values[1], 0));
  const poly = [];

  ctx.beginPath();
  for (let i = 0; i <= 96; i++) {
    const t = (i / 96) * Math.PI * 2;
    const ct = Math.cos(t) * a;
    const st = Math.sin(t) * b;
    const p = tf.toScreen([
      center[0] + ct * v1[0] + st * v2[0],
      center[1] + ct * v1[1] + st * v2[1],
    ]);
    poly.push(p);
    if (i === 0) ctx.moveTo(p[0], p[1]);
    else ctx.lineTo(p[0], p[1]);
  }
  ctx.closePath();

  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.save();
    ctx.setLineDash(dash ?? []);
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = stroke;
    ctx.stroke();
    ctx.restore();
  }
  return poly;
}

// Shortest distance from a screen point to a closed polyline. Used to
// decide whether the cursor is "on" an ellipse: the contour, not the
// filled interior, because the interiors overlap heavily and an
// interior test would make the topmost ellipse swallow every hover
// inside it.
export function distanceToPolyline(p, poly) {
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const [ax, ay] = poly[i - 1];
    const [bx, by] = poly[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy)));
  }
  return best;
}

// Direction marks along a path: small chevrons pointing the way the
// quantity moved, so a still frame still says which end is the cause
// and which is the effect.
export function drawChevrons(ctx, from, to, { color, spacing = 26, size = 4.5 }) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  // Below roughly one spacing there is no room for a mark that would
  // not collide with the arrowhead at the end of the run.
  if (len < spacing) return;
  const ux = dx / len;
  const uy = dy / len;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let d = spacing * 0.6; d < len - spacing * 0.45; d += spacing) {
    const cx = from[0] + ux * d;
    const cy = from[1] + uy * d;
    ctx.beginPath();
    ctx.moveTo(cx - ux * size - uy * size, cy - uy * size + ux * size);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx - ux * size + uy * size, cy - uy * size - ux * size);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawArrow(ctx, from, to, { color, width = 1.75, head = 7, dash }) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const ux = dx / len;
  const uy = dy / len;
  const tipBack = Math.min(head, len);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash ?? []);
  ctx.beginPath();
  ctx.moveTo(from[0], from[1]);
  ctx.lineTo(to[0] - ux * tipBack * 0.7, to[1] - uy * tipBack * 0.7);
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(to[0], to[1]);
  ctx.lineTo(to[0] - ux * tipBack - uy * tipBack * 0.45, to[1] - uy * tipBack + ux * tipBack * 0.45);
  ctx.lineTo(to[0] - ux * tipBack + uy * tipBack * 0.45, to[1] - uy * tipBack - ux * tipBack * 0.45);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// `hollow` means DERIVED: a white interior marks a quantity the filter
// computes, a filled one marks a quantity you can drag. That is the
// only thing fill communicates, so it has to stay consistent across
// every dot on every panel.
export function drawPoint(ctx, p, { color, r = 6, hollow = false, draggable = false }) {
  ctx.save();
  if (draggable) {
    // Faint halo marking "you can grab this". Cheaper to read at a
    // glance than a legend entry, and it's the only visual difference
    // between the dots you can move and the ones the filter derives.
    ctx.beginPath();
    ctx.arc(p[0], p[1], r + 4.5, 0, Math.PI * 2);
    ctx.fillStyle = color + "22";
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
  ctx.fillStyle = hollow ? "#fff" : color;
  ctx.fill();
  ctx.lineWidth = hollow ? 2.5 : 1.5;
  ctx.strokeStyle = hollow ? color : "#fff";
  ctx.stroke();
  ctx.restore();
}

export function drawHandle(ctx, p, color, active) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(p[0] - 4.5, p[1] - 4.5, 9, 9);
  ctx.fillStyle = active ? color : "#fff";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.restore();
}

// A 2x2 matrix printed in the corner of a panel.
//
// Monospaced and right-aligned to a fixed width so the columns line up
// and, more importantly, so the digits do not jitter sideways while a
// handle is being dragged — the numbers are there to be read *during*
// the drag, and proportional digits shifting under the cursor makes
// that surprisingly hard.
export function drawMatrix(ctx, m, { x, y, color = "#444", size = 11 }) {
  const cell = (v) => (Math.abs(v) < 5e-3 ? 0 : v).toFixed(2).padStart(5);
  const rows = [`[${cell(m[0])} ${cell(m[1])}]`, `[${cell(m[2])} ${cell(m[3])}]`];

  ctx.save();
  ctx.font = `${size}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  ctx.textBaseline = "top";
  const w = Math.max(...rows.map((r) => ctx.measureText(r).width));
  const lineHeight = size * 1.35;

  ctx.fillStyle = "#ffffffcc";
  ctx.fillRect(x - 4, y - 3, w + 8, lineHeight * 2 + 6);
  ctx.fillStyle = color;
  rows.forEach((r, i) => ctx.fillText(r, x, y + i * lineHeight));
  ctx.restore();
}

export function drawLabel(ctx, p, text, { color = COLORS.label, dx = 9, dy = -9, size = 11.5 } = {}) {
  ctx.save();
  ctx.font = `${size}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  const w = ctx.measureText(text).width;
  // Knocked-back plate so labels stay readable where they land on top
  // of the vector field or another ellipse.
  ctx.fillStyle = "#ffffffd0";
  ctx.fillRect(p[0] + dx - 2.5, p[1] + dy - 7.5, w + 5, 15);
  ctx.fillStyle = color;
  ctx.fillText(text, p[0] + dx, p[1] + dy);
  ctx.restore();
}
