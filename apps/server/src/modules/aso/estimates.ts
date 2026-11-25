import {
  type EstimateStore,
  KEYWORD_ESTIMATE_MODEL,
  listingStoreOf,
  type OwnSignal,
} from '@kiln/core';
import type { Sql } from '@kiln/db';
import type { ManagedApp } from '../../services/apps.ts';
import { adsPopularityFor, adsSignalFor } from '../ads/view.ts';
import { type AsoKeyword, listKeywords } from './service.ts';
import {
  type EstimateView,
  estimateTrend,
  estimateView,
  latestSignals,
  readSignalDays,
  SIGNAL_RETENTION_DAYS,
} from './signals.ts';

/**
 * Reads of the keyword estimates (docs/adr/0057-keyword-estimates.md, docs/api/aso.md#estimates). Database only: no store is contacted.
 * The estimate is worked out here from the stored signals, the rank history and (Google Play) the team's own search terms, on every read.
 */

const RANK_SAMPLES = 30;
const DAY_MS = 86_400_000;

const storeOf = (app: ManagedApp): EstimateStore => listingStoreOf(app.platform);

/** The newest period of the app's own search terms file for the term (the storefront's row first, else the unsplit one). */
async function ownSignal(
  db: Sql,
  workspaceId: string,
  appId: string,
  k: AsoKeyword,
): Promise<OwnSignal | null> {
  const rows = await db.query(
    `SELECT country, period_from, period_to, visitors, installs FROM play_search_terms
      WHERE workspace_id = ? AND app_id = ? AND term_key = ? AND term_key <> '' AND (country = ? OR country = '')
      ORDER BY period_to DESC, country DESC LIMIT 1`,
    [workspaceId, appId, k.key, k.country],
  );
  const r = rows[0];
  if (!r) return null;
  const from = Date.parse(`${String(r.period_from)}T00:00:00Z`);
  const to = Date.parse(`${String(r.period_to)}T00:00:00Z`);
  const days =
    Number.isFinite(from) && Number.isFinite(to)
      ? Math.max(1, Math.round((to - from) / DAY_MS) + 1)
      : 1;
  return {
    visitors: r.visitors === null || r.visitors === undefined ? null : Number(r.visitors),
    installs: r.installs === null || r.installs === undefined ? null : Number(r.installs),
    days,
  };
}

async function ranksOf(db: Sql, keywordId: string): Promise<Array<number | null>> {
  const rows = await db.query(
    'SELECT rank_pos FROM aso_rank_checks WHERE keyword_id = ? ORDER BY checked_at DESC LIMIT ?',
    [keywordId, RANK_SAMPLES],
  );
  return rows.map((r) => (r.rank_pos === null ? null : Number(r.rank_pos))).reverse();
}

export type KeywordEstimateRow = {
  keywordId: string;
  term: string;
  country: string;
  locale: string;
  platform: string;
  estimate: EstimateView;
};

async function estimateOf(db: Sql, workspaceId: string, app: ManagedApp, k: AsoKeyword) {
  const store = storeOf(app);
  const days = await readSignalDays(db, workspaceId, store, k.country, k.key);
  const own = store === 'google_play' ? await ownSignal(db, workspaceId, app.id, k) : null;
  // The team's own Apple Ads campaigns (modules/ads): a lower bound, and null (not 0) when the term never appeared in a report.
  const ads =
    store === 'app_store' ? await adsSignalFor(db, workspaceId, app.id, k.key, k.country) : null;
  const currentRank = k.state === null ? undefined : k.state === 'ranked' ? k.rank : null;
  const estimate = estimateView(store, k.term, latestSignals(days), {
    own,
    ads,
    ranks: await ranksOf(db, k.id),
    currentRank,
  });
  return { estimate, days, store, ads };
}

export async function estimatesForApp(db: Sql, workspaceId: string, app: ManagedApp) {
  const keywords = await listKeywords(db, workspaceId, app.id);
  const estimates: KeywordEstimateRow[] = [];
  for (const k of keywords) {
    const { estimate } = await estimateOf(db, workspaceId, app, k);
    estimates.push({
      keywordId: k.id,
      term: k.term,
      country: k.country,
      locale: k.locale,
      platform: k.platform,
      estimate,
    });
  }
  return { appId: app.id, model: KEYWORD_ESTIMATE_MODEL, store: storeOf(app), estimates };
}

export async function estimateDetail(db: Sql, workspaceId: string, app: ManagedApp, k: AsoKeyword) {
  const { estimate, days, store, ads } = await estimateOf(db, workspaceId, app, k);
  return {
    model: KEYWORD_ESTIMATE_MODEL,
    keyword: { id: k.id, term: k.term, country: k.country, locale: k.locale, platform: k.platform },
    estimate,
    trend: estimateTrend(store, k.term, days),
    retentionDays: SIGNAL_RETENTION_DAYS,
    // Apple's own numbers, shown beside the estimate and never merged into it (docs/adr/0058-apple-ads.md).
    appleAds:
      store === 'app_store'
        ? { campaigns: ads, popularity: await adsPopularityFor(db, workspaceId, k.key, k.country) }
        : null,
  };
}

export type KeywordSuggestion = { term: string; country: string; locale: string; from: string[] };

/**
 * Related terms for a person to weigh: the App Store hints stored for the tracked keywords, minus the terms already tracked in that
 * storefront. Database only (the hints were read by the refresh); each suggestion names the tracked keywords that brought it.
 */
export async function suggestionsForApp(
  db: Sql,
  workspaceId: string,
  app: ManagedApp,
  filter: { country?: string; limit: number },
) {
  const store = storeOf(app);
  if (store !== 'app_store')
    return { appId: app.id, store, suggestions: [] as KeywordSuggestion[] };
  const keywords = await listKeywords(db, workspaceId, app.id);
  const tracked = new Set(keywords.map((k) => `${k.country}|${k.key}`));
  const found = new Map<string, KeywordSuggestion>();
  const seenSource = new Set<string>();
  for (const k of keywords) {
    if (filter.country && k.country !== filter.country) continue;
    const source = `${k.country}|${k.key}`;
    if (seenSource.has(source)) continue;
    seenSource.add(source);
    const days = await readSignalDays(db, workspaceId, store, k.country, k.key, 14);
    for (const term of latestSignals(days).hints?.list ?? []) {
      const key = `${k.country}|${term
        .toLowerCase()
        .replace(/[\s\-_]+/g, ' ')
        .trim()}`;
      if (tracked.has(key)) continue;
      const hit = found.get(key);
      if (hit) {
        if (!hit.from.includes(k.term)) hit.from.push(k.term);
      } else found.set(key, { term, country: k.country, locale: k.locale, from: [k.term] });
    }
  }
  const suggestions = [...found.values()]
    .sort((a, b) => b.from.length - a.from.length || a.term.localeCompare(b.term))
    .slice(0, filter.limit);
  return { appId: app.id, store, suggestions };
}
