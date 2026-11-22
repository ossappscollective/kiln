import { dateToDay } from '@kiln/core';
import type { Api } from '../api.ts';
import { k, t } from '../i18n/t.ts';
import {
  type AnalyticsOverview,
  type AnalyticsSeries,
  type AnalyticsStatus,
  hasData,
  monthKey,
  type ResolvedRange,
  seriesOf,
  stateOf,
} from './analytics.ts';
import {
  type ChartCard,
  type ChartPanel,
  type PanelKind,
  seriesLabel,
  type VersionBars,
} from './view.ts';

/**
 * Two cards of the Analytics screen that do not fit the daily, one-overview pattern (docs/adr/0042-earnings-and-subscription-metrics.md):
 *
 * - "Earnings (net, monthly)": Google Play's Earnings report is a monthly statement. It is read as a MONTHLY overview of its own
 *   (`granularity=month`, the last twelve months), whatever date range the page shows; every point is a month, named "Oct 2026", never a day.
 *   Money is per currency, with the same tabs, select and locale default as the sales cards (they are drawn by the same chart and the same
 *   currency helpers), and never added across currencies. Gross (the charges) and net are two separate series of the same currency and
 *   month: net is after Google's fees and taxes, the charges are what buyers paid; one is never derived from the other here.
 * - "Subscriptions": active, new and cancelled subscriptions from the Apple Subscription reports or the Play subscription statistics.
 *   Counts only (no unit, no money), with the active ones by product. Apple's and Google's are different measures and are never mixed.
 */

export const earningsCardTitle = (): string => t('analytics:earnings.cardTitle');
export const subscriptionsCardTitle = (): string => t('analytics:subs.cardTitle');

/** How many months the earnings card reads. */
export const EARNINGS_MONTHS = 12;

const EARNINGS_SOURCE = 'play_earnings';
const SUBSCRIPTION_SOURCES = ['apple_subscriptions', 'play_subscriptions'] as const;

