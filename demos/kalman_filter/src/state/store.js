import { solveStep } from "../kalman.js";
import { modelById } from "../models.js";
import { STAGE_PRESETS } from "../ui/groups.js";
import { vadd, vsub, sampleGaussian, symmetrize } from "../linalg.js";

// Every ellipse in the demo is a 1-sigma contour. This is a DISPLAY
// choice only: it scales every ellipse and every drag handle together
// and never touches the covariances themselves.
//
// Worth knowing what it means, since the 1D intuition misleads here — a
// 1-sigma ellipse encloses about 39% of a 2D Gaussian, not 68%. The 95%
// contour would be at k = sqrt(chi2_2(0.95)) = 2.4477.
export const SIGMA_K = 1;

// How many committed steps stay undoable. A snapshot is five short
// arrays, so this is negligible memory; the drawn trail is capped much
// lower separately, since a hundred faded dots is clutter, not context.
const MAX_HISTORY = 500;

const DEFAULTS = {
  modelId: "spiral-sink",
  // Opens on the case where all three filters agree exactly, which is
  // the right place to start from: it establishes that they are three
  // answers to the same question before the nonlinear models make them
  // disagree.
  filterId: "kf",
  dt: 0.35,
  // Placed so that one full cycle -- x0, its flowed image, x1, z, and
  // all four ellipses -- sits inside the default view with the origin
  // still on screen, since the origin is where every one of these
  // linear flows is anchored. The prior mean is not a constant: see
  // seedEstimate().
  xTrue: [1.6, 0.4],
  P: [0.5, 0.16, 0.16, 0.22],
  Q: [0.1, -0.03, -0.03, 0.06],
  R: [0.22, 0.1, 0.1, 0.3],
};

// The prior mean is drawn from the prior itself rather than being a
// fixed offset from the truth: x-hat0 ~ N(x0, P0), which is exactly the
// claim P0 is making. A hand-placed constant tends to sit implausibly
// far out in the tail, so the opening picture shows an estimate the
// stated covariance would essentially never produce -- the wrong first
// impression for the one number the ellipse is there to communicate.
function seedEstimate(xTrue, P) {
  return vadd(xTrue, sampleGaussian(P));
}

export class FilterStore {
  constructor() {
    this.state = {
      modelId: DEFAULTS.modelId,
      filterId: DEFAULTS.filterId,
      dt: DEFAULTS.dt,
      xTrue: [...DEFAULTS.xTrue],
      xHat: seedEstimate(DEFAULTS.xTrue, DEFAULTS.P),
      P: [...DEFAULTS.P],
      Q: [...DEFAULTS.Q],
      R: [...DEFAULTS.R],

      // The noise REALIZATIONS, not the covariances. These are the
      // store's source of truth for where the true next state and the
      // measurement sit; both of those are derived (see solveStep).
      //
      // Holding w and v fixed — rather than holding the absolute
      // positions of xTrueNext and z fixed — is what makes dragging
      // feel physical: drag the initial true state and the next true
      // state follows the flow, carrying the measurement along with it,
      // because the DRAW from each noise distribution hasn't changed.
      // Only the thing the draws are relative to has.
      w: [0.12, -0.2],
      v: [0.3, 0.26],

      // Which groups of the state plot are shown, as group ids from
      // ui/groups.js. The stage buttons are presets over this set and
      // the legend entries toggle individual members, so there is one
      // source of truth for what is on screen rather than two controls
      // that could disagree.
      visibleGroups: [...STAGE_PRESETS.complete],

      // Undo stack: one snapshot per committed step, holding everything
      // that step overwrote. It doubles as the trail the plot draws, so
      // there is a single record of where the filter has been rather
      // than two that can disagree.
      history: [],

      // Redo stack of NOISE DRAWS only, pushed by stepBack and consumed
      // by commitStep.
      //
      // Stepping back and forward again has to retrace the same
      // trajectory, or the two buttons are not inverses and the whole
      // point of walking a step is lost -- you would be comparing
      // against a different roll of the dice each time. What is
      // remembered is deliberately just the draws, not the resulting
      // state: the coin flips for a step you have already visited stay
      // flipped, but they are still applied to whatever the state
      // actually is now. So if you step back, drag the truth somewhere
      // else, and step forward again, you see that same draw acting on
      // the new situation -- consistent with how w and v are held fixed
      // everywhere else in this demo. Stepping into a step never
      // visited finds the stack empty and samples fresh.
      redo: [],
    };
    this.listeners = new Set();
    this.derived = null;
    this.recompute();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    for (const listener of this.listeners) listener(this.state, this.derived);
  }

  model() {
    return modelById(this.state.modelId);
  }

  setFilter(filterId) {
    this.update({ filterId });
  }

