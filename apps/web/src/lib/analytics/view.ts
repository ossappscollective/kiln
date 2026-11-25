import type { MetricUnit } from '@kiln/core';
import { platformSupports, supports } from '@kiln/core';
import { timeAgo } from '../format.ts';
import { formatList } from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';
import {
  type AnalyticsOverview,
  type AnalyticsSeries,
  type AnalyticsStatus,
  type AnalyticsSyncResult,
  type Delta,
  type DeltaTone,
  deltaLine,
  deltaSpoken,
  deltaTone,
  deriveRatioSeries,
  formatDay,
  formatExact,
  formatValue,
  freshnessLine,
  hasData,
  isProvisional,
  lastValue,
  levelDelta,
  noteText,
  periodDelta,
  type SourceState,
  type SourceStatus,
  type StepAction,
  seriesOf,
  setupSentence,
  sourceLabel,
  stateInfo,
  stateLabel,
  stateOf,
  stepAction,
  storedErrorText,
} from './analytics.ts';
import { type GuideKind, guideKindOf, isTestable } from './guide.ts';

const metricKeys: Record<string, string> = {
  impressions: k('analytics:metric.impressions'),
  product_page_views: k('analytics:metric.productPageViews'),
  downloads_first_time: k('analytics:metric.downloadsFirstTime'),
  downloads_redownload: k('analytics:metric.downloadsRedownload'),
  sessions: k('analytics:metric.sessions'),
  crashes: k('analytics:metric.crashes'),
  sales_units: k('analytics:metric.salesUnits'),
  sales_proceeds: k('analytics:metric.salesProceeds'),
  crash_rate: k('analytics:metric.crashRate'),
  anr_rate: k('analytics:metric.anrRate'),
  crash_rate_perceived: k('analytics:metric.crashRatePerceived'),
  anr_rate_perceived: k('analytics:metric.anrRatePerceived'),
  crash_users: k('analytics:metric.crashUsers'),
  anr_users: k('analytics:metric.anrUsers'),
  installs_user: k('analytics:metric.installsUser'),
  installs_device: k('analytics:metric.installsDevice'),
  uninstalls_device: k('analytics:metric.uninstallsDevice'),
  active_installs_device: k('analytics:metric.activeInstallsDevice'),
  rating_average_daily: k('analytics:metric.ratingAverageDaily'),
  rating_average_total: k('analytics:metric.ratingAverageTotal'),
  store_listing_visitors: k('analytics:metric.storeListingVisitors'),
  store_listing_acquisitions: k('analytics:metric.storeListingAcquisitions'),
  sales_gross: k('analytics:metric.salesGross'),
  sales_refunds: k('analytics:metric.salesRefunds'),
  sales_orders: k('analytics:metric.salesOrders'),
  earnings_net: k('analytics:metric.earningsNet'),
  earnings_charges: k('analytics:metric.earningsCharges'),
  earnings_taxes: k('analytics:metric.earningsTaxes'),
  earnings_fees: k('analytics:metric.earningsFees'),
  earnings_orders: k('analytics:metric.earningsOrders'),
  subscriptions_active: k('analytics:metric.subscriptionsActive'),
  subscriptions_active_offer: k('analytics:metric.subscriptionsActiveOffer'),
  subscriptions_active_trial: k('analytics:metric.subscriptionsActiveTrial'),
  subscriptions_new: k('analytics:metric.subscriptionsNew'),
  subscriptions_cancelled: k('analytics:metric.subscriptionsCancelled'),
  subscriptions_trial_conversions: k('analytics:metric.subscriptionsTrialConversions'),
  play_subscriptions_active: k('analytics:metric.playSubscriptionsActive'),
  play_subscriptions_new: k('analytics:metric.playSubscriptionsNew'),
  play_subscriptions_cancelled: k('analytics:metric.playSubscriptionsCancelled'),
};

/** The name of a metric in the active language; the API's own (English) label when the metric has no message. */
export const metricLabel = (metric: string, label: string): string => {
  const key = metricKeys[metric];
  return key ? t(key) : label;
};

/** The name of a series in the active language: the API sends English labels, so the metric id (or a derived id) picks the message. */
export function seriesLabel(
  series: Pick<AnalyticsSeries, 'id' | 'metric' | 'label' | 'source'>,
): string {
  const key = metricKeys[series.metric];
  if (key) return t(key);
  if (series.id === 'product_page_conversion')
    return series.source.indexOf('play_') === 0
      ? t('analytics:series.storeListingConversion')
      : t('analytics:series.productPageConversion');
  if (series.id === 'impression_tap_rate') return t('analytics:series.tapThroughRate');
  if (series.id === 'crash_rate_derived') return t('analytics:series.crashesPerSession');
  return series.label;
}

