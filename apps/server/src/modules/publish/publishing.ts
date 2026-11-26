import type { Platform } from '@kiln/core';
import type { Database, Sql } from '@kiln/db';
import type { Context, Next } from 'hono';
import { coded } from '../../i18n/problem.ts';
import type { AppEnv } from '../../http.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import type { PublishStep } from './pending.ts';

/**
 * What a running batch publish looks like from outside (docs/api/pending.md "Publishing now"). The claim row of `store_publish_claims`
 * (migration 29) already said "a publish is running for this app"; migration 71 adds WHICH steps it runs, which one runs now, and a
 * heartbeat. Everything here is a read or a write of that one row, so it is true across processes (a second server instance sees what
 * the first one is doing). Ids, step names and times only: never a text, a credential or a store answer.
 *
 * Expiry. A claim whose last heartbeat (`step_at`, else `claim_at`) is older than the time to live is a process that died: it is not
 * reported as running and does not block anything (the same rule `takeClaim` uses to take it over). The default time to live is 15
 * minutes, more than one step's 8 minute backstop plus the work around it, and every step boundary renews it, so a live batch of any
 * length is never mistaken for a dead one.
 */

/** A batch that nobody has touched for this long (no step started or ended) is a process that died. */
export const DEFAULT_PUBLISH_CLAIM_TTL_MS = 900_000;

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
  );

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
    `SELECT app_id, platform, claimed_by, claim_at, steps, current_step, step_at
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

/** The steps the batch runs, once the plan says which are included. Renews the heartbeat. */
export const recordSteps = (
  sql: Sql,
  claim: ClaimKey,
  steps: readonly PublishStep[],
  now: number,
) =>
  sql.execute(
    "UPDATE store_publish_claims SET steps = ?, step_at = ? WHERE app_id = ? AND platform = ? AND claim_at = ? AND status = 'writing'",
    [JSON.stringify(steps), now, claim.appId, claim.platform, claim.at],
  );

/** A step starts (`step`) or ends (null). Renews the heartbeat. */
export const recordStep = (sql: Sql, claim: ClaimKey, step: PublishStep | null, now: number) =>
  sql.execute(
    "UPDATE store_publish_claims SET current_step = ?, step_at = ? WHERE app_id = ? AND platform = ? AND claim_at = ? AND status = 'writing'",
    [step, now, claim.appId, claim.platform, claim.at],
  );

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
