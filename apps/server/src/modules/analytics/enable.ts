import { createHash } from 'node:crypto';
import { AnalyticsError, type AppleAccessType, type AppleAnalyticsPort } from '@kiln/connectors';
import { type ActorType, analyticsErrorMessages, supports } from '@kiln/core';
import { getApp, type ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { useCredentialSecret } from '../../services/credentials.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { getSettings } from '../../services/workspace-settings.ts';
import { listReportRequests, saveReportRequest, saveSourceState, setAppleMode } from './store.ts';
import {
  ANALYTICS_SYNC_QUEUE,
  type AnalyticsContext,
  classifyAnalyticsError,
  withDeadline,
} from './sync.ts';

/**
 * "Enable Apple analytics" (docs/adr/0017-analytics-foundation.md): the ONE store write of analytics. It creates an
 * `analyticsReportRequest` at Apple, so Apple starts producing the reports (ONGOING), and optionally one ONE_TIME_SNAPSHOT for the
 * history from 2024-01-01 (Apple allows one a month). It is explicit and in two steps, like every store write here:
 *
 * 1. `previewEnable` reads what Apple already has (read only) and answers the plan: what would be created, what exists, whether the
 *    key's role may create a request, and a `confirmHash` of that plan.
 * 2. `applyEnable` needs the same hash. If the plan changed in between (someone else created a request), nothing is sent and the
 *    new plan comes back (`409 plan_changed`).
 *
 * A 403 is `analytics_role_required` (Apple lists the Admin role): the app falls back to importing a report file. Audited as
 * `analytics.enable` with ids only. Needs `analytics.manage` and the workspace setting `analytics.enabled`.
 */

type Actor = { type: ActorType; id: string };

export type EnableStep = { accessType: AppleAccessType; action: 'create' | 'adopt' | 'exists' };

export type EnablePlan = {
  appId: string;
  platform: string;
  /** Whether the key may create report requests, as far as a read can tell. */
  roleCheck: 'ok' | 'role_required';
  steps: EnableStep[];
  /** What would be sent to Apple, in words. Empty when nothing would. */
  willSend: string[];
  notes: string[];
};

export type EnablePreview = { plan: EnablePlan; confirmHash: string; canCreate: boolean };

const planHash = (
  workspaceId: string,
  appleAppId: string,
  backfill: boolean,
  plan: EnablePlan,
): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        v: 1,
        workspaceId,
        appId: plan.appId,
        appleAppId,
        backfill,
        roleCheck: plan.roleCheck,
        steps: plan.steps,
      }),
    )
    .digest('hex');

const SNAPSHOT_COOLDOWN_MS = 30 * 86_400_000;

type Prepared =
  | {
      ok: true;
      app: ManagedApp;
      port: AppleAnalyticsPort;
      preview: EnablePreview;
      known: { id: string; accessType: string; stopped: boolean }[];
    }
  | Failure;