/**
 * What the Analytics screen draws, worked out from the API's answers: the row of figures, the small-multiple chart cards
 * with their tooltips and table twins, the freshness lines, and the state of the sources as next steps. Pure.
 *
 * One platform is one overview. Nothing is merged across platforms (Apple downloads and Google installs are different
 * measures), across currencies, or across sources.
 */

// ---------------------------------------------------------------------------------------------
// The row of figures

export type StatChipModel = {
  id: string;
  label: string;
  value: string;
  /** Said on hover and to a screen reader: how the figure is made, when it is not a plain store number. */
  title: string;
  delta: Delta;
  /** "+12% vs previous 28 days", or what is missing, or ''. */
  line: string;
  spoken: string;
  tone: DeltaTone;
};

type ChipSpec = {
  id: string;
  labelKey: string;
  upIsGood: boolean;
  /** `total`: the sum or mean over the range. `level`: the newest value (a rating). */
  kind: 'total' | 'level';
  titleKey: string;
  pick: (overview: AnalyticsOverview | null) => AnalyticsSeries | null;
};

/** Crashes divided by sessions, from the two Apple usage series (both come from users who opted in). Null without both. */
export function appleCrashRate(overview: AnalyticsOverview | null): AnalyticsSeries | null {
  const crashes = seriesOf(overview, 'crashes');
  const sessions = seriesOf(overview, 'sessions');
  if (!hasData(crashes) || !hasData(sessions)) return null;
  const derived = deriveRatioSeries({
    id: 'crash_rate_derived',
    label: t('analytics:series.crashesPerSession'),
    numerator: crashes,
    denominator: sessions,
  });
  return hasData(derived) ? derived : null;
}

const appleSpecs: ChipSpec[] = [
  {
    id: 'impressions',
    labelKey: k('analytics:chip.impressions'),
    upIsGood: true,
    kind: 'total',
    titleKey: k('analytics:chipTitle.impressions'),
    pick: (o) => seriesOf(o, 'impressions'),
  },
  {
    id: 'product_page_views',
    labelKey: k('analytics:chip.productPageViews'),
    upIsGood: true,
    kind: 'total',
    titleKey: k('analytics:chipTitle.pageViews'),
    pick: (o) => seriesOf(o, 'product_page_views'),
  },
  {
    id: 'downloads',
    labelKey: k('analytics:chip.downloads'),
    upIsGood: true,
    kind: 'total',
    titleKey: k('analytics:chipTitle.downloadsApple'),
    pick: (o) => seriesOf(o, 'downloads_first_time'),
  },
  {
    id: 'conversion',
    labelKey: k('analytics:chip.conversion'),
    upIsGood: true,
    kind: 'total',
    titleKey: k('analytics:chipTitle.conversionApple'),
    pick: (o) => seriesOf(o, 'product_page_conversion'),
  },
  {
    id: 'crash_rate',
    labelKey: k('analytics:chip.crashRate'),
    upIsGood: false,
    kind: 'total',
    titleKey: k('analytics:chipTitle.crashRateApple'),
    pick: appleCrashRate,
  },
];

const googleSpecs: ChipSpec[] = [
  {
    id: 'downloads',
    labelKey: k('analytics:chip.installs'),
    upIsGood: true,
    kind: 'total',
    titleKey: k('analytics:chipTitle.installs'),
    pick: (o) => seriesOf(o, 'installs_user'),
  },
  {
    id: 'product_page_views',
    labelKey: k('analytics:chip.storeVisitors'),
    upIsGood: true,
    kind: 'total',
    titleKey: k('analytics:chipTitle.storeVisitors'),
    pick: (o) => seriesOf(o, 'store_listing_visitors'),
  },
  {
    id: 'conversion',
    labelKey: k('analytics:chip.conversion'),
    upIsGood: true,
    kind: 'total',
    titleKey: k('analytics:chipTitle.conversionGoogle'),
    pick: (o) => seriesOf(o, 'product_page_conversion'),
  },
  {
    id: 'crash_rate',
    labelKey: k('analytics:chip.crashRate'),
    upIsGood: false,
    kind: 'total',
    titleKey: k('analytics:chipTitle.crashRateGoogle'),
    pick: (o) => seriesOf(o, 'crash_rate'),
  },
  {
    id: 'anr_rate',
    labelKey: k('analytics:chip.anrRate'),
    upIsGood: false,
    kind: 'total',
    titleKey: k('analytics:chipTitle.anrRate'),
    pick: (o) => seriesOf(o, 'anr_rate'),
  },
  {
    id: 'rating',
    labelKey: k('analytics:chip.rating'),
    upIsGood: true,
    kind: 'level',
    titleKey: k('analytics:chipTitle.rating'),
    pick: (o) => seriesOf(o, 'rating_average_total'),
  },
];

