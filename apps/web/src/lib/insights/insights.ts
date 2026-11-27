import type {
  CheckIssue,
  CheckSeverity,
  CoverageCountry,
  CoverageLanguage,
  InsightCard,
  InsightCategory,
  InsightEvidence,
  InsightSeverity,
  InsightTarget,
  LanguageCoverage,
  ListingStore,
  LocaleChecks,
} from '@kiln/core';
import { INSIGHT_CATEGORIES } from '@kiln/core';
import { appAddress, type PlatformScope } from '../app-scope.ts';
import {
  formatDate,
  formatDisplayName,
  formatList,
  formatNumber,
  formatPercent,
} from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';
import type { IconName } from '../icons.ts';
import { badgeText } from '../nav-badges.ts';

/**
 * Insights, store page checks and country language coverage as pure functions (docs/api/insights.md): the shapes the server sends, the
 * filter chips and their counts, the order of the cards, the sentence of a card (`insights:card.<code>.*`), where an action goes, the badge
 * of the app navigation, the empty-state reasons, the bars of the language coverage. No network, no DOM.
 */

// ---------------------------------------------------------------------------------------------
// What the server sends

export type SkipReason =
  | 'no_data'
  | 'too_little_data'
  | 'no_countries'
  | 'no_listing'
  | 'no_reviews'
  | 'no_keywords'
  | 'not_for_store'
  | 'no_access';
export type SkippedRule = { rule: string; reason: string };

export type InsightsView = {
  appId: string;
  generatedAt: number;
  cards: InsightCard[];
  hiddenCount: number;
  counts: Record<InsightCategory, number>;
  skipped: SkippedRule[];
};

export type CountriesView = {
  appId: string;
  store: ListingStore;
  unavailable: 'no_countries' | 'no_listing' | 'no_access' | null;
  storeLocales: string[];
  coverage: LanguageCoverage | null;
};

export type ListingChecksView = {
  appId: string;
  store: ListingStore;
  unavailable: 'no_listing' | null;
  /** The base locale the others are compared with (declared by the store, else English, else the first). */
  baseLocale?: string | null;
  score: number | null;
  issueCount: number;
  counts: { problems: number; warnings: number; tips: number };
  locales: LocaleChecks[];
};

// ---------------------------------------------------------------------------------------------
// Cards: order, filter, chips

const SEVERITY_ORDER: readonly InsightSeverity[] = ['problem', 'warning', 'info', 'good'];

/** The cards in the order to read: problems, warnings, information, good news; inside a severity the server's order (weight) stays. */
export function sortCards(cards: readonly InsightCard[]): InsightCard[] {
  return cards
    .map((card, i) => ({ card, i }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.card.severity) - SEVERITY_ORDER.indexOf(b.card.severity) ||
        a.i - b.i,
    )
    .map((x) => x.card);
}

export type CategoryChip = { id: 'all' | InsightCategory; count: number };

/** `All` first, then each category that has at least one card, in the fixed order of categories. Counts are of the cards given. */
export function categoryChips(cards: readonly InsightCard[]): CategoryChip[] {
  const out: CategoryChip[] = [{ id: 'all', count: cards.length }];
  for (const id of INSIGHT_CATEGORIES) {
    const count = cards.filter((c) => c.category === id).length;
    if (count > 0) out.push({ id, count });
  }
  return out;
}

/** A selected category that has no card any more (the last one was dismissed) is All again. */
export function activeCategory(
  selected: 'all' | InsightCategory,
  chips: readonly CategoryChip[],
): 'all' | InsightCategory {
  return chips.some((c) => c.id === selected) ? selected : 'all';
}

const CATEGORY_NAME: Record<InsightCategory, string> = {
  visibility: k('insights:category.visibility'),
  conversion: k('insights:category.conversion'),
  downloads: k('insights:category.downloads'),
  markets: k('insights:category.markets'),
  reviews: k('insights:category.reviews'),
  keywords: k('insights:category.keywords'),
  listing: k('insights:category.listing'),
};
/** The name of a filter chip. */
export const chipLabel = (id: 'all' | InsightCategory): string =>
  t(id === 'all' ? k('insights:filter.all') : CATEGORY_NAME[id]);

