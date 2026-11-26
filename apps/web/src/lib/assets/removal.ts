import {
  afterRemoval,
  type AssetKind,
  type FileId,
  type ListingStore,
  type RemovalReason,
  type RemovalResult,
  type RemovalSummary,
  setNeedsAnImage,
  summarizeRemoval,
} from '@kiln/core';
import { k } from '../i18n/t.ts';

/**
 * Taking images out of a set from the Graphics tab: what a request names, what each image shows while it runs (the optimistic state),
 * how the per-image answers are read, and when the person is asked first. Pure; no pending count is computed here (the staged tray and
 * the count come from the staged view the answer carries, through the app state).
 */

/** What a row gives to name its file: the store's ref, else the blob id of a staged file, else its place. */
export function fileIdOf(row: { ref?: string | undefined; oid?: string | undefined; position: number }): FileId {
  if (row.ref !== undefined && row.ref !== '') return { ref: row.ref };
  if (row.oid !== undefined && row.oid !== '') return { oid: row.oid };
  return { position: row.position };
}

/** The message key (`t(key)`) of each reason an image was not taken out. */
export const REASON_KEYS = {
  unknown_file: k('assets:store.reason.unknownFile'),
  stale_store_ref: k('assets:store.reason.staleRef'),
  position_out_of_range: k('assets:store.reason.outOfRange'),
  not_in_staged_set: k('assets:store.reason.notInStaged'),
  duplicate_in_request: k('assets:store.reason.duplicate'),
  no_identifier: k('assets:store.reason.noIdentifier'),
  failed: k('assets:store.reason.failed'),
} as const;

/** What one image shows: it is being removed, or its removal was refused (the reason, and the server's sentence when it gave one). */
export type ItemState =
  | { status: 'removing' }
  | { status: 'error'; reason: RemovalReason | 'failed'; message: string };

export type ItemStates = Readonly<Record<string, ItemState | undefined>>;

export const NO_STATES: ItemStates = {};

const without = (states: ItemStates, keys: readonly string[]): Record<string, ItemState | undefined> => {
  const next: Record<string, ItemState | undefined> = {};
  for (const k of Object.keys(states)) if (keys.indexOf(k) < 0) next[k] = states[k];
  return next;
};

/** The request starts: every image of it shows "Removing…" (and an earlier error of it is cleared). */
export function startRemoving(states: ItemStates, keys: readonly string[]): ItemStates {
  const next = without(states, keys);
  for (const k of keys) next[k] = { status: 'removing' };
  return next;
}

export type Applied = {
  states: ItemStates;
  /** Keys whose file is out of the set now (removed, or already not in it): they leave the grid with the staged view. */
  gone: string[];
  /** Keys the server refused, with the reason. They stay, restored, with the error shown on them. */
  refused: { key: string; reason: RemovalReason }[];
  summary: RemovalSummary;
};

/**
 * The answer of a batch: `results[i]` belongs to `keys[i]` (the request listed the images in that order). A result that is missing is
 * an error of its own (`failed`), never silence. `removed` and `already_removed` end the "Removing…" state; `not_found` restores the
 * image with its reason.
 */
export function applyResults(
  states: ItemStates,
  keys: readonly string[],
  results: readonly RemovalResult[],
  messageOf: (reason: RemovalReason | 'failed') => string,
): Applied {
  const next = without(states, keys);
  const gone: string[] = [];
  const refused: { key: string; reason: RemovalReason }[] = [];
  keys.forEach((key, i) => {
    const r = results.filter((x) => x.index === i)[0];
    if (r === undefined) {
      next[key] = { status: 'error', reason: 'failed', message: messageOf('failed') };
    } else if (r.outcome === 'not_found') {
      const reason = r.reason ?? 'unknown_file';
      refused.push({ key, reason });
      next[key] = { status: 'error', reason, message: messageOf(reason) };
    } else gone.push(key);
  });
  return { states: next, gone, refused, summary: summarizeRemoval(results) };
}

/** The whole request failed (the network, a lock, a role): every image of it is restored with the same sentence. */
export function failAll(states: ItemStates, keys: readonly string[], message: string): ItemStates {
  const next = without(states, keys);
  for (const k of keys) next[k] = { status: 'error', reason: 'failed', message };
  return next;
}

/** Drops the state of images that are not in the set any more (after the staged view or the store view came in). */
export function pruneStates(states: ItemStates, order: readonly string[]): ItemStates {
  const stale = Object.keys(states).filter((k) => order.indexOf(k) < 0);
  return stale.length === 0 ? states : without(states, stale);
}

export const isRemoving = (states: ItemStates, key: string): boolean => states[key]?.status === 'removing';

export const removingCount = (states: ItemStates): number =>
  Object.keys(states).filter((k) => states[k]?.status === 'removing').length;

// ---------------------------------------------------------------------------------------------
// Asking first, and saying what is left

/** More than this many images asks first, whatever the set holds. */
export const CONFIRM_ABOVE = 5;

/** Whether the person is asked before this removal (inline, never a dialog): every image of the set, or more than 5. */
export const needsConfirm = (total: number, count: number): boolean =>
  count > 0 && (count >= total || count > CONFIRM_ABOVE);

/**
 * The consequence of emptying a set, from the content rules of the store: `required` when the store needs at least one image in it (the
 * largest iPhone and iPad display types of the App Store, the phone screenshots of Google Play), `optional` for the legacy sizes,
 * `none` when the set keeps images.
 */
export function emptyingConsequence(
  store: ListingStore,
  slot: { kind: AssetKind; device: string | null },
  total: number,
  count: number,
): 'none' | 'optional' | 'required' {
  if (!afterRemoval(total, count).empties) return 'none';
  return setNeedsAnImage(store, slot) ? 'required' : 'optional';
}

/** "Undo" is offered when the removal made a staged change of its own: undoing is then discarding that change. */
export const canUndo = (setWasStaged: boolean, summary: RemovalSummary): boolean =>
  !setWasStaged && summary.removed > 0;

/** What the line after a removal says: how many went, how many were already gone, how many could not be removed. */
export type Outcome = { removed: number; alreadyRemoved: number; refused: number };
export const outcomeOf = (summary: RemovalSummary): Outcome => ({
  removed: summary.removed,
  alreadyRemoved: summary.alreadyRemoved,
  refused: summary.notFound,
});