/** The figures for the top row: only those that have data. A figure with nothing behind it is not drawn. */
export function buildChips(
  platform: string,
  current: AnalyticsOverview | null,
  previous: AnalyticsOverview | null,
  days: number,
): StatChipModel[] {
  const specs = platformSupports(platform, 'playReportsBucket') ? googleSpecs : appleSpecs;
  const chips: StatChipModel[] = [];
  for (const spec of specs) {
    const now = spec.pick(current);
    if (!hasData(now)) continue;
    const before = spec.pick(previous);
    const raw = spec.kind === 'level' ? lastValue(now) : now.total;
    if (raw === null) continue;
    const delta = spec.kind === 'level' ? levelDelta(now, before) : periodDelta(now, before, days);
    chips.push({
      id: spec.id,
      label: t(spec.labelKey),
      value: formatValue(now.unit, raw, now.currency),
      title: t(spec.titleKey),
      delta,
      line: deltaLine(delta, days),
      spoken: deltaSpoken(delta, days),
      tone: deltaTone(delta, spec.upIsGood),
    });
  }
  return chips;
}

// ---------------------------------------------------------------------------------------------
// Chart cards (small multiples)

export type PanelKind = 'line' | 'columns' | 'stacked';
export type PanelSeries = { key: string; label: string; color: 1 | 2; series: AnalyticsSeries };
export type ChartPanel = {
  id: string;
  /** Named when the card has several panels (or a currency); the card title names a lone panel. */
  title: string | null;
  kind: PanelKind;
  unit: MetricUnit;
  currency: string | null;
  /** `zero`: the axis starts at zero (counts, rates, money). `tight`: it follows the data (a rating, which never starts at zero). */
  domain: 'zero' | 'tight';
  series: PanelSeries[];
};
export type VersionBars = {
  id: string;
  title: string;
  unit: MetricUnit;
  items: { value: string; total: number }[];
};
export type ChartCard = {
  id: string;
  title: string;
  panels: ChartPanel[];
  versions: VersionBars[];
};

type Entry = [AnalyticsSeries | null, string | null, 1 | 2];

function makePanel(
  id: string,
  title: string | null,
  kind: PanelKind,
  unit: MetricUnit,
  entries: Entry[],
  options: { domain?: 'zero' | 'tight'; currency?: string | null } = {},
): ChartPanel | null {
  const series: PanelSeries[] = [];
  for (const [s, label, color] of entries) {
    if (!hasData(s)) continue;
    series.push({ key: s.id, label: label ?? seriesLabel(s), color, series: s });
  }
  if (series.length === 0) return null;
  return {
    id,
    title,
    kind,
    unit,
    currency: options.currency ?? null,
    domain: options.domain ?? 'zero',
    series,
  };
}

const present = <T>(list: (T | null)[]): T[] => list.filter((p): p is T => p !== null);

function versionBars(
  id: string,
  title: string,
  series: AnalyticsSeries | null,
): VersionBars | null {
  const breakdown = series?.breakdown;
  if (
    !series ||
    !breakdown ||
    breakdown.dimension !== 'app_version' ||
    breakdown.items.length === 0
  )
    return null;
  return { id, title, unit: series.unit, items: breakdown.items };
}

function card(
  id: string,
  title: string,
  panels: (ChartPanel | null)[],
  versions: (VersionBars | null)[] = [],
): ChartCard | null {
  const list = present(panels);
  if (list.length === 0) return null;
  // A lone panel is named by the card; with several, each keeps its own title.
  const named =
    list.length === 1 && !list[0]?.currency ? [{ ...(list[0] as ChartPanel), title: null }] : list;
  return { id, title, panels: named, versions: present(versions) };
}

/**
 * The one chart the Insights overview draws open: the downloads (Apple) or installs (Google Play) card, else the first one. The
 * others come after it, in reading order, behind "More charts".
 */
export function splitHeadline(cards: readonly ChartCard[]): {
  headline: ChartCard | null;
  rest: ChartCard[];
} {
  if (cards.length === 0) return { headline: null, rest: [] };
  const found = cards.findIndex((c) => c.id === 'downloads' || c.id === 'installs');
  const at = Math.max(found, 0);
  return { headline: cards[at] ?? null, rest: cards.filter((_, i) => i !== at) };
}

/** What the Android sales card is called: the numbers are buyer-paid estimates, not proceeds (the Apple card is "Proceeds"). */
export const salesCardTitleGoogle = (): string => t('analytics:card.salesGoogle');

/**
 * The chart cards of one platform, in reading order: reach, downloads, conversion, crashes, ratings, proceeds (Apple) or sales (Google).
 * A card with no data is not drawn; the screen says in one quiet line when nothing is.
 */
