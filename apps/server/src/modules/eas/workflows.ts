import {
  dispatchExpoWorkflow,
  ExpoError,
  type ExpoWorkflowInputs,
  type ExpoWorkflowRun,
  expoWorkflowRun,
  normalizeGitRef,
  normalizeWorkflowFileName,
  workflowPathOf,
} from '@kiln/connectors';
import type { ActorType } from '@kiln/core';
import type { Database } from '@kiln/db';
import { enqueue, type JobHandler } from '../../jobs.ts';
import { getApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import type { TestLimiter } from '../../services/credential-tests.ts';
import { type Failure, failure, getRepository } from '../../services/repositories.ts';
import { type BuildMatcher, defaultMatchers, relinkApp } from '../ci/links.ts';
import {
  announce,
  firstLine,
  RUN_COLUMNS,
  recordDispatch,
  runViews,
  type WorkflowRunView,
} from '../ci/runs.ts';
import { expoClientFor, expoFailure } from './client.ts';
import type { EasDeps } from './index.ts';
import { getExpoLink } from './link.ts';

/**
 * EAS Workflows as a CI provider (docs/adr/0035-eas-workflows.md, docs/api/eas.md). A run started here through Expo's REST API is
 * stored in `workflow_runs` with `provider = 'eas-workflows'`, in the words of the other providers (`queued`, `in_progress`,
 * `completed` + `success`/`failure`/`cancelled`), so the runs lists, the release pipeline, the builds, the events and the alerts read it
 * like any other run. Starting a run is a write that runs the team's EAS Workflows with the team's secrets: it is `ci.dispatch`
 * (members and above), shares the CI dispatch budget per workspace, and is audited as `ci.dispatch` like a GitHub dispatch, with the
 * provider in the detail. The token is read only through `expoClientFor` (audited as `credential.use`) and never leaves it.
 *
 * Expo has no endpoint that lists runs, so only runs started here are followed: `eas.poll` reads each one until it finishes.
 */

type Actor = { type: ActorType; id: string };

export const EAS_PROVIDER = 'eas-workflows' as const;
export const EAS_WORKFLOW_PURPOSE = 'eas.workflow';
export const EAS_POLL_QUEUE = 'eas.poll';
/** A run still going this long after it was started is not followed any longer (the CI poll uses the same bound). */
export const EAS_POLL_MAX_MS = 3 * 60 * 60_000;
const POLL_FIRST_DELAY_MS = 5_000;

/** What reading and following a run needs (the poll worker has no limiter). */
export type EasRunContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  deps: EasDeps | undefined;
  /** How builds are matched to runs (`shared.ci.matchers`). */
  matchers?: readonly BuildMatcher[] | undefined;
  pollMaxMs?: number | undefined;
};

export type EasWorkflowContext = EasRunContext & {
  /** `shared.ci.limiter`: the CI dispatch budget of a workspace (dispatches per minute), shared with GitHub starts. */
  limiter: TestLimiter;
};

const sorted = (values: Iterable<string>) => [...values].sort();

export type DispatchEasInput = {
  workspaceId: string;
  appId: string;
  /** `.eas/workflows/build.yml` or `build.yml`. */
  workflow: string;
  /** A branch, tag, SHA or full ref. Default: the default branch of the app's repository. */
  ref?: string | undefined;
  inputs?: ExpoWorkflowInputs | undefined;
};

/** The failure when this app cannot run EAS workflows, else the link and the repository. */
async function target(ctx: EasRunContext, workspaceId: string, appId: string) {
  const app = await getApp(ctx.db, workspaceId, appId);
  if (!app) return failure(404, 'not_found');
  const link = await getExpoLink(ctx.db, workspaceId, appId);
  if (!link) {
    return failure(
      422,
      'expo_not_linked',
      'This app is not linked to an Expo project. Link it in the app settings first.',
    );
  }
  const repository = app.repositoryId ? await getRepository(ctx.db, workspaceId, app.repositoryId) : undefined;
  if (!repository) {
    return failure(
      422,
      'repository_required',
      'Connect this app to its repository first: EAS workflow runs are listed with the runs of the repository.',
    );
  }
  return { ok: true as const, app, link, repository };
}

/**
 * Starts a workflow run at Expo. `422` `expo_not_linked` / `repository_required` / `invalid_workflow` / `invalid_ref` /
 * `credential_*` / `expo_auth` / `expo_forbidden` / `expo_not_found` (the ref or the file) / `invalid_workflow` (Expo refused the
 * inputs); `429` (the CI dispatch budget, or Expo said to slow down); `502` `expo_unavailable`; `504` `timeout` (the run may have
 * started: look at Expo before trying again).
 */
