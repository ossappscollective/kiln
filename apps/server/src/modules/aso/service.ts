import { createHash, randomUUID } from 'node:crypto';
import { AsoError, isPlayPackageName } from '@kiln/connectors';
import {
  type ActorType,
  type AsoPlatform,
  byFamily,
  type CompetitorChange,
  type CompetitorState,
  checkTerm,
  DEFAULT_EDGE_TOP,
  decideSnapshot,
  defaultLocaleFor,
  imageKey,
  isBigMove,
  type ListingStore,
  listingStoreOf,
  MAX_NOTES_CHARACTERS,
  MAX_TAG_CHARACTERS,
  normalizeCountry,
  normalizeLocale,
  type RankChange,
  rankChange,
  rankTrend,
  storeSideId,
  supports,
} from '@kiln/core';
import {
  type Database,
  nullableNumber,
  nullableString,
  type Param,
  type Row,
  type Sql,
} from '@kiln/db';
import { enqueue, type JobHandler } from '../../jobs.ts';
import { getApp, type ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { emitEvent } from '../../services/events.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { rankMoveThresholdFor } from '../../services/workspace-settings.ts';
import { COMPETITOR_SEARCH_LIMIT, type CompetitorSearchResult, mapSearchResults } from './competitor-search.ts';
import { registerSearchImage } from './competitor-images.ts';
import { recordListingChanges, storeInitialListingState, type WatchOutcome } from './competitor-watch.ts';
import type { AsoSources, PublicApp } from './net.ts';

import { coded } from '../../i18n/problem.ts';
/**
 * ASO data and its refresh: tracked keywords and their rank checks, followed competitors and their
 * public snapshots (docs/adr/0011-aso-keywords-competitors.md, docs/api/aso.md). Everything read here
 * is PUBLIC store data (the iTunes Search API; optionally the public pages of Google Play): no credential is
 * used and nothing is ever written to a store.
 *
 * - Rank checks are stored on every check (rank or null, the number of results looked at, the source).
 *   Competitor snapshots only on the first look, on a change and as a heartbeat (`decideSnapshot`).
 * - A refresh takes an atomic claim on `aso_app_state` (one per app across processes, it expires), checks
 *   at most `limits.maxChecksPerRun` keywords (the oldest first; the scheduler only the due ones), shares
 *   one search per term and storefront (cache and in-flight sharing in aso-net.ts), and stops early
 *   (the rest stays due) when a source says to slow down, is unavailable, fails three times in a row or the
 *   time is up. A source that is unavailable never turns into "not ranked".
 * - Events: `aso.rank_changed` for a move of at least the workspace setting `aso.rankMoveThreshold` places
 *   (or into or out of the top ten), never on the first check; `aso.competitor_changed` for a notable change
 *   of a competitor (never on the first look). Both carry ids and numbers, never a keyword or a text.
 * - Audit entries carry ids and counts, never a term, a note or a store text.
 */

type Actor = { type: ActorType; id: string };

export const ASO_REFRESH_QUEUE = 'aso.refresh';
export const ASO_CLAIM_TTL_MS = 15 * 60_000;
export const DEFAULT_ASO_RUN_MS = 4 * 60_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MAX_TOP_RESULTS = 20;
const MAX_EXCERPT = 1000;
const MAX_ERROR_LENGTH = 200;
const MIN_BACKOFF_MS = 15 * MINUTE;
const MAX_BACKOFF_MS = 6 * 60 * MINUTE;
const TRANSIENT_STOP = 3;

export type AsoLimits = {
  maxKeywordsPerApp: number;
  maxCompetitorsPerApp: number;
  /** Most keyword checks one refresh makes. */
  maxChecksPerRun: number;
  /** How many results of a search are looked at (Apple allows up to 200, Google Play is capped lower). */
  rankDepth: number;
  /** A competitor with no stored snapshot for this long gets one anyway. */
  heartbeatMs: number;
  /** KILN_ASO_RETENTION_DAYS; 0 keeps everything. */
  retentionDays: number;
  /** KILN_ASO_INTERVAL_MINUTES in milliseconds; 0: scheduled refreshes are off. */
  intervalMs: number;
};

export const DEFAULT_ASO_LIMITS: AsoLimits = {
  maxKeywordsPerApp: 50,
  maxCompetitorsPerApp: 10,
  maxChecksPerRun: 25,
  rankDepth: 50,
  heartbeatMs: 7 * DAY,
  retentionDays: 365,
  intervalMs: 0,
};

export type AsoContext = {
  db: Database;
  now: () => number;
  sources: AsoSources;
  limits: AsoLimits;
  /** Longest one refresh runs. Default 4 minutes. */
  maxRunMs?: number;
};

export const platformStore = (platform: AsoPlatform): ListingStore => listingStoreOf(platform);

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

// ---------------------------------------------------------------------------------------------
// Errors

/** An `AsoError` as the response a person sees. Never carries a term or an address. */
export function asoFailure(error: unknown): Failure {
  if (error instanceof AsoError) {
    switch (error.kind) {
      case 'rate_limited': {
        const wait = error.retryAfterSeconds ?? 60;
        return {
          ...failure(429, 'rate_limited', error.message, { retryAfterSeconds: wait }),
          headers: { 'Retry-After': String(wait) },
        };
      }
      case 'unavailable':
        return error.reason === 'disabled'
          ? playDisabledFailure()
          : failure(502, 'source_unavailable', error.message, {
              reason: error.reason ?? 'unknown',
            });
      case 'timeout':
        return failure(504, 'source_timeout', error.message);
      case 'invalid_input':
        return failure(422, 'invalid_input', error.message);
      default:
        return failure(502, 'source_failed', error.message);
    }
  }
  return failure(
    502,
    'source_failed',
    'The store could not be read. Try again in a moment.',
    coded('aso.storeUnreadable'),
  );
}

export const playDisabledFailure = (): Failure =>
  failure(
    409,
    'play_unofficial_disabled',
    'Reading Google Play pages is switched off. The operator can turn it on with KILN_ASO_PLAY_UNOFFICIAL_ENABLED=true (read the warning in docs/api/aso.md first).',
  );

/** The short code kept on a keyword or competitor when its last look failed. */
export function asoErrorCode(error: unknown): string {
  if (error instanceof AsoError)
    return error.kind === 'unavailable' ? `unavailable_${error.reason ?? 'unknown'}` : error.kind;
  return 'failed';
}

// ---------------------------------------------------------------------------------------------
// Keywords

export type KeywordState = 'ranked' | 'not_ranked';

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
  priority: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** The last SUCCESSFUL check; null: never checked. */
  lastCheckedAt: number | null;
  /** The result of the last successful check; null: never checked. */
  state: KeywordState | null;
  rank: number | null;
  /** How many results that check looked at. */
  total: number | null;
  /** The check before it, when there was one. */
  previous: { state: KeywordState; rank: number | null } | null;
  /** How the last two successful checks compare. */
  change: RankChange | null;
  /** Why the latest attempt failed (a short code), or null when it did not. Cleared by the next success. */
  error: string | null;
};

