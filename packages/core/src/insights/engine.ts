// Adapted from Open Screenshot Generator (MIT), see THIRD_PARTY_NOTICES.md
//
// The cards of the Insights overview: what changed, what is wrong, what to do. Every rule is a pure function of numbers Kiln already stores
// (analytics days, countries, reviews, keyword ranks, the live store page); no AI, no network, the same answer for the same data. A rule fires
// only on enough volume to mean something (a 40% jump from 10 views to 14 is noise) and the rate rule only when a significance test agrees. A
// rule whose data is absent is not run and is reported in `skipped` with the reason, so the screen can say what it could not look at.
//
// A card has a stable `id` (the rule and its subject) and a `fingerprint` (the finding: direction, size band, the items in it). A card that a
// person dismissed stays hidden until its fingerprint changes. Text is not built here: `code` and `params` name the sentence, the interface
// puts it in the person's language.

import { isBigMove, type RankChange } from '../aso/aso.ts';
import type { ListingStore } from '../listing/listing.ts';
import { type CountryCount, languageCoverage } from './language-coverage.ts';
import { type CheckLocaleText, checkListing } from './listing-checks.ts';
import { complaintThemes, type ReviewTheme } from './review-themes.ts';

export const INSIGHT_CATEGORIES = [
  'visibility',
  'conversion',
  'downloads',
  'markets',
  'reviews',
  'keywords',
  'listing',
] as const;
export type InsightCategory = (typeof INSIGHT_CATEGORIES)[number];
export type InsightSeverity = 'problem' | 'warning' | 'good' | 'info';

/** A place in Kiln: the page, its view and what to open there. The web turns it into an address. */
export type InsightTarget = {
  section: 'insights' | 'listing' | 'reviews';
  view?: string;
  locale?: string;
  country?: string;
  term?: string;
};

export type InsightEvidence = {
  key: string;
  value: number | string;
  format: 'count' | 'percent' | 'rating' | 'rank' | 'text' | 'day';
};

export type InsightCard = {
  id: string;
  fingerprint: string;
  category: InsightCategory;
  severity: InsightSeverity;
  /** The sentence: `insights:card.<code>.headline` and `.explain`; `params` fill both. */
  code: string;
  params: Record<string, string | number>;
  evidence: InsightEvidence[];
  /** One or two places to go, in the order of use; `code` names the button text `insights:action.<code>`. */
  actions: { code: string; target: InsightTarget }[];
  /** For ordering inside a severity, 0..100. */
  weight: number;
};

export type InsightRule =
  | 'visibility'
  | 'conversion'
  | 'downloads'
  | 'featured'
  | 'localize'
  | 'complaints'
  | 'version_rating'
  | 'keywords'
  | 'listing';
export type SkipReason =
  | 'no_data'
  | 'too_little_data'
  | 'no_countries'
  | 'no_listing'
  | 'no_reviews'
  | 'no_keywords'
  | 'not_for_store'
  | 'no_access';

export type DayValue = { day: string; value: number };
export type InsightReview = { rating: number; text: string; day: string; version: string | null };
export type InsightKeyword = {
  term: string;
  country: string;
  rank: number | null;
  change: RankChange | null;
};

export type InsightsInput = {
  store: ListingStore;
  /** `YYYY-MM-DD`: the last day the windows may end on. */
  today: string;
  /** Times the app was seen (App Store impressions) or the store page visited (Google Play visitors), per day. */
  seen?: readonly DayValue[] | null;
  /** New downloads that came from those (App Store first-time downloads, Google Play listing acquisitions), per day. */
  acquired?: readonly DayValue[] | null;
  /** All new downloads, per day (App Store first-time downloads, Google Play installs by user). */
  downloads?: readonly DayValue[] | null;
  /** Times seen while browsing the App Store (Today, Games, Apps, charts), per day. App Store only. */
  browse?: readonly DayValue[] | null;
  /** Downloads per country over the last 28 days, and the languages the live store page is in. */
  countries?: readonly CountryCount[] | null;
  storeLocales?: readonly string[] | null;
  reviews?: readonly InsightReview[] | null;
  keywords?: readonly InsightKeyword[] | null;
  /** The live store page text; null when it was never read. */
  listing?: { locales: readonly CheckLocaleText[]; baseLocale?: string | undefined } | null;
  /** Places a rank move must reach to count (default 5). */
  rankThreshold?: number;
};