const SEVERITY_NAME: Record<InsightSeverity, string> = {
  problem: k('insights:severity.problem'),
  warning: k('insights:severity.warning'),
  info: k('insights:severity.info'),
  good: k('insights:severity.good'),
};
/** The word for a severity, read by a screen reader beside the icon. */
export const severityLabel = (severity: InsightSeverity): string => t(SEVERITY_NAME[severity]);

const CHECK_SEVERITY_NAME: Record<CheckSeverity, string> = {
  problem: k('insights:check.severity.problem'),
  warning: k('insights:check.severity.warning'),
  tip: k('insights:check.severity.tip'),
};
export const checkSeverityLabel = (severity: CheckSeverity): string =>
  t(CHECK_SEVERITY_NAME[severity]);

export const filterCards = (
  cards: readonly InsightCard[],
  category: 'all' | InsightCategory,
): InsightCard[] =>
  category === 'all' ? [...cards] : cards.filter((c) => c.category === category);

/** The cards of the list after one was dismissed (or put back): what the person sees at once, before the next read. */
export const withoutCard = (cards: readonly InsightCard[], id: string): InsightCard[] =>
  cards.filter((c) => c.id !== id);

/** Puts a card back where the server's order had it (by the order of `original`); a card already there stays once. */
export function withCardBack(
  cards: readonly InsightCard[],
  card: InsightCard,
  original: readonly InsightCard[],
): InsightCard[] {
  if (cards.some((c) => c.id === card.id)) return [...cards];
  const rank = (id: string) => original.findIndex((c) => c.id === id);
  return [...cards, card].sort((a, b) => rank(a.id) - rank(b.id));
}

// ---------------------------------------------------------------------------------------------
// The badge of the app navigation

/** The badge of the Insights entry: the cards of every record of the app that were read (a record not read yet counts nothing); null when none was read. */
export function navBadgeCount(
  ids: readonly string[],
  counts: Readonly<Record<string, number | undefined>>,
): number | null {
  let known = 0;
  let sum = 0;
  for (const id of ids) {
    const n = counts[id];
    if (typeof n !== 'number' || !Number.isFinite(n)) continue;
    known += 1;
    sum += Math.max(0, Math.floor(n));
  }
  return known === 0 ? null : sum;
}

/** The text of the badge (nothing for zero or unknown, 99+ above 99): the same rule as the other entries. */
export const insightsBadgeText = (count: number | null): string | null => badgeText(count);

/** A count read at `at` is fresh for this long; reading it again earlier is not worth a request (no polling). */
export const COUNT_MAX_AGE_MS = 5 * 60_000;

export function countIsFresh(readAt: number | undefined, now: number): boolean {
  return readAt !== undefined && now - readAt >= 0 && now - readAt < COUNT_MAX_AGE_MS;
}

// ---------------------------------------------------------------------------------------------
// The look of a card

export const SEVERITY_ICON: Record<InsightSeverity, IconName> = {
  problem: 'x-circle',
  warning: 'alert-triangle',
  info: 'info',
  good: 'check-circle',
};

export const SEVERITY_TONE: Record<InsightSeverity, 'bad' | 'warn' | 'info' | 'ok'> = {
  problem: 'bad',
  warning: 'warn',
  info: 'info',
  good: 'ok',
};

const PERCENT_PARAMS = new Set(['percent']);
const RATE_PARAMS = new Set(['now', 'before']);