const KEYWORD_COLUMNS = `id, app_id, platform, country, locale, term, term_key, tag, notes, priority, created_by, created_at,
  updated_at, last_checked_at, last_state, last_rank_pos, last_total, prev_state, prev_rank_pos, last_error`;

const asState = (v: unknown): KeywordState | null =>
  v === 'ranked' || v === 'not_ranked' ? v : null;

export function toKeyword(r: Row): AsoKeyword {
  const state = asState(r.last_state);
  const previousState = asState(r.prev_state);
  const total = nullableNumber(r.last_total);
  const rank = nullableNumber(r.last_rank_pos);
  const previous = previousState
    ? { state: previousState, rank: nullableNumber(r.prev_rank_pos) }
    : null;
  const change =
    state && previous
      ? rankChange({ rank: previous.rank, total: total ?? 0 }, { rank, total: total ?? 0 })
      : null;
  return {
    id: String(r.id),
    appId: String(r.app_id),
    platform: String(r.platform) as AsoPlatform,
    country: String(r.country),
    locale: String(r.locale),
    term: String(r.term),
    key: String(r.term_key),
    tag: nullableString(r.tag),
    notes: nullableString(r.notes),
    priority: Number(r.priority),
    createdBy: String(r.created_by),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastCheckedAt: nullableNumber(r.last_checked_at),
    state,
    rank: state ? rank : null,
    total: state ? total : null,
    previous,
    change,
    error: nullableString(r.last_error),
  };
}

export async function listKeywords(
  sql: Sql,
  workspaceId: string,
  appId: string,
  filter: { country?: string; locale?: string; tag?: string } = {},
): Promise<AsoKeyword[]> {
  const where = ['workspace_id = ?', 'app_id = ?'];
  const params: Param[] = [workspaceId, appId];
  if (filter.country) {
    where.push('country = ?');
    params.push(filter.country);
  }
  if (filter.locale) {
    where.push('locale = ?');
    params.push(filter.locale);
  }
  if (filter.tag) {
    where.push('tag = ?');
    params.push(filter.tag);
  }
  const rows = await sql.query(
    `SELECT ${KEYWORD_COLUMNS} FROM aso_keywords WHERE ${where.join(' AND ')} ORDER BY term_key, country, locale`,
    params,
  );
  return rows.map(toKeyword);
}

export async function getKeyword(
  sql: Sql,
  workspaceId: string,
  appId: string,
  id: string,
): Promise<AsoKeyword | undefined> {
  const [row] = await sql.query(
    `SELECT ${KEYWORD_COLUMNS} FROM aso_keywords WHERE id = ? AND app_id = ? AND workspace_id = ?`,
    [id, appId, workspaceId],
  );
  return row ? toKeyword(row) : undefined;
}

export type KeywordInput = {
  term: string;
  country?: string;
  locale?: string;
  tag?: string | null;
  notes?: string | null;
  priority?: number;
};

export type KeywordResult =
  | { index: number; status: 'created'; keyword: AsoKeyword }
  | { index: number; status: 'exists'; keyword: AsoKeyword }
  | { index: number; status: 'invalid'; message: string }
  | { index: number; status: 'limit'; message: string };

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/;

/** A tag or a note: plain text, no control characters (a note may have line breaks). */
function cleanFreeText(
  value: string | null | undefined,
  max: number,
  multiline: boolean,
): { ok: true; value: string | null } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  const text = multiline ? value.trim() : value.replace(/\s+/g, ' ').trim();
  if (text === '') return { ok: true, value: null };
  if (Array.from(text).length > max) return { ok: false, message: `At most ${max} characters.` };
  if (CONTROL.test(text)) return { ok: false, message: 'No control characters.' };
  return { ok: true, value: text };
}

/** Adds keywords to an app. Each item is judged on its own: a bad or duplicate one does not stop the others. */
export async function addKeywords(
  ctx: AsoContext,
  input: { workspaceId: string; app: ManagedApp; actor: Actor; items: readonly KeywordInput[] },
): Promise<KeywordResult[]> {
  const { workspaceId, app } = input;
  const at = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const [counted] = await tx.query(
      'SELECT COUNT(*) AS n FROM aso_keywords WHERE app_id = ? AND workspace_id = ?',
      [app.id, workspaceId],
    );
    let count = Number(counted?.n ?? 0);
    const results: KeywordResult[] = [];
    const created: string[] = [];
    for (let index = 0; index < input.items.length; index += 1) {
      const item = input.items[index] as KeywordInput;
      const term = checkTerm(item.term);
      if (!term.ok) {
        results.push({ index, status: 'invalid', message: term.reason });
        continue;
      }
      const country = item.country === undefined ? 'us' : normalizeCountry(item.country);
      if (!country) {
        results.push({
          index,
          status: 'invalid',
          message: 'The country is two letters, such as us or de.',
        });
        continue;
      }
      const locale =
        item.locale === undefined ? defaultLocaleFor(country) : normalizeLocale(item.locale);
      if (!locale) {
        results.push({
          index,
          status: 'invalid',
          message: 'The locale is a language tag such as en-US or pt-BR.',
        });
        continue;
      }
      const priority = item.priority ?? 2;
      if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
        results.push({
          index,
          status: 'invalid',
          message: 'The priority is 1 (low), 2 (normal) or 3 (high).',
        });
        continue;
      }
      const tag = cleanFreeText(item.tag, MAX_TAG_CHARACTERS, false);
      const notes = cleanFreeText(item.notes, MAX_NOTES_CHARACTERS, true);
      if (!tag.ok || !notes.ok) {
        results.push({
          index,
          status: 'invalid',
          message: !tag.ok
            ? `Tag: ${tag.message}`
            : `Notes: ${(notes as { message: string }).message}`,
        });
        continue;
      }
      const [existing] = await tx.query(
        `SELECT ${KEYWORD_COLUMNS} FROM aso_keywords WHERE app_id = ? AND country = ? AND locale = ? AND term_key = ?`,
        [app.id, country, locale, term.key],
      );
      if (existing) {
        results.push({ index, status: 'exists', keyword: toKeyword(existing) });
        continue;
      }
      if (count >= ctx.limits.maxKeywordsPerApp) {
        results.push({
          index,
          status: 'limit',
          message: `An app tracks at most ${ctx.limits.maxKeywordsPerApp} keywords (KILN_ASO_MAX_KEYWORDS_PER_APP).`,
        });
        continue;
      }
      const id = randomUUID();
      await tx.execute(
        `INSERT INTO aso_keywords
           (id, workspace_id, app_id, platform, country, locale, term, term_key, tag, notes, priority, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          workspaceId,
          app.id,
          app.platform,
          country,
          locale,
          term.term,
          term.key,
          tag.value,
          notes.value,
          priority,
          input.actor.id,
          at,
          at,
        ],
      );
      count += 1;
      created.push(id);
      const row = (
        await tx.query(`SELECT ${KEYWORD_COLUMNS} FROM aso_keywords WHERE id = ?`, [id])
      )[0] as Row;
      results.push({ index, status: 'created', keyword: toKeyword(row) });
    }
    if (created.length > 0) {
      await recordAudit(tx, {
        workspaceId,
        actor: input.actor,
        action: 'aso.keyword_add',
        target: { type: 'app', id: app.id },
        // Ids and a count: the terms are not in the audit log.
        detail: { count: created.length, keywordIds: created.slice(0, 50) },
        at,
      });
    }
    return results;
  });
}

export async function updateKeyword(
  ctx: AsoContext,
  input: {
    workspaceId: string;
    appId: string;
    id: string;
    actor: Actor;
    tag?: string | null;
    notes?: string | null;
    priority?: number;
  },
): Promise<{ ok: true; keyword: AsoKeyword } | Failure> {
  const existing = await getKeyword(ctx.db, input.workspaceId, input.appId, input.id);
  if (!existing) return failure(404, 'not_found');
  const sets: string[] = [];
  const params: Param[] = [];
  const changed: string[] = [];
  if (input.tag !== undefined) {
    const tag = cleanFreeText(input.tag, MAX_TAG_CHARACTERS, false);
    if (!tag.ok) return failure(422, 'invalid_keyword', `Tag: ${tag.message}`);
    sets.push('tag = ?');
    params.push(tag.value);
    changed.push('tag');
  }
  if (input.notes !== undefined) {
    const notes = cleanFreeText(input.notes, MAX_NOTES_CHARACTERS, true);
    if (!notes.ok) return failure(422, 'invalid_keyword', `Notes: ${notes.message}`);
    sets.push('notes = ?');
    params.push(notes.value);
    changed.push('notes');
  }
  if (input.priority !== undefined) {
    if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 3) {
      return failure(422, 'invalid_keyword', 'The priority is 1 (low), 2 (normal) or 3 (high).');
    }
    sets.push('priority = ?');
    params.push(input.priority);
    changed.push('priority');
  }
  if (sets.length === 0) return { ok: true, keyword: existing };
  const at = ctx.now();
  await ctx.db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE aso_keywords SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND workspace_id = ?`,
      [...params, at, input.id, input.workspaceId],
    );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'aso.keyword_update',
      target: { type: 'aso_keyword', id: input.id },
      detail: { appId: input.appId, changed },
      at,
    });
  });
  return {
    ok: true,
    keyword: (await getKeyword(ctx.db, input.workspaceId, input.appId, input.id)) as AsoKeyword,
  };
}

