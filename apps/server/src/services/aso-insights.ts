import {
  buildCoach,
  type CoachAction,
  type CoachKeyword,
  type CompetitorText,
  type CoverageGap,
  coverageGaps,
  defaultLocaleFor,
  type FitFields,
  type FitKeyword,
  type Idea,
  type IdeaSource,
  isApplePlatform,
  isGooglePlatform,
  type ListingFit,
  languageOf,
  listingFit,
  type MarketKeyword,
  mineIdeas,
  normalizeLocale,
  type SuggestedCompetitor,
  suggestCompetitors,
  type TermAcrossMarkets,
  termsAcrossMarkets,
} from '@mrm/core';
import type { Sql } from '@mrm/db';
import type { ManagedApp } from './apps.ts';
import {
  type AsoAppState,
  type AsoCompetitor,
  type AsoKeyword,
  getAsoState,
  listCompetitors,
  listKeywords,
  platformStore,
} from './aso.ts';
import { getLiveListing } from './listing-live.ts';
import { rankMoveThresholdFor } from './workspace-settings.ts';

/**
 * What can be worked out from what is already stored: no store is read here, so none of it costs a
 * request and none of it needs the Play switch. Everything is a SUGGESTION: nothing here changes a
 * listing, a keyword or a competitor (docs/api/aso.md).
 *
 * - `listingFitFor`: which tracked keywords the app's own live listing covers (core `listingFit`).
 * - `ideasFor`: phrases from the own listing and the followed competitors' stored texts (local
 *   n-gram mining; a frequency, NOT a search volume).
 * - `gapsFor`: what competitors put in their names that the own listing does not have.
 * - `suggestionsFor`: apps that keep appearing in the top results of several tracked keywords, as
 *   candidates for the person to follow (`POST /competitors`).
 * - `marketsFor`: the same term in several countries as one row.
 */

type ListingChannel = {
  channel: 'live' | 'editable';
  locale: string;
  fields: FitFields;
  observedAt: number | null;
};

const tag = (locale: string): string => locale.replace(/_/g, '-').toLowerCase();

/** The stored text of one locale, under the names the fit logic uses. */
function fitFieldsOf(
  platform: ManagedApp['platform'],
  text: Record<string, string | undefined>,
): FitFields {
  const fields: FitFields = {};
  if (isApplePlatform(platform)) {
    if (text.name !== undefined) fields.title = text.name;
    if (text.subtitle !== undefined) fields.subtitle = text.subtitle;
    if (text.keywords !== undefined) fields.keywords = text.keywords;
    if (text.description !== undefined) fields.description = text.description;
  } else {
    if (text.title !== undefined) fields.title = text.title;
    if (text.short_description !== undefined) fields.shortDescription = text.short_description;
    if (text.full_description !== undefined) fields.description = text.full_description;
  }
  return fields;
}

/** Every locale of the stored listing (the live copy when there is one) with its text. */
export async function listingLocalesFor(
  sql: Sql,
  workspaceId: string,
  app: ManagedApp,
): Promise<{
  locales: { locale: string; fields: FitFields }[];
  readAt: number | null;
  error: string | null;
}> {
  const listing = await getLiveListing(sql, workspaceId, {
    id: app.id,
    platform: app.platform,
    identifier: app.identifier,
  });
  const channel =
    listing.channels.find((c) => c.channel === 'live' && Object.keys(c.locales).length > 0) ??
    listing.channels.find((c) => Object.keys(c.locales).length > 0);
  const locales = channel
    ? Object.keys(channel.locales)
        .sort()
        .map((locale) => ({
          locale,
          fields: fitFieldsOf(app.platform, channel.locales[locale] ?? {}),
        }))
    : [];
  return { locales, readAt: listing.readAt, error: listing.error };
}

