import { randomUUID } from 'node:crypto';
import {
  type Platform,
  PUBLISH_CLAIM_TTL_MS,
  PUBLISH_HEARTBEAT_MS,
  PUBLISH_SILENT_AFTER_MS as SILENT_AFTER_MS,
  PUBLISH_STUCK_AFTER_MS as STUCK_AFTER_MS,
} from '@kiln/core';
import type { Database, Sql } from '@kiln/db';
import type { Context, Next } from 'hono';
import type { AppEnv } from '../../http.ts';
import { coded } from '../../i18n/problem.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import type { PublishStep } from './pending.ts';
import { type RunStep, recordRun } from './publish-runs.ts';

/**
 * What a running batch publish looks like from outside (docs/api/pending.md "Publishing now"). The claim row of `store_publish_claims`
 * (migration 29) already said "a publish is running for this app"; migration 71 adds WHICH steps it runs, which one runs now, and a
 * heartbeat. Everything here is a read or a write of that one row, so it is true across processes (a second server instance sees what
 * the first one is doing). Ids, step names and times only: never a text, a credential or a store answer.
 *
 * Expiry. A claim whose last heartbeat (`heartbeat_at`, else `step_at`, else `claim_at`) is older than the time to live is a process that
 * died: it is not reported as running and does not block anything (the same rule `takeClaim` uses to take it over). A running batch
 * renews the heartbeat by a timer every 20 seconds, also while a step waits for the store (migration 74), so the time to live can be
 * short (2 minutes): a step of any length is never mistaken for a dead one, and a dead one is seen as dead soon.
 *
 * Ghosts. A claim belongs to the server process that took it (`instance_id`, a boot id). A server that starts again finds the claims of
 * the process before it (`reapPreviousProcessClaims`): the step they were running is gone, so each one is turned into a kept run whose
 * running step ended `interrupted` with an unknown outcome, never left reading as "running". A claim that falls silent is turned into
 * the same run when somebody reads or takes it (`reapDeadClaims`), and a person can end one that still beats but cannot be right any more
 * (`interruptPublish`).
 */

/** A batch that has not renewed its heartbeat for this long is a process that died. */
export const DEFAULT_PUBLISH_CLAIM_TTL_MS = PUBLISH_CLAIM_TTL_MS;
/** How often a running batch renews its heartbeat (also while one step waits for the store). */
export const DEFAULT_PUBLISH_HEARTBEAT_MS = PUBLISH_HEARTBEAT_MS;
/** A person may end a claim that has been silent for this long, before the time to live ends it by itself. */
/** The one value of `@kiln/core` timings, shared with the browser's "the server has not reported" line. */
export const PUBLISH_SILENT_AFTER_MS = SILENT_AFTER_MS;
/** A person may end a claim that has run for this long even when it still beats: no batch is meant to take longer (a step is cut at 8 minutes). */
export const PUBLISH_STUCK_AFTER_MS = STUCK_AFTER_MS;
/** The boot id of this server process: a claim of another one is the claim of a process that is gone. */
export const PROCESS_ID = randomUUID();

/** What a running step says it is doing: a fixed word and, for a count, two numbers. Never a text of the store. */
export const DETAIL_PHASES = [
  'writing_texts',
  'uploading_images',
  'processing_images',
  'placing_images',
] as const;
export type DetailPhase = (typeof DETAIL_PHASES)[number];
export type PublishDetail = {
  phase: DetailPhase;
  done: number | null;
  total: number | null;
  /** When it was written (epoch milliseconds). */
  at: number;
};

/** The step words a claim row may hold (the same list as `PUBLISH_STEPS` of pending.ts, kept here so the two files do not import each other). */
const KNOWN_STEPS: readonly PublishStep[] = [
  'push_draft',
  'push_and_submit',
  'submit',
  'release',
  'rollout',
];

export type Publishing = {
  /** When the batch took the claim (epoch milliseconds). */
  startedAt: number;
  /** The steps it runs, in order (`push_draft`, `submit`, `release`, `rollout`). Empty for a claim older than migration 71. */
  steps: PublishStep[];
  /** The step that runs now; null before the first starts and between steps. */
  currentStep: PublishStep | null;
  /** When the current step started; null when none runs. */
  stepStartedAt: number | null;
  /** Who started it. `name` is null when the person is gone. */
  by: { id: string; name: string | null } | null;
  /** The last sign of life of the process that runs it (epoch milliseconds). */
  heartbeatAt: number;
  /** What the running step is doing now, or null (no step runs, or it says nothing). */
  detail: PublishDetail | null;
  /** How many steps ended applied so far. */
  stepsDone: number;
  /** The server lets a person end this claim now: it has been silent for a minute, or it has run longer than any batch should. */
  interruptible: boolean;
};

