import { type Platform, REVIEW_CODES } from '@kiln/core';
import type { ReadinessFact } from '../app-state/blockers.ts';
import { type ReadinessLine, readinessLine } from '../publish-readiness.ts';

/**
 * The App Review Information check, early (docs/state-model.md, "Single owners (core)"): the submit refuses a version whose review
 * contact or demo account is blank (`evaluateReviewInformation`, ONE core rule), and the current readiness carries that finding as a
 * blocker. The Listing page and the Release page show it BEFORE the publish dialog, from the same reading; nothing here judges.
 */

/** The review-information blockers of a reading, as lines ("what is missing", "how to fix it", "where"). Empty while not read. */
export function reviewLinesOf(
  platform: Platform,
  fact: ReadinessFact | null | undefined,
): ReadinessLine[] {
  const reading = fact?.reading;
  if (reading === null || reading === undefined) return [];
  return reading.blockers
    .filter((b) => REVIEW_CODES.indexOf(b.code) >= 0)
    .map((b, i) => readinessLine(platform, b, i));
}
