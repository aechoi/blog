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
export function solveStep({ F, dt, Q, R, xTrue, xHat, P, w, v }) {
  const A = expm(F, dt);

  // --- prediction ---
  const xPred = matvec(A, xHat);
  const PPred = symmetrize(madd(matmul(matmul(A, P), transpose(A)), Q));

  // --- truth advances, by the same dynamics plus the process noise draw ---
  const xTrueNext = vadd(matvec(A, xTrue), w);

  // --- measurement, with C = I ---
  const z = vadd(xTrueNext, v);

  // --- update ---
  const S = symmetrize(madd(PPred, R)); // innovation covariance, C P C' + R
  const K = matmul(PPred, inv(S)); // P C' S^-1
  const innovation = vsub(z, xPred); // z - C xPred
  const xPost = vadd(xPred, matvec(K, innovation));

  // Joseph form: (I-KC) P (I-KC)' + K R K'. The textbook (I-KC)P is
  // algebraically identical but is not symmetry- or PSD-preserving
  // under roundoff, and this thing is deliberately driven into the
  // regimes where that matters — the covariance handles let you drag
  // an ellipse down to a sliver, and the dt slider lets A get stiff.
  const IKC = msub(I2, K);
  const PPost = symmetrize(
    madd(matmul(matmul(IKC, PPred), transpose(IKC)), matmul(matmul(K, R), transpose(K))),
  );

  return { A, xPred, PPred, xTrueNext, z, S, K, innovation, xPost, PPost };
}
