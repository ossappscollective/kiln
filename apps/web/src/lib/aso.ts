import { type RankChange, type RankChangeKind, checkTerm, defaultLocaleFor, normalizeCountry, normalizeLocale } from '@mrm/core';
import type { CoverageGap, FitStatus, Idea, ListingFit, SuggestedCompetitor, TermAcrossMarkets } from '@mrm/core';
import { ApiError } from './api.ts';
import { type PlatformScope, appAddress, parseViewPath } from './app-scope.ts';
import type { IconName } from './icons.ts';
import { retrySeconds } from './portfolio.ts';

/**
 * ASO in the web (docs/api/aso.md): the shapes of the API and the pure logic of the screens. Everything
 * here is plain data in and out so it can be tested; written for the ES2017 web build.
 *
 * A "rank" is a position in the results the store (or its public search service) returned for the term;
 * `rank: null` with `state: 'not_ranked'` means "not within the first `total` results".
 */

// ---------------------------------------------------------------------------------------------
// API shapes

export type AsoPlatform = 'ios' | 'android';
export type AsoStore = 'app_store' | 'google_play';

export type AsoConfig = {
  apple: { enabled: boolean; source: string; documentedCallsPerMinute: number };
  play: { enabled: boolean; unofficial: boolean; notice: string; howToEnable: string };
  schedule: { intervalMinutes: number };
  retentionDays: number;
  limits: { maxKeywordsPerApp: number; maxCompetitorsPerApp: number; maxChecksPerRun: number; rankDepth: number; maxKeywordsPerRequest: number };
  rankMoveThreshold: number;
};

export type AsoKeyword = {
  id: string;
  appId: string;
  platform: AsoPlatform;
  country: string;
  locale: string;
  term: string;
  key: string;
  tag: string | null;
  notes: string | null;
  /** 1 low, 2 normal, 3 high. */
  priority: number;
  createdAt: number;
  updatedAt: number;
  /** The last SUCCESSFUL check; null: never checked. */
  lastCheckedAt: number | null;
  state: 'ranked' | 'not_ranked' | null;
  rank: number | null;
  total: number | null;
  previous: { state: 'ranked' | 'not_ranked'; rank: number | null } | null;
  change: RankChange | null;
  /** A short code of the latest failed attempt. */
  error: string | null;
};

export type AsoKeywordInput = { term: string; country?: string; locale?: string; tag?: string; notes?: string; priority?: number };
export type AsoAddSummary = { created: number; exists: number; invalid: number; limit: number };
export type AsoAddResult = {
  results: { index: number; status: 'created' | 'exists' | 'invalid' | 'limit'; keyword?: AsoKeyword; message?: string }[];
  summary: AsoAddSummary;
};

export type AsoCheck = { id: string; checkedAt: number; rank: number | null; total: number; source: string };
export type AsoKeywordHistory = {
  keyword: AsoKeyword;
  checks: AsoCheck[];
  trend: { direction: 'up' | 'down' | 'flat' | 'unknown'; delta: number | null; latest: number | null; best: number | null; worst: number | null; samples: number };
};

export type AsoChange = { field: string; from?: string | number | null; to?: string | number | null };
export type AsoSnapshot = {
  id: string;
  checkedAt: number;
  kind: 'first' | 'change' | 'heartbeat';
  version: string | null;
  rating: number | null;
  ratingCount: number | null;
  price: string | null;
  currency: string | null;
  title: string | null;
  subtitle: string | null;
  descriptionExcerpt: string | null;
  screenshotCount: number | null;
  changes: AsoChange[] | null;
};
export type AsoCompetitor = {
  id: string;
  appId: string;
  store: AsoStore;
  externalId: string;
  country: string;
  name: string;
  addedBy: string;
  addedAt: number;
  lastCheckedAt: number | null;
  state: 'ok' | 'not_found' | 'unavailable' | null;
  error: string | null;
  latest: AsoSnapshot | null;
};
export type AsoCompetitorHistory = {
  competitor: AsoCompetitor;
  snapshots: AsoSnapshot[];
  diff: { from: string | null; to: string; at: number; changes: AsoChange[] } | null;
};

export type AsoRefreshResult = {
  at: number;
  keywords: { due: number; checked: number; ranked: number; notRanked: number; failed: number; cached: number; moved: number };
  competitors: { due: number; checked: number; changed: number; notFound: number; failed: number };
  deferred: boolean;
  retryAfterSeconds?: number;
  stoppedBecause?: 'rate_limit' | 'unavailable' | 'errors' | 'time' | 'cap';
  errors: string[];
  warnings: string[];
};
export type AsoState = {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  backoffUntil: number | null;
  lastResult: AsoRefreshResult | null;
};
export type AsoRefreshOutcome = { result: AsoRefreshResult; state: AsoState };

