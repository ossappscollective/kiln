import assert from 'node:assert/strict';
import { migrate } from '@kiln/db';
import { dbTest } from '@kiln/db/testing';
import { createWorker, enqueue } from './jobs.ts';
import { createHostGate, mapPool, resetSyncPipeline } from './services/sync-pipeline.ts';

// A model of one store sync round, run on the real worker, the real host gate and the real pool, with a fake store that
// answers after a fixed latency. It measures the SHAPE of the pipeline (what waits for what), not real store timings.

const LATENCY = 8;
const APPS = 6;
const SOURCES = 5;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function round(mode: 'before' | 'after') {
  const after = mode === 'after';
  resetSyncPipeline({ analyticsSources: after ? 3 : 1 });
  const gate = createHostGate({ limits: { apple: after ? 4 : 99 } });
  let requests = 0;
  const store = gate.wrap((async () => {
    requests++;
    await wait(LATENCY);
    return new Response('{}');
  }) as typeof fetch);
  const get = () => store('https://api.appstoreconnect.apple.com/v1/x');
  const doneAt: Record<string, number> = {};
  const t0 = Date.now();
  const mark = (name: string) => void (doneAt[name] = Date.now() - t0);
  return { after, gate, get, doneAt, t0, mark, requestCount: () => requests };
}

dbTest('benchmark: one round for several apps, serial worker and sequential feeds vs the pipeline', async (db) => {
  await migrate(db);
  const out: Record<string, { ms: number; requests: number; appSyncsDoneBy: number }> = {};
  for (const mode of ['before', 'after'] as const) {
    await db.execute('DELETE FROM jobs');
    const r = await round(mode);
    const handlers = {
      'app.sync': async (p: unknown) => {
        const reads = [r.get, r.get, r.get];
        if (r.after) await Promise.all(reads.map((f) => f()));
        else for (const f of reads) await f();
        r.mark(`app:${(p as { n: number }).n}`);
      },
      'review.sync': async () => void (await r.get()),
      'analytics.sync': async () => {
        await mapPool(Array.from({ length: SOURCES }), r.after ? 3 : 1, async () => {
          for (let i = 0; i < 3; i++) await r.get();
        });
      },
    };
    // The scheduler queues analytics first in this round, as a worst case.
    for (let n = 0; n < APPS; n++) await enqueue(db, 'analytics.sync', { n }, { now: 1 });
    for (let n = 0; n < APPS; n++) await enqueue(db, 'review.sync', { n }, { now: 1 });
    for (let n = 0; n < APPS; n++) await enqueue(db, 'app.sync', { n }, { now: 1 });
    const worker = createWorker({
      sql: db,
      handlers,
      pollMs: 2,
      now: () => 10,
      ...(r.after
        ? {
            concurrency: 4,
            priority: { 'app.sync': 0, 'review.sync': 1, 'analytics.sync': 3 },
            heavy: ['analytics.sync'],
          }
        : {}),
    });
    const start = Date.now();
    worker.start();
    for (;;) {
      const [row] = await db.query("SELECT COUNT(*) AS n FROM jobs WHERE status <> 'done'");
      if (Number(row?.n) === 0) break;
      await wait(3);
    }
    const ms = Date.now() - start;
    await worker.stop();
    const appDone = Math.max(...Array.from({ length: APPS }, (_, n) => r.doneAt[`app:${n}`] ?? Number.POSITIVE_INFINITY));
    out[mode] = { ms, requests: r.requestCount(), appSyncsDoneBy: appDone };
    if (r.after) assert.ok(r.gate.stats().apple.peak <= 4, 'the host limit held');
  }
  const before = out.before as (typeof out)[string];
  const after = out.after as (typeof out)[string];
  console.log(`bench (fake store, ${LATENCY} ms per request, ${APPS} apps): before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
  assert.equal(before.requests, after.requests, 'same requests: faster, not more');
  assert.ok(after.ms < before.ms * 0.5, `whole round: ${after.ms} ms against ${before.ms} ms`);
  assert.ok(after.appSyncsDoneBy < before.appSyncsDoneBy * 0.5, 'release state lands early');
});