export function buildCards(overview: AnalyticsOverview | null): ChartCard[] {
  if (!overview) return [];
  const s = (id: string) => seriesOf(overview, id);
  const cards: (ChartCard | null)[] = [];
  if (platformSupports(overview.platform, 'playReportsBucket')) {
    cards.push(
      card('installs', t('analytics:card.installs'), [
        makePanel('installs_user', t('analytics:panel.userInstalls'), 'columns', 'count', [
          [s('installs_user'), null, 1],
        ]),
        makePanel('uninstalls_device', t('analytics:panel.deviceUninstalls'), 'columns', 'count', [
          [s('uninstalls_device'), null, 1],
        ]),
      ]),
      card('listing', t('analytics:card.listing'), [
        makePanel('store_listing_visitors', t('analytics:panel.visitors'), 'line', 'count', [
          [s('store_listing_visitors'), null, 1],
        ]),
        makePanel(
          'store_listing_acquisitions',
          t('analytics:panel.acquisitions'),
          'line',
          'count',
          [[s('store_listing_acquisitions'), null, 1]],
        ),
      ]),
      card('conversion', t('analytics:card.listingConversion'), [
        makePanel('product_page_conversion', null, 'line', 'ratio', [
          [s('product_page_conversion'), null, 1],
        ]),
      ]),
      card(
        'vitals',
        t('analytics:card.vitals'),
        [
          makePanel('vitals', null, 'line', 'ratio', [
            [s('crash_rate'), null, 1],
            [s('anr_rate'), null, 2],
          ]),
        ],
        [
          versionBars('crash_rate_versions', t('analytics:versions.crashRate'), s('crash_rate')),
          versionBars('anr_rate_versions', t('analytics:versions.anrRate'), s('anr_rate')),
        ],
      ),
      card('ratings', t('analytics:card.ratings'), [
        makePanel(
          'ratings',
          null,
          'line',
          'rating',
          [
            [s('rating_average_total'), t('analytics:panel.ratingAll'), 1],
            [s('rating_average_daily'), t('analytics:panel.ratingDay'), 2],
          ],
          { domain: 'tight' },
        ),
      ]),
    );
    // Estimated sales are what BUYERS paid (tax included, Google's fee not deducted): never called proceeds, one panel per currency.
    const gross = overview.series.filter((x) => x.metric === 'sales_gross' && hasData(x));
    const refunds = overview.series.filter((x) => x.metric === 'sales_refunds' && hasData(x));
    cards.push(
      card('sales', salesCardTitleGoogle(), [
        ...gross.map((x) =>
          makePanel(
            x.id,
            x.currency ?? t('analytics:panel.sales'),
            'columns',
            'money',
            [
              [
                x,
                x.currency
                  ? t('analytics:panel.salesBuyerPaidCurrency', { currency: x.currency })
                  : t('analytics:panel.salesBuyerPaid'),
                1,
              ],
            ],
            { currency: x.currency },
          ),
        ),
        ...refunds.map((x) =>
          makePanel(
            x.id,
            x.currency
              ? t('analytics:panel.refundsCurrency', { currency: x.currency })
              : t('analytics:panel.refunds'),
            'columns',
            'money',
            [
              [
                x,
                x.currency
                  ? t('analytics:panel.refundsBuyerPaidCurrency', { currency: x.currency })
                  : t('analytics:panel.refundsBuyerPaid'),
                2,
              ],
            ],
            { currency: x.currency },
          ),
        ),
        makePanel('sales_orders', t('analytics:panel.orders'), 'columns', 'count', [
          [s('sales_orders'), null, 1],
        ]),
      ]),
    );
  } else {
    const crashRate = appleCrashRate(overview);
    cards.push(
      card('reach', t('analytics:card.reach'), [
        makePanel('impressions', t('analytics:panel.impressions'), 'line', 'count', [
          [s('impressions'), null, 1],
        ]),
        makePanel('product_page_views', t('analytics:panel.productPageViews'), 'line', 'count', [
          [s('product_page_views'), null, 1],
        ]),
      ]),
      card('downloads', t('analytics:card.downloads'), [
        makePanel('downloads', null, 'stacked', 'count', [
          [s('downloads_first_time'), null, 1],
          [s('downloads_redownload'), null, 2],
        ]),
      ]),
      card('conversion', t('analytics:card.conversion'), [
        makePanel(
          'product_page_conversion',
          t('analytics:panel.productPageConversion'),
          'line',
          'ratio',
          [[s('product_page_conversion'), null, 1]],
        ),
        makePanel('impression_tap_rate', t('analytics:panel.tapThroughRate'), 'line', 'ratio', [
          [s('impression_tap_rate'), null, 1],
        ]),
      ]),
      card(
        'crashes',
        t('analytics:card.crashes'),
        [
          makePanel('crashes', t('analytics:panel.crashes'), 'columns', 'count', [
            [s('crashes'), null, 1],
          ]),
          makePanel('crash_rate_derived', t('analytics:panel.crashesPerSession'), 'line', 'ratio', [
            [crashRate, null, 1],
          ]),
        ],
        [versionBars('crash_versions', t('analytics:versions.crashes'), s('crashes'))],
      ),
    );
    const proceeds = overview.series.filter((x) => x.metric === 'sales_proceeds' && hasData(x));
    cards.push(
      card(
        'proceeds',
        t('analytics:card.proceeds'),
        proceeds.map((x) =>
          makePanel(
            x.id,
            x.currency ?? t('analytics:panel.proceeds'),
            'columns',
            'money',
            [
              [
                x,
                x.currency
                  ? t('analytics:panel.proceedsCurrency', { currency: x.currency })
                  : t('analytics:panel.proceeds'),
                1,
              ],
            ],
            { currency: x.currency },
          ),
        ),
      ),
    );
  }
  return present(cards);
}

