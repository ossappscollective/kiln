import { t } from '../i18n/t.ts';
import { MAX_RATING, type ReviewFilters, type UnansweredSummary } from './reviews.ts';
import {
  chunkIds,
  needsTranslation,
  type ReviewTranslation,
  type Translatable,
} from './translation.ts';

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
export const ratingsWithLowOnly = (on: boolean, threshold: number): number[] =>
  on ? lowRatings(threshold) : [];

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
  return pending === 0
    ? t('reviews:tab.allTranslated')
    : t('reviews:tab.translateAll', { count: pending, language });
}

// ---------------------------------------------------------------------------------------------
// Unanswered reviews (the `unanswered` of the per-app summary)

/** How old the oldest unanswered review is, in words for a chip: "2 h", "3 d". Rounded down; never negative. */
export function ageText(at: number, now: number): string {
  const hours = Math.max(0, Math.floor((now - at) / 3_600_000));
  if (hours < 1) return t('reviews:tab.ageUnderHour');
  if (hours < 48) return t('reviews:tab.ageHours', { count: hours });
  return t('reviews:tab.ageDays', { count: Math.floor(hours / 24) });
}

export type UnansweredChip = { text: string; label: string };

/**
 * The quiet chip of the Reviews tab: "5 unanswered, oldest 3 d". Nothing for none or for a summary without the field (an older
 * server). When the server counts only the lowest ratings (`maxRating` below 5) it says so, so the number is not misread.
 */
export function unansweredChip(
  unanswered: UnansweredSummary | null | undefined,
  now: number,
): UnansweredChip | null {
  if (!unanswered || !(unanswered.count > 0)) return null;
  const params = {
    count: unanswered.count,
    max: unanswered.maxRating,
    age: unanswered.oldestAt === null ? '' : ageText(unanswered.oldestAt, now),
  };
  const dated = unanswered.oldestAt !== null;
  const text =
    unanswered.maxRating >= MAX_RATING
      ? dated
        ? t('reviews:tab.chipOldest', params)
        : t('reviews:tab.chip', params)
      : unanswered.maxRating === 1
        ? dated
          ? t('reviews:tab.chipOneStarOldest', params)
          : t('reviews:tab.chipOneStar', params)
        : dated
          ? t('reviews:tab.chipMaxOldest', params)
          : t('reviews:tab.chipMax', params);
  return { text, label: t('reviews:tab.chipLabel', { text }) };
}

/** The filters of "Show unanswered": no developer response, not ignored, and the same ratings the count covers. */
export function unansweredFilters(maxRating: number): Partial<ReviewFilters> {
  return {
    response: 'no',
    statuses: ['new', 'triaged', 'replied_in_console'],
    ratings: maxRating >= MAX_RATING ? [] : lowRatings(maxRating),
  };
}