export type AsoMover = { keywordId: string; term: string; country: string; locale: string; kind: string; from: number | null; to: number | null; delta: number | null };
export type AsoSummary = {
  app: { id: string; platform: AsoPlatform; store: AsoStore };
  keywords: { total: number; ranked: number; notRanked: number; unchecked: number; failing: number; top3: number; top10: number };
  movers: AsoMover[];
  competitors: { total: number; notFound: number; changedRecently: number };
  state: AsoState;
};

export type AsoFitView = {
  locale: string;
  listingLocale: string | null;
  channel: 'live' | 'editable' | null;
  keywords: number;
  fit: ListingFit | null;
};
export type AsoFitResponse = { readAt: number | null; error: string | null; locales: AsoFitView[]; indexedFields: string[]; assumptions: string[] };
export type AsoIdeasResponse = {
  locale: string;
  basedOn: { ownListing: boolean; competitors: number };
  ideas: Idea[];
  notes: string[];
};
export type AsoGapsResponse = { locale: string; competitors: number; gaps: CoverageGap[]; notes: string[] };
export type AsoSuggestion = SuggestedCompetitor & { country: string; name: string | null };
export type AsoSuggestionsResponse = { suggestions: AsoSuggestion[]; basedOnKeywords: number; notes: string[] };
export type AsoMarketsResponse = { terms: TermAcrossMarkets[] };

// ---------------------------------------------------------------------------------------------
// Views of the app section (address backed: `?view=`)

export type AsoView = 'keywords' | 'competitors' | 'ideas' | 'fit' | 'gaps' | 'markets';

export const asoViews: { id: AsoView; label: string }[] = [
  { id: 'keywords', label: 'Keywords' },
  { id: 'competitors', label: 'Competitors' },
  { id: 'ideas', label: 'Ideas' },
  { id: 'fit', label: 'Fit' },
  { id: 'gaps', label: 'Gaps' },
  { id: 'markets', label: 'Markets' },
];

export const isAsoView = (value: string | null | undefined): value is AsoView =>
  value !== null && value !== undefined && asoViews.some((v) => v.id === value);

/** The sub-view an address names; Keywords when it names none. */
export function asoViewFromHash(hash: string): AsoView {
  const view = parseViewPath(hash).query.get('view');
  return isAsoView(view) ? view : 'keywords';
}

/** The same address with another sub-view. Keywords, the default, is not written; other query parts stay. */
export function withAsoView(hash: string, view: AsoView): string {
  const at = hash.indexOf('?');
  const path = at < 0 ? hash : hash.slice(0, at);
  const params = new URLSearchParams(at < 0 ? '' : hash.slice(at + 1));
  if (view === 'keywords') params.delete('view');
  else params.set('view', view);
  const search = params.toString();
  return search === '' ? path : `${path}?${search}`;
}

/** The address of a sub-view of the ASO section of an app. */
export const asoViewHref = (appId: string, view: AsoView = 'keywords', platform: PlatformScope | null = null): string =>
  withAsoView(appAddress(appId, 'aso', platform), view);

/** The workspace overview of all apps. */
export const asoOverviewHref = '#/aso';

// ---------------------------------------------------------------------------------------------
// Errors

const messages: Record<string, string> = {
  play_unofficial_disabled: 'Google Play reading is switched off on this server. Nothing was requested.',
  refresh_in_progress: 'A check of this app is already running. Try again in a moment.',
  already_followed: 'That app is already followed.',
  limit_reached: 'The limit of followed competitors is reached. Remove one first.',
  own_app: 'That is your own app. Follow another one.',
  invalid_external_id: 'That is not an App Store id, package name or store link.',
  invalid_country: 'That is not a two-letter storefront such as us.',
  refresh_failed: 'The store could not be read just now. Nothing was recorded as not ranked. Try again later.',
  source_unavailable: 'The store could not be read just now. Nothing was recorded. Try again later.',
  source_failed: 'The store could not be read just now. Nothing was recorded. Try again later.',
  source_timeout: 'The store did not answer in time. Try again later.',
};