async function prepare(
  ctx: AnalyticsContext,
  input: { workspaceId: string; appId: string; backfill: boolean },
  actor: Actor,
  fetchWith: typeof fetch,
): Promise<Prepared> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  if (!supports(app.platform, 'appleAnalyticsReports')) {
    return failure(
      422,
      'not_apple_app',
      'Analytics reports are an App Store feature. This app is not an iOS or macOS app.',
    );
  }
  const settings = (await getSettings(ctx.db, input.workspaceId)).values;
  if (settings['analytics.enabled'] !== true) {
    return failure(
      409,
      'analytics_disabled',
      'Analytics is off for this workspace. An admin turns it on in the settings (analytics.enabled).',
    );
  }
  if (!app.storeAppId) return failure(422, 'app_not_synced', analyticsErrorMessages.app_not_synced);
  let secret: string | undefined;
  try {
    secret = await useCredentialSecret(
      ctx.db,
      ctx.masterKey,
      { workspaceId: input.workspaceId, id: app.credentialId, purpose: ANALYTICS_SYNC_QUEUE },
      actor,
      ctx.now(),
    );
  } catch {
    return failure(422, 'credential_unreadable', analyticsErrorMessages.credential_unreadable);
  }
  if (secret === undefined)
    return failure(422, 'credential_not_found', analyticsErrorMessages.credential_not_found);

  const port = ctx.connectors.apple({ secret, fetch: fetchWith });
  let known: { id: string; accessType: string; stopped: boolean }[] = [];
  let roleCheck: EnablePlan['roleCheck'] = 'ok';
  try {
    known = (await port.listRequests(app.storeAppId)).map((r) => ({
      id: r.id,
      accessType: r.accessType,
      stopped: r.stoppedDueToInactivity,
    }));
  } catch (error) {
    if (error instanceof AnalyticsError && error.code === 'analytics_role_required')
      roleCheck = 'role_required';
    else {
      const c = classifyAnalyticsError(error);
      return failure(
        c.status === 504 ? 504 : c.status === 429 ? 429 : c.status === 502 ? 502 : 422,
        c.code,
        analyticsErrorMessages[c.code],
      );
    }
  }
  const local = await listReportRequests(ctx.db, input.workspaceId, app.id);
  const steps: EnableStep[] = [];
  const live = (accessType: AppleAccessType) =>
    known.find((k) => k.accessType === accessType && !k.stopped);
  const ongoing = live('ONGOING');
  const ongoingLocal = local.find(
    (r) => r.accessType === 'ONGOING' && r.status === 'active' && r.appleRequestId === ongoing?.id,
  );
  steps.push({
    accessType: 'ONGOING',
    action: ongoing ? (ongoingLocal ? 'exists' : 'adopt') : 'create',
  });
  if (input.backfill) {
    const snapshot = known.find((k) => k.accessType === 'ONE_TIME_SNAPSHOT');
    const recent = local.find(
      (r) => r.accessType === 'ONE_TIME_SNAPSHOT' && ctx.now() - r.createdAt < SNAPSHOT_COOLDOWN_MS,
    );
    const snapshotLocal = local.find(
      (r) => r.accessType === 'ONE_TIME_SNAPSHOT' && r.appleRequestId === snapshot?.id,
    );
    steps.push({
      accessType: 'ONE_TIME_SNAPSHOT',
      action: recent || snapshotLocal ? 'exists' : snapshot ? 'adopt' : 'create',
    });
  }
  const notes = [
    'Apple keeps each daily report for 35 days and then deletes it, so this server stores the numbers it reads.',
    'The first reports appear one to two days after the request.',
  ];
  if (input.backfill)
    notes.push(
      'A one-time snapshot brings history from 2024-01-01. Apple allows one snapshot request a month.',
    );
  if (roleCheck === 'role_required') {
    notes.push(
      'The App Store Connect key may not create report requests (Apple lists the Admin role). Use an Admin key once, or import a report file instead.',
    );
  }
  const plan: EnablePlan = {
    appId: app.id,
    platform: app.platform,
    roleCheck,
    steps,
    willSend: steps
      .filter((s) => s.action === 'create')
      .map(
        (s) =>
          `Create an analytics report request (${s.accessType}) for this app at App Store Connect.`,
      ),
    notes,
  };
  return {
    ok: true,
    app,
    port,
    known,
    preview: {
      plan,
      confirmHash: planHash(input.workspaceId, app.storeAppId, input.backfill, plan),
      canCreate: roleCheck === 'ok',
    },
  };
}

/** Reads what Apple has and answers what enabling would do. Sends nothing that changes anything. */
export async function previewEnable(
  ctx: AnalyticsContext,
  input: { workspaceId: string; appId: string; backfill: boolean },
  actor: Actor,
): Promise<({ ok: true } & EnablePreview) | Failure> {
  const prepared = await withDeadline(ctx.timeoutMs, (f) => prepare(ctx, input, actor, f)).catch(
    (error): Failure => {
      const c = classifyAnalyticsError(error);
      return failure(c.status === 504 ? 504 : 502, c.code, analyticsErrorMessages[c.code]);
    },
  );
  if (!prepared.ok) return prepared;
  return { ok: true, ...prepared.preview };
}

export type EnableResult = {
  ok: true;
  steps: (EnableStep & { appleRequestId: string })[];
  appleMode: 'ongoing';
};

