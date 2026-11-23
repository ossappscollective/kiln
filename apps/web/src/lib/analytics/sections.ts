import { k, t } from '../i18n/t.ts';
import type { RailGroup } from '../section-rail.ts';
import { type SourceState, stateOf } from './analytics.ts';
import type { ChartCard } from './view.ts';

/**
 * The Insights overview as a section rail (components/ui/SectionRail.svelte, `?section=`), so it is not one long column:
 *   Overview      the headline figures (a table across platforms, or a grid for one), the RevenueCat block, then the headline charts
 *   Acquisition   how people find the app: reach, listing, downloads or installs, conversion
 *   Quality       crashes, ANRs and ratings
 *   Revenue       sales, proceeds, subscriptions and the monthly earnings (store figures; RevenueCat's own are in the headline)
 *   Next steps    ASO next steps and open AI suggestions
 *   Data sources  where the numbers come from, one panel for the whole scope
 */
export type InsightsPart = 'overview' | 'acquisition' | 'quality' | 'revenue' | 'next' | 'sources';

export const INSIGHTS_PARTS: readonly InsightsPart[] = ['overview', 'acquisition', 'quality', 'revenue', 'next', 'sources'];

/** Which part a chart card belongs to; an unknown card is shown under Acquisition rather than lost. */
export type CardPart = 'acquisition' | 'quality' | 'revenue';

const QUALITY = new Set(['vitals', 'crashes', 'ratings']);
const REVENUE = new Set(['sales', 'proceeds', 'subscriptions', 'earnings']);

export const cardPart = (card: Pick<ChartCard, 'id'>): CardPart =>
  QUALITY.has(card.id) ? 'quality' : REVENUE.has(card.id) ? 'revenue' : 'acquisition';

/** The cards of one part, in their reading order. */
export const cardsOfPart = (cards: readonly ChartCard[], part: CardPart): ChartCard[] => cards.filter((c) => cardPart(c) === part);

/**
 * The cards of a part when the headline chart is drawn in Overview: Overview shows the headline chart, Acquisition shows the other
 * acquisition cards. Nothing is dropped: every card is in exactly one part.
 */
export const withoutHeadline = (cards: readonly ChartCard[], headlineId: string | null): ChartCard[] =>
  headlineId === null ? [...cards] : cards.filter((c) => c.id !== headlineId);

/** How many columns the platforms of the scope get: side by side when there are two or more, one column otherwise. */
export const platformColumns = (platformsInScope: number): 1 | 2 => (platformsInScope > 1 ? 2 : 1);

/** The RevenueCat figures are "all stores" figures: one block for the whole scope, read from the first record that is linked. */
export function revenueHost<T extends { linked: boolean }>(records: readonly T[]): T | null {
  return records.find((r) => r.linked) ?? null;
}

export type InsightsCounts = {
  acquisition: number;
  quality: number;
  revenue: number;
  /** Sources that could not be read (the last read failed), across the scope; null while unknown. */
  failedSources: number | null;
};

/** The rail is drawn only when the tab has two or more sections; one section is just the content. */
export const railWorthDrawing = (groups: readonly RailGroup[]): boolean => groups.reduce((n, g) => n + g.entries.length, 0) >= 2;

/** `withNumbers`: something is stored, so Acquisition, Quality and Revenue exist; without data they would be three empty pages. */
export function insightsGroups(counts: InsightsCounts, showNext: boolean, withNumbers = true): RailGroup[] {
  const entry = (id: InsightsPart, labelKey: string, count?: number | null, note?: string) => ({ id, label: t(labelKey), count, note });
  return [
    {
      id: 'numbers',
      label: t(k('analytics:rail.groupNumbers')),
      entries: [
        entry('overview', k('analytics:rail.overview')),
        ...(withNumbers
          ? [
              entry('acquisition', k('analytics:rail.acquisition'), counts.acquisition),
              entry('quality', k('analytics:rail.quality'), counts.quality),
              entry('revenue', k('analytics:rail.revenue'), counts.revenue),
            ]
          : []),
      ],
    },
    {
      id: 'more',
      label: t(k('analytics:rail.groupMore')),
      entries: [
        ...(showNext ? [entry('next', k('analytics:rail.next'))] : []),
        entry(
          'sources',
          k('analytics:rail.sources'),
          counts.failedSources !== null && counts.failedSources > 0 ? counts.failedSources : null,
          counts.failedSources ? t(k('analytics:rail.sourcesFailed'), { count: counts.failedSources }) : undefined,
        ),
      ],
    },
  ];
}

/** One state for the whole scope: a failed read first, then a missing setup, then waiting; ready when any platform reads; off when all are off. */
export function worstState(states: readonly SourceState[]): SourceState {
  for (const wanted of ['error', 'needs_setup', 'waiting'] as SourceState[]) if (states.includes(wanted)) return wanted;
  return states.includes('ready') ? 'ready' : 'off';
}

/** The sources that failed their last read, across the platforms of the scope. */
export const failedSourceCount = (statuses: readonly { sources: readonly { state: string }[] }[]): number =>
  statuses.reduce((n, s) => n + s.sources.filter((x) => stateOf(x.state) === 'error').length, 0);

/** The newest read of any source of any platform, or null when nothing was read. */
export function latestRead(reads: readonly (number | null)[]): number | null {
  let best: number | null = null;
  for (const r of reads) if (r !== null && (best === null || r > best)) best = r;
  return best;
}
