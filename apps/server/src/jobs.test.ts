import assert from 'node:assert/strict';
import { migrate } from '@kiln/db';
import { dbTest } from '@kiln/db/testing';
import {
  backoffMs,
  claimNext,
  completeJob,
  createWorker,
  enqueue,
  failJob,
  recoverStale,
} from './jobs.ts';

// Every test runs once per database (SQLite, and Postgres when KILN_TEST_POSTGRES_URL is set).

dbTest('a queued job runs once and ends as done', async (db) => {
  await migrate(db);
  const seen: unknown[] = [];
  const id = await enqueue(db, 'greet', { name: 'Ada' }, { now: 1 });
  const worker = createWorker({
    sql: db,
    handlers: { greet: async (p) => void seen.push(p) },
    now: () => 10,
  });
  assert.equal(await worker.tick(), true);
  assert.equal(await worker.tick(), false);
  assert.deepEqual(seen, [{ name: 'Ada' }]);
  const [row] = await db.query('SELECT status, attempts FROM jobs WHERE id = ?', [id]);
  assert.deepEqual(row, { status: 'done', attempts: 1 });
});

dbTest('jobs scheduled for later wait, and run in order when due', async (db) => {
  await migrate(db);
  await enqueue(db, 'q', 'late', { runAt: 100, now: 1 });
  await enqueue(db, 'q', 'early', { runAt: 50, now: 2 });
  assert.equal(await claimNext(db, 10), undefined);
  assert.equal((await claimNext(db, 60))?.payload, 'early');
  assert.equal((await claimNext(db, 200))?.payload, 'late');
});

dbTest('two claims never return the same job', async (db) => {
  await migrate(db);
  await enqueue(db, 'q', 1, { now: 1 });
  const [a, b] = await Promise.all([claimNext(db, 5), claimNext(db, 5)]);
  assert.equal([a, b].filter(Boolean).length, 1);
});

dbTest('a failing job retries with backoff, then fails for good', async (db) => {
  await migrate(db);
  let time = 1_000;
  const id = await enqueue(db, 'flaky', {}, { now: 0 });
  const worker = createWorker({
    sql: db,
    handlers: {
      flaky: async () => {
        throw new Error('nope');
      },
    },
    maxAttempts: 2,
    now: () => time,
  });
  await worker.tick();
  let [row] = await db.query('SELECT status, run_at, last_error FROM jobs WHERE id = ?', [id]);
  assert.deepEqual(row, { status: 'queued', run_at: 1_000 + backoffMs(1), last_error: 'nope' });
  assert.equal(await worker.tick(), false, 'not due yet');
  time += backoffMs(1);
  await worker.tick();
  [row] = await db.query('SELECT status, run_at, last_error FROM jobs WHERE id = ?', [id]);
  assert.equal(row?.status, 'failed');
});

dbTest('a job for an unknown queue fails at once', async (db) => {
  await migrate(db);
  const id = await enqueue(db, 'mystery', {}, { now: 0 });
  await createWorker({ sql: db, handlers: {}, now: () => 1 }).tick();
  const [row] = await db.query('SELECT status, last_error FROM jobs WHERE id = ?', [id]);
  assert.equal(row?.status, 'failed');
  assert.match(String(row?.last_error), /No handler/);
});

dbTest('a job left running by a dead worker is picked up again', async (db) => {
  await migrate(db);
  const id = await enqueue(db, 'q', {}, { now: 0 });
  await claimNext(db, 1); // a worker takes it and dies
  let ran = 0;
  const worker = createWorker({
    sql: db,
    handlers: { q: async () => void ran++ },
    staleAfterMs: 1_000,
    now: () => 120_000,
  });
  await worker.tick();
  assert.equal(ran, 1);
  const [row] = await db.query('SELECT status, attempts FROM jobs WHERE id = ?', [id]);
  assert.deepEqual(row, { status: 'done', attempts: 2 });
});

dbTest('start polls and stop waits for the job in flight', async (db) => {
  await migrate(db);
  let finished = false;
  await enqueue(db, 'slow', {});
  const worker = createWorker({
    sql: db,
    pollMs: 5,
    handlers: {
      slow: async () => {
        await new Promise((r) => setTimeout(r, 30));
        finished = true;
      },
    },
  });
  worker.start();
  await new Promise((r) => setTimeout(r, 15));
  await worker.stop();
  assert.equal(finished, true);
});

