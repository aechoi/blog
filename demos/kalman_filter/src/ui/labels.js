// Every symbol shown anywhere in the UI, built from the current step
// index so the subscripts advance with the Step buttons.
//
// The demo used to hard-code "x₀" and "x₁". That is only right on the
// first step: walk forward three times and the plot still claimed to be
// showing x₀ while the filter was at x₃, which quietly contradicts the
// trail of past states drawn right next to it. Deriving the labels from
// one counter means the plot, the legend, the hover captions and the
// numeric readout can never disagree about which step you are on.

const SUB = "₀₁₂₃₄₅₆₇₈₉";

export function sub(n) {
  return String(n)
    .split("")
    .map((d) => SUB[Number(d)] ?? d)
    .join("");
}

// `k` is the number of committed steps: the cycle on screen runs from
// state k to state k+1.
//
// `linear` switches the name of the flow image. On a linear model the
// transition really is a matrix and "A x" is the honest label; on a
// curved one there is no A, and writing one would assert the very
// approximation the nonlinear models exist to question. The flow map
// gets its usual name there instead.
export function labelsFor(k, linear = true) {
  const a = sub(k);
  const b = sub(k + 1);
  return {
    x0: `x${a}`,
    flowed: linear ? `A x${a}` : `φ(x${a})`,
    x1: `x${b}`,
    xhat0: `x̂${a}`,
    xpred: `x̂${b}⁻`,
    xpost: `x̂${b}⁺`,
    z: `z${b}`,
    P0: `P${a}`,
    Ppred: `P${b}⁻`,
    Ppost: `P${b}⁺`,
    Q: "Q",
    R: "R",
    // The sigma set belongs to the prior it was drawn from.
    sigma: `χ${a}`,
    sigmaPred: `φ(χ${a})`,
    // The process noise acts on the transition out of step k; the
    // measurement noise belongs to the observation taken at k+1.
    w: `w${a}`,
    v: `v${b}`,
  };
}
