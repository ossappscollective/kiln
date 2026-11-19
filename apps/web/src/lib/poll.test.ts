import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPoller, type Timers, type Visibility } from './poll.ts';

/** Timers and a page that the test drives by hand. */
function harness() {
  const scheduled = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const timers: Timers = {
    set(fn, ms) {
      const id = next++;
      scheduled.set(id, { fn, ms });
      return id;
    },
    clear(handle) {
      scheduled.delete(handle as number);
    },
  };
  let visible = true;
  const listeners = new Set<() => void>();
  const visibility: Visibility = {
    visible: () => visible,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    timers,
    visibility,
    scheduled,
    listeners,
    /** The one pending timer, and its delay. */
    pending: () => [...scheduled.values()],
    async fire() {
      const [entry] = [...scheduled.entries()];
      assert.ok(entry, 'a timer is pending');
      scheduled.delete(entry[0]);
      entry[1].fn();
      await flush();
    },
    async show(value: boolean) {
      visible = value;
      for (const l of [...listeners]) l();
      await flush();
    },
  };
}

test('ticks every interval while there is more, and stops by itself when there is not', async () => {
  const h = harness();
  const results = [true, true, false];
  let ticks = 0;
  const poller = createPoller({
    intervalMs: 5_000,
    timers: h.timers,
    visibility: h.visibility,
    tick: async () => {
      ticks++;
      return results.shift() ?? false;
    },
  });
  poller.start();
  assert.equal(poller.running, true);
  assert.deepEqual(
    h.pending().map((p) => p.ms),
    [5_000],
    'the first tick waits one interval',
  );
  await h.fire();
  assert.equal(ticks, 1);
  assert.deepEqual(
    h.pending().map((p) => p.ms),
    [5_000],
  );
  await h.fire();
  await h.fire();
  assert.equal(ticks, 3);
  assert.equal(poller.running, false, 'nothing left to follow');
  assert.equal(h.pending().length, 0);
  assert.equal(h.listeners.size, 0, 'the visibility listener is gone');
});

test('start can tick at once, and starting twice changes nothing', async () => {
  const h = harness();
  let ticks = 0;
  const poller = createPoller({
    intervalMs: 5_000,
    timers: h.timers,
    visibility: h.visibility,
    tick: async () => (ticks++, true),
  });
  poller.start(true);
  poller.start(true);
  assert.deepEqual(
    h.pending().map((p) => p.ms),
    [0],
  );
  assert.equal(h.listeners.size, 1);
  await h.fire();
  assert.equal(ticks, 1);
  poller.stop();
});

test('a hidden page is not polled, and coming back ticks at once', async () => {
  const h = harness();
  let ticks = 0;
  const poller = createPoller({
    intervalMs: 5_000,
    timers: h.timers,
    visibility: h.visibility,
    tick: async () => (ticks++, true),
  });
  poller.start();
  await h.show(false);
  await h.fire();
  assert.equal(ticks, 0, 'hidden: the timer fired and did nothing');
  assert.equal(h.pending().length, 0, 'and no timer is left spinning');
  assert.equal(poller.running, true);

  await h.show(true);
  assert.deepEqual(
    h.pending().map((p) => p.ms),
    [0],
    'visible again: next tick without waiting',
  );
  await h.fire();
  assert.equal(ticks, 1);
  assert.deepEqual(
    h.pending().map((p) => p.ms),
    [5_000],
  );
  poller.stop();
});

test('a failing tick is reported and retried slower, and a good one resets the pace', async () => {
  const h = harness();
  const errors: unknown[] = [];
  const outcomes: (boolean | Error)[] = [new Error('down'), new Error('still down'), true, false];
  const poller = createPoller({
    intervalMs: 5_000,
    maxIntervalMs: 12_000,
    timers: h.timers,
    visibility: h.visibility,
    onError: (e) => errors.push(e),
    tick: async () => {
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      return next ?? false;
    },
  });
  poller.start();
  await h.fire();
  assert.deepEqual(
    h.pending().map((p) => p.ms),
    [10_000],
    'one failure: twice the interval',
  );
  await h.fire();
  assert.deepEqual(
    h.pending().map((p) => p.ms),
    [12_000],
    'two failures: capped',
  );
  await h.fire();
  assert.deepEqual(
    h.pending().map((p) => p.ms),
    [5_000],
    'a success: back to the interval',
  );
  assert.equal(errors.length, 2);
  await h.fire();
  assert.equal(poller.running, false);
});

test('stop clears the timer and the listener, and a tick in flight does not schedule another', async () => {
  const h = harness();
  let release: (more: boolean) => void = () => {};
  const poller = createPoller({
    intervalMs: 5_000,
    timers: h.timers,
    visibility: h.visibility,
    tick: () => new Promise<boolean>((resolve) => (release = resolve)),
  });
  poller.start();
  poller.stop();
  assert.equal(h.pending().length, 0);
  assert.equal(h.listeners.size, 0);
  assert.equal(poller.running, false);

  poller.start(true);
  await h.fire();
  poller.stop();
  release(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.pending().length, 0, 'the answer of a stopped poller is dropped');

  // It can be started again after a stop.
  poller.start();
  assert.equal(h.pending().length, 1);
  poller.stop();
});

test('two ticks never overlap', async () => {
  const h = harness();
  let running = 0;
  let overlap = 0;
  let release: (more: boolean) => void = () => {};
  const poller = createPoller({
    intervalMs: 5_000,
    timers: h.timers,
    visibility: h.visibility,
    tick: () => {
      running++;
      overlap = Math.max(overlap, running);
      return new Promise<boolean>((resolve) => {
        release = (more) => {
          running--;
          resolve(more);
        };
      });
    },
  });
  poller.start(true);
  await h.fire();
  await h.show(false);
  await h.show(true);
  assert.equal(h.pending().length, 0, 'coming back while a tick runs does not queue a second one');
  release(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(overlap, 1);
  poller.stop();
});
