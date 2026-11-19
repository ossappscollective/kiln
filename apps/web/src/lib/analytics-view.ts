import type { MetricUnit } from '@mrm/core';
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
  stateOf,
  stepAction,
  storedErrorText,
} from './analytics.ts';
import { timeAgo } from './format.ts';

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
  label: string;
  upIsGood: boolean;
  /** `total`: the sum or mean over the range. `level`: the newest value (a rating). */
  kind: 'total' | 'level';
  title: string;
  pick: (overview: AnalyticsOverview | null) => AnalyticsSeries | null;
};

/** Crashes divided by sessions, from the two Apple usage series (both come from users who opted in). Null without both. */
export function appleCrashRate(overview: AnalyticsOverview | null): AnalyticsSeries | null {
  const crashes = seriesOf(overview, 'crashes');
  const sessions = seriesOf(overview, 'sessions');
  if (!hasData(crashes) || !hasData(sessions)) return null;
  const derived = deriveRatioSeries({
    id: 'crash_rate_derived',
    label: 'Crashes per session',
    numerator: crashes,
    denominator: sessions,
  });
  return hasData(derived) ? derived : null;
}

const appleSpecs: ChipSpec[] = [
  {
    id: 'impressions',
    label: 'Impressions',
    upIsGood: true,
    kind: 'total',
    title: 'Counts of impressions, not unique people.',
    pick: (o) => seriesOf(o, 'impressions'),
  },
  {
    id: 'product_page_views',
    label: 'Product page views',
    upIsGood: true,
    kind: 'total',
    title: 'Counts of page views, not unique people.',
    pick: (o) => seriesOf(o, 'product_page_views'),
  },
  {
    id: 'downloads',
    label: 'First-time downloads',
    upIsGood: true,
    kind: 'total',
    title: 'First-time downloads. Redownloads are in the chart below.',
    pick: (o) => seriesOf(o, 'downloads_first_time'),
  },
  {
    id: 'conversion',
    label: 'Conversion',
    upIsGood: true,
    kind: 'total',
    title:
      'First-time downloads divided by product page views. Derived; it may not match App Store Connect.',
    pick: (o) => seriesOf(o, 'product_page_conversion'),
  },
  {
    id: 'crash_rate',
    label: 'Crash rate',
    upIsGood: false,
    kind: 'total',
    title:
      'Crashes divided by sessions, from the people who opted in to share data. Derived here; not a total.',
    pick: appleCrashRate,
  },
];