export type InsightsResult = {
  cards: InsightCard[];
  skipped: { rule: InsightRule; reason: SkipReason }[];
};

// ---------------------------------------------------------------------------------------------
// helpers

const DAY_MS = 86_400_000;
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const addDays = (day: string, n: number) =>
  new Date(dayMs(day) + n * DAY_MS).toISOString().slice(0, 10);

type Window = { from: string; to: string };
const sumIn = (series: readonly DayValue[], w: Window): { total: number; days: number } => {
  let total = 0;
  const seen = new Set<string>();
  for (const p of series) {
    if (p.day >= w.from && p.day <= w.to && Number.isFinite(p.value)) {
      total += p.value;
      seen.add(p.day);
    }
  }
  return { total, days: seen.size };
};

/** The two 14 day windows that end on the newest day with data (not after `today`). Null when the series has no day. */
function windows(
  series: readonly DayValue[],
  today: string,
): { current: Window; previous: Window } | null {
  let end: string | null = null;
  for (const p of series) if (p.day <= today && (end === null || p.day > end)) end = p.day;
  if (end === null) return null;
  return {
    current: { from: addDays(end, -13), to: end },
    previous: { from: addDays(end, -27), to: addDays(end, -14) },
  };
}

const MIN_DAYS = 10;
const band = (value: number, step: number) => Math.round(value / step) * step;
const pct = (ratio: number) => Math.round(ratio * 100);

/** Two proportions compared with a pooled z test; true at roughly 95% confidence. */
export function rateDiffers(
  aHits: number,
  aTrials: number,
  bHits: number,
  bTrials: number,
): boolean {
  if (aTrials <= 0 || bTrials <= 0) return false;
  const pooled = (aHits + bHits) / (aTrials + bTrials);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / aTrials + 1 / bTrials));
  if (se === 0) return false;
  return Math.abs(aHits / aTrials - bHits / bTrials) / se >= 1.96;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

