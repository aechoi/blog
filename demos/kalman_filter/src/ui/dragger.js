// Shared pointer-drag wiring for the canvases.
//
// Each view registers its grabbable things as {id, at()} where at()
// returns a SCREEN-space position, recomputed at hit-test time so the
// targets track whatever the last redraw put on screen. On pointerdown
// the nearest target within GRAB_RADIUS wins; the view is then handed
// pointer positions in world space until release.
const GRAB_RADIUS = 13;

export function attachDragger(canvas, {
  targets,
  onGrab,
  onDrag,
  onRelease,
  onHover,
  toWorld,
  onBackgroundDrag,
}) {
  let active = null;
  let panFrom = null; // previous pointer position, for background drags

  function localPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  // `forDrag` excludes hover-only targets (ellipse contours), which
  // exist to be described on hover but are not themselves grabbable --
  // an ellipse is reshaped through its handles. Without the exclusion,
  // pressing anywhere on a contour would start a drag that does nothing
  // and, worse, swallow the pan gesture.
  function pick(p, { forDrag = false } = {}) {
    let best = null;
    let bestDist = Infinity;
    // Later-registered targets win ties, so views can list their
    // broad/background items first and the things most worth grabbing
    // last, and overlapping dots still resolve the way the user expects.
    for (const target of targets()) {
      if (forDrag && target.hoverOnly) continue;
      const limit = target.radius ?? GRAB_RADIUS;
      const d = target.distance ? target.distance(p) : Math.hypot(...vecTo(p, target.at()));
      if (d <= limit && d <= bestDist) {
        best = target;
        bestDist = d;
      }
    }
    return best;
  }

  function vecTo(p, at) {
    return [p[0] - at[0], p[1] - at[1]];
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const p = localPoint(e);
    const target = pick(p, { forDrag: true });

    // Empty space pans the view, when the view supports it. Checked
    // after pick() so that grabbing a handle always wins over panning.
    if (!target) {
      if (!onBackgroundDrag) return;
      e.preventDefault();
      active = { id: "__pan__", kind: "pan", at: () => p };
      panFrom = p;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // see below; capture is optional
      }
      canvas.style.cursor = "grabbing";
      return;
    }

    e.preventDefault();
    active = target;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Capture is an enhancement (it keeps the drag alive when the
      // cursor leaves the canvas), not a requirement. It throws for a
      // pointer id the browser doesn't consider active; letting that
      // propagate would abort pointerdown and kill the drag outright,
      // so the gesture proceeds uncaptured instead.
    }
    onGrab?.(target);
    onDrag?.(target, toWorld(p), p);
  });

  canvas.addEventListener("pointermove", (e) => {
    const p = localPoint(e);
    if (!active) {
      onHover?.(pick(p));
      return;
    }
    if (active.kind === "pan") {
      // Panning is inherently relative: it reports how far the pointer
      // moved since the last event, not where it is, so the world point
      // under the cursor stays pinned to the cursor.
      onBackgroundDrag(p[0] - panFrom[0], p[1] - panFrom[1]);
      panFrom = p;
      return;
    }
    onDrag?.(active, toWorld(p), p);
  });

  function end(e) {
    if (!active) return;
    active = null;
    panFrom = null;
    onRelease?.();
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // capture may already be gone; nothing to clean up
    }
  }
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  // Same safety net as the HRTF demo's views: a release that happens
  // while the window is unfocused never arrives as a pointerup, which
  // would otherwise leave a handle stuck to the cursor forever.
  window.addEventListener("blur", () => {
    if (!active) return;
    active = null;
    panFrom = null;
    onRelease?.();
  });

  canvas.addEventListener("pointerleave", () => onHover?.(null));
}
