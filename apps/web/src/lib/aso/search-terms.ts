import {
  daysBetween,
  isIsoDate,
  type SearchTermInsight,
  type SearchTermSort,
  searchTermLimits,
  type TermListing,
} from '@kiln/core';
import {
  analyticsErrorText,
  formatCountExact,
  formatDay,
  formatPercent,
} from '../analytics/analytics.ts';
import { ApiError } from '../api.ts';
import { formatList } from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';

/**
 * Google Play search terms in the web (docs/api/aso.md): the shapes of the two endpoints and the pure logic of the "Search terms" view
 * and its import dialog. Everything here is plain data in and out so it can be tested; written for the ES2017 web build.
 *
 * The numbers are the terms people searched on Google Play and then opened the app's listing from, as the Play Console exports them. They
 * are not how often a term is searched. The words never leave the screen: nothing here logs, stores or sends a term anywhere.
 */

// ---------------------------------------------------------------------------------------------
// API shapes

export type SearchTermsNote = { code: string; message: string };

export type SearchTermsResponse = {
  appId: string;
  platform: 'android';
  from: string | null;
  to: string | null;
  country: string | null;
  sort: SearchTermSort;
  /** The listing language the "in your listing" check used. */
  locale: string;
  listingLocale: string | null;
  listingReadAt: number | null;
  /** The latest import: null when nothing was imported. */
  imported: {
    at: number;
    periodFrom: string | null;
    periodTo: string | null;
    imports: number;
  } | null;
  /** Everything stored for the app, whatever this view asks for. */
  stored: { from: string; to: string; countries: string[]; rows: number } | null;
  terms: SearchTermInsight[];
  termCount: number;
  other: { visitors: number | null; installs: number | null } | null;
  totals: { visitors: number | null; installs: number | null };
  notes: SearchTermsNote[];
};

export type SearchTermsQuery = {
  from?: string;
  to?: string;
  country?: string;
  locale?: string;
  sort?: SearchTermSort;
  limit?: number;
};

export type SearchTermsPlan = {
  platform: 'android';
  report: { kind: 'play_search_terms'; label: string };
  stats: {
    rowsRead: number;
    rowsUsed: number;
    rowsUnreadable: number;
    rowsFiltered: number;
    rowsOther: number;
  };
  dateFrom: string | null;
  dateTo: string | null;
  /** The file had its own dates. When false, `period` is the one the person gave. */
  hasDates: boolean;
  period: { from: string; to: string } | null;
  days: number;
  rows: number;
  terms: number;
  countries: string[];
  files: number;
  totals: { visitors: number | null; installs: number | null };
  other: { visitors: number | null; installs: number | null } | null;
  top: {
    term: string;
    visitors: number | null;
    installs: number | null;
    conversion: number | null;
  }[];
  overlapsStored: number;
  notes: string[];
};
export type SearchTermsPreview = { plan: SearchTermsPlan; confirmHash: string };
export type SearchTermsImported = {
  rows: number;
  written: number;
  unchanged: number;
  dateFrom: string | null;
  dateTo: string | null;
};
export type SearchTermsImportResult = { imported: SearchTermsImported };

/** The days a file without dates covers, as the person typed them. */
export type ImportPeriod = { from: string; to: string };

// ---------------------------------------------------------------------------------------------
// The query

export function searchTermsQueryText(query: SearchTermsQuery): string {
  const params: string[] = [];
  const add = (key: string, value: string | number | undefined) => {
    if (value !== undefined && value !== '')
      params.push(`${key}=${encodeURIComponent(String(value))}`);
  };
  add('from', query.from);
  add('to', query.to);
  add('country', query.country);
  add('locale', query.locale);
  add('sort', query.sort);
  add('limit', query.limit);
  return params.length === 0 ? '' : `?${params.join('&')}`;
}

/** `?from=&to=` of an import, or '' for a file that has its own dates. */
export const importPeriodText = (period: ImportPeriod | null): string =>
  period ? `from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}` : '';

// ---------------------------------------------------------------------------------------------
// What the view says

/** The steps to get the file, as message keys. The Console's menus move and are not verified here (docs/research/play-search-terms.md), so the first step says what the report is called and how to find it, not a fixed menu path. */
export const exportStepKeys: string[] = [
  k('aso:terms.step.open'),
  k('aso:terms.step.find'),
  k('aso:terms.step.breakdown'),
  k('aso:terms.step.export'),
  k('aso:terms.step.english'),
];

/** Where to get the file, in the active language. */
export const exportSteps = (): string[] => exportStepKeys.map((key) => t(key));

/** The note under the empty state: what the numbers are and what they are not. */
export const exportCaveat = (): string => t('aso:terms.caveat');

