import { getMinMaxInRange } from "../audio/waveform.js";
import { syncCanvasSize, xToTime } from "./timeMapping.js";

const WAVE_COLOR = "#3b6ea5";
const MARKER_COLOR = "#e8562c";
const ZERO_LINE_COLOR = "#ddd";
const BG_COLOR = "#fafafa";
const RULER_BG_COLOR = "#eef0f2";
const RULER_TICK_COLOR = "#aaa";
const RULER_TEXT_COLOR = "#777";
const RULER_HEIGHT = 16;

// "1-2-5" progression so there's always a round-looking interval that
// keeps adjacent tick labels from overlapping, at any zoom level.
const NICE_INTERVALS = [
  0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600,
  1800, 3600,
];

function pickTickInterval(pixelsPerSecond, minPixelSpacing = 70) {
  for (const interval of NICE_INTERVALS) {
    if (interval * pixelsPerSecond >= minPixelSpacing) return interval;
  }
  return NICE_INTERVALS[NICE_INTERVALS.length - 1];
}

function formatTickLabel(t, interval) {
  const at = Math.max(0, t);
  if (interval >= 1) {
    const totalSec = Math.round(at);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  const decimals = interval >= 0.1 ? 1 : interval >= 0.01 ? 2 : 3;
  return `${at.toFixed(decimals)}s`;
}

function formatPlayheadTime(t) {
  const at = Math.max(0, t);
  const totalMs = Math.round(at * 1000);
  const m = Math.floor(totalMs / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${m}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

// Renders the audio strip: a scrolling waveform with a fixed marker at
// the horizontal center representing the current playhead ("now"), a
// time-axis ruler along the bottom, and the exact playhead time called
// out at the marker. Wheel zooms the time axis only (amplitude is never
// scaled); drag scrubs the playhead by treating the waveform like a
// tape being pulled under the marker.
export function createWaveformView(canvas, { store, seek, timeAxis }) {
  const ctx = canvas.getContext("2d");
  let dragging = false;
  let lastClientX = 0;
  const minMaxScratch = { min: 0, max: 0 }; // reused across every column of every redraw

  function timeAtClientX(clientX) {
    const rect = canvas.getBoundingClientRect();
    const { width } = syncCanvasSize(canvas);
    return xToTime(clientX - rect.left, width, store.state.playhead, timeAxis);
  }

  function draw() {
    const { width, height, dpr } = syncCanvasSize(canvas);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const waveHeight = height - RULER_HEIGHT;
    const centerX = width / 2;
    const playhead = store.state.playhead;

    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, width, waveHeight);
    ctx.fillStyle = RULER_BG_COLOR;
    ctx.fillRect(0, waveHeight, width, RULER_HEIGHT);

    ctx.strokeStyle = ZERO_LINE_COLOR;
    ctx.beginPath();
    ctx.moveTo(0, waveHeight / 2);
    ctx.lineTo(width, waveHeight / 2);
    ctx.stroke();

    const { audio, peaks: committedPeaks, livePeaks } = store.state;
    const peaks = livePeaks || committedPeaks;
    const pixelsPerSecond = width / timeAxis.visibleDuration;
    const secondsPerPixel = 1 / pixelsPerSecond;

    if (audio && peaks) {
      ctx.strokeStyle = WAVE_COLOR;
      ctx.beginPath();
      for (let x = 0; x < width; x++) {
        const tStart = playhead + (x - centerX) * secondsPerPixel;
        const tEnd = tStart + secondsPerPixel;
        if (tEnd < 0 || tStart > audio.duration) continue;
        const { min, max } = getMinMaxInRange(
          peaks,
          Math.max(0, tStart),
          Math.min(audio.duration, tEnd),
          minMaxScratch
        );
        // amplitude is raw PCM in [-1, 1], mapped 1:1 to half-height —
        // never rescaled to the buffer's own peak, so loudness stays
        // visually comparable across different files
        const yMin = waveHeight / 2 - max * (waveHeight / 2);
        const yMax = waveHeight / 2 - min * (waveHeight / 2);
        ctx.moveTo(x + 0.5, yMin);
        ctx.lineTo(x + 0.5, yMax);
      }
      ctx.stroke();
    }

    // Time-axis ruler: tick marks + labels at a "nice" interval chosen
    // from the current zoom level, covering whatever span is visible.
    // Labels within ~55px of the marker are skipped so they don't
    // collide with the playhead's own bold time readout there.
    const interval = pickTickInterval(pixelsPerSecond);
    const viewStart = playhead - centerX * secondsPerPixel;
    const viewEnd = playhead + (width - centerX) * secondsPerPixel;
    const firstTickIndex = Math.ceil(Math.max(0, viewStart) / interval);
    const lastTickIndex = Math.floor(viewEnd / interval);

    ctx.font = "10px system-ui, sans-serif";
    ctx.textBaseline = "bottom";
    ctx.strokeStyle = RULER_TICK_COLOR;
    ctx.fillStyle = RULER_TEXT_COLOR;
    ctx.lineWidth = 1;
    for (let i = firstTickIndex; i <= lastTickIndex; i++) {
      const tickTime = i * interval;
      const x = centerX + (tickTime - playhead) * pixelsPerSecond;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, waveHeight);
      ctx.lineTo(x + 0.5, waveHeight + 4);
      ctx.stroke();
      if (Math.abs(x - centerX) < 55) continue;
      const label = formatTickLabel(tickTime, interval);
      ctx.textAlign = x < centerX ? "left" : x > centerX ? "right" : "center";
      const labelX = ctx.textAlign === "left" ? x + 3 : ctx.textAlign === "right" ? x - 3 : x;
      ctx.fillText(label, labelX, height - 2);
    }

    // Playhead marker, spanning the full strip, and its exact time
    // called out just above the ruler.
    ctx.strokeStyle = MARKER_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(centerX, 0);
    ctx.lineTo(centerX, height);
    ctx.stroke();
    ctx.lineWidth = 1;

    if (audio) {
      const label = formatPlayheadTime(playhead);
      ctx.font = "bold 10px system-ui, sans-serif";
      const labelWidth = ctx.measureText(label).width;
      const padX = 4;
      const boxW = labelWidth + padX * 2;
      const boxX = Math.min(Math.max(centerX - boxW / 2, 0), width - boxW);
      ctx.fillStyle = MARKER_COLOR;
      ctx.fillRect(boxX, waveHeight, boxW, RULER_HEIGHT);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(label, boxX + padX, height - 2);
    }
  }

  store.subscribe((event) => {
    if (
      event.type === "audio-loaded" ||
      event.type === "playhead-changed" ||
      event.type === "play-state-changed"
    ) {
      draw();
    }
  });
  timeAxis.subscribe(draw);

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      timeAxis.zoomBy(Math.pow(1.0015, e.deltaY));
    },
    { passive: false }
  );

  canvas.addEventListener("pointerdown", (e) => {
    if (!store.state.audio) return;
    dragging = true;
    lastClientX = e.clientX;
    canvas.setPointerCapture(e.pointerId);
    seek(timeAtClientX(e.clientX));
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const { width } = syncCanvasSize(canvas);
    const pixelsPerSecond = width / timeAxis.visibleDuration;
    const deltaX = e.clientX - lastClientX;
    lastClientX = e.clientX;
    seek(store.state.playhead - deltaX / pixelsPerSecond);
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // pointer capture may already be gone; nothing to clean up
    }
  }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  new ResizeObserver(draw).observe(canvas);
  draw();
}
