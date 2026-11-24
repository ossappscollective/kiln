import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReadingsScope, runsOfApps, scopeKey } from './sync-scope.ts';

test('an app switch is a changed scope; the same scope is not', () => {
  const s = createReadingsScope();
  assert.equal(s.begin(scopeKey('w', ['a'])).changed, true);
  assert.equal(s.begin(scopeKey('w', ['a'])).changed, false);
  assert.equal(s.begin(scopeKey('w', ['b'])).changed, true);
  assert.equal(s.begin(scopeKey('w2', ['b'])).changed, true);
});

test('a late answer for the app that was left is ignored', () => {
  const s = createReadingsScope();
  const forA = s.begin(scopeKey('w', ['a']));
  const forB = s.begin(scopeKey('w', ['b']));
  assert.equal(s.accepts(forA.token), false);
  assert.equal(s.accepts(forB.token), true);
  // Going back to A starts a new read: B's answer is now the late one.
  const again = s.begin(scopeKey('w', ['a']));
  assert.equal(s.accepts(forB.token), false);
  assert.equal(s.accepts(again.token), true);
});

test("runs of another app are not this app's: no busy state and no progress carried over", () => {
  const runs = {
    'a:reviews': 'running',
    'a:app': 'done',
    'b:eas': 'queued',
    'ab:eas': 'running',
  } as const;
  assert.deepEqual(runsOfApps(runs, ['b']), { 'b:eas': 'queued' });
  assert.deepEqual(runsOfApps(runs, ['a', 'b']), {
    'a:reviews': 'running',
    'a:app': 'done',
    'b:eas': 'queued',
  });
  assert.deepEqual(runsOfApps(runs, []), {});
});