export type ListingBadge = { text: string; tone: 'ok' | 'warn' | 'neutral'; title: string };

const listingBadges: Record<
  TermListing,
  { textKey: string; tone: ListingBadge['tone']; titleKey: string }
> = {
  in_listing: {
    textKey: k('aso:terms.badge.inListing'),
    tone: 'ok',
    titleKey: k('aso:terms.badge.inListing.title'),
  },
  partly: {
    textKey: k('aso:terms.badge.partly'),
    tone: 'warn',
    titleKey: k('aso:terms.badge.partly.title'),
  },
  not_in_listing: {
    textKey: k('aso:terms.badge.notInListing'),
    tone: 'warn',
    titleKey: k('aso:terms.badge.notInListing.title'),
  },
  unknown: {
    textKey: k('aso:terms.badge.unknown'),
    tone: 'neutral',
    titleKey: k('aso:terms.badge.unknown.title'),
  },
};

export const listingBadge = (listing: TermListing): ListingBadge => {
  const b = listingBadges[listing];
  return { text: t(b.textKey), tone: b.tone, title: t(b.titleKey) };
};

/** "12.5%", or a dash when there is no rate. */
export const conversionText = (conversion: number | null): string =>
  conversion === null ? '–' : formatPercent(conversion);

export const countText = (n: number | null): string => (n === null ? '–' : formatCountExact(n));

/** The hint for a term that brought installs and is not fully in the listing text. A suggestion for a person to weigh. */
export const hintText = (term: Pick<SearchTermInsight, 'hint' | 'installs'>): string | null =>
  term.hint === 'add_to_listing'
    ? term.installs === null
      ? t('aso:terms.hintNoCount')
      : t('aso:terms.hint', { count: term.installs })
    : null;

export type TermRow = {
  key: string;
  term: string;
  installs: string;
  visitors: string;
  conversion: string;
  listing: ListingBadge;
  tracked: boolean;
  /** Storefronts it is tracked in, upper case ("US, DE"). */
  trackedIn: string;
  hint: string | null;
  /** A one-click track needs a term that is not tracked yet. */
  canTrack: boolean;
};

export function termRows(terms: readonly SearchTermInsight[]): TermRow[] {
  return terms.map((term) => ({
    key: term.key,
    term: term.term,
    installs: countText(term.installs),
    visitors: countText(term.visitors),
    conversion: conversionText(term.conversion),
    listing: listingBadge(term.listing),
    tracked: term.trackedKeywordId !== null,
    trackedIn: term.trackedCountries.map((c) => c.toUpperCase()).join(', '),
    hint: hintText(term),
    canTrack: term.trackedKeywordId === null,
  }));
}

function periodText(from: string | null, to: string | null): string {
  if (from === null || to === null) return t('aso:terms.period.none');
  return from === to
    ? formatDay(from, true)
    : t('aso:terms.period.range', { from: formatDay(from, true), to: formatDay(to, true) });
}

/** "Imported from a file on 12 Nov 2026, covering 1 Oct 2026 to 31 Oct 2026." Null when nothing was imported. */
export function freshnessLine(
  view: Pick<SearchTermsResponse, 'imported' | 'stored'>,
  today: (ms: number) => string,
): string | null {
  if (!view.imported) return null;
  const covers =
    view.imported.periodFrom !== null
      ? periodText(view.imported.periodFrom, view.imported.periodTo)
      : view.stored
        ? periodText(view.stored.from, view.stored.to)
        : t('aso:terms.period.none');
  return t('aso:terms.fresh', { date: formatDay(today(view.imported.at), true), covers });
}

/** The line over the table: the period shown and the number of terms. */
export function periodLine(
  view: Pick<SearchTermsResponse, 'from' | 'to' | 'termCount' | 'terms' | 'country'>,
): string {
  const country = view.country ? view.country.toUpperCase() : '';
  const period = periodText(view.from, view.to);
  if (view.terms.length < view.termCount) {
    const params = { shown: formatCountExact(view.terms.length), count: view.termCount, period };
    return country
      ? t('aso:terms.line.topIn', { ...params, country })
      : t('aso:terms.line.top', params);
  }
  return country
    ? t('aso:terms.line.allIn', { count: view.termCount, country, period })
    : t('aso:terms.line.all', { count: view.termCount, period });
}

export type TotalsLine = { text: string } | null;