/** The own listing text for a locale: the exact locale, else another locale of the same language. */
export async function ownFields(
  sql: Sql,
  workspaceId: string,
  app: ManagedApp,
  locale: string,
): Promise<{ found: ListingChannel | null; readAt: number | null; error: string | null }> {
  const listing = await getLiveListing(sql, workspaceId, {
    id: app.id,
    platform: app.platform,
    identifier: app.identifier,
  });
  const channel =
    listing.channels.find((c) => c.channel === 'live' && Object.keys(c.locales).length > 0) ??
    listing.channels.find((c) => Object.keys(c.locales).length > 0);
  if (!channel) return { found: null, readAt: listing.readAt, error: listing.error };
  const names = Object.keys(channel.locales);
  const wanted = tag(locale);
  const exact = names.find((n) => tag(n) === wanted);
  const sameLanguage = names.find((n) => languageOf(n) === languageOf(locale));
  const chosen = exact ?? sameLanguage;
  if (!chosen) return { found: null, readAt: listing.readAt, error: listing.error };
  const fields = fitFieldsOf(app.platform, channel.locales[chosen] ?? {});
  return {
    found: { channel: channel.channel, locale: chosen, fields, observedAt: channel.observedAt },
    readAt: listing.readAt,
    error: listing.error,
  };
}

/**
 * The stored text of every locale of the listing that the listing keyword view reads terms from: the App Store name,
 * subtitle and keyword field, or the Google Play title, short and full description. Our own database only (the copy the
 * last sync stored); no store is read. The App Store description is left out, because the store does not search it.
 */
export async function listingKeywordsFor(
  sql: Sql,
  workspaceId: string,
  app: ManagedApp,
): Promise<{
  readAt: number | null;
  error: string | null;
  locales: { locale: string; fields: FitFields }[];
}> {
  const stored = await listingLocalesFor(sql, workspaceId, app);
  const locales = stored.locales.map((l) => {
    const { description: _description, ...rest } = l.fields;
    return { locale: l.locale, fields: isApplePlatform(app.platform) ? rest : l.fields };
  });
  return { readAt: stored.readAt, error: stored.error, locales };
}

const fitKeywordOf = (k: AsoKeyword): FitKeyword => ({
  id: k.id,
  term: k.term,
  priority: k.priority,
  rank: k.state === 'ranked' ? k.rank : k.state === 'not_ranked' ? null : undefined,
});

export type FitView = {
  /** The locale of the tracked keywords this block is about. */
  locale: string;
  /** The locale of the listing the text came from (it can be another locale of the same language), or null when none is stored. */
  listingLocale: string | null;
  channel: 'live' | 'editable' | null;
  keywords: number;
  fit: ListingFit | null;
  /** The stored listing text this fit was worked out from (for the budget meters); null when none is stored for the locale. */
  fields: FitFields | null;
};

/** Keyword fit per locale of the tracked keywords. */
export async function listingFitFor(
  sql: Sql,
  workspaceId: string,
  app: ManagedApp,
  filter: { locale?: string } = {},
): Promise<{ readAt: number | null; error: string | null; locales: FitView[] }> {
  const keywords = await listKeywords(sql, workspaceId, app.id);
  const byLocale = new Map<string, AsoKeyword[]>();
  for (const k of keywords) {
    if (filter.locale && tag(k.locale) !== tag(filter.locale)) continue;
    const list = byLocale.get(k.locale) ?? [];
    list.push(k);
    byLocale.set(k.locale, list);
  }
  let readAt: number | null = null;
  let error: string | null = null;
  const locales: FitView[] = [];
  for (const locale of Array.from(byLocale.keys()).sort()) {
    const group = byLocale.get(locale) as AsoKeyword[];
    const own = await ownFields(sql, workspaceId, app, locale);
    readAt = own.readAt;
    error = own.error;
    locales.push({
      locale,
      listingLocale: own.found?.locale ?? null,
      channel: own.found?.channel ?? null,
      keywords: group.length,
      fit: own.found
        ? listingFit({
            platform: app.platform,
            locale,
            fields: own.found.fields,
            keywords: group.map(fitKeywordOf),
          })
        : null,
      fields: own.found?.fields ?? null,
    });
  }
  if (byLocale.size === 0) {
    const own = await ownFields(sql, workspaceId, app, filter.locale ?? 'en-US');
    readAt = own.readAt;
    error = own.error;
  }
  return { readAt, error, locales };
}