/** Apple has no rating history; the screen says so in one quiet line instead of an empty chart. */
export const noRatingHistory = (platform: string): boolean =>
  !platformSupports(platform, 'ratingHistory');

export const allSeries = (c: ChartCard): AnalyticsSeries[] => {
  const out: AnalyticsSeries[] = [];
  for (const p of c.panels)
    for (const ps of p.series) if (out.indexOf(ps.series) < 0) out.push(ps.series);
  return out;
};

/** The sum of a panel's first series over the days shown (a missing day counts as nothing). */
export const panelTotal = (p: ChartPanel): number =>
  (p.series[0]?.series.points ?? []).reduce((n, pt) => n + (pt.value ?? 0), 0);

/**
 * The currencies a card draws, the one with the most volume first (by its first panel in that currency). Money is never added across
 * currencies, so a card with several shows one currency at a time (tabs) instead of one long chart per currency.
 */
export function cardCurrencies(c: ChartCard): string[] {
  const volume = new Map<string, number>();
  for (const p of c.panels) {
    if (p.currency && !volume.has(p.currency)) volume.set(p.currency, panelTotal(p));
  }
  return [...volume.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([currency]) => currency);
}

/** The panels shown for one currency: its own, and the ones that belong to no currency (orders). */
export const panelsForCurrency = (c: ChartCard, currency: string): ChartPanel[] =>
  c.panels
    .filter((p) => p.currency === null || p.currency === currency)
    // The tab already names the currency: a panel titled with just the code needs no title of its own.
    .map((p) => (p.currency !== null && p.title === p.currency ? { ...p, title: null } : p));

/** The dates of a card's charts (every series of one overview shares them). */
export const cardDates = (c: ChartCard): string[] =>
  (c.panels[0]?.series[0]?.series.points ?? []).map((p) => p.date);

// ---------------------------------------------------------------------------------------------
// The honesty lines of a card

/** One line per source: "Data up to Nov 17. Apple reports can lag up to 3 days." The newest day of each source is used. */
export function cardFreshness(c: ChartCard): string[] {
  const best = new Map<string, AnalyticsSeries>();
  for (const s of allSeries(c)) {
    const have = best.get(s.source);
    if (!have || (s.coverage.lastDay ?? '') > (have.coverage.lastDay ?? '')) best.set(s.source, s);
  }
  const lines: string[] = [];
  best.forEach((s) => lines.push(freshnessLine(s)));
  return lines;
}

export type CardSeriesInfo = {
  id: string;
  label: string;
  source: string;
  coverage: string;
  freshness: string;
  notes: string[];
};

const coverageWords = (s: AnalyticsSeries): string => {
  // A monthly figure counts months: a day-count would say "1 day with data" for a month.
  if (s.cadence === 'monthly') {
    if (s.coverage.state === 'none') return t('analytics:coverage.noMonths');
    const withData = t('analytics:coverage.monthsWithData', { count: s.coverage.days });
    return s.coverage.gapDays > 0
      ? formatList(
          [withData, t('analytics:coverage.monthsMissing', { count: s.coverage.gapDays })],
          { type: 'unit' },
        )
      : withData;
  }
  if (s.coverage.state === 'none') return t('analytics:coverage.noDays');
  const withData = t('analytics:coverage.daysWithData', { count: s.coverage.days });
  return s.coverage.gapDays > 0
    ? formatList([withData, t('analytics:coverage.daysMissing', { count: s.coverage.gapDays })], {
        type: 'unit',
      })
    : withData;
};

/** What the "About this data" popover lists per series: its source, how complete it is, how late it can be, and its notes. */
export function cardInfo(c: ChartCard): CardSeriesInfo[] {
  return allSeries(c).map((s) => ({
    id: s.id,
    label: seriesLabel(s),
    source: s.derived
      ? t('analytics:info.derivedHere', { source: sourceLabel(s.source) })
      : sourceLabel(s.source),
    coverage: coverageWords(s),
    freshness: freshnessLine(s),
    notes: s.coverage.notes.map(noteText),
  }));
}

