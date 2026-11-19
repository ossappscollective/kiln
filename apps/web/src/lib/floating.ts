import { placePopover } from './popover-place.ts';

/**
 * The `floating` action: draws an element as a popover or dropdown that no container can clip. The element goes into the top
 * layer (the native `popover="manual"` attribute, so it also sits above an open dialog and ignores `overflow` and transforms of its
 * ancestors) and is placed with `position: fixed` next to its anchor by `placePopover` (clamped to the window, flipped above when
 * there is no room below, scrolling inside when it is tall). It follows the anchor on scroll and resize. It does not handle
 * focus, Escape or clicks outside: the component that opens it keeps doing that.
 *
 * Usage: `<div use:floating={{ anchor: button, align: 'end' }}>...</div>`; `anchor` is the element the popover belongs to.
 */
export type FloatingParams = {
  anchor: HTMLElement | null;
  align?: 'start' | 'end';
  gap?: number;
  /** At least as wide as the anchor (the list of a field). */
  matchAnchorWidth?: boolean;
};

export function floating(node: HTMLElement, params: FloatingParams) {
  let current = params;
  node.setAttribute('popover', 'manual');
  if (typeof node.showPopover === 'function') {
    try {
      node.showPopover();
    } catch {
      // Not connected yet or already shown: fixed positioning below still keeps it unclipped by overflow.
    }
  }
  node.style.position = 'fixed';
  node.style.inset = 'auto';
  node.style.margin = '0';
  node.style.overflowY = 'auto';
  node.style.overflowX = 'hidden';

  function place() {
    const anchor = current.anchor;
    if (!anchor || !node.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    const viewport = { width: document.documentElement.clientWidth, height: window.innerHeight };
    const scrolled = node.scrollTop;
    node.style.maxHeight = '';
    node.style.maxWidth = `${Math.max(0, viewport.width - 16)}px`;
    if (current.matchAnchorWidth) node.style.minWidth = `${Math.round(rect.width)}px`;
    const where = placePopover({
      anchor: rect,
      viewport,
      size: { width: node.offsetWidth, height: node.scrollHeight + (node.offsetHeight - node.clientHeight) },
      align: current.align,
      gap: current.gap,
      matchAnchorWidth: current.matchAnchorWidth,
    });
    node.style.maxHeight = `${where.maxHeight}px`;
    node.style.left = `${where.left}px`;
    node.style.top = `${where.top}px`;
    node.scrollTop = scrolled;
    node.dataset.placement = where.placement;
  }

  place();
  const again = () => place();
  // Scrolling inside the popover itself does not move it.
  const scrolledAround = (event: Event) => {
    if (!(event.target instanceof Node) || !node.contains(event.target)) place();
  };
  window.addEventListener('resize', again);
  window.addEventListener('scroll', scrolledAround, true);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(again) : null;
  observer?.observe(node);

  return {
    update(next: FloatingParams) {
      current = next;
      place();
    },
    destroy() {
      window.removeEventListener('resize', again);
      window.removeEventListener('scroll', scrolledAround, true);
      observer?.disconnect();
    },
  };
}