/** The locale to work in when a person gives none: the one most tracked keywords use, else English (US). */
export async function defaultLocale(sql: Sql, workspaceId: string, appId: string): Promise<string> {
  const keywords = await listKeywords(sql, workspaceId, appId);
  const counts = new Map<string, number>();
  for (const k of keywords) counts.set(k.locale, (counts.get(k.locale) ?? 0) + 1);
  let best = 'en-US';
  let most = 0;
  for (const [locale, n] of counts) {
    if (n > most) {
      best = locale;
      most = n;
    }
  }
  return best;
}

export const checkLocale = (raw: string | undefined): string | undefined =>
  raw === undefined ? undefined : normalizeLocale(raw);

type CompetitorTexts = { competitor: AsoCompetitor; text: CompetitorText }[];

const competitorTexts = (competitors: readonly AsoCompetitor[]): CompetitorTexts => {
  const out: CompetitorTexts = [];
  for (const competitor of competitors) {
    const latest = competitor.latest;
    if (!latest) continue;
    const text: CompetitorText = { id: competitor.id };
    const title = latest.title ?? competitor.name;
    if (title) text.title = title;
    if (latest.subtitle) text.subtitle = latest.subtitle;
    if (latest.descriptionExcerpt) text.description = latest.descriptionExcerpt;
    out.push({ competitor, text });
  }
  return out;
};

/**
 * Phrases worth considering as keywords, from the texts held here. The ranking is a frequency in
 * those texts, never a search volume (no store publishes one for free).
 */
export async function ideasFor(
  sql: Sql,
  workspaceId: string,
  app: ManagedApp,
  options: { locale?: string; limit?: number; minOccurrences?: number } = {},
): Promise<{
  locale: string;
  basedOn: { ownListing: boolean; competitors: number };
  ideas: Idea[];
  notes: string[];
}> {
  const locale = options.locale ?? (await defaultLocale(sql, workspaceId, app.id));
  const keywords = await listKeywords(sql, workspaceId, app.id);
  const competitors = competitorTexts(await listCompetitors(sql, workspaceId, app.id));
  const own = await ownFields(sql, workspaceId, app, locale);
  const sources: IdeaSource[] = [];
  const f = own.found?.fields;
  if (f) {
    if (f.title) sources.push({ id: 'own:title', text: f.title, weight: 3 });
    if (f.subtitle) sources.push({ id: 'own:subtitle', text: f.subtitle, weight: 2 });
    if (f.shortDescription) sources.push({ id: 'own:short', text: f.shortDescription, weight: 2 });
    if (f.description) sources.push({ id: 'own:description', text: f.description, weight: 1 });
  }
  for (const { competitor, text } of competitors) {
    if (text.title) sources.push({ id: competitor.id, text: text.title, weight: 3 });
    if (text.subtitle) sources.push({ id: competitor.id, text: text.subtitle, weight: 2 });
    if (text.description) sources.push({ id: competitor.id, text: text.description, weight: 1 });
  }
  const ideas = mineIdeas(sources, {
    language: locale,
    exclude: keywords.map((k) => k.term),
    limit: options.limit ?? 30,
    minOccurrences: options.minOccurrences ?? 2,
  });
  const notes = [
    'The score is a frequency in the texts listed under basedOn. It is not a search volume or a popularity.',
  ];
  if (!own.found)
    notes.push(
      'No live listing text is stored for this locale (sync the app), so only competitors are used.',
    );
  if (competitors.length === 0)
    notes.push('No competitor is followed, so only the own listing is used.');
  return {
    locale,
    basedOn: { ownListing: own.found !== null, competitors: competitors.length },
    ideas,
    notes,
  };
}

