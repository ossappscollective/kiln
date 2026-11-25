import {
  type Action,
  applyDismissals,
  buildInsights,
  type CheckLocaleText,
  COUNTRY_CODES,
  type CountryCount,
  type CoverageLanguage,
  can,
  categoryCounts,
  checkListing,
  type DayValue,
  type InsightCard,
  type InsightKeyword,
  type InsightReview,
  type InsightsResult,
  type ListingStore,
  languageCoverage,
  languageKey,
  normalizeCountryCode,
  type Role,
} from '@kiln/core';
import type { Sql } from '@kiln/db';
import type { ManagedApp } from '../../services/apps.ts';
import { rankMoveThresholdFor } from '../../services/workspace-settings.ts';
import { readDaily } from '../analytics/store.ts';
import { listKeywords } from '../aso/service.ts';
import { getLiveListing } from '../listing/live.ts';
import { listReviews } from '../reviews/service.ts';

/**
 * Insights (docs/adr/0051-insights.md): the cards are computed on read from what Kiln stores (analytics days, reviews, keyword ranks, the live
 * store page) by the pure engine in `@kiln/core`; only the dismissals are stored (`insight_dismissals`). A role sees only the rules whose data it may read.
 */

const DAY = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const storeOf = (app: ManagedApp): ListingStore =>
  app.platform === 'android' ? 'google_play' : 'app_store';

/** The two letter code of a country as an Apple report may write it: a code, or an English name. Null for text that is neither. */
let namesToCodes: Map<string, string> | null = null;
export function countryCodeOf(raw: string): string | null {
  const code = normalizeCountryCode(raw);
  if (code) return code;
  if (!namesToCodes) {
    namesToCodes = new Map();
    try {
      const names = new Intl.DisplayNames(['en'], { type: 'region' });
      for (const c of COUNTRY_CODES) {
        const name = names.of(c);
        if (name) namesToCodes.set(name.toLowerCase(), c);
      }
    } catch {
      // Without region names only two letter codes are read.
    }
    for (const [name, c] of Object.entries({
      'south korea': 'KR',
      'korea, republic of': 'KR',
      turkey: 'TR',
      czechia: 'CZ',
      'united states of america': 'US',
      'hong kong': 'HK',
      'taiwan, province of china': 'TW',
      'russian federation': 'RU',
      'viet nam': 'VN',
    })) {
      namesToCodes.set(name, c);
    }
  }
  return namesToCodes.get(raw.trim().toLowerCase()) ?? null;
}

type Daily = Awaited<ReturnType<typeof readDaily>>;
const perDay = (
  rows: Daily,
  metric: string,
  accept?: (dimValue: string) => boolean,
): DayValue[] => {
  const sums = new Map<string, number>();
  for (const r of rows)
    if (r.metric === metric && (!accept || accept(r.dimValue)))
      sums.set(r.day, (sums.get(r.day) ?? 0) + r.value);
  return Array.from(sums, ([day, value]) => ({ day, value })).sort((a, b) =>
    a.day.localeCompare(b.day),
  );
};
const orNull = (list: DayValue[]) => (list.length > 0 ? list : null);

export type InsightsInputs = Parameters<typeof buildInsights>[0];

