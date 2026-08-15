// Two modes for the live position controls (polar plot + az/el/r sliders),
// named after the standard DAW automation terms:
//
// - "touch": once you release a control, the position at the playhead
//   just reflects whatever's already recorded in the path there (an old
//   take, or the default). This is the behavior everything already had.
// - "latch" (default): once you release a control, that channel holds at
//   the value you left it — overwriting the path forward from there —
//   until you touch that channel again. This is what lets you re-record a
//   multi-channel trajectory one channel at a time: place azimuth and let
//   go, it stays put; now drag elevation without azimuth snapping back to
//   whatever the old take had there. Defaulted on since that's the more
//   common workflow (building a trajectory channel-by-channel) — touch is
//   there for when you want to preview/nudge without disturbing a take
//   you already like.
//
// Controls call notifyEditStart(channel) on pointerdown (releasing any
// existing hold on that channel back to the drag itself) and
// notifyEdited(channel, value) on pointerup (establishing the new hold, if
// in latch mode). The actual continuous forward-writing while nothing is
// being dragged happens here, on every playhead-changed tick — the same
// "fill any gap since we last wrote" approach the draw tools use, so a
// dropped frame doesn't leave a hole in the held channel.
export function createLatchController(store) {
  let mode = "latch";
  const held = { az: null, el: null, r: null };
  const lastWrittenTime = { az: null, el: null, r: null };

  function clearAllHolds() {
    held.az = held.el = held.r = null;
    lastWrittenTime.az = lastWrittenTime.el = lastWrittenTime.r = null;
  }

  function setMode(newMode) {
    if (newMode !== "touch" && newMode !== "latch") return;
    mode = newMode;
    if (mode === "touch") clearAllHolds();
  }

  function getMode() {
    return mode;
  }

  function notifyEditStart(channel) {
    held[channel] = null;
    lastWrittenTime[channel] = null;
  }

  function notifyEdited(channel, value) {
    if (mode !== "latch") return;
    held[channel] = value;
    lastWrittenTime[channel] = store.state.playhead;
  }

  store.subscribe((event) => {
    if (event.type !== "playhead-changed" || !store.state.path) return;
    const t = store.state.playhead;

    // A manual scrub while paused also fires playhead-changed, but
    // that's navigation, not "time passing under the held control", so
    // it shouldn't paint over whatever's already there. Still resync
    // lastWrittenTime to the scrubbed-to position (without painting) so
    // that resuming playback later fills forward from there, instead of
    // retroactively painting the whole gap the scrub just jumped over.
    if (!store.state.isPlaying) {
      for (const channel of ["az", "el", "r"]) {
        if (held[channel] !== null) lastWrittenTime[channel] = t;
      }
      return;
    }

    for (const channel of ["az", "el", "r"]) {
      if (held[channel] === null) continue;
      const from = lastWrittenTime[channel] ?? t;
      lastWrittenTime[channel] = t;
      if (t === from) continue;
      const value = held[channel];
      store.paintRange(channel, from, t, () => value);
    }
  });

  return { setMode, getMode, notifyEditStart, notifyEdited };
}
