import { StoreRateLimitError } from '@kiln/connectors';
import { supports } from '@kiln/core';
import { coded } from '../../i18n/problem.ts';
import { getApp, type ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import {
  type Actor,
  connect,
  mapStoreError,
  StoreTimeout,
  timeoutFailure,
  withConnector,
} from '../monetization/shared.ts';
import { storeFor } from '../reviews/sync.ts';
import {
  type CreateNote,
  countNotes,
  datesProblem,
  deleteNote,
  getNote,
  insertNote,
  listNotes,
  merged,
  type NoteView,
  saveNote,
  type UpdateNote,
} from './notes.ts';
import {
  EXPERIMENTS_SYNC_PURPOSE,
  type ExperimentsContext,
  MAX_NOTES_PER_APP,
  noteNotFoundFailure,
  notSupportedFailure,
  tooManyNotesFailure,
} from './shared.ts';
import {
  type CustomPageView,
  type ExperimentsSyncStatus,
  type ExperimentView,
  listStored,
  readSyncStatus,
  recordSyncFailure,
  replaceSnapshot,
} from './snapshot.ts';

/**
 * Store experiments and custom product pages of an app (docs/api/experiments.md, docs/adr/0048-store-experiments.md). READ ONLY toward the store:
 * a sync asks Apple for the lists and changes nothing there; Google Play has no API for them, so its app has the manual tracker. A sync is a
 * request of a person (`apps.sync`), counted against the same per workspace budget as the app sync. A failed sync keeps the last good copy.
 */

export type ExperimentsView = {
  app: { id: string; name: string; platform: ManagedApp['platform']; store: string };
  /** False for a store whose API has no experiments (Google Play): the lists are empty and a sync is refused; the tracker still works. */
  api: boolean;
  experiments: ExperimentView[];
  customPages: CustomPageView[];
  /** Null before the first sync. */
  sync: ExperimentsSyncStatus | null;
  notes: NoteView[];
  limits: { notes: number };
};

const appView = (app: ManagedApp) => ({
  id: app.id,
  name: app.name,
  platform: app.platform,
  store: storeFor(app.platform),
});

export async function listExperiments(
  ctx: ExperimentsContext,
  input: { workspaceId: string; appId: string },
): Promise<{ ok: true; view: ExperimentsView } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const api = supports(app.platform, 'storeExperimentsApi');
  const stored = api
    ? await listStored(ctx.db, input.workspaceId, app.id)
    : { experiments: [], customPages: [] };
  return {
    ok: true,
    view: {
      app: appView(app),
      api,
      ...stored,
      sync: api ? await readSyncStatus(ctx.db, input.workspaceId, app.id) : null,
      notes: await listNotes(ctx.db, input.workspaceId, app.id),
      limits: { notes: MAX_NOTES_PER_APP },
    },
  };
}

export type SyncResult = {
  app: ExperimentsView['app'];
  experiments: number;
  customPages: number;
  complete: boolean;
  warnings: string[];
  syncedAt: number;
};

const readAll = (
  ctx: ExperimentsContext,
  input: Parameters<typeof withConnector>[1],
): Promise<import('@kiln/connectors').ListExperimentsResult> =>
  withConnector(ctx.readFactory, input, ctx.readTimeoutMs, async (connector) => {
    if (!connector) throw new Error('no connector');
    return connector.listExperiments();
  });

