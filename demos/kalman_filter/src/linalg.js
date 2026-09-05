// Small fixed-size linear algebra for the 2x2 / 2-vector case that this
// whole demo lives in. Matrices are flat [a, b, c, d] == [[a, b], [c, d]]
// (row-major); vectors are [x, y]. Everything allocates a fresh array
// rather than writing in place — the state here is tiny and recomputed
// wholesale on every drag event, so aliasing bugs cost more than the
// garbage does.

export const I2 = [1, 0, 0, 1];

export function matmul(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
  ];
}

export function matvec(m, v) {
  return [m[0] * v[0] + m[1] * v[1], m[2] * v[0] + m[3] * v[1]];
}

export function transpose(m) {
  return [m[0], m[2], m[1], m[3]];
}

export function madd(m, n) {
  return [m[0] + n[0], m[1] + n[1], m[2] + n[2], m[3] + n[3]];
}

export function msub(m, n) {
  return [m[0] - n[0], m[1] - n[1], m[2] - n[2], m[3] - n[3]];
}

function mscale(m, s) {
  return [m[0] * s, m[1] * s, m[2] * s, m[3] * s];
}

export function inv(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
}

export function vadd(a, b) {
  return [a[0] + b[0], a[1] + b[1]];
}

export function vsub(a, b) {
  return [a[0] - b[0], a[1] - b[1]];
}



// Forces exact symmetry. The covariance recursions are symmetric in
// exact arithmetic but drift by ~1e-17 in floating point, and the
// analytic eigendecomposition below assumes m[1] === m[2] exactly —
// so every covariance produced by kalman.js goes through here before
// anything tries to draw it.
export function symmetrize(m) {
  const off = (m[1] + m[2]) / 2;
  return [m[0], off, off, m[3]];
}

// Analytic eigendecomposition of a symmetric 2x2, returned with the
// LARGER eigenvalue first — the opposite of numpy's eigh, and the order
// the UI wants, since "drag the major semi-axis" should always mean
// handle 0. Vectors are returned as vectors (not packed as the columns
// of a matrix) precisely because packing them is what makes the
// row-vs-column mixup possible at the call site.
export function eigSym(m) {
  const [a, b, , d] = m;
  const mid = (a + d) / 2;
  const disc = Math.hypot((a - d) / 2, b);
  const l1 = mid + disc;
  const l2 = mid - disc;

  let v1;
  if (Math.abs(b) > 1e-14) {
    v1 = [l1 - d, b];
    const n = Math.hypot(v1[0], v1[1]);
    v1 = [v1[0] / n, v1[1] / n];
  } else {
    // Already diagonal: the eigenvectors are the axes, but which axis
    // carries the LARGER eigenvalue depends on which diagonal entry
    // wins. Getting this backwards silently rotates every axis-aligned
    // ellipse by 90 degrees.
    v1 = a >= d ? [1, 0] : [0, 1];
  }
  const v2 = [-v1[1], v1[0]];
  return { values: [l1, l2], vectors: [v1, v2] };
}

// Rebuilds a covariance from an eigen-pair: lambda1 v1 v1' + lambda2 v2 v2'.
// This is how the drag handles write back — the user manipulates axes,
// and the covariance is whatever those axes imply.
export function covFromEigen(l1, l2, v1) {
  const v2 = [-v1[1], v1[0]];
  return symmetrize([
    l1 * v1[0] * v1[0] + l2 * v2[0] * v2[0],
    l1 * v1[0] * v1[1] + l2 * v2[0] * v2[1],
    l1 * v1[1] * v1[0] + l2 * v2[1] * v2[0],
    l1 * v1[1] * v1[1] + l2 * v2[1] * v2[1],
  ]);
}

// Lower-triangular Cholesky factor, for turning standard normals into
// samples with covariance m. Guarded against the (draggable!) degenerate
// case where the user has squashed an ellipse flat — a zero or negative
// pivot would otherwise produce NaN samples that poison every downstream
// coordinate and blank the whole canvas.
export function cholesky(m) {
  const a = Math.max(m[0], 1e-12);
  const l11 = Math.sqrt(a);
  const l21 = m[2] / l11;
  const l22 = Math.sqrt(Math.max(m[3] - l21 * l21, 1e-12));
  return [l11, 0, l21, l22];
}

let spare = null;

// Box-Muller, keeping the second variate for the next call.
export function randn() {
  if (spare !== null) {
    const s = spare;
    spare = null;
    return s;
  }
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const r = Math.sqrt(-2 * Math.log(u));
  const t = 2 * Math.PI * v;
  spare = r * Math.sin(t);
  return r * Math.cos(t);
}

export function sampleGaussian(cov) {
  return matvec(cholesky(cov), [randn(), randn()]);
}

// Matrix exponential by scaling-and-squaring with a Taylor series.
//
// There IS a closed form for 2x2 (via the eigenvalues of F), but it
// needs separate branches for real-distinct, complex, and repeated
// eigenvalues, and the repeated case is exactly the shear model in
// models.js — a defective matrix whose closed form is the one people
// get wrong. Scaling-and-squaring has no branches and no special cases:
// halve until the norm is small, where the series converges fast, then
// square back up.
export function expm(m, dt) {
  const a = mscale(m, dt);
  const norm = Math.max(
    Math.abs(a[0]) + Math.abs(a[1]),
    Math.abs(a[2]) + Math.abs(a[3]),
  );
  const squarings = Math.max(0, Math.ceil(Math.log2(Math.max(norm, 1e-12) / 0.25)));
  const scaled = mscale(a, 1 / 2 ** squarings);

  let term = I2;
  let sum = I2;
  for (let k = 1; k <= 14; k++) {
    term = mscale(matmul(term, scaled), 1 / k);
    sum = madd(sum, term);
  }
  for (let k = 0; k < squarings; k++) sum = matmul(sum, sum);
  return sum;
}
