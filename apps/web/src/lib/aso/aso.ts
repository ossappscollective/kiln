import {
  type CoachAction,
  type CoverageGap,
  checkTerm,
  defaultLocaleFor,
  type FitFields,
  type FitStatus,
  type Idea,
  type ListingFit,
  type ListingStore,
  normalizeCountry,
  normalizeLocale,
  type Platform,
  type RankChange,
  type RankChangeKind,
  type SuggestedCompetitor,
  type TermAcrossMarkets,
} from '@kiln/core';
import { ApiError } from '../api.ts';
import { appAddress, type PlatformScope, parseViewPath } from '../app-scope.ts';
import { formatList, formatNumber } from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';
import type { IconName } from '../icons.ts';
import { termReason } from '../core-text.ts';
import { retrySeconds } from '../portfolio.ts';

/**
 * ASO in the web (docs/api/aso.md): the shapes of the API and the pure logic of the screens. Everything
 * here is plain data in and out so it can be tested; written for the ES2017 web build.
 *
 * A "rank" is a position in the results the store (or its public search service) returned for the term;
 * `rank: null` with `state: 'not_ranked'` means "not within the first `total` results".
 */

// ---------------------------------------------------------------------------------------------
// API shapes

export type AsoPlatform = Platform;
export type AsoStore = ListingStore;

