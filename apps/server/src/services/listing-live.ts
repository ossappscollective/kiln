import { randomUUID } from 'node:crypto';
import type { ActorType, Platform } from '@mrm/core';
import {
  redactSecrets,
  secretStrings,
  StoreError,
  StoreRateLimitError,
  type StoreConnector,
  type StoreListing,
} from '@mrm/connectors';
import type { Database, Sql } from '@mrm/db';
import {
  ABSENT_HASH,
  classifyDrift,
  type DriftField,
  type DriftLocale,
  type DriftSide,
  type DriftSummary,
  DEFAULT_FALLBACK_LOCALE,
  emptySide,
  fieldKey,
  fieldSpec,
  flattenListing,
  hashListingValue,
  isListingField,
  type ListingSource,
  listingFieldsFor,
  sideProblems,
  splitKey,
  summarize,
} from './listing-drift.ts';

/**
 * The live store listing, its history and the three-way drift view. Read-only toward the stores:
 * the only store call is the connector's `readListing`, and everything else is the tool's own
 * database. Nothing here is audited except what the callers already audit (the use of a credential).
 *
 * `listing_snapshots` holds one row per change of a field per stream. A stream is one app,
 * platform, locale, field, channel and source. A row is written only when the hash of the
 * normalized value differs from the newest row of the same stream, so the rows of a stream are the
 * sequence of its changes and `observed_at` is when a value was first seen.
 */

type Actor = { type: ActorType; id: string };
type Row = Record<string, unknown>;

const MAX_ERROR_LENGTH = 500;
const ID_CHUNK = 300;

/** What the services here need of the app; the full `ManagedApp` satisfies it. */
export type ListingApp = { id: string; platform: Platform; identifier: string };