/** Reads what the rules need. A source the role may not read, or that holds nothing, is null (the engine skips the rule with a reason). */
export async function collectInputs(
  sql: Sql,
  ctx: { workspaceId: string; app: ManagedApp; role: Role; now: number },
): Promise<{
  input: InsightsInputs;
  noAccess: ('complaints' | 'version_rating' | 'keywords' | 'listing')[];
}> {
  const { app, workspaceId } = ctx;
  const store = storeOf(app);
  const today = dayOf(ctx.now);
  const base = { workspaceId, appId: app.id, platform: app.platform };
  const allowed = (action: Action) => can(ctx.role, action);
  const noAccess: ('complaints' | 'version_rating' | 'keywords' | 'listing')[] = [];

  const totals = await readDaily(sql, { ...base, from: dayOf(ctx.now - 56 * DAY), to: today });
  const apple = store === 'app_store';
  const input: InsightsInputs = {
    store,
    today,
    seen: orNull(perDay(totals, apple ? 'impressions' : 'store_listing_visitors')),
    acquired: orNull(perDay(totals, apple ? 'downloads_first_time' : 'store_listing_acquisitions')),
    downloads: orNull(perDay(totals, apple ? 'downloads_first_time' : 'installs_user')),
  };

  if (apple) {
    const bySource = await readDaily(sql, {
      ...base,
      from: dayOf(ctx.now - 49 * DAY),
      to: today,
      dimension: 'source_type',
    });
    input.browse = orNull(perDay(bySource, 'impressions', (v) => /browse/i.test(v)));
    const byTerritory = await readDaily(sql, {
      ...base,
      from: dayOf(ctx.now - 27 * DAY),
      to: today,
      dimension: 'territory',
    });
    const counts = new Map<string, number>();
    for (const r of byTerritory) {
      if (r.metric !== 'downloads_first_time') continue;
      const code = countryCodeOf(r.dimValue);
      if (code) counts.set(code, (counts.get(code) ?? 0) + r.value);
    }
    input.countries =
      counts.size > 0
        ? Array.from(counts, ([country, count]): CountryCount => ({ country, count }))
        : null;
  }

  if (allowed('reviews.read')) {
    const since = ctx.now - 90 * DAY;
    const out: InsightReview[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const res = await listReviews(
        sql,
        workspaceId,
        app.id,
        { since },
        { limit: 100, ...(cursor ? { cursor } : {}) },
      );
      if ('error' in res) break;
      for (const r of res.reviews)
        out.push({
          rating: r.rating,
          text: `${r.title ?? ''} ${r.body}`,
          day: dayOf(r.createdAt),
          version: r.appVersion,
        });
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    input.reviews = out;
  } else noAccess.push('complaints', 'version_rating');

  if (allowed('aso.read')) {
    const keywords = await listKeywords(sql, workspaceId, app.id);
    input.keywords = keywords.map(
      (k): InsightKeyword => ({ term: k.term, country: k.country, rank: k.rank, change: k.change }),
    );
    input.rankThreshold = await rankMoveThresholdFor(sql, workspaceId);
  } else noAccess.push('keywords');

  if (allowed('listing.read')) {
    const live = await getLiveListing(sql, workspaceId, {
      id: app.id,
      platform: app.platform,
      identifier: app.identifier,
    });
    const channel = live.channels.find((c) => c.channel === 'live');
    if (channel) {
      const media = channel.sections?.media;
      const locales: CheckLocaleText[] = Object.keys(channel.locales)
        .filter((l) => languageKey(l) !== null)
        .map((locale) => {
          const sets = media?.screenshots[locale];
          return {
            locale,
            fields: channel.locales[locale] ?? {},
            hasScreenshots: sets
              ? sets.reduce((n, s) => n + s.count, 0) > 0
              : media && !media.truncated
                ? false
                : null,
          };
        });
      input.storeLocales = locales.map((l) => l.locale);
      const baseLocale = channel.sections?.details?.defaultLanguage;
      input.listing = { locales, ...(baseLocale ? { baseLocale } : {}) };
    }
  } else noAccess.push('listing');
  return { input, noAccess };
}

export type DismissalRow = { cardId: string; fingerprint: string; dismissedAt: number };

export async function listDismissals(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<DismissalRow[]> {
  const rows = await sql.query(
    'SELECT card_id, fingerprint, dismissed_at FROM insight_dismissals WHERE workspace_id = ? AND app_id = ?',
    [workspaceId, appId],
  );
  return rows.map((r) => ({
    cardId: String(r.card_id),
    fingerprint: String(r.fingerprint),
    dismissedAt: Number(r.dismissed_at),
  }));
}

export type InsightsView = {
  appId: string;
  generatedAt: number;
  cards: InsightCard[];
  hiddenCount: number;
  counts: ReturnType<typeof categoryCounts>;
  skipped: InsightsResult['skipped'];
};

export async function insightsFor(
  sql: Sql,
  ctx: { workspaceId: string; app: ManagedApp; role: Role; now: number; includeHidden?: boolean },
): Promise<InsightsView> {
  const { input, noAccess } = await collectInputs(sql, ctx);
  const result = buildInsights(input);
  const dismissed = new Map(
    (await listDismissals(sql, ctx.workspaceId, ctx.app.id)).map((d) => [d.cardId, d.fingerprint]),
  );
  const { visible, hidden } = applyDismissals(result.cards, dismissed);
  const skipped = [
    ...result.skipped.filter((s) => (noAccess as string[]).indexOf(s.rule) < 0),
    ...noAccess.map((rule) => ({ rule, reason: 'no_access' as const })),
  ];
  return {
    appId: ctx.app.id,
    generatedAt: ctx.now,
    cards: ctx.includeHidden ? result.cards : visible,
    hiddenCount: hidden.length,
    counts: categoryCounts(visible),
    skipped,
  };
}

/** Just the number for the badge of the app navigation. */
export async function visibleCount(
  sql: Sql,
  ctx: { workspaceId: string; app: ManagedApp; role: Role; now: number },
): Promise<number> {
  const view = await insightsFor(sql, ctx);
  return view.cards.length;
}

/** Hides the card for as long as its fingerprint stays the one given; the card must be one of the current cards. */
export async function dismissCard(
  sql: Sql,
  ctx: {
    workspaceId: string;
    app: ManagedApp;
    role: Role;
    now: number;
    cardId: string;
    userId: string;
  },
): Promise<'ok' | 'not_found'> {
  const { input } = await collectInputs(sql, ctx);
  const card = buildInsights(input).cards.find((c) => c.id === ctx.cardId);
  if (!card) return 'not_found';
  await sql.execute('DELETE FROM insight_dismissals WHERE app_id = ? AND card_id = ?', [
    ctx.app.id,
    card.id,
  ]);
  await sql.execute(
    'INSERT INTO insight_dismissals (app_id, card_id, workspace_id, fingerprint, dismissed_at, dismissed_by) VALUES (?, ?, ?, ?, ?, ?)',
    [ctx.app.id, card.id, ctx.workspaceId, card.fingerprint, ctx.now, ctx.userId],
  );
  return 'ok';
}

/** Shows every dismissed card of the app again (or one); returns how many dismissals were removed. */
export async function restoreCards(
  sql: Sql,
  ctx: { workspaceId: string; appId: string; cardId?: string },
): Promise<number> {
  const rows = await listDismissals(sql, ctx.workspaceId, ctx.appId);
  const hit = rows.filter((r) => !ctx.cardId || r.cardId === ctx.cardId);
  for (const r of hit)
    await sql.execute('DELETE FROM insight_dismissals WHERE app_id = ? AND card_id = ?', [
      ctx.appId,
      r.cardId,
    ]);
  return hit.length;
}

export type CountriesView = {
  appId: string;
  store: ListingStore;
  /** Why there is no table, or null: `no_countries` (the store sends no downloads by country, or none stored), `no_listing` (the live page was never read). */
  unavailable: 'no_countries' | 'no_listing' | 'no_access' | null;
  storeLocales: string[];
  coverage: ReturnType<typeof languageCoverage> | null;
};

export async function countriesFor(
  sql: Sql,
  ctx: { workspaceId: string; app: ManagedApp; role: Role; now: number },
): Promise<CountriesView> {
  const { input } = await collectInputs(sql, ctx);
  const store = input.store;
  const storeLocales = input.storeLocales ? [...input.storeLocales] : [];
  const unavailable = !input.countries
    ? 'no_countries'
    : !input.storeLocales
      ? can(ctx.role, 'listing.read')
        ? 'no_listing'
        : 'no_access'
      : null;
  return {
    appId: ctx.app.id,
    store,
    unavailable,
    storeLocales,
    coverage: input.countries
      ? languageCoverage({ countries: input.countries, storeLocales, store })
      : null,
  };
}

export type ListingChecksView = {
  appId: string;
  store: ListingStore;
  /** Why there are no checks, or null: `no_listing` (the live page was never read). */
  unavailable: 'no_listing' | null;
  score: number | null;
  issueCount: number;
  /** Problems (to fix), warnings (to review) and tips, across every locale: the numbers the card and the locale panel both say. */
  counts: ReturnType<typeof checkListing>['counts'];
  locales: ReturnType<typeof checkListing>['locales'];
};

/** The checks of the live store page of the app, per locale (the same ones the `listing` card counts). Needs `listing.read`: the route checks. */
export async function listingChecksFor(
  sql: Sql,
  ctx: { workspaceId: string; app: ManagedApp; role: Role; now: number },
): Promise<ListingChecksView> {
  const { input } = await collectInputs(sql, ctx);
  const store = input.store;
  if (!input.listing)
    return {
      appId: ctx.app.id,
      store,
      unavailable: 'no_listing',
      score: null,
      issueCount: 0,
      counts: { problems: 0, warnings: 0, tips: 0 },
      locales: [],
    };
  const res = checkListing({
    store,
    locales: input.listing.locales,
    baseLocale: input.listing.baseLocale,
  });
  return {
    appId: ctx.app.id,
    store,
    unavailable: null,
    score: res.score,
    issueCount: res.issueCount,
    counts: res.counts,
    locales: res.locales,
  };
}

export type { CoverageLanguage };
export { checkListing };
