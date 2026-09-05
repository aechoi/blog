import { MODELS } from "../models.js";
import { FILTERS } from "../kalman.js";
import { GROUPS, stageMatching, groupApplies } from "./groups.js";
import { labelsFor } from "./labels.js";
import { SIGMA_SPREAD } from "../unscented.js";

// Wires the DOM controls to the store and keeps the numeric readout in
// sync. Everything here is one-way into the store; the readout is
// rebuilt from (state, derived) on every emit, same as the canvases.

// "predict" and "update" are the canonical names for the two steps of
// the recursion (the time update and the measurement update).
const STAGES = [
  { id: "predict", label: "predict" },
  { id: "update", label: "update" },
  { id: "complete", label: "complete" },
];

function fmt(x) {
  return (Math.abs(x) < 5e-3 ? 0 : x).toFixed(2);
}

// The trace chain gets an extra digit. At two decimals a contracting
// model's predict step reads "0.72 -> 0.72" -- the contraction of
// A P A-transpose nearly cancels the Q it adds -- and the whole point of showing
// three numbers is lost to rounding.
function fmt3(x) {
  return (Math.abs(x) < 5e-4 ? 0 : x).toFixed(3);
}

function mat(m) {
  return `[${fmt(m[0])}  ${fmt(m[1])}]\n[${fmt(m[2])}  ${fmt(m[3])}]`;
}

export function createControls(root, { store, stateView, noiseScale }) {
  const modelSelect = root.querySelector("#modelSelect");
  for (const m of MODELS) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name;
    modelSelect.append(opt);
  }
  modelSelect.value = store.state.modelId;

  const filterSelect = root.querySelector("#filterSelect");
  for (const f of FILTERS) {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.name;
    filterSelect.append(opt);
  }
  filterSelect.addEventListener("change", () => store.setFilter(filterSelect.value));

  // The legend doubles as the per-group switch, built from the same
  // table the plot draws from so the two cannot drift apart.
  const legend = root.querySelector("#legend");
  const legendButtons = GROUPS.map((group) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.group = group.id;
    const swatch = document.createElement("i");
    swatch.className = "swatch";
    swatch.style.background = group.color;
    const text = document.createTextNode("");
    btn.append(swatch, text);
    btn._text = text;
    btn.addEventListener("click", () => store.toggleGroup(group.id));
    legend.append(btn);
    return btn;
  });

  const stageToggle = root.querySelector("#stageToggle");
  const stageButtons = STAGES.map((stage) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = stage.label;
    btn.dataset.stage = stage.id;
    btn.addEventListener("click", () => store.setStage(stage.id));
    stageToggle.append(btn);
    return btn;
  });

  modelSelect.addEventListener("change", () => {
    stateView.resetField();
    store.update({ modelId: modelSelect.value });
  });

  const stepBackBtn = root.querySelector("#stepBackBtn");
  stepBackBtn.addEventListener("click", () => store.stepBack());
  root.querySelector("#stepBtn").addEventListener("click", () => store.commitStep());
  root.querySelector("#resampleBtn").addEventListener("click", () => store.resampleNoise());
  root.querySelector("#resetBtn").addEventListener("click", () => {
    store.reset();
    stateView.resetField();
    stateView.resetView();
    noiseScale.reset();
  });

  const readout = root.querySelector("#readout");

  function render(state, derived) {
    // Steps committed so far. Everything labelled below is indexed off
    // this, so it is read once at the top rather than re-derived per
    // section.
    const k = state.history.length;
    const model = store.model();
    const l = labelsFor(k, model.linear);

    modelSelect.value = state.modelId;
    filterSelect.value = state.filterId;
    // A stage button lights up only while the visible set still matches
    // its preset exactly. Toggling a legend entry away from a preset
    // therefore clears the highlight rather than leaving the UI claiming
    // a stage it is no longer showing.
    const active = stageMatching(state.visibleGroups);
    for (const btn of stageButtons) {
      btn.classList.toggle("active", btn.dataset.stage === active);
    }
    for (const btn of legendButtons) {
      const group = GROUPS.find((g) => g.id === btn.dataset.group);
      // A switch for something the current filter does not have is worse
      // than no switch: it would toggle a group that draws nothing.
      const applies = groupApplies(group.id, state.filterId);
      btn.hidden = !applies;
      if (!applies) continue;
      btn._text.nodeValue = group.label(k, model.linear);
      const on = state.visibleGroups.includes(btn.dataset.group);
      btn.classList.toggle("off", !on);
      btn.setAttribute("aria-pressed", String(on));
    }
    // Nothing to undo at the start of a run, or after Reset.
    stepBackBtn.disabled = state.history.length === 0;
    // The trace chain is the headline number: prediction adds
    // uncertainty (P0 -> P1-, which folds in Q), the measurement removes
    // it (P1- -> P1+). Seeing all three at once is what makes that
    // trade legible.
    const trP0 = state.P[0] + state.P[3];
    const trPred = derived.PPred[0] + derived.PPred[3];
    const trPost = derived.PPost[0] + derived.PPost[3];

    // The transition matrix, when the running filter has one. The UKF
    // forms none at all, so there is nothing honest to print in that
    // slot; it gets the sigma spread instead, which is the quantity
    // actually doing the corresponding work.
    const transitionLabel = model.linear
      ? "A = expm(F·dt)"
      : state.filterId === "kf"
        ? "A = expm(J(0)·dt)"
        : `∂φ/∂x at ${l.xhat0}`;
    const transitionRow = derived.A
      ? `<div class="ro-item"><span>${transitionLabel}</span><pre>${mat(derived.A)}</pre></div>`
      : `<div class="ro-item"><span>sigma points</span><pre>5 at ±${SIGMA_SPREAD.toFixed(2)}σ
no Jacobian formed</pre></div>`;

    readout.innerHTML = `
      ${transitionRow}
      <div class="ro-item"><span>Kalman gain K</span><pre>${mat(derived.K)}</pre></div>
      <div class="ro-item"><span>innovation ${l.z} − ${l.xpred}</span><pre>[${fmt(derived.innovation[0])}  ${fmt(derived.innovation[1])}]</pre></div>
      <div class="ro-item"><span>tr ${l.P0} → tr ${l.Ppred} → tr ${l.Ppost}</span><pre>${fmt3(trP0)} → ${fmt3(trPred)} → ${fmt3(trPost)}</pre></div>
      <div class="ro-item"><span>steps taken</span><pre>${state.history.length}</pre></div>
    `;
  }

  store.subscribe(render);
  render(store.state, store.derived);
}