const googleSpecs: ChipSpec[] = [
  {
    id: 'downloads',
    label: 'Installs',
    upIsGood: true,
    kind: 'total',
    title: 'User installs from the Play Console monthly reports.',
    pick: (o) => seriesOf(o, 'installs_user'),
  },
  {
    id: 'product_page_views',
    label: 'Store visitors',
    upIsGood: true,
    kind: 'total',
    title: 'From the legacy store listing export, which Google changed in 2026.',
    pick: (o) => seriesOf(o, 'store_listing_visitors'),
  },
  {
    id: 'conversion',
    label: 'Conversion',
    upIsGood: true,
    kind: 'total',
    title:
      'Store listing acquisitions divided by visitors. Derived; it may not match Play Console.',
    pick: (o) => seriesOf(o, 'product_page_conversion'),
  },
  {
    id: 'crash_rate',
    label: 'Crash rate',
    upIsGood: false,
    kind: 'total',
    title: 'Mean daily crash rate from Android vitals, as the API sends it.',
    pick: (o) => seriesOf(o, 'crash_rate'),
  },
  {
    id: 'anr_rate',
    label: 'ANR rate',
    upIsGood: false,
    kind: 'total',
    title: 'Mean daily ANR rate from Android vitals, as the API sends it.',
    pick: (o) => seriesOf(o, 'anr_rate'),
  },
  {
    id: 'rating',
    label: 'Rating',
    upIsGood: true,
    kind: 'level',
    title:
      'The newest all-time average rating of the Play Console reports. No count of ratings is available.',
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
  const specs = platform === 'android' ? googleSpecs : appleSpecs;
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
      label: spec.label,
      value: formatValue(now.unit, raw, now.currency),
      title: spec.title,
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
    series.push({ key: s.id, label: label ?? s.label, color, series: s });
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
  const at = found < 0 ? 0 : found;
  return { headline: cards[at] ?? null, rest: cards.filter((_, i) => i !== at) };
}

/**
 * The chart cards of one platform, in reading order: reach, downloads, conversion, crashes, ratings, proceeds.
 * A card with no data is not drawn; the screen says in one quiet line when nothing is.
 */
export function buildCards(overview: AnalyticsOverview | null): ChartCard[] {
  if (!overview) return [];
  const s = (id: string) => seriesOf(overview, id);
  const cards: (ChartCard | null)[] = [];
  if (overview.platform === 'android') {
    cards.push(
      card('installs', 'Installs', [
        makePanel('installs_user', 'User installs', 'columns', 'count', [
          [s('installs_user'), null, 1],
        ]),
        makePanel('uninstalls_device', 'Device uninstalls', 'columns', 'count', [
          [s('uninstalls_device'), null, 1],
        ]),
      ]),
      card('listing', 'Store listing visitors and acquisitions', [
        makePanel('store_listing_visitors', 'Visitors', 'line', 'count', [
          [s('store_listing_visitors'), null, 1],
        ]),
        makePanel('store_listing_acquisitions', 'Acquisitions', 'line', 'count', [
          [s('store_listing_acquisitions'), null, 1],
        ]),
      ]),
      card('conversion', 'Store listing conversion', [
        makePanel('product_page_conversion', null, 'line', 'ratio', [
          [s('product_page_conversion'), null, 1],
        ]),
      ]),
      card(
        'vitals',
        'Crash and ANR rate',
        [
          makePanel('vitals', null, 'line', 'ratio', [
            [s('crash_rate'), null, 1],
            [s('anr_rate'), null, 2],
          ]),
        ],
        [
          versionBars('crash_rate_versions', 'Crash rate by app version', s('crash_rate')),
          versionBars('anr_rate_versions', 'ANR rate by app version', s('anr_rate')),
        ],
      ),
      card('ratings', 'Rating over time', [
        makePanel(
          'ratings',
          null,
          'line',
          'rating',
          [
            [s('rating_average_total'), 'Average rating, all time', 1],
            [s('rating_average_daily'), 'Average rating of the day', 2],
          ],
          { domain: 'tight' },
        ),
      ]),
    );
  } else {
    const crashRate = appleCrashRate(overview);
    cards.push(
      card('reach', 'Impressions and product page views', [
        makePanel('impressions', 'Impressions', 'line', 'count', [[s('impressions'), null, 1]]),
        makePanel('product_page_views', 'Product page views', 'line', 'count', [
          [s('product_page_views'), null, 1],
        ]),
      ]),
      card('downloads', 'Downloads', [
        makePanel('downloads', null, 'stacked', 'count', [
          [s('downloads_first_time'), null, 1],
          [s('downloads_redownload'), null, 2],
        ]),
      ]),
      card('conversion', 'Conversion', [
        makePanel('product_page_conversion', 'Product page conversion', 'line', 'ratio', [
          [s('product_page_conversion'), null, 1],
        ]),
        makePanel('impression_tap_rate', 'Tap-through rate', 'line', 'ratio', [
          [s('impression_tap_rate'), null, 1],
        ]),
      ]),
      card(
        'crashes',
        'Crashes',
        [
          makePanel('crashes', 'Crashes', 'columns', 'count', [[s('crashes'), null, 1]]),
          makePanel('crash_rate_derived', 'Crashes per session', 'line', 'ratio', [
            [crashRate, null, 1],
          ]),
        ],
        [versionBars('crash_versions', 'Crashes by app version', s('crashes'))],
      ),
    );
    const proceeds = overview.series.filter((x) => x.metric === 'sales_proceeds' && hasData(x));
    cards.push(
      card(
        'proceeds',
        'Proceeds',
        proceeds.map((x) =>
          makePanel(
            x.id,
            x.currency ?? 'Proceeds',
            'columns',
            'money',
            [[x, x.currency ? `Proceeds (${x.currency})` : 'Proceeds', 1]],
            { currency: x.currency },
          ),
        ),
      ),
    );
  }
  return present(cards);
}

/** Apple has no rating history; the screen says so in one quiet line instead of an empty chart. */
export const noRatingHistory = (platform: string): boolean => platform !== 'android';

export const allSeries = (c: ChartCard): AnalyticsSeries[] => {
  const out: AnalyticsSeries[] = [];
  for (const p of c.panels)
    for (const ps of p.series) if (out.indexOf(ps.series) < 0) out.push(ps.series);
  return out;
};

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
  if (s.coverage.state === 'none') return 'No days with data in this range';
  const gap =
    s.coverage.gapDays > 0
      ? `, ${s.coverage.gapDays} ${s.coverage.gapDays === 1 ? 'day' : 'days'} missing between the first and the last`
      : '';
  return `${s.coverage.days} ${s.coverage.days === 1 ? 'day' : 'days'} with data${gap}`;
};