/** The numbers of a card, written for the person's language, and names instead of codes (a language, the countries). */
export function cardParams(
  card: Pick<InsightCard, 'code' | 'params'>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const rating = card.code === 'version_rating.drop';
  for (const [key, value] of Object.entries(card.params)) {
    if (typeof value !== 'number') {
      if (key === 'language') out[key] = languageText(value);
      else if (key === 'countries')
        out[key] = formatList(value.split(',').filter(Boolean).map(regionText));
      else if (key === 'country') out[key] = regionText(value);
      else if (key === 'day') out[key] = dayText(value);
      else out[key] = value;
    } else if (PERCENT_PARAMS.has(key)) out[key] = formatPercent(value / 100);
    else if (RATE_PARAMS.has(key) && !rating)
      out[key] = formatPercent(value / 100, { maximumFractionDigits: 1 });
    else if (RATE_PARAMS.has(key)) out[key] = formatNumber(value, { maximumFractionDigits: 1 });
    else out[key] = formatNumber(value);
  }
  return out;
}

type Sentence = { headline: string; explain: string };
const CARD_TEXT: Record<string, Sentence> = {
  'visibility.up.seen': {
    headline: k('insights:card.visibilityUpSeen.headline'),
    explain: k('insights:card.visibilityUpSeen.explain'),
  },
  'visibility.down.seen': {
    headline: k('insights:card.visibilityDownSeen.headline'),
    explain: k('insights:card.visibilityDownSeen.explain'),
  },
  'visibility.up.visits': {
    headline: k('insights:card.visibilityUpVisits.headline'),
    explain: k('insights:card.visibilityUpVisits.explain'),
  },
  'visibility.down.visits': {
    headline: k('insights:card.visibilityDownVisits.headline'),
    explain: k('insights:card.visibilityDownVisits.explain'),
  },
  'conversion.up': {
    headline: k('insights:card.conversionUp.headline'),
    explain: k('insights:card.conversionUp.explain'),
  },
  'conversion.down': {
    headline: k('insights:card.conversionDown.headline'),
    explain: k('insights:card.conversionDown.explain'),
  },
  'downloads.up': {
    headline: k('insights:card.downloadsUp.headline'),
    explain: k('insights:card.downloadsUp.explain'),
  },
  'downloads.down': {
    headline: k('insights:card.downloadsDown.headline'),
    explain: k('insights:card.downloadsDown.explain'),
  },
  'featured.spike': {
    headline: k('insights:card.featuredSpike.headline'),
    explain: k('insights:card.featuredSpike.explain'),
  },
  localize: {
    headline: k('insights:card.localize.headline'),
    explain: k('insights:card.localize.explain'),
  },
  complaints: {
    headline: k('insights:card.complaints.headline'),
    explain: k('insights:card.complaints.explain'),
  },
  'version_rating.drop': {
    headline: k('insights:card.versionRatingDrop.headline'),
    explain: k('insights:card.versionRatingDrop.explain'),
  },
  'keywords.up': {
    headline: k('insights:card.keywordsUp.headline'),
    explain: k('insights:card.keywordsUp.explain'),
  },
  'keywords.down': {
    headline: k('insights:card.keywordsDown.headline'),
    explain: k('insights:card.keywordsDown.explain'),
  },
  'listing.issues': {
    headline: k('insights:card.listingIssues.headline'),
    explain: k('insights:card.listingIssues.explain'),
  },
  'listing.review': {
    headline: k('insights:card.listingReview.headline'),
    explain: k('insights:card.listingReview.explain'),
  },
};
const UNKNOWN_CARD: Sentence = {
  headline: k('insights:card.unknown.headline'),
  explain: k('insights:card.unknown.explain'),
};

const THEME_NAME: Record<string, string> = {
  crash: k('insights:theme.crash'),
  bug: k('insights:theme.bug'),
  login: k('insights:theme.login'),
  data: k('insights:theme.data'),
  price: k('insights:theme.price'),
  ads: k('insights:theme.ads'),
  performance: k('insights:theme.performance'),
  update: k('insights:theme.update'),
};

