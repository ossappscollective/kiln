import { MAX_RATING } from './reviews.ts';
import { type ReviewTranslation, type Translatable, chunkIds, needsTranslation } from './review-translation.ts';

/**
 * Small pure helpers of the per-app Reviews tab (docs/ux-ia.md, design R6): the low-rating quick filter and
 * "Translate all visible". Nothing here fetches. Written for the ES2017 web build.
 */

/** The ratings that count as low for a threshold: 1 to the threshold (the server's `lowRatingThreshold`). */
export function lowRatings(threshold: number): number[] {
  const top = Math.max(0, Math.min(MAX_RATING, Math.trunc(threshold)));
  const out: number[] = [];
  for (let n = 1; n <= top; n += 1) out.push(n);
  return out;
}

/** Whether the rating filter is exactly the low ratings (the quick filter is "on"). */
export function isLowOnly(ratings: readonly number[], threshold: number): boolean {
  const low = lowRatings(threshold);
  if (low.length === 0 || ratings.length !== low.length) return false;
  const sorted = [...ratings].sort((a, b) => a - b);
  return low.every((n, i) => sorted[i] === n);
}

/** The rating filter after the quick filter is switched on (the low ratings) or off (no rating filter). */
export const ratingsWithLowOnly = (on: boolean, threshold: number): number[] => (on ? lowRatings(threshold) : []);

/** The reviews of the list that still need a translation into `target`, as the ids of one or more requests. */
export function pendingTranslationBatches(
  reviews: readonly Translatable[],
  target: string,
  have: Readonly<Record<string, ReviewTranslation | undefined>>,
): string[][] {
  const ids: string[] = [];
  for (const review of reviews) {
    if (have[review.id] !== undefined) continue;
    if (needsTranslation(review, target)) ids.push(review.id);
  }
  return chunkIds(ids);
}

/** The translations kept so far plus new ones (a newer one for a review replaces an older one). */
export function mergeTranslations(
  have: Readonly<Record<string, ReviewTranslation | undefined>>,
  added: readonly ReviewTranslation[],
): Record<string, ReviewTranslation | undefined> {
  const out: Record<string, ReviewTranslation | undefined> = { ...have };
  for (const t of added) out[t.reviewId] = t;
  return out;
}

/** The label of the button: how many reviews it will send. */
export function translateAllLabel(pending: number, language: string): string {
  return pending === 0 ? 'All visible reviews are translated' : `Translate all visible (${pending}) to ${language}`;
}
