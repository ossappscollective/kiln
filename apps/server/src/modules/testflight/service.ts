import {
  type BetaScreenshotLink,
  StoreRateLimitError,
  type StoreBetaFeedback,
} from '@kiln/connectors';
import { supports } from '@kiln/core';
import { getApp, type ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { emitEvent } from '../../services/events.ts';
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
  assigneeNotMemberFailure,
  feedbackNotFoundFailure,
  MAX_CRASH_LOGS_PER_SYNC,
  MAX_EVENTS_PER_KIND_PER_SYNC,
  notSupportedFailure,
  TESTFLIGHT_SCREENSHOT_PURPOSE,
  TESTFLIGHT_SYNC_PURPOSE,
  type TestflightContext,
} from './shared.ts';
import {
  type BuildFacet,
  type Counts,
  type CrashGroups,
  crashesWithoutLog,
  existingIds,
  type FeedbackItem,
  type FeedbackKind,
  type FeedbackListItem,
  getFeedback,
  hasSynced,
  type ListFilter,
  listFeedback,
  readBuilds,
  readCounts,
  readCrashGroups,
  readSyncStatus,
  recordSyncFailure,
  recordSyncSuccess,
  type SyncStatus,
  type TriageInput,
  triage,
  storeCrashLog,
  upsertSubmissions,
  appleRefOf,
} from './store.ts';

/**
 * TestFlight beta feedback and crash submissions of an app (docs/api/testflight-feedback.md, docs/adr/0049-testflight-feedback.md). READ ONLY toward
 * Apple: a sync asks for the lists and the crash logs and changes nothing there. Triage (status, assignee, note) is Kiln's own data. A sync is a
 * request of a person (`reviews.sync`), counted against the same per workspace budget as the app sync, or a job queued with the review reads.
 */

export type TestflightView = {
  app: { id: string; name: string; platform: ManagedApp['platform']; store: string };
  /** False for a store with no TestFlight (Google Play): nothing is stored and a sync is refused. */
  api: boolean;
  counts: Counts;
  builds: BuildFacet[];
  items: FeedbackListItem[];
  nextCursor: string | null;
  sync: SyncStatus | null;
};

const appView = (app: ManagedApp) => ({
  id: app.id,
  name: app.name,
  platform: app.platform,
  store: storeFor(app.platform),
});

const emptyCounts = (): Counts => ({
  feedback: 0,
  crashes: 0,
  openFeedback: 0,
  openCrashes: 0,
  byStatus: { new: 0, seen: 0, in_progress: 0, resolved: 0, ignored: 0 },
});

export const encodeCursor = (c: { createdAt: number; id: string }): string =>
  Buffer.from(`${c.createdAt}:${c.id}`).toString('base64url');
export function decodeCursor(value: string): { createdAt: number; id: string } | undefined {
  const raw = Buffer.from(value, 'base64url').toString('utf8');
  const at = raw.indexOf(':');
  const createdAt = Number(raw.slice(0, at));
  const id = raw.slice(at + 1);
  return at > 0 && Number.isFinite(createdAt) && id !== '' ? { createdAt, id } : undefined;
}

export async function listTestflight(
  ctx: TestflightContext,
  input: { workspaceId: string; appId: string; filter: ListFilter; mayViewEmail: boolean },
): Promise<{ ok: true; view: TestflightView } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const api = supports(app.platform, 'testflightFeedbackApi');
  if (!api) {
    return {
      ok: true,
      view: {
        app: appView(app),
        api,
        counts: emptyCounts(),
        builds: [],
        items: [],
        nextCursor: null,
        sync: null,
      },
    };
  }
  const page = await listFeedback(ctx.db, { ...input, appId: app.id });
  return {
    ok: true,
    view: {
      app: appView(app),
      api,
      counts: await readCounts(ctx.db, input.workspaceId, app.id),
      builds: await readBuilds(ctx.db, input.workspaceId, app.id),
      items: page.items,
      nextCursor: page.next ? encodeCursor(page.next) : null,
      sync: await readSyncStatus(ctx.db, input.workspaceId, app.id),
    },
  };
}

export async function getTestflightItem(
  ctx: TestflightContext,
  input: { workspaceId: string; appId: string; id: string; mayViewEmail: boolean },
): Promise<{ ok: true; item: FeedbackItem & { crashLog: string | null } } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const item = await getFeedback(ctx.db, { ...input, appId: app.id });
  return item ? { ok: true, item } : feedbackNotFoundFailure();
}

export async function crashGroups(
  ctx: TestflightContext,
  input: { workspaceId: string; appId: string },
): Promise<{ ok: true; groups: CrashGroups } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  return { ok: true, groups: await readCrashGroups(ctx.db, input.workspaceId, app.id) };
}

