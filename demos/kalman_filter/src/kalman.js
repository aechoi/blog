import {
  I2,
  matmul,
  matvec,
  transpose,
  madd,
  msub,
  inv,
  vadd,
  vsub,
  symmetrize,
  expm,
} from "./linalg.js";
import { propagate, flowPoint } from "./flow.js";
import {
  sigmaPoints,
  sigmaMean,
  sigmaCovariance,
  sigmaCrossCovariance,
} from "./unscented.js";

// One predict/update cycle, computed from scratch on every change.
//
// The measurement model is fixed at C = I: measurements live in state
// space, so they can be drawn as points on the very same axes as the
// state. That is what makes the update step legible here — the
// innovation is a literal arrow between two dots on one plot, rather
// than a quantity in some other space you have to imagine.
//
// The two "true" quantities are NOT sampled here. They're derived from
// the noise realizations w and v held in the store, because those are
// what the user is really manipulating when they drag the true next
// state or the measurement (see store.js). Sampling belongs to the step
// commit, not to the recompute.
//
// Three filters share this one function, and effectively differ in one
// place: what the PREDICT step does to the prior. Because C = I, the
// measurement model is linear and perfectly known, so the update cannot
// tell them apart — the UKF's sigma-point gain provably comes out equal
// to the Kalman gain here. That is an honest consequence of the choice
// that makes this demo drawable (measurements living in state space, so
// the innovation is an arrow between two dots), and it is worth stating
// plainly rather than hiding behind three copies of the same algebra:
// on these models, the filters are three answers to ONE question, which
// is what a curved flow does to a Gaussian.

export const FILTERS = [
  { id: "kf", name: "KF — Kalman" },
  { id: "ekf", name: "EKF — extended" },
  { id: "ukf", name: "UKF — unscented" },
];

export function filterById(id) {
  return FILTERS.find((f) => f.id === id) ?? FILTERS[0];
}

// The point the plain KF linearizes about, once and for all. Every model
// in the catalog has an equilibrium here, which is what makes it the
// defensible choice: it is the operating point the system is nominally
// sitting at, and linearizing about it is what "just use a Kalman
// filter" means in practice on a nonlinear plant.
const ORIGIN = [0, 0];

// --- the three predict steps -------------------------------------------
//
// Each returns the predicted mean and covariance, plus whatever it used
// to get there, so the readout and the plot can show the actual
// approximation rather than a description of one.

// KF. ONE transition matrix, fixed for the whole run.
//
// On a linear model that is the whole truth: the flow map really is
// expm(F*dt) everywhere, and the filter is exactly optimal.
//
// On a curved one it is the textbook engineering compromise -- linearize
// about the nominal operating point and ship it. J(0) is the Jacobian at
// the equilibrium, and this A is computed from it no matter where the
// state has since wandered. That is precisely the assumption the EKF
// drops by relinearizing at the mean each step, so running the two
// against the same trajectory is the cleanest way to see what
// relinearizing actually buys: near the origin they agree, and out where
// the flow no longer resembles its linearization at the origin, the KF
// goes confidently wrong -- a tight ellipse in the wrong place, which is
// the failure mode worth recognising.
function predictKF(model, dt, xHat, P, Q) {
  const A = expm(model.J(ORIGIN), dt);
  return {
    A,
    xPred: matvec(A, xHat),
    PPred: symmetrize(madd(matmul(matmul(A, P), transpose(A)), Q)),
  };
}

// EKF. The mean rides the true flow -- there is no reason to degrade it,
// and pushing it through a linearization instead is a real (and common)
// implementation error that biases the estimate on any curved flow.
// Only the COVARIANCE is linearized, through the Jacobian of the flow
// map at the prior mean.
function predictEKF(model, dt, xHat, P, Q) {
  const { x: xPred, A } = propagate(model, xHat, dt);
  return {
    A,
    xPred,
    PPred: symmetrize(madd(matmul(matmul(A, P), transpose(A)), Q)),
  };
}

// UKF. No derivative anywhere: place points at a known spread, push each
// one through the real flow, and refit.
//
// Where this beats the EKF is exactly where the flow's curvature varies
// across the WIDTH of the prior -- the EKF's Jacobian is a statement
// about an infinitesimal neighbourhood of the mean and cannot know how
// wide the prior is, while the sigma points are placed by P and so feel
// it. Where the prior is tight, the two agree closely, which is itself
// worth being able to see.
function predictUKF(model, dt, xHat, P, Q) {
  const prior = sigmaPoints(xHat, P);
  const flowed = prior.map((p) => flowPoint(model, p, dt));
  const xPred = sigmaMean(flowed);
  return {
    A: null,
    xPred,
    PPred: symmetrize(madd(sigmaCovariance(flowed, xPred), Q)),
    sigmaPrior: prior,
    sigmaPred: flowed,
  };
}

