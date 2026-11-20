/**
 * The `fitToViewport` action: limits the height of a panel so that its bottom edge is never below the window, wherever the panel
 * starts on the page. The panel keeps its own parts (a header, a footer) in view and scrolls its content (give that part
 * `overflow-y: auto` and `flex: 1 1 auto`; the panel itself is a column flex box). It measures again when the window changes size
 * and when anything on the page scrolls, because the panel moves up as the page scrolls and gets more room.
 *
 * Usage: `<section use:fitToViewport={{ margin: 16, min: 360 }}>`.
 */
/** `fill`: the panel takes all the room (a fixed height) instead of only being limited, so a footer stays at the same place on every page of a multi-step panel. */
export type FitParams = { margin?: number; min?: number; fill?: boolean };

export function fitToViewport(node: HTMLElement, params: FitParams = {}) {
  let current = params;
  let frame = 0;

  function measure() {
    frame = 0;
    if (!node.isConnected) return;
    const margin = current.margin ?? 16;
    const min = current.min ?? 360;
    const top = node.getBoundingClientRect().top;
    const room = Math.floor(window.innerHeight - Math.max(top, 0) - margin);
    const height = `${Math.max(min, room)}px`;
    node.style.maxHeight = height;
    if (current.fill) node.style.height = height;
  }

  function schedule() {
    if (frame === 0) frame = requestAnimationFrame(measure);
  }

  window.addEventListener('resize', schedule);
  document.addEventListener('scroll', schedule, true);
  schedule();

  return {
    update(next: FitParams) {
      current = next;
      schedule();
    },
    destroy() {
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
      if (frame !== 0) cancelAnimationFrame(frame);
    },
  };
}
