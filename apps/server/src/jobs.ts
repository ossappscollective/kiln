import { randomUUID } from 'node:crypto';
import type { Sql } from '@mrm/db';

/**
 * A queue in the database, so there is no Redis or RabbitMQ to run. Claiming is optimistic and
 * portable: pick a candidate, then flip it from queued to running only if it is still queued.
 * Exactly one worker wins that update, on SQLite and on Postgres.
 *
 * Delivery is at least once: a job whose worker dies is picked up again after `staleAfterMs`,
 * so handlers must be safe to repeat.
 */
export type Job = {
  id: string;
  queue: string;
  payload: unknown;
  attempts: number;
};

export const DEFAULT_MAX_ATTEMPTS = 5;

export type JobHandler = (payload: unknown, job: Job) => Promise<void>;

export async function enqueue(
  sql: Sql,
  queue: string,
  payload: unknown,
  options: { runAt?: number; now?: number } = {},
): Promise<string> {
  const id = randomUUID();
  const now = options.now ?? Date.now();
  await sql.execute(
    `INSERT INTO jobs (id, queue, payload, status, run_at, attempts, created_at)
     VALUES (?, ?, ?, 'queued', ?, 0, ?)`,
    [id, queue, JSON.stringify(payload ?? null), options.runAt ?? now, now],
  );
  return id;
}

export async function claimNext(sql: Sql, now: number): Promise<Job | undefined> {
  for (let tries = 0; tries < 5; tries++) {
    const [candidate] = await sql.query(
      `SELECT id FROM jobs WHERE status = 'queued' AND run_at <= ?
        ORDER BY run_at, created_at, id LIMIT 1`,
      [now],
    );
    if (!candidate) return undefined;
    const claimed = await sql.execute(
      `UPDATE jobs SET status = 'running', locked_at = ?, attempts = attempts + 1
        WHERE id = ? AND status = 'queued'`,
      [now, String(candidate.id)],
    );
    if (claimed === 1) {
      const [row] = await sql.query('SELECT id, queue, payload, attempts FROM jobs WHERE id = ?', [
        String(candidate.id),
      ]);
      if (row) {
        return {
          id: String(row.id),
          queue: String(row.queue),
          payload: JSON.parse(String(row.payload)),
          attempts: Number(row.attempts),
        };
      }
    }
  }
  return undefined;
}

/**
 * Marks the job done, but only for the worker that holds it: the job must still be `running`, and
 * on the attempt that this worker claimed. A job that was recovered as stale and claimed again
 * belongs to someone else now, and a late finish must not overwrite that. Returns whether it did.
 */
export async function completeJob(sql: Sql, job: Pick<Job, 'id' | 'attempts'>): Promise<boolean> {
  const changed = await sql.execute(
    "UPDATE jobs SET status = 'done', locked_at = NULL WHERE id = ? AND status = 'running' AND attempts = ?",
    [job.id, job.attempts],
  );
  return changed === 1;
}

export const backoffMs = (attempts: number) => Math.min(5_000 * 2 ** (attempts - 1), 3_600_000);

/**
 * Requeue with backoff, or give up (status 'failed') once attempts reach the limit. Like
 * `completeJob`, it only touches a job that is still `running` on the attempt this worker claimed;
 * otherwise it returns 'lost' and changes nothing.
 */
export async function failJob(
  sql: Sql,
  job: Job,
  error: unknown,
  options: { maxAttempts: number; now: number; permanent?: boolean },
): Promise<'retry' | 'failed' | 'lost'> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  const mine = "WHERE id = ? AND status = 'running' AND attempts = ?";
  if (options.permanent || job.attempts >= options.maxAttempts) {
    const changed = await sql.execute(
      `UPDATE jobs SET status = 'failed', last_error = ?, locked_at = NULL ${mine}`,
      [message, job.id, job.attempts],
    );
    return changed === 1 ? 'failed' : 'lost';
  }
  const changed = await sql.execute(
    `UPDATE jobs SET status = 'queued', last_error = ?, run_at = ?, locked_at = NULL ${mine}`,
    [message, options.now + backoffMs(job.attempts), job.id, job.attempts],
  );
  return changed === 1 ? 'retry' : 'lost';
}

/**
 * Takes jobs back that were running when their worker stopped. One that has already used all its
 * attempts is marked `failed` instead of being run again, so a job that crashes its worker cannot
 * loop forever. Returns how many jobs it touched.
 */
export async function recoverStale(
  sql: Sql,
  now: number,
  staleAfterMs: number,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): Promise<number> {
  const cutoff = now - staleAfterMs;
  const exhausted = await sql.execute(
    `UPDATE jobs SET status = 'failed', locked_at = NULL,
            last_error = 'The worker stopped while running this job, and it has no attempts left.'
      WHERE status = 'running' AND locked_at < ? AND attempts >= ?`,
    [cutoff, maxAttempts],
  );
  const requeued = await sql.execute(
    "UPDATE jobs SET status = 'queued', locked_at = NULL WHERE status = 'running' AND locked_at < ?",
    [cutoff],
  );
  return exhausted + requeued;
}

export type Worker = {
  /** Runs at most one job. Resolves true when it ran one. Exposed for tests and for `start`. */
  tick(): Promise<boolean>;
  start(): void;
  stop(): Promise<void>;
};

export function createWorker(options: {
  sql: Sql;
  handlers: Record<string, JobHandler>;
  pollMs?: number;
  maxAttempts?: number;
  staleAfterMs?: number;
  now?: () => number;
  onError?: (message: string, error: unknown) => void;
}): Worker {
  const { sql, handlers } = options;
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? 2_000;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const staleAfterMs = options.staleAfterMs ?? 10 * 60_000;
  const report = options.onError ?? ((message, error) => console.error(message, error));

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<unknown> = Promise.resolve();
  let stopped = true;
  let lastRecovery = 0;

  async function tick(): Promise<boolean> {
    if (now() - lastRecovery > 60_000) {
      lastRecovery = now();
      await recoverStale(sql, now(), staleAfterMs, maxAttempts);
    }
    const job = await claimNext(sql, now());
    if (!job) return false;
    const handler = handlers[job.queue];
    if (!handler) {
      await failJob(sql, job, new Error(`No handler for queue "${job.queue}"`), {
        maxAttempts,
        now: now(),
        permanent: true,
      });
      return true;
    }
    try {
      await handler(job.payload, job);
      await completeJob(sql, job);
    } catch (error) {
      await failJob(sql, job, error, { maxAttempts, now: now() });
    }
    return true;
  }

  function schedule(delay: number) {
    if (stopped) return;
    timer = setTimeout(() => {
      running = tick()
        .catch((error) => report('job worker tick failed', error))
        .then((didWork) => schedule(didWork === true ? 0 : pollMs));
    }, delay);
  }

  return {
    tick,
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(0);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