/** Terms competitors use in their names and texts that the own listing does not have. */
export async function gapsFor(
  sql: Sql,
  workspaceId: string,
  app: ManagedApp,
  options: { locale?: string; limit?: number } = {},
): Promise<{ locale: string; competitors: number; gaps: CoverageGap[]; notes: string[] }> {
  const locale = options.locale ?? (await defaultLocale(sql, workspaceId, app.id));
  const keywords = (await listKeywords(sql, workspaceId, app.id)).filter(
    (k) => tag(k.locale) === tag(locale),
  );
  const texts = competitorTexts(await listCompetitors(sql, workspaceId, app.id));
  const own = await ownFields(sql, workspaceId, app, locale);
  const notes: string[] = [];
  if (!own.found)
    notes.push(
      'No live listing text is stored for this locale (sync the app): every term then reads as missing.',
    );
  if (texts.length === 0) notes.push('No competitor is followed.');
  const gaps = coverageGaps({
    platform: app.platform,
    locale,
    ours: own.found?.fields ?? {},
    competitors: texts.map((t) => t.text),
    tracked: keywords.map(fitKeywordOf),
    limit: options.limit ?? 30,
  });
  return { locale, competitors: texts.length, gaps, notes };
}

export type SuggestionView = SuggestedCompetitor & { country: string; name: string | null };

/**
 * Apps that appear in the stored top results of several tracked keywords (the newest check of
 * each), per country, without the own app and without the ones already followed. The person decides.
 */
export async function suggestionsFor(
  sql: Sql,
  workspaceId: string,
  app: ManagedApp,
  options: { minKeywords?: number; limit?: number } = {},
): Promise<{ suggestions: SuggestionView[]; basedOnKeywords: number; notes: string[] }> {
  const ownId = isApplePlatform(app.platform) ? app.storeAppId : app.identifier;
  const keywords = await listKeywords(sql, workspaceId, app.id);
  const followed = await listCompetitors(sql, workspaceId, app.id);
  const rows = await sql.query(
    `SELECT keyword_id, top_results FROM aso_rank_checks c
      WHERE c.app_id = ? AND c.workspace_id = ?
        AND c.checked_at = (SELECT MAX(r.checked_at) FROM aso_rank_checks r WHERE r.keyword_id = c.keyword_id)`,
    [app.id, workspaceId],
  );
  const top = new Map<string, { id: string; name?: string }[]>();
  for (const row of rows) {
    try {
      const parsed: unknown = JSON.parse(String(row.top_results));
      if (Array.isArray(parsed)) {
        top.set(
          String(row.keyword_id),
          parsed.filter(
            (p): p is { id: string; name?: string } =>
              typeof p === 'object' && p !== null && typeof (p as { id?: unknown }).id === 'string',
          ),
        );
      }
    } catch {
      // A row that is not JSON has nothing to offer.
    }
  }
  const byCountry = new Map<string, { keywordId: string; ids: string[] }[]>();
  const names = new Map<string, string>();
  let used = 0;
  for (const k of keywords) {
    const hits = top.get(k.id);
    if (!hits || hits.length === 0) continue;
    used += 1;
    for (const h of hits) if (h.name) names.set(`${k.country}\u0000${h.id}`, h.name);
    const list = byCountry.get(k.country) ?? [];
    list.push({ keywordId: k.id, ids: hits.map((h) => h.id) });
    byCountry.set(k.country, list);
  }
  const suggestions: SuggestionView[] = [];
  for (const country of Array.from(byCountry.keys()).sort()) {
    const exclude = followed.filter((c) => c.country === country).map((c) => c.externalId);
    const found = suggestCompetitors(byCountry.get(country) ?? [], {
      ...(ownId ? { ownId } : {}),
      exclude,
      minKeywords: options.minKeywords ?? 2,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });
    for (const s of found)
      suggestions.push({
        ...s,
        country,
        name: names.get(`${country}\u0000${s.externalId}`) ?? null,
      });
  }
  suggestions.sort(
    (a, b) =>
      b.keywordCount - a.keywordCount ||
      a.averageRank - b.averageRank ||
      a.externalId.localeCompare(b.externalId),
  );
  const notes: string[] = [];
  if (used === 0)
    notes.push(
      'No keyword has been checked yet, so there are no results to compare. Refresh the app first.',
    );
  if (isGooglePlatform(app.platform))
    notes.push('Google Play results carry no names; look an app up before following it.');
  return { suggestions: suggestions.slice(0, options.limit ?? 20), basedOnKeywords: used, notes };
}