/** "Terms listed: 120 visitors, 14 installs. Grouped as Other: 90 visitors, 3 installs." */
export function totalsLine(view: Pick<SearchTermsResponse, 'totals' | 'other'>): string | null {
  const one = (v: { visitors: number | null; installs: number | null }) => {
    const parts: string[] = [];
    if (v.visitors !== null) parts.push(t('aso:terms.visitors', { count: v.visitors }));
    if (v.installs !== null) parts.push(t('aso:terms.installs', { count: v.installs }));
    return formatList(parts, { type: 'unit' });
  };
  const all = one(view.totals);
  if (all === '') return null;
  const other = view.other ? one(view.other) : '';
  return other === '' ? t('aso:terms.totals', { all }) : t('aso:terms.totalsOther', { all, other });
}

/** The day of a stored time, in UTC, for the freshness line. */
export const dayOfMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------
// Errors

const sentences: Record<string, string> = {
  not_google_play_app: k('aso:terms.error.notGooglePlayApp'),
  import_not_supported: k('aso:terms.error.importNotSupported'),
  forbidden: k('aso:terms.error.forbidden'),
};

/** A sentence for a failed read or import: from a fixed list, never the file's text. */
export function searchTermsErrorText(error: unknown): string {
  const key = error instanceof ApiError ? sentences[error.code] : undefined;
  if (key !== undefined) return t(key);
  return analyticsErrorText(error);
}

// ---------------------------------------------------------------------------------------------
// The import: file, period, preview, confirm

export const MAX_SEARCH_TERMS_FILE_BYTES = 10 * 1024 * 1024;

/** Why a file cannot be sent, or '' when it can. The server checks the content. */
export function checkSearchTermsFile(file: { name: string; size: number }): string {
  if (file.size <= 0) return t('aso:terms.file.empty');
  if (file.size > MAX_SEARCH_TERMS_FILE_BYTES) return t('aso:terms.file.tooLarge');
  if (file.name.length > 200) return t('aso:terms.file.nameTooLong');
  return '';
}

/** Why the two days cannot be the period of a file, or '' when they can. Both are needed together. */
export function checkImportPeriod(from: string, to: string, today: string): string {
  if (!isIsoDate(from) || !isIsoDate(to)) return t('aso:terms.period.invalid');
  if (from > to) return t('aso:terms.period.order');
  if (to > today) return t('aso:terms.period.future');
  if (daysBetween(from, to) + 1 > searchTermLimits.maxPeriodDays)
    return t('aso:terms.period.tooLong', { count: searchTermLimits.maxPeriodDays });
  return '';
}

export type SearchTermsFlow =
  | { phase: 'idle' }
  | { phase: 'checking'; fileName: string }
  | { phase: 'preview'; fileName: string; plan: SearchTermsPlan; confirmHash: string }
  | { phase: 'importing'; fileName: string; plan: SearchTermsPlan; confirmHash: string }
  | { phase: 'done'; fileName: string; result: SearchTermsImported }
  | {
      phase: 'error';
      fileName: string | null;
      during: 'preview' | 'import';
      code: string;
      message: string;
    };

export type SearchTermsFlowEvent =
  | { type: 'pick'; fileName: string }
  | { type: 'previewed'; preview: SearchTermsPreview }
  | { type: 'confirm' }
  | { type: 'imported'; result: SearchTermsImported }
  | { type: 'failed'; during: 'preview' | 'import'; code: string; message: string }
  | { type: 'reset' };

export const idleFlow: SearchTermsFlow = { phase: 'idle' };

/** Something to store and the hash of the preview. A file with nothing usable cannot be confirmed. */
export const canConfirmTerms = (state: SearchTermsFlow): boolean =>
  (state.phase === 'preview' || state.phase === 'importing') &&
  state.confirmHash !== '' &&
  state.plan.rows > 0;

/** One step of the import. An event that does not fit the state is ignored, so a late answer cannot jump a step. */
export function flowStep(state: SearchTermsFlow, event: SearchTermsFlowEvent): SearchTermsFlow {
  switch (event.type) {
    case 'reset':
      return state.phase === 'importing' || state.phase === 'checking' ? state : idleFlow;
    case 'pick':
      return state.phase === 'importing' || state.phase === 'checking'
        ? state
        : { phase: 'checking', fileName: event.fileName };
    case 'previewed':
      return state.phase === 'checking'
        ? {
            phase: 'preview',
            fileName: state.fileName,
            plan: event.preview.plan,
            confirmHash: event.preview.confirmHash,
          }
        : state;
    case 'confirm':
      return state.phase === 'preview' && canConfirmTerms(state)
        ? {
            phase: 'importing',
            fileName: state.fileName,
            plan: state.plan,
            confirmHash: state.confirmHash,
          }
        : state;
    case 'imported':
      return state.phase === 'importing'
        ? { phase: 'done', fileName: state.fileName, result: event.result }
        : state;
    case 'failed': {
      if (event.during === 'preview' && state.phase !== 'checking') return state;
      if (event.during === 'import' && state.phase !== 'importing') return state;
      const fileName =
        state.phase === 'checking' || state.phase === 'importing' ? state.fileName : null;
      return {
        phase: 'error',
        fileName,
        during: event.during,
        code: event.code,
        message: event.message,
      };
    }
    default:
      return state;
  }
}