/** The sentence of a code. `complaints.<theme>` is one sentence with the theme named; a code from a newer server reads as a generic card. */
function sentenceOf(card: Pick<InsightCard, 'code' | 'params'>): {
  text: Sentence;
  extra: Record<string, string>;
} {
  if (card.code.startsWith('complaints.')) {
    const theme = THEME_NAME[card.code.slice('complaints.'.length)];
    return {
      text: CARD_TEXT.complaints as Sentence,
      extra: { theme: theme ? t(theme) : card.code.slice('complaints.'.length) },
    };
  }
  const text = CARD_TEXT[card.code];
  return text ? { text, extra: {} } : { text: UNKNOWN_CARD, extra: {} };
}

export const headlineOf = (card: Pick<InsightCard, 'code' | 'params'>): string => {
  const { text, extra } = sentenceOf(card);
  return t(text.headline, { ...cardParams(card), ...extra });
};
export const explainOf = (card: Pick<InsightCard, 'code' | 'params'>): string => {
  const { text, extra } = sentenceOf(card);
  return t(text.explain, { ...cardParams(card), ...extra });
};

const ACTION_TEXT: Record<string, string> = {
  openOverview: k('insights:action.openOverview'),
  openKeywords: k('insights:action.openKeywords'),
  openGraphics: k('insights:action.openGraphics'),
  openText: k('insights:action.openText'),
  openCountries: k('insights:action.openCountries'),
  addLocale: k('insights:action.addLocale'),
  openReviews: k('insights:action.openReviews'),
  openRank: k('insights:action.openRank'),
  openChecks: k('insights:action.openChecks'),
};
/** The button text of an action code; a code from a newer server reads as "Open". */
export const actionLabel = (code: string): string =>
  t(ACTION_TEXT[code] ?? k('insights:action.open'));

const regionText = (code: string): string => formatDisplayName(code, 'region') || code;
export const languageText = (tag: string): string => formatDisplayName(tag, 'language') || tag;
function dayText(day: string): string {
  const at = Date.parse(`${day}T12:00:00Z`);
  return Number.isFinite(at) ? formatDate(at, { dateStyle: 'medium', timeZone: 'UTC' }) : day;
}

const EVIDENCE_LABEL: Record<string, string> = {
  current: k('insights:evidence.current'),
  previous: k('insights:evidence.previous'),
  rateNow: k('insights:evidence.rateNow'),
  ratePrevious: k('insights:evidence.ratePrevious'),
  browseDay: k('insights:evidence.browseDay'),
  browseUsual: k('insights:evidence.browseUsual'),
  day: k('insights:evidence.day'),
  share: k('insights:evidence.share'),
  downloads: k('insights:evidence.downloads'),
  mentions: k('insights:evidence.mentions'),
  complaints: k('insights:evidence.complaints'),
  ratingNow: k('insights:evidence.ratingNow'),
  ratingPrevious: k('insights:evidence.ratingPrevious'),
  score: k('insights:evidence.score'),
  issues: k('insights:evidence.issues'),
  warnings: k('insights:evidence.warnings'),
};