export type AsoConfig = {
  apple: { enabled: boolean; source: string; documentedCallsPerMinute: number };
  play: { enabled: boolean; unofficial: boolean; notice: string; howToEnable: string };
  schedule: { intervalMinutes: number };
  retentionDays: number;
  limits: {
    maxKeywordsPerApp: number;
    maxCompetitorsPerApp: number;
    maxChecksPerRun: number;
    rankDepth: number;
    maxKeywordsPerRequest: number;
  };
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

export type AsoKeywordInput = {
  term: string;
  country?: string;
  locale?: string;
  tag?: string;
  notes?: string;
  priority?: number;
};
export type AsoAddSummary = { created: number; exists: number; invalid: number; limit: number };
export type AsoAddResult = {
  results: {
    index: number;
    status: 'created' | 'exists' | 'invalid' | 'limit';
    keyword?: AsoKeyword;
    message?: string;
  }[];
  summary: AsoAddSummary;
};

export type AsoCheck = {
  id: string;
  checkedAt: number;
  rank: number | null;
  total: number;
  source: string;
};
export type AsoKeywordHistory = {
  keyword: AsoKeyword;
  checks: AsoCheck[];
  trend: {
    direction: 'up' | 'down' | 'flat' | 'unknown';
    delta: number | null;
    latest: number | null;
    best: number | null;
    worst: number | null;
    samples: number;
  };
};

export type AsoChange = {
  field: string;
  from?: string | number | null;
  to?: string | number | null;
};
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
  keywords: {
    due: number;
    checked: number;
    ranked: number;
    notRanked: number;
    failed: number;
    cached: number;
    moved: number;
  };
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

export type AsoMover = {
  keywordId: string;
  term: string;
  country: string;
  locale: string;
  kind: string;
  from: number | null;
  to: number | null;
  delta: number | null;
};
export type AsoSummary = {
  app: { id: string; platform: AsoPlatform; store: AsoStore };
  keywords: {
    total: number;
    ranked: number;
    notRanked: number;
    unchecked: number;
    failing: number;
    top3: number;
    top10: number;
  };
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
  /** The stored listing text the fit was worked out from (for the budget meters). Absent from an older server. */
  fields?: FitFields | null;
};
export type AsoCoachResponse = {
  actions: CoachAction[];
  basedOn: {
    keywords: number;
    competitors: number;
    listingLocales: number;
    lastCheckAt: number | null;
    listingReadAt: number | null;
  };
};
export type AsoFitResponse = {
  readAt: number | null;
  error: string | null;
  locales: AsoFitView[] /** Every locale the stored listing has text for. Absent from an older server. */;
  listingLocales?: string[];
  indexedFields: string[];
  assumptions: string[];
};
export type AsoIdeasResponse = {
  locale: string;
  basedOn: { ownListing: boolean; competitors: number };
  ideas: Idea[];
  notes: string[];
};
export type AsoGapsResponse = {
  locale: string;
  competitors: number;
  gaps: CoverageGap[];
  notes: string[];
};
export type AsoSuggestion = SuggestedCompetitor & { country: string; name: string | null };
export type AsoSuggestionsResponse = {
  suggestions: AsoSuggestion[];
  basedOnKeywords: number;
  notes: string[];
};
/** The stored text of every locale of the listing (`GET /aso/listing-keywords`); the terms are worked out in the web with core `listingRows`. */
export type AsoListingKeywordsResponse = {
  readAt: number | null;
  error: string | null;
  locales: { locale: string; fields: FitFields }[];
  indexedFields: string[];
};
export type AsoMarketsResponse = { terms: TermAcrossMarkets[] };

// ---------------------------------------------------------------------------------------------
// Views of Keywords and Search terms in Insights (address backed: `?view=`)

export type AsoView =
  | 'keywords'
  | 'listing'
  | 'competitors'
  | 'ideas'
  | 'fit'
  | 'gaps'
  | 'markets'
  | 'terms'
  | 'rank';

/** A view with the key of its label (`t(labelKey)` where it is drawn). */
export type AsoViewItem = { id: AsoView; labelKey: string };

export const asoViews: AsoViewItem[] = [
  { id: 'keywords', labelKey: k('aso:view.keywords') },
  { id: 'listing', labelKey: k('aso:view.listing') },
  { id: 'competitors', labelKey: k('aso:view.competitors') },
  { id: 'ideas', labelKey: k('aso:view.ideas') },
  { id: 'fit', labelKey: k('aso:view.fit') },
  { id: 'gaps', labelKey: k('aso:view.gaps') },
  { id: 'markets', labelKey: k('aso:view.markets') },
  { id: 'terms', labelKey: k('aso:view.terms') },
  { id: 'rank', labelKey: k('aso:view.rank') },
];

/** The views an app section offers: Search terms is for Google Play apps only (a Play Console file), so it is left out without one. */
export const asoViewsFor = (androidInScope: boolean): AsoViewItem[] =>
  asoViews.filter((v) => v.id !== 'terms' || androidInScope);

/** The view to draw: the one asked for when this section offers it, else Keywords. */
export const availableAsoView = (view: AsoView, androidInScope: boolean): AsoView =>
  asoViewsFor(androidInScope).some((v) => v.id === view) ? view : 'keywords';

export const isAsoView = (value: string | null | undefined): value is AsoView =>
  value !== null && value !== undefined && asoViews.some((v) => v.id === value);

/** The sub-view an address names; Keywords when it names none. */
export function asoViewFromHash(hash: string): AsoView {
  const view = parseViewPath(hash).query.get('view');
  return isAsoView(view) ? view : 'keywords';
}

/**
 * The views of the Keywords page of Insights that are one click away (the segmented control); every other keyword view
 * (`keywordMoreViews`) is behind its "More" menu. Search terms is not here: it is a view of Insights of its own (Google Play only).
 */
export const keywordMainViews: AsoViewItem[] = [
  { id: 'keywords', labelKey: k('aso:view.keywords') },
  { id: 'rank', labelKey: k('aso:view.rank') },
];

/** The keyword views behind "More", with one line each for the menu. Together with `keywordMainViews` and Search terms they are every ASO view. */
export const keywordMoreViews: (AsoViewItem & { hintKey: string })[] = [
  { id: 'listing', labelKey: k('aso:view.listing'), hintKey: k('aso:view.listing.hint') },
  {
    id: 'competitors',
    labelKey: k('aso:view.competitors'),
    hintKey: k('aso:view.competitors.hint'),
  },
  { id: 'ideas', labelKey: k('aso:view.ideas'), hintKey: k('aso:view.ideas.hint') },
  { id: 'fit', labelKey: k('aso:view.fit'), hintKey: k('aso:view.fit.hint') },
  { id: 'gaps', labelKey: k('aso:view.gaps'), hintKey: k('aso:view.gaps.hint') },
  { id: 'markets', labelKey: k('aso:view.markets'), hintKey: k('aso:view.markets.hint') },
];

/** Whether a keyword view is behind the "More" menu. */
export const isMoreKeywordView = (view: AsoView): boolean =>
  keywordMoreViews.some((v) => v.id === view);

/** The same address with another sub-view (`?view=`). Keywords is written too: the default of Insights is Overview. Other query parts stay. */
export function withAsoView(hash: string, view: AsoView): string {
  const at = hash.indexOf('?');
  const path = at < 0 ? hash : hash.slice(0, at);
  const params = new URLSearchParams(at < 0 ? '' : hash.slice(at + 1));
  params.set('view', view);
  const search = params.toString();
  return search === '' ? path : `${path}?${search}`;
}

/** The address of a sub-view of Keywords (or of Search terms) in Insights of an app. */
export const asoViewHref = (
  appId: string,
  view: AsoView = 'keywords',
  platform: PlatformScope | null = null,
): string => withAsoView(appAddress(appId, 'insights', platform), view);

/** The workspace overview of all apps. */
export const asoOverviewHref = '#/aso';

// ---------------------------------------------------------------------------------------------
// Errors

const messages: Record<string, string> = {
  play_unofficial_disabled: k('aso:error.playUnofficialDisabled'),
  refresh_in_progress: k('aso:error.refreshInProgress'),
  already_followed: k('aso:error.alreadyFollowed'),
  limit_reached: k('aso:error.limitReached'),
  own_app: k('aso:error.ownApp'),
  invalid_external_id: k('aso:error.invalidExternalId'),
  invalid_country: k('aso:error.invalidCountry'),
  refresh_failed: k('aso:error.refreshFailed'),
  source_unavailable: k('aso:error.sourceUnavailable'),
  source_failed: k('aso:error.sourceUnavailable'),
  source_timeout: k('aso:error.sourceTimeout'),
};

/** "45 seconds", "2 minutes". */
export function waitText(seconds: number): string {
  if (seconds < 60) return t('aso:wait.seconds', { count: Math.max(1, Math.ceil(seconds)) });
  return t('aso:wait.minutes', { count: Math.ceil(seconds / 60) });
}

/** A sentence for an ASO call that failed. A limit says when to try again. The server's own message (English) is the last resort. */
export function asoErrorMessage(error: unknown, fallback?: string): string {
  const otherwise = fallback ?? t('aso:error.generic');
  if (!(error instanceof ApiError)) return otherwise;
  if (error.status === 422 && error.code === 'not_found') return t('aso:error.notFound');
  if (error.status === 429) {
    const seconds = retrySeconds(error);
    return seconds !== null
      ? t('aso:error.limitWait', { wait: waitText(seconds) })
      : t('aso:error.limitMinute');
  }
  const key = messages[error.code];
  return key !== undefined ? t(key) : (error.message ?? otherwise);
}

/** Seconds to wait before another refresh after a 429; null for any other error. */
export function refreshWaitSeconds(error: unknown): number | null {
  return error instanceof ApiError && error.status === 429 ? (retrySeconds(error) ?? 60) : null;
}

// ---------------------------------------------------------------------------------------------
// Text for ranks

/** The rank cell: "12", "50+" (not within the first 50), a dash for never checked. */
export function rankText(k: Pick<AsoKeyword, 'state' | 'rank' | 'total'>): {
  text: string;
  title: string;
  muted: boolean;
} {
  if (k.state === 'ranked' && k.rank !== null)
    return { text: String(k.rank), title: t('aso:rank.position', { rank: k.rank }), muted: false };
  if (k.state === 'not_ranked') {
    const n = k.total ?? 50;
    return { text: `${n}+`, title: t('aso:rank.notWithin', { count: n }), muted: true };
  }
  return { text: '–', title: t('aso:rank.notChecked'), muted: true };
}

export type ChangeInfo = {
  text: string;
  tone: 'ok' | 'bad' | 'neutral';
  icon: IconName | null;
  title: string;
};

/** "+3" (better), "-4" (worse), "New", "Entered", "Left", or a dash. Words and icons say it, not the colour. */
export function changeInfo(change: RankChange | null, checked: boolean): ChangeInfo {
  if (!checked) return { text: '–', tone: 'neutral', icon: null, title: t('aso:rank.notChecked') };
  const kind: RankChangeKind = change?.kind ?? 'first';
  switch (kind) {
    case 'up':
      return {
        text: `+${change?.delta ?? 0}`,
        tone: 'ok',
        icon: 'arrow-up',
        title: t('aso:change.up', { count: change?.delta ?? 0 }),
      };
    case 'down':
      return {
        text: `${change?.delta ?? 0}`,
        tone: 'bad',
        icon: 'arrow-down',
        title: t('aso:change.down', { count: Math.abs(change?.delta ?? 0) }),
      };
    case 'entered':
      return {
        text: t('aso:change.entered'),
        tone: 'ok',
        icon: 'arrow-up',
        title: t('aso:change.enteredTitle'),
      };
    case 'dropped':
      return {
        text: t('aso:change.left'),
        tone: 'bad',
        icon: 'arrow-down',
        title: t('aso:change.leftTitle'),
      };
    case 'same':
      return { text: '0', tone: 'neutral', icon: null, title: t('aso:change.sameTitle') };
    case 'still_unranked':
      return {
        text: '–',
        tone: 'neutral',
        icon: null,
        title: t('aso:change.stillUnrankedTitle'),
      };
    default:
      return {
        text: t('aso:change.new'),
        tone: 'neutral',
        icon: null,
        title: t('aso:change.newTitle'),
      };
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
export const keywordSorts: { id: KeywordSort; labelKey: string }[] = [
  { id: 'rank', labelKey: k('aso:sort.rank') },
  { id: 'move', labelKey: k('aso:sort.move') },
  { id: 'term', labelKey: k('aso:sort.term') },
  { id: 'checked', labelKey: k('aso:sort.checked') },
];

const rankOrder = (k: AsoKeyword): number =>
  k.state === 'ranked' && k.rank !== null ? k.rank : k.state === 'not_ranked' ? 10_000 : 20_000;

export function sortKeywords<T extends AsoKeyword>(list: readonly T[], sort: KeywordSort): T[] {
  const out = list.slice();
  const byTerm = (a: T, b: T) =>
    a.term.localeCompare(b.term) ||
    a.country.localeCompare(b.country) ||
    a.platform.localeCompare(b.platform);
  if (sort === 'term') out.sort(byTerm);
  else if (sort === 'move')
    out.sort(
      (a, b) =>
        moveSize(b.change) - moveSize(a.change) || rankOrder(a) - rankOrder(b) || byTerm(a, b),
    );
  else if (sort === 'checked')
    out.sort((a, b) => (b.lastCheckedAt ?? 0) - (a.lastCheckedAt ?? 0) || byTerm(a, b));
  else out.sort((a, b) => rankOrder(a) - rankOrder(b) || byTerm(a, b));
  return out;
}

/** "US · en-US". */
export const marketText = (k: Pick<AsoKeyword, 'country' | 'locale'>): string =>
  `${k.country.toUpperCase()} · ${k.locale}`;

/** Case insensitive match on the term, the tag and the market. */
export function filterKeywords<T extends AsoKeyword>(list: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === '') return list.slice();
  return list.filter(
    (k) =>
      k.term.toLowerCase().indexOf(q) >= 0 ||
      (k.tag ?? '').toLowerCase().indexOf(q) >= 0 ||
      marketText(k).toLowerCase().indexOf(q) >= 0,
  );
}

// ---------------------------------------------------------------------------------------------
// Sparkline

export type Spark = {
  path: string;
  width: number;
  height: number;
  last: { x: number; y: number } | null;
  samples: number;
};

/**
 * A tiny line of a rank history (oldest first): rank 1 is at the top, "not ranked" counts as one past the
 * deepest result seen and sits at the bottom. One check is a dot, none is nothing.
 */
export function sparkline(
  checks: readonly Pick<AsoCheck, 'rank' | 'total'>[],
  width = 72,
  height = 20,
  pad = 2,
): Spark {
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
      invalid.push({ text: part.trim().slice(0, 40), reason: termReason(checked) });
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
  'us',
  'gb',
  'ca',
  'au',
  'de',
  'fr',
  'es',
  'it',
  'nl',
  'se',
  'no',
  'dk',
  'fi',
  'pl',
  'pt',
  'br',
  'mx',
  'jp',
  'kr',
  'cn',
  'in',
  'tr',
  'ru',
  'ch',
  'at',
  'ie',
  'nz',
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

export const emptyAddSummary = (): AsoAddSummary => ({
  created: 0,
  exists: 0,
  invalid: 0,
  limit: 0,
});

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

/** "Added 8 keywords. 2 already tracked, 1 not accepted, 3 over the limit of 50." */
export function addSummaryText(s: AsoAddSummary, maxPerApp?: number): string {
  const head =
    s.created > 0
      ? t('aso:addSummary.added', { count: s.created })
      : t('aso:addSummary.nothingAdded');
  const rest: string[] = [];
  if (s.exists > 0) rest.push(t('aso:addSummary.exists', { count: s.exists }));
  if (s.invalid > 0) rest.push(t('aso:addSummary.invalid', { count: s.invalid }));
  if (s.limit > 0)
    rest.push(
      maxPerApp
        ? t('aso:addSummary.limitOf', { count: s.limit, max: maxPerApp })
        : t('aso:addSummary.limit', { count: s.limit }),
    );
  return rest.length > 0
    ? t('aso:addSummary.withRest', { head, rest: formatList(rest, { type: 'unit' }) })
    : head;
}

// ---------------------------------------------------------------------------------------------
// Refresh

/** "Checked 25 of 40 keywords and 3 of 3 competitors." with what stopped it, when it did. */
export function refreshText(result: AsoRefreshResult): string {
  const k = result.keywords;
  const c = result.competitors;
  const keywords = t('aso:refresh.keywordsOf', { checked: k.checked, count: k.due });
  let text =
    c.due > 0
      ? t('aso:refresh.checkedBoth', {
          keywords,
          competitors: t('aso:refresh.competitorsOf', { checked: c.checked, count: c.due }),
        })
      : t('aso:refresh.checkedKeywords', { keywords });
  if (k.moved > 0) text += ` ${t('aso:refresh.moved', { count: k.moved })}`;
  if (result.deferred) {
    const why: Record<string, string> = {
      cap: t('aso:refresh.stop.cap'),
      time: t('aso:refresh.stop.time'),
      rate_limit: result.retryAfterSeconds
        ? t('aso:refresh.stop.rateLimitWait', { wait: waitText(result.retryAfterSeconds) })
        : t('aso:refresh.stop.rateLimit'),
      unavailable: t('aso:refresh.stop.unavailable'),
      errors: t('aso:refresh.stop.errors'),
    };
    text += ` ${why[result.stoppedBecause ?? 'cap'] ?? t('aso:refresh.stop.cap')}`;
  }
  return text;
}

/** Seconds to wait after a run that stopped for a store's limit, or null. */
export function resultWaitSeconds(result: AsoRefreshResult): number | null {
  return result.stoppedBecause === 'rate_limit' && result.retryAfterSeconds
    ? result.retryAfterSeconds
    : null;
}

// ---------------------------------------------------------------------------------------------
// Competitors

const fieldLabels: Record<string, string> = {
  version: k('aso:field.version'),
  title: k('aso:field.title'),
  subtitle: k('aso:field.subtitle'),
  price: k('aso:field.price'),
  description: k('aso:field.description'),
  media: k('aso:field.media'),
  screenshots: k('aso:field.screenshots'),
  rating: k('aso:field.rating'),
  ratingCount: k('aso:field.ratingCount'),
  rating_count: k('aso:field.ratingCount'),
  keywords: k('aso:field.keywords'),
  shortDescription: k('aso:field.shortDescription'),
};

/** The label of a field; a field this app does not know is shown as the store sent it. */
export const fieldLabel = (field: string): string => {
  const key = fieldLabels[field];
  return key !== undefined ? t(key) : field;
};

const shown = (v: string | number | null | undefined): string =>
  v === null || v === undefined || v === '' ? t('aso:value.none') : String(v);

/** "Version 2.0 to 2.1", "Description changed". The values are public short texts, shown as plain text. */
export function changeText(c: AsoChange): string {
  const field = fieldLabel(c.field);
  if (c.from === undefined && c.to === undefined) return t('aso:changeText.changed', { field });
  const count = c.field === 'ratingCount' || c.field === 'rating_count';
  const from = count && typeof c.from === 'number' ? formatNumber(c.from) : shown(c.from);
  const to = count && typeof c.to === 'number' ? formatNumber(c.to) : shown(c.to);
  return t('aso:changeText.fromTo', { field, from, to });
}

const daysAgo = (at: number, now: number): string => {
  const days = Math.floor((now - at) / 86_400_000);
  return days <= 0
    ? t('aso:time.today')
    : days === 1
      ? t('aso:time.yesterday')
      : t('aso:time.daysAgo', { count: days });
};

/** The one line on a competitor card about the last change. */
export function lastChangeText(
  h: Pick<AsoCompetitorHistory, 'diff'> | null,
  c: AsoCompetitor,
  now: number,
): string {
  if (h?.diff && h.diff.changes.length > 0) {
    const more = h.diff.changes.length - 1;
    const change = changeText(h.diff.changes[0] as AsoChange);
    const when = daysAgo(h.diff.at, now);
    return more > 0
      ? t('aso:lastChange.withMore', { change, count: more, when })
      : t('aso:lastChange.at', { change, when });
  }
  const latest = c.latest;
  if (latest?.changes && latest.changes.length > 0)
    return t('aso:lastChange.at', {
      change: changeText(latest.changes[0] as AsoChange),
      when: daysAgo(latest.checkedAt, now),
    });
  if (c.state === 'not_found') return t('aso:lastChange.gone');
  return latest ? t('aso:lastChange.none') : t('aso:lastChange.notYet');
}

/** Stars with one decimal: "4.6". */
export const ratingText = (rating: number | null | undefined): string =>
  rating === null || rating === undefined
    ? '–'
    : formatNumber(rating, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const countText = (n: number | null | undefined): string =>
  n === null || n === undefined ? '–' : formatNumber(n);

export type CompareRow = { label: string; ours: string; theirs: string[] };
export type OurFacts = {
  version: string | null;
  rating: number | null;
  ratingCount: number | null;
};

/** The side by side of our app and the followed ones. A value we do not hold is a dash, never a guess. */
export function compareRows(ours: OurFacts, others: readonly AsoCompetitor[]): CompareRow[] {
  const col = (f: (s: AsoSnapshot) => string): string[] =>
    others.map((c) => (c.latest ? f(c.latest) : '–'));
  return [
    {
      label: t('aso:compare.version'),
      ours: ours.version ?? '–',
      theirs: col((s) => s.version ?? '–'),
    },
    {
      label: t('aso:compare.rating'),
      ours: ratingText(ours.rating),
      theirs: col((s) => ratingText(s.rating)),
    },
    {
      label: t('aso:compare.ratings'),
      ours: countText(ours.ratingCount),
      theirs: col((s) => countText(s.ratingCount)),
    },
    { label: t('aso:compare.price'), ours: '–', theirs: col((s) => s.price ?? '–') },
    {
      label: t('aso:compare.screenshots'),
      ours: '–',
      theirs: col((s) => (s.screenshotCount === null ? '–' : String(s.screenshotCount))),
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Fit

/** `labelKey` and `hintKey` are message keys: `t(info.labelKey)` where it is drawn. */
export const fitStatusInfo: Record<
  FitStatus,
  { labelKey: string; tone: 'ok' | 'warn' | 'bad' | 'neutral'; hintKey: string }
> = {
  strong: { labelKey: k('aso:fit.strong'), tone: 'ok', hintKey: k('aso:fit.strong.hint') },
  covered: { labelKey: k('aso:fit.covered'), tone: 'ok', hintKey: k('aso:fit.covered.hint') },
  partial: { labelKey: k('aso:fit.partial'), tone: 'warn', hintKey: k('aso:fit.partial.hint') },
  description_only: {
    labelKey: k('aso:fit.descriptionOnly'),
    tone: 'warn',
    hintKey: k('aso:fit.descriptionOnly.hint'),
  },
  missing: { labelKey: k('aso:fit.missing'), tone: 'bad', hintKey: k('aso:fit.missing.hint') },
};

/** Message keys of the listing fields (`t(fitFieldLabels[field])`). */
export const fitFieldLabels: Record<string, string> = {
  title: k('aso:field.title'),
  subtitle: k('aso:field.subtitle'),
  keywords: k('aso:field.keywords'),
  shortDescription: k('aso:field.shortDescription'),
  description: k('aso:field.description'),
};

/** The listing fields to show a column for, per platform. */
export const fitColumns: Record<AsoPlatform, string[]> = {
  ios: ['title', 'subtitle', 'keywords', 'description'],
  macos: ['title', 'subtitle', 'keywords', 'description'],
  android: ['title', 'shortDescription', 'description'],
};

/** How full the iOS keyword field is, for the meter. */
export function keywordMeter(
  bytes: number,
  max: number,
): { percent: number; tone: 'ok' | 'warn' | 'bad'; text: string } {
  const percent = max <= 0 ? 0 : Math.min(100, Math.round((bytes / max) * 100));
  const tone = bytes > max ? 'bad' : bytes >= max * 0.9 ? 'warn' : 'ok';
  const left = max - bytes;
  return {
    percent,
    tone,
    text:
      left < 0
        ? t('aso:meter.over', { bytes, count: max, over: -left })
        : t('aso:meter.left', { bytes, count: max, left }),
  };
}

// ---------------------------------------------------------------------------------------------
// Ideas and gaps

/** The storefront an idea of a locale most likely belongs to: a market already tracked in it, else the region of the locale, else ''. */
export function countryForLocale(
  locale: string,
  keywords: readonly Pick<AsoKeyword, 'country' | 'locale'>[],
): string {
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
  return Object.keys(counts).sort(
    (a, b) => (counts[b] as number) - (counts[a] as number) || a.localeCompare(b),
  );
}

/** "6 times in 3 of 4 texts". */
export function ideaWhy(idea: Pick<Idea, 'occurrences' | 'sources'>, texts: number): string {
  return t('aso:idea.why', {
    count: idea.occurrences,
    texts: t('aso:idea.texts', { count: texts, sources: idea.sources }),
  });
}

/** What the ideas were read from: "your listing and 3 competitors". */
export function ideaSourceText(basedOn: AsoIdeasResponse['basedOn']): string {
  const parts: string[] = [];
  if (basedOn.ownListing) parts.push(t('aso:idea.ownListing'));
  if (basedOn.competitors > 0)
    parts.push(t('aso:idea.competitors', { count: basedOn.competitors }));
  return parts.length > 0 ? formatList(parts) : t('aso:idea.noTexts');
}

export const ideaTexts = (basedOn: AsoIdeasResponse['basedOn']): number =>
  basedOn.competitors + (basedOn.ownListing ? 1 : 0);

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
  if (here.length === 0)
    return { text: '', title: t('aso:market.notTracked'), best: false, muted: true };
  const ranked = here
    .filter((m) => m.state === 'ranked' && m.rank !== null)
    .map((m) => m.rank as number);
  const state = (m: (typeof here)[number]) =>
    m.state === 'ranked'
      ? t('aso:market.position', { rank: m.rank ?? '' })
      : m.state === 'not_ranked'
        ? t('aso:market.notInResults')
        : m.state === 'unavailable'
          ? t('aso:market.notReadable')
          : t('aso:market.notChecked');
  const title = here
    .map((m) => t('aso:market.localeState', { locale: m.locale, state: state(m) }))
    .join('; ');
  if (ranked.length > 0) {
    const best = Math.min(...ranked);
    return {
      text: String(best),
      title,
      best: term.bestRank !== null && best === term.bestRank,
      muted: false,
    };
  }
  if (here.some((m) => m.state === 'not_ranked'))
    return { text: t('aso:market.notRanked'), title, best: false, muted: true };
  return { text: '–', title, best: false, muted: true };
}

// ---------------------------------------------------------------------------------------------
// The overview of all apps, and "Needs attention"

export type OverviewRow = {
  name: string;
  appId: string;
  platform: AsoPlatform;
  summary: AsoSummary;
};
export type OverviewMover = AsoMover & { name: string; appId: string; platform: AsoPlatform };

/** The moves of all apps, the biggest first. Gains (up, entered) and drops (down, dropped) are kept apart. */
export function overviewMovers(
  rows: readonly OverviewRow[],
  limit = 6,
): { gains: OverviewMover[]; drops: OverviewMover[] } {
  const all: OverviewMover[] = [];
  for (const r of rows)
    for (const m of r.summary.movers)
      all.push({ ...m, name: r.name, appId: r.appId, platform: r.platform });
  const size = (m: AsoMover) => (m.delta !== null ? Math.abs(m.delta) : 1000);
  all.sort((a, b) => size(b) - size(a) || a.term.localeCompare(b.term));
  return {
    gains: all.filter((m) => m.kind === 'up' || m.kind === 'entered').slice(0, limit),
    drops: all.filter((m) => m.kind === 'down' || m.kind === 'dropped').slice(0, limit),
  };
}

export type OverviewStats = {
  apps: number;
  keywords: number;
  ranked: number;
  top10: number;
  competitors: number;
  competitorChanges: number;
  failing: number;
};

/** An app with nothing tracked has nothing to show. */
export const hasAsoData = (s: AsoSummary): boolean =>
  s.keywords.total > 0 || s.competitors.total > 0;

export function overviewStats(rows: readonly OverviewRow[]): OverviewStats {
  const s: OverviewStats = {
    apps: 0,
    keywords: 0,
    ranked: 0,
    top10: 0,
    competitors: 0,
    competitorChanges: 0,
    failing: 0,
  };
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
export function isBigDrop(
  m: Pick<AsoMover, 'kind' | 'from' | 'delta'>,
  threshold: number = DEFAULT_RANK_THRESHOLD,
): boolean {
  if (m.kind === 'down') return Math.abs(m.delta ?? 0) >= threshold;
  if (m.kind === 'dropped') return (m.from ?? Number.POSITIVE_INFINITY) <= 10;
  return false;
}

export const moverText = (m: Pick<AsoMover, 'kind' | 'from' | 'to'>): string =>
  m.kind === 'entered'
    ? t('aso:mover.entered', { to: m.to ?? '' })
    : m.kind === 'dropped'
      ? t('aso:mover.dropped', { from: m.from ?? '' })
      : t('aso:mover.fromTo', { from: m.from ?? '', to: m.to ?? '' });

export const moverMarket = (m: Pick<AsoMover, 'country' | 'locale'>): string =>
  `${m.country.toUpperCase()} · ${m.locale}`;

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
  const play = androidInScope && !config.play.enabled;
  const auto = config.schedule.intervalMinutes === 0;
  if (play) {
    items.push(
      t('aso:states.playItem', {
        notice: config.play.notice,
        howToEnable: config.play.howToEnable,
      }),
    );
  }
  if (auto) items.push(t('aso:states.autoItem'));
  if (!play && !auto) return null;
  return {
    label: play && auto ? t('aso:states.both') : play ? t('aso:states.play') : t('aso:states.auto'),
    items,
  };
}

const checkErrors: Record<string, string> = {
  rate_limited: k('aso:checkError.rateLimited'),
  unavailable_layout_changed: k('aso:checkError.unavailableLayoutChanged'),
  play_unofficial_disabled: k('aso:checkError.playUnofficialDisabled'),
  server: k('aso:checkError.server'),
};

/** What a failed attempt means, for the InfoTip beside a rank. The rank itself is kept from the last success. */
export const checkErrorText = (code: string): string => {
  const key = checkErrors[code];
  return key !== undefined ? t(key) : t('aso:checkError.other', { code });
};

/** One cell of the fit table: is the keyword in this listing field, as a phrase or only some of its words. */
export function fieldCell(
  k: {
    term: string;
    where: readonly { field: string; phrase: boolean; wordsPresent: number; occurrences: number }[];
  },
  field: string,
): { mark: 'phrase' | 'words' | 'none'; text: string; title: string } {
  const m = k.where.filter((w) => w.field === field)[0];
  if (!m || m.wordsPresent === 0) return { mark: 'none', text: '', title: t('aso:fieldCell.none') };
  if (m.phrase)
    return {
      mark: 'phrase',
      text: m.occurrences > 1 ? `x${m.occurrences}` : '',
      title: t('aso:fieldCell.phrase'),
    };
  const checked = checkTerm(k.term);
  const n = checked.ok ? checked.words : m.wordsPresent;
  return {
    mark: 'words',
    text: `${m.wordsPresent}/${n}`,
    title: t('aso:fieldCell.words', { present: m.wordsPresent, count: n }),
  };
}

export const priorityLabel = (priority: number): string =>
  priority >= 3
    ? t('aso:priority.high')
    : priority <= 1
      ? t('aso:priority.low')
      : t('aso:priority.normal');