dbTest('many workers claiming at once run every job exactly once', async (db) => {
  await migrate(db);
  const total = 25;
  for (let i = 0; i < total; i++) await enqueue(db, 'q', i, { now: i });
  const seen: number[] = [];
  const drain = async () => {
    for (;;) {
      const job = await claimNext(db, 1_000);
      if (!job) return;
      seen.push(Number(job.payload));
      await completeJob(db, job);
    }
  };
  await Promise.all([drain(), drain(), drain(), drain()]);
  assert.deepEqual(
    seen.sort((a, b) => a - b),
    Array.from({ length: total }, (_, i) => i),
  );
  const [row] = await db.query(
    "SELECT COUNT(*) AS n, MAX(attempts) AS most FROM jobs WHERE status = 'done'",
  );
  assert.deepEqual(row, { n: total, most: 1 });
});

dbTest(
  'a late finish from a worker that lost its job does not overwrite the new run',
  async (db) => {
    await migrate(db);
    const id = await enqueue(db, 'q', {}, { now: 0 });
    const first = await claimNext(db, 1);
    assert.ok(first);
    // The first worker stalls; the job is recovered and a second worker claims it.
    await recoverStale(db, 1_000_000, 1_000);
    const second = await claimNext(db, 1_000_001);
    assert.equal(second?.attempts, 2);
    // The first worker wakes up and reports: both its success and its failure are ignored.
    assert.equal(await completeJob(db, first), false);
    assert.equal(
      await failJob(db, first, new Error('late'), { maxAttempts: 5, now: 2_000_000 }),
      'lost',
    );
    let [row] = await db.query('SELECT status, last_error FROM jobs WHERE id = ?', [id]);
    assert.deepEqual(row, { status: 'running', last_error: null });
    // The current worker still can.
    assert.equal(await completeJob(db, second), true);
    [row] = await db.query('SELECT status, last_error FROM jobs WHERE id = ?', [id]);
    assert.equal(row?.status, 'done');
    // And a done job cannot be completed or failed again.
    assert.equal(await completeJob(db, second), false);
    assert.equal(await failJob(db, second, new Error('x'), { maxAttempts: 5, now: 3 }), 'lost');
    [row] = await db.query('SELECT status FROM jobs WHERE id = ?', [id]);
    assert.equal(row?.status, 'done');
  },
);

dbTest('a job that was never claimed cannot be completed or failed', async (db) => {
  await migrate(db);
  const id = await enqueue(db, 'q', {}, { now: 0 });
  const ghost = { id, queue: 'q', payload: null, attempts: 0 };
  assert.equal(await completeJob(db, ghost), false);
  assert.equal(await failJob(db, ghost, new Error('x'), { maxAttempts: 5, now: 1 }), 'lost');
  const [row] = await db.query('SELECT status FROM jobs WHERE id = ?', [id]);
  assert.equal(row?.status, 'queued');
});

dbTest(
  'recoverStale fails a stale job that has used all its attempts, and requeues the rest',
  async (db) => {
    await migrate(db);
    const spent = await enqueue(db, 'q', 'spent', { now: 0 });
    const fresh = await enqueue(db, 'q', 'fresh', { now: 1 });
    await claimNext(db, 10); // spent: attempt 1
    await db.execute(
      "UPDATE jobs SET status = 'running', attempts = 3, locked_at = 10 WHERE id = ?",
      [spent],
    );
    await claimNext(db, 10); // fresh: attempt 1
    assert.equal(await recoverStale(db, 100_000, 1_000, 3), 2);
    const [a] = await db.query('SELECT status, last_error FROM jobs WHERE id = ?', [spent]);
    assert.equal(a?.status, 'failed');
    assert.match(String(a?.last_error), /no attempts left/);
    const [b] = await db.query('SELECT status FROM jobs WHERE id = ?', [fresh]);
    assert.equal(b?.status, 'queued');
  },
);

dbTest('the worker passes its own attempt limit to recovery', async (db) => {
  await migrate(db);
  const id = await enqueue(db, 'q', {}, { now: 0 });
  await claimNext(db, 1);
  let ran = 0;
  const worker = createWorker({
    sql: db,
    handlers: { q: async () => void ran++ },
    maxAttempts: 1,
    staleAfterMs: 1_000,
    now: () => 120_000,
  });
  await worker.tick();
  assert.equal(ran, 0, 'not run again');
  const [row] = await db.query('SELECT status FROM jobs WHERE id = ?', [id]);
  assert.equal(row?.status, 'failed');
});