export async function deleteKeyword(
  ctx: AsoContext,
  input: { workspaceId: string; appId: string; id: string; actor: Actor },
): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const existing = await getKeyword(tx, input.workspaceId, input.appId, input.id);
    if (!existing) return false;
    await tx.execute('DELETE FROM aso_rank_checks WHERE keyword_id = ? AND workspace_id = ?', [
      input.id,
      input.workspaceId,
    ]);
    await tx.execute('DELETE FROM aso_keywords WHERE id = ? AND workspace_id = ?', [
      input.id,
      input.workspaceId,
    ]);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'aso.keyword_delete',
      target: { type: 'aso_keyword', id: input.id },
      detail: { appId: input.appId, country: existing.country, locale: existing.locale },
      at: ctx.now(),
    });
    return true;
  });
}

export type RankCheckView = {
  id: string;
  checkedAt: number;
  rank: number | null;
  total: number;
  source: string;
};

export const DEFAULT_HISTORY_LIMIT = 100;
export const MAX_HISTORY_LIMIT = 1000;

/** The checks of a keyword, oldest first (the newest `limit`), with their trend. */
export async function keywordHistory(
  sql: Sql,
  input: { workspaceId: string; appId: string; keywordId: string; limit?: number; since?: number },
) {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_HISTORY_LIMIT, 1), MAX_HISTORY_LIMIT);
  const rows = await sql.query(
    `SELECT id, checked_at, rank_pos, total, source FROM aso_rank_checks
      WHERE keyword_id = ? AND app_id = ? AND workspace_id = ? AND checked_at >= ?
      ORDER BY checked_at DESC, id DESC LIMIT ?`,
    [input.keywordId, input.appId, input.workspaceId, input.since ?? 0, limit],
  );
  const checks: RankCheckView[] = rows
    .map((r) => ({
      id: String(r.id),
      checkedAt: Number(r.checked_at),
      rank: nullableNumber(r.rank_pos),
      total: Number(r.total),
      source: String(r.source),
    }))
    .reverse();
  return { checks, trend: rankTrend(checks.map((c) => ({ rank: c.rank, total: c.total }))) };
}

// ---------------------------------------------------------------------------------------------
// Competitors

export type CompetitorSnapshotView = {
  id: string;
  checkedAt: number;
  kind: 'first' | 'change' | 'heartbeat';
  version: string | null;
  /** Stars, 0 to 5. */
  rating: number | null;
  ratingCount: number | null;
  price: string | null;
  currency: string | null;
  title: string | null;
  subtitle: string | null;
  descriptionExcerpt: string | null;
  screenshotCount: number | null;
  changes: CompetitorChange[] | null;
};

export type AsoCompetitor = {
  id: string;
  appId: string;
  store: ListingStore;
  externalId: string;
  country: string;
  name: string;
  addedBy: string;
  addedAt: number;
  lastCheckedAt: number | null;
  state: 'ok' | 'not_found' | 'unavailable' | null;
  error: string | null;
  latest: CompetitorSnapshotView | null;
};

const SNAPSHOT_COLUMNS = `id, checked_at, kind, version, rating_milli, rating_count, price, currency, title, subtitle,
  description_excerpt, text_hash, description_hash, screenshot_count, media_hash, changes`;

function parseChanges(raw: unknown): CompetitorChange[] | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? (value as CompetitorChange[]) : null;
  } catch {
    return null;
  }
}

export function toSnapshot(r: Row): CompetitorSnapshotView {
  const milli = nullableNumber(r.rating_milli);
  return {
    id: String(r.id),
    checkedAt: Number(r.checked_at),
    kind: String(r.kind) as CompetitorSnapshotView['kind'],
    version: nullableString(r.version),
    rating: milli === null ? null : milli / 1000,
    ratingCount: nullableNumber(r.rating_count),
    price: nullableString(r.price),
    currency: nullableString(r.currency),
    title: nullableString(r.title),
    subtitle: nullableString(r.subtitle),
    descriptionExcerpt: nullableString(r.description_excerpt),
    screenshotCount: nullableNumber(r.screenshot_count),
    changes: parseChanges(r.changes),
  };
}

const stateOfSnapshot = (r: Row): CompetitorState & { checkedAt: number } => ({
  checkedAt: Number(r.checked_at),
  version: nullableString(r.version),
  ratingMilli: nullableNumber(r.rating_milli),
  ratingCount: nullableNumber(r.rating_count),
  price: nullableString(r.price),
  title: nullableString(r.title),
  subtitle: nullableString(r.subtitle),
  textHash: String(r.text_hash),
  descriptionHash: nullableString(r.description_hash),
  screenshotCount: nullableNumber(r.screenshot_count),
  mediaHash: nullableString(r.media_hash),
});

