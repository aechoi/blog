// The dynamics catalog. Every model is defined in CONTINUOUS time as
// xdot = f(x), and the filter's discrete transition is the flow map of
// that field over dt (see flow.js).
//
// That indirection is the whole reason the vector field means anything:
// the streamlines drawn on the state plot are f evaluated on a grid, so
// they show the exact flow the prediction step advances along. Defining
// the models directly as a discrete map instead would leave the picture
// and the filter describing two different systems, and the truth would
// visibly fail to follow the streamlines it is drawn on top of.
//
// Two families live here, and the difference is the point of the whole
// filter selector:
//
//   LINEAR (`linear: true`, carrying a constant matrix F). f(x) = F x,
//   so the flow map is exactly expm(F*dt) and a Gaussian stays Gaussian
//   under it. The Kalman filter is then not an approximation at all --
//   whatever the posterior ellipse shows is the true posterior.
//
//   NONLINEAR. The flow map bends, so it carries the prior ellipse to
//   something that is not an ellipse, and all three filters are
//   approximating that shape by different means: the KF by one Jacobian
//   taken at the origin and never revisited, the EKF by the Jacobian at
//   the current mean, the UKF by pushing sample points through the real
//   map. The gap between those three is what there is to look at.
//
// Every model supplies its own Jacobian analytically. A finite
// difference would be easier and would also quietly become the thing
// under study -- the EKF's whole behaviour is its Jacobian, so an
// approximate one would leave you unable to tell a property of the
// filter from an artefact of the differencing.

const VAN_DER_POL_MU = 1;
const DUFFING_DAMPING = 0.3;
const PENDULUM_DAMPING = 0.25;

// A linear model, written once as F and expanded into the same
// f/J interface every nonlinear model provides.
function linear(id, name, F) {
  return {
    id,
    name,
    linear: true,
    F,
    f: ([x, y]) => [F[0] * x + F[1] * y, F[2] * x + F[3] * y],
    J: () => F,
  };
}

export const MODELS = [
  linear("spiral-sink", "Stable spiral", [-0.35, -1.6, 1.6, -0.35]),
  linear("spiral-source", "Unstable spiral", [0.3, -1.6, 1.6, 0.3]),
  linear("center", "Center (pure rotation)", [0, -1.6, 1.6, 0]),
  linear("saddle", "Saddle", [0.9, 0.4, 0.4, -0.9]),
  linear("stable-node", "Stable node", [-1.4, 0, 0, -0.45]),
  linear("shear", "Constant velocity (shear)", [0, 1, 0, 0]),
  linear("damped-oscillator", "Damped oscillator", [0, 1, -2.2, -0.5]),

  {
    id: "van-der-pol",
    name: "Van der Pol oscillator ◇",
    // The classic self-sustaining oscillator: small orbits are pumped
    // up, large ones are damped down, and everything ends on one limit
    // cycle of amplitude about 2. Nothing linear can do this -- a linear
    // system's orbits are either all growing or all shrinking -- so it
    // is the cleanest case where a filter that believes its own
    // linearization gets the answer qualitatively wrong.
    linear: false,
    f: ([x, y]) => [y, VAN_DER_POL_MU * (1 - x * x) * y - x],
    J: ([x, y]) => [
      0,
      1,
      -2 * VAN_DER_POL_MU * x * y - 1,
      VAN_DER_POL_MU * (1 - x * x),
    ],
  },
  {
    id: "duffing",
    name: "Duffing (double well) ◇",
    // Two stable wells at (±1, 0) separated by a saddle at the origin.
    // The interesting failure lives right at that saddle: a prior
    // straddling it gets pulled apart into two lobes, and no single
    // ellipse can honestly represent that. Watch the EKF and the UKF
    // disagree hardest there.
    linear: false,
    f: ([x, y]) => [y, x - x * x * x - DUFFING_DAMPING * y],
    J: ([x]) => [0, 1, 1 - 3 * x * x, -DUFFING_DAMPING],
  },
  {
    id: "pendulum",
    name: "Damped pendulum ◇",
    // x is the angle, y the angular rate. Linearising sin(x) ~ x is the
    // textbook approximation, and this is where you get to watch the
    // cost of it: near the origin the EKF is excellent, and out past
    // x ~ 2 rad, where sin(x) has turned over and the restoring torque
    // is FALLING with angle, it is not.
    linear: false,
    f: ([x, y]) => [y, -Math.sin(x) - PENDULUM_DAMPING * y],
    J: ([x]) => [0, 1, -Math.cos(x), -PENDULUM_DAMPING],
  },
  {
    id: "hopf",
    name: "Limit cycle (Hopf) ◇",
    // Polar form: rdot = r(1 - r^2), thetadot = 1. An unstable focus at
    // the origin and an attracting circle of radius 1, so the flow
    // squeezes any belief onto a ring. A ring is the one shape a
    // covariance ellipse cannot be, which makes this the sharpest test
    // of what a Gaussian filter can and cannot represent.
    linear: false,
    f: ([x, y]) => {
      const r2 = x * x + y * y;
      return [x - y - x * r2, x + y - y * r2];
    },
    J: ([x, y]) => {
      const r2 = x * x + y * y;
      return [1 - r2 - 2 * x * x, -1 - 2 * x * y, 1 - 2 * x * y, 1 - r2 - 2 * y * y];
    },
  },
];

export function modelById(id) {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

// The continuous-time velocity field, for the arrows and the advected
// particles. Same f the filters propagate along, evaluated pointwise.
export function fieldAt(model, x, y) {
  return model.f([x, y]);
}