const PREDICT = { kf: predictKF, ekf: predictEKF, ukf: predictUKF };

// --- the update ------------------------------------------------------
//
// Both forms end at the same Joseph-form covariance. Joseph is valid for
// ANY gain, not only the optimal one, which is what lets the unscented
// path keep it: (I-KC) P (I-KC)' + K R K' is an identity in K. The
// textbook (I-KC)P is algebraically equal at the optimal gain but is not
// symmetry- or PSD-preserving under roundoff, and this thing is
// deliberately driven into the regimes where that matters -- the
// covariance handles let you drag an ellipse down to a sliver, and the
// dt control lets the transition get stiff.
function josephPosterior(PPred, R, K) {
  const IKC = msub(I2, K); // I - K C, with C = I
  return symmetrize(
    madd(matmul(matmul(IKC, PPred), transpose(IKC)), matmul(matmul(K, R), transpose(K))),
  );
}

function updateLinear(xPred, PPred, R, z) {
  const S = symmetrize(madd(PPred, R)); // innovation covariance, C P C' + R
  const K = matmul(PPred, inv(S)); // P C' S^-1
  const innovation = vsub(z, xPred); // z - C xPred
  return {
    S,
    K,
    innovation,
    xPost: vadd(xPred, matvec(K, innovation)),
    PPost: josephPosterior(PPred, R, K),
  };
}

// The same step with no measurement matrix anywhere: regenerate sigma
// points from the PREDICTED belief, push them through h (the identity
// here), and read the gain off the resulting covariances.
//
// Regenerating rather than reusing the propagated points from the
// predict step is the standard formulation and matters: Q has been added
// in between, so the propagated points no longer have covariance PPred
// and would understate the spread the measurement is being compared
// against.
function updateUnscented(xPred, PPred, R, z) {
  const xs = sigmaPoints(xPred, PPred);
  const zs = xs; // h(x) = C x = x
  const zMean = sigmaMean(zs);
  const S = symmetrize(madd(sigmaCovariance(zs, zMean), R));
  const Pxz = sigmaCrossCovariance(xs, xPred, zs, zMean);
  const K = matmul(Pxz, inv(S));
  const innovation = vsub(z, zMean);
  return {
    S,
    K,
    innovation,
    xPost: vadd(xPred, matvec(K, innovation)),
    PPost: josephPosterior(PPred, R, K),
  };
}

export function solveStep({ model, filterId, dt, Q, R, xTrue, xHat, P, w, v }) {
  const id = PREDICT[filterId] ? filterId : "kf";

  // --- prediction ---
  const predicted = PREDICT[id](model, dt, xHat, P, Q);
  const { xPred, PPred } = predicted;

  // --- truth advances, along the same flow, plus the process noise draw ---
  // Always the REAL flow, never a filter's idea of it. The truth is what
  // the filters are being judged against, so it has to be independent of
  // which one is selected -- switching filters must change the estimate
  // on screen and nothing else.
  const flowed = flowPoint(model, xTrue, dt);
  const xTrueNext = vadd(flowed, w);

  // --- measurement, with C = I ---
  const z = vadd(xTrueNext, v);

  // --- update ---
  //
  // C = I, so the measurement model is linear and exactly known. The KF
  // and the EKF therefore share one update; the UKF forms its gain from
  // sigma-point statistics instead, which with C = I provably lands on
  // the same numbers (checked in the tests). It is implemented rather
  // than short-circuited because the gain is the half of the UKF that
  // has nothing to do with the flow, and skipping it would leave a
  // "UKF" that is really a UKF predict bolted to a Kalman update.
  const updated = id === "ukf" ? updateUnscented(xPred, PPred, R, z) : updateLinear(xPred, PPred, R, z);
  const { S, K, innovation, xPost, PPost } = updated;

  return {
    filterId: id,
    A: predicted.A,
    flowed,
    xPred,
    PPred,
    xTrueNext,
    z,
    S,
    K,
    innovation,
    xPost,
    PPost,
    sigmaPrior: predicted.sigmaPrior ?? null,
    sigmaPred: predicted.sigmaPred ?? null,
  };
}