/** One evidence line: a label and a value, written for the person's language. A key that is not a known name (a keyword and its country) is shown as it is. */
export function evidenceLine(e: InsightEvidence): { label: string; value: string } {
  const known = EVIDENCE_LABEL[e.key];
  const label = known ? t(known) : e.key;
  let value: string;
  switch (e.format) {
    case 'percent':
      value =
        typeof e.value === 'number'
          ? formatPercent(e.value, { maximumFractionDigits: 1 })
          : String(e.value);
      break;
    case 'rating':
      value =
        typeof e.value === 'number'
          ? formatNumber(e.value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
          : String(e.value);
      break;
    case 'rank':
      value =
        typeof e.value === 'number' && e.value > 0
          ? `#${formatNumber(e.value)}`
          : t('insights:evidence.unranked');
      break;
    case 'day':
      value = typeof e.value === 'string' ? dayText(e.value) : String(e.value);
      break;
    case 'text':
      value = String(e.value);
      break;
    default:
      value = typeof e.value === 'number' ? formatNumber(e.value) : String(e.value);
  }
  return { label, value };
}

// ---------------------------------------------------------------------------------------------
// Where an action goes

/** The address a card action opens, for the open app and its platform scope. Only Kiln's own pages: the target is data from the server, never a URL. */
export function actionHref(
  id: string,
  action: { code: string; target: InsightTarget },
  platform: PlatformScope | null = null,
): string {
  const { target } = action;
  const base = appAddress(id, target.section, platform);
  const params = new URLSearchParams();
  const at = base.indexOf('?');
  const path = at < 0 ? base : base.slice(0, at);
  if (at >= 0) for (const [k, v] of new URLSearchParams(base.slice(at + 1))) params.set(k, v);
  // A keyword card opens the rank view of Keywords (it names no single keyword in the address).
  const view =
    target.section === 'insights' && target.view === 'keywords' && target.term
      ? 'rank'
      : target.view;
  if (view && view !== 'overview') params.set('view', view);
  // `addLocale` names a language the page does not have yet: there is no locale to open.
  if (target.locale && action.code !== 'addLocale') params.set('locale', target.locale);
  // Opening the checks of a locale is a deliberate deep link: it also opens that locale's panel (`?panel=`, see lib/app-header.ts).
  if (target.locale && action.code === 'openChecks' && target.section === 'listing')
    params.set('panel', target.locale);
  const text = params.toString();
  return text === '' ? path : `${path}?${text}`;
}

// ---------------------------------------------------------------------------------------------
// Why a rule had no data

const RULE_ORDER = [
  'visibility',
  'conversion',
  'downloads',
  'featured',
  'localize',
  'complaints',
  'version_rating',
  'keywords',
  'listing',
];

const RULE_NAME: Record<string, string> = {
  visibility: k('insights:skip.visibility'),
  conversion: k('insights:skip.conversion'),
  downloads: k('insights:skip.downloads'),
  featured: k('insights:skip.featured'),
  localize: k('insights:skip.localize'),
  complaints: k('insights:skip.complaints'),
  version_rating: k('insights:skip.versionRating'),
  keywords: k('insights:skip.keywords'),
  listing: k('insights:skip.listing'),
};
const REASON_TEXT: Record<string, string> = {
  no_data: k('insights:reason.noData'),
  too_little_data: k('insights:reason.tooLittleData'),
  no_countries: k('insights:reason.noCountries'),
  no_listing: k('insights:reason.noListing'),
  no_reviews: k('insights:reason.noReviews'),
  no_keywords: k('insights:reason.noKeywords'),
  not_for_store: k('insights:reason.notForStore'),
  no_access: k('insights:reason.noAccess'),
};

export type SkipNote = { rule: string; reason: string; text: string };

/** The rules that did not run, one line each, in the order of the rules: what they need (`insights:skip.<rule>`) and why they had none (`insights:reason.<reason>`). */
export function skipNotes(skipped: readonly SkippedRule[]): SkipNote[] {
  const seen = new Set<string>();
  const out: SkipNote[] = [];
  for (const s of skipped) {
    if (seen.has(s.rule)) continue;
    seen.add(s.rule);
    out.push({
      rule: s.rule,
      reason: s.reason,
      text: t('insights:skip.line', {
        rule: t(RULE_NAME[s.rule] ?? k('insights:skip.other')),
        reason: t(REASON_TEXT[s.reason] ?? k('insights:reason.other')),
      }),
    });
  }
  const at = (rule: string) =>
    RULE_ORDER.indexOf(rule) < 0 ? RULE_ORDER.length : RULE_ORDER.indexOf(rule);
  return out.sort((a, b) => at(a.rule) - at(b.rule));
}

/** What to say when there are no cards at all: nothing happened (every rule ran) or nothing could be judged (some did not). */
export function emptyKind(
  view: Pick<InsightsView, 'cards' | 'skipped' | 'hiddenCount'>,
): 'none' | 'quiet' | 'hidden' | 'nodata' {
  if (view.cards.length > 0) return 'none';
  if (view.hiddenCount > 0) return 'hidden';
  return view.skipped.length === 0 ? 'quiet' : 'nodata';
}

// ---------------------------------------------------------------------------------------------
// Store page checks

const CHECK_ORDER: readonly CheckSeverity[] = ['problem', 'warning', 'tip'];

export const sortIssues = (issues: readonly CheckIssue[]): CheckIssue[] =>
  issues
    .map((issue, i) => ({ issue, i }))
    .sort(
      (a, b) =>
        CHECK_ORDER.indexOf(a.issue.severity) - CHECK_ORDER.indexOf(b.issue.severity) || a.i - b.i,
    )
    .map((x) => x.issue);

export const CHECK_TONE: Record<CheckSeverity, 'bad' | 'warn' | 'info'> = {
  problem: 'bad',
  warning: 'warn',
  tip: 'info',
};
export const CHECK_ICON: Record<CheckSeverity, IconName> = {
  problem: 'x-circle',
  warning: 'alert-triangle',
  tip: 'info',
};

/** Weakest locales first (lowest score), then by name, so the first row is where to start. */
export const localesByScore = (locales: readonly LocaleChecks[]): LocaleChecks[] =>
  [...locales].sort((a, b) => a.score - b.score || a.locale.localeCompare(b.locale));

export type ScoreBand = 'good' | 'fair' | 'poor';
export const scoreBand = (score: number): ScoreBand =>
  score >= 85 ? 'good' : score >= 60 ? 'fair' : 'poor';
export const SCORE_TONE: Record<ScoreBand, 'ok' | 'warn' | 'bad'> = {
  good: 'ok',
  fair: 'warn',
  poor: 'bad',
};

const FIELD_NAME: Record<string, string> = {
  name: k('insights:field.name'),
  subtitle: k('insights:field.subtitle'),
  keywords: k('insights:field.keywords'),
  description: k('insights:field.description'),
  promotional_text: k('insights:field.promotionalText'),
  title: k('insights:field.title'),
  short_description: k('insights:field.shortDescription'),
  full_description: k('insights:field.fullDescription'),
};

/** The store's field id as a name a person knows; an id this app has no name for is shown as it is. */
export function fieldName(field: string): string {
  const key = FIELD_NAME[field];
  return key ? t(key) : field;
}

const UNIT_NAME: Record<string, string> = {
  characters: k('insights:unit.characters'),
  bytes: k('insights:unit.bytes'),
};

/** Words of a finding: its numbers written for the language, the unit and the fields by name. */
export function issueParams(
  issue: Pick<CheckIssue, 'params' | 'field'>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, v] of Object.entries(issue.params)) {
    if (typeof v === 'number') out[key] = formatNumber(v);
    else if (key === 'unit') out[key] = UNIT_NAME[v] ? t(UNIT_NAME[v]) : v;
    else if (key === 'fields') out[key] = formatList(v.split(',').map((f) => fieldName(f.trim())));
    else out[key] = v;
  }
  out.field = issue.field ? fieldName(issue.field) : '';
  return out;
}

