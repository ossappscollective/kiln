import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Conflict,
  type ConsistencyReport,
  consistencyMonitor,
  createMonitor,
  reportShown,
} from './dev-assert.ts';

/** A manual scheduler: the "tick" ends when the test says so. */
function harness(enabled = true) {
  let pending: (() => void) | null = null;
  const logs: { message: string; conflict: Conflict }[] = [];
  let read: (() => ConsistencyReport) | null = null;
  const monitor = createMonitor({
    enabled,
    schedule: (flush) => {
      pending = flush;
    },
    log: (message, conflict) => logs.push({ message, conflict }),
    expose: (r) => {
      read = r;
    },
  });
  return {
    monitor,
    logs,
    endTick: () => {
      const f = pending;
      pending = null;
      f?.();
    },
    exposed: () => read,
    scheduled: () => pending !== null,
  };
}

test('two surfaces reporting different values for one fact in one tick is logged, naming both', () => {
  const h = harness();
  h.monitor.reportShown('pendingCount', 5, 'topBar');
  h.monitor.reportShown('pendingCount', 4, 'pendingHeader');
  h.endTick();
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0]?.message ?? '', /pendingCount: topBar shows 5, pendingHeader shows 4/);
  assert.deepEqual(h.logs[0]?.conflict.shown, [
    { surfaceId: 'topBar', value: 5 },
    { surfaceId: 'pendingHeader', value: 4 },
  ]);
});

test('equal values, one surface, other fact keys and lists in another order are not a conflict', () => {
  const h = harness();
  h.monitor.reportShown('pendingCount', 5, 'topBar');
  h.monitor.reportShown('pendingCount', 5, 'sidebarBadge');
  h.monitor.reportShown('stagedItems', 2, 'stagedTray');
  h.monitor.reportShown('localeList:a', ['b', 'a'], 'listingGrid');
  h.monitor.reportShown('localeList:a', ['a', 'b'], 'fixBar');
  h.endTick();
  assert.deepEqual(h.logs, []);
  assert.deepEqual(h.monitor.report().conflicts, []);
});

test('values of different ticks are not compared in the tick, a surface that updates is not a conflict', () => {
  const h = harness();
  h.monitor.reportShown('pendingCount', 5, 'topBar');
  h.endTick();
  h.monitor.reportShown('pendingCount', 6, 'pendingHeader');
  h.endTick();
  assert.deepEqual(h.logs, []);
  // ... but the last values of the surfaces are known, and they disagree now
  assert.deepEqual(h.monitor.report().disagreeingNow, ['pendingCount']);
});

test('the same disagreement is said once, a new one is said again', () => {
  const h = harness();
  for (let i = 0; i < 3; i++) {
    h.monitor.reportShown('pendingCount', 5, 'topBar');
    h.monitor.reportShown('pendingCount', 4, 'pendingHeader');
    h.endTick();
  }
  assert.equal(h.logs.length, 1);
  h.monitor.reportShown('pendingCount', 5, 'topBar');
  h.monitor.reportShown('pendingCount', 3, 'pendingHeader');
  h.endTick();
  assert.equal(h.logs.length, 2);
});

test('the report is exposed once, as a function that returns what was shown and every conflict', () => {
  const h = harness();
  assert.equal(h.exposed(), null);
  h.monitor.reportShown('liveVersion:ios-1', '1.19.0', 'nextStep');
  h.monitor.reportShown('liveVersion:ios-1', null, 'appDashboardTiles');
  h.endTick();
  const report = h.exposed()?.();
  assert.deepEqual(report?.latest, {
    'liveVersion:ios-1': { nextStep: '1.19.0', appDashboardTiles: null },
  });
  assert.equal(report?.conflicts.length, 1);
  assert.equal(report?.conflicts[0]?.factKey, 'liveVersion:ios-1');
  assert.deepEqual(report?.disagreeingNow, ['liveVersion:ios-1']);
});

test('disabled (production): nothing is recorded, scheduled, logged or exposed', () => {
  const h = harness(false);
  h.monitor.reportShown('pendingCount', 5, 'topBar');
  h.monitor.reportShown('pendingCount', 4, 'pendingHeader');
  assert.equal(h.scheduled(), false);
  h.endTick();
  assert.deepEqual(h.logs, []);
  assert.equal(h.exposed(), null);
  assert.deepEqual(h.monitor.report(), { latest: {}, conflicts: [], disagreeingNow: [] });
});

test('the default monitor is off outside development (node has no import.meta.env.DEV): reportShown is a no-op', () => {
  consistencyMonitor.reset();
  reportShown('pendingCount', 5, 'topBar');
  reportShown('pendingCount', 4, 'pendingHeader');
  assert.deepEqual(consistencyMonitor.report(), { latest: {}, conflicts: [], disagreeingNow: [] });
  assert.equal((globalThis as { window?: unknown }).window, undefined);
});

test('reset forgets everything', () => {
  const h = harness();
  h.monitor.reportShown('pendingCount', 5, 'topBar');
  h.monitor.reportShown('pendingCount', 4, 'pendingHeader');
  h.endTick();
  h.monitor.reset();
  assert.deepEqual(h.monitor.report(), { latest: {}, conflicts: [], disagreeingNow: [] });
});
