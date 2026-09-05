import { cholesky, symmetrize } from "./linalg.js";

// The unscented transform: the UKF's answer to "what does a nonlinear
// map do to a Gaussian".
//
// The EKF answers it by replacing the map with its Jacobian at the mean,
// which is a statement about an infinitesimal neighbourhood and says
// nothing about how wide the prior actually is. The UT instead places a
// small set of points at a known spread, pushes each through the REAL
// map, and reads the mean and covariance back off the images. Nothing is
// differentiated, and a map that is strongly curved across the width of
// the prior is sampled where that curvature actually lives.

const N = 2; // state dimension, fixed like everything else here

// The scaled unscented transform's three knobs.
//
// ALPHA is normally taken tiny (1e-3) to keep the points in a small
// neighbourhood of the mean, which makes the UT reproduce the EKF's
// linearization to first order -- exactly the behaviour this demo exists
// to contrast against. At alpha = 1 the points sit out at sqrt(n + kappa)
// = sqrt(3) ~ 1.73 sigma, well inside the plotted 1-sigma-and-a-bit
// region and genuinely far enough out to feel the curvature of the flow.
// It also makes them visible as separate dots at a normal zoom, which
// matters here because they are drawn.
//
// KAPPA = 3 - n is the usual choice for a Gaussian prior, and BETA = 2
// is optimal for one; beta enters only the covariance weight of the
// centre point.
const ALPHA = 1;
const KAPPA = 3 - N;
const BETA = 2;
const LAMBDA = ALPHA * ALPHA * (N + KAPPA) - N;

// How many sigmas out the off-centre points sit. Exported because the
// plot labels the spread, and a caption that disagreed with the geometry
// would be worse than no caption.
export const SIGMA_SPREAD = Math.sqrt(N + LAMBDA);

// Mean weights and covariance weights. They differ only in the centre
// point, and only by beta.
const WM = [LAMBDA / (N + LAMBDA), 0.5 / (N + LAMBDA), 0.5 / (N + LAMBDA), 0.5 / (N + LAMBDA), 0.5 / (N + LAMBDA)];
const WC = [WM[0] + (1 - ALPHA * ALPHA + BETA), WM[1], WM[2], WM[3], WM[4]];

export const SIGMA_WEIGHTS = { mean: WM, cov: WC };

// The 2n+1 points: the mean, then the mean plus and minus each column of
// the scaled Cholesky factor.
//
// The columns are what matter, not the rows -- for the lower-triangular
// factor L those are [L00, L10] and [0, L11]. Taking rows instead gives
// points whose sample covariance is L'L rather than LL', which is a
// different matrix as soon as the covariance is correlated, and the
// resulting ellipse is wrong in a way that looks plausible.
export function sigmaPoints(mean, cov) {
  const L = cholesky(cov);
  const s = SIGMA_SPREAD;
  const c0 = [s * L[0], s * L[2]]; // first column
  const c1 = [s * L[1], s * L[3]]; // second column
  return [
    [mean[0], mean[1]],
    [mean[0] + c0[0], mean[1] + c0[1]],
    [mean[0] + c1[0], mean[1] + c1[1]],
    [mean[0] - c0[0], mean[1] - c0[1]],
    [mean[0] - c1[0], mean[1] - c1[1]],
  ];
}

// Weighted mean of a set of sigma points.
export function sigmaMean(points) {
  let x = 0;
  let y = 0;
  for (let i = 0; i < points.length; i++) {
    x += WM[i] * points[i][0];
    y += WM[i] * points[i][1];
  }
  return [x, y];
}

// Weighted covariance of `points` about `mean`.
export function sigmaCovariance(points, mean) {
  let a = 0;
  let b = 0;
  let d = 0;
  for (let i = 0; i < points.length; i++) {
    const dx = points[i][0] - mean[0];
    const dy = points[i][1] - mean[1];
    a += WC[i] * dx * dx;
    b += WC[i] * dx * dy;
    d += WC[i] * dy * dy;
  }
  return symmetrize([a, b, b, d]);
}

// Weighted cross-covariance between two point sets about their means.
// This is the term that becomes "P C-transpose" in the linear case and
// is what the UKF's gain is built from without ever forming a C.
export function sigmaCrossCovariance(xs, xMean, zs, zMean) {
  let a = 0;
  let b = 0;
  let c = 0;
  let d = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx0 = xs[i][0] - xMean[0];
    const dx1 = xs[i][1] - xMean[1];
    const dz0 = zs[i][0] - zMean[0];
    const dz1 = zs[i][1] - zMean[1];
    a += WC[i] * dx0 * dz0;
    b += WC[i] * dx0 * dz1;
    c += WC[i] * dx1 * dz0;
    d += WC[i] * dx1 * dz1;
  }
  return [a, b, c, d];
}