/** Compares `1.10.0` with `1.9.2` by numbers, part by part. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split('.').map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// rules

type Ctx = { input: InsightsInput; cards: InsightCard[]; skipped: InsightsResult['skipped'] };
const skip = (ctx: Ctx, rule: InsightRule, reason: SkipReason) =>
  ctx.skipped.push({ rule, reason });

const MIN_SEEN = 500;
const MIN_DOWNLOADS = 50;

function visibility(ctx: Ctx) {
  const { seen, store, today } = ctx.input;
  if (!seen || seen.length === 0) {
    skip(ctx, 'visibility', 'no_data');
    return;
  }
  const w = windows(seen, today);
  const cur = w && sumIn(seen, w.current);
  const prev = w && sumIn(seen, w.previous);
  if (!w || !cur || !prev || cur.days < MIN_DAYS || prev.days < MIN_DAYS || prev.total < MIN_SEEN) {
    skip(ctx, 'visibility', 'too_little_data');
    return;
  }
  const change = cur.total / prev.total - 1;
  if (Math.abs(change) < 0.25) return;
  const up = change > 0;
  const unit = store === 'google_play' ? 'visits' : 'seen';
  ctx.cards.push({
    id: 'visibility',
    fingerprint: `${up ? 'up' : 'down'}:${band(pct(Math.abs(change)), 10)}`,
    category: 'visibility',
    severity: up ? 'good' : 'warning',
    code: `visibility.${up ? 'up' : 'down'}.${unit}`,
    params: { percent: pct(Math.abs(change)), current: cur.total, previous: prev.total },
    evidence: [
      { key: 'current', value: cur.total, format: 'count' },
      { key: 'previous', value: prev.total, format: 'count' },
    ],
    actions: [
      {
        code: up ? 'openOverview' : 'openKeywords',
        target: { section: 'insights', view: up ? 'overview' : 'keywords' },
      },
    ],
    weight: Math.min(90, 35 + Math.round(Math.abs(change) * 60)),
  });
}

function conversion(ctx: Ctx) {
  const { seen, acquired, today } = ctx.input;
  if (!seen || !acquired || seen.length === 0 || acquired.length === 0) {
    skip(ctx, 'conversion', 'no_data');
    return;
  }
  const w = windows(seen, today);
  if (!w) {
    skip(ctx, 'conversion', 'no_data');
    return;
  }
  const s = { cur: sumIn(seen, w.current), prev: sumIn(seen, w.previous) };
  const a = { cur: sumIn(acquired, w.current), prev: sumIn(acquired, w.previous) };
  if (
    s.cur.days < MIN_DAYS ||
    s.prev.days < MIN_DAYS ||
    s.cur.total < 1000 ||
    s.prev.total < 1000 ||
    a.prev.total < 20
  ) {
    skip(ctx, 'conversion', 'too_little_data');
    return;
  }
  const now = a.cur.total / s.cur.total;
  const before = a.prev.total / s.prev.total;
  const change = now / before - 1;
  if (Math.abs(change) < 0.1 || !rateDiffers(a.cur.total, s.cur.total, a.prev.total, s.prev.total))
    return;
  const up = change > 0;
  ctx.cards.push({
    id: 'conversion',
    fingerprint: `${up ? 'up' : 'down'}:${band(pct(Math.abs(change)), 10)}`,
    category: 'conversion',
    severity: up ? 'good' : 'problem',
    code: `conversion.${up ? 'up' : 'down'}`,
    params: { now: Math.round(now * 1000) / 10, before: Math.round(before * 1000) / 10 },
    evidence: [
      { key: 'rateNow', value: now, format: 'percent' },
      { key: 'ratePrevious', value: before, format: 'percent' },
    ],
    actions: [
      { code: 'openGraphics', target: { section: 'listing', view: 'graphics' } },
      { code: 'openText', target: { section: 'listing', view: 'text' } },
    ],
    weight: up ? 60 : 88,
  });
}

function downloads(ctx: Ctx) {
  const { downloads: series, today } = ctx.input;
  if (!series || series.length === 0) {
    skip(ctx, 'downloads', 'no_data');
    return;
  }
  const w = windows(series, today);
  const cur = w && sumIn(series, w.current);
  const prev = w && sumIn(series, w.previous);
  if (
    !w ||
    !cur ||
    !prev ||
    cur.days < MIN_DAYS ||
    prev.days < MIN_DAYS ||
    prev.total < MIN_DOWNLOADS
  ) {
    skip(ctx, 'downloads', 'too_little_data');
    return;
  }
  const change = cur.total / prev.total - 1;
  if (Math.abs(change) < 0.2) return;
  const up = change > 0;
  ctx.cards.push({
    id: 'downloads',
    fingerprint: `${up ? 'up' : 'down'}:${band(pct(Math.abs(change)), 10)}`,
    category: 'downloads',
    severity: up ? 'good' : 'warning',
    code: `downloads.${up ? 'up' : 'down'}`,
    params: { percent: pct(Math.abs(change)), current: cur.total, previous: prev.total },
    evidence: [
      { key: 'current', value: cur.total, format: 'count' },
      { key: 'previous', value: prev.total, format: 'count' },
    ],
    actions: [{ code: 'openOverview', target: { section: 'insights', view: 'overview' } }],
    weight: Math.min(88, 35 + Math.round(Math.abs(change) * 55)),
  });
}

/** A day of browse views far above the usual is what a feature placement in the App Store looks like. */
function featured(ctx: Ctx) {
  const { browse, store, today } = ctx.input;
  if (store !== 'app_store') {
    skip(ctx, 'featured', 'not_for_store');
    return;
  }
  if (!browse || browse.length === 0) {
    skip(ctx, 'featured', 'no_data');
    return;
  }
  const recent = browse.filter((p) => p.day <= today).sort((a, b) => a.day.localeCompare(b.day));
  const last = recent[recent.length - 1];
  if (!last) {
    skip(ctx, 'featured', 'no_data');
    return;
  }
  const baseline = recent
    .filter((p) => p.day <= addDays(last.day, -10) && p.day >= addDays(last.day, -38))
    .map((p) => p.value);
  if (baseline.length < 21) {
    skip(ctx, 'featured', 'too_little_data');
    return;
  }
  const usual = median(baseline);
  let spike: DayValue | null = null;
  for (const p of recent) {
    if (p.day <= addDays(last.day, -10)) continue;
    if (p.value >= Math.max(3 * usual, usual + 200) && (!spike || p.value > spike.value)) spike = p;
  }
  if (!spike) return;
  ctx.cards.push({
    id: 'featured',
    fingerprint: spike.day,
    category: 'visibility',
    severity: 'good',
    code: 'featured.spike',
    params: {
      day: spike.day,
      count: spike.value,
      times: Math.max(1, Math.round(spike.value / Math.max(1, usual))),
    },
    evidence: [
      { key: 'browseDay', value: spike.value, format: 'count' },
      { key: 'browseUsual', value: Math.round(usual), format: 'count' },
      { key: 'day', value: spike.day, format: 'day' },
    ],
    actions: [{ code: 'openOverview', target: { section: 'insights', view: 'overview' } }],
    weight: 80,
  });
}

