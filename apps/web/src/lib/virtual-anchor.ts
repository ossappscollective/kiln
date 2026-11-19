import type { Box } from './popover-place.ts';

/**
 * A stand-in for the element a floating popover hangs on, when the thing it points at is a place and not an element (the crosshair
 * of a chart). The `floating` action only calls `getBoundingClientRect`, so a one point box that follows its host (the chart's svg)
 * does: it is measured again on every scroll and resize, so it never goes stale.
 */
export function pointBox(
  host: Pick<Element, 'getBoundingClientRect'>,
  dx: number,
  dy: number,
): Box & { width: number; height: number; x: number; y: number } {
  const r = host.getBoundingClientRect();
  const x = r.left + dx;
  const y = r.top + dy;
  return { left: x, right: x, top: y, bottom: y, width: 0, height: 0, x, y };
}

/** The point `dx`, `dy` from the top left corner of `host`, as an anchor for `floating`. */
export function pointAnchor(
  host: Pick<Element, 'getBoundingClientRect'>,
  dx: number,
  dy: number,
): HTMLElement {
  return { getBoundingClientRect: () => pointBox(host, dx, dy) } as unknown as HTMLElement;
}
