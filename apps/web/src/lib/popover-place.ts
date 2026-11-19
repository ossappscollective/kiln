/**
 * Where a popover, menu or dropdown goes (pure; the `floating` action in floating.ts measures and applies it). Popovers are drawn
 * with `position: fixed` in the top layer, so no container with `overflow` or a transform can clip them; this function keeps them
 * inside the window: it clamps them sideways, puts them above the anchor when there is no room below, and limits the height (the
 * popover then scrolls inside). Written for the ES2017 web build.
 */

export type Box = { top: number; left: number; right: number; bottom: number };
export type Viewport = { width: number; height: number };

export type PlaceInput = {
  /** The bounding box of the button or field the popover belongs to, in window coordinates. */
  anchor: Box;
  viewport: Viewport;
  /** The natural size of the popover (its width as styled, its full content height). */
  size: { width: number; height: number };
  /** Which edge of the anchor the popover lines up with, or `center` (a tooltip over its trigger). */
  align?: 'start' | 'end' | 'center';
  /** Go above the anchor when the content fits there (a tooltip); the default is below. */
  prefer?: 'below' | 'above';
  /** Space between the anchor and the popover. */
  gap?: number;
  /** The least space kept free at the window edges. */
  margin?: number;
  /** Use at least the anchor's width (a dropdown of a field). */
  matchAnchorWidth?: boolean;
};

export type Placement = {
  top: number;
  left: number;
  /** The width to give the popover (never wider than the window less its margins). */
  width: number;
  maxWidth: number;
  /** Scroll inside the popover beyond this height. */
  maxHeight: number;
  placement: 'below' | 'above';
};

/** Keeps `value` inside [low, high]; with high below low the low edge wins. */
const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(value, high));

export function placePopover(input: PlaceInput): Placement {
  const { anchor, viewport, size } = input;
  const gap = input.gap ?? 4;
  const margin = input.margin ?? 8;
  const maxWidth = Math.max(0, viewport.width - 2 * margin);
  const wanted = input.matchAnchorWidth ? Math.max(size.width, anchor.right - anchor.left) : size.width;
  const width = Math.min(wanted, maxWidth);

  const edge = input.align === 'end' ? anchor.right - width : input.align === 'center' ? (anchor.left + anchor.right - width) / 2 : anchor.left;
  const left = clamp(edge, margin, viewport.width - margin - width);

  const below = Math.max(0, viewport.height - anchor.bottom - gap - margin);
  const above = Math.max(0, anchor.top - gap - margin);
  // Below unless the content does not fit there and there is more room above.
  const placement: Placement['placement'] =
    input.prefer === 'above' && size.height <= above ? 'above' : size.height <= below || below >= above ? 'below' : 'above';
  const room = placement === 'below' ? below : above;
  const maxHeight = Math.floor(room);
  const height = Math.min(size.height, maxHeight);
  const top = placement === 'below' ? anchor.bottom + gap : anchor.top - gap - height;
  return { top: Math.round(top), left: Math.round(left), width: Math.round(width), maxWidth: Math.floor(maxWidth), maxHeight, placement };
}
