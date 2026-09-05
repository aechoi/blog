// Shared pointer-drag wiring for the canvases.
//
// Each view registers its grabbable things as {id, at()} where at()
// returns a SCREEN-space position, recomputed at hit-test time so the
// targets track whatever the last redraw put on screen. On pointerdown
// the nearest target within GRAB_RADIUS wins; the view is then handed
// pointer positions in world space until release.
//
// A second finger turns the gesture into a pinch, which the view
// receives through onPinch rather than as a drag: on a phone the wheel
// event does not exist, so pinching is the ONLY way to reach the zoom
// that a mouse gets from scrolling, and the canvases set
// `touch-action: none` precisely so the browser hands us the gesture
// instead of page-zooming over the top of the plot.
const GRAB_RADIUS = 13;

export function attachDragger(canvas, {
  targets,
  onGrab,
  onDrag,
  onRelease,
  onHover,
  toWorld,
  onBackgroundDrag,
  onPinch,
}) {
  let active = null;
  let panFrom = null; // previous pointer position, for background drags
  // Live pointers on this canvas, in local coordinates. Only ever more
  // than one on touch; a pinch is exactly the two-entry case.
  const pointers = new Map();
  let pinch = null;

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

  // Midpoint and separation of the pinching pair, which is all a pinch
  // is: the separation gives the zoom factor, the midpoint gives both
  // the point to zoom about and, as it moves, a pan.
  //
  // Keyed by the two pointer IDS rather than "whichever two are down",
  // so a third finger landing mid-pinch changes nothing instead of
  // silently re-pairing the gesture and jumping the zoom.
  function pinchGeometry(ids) {
    const a = pointers.get(ids[0]);
    const b = pointers.get(ids[1]);
    if (!a || !b) return null;
    return {
      mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      dist: Math.hypot(b[0] - a[0], b[1] - a[1]),
    };
  }

  // Drop whatever single-pointer gesture was in flight. A pinch has to
  // take over cleanly, or the finger that started as a drag keeps
  // dragging a handle around underneath the zoom.
  function abandonGesture() {
    if (!active) return;
    active = null;
    panFrom = null;
    onRelease?.();
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const p = localPoint(e);
    pointers.set(e.pointerId, p);

    if (onPinch && !pinch && pointers.size === 2) {
      e.preventDefault();
      abandonGesture();
      const ids = [...pointers.keys()];
      pinch = { ids, ...pinchGeometry(ids) };
      canvas.style.cursor = "default";
      return;
    }
    // A third finger is neither a drag nor a meaningful pinch; the two
    // already down keep the gesture.
    if (pointers.size > 2) return;

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
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);

    if (pinch) {
      const now = pinchGeometry(pinch.ids);
      if (!now) return;
      e.preventDefault();
      // Reported incrementally, like the pan above: a factor since the
      // last event and how far the midpoint travelled, so the view can
      // apply both without knowing where the gesture started.
      if (pinch.dist > 0 && now.dist > 0) {
        onPinch({
          factor: now.dist / pinch.dist,
          mid: now.mid,
          dx: now.mid[0] - pinch.mid[0],
          dy: now.mid[1] - pinch.mid[1],
        });
      }
      pinch = { ids: pinch.ids, ...now };
      return;
    }

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
    pointers.delete(e.pointerId);
    // Lifting out of a pinch does NOT hand the remaining finger a drag:
    // it never sent a pointerdown that picked a target, and starting one
    // mid-gesture would yank whatever it happens to be resting on.
    if (pinch) {
      if (pinch.ids.includes(e.pointerId)) pinch = null;
      return;
    }
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
    pointers.clear();
    pinch = null;
    abandonGesture();
  });

  // Safari on iOS keeps page pinch-zoom as an always-available
  // accessibility gesture and does NOT suppress it for touch-action:
  // none, so without this a pinch over the plot zooms the surrounding
  // page instead of the view. These are Safari's own non-standard
  // gesture events; cancelling them stops the page zoom and leaves the
  // pointer events above -- which is where our own pinch lives --
  // untouched. Absent everywhere else, where they simply never fire.
  if (onPinch) {
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
      canvas.addEventListener(type, (e) => e.preventDefault());
    }
  }

  canvas.addEventListener("pointerleave", () => onHover?.(null));
}
