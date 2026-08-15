// Keeps the AudioEngine's HRTF convolver fed with the interpolated filter
// for whatever az/el/r is at the current playhead — subscribes to the
// same store events every other view does, so it updates continuously
// during playback and immediately in response to any live edit (dragging
// the polar plot, a slider, or drawing on a time-series strip while
// paused or playing).
//
// Returns an unsubscribe function, so switching to a different HRTF set
// (a different interpolator) can cleanly stop this one before starting a
// new one instead of leaving a stale subscription feeding the old set's
// filters into the worklet.
export function createLiveConvolution({ store, engine, interpolator }) {
  function update() {
    if (!store.state.path) return;
    const pos = store.getPositionAt(store.state.playhead);
    const { left, right } = interpolator.getIR(pos.az, pos.el, pos.r);
    engine.setFilter(left, right);
  }

  return store.subscribe((event) => {
    if (
      event.type === "audio-loaded" ||
      event.type === "playhead-changed" ||
      event.type === "path-changed"
    ) {
      update();
    }
  });
}
