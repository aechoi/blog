import { eigSym } from "../linalg.js";
import { SIGMA_K } from "../state/store.js";

// One zoom level shared by the Q and R panels.
//
// The panels are locked to each other, not frozen: both always draw at
// the same world-units-per-pixel, and zooming either one zooms both.
// That is what makes them comparable — if Q's ellipse looks twice the
// size of R's, it is twice the size, and no amount of scrolling can
// make a small covariance masquerade as a large one. Independent
// per-panel scales would silently normalise that difference away, which
// is the one comparison these two panels exist to support.
//
// The starting span fits the LARGER of the two covariances, so both are
// on screen at once from the outset.
const PANEL_SIGMA_MARGIN = 2.4;
const MIN_SPAN = 0.01;
const MAX_SPAN = 50;

function spanFor(cov) {
  const eig = eigSym(cov);
  return SIGMA_K * Math.sqrt(Math.max(eig.values[0], 0)) * PANEL_SIGMA_MARGIN;
}

export function createNoiseScale(store) {
  const initial = Math.max(spanFor(store.state.Q), spanFor(store.state.R), 0.12);
  let halfSpan = initial;
  const listeners = new Set();

  function emit() {
    for (const fn of listeners) fn();
  }

  return {
    get() {
      return halfSpan;
    },
    // `factor` comes straight from a wheel delta; clamped so a fast
    // scroll cannot strand the panels at a uselessly large or small
    // zoom with no ellipse in view to scroll back from.
    zoomBy(factor) {
      halfSpan = Math.min(MAX_SPAN, Math.max(MIN_SPAN, halfSpan * factor));
      emit();
    },
    reset() {
      halfSpan = initial;
      emit();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