/** Downloads from countries whose main language the live store page does not cover. */
function localize(ctx: Ctx) {
  const { countries, storeLocales, store } = ctx.input;
  if (!countries || countries.length === 0) {
    skip(ctx, 'localize', 'no_countries');
    return;
  }
  if (!storeLocales || storeLocales.length === 0) {
    skip(ctx, 'localize', 'no_listing');
    return;
  }
  const cov = languageCoverage({ countries, storeLocales, store });
  if (cov.total < 150) {
    skip(ctx, 'localize', 'too_little_data');
    return;
  }
  for (const lang of cov.languages
    .filter((l) => l.coveredBy === null && l.share >= 0.04 && l.count >= 15)
    .slice(0, 3)) {
    const share = pct(lang.share);
    ctx.cards.push({
      id: `localize:${lang.language}`,
      fingerprint: `${lang.language}:${band(share, 5)}`,
      category: 'markets',
      severity: 'warning',
      code: 'localize',
      params: {
        percent: share,
        language: lang.language,
        countries: lang.countries
          .slice(0, 3)
          .map((c) => c.country)
          .join(','),
      },
      evidence: [
        { key: 'share', value: lang.share, format: 'percent' },
        { key: 'downloads', value: lang.count, format: 'count' },
      ],
      actions: [
        { code: 'openCountries', target: { section: 'insights', view: 'countries' } },
        { code: 'addLocale', target: { section: 'listing', view: 'text', locale: lang.language } },
      ],
      weight: Math.min(92, 55 + Math.round(lang.share * 150)),
    });
  }
}

const COMPLAINT_DAYS = 30;
const THEME_MIN = 3;