/** Creates what the plan says, if the plan is still the one the person saw. */
export async function applyEnable(
  ctx: AnalyticsContext,
  input: { workspaceId: string; appId: string; backfill: boolean; confirmHash: string },
  actor: Actor,
): Promise<EnableResult | (Failure & { plan?: EnablePlan })> {
  return withDeadline(ctx.timeoutMs, async (f): Promise<EnableResult | Failure> => {
    const prepared = await prepare(ctx, input, actor, f);
    if (!prepared.ok) return prepared;
    const { app, port, preview, known } = prepared;
    if (preview.confirmHash !== input.confirmHash) {
      return {
        ...failure(
          409,
          'plan_changed',
          'What Apple has changed since the preview. Review the new plan and confirm it.',
        ),
        body: {
          error: 'plan_changed',
          message: 'What Apple has changed since the preview. Review the new plan and confirm it.',
          plan: preview.plan,
          confirmHash: preview.confirmHash,
        },
      };
    }
    const startedBy = actor.id;
    if (preview.plan.roleCheck === 'role_required') {
      await saveSourceState(ctx.db, {
        workspaceId: input.workspaceId,
        appId: app.id,
        platform: app.platform,
        source: 'apple_analytics',
        now: ctx.now(),
        ok: false,
        errorCode: 'analytics_role_required',
      });
      return {
        ...failure(422, 'analytics_role_required', analyticsErrorMessages.analytics_role_required),
        body: {
          error: 'analytics_role_required',
          message: analyticsErrorMessages.analytics_role_required,
          nextStep: 'import_apple_report',
        },
      };
    }
    const done: (EnableStep & { appleRequestId: string })[] = [];
    let problem: Failure | undefined;
    for (const step of preview.plan.steps) {
      try {
        let appleRequestId: string | undefined;
        if (step.action === 'create')
          appleRequestId = (await port.createRequest(app.storeAppId ?? '', step.accessType)).id;
        else if (step.action === 'adopt')
          appleRequestId =
            known.find((k) => k.accessType === step.accessType && !k.stopped)?.id ??
            known.find((k) => k.accessType === step.accessType)?.id;
        else
          appleRequestId = (await listReportRequests(ctx.db, input.workspaceId, app.id)).find(
            (r) => r.accessType === step.accessType,
          )?.appleRequestId;
        if (!appleRequestId) continue;
        if (step.action !== 'exists') {
          await saveReportRequest(ctx.db, {
            workspaceId: input.workspaceId,
            appId: app.id,
            appleRequestId,
            accessType: step.accessType,
            createdBy: startedBy,
            now: ctx.now(),
          });
        }
        done.push({ ...step, appleRequestId });
      } catch (error) {
        const c = classifyAnalyticsError(error);
        await saveSourceState(ctx.db, {
          workspaceId: input.workspaceId,
          appId: app.id,
          platform: app.platform,
          source: 'apple_analytics',
          now: ctx.now(),
          ok: false,
          errorCode: c.code,
        });
        problem = {
          ...failure(
            c.status === 504 ? 504 : c.status === 429 ? 429 : c.status === 502 ? 502 : 422,
            c.code,
            analyticsErrorMessages[c.code],
          ),
          body: {
            error: c.code,
            message: analyticsErrorMessages[c.code],
            ...(c.code === 'analytics_role_required' ? { nextStep: 'import_apple_report' } : {}),
          },
        };
        break;
      }
    }
    const at = ctx.now();
    if (done.some((d) => d.accessType === 'ONGOING')) {
      await setAppleMode(ctx.db, {
        workspaceId: input.workspaceId,
        appId: app.id,
        mode: 'ongoing',
        by: startedBy,
        now: at,
      });
      await saveSourceState(ctx.db, {
        workspaceId: input.workspaceId,
        appId: app.id,
        platform: app.platform,
        source: 'apple_analytics',
        now: at,
        ok: true,
        attempted: false,
      });
    }
    // Ids only: the app, the kind of each request and the id Apple gave it.
    await recordAudit(ctx.db, {
      workspaceId: input.workspaceId,
      actor,
      action: 'analytics.enable',
      target: { type: 'app', id: app.id },
      detail: {
        ok: problem === undefined,
        steps: done.map((d) => ({
          accessType: d.accessType,
          action: d.action,
          appleRequestId: d.appleRequestId,
        })),
        backfill: input.backfill,
        ...(problem ? { code: problem.body.error } : {}),
      },
      at,
    });
    if (problem) return problem;
    return { ok: true, steps: done, appleMode: 'ongoing' };
  }).catch((error): Failure => {
    const c = classifyAnalyticsError(error);
    return failure(c.status === 504 ? 504 : 502, c.code, analyticsErrorMessages[c.code]);
  });
}