/** "45 seconds", "2 minutes". */
export function waitText(seconds: number): string {
  if (seconds < 60) {
    const n = Math.max(1, Math.ceil(seconds));
    return `${n} second${n === 1 ? '' : 's'}`;
  }
  const m = Math.ceil(seconds / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

/** A sentence for an ASO call that failed. A limit says when to try again. */
export function asoErrorMessage(error: unknown, fallback = 'That did not work. Try again.'): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 422 && error.code === 'not_found') return 'The store has no app with that id.';
  if (error.status === 429) {
    const seconds = retrySeconds(error);
    return seconds !== null ? `The limit was reached. Try again in ${waitText(seconds)}.` : 'The limit was reached. Try again in a minute.';
  }
  return messages[error.code] ?? error.message ?? fallback;
}

/** Seconds to wait before another refresh after a 429; null for any other error. */
export function refreshWaitSeconds(error: unknown): number | null {
  return error instanceof ApiError && error.status === 429 ? (retrySeconds(error) ?? 60) : null;
}

// ---------------------------------------------------------------------------------------------
// Text for ranks

/** The rank cell: "12", "50+" (not within the first 50), a dash for never checked. */
export function rankText(k: Pick<AsoKeyword, 'state' | 'rank' | 'total'>): { text: string; title: string; muted: boolean } {
  if (k.state === 'ranked' && k.rank !== null) return { text: String(k.rank), title: `Position ${k.rank} in the results`, muted: false };
  if (k.state === 'not_ranked') {
    const n = k.total ?? 50;
    return { text: `${n}+`, title: `Not within the first ${n} results`, muted: true };
  }
  return { text: '–', title: 'Not checked yet', muted: true };
}

export type ChangeInfo = { text: string; tone: 'ok' | 'bad' | 'neutral'; icon: IconName | null; title: string };

/** "+3" (better), "-4" (worse), "New", "Entered", "Left", or a dash. Words and icons say it, not the colour. */
export function changeInfo(change: RankChange | null, checked: boolean): ChangeInfo {
  if (!checked) return { text: '–', tone: 'neutral', icon: null, title: 'Not checked yet' };
  const kind: RankChangeKind = change?.kind ?? 'first';
  switch (kind) {
    case 'up':
      return { text: `+${change?.delta ?? 0}`, tone: 'ok', icon: 'arrow-up', title: `Up ${change?.delta ?? 0} places since the last check` };
    case 'down':
      return { text: `${change?.delta ?? 0}`, tone: 'bad', icon: 'arrow-down', title: `Down ${Math.abs(change?.delta ?? 0)} places since the last check` };
    case 'entered':
      return { text: 'Entered', tone: 'ok', icon: 'arrow-up', title: 'Was not in the results at the last check' };
    case 'dropped':
      return { text: 'Left', tone: 'bad', icon: 'arrow-down', title: 'Was in the results at the last check' };
    case 'same':
      return { text: '0', tone: 'neutral', icon: null, title: 'No change since the last check' };
    case 'still_unranked':
      return { text: '–', tone: 'neutral', icon: null, title: 'Not in the results at the last two checks' };
    default:
      return { text: 'New', tone: 'neutral', icon: null, title: 'First check, nothing to compare with' };
  }
}

/** A size to sort moves by: places moved, or a large number for entering or leaving the results. */
export function moveSize(change: RankChange | null): number {
  if (!change) return 0;
  if (change.kind === 'up' || change.kind === 'down') return Math.abs(change.delta ?? 0);
  if (change.kind === 'entered' || change.kind === 'dropped') return 1000;
  return 0;
}

export type KeywordSort = 'rank' | 'move' | 'term' | 'checked';
export const keywordSorts: { id: KeywordSort; label: string }[] = [
  { id: 'rank', label: 'Best rank first' },
  { id: 'move', label: 'Biggest move' },
  { id: 'term', label: 'Keyword A to Z' },
  { id: 'checked', label: 'Last checked' },
];

const rankOrder = (k: AsoKeyword): number => (k.state === 'ranked' && k.rank !== null ? k.rank : k.state === 'not_ranked' ? 10_000 : 20_000);

export function sortKeywords<T extends AsoKeyword>(list: readonly T[], sort: KeywordSort): T[] {
  const out = list.slice();
  const byTerm = (a: T, b: T) => a.term.localeCompare(b.term) || a.country.localeCompare(b.country) || a.platform.localeCompare(b.platform);
  if (sort === 'term') out.sort(byTerm);
  else if (sort === 'move') out.sort((a, b) => moveSize(b.change) - moveSize(a.change) || rankOrder(a) - rankOrder(b) || byTerm(a, b));
  else if (sort === 'checked') out.sort((a, b) => (b.lastCheckedAt ?? 0) - (a.lastCheckedAt ?? 0) || byTerm(a, b));
  else out.sort((a, b) => rankOrder(a) - rankOrder(b) || byTerm(a, b));
  return out;
}