async function latestSnapshotRow(sql: Sql, competitorId: string): Promise<Row | undefined> {
  const [row] = await sql.query(
    `SELECT ${SNAPSHOT_COLUMNS} FROM aso_competitor_snapshots WHERE competitor_id = ? ORDER BY checked_at DESC, id DESC LIMIT 1`,
    [competitorId],
  );
  return row;
}

async function toCompetitor(sql: Sql, r: Row): Promise<AsoCompetitor> {
  const latest = await latestSnapshotRow(sql, String(r.id));
  const state =
    r.last_state === 'ok' || r.last_state === 'not_found' || r.last_state === 'unavailable'
      ? r.last_state
      : null;
  return {
    id: String(r.id),
    appId: String(r.app_id),
    store: String(r.store) as AsoCompetitor['store'],
    externalId: String(r.external_id),
    country: String(r.country),
    name: String(r.name),
    addedBy: String(r.added_by),
    addedAt: Number(r.added_at),
    lastCheckedAt: nullableNumber(r.last_checked_at),
    state,
    error: nullableString(r.last_error),
    latest: latest ? toSnapshot(latest) : null,
  };
}

const COMPETITOR_COLUMNS =
  'id, app_id, store, external_id, country, name, added_by, added_at, last_checked_at, last_state, last_error, listing_state';

export async function listCompetitors(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<AsoCompetitor[]> {
  const rows = await sql.query(
    `SELECT ${COMPETITOR_COLUMNS} FROM aso_competitors WHERE workspace_id = ? AND app_id = ? ORDER BY added_at, id`,
    [workspaceId, appId],
  );
  const out: AsoCompetitor[] = [];
  for (const row of rows) out.push(await toCompetitor(sql, row));
  return out;
}

export async function getCompetitor(
  sql: Sql,
  workspaceId: string,
  appId: string,
  id: string,
): Promise<AsoCompetitor | undefined> {
  const [row] = await sql.query(
    `SELECT ${COMPETITOR_COLUMNS} FROM aso_competitors WHERE id = ? AND app_id = ? AND workspace_id = ?`,
    [id, appId, workspaceId],
  );
  return row ? toCompetitor(sql, row) : undefined;
}

/** The numeric App Store id (also from `id123` or an apps.apple.com address), or the Android package name (also from a play.google.com address). */
export function normalizeExternalId(platform: AsoPlatform, raw: string): string | undefined {
  const text = raw.trim();
  if (listingStoreOf(platform) === 'app_store') {
    const match = /^(?:id)?([0-9]{1,15})$/i.exec(text) ?? /\/id([0-9]{1,15})(?:[/?#]|$)/.exec(text);
    return match?.[1];
  }
  const fromUrl = /[?&]id=([A-Za-z][A-Za-z0-9_.]*)/.exec(text);
  const candidate = fromUrl ? (fromUrl[1] as string) : text;
  return isPlayPackageName(candidate) ? candidate : undefined;
}

/**
 * Search the App Store by name for an app to follow. Reads the public store through the shared cache, rate limit and cool-down;
 * writes nothing. Each row says whether it is this app or is already followed in that storefront.
 */
export async function searchCompetitors(
  ctx: AsoContext,
  input: { workspaceId: string; app: ManagedApp; q: string; country: string },
): Promise<{ ok: true; country: string; results: CompetitorSearchResult[]; cached: boolean } | Failure> {
  const { app, workspaceId } = input;
  if (listingStoreOf(app.platform) !== 'app_store' || !ctx.sources.searchApps)
    return failure(
      409,
      'search_app_store_only',
      'Search by name is for App Store apps. For Google Play, paste the package name or the play.google.com address.',
      coded('aso.searchAppStoreOnly'),
    );
  let found: { apps: PublicApp[]; cached: boolean };
  try {
    found = await ctx.sources.searchApps({
      platform: app.platform,
      term: input.q,
      country: input.country,
      limit: COMPETITOR_SEARCH_LIMIT,
    });
  } catch (error) {
    return asoFailure(error);
  }
  const rows = await ctx.db.query(
    'SELECT external_id FROM aso_competitors WHERE app_id = ? AND workspace_id = ? AND store = ? AND country = ?',
    [app.id, workspaceId, platformStore(app.platform), input.country],
  );
  const followed = new Set(rows.map((r) => String(r.external_id)));
  return {
    ok: true,
    country: input.country,
    cached: found.cached,
    results: mapSearchResults(found.apps, { ownId: storeSideId(app.platform, app) ?? undefined, followed }).map((r) => ({
      ...r,
      iconRef: registerSearchImage(workspaceId, app.id, r.iconUrl, ctx.now()),
    })),
  };
}

/** A competitor's public data as the state the diff compares, plus the short fields that are stored. */
export function competitorStateOf(app: PublicApp): {
  state: CompetitorState;
  excerpt: string | null;
} {
  const description = app.description ?? '';
  const title = app.name || null;
  // The identity of an image, not its address: a re-encode or another CDN size is no change (docs/adr/0056-competitor-listing-watch.md).
  const media = [app.iconUrl ?? '', ...(app.screenshotUrls ?? [])].map((u) => (u === '' ? '' : imageKey(u))).join('\n');
  return {
    state: {
      version: app.version ?? null,
      ratingMilli: app.ratingMilli ?? null,
      ratingCount: app.ratingCount ?? null,
      price: app.price ?? null,
      title,
      subtitle: null,
      textHash: sha(`${title ?? ''}\n\n${description}`),
      descriptionHash: description === '' ? null : sha(description),
      screenshotCount: app.screenshotCount ?? null,
      mediaHash: media.trim() === '' ? null : sha(media),
    },
    excerpt: description === '' ? null : description.slice(0, MAX_EXCERPT),
  };
}

async function insertSnapshot(
  tx: Sql,
  input: {
    workspaceId: string;
    appId: string;
    competitorId: string;
    at: number;
    kind: string;
    app: PublicApp;
    changes: CompetitorChange[];
  },
): Promise<void> {
  const { state, excerpt } = competitorStateOf(input.app);
  await tx.execute(
    `INSERT INTO aso_competitor_snapshots
       (id, workspace_id, competitor_id, app_id, checked_at, kind, version, rating_milli, rating_count, price, currency, title, subtitle,
        description_excerpt, text_hash, description_hash, screenshot_count, media_hash, changes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      input.workspaceId,
      input.competitorId,
      input.appId,
      input.at,
      input.kind,
      state.version ?? null,
      state.ratingMilli ?? null,
      state.ratingCount ?? null,
      state.price ?? null,
      input.app.currency ?? null,
      state.title ?? null,
      state.subtitle ?? null,
      excerpt,
      state.textHash,
      state.descriptionHash ?? null,
      state.screenshotCount ?? null,
      state.mediaHash ?? null,
      input.changes.length > 0 ? JSON.stringify(input.changes) : null,
    ],
  );
}

/** Follows an app of the store as a competitor: looks it up once (so the name is real and the first snapshot exists). */
export async function addCompetitor(
  ctx: AsoContext,
  input: {
    workspaceId: string;
    app: ManagedApp;
    actor: Actor;
    externalId: string;
    country?: string;
  },
): Promise<{ ok: true; competitor: AsoCompetitor } | Failure> {
  const { workspaceId, app } = input;
  const externalId = normalizeExternalId(app.platform, input.externalId);
  if (!externalId) {
    return failure(
      422,
      'invalid_external_id',
      listingStoreOf(app.platform) === 'app_store'
        ? 'Use the numeric App Store id (a number, id123 or an apps.apple.com address).'
        : 'Use the Android package name (such as com.example.app) or its play.google.com address.',
    );
  }
  const country = input.country === undefined ? 'us' : normalizeCountry(input.country);
  if (!country)
    return failure(422, 'invalid_country', 'The country is two letters, such as us or de.');
  if (externalId === storeSideId(app.platform, app)) {
    return failure(422, 'own_app', 'That is this app itself.', coded('aso.competitorSelf'));
  }
  const store = platformStore(app.platform);
  const [counted] = await ctx.db.query(
    'SELECT COUNT(*) AS n FROM aso_competitors WHERE app_id = ? AND workspace_id = ?',
    [app.id, workspaceId],
  );
  const [dup] = await ctx.db.query(
    'SELECT id FROM aso_competitors WHERE app_id = ? AND store = ? AND external_id = ? AND country = ?',
    [app.id, store, externalId, country],
  );
  if (dup)
    return failure(
      409,
      'already_followed',
      'This competitor is already followed in that country.',
      coded('aso.competitorExists'),
    );
  if (Number(counted?.n ?? 0) >= ctx.limits.maxCompetitorsPerApp) {
    return failure(
      409,
      'limit_reached',
      `An app follows at most ${ctx.limits.maxCompetitorsPerApp} competitors (KILN_ASO_MAX_COMPETITORS_PER_APP).`,
      coded('aso.competitorLimit', { max: ctx.limits.maxCompetitorsPerApp }),
    );
  }
  let found: PublicApp | undefined;
  try {
    found = await ctx.sources.lookup({
      platform: app.platform,
      id: externalId,
      country,
      locale: defaultLocaleFor(country),
    });
  } catch (error) {
    return asoFailure(error);
  }
  if (!found) return failure(
    422,
    'not_found',
    'The store has no such app in that country.',
    coded('aso.noStoreApp'),
  );
  const at = ctx.now();
  const id = randomUUID();
  try {
    await ctx.db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO aso_competitors (id, workspace_id, app_id, store, external_id, country, name, added_by, added_at, last_checked_at, last_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok')`,
        [
          id,
          workspaceId,
          app.id,
          store,
          externalId,
          country,
          (found as PublicApp).name.slice(0, 200) || externalId,
          input.actor.id,
          at,
          at,
        ],
      );
      await insertSnapshot(tx, {
        workspaceId,
        appId: app.id,
        competitorId: id,
        at,
        kind: 'first',
        app: found as PublicApp,
        changes: [],
      });
      await storeInitialListingState(tx, id, store, found as PublicApp);
      await recordAudit(tx, {
        workspaceId,
        actor: input.actor,
        action: 'aso.competitor_add',
        target: { type: 'aso_competitor', id },
        detail: { appId: app.id, store, country },
        at,
      });
    });
  } catch {
    // The unique index: somebody added it a moment ago.
    return failure(
      409,
      'already_followed',
      'This competitor is already followed in that country.',
      coded('aso.competitorExists'),
    );
  }
  return {
    ok: true,
    competitor: (await getCompetitor(ctx.db, workspaceId, app.id, id)) as AsoCompetitor,
  };
}