/** The code and sentence of a failure. */
export const failure = (error: unknown): { code: string; message: string } => ({
  code: error instanceof ApiError ? error.code : '',
  message: searchTermsErrorText(error),
});

/** The file needs a period typed by the person: a file with no date column. */
export const needsPeriod = (state: SearchTermsFlow): boolean =>
  state.phase === 'error' && state.during === 'preview' && state.code === 'period_required';

export type PreviewFacts = {
  period: string;
  rows: string[];
  terms: string;
  countries: string;
  totals: string | null;
  top: { term: string; visitors: string; installs: string; conversion: string }[];
  warnings: string[];
  willStore: string;
};

/** What the preview says before anything is stored: the period, the rows read and left out, the terms, the countries, the biggest terms. */
export function previewFacts(plan: SearchTermsPlan): PreviewFacts {
  const s = plan.stats;
  const rows = [
    t('aso:terms.preview.rowsRead', { count: s.rowsRead, used: formatCountExact(s.rowsUsed) }),
  ];
  if (s.rowsOther > 0)
    rows.push(t('aso:terms.preview.rowsOther', { count: formatCountExact(s.rowsOther) }));
  if (s.rowsFiltered > 0)
    rows.push(t('aso:terms.preview.rowsFiltered', { count: formatCountExact(s.rowsFiltered) }));
  if (s.rowsUnreadable > 0)
    rows.push(t('aso:terms.preview.rowsUnreadable', { count: formatCountExact(s.rowsUnreadable) }));
  const from = plan.hasDates ? plan.dateFrom : (plan.period?.from ?? null);
  const to = plan.hasDates ? plan.dateTo : (plan.period?.to ?? null);
  const period =
    from === null || to === null
      ? t('aso:terms.preview.noDates')
      : plan.hasDates
        ? t('aso:terms.preview.periodFile', { range: periodText(from, to), count: plan.days })
        : t('aso:terms.preview.periodTyped', { range: periodText(from, to) });
  const warnings: string[] = [];
  if (plan.overlapsStored > 0) warnings.push(t('aso:terms.preview.overlap'));
  return {
    period,
    rows,
    terms: t('aso:terms.preview.terms', { count: plan.terms }),
    countries:
      plan.countries.length === 0
        ? t('aso:terms.preview.noCountry')
        : plan.countries.map((c) => c.toUpperCase()).join(', '),
    totals: totalsLine({ totals: plan.totals, other: plan.other }),
    top: plan.top.map((term) => ({
      term: term.term,
      visitors: countText(term.visitors),
      installs: countText(term.installs),
      conversion: conversionText(term.conversion),
    })),
    warnings,
    willStore:
      plan.rows > 0
        ? t('aso:terms.preview.willStore', { count: plan.rows })
        : t('aso:terms.preview.willStoreNone'),
  };
}

/** The line after a successful import. A repeat of the same file stores nothing, and says so. */
export function importedLine(result: SearchTermsImported): string {
  if (result.written === 0) return t('aso:terms.imported.nothing');
  const parts = [t('aso:terms.imported.stored', { count: result.written })];
  if (result.unchanged > 0)
    parts.push(t('aso:terms.imported.unchanged', { count: result.unchanged }));
  const list = formatList(parts, { type: 'unit' });
  return result.dateFrom && result.dateTo
    ? t('aso:terms.imported.lineRange', {
        parts: list,
        range: periodText(result.dateFrom, result.dateTo),
      })
    : t('aso:terms.imported.line', { parts: list });
}

// ---------------------------------------------------------------------------------------------
// Tracking a term in one click

/** The storefront and locale a one-click track uses: the view's country when it has one, else the tracked storefront with most keywords. */
export function trackTarget(
  view: Pick<SearchTermsResponse, 'country' | 'locale'>,
  keywords: readonly { country: string; locale: string }[],
): { country: string; locale: string } | null {
  if (view.country) return { country: view.country, locale: view.locale };
  const counts: Record<string, number> = {};
  const order: string[] = [];
  for (const k of keywords) {
    const id = `${k.country}|${k.locale}`;
    if (counts[id] === undefined) {
      counts[id] = 0;
      order.push(id);
    }
    counts[id] = (counts[id] as number) + 1;
  }
  let best: string | null = null;
  for (const id of order)
    if (best === null || (counts[id] as number) > (counts[best] as number)) best = id;
  if (best === null) return null;
  const [country, locale] = best.split('|');
  return { country: country as string, locale: locale as string };
}