const stepsOf = (raw: unknown): PublishStep[] => {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((s): s is PublishStep => KNOWN_STEPS.includes(s as PublishStep))
      : [];
  } catch {
    return [];
  }
};

/** The time of the last sign of life of a claim row. */
export const heartbeatOf = (row: Record<string, unknown>): number =>
  Math.max(
    Number(row.claim_at),
    row.step_at === null || row.step_at === undefined ? 0 : Number(row.step_at),
    row.heartbeat_at === null || row.heartbeat_at === undefined ? 0 : Number(row.heartbeat_at),
  );

const detailOf = (row: Record<string, unknown>): PublishDetail | null => {
  if (typeof row.detail !== 'string' || row.detail === '') return null;
  try {
    const parsed = JSON.parse(row.detail) as Record<string, unknown>;
    const phase = parsed.phase as DetailPhase;
    if (!DETAIL_PHASES.includes(phase)) return null;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      phase,
      done: num(parsed.done),
      total: num(parsed.total),
      at: row.detail_at === null || row.detail_at === undefined ? 0 : Number(row.detail_at),
    };
  } catch {
    return null;
  }
};

/** Whether a person may end a claim now: silent for a minute, or running for longer than a batch is meant to. */
export const isInterruptible = (row: Record<string, unknown>, now: number): boolean =>
  now - heartbeatOf(row) >= PUBLISH_SILENT_AFTER_MS ||
  now - Number(row.claim_at) >= PUBLISH_STUCK_AFTER_MS;

/** Whether a claim row is a batch that is still alive at `now`. */
export const isLiveClaim = (
  row: Record<string, unknown>,
  now: number,
  ttlMs: number = DEFAULT_PUBLISH_CLAIM_TTL_MS,
): boolean => now - heartbeatOf(row) < ttlMs;

/**
 * The running batches of a workspace (or of `appIds`), by app id, expired claims left out. One query for the claims and one for the
 * names of the people who started them.
 */
export async function readPublishing(
  sql: Sql,
  input: {
    workspaceId: string;
    appIds?: readonly string[] | undefined;
    now: number;
    ttlMs?: number | undefined;
  },
): Promise<Map<string, Publishing>> {
  const out = new Map<string, Publishing>();
  if (input.appIds !== undefined && input.appIds.length === 0) return out;
  const wanted = input.appIds === undefined ? null : new Set(input.appIds);
  const rows = await sql.query(
    `SELECT app_id, platform, claimed_by, claim_at, steps, current_step, step_at, heartbeat_at, detail, detail_at, steps_done
       FROM store_publish_claims WHERE workspace_id = ? AND status = 'writing'`,
    [input.workspaceId],
  );
  const live = rows.filter(
    (r) =>
      isLiveClaim(r, input.now, input.ttlMs) && (wanted === null || wanted.has(String(r.app_id))),
  );
  if (live.length === 0) return out;
  const ids = [...new Set(live.map((r) => String(r.claimed_by)))];
  const names = new Map<string, string>();
  for (const u of await sql.query(
    `SELECT id, display_name FROM users WHERE id IN (${ids.map(() => '?').join(', ')})`,
    ids,
  ))
    names.set(String(u.id), String(u.display_name));
  for (const r of live) {
    const current = typeof r.current_step === 'string' ? (r.current_step as PublishStep) : null;
    const by = String(r.claimed_by);
    out.set(String(r.app_id), {
      startedAt: Number(r.claim_at),
      steps: stepsOf(r.steps),
      currentStep: current !== null && KNOWN_STEPS.includes(current) ? current : null,
      stepStartedAt:
        current !== null && r.step_at !== null && r.step_at !== undefined
          ? Number(r.step_at)
          : null,
      by: by === '' ? null : { id: by, name: names.get(by) ?? null },
      heartbeatAt: heartbeatOf(r),
      // What it says only counts while the step it was said in runs (a step that ended or began clears it).
      detail: current === null ? null : detailOf(r),
      stepsDone: r.steps_done === null || r.steps_done === undefined ? 0 : Number(r.steps_done),
      interruptible: isInterruptible(r, input.now),
    });
  }
  return out;
}