/** The sync of one app. The route has already checked the app exists and counted the request against the budget. Nothing is changed in the store. */
export async function syncExperiments(
  ctx: ExperimentsContext,
  input: { workspaceId: string; appId: string; actor: Actor },
): Promise<{ ok: true; result: SyncResult } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  if (!supports(app.platform, 'storeExperimentsApi')) return notSupportedFailure();
  const at = ctx.now();
  const failed = async (f: Failure, record: boolean): Promise<Failure> => {
    if (record) {
      await recordSyncFailure(ctx.db, {
        workspaceId: input.workspaceId,
        appId: app.id,
        message: String(f.body.message ?? f.body.error),
        at,
      });
    }
    return f;
  };

  const connected = await connect(
    ctx,
    input.workspaceId,
    app,
    EXPERIMENTS_SYNC_PURPOSE,
    input.actor,
  );
  if (!connected.ok) return failed(connected, true);
  const { connection } = connected;
  let result: Awaited<ReturnType<typeof readAll>>;
  try {
    result = await readAll(ctx, connection.input);
  } catch (error) {
    if (error instanceof StoreTimeout) return failed(timeoutFailure(), true);
    const mapped = mapStoreError(error, connection.secret);
    return failed(mapped.failure, !(error instanceof StoreRateLimitError));
  }

  await ctx.db.transaction(async (tx) => {
    await replaceSnapshot(tx, { workspaceId: input.workspaceId, appId: app.id, result, at });
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'experiments.synced',
      target: { type: 'app', id: app.id },
      // Counts only: never a name, a text or a store response.
      detail: {
        appId: app.id,
        store: storeFor(app.platform),
        experiments: result.experiments.length,
        customPages: result.customPages.length,
        complete: result.complete,
        warnings: result.warnings.length,
      },
      at,
    });
  });
  return {
    ok: true,
    result: {
      app: appView(app),
      experiments: result.experiments.length,
      customPages: result.customPages.length,
      complete: result.complete,
      warnings: result.warnings,
      syncedAt: at,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The manual tracker

const datesFailure = (message: string): Failure =>
  failure(422, 'invalid_dates', message, coded('experiments.datesOrder'));

export async function createNote(
  ctx: ExperimentsContext,
  input: { workspaceId: string; appId: string; actor: Actor; note: CreateNote },
): Promise<{ ok: true; note: NoteView } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const problem = datesProblem(input.note.startedOn ?? null, input.note.endedOn ?? null);
  if (problem) return datesFailure(problem);
  if ((await countNotes(ctx.db, input.workspaceId, app.id)) >= MAX_NOTES_PER_APP) {
    return tooManyNotesFailure();
  }
  const at = ctx.now();
  const note = await ctx.db.transaction(async (tx) => {
    const created = await insertNote(tx, {
      workspaceId: input.workspaceId,
      appId: app.id,
      actorId: input.actor.id,
      at,
      note: input.note,
    });
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'experiments.note_created',
      target: { type: 'app', id: app.id },
      detail: { appId: app.id, noteId: created.id, kind: created.kind, status: created.status },
      at,
    });
    return created;
  });
  return { ok: true, note };
}

export async function updateNote(
  ctx: ExperimentsContext,
  input: { workspaceId: string; appId: string; noteId: string; actor: Actor; changes: UpdateNote },
): Promise<{ ok: true; note: NoteView } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const current = await getNote(ctx.db, input.workspaceId, app.id, input.noteId);
  if (!current) return noteNotFoundFailure();
  const at = ctx.now();
  const next = merged(current, input.changes, at);
  const problem = datesProblem(next.startedOn, next.endedOn);
  if (problem) return datesFailure(problem);
  await ctx.db.transaction(async (tx) => {
    await saveNote(tx, input.workspaceId, app.id, next);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'experiments.note_updated',
      target: { type: 'app', id: app.id },
      detail: { appId: app.id, noteId: next.id, status: next.status },
      at,
    });
  });
  return { ok: true, note: next };
}

export async function removeNote(
  ctx: ExperimentsContext,
  input: { workspaceId: string; appId: string; noteId: string; actor: Actor },
): Promise<{ ok: true } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const current = await getNote(ctx.db, input.workspaceId, app.id, input.noteId);
  if (!current) return noteNotFoundFailure();
  const at = ctx.now();
  await ctx.db.transaction(async (tx) => {
    await deleteNote(tx, input.workspaceId, app.id, current.id);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'experiments.note_deleted',
      target: { type: 'app', id: app.id },
      detail: { appId: app.id, noteId: current.id },
      at,
    });
  });
  return { ok: true };
}