/** The limits that apply to the whole page for a platform, once: counts are not people, usage is a sample, small counts are dropped. */
export function pageNotes(overview: AnalyticsOverview | null): string[] {
  if (!overview) return [];
  const wanted = [
    'apple_counts_not_unique',
    'apple_usage_opt_in_only',
    'apple_privacy_thresholds',
    'apple_estimates',
    'google_monthly_files',
    'google_unit_unverified',
    'play_estimated_sales_gross',
    'play_sales_latency',
  ];
  const seen: string[] = [];
  for (const s of overview.series) {
    if (!hasData(s)) continue;
    for (const n of s.coverage.notes)
      if (wanted.indexOf(n.code) >= 0 && seen.indexOf(n.code) < 0) seen.push(n.code);
  }
  const ordered = wanted.filter((code) => seen.indexOf(code) >= 0);
  const out = ordered.map((code) => noteText({ code, message: '' }));
  for (const n of overview.notes)
    if (n.code !== 'apple_rating_history_not_available' && n.code !== 'google_no_impressions')
      out.push(noteText(n));
  return out;
}

/** The notes the API gives for the platform as a whole, in words: no impressions on Google, no rating history on Apple. */
export const platformNotes = (overview: AnalyticsOverview | null): string[] =>
  (overview?.notes ?? []).map(noteText);

// ---------------------------------------------------------------------------------------------
// Tooltip and table twin

export type TipRow = {
  key: string;
  label: string /** 0: no swatch (a total). */;
  color: 0 | 1 | 2;
  text: string;
  missing: boolean;
};
export type Tip = { date: string; heading: string; rows: TipRow[]; provisional: boolean };

/** What the tooltip says at one position: every series of the panel with its exact value, or "No data". */
export function tooltipFor(panel: ChartPanel, index: number, today: string): Tip | null {
  const first = panel.series[0]?.series.points[index];
  if (!first) return null;
  const rows: TipRow[] = panel.series.map((ps) => {
    const v = ps.series.points[index]?.value ?? null;
    return {
      key: ps.key,
      label: ps.label,
      color: ps.color,
      text:
        v === null ? t('analytics:tip.noData') : formatExact(ps.series.unit, v, ps.series.currency),
      missing: v === null,
    };
  });
  if (panel.kind === 'stacked' && panel.series.length > 1) {
    const values = panel.series
      .map((ps) => ps.series.points[index]?.value ?? null)
      .filter((v): v is number => v !== null);
    if (values.length > 0)
      rows.push({
        key: '__total',
        label: t('analytics:tip.total'),
        color: 0,
        text: formatExact(
          panel.unit,
          values.reduce((a, b) => a + b, 0),
          panel.currency,
        ),
        missing: false,
      });
  }
  const provisional = panel.series.some(
    (ps) =>
      ps.series.points[index]?.value !== null &&
      isProvisional(first.date, today, ps.series.delayDays),
  );
  return { date: first.date, heading: formatDay(first.date, true), rows, provisional };
}

/** The accessible name of a chart: what it shows and its extremes, so the picture is not the only way to read it. */
export function describePanel(panel: ChartPanel, cardTitle: string): string {
  const name = panel.title ?? cardTitle;
  const parts: string[] = [];
  for (const ps of panel.series) {
    const values = ps.series.points.map((p) => p.value).filter((v): v is number => v !== null);
    if (values.length === 0) continue;
    const fmt = (v: number) => formatValue(ps.series.unit, v, ps.series.currency);
    const missing = ps.series.points.length - values.length;
    const figures = {
      label: ps.label,
      latest: fmt(lastValue(ps.series) ?? 0),
      lowest: fmt(Math.min(...values)),
      highest: fmt(Math.max(...values)),
    };
    parts.push(
      missing > 0
        ? t('analytics:panel.describeSeriesMissing', { ...figures, count: missing })
        : t('analytics:panel.describeSeries', figures),
    );
  }
  return parts.length === 0
    ? t('analytics:panel.describeNone', { name })
    : t('analytics:panel.describe', { name, parts: parts.join(' ') });
}

export type DataTableModel = { columns: string[]; rows: { date: string; cells: string[] }[] };

/** The table twin of a card: a row per day, a column per series, "No data" where there is none. A value the store sent unverified also shows as sent. */
export function tableFor(c: ChartCard): DataTableModel {
  const columns = [t('analytics:table.date')];
  const specs: { series: AnalyticsSeries; raw: boolean }[] = [];
  for (const s of allSeries(c)) {
    columns.push(seriesLabel(s));
    specs.push({ series: s, raw: false });
    if (s.coverage.notes.some((n) => n.code === 'google_unit_unverified')) {
      columns.push(t('analytics:table.asSent', { label: seriesLabel(s) }));
      specs.push({ series: s, raw: true });
    }
  }
  const dates = cardDates(c);
  const rows = dates.map((date, i) => ({
    date: formatDay(date, true),
    cells: specs.map(({ series, raw }) => {
      const v = series.points[i]?.value ?? null;
      if (v === null) return t('analytics:tip.noData');
      return raw ? String(v) : formatExact(series.unit, v, series.currency);
    }),
  }));
  return { columns, rows };
}