/** "US · en-US". */
export const marketText = (k: Pick<AsoKeyword, 'country' | 'locale'>): string => `${k.country.toUpperCase()} · ${k.locale}`;

/** Case insensitive match on the term, the tag and the market. */
export function filterKeywords<T extends AsoKeyword>(list: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === '') return list.slice();
  return list.filter((k) => k.term.toLowerCase().indexOf(q) >= 0 || (k.tag ?? '').toLowerCase().indexOf(q) >= 0 || marketText(k).toLowerCase().indexOf(q) >= 0);
}

// ---------------------------------------------------------------------------------------------
// Sparkline

export type Spark = { path: string; width: number; height: number; last: { x: number; y: number } | null; samples: number };

/**
 * A tiny line of a rank history (oldest first): rank 1 is at the top, "not ranked" counts as one past the
 * deepest result seen and sits at the bottom. One check is a dot, none is nothing.
 */
export function sparkline(checks: readonly Pick<AsoCheck, 'rank' | 'total'>[], width = 72, height = 20, pad = 2): Spark {
  const n = checks.length;
  if (n === 0) return { path: '', width, height, last: null, samples: 0 };
  let deepest = 0;
  for (const c of checks) deepest = Math.max(deepest, c.total, c.rank ?? 0);
  const out = deepest + 1;
  const values = checks.map((c) => c.rank ?? out);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  const x = (i: number) => (n === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (n - 1));
  const y = (v: number) => (span === 0 ? height / 2 : pad + ((v - lo) * (height - 2 * pad)) / span);
  const round = (v: number) => Math.round(v * 10) / 10;
  const points = values.map((v, i) => ({ x: round(x(i)), y: round(y(v)) }));
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
  return { path, width, height, last: points[points.length - 1] ?? null, samples: n };
}

/** The best (lowest) rank of a history, or null when it never ranked. */
export function bestRank(checks: readonly Pick<AsoCheck, 'rank'>[]): number | null {
  let best: number | null = null;
  for (const c of checks) if (c.rank !== null && (best === null || c.rank < best)) best = c.rank;
  return best;
}

// ---------------------------------------------------------------------------------------------
// Adding keywords

export type PastedTerms = {
  terms: { term: string; key: string }[];
  /** Parts that were the same keyword as an earlier one. */
  duplicates: number;
  invalid: { text: string; reason: string }[];
};

/** Keywords as pasted: one per line, or separated by commas or semicolons. Blank parts are ignored. */
export function parsePastedTerms(text: string): PastedTerms {
  const seen: Record<string, true | undefined> = {};
  const terms: PastedTerms['terms'] = [];
  const invalid: PastedTerms['invalid'] = [];
  let duplicates = 0;
  for (const part of text.split(/[\n\r,;]+/)) {
    if (part.trim() === '') continue;
    const checked = checkTerm(part);
    if (!checked.ok) {
      invalid.push({ text: part.trim().slice(0, 40), reason: checked.reason });
      continue;
    }
    if (seen[checked.key]) {
      duplicates += 1;
      continue;
    }
    seen[checked.key] = true;
    terms.push({ term: checked.term, key: checked.key });
  }
  return { terms, duplicates, invalid };
}

export type MarketChoice = { country: string; locale: string };

/** A market from what was typed (an empty locale takes the storefront's usual one); null when either is not valid. */
export function checkMarket(country: string, locale: string): MarketChoice | null {
  const c = normalizeCountry(country);
  if (c === undefined) return null;
  const l = locale.trim() === '' ? defaultLocaleFor(c) : normalizeLocale(locale);
  return l === undefined ? null : { country: c, locale: l };
}

/** The locale a storefront most likely uses (for the picker to fill in). */
export const localeForCountry = (country: string): string => defaultLocaleFor(country);

/** The storefronts the picker offers. Any two letters are accepted by the server. */
export const commonCountries: string[] = [
  'us', 'gb', 'ca', 'au', 'de', 'fr', 'es', 'it', 'nl', 'se', 'no', 'dk', 'fi', 'pl', 'pt', 'br', 'mx', 'jp', 'kr', 'cn', 'in', 'tr', 'ru', 'ch', 'at', 'ie', 'nz',
];

