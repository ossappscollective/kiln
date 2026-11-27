import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RemovalResult } from '@kiln/core';
import {
  applyResults,
  canUndo,
  emptyingConsequence,
  failAll,
  fileIdOf,
  isRemoving,
  NO_STATES,
  needsConfirm,
  outcomeOf,
  pruneStates,
  removingCount,
  startRemoving,
} from './removal.ts';

const say = (reason: string) => `says:${reason}`;
const res = (
  index: number,
  outcome: RemovalResult['outcome'],
  reason?: RemovalResult['reason'],
): RemovalResult => ({
  index,
  id: {},
  outcome,
  ...(reason ? { reason } : {}),
});

test('a file is named by the store ref, else by its blob id, else by its place', () => {
  assert.deepEqual(fileIdOf({ ref: 'r1', oid: 'o1', position: 3 }), { ref: 'r1' });
  assert.deepEqual(fileIdOf({ oid: 'o1', position: 3 }), { oid: 'o1' });
  assert.deepEqual(fileIdOf({ ref: '', oid: '', position: 3 }), { position: 3 });
});

test('starting a removal marks every image of it as removing and clears an earlier error', () => {
  const failed = failAll(NO_STATES, ['a'], 'boom');
  const started = startRemoving(failed, ['a', 'b']);
  assert.deepEqual(started, { a: { status: 'removing' }, b: { status: 'removing' } });
  assert.equal(isRemoving(started, 'a'), true);
  assert.equal(isRemoving(started, 'z'), false);
  assert.equal(removingCount(started), 2);
  assert.deepEqual(NO_STATES, {}, 'the shared empty state is never changed');
});

test('the answer ends the removing state of each image on its own: gone or restored with a reason', () => {
  const started = startRemoving(NO_STATES, ['a', 'b', 'c', 'd']);
  const done = applyResults(
    started,
    ['a', 'b', 'c', 'd'],
    [res(0, 'removed'), res(1, 'not_found', 'stale_store_ref'), res(2, 'already_removed')],
    say,
  );
  assert.deepEqual(done.gone, ['a', 'c']);
  assert.deepEqual(done.refused, [{ key: 'b', reason: 'stale_store_ref' }]);
  assert.deepEqual(done.states.b, {
    status: 'error',
    reason: 'stale_store_ref',
    message: 'says:stale_store_ref',
  });
  assert.deepEqual(
    done.states.d,
    { status: 'error', reason: 'failed', message: 'says:failed' },
    'no answer for it is an error, not silence',
  );
  assert.equal(done.states.a, undefined);
  assert.equal(removingCount(done.states), 0);
  assert.deepEqual(done.summary, { removed: 1, alreadyRemoved: 1, notFound: 1 });
  assert.deepEqual(outcomeOf(done.summary), { removed: 1, alreadyRemoved: 1, refused: 1 });
});

test('a request that failed as a whole restores every image with the same sentence', () => {
  const started = startRemoving(NO_STATES, ['a', 'b']);
  const failed = failAll(started, ['a', 'b'], 'The version is locked');
  assert.deepEqual(failed.a, {
    status: 'error',
    reason: 'failed',
    message: 'The version is locked',
  });
  assert.equal(removingCount(failed), 0);
});

test('the states of images that left the set are dropped', () => {
  const states = startRemoving(NO_STATES, ['a', 'b']);
  assert.equal(pruneStates(states, ['a', 'b', 'c']), states);
  assert.deepEqual(pruneStates(states, ['b']), { b: { status: 'removing' } });
});

test('the person is asked first only for every image of a set, or more than 5', () => {
  assert.equal(needsConfirm(10, 1), false);
  assert.equal(needsConfirm(10, 5), false);
  assert.equal(needsConfirm(10, 6), true);
  assert.equal(needsConfirm(3, 3), true);
  assert.equal(needsConfirm(1, 1), true, 'the last image of a set');
  assert.equal(needsConfirm(4, 0), false);
});

test('emptying a set says what the store needs: required for the largest sizes, nothing for the legacy ones', () => {
  const shot = (device: string) => ({ kind: 'screenshot' as const, device });
  assert.equal(emptyingConsequence('app_store', shot('iphone_6_9'), 3, 3), 'required');
  assert.equal(emptyingConsequence('app_store', shot('ipad_13'), 1, 1), 'required');
  assert.equal(emptyingConsequence('app_store', shot('iphone_5_5'), 3, 3), 'optional');
  assert.equal(emptyingConsequence('app_store', shot('iphone_6_9'), 3, 2), 'none');
  assert.equal(emptyingConsequence('google_play', shot('phone'), 2, 2), 'required');
});

test('undo is offered when the removal made a staged change of its own', () => {
  assert.equal(canUndo(false, { removed: 3, alreadyRemoved: 0, notFound: 0 }), true);
  assert.equal(
    canUndo(true, { removed: 3, alreadyRemoved: 0, notFound: 0 }),
    false,
    'undoing would drop earlier staged changes',
  );
  assert.equal(canUndo(false, { removed: 0, alreadyRemoved: 2, notFound: 1 }), false);
});
