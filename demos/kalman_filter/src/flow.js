import { I2, matmul, matvec, expm } from "./linalg.js";

// The discrete transition, for both families of model in models.js:
// where does a point go after dt, and what does the map do to a small
// neighbourhood of it.
//
// Those two answers are what every filter here is built from. The mean
// propagates by the first; the covariance propagates by the second.
// Keeping them in one function is deliberate -- they have to describe
// the SAME map or the predicted ellipse will not sit where the
// predicted mean does, and a mismatch there looks exactly like a filter
// bug when it is really an integration mismatch.

// Substep size for the nonlinear integrator. Small enough that RK4's
// error over one dt is far below anything the plot can show, which
// matters because this integrator defines the "truth" the filters are
// then judged against -- if it were sloppy, its error would masquerade
// as filter error.
const MAX_SUBSTEP = 0.02;

// One RK4 step of the joint system (x, Phi):
//
//     xdot   = f(x)
//     Phidot = J(x) Phi,        Phi(0) = I
//
// The second line is the variational equation, and integrating it
// ALONGSIDE the state is what makes the returned Jacobian the exact
// derivative of the returned flow map (to the integrator's accuracy)
// rather than an independent approximation of it.
//
// The tempting shortcut is expm(J(x0)*dt) -- the Jacobian frozen at the
// starting point. That is a different matrix whenever the Jacobian
// varies along the trajectory, which on a curved flow is always, and it
// silently mis-sizes the predicted ellipse in a way that is impossible
// to distinguish from the EKF's own approximation error. The whole
// point of this demo is to show that error honestly, so it must not be
// contaminated by a second one.
function rk4Joint(model, x, Phi, h) {
  const deriv = (xs, Ps) => [model.f(xs), matmul(model.J(xs), Ps)];
  const axpy = (a, da, b, db, s) => [
    [a[0] + s * da[0], a[1] + s * da[1]],
    [b[0] + s * db[0], b[1] + s * db[1], b[2] + s * db[2], b[3] + s * db[3]],
  ];

  const [k1x, k1P] = deriv(x, Phi);
  const [x2, P2] = axpy(x, k1x, Phi, k1P, h / 2);
  const [k2x, k2P] = deriv(x2, P2);
  const [x3, P3] = axpy(x, k2x, Phi, k2P, h / 2);
  const [k3x, k3P] = deriv(x3, P3);
  const [x4, P4] = axpy(x, k3x, Phi, k3P, h);
  const [k4x, k4P] = deriv(x4, P4);

  const w = h / 6;
  return {
    x: [
      x[0] + w * (k1x[0] + 2 * k2x[0] + 2 * k3x[0] + k4x[0]),
      x[1] + w * (k1x[1] + 2 * k2x[1] + 2 * k3x[1] + k4x[1]),
    ],
    Phi: [
      Phi[0] + w * (k1P[0] + 2 * k2P[0] + 2 * k3P[0] + k4P[0]),
      Phi[1] + w * (k1P[1] + 2 * k2P[1] + 2 * k3P[1] + k4P[1]),
      Phi[2] + w * (k1P[2] + 2 * k2P[2] + 2 * k3P[2] + k4P[2]),
      Phi[3] + w * (k1P[3] + 2 * k2P[3] + 2 * k3P[3] + k4P[3]),
    ],
  };
}

// Where `x` lands after `dt`, and the Jacobian of that map at `x`.
//
// Linear models take the exact route: the flow map IS expm(F*dt), it is
// its own Jacobian everywhere, and there is no reason to approximate
// something available in closed form. That exactness is also what lets
// the demo claim the Kalman filter is optimal rather than merely good
// on those models.
export function propagate(model, x, dt) {
  if (model.linear) {
    const A = expm(model.F, dt);
    return { x: matvec(A, x), A };
  }
  const steps = Math.max(1, Math.ceil(Math.abs(dt) / MAX_SUBSTEP));
  const h = dt / steps;
  let xs = x;
  let Phi = I2;
  for (let i = 0; i < steps; i++) {
    const next = rk4Joint(model, xs, Phi, h);
    xs = next.x;
    Phi = next.Phi;
  }
  return { x: xs, A: Phi };
}

// Just the mean, for the many places that push a point through the flow
// and have no use for the Jacobian -- the truth, and every sigma point.
export function flowPoint(model, x, dt) {
  return propagate(model, x, dt).x;
}