/** One item per market and term, in the order the person typed them. */
export function addItems(
  terms: readonly { term: string }[],
  markets: readonly MarketChoice[],
  extra: { tag?: string; priority?: number } = {},
): AsoKeywordInput[] {
  const out: AsoKeywordInput[] = [];
  for (const m of markets) {
    for (const t of terms) {
      const item: AsoKeywordInput = { term: t.term, country: m.country, locale: m.locale };
      if (extra.tag && extra.tag.trim() !== '') item.tag = extra.tag.trim();
      if (extra.priority !== undefined && extra.priority !== 2) item.priority = extra.priority;
      out.push(item);
    }
  }
  return out;
}

export function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export const emptyAddSummary = (): AsoAddSummary => ({ created: 0, exists: 0, invalid: 0, limit: 0 });

export function sumAddSummary(parts: readonly AsoAddSummary[]): AsoAddSummary {
  const total = emptyAddSummary();
  for (const p of parts) {
    total.created += p.created;
    total.exists += p.exists;
    total.invalid += p.invalid;
    total.limit += p.limit;
  }
  return total;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "Added 8 keywords. 2 already tracked, 1 not accepted, 3 over the limit of 50." */
export function addSummaryText(s: AsoAddSummary, maxPerApp?: number): string {
  const head = s.created > 0 ? `Added ${plural(s.created, 'keyword', 'keywords')}.` : 'Nothing was added.';
  const rest: string[] = [];
  if (s.exists > 0) rest.push(`${s.exists} already tracked`);
  if (s.invalid > 0) rest.push(`${s.invalid} not accepted`);
  if (s.limit > 0) rest.push(`${s.limit} over the limit${maxPerApp ? ` of ${maxPerApp}` : ''}`);
  return rest.length > 0 ? `${head} ${rest.join(', ')}.` : head;
}

// ---------------------------------------------------------------------------------------------
// Refresh

/** "Checked 25 of 40 keywords and 3 of 3 competitors." with what stopped it, when it did. */
export function refreshText(result: AsoRefreshResult): string {
  const k = result.keywords;
  const c = result.competitors;
  let text = `Checked ${k.checked} of ${plural(k.due, 'keyword', 'keywords')}`;
  if (c.due > 0) text += ` and ${c.checked} of ${plural(c.due, 'competitor', 'competitors')}`;
  text += '.';
  if (k.moved > 0) text += ` ${plural(k.moved, 'keyword', 'keywords')} moved.`;
  if (result.deferred) {
    const why: Record<string, string> = {
      cap: 'The rest is left for the next check.',
      time: 'It ran out of time; the rest is left for the next check.',
      rate_limit: result.retryAfterSeconds ? `The store asked to slow down; try again in ${waitText(result.retryAfterSeconds)}.` : 'The store asked to slow down.',
      unavailable: 'The store could not be read for the rest.',
      errors: 'It stopped after repeated errors.',
    };
    text += ` ${why[result.stoppedBecause ?? 'cap'] ?? 'The rest is left for the next check.'}`;
  }
  return text;
}

/** Seconds to wait after a run that stopped for a store's limit, or null. */
export function resultWaitSeconds(result: AsoRefreshResult): number | null {
  return result.stoppedBecause === 'rate_limit' && result.retryAfterSeconds ? result.retryAfterSeconds : null;
}

// ---------------------------------------------------------------------------------------------
// Competitors

const fieldLabels: Record<string, string> = {
  version: 'Version',
  title: 'Name',
  subtitle: 'Subtitle',
  price: 'Price',
  description: 'Description',
  media: 'Icon or screenshots',
  screenshots: 'Screenshots',
  rating: 'Rating',
  ratingCount: 'Rating count',
  rating_count: 'Rating count',
};

export const fieldLabel = (field: string): string => fieldLabels[field] ?? field;

const shown = (v: string | number | null | undefined): string => (v === null || v === undefined || v === '' ? 'none' : String(v));

/** "Version 2.0 to 2.1", "Description changed". The values are public short texts, shown as plain text. */
export function changeText(c: AsoChange): string {
  const label = fieldLabel(c.field);
  if (c.from === undefined && c.to === undefined) return `${label} changed`;
  const count = c.field === 'ratingCount' || c.field === 'rating_count';
  const f = count && typeof c.from === 'number' ? c.from.toLocaleString('en') : shown(c.from);
  const t = count && typeof c.to === 'number' ? c.to.toLocaleString('en') : shown(c.to);
  return `${label} ${f} to ${t}`;
}

const daysAgo = (at: number, now: number): string => {
  const days = Math.floor((now - at) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
};

/** The one line on a competitor card about the last change. */
export function lastChangeText(h: Pick<AsoCompetitorHistory, 'diff'> | null, c: AsoCompetitor, now: number): string {
  if (h?.diff && h.diff.changes.length > 0) {
    const more = h.diff.changes.length - 1;
    return `${changeText(h.diff.changes[0] as AsoChange)}${more > 0 ? ` and ${more} more` : ''}, ${daysAgo(h.diff.at, now)}`;
  }
  const latest = c.latest;
  if (latest?.changes && latest.changes.length > 0) return `${changeText(latest.changes[0] as AsoChange)}, ${daysAgo(latest.checkedAt, now)}`;
  if (c.state === 'not_found') return 'No longer in the store';
  return latest ? 'No change seen since the first look' : 'Not looked at yet';
}

/** Stars with one decimal: "4.6". */
export const ratingText = (rating: number | null | undefined): string => (rating === null || rating === undefined ? '–' : rating.toFixed(1));

export const countText = (n: number | null | undefined): string => (n === null || n === undefined ? '–' : n.toLocaleString('en'));

export type CompareRow = { label: string; ours: string; theirs: string[] };
export type OurFacts = { version: string | null; rating: number | null; ratingCount: number | null };

/** The side by side of our app and the followed ones. A value we do not hold is a dash, never a guess. */
export function compareRows(ours: OurFacts, others: readonly AsoCompetitor[]): CompareRow[] {
  const col = (f: (s: AsoSnapshot) => string): string[] => others.map((c) => (c.latest ? f(c.latest) : '–'));
  return [
    { label: 'Version', ours: ours.version ?? '–', theirs: col((s) => s.version ?? '–') },
    { label: 'Rating', ours: ratingText(ours.rating), theirs: col((s) => ratingText(s.rating)) },
    { label: 'Ratings', ours: countText(ours.ratingCount), theirs: col((s) => countText(s.ratingCount)) },
    { label: 'Price', ours: '–', theirs: col((s) => s.price ?? '–') },
    { label: 'Screenshots', ours: '–', theirs: col((s) => (s.screenshotCount === null ? '–' : String(s.screenshotCount))) },
  ];
}

// ---------------------------------------------------------------------------------------------
// Fit

export const fitStatusInfo: Record<FitStatus, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral'; hint: string }> = {
  strong: { label: 'Strong', tone: 'ok', hint: 'The phrase is in the name or subtitle (Android: title or short description).' },
  covered: { label: 'Covered', tone: 'ok', hint: 'Every word is in the searched fields, but not as a phrase in the name or subtitle.' },
  partial: { label: 'Partial', tone: 'warn', hint: 'Some of the words are in the searched fields.' },
  description_only: { label: 'Description only', tone: 'warn', hint: 'Only in the description, which the App Store may not search. Unverified.' },
  missing: { label: 'Missing', tone: 'bad', hint: 'None of the words are in the searched fields.' },
};

export const fitFieldLabels: Record<string, string> = {
  title: 'Name',
  subtitle: 'Subtitle',
  keywords: 'Keyword field',
  shortDescription: 'Short description',
  description: 'Description',
};

/** The listing fields to show a column for, per platform. */
export const fitColumns: Record<AsoPlatform, string[]> = {
  ios: ['title', 'subtitle', 'keywords', 'description'],
  android: ['title', 'shortDescription', 'description'],
};

/** How full the iOS keyword field is, for the meter. */
export function keywordMeter(bytes: number, max: number): { percent: number; tone: 'ok' | 'warn' | 'bad'; text: string } {
  const percent = max <= 0 ? 0 : Math.min(100, Math.round((bytes / max) * 100));
  const tone = bytes > max ? 'bad' : bytes >= max * 0.9 ? 'warn' : 'ok';
  const left = max - bytes;
  return { percent, tone, text: `${bytes} of ${max} bytes, ${left < 0 ? `${-left} over` : `${left} left`}` };
}

// ---------------------------------------------------------------------------------------------
// Ideas and gaps

/** The storefront an idea of a locale most likely belongs to: a market already tracked in it, else the region of the locale, else ''. */
export function countryForLocale(locale: string, keywords: readonly Pick<AsoKeyword, 'country' | 'locale'>[]): string {
  const known = keywords.filter((k) => k.locale.toLowerCase() === locale.toLowerCase())[0];
  if (known) return known.country;
  const parts = locale.split('-');
  const region = parts.length > 1 ? (parts[parts.length - 1] as string) : '';
  return /^[A-Za-z]{2}$/.test(region) ? region.toLowerCase() : '';
}

/** The locales of the tracked keywords, most used first. */
export function localesOf(keywords: readonly Pick<AsoKeyword, 'locale'>[]): string[] {
  const counts: Record<string, number> = {};
  for (const k of keywords) counts[k.locale] = (counts[k.locale] ?? 0) + 1;
  return Object.keys(counts).sort((a, b) => (counts[b] as number) - (counts[a] as number) || a.localeCompare(b));
}

/** "6 times in 3 of 4 texts". */
export function ideaWhy(idea: Pick<Idea, 'occurrences' | 'sources'>, texts: number): string {
  return `${idea.occurrences} ${idea.occurrences === 1 ? 'time' : 'times'} in ${idea.sources} of ${texts} ${texts === 1 ? 'text' : 'texts'}`;
}

/** What the ideas were read from: "your listing and 3 competitors". */
export function ideaSourceText(basedOn: AsoIdeasResponse['basedOn']): string {
  const parts: string[] = [];
  if (basedOn.ownListing) parts.push('your listing');
  if (basedOn.competitors > 0) parts.push(plural(basedOn.competitors, 'competitor', 'competitors'));
  return parts.length > 0 ? parts.join(' and ') : 'no texts yet';
}

export const ideaTexts = (basedOn: AsoIdeasResponse['basedOn']): number => basedOn.competitors + (basedOn.ownListing ? 1 : 0);

// ---------------------------------------------------------------------------------------------
// Markets

/** The countries of the rows, sorted, for the columns of the matrix. */
export function marketColumns(terms: readonly TermAcrossMarkets[]): string[] {
  const seen: Record<string, true | undefined> = {};
  for (const t of terms) for (const m of t.markets) seen[m.country] = true;
  return Object.keys(seen).sort();
}

export type MatrixCell = { text: string; title: string; best: boolean; muted: boolean };

/** One cell of the matrix: the best rank of the term in a country, "not ranked", or empty when it is not tracked there. */
export function marketCell(term: TermAcrossMarkets, country: string): MatrixCell {
  const here = term.markets.filter((m) => m.country === country);
  if (here.length === 0) return { text: '', title: 'Not tracked in this country', best: false, muted: true };
  const ranked = here.filter((m) => m.state === 'ranked' && m.rank !== null).map((m) => m.rank as number);
  const state = (m: (typeof here)[number]) =>
    m.state === 'ranked' ? `position ${m.rank}` : m.state === 'not_ranked' ? 'not in the results' : m.state === 'unavailable' ? 'not readable' : 'not checked';
  const title = here.map((m) => `${m.locale}: ${state(m)}`).join('; ');
  if (ranked.length > 0) {
    const best = Math.min(...ranked);
    return { text: String(best), title, best: term.bestRank !== null && best === term.bestRank, muted: false };
  }
  if (here.some((m) => m.state === 'not_ranked')) return { text: 'not ranked', title, best: false, muted: true };
  return { text: '–', title, best: false, muted: true };
}

// ---------------------------------------------------------------------------------------------
// The overview of all apps, and "Needs attention"

export type OverviewRow = { name: string; appId: string; platform: AsoPlatform; summary: AsoSummary };
export type OverviewMover = AsoMover & { name: string; appId: string; platform: AsoPlatform };

/** The moves of all apps, the biggest first. Gains (up, entered) and drops (down, dropped) are kept apart. */
export function overviewMovers(rows: readonly OverviewRow[], limit = 6): { gains: OverviewMover[]; drops: OverviewMover[] } {
  const all: OverviewMover[] = [];
  for (const r of rows) for (const m of r.summary.movers) all.push({ ...m, name: r.name, appId: r.appId, platform: r.platform });
  const size = (m: AsoMover) => (m.delta !== null ? Math.abs(m.delta) : 1000);
  all.sort((a, b) => size(b) - size(a) || a.term.localeCompare(b.term));
  return {
    gains: all.filter((m) => m.kind === 'up' || m.kind === 'entered').slice(0, limit),
    drops: all.filter((m) => m.kind === 'down' || m.kind === 'dropped').slice(0, limit),
  };
}

export type OverviewStats = { apps: number; keywords: number; ranked: number; top10: number; competitors: number; competitorChanges: number; failing: number };

/** An app with nothing tracked has nothing to show. */
export const hasAsoData = (s: AsoSummary): boolean => s.keywords.total > 0 || s.competitors.total > 0;

export function overviewStats(rows: readonly OverviewRow[]): OverviewStats {
  const s: OverviewStats = { apps: 0, keywords: 0, ranked: 0, top10: 0, competitors: 0, competitorChanges: 0, failing: 0 };
  for (const r of rows) {
    if (!hasAsoData(r.summary)) continue;
    s.apps += 1;
    s.keywords += r.summary.keywords.total;
    s.ranked += r.summary.keywords.ranked;
    s.top10 += r.summary.keywords.top10;
    s.competitors += r.summary.competitors.total;
    s.competitorChanges += r.summary.competitors.changedRecently;
    s.failing += r.summary.keywords.failing;
  }
  return s;
}

/** The default of `aso.rankMoveThreshold`, for a place that reads one summary only (the dashboard). */
export const DEFAULT_RANK_THRESHOLD = 5;

/** A drop worth showing: a move down of at least `threshold` places, or leaving the results from the top 10. */
export function isBigDrop(m: Pick<AsoMover, 'kind' | 'from' | 'delta'>, threshold: number = DEFAULT_RANK_THRESHOLD): boolean {
  if (m.kind === 'down') return Math.abs(m.delta ?? 0) >= threshold;
  if (m.kind === 'dropped') return (m.from ?? Number.POSITIVE_INFINITY) <= 10;
  return false;
}

export const moverText = (m: Pick<AsoMover, 'kind' | 'from' | 'to'>): string =>
  m.kind === 'entered' ? `entered at ${m.to}` : m.kind === 'dropped' ? `left the results (was ${m.from})` : `${m.from} to ${m.to}`;

export const moverMarket = (m: Pick<AsoMover, 'country' | 'locale'>): string => `${m.country.toUpperCase()} · ${m.locale}`;

/** A threshold as typed: a whole number from 1 to 100, else null. */
export function parseThreshold(text: string): number | null {
  if (!/^[0-9]{1,3}$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= 1 && n <= 100 ? n : null;
}

// ---------------------------------------------------------------------------------------------
// Quiet states

export type ConfigStates = { label: string; items: string[] } | null;

/**
 * What is switched off, as one pill: Google Play reading (only when an Android app is in scope) and the
 * scheduled checks. Null when everything that matters is on, so nothing is drawn.
 */
export function configStates(config: AsoConfig | null, androidInScope: boolean): ConfigStates {
  if (config === null) return null;
  const items: string[] = [];
  const short: string[] = [];
  if (androidInScope && !config.play.enabled) {
    short.push('Google Play reads off');
    items.push(`Google Play: ${config.play.notice} ${config.play.howToEnable}`);
  }
  if (config.schedule.intervalMinutes === 0) {
    short.push('automatic checks off');
    items.push('Automatic checks are off on this server, so ranks change only when someone presses Check now.');
  }
  if (short.length === 0) return null;
  const label = short.join(', ');
  return { label: label.charAt(0).toUpperCase() + label.slice(1), items };
}

const checkErrors: Record<string, string> = {
  rate_limited: 'The store asked us to slow down. The rank shown is the last one read.',
  unavailable_layout_changed: 'The store page could not be understood, so the rank shown is the last one read.',
  play_unofficial_disabled: 'Google Play reading is switched off, so this was not checked.',
  server: 'The server could not finish the check. The rank shown is the last one read.',
};

/** What a failed attempt means, for the InfoTip beside a rank. The rank itself is kept from the last success. */
export const checkErrorText = (code: string): string => checkErrors[code] ?? `The last check failed (${code}). The rank shown is the last one read.`;

/** One cell of the fit table: is the keyword in this listing field, as a phrase or only some of its words. */
export function fieldCell(k: { term: string; where: readonly { field: string; phrase: boolean; wordsPresent: number; occurrences: number }[] }, field: string): { mark: 'phrase' | 'words' | 'none'; text: string; title: string } {
  const m = k.where.filter((w) => w.field === field)[0];
  if (!m || m.wordsPresent === 0) return { mark: 'none', text: '', title: 'Not in this field' };
  if (m.phrase) return { mark: 'phrase', text: m.occurrences > 1 ? `x${m.occurrences}` : '', title: 'The phrase is in this field' };
  const checked = checkTerm(k.term);
  const n = checked.ok ? checked.words : m.wordsPresent;
  return { mark: 'words', text: `${m.wordsPresent}/${n}`, title: `${m.wordsPresent} of ${n} words are in this field, not as a phrase` };
}

export const priorityLabel = (priority: number): string => (priority >= 3 ? 'High' : priority <= 1 ? 'Low' : 'Normal');
