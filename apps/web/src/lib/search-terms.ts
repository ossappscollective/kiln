import {
  daysBetween,
  isIsoDate,
  type SearchTermInsight,
  type SearchTermSort,
  searchTermLimits,
  type TermListing,
} from '@mrm/core';
import { analyticsErrorText, formatCountExact, formatDay, formatPercent } from './analytics.ts';
import { ApiError } from './api.ts';

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

/** Where to get the file. The Console's menus move and are not verified here (docs/research/play-search-terms.md), so the first step says what the report is called and how to find it, not a fixed menu path. */
export const exportSteps: string[] = [
  'Open Google Play Console and choose the app.',
  'Find the report that breaks down store listing visitors by how they found your app. The menus change: type "acquisition" or "search terms" into the search box at the top of the Console, or look under Grow users. Google calls this the user acquisition (organic) report, with a Search row that opens the search terms.',
  'Choose the breakdown "Search term" and the period you want. Pick a country first if you want one country only.',
  'Press "Export report" next to the table and keep the downloaded .csv (or .zip) file.',
  'Switch the console to English before exporting: the column names are read by name and other languages may not be recognised.',
];

/** The note under the empty state: what the numbers are and what they are not. */
export const exportCaveat =
  'The file lists the terms people searched on Google Play and then opened your listing from. Terms too small to report are grouped by Google into "Other". Nothing is read from Google: the file goes to this server only.';

export type ListingBadge = { text: string; tone: 'ok' | 'warn' | 'neutral'; title: string };

const listingBadges: Record<TermListing, ListingBadge> = {
  in_listing: {
    text: 'In listing',
    tone: 'ok',
    title: 'Every word of the term is in the stored listing text.',
  },
  partly: {
    text: 'Partly in listing',
    tone: 'warn',
    title: 'Some words of the term are in the stored listing text, not all.',
  },
  not_in_listing: {
    text: 'Not in listing',
    tone: 'warn',
    title: 'No word of the term is in the stored listing text.',
  },
  unknown: {
    text: 'Listing unknown',
    tone: 'neutral',
    title: 'No listing text is stored for this language. Sync the app to read it.',
  },
};

export const listingBadge = (listing: TermListing): ListingBadge => listingBadges[listing];

/** "12.5%", or a dash when there is no rate. */
export const conversionText = (conversion: number | null): string =>
  conversion === null ? '–' : formatPercent(conversion);

export const countText = (n: number | null): string => (n === null ? '–' : formatCountExact(n));

/** The hint for a term that brought installs and is not fully in the listing text. A suggestion for a person to weigh. */
export const hintText = (term: Pick<SearchTermInsight, 'hint' | 'installs'>): string | null =>
  term.hint === 'add_to_listing'
    ? `Brought ${term.installs === null ? 'installs' : `${formatCountExact(term.installs)} ${term.installs === 1 ? 'install' : 'installs'}`} and is not fully in your listing text. Add it to the description?`
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
  return terms.map((t) => ({
    key: t.key,
    term: t.term,
    installs: countText(t.installs),
    visitors: countText(t.visitors),
    conversion: conversionText(t.conversion),
    listing: listingBadge(t.listing),
    tracked: t.trackedKeywordId !== null,
    trackedIn: t.trackedCountries.map((c) => c.toUpperCase()).join(', '),
    hint: hintText(t),
    canTrack: t.trackedKeywordId === null,
  }));
}

function periodText(from: string | null, to: string | null): string {
  if (from === null || to === null) return 'the dates in the file';
  return from === to ? formatDay(from, true) : `${formatDay(from, true)} to ${formatDay(to, true)}`;
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
        : 'the dates in the file';
  return `Imported from a file on ${formatDay(today(view.imported.at), true)}, covering ${covers}.`;
}

/** The line over the table: the period shown and the number of terms. */
export function periodLine(
  view: Pick<SearchTermsResponse, 'from' | 'to' | 'termCount' | 'terms' | 'country'>,
): string {
  const where = view.country ? ` in ${view.country.toUpperCase()}` : '';
  const shown =
    view.terms.length < view.termCount
      ? `the top ${formatCountExact(view.terms.length)} of ${formatCountExact(view.termCount)} terms`
      : `${formatCountExact(view.termCount)} ${view.termCount === 1 ? 'term' : 'terms'}`;
  return `${shown}${where}, ${periodText(view.from, view.to)}.`;
}

export type TotalsLine = { text: string } | null;

