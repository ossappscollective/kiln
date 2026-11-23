import assert from 'node:assert/strict';
import { test } from 'node:test';
import { announceStagedChanged, batchAppIds, onStagedChanged, type StagedChangedDetail } from './staged-sync.ts';

test('an announcement reaches every listener until it stops listening', () => {
  const bus = new EventTarget();
  const a: StagedChangedDetail[] = [];
  const b: StagedChangedDetail[] = [];
  const offA = onStagedChanged((d) => a.push(d), bus);
  onStagedChanged((d) => b.push(d), bus);
  announceStagedChanged('app1', 'discard', bus);
  offA();
  announceStagedChanged('app2', 'stage', bus);
  assert.deepEqual(a, [{ appId: 'app1', reason: 'discard' }]);
  assert.deepEqual(b, [{ appId: 'app1', reason: 'discard' }, { appId: 'app2', reason: 'stage' }]);
});

test('no window, no listener: announcing and listening are harmless', () => {
  announceStagedChanged('x', 'publish', null);
  onStagedChanged(() => assert.fail('no'), null)();
});

test('announcements that arrive together run the refresh once with distinct ids', () => {
  const queue: (() => void)[] = [];
  const runs: string[][] = [];
  const batch = batchAppIds((ids) => runs.push(ids), (fn) => {
    queue.push(fn);
    return () => queue.splice(queue.indexOf(fn), 1);
  });
  batch.add('a');
  batch.add('b');
  batch.add('a');
  assert.equal(queue.length, 1);
  queue.shift()?.();
  assert.deepEqual(runs, [['a', 'b']]);
  batch.add('c');
  batch.cancel();
  assert.equal(queue.length, 0);
  batch.add('d');
  queue.shift()?.();
  assert.deepEqual(runs, [['a', 'b'], ['d']]);
});
