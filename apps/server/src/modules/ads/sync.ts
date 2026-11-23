import {
  type AdsDay,
  type AdsTerm,
  readAppleAdsCampaigns,
  readAppleAdsKeywords,
  readAppleAdsPopularity,
  readAppleAdsSearchTerms,
} from '@kiln/connectors';
import { type ActorType, checkTerm, listingStoreOf } from '@kiln/core';
import type { Database, Sql } from '@kiln/db';
import { coded } from '../../i18n/problem.ts';
import type { JobHandler } from '../../jobs.ts';
import { getApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { type Failure, failure, type Outcome } from '../../services/repositories.ts';
import { listKeywords } from '../aso/service.ts';
import { adsClientFor, adsFailure } from './client.ts';
import type { AdsDeps } from './index.ts';
import { type AdsLinkView, getAdsLink, notSupportedFailure } from './link.ts';

/**
 * The Apple Ads sync (docs/adr/0058-apple-ads.md): reads the campaign report of the linked ad account, then the search term and keyword
 * reports of the campaigns that promote the linked app, and keeps daily rows. READ ONLY toward Apple. The `ads.sync` job runs it after
 * the analytics kinds of the sync plan (lib/sync-plan.ts, services/sync-all.ts); it also runs alone (`POST .../ads/sync`).
 *
 * - Range: the last 14 days (30 on the first sync, 1 to 90 on request), ending YESTERDAY in UTC, because the report is read in the
 *   account's time zone and today may not have ended there; Apple attributes installs late, so the recent days are read again.
 * - Idempotent: for every campaign read to the end, the rows of that range are replaced in one transaction (a day Apple no longer
 *   reports, for example a term it now hides, goes away); a campaign whose read was cut short keeps its old rows and is upserted.
 * - Caps: 25 campaigns, 20,000 daily rows per campaign and kind, 120 requests. A cap is said (`complete` false, a warning).
 * - Money: only rows in the account's currency are stored; others are counted in a warning, never mixed.
 * - Retention: rows older than 90 days are deleted at the end of every sync.
 * - Popularity: Apple's own 1 to 100 score of the app's tracked keywords (at most 3 storefronts and 40 terms each) for the last full
 *   week. A failure here is a warning; it never fails the sync.
 * - A failed sync keeps the last good rows, records a fixed sentence (never Apple's text) and a failure streak (a 429 is not one).
 */
type Actor = { type: ActorType; id: string };

export const ADS_SYNC_QUEUE = 'ads.sync';
export const ADS_SYNC_PURPOSE = 'ads.sync';
export const ADS_RETENTION_DAYS = 90;
export const ADS_DEFAULT_DAYS = 14;
export const ADS_FIRST_DAYS = 30;
export const ADS_MAX_CAMPAIGNS = 25;
export const ADS_MAX_POPULARITY_COUNTRIES = 3;
export const ADS_MAX_POPULARITY_TERMS = 40;
export const DEFAULT_ADS_SYNC_TIMEOUT_MS = 240_000;
const DAY_MS = 86_400_000;

export type AdsSyncContext = { db: Database; masterKey: Buffer; now: () => number; deps: AdsDeps | undefined };

export type AdsSyncResult = {
  campaigns: number;
  termRows: number;
  keywordRows: number;
  complete: boolean;
  skipped: number;
  /** Fixed warning codes, never Apple's text: `cap_campaigns`, `read_cut`, `currency_mismatch`, `popularity_failed`, `no_campaign`. */
  warnings: string[];
  rangeStart: string;
  rangeEnd: string;
  syncedAt: number;
};

export const notLinkedFailure = (): Failure =>
  failure(422, 'ads_not_linked', 'This app is not linked to an Apple Ads account. Link it in the app settings first.', coded('ads.notLinked'));

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function adsRangeFor(now: number, days: number): { start: string; end: string } {
  const end = now - DAY_MS;
  return { start: isoDay(end - (days - 1) * DAY_MS), end: isoDay(end) };
}

/** The last full Sunday to Saturday week that ended at least two days ago (Apple publishes popularity weekly). */
export function lastFullWeek(now: number): { start: string; end: string } {
  let d = now - 2 * DAY_MS;
  while (new Date(d).getUTCDay() !== 6) d -= DAY_MS;
  return { start: isoDay(d - 6 * DAY_MS), end: isoDay(d) };
}

type Metric = { impressions: number; taps: number; installs: number; tapInstalls: number; spendMicros: number };
const zero = (): Metric => ({ impressions: 0, taps: 0, installs: 0, tapInstalls: 0, spendMicros: 0 });

const termKeyOf = (term: string): string => {
  const checked = checkTerm(term);
  return (checked.ok ? checked.key : term.trim().toLowerCase()).slice(0, 120);
};


/** Multi-row upsert in chunks, so a big report is a few statements, not thousands. */
async function upsertRows(sql: Sql, table: string, columns: string[], key: string[], rows: unknown[][]): Promise<void> {
  const chunk = 100;
  const set = columns.filter((c) => !key.includes(c)).map((c) => `${c} = excluded.${c}`).join(', ');
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const marks = part.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
    await sql.execute(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${marks} ON CONFLICT (${key.join(', ')}) DO UPDATE SET ${set}`,
      part.flat() as never[],
    );
  }
}

const METRIC_COLUMNS = ['impressions', 'taps', 'installs', 'tap_installs', 'spend_micros', 'currency', 'fetched_at'];
const metricValues = (d: Metric, currency: string | null, at: number): unknown[] => [d.impressions, d.taps, d.installs, d.tapInstalls, d.spendMicros, currency, at];

const CAMPAIGN_COLUMNS = ['workspace_id', 'app_id', 'campaign_id', 'day', 'name', 'status', ...METRIC_COLUMNS];
const TERM_COLUMNS = ['workspace_id', 'app_id', 'campaign_id', 'kind', 'term_key', 'country', 'day', 'term', 'match_type', 'source', 'keyword_text', ...METRIC_COLUMNS];

/** The rows of one term report, merged by (key, country, day) after normalising the key, in the account's currency only. */
export function termRowsOf(
  workspaceId: string,
  appId: string,
  campaignId: string,
  kind: 'term' | 'keyword',
  terms: AdsTerm[],
  currency: string | null,
  at: number,
): { rows: unknown[][]; foreign: number } {
  const merged = new Map<string, { base: unknown[]; metric: Metric; currency: string | null }>();
  let foreign = 0;
  for (const t of terms) {
    const key = kind === 'keyword' ? (t.keywordId ?? '') : termKeyOf(t.term);
    if (key === '') continue;
    for (const d of t.days) {
      if (currency !== null && d.currency !== null && d.currency !== currency) {
        foreign += 1;
        continue;
      }
      const id = `${key}|${d.country}|${d.day}`;
      const had = merged.get(id);
      if (had) {
        had.metric.impressions += d.impressions;
        had.metric.taps += d.taps;
        had.metric.installs += d.installs;
        had.metric.tapInstalls += d.tapInstalls;
        had.metric.spendMicros += d.spendMicros;
        continue;
      }
      merged.set(id, {
        base: [workspaceId, appId, campaignId, kind, key, d.country, d.day, t.term.slice(0, 200), t.matchType, t.source, t.keywordText?.slice(0, 200) ?? null],
        metric: { impressions: d.impressions, taps: d.taps, installs: d.installs, tapInstalls: d.tapInstalls, spendMicros: d.spendMicros },
        currency: d.currency ?? currency,
      });
    }
  }
  return { rows: [...merged.values()].map((m) => [...m.base, ...metricValues(m.metric, m.currency, at)]), foreign };
}

function campaignRowsOf(workspaceId: string, appId: string, campaignId: string, name: string, status: string | null, days: AdsDay[], currency: string | null, at: number) {
  const byDay = new Map<string, { metric: Metric; currency: string | null }>();
  let foreign = 0;
  for (const d of days) {
    if (currency !== null && d.currency !== null && d.currency !== currency) {
      foreign += 1;
      continue;
    }
    const had = byDay.get(d.day) ?? { metric: zero(), currency: d.currency ?? currency };
    had.metric.impressions += d.impressions;
    had.metric.taps += d.taps;
    had.metric.installs += d.installs;
    had.metric.tapInstalls += d.tapInstalls;
    had.metric.spendMicros += d.spendMicros;
    byDay.set(d.day, had);
  }
  const rows = [...byDay.entries()].map(([day, v]) => [workspaceId, appId, campaignId, day, name.slice(0, 200), status, ...metricValues(v.metric, v.currency, at)]);
  return { rows, foreign };
}

async function recordFailure(db: Sql, workspaceId: string, appId: string, f: Failure, at: number): Promise<void> {
  const message = String(f.body.message ?? f.body.error).slice(0, 500);
  const code = typeof f.body.code === 'string' ? f.body.code : null;
  await db.execute(
    `INSERT INTO ads_sync (app_id, workspace_id, last_attempt_at, last_error, last_error_code, failure_streak)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (app_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error,
       last_error_code = excluded.last_error_code,
       failure_streak = ads_sync.failure_streak + ${f.status === 429 ? 0 : 1}`,
    [appId, workspaceId, at, message, code, f.status === 429 ? 0 : 1],
  );
}

/** Runs one sync of an app record. A failure is recorded on the app and answered; the last good rows stay. */
export async function runAdsSync(
  ctx: AdsSyncContext,
  input: { workspaceId: string; appId: string; actor: Actor; days?: number | undefined },
): Promise<Outcome<{ result: AdsSyncResult }>> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  if (listingStoreOf(app.platform) !== 'app_store') return notSupportedFailure();
  const link = await getAdsLink(ctx.db, input.workspaceId, app.id);
  if (!link) return notLinkedFailure();
  const at = ctx.now();
  const failed = async (f: Failure): Promise<Failure> => {
    await recordFailure(ctx.db, input.workspaceId, app.id, f, at);
    return f;
  };
  const [previous] = await ctx.db.query('SELECT last_success_at FROM ads_sync WHERE app_id = ?', [app.id]);
  const days = Math.min(90, Math.max(1, input.days ?? (previous?.last_success_at ? ADS_DEFAULT_DAYS : ADS_FIRST_DAYS)));
  const range = adsRangeFor(at, days);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ctx.deps?.syncTimeoutMs ?? DEFAULT_ADS_SYNC_TIMEOUT_MS);
  try {
    const opened = await adsClientFor(ctx.db, ctx.masterKey, input.workspaceId, link.credentialId, ctx.deps, {
      actor: input.actor,
      purpose: ADS_SYNC_PURPOSE,
      now: at,
      signal: controller.signal,
    });
    if (!opened.ok) return failed(opened);
    const { client } = opened;
    const warnings = new Set<string>();
    let complete = true;
    let skipped = 0;
    let termRows = 0;
    let keywordRows = 0;
    const writes: Array<(tx: Sql) => Promise<void>> = [];
    let campaignCount = 0;
    try {
      const report = await readAppleAdsCampaigns(client, link.adAccountId, range, { signal: controller.signal });
      skipped += report.skipped;
      if (!report.complete) {
        complete = false;
        warnings.add('read_cut');
      }
      let mine = report.rows.filter((c) => c.adamId === link.adamId);
      if (mine.length === 0) warnings.add('no_campaign');
      if (mine.length > ADS_MAX_CAMPAIGNS) {
        mine = mine.sort((a, b) => b.days.reduce((t, d) => t + d.impressions, 0) - a.days.reduce((t, d) => t + d.impressions, 0)).slice(0, ADS_MAX_CAMPAIGNS);
        warnings.add('cap_campaigns');
        complete = false;
      }
      campaignCount = mine.length;
      let foreign = 0;
      for (const c of mine) {
        const camp = campaignRowsOf(input.workspaceId, app.id, c.campaignId, c.name, c.status, c.days, link.currency, at);
        foreign += camp.foreign;
        writes.push(async (tx) => {
          await tx.execute('DELETE FROM ads_campaign_daily WHERE app_id = ? AND campaign_id = ? AND day >= ? AND day <= ?', [app.id, c.campaignId, range.start, range.end]);
          await upsertRows(tx, 'ads_campaign_daily', CAMPAIGN_COLUMNS, ['app_id', 'campaign_id', 'day'], camp.rows);
        });
        for (const kind of ['term', 'keyword'] as const) {
          if (!client.canRequest(1)) {
            complete = false;
            warnings.add('read_cut');
            continue;
          }
          const read = kind === 'term' ? readAppleAdsSearchTerms : readAppleAdsKeywords;
          const result = await read(client, link.adAccountId, c.campaignId, range, { signal: controller.signal });
          skipped += result.skipped;
          const built = termRowsOf(input.workspaceId, app.id, c.campaignId, kind, result.rows, link.currency, at);
          foreign += built.foreign;
          if (kind === 'term') termRows += built.rows.length;
          else keywordRows += built.rows.length;
          if (!result.complete) {
            complete = false;
            warnings.add('read_cut');
          }
          writes.push(async (tx) => {
            // A read cut short does not know what is missing, so it does not delete.
            if (result.complete) {
              await tx.execute('DELETE FROM ads_term_daily WHERE app_id = ? AND campaign_id = ? AND kind = ? AND day >= ? AND day <= ?', [app.id, c.campaignId, kind, range.start, range.end]);
            }
            await upsertRows(tx, 'ads_term_daily', TERM_COLUMNS, ['app_id', 'campaign_id', 'kind', 'term_key', 'country', 'day'], built.rows);
          });
        }
      }
      if (foreign > 0) warnings.add('currency_mismatch');
    } catch (error) {
      if (timedOut) return failed(failure(504, 'timeout', 'Apple Ads did not answer in time. Try again in a minute.', coded('ads.timeout')));
      return failed(adsFailure(error, opened.secret));
    }

    const popularity = await readPopularity(ctx, client, link, { workspaceId: input.workspaceId, appId: app.id }, controller.signal, at).catch(() => {
      warnings.add('popularity_failed');
      return null;
    });
    if (popularity && !popularity.complete) warnings.add('popularity_partial');

    const cutoff = isoDay(at - ADS_RETENTION_DAYS * DAY_MS);
    await ctx.db.transaction(async (tx) => {
      for (const write of writes) await write(tx);
      if (popularity) await writePopularity(tx, input.workspaceId, popularity.rows, at);
      for (const table of ['ads_campaign_daily', 'ads_term_daily']) {
        await tx.execute(`DELETE FROM ${table} WHERE app_id = ? AND day < ?`, [app.id, cutoff]);
      }
      await tx.execute(
        `INSERT INTO ads_sync (app_id, workspace_id, last_attempt_at, last_success_at, last_error, last_error_code, last_error_params, failure_streak, range_start, range_end, campaigns, complete, skipped, warnings)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (app_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_success_at = excluded.last_success_at,
           last_error = NULL, last_error_code = NULL, last_error_params = NULL, failure_streak = 0, range_start = excluded.range_start,
           range_end = excluded.range_end, campaigns = excluded.campaigns, complete = excluded.complete, skipped = excluded.skipped, warnings = excluded.warnings`,
        [app.id, input.workspaceId, at, at, range.start, range.end, campaignCount, complete ? 1 : 0, skipped, JSON.stringify([...warnings])],
      );
      await recordAudit(tx, {
        workspaceId: input.workspaceId,
        actor: input.actor,
        action: 'ads.synced',
        target: { type: 'app', id: app.id },
        // Counts only: never a campaign name, a term or a response.
        detail: { appId: app.id, campaigns: campaignCount, termRows, keywordRows, complete, warnings: warnings.size },
        at,
      });
    });
    return {
      ok: true,
      result: { campaigns: campaignCount, termRows, keywordRows, complete, skipped, warnings: [...warnings], rangeStart: range.start, rangeEnd: range.end, syncedAt: at },
    };
  } finally {
    clearTimeout(timer);
  }
}

type PopularityRow = { country: string; termKey: string; genre: string; term: string; period: string | null; popularity100: number | null; popularity5: number | null; rankInGenre: number | null };

async function readPopularity(
  ctx: AdsSyncContext,
  client: Parameters<typeof readAppleAdsPopularity>[0],
  link: AdsLinkView,
  input: { workspaceId: string; appId: string },
  signal: AbortSignal,
  at: number,
): Promise<{ rows: PopularityRow[]; complete: boolean }> {
  const keywords = await listKeywords(ctx.db, input.workspaceId, input.appId);
  const byCountry = new Map<string, Map<string, string>>();
  for (const k of keywords) {
    const m = byCountry.get(k.country) ?? new Map<string, string>();
    if (m.size < ADS_MAX_POPULARITY_TERMS) m.set(k.key, k.term);
    byCountry.set(k.country, m);
  }
  const week = lastFullWeek(at);
  const rows: PopularityRow[] = [];
  let complete = true;
  for (const [country, terms] of [...byCountry.entries()].slice(0, ADS_MAX_POPULARITY_COUNTRIES)) {
    if (!client.canRequest(0)) {
      complete = false;
      break;
    }
    const read = await readAppleAdsPopularity(client, link.adAccountId, { country, terms: [...terms.values()], weekStart: week.start, weekEnd: week.end }, { signal });
    if (!read.complete) complete = false;
    for (const r of read.rows) {
      rows.push({ country, termKey: termKeyOf(r.term), genre: r.genre ?? '', term: r.term, period: r.period, popularity100: r.popularity100, popularity5: r.popularity5, rankInGenre: r.rankInGenre });
    }
  }
  return { rows, complete };
}

async function writePopularity(tx: Sql, workspaceId: string, rows: PopularityRow[], at: number): Promise<void> {
  const seen = new Set<string>();
  const out: unknown[][] = [];
  for (const r of rows) {
    const id = `${r.country}|${r.termKey}|${r.genre}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push([workspaceId, r.country, r.termKey, r.genre, r.term.slice(0, 200), r.period, r.popularity100, r.popularity5, r.rankInGenre, at]);
  }
  await upsertRows(tx, 'ads_term_popularity', ['workspace_id', 'country', 'term_key', 'genre', 'term', 'period', 'popularity_100', 'popularity_5', 'rank_in_genre', 'fetched_at'], ['workspace_id', 'country', 'term_key', 'genre'], out);
}

export type AdsSyncPayload = { workspaceId: string; appId: string; requestedBy: string; days?: number };
const isPayload = (value: unknown): value is AdsSyncPayload =>
  typeof value === 'object' && value !== null && typeof (value as AdsSyncPayload).workspaceId === 'string' && typeof (value as AdsSyncPayload).appId === 'string';

/** The worker's handler: one sync of one app record, as the system. A failure is recorded by the sync itself, never thrown into the queue. */
export function createAdsSyncHandler(ctx: AdsSyncContext): JobHandler {
  return async (payload) => {
    if (!isPayload(payload)) return;
    await runAdsSync(ctx, { workspaceId: payload.workspaceId, appId: payload.appId, actor: { type: 'system', id: ADS_SYNC_QUEUE }, days: payload.days }).catch(() => undefined);
  };
}