/** "Terms listed: 120 visitors, 14 installs. Grouped as Other: 90 visitors, 3 installs." */
export function totalsLine(view: Pick<SearchTermsResponse, 'totals' | 'other'>): string | null {
  const one = (v: { visitors: number | null; installs: number | null }) => {
    const parts: string[] = [];
    if (v.visitors !== null)
      parts.push(`${formatCountExact(v.visitors)} ${v.visitors === 1 ? 'visitor' : 'visitors'}`);
    if (v.installs !== null)
      parts.push(`${formatCountExact(v.installs)} ${v.installs === 1 ? 'install' : 'installs'}`);
    return parts.join(', ');
  };
  const all = one(view.totals);
  if (all === '') return null;
  const other = view.other ? one(view.other) : '';
  return other === ''
    ? `In the period: ${all}.`
    : `In the period: ${all}, of which ${other} are grouped by Google as "Other" and cannot be listed.`;
}

/** The day of a stored time, in UTC, for the freshness line. */
export const dayOfMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------
// Errors

const sentences: Record<string, string> = {
  not_google_play_app: 'Search terms are only for Google Play apps.',
  import_not_supported: 'Search terms can only be imported for a Google Play app.',
  forbidden: 'Only an owner or an admin can import search terms.',
};

/** A sentence for a failed read or import: from a fixed list, never the file's text. */
export function searchTermsErrorText(error: unknown): string {
  if (error instanceof ApiError && sentences[error.code]) return sentences[error.code] as string;
  return analyticsErrorText(error);
}

// ---------------------------------------------------------------------------------------------
// The import: file, period, preview, confirm

export const MAX_SEARCH_TERMS_FILE_BYTES = 10 * 1024 * 1024;

/** Why a file cannot be sent, or '' when it can. The server checks the content. */
export function checkSearchTermsFile(file: { name: string; size: number }): string {
  if (file.size <= 0) return 'The file is empty.';
  if (file.size > MAX_SEARCH_TERMS_FILE_BYTES) return 'The file is larger than 10 MiB.';
  if (file.name.length > 200) return 'The file name is longer than 200 characters.';
  return '';
}

/** Why the two days cannot be the period of a file, or '' when they can. Both are needed together. */
export function checkImportPeriod(from: string, to: string, today: string): string {
  if (!isIsoDate(from) || !isIsoDate(to)) return 'Give both days as year-month-day.';
  if (from > to) return 'The first day is after the last day.';
  if (to > today) return 'The last day is in the future.';
  if (daysBetween(from, to) + 1 > searchTermLimits.maxPeriodDays)
    return `A period is at most ${searchTermLimits.maxPeriodDays} days.`;
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
  const rows = [`${formatCountExact(s.rowsRead)} rows read, ${formatCountExact(s.rowsUsed)} used`];
  if (s.rowsOther > 0) rows.push(`${formatCountExact(s.rowsOther)} grouped by Google as "Other"`);
  if (s.rowsFiltered > 0)
    rows.push(
      `${formatCountExact(s.rowsFiltered)} left out because they are not Google Play search`,
    );
  if (s.rowsUnreadable > 0) rows.push(`${formatCountExact(s.rowsUnreadable)} could not be read`);
  const from = plan.hasDates ? plan.dateFrom : (plan.period?.from ?? null);
  const to = plan.hasDates ? plan.dateTo : (plan.period?.to ?? null);
  const period =
    from === null || to === null
      ? 'No dates found'
      : `${periodText(from, to)}${plan.hasDates ? ` (${formatCountExact(plan.days)} ${plan.days === 1 ? 'day' : 'days'}, from the file)` : ' (typed by you)'}`;
  const warnings: string[] = [];
  if (plan.overlapsStored > 0)
    warnings.push(
      'Part of this period is already stored from another file, so some days could be counted twice in the totals.',
    );
  return {
    period,
    rows,
    terms: `${formatCountExact(plan.terms)} ${plan.terms === 1 ? 'term' : 'terms'}`,
    countries:
      plan.countries.length === 0
        ? 'No country in the file'
        : plan.countries.map((c) => c.toUpperCase()).join(', '),
    totals: totalsLine({ totals: plan.totals, other: plan.other }),
    top: plan.top.map((t) => ({
      term: t.term,
      visitors: countText(t.visitors),
      installs: countText(t.installs),
      conversion: conversionText(t.conversion),
    })),
    warnings,
    willStore:
      plan.rows > 0
        ? `${formatCountExact(plan.rows)} ${plan.rows === 1 ? 'row' : 'rows'} can be stored.`
        : 'Nothing in this file can be stored.',
  };
}

/** The line after a successful import. A repeat of the same file stores nothing, and says so. */
export function importedLine(result: SearchTermsImported): string {
  if (result.written === 0) return 'Nothing new was stored: every row was already there.';
  const parts = [
    `Stored ${formatCountExact(result.written)} ${result.written === 1 ? 'row' : 'rows'}`,
  ];
  if (result.unchanged > 0) parts.push(`${formatCountExact(result.unchanged)} were already there`);
  const range =
    result.dateFrom && result.dateTo ? ` for ${periodText(result.dateFrom, result.dateTo)}` : '';
  return `${parts.join(', ')}${range}.`;
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