const CHECK_TEXT: Record<string, Sentence> = {
  empty: { headline: k('insights:check.empty.title'), explain: k('insights:check.empty.explain') },
  too_long: {
    headline: k('insights:check.tooLong.title'),
    explain: k('insights:check.tooLong.explain'),
  },
  keywords_spaces: {
    headline: k('insights:check.keywordsSpaces.title'),
    explain: k('insights:check.keywordsSpaces.explain'),
  },
  keywords_duplicate: {
    headline: k('insights:check.keywordsDuplicate.title'),
    explain: k('insights:check.keywordsDuplicate.explain'),
  },
  keywords_in_title: {
    headline: k('insights:check.keywordsInTitle.title'),
    explain: k('insights:check.keywordsInTitle.explain'),
  },
  keywords_underused: {
    headline: k('insights:check.keywordsUnderused.title'),
    explain: k('insights:check.keywordsUnderused.explain'),
  },
  subtitle_repeats_name: {
    headline: k('insights:check.subtitleRepeatsName.title'),
    explain: k('insights:check.subtitleRepeatsName.explain'),
  },
  subtitle_missing: {
    headline: k('insights:check.subtitleMissing.title'),
    explain: k('insights:check.subtitleMissing.explain'),
  },
  underused: {
    headline: k('insights:check.underused.title'),
    explain: k('insights:check.underused.explain'),
  },
  untranslated: {
    headline: k('insights:check.untranslated.title'),
    explain: k('insights:check.untranslated.explain'),
  },
  no_screenshots: {
    headline: k('insights:check.noScreenshots.title'),
    explain: k('insights:check.noScreenshots.explain'),
  },
  promo_missing: {
    headline: k('insights:check.promoMissing.title'),
    explain: k('insights:check.promoMissing.explain'),
  },
};
const UNKNOWN_CHECK: Sentence = {
  headline: k('insights:check.unknown.title'),
  explain: k('insights:check.unknown.explain'),
};

