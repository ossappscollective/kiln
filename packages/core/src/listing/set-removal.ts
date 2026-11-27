import type { ListingStore } from './listing.ts';
import type { AssetKind } from './store-asset-specs.ts';

/**
 * Taking files out of a staged set, in one request (docs/api/staged-changes.md "Remove files from a set"): the identifiers a
 * request names, the precise answer for each of them, and what emptying a set means for the store. Pure; written for the ES2017
 * web build (no flatMap, no fromEntries).
 */

/**
 * One file of a set, by what identifies it and never by luck: `ref` (an image the STORE holds, as the store view gives it),
 * `oid` (the git blob id of a staged or repository file) or, as the last resort, `position` (1-based, in the set as it is now).
 * At least one is given; `ref` wins over `oid`, `oid` over `position`.
 */
export type FileId = {
  ref?: string | undefined;
  oid?: string | undefined;
  position?: number | undefined;
};

export const MAX_REMOVALS_PER_REQUEST = 100;

export const REMOVAL_OUTCOMES = ['removed', 'already_removed', 'not_found'] as const;
export type RemovalOutcome = (typeof REMOVAL_OUTCOMES)[number];

/**
 * Why a file was not taken out. `unknown_file`: no file of the set has that ref or blob id. `stale_store_ref`: the ref is not in the
 * store's view any more (read the store again). `position_out_of_range`: the set has fewer files than that. `not_in_staged_set`: the
 * set is staged and the file is not part of it (it was taken out, or replaced, since the page was read: a push removes it).
 * `duplicate_in_request`: the same file is named twice (the second one has nothing left to remove). `no_identifier`: nothing names a file.
 */
export const REMOVAL_REASONS = [
  'unknown_file',
  'stale_store_ref',
  'position_out_of_range',
  'not_in_staged_set',
  'duplicate_in_request',
  'no_identifier',
] as const;
export type RemovalReason = (typeof REMOVAL_REASONS)[number];

export type RemovalResult = {
  /** Where the identifier stood in the request (0-based), so a client matches the answer without comparing identifiers. */
  index: number;
  id: FileId;
  outcome: RemovalOutcome;
  reason?: RemovalReason | undefined;
  /** 1-based place the file had in the set before this request, when it was found. */
  position?: number | undefined;
};

export type RemovalSummary = { removed: number; alreadyRemoved: number; notFound: number };

export function summarizeRemoval(results: readonly RemovalResult[]): RemovalSummary {
  const out: RemovalSummary = { removed: 0, alreadyRemoved: 0, notFound: 0 };
  for (const r of results) {
    if (r.outcome === 'removed') out.removed++;
    else if (r.outcome === 'already_removed') out.alreadyRemoved++;
    else out.notFound++;
  }
  return out;
}

/** The identifiers that were not taken out and are not simply already gone: what a screen shows next to the file. */
export const failedRemovals = (results: readonly RemovalResult[]): RemovalResult[] =>
  results.filter((r) => r.outcome === 'not_found');

// ---------------------------------------------------------------------------------------------
// What an empty set means

/**
 * The screenshot sets a store REQUIRES to hold at least one image (an app that is sent for review without them is refused): App Store,
 * the largest iPhone and the largest iPad display type (the smaller sizes are scaled from them, so they are optional, and the legacy
 * ones such as iPhone 5.5" are never required); Google Play, the phone screenshots.
 * UNVERIFIED against the store's console for apps that do not support iPad or iPhone: such an app does not need that set.
 */
const REQUIRED_SCREENSHOT_DEVICES: Record<ListingStore, readonly string[]> = {
  app_store: ['iphone_6_9', 'ipad_13'],
  google_play: ['phone'],
};

/** Whether the store needs at least one image in this set (an empty set then blocks a submit). */
export function setNeedsAnImage(
  store: ListingStore,
  slot: { kind: AssetKind; device: string | null },
): boolean {
  if (slot.kind !== 'screenshot' || slot.device === null) return false;
  return REQUIRED_SCREENSHOT_DEVICES[store].indexOf(slot.device) >= 0;
}

/** What taking `count` files out of a set that holds `total` leaves: how many remain, and whether the set is emptied. */
export const afterRemoval = (
  total: number,
  count: number,
): { remaining: number; empties: boolean } => {
  const remaining = Math.max(0, total - Math.max(0, count));
  return { remaining, empties: total > 0 && remaining === 0 };
};