export async function dispatchEasWorkflow(
  ctx: EasWorkflowContext,
  input: DispatchEasInput,
  actor: Actor,
): Promise<({ ok: true; run: WorkflowRunView } | Failure)> {
  const { workspaceId } = input;
  const found = await target(ctx, workspaceId, input.appId);
  if (!found.ok) return found;
  const { link, repository } = found;
  const fileName = normalizeWorkflowFileName(input.workflow);
  if (!fileName) {
    return failure(422, 'invalid_workflow', 'Name a workflow file in .eas/workflows, such as build.yml.');
  }
  const ref = normalizeGitRef(input.ref ?? repository.defaultBranch);
  if (!ref) return failure(422, 'invalid_ref', 'Use a branch, a tag or a commit.');
  const inputs = input.inputs ?? {};

  const wait = ctx.limiter.take(workspaceId);
  if (wait > 0) {
    return {
      ...failure(429, 'rate_limited', `Too many CI requests. Try again in ${wait} seconds.`, {
        retryAfterSeconds: wait,
      }),
      headers: { 'Retry-After': String(wait) },
    };
  }

  const audit = (detail: Record<string, unknown>) => ({
    workspaceId,
    actor,
    action: 'ci.dispatch',
    target: { type: 'repository', id: repository.id },
    detail: {
      provider: 'eas-workflows',
      workflow: fileName,
      ref,
      inputs: sorted(Object.keys(inputs)),
      appId: input.appId,
      ...detail,
    },
    at: ctx.now(),
  });

  const opened = await expoClientFor(ctx.db, ctx.masterKey, workspaceId, link.credentialId, ctx.deps, {
    actor,
    purpose: EAS_WORKFLOW_PURPOSE,
    now: ctx.now(),
  });
  if (!opened.ok) {
    await recordAudit(ctx.db, audit({ ok: false, code: opened.body.error }));
    return opened;
  }

  let started: { id: string; url: string | null };
  try {
    started = await dispatchExpoWorkflow(opened.client, {
      projectId: link.projectId,
      fileName,
      gitRef: ref,
      inputs,
    });
  } catch (error) {
    let failed = expoFailure(error);
    if (error instanceof ExpoError && error.kind === 'invalid_input') {
      failed = failure(422, 'invalid_workflow', error.message);
    } else if (failed.status === 504) {
      failed = failure(
        504,
        'timeout',
        'Expo did not answer in time. The workflow may still have started: look at the runs in Expo before trying again.',
      );
    }
    await recordAudit(ctx.db, audit({ ok: false, code: failed.body.error }));
    return failed;
  }

  const now = ctx.now();
  const run = await ctx.db.transaction(async (tx) => {
    const stored = await recordDispatch(tx, {
      workspaceId,
      repositoryId: repository.id,
      appId: input.appId,
      appIds: [input.appId],
      workflow: fileName,
      workflowPath: workflowPathOf(fileName),
      provider: EAS_PROVIDER,
      ref,
      inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, String(v)])),
      dispatchedBy: actor.id,
      now,
      runId: started.id,
      runUrl: started.url ?? undefined,
    });
    await recordAudit(tx, audit({ ok: true, runId: started.id }));
    return stored;
  });
  await enqueueEasPoll(
    ctx,
    { workspaceId, appId: input.appId, runId: started.id, startedAt: now, attempt: 0, requestedBy: actor.id },
    POLL_FIRST_DELAY_MS,
  );
  return { ok: true, run };
}

// ---------------------------------------------------------------------------------------------
// Stored runs

async function storedRun(
  ctx: Pick<EasWorkflowContext, 'db'>,
  workspaceId: string,
  appId: string,
  runId: string,
): Promise<WorkflowRunView | undefined> {
  const [row] = await ctx.db.query(
    `SELECT ${RUN_COLUMNS} FROM workflow_runs WHERE workspace_id = ? AND provider = ? AND run_id = ?`,
    [workspaceId, EAS_PROVIDER, runId],
  );
  if (!row) return undefined;
  const [view] = await runViews(ctx.db, [row]);
  return view && view.appIds.indexOf(appId) !== -1 ? view : undefined;
}

export const getEasRun = storedRun;

