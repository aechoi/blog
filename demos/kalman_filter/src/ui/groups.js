import { COLORS } from "./canvas.js";
import { labelsFor } from "./labels.js";

// The things on the state plot that switch on and off together.
//
// A group is one *object* in the filter's story. The three truth
// markers are three groups, each worth looking at without the others:
// x_k is the input to the predict step, A x_k is what the dynamics alone
// do to it, and x_{k+1} is the outcome once the noise lands. Conversely
// a mean and its covariance are one belief and always travel together.
//
// Arrows are not group members; they are derived from their endpoints,
// see DERIVED below.
//
// The array order is the legend order, and it follows the causal
// story rather than grouping by colour: the truth's chain first,
// with each noise sitting immediately before the state it produces
// (x_k, A x_k, then Q and w, then x_{k+1}, then z with its R and v),
// and the filter's own chain after it (prior, predicted, posterior).
// Reading down the legend reads the step in the order it happens.
//
// The ids in `members` are the element ids stateView draws with.
export const GROUPS = [
  {
    id: "truth0",
    label: (k) => `${labelsFor(k).x0} initial state`,
    color: COLORS.truthPrev,
    members: ["x0"],
  },
  {
    id: "flowed",
    label: (k) => `${labelsFor(k).flowed} noiseless`,
    color: COLORS.truthFlowed,
    members: ["flowed"],
  },
  {
    id: "process",
    label: (k) => `Q, ${labelsFor(k).w} process noise`,
    color: COLORS.process,
    members: ["Q"],
  },
  {
    id: "truth1",
    label: (k) => `${labelsFor(k).x1} new state`,
    color: COLORS.truthNow,
    members: ["x1"],
  },
  {
    id: "measurement",
    label: (k) => {
      const l = labelsFor(k);
      return `${l.z}, R, ${l.v} measurement`;
    },
    color: COLORS.measurement,
    members: ["z", "R"],
  },
  {
    id: "prior",
    label: (k) => {
      const l = labelsFor(k);
      return `${l.xhat0}, ${l.P0} prior`;
    },
    color: COLORS.prior,
    members: ["xhat0", "P0"],
  },
  {
    id: "predicted",
    label: (k) => {
      const l = labelsFor(k);
      return `${l.xpred}, ${l.Ppred} predicted`;
    },
    color: COLORS.predicted,
    members: ["xpred", "Ppred"],
  },
  {
    id: "posterior",
    label: (k) => {
      const l = labelsFor(k);
      return `${l.xpost}, ${l.Ppost} posterior`;
    },
    color: COLORS.posterior,
    members: ["xpost", "Ppost"],
  },
];

// Elements whose visibility is computed from other elements rather than
// owned by a group: the arrows, which have no switch of their own
// because an arrow is a relationship rather than a thing.
export const DERIVED = {
  // An arrow is a relationship, so it needs BOTH of the things it
  // connects. Tying it to one end left arrows pointing at nothing
  // whenever the far end was switched off.
  "arrow:flow": (vis) => vis("x0") && vis("flowed"),
  "arrow:w": (vis) => vis("flowed") && vis("x1"),
  "arrow:v": (vis) => vis("x1") && vis("z"),
  "arrow:predict": (vis) => vis("xhat0") && vis("xpred"),
  "arrow:correct": (vis) => vis("xpred") && vis("xpost"),
  "arrow:innovation": (vis) => vis("xpred") && vis("z"),
};

// Element id -> group id, built once.
const OWNER = new Map();
for (const g of GROUPS) {
  for (const m of g.members) OWNER.set(m, g.id);
}

export function groupOf(elementId) {
  return OWNER.get(elementId) ?? null;
}

// The single rule for whether anything on the state plot is live.
//
// Both the renderer and the hit-tester go through here so they cannot
// disagree about what is switched on. DERIVED entries resolve through
// this same function, so a derived element could depend on another one
// if that ever became useful.
export function isVisible(elementId, visibleGroups) {
  const derived = DERIVED[elementId];
  if (derived) return derived((id) => isVisible(id, visibleGroups));
  const group = groupOf(elementId);
  return group === null || visibleGroups.includes(group);
}

// The stage buttons are presets over these groups, not a separate
// mechanism: picking a stage selects a set, and clicking a legend entry
// edits that set. So the two controls can never disagree about what is
// on screen, and a stage button lights up exactly when the current set
// matches its preset.
export const STAGE_PRESETS = {
  predict: ["truth0", "flowed", "truth1", "prior", "process", "predicted"],
  update: ["truth1", "predicted", "measurement", "posterior"],
  complete: GROUPS.map((g) => g.id),
};

export function stageMatching(visible) {
  const key = [...visible].sort().join(",");
  return (
    Object.keys(STAGE_PRESETS).find((id) => [...STAGE_PRESETS[id]].sort().join(",") === key) ?? null
  );
}
