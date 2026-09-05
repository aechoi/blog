import { FilterStore } from "./state/store.js";
import { createStateView } from "./ui/stateView.js";
import { createNoiseView } from "./ui/noiseView.js";
import { createNoiseScale } from "./ui/noiseScale.js";
import { createControls } from "./ui/controls.js";

const store = new FilterStore();

const stateView = createStateView(document.querySelector("#stateCanvas"), { store });
// One scale object, two panels: see ui/noiseScale.js.
const noiseScale = createNoiseScale(store);
createNoiseView(document.querySelector("#qCanvas"), { store, which: "Q", scale: noiseScale });
createNoiseView(document.querySelector("#rCanvas"), { store, which: "R", scale: noiseScale });
createControls(document, { store, stateView, noiseScale });

// Same fullscreen affordance the other demos use, so the thing is
// usable at a sensible size from inside a Quarto iframe.
const fsBtn = document.querySelector("#fullscreenBtn");
fsBtn.addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
});

// Exposed for poking at the filter from the console while developing.
window.kf = store;