/** The same term in each tracked country and locale as one row. */
export async function marketsFor(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<TermAcrossMarkets[]> {
  const keywords = await listKeywords(sql, workspaceId, appId);
  const items: MarketKeyword[] = keywords.map((k) => ({
    id: k.id,
    term: k.term,
    key: k.key,
    country: k.country,
    locale: k.locale,
    rank: k.rank,
    state: k.state ?? (k.error ? 'unavailable' : null),
    checkedAt: k.lastCheckedAt,
  }));
  return termsAcrossMarkets(items);
}

export const localeOfCountry = (country: string): string => defaultLocaleFor(country);

export type AsoSummary = {
  app: { id: string; platform: ManagedApp['platform']; store: 'app_store' | 'google_play' };
  keywords: {
    total: number;
    ranked: number;
    notRanked: number;
    unchecked: number;
    failing: number;
    top3: number;
    top10: number;
  };
  /** The biggest moves between the last two checks, at most five. */
  movers: {
    keywordId: string;
    term: string;
    country: string;
    locale: string;
    kind: string;
    from: number | null;
    to: number | null;
    delta: number | null;
  }[];
  competitors: { total: number; notFound: number; changedRecently: number };
  state: AsoAppState;
};

const RECENT_CHANGE_MS = 7 * 24 * 60 * 60_000;

export async function summaryFor(
  sql: Sql,
  workspaceId: string,
  app: ManagedApp,
  now: number,
): Promise<AsoSummary> {
  const keywords = await listKeywords(sql, workspaceId, app.id);
  const competitors = await listCompetitors(sql, workspaceId, app.id);
  const counts = {
    total: keywords.length,
    ranked: 0,
    notRanked: 0,
    unchecked: 0,
    failing: 0,
    top3: 0,
    top10: 0,
  };
  const moves: AsoSummary['movers'] = [];
  for (const k of keywords) {
    if (k.state === null) counts.unchecked += 1;
    else if (k.state === 'ranked') {
      counts.ranked += 1;
      if (k.rank !== null && k.rank <= 3) counts.top3 += 1;
      if (k.rank !== null && k.rank <= 10) counts.top10 += 1;
    } else counts.notRanked += 1;
    if (k.error) counts.failing += 1;
    const c = k.change;
    if (
      c &&
      (c.kind === 'up' || c.kind === 'down' || c.kind === 'entered' || c.kind === 'dropped')
    ) {
      moves.push({
        keywordId: k.id,
        term: k.term,
        country: k.country,
        locale: k.locale,
        kind: c.kind,
        from: c.from,
        to: c.to,
        delta: c.delta ?? null,
      });
    }
  }
  const size = (m: AsoSummary['movers'][number]) => (m.delta !== null ? Math.abs(m.delta) : 1000);
  moves.sort((a, b) => size(b) - size(a) || a.term.localeCompare(b.term));
  return {
    app: { id: app.id, platform: app.platform, store: platformStore(app.platform) },
    keywords: counts,
    movers: moves.slice(0, 5),
    competitors: {
      total: competitors.length,
      notFound: competitors.filter((c) => c.state === 'not_found').length,
      changedRecently: competitors.filter(
        (c) => c.latest?.kind === 'change' && now - c.latest.checkedAt < RECENT_CHANGE_MS,
      ).length,
    },
    state: await getAsoState(sql, workspaceId, app.id),
  };
}

// ---------------------------------------------------------------------------------------------
// The coach: next actions, worked out from what is stored (core `buildCoach`)

type TopResult = { id: string; name?: string };

/** The stored results (best first) of the newest check of each keyword of the app. */
async function latestTopResults(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<Map<string, TopResult[]>> {
  const rows = await sql.query(
    `SELECT keyword_id, top_results FROM aso_rank_checks c
      WHERE c.app_id = ? AND c.workspace_id = ?
        AND c.checked_at = (SELECT MAX(r.checked_at) FROM aso_rank_checks r WHERE r.keyword_id = c.keyword_id)`,
    [appId, workspaceId],
  );
  const top = new Map<string, TopResult[]>();
  for (const row of rows) {
    try {
      const parsed: unknown = JSON.parse(String(row.top_results));
      if (Array.isArray(parsed)) {
        top.set(
          String(row.keyword_id),
          parsed.filter(
            (p): p is TopResult =>
              typeof p === 'object' && p !== null && typeof (p as { id?: unknown }).id === 'string',
          ),
        );
      }
    } catch {
      // A row that is not JSON has nothing to offer.
    }
  }
  return top;
}

export type CoachView = {
  actions: CoachAction[];
  /** What the actions were worked out from. */
  basedOn: {
    keywords: number;
    competitors: number;
    listingLocales: number;
    lastCheckAt: number | null;
    listingReadAt: number | null;
  };
};

/**
 * A short ranked list of next steps for an app. Reads our own database only (no store is contacted) and
 * proposes; nothing here changes a keyword, a competitor or a listing.
 */
export async function coachFor(
  sql: Sql,
  workspaceId: string,
  app: ManagedApp,
  now: number,
): Promise<CoachView> {
  const keywords = await listKeywords(sql, workspaceId, app.id);
  const competitors = await listCompetitors(sql, workspaceId, app.id);
  const state = await getAsoState(sql, workspaceId, app.id);
  const listing = await listingLocalesFor(sql, workspaceId, app);
  const threshold = await rankMoveThresholdFor(sql, workspaceId);

  const coachKeywords: CoachKeyword[] = keywords.map((k) => ({
    id: k.id,
    term: k.term,
    country: k.country,
    locale: k.locale,
    priority: k.priority,
    state: k.state,
    rank: k.rank,
    lastCheckedAt: k.lastCheckedAt,
    change: k.change,
  }));

  // A followed competitor in the stored results of a keyword, before the own app (or while it is not in them).
  const above: {
    keywordId: string;
    competitorId: string;
    competitorName: string;
    competitorRank: number;
  }[] = [];
  if (competitors.length > 0) {
    const top = await latestTopResults(sql, workspaceId, app.id);
    for (const k of keywords) {
      if (k.state === null) continue;
      const hits = top.get(k.id);
      if (!hits) continue;
      let best: { competitorId: string; competitorName: string; competitorRank: number } | null =
        null;
      hits.forEach((hit, index) => {
        const rank = index + 1;
        if (k.state === 'ranked' && k.rank !== null && rank >= k.rank) return;
        const competitor = competitors.find(
          (c) => c.country === k.country && c.externalId === hit.id,
        );
        if (competitor && (best === null || rank < best.competitorRank))
          best = {
            competitorId: competitor.id,
            competitorName: competitor.name,
            competitorRank: rank,
          };
      });
      if (best !== null)
        above.push({
          keywordId: k.id,
          ...(best as { competitorId: string; competitorName: string; competitorRank: number }),
        });
    }
  }

  const actions = buildCoach({
    platform: app.platform,
    now,
    keywords: coachKeywords,
    competitors: competitors.map((c) => ({ id: c.id, name: c.name })),
    competitorsAbove: above,
    listingLocales: listing.locales,
    lastCheckAt: state.lastSuccessAt,
    rankMoveThreshold: threshold,
  });
  return {
    actions,
    basedOn: {
      keywords: keywords.length,
      competitors: competitors.length,
      listingLocales: listing.locales.length,
      lastCheckAt: state.lastSuccessAt,
      listingReadAt: listing.readAt,
    },
  };
}
