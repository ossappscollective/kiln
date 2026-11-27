import { type AssetKind, type AssetStore, assetCountLimit } from '../listing/store-asset-specs.ts';

/**
 * THE image limit table (docs/state-model.md, "Single owners (core)"). Before this file the numbers lived in `maxFor` of
 * store-asset-specs.ts (10 Apple screenshots, 3 previews, 8 Play screenshots) AND `slotMaxFiles` of staged-changes.ts (10, 8, 1) AND in
 * the text of `ASSET_RULES['apple.screenshot.count']`, and the web retyped them for the Add button. This is a view over the first (it
 * does not fork it): change a number in `store-asset-specs.ts` and every consumer follows.
 *
 * TWO LIMITS, because two units are counted:
 *  - `max`: how many files ONE STORE SET holds (an Apple placement group; a Play image type). The store's own limit: what a store read is
 *    judged against, per group, never summed across sibling groups.
 *  - `stagedMax`: how many files ONE STAGED SET may hold. A push replaces the whole DISPLAY (all sibling groups of it), so a staged set
 *    is one display and holds at most `max` files; every kind without a count (icon, feature graphic, TV banner) holds ONE file; a
 *    preview is not pushed at all (1).
 * `device` is part of the signature because a limit may become per device; today no device has its own.
 *
 * Pure. ES2017.
 */

export type ImageLimit = {
  /** The documented count of one store set, or null when the kind has none. */
  max: number | null;
  /** The rule id (`apple.screenshot.count`), or null. */
  rule: string | null;
  /** The most files one staged set (one display) holds. */
  stagedMax: number;
};

export function limitOf(
  store: AssetStore,
  kind: AssetKind,
  _device: string | null = null,
): ImageLimit {
  const counted = assetCountLimit(store, kind);
  if (counted === null) return { max: null, rule: null, stagedMax: 1 };
  return {
    max: counted.max,
    rule: counted.rule,
    stagedMax: kind === 'screenshot' ? counted.max : 1,
  };
}
