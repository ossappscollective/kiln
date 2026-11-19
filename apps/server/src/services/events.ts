import type { Row, Sql } from '@mrm/db';
import { type EventType, eventTypes, isEventType } from './event-types.ts';
import { queueWebhookDeliveries } from './webhooks.ts';

export { type EventType, eventTypes, isEventType };

/**
 * The event log: a row per thing that happened in a workspace, written by the services, read
 * through `GET /api/workspaces/:id/events` and its server-sent stream, and pushed to webhooks.
 *
 * Other code adopts it with one call: `emitEvent(db, { workspaceId, type, subject, payload })`.
 * Pass the transaction (`tx`) when the thing that happened is written in one, so the event exists
 * only if the change does. Never call it with the Database from inside a transaction callback:
 * SQLite would wait for the transaction to end. A payload never holds a secret (see `redactPayload`).
 */

/** What an event is about. All parts are optional; an event can name an app, a repository or both. */
export type EventSubject = { appId?: string; repositoryId?: string; releaseId?: string };

export type EmitInput = {
  workspaceId: string;
  type: EventType;
  subject?: EventSubject;
  /** Plain JSON, no secrets. Keys that look like secrets are dropped, and the whole is capped. */
  payload?: Record<string, unknown>;
  /** Epoch milliseconds. Default: now. */
  at?: number;
};

export type EventRecord = {
  /** Increases with every event of the instance. The cursor for paging and for Last-Event-ID. */
  id: number;
  workspaceId: string;
  type: EventType;
  subject: EventSubject;
  payload: Record<string, unknown>;
  createdAt: number;
};

/** Larger payloads are replaced by a short marker; an event is a pointer, not a data transfer. */
export const MAX_PAYLOAD_BYTES = 16 * 1024;
const SECRET_KEY = /secret|token|password|passwd|ciphertext|authorization|private_?key|api_?key|credential_?json/i;

/**
 * Defence in depth: callers must not put secrets in a payload, and keys that look like one are
 * removed anyway. Only plain JSON survives (functions, symbols and undefined are dropped).
 */
export function redactPayload(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (depth > 6) return null;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactPayload(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key) || item === undefined || typeof item === 'function') continue;
      out[key] = redactPayload(item, depth + 1);
    }
    return out;
  }
  return null;
}

function encodePayload(payload: Record<string, unknown> | undefined): string {
  const text = JSON.stringify(redactPayload(payload ?? {}));
  return text.length > MAX_PAYLOAD_BYTES ? JSON.stringify({ truncated: true }) : text;
}

// ---------------------------------------------------------------------------------------------
// In-process wake-up for live streams

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();

/**
 * Calls `listener` soon after an event of the workspace was written by this process. It is only a
 * nudge to look at the table again: the stream reads the table, so an event written by another
 * process (a worker run apart from the server) is found by the stream's slower poll.
 */
export function subscribeToEvents(workspaceId: string, listener: Listener): () => void {
  let set = listeners.get(workspaceId);
  if (!set) {
    set = new Set();
    listeners.set(workspaceId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(workspaceId) === set) listeners.delete(workspaceId);
  };
}

function wake(workspaceId: string): void {
  const set = listeners.get(workspaceId);
  if (!set || set.size === 0) return;
  // A moment later, so a transaction that wrote the event has usually committed when they look.
  const timer = setTimeout(() => {
    for (const listener of [...(listeners.get(workspaceId) ?? [])]) {
      try {
        listener();
      } catch {
        // A broken stream must not break the emitter.
      }
    }
  }, 25);
  timer.unref?.();
}

// ---------------------------------------------------------------------------------------------
// Writing