export const issueText = (
  issue: Pick<CheckIssue, 'code' | 'params' | 'field'>,
): { title: string; explain: string } => {
  const text = CHECK_TEXT[issue.code] ?? UNKNOWN_CHECK;
  const params = issueParams(issue);
  return { title: t(text.headline, params), explain: t(text.explain, params) };
};

/** The issues of one severity in a locale, counted for the summary line. */
export function countBySeverity(locales: readonly LocaleChecks[]): Record<CheckSeverity, number> {
  const out: Record<CheckSeverity, number> = { problem: 0, warning: 0, tip: 0 };
  for (const l of locales) for (const i of l.issues) out[i.severity] += 1;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Language coverage of the countries

export type LanguageBar = {
  language: string;
  count: number;
  share: number;
  /** The bar's length, 0..100, relative to the biggest language. */
  width: number;
  coveredBy: string | null;
  countries: CoverageCountry[];
};

/** The bars, biggest first: the length is relative to the biggest language, so the first bar is full. */
export function languageBars(languages: readonly CoverageLanguage[]): LanguageBar[] {
  const max = languages.reduce((m, l) => Math.max(m, l.count), 0);
  return languages.map((l) => ({
    language: l.language,
    count: l.count,
    share: l.share,
    width: max > 0 ? Math.max(2, Math.round((l.count / max) * 100)) : 0,
    coveredBy: l.coveredBy,
    countries: l.countries,
  }));
}

/** Only the bars worth drawing: the biggest `limit` languages; the rest are said in one line. */
export function topBars(
  bars: readonly LanguageBar[],
  limit = 12,
): { shown: LanguageBar[]; hidden: number } {
  return { shown: bars.slice(0, limit), hidden: Math.max(0, bars.length - limit) };
}

/** The share of downloads in countries whose language the page does not cover, as the person reads it. */
export const uncoveredText = (coverage: Pick<LanguageCoverage, 'uncoveredShare'>): string =>
  formatPercent(coverage.uncoveredShare, { maximumFractionDigits: 0 });

export const countryText = (code: string): string => {
  const name = formatDisplayName(code, 'region');
  return name && name !== code.toUpperCase() ? name : code.toUpperCase();
};

/** The reason there is no table, in words. */
export const unavailableText = (reason: NonNullable<CountriesView['unavailable']>): string =>
  t(
    reason === 'no_countries'
      ? k('insights:countries.unavailable.noCountries')
      : reason === 'no_listing'
        ? k('insights:countries.unavailable.noListing')
        : k('insights:countries.unavailable.noAccess'),
  );
