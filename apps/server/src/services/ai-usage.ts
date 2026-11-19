import type { Database, Sql } from '@mrm/db';

/**
 * The token budget of AI runs (docs/adr/0016-ai-foundation.md): one row per run in `ai_usage`, counts only, NO TEXT.
 *
 * - The month is the UTC calendar month. The budget is the sum of the rows since its start; a row that is still
 *   `reserved` counts with the tokens it reserved (the estimated input plus the output cap), a settled row with the tokens
 *   the provider reported. So a run in flight is already counted, and a burst of runs cannot all pass a check and then
 *   overspend together.
 * - The check and the insert of the reservation are one transaction. On SQLite that is serial. On Postgres two
 *   instances can still both pass; the overshoot is bounded by the number of runs in flight (each process allows two per
 *   workspace) times the cap of one run, which is why the cap per run exists. Documented in the ADR.
 * - A budget of 0 means no limit here (usage is still recorded).
 * - A call that failed without the provider reporting tokens is settled at 0: it did not spend budget.
 * - A reservation that was never settled (the process died) keeps counting until the month ends: the safe side.
 */

/** Epoch milliseconds of 00:00 UTC on the first day of the month that contains `at`. */
export function monthStart(at: number): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Epoch milliseconds of the start of the next UTC month: when the budget resets. */
export function nextMonthStart(at: number): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** `YYYY-MM` of the UTC month that contains `at`. */
export const monthKey = (at: number): string => new Date(at).toISOString().slice(0, 7);

const SPENT = "CASE WHEN status = 'reserved' THEN reserved_tokens ELSE input_tokens + output_tokens END";

export type MonthUsage = { used: number; runs: number; month: string; resetsAt: number };

export async function getMonthUsage(sql: Sql, workspaceId: string, at: number): Promise<MonthUsage> {
  const [row] = await sql.query(
    `SELECT COALESCE(SUM(${SPENT}), 0) AS used, COUNT(*) AS runs FROM ai_usage WHERE workspace_id = ? AND created_at >= ?`,
    [workspaceId, monthStart(at)],
  );
  return { used: Number(row?.used ?? 0), runs: Number(row?.runs ?? 0), month: monthKey(at), resetsAt: nextMonthStart(at) };
}

export type UsageRun = {
  id: string;
  workspaceId: string;
  appId: string | null;
  task: string;
  taskVersion: number;
  provider: string;
  model: string;
  actorId: string;
  at: number;
};

export type Reservation = { ok: true } | { ok: false; used: number; budget: number };

/** Takes `tokens` from this month's budget by writing the run's row, or says how much is used. */
export async function reserveTokens(db: Database, run: UsageRun, tokens: number, budget: number): Promise<Reservation> {
  return db.transaction(async (tx): Promise<Reservation> => {
    if (budget > 0) {
      const { used } = await getMonthUsage(tx, run.workspaceId, run.at);
      if (used + tokens > budget) return { ok: false, used, budget };
    }
    await tx.execute(
      `INSERT INTO ai_usage (id, workspace_id, app_id, task, task_version, provider, model, status, reserved_tokens, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
      [run.id, run.workspaceId, run.appId, run.task, run.taskVersion, run.provider, run.model, tokens, run.actorId, run.at],
    );
    return { ok: true };
  });
}

/** Settles a run with what the provider reported. `errorCode` is a fixed code, never provider text. */
export async function settleUsage(
  sql: Sql,
  id: string,
  result: { status: 'ok' | 'failed'; errorCode?: string; inputTokens: number; outputTokens: number; at: number },
): Promise<void> {
  await sql.execute(
    'UPDATE ai_usage SET status = ?, error_code = ?, input_tokens = ?, output_tokens = ?, finished_at = ? WHERE id = ?',
    [result.status, result.errorCode ?? null, Math.max(0, Math.floor(result.inputTokens)), Math.max(0, Math.floor(result.outputTokens)), result.at, id],
  );
}

/** Usage rows older than 400 days are deleted (counts only, but there is no reason to keep them for ever). */
export const USAGE_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;

/** Runs at the same time per workspace in this process. `acquire` returns a release function, or undefined when the limit is reached. */
export type ConcurrencyGate = { acquire(workspaceId: string): (() => void) | undefined; inFlight(workspaceId: string): number };

export function createConcurrencyGate(limit: number): ConcurrencyGate {
  const running = new Map<string, number>();
  return {
    acquire(workspaceId) {
      const now = running.get(workspaceId) ?? 0;
      if (now >= limit) return undefined;
      running.set(workspaceId, now + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (running.get(workspaceId) ?? 1) - 1;
        if (left <= 0) running.delete(workspaceId);
        else running.set(workspaceId, left);
      };
    },
    inFlight: (workspaceId) => running.get(workspaceId) ?? 0,
  };
}