export type SyncResult = {
  app: TestflightView['app'];
  feedback: number;
  crashes: number;
  added: { feedback: number; crashes: number };
  crashLogs: number;
  complete: boolean;
  warnings: string[];
  syncedAt: number;
};

type Read = {
  items: StoreBetaFeedback[];
  complete: boolean;
  warnings: string[];
  logs: Map<string, string | null>;
};

/** The sync of one app. The route has already checked the app exists and counted the request against the budget. Nothing is changed in Apple. */
export async function syncTestflight(
  ctx: TestflightContext,
  input: { workspaceId: string; appId: string; actor: Actor },
): Promise<{ ok: true; result: SyncResult } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  if (!supports(app.platform, 'testflightFeedbackApi')) return notSupportedFailure();
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
    TESTFLIGHT_SYNC_PURPOSE,
    input.actor,
  );
  if (!connected.ok) return failed(connected, true);
  const { connection } = connected;
  const baseline = !(await hasSynced(ctx.db, input.workspaceId, app.id));
  const alreadyWithoutLog = await crashesWithoutLog(
    ctx.db,
    input.workspaceId,
    app.id,
    MAX_CRASH_LOGS_PER_SYNC,
  );

  let read: Read;
  try {
    read = await withConnector(
      ctx.readFactory,
      connection.input,
      ctx.readTimeoutMs,
      async (connector): Promise<Read> => {
        if (!connector) throw new Error('no connector');
        const listed = await connector.listFeedback();
        const warnings = [...listed.warnings];
        const known = await existingIds(
          ctx.db,
          input.workspaceId,
          app.id,
          listed.items.map((i) => i.id),
        );
        // Crash logs to read: the new crashes (newest first), then stored ones still without a log, up to the cap.
        const wanted: string[] = [];
        for (const i of listed.items) if (i.kind === 'crash' && !known.has(i.id)) wanted.push(i.id);
        for (const idValue of alreadyWithoutLog)
          if (!wanted.includes(idValue)) wanted.push(idValue);
        const logs = new Map<string, string | null>();
        let skipped = 0;
        for (const idValue of wanted.slice(0, MAX_CRASH_LOGS_PER_SYNC)) {
          try {
            logs.set(idValue, await connector.readCrashLog(idValue));
          } catch (error) {
            // A rate limit stops the read of logs (the rest wait for the next sync); a refusal or any other failure leaves this one unread.
            if (error instanceof StoreRateLimitError) break;
            skipped++;
          }
        }
        if (wanted.length > MAX_CRASH_LOGS_PER_SYNC) {
          warnings.push(
            'Some crash logs are not read yet: too many in one sync. They are read by the next ones.',
          );
        }
        if (skipped > 0)
          warnings.push(
            'Some crash logs could not be read. They are tried again by the next sync.',
          );
        return { items: listed.items, complete: listed.complete, warnings, logs };
      },
    );
  } catch (error) {
    if (error instanceof StoreTimeout) return failed(timeoutFailure(), true);
    const mapped = mapStoreError(error, connection.secret);
    return failed(mapped.failure, !(error instanceof StoreRateLimitError));
  }

  const known = await existingIds(
    ctx.db,
    input.workspaceId,
    app.id,
    read.items.map((i) => i.id),
  );
  const added = { feedback: 0, crashes: 0 };
  await ctx.db.transaction(async (tx) => {
    const upserted = await upsertSubmissions(tx, {
      workspaceId: input.workspaceId,
      appId: app.id,
      items: read.items,
      existing: known,
      at,
    });
    for (const [appleId, logText] of read.logs) {
      await storeCrashLog(tx, { workspaceId: input.workspaceId, appId: app.id, appleId, logText });
    }
    for (const row of upserted.inserted) {
      if (row.item.kind === 'crash') added.crashes++;
      else added.feedback++;
    }
    await recordSyncSuccess(tx, {
      workspaceId: input.workspaceId,
      appId: app.id,
      at,
      complete: read.complete,
      warnings: read.warnings,
    });
    // Alerts: ids, build and platform only, never a comment, a tester or a log. The first read of an app (every old submission is new to Kiln)
    // raises none; later reads raise one event per new submission up to a cap per kind, then one grouped event.
    if (!baseline) {
      for (const kind of ['feedback', 'crash'] as const satisfies readonly FeedbackKind[]) {
        const fresh = upserted.inserted.filter((r) => r.item.kind === kind);
        const single = fresh.slice(0, MAX_EVENTS_PER_KIND_PER_SYNC);
        for (const r of single) {
          await emitEvent(tx, {
            workspaceId: input.workspaceId,
            type: kind === 'crash' ? 'testflight.crash' : 'testflight.feedback',
            subject: { appId: app.id },
            payload: {
              appId: app.id,
              submissionId: r.id,
              platform: app.platform,
              buildNumber: r.item.buildNumber,
              version: r.item.version,
            },
            at,
          });
        }
        if (fresh.length > single.length) {
          await emitEvent(tx, {
            workspaceId: input.workspaceId,
            type: kind === 'crash' ? 'testflight.crash' : 'testflight.feedback',
            subject: { appId: app.id },
            payload: {
              appId: app.id,
              platform: app.platform,
              grouped: true,
              count: fresh.length - single.length,
            },
            at,
          });
        }
      }
    }
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'testflight.synced',
      target: { type: 'app', id: app.id },
      // Counts only: never a comment, a tester, a log or a store response.
      detail: {
        appId: app.id,
        store: storeFor(app.platform),
        feedback: added.feedback,
        crashes: added.crashes,
        crashLogs: read.logs.size,
        complete: read.complete,
        baseline,
      },
      at,
    });
  });
  const status = await readSyncStatus(ctx.db, input.workspaceId, app.id);
  const counts = await readCounts(ctx.db, input.workspaceId, app.id);
  return {
    ok: true,
    result: {
      app: appView(app),
      feedback: counts.feedback,
      crashes: counts.crashes,
      added,
      crashLogs: read.logs.size,
      complete: status?.complete ?? read.complete,
      warnings: read.warnings,
      syncedAt: at,
    },
  };
}