export async function emitEvent(sql: Sql, input: EmitInput): Promise<EventRecord> {
  const at = input.at ?? Date.now();
  const subject = input.subject ?? {};
  const payload = encodePayload(input.payload);
  const [row] = await sql.query(
    `INSERT INTO events (workspace_id, type, app_id, repository_id, release_id, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      input.workspaceId,
      input.type,
      subject.appId ?? null,
      subject.repositoryId ?? null,
      subject.releaseId ?? null,
      payload,
      at,
    ],
  );
  const record: EventRecord = {
    id: Number(row?.id),
    workspaceId: input.workspaceId,
    type: input.type,
    subject: {
      ...(subject.appId ? { appId: subject.appId } : {}),
      ...(subject.repositoryId ? { repositoryId: subject.repositoryId } : {}),
      ...(subject.releaseId ? { releaseId: subject.releaseId } : {}),
    },
    payload: JSON.parse(payload) as Record<string, unknown>,
    createdAt: at,
  };
  await queueWebhookDeliveries(sql, record);
  wake(input.workspaceId);
  return record;
}

// ---------------------------------------------------------------------------------------------
// Reading

const toRecord = (r: Row): EventRecord => ({
  id: Number(r.id),
  workspaceId: String(r.workspace_id),
  type: String(r.type) as EventType,
  subject: {
    ...(r.app_id ? { appId: String(r.app_id) } : {}),
    ...(r.repository_id ? { repositoryId: String(r.repository_id) } : {}),
    ...(r.release_id ? { releaseId: String(r.release_id) } : {}),
  },
  payload: JSON.parse(String(r.payload)) as Record<string, unknown>,
  createdAt: Number(r.created_at),
});

export const MAX_EVENTS_LIMIT = 200;
export const DEFAULT_EVENTS_LIMIT = 50;

export type EventFilter = {
  /** Only events with an id above this. Without it: the newest `limit` events. */
  since?: number;
  limit?: number;
  types?: readonly string[];
  /** Only events about these apps (an app scoped token). Events about no app are left out. */
  appIds?: readonly string[];
};

export async function listEvents(
  sql: Sql,
  workspaceId: string,
  filter: EventFilter = {},
): Promise<{ events: EventRecord[]; hasMore: boolean }> {
  const limit = Math.trunc(Math.min(Math.max(filter.limit ?? DEFAULT_EVENTS_LIMIT, 1), MAX_EVENTS_LIMIT));
  const where = ['workspace_id = ?'];
  const params: (string | number)[] = [workspaceId];
  if (filter.since !== undefined) {
    where.push('id > ?');
    params.push(filter.since);
  }
  if (filter.types && filter.types.length > 0) {
    where.push(`type IN (${filter.types.map(() => '?').join(', ')})`);
    params.push(...filter.types);
  }
  if (filter.appIds) {
    if (filter.appIds.length === 0) return { events: [], hasMore: false };
    where.push(`app_id IN (${filter.appIds.map(() => '?').join(', ')})`);
    params.push(...filter.appIds);
  }
  const order = filter.since === undefined ? 'DESC' : 'ASC';
  const rows = await sql.query(
    `SELECT id, workspace_id, type, app_id, repository_id, release_id, payload, created_at
       FROM events WHERE ${where.join(' AND ')} ORDER BY id ${order} LIMIT ?`,
    [...params, limit + 1],
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(toRecord);
  return { events: order === 'DESC' ? page.reverse() : page, hasMore };
}

/** The id of the newest event of the workspace, or 0. */
export async function latestEventId(sql: Sql, workspaceId: string): Promise<number> {
  const [row] = await sql.query('SELECT MAX(id) AS id FROM events WHERE workspace_id = ?', [workspaceId]);
  return Number(row?.id ?? 0);
}

/** Drops events older than `keepMs`. Called at start-up; the log is a feed, not an archive. */
export async function pruneEvents(sql: Sql, now: number, keepMs = 90 * 24 * 60 * 60 * 1000): Promise<number> {
  return sql.execute('DELETE FROM events WHERE created_at < ?', [now - keepMs]);
}

// ---------------------------------------------------------------------------------------------
// Events that follow from audited actions
//
// Change sets and credential tests already record an audit event at the moment they happen, in
// the same transaction. `recordAudit` calls this, so those events cannot be forgotten by a code
// path and nobody has to touch the services that own them. Anything not in this table is emitted
// by its own service (see `recordSyncEvents` for syncs).

type AuditLike = {
  workspaceId: string;
  actor: { type: string; id: string };
  action: string;
  target?: { type: string; id: string };
  detail?: Record<string, unknown>;
  at: number;
};

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

export function eventFromAudit(audit: AuditLike): EmitInput | undefined {
  const detail = audit.detail ?? {};
  const base = { workspaceId: audit.workspaceId, at: audit.at };
  const actor = { type: audit.actor.type, id: audit.actor.id };
  const repositoryId = text(detail.repositoryId);
  const subject: EventSubject = repositoryId ? { repositoryId } : {};
  const changeSetId = audit.target?.type === 'change_set' ? audit.target.id : undefined;
  switch (audit.action) {
    case 'changeset.create':
      return { ...base, type: 'changeset.created', subject, payload: { changeSetId, files: detail.files, actor } };
    case 'changeset.approve':
      return { ...base, type: 'changeset.approved', subject, payload: { changeSetId, actor } };
    case 'changeset.apply':
    case 'changeset.apply_local':
      return {
        ...base,
        type: 'changeset.applied',
        subject,
        payload: {
          changeSetId,
          branch: detail.branch ?? null,
          prNumber: detail.prNumber ?? null,
          prUrl: detail.prUrl ?? null,
          commitSha: detail.commitSha ?? null,
          actor,
        },
      };
    case 'changeset.apply_failed':
    case 'changeset.apply_timeout':
      return {
        ...base,
        type: 'changeset.failed',
        subject,
        payload: {
          changeSetId,
          reason: audit.action === 'changeset.apply_timeout' ? 'timeout' : (text(detail.reason) ?? 'unknown'),
          actor,
        },
      };
    case 'credential.test':
      if (detail.ok !== false) return undefined;
      return {
        ...base,
        type: 'credential.test_failed',
        payload: {
          credentialId: audit.target?.type === 'credential' ? audit.target.id : null,
          kind: text(detail.kind) ?? null,
          saved: audit.target?.type === 'credential',
          actor,
        },
      };
    case 'step_up.verified':
      return { ...base, type: 'stepup.verified', payload: { userId: audit.actor.id, factor: text(detail.factor) ?? null, action: text(detail.action) ?? null, targetId: text(detail.targetId) ?? null } };
    case 'step_up.failed':
      return {
        ...base,
        type: 'stepup.failed',
        payload: { userId: audit.actor.id, factor: text(detail.factor) ?? null, action: text(detail.action) ?? null, reason: text(detail.reason) ?? null, failedCount: typeof detail.failedCount === 'number' ? detail.failedCount : null },
      };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Store sync

export type SyncedRelease = {
  status: string | null;
  version: string;
  track: string;
  build: string | null;
};

export type ReleaseStatusChange = {
  releaseId: string | null;
  version: string;
  track: string;
  build: string | null;
  from: string | null;
  to: string | null;
};

/**
 * What a sync changed in the normalized status of releases, by diffing the rows that were there
 * (`before`, keyed by track and version as in `syncApp`) with what the store reported (`after`).
 * A release that is new is reported only when `baselined` (the app was synced before), with
 * `from: null`, so the first sync of an app is a quiet baseline and not a flood of events.
 */
export function releaseStatusChanges(
  before: ReadonlyMap<string, Record<string, unknown>>,
  after: ReadonlyMap<string, SyncedRelease>,
  baselined: boolean,
): ReleaseStatusChange[] {
  const changes: ReleaseStatusChange[] = [];
  for (const [key, release] of after) {
    const old = before.get(key);
    if (!old) {
      if (baselined && release.status !== null) {
        changes.push({ releaseId: null, ...pick(release), from: null, to: release.status });
      }
      continue;
    }
    const from = old.status === null || old.status === undefined ? null : String(old.status);
    if (from !== release.status) {
      changes.push({ releaseId: String(old.id), ...pick(release), from, to: release.status });
    }
  }
  return changes;
}

const pick = (r: SyncedRelease) => ({ version: r.version, track: r.track, build: r.build });

/** Most status changes one sync emits as events; the `app.synced` payload says when it cut. */
export const MAX_STATUS_EVENTS_PER_SYNC = 50;

/** The one call `syncApp` makes inside its transaction: a status event per change, then `app.synced`. */
export async function recordSyncEvents(
  sql: Sql,
  input: {
    workspaceId: string;
    appId: string;
    at: number;
    summary: { found: number; added: number; updated: number; removed: number; unmapped: number };
    changes: ReleaseStatusChange[];
    trigger?: string;
  },
): Promise<void> {
  const emitted = input.changes.slice(0, MAX_STATUS_EVENTS_PER_SYNC);
  for (const change of emitted) {
    await emitEvent(sql, {
      workspaceId: input.workspaceId,
      type: 'app.release.status_changed',
      subject: { appId: input.appId, ...(change.releaseId ? { releaseId: change.releaseId } : {}) },
      payload: { version: change.version, track: change.track, build: change.build, from: change.from, to: change.to },
      at: input.at,
    });
  }
  await emitEvent(sql, {
    workspaceId: input.workspaceId,
    type: 'app.synced',
    subject: { appId: input.appId },
    payload: {
      ...input.summary,
      statusChanges: input.changes.length,
      statusChangesTruncated: input.changes.length > emitted.length,
      trigger: input.trigger ?? 'request',
    },
    at: input.at,
  });
}
