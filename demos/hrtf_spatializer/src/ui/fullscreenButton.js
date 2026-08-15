// A small ⛶/⤢ toggle in the corner of the page, mirroring the
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
export function createFullscreenButton() {
  const target = document.documentElement;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "fullscreenBtn";
  btn.title = "Toggle fullscreen";
  btn.textContent = "⛶";
  btn.addEventListener("click", () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      target.requestFullscreen().catch(() => {});
    }
  });
  document.addEventListener("fullscreenchange", () => {
    btn.textContent = document.fullscreenElement ? "⤢" : "⛶";
  });
  document.body.appendChild(btn);
  return btn;
}