  recompute() {
    const s = this.state;
    this.derived = solveStep({
      model: this.model(),
      filterId: s.filterId,
      dt: s.dt,
      Q: s.Q,
      R: s.R,
      xTrue: s.xTrue,
      xHat: s.xHat,
      P: s.P,
      w: s.w,
      v: s.v,
    });
  }

  update(patch) {
    Object.assign(this.state, patch);
    this.recompute();
    this.emit();
  }

  // --- the two coupled drags -------------------------------------------
  //
  // Each of these has a partner that writes the same underlying degree
  // of freedom from the other direction: setTrueNext is what the main
  // plot calls when you drag the true next state, setProcessNoise is
  // what the Q panel calls when you drag the w arrow. They agree by
  // construction because they both bottom out in state.w.

  // Dragging the true next state to a point chooses the process noise
  // that would have put it there: w = x1 - A x0. The measurement rides
  // along, since v is unchanged and z = x1 + v.
  setTrueNext(point) {
    this.update({ w: vsub(point, this.derived.flowed) });
  }

  // Dragging the measurement chooses the measurement noise instead:
  // v = z - x1. The true state does not move.
  setMeasurement(point) {
    this.update({ v: vsub(point, this.derived.xTrueNext) });
  }

  setProcessNoise(w) {
    this.update({ w: [...w] });
  }

  setMeasurementNoise(v) {
    this.update({ v: [...v] });
  }

  setCovariance(which, cov) {
    this.update({ [which]: symmetrize(cov) });
  }

  // --- stepping ---------------------------------------------------------
  //
  // Commits the cycle: the posterior becomes the new prior, the true
  // next state becomes the new true state, and fresh noise is drawn
  // from Q and R.
  commitStep() {
    const d = this.derived;
    const s = this.state;
    // Snapshot everything the step is about to overwrite, including the
    // noise draws -- without those, stepping back would land on the same
    // estimates but a different realisation, and the picture would
    // silently differ from the one you stepped away from.
    this.state.history = [
      ...s.history.slice(-MAX_HISTORY),
      {
        xTrue: [...s.xTrue],
        xHat: [...s.xHat],
        P: [...s.P],
        w: [...s.w],
        v: [...s.v],
      },
    ];
    // Reuse the draws for this step if we have been here before.
    const remembered = s.redo.length > 0 ? s.redo[s.redo.length - 1] : null;
    this.state.redo = remembered ? s.redo.slice(0, -1) : s.redo;

    this.update({
      xTrue: [...d.xTrueNext],
      xHat: [...d.xPost],
      P: [...d.PPost],
      w: remembered ? [...remembered.w] : sampleGaussian(s.Q),
      v: remembered ? [...remembered.v] : sampleGaussian(s.R),
    });
  }

  // Exact inverse of commitStep, restoring the snapshot it stored.
  //
  // Note this deliberately restores only the trajectory -- the estimates
  // and the noise draws -- and not the model, dt, Q or R. Those are
  // settings rather than history: if you changed the dynamics and then
  // stepped back, you want the previous state under the dynamics you are
  // now looking at, not a silent revert of a control you just set.
  stepBack() {
    const s = this.state;
    if (s.history.length === 0) return;
    const prev = s.history[s.history.length - 1];
    this.state.history = s.history.slice(0, -1);
    // Hand the draws we are leaving behind to the redo stack, so
    // stepping forward again lands on the same trajectory.
    this.state.redo = [...s.redo, { w: [...s.w], v: [...s.v] }];
    this.update({
      xTrue: [...prev.xTrue],
      xHat: [...prev.xHat],
      P: [...prev.P],
      w: [...prev.w],
      v: [...prev.v],
    });
  }

  resampleNoise() {
    this.update({ w: sampleGaussian(this.state.Q), v: sampleGaussian(this.state.R) });
  }

  reset() {
    this.state.history = [];
    this.state.redo = [];
    this.update({
      xTrue: [...DEFAULTS.xTrue],
      xHat: seedEstimate(DEFAULTS.xTrue, DEFAULTS.P),
      P: [...DEFAULTS.P],
      Q: [...DEFAULTS.Q],
      R: [...DEFAULTS.R],
      w: [0.12, -0.2],
      v: [0.3, 0.26],
    });
  }

  sigmaK() {
    return SIGMA_K;
  }

  setStage(id) {
    this.update({ visibleGroups: [...STAGE_PRESETS[id]] });
  }

  toggleGroup(id) {
    const on = this.state.visibleGroups.includes(id);
    this.update({
      visibleGroups: on
        ? this.state.visibleGroups.filter((g) => g !== id)
        : [...this.state.visibleGroups, id],
    });
  }

  isGroupVisible(id) {
    return this.state.visibleGroups.includes(id);
  }
}