export async function removeCompetitor(
  ctx: AsoContext,
  input: { workspaceId: string; appId: string; id: string; actor: Actor },
): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const existing = await getCompetitor(tx, input.workspaceId, input.appId, input.id);
    if (!existing) return false;
    await tx.execute(
      'DELETE FROM aso_competitor_snapshots WHERE competitor_id = ? AND workspace_id = ?',
      [input.id, input.workspaceId],
    );
    await tx.execute(
      'DELETE FROM aso_competitor_reviews WHERE competitor_id = ? AND workspace_id = ?',
      [input.id, input.workspaceId],
    );
    await tx.execute('DELETE FROM aso_competitors WHERE id = ? AND workspace_id = ?', [
      input.id,
      input.workspaceId,
    ]);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'aso.competitor_remove',
      target: { type: 'aso_competitor', id: input.id },
      detail: { appId: input.appId, store: existing.store, country: existing.country },
      at: ctx.now(),
    });
    return true;
  });
}

/** The stored snapshots of a competitor, newest first, and what changed between the two newest. */
export async function competitorHistory(
  sql: Sql,
  input: { workspaceId: string; appId: string; competitorId: string; limit?: number },
) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
  const rows = await sql.query(
    `SELECT ${SNAPSHOT_COLUMNS} FROM aso_competitor_snapshots
      WHERE competitor_id = ? AND app_id = ? AND workspace_id = ? ORDER BY checked_at DESC, id DESC LIMIT ?`,
    [input.competitorId, input.appId, input.workspaceId, limit],
  );
  const snapshots = rows.map(toSnapshot);
  // The latest CHANGE: the newest snapshot that recorded differences, with the one before it.
  const index = snapshots.findIndex(
    (s) => s.kind === 'change' && s.changes !== null && s.changes.length > 0,
  );
  const diff =
    index >= 0
      ? {
          from: snapshots[index + 1]?.id ?? null,
          to: (snapshots[index] as CompetitorSnapshotView).id,
          at: (snapshots[index] as CompetitorSnapshotView).checkedAt,
          changes: (snapshots[index] as CompetitorSnapshotView).changes as CompetitorChange[],
        }
      : null;
  return { snapshots, diff };
}

// ---------------------------------------------------------------------------------------------
// State

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
  /** Work is left for a later refresh. */
  deferred: boolean;
  retryAfterSeconds?: number;
  stoppedBecause?: 'rate_limit' | 'unavailable' | 'errors' | 'time' | 'cap';
  /** Why checks failed (short codes), distinct. */
  errors: string[];
  warnings: string[];
};

export type AsoAppState = {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  backoffUntil: number | null;
  lastResult: AsoRefreshResult | null;
};