/** What the "About this data" popover lists per series: its source, how complete it is, how late it can be, and its notes. */
export function cardInfo(c: ChartCard): CardSeriesInfo[] {
  return allSeries(c).map((s) => ({
    id: s.id,
    label: s.label,
    source: sourceLabel(s.source) + (s.derived ? ' (derived here)' : ''),
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
      text: v === null ? 'No data' : formatExact(ps.series.unit, v, ps.series.currency),
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
        label: 'Total',
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
    parts.push(
      `${ps.label}: latest ${fmt(lastValue(ps.series) ?? 0)}, lowest ${fmt(Math.min(...values))}, highest ${fmt(Math.max(...values))}${missing > 0 ? `, ${missing} ${missing === 1 ? 'day' : 'days'} with no data` : ''}`,
    );
  }
  return `${name}. ${parts.join('. ')}.`;
}

export type DataTableModel = { columns: string[]; rows: { date: string; cells: string[] }[] };

/** The table twin of a card: a row per day, a column per series, "No data" where there is none. A value the store sent unverified also shows as sent. */
export function tableFor(c: ChartCard): DataTableModel {
  const columns = ['Date'];
  const specs: { series: AnalyticsSeries; raw: boolean }[] = [];
  for (const s of allSeries(c)) {
    columns.push(s.label);
    specs.push({ series: s, raw: false });
    if (s.coverage.notes.some((n) => n.code === 'google_unit_unverified')) {
      columns.push(`${s.label}, as sent`);
      specs.push({ series: s, raw: true });
    }
  }
  const dates = cardDates(c);
  const rows = dates.map((date, i) => ({
    date: formatDay(date, true),
    cells: specs.map(({ series, raw }) => {
      const v = series.points[i]?.value ?? null;
      if (v === null) return 'No data';
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
};

const usable = (a: StepAction | null): a is StepAction =>
  a !== null && !(a.kind === 'text' && a.label === 'Wait');

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
          ? `Data from ${formatDay(s.firstDay, true)} to ${formatDay(s.lastDay, true)}.`
          : 'Ready.';
    else if (state === 'off') message = setupSentence('turn_on_analytics');
    else message = 'No data has been read yet.';
    const stepFor = (step: string | undefined): StepAction | null =>
      step ? stepAction(step) : null;
    let action = stepFor(setup?.nextStep);
    if (!action && state === 'error') action = stepAction('sync_now');
    const alternatives = (setup?.alternatives ?? [])
      .map((a) => stepAction(a))
      .filter((a) => usable(a));
    return {
      source: s.source,
      label: s.label || sourceLabel(s.source),
      state,
      stateLabel: info.label,
      tone: info.tone,
      icon: info.icon,
      optional: setup?.optional === true,
      message,
      error: s.lastError ? storedErrorText(s.lastError.code) : null,
      action: usable(action) ? action : null,
      alternatives,
      range:
        s.firstDay && s.lastDay
          ? `${formatDay(s.firstDay, true)} to ${formatDay(s.lastDay, true)}`
          : null,
      lastRead:
        s.lastOkAt === null
          ? s.lastAttemptAt === null
            ? 'Not read yet'
            : `Tried ${timeAgo(s.lastAttemptAt, now)}, nothing stored`
          : `Last read ${timeAgo(s.lastOkAt, now)}`,
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
  if (!status.enabled) return 'Scheduled syncs are off while analytics is off.';
  if (minutes <= 0) return 'The server has no scheduled sync; use Sync analytics now.';
  if (minutes % 1440 === 0)
    return `Synced every ${minutes / 1440 === 1 ? 'day' : `${minutes / 1440} days`}.`;
  if (minutes % 60 === 0)
    return `Synced every ${minutes / 60 === 1 ? 'hour' : `${minutes / 60} hours`}.`;
  return `Synced every ${minutes} minutes.`;
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
      const span =
        s.dayFrom && s.dayTo ? ` for ${formatDay(s.dayFrom)} to ${formatDay(s.dayTo)}` : '';
      return {
        source: s.source,
        label,
        text: (s.points ?? 0) > 0 ? `Read ${s.points} values${span}.` : 'Nothing new.',
        tone: 'ok',
      };
    }
    if (s.status === 'partial')
      return {
        source: s.source,
        label,
        text: `Read part of the data.${s.errorCode ? ` ${storedErrorText(s.errorCode)}` : ''}`,
        tone: 'warn',
      };
    if (s.status === 'failed') {
      const again = s.transient === true ? ' The next sync tries again.' : '';
      return {
        source: s.source,
        label,
        text: `${s.errorCode ? storedErrorText(s.errorCode) : 'The read failed.'}${again}`,
        tone: 'bad',
      };
    }
    if (s.status === 'skipped') {
      const why =
        s.setup === 'import_only'
          ? 'Skipped: this app imports report files instead.'
          : `Skipped. ${s.setup ? setupSentence(s.setup) : 'It cannot run yet.'}`;
      return { source: s.source, label, text: why, tone: 'neutral' };
    }
    return { source: s.source, label, text: 'Done.', tone: 'neutral' };
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
  const android = overview.platform === 'android';
  const picks: { id: string; label: string; title: string; series: AnalyticsSeries | null }[] =
    android
      ? [
          {
            id: 'downloads',
            label: 'Installs',
            title: 'User installs',
            series: seriesOf(overview, 'installs_user'),
          },
          {
            id: 'conversion',
            label: 'Conversion',
            title: 'Store listing conversion, derived',
            series: seriesOf(overview, 'product_page_conversion'),
          },
          {
            id: 'crash_rate',
            label: 'Crash rate',
            title: 'Mean daily crash rate from Android vitals, as sent',
            series: seriesOf(overview, 'crash_rate'),
          },
        ]
      : [
          {
            id: 'downloads',
            label: 'First-time downloads',
            title: 'First-time downloads',
            series: seriesOf(overview, 'downloads_first_time'),
          },
          {
            id: 'conversion',
            label: 'Conversion',
            title: 'First-time downloads divided by product page views, derived',
            series: seriesOf(overview, 'product_page_conversion'),
          },
          {
            id: 'crash_rate',
            label: 'Crash rate',
            title: 'Crashes divided by sessions, from people who opted in; derived',
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