// ---------------------------------------------------------------------------------------------
// The state of the sources, as next steps

export const hasStoredData = (status: AnalyticsStatus | null): boolean =>
  !!status && status.sources.some((s) => s.lastDay !== null);

/** The state to show for the app as a whole: off, else the worst of its required sources; an optional setup does not count. */
export function overallState(status: AnalyticsStatus): SourceState {
  if (!status.enabled) return 'off';
  const states = status.sources
    .filter((s) => !(s.state === 'needs_setup' && s.setup?.optional === true))
    .map((s) => stateOf(s.state));
  // The worst state first: a failed read or a missing setup is not hidden by a source that works.
  for (const wanted of ['error', 'needs_setup', 'waiting'] as SourceState[])
    if (states.indexOf(wanted) >= 0) return wanted;
  return 'ready';
}

export type SourceRow = {
  source: string;
  label: string;
  state: SourceState;
  stateLabel: string;
  tone: 'neutral' | 'warn' | 'info' | 'bad' | 'ok';
  icon: 'check-circle' | 'clock' | 'alert-triangle' | 'x-circle' | 'info';
  optional: boolean;
  /** The sentence for a person, from a fixed vocabulary. */
  message: string;
  /** The last failed read, when there is one and the message above is not already about it. */
  error: string | null;
  action: StepAction | null;
  alternatives: StepAction[];
  range: string | null;
  lastRead: string;
  /** The setup code, else the code of the last failed read: what the guide below the row switches on. */
  code: string | null;
  /** The setup guide that explains the cause with real links, or null. It replaces a next step that has no button. */
  guide: GuideKind | null;
  /** "Test access" can check this source with one call. */
  testable: boolean;
};

const usable = (a: StepAction | null): a is StepAction =>
  a !== null && !(a.kind === 'text' && a.label === t('analytics:step.wait'));

export function sourceRows(status: AnalyticsStatus, now: number): SourceRow[] {
  return status.sources.map((s: SourceStatus): SourceRow => {
    const state = stateOf(s.state);
    const info = stateInfo[state];
    const setup = s.setup;
    let message: string;
    if (setup) message = setupSentence(setup.code);
    else if (state === 'ready')
      message =
        s.firstDay && s.lastDay
          ? t('analytics:sourceRow.dataFromTo', {
              from: formatDay(s.firstDay, true),
              to: formatDay(s.lastDay, true),
            })
          : t('analytics:sourceRow.ready');
    else if (state === 'off') message = setupSentence('turn_on_analytics');
    else message = t('analytics:sourceRow.noData');
    const stepFor = (step: string | undefined): StepAction | null =>
      step ? stepAction(step) : null;
    const code = setup?.code ?? s.lastError?.code ?? null;
    const guide = guideKindOf(code);
    // A guide with real links replaces a next step that is only words ("Grant the Play permission").
    let action = guide !== null && guide !== 'play_bucket_id' ? null : stepFor(setup?.nextStep);
    if (!action && state === 'error') action = stepAction('sync_now');
    const alternatives = (setup?.alternatives ?? [])
      .map((a) => stepAction(a))
      .filter((a) => usable(a));
    return {
      source: s.source,
      label: s.label || sourceLabel(s.source),
      state,
      stateLabel: stateLabel(state),
      tone: info.tone,
      icon: info.icon,
      optional: setup?.optional === true,
      message,
      error: s.lastError ? storedErrorText(s.lastError.code) : null,
      action: usable(action) ? action : null,
      alternatives,
      range:
        s.firstDay && s.lastDay
          ? t('analytics:range.fromTo', {
              from: formatDay(s.firstDay, true),
              to: formatDay(s.lastDay, true),
            })
          : null,
      code,
      guide,
      testable: isTestable(s.source) && state !== 'ready' && state !== 'off',
      lastRead:
        s.lastOkAt === null
          ? s.lastAttemptAt === null
            ? t('analytics:sourceRow.notRead')
            : t('analytics:sourceRow.tried', { ago: timeAgo(s.lastAttemptAt, now) })
          : t('analytics:sourceRow.lastRead', { ago: timeAgo(s.lastOkAt, now) }),
    };
  });
}

/** The newest successful read over all sources, or null. */
export function lastReadAt(status: AnalyticsStatus): number | null {
  let best: number | null = null;
  for (const s of status.sources)
    if (s.lastOkAt !== null && (best === null || s.lastOkAt > best)) best = s.lastOkAt;
  return best;
}

