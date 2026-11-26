/**
 * The selection of the images of ONE set (Graphics tab): which images are ticked, in what order they were reached, and the anchor of
 * a shift-click range. Pure: it holds keys (`GraphicRow.key`, stable while the set is edited) and never positions, so a re-read or a
 * removal in the middle of the set does not move the selection onto another image. Every function returns a new value.
 */
export type Selection = { keys: readonly string[]; anchor: string | null };

export const NO_SELECTION: Selection = { keys: [], anchor: null };

export const isSelected = (s: Selection, key: string): boolean => s.keys.indexOf(key) >= 0;

export const selectionSize = (s: Selection): number => s.keys.length;

/** Ticks the image, or unticks it when it was ticked. The image becomes the anchor of the next range. */
export function toggle(s: Selection, key: string): Selection {
  return isSelected(s, key)
    ? { keys: s.keys.filter((k) => k !== key), anchor: key }
    : { keys: [...s.keys, key], anchor: key };
}

/**
 * A shift-click: every image between the anchor and `key` (both included, in the order of the set) is ticked, on top of what was
 * ticked. Without an anchor, or when the anchor is not in the set any more, it is a plain tick. The anchor stays where it was, so
 * the next shift-click extends from the same place.
 */
export function selectRange(s: Selection, order: readonly string[], key: string): Selection {
  const to = order.indexOf(key);
  if (to < 0) return s;
  const from = s.anchor === null ? -1 : order.indexOf(s.anchor);
  if (from < 0) return { keys: isSelected(s, key) ? s.keys : [...s.keys, key], anchor: key };
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const keys = s.keys.slice();
  for (let i = lo; i <= hi; i++) {
    const k = order[i] as string;
    if (keys.indexOf(k) < 0) keys.push(k);
  }
  return { keys, anchor: s.anchor };
}

/** A click on an image's checkbox: with Shift a range, else a toggle. */
export const click = (
  s: Selection,
  order: readonly string[],
  key: string,
  shift: boolean,
): Selection => (shift ? selectRange(s, order, key) : toggle(s, key));

/** "Select all in this set". */
export const selectAll = (order: readonly string[]): Selection => ({
  keys: order.slice(),
  anchor: order.length > 0 ? (order[0] as string) : null,
});

export const clearSelection = (): Selection => NO_SELECTION;

/** The selection of a set that changed under it: what is not in the set any more is dropped (the same object when nothing is). */
export function prune(s: Selection, order: readonly string[]): Selection {
  const keys = s.keys.filter((k) => order.indexOf(k) >= 0);
  const anchor = s.anchor !== null && order.indexOf(s.anchor) >= 0 ? s.anchor : null;
  return keys.length === s.keys.length && anchor === s.anchor ? s : { keys, anchor };
}

/** The ticked keys in the order of the set (the order a request lists them, whatever order the person ticked them in). */
export const selectedInOrder = (s: Selection, order: readonly string[]): string[] =>
  order.filter((k) => isSelected(s, k));

/** Whether every image of the set is ticked (the "select all" checkbox is then on). */
export const allSelected = (s: Selection, order: readonly string[]): boolean =>
  order.length > 0 && order.every((k) => isSelected(s, k));