export type ListingStatus = {
  /** When the live listing was last read successfully. */
  listingReadAt: number | null;
  /** Why the last read failed. Cleared by the next success. Never contains a secret. */
  listingError: string | null;
  repoReadAt: number | null;
  /** The commit (or branch) the repository listing was read at. */
  repoRef: string | null;
  repoError: string | null;
};

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export async function getListingStatus(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<ListingStatus> {
  const [row] = await sql.query(
    `SELECT listing_read_at, listing_error, repo_read_at, repo_ref, repo_error
       FROM app_listing_status WHERE app_id = ? AND workspace_id = ?`,
    [appId, workspaceId],
  );
  return {
    listingReadAt: num(row?.listing_read_at),
    listingError: str(row?.listing_error),
    repoReadAt: num(row?.repo_read_at),
    repoRef: str(row?.repo_ref),
    repoError: str(row?.repo_error),
  };
}

/** Changes some columns of the status row, creating it first. Portable (no upsert syntax). */
export async function updateListingStatus(
  sql: Sql,
  workspaceId: string,
  appId: string,
  changes: Partial<{
    listing_read_at: number | null;
    listing_error: string | null;
    repo_read_at: number | null;
    repo_ref: string | null;
    repo_error: string | null;
  }>,
): Promise<void> {
  const columns = Object.keys(changes) as (keyof typeof changes)[];
  if (columns.length === 0) return;
  const values = columns.map((c) => changes[c] ?? null);
  const changed = await sql.execute(
    `UPDATE app_listing_status SET ${columns.map((c) => `${c} = ?`).join(', ')}
      WHERE app_id = ? AND workspace_id = ?`,
    [...values, appId, workspaceId],
  );
  if (changed > 0) return;
  await sql.execute(
    `INSERT INTO app_listing_status (app_id, workspace_id, ${columns.join(', ')})
     VALUES (?, ?, ${columns.map(() => '?').join(', ')})`,
    [appId, workspaceId, ...values],
  );
}

/** Removes everything the listing history holds for an app (when the app is deleted). */
export async function deleteListingData(sql: Sql, workspaceId: string, appId: string): Promise<void> {
  await sql.execute('DELETE FROM listing_snapshots WHERE app_id = ? AND workspace_id = ?', [
    appId,
    workspaceId,
  ]);
  await sql.execute('DELETE FROM app_listing_status WHERE app_id = ? AND workspace_id = ?', [
    appId,
    workspaceId,
  ]);
}

// ---------------------------------------------------------------------------------------------
// Writing snapshots

export type SnapshotMeta = {
  workspaceId: string;
  app: Pick<ListingApp, 'id' | 'platform'>;
  source: ListingSource;
  /** `live` or `editable` for the store, `default` for the others. */
  channel: string;
  sourceRef: string | null;
  observedAt: number;
  actor: Actor | null;
};

const insertRow = (
  sql: Sql,
  meta: SnapshotMeta,
  locale: string,
  field: string,
  value: string | null,
): Promise<number> =>
  sql.execute(
    `INSERT INTO listing_snapshots
       (id, workspace_id, app_id, platform, locale, field, channel, value, value_hash, source,
        source_ref, observed_at, actor_type, actor_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      meta.workspaceId,
      meta.app.id,
      meta.app.platform,
      locale,
      field,
      meta.channel,
      value,
      hashListingValue(value),
      meta.source,
      meta.sourceRef,
      meta.observedAt,
      meta.actor?.type ?? null,
      meta.actor?.id ?? null,
    ],
  );

/** The newest value hash of each field of one stream. Later rows win. */
async function streamHashes(sql: Sql, meta: SnapshotMeta): Promise<Map<string, string>> {
  const rows = await sql.query(
    `SELECT locale, field, value_hash FROM listing_snapshots
      WHERE workspace_id = ? AND app_id = ? AND source = ? AND channel = ?
      ORDER BY observed_at, id`,
    [meta.workspaceId, meta.app.id, meta.source, meta.channel],
  );
  const latest = new Map<string, string>();
  for (const r of rows) latest.set(fieldKey(String(r.locale), String(r.field)), String(r.value_hash));
  return latest;
}

export type RecordResult = { changed: number; removed: number; unchanged: number };

/**
 * Records a complete read of one stream (the live store, or the repository): a row for every field
 * whose value differs from the stream's newest row, and an "absent" row for every field the stream
 * had that this read no longer has. Run it inside a transaction.
 */
export async function recordStream(
  sql: Sql,
  meta: SnapshotMeta,
  values: readonly { locale: string; field: string; value: string }[],
): Promise<RecordResult> {
  const latest = await streamHashes(sql, meta);
  const seen = new Set<string>();
  let changed = 0;
  let unchanged = 0;
  let removed = 0;
  for (const { locale, field, value } of values) {
    const key = fieldKey(locale, field);
    seen.add(key);
    if (latest.get(key) === hashListingValue(value)) {
      unchanged++;
      continue;
    }
    await insertRow(sql, meta, locale, field, value);
    changed++;
  }
  for (const [key, hash] of latest) {
    if (seen.has(key) || hash === ABSENT_HASH) continue;
    const { locale, field } = splitKey(key);
    await insertRow(sql, meta, locale, field, null);
    removed++;
  }
  return { changed, removed, unchanged };
}

/**
 * Records what a change set changed, once per change set (the change set id is the source ref).
 * `values` are the fields the change set sets (`null`: removes). No hash comparison: a change set
 * only contains files that differed from the repository, and its place in the history is the
 * point.
 */
export async function recordChangeSetValues(
  sql: Sql,
  meta: SnapshotMeta,
  values: readonly { locale: string; field: string; value: string | null }[],
): Promise<number> {
  const [done] = await sql.query(
    `SELECT id FROM listing_snapshots WHERE app_id = ? AND workspace_id = ? AND source = ? AND source_ref = ?`,
    [meta.app.id, meta.workspaceId, 'change_set', meta.sourceRef],
  );
  if (done) return 0;
  let written = 0;
  for (const { locale, field, value } of values) {
    written += await insertRow(sql, meta, locale, field, value);
  }
  return written;
}

// ---------------------------------------------------------------------------------------------
// Reading the live listing from the store (best effort, part of the sync)

export type ListingReadContext = {
  db: Database;
  now: () => number;
  /** Longest the listing read may take (the sync's limit; it has its own budget). */
  timeoutMs: number;
};

class ListingTimeout extends Error {}

/** A failure as one safe sentence. The connectors' messages are already redacted; once more here. */
function describeFailure(error: unknown, secret: string): string {
  const clean = (text: string) =>
    redactSecrets(text, secret ? secretStrings(secret) : []).slice(0, MAX_ERROR_LENGTH);
  if (error instanceof ListingTimeout) return 'The store did not answer in time while reading the listing.';
  if (error instanceof StoreRateLimitError) return clean(error.message);
  if (error instanceof StoreError) return clean(error.message);
  return 'The listing could not be read. Try again in a moment.';
}

/** The values of one channel, as flat rows. */
const channelValues = (read: StoreListing, platform: Platform) =>
  read.channels.map((c) => ({ channel: c.channel, ref: c.versionString ?? null, values: flattenListing(c.listing, platform) }));

/**
 * Reads the live listing and records it. Never throws and never fails the release sync: a failure
 * is stored as `listing_error` of the app and returned. A connector without `readListing` (a test
 * double) is skipped without touching the status.
 *
 * The caller has the decrypted `secret` (its use was audited as `credential.use` by the sync); it
 * is not stored or logged, and every message is redacted against it.
 */
export async function syncListing(
  ctx: ListingReadContext,
  input: {
    workspaceId: string;
    app: ListingApp;
    /** Apple's numeric app id, or the package name. */
    appStoreId: string;
    /** The connector the release sync used (one connector, one token, per sync). */
    connector: StoreConnector;
    /** Cancels the request in flight (the sync's abort controller). */
    abort: () => void;
    secret: string;
    actor: Actor;
  },
): Promise<{ ok: true; recorded: number } | { ok: false; error: string } | { ok: 'skipped' }> {
  const { app, workspaceId, connector } = input;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (typeof connector.readListing !== 'function') return { ok: 'skipped' };
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        input.abort();
        reject(new ListingTimeout('timeout'));
      }, ctx.timeoutMs);
    });
    timedOut.catch(() => undefined);
    const work = connector.readListing(input.appStoreId);
    work.catch(() => undefined);
    const read = await Promise.race([work, timedOut]);
    const at = ctx.now();
    const channels = channelValues(read, app.platform);
    const recorded = await ctx.db.transaction(async (tx) => {
      const [still] = await tx.query('SELECT id FROM apps WHERE id = ? AND workspace_id = ?', [
        app.id,
        workspaceId,
      ]);
      if (!still) return 0;
      let count = 0;
      // A channel that is gone (the editable version was released) is recorded as removed.
      for (const channel of ['live', 'editable'] as const) {
        const found = channels.find((c) => c.channel === channel);
        if (!found && app.platform === 'android') continue;
        const result = await recordStream(
          tx,
          {
            workspaceId,
            app,
            source: 'store',
            channel,
            sourceRef: found?.ref ?? null,
            observedAt: at,
            actor: input.actor,
          },
          found?.values ?? [],
        );
        count += result.changed + result.removed;
      }
      await updateListingStatus(tx, workspaceId, app.id, {
        listing_read_at: at,
        listing_error: null,
      });
      return count;
    });
    return { ok: true, recorded };
  } catch (error) {
    const message = describeFailure(error, input.secret);
    try {
      await updateListingStatus(ctx.db, workspaceId, app.id, { listing_error: message });
    } catch {
      // Nothing more can be done; the release sync must not fail because of this.
    }
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------
// Reading the history

type IndexRow = {
  id: string;
  locale: string;
  field: string;
  channel: string;
  source: ListingSource;
  sourceRef: string | null;
  hash: string;
  observedAt: number;
};

/** Every row of an app without the values, oldest first. */
async function loadIndex(sql: Sql, workspaceId: string, appId: string): Promise<IndexRow[]> {
  const rows = await sql.query(
    `SELECT id, locale, field, channel, source, source_ref, value_hash, observed_at
       FROM listing_snapshots WHERE workspace_id = ? AND app_id = ?
      ORDER BY observed_at, id`,
    [workspaceId, appId],
  );
  return rows.map((r) => ({
    id: String(r.id),
    locale: String(r.locale),
    field: String(r.field),
    channel: String(r.channel),
    source: String(r.source) as ListingSource,
    sourceRef: str(r.source_ref),
    hash: String(r.value_hash),
    observedAt: Number(r.observed_at),
  }));
}

/** The values of some rows, by id (a few hundred at a time). */
async function loadValues(
  sql: Sql,
  workspaceId: string,
  appId: string,
  ids: readonly string[],
): Promise<Map<string, string | null>> {
  const found = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const rows = await sql.query(
      `SELECT id, value FROM listing_snapshots
        WHERE workspace_id = ? AND app_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`,
      [workspaceId, appId, ...chunk],
    );
    for (const r of rows) found.set(String(r.id), str(r.value));
  }
  return found;
}

/** The newest row of each field among the rows the predicate keeps (the input is oldest first). */
function newestPer(rows: readonly IndexRow[], keep: (r: IndexRow) => boolean): Map<string, IndexRow> {
  const latest = new Map<string, IndexRow>();
  for (const r of rows) if (keep(r)) latest.set(fieldKey(r.locale, r.field), r);
  return latest;
}

const isPresent = (r: IndexRow | undefined): r is IndexRow => r !== undefined && r.hash !== ABSENT_HASH;

export type LiveChannel = {
  channel: 'live' | 'editable';
  /** The store version the values were read from (App Store), when known. */
  sourceRef: string | null;
  /** The newest time any of these values was first seen. */
  observedAt: number | null;
  locales: Record<string, Record<string, string>>;
};

export type LiveListing = {
  appId: string;
  platform: Platform;
  /** When the listing was last read successfully (`null`: never). */
  readAt: number | null;
  /** Why the last read failed, or null. The values shown are then those of the last good read. */
  error: string | null;
  channels: LiveChannel[];
};

/** The latest values of the live store listing per locale and field, from the stored snapshots. */
export async function getLiveListing(
  sql: Sql,
  workspaceId: string,
  app: ListingApp,
): Promise<LiveListing> {
  const [index, status] = await Promise.all([
    loadIndex(sql, workspaceId, app.id),
    getListingStatus(sql, workspaceId, app.id),
  ]);
  const channels: { name: 'live' | 'editable'; rows: IndexRow[] }[] = [];
  for (const name of ['live', 'editable'] as const) {
    const rows = [...newestPer(index, (r) => r.source === 'store' && r.channel === name).values()].filter(isPresent);
    if (rows.length > 0) channels.push({ name, rows });
  }
  const values = await loadValues(
    sql,
    workspaceId,
    app.id,
    channels.flatMap((c) => c.rows.map((r) => r.id)),
  );
  const out: LiveChannel[] = channels.map(({ name, rows }) => {
    const locales: Record<string, Record<string, string>> = {};
    for (const r of rows) {
      const value = values.get(r.id);
      if (typeof value === 'string' && isListingField(app.platform, r.field)) {
        (locales[r.locale] ??= {})[r.field] = value;
      }
    }
    const newest = rows.reduce((a, b) => (b.observedAt >= a.observedAt ? b : a));
    return {
      channel: name,
      sourceRef: newest.sourceRef,
      observedAt: newest.observedAt,
      locales: Object.fromEntries(Object.entries(locales).sort(([a], [b]) => a.localeCompare(b))),
    };
  });
  return {
    appId: app.id,
    platform: app.platform,
    readAt: status.listingReadAt,
    error: status.listingError,
    channels: out,
  };
}

export type Drift = {
  appId: string;
  platform: Platform;
  /** Which store copy the "live" column is: `live`, or `editable` for an app that has no live version. `null`: nothing read yet. */
  channel: 'live' | 'editable' | null;
  store: { readAt: number | null; error: string | null };
  repo: { readAt: number | null; ref: string | null; error: string | null };
  summary: DriftSummary;
  locales: DriftLocale[];
};

const later = (a: IndexRow | undefined, b: IndexRow | undefined): IndexRow | undefined => {
  if (!a) return b;
  if (!b) return a;
  return b.observedAt > a.observedAt || (b.observedAt === a.observedAt && b.id > a.id) ? b : a;
};

/**
 * The three-way view per locale and field: the repository's value (the newest repository
 * snapshot), what the tool last knew (the newest of the store snapshots and applied change sets),
 * and the live store value (the newest store snapshot of the live version, or of the editable one
 * for an app that is not live yet). The status and its direction come from the whole history of the
 * field (`classifyDrift`). The repository's `default` locale (the fallback folder) fills fields a
 * locale does not set.
 */
export async function getDrift(sql: Sql, workspaceId: string, app: ListingApp): Promise<Drift> {
  const [index, status] = await Promise.all([
    loadIndex(sql, workspaceId, app.id),
    getListingStatus(sql, workspaceId, app.id),
  ]);
  const platform = app.platform;
  const repoLatest = newestPer(index, (r) => r.source === 'repo');
  const changeSetLatest = newestPer(index, (r) => r.source === 'change_set');
  const storeLive = newestPer(index, (r) => r.source === 'store' && r.channel === 'live');
  const storeEditable = newestPer(index, (r) => r.source === 'store' && r.channel === 'editable');
  const channel: Drift['channel'] = [...storeLive.values()].some(isPresent)
    ? 'live'
    : [...storeEditable.values()].some(isPresent)
      ? 'editable'
      : null;
  const storeLatest = channel === 'editable' ? storeEditable : storeLive;

  // Histories of hashes, per field.
  const repoHistory = new Map<string, string[]>();
  const storeHistory = new Map<string, Set<string>>();
  for (let i = index.length - 1; i >= 0; i--) {
    const r = index[i] as IndexRow;
    const key = fieldKey(r.locale, r.field);
    if (r.source === 'repo' || r.source === 'change_set') {
      const list = repoHistory.get(key) ?? [];
      if (!list.includes(r.hash)) list.push(r.hash);
      repoHistory.set(key, list);
    } else if (r.source === 'store' && r.channel === (channel ?? 'live')) {
      const set = storeHistory.get(key) ?? new Set<string>();
      set.add(r.hash);
      storeHistory.set(key, set);
    }
  }

  const locales = new Set<string>();
  for (const r of [...repoLatest.values(), ...storeLatest.values(), ...changeSetLatest.values()]) {
    if (isPresent(r) && r.locale !== DEFAULT_FALLBACK_LOCALE) locales.add(r.locale);
  }

  type Picked = { locale: string; field: string; repo?: IndexRow; db?: IndexRow; live?: IndexRow; repoKey: string };
  const picked: Picked[] = [];
  for (const locale of [...locales].sort((a, b) => a.localeCompare(b))) {
    for (const field of listingFieldsFor(platform)) {
      const key = fieldKey(locale, field);
      let repoKey = key;
      let repo = repoLatest.get(key);
      if (!isPresent(repo)) {
        const fallback = repoLatest.get(fieldKey(DEFAULT_FALLBACK_LOCALE, field));
        if (isPresent(fallback)) {
          repo = fallback;
          repoKey = fieldKey(DEFAULT_FALLBACK_LOCALE, field);
        }
      }
      const live = storeLatest.get(key);
      const db = later(changeSetLatest.get(key), live);
      if (!isPresent(repo) && !isPresent(live) && !isPresent(db)) continue;
      picked.push({
        locale,
        field,
        ...(repo ? { repo } : {}),
        ...(db ? { db } : {}),
        ...(live ? { live } : {}),
        repoKey,
      });
    }
  }

  const ids = new Set<string>();
  for (const p of picked) for (const r of [p.repo, p.db, p.live]) if (isPresent(r)) ids.add(r.id);
  const values = await loadValues(sql, workspaceId, app.id, [...ids]);
  const side = (r: IndexRow | undefined): DriftSide =>
    r === undefined
      ? emptySide()
      : {
          value: isPresent(r) ? (values.get(r.id) ?? null) : null,
          observedAt: r.observedAt,
          sourceRef: r.sourceRef,
          source: r.source,
        };

  const repoValues = new Map<string, string>();
  const liveValues = new Map<string, string>();
  const sides = picked.map((p) => ({ p, repo: side(p.repo), db: side(p.db), live: side(p.live) }));
  for (const { p, repo, live } of sides) {
    const key = fieldKey(p.locale, p.field);
    if (repo.value !== null) repoValues.set(key, repo.value);
    if (live.value !== null) liveValues.set(key, live.value);
  }
  const repoProblems = sideProblems(platform, repoValues);
  const liveProblems = sideProblems(platform, liveValues);

  const byLocale = new Map<string, DriftField[]>();
  for (const { p, repo, db, live } of sides) {
    const key = fieldKey(p.locale, p.field);
    const verdict = classifyDrift({
      repo: repo.value,
      live: live.value,
      repoHistory: repoHistory.get(p.repoKey) ?? [],
      liveHistory: storeHistory.get(key) ?? new Set<string>(),
    });
    const spec = fieldSpec(platform, p.field);
    const field: DriftField = {
      locale: p.locale,
      field: p.field,
      label: spec?.label ?? p.field,
      limit: spec?.maxLength ?? null,
      unit: spec?.unit ?? 'characters',
      status: verdict.status,
      ...(verdict.missingIn ? { missingIn: verdict.missingIn } : {}),
      repo,
      db,
      live,
      problems: { repo: repoProblems.get(key) ?? [], live: liveProblems.get(key) ?? [] },
    };
    const list = byLocale.get(p.locale) ?? [];
    list.push(field);
    byLocale.set(p.locale, list);
  }
  const result: DriftLocale[] = [...byLocale].map(([locale, fields]) => ({ locale, fields }));
  return {
    appId: app.id,
    platform,
    channel,
    store: { readAt: status.listingReadAt, error: status.listingError },
    repo: { readAt: status.repoReadAt, ref: status.repoRef, error: status.repoError },
    summary: summarize(result),
    locales: result,
  };
}

export type HistoryEntry = {
  id: string;
  locale: string;
  field: string;
  channel: string;
  /** `null`: the field was removed (or is absent). */
  value: string | null;
  source: ListingSource;
  /** A store version, a commit sha or a change set id. */
  sourceRef: string | null;
  observedAt: number;
  actor: { type: string; id: string } | null;
};

export type HistoryPage = { items: HistoryEntry[]; nextCursor: string | null };

export const HISTORY_DEFAULT_LIMIT = 50;
export const HISTORY_MAX_LIMIT = 200;

/** `observedAt:id`, or undefined when it is not one. */
export function parseHistoryCursor(raw: string): { observedAt: number; id: string } | undefined {
  const match = /^(\d{1,16}):([A-Za-z0-9-]{1,64})$/.exec(raw);
  return match ? { observedAt: Number(match[1]), id: match[2] as string } : undefined;
}

/** The changes of a field (or of every field), newest first, in pages. */
export async function getHistory(
  sql: Sql,
  workspaceId: string,
  app: ListingApp,
  options: {
    locale?: string | undefined;
    field?: string | undefined;
    limit: number;
    cursor?: { observedAt: number; id: string } | undefined;
  },
): Promise<HistoryPage> {
  const where = ['workspace_id = ?', 'app_id = ?'];
  const params: (string | number)[] = [workspaceId, app.id];
  if (options.locale !== undefined) {
    where.push('locale = ?');
    params.push(options.locale);
  }
  if (options.field !== undefined) {
    where.push('field = ?');
    params.push(options.field);
  }
  if (options.cursor) {
    where.push('(observed_at < ? OR (observed_at = ? AND id < ?))');
    params.push(options.cursor.observedAt, options.cursor.observedAt, options.cursor.id);
  }
  const rows = await sql.query(
    `SELECT id, locale, field, channel, value, source, source_ref, observed_at, actor_type, actor_id
       FROM listing_snapshots WHERE ${where.join(' AND ')}
      ORDER BY observed_at DESC, id DESC LIMIT ?`,
    [...params, options.limit + 1],
  );
  const page = rows.slice(0, options.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: String(r.id),
      locale: String(r.locale),
      field: String(r.field),
      channel: String(r.channel),
      value: str(r.value),
      source: String(r.source) as ListingSource,
      sourceRef: str(r.source_ref),
      observedAt: Number(r.observed_at),
      actor: r.actor_type ? { type: String(r.actor_type), id: String(r.actor_id ?? '') } : null,
    })),
    nextCursor: rows.length > options.limit && last ? `${Number(last.observed_at)}:${String(last.id)}` : null,
  };
}
