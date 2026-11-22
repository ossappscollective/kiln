import type {
  InboxFilters,
  ReviewFilters,
  ReviewStatus,
  StoredSummary,
  WeekBucket,
} from './reviews.ts';
import { formatList } from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';
import { averageText, statusLabels, statusOrder } from './reviews.ts';

/**
 * Pure state of the compact Reviews toolbar (docs/ux-ia.md, phase 2): the status chips with counts, how many filters the
 * "Filters" popover holds that are on, and the one slim line that replaces the old rating overview. Nothing here fetches.
 * Written for the ES2017 web build.
 */

/** The short names of the status chips ("Replied" stands for replied in the store console). */
export const chipLabels: Record<ReviewStatus, string> = {
  new: 'New',
  triaged: 'Triaged',
  replied_in_console: 'Replied',
  ignored: 'Ignored',
};

export type StatusChip = {
  status: ReviewStatus;
  label: string;
  /** The full name for a tooltip or screen reader. */
  title: string;
  /** The number of stored reviews with this status, or null when it is not known (the inbox only counts new ones). */
  count: number | null;
  pressed: boolean;
};

/** One chip per status, in the order of the triage flow. A chip is pressed only when it is the one status filtered by. */
export function statusChips(
  counts: Partial<Record<ReviewStatus, number>>,
  active: readonly ReviewStatus[],
): StatusChip[] {
  return statusOrder.map((status) => {
    const count = counts[status];
    return {
      status,
      label: chipLabels[status],
      title: statusLabels[status],
      count: typeof count === 'number' ? count : null,
      pressed: active.length === 1 && active[0] === status,
    };
  });
}

/** The statuses filtered by after a chip is pressed: that one, or none when it was the only one on. */
export function statusesAfterChip(
  active: readonly ReviewStatus[],
  pressed: ReviewStatus,
): ReviewStatus[] {
  return active.length === 1 && active[0] === pressed ? [] : [pressed];
}

/**
 * How many filters behind the "Filters" popover are on. The status chips and the search box show themselves, so they do not
 * count, except for a status filter of several statuses (from "Show unanswered"), which no chip can show.
 */
export function popoverFilterCount(f: ReviewFilters, sinceChoice = 'all'): number {
  return (
    (f.ratings.length > 0 ? 1 : 0) +
    (f.response !== '' ? 1 : 0) +
    (f.version.trim() !== '' ? 1 : 0) +
    (f.territory.trim() !== '' ? 1 : 0) +
    (f.language.trim() !== '' ? 1 : 0) +
    (sinceChoice !== 'all' ? 1 : 0) +
    (f.sort !== 'newest' ? 1 : 0) +
    (f.statuses.length > 1 ? 1 : 0)
  );
}

/** The same for the inbox of every app: it also has the store, the assignee, the apps and "written" choices. */
export function inboxPopoverFilterCount(f: InboxFilters): number {
  return (
    popoverFilterCount(f, 'all') +
    (f.within !== '' ? 1 : 0) +
    (f.platform !== '' ? 1 : 0) +
    (f.assignee !== '' ? 1 : 0) +
    (f.appIds.length > 0 ? 1 : 0)
  );
}

/** The label of the Filters button: "Filters", or "Filters (3)". */
export const filtersButtonText = (on: number): string => (on > 0 ? t('reviews:toolbar.filtersCount', { count: on }) : t('reviews:toolbar.filters'));

export type TrendWord = 'rising' | 'falling' | 'steady';

const TREND_KEYS: Record<TrendWord, string> = {
  rising: k('reviews:toolbar.trendRising'),
  falling: k('reviews:toolbar.trendFalling'),
  steady: k('reviews:toolbar.trendSteady'),
};

/**
 * Whether the weekly average rating moves: the average of the latest two weeks with a rating against the weeks before them.
 * Null with fewer than three weeks that have a rating (not enough to say). A move under a quarter star is "steady".
 */
export function trendWord(weeks: readonly WeekBucket[]): TrendWord | null {
  const rated = weeks.filter((w) => w.average !== null && w.count > 0);
  if (rated.length < 3) return null;
  const weighted = (list: readonly WeekBucket[]): number => {
    let sum = 0;
    let n = 0;
    for (const w of list) {
      sum += (w.average ?? 0) * w.count;
      n += w.count;
    }
    return n === 0 ? 0 : sum / n;
  };
  const recent = weighted(rated.slice(-2));
  const before = weighted(rated.slice(0, -2));
  const delta = recent - before;
  if (Math.abs(delta) < 0.25) return 'steady';
  return delta > 0 ? 'rising' : 'falling';
}

/** The slim line: "4.3 average, 42 stored reviews, rating rising". Always the same order; the trend only when it can be said. */
export function statsLine(stored: Pick<StoredSummary, 'count' | 'average' | 'weeks'>): string {
  if (stored.count === 0) return t('reviews:toolbar.noStored');
  const parts = [
    t('reviews:toolbar.average', { value: averageText(stored.average) }),
    t('reviews:toolbar.stored', { count: stored.count }),
  ];
  const trend = trendWord(stored.weeks);
  if (trend !== null) parts.push(t(TREND_KEYS[trend]));
  return formatList(parts, { type: 'unit' });
}
