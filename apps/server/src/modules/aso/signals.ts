import { appleStorefrontId } from '@kiln/connectors';
import {
  type AdsSignal,
  estimateKeyword,
  type EstimateStore,
  type HintsSignal,
  KEYWORD_ESTIMATE_MODEL,
  type KeywordEstimate,
  type KeywordSignals,
  type OwnSignal,
  type ResultsSignal,
} from '@kiln/core';
import type { Database, Sql } from '@kiln/db';

/**
 * The signals behind the keyword estimates (docs/adr/0057-keyword-estimates.md): what the public App Store said about a term on a
 * day, kept compactly in `aso_keyword_signals` (one row per workspace, store, storefront, term and day, 90 days). The estimate is
 * never stored: it is recomputed from these rows and the team's own data on every read, so a new model needs no migration.
 * Only terms the team tracks are ever asked; nothing here is sent to an AI; no term is logged.
 */

export const SIGNAL_RETENTION_DAYS = 90;
/** Most terms whose hints one refresh asks for (each is one request to Apple, after the cache). */
export const DEFAULT_SIGNAL_TERMS_PER_RUN = 10;
export const MAX_RESULT_APPS = 10;
const DAY_MS = 86_400_000;

export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** What a day's row holds: only public store data. */
export type StoredSignals = {
  hints?: HintsSignal & { at: number };
  results?: ResultsSignal & { at: number };
};

export const hintsPosition = (term: string, list: readonly string[]): number | null => {
  const key = term.toLowerCase().replace(/\s+/g, ' ').trim();
  const i = list.indexOf(key);
  return i === -1 ? null : i + 1;
};

const parse = (text: unknown): StoredSignals => {
  try {
    const v = JSON.parse(String(text)) as unknown;
    return v && typeof v === 'object' ? (v as StoredSignals) : {};
  } catch {
    return {};
  }
};

/** Merges `patch` into the row of `now`'s day (a result read and a hints read of one day share it). */
export async function saveSignals(
  db: Database,
  input: { workspaceId: string; store: EstimateStore; country: string; termKey: string; term: string; now: number },
  patch: StoredSignals,
): Promise<void> {
  const day = dayOf(input.now);
  const key = [input.workspaceId, input.store, input.country, input.termKey, day];
  await db.transaction(async (tx) => {
    const [row] = await tx.query(
      'SELECT signals FROM aso_keyword_signals WHERE workspace_id = ? AND store = ? AND country = ? AND term_key = ? AND day = ?',
      key,
    );
    const merged = { ...(row ? parse(row.signals) : {}), ...patch };
    await tx.execute(
      `INSERT INTO aso_keyword_signals (workspace_id, store, country, term_key, day, term, signals, model, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, store, country, term_key, day) DO UPDATE SET
         term = excluded.term, signals = excluded.signals, model = excluded.model, fetched_at = excluded.fetched_at`,
      [...key, input.term.slice(0, 200), JSON.stringify(merged), KEYWORD_ESTIMATE_MODEL, input.now],
    );
  });
}

/** The first search results of a rank check, as the results signal (names cut, at most 10 apps). */
export function resultsSignal(
  hits: ReadonlyArray<{ id: string; name?: string; ratingCount?: number }>,
  total: number,
  limit: number,
  now: number,
): ResultsSignal & { at: number } {
  return {
    total,
    limit,
    at: now,
    top: hits.slice(0, MAX_RESULT_APPS).map((h) => ({
      id: h.id,
      ...(h.name ? { name: h.name.slice(0, 100) } : {}),
      ratingCount: typeof h.ratingCount === 'number' ? h.ratingCount : null,
    })),
  };
}

/** Rows older than the retention, and rows of terms no keyword tracks any more. */
export async function pruneSignals(db: Database, workspaceId: string, now: number): Promise<void> {
  await db.execute('DELETE FROM aso_keyword_signals WHERE workspace_id = ? AND fetched_at < ?', [
    workspaceId,
    now - SIGNAL_RETENTION_DAYS * DAY_MS,
  ]);
  await db.execute(
    `DELETE FROM aso_keyword_signals WHERE workspace_id = ? AND NOT EXISTS (
       SELECT 1 FROM aso_keywords k WHERE k.workspace_id = aso_keyword_signals.workspace_id
         AND k.country = aso_keyword_signals.country AND k.term_key = aso_keyword_signals.term_key)`,
    [workspaceId],
  );
}

export type SignalTarget = { country: string; termKey: string; term: string };

/**
 * The terms of an App Store app that still need hints today: distinct per storefront and term, a storefront Kiln has no id for is
 * left out (a wrong storefront would be a wrong signal), the oldest reading first, at most `limit`.
 */
