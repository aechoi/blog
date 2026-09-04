// The dynamics catalog. Every model is defined in CONTINUOUS time as
// xdot = F x, and the filter's discrete transition is A = expm(F * dt).
//
// That indirection is the whole reason the vector field means anything:
// the arrows and streamlines drawn on the state plot are F evaluated on
// a grid, so they show the exact flow that A advances along. Defining
// the models directly as a discrete A instead would leave the picture
// and the filter describing two different systems, and the truth would
// visibly fail to follow the streamlines it's drawn on top of.
//
// All are linear and homogeneous (no affine offset), which keeps the
// Kalman filter exactly optimal — whatever the posterior ellipse shows
// is the true posterior, not an approximation.

export const MODELS = [
  {
    id: "spiral-sink",
    name: "Stable spiral",
    F: [-0.35, -1.6, 1.6, -0.35],
  },
  {
    id: "spiral-source",
    name: "Unstable spiral",
    F: [0.3, -1.6, 1.6, 0.3],
  },
  {
    id: "center",
    name: "Center (pure rotation)",
    F: [0, -1.6, 1.6, 0],
  },
  {
    id: "saddle",
    name: "Saddle",
    F: [0.9, 0.4, 0.4, -0.9],
  },
  {
    id: "stable-node",
    name: "Stable node",
    F: [-1.4, 0, 0, -0.45],
  },
  {
    id: "shear",
    name: "Constant velocity (shear)",
    F: [0, 1, 0, 0],
  },
  {
    id: "damped-oscillator",
    name: "Damped oscillator",
    F: [0, 1, -2.2, -0.5],
  },
];

export function modelById(id) {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

// The continuous-time velocity field, for the arrows and the advected
// particles. Same F the filter discretizes, evaluated pointwise.
export function fieldAt(F, x, y) {
  return [F[0] * x + F[1] * y, F[2] * x + F[3] * y];
}
