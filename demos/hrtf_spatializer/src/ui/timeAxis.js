// Holds only the zoom level of a scrolling time-axis view. The center
// of the view is always the store's playhead — that's owned by
// PathStore, not duplicated here — so this is reusable across every
// strip that shares the same "now stays centered" viewport.
export class TimeAxisView {
  constructor({
    initialVisibleDuration = 4,
    minVisibleDuration = 0.05,
    maxVisibleDuration = 120,
  } = {}) {
    this.visibleDuration = initialVisibleDuration;
    this.minVisibleDuration = minVisibleDuration;
    this.maxVisibleDuration = maxVisibleDuration;
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    for (const listener of this.listeners) listener(this.visibleDuration);
  }

  zoomBy(factor) {
    const next = this.visibleDuration * factor;
    this.visibleDuration = Math.min(
      this.maxVisibleDuration,
      Math.max(this.minVisibleDuration, next)
    );
    this.emit();
  }
}