export async function triageItem(
  ctx: TestflightContext,
  input: {
    workspaceId: string;
    appId: string;
    id: string;
    actor: Actor;
    changes: TriageInput;
    mayViewEmail: boolean;
  },
): Promise<{ ok: true; item: FeedbackItem } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const at = ctx.now();
  const done = await ctx.db.transaction(async (tx) => {
    const result = await triage(tx, {
      workspaceId: input.workspaceId,
      appId: app.id,
      id: input.id,
      actorId: input.actor.id,
      at,
      mayViewEmail: input.mayViewEmail,
      ...input.changes,
    });
    if (result.ok && result.changed.length > 0) {
      // Which fields changed and the status and assignee; never the note, the comment or the log.
      await recordAudit(tx, {
        workspaceId: input.workspaceId,
        actor: input.actor,
        action: 'testflight.triage',
        target: { type: 'testflight_feedback', id: result.item.id },
        detail: {
          appId: app.id,
          changed: result.changed,
          ...(result.changed.includes('status')
            ? { statusFrom: result.from.status, statusTo: result.item.status }
            : {}),
          ...(result.changed.includes('assignee')
            ? { assigneeFrom: result.from.assigneeUserId, assigneeTo: result.item.assigneeUserId }
            : {}),
        },
        at,
      });
    }
    return result;
  });
  if (!done.ok)
    return done.error === 'not_found' ? feedbackNotFoundFailure() : assigneeNotMemberFailure();
  return { ok: true, item: done.item };
}

/**
 * Fresh screenshot links of one feedback, read from Apple now. The links expire and are never stored or logged: they go to the person who
 * asked. The route has counted the request against the budget.
 */
export async function screenshotLinks(
  ctx: TestflightContext,
  input: { workspaceId: string; appId: string; id: string; actor: Actor },
): Promise<{ ok: true; screenshots: BetaScreenshotLink[] } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  if (!supports(app.platform, 'testflightFeedbackApi')) return notSupportedFailure();
  const ref = await appleRefOf(ctx.db, {
    workspaceId: input.workspaceId,
    appId: app.id,
    id: input.id,
  });
  if (!ref) return feedbackNotFoundFailure();
  if (ref.kind !== 'feedback' || ref.screenshots === 0) return { ok: true, screenshots: [] };
  const connected = await connect(
    ctx,
    input.workspaceId,
    app,
    TESTFLIGHT_SCREENSHOT_PURPOSE,
    input.actor,
  );
  if (!connected.ok) return connected;
  try {
    const screenshots = await withConnector(
      ctx.readFactory,
      connected.connection.input,
      ctx.readTimeoutMs,
      async (connector) => {
        if (!connector) throw new Error('no connector');
        return connector.readScreenshots(ref.appleId);
      },
    );
    return { ok: true, screenshots };
  } catch (error) {
    if (error instanceof StoreTimeout) return timeoutFailure();
    return mapStoreError(error, connected.connection.secret).failure;
  }
}