/** The batch running for one app, or null. */
export async function publishingOf(
  sql: Sql,
  input: { workspaceId: string; appId: string; now: number; ttlMs?: number | undefined },
): Promise<Publishing | null> {
  return (await readPublishing(sql, { ...input, appIds: [input.appId] })).get(input.appId) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Writes of the batch (its own claim row)

export type ClaimKey = { appId: string; platform: Platform; at: number };

const OWN = "app_id = ? AND platform = ? AND claim_at = ? AND status = 'writing'";
const own = (claim: ClaimKey) => [claim.appId, claim.platform, claim.at];

/** The steps the batch runs, once the plan says which are included. Renews the heartbeat. */
export const recordSteps = (
  sql: Sql,
  claim: ClaimKey,
  steps: readonly PublishStep[],
  now: number,
) =>
  sql.execute(
    `UPDATE store_publish_claims SET steps = ?, step_at = ?, heartbeat_at = ? WHERE ${OWN}`,
    [JSON.stringify(steps), now, now, ...own(claim)],
  );

/**
 * A step starts (`step`) or ends (null; `applied` says whether it went through). Renews the heartbeat and clears what the step said it
 * was doing. Returns the number of rows written: 0 means the claim is gone (a person ended it, or a newer batch took it).
 */
export const recordStep = (
  sql: Sql,
  claim: ClaimKey,
  step: PublishStep | null,
  now: number,
  applied = false,
) =>
  sql.execute(
    `UPDATE store_publish_claims SET current_step = ?, step_at = ?, heartbeat_at = ?, detail = NULL, detail_at = NULL,
       steps_done = COALESCE(steps_done, 0) + ? WHERE ${OWN}`,
    [step, now, now, step === null && applied ? 1 : 0, ...own(claim)],
  );

/** The timer of a running batch: it is alive. Returns the number of rows written (0: the claim is gone). */
export const recordHeartbeat = (sql: Sql, claim: ClaimKey, now: number) =>
  sql.execute(`UPDATE store_publish_claims SET heartbeat_at = ? WHERE ${OWN}`, [
    now,
    ...own(claim),
  ]);

/** What the running step is doing now (`phase` is one of `DETAIL_PHASES`). Also a sign of life. */
export const recordDetail = (
  sql: Sql,
  claim: ClaimKey,
  detail: { phase: DetailPhase; done?: number | undefined; total?: number | undefined },
  now: number,
) =>
  sql.execute(
    `UPDATE store_publish_claims SET detail = ?, detail_at = ?, heartbeat_at = ? WHERE ${OWN}`,
    [
      JSON.stringify({
        phase: detail.phase,
        ...(detail.done !== undefined ? { done: detail.done } : {}),
        ...(detail.total !== undefined ? { total: detail.total } : {}),
      }),
      now,
      now,
      ...own(claim),
    ],
  );

// ---------------------------------------------------------------------------------------------
// Claims that nobody works on: they become an interrupted run

export const INTERRUPTED_MESSAGE =
  'The publish was interrupted: the server restarted or lost the request. Check the store, then review again.';

/** The run kept for a claim whose batch is gone: the steps that ended applied, the one that was running (unknown), the rest not run. */
function interruptedResults(
  row: Record<string, unknown>,
  now: number,
): { steps: PublishStep[]; results: RunStep[]; outcome: 'partial' | 'failed' } {
  const steps = stepsOf(row.steps);
  const startedAt = Number(row.claim_at);
  const done = Math.min(
    row.steps_done === null || row.steps_done === undefined ? 0 : Number(row.steps_done),
    steps.length,
  );
  const results: RunStep[] = steps.map((type, i) => {
    if (i < done) return { type, status: 'applied', startedAt, finishedAt: now };
    if (i === done)
      return {
        type,
        status: 'failed',
        startedAt,
        finishedAt: now,
        error: 'interrupted',
        httpStatus: 504,
        outcome: 'unknown',
        message: INTERRUPTED_MESSAGE,
        code: 'publish.interrupted',
      };
    return {
      type,
      status: 'skipped',
      startedAt: now,
      finishedAt: now,
      reason: 'previous_step_not_applied',
    };
  });
  return { steps, results, outcome: done > 0 ? 'partial' : 'failed' };
}

/**
 * Ends the claim row `row` (only when it is still that claim) and keeps the interrupted run it stands for. Returns whether this call
 * ended it (a second caller, or the batch itself finishing at the same moment, finds nothing to end).
 */
async function endClaim(sql: Sql, row: Record<string, unknown>, now: number): Promise<boolean> {
  const ended = await sql.execute(
    "DELETE FROM store_publish_claims WHERE app_id = ? AND platform = ? AND claim_at = ? AND status = 'writing'",
    [String(row.app_id), String(row.platform), Number(row.claim_at)],
  );
  if (ended !== 1) return false;
  const { steps, results, outcome } = interruptedResults(row, now);
  const by = row.claimed_by === null || row.claimed_by === undefined ? '' : String(row.claimed_by);
  try {
    await recordRun(sql, {
      workspaceId: String(row.workspace_id),
      appId: String(row.app_id),
      platform: String(row.platform) as Platform,
      startedAt: Number(row.claim_at),
      finishedAt: now,
      outcome,
      steps,
      results,
      byUser: by === '' ? null : by,
    });
  } catch {
    // A failure to keep the run never keeps the ghost: the claim is already gone.
  }
  return true;
}

const CLAIM_COLUMNS =
  'app_id, platform, workspace_id, claimed_by, claim_at, steps, current_step, step_at, heartbeat_at, steps_done, instance_id';

/**
 * Claims that no process works on, turned into interrupted runs: the ones whose heartbeat is older than the time to live (a process
 * that died). `workspaceId`/`appId` narrow the read. Returns how many were ended.
 */
export async function reapDeadClaims(
  sql: Sql,
  input: {
    now: number;
    ttlMs?: number | undefined;
    workspaceId?: string | undefined;
    appId?: string | undefined;
  },
): Promise<number> {
  const where = ["status = 'writing'"];
  const args: string[] = [];
  if (input.workspaceId !== undefined) {
    where.push('workspace_id = ?');
    args.push(input.workspaceId);
  }
  if (input.appId !== undefined) {
    where.push('app_id = ?');
    args.push(input.appId);
  }
  const rows = await sql.query(
    `SELECT ${CLAIM_COLUMNS} FROM store_publish_claims WHERE ${where.join(' AND ')}`,
    args,
  );
  let ended = 0;
  for (const row of rows)
    if (!isLiveClaim(row, input.now, input.ttlMs) && (await endClaim(sql, row, input.now)))
      ended += 1;
  return ended;
}

/**
 * At server start: every claim that was not taken by THIS process belongs to a process that is gone, whatever its heartbeat says (the
 * step it ran died with it). One server process runs per database; a second one would have its claims ended here too (docs/api/pending.md).
 */
export async function reapPreviousProcessClaims(
  sql: Sql,
  input: { now: number; instanceId?: string | undefined },
): Promise<number> {
  const mine = input.instanceId ?? PROCESS_ID;
  const rows = await sql.query(
    `SELECT ${CLAIM_COLUMNS} FROM store_publish_claims WHERE status = 'writing'`,
    [],
  );
  let ended = 0;
  for (const row of rows)
    if (row.instance_id !== mine && (await endClaim(sql, row, input.now))) ended += 1;
  return ended;
}

export type InterruptResult = { ok: true } | Failure;

/**
 * A person ends the claim of an app: allowed only when the server itself says it is silent or has run too long (`isInterruptible`);
 * a batch that is alive and recent is never cancelled from here. Nothing is sent to a store: the claim is ended and the interrupted
 * run kept, which tells the person to look at the store.
 */
export async function interruptPublish(
  sql: Sql,
  input: { workspaceId: string; appId: string; now: number },
): Promise<InterruptResult> {
  const rows = await sql.query(
    `SELECT ${CLAIM_COLUMNS} FROM store_publish_claims WHERE workspace_id = ? AND app_id = ? AND status = 'writing'`,
    [input.workspaceId, input.appId],
  );
  const row = rows[0];
  if (!row)
    return failure(
      404,
      'not_publishing',
      'No publish of this app is running.',
      coded('publish.notRunning'),
    );
  if (!isInterruptible(row, input.now))
    return failure(
      409,
      'still_running',
      'The publish is still running and has not gone quiet. It was not stopped.',
      coded('publish.stillRunning'),
    );
  await endClaim(sql, row, input.now);
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// The refusal

const utc = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** `409 publish_in_progress`, naming when the running batch started. */
export function publishInProgress(startedAt: number | null): Failure {
  if (startedAt === null)
    return failure(
      409,
      'publish_in_progress',
      'A publish of this app is in progress. Wait for it to finish.',
      coded('publish.inProgress.publish'),
    );
  return failure(
    409,
    'publish_in_progress',
    `A publish of this app has been running since ${utc(startedAt)}. Wait for it to finish.`,
    { startedAt, ...coded('publish.inProgress.since', { since: utc(startedAt) }) },
  );
}

/** The refusal for a write that must not run while a batch publish of the app runs; null when none does. */
export async function refuseWhilePublishing(
  db: Database,
  input: { workspaceId: string; appId: string; now: number; ttlMs?: number | undefined },
): Promise<Failure | null> {
  const running = await publishingOf(db, input);
  return running === null ? null : publishInProgress(running.startedAt);
}

/**
 * A route guard: the write behind it (a release, a submit, a rollout change, a push of the staged changes, a version, a discard) is
 * refused with `409 publish_in_progress` while a batch publish of the app (`:id`) runs. The batch itself calls the services, not the
 * routes, so it is never held up by its own claim.
 */
export const notWhilePublishing =
  (ctx: { db: Database; now: () => number; claimTtlMs?: number | undefined }) =>
  async (c: Context<AppEnv>, next: Next) => {
    const refusal = await refuseWhilePublishing(ctx.db, {
      workspaceId: c.req.param('workspaceId') ?? '',
      appId: c.req.param('id') ?? '',
      now: ctx.now(),
      ttlMs: ctx.claimTtlMs,
    });
    if (!refusal) return next();
    c.header('Cache-Control', 'no-store');
    return c.json(refusal.body, refusal.status);
  };
