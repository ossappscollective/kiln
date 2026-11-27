import { type CopyChannelName, pickCopy, type StoreCopyView } from './copy.ts';
import { normalizeStoreText } from './text.ts';

/**
 * THE staged-text baseline (docs/state-model.md, "Single owners (core)"): what a staged text is compared with to say "unchanged".
 *
 * THE DIVERGENCE. `buildStagedView` compared a staged text with the LIVE snapshot (so the cart count and Pending dropped it as `unchanged`)
 * while the push preview compared it with the EDITABLE draft just read (`textChanged`/`textUnchanged`). A text equal to the live one but not
 * to an edited draft was "not pending" in the count, never pushed, and "changed" in the publish dialog; the reverse with a stale snapshot.
 *
 * THE DECISION: the baseline is the EDITABLE draft's value when a draft exists (the store holds one and it has this locale and field), else
 * the live value. It is the thing a push would overwrite, so "unchanged" means "a push would not change it". Both channels are read from
 * the one `StoreCopyView` (intent `editable`, which already falls back to live when the store has no draft). A text that neither has has no
 * baseline (null): it is never unchanged (it is new). Comparison uses the one normaliser (`normalizeStoreText`).
 *
 * Pure. ES2017.
 */

export type StagedBaseline = { value: string; from: CopyChannelName } | null;

/** The baseline of a locale's field: the editable draft's text when there is one, else the live text; null when neither has it. */
export function stagedBaselineOf(
  editable: StoreCopyView,
  locale: string,
  field: string,
): StagedBaseline {
  // `editable` intent: the draft's locales and texts, the live copy when the store has no draft at all.
  const copy = pickCopy(editable, locale);
  if (copy === undefined) return null;
  const value = copy.fields[field];
  return value === undefined ? null : { value, from: copy.from };
}

/** Whether a staged text equals its baseline once normalised (a push would not change it). False without a baseline. */
export function isUnchangedStaged(
  staged: string,
  baseline: StagedBaseline | string | null,
): boolean {
  const value = baseline === null ? null : typeof baseline === 'string' ? baseline : baseline.value;
  return value !== null && normalizeStoreText(staged) === normalizeStoreText(value);
}
