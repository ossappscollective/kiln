import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createHostGate,
  credentialLane,
  hostGroupOf,
  mapPool,
  readAhead,
  resetSyncPipeline,
  retryAfterSeconds,
  syncActivity,
} from './sync-pipeline.ts';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('mapPool respects the limit, keeps input order, and settles every item even when some fail', async () => {
  let inFlight = 0;
  let peak = 0;
  const results = await mapPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await wait(5);
    inFlight--;
    if (n === 4) throw new Error('four');
    return n * 10;
  });
  assert.equal(peak, 3);
  assert.deepEqual(
    results.map((r) => (r.status === 'fulfilled' ? r.value : 'failed')),
    [10, 20, 30, 'failed', 50, 60, 70],
  );
});

test('readAhead overlaps the reads but hands the results over in order, and a failed read surfaces at its turn', async () => {
  let started = 0;
  let inFlight = 0;
  let peak = 0;
  const seen: number[] = [];
  const read = async (n: number) => {
    started++;
    inFlight++;
    peak = Math.max(peak, inFlight);
    await wait(n === 1 ? 20 : 2);
    inFlight--;
    if (n === 5) throw new Error('five');
    return n;
  };
  await assert.rejects(async () => {
    for await (const { result } of readAhead([1, 2, 3, 4, 5, 6], 3, read)) seen.push(result);
  }, /five/);
  assert.deepEqual(seen, [1, 2, 3, 4]);
  assert.ok(peak >= 2 && peak <= 3, `peak ${peak}`);
  assert.ok(started >= 5);
});

test('host groups: Apple and Google are told apart, other hosts are not gated', () => {
  assert.equal(hostGroupOf('https://api.appstoreconnect.apple.com/v1/apps'), 'apple');
  assert.equal(hostGroupOf('https://androidpublisher.googleapis.com/x'), 'google');
  assert.equal(hostGroupOf('https://oauth2.googleapis.com/token'), 'google');
  assert.equal(hostGroupOf('https://example.com/hook'), undefined);
  assert.equal(hostGroupOf('https://evilappstoreconnect.apple.com.example.com/'), undefined);
});

test('retryAfterSeconds reads seconds and dates', () => {
  assert.equal(retryAfterSeconds('7', 0), 7);
  assert.equal(retryAfterSeconds(new Date(10_000).toUTCString(), 4_000), 6);
  assert.equal(retryAfterSeconds('soon', 0), undefined);
  assert.equal(retryAfterSeconds(null, 0), undefined);
});

test('the host gate bounds requests in flight per host, separately for Apple and Google', async () => {
  const gate = createHostGate({ limits: { apple: 2, google: 3 } });
  const live: Record<string, number> = { a: 0, g: 0 };
  const peak: Record<string, number> = { a: 0, g: 0 };
  const base = (async (input: string | URL | Request) => {
    const key = String(input).includes('apple') ? 'a' : 'g';
    live[key] = (live[key] ?? 0) + 1;
    peak[key] = Math.max(peak[key] ?? 0, live[key] ?? 0);
    await wait(4);
    live[key] = (live[key] ?? 0) - 1;
    return new Response('{}');
  }) as typeof fetch;
  const f = gate.wrap(base);
  await Promise.all([
    ...Array.from({ length: 10 }, () => f('https://api.appstoreconnect.apple.com/v1/apps')),
    ...Array.from({ length: 10 }, () => f('https://androidpublisher.googleapis.com/x')),
  ]);
  assert.equal(peak.a, 2);
  assert.equal(peak.g, 3);
  assert.equal(gate.stats().apple.peak, 2);
});

test('a 429 with Retry-After pauses every request to that host, and only that host', async () => {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const gate = createHostGate({
    limits: { apple: 4 },
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  const calls: Array<{ url: string; at: number }> = [];
  let limited = false;
  const base = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push({ url, at: clock });
    if (url.includes('/limited') && !limited) {
      limited = true;
      return new Response('', { status: 429, headers: { 'retry-after': '9' } });
    }
    return new Response('{}');
  }) as typeof fetch;
  const f = gate.wrap(base);
  const first = await f('https://api.appstoreconnect.apple.com/limited');
  assert.equal(first.status, 429);
  // Another request to Apple waits the 9 seconds; Google and other hosts do not.
  await f('https://androidpublisher.googleapis.com/ok');
  await f('https://example.com/ok');
  assert.deepEqual(sleeps, []);
  await f('https://api.appstoreconnect.apple.com/next');
  assert.deepEqual(sleeps, [9_000]);
  assert.equal(calls.at(-1)?.at, 1_009_000);
});

test('the pause is capped, and an aborted caller does not wait it out', async () => {
  let clock = 0;
  const gate = createHostGate({
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    maxCooldownMs: 3_000,
  });
  const f = gate.wrap(
    (async () =>
      new Response('', { status: 429, headers: { 'retry-after': '600' } })) as typeof fetch,
  );
  await f('https://api.appstoreconnect.apple.com/a');
  assert.equal(gate.stats().apple.pausedUntil, 3_000);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f('https://api.appstoreconnect.apple.com/b', { signal: controller.signal }),
    /stopped/,
  );
});

test('credentialLane lets perCredential reads of one key run at once and other keys run freely', async () => {
  resetSyncPipeline({ perCredential: 2 });
  let live = 0;
  let peak = 0;
  const job = async () => {
    live++;
    peak = Math.max(peak, live);
    await wait(4);
    live--;
  };
  await Promise.all(Array.from({ length: 6 }, () => credentialLane('key-a', job)));
  assert.equal(peak, 2);
  peak = 0;
  await Promise.all(['k1', 'k2', 'k3'].map((k) => credentialLane(k, job)));
  assert.equal(peak, 3);
  resetSyncPipeline();
});

test('syncActivity lists the feeds being read in one workspace until they end', () => {
  const end = syncActivity.begin('ws-act', 'app-1', 'reviews', 5);
  const other = syncActivity.begin('ws-other', 'app-2', 'analytics', 5);
  assert.deepEqual(
    syncActivity.list('ws-act').map((e) => [e.appId, e.feed]),
    [['app-1', 'reviews']],
  );
  end();
  other();
  assert.deepEqual(syncActivity.list('ws-act'), []);
});
