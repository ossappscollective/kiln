import { formatCountExact, formatMoney } from '../analytics/analytics.ts';
import { timeAgo } from '../format.ts';
import { k, t } from '../i18n/t.ts';

/**
 * The RevenueCat figures strip at the top of the Products page (docs/adr/0043-revenuecat-metrics.md): RevenueCat's own overview of the
 * linked project, from the STORED copy (`GET .../revenuecat/metrics`, no RevenueCat call). The figures cover every app and store of the
 * RevenueCat project, not this app alone, and they are RevenueCat's numbers, not the store consoles'. Money carries the currency RevenueCat
 * reported and is never converted; a figure RevenueCat did not report is not drawn (never a zero).
 */

export type RevenueCatMetric = {
  id: string;
  name: string;
  kind: 'count' | 'money';
  value: number;
  currency: string | null;
  period: string | null;
  windowDays: number | null;
  lastUpdatedAt: number | null;
};

export type RevenueCatMetricsRead = {
  supported: boolean;
  linked: boolean;
  metrics: {
    scope: 'project';
    projectId: string;
    projectName: string;
    currency: string | null;
    fetchedAt: number;
    figures: {
      activeSubscriptions: RevenueCatMetric | null;
      activeTrials: RevenueCatMetric | null;
      mrr: RevenueCatMetric | null;
      revenue: RevenueCatMetric | null;
    };
    others: RevenueCatMetric[];
  } | null;
  status: { lastAttemptAt: number | null; lastError: string | null; failures: number } | null;
};

/** The words next to every strip: whose numbers these are and what they cover. */
/** Message keys: translate them where they are drawn (`t(STRIP_SCOPE)`). */
export const STRIP_SCOPE = k('products:metrics.scope');

export const STRIP_SCOPE_DETAIL = k('products:metrics.scopeDetail');

export type StripTile = { id: string; label: string; value: string; title: string };

/** "$1,235" or "1,235" with no currency named: an amount whose currency RevenueCat did not say is never dressed up as money. */
export function metricValue(metric: RevenueCatMetric): string {
  if (metric.kind === 'count') return formatCountExact(metric.value);
  if (metric.currency === null) return t('products:metrics.currencyNotReported', { amount: formatMoney(metric.value, null) });
  return formatMoney(metric.value, metric.currency);
}

const windowWords = (days: number | null): string =>
  days === null || days === 0 ? '' : ` ${t('products:metrics.window', { count: days })}`;

/** The four figures, in the order of the strip; one RevenueCat did not report is left out. */
export function stripTiles(read: RevenueCatMetricsRead | null): StripTile[] {
  const figures = read?.metrics?.figures;
  if (!figures) return [];
  const tile = (id: string, label: string, m: RevenueCatMetric | null, extra = ''): StripTile[] =>
    m === null
      ? []
      : [
          {
            id,
            label: `${label}${windowWords(m.windowDays)}`,
            value: metricValue(m),
            title: `${m.period ? t('products:metrics.titlePeriod', { name: m.name, period: m.period }) : t('products:metrics.title', { name: m.name })}${extra}`,
          },
        ];
  return [
    ...tile('active_subscriptions', t('products:metrics.activeSubscriptions'), figures.activeSubscriptions),
    ...tile('active_trials', t('products:metrics.activeTrials'), figures.activeTrials),
    ...tile('mrr', t('products:metrics.mrr'), figures.mrr, ` ${t('products:metrics.mrrNote')}`),
    ...tile('revenue', t('products:metrics.revenue'), figures.revenue, ` ${t('products:metrics.revenueNote')}`),
  ];
}

/** "As of 3 minutes ago", from the time of the read. */
export const asOf = (read: RevenueCatMetricsRead | null, now: number): string =>
  read?.metrics ? t('products:metrics.asOf', { ago: timeAgo(read.metrics.fetchedAt, now) }) : '';

/** Whether the strip is drawn at all: only for a linked app, and only when there is something to say (figures, or why there are none). */
export function stripVisible(read: RevenueCatMetricsRead | null): boolean {
  if (!read || !read.supported || !read.linked) return false;
  return stripTiles(read).length > 0 || (read.status?.lastError ?? null) !== null;
}

/** The sentence about the last failed read, kept beside the figures that were kept; '' after a good read. */
export function stripProblem(read: RevenueCatMetricsRead | null): string {
  const error = read?.status?.lastError ?? null;
  if (error === null) return '';
  return read?.metrics ? t('products:metrics.staleProblem', { error }) : error;
}