/** The first day of the month `ago` months before the month of `day`. */
export function firstOfMonthBack(day: string, ago: number): string {
  let y = Number(day.slice(0, 4));
  let m = Number(day.slice(5, 7)) - ago;
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

/** The range of the monthly read: from the first of the month eleven months ago to today. It does not follow the range of the page. */
export const earningsRange = (today: string): { from: string; to: string } => ({
  from: firstOfMonthBack(today, EARNINGS_MONTHS - 1),
  to: today,
});

const sourceOf = (status: AnalyticsStatus | null, source: string) =>
  status?.sources.find((s) => s.source === source) ?? null;

/** Whether a source of this app has stored something (so the card is worth a read). */
export const sourceHasData = (status: AnalyticsStatus | null, source: string): boolean =>
  sourceOf(status, source)?.lastDay != null;

export const hasEarnings = (status: AnalyticsStatus | null): boolean =>
  sourceHasData(status, EARNINGS_SOURCE);
export const hasSubscriptions = (status: AnalyticsStatus | null): boolean =>
  SUBSCRIPTION_SOURCES.some((s) => sourceHasData(status, s));

/**
 * The line under the cards when the earnings source is set up and has no month yet: a missing file is "not available yet", never zero and
 * never an error. '' when there is data, the source is not set up (the sources panel says what to do), or its last read failed (said there too).
 */
export function earningsWaitingLine(status: AnalyticsStatus | null): string {
  const found = sourceOf(status, EARNINGS_SOURCE);
  if (!status?.enabled || !found || found.lastDay !== null) return '';
  if (stateOf(found.state) !== 'ready' && stateOf(found.state) !== 'waiting') return '';
  return t('analytics:earnings.waiting');
}

/** A monthly series with its points named by month ("2026-10") instead of the first day it is stored on. */
export function monthlySeries(series: AnalyticsSeries): AnalyticsSeries {
  return {
    ...series,
    cadence: 'monthly',
    points: series.points.map((p) => ({ date: monthKey(p.date), value: p.value })),
  };
}

function panel(
  id: string,
  title: string | null,
  kind: PanelKind,
  unit: ChartPanel['unit'],
  entries: [AnalyticsSeries | null, string | null, 1 | 2][],
  currency: string | null = null,
): ChartPanel | null {
  const series = entries.flatMap(([s, label, color]) =>
    hasData(s) ? [{ key: s.id, label: label ?? seriesLabel(s), color, series: s }] : [],
  );
  return series.length === 0 ? null : { id, title, kind, unit, currency, domain: 'zero', series };
}

const compact = <T>(list: (T | null)[]): T[] => list.filter((p): p is T => p !== null);

/**
 * The earnings card from the MONTHLY overview: one panel per currency (net and charges as two lines of the same currency), and the number of
 * orders, which belongs to no currency. Null when there is nothing to draw.
 */
export function buildEarningsCard(overview: AnalyticsOverview | null): ChartCard | null {
  if (!overview) return null;
  const monthly = (metric: string) =>
    overview.series
      .filter((s) => s.metric === metric && s.currency !== null && hasData(s))
      .map(monthlySeries);
  const net = monthly('earnings_net');
  const charges = monthly('earnings_charges');
  const currencies = [...new Set([...net, ...charges].map((s) => s.currency as string))];
  const panels = compact([
    ...currencies.map((currency) =>
      panel(
        `earnings:${currency}`,
        currency,
        'line',
        'money',
        [
          [
            net.find((s) => s.currency === currency) ?? null,
            t('analytics:earnings.net', { currency }),
            1,
          ],
          [
            charges.find((s) => s.currency === currency) ?? null,
            t('analytics:earnings.charges', { currency }),
            2,
          ],
        ],
        currency,
      ),
    ),
    (() => {
      const orders = seriesOf(overview, 'earnings_orders');
      return panel('earnings_orders', t('analytics:earnings.chargesCount'), 'columns', 'count', [
        [orders && hasData(orders) ? monthlySeries(orders) : null, null, 1],
      ]);
    })(),
  ]);
  if (panels.length === 0) return null;
  return { id: 'earnings', title: earningsCardTitle(), panels, versions: [] };
}

/**
 * The subscriptions card from a daily overview read with `breakdown=product` (the active ones by product come from it). Apple's counts (`subscriptions_*`) and Google's (`play_subscriptions_*`) are
 * separate measures: an app record has one platform, and whichever family has data is drawn.
 */
export function buildSubscriptionsCard(overview: AnalyticsOverview | null): ChartCard | null {
  if (!overview) return null;
  const families = [
    { prefix: 'subscriptions', trial: 'subscriptions_active_trial' },
    { prefix: 'play_subscriptions', trial: null },
  ];
  const panels: (ChartPanel | null)[] = [];
  const versions: (VersionBars | null)[] = [];
  for (const family of families) {
    const active = seriesOf(overview, `${family.prefix}_active`);
    const fresh = seriesOf(overview, `${family.prefix}_new`);
    const cancelled = seriesOf(overview, `${family.prefix}_cancelled`);
    const trial = family.trial ? seriesOf(overview, family.trial) : null;
    panels.push(
      panel(`${family.prefix}_active`, t('analytics:subs.active'), 'line', 'count', [
        [active, null, 1],
        [trial, t('analytics:subs.activeTrials'), 2],
      ]),
      panel(`${family.prefix}_new`, t('analytics:subs.new'), 'columns', 'count', [
        [fresh, null, 1],
      ]),
      panel(`${family.prefix}_cancelled`, t('analytics:subs.cancelled'), 'columns', 'count', [
        [cancelled, null, 1],
      ]),
    );
    const items = seriesOf(overview, `${family.prefix}_active`)?.breakdown;
    if (items && items.dimension === 'product' && items.items.length > 0 && hasData(active)) {
      versions.push({
        id: `${family.prefix}_by_product`,
        title: t('analytics:subs.byProduct'),
        unit: 'count',
        items: items.items,
      });
    }
  }
  const list = compact(panels);
  return list.length === 0
    ? null
    : {
        id: 'subscriptions',
        title: subscriptionsCardTitle(),
        panels: list,
        versions: compact(versions),
      };
}

export type ExtraReads = Pick<Api, 'analyticsOverview'>;

export type Extras = {
  earnings: AnalyticsOverview | null;
  subscriptions: AnalyticsOverview | null;
};

/**
 * The reads of the two cards, only for what is stored (one extra read each): the monthly overview for earnings, and a daily one with the
 * product breakdown for subscriptions. A failed read drops that card only and is never an error of the page.
 */
export async function loadExtras(
  api: ExtraReads,
  workspaceId: string,
  app: { id: string; platform: string },
  status: AnalyticsStatus,
  range: ResolvedRange,
  now: number,
): Promise<Extras> {
  const today = dateToDay(now);
  const earnings = hasEarnings(status)
    ? api
        .analyticsOverview(workspaceId, app.id, {
          platform: app.platform,
          ...earningsRange(today),
          granularity: 'month',
        })
        .catch((): null => null)
    : Promise.resolve(null);
  const subscriptions = hasSubscriptions(status)
    ? api
        .analyticsOverview(workspaceId, app.id, {
          platform: app.platform,
          from: range.from,
          to: range.to,
          granularity: 'day',
          breakdown: 'product',
        })
        .catch((): null => null)
    : Promise.resolve(null);
  const [e, s] = await Promise.all([earnings, subscriptions]);
  return { earnings: e, subscriptions: s };
}