export async function getAsoState(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<AsoAppState> {
  const [row] = await sql.query(
    'SELECT last_attempt_at, last_success_at, last_error, consecutive_failures, backoff_until, last_result FROM aso_app_state WHERE app_id = ? AND workspace_id = ?',
    [appId, workspaceId],
  );
  let lastResult: AsoRefreshResult | null = null;
  if (row && typeof row.last_result === 'string') {
    try {
      lastResult = JSON.parse(row.last_result) as AsoRefreshResult;
    } catch {
      lastResult = null;
    }
  }
  return {
    lastAttemptAt: nullableNumber(row?.last_attempt_at),
    lastSuccessAt: nullableNumber(row?.last_success_at),
    lastError: nullableString(row?.last_error),
    consecutiveFailures: Number(row?.consecutive_failures ?? 0),
    backoffUntil: nullableNumber(row?.backoff_until),
    lastResult,
  };
}

export const asoBackoffMs = (failures: number): number =>
  Math.min(MIN_BACKOFF_MS * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);

async function claim(
  db: Sql,
  workspaceId: string,
  appId: string,
  now: number,
  by: string,
): Promise<boolean> {
  const changed = await db.execute(
    `INSERT INTO aso_app_state (app_id, workspace_id, claimed_at, claimed_by) VALUES (?, ?, ?, ?)
     ON CONFLICT (app_id) DO UPDATE SET claimed_at = excluded.claimed_at, claimed_by = excluded.claimed_by
       WHERE aso_app_state.claimed_at IS NULL OR aso_app_state.claimed_at < ?`,
    [appId, workspaceId, now, by, now - ASO_CLAIM_TTL_MS],
  );
  return changed === 1;
}

// ---------------------------------------------------------------------------------------------
// The refresh

export type AsoRefreshOptions = {
  scope?: 'all' | 'keywords' | 'competitors';
  /** Check everything up to the caps (a person asked). Default: only what is due (`limits.intervalMs`). */
  force?: boolean;
};
export type AsoTrigger = { trigger: 'request' } | { trigger: 'job'; requestedBy: string };
export type AsoRefreshFailure = Failure & { transient: boolean };

/** Apps being refreshed in this process; the database claim covers the other processes. */
const running = new Set<string>();

export async function refreshApp(
  ctx: AsoContext,
  input: { workspaceId: string; id: string },
  actor: Actor,
  trigger: AsoTrigger = { trigger: 'request' },
  options: AsoRefreshOptions = {},
): Promise<{ ok: true; result: AsoRefreshResult; state: AsoAppState } | AsoRefreshFailure> {
  const app = await getApp(ctx.db, input.workspaceId, input.id);
  if (!app) return { ...failure(404, 'not_found'), transient: false };
  if (supports(app.platform, 'unofficialSearch') && !ctx.sources.playEnabled)
    return { ...playDisabledFailure(), transient: false };
  if (
    running.has(app.id) ||
    !(await claim(ctx.db, input.workspaceId, app.id, ctx.now(), actor.id))
  ) {
    return {
      ...failure(
        409,
        'refresh_in_progress',
        'This app is being refreshed right now.',
        coded('aso.refreshing'),
      ),
      transient: true,
    };
  }
  running.add(app.id);
  try {
    return await run(ctx, input.workspaceId, app, actor, trigger, options);
  } catch {
    // Nothing may escape: a bug here must not stop the scheduler or the worker.
    await release(ctx, input.workspaceId, app.id, 'failed').catch(() => undefined);
    return {
      ...failure(
        502,
        'refresh_failed',
        'The ASO refresh could not be completed. Try again in a moment.',
        coded('aso.refreshFailed'),
      ),
      transient: true,
    };
  } finally {
    running.delete(app.id);
  }
}

async function release(
  ctx: AsoContext,
  workspaceId: string,
  appId: string,
  error: string,
): Promise<void> {
  const at = ctx.now();
  await ctx.db.execute(
    `UPDATE aso_app_state SET claimed_at = NULL, claimed_by = NULL, last_attempt_at = ?, last_error = ?,
            consecutive_failures = consecutive_failures + 1, backoff_until = ? WHERE app_id = ? AND workspace_id = ?`,
    [at, error, at + MIN_BACKOFF_MS, appId, workspaceId],
  );
}

async function run(
  ctx: AsoContext,
  workspaceId: string,
  app: ManagedApp,
  actor: Actor,
  trigger: AsoTrigger,
  options: AsoRefreshOptions,
): Promise<{ ok: true; result: AsoRefreshResult; state: AsoAppState } | AsoRefreshFailure> {
  const startedAt = ctx.now();
  const scope = options.scope ?? 'all';
  const dueBefore =
    options.force || ctx.limits.intervalMs <= 0
      ? Number.POSITIVE_INFINITY
      : startedAt - ctx.limits.intervalMs;
  const before = await getAsoState(ctx.db, workspaceId, app.id);
  const threshold = await rankMoveThresholdFor(ctx.db, workspaceId);
  const maxRunMs = ctx.maxRunMs ?? DEFAULT_ASO_RUN_MS;
  const ownId = storeSideId(app.platform, app);

  const result: AsoRefreshResult = {
    at: startedAt,
    keywords: { due: 0, checked: 0, ranked: 0, notRanked: 0, failed: 0, cached: 0, moved: 0 },
    competitors: { due: 0, checked: 0, changed: 0, notFound: 0, failed: 0 },
    deferred: false,
    errors: [],
    warnings: [],
  };
  const addError = (code: string) => {
    if (!result.errors.includes(code)) result.errors.push(code);
  };
  let stop: AsoRefreshResult['stoppedBecause'];
  let retryAfter: number | undefined;
  let storeLimited = false;
  let transientRun = 0;
  let attempted = 0;
  let succeeded = 0;
  const timeUp = () => ctx.now() - startedAt > maxRunMs;

  // ---- keywords
  if (scope !== 'competitors') {
    const rows = await ctx.db.query(
      `SELECT ${KEYWORD_COLUMNS} FROM aso_keywords WHERE app_id = ? AND workspace_id = ?
        AND (last_checked_at IS NULL OR last_checked_at < ?) ORDER BY COALESCE(last_checked_at, 0), created_at, id`,
      [app.id, workspaceId, Number.isFinite(dueBefore) ? dueBefore : Number.MAX_SAFE_INTEGER],
    );
    const due = rows.map(toKeyword);
    result.keywords.due = due.length;
    if (due.length > ctx.limits.maxChecksPerRun) {
      result.deferred = true;
      stop = 'cap';
    }
    for (const keyword of due.slice(0, ctx.limits.maxChecksPerRun)) {
      if (timeUp()) {
        stop = 'time';
        result.deferred = true;
        break;
      }
      if (!ownId) {
        // An iOS app whose App Store id is not known yet cannot be found in the results.
        await markKeywordFailed(ctx, workspaceId, keyword.id, 'app_not_synced');
        result.keywords.failed += 1;
        addError('app_not_synced');
        continue;
      }
      attempted += 1;
      try {
        const outcome = await ctx.sources.search({
          platform: app.platform,
          term: keyword.term,
          country: keyword.country,
          locale: keyword.locale,
          limit: ctx.limits.rankDepth,
        });
        const index = outcome.hits.findIndex((h) => h.id === ownId);
        const rank = index === -1 ? null : index + 1;
        const moved = await recordRank(ctx, workspaceId, app, keyword, {
          rank,
          total: outcome.total,
          source: byFamily(app.platform, { apple: 'apple_search', google: 'play_public' }),
          top: outcome.hits.slice(0, MAX_TOP_RESULTS),
          threshold,
        });
        result.keywords.checked += 1;
        if (outcome.cached) result.keywords.cached += 1;
        if (rank === null) result.keywords.notRanked += 1;
        else result.keywords.ranked += 1;
        if (moved) result.keywords.moved += 1;
        succeeded += 1;
        transientRun = 0;
      } catch (error) {
        const code = asoErrorCode(error);
        if (error instanceof AsoError && error.kind === 'rate_limited') {
          // Later. A store's own 429 (it has a status) is a failure with a backoff; our own limit is not.
          result.deferred = true;
          stop = 'rate_limit';
          retryAfter = error.retryAfterSeconds ?? 60;
          storeLimited = error.status !== undefined;
          if (storeLimited) addError('rate_limited');
          break;
        }
        addError(code);
        result.keywords.failed += 1;
        await markKeywordFailed(ctx, workspaceId, keyword.id, code);
        if (error instanceof AsoError && error.kind === 'unavailable') {
          result.deferred = true;
          stop = 'unavailable';
          break;
        }
        transientRun += 1;
        if (transientRun >= TRANSIENT_STOP) {
          result.deferred = true;
          stop = 'errors';
          break;
        }
      }
    }
  }

  // ---- competitors (not when a source already said to stop)
  if (scope !== 'keywords' && (stop === undefined || stop === 'cap')) {
    const rows = await ctx.db.query(
      `SELECT ${COMPETITOR_COLUMNS} FROM aso_competitors WHERE app_id = ? AND workspace_id = ?
        AND (last_checked_at IS NULL OR last_checked_at < ?) ORDER BY COALESCE(last_checked_at, 0), added_at, id`,
      [app.id, workspaceId, Number.isFinite(dueBefore) ? dueBefore : Number.MAX_SAFE_INTEGER],
    );
    result.competitors.due = rows.length;
    let competitorErrors = 0;
    for (const row of rows) {
      if (timeUp()) {
        stop = 'time';
        result.deferred = true;
        break;
      }
      const id = String(row.id);
      attempted += 1;
      try {
        const found = await ctx.sources.lookup({
          platform: app.platform,
          id: String(row.external_id),
          country: String(row.country),
          locale: defaultLocaleFor(String(row.country)),
        });
        const outcome = await recordCompetitorCheck(ctx, workspaceId, app, row, found);
        result.competitors.checked += 1;
        if (!found) result.competitors.notFound += 1;
        if (outcome.changed) result.competitors.changed += 1;
        succeeded += 1;
        competitorErrors = 0;
      } catch (error) {
        const code = asoErrorCode(error);
        if (error instanceof AsoError && error.kind === 'rate_limited') {
          result.deferred = true;
          stop = 'rate_limit';
          retryAfter = error.retryAfterSeconds ?? 60;
          storeLimited = error.status !== undefined;
          if (storeLimited) addError('rate_limited');
          break;
        }
        addError(code);
        result.competitors.failed += 1;
        await ctx.db.execute(
          'UPDATE aso_competitors SET last_state = ?, last_error = ? WHERE id = ?',
          ['unavailable', code, id],
        );
        if (error instanceof AsoError && error.kind === 'unavailable') {
          result.deferred = true;
          stop = 'unavailable';
          break;
        }
        competitorErrors += 1;
        if (competitorErrors >= TRANSIENT_STOP) {
          result.deferred = true;
          stop = 'errors';
          break;
        }
      }
    }
  }

  if (stop) result.stoppedBecause = stop;
  if (retryAfter !== undefined) result.retryAfterSeconds = retryAfter;
  if (result.keywords.failed > 0 && result.errors.includes('app_not_synced')) {
    result.warnings.push(
      'The App Store id of this app is not known yet. Sync the app first, then check its keywords.',
    );
  }

  // A run that tried and got nothing is a failure (the scheduler backs off); a run that only hit our
  // own limit, or had nothing to do, is not.
  const failed =
    attempted > 0 &&
    succeeded === 0 &&
    result.errors.length > 0 &&
    !(stop === 'rate_limit' && !storeLimited);
  const at = ctx.now();
  const failures = failed ? before.consecutiveFailures + 1 : 0;
  const wait = failed ? Math.max(asoBackoffMs(failures), (retryAfter ?? 0) * 1000) : 0;
  await ctx.db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO aso_app_state (app_id, workspace_id, last_attempt_at, last_success_at, last_error, consecutive_failures, backoff_until, last_result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (app_id) DO UPDATE SET
         last_attempt_at = excluded.last_attempt_at,
         last_success_at = COALESCE(excluded.last_success_at, aso_app_state.last_success_at),
         last_error = excluded.last_error, consecutive_failures = excluded.consecutive_failures,
         backoff_until = excluded.backoff_until, claimed_at = NULL, claimed_by = NULL, last_result = excluded.last_result`,
      [
        app.id,
        workspaceId,
        at,
        succeeded > 0 ? at : null,
        failed ? (result.errors[0] ?? 'failed').slice(0, MAX_ERROR_LENGTH) : null,
        failures,
        failed ? at + wait : null,
        JSON.stringify(result),
      ],
    );
    await recordAudit(tx, {
      workspaceId,
      actor,
      action: 'aso.refresh',
      target: { type: 'app', id: app.id },
      // Counts only: no term, no store text.
      detail: {
        ok: !failed,
        keywordsChecked: result.keywords.checked,
        keywordsFailed: result.keywords.failed,
        competitorsChecked: result.competitors.checked,
        competitorsChanged: result.competitors.changed,
        deferred: result.deferred,
        ...(stop ? { stoppedBecause: stop } : {}),
        ...trigger,
      },
      at,
    });
  });
  if (failed) {
    const failure502 = failure(
      502,
      'refresh_failed',
      'No store check could be made. The reasons are in the result.',
      { result, ...coded('aso.noStoreCheck') },
    );
    return { ...failure502, transient: result.errors.some((e) => !e.startsWith('unavailable_')) };
  }
  return { ok: true, result, state: await getAsoState(ctx.db, workspaceId, app.id) };
}

async function markKeywordFailed(
  ctx: AsoContext,
  workspaceId: string,
  id: string,
  code: string,
): Promise<void> {
  // Only the reason is kept. `last_checked_at` stays the last SUCCESSFUL check; the app level backoff
  // (aso_app_state) is what keeps a failing source from being asked again at once.
  await ctx.db.execute('UPDATE aso_keywords SET last_error = ? WHERE id = ? AND workspace_id = ?', [
    code,
    id,
    workspaceId,
  ]);
}

async function recordRank(
  ctx: AsoContext,
  workspaceId: string,
  app: ManagedApp,
  keyword: AsoKeyword,
  check: {
    rank: number | null;
    total: number;
    source: string;
    top: { id: string; name?: string }[];
    threshold: number;
  },
): Promise<boolean> {
  const at = ctx.now();
  const state: KeywordState = check.rank === null ? 'not_ranked' : 'ranked';
  const change =
    keyword.state !== null
      ? rankChange(
          { rank: keyword.rank, total: keyword.total ?? check.total },
          { rank: check.rank, total: check.total },
        )
      : null;
  const big = change !== null && isBigMove(change, check.threshold, DEFAULT_EDGE_TOP);
  await ctx.db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO aso_rank_checks (id, workspace_id, keyword_id, app_id, checked_at, rank_pos, total, source, top_results)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        workspaceId,
        keyword.id,
        app.id,
        at,
        check.rank,
        check.total,
        check.source,
        JSON.stringify(
          check.top.map((h) => (h.name ? { id: h.id, name: h.name.slice(0, 100) } : { id: h.id })),
        ),
      ],
    );
    await tx.execute(
      `UPDATE aso_keywords SET
         prev_state = last_state, prev_rank_pos = last_rank_pos,
         last_state = ?, last_rank_pos = ?, last_total = ?, last_checked_at = ?, last_error = NULL
       WHERE id = ? AND workspace_id = ?`,
      [state, check.rank, check.total, at, keyword.id, workspaceId],
    );
    if (big && change) {
      await emitEvent(tx, {
        workspaceId,
        type: 'aso.rank_changed',
        subject: { appId: app.id },
        payload: {
          appId: app.id,
          keywordId: keyword.id,
          platform: app.platform,
          country: keyword.country,
          locale: keyword.locale,
          from: change.from,
          to: change.to,
          ...(change.delta !== undefined ? { delta: change.delta } : {}),
          change: change.kind,
          threshold: check.threshold,
        },
        at,
      });
    }
  });
  return big;
}

async function recordCompetitorCheck(
  ctx: AsoContext,
  workspaceId: string,
  app: ManagedApp,
  row: Row,
  found: PublicApp | undefined,
): Promise<{ changed: boolean; listingChanges: number }> {
  const at = ctx.now();
  const competitorId = String(row.id);
  if (!found) {
    await ctx.db.execute(
      "UPDATE aso_competitors SET last_checked_at = ?, last_state = 'not_found', last_error = NULL WHERE id = ?",
      [at, competitorId],
    );
    return { changed: false, listingChanges: 0 };
  }
  const { state } = competitorStateOf(found);
  const latest = await latestSnapshotRow(ctx.db, competitorId);
  const decision = decideSnapshot(
    latest ? stateOfSnapshot(latest) : undefined,
    state,
    at,
    ctx.limits.heartbeatMs,
  );
  let watched: WatchOutcome = { changes: [], stored: false };
  await ctx.db.transaction(async (tx) => {
    if (decision.store) {
      await insertSnapshot(tx, {
        workspaceId,
        appId: app.id,
        competitorId,
        at,
        kind: decision.kind,
        app: found,
        changes: decision.changes,
      });
    }
    await tx.execute(
      "UPDATE aso_competitors SET last_checked_at = ?, last_state = 'ok', last_error = NULL, name = ? WHERE id = ?",
      [at, found.name ? found.name.slice(0, 200) : String(row.name), competitorId],
    );
    watched = await recordListingChanges(tx, {
      workspaceId,
      appId: app.id,
      competitorId,
      store: String(row.store) as ListingStore,
      country: String(row.country),
      previousState: row.listing_state,
      found,
      at,
    });
    if (decision.kind === 'change' && decision.notable) {
      await emitEvent(tx, {
        workspaceId,
        type: 'aso.competitor_changed',
        subject: { appId: app.id },
        // Ids and the names of the fields; the values are in the history.
        payload: {
          appId: app.id,
          competitorId,
          store: platformStore(app.platform),
          country: String(row.country),
          fields: decision.changes.map((c) => c.field),
        },
        at,
      });
    }
  });
  return { changed: decision.kind === 'change' || watched.stored, listingChanges: watched.changes.length };
}

/** A competitor is not checked again for this long by "Check now" (the same lookup is also cached by the sources). */
export const COMPETITOR_CHECK_MIN_INTERVAL_MS = 5 * 60_000;

export type CheckNowOutcome =
  | { ok: true; state: 'checked' | 'recent' | 'not_found'; changes: number; checkedAt: number }
  | Failure;

/**
 * "Check now" of one competitor: the same lookup, the same cache, rate limit and cool-down as the refresh, and the same recording
 * (`recordCompetitorCheck`), so a change found here is in the list, the timeline and the alerts. A competitor read in the last 5
 * minutes is not read again (`recent`). An App Store competitor only: Kiln does not read Google Play pages.
 */
export async function checkCompetitorNow(
  ctx: AsoContext,
  input: { workspaceId: string; app: ManagedApp; competitorId: string },
): Promise<CheckNowOutcome | undefined> {
  const [row] = await ctx.db.query(`SELECT ${COMPETITOR_COLUMNS} FROM aso_competitors WHERE id = ? AND app_id = ? AND workspace_id = ?`, [
    input.competitorId,
    input.app.id,
    input.workspaceId,
  ]);
  if (!row) return undefined;
  if (String(row.store) !== 'app_store')
    return failure(409, 'play_listing_not_watched', 'Kiln does not read Google Play pages, so the listing of a Google Play competitor is not watched.', coded('aso.playListingNotWatched'));
  const now = ctx.now();
  const last = nullableNumber(row.last_checked_at);
  if (last !== null && now - last < COMPETITOR_CHECK_MIN_INTERVAL_MS && row.last_state === 'ok')
    return { ok: true, state: 'recent', changes: 0, checkedAt: last };
  try {
    const found = await ctx.sources.lookup({
      platform: input.app.platform,
      id: String(row.external_id),
      country: String(row.country),
      locale: defaultLocaleFor(String(row.country)),
    });
    const outcome = await recordCompetitorCheck(ctx, input.workspaceId, input.app, row, found);
    return { ok: true, state: found ? 'checked' : 'not_found', changes: outcome.listingChanges, checkedAt: ctx.now() };
  } catch (error) {
    if (!(error instanceof AsoError && error.kind === 'rate_limited'))
      await ctx.db.execute('UPDATE aso_competitors SET last_state = ?, last_error = ? WHERE id = ?', ['unavailable', asoErrorCode(error), input.competitorId]);
    return asoFailure(error);
  }
}

// ---------------------------------------------------------------------------------------------
// As a job

export type AsoRefreshPayload = {
  workspaceId: string;
  appId: string;
  requestedBy: string;
  force?: boolean;
  scope?: 'all' | 'keywords' | 'competitors';
};

export function enqueueAsoRefresh(
  ctx: Pick<AsoContext, 'db' | 'now'>,
  payload: AsoRefreshPayload,
  options: { runAt?: number } = {},
): Promise<string> {
  return enqueue(ctx.db, ASO_REFRESH_QUEUE, payload, {
    now: ctx.now(),
    ...(options.runAt !== undefined ? { runAt: options.runAt } : {}),
  });
}

const isPayload = (value: unknown): value is AsoRefreshPayload =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as AsoRefreshPayload).workspaceId === 'string' &&
  typeof (value as AsoRefreshPayload).appId === 'string' &&
  typeof (value as AsoRefreshPayload).requestedBy === 'string';

/** The worker's handler for `aso.refresh`. A failure is recorded on the app's state with a backoff; this never throws. */
export function createAsoRefreshHandler(ctx: AsoContext): JobHandler {
  return async (payload) => {
    if (!isPayload(payload)) return;
    await refreshApp(
      ctx,
      { workspaceId: payload.workspaceId, id: payload.appId },
      { type: 'system', id: ASO_REFRESH_QUEUE },
      { trigger: 'job', requestedBy: payload.requestedBy },
      {
        ...(payload.force ? { force: true } : {}),
        ...(payload.scope ? { scope: payload.scope } : {}),
      },
    ).catch(() => undefined);
  };
}