export async function termsNeedingHints(
  db: Sql,
  workspaceId: string,
  appId: string,
  today: string,
  limit: number,
): Promise<SignalTarget[]> {
  const rows = await db.query(
    `SELECT k.country AS country, k.term_key AS term_key, MIN(k.term) AS term,
            (SELECT MAX(s.day) FROM aso_keyword_signals s WHERE s.workspace_id = k.workspace_id AND s.store = 'app_store'
               AND s.country = k.country AND s.term_key = k.term_key) AS last_day
       FROM aso_keywords k WHERE k.workspace_id = ? AND k.app_id = ?
      GROUP BY k.workspace_id, k.country, k.term_key ORDER BY COALESCE(last_day, ''), k.term_key`,
    [workspaceId, appId],
  );
  const out: SignalTarget[] = [];
  for (const r of rows) {
    if (String(r.last_day ?? '') === today && (await hasHintsToday(db, workspaceId, String(r.country), String(r.term_key), today))) continue;
    if (appleStorefrontId(String(r.country)) === undefined) continue;
    out.push({ country: String(r.country), termKey: String(r.term_key), term: String(r.term) });
    if (out.length >= limit) break;
  }
  return out;
}

async function hasHintsToday(db: Sql, workspaceId: string, country: string, termKey: string, day: string): Promise<boolean> {
  const [row] = await db.query(
    "SELECT signals FROM aso_keyword_signals WHERE workspace_id = ? AND store = 'app_store' AND country = ? AND term_key = ? AND day = ?",
    [workspaceId, country, termKey, day],
  );
  return !!row && parse(row.signals).hints !== undefined;
}

export type SignalDay = { day: string; fetchedAt: number; signals: StoredSignals };

/** The stored days of a term, newest first (at most `days`). */
export async function readSignalDays(
  db: Sql,
  workspaceId: string,
  store: EstimateStore,
  country: string,
  termKey: string,
  days = SIGNAL_RETENTION_DAYS,
): Promise<SignalDay[]> {
  const rows = await db.query(
    `SELECT day, fetched_at, signals FROM aso_keyword_signals
      WHERE workspace_id = ? AND store = ? AND country = ? AND term_key = ? ORDER BY day DESC LIMIT ?`,
    [workspaceId, store, country, termKey, days],
  );
  return rows.map((r) => ({ day: String(r.day), fetchedAt: Number(r.fetched_at), signals: parse(r.signals) }));
}

/** The newest hints and the newest results among the days (they may come from different days). */
export function latestSignals(days: readonly SignalDay[]): StoredSignals {
  const out: StoredSignals = {};
  for (const d of days) {
    if (!out.hints && d.signals.hints) out.hints = d.signals.hints;
    if (!out.results && d.signals.results) out.results = d.signals.results;
  }
  return out;
}

export type EstimateView = KeywordEstimate & {
  /** When the newest public signal was read; null when there is none. */
  signalsAt: number | null;
  /** The newest hints list (a short list of related terms), for the detail and the suggestions. */
  hints: string[];
  /** The apps of the newest search results (at most 10): who a term competes with. */
  top: Array<{ id: string; name: string | null; ratingCount: number | null }>;
};

export function buildSignals(
  term: string,
  stored: StoredSignals,
  extra: { own?: OwnSignal | null; ads?: AdsSignal | null; ranks?: Array<number | null>; currentRank?: number | null | undefined },
): KeywordSignals {
  return {
    term,
    hints: stored.hints ? { position: stored.hints.position, list: stored.hints.list } : null,
    results: stored.results ?? null,
    own: extra.own ?? null,
    ads: extra.ads ?? null,
    ranks: extra.ranks ?? [],
    currentRank: extra.currentRank,
  };
}

export function estimateView(
  store: EstimateStore,
  term: string,
  stored: StoredSignals,
  extra: Parameters<typeof buildSignals>[2],
): EstimateView {
  const estimate = estimateKeyword(store, buildSignals(term, stored, extra));
  const at = Math.max(stored.hints?.at ?? 0, stored.results?.at ?? 0);
  return {
    ...estimate,
    signalsAt: at > 0 ? at : null,
    hints: stored.hints?.list ?? [],
    top: (stored.results?.top ?? []).map((a) => ({ id: a.id, name: a.name ?? null, ratingCount: a.ratingCount ?? null })),
  };
}

/**
 * One estimate per stored day, oldest first, for the trend. Each day uses the newest hints and results read up to that day (own data
 * and ranks are not part of a past day's estimate, so the trend moves only with the public signals).
 */
export function estimateTrend(
  store: EstimateStore,
  term: string,
  days: readonly SignalDay[],
): Array<{ day: string; popularity: number | null; difficulty: number | null }> {
  const carried: StoredSignals = {};
  return days
    .slice()
    .reverse()
    .map((d) => {
      if (d.signals.hints) carried.hints = d.signals.hints;
      if (d.signals.results) carried.results = d.signals.results;
      const e = estimateKeyword(store, buildSignals(term, carried, {}));
      return { day: d.day, popularity: e.popularity.score, difficulty: e.difficulty.score };
    });
}
