import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSourceRows, failedSources, newestRead, pageStatus, runActive, runStates, sourceState } from './sync-sources.ts';

const ok = { lastReadAt: 100, lastAttemptAt: 100, failed: false };
const failed = { lastReadAt: 50, lastAttemptAt: 120, failed: true };
const never = { lastReadAt: null, lastAttemptAt: null, failed: false };

test('state: running wins, then failed (even with older data), then never, else ok', () => {
  assert.equal(sourceState(failed, 'running'), 'running');
  assert.equal(sourceState(failed), 'failed');
  assert.equal(sourceState(never), 'never');
  assert.equal(sourceState(ok), 'ok');
  assert.equal(sourceState(ok, 'failed'), 'failed');
  assert.equal(sourceState(ok, 'skipped'), 'ok');
});

test('rows: what needs a look first, then critical order; a hint only where something is wrong', () => {
  const rows = buildSourceRows([
    { appId: 'a', platform: 'ios', kind: 'analytics', reading: ok },
    { appId: 'a', platform: 'ios', kind: 'reviews', reading: failed },
    { appId: 'a', platform: 'ios', kind: 'app', reading: ok },
    { appId: 'a', platform: 'ios', kind: 'eas', reading: never },
  ]);
  assert.deepEqual(rows.map((r) => r.kind), ['reviews', 'eas', 'app', 'analytics']);
  assert.ok(rows[0]?.hint);
  assert.ok(rows[1]?.hint);
  assert.equal(rows[2]?.hint, null);
  assert.equal(failedSources(rows), 1);
  assert.equal(newestRead(rows), 100);
});

test('a run in progress turns a row to running and clears its hint', () => {
  const rows = buildSourceRows([{ appId: 'a', platform: 'ios', kind: 'reviews', reading: failed }], { 'a:reviews': 'queued' });
  assert.equal(rows[0]?.state, 'running');
  assert.equal(rows[0]?.hint, null);
});

test('page status names the failed kinds it cares about and its newest read', () => {
  const rows = buildSourceRows([
    { appId: 'a', platform: 'ios', kind: 'reviews', reading: failed },
    { appId: 'b', platform: 'android', kind: 'reviews', reading: ok },
    { appId: 'a', platform: 'ios', kind: 'analytics', reading: failed },
  ]);
  assert.deepEqual(pageStatus(rows, ['reviews']), { failed: ['reviews'], newest: 100 });
  assert.deepEqual(pageStatus(rows, ['eas']), { failed: [], newest: null });
});

test('run states merge the server plan and the browser kinds, and say when the run is over', () => {
  const runs = runStates('a', [{ kind: 'app', state: 'queued', jobId: '1' }, { kind: 'eas', state: 'skipped', reason: 'not_linked' }], { products: 'running' });
  assert.deepEqual(runs, { 'a:app': 'queued', 'a:eas': 'skipped', 'a:products': 'running' });
  assert.equal(runActive(runs), true);
  assert.equal(runActive({ 'a:app': 'done', 'a:eas': 'skipped' }), false);
});