export function scheduleText(status: AnalyticsStatus): string {
  const minutes = status.schedule.intervalMinutes;
  if (!status.enabled) return t('analytics:schedule.off');
  if (minutes <= 0) return t('analytics:schedule.none');
  if (minutes % 1440 === 0) return t('analytics:schedule.everyDay', { count: minutes / 1440 });
  if (minutes % 60 === 0) return t('analytics:schedule.everyHour', { count: minutes / 60 });
  return t('analytics:schedule.everyMinute', { count: minutes });
}

export type SyncLine = {
  source: string;
  label: string;
  text: string;
  tone: 'ok' | 'warn' | 'bad' | 'neutral';
};

/** One line per source of a manual sync, in fixed words. A store failure is a code, never the store's text. */
export function syncLines(sync: AnalyticsSyncResult['sync']): SyncLine[] {
  return sync.sources.map((s): SyncLine => {
    const label = sourceLabel(s.source);
    if (s.status === 'ok') {
      const count = s.points ?? 0;
      return {
        source: s.source,
        label,
        text:
          count <= 0
            ? t('analytics:sync.nothingNew')
            : s.dayFrom && s.dayTo
              ? t('analytics:sync.readValuesSpan', {
                  count,
                  from: formatDay(s.dayFrom),
                  to: formatDay(s.dayTo),
                })
              : t('analytics:sync.readValues', { count }),
        tone: 'ok',
      };
    }
    if (s.status === 'partial')
      return {
        source: s.source,
        label,
        text: s.errorCode
          ? t('analytics:sync.partialWith', { error: storedErrorText(s.errorCode) })
          : t('analytics:sync.partial'),
        tone: 'warn',
      };
    if (s.status === 'failed') {
      const reason = s.errorCode ? storedErrorText(s.errorCode) : t('analytics:sync.readFailed');
      return {
        source: s.source,
        label,
        text: s.transient === true ? t('analytics:sync.withRetry', { text: reason }) : reason,
        tone: 'bad',
      };
    }
    if (s.status === 'skipped') {
      const why =
        s.setup === 'import_only'
          ? t('analytics:sync.skippedImport')
          : t('analytics:sync.skipped', {
              reason: s.setup ? setupSentence(s.setup) : t('analytics:sync.cannotRun'),
            });
      return { source: s.source, label, text: why, tone: 'neutral' };
    }
    return { source: s.source, label, text: t('analytics:sync.done'), tone: 'neutral' };
  });
}

// ---------------------------------------------------------------------------------------------
// The compact strip of the app dashboard

export type StripItem = {
  id: string;
  label: string;
  value: string;
  title: string;
  points: (number | null)[];
  dates: string[];
  unit: MetricUnit;
};
export type Strip = { items: StripItem[]; freshness: string };

/** Downloads, conversion and crash rate with their trend, or null when none has data (the dashboard then draws nothing). */
export function buildStrip(overview: AnalyticsOverview | null): Strip | null {
  if (!overview) return null;
  const android = platformSupports(overview.platform, 'playReportsBucket');
  const picks: { id: string; label: string; title: string; series: AnalyticsSeries | null }[] =
    android
      ? [
          {
            id: 'downloads',
            label: t('analytics:chip.installs'),
            title: t('analytics:strip.installs'),
            series: seriesOf(overview, 'installs_user'),
          },
          {
            id: 'conversion',
            label: t('analytics:chip.conversion'),
            title: t('analytics:strip.conversionGoogle'),
            series: seriesOf(overview, 'product_page_conversion'),
          },
          {
            id: 'crash_rate',
            label: t('analytics:chip.crashRate'),
            title: t('analytics:strip.crashRateGoogle'),
            series: seriesOf(overview, 'crash_rate'),
          },
        ]
      : [
          {
            id: 'downloads',
            label: t('analytics:chip.downloads'),
            title: t('analytics:strip.downloadsApple'),
            series: seriesOf(overview, 'downloads_first_time'),
          },
          {
            id: 'conversion',
            label: t('analytics:chip.conversion'),
            title: t('analytics:strip.conversionApple'),
            series: seriesOf(overview, 'product_page_conversion'),
          },
          {
            id: 'crash_rate',
            label: t('analytics:chip.crashRate'),
            title: t('analytics:strip.crashRateApple'),
            series: appleCrashRate(overview),
          },
        ];
  const items: StripItem[] = [];
  let newest: AnalyticsSeries | null = null;
  for (const p of picks) {
    const s = p.series;
    if (!hasData(s) || s.total === null) continue;
    items.push({
      id: p.id,
      label: p.label,
      value: formatValue(s.unit, s.total, s.currency),
      title: p.title,
      points: s.points.map((x) => x.value),
      dates: s.points.map((x) => x.date),
      unit: s.unit,
    });
    if (!newest || (s.coverage.lastDay ?? '') > (newest.coverage.lastDay ?? '')) newest = s;
  }
  if (items.length === 0 || !newest) return null;
  return { items, freshness: freshnessLine(newest) };
}