function complaints(ctx: Ctx) {
  const { reviews, today } = ctx.input;
  if (!reviews || reviews.length === 0) {
    skip(ctx, 'complaints', 'no_reviews');
    return;
  }
  const from = addDays(today, -(COMPLAINT_DAYS - 1));
  const recent = reviews.filter((r) => r.day >= from && r.day <= today);
  const { complaints: n, themes } = complaintThemes(recent);
  if (n < THEME_MIN) {
    skip(ctx, 'complaints', 'too_little_data');
    return;
  }
  for (const { theme, count } of themes.filter((t) => t.count >= THEME_MIN).slice(0, 3)) {
    ctx.cards.push({
      id: `complaints:${theme}`,
      fingerprint: `${theme}:${count >= 20 ? 20 : count >= 10 ? 10 : count >= 5 ? 5 : 3}`,
      category: 'reviews',
      severity: count >= 10 ? 'problem' : 'warning',
      code: `complaints.${theme satisfies ReviewTheme}`,
      params: { count, total: n, days: COMPLAINT_DAYS },
      evidence: [
        { key: 'mentions', value: count, format: 'count' },
        { key: 'complaints', value: n, format: 'count' },
      ],
      actions: [{ code: 'openReviews', target: { section: 'reviews', view: 'reviews' } }],
      weight: Math.min(90, 50 + count * 3),
    });
  }
}

const VERSION_MIN_REVIEWS = 8;

function versionRating(ctx: Ctx) {
  const { reviews } = ctx.input;
  if (!reviews || reviews.length === 0) {
    skip(ctx, 'version_rating', 'no_reviews');
    return;
  }
  const groups = new Map<string, number[]>();
  for (const r of reviews) {
    if (!r.version || !(r.rating >= 1 && r.rating <= 5)) continue;
    const list = groups.get(r.version) ?? [];
    list.push(r.rating);
    groups.set(r.version, list);
  }
  const versions = Array.from(groups.keys())
    .filter((v) => (groups.get(v) as number[]).length >= VERSION_MIN_REVIEWS)
    .sort((a, b) => compareVersions(b, a));
  const [now, before] = versions;
  if (!now || !before) {
    skip(ctx, 'version_rating', 'too_little_data');
    return;
  }
  const avg = (v: string) => {
    const l = groups.get(v) as number[];
    return l.reduce((s, x) => s + x, 0) / l.length;
  };
  const drop = avg(before) - avg(now);
  if (drop < 0.5) return;
  const a = Math.round(avg(now) * 10) / 10;
  const b = Math.round(avg(before) * 10) / 10;
  ctx.cards.push({
    id: 'version_rating',
    fingerprint: `${now}:${before}:${band(Math.round(drop * 10), 5)}`,
    category: 'reviews',
    severity: 'problem',
    code: 'version_rating.drop',
    params: { version: now, previous: before, now: a, before: b },
    evidence: [
      { key: 'ratingNow', value: a, format: 'rating' },
      { key: 'ratingPrevious', value: b, format: 'rating' },
    ],
    actions: [{ code: 'openReviews', target: { section: 'reviews', view: 'reviews' } }],
    weight: 90,
  });
}

function keywords(ctx: Ctx) {
  const { keywords: list, rankThreshold } = ctx.input;
  if (!list || list.length === 0) {
    skip(ctx, 'keywords', 'no_keywords');
    return;
  }
  const moves = list.filter((k) => k.change && isBigMove(k.change, rankThreshold ?? 5));
  const gain = (k: InsightKeyword) =>
    k.change?.kind === 'entered'
      ? 1000
      : k.change?.kind === 'dropped'
        ? -1000
        : (k.change?.delta ?? 0);
  for (const dir of ['down', 'up'] as const) {
    const side = moves
      .filter((k) => (dir === 'up' ? gain(k) > 0 : gain(k) < 0))
      .sort((a, b) => Math.abs(gain(b)) - Math.abs(gain(a)));
    if (side.length === 0) continue;
    const top = side[0] as InsightKeyword;
    ctx.cards.push({
      id: `keywords:${dir}`,
      fingerprint: side
        .map((k) => `${k.term}@${k.country}:${k.rank ?? '-'}`)
        .sort()
        .join('|'),
      category: 'keywords',
      severity: dir === 'up' ? 'good' : 'warning',
      code: `keywords.${dir}`,
      params: {
        count: side.length,
        term: top.term,
        country: top.country.toUpperCase(),
        from: top.change?.from ?? 0,
        to: top.change?.to ?? 0,
      },
      evidence: side.slice(0, 3).map((k) => ({
        key: `${k.term} (${k.country.toUpperCase()})`,
        value: k.rank ?? 0,
        format: 'rank' as const,
      })),
      actions: [
        {
          code: 'openRank',
          target: { section: 'insights', view: 'keywords', term: top.term, country: top.country },
        },
      ],
      weight: dir === 'down' ? 70 : 55,
    });
  }
}