/** The EAS Workflows runs of an app, newest first (stored runs only: Expo is not called). */
export async function listEasRuns(
  ctx: Pick<EasWorkflowContext, 'db'>,
  workspaceId: string,
  appId: string,
  limit = 30,
): Promise<WorkflowRunView[]> {
  const rows = await ctx.db.query(
    `SELECT ${RUN_COLUMNS} FROM workflow_runs
      WHERE workspace_id = ? AND provider = ?
        AND id IN (SELECT run_ref FROM ci_run_apps WHERE workspace_id = ? AND app_id = ?)
      ORDER BY started_at DESC, id DESC LIMIT ?`,
    [workspaceId, EAS_PROVIDER, workspaceId, appId, Math.min(Math.max(Math.trunc(limit), 1), 100)],
  );
  return runViews(ctx.db, rows);
}

// ---------------------------------------------------------------------------------------------
// Refresh

export type EasJobView = {
  key: string;
  name: string;
  type: string;
  status: string;
  buildId: string | null;
  submissionId: string | null;
};

export type RefreshedEasRun = { run: WorkflowRunView; jobs: EasJobView[]; expoStatus: string };

/** Expo's run in the stored row: status words, commit, ref and times. Announces the finish once. */
async function storeEasRun(
  ctx: EasRunContext,
  stored: WorkflowRunView,
  read: ExpoWorkflowRun,
  workspaceId: string,
): Promise<void> {
  const now = ctx.now();
  const wasActive = stored.active;
  const finished = read.ci.status === 'completed';
  await ctx.db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE workflow_runs
          SET status = ?, conclusion = ?, head_sha = COALESCE(?, head_sha), commit_message = COALESCE(?, commit_message),
              url = COALESCE(?, url), run_updated_at = ?, synced_at = ?
        WHERE workspace_id = ? AND provider = ? AND run_id = ? AND repository_id = ?`,
      [
        read.ci.status,
        read.ci.conclusion ?? null,
        read.gitCommitHash,
        firstLine(read.gitCommitMessage ?? undefined),
        read.url,
        read.updatedAt ?? now,
        now,
        workspaceId,
        EAS_PROVIDER,
        stored.id,
        stored.repositoryId,
      ],
    );
    if (finished && wasActive) {
      await announce(
        tx,
        { workspaceId, repositoryId: stored.repositoryId, appIds: stored.appIds, runId: stored.id, at: now },
        'finished',
        read.ci.conclusion ?? null,
      );
    }
  });
  if (finished) {
    const matchers = ctx.matchers ?? defaultMatchers();
    for (const appId of stored.appIds) {
      const app = await getApp(ctx.db, workspaceId, appId);
      if (app) await relinkApp(ctx.db, { app, matchers, now });
    }
  }
}

/**
 * Reads one run from Expo and stores it. `404` when the run is not one of this app's EAS runs; `422` `expo_not_found` when Expo no
 * longer has it (it is then settled as `completed` with the conclusion `unknown`, so nothing waits for it).
 */
export async function refreshEasRun(
  ctx: EasRunContext,
  input: { workspaceId: string; appId: string; runId: string },
  actor: Actor,
): Promise<({ ok: true } & RefreshedEasRun) | Failure> {
  const { workspaceId } = input;
  const stored = await storedRun(ctx, workspaceId, input.appId, input.runId);
  if (!stored) return failure(404, 'not_found');
  const link = await getExpoLink(ctx.db, workspaceId, input.appId);
  if (!link) {
    return failure(422, 'expo_not_linked', 'This app is not linked to an Expo project. Link it in the app settings first.');
  }
  const opened = await expoClientFor(ctx.db, ctx.masterKey, workspaceId, link.credentialId, ctx.deps, {
    actor,
    purpose: EAS_WORKFLOW_PURPOSE,
    now: ctx.now(),
  });
  if (!opened.ok) return opened;
  let read: ExpoWorkflowRun;
  try {
    read = await expoWorkflowRun(opened.client, input.runId);
  } catch (error) {
    if (error instanceof ExpoError && error.kind === 'not_found' && stored.active) {
      const now = ctx.now();
      await ctx.db.transaction(async (tx) => {
        await tx.execute(
          `UPDATE workflow_runs SET status = 'completed', conclusion = 'unknown', synced_at = ?
            WHERE workspace_id = ? AND provider = ? AND run_id = ? AND repository_id = ?`,
          [now, workspaceId, EAS_PROVIDER, stored.id, stored.repositoryId],
        );
        await announce(
          tx,
          { workspaceId, repositoryId: stored.repositoryId, appIds: stored.appIds, runId: stored.id, at: now },
          'finished',
          'unknown',
        );
      });
    }
    return expoFailure(error);
  }
  await storeEasRun(ctx, stored, read, workspaceId);
  const run = (await storedRun(ctx, workspaceId, input.appId, input.runId)) as WorkflowRunView;
  return {
    ok: true,
    run,
    expoStatus: read.status,
    jobs: read.jobs.map((j) => ({
      key: j.key,
      name: j.name,
      type: j.type,
      status: j.status,
      buildId: j.buildId,
      submissionId: j.submissionId,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// eas.poll

export type EasPollPayload = {
  workspaceId: string;
  appId: string;
  /** Expo's run id. */
  runId: string;
  /** When polling began; the maximum counts from here. */
  startedAt: number;
  attempt: number;
  requestedBy: string;
};

/** 15 s, 22 s, 34 s, 51 s, then a minute (as `ci.poll`). */
export const easPollDelayMs = (attempt: number) => Math.min(Math.round(15_000 * 1.5 ** attempt), 60_000);

const isPollPayload = (v: unknown): v is EasPollPayload => {
  const p = v as Partial<EasPollPayload> | null;
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof p.workspaceId === 'string' &&
    typeof p.appId === 'string' &&
    typeof p.runId === 'string' &&
    typeof p.startedAt === 'number' &&
    typeof p.attempt === 'number' &&
    typeof p.requestedBy === 'string'
  );
};

/** Queues a read of a run, unless one is already waiting for it. */
export async function enqueueEasPoll(
  ctx: Pick<EasWorkflowContext, 'db' | 'now'>,
  payload: EasPollPayload,
  delayMs = 0,
): Promise<string | undefined> {
  const waiting = await ctx.db.query(
    "SELECT id FROM jobs WHERE queue = ? AND status = 'queued' AND payload LIKE ?",
    [EAS_POLL_QUEUE, `%"runId":"${payload.runId}"%`],
  );
  if (waiting.length > 0) return undefined;
  const now = ctx.now();
  return enqueue(ctx.db, EAS_POLL_QUEUE, payload, { now, runAt: now + delayMs });
}

/**
 * The worker's handler for `eas.poll`: reads the run, and while it is not finished queues the next read with a growing delay, until
 * `pollMaxMs` after the first. A rate limit waits for what Expo asks; a temporary failure throws so the queue retries it with backoff;
 * a permanent one (the link or the credential is gone, no access) is audited once and ends the chain.
 */
export function createEasPollHandler(ctx: EasRunContext): JobHandler {
  return async (payload) => {
    if (!isPollPayload(payload)) return;
    const { workspaceId, appId, runId } = payload;
    const actor: Actor = { type: 'system', id: EAS_POLL_QUEUE };
    const deadline = payload.startedAt + (ctx.pollMaxMs ?? EAS_POLL_MAX_MS);
    const next = (delayMs: number) => enqueueEasPoll(ctx, { ...payload, attempt: payload.attempt + 1 }, delayMs);

    const stored = await storedRun(ctx, workspaceId, appId, runId);
    if (!stored || !stored.active) return;
    const done = await refreshEasRun(ctx, { workspaceId, appId, runId }, actor);
    const now = ctx.now();
    if (!done.ok) {
      if (done.status === 429) {
        const wait = Math.max(1, Number(done.body.retryAfterSeconds ?? 60)) * 1000;
        if (now + wait < deadline) await next(wait);
        return;
      }
      if (done.status === 502 || done.status === 504) {
        throw new Error(String(done.body.message ?? done.body.error));
      }
      await recordAudit(ctx.db, {
        workspaceId,
        actor,
        action: EAS_POLL_QUEUE,
        target: { type: 'repository', id: stored.repositoryId },
        detail: { provider: EAS_PROVIDER, ok: false, code: done.body.error, runId },
        at: now,
      });
      return;
    }
    if (!done.run.active) return;
    if (now >= deadline) {
      await recordAudit(ctx.db, {
        workspaceId,
        actor,
        action: EAS_POLL_QUEUE,
        target: { type: 'repository', id: stored.repositoryId },
        detail: { provider: EAS_PROVIDER, ok: true, ended: 'max_duration', runId },
        at: now,
      });
      return;
    }
    await next(Math.min(easPollDelayMs(payload.attempt), deadline - now));
  };
}
