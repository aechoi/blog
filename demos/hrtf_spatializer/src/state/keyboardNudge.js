// Physical-key hotkeys for nudging az/el/r: A/D or Left/Right for azimuth,
// W/S or Up/Down for elevation, Q/E for radius in/out. Keyed off
// KeyboardEvent.code (the physical key position, independent of the
// active keyboard layout) rather than .key, so this lands on the same
// WASD/QE block regardless of layout — Dvorak included — the same way a
// game's WASD movement does.
//
// Driven by its own rAF loop rather than the store's playhead-changed
// tick, so holding a key nudges the *current* position even while paused
// (mouse drags already behave this way — see e.g. radiusSliderView.js)
// and paints a moving trajectory across the playhead while
// playing/recording, using the same paint-since-last-write technique
// every drag-based control here uses to avoid leaving gaps on a slow tick.
const CHANNELS = {
  az: {
    negative: ["KeyA", "ArrowLeft"],
    positive: ["KeyD", "ArrowRight"],
    min: -180,
    max: 180,
    wrap: true,
    ratePerSecond: 90,
  },
  el: {
    negative: ["KeyS", "ArrowDown"],
    positive: ["KeyW", "ArrowUp"],
    min: -90,
    max: 90,
    wrap: false,
    ratePerSecond: 60,
  },
  r: {
    negative: ["KeyQ"], // in, toward the head
    positive: ["KeyE"], // out, away from the head
    min: 0.1,
    max: 5,
    wrap: false,
    ratePerSecond: 1,
  },
};

const CODE_TO_CHANNEL = new Map();
for (const [channel, { negative, positive }] of Object.entries(CHANNELS)) {
  for (const code of [...negative, ...positive]) CODE_TO_CHANNEL.set(code, channel);
}

const FOCUSABLE_CONTROLS = new Set(["INPUT", "BUTTON", "SELECT", "TEXTAREA"]);

function wrapValue(v, min, max) {
  const range = max - min;
  return min + (((v - min) % range) + range) % range;
}

function clampValue(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function createKeyboardNudge({ store, latch }) {
  const heldCodes = new Set();
  const active = {}; // channel -> { target, lastWrittenTime, lastTickAt, rafId }

  function isChannelHeld(channel) {
    const { negative, positive } = CHANNELS[channel];
    return negative.some((c) => heldCodes.has(c)) || positive.some((c) => heldCodes.has(c));
  }

  function channelVelocitySign(channel) {
    const { negative, positive } = CHANNELS[channel];
    const neg = negative.some((c) => heldCodes.has(c));
    const pos = positive.some((c) => heldCodes.has(c));
    return (pos ? 1 : 0) - (neg ? 1 : 0);
  }

  function startChannel(channel) {
    if (active[channel] || !store.state.path) return;
    const { min, max } = CHANNELS[channel];
    const state = {
      target: clampValue(store.getPositionAt(store.state.playhead)[channel], min, max),
      lastWrittenTime: store.state.playhead,
      lastTickAt: performance.now(),
      rafId: null,
    };
    active[channel] = state;
    latch?.notifyEditStart(channel);

    function tick() {
      const now = performance.now();
      const dt = (now - state.lastTickAt) / 1000;
      state.lastTickAt = now;

      const sign = channelVelocitySign(channel);
      if (sign !== 0) {
        const raw = state.target + sign * CHANNELS[channel].ratePerSecond * dt;
        state.target = CHANNELS[channel].wrap ? wrapValue(raw, min, max) : clampValue(raw, min, max);
      }

      const t = store.state.playhead;
      store.paintRange(channel, state.lastWrittenTime, t, () => state.target);
      state.lastWrittenTime = t;
      state.rafId = requestAnimationFrame(tick);
    }
    state.rafId = requestAnimationFrame(tick);
  }

  function stopChannel(channel) {
    const state = active[channel];
    if (!state) return;
    cancelAnimationFrame(state.rafId);
    delete active[channel];
    latch?.notifyEdited(channel, state.target);
  }

  function stopAll() {
    heldCodes.clear();
    for (const channel of Object.keys(active)) stopChannel(channel);
  }

  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (FOCUSABLE_CONTROLS.has(document.activeElement?.tagName)) return;
    const channel = CODE_TO_CHANNEL.get(e.code);
    if (!channel) return;
    e.preventDefault();
    heldCodes.add(e.code);
    startChannel(channel);
  });

  window.addEventListener("keyup", (e) => {
    const channel = CODE_TO_CHANNEL.get(e.code);
    if (!channel) return;
    heldCodes.delete(e.code);
    if (!isChannelHeld(channel)) stopChannel(channel);
  });

  // Safety net: if the window loses focus mid-hold (alt-tab, devtools, an
  // OS dialog), the actual key-up can happen with no browser window
  // listening at all, so no keyup event ever arrives — same failure mode
  // the pointer-drag controls guard against on "blur" elsewhere in this
  // app. Without this, a channel would stay stuck nudging forever.
  window.addEventListener("blur", stopAll);
}
