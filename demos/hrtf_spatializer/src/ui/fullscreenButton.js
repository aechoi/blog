// A small fullscreen toggle in the corner of the page, mirroring the
// em_field_visualizer demo's own fullscreen button: fullscreens
// document.documentElement rather than requiring the embedding page (e.g.
// the iframe wrapper on the blog) to drive it from outside. That matters
// for more than symmetry — an element fullscreened from *inside* its own
// document paints using that document's own CSS (including the
// color-scheme/background rules below), whereas fullscreening the
// <iframe> element from the parent page leaves the fullscreen backdrop's
// color up to the parent's environment (which is how a viewer's
// browser-level dark mode was leaking in and reflowing all the native
// form controls to dark, unstyled colors).
// Inline SVG icons: the ⛶ / ⤢ symbol characters used before aren't in many
// fonts (⛶ especially) and showed up as empty boxes.
const FULLSCREEN_ICON =
  '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8V3h5M12 3h5v5M17 12v5h-5M8 17H3v-5"/></svg>';
const EXIT_FULLSCREEN_ICON =
  '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v5H3M17 8h-5V3M12 17v-5h5M3 12h5v5"/></svg>';

export function createFullscreenButton() {
  const target = document.documentElement;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "fullscreenBtn";
  btn.title = "Toggle fullscreen";
  btn.setAttribute("aria-label", "Toggle fullscreen");
  btn.innerHTML = FULLSCREEN_ICON;
  btn.addEventListener("click", () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      target.requestFullscreen().catch(() => {});
    }
  });
  document.addEventListener("fullscreenchange", () => {
    btn.innerHTML = document.fullscreenElement ? EXIT_FULLSCREEN_ICON : FULLSCREEN_ICON;
  });
  document.body.appendChild(btn);
  return btn;
}