function listing(ctx: Ctx) {
  const { listing: page, store } = ctx.input;
  if (!page || page.locales.length === 0) {
    skip(ctx, 'listing', 'no_listing');
    return;
  }
  const out = checkListing({ store, locales: page.locales, baseLocale: page.baseLocale });
  const problems = out.locales.flatMap((l) =>
    l.issues.filter((i) => i.severity !== 'tip').map((i) => ({ ...i, locale: l.locale })),
  );
  if (problems.length === 0) return;
  const worst = [...out.locales].sort((a, b) => a.score - b.score)[0] as {
    locale: string;
    score: number;
  };
  // The headline counts what must be fixed; advice is counted apart. Only a real problem makes the card red.
  const hard = out.counts.problems;
  const soft = out.counts.warnings;
  ctx.cards.push({
    id: 'listing',
    fingerprint: problems
      .map((i) => i.id)
      .sort()
      .join('|'),
    category: 'listing',
    severity: hard > 0 ? 'problem' : 'warning',
    code: hard > 0 ? 'listing.issues' : 'listing.review',
    params: {
      count: hard > 0 ? hard : soft,
      problems: hard,
      warnings: soft,
      score: out.score,
      locale: worst.locale,
    },
    evidence: [
      { key: 'score', value: out.score, format: 'count' },
      { key: 'issues', value: hard, format: 'count' },
      { key: 'warnings', value: soft, format: 'count' },
    ],
    actions: [
      { code: 'openChecks', target: { section: 'listing', view: 'text', locale: worst.locale } },
    ],
    weight: hard > 0 ? 75 : 50,
  });
}

const SEVERITY_ORDER: Record<InsightSeverity, number> = {
  problem: 0,
  warning: 1,
  good: 2,
  info: 3,
};

/** Runs every rule. Cards come sorted: problems first, then by weight. */
export function buildInsights(input: InsightsInput): InsightsResult {
  const ctx: Ctx = { input, cards: [], skipped: [] };
  for (const rule of [
    visibility,
    conversion,
    downloads,
    featured,
    localize,
    complaints,
    versionRating,
    keywords,
    listing,
  ])
    rule(ctx);
  ctx.cards.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      b.weight - a.weight ||
      a.id.localeCompare(b.id),
  );
  return { cards: ctx.cards, skipped: ctx.skipped };
}

/** The cards a person has not dismissed: a dismissal holds while the card's fingerprint is the one that was dismissed. */
export function applyDismissals(
  cards: readonly InsightCard[],
  dismissed: ReadonlyMap<string, string> | Record<string, string>,
): { visible: InsightCard[]; hidden: InsightCard[] } {
  const get = (id: string) =>
    dismissed instanceof Map ? dismissed.get(id) : (dismissed as Record<string, string>)[id];
  const visible: InsightCard[] = [];
  const hidden: InsightCard[] = [];
  for (const card of cards) (get(card.id) === card.fingerprint ? hidden : visible).push(card);
  return { visible, hidden };
}

/** How many visible cards each category has, in the order of `INSIGHT_CATEGORIES`, for the filter chips and the badge. */
export function categoryCounts(cards: readonly InsightCard[]): Record<InsightCategory, number> {
  const out = {} as Record<InsightCategory, number>;
  for (const c of INSIGHT_CATEGORIES) out[c] = 0;
  for (const card of cards) out[card.category] += 1;
  return out;
}
