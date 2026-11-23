import assert from 'node:assert/strict';
import { migrate } from '@kiln/db';
import { dbTest } from '@kiln/db/testing';
import { createWorker, enqueue } from './jobs.ts';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function drain(db: Parameters<typeof migrate>[0]) {
  for (let i = 0; i < 500; i++) {
    const [row] = await db.query("SELECT COUNT(*) AS n FROM jobs WHERE status <> 'done'");
    if (Number(row?.n) === 0) return;
    await wait(4);
  }
  throw new Error('jobs did not finish');
}

dbTest('queue priority: due jobs of a lower rank go first, others keep their order', async (db) => {
  await migrate(db);
  const order: string[] = [];
  const handler = (name: string) => async () => void order.push(name);
  await enqueue(db, 'analytics', {}, { now: 1 });
  await enqueue(db, 'reviews', {}, { now: 2 });
  await enqueue(db, 'apps', {}, { now: 3 });
  await enqueue(db, 'webhook', {}, { now: 4 });
  const worker = createWorker({
    sql: db,
    now: () => 10,
    handlers: { analytics: handler('analytics'), reviews: handler('reviews'), apps: handler('apps'), webhook: handler('webhook') },
    priority: { apps: 0, reviews: 1, analytics: 3 },
  });
  while (await worker.tick());
  assert.deepEqual(order, ['apps', 'webhook', 'reviews', 'analytics']);
});

dbTest('a future job is not claimed early, whatever its rank', async (db) => {
  await migrate(db);
  await enqueue(db, 'apps', {}, { now: 1, runAt: 1000 });
  await enqueue(db, 'analytics', {}, { now: 1 });
  const seen: string[] = [];
  const worker = createWorker({
    sql: db,
    now: () => 10,
    handlers: { apps: async () => void seen.push('apps'), analytics: async () => void seen.push('analytics') },
    priority: { apps: 0, analytics: 3 },
  });
  assert.equal(await worker.tick(), true);
  assert.equal(await worker.tick(), false);
  assert.deepEqual(seen, ['analytics']);
});

dbTest('concurrency: jobs overlap up to the limit, each runs exactly once, heavy jobs leave a slot free', async (db) => {
  await migrate(db);
  let live = 0;
  let peak = 0;
  let heavyLive = 0;
  let heavyPeak = 0;
  const runs = new Map<string, number>();
  const work = (heavy: boolean) => async (payload: unknown) => {
    const id = String((payload as { id: number }).id);
    runs.set(id, (runs.get(id) ?? 0) + 1);
    live++;
    peak = Math.max(peak, live);
    if (heavy) {
      heavyLive++;
      heavyPeak = Math.max(heavyPeak, heavyLive);
    }
    await wait(12);
    if (heavy) heavyLive--;
    live--;
  };
  for (let id = 0; id < 8; id++) await enqueue(db, 'slow', { id }, { now: 1 });
  for (let id = 100; id < 106; id++) await enqueue(db, 'quick', { id }, { now: 1 });
  const worker = createWorker({
    sql: db,
    now: () => 10,
    pollMs: 2,
    concurrency: 4,
    heavy: ['slow'],
    handlers: { slow: work(true), quick: work(false) },
  });
  worker.start();
  await drain(db);
  await worker.stop();
  assert.equal(peak, 4);
  assert.ok(heavyPeak <= 3, `heavy peak ${heavyPeak}`);
  assert.equal(runs.size, 14);
  for (const count of runs.values()) assert.equal(count, 1);
});

dbTest('a failing job does not stop the other slots, and stop() waits for running jobs', async (db) => {
  await migrate(db);
  await enqueue(db, 'bad', {}, { now: 1 });
  await enqueue(db, 'good', {}, { now: 1 });
  let finished = false;
  const worker = createWorker({
    sql: db,
    now: () => 10,
    pollMs: 2,
    concurrency: 2,
    onError: () => undefined,
    handlers: {
      bad: async () => {
        throw new Error('nope');
      },
      good: async () => {
        await wait(15);
        finished = true;
      },
    },
  });
  worker.start();
  await wait(5);
  await worker.stop();
  assert.equal(finished, true);
  const [bad] = await db.query("SELECT status FROM jobs WHERE queue = 'bad'");
  assert.equal(bad?.status, 'queued');
});
