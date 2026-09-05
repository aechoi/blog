import { eigSym, covFromEigen } from "../linalg.js";

// Smallest variance a drag is allowed to produce. Without it you can
// pull an axis to exactly zero, which makes the covariance singular —
// the innovation covariance S = P + R stays invertible, but the ellipse
// becomes a line segment you can no longer grab to undo.
const MIN_VARIANCE = 2e-3;

// The two grab points for a covariance: the tip of each k-sigma
// semi-axis. Index 0 is the major axis (eigSym returns descending), so
// handle 0 is always the long one at rest.
export function handlePositions(cov, center, k) {
  const eig = eigSym(cov);
  return eig.vectors.map((v, i) => {
    const r = k * Math.sqrt(Math.max(eig.values[i], 0));
    return [center[0] + v[0] * r, center[1] + v[1] * r];
  });
}

// Begins a handle drag. The captured `otherValue` is the eigenvalue of
// the axis NOT being dragged, held fixed for the whole gesture — so
// pulling on the major axis changes the major axis and the orientation,
// and leaves the minor axis exactly as it was.
export function beginHandleDrag(cov, index) {
  const eig = eigSym(cov);
  return { index, otherValue: eig.values[1 - index] };
}

// Writes a handle drag back into a covariance.
//
// Note there is deliberately no attempt to keep the dragged axis the
// "major" one: pull the long axis in past the short one and they simply
// swap roles. That's safe because the two handles occupy the same pair
// of points either way — the ellipse is the same object — so nothing
// jumps under the cursor, and covFromEigen doesn't care about ordering.
export function applyHandleDrag(drag, center, pointer, k) {
  const dx = pointer[0] - center[0];
  const dy = pointer[1] - center[1];
  const r = Math.hypot(dx, dy);
  if (r < 1e-9) return null;

  const dir = [dx / r, dy / r];
  const value = Math.max((r / k) ** 2, MIN_VARIANCE);
  return covFromEigen(value, Math.max(drag.otherValue, MIN_VARIANCE), dir);
}
