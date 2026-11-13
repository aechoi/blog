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
// Swap to an "exit" icon while fullscreen. (The icons are inline SVG: the
// ⛶ symbol character used before isn't in many fonts.)
const fsEnterIcon = fsBtn.innerHTML;
const fsExitIcon =
  '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v5H3M17 8h-5V3M12 17v-5h5M3 12h5v5"/></svg>';
document.addEventListener("fullscreenchange", () => {
  const on = Boolean(document.fullscreenElement);
  fsBtn.innerHTML = on ? fsExitIcon : fsEnterIcon;
  fsBtn.title = on ? "Exit fullscreen" : "Fullscreen";
  fsBtn.setAttribute("aria-label", fsBtn.title);
});

// Exposed for poking at the filter from the console while developing.
window.kf = store;
