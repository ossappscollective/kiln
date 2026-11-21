import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allChosen,
  canCheckForUpdates,
  canRefresh,
  conflictsFrom,
  isRefreshable,
  looksStale,
  pendingConflicts,
  type RefreshFile,
  refreshDoneMessage,
  stalenessSummary,
  toResolutions,
} from './change-set-refresh.ts';

const set = (status: string, extra: Record<string, unknown> = {}) =>
  ({ status, branch: null, error: null, ...extra }) as Parameters<typeof isRefreshable>[0] & {
    error: string | null;
  };

test('only a draft, approved or failed change set without a branch can be refreshed', () => {
  for (const status of ['draft', 'approved', 'failed'])
    assert.equal(isRefreshable(set(status)), true, status);
  for (const status of ['applying', 'applied', 'discarded'])
    assert.equal(isRefreshable(set(status)), false, status);
  assert.equal(isRefreshable(set('failed', { branch: 'kiln/x' })), false);
  assert.equal(isRefreshable(set('approved', { branch: 'kiln/x' })), true);
});

test('who may refresh and who may check: the rights the server asks for', () => {
  assert.equal(canRefresh('member', set('draft')), true);
  assert.equal(canRefresh('viewer', set('draft')), false);
  assert.equal(canRefresh('owner', set('applied')), false);
  assert.equal(canCheckForUpdates('member', set('draft')), true);
  assert.equal(canCheckForUpdates('viewer', set('draft')), false);
});

test('a change set looks stale after a conflict, or when its stored error says the files changed', () => {
  assert.equal(looksStale(set('failed'), 'change_conflict'), true);
  assert.equal(looksStale(set('approved'), 'base_changed'), true);
  assert.equal(looksStale(set('approved'), 'timeout'), false);
  assert.equal(
    looksStale(
      set('failed', { error: 'The repository changed since this change set was made: a.txt.' }),
    ),
    true,
  );
  assert.equal(
    looksStale(
      set('approved', {
        error:
          'These files are not what the change set was made from on branch main of the local clone: they changed after it was created.',
      }),
    ),
    true,
  );
  assert.equal(looksStale(set('failed', { error: 'GitHub is down' })), false);
  assert.equal(
    looksStale(set('draft', { error: 'The repository changed since' })),
    false,
    'a draft has no apply error to go by',
  );
  assert.equal(looksStale(set('applied'), 'change_conflict'), false);
  assert.equal(
    looksStale(set('failed', { branch: 'kiln/x' }), 'change_conflict'),
    false,
    'it cannot be refreshed, so it is not offered',
  );
});

test('the staleness sentence', () => {
  assert.match(
    stalenessSummary({ stale: false, files: [{ path: 'a', state: 'same' }] }),
    /^Up to date/,
  );
  assert.equal(
    stalenessSummary({
      stale: true,
      files: [
        { path: 'a', state: 'changed' },
        { path: 'b', state: 'already_applied' },
        { path: 'c', state: 'conflict' },
        { path: 'd', state: 'conflict' },
        { path: 'e', state: 'same' },
      ],
    }),
    'Out of date: 1 file can be merged, 1 already in the repository, 2 files in conflict.',
  );
});

const files: RefreshFile[] = [
  { path: 'a', state: 'same', outcome: 'unchanged' },
  {
    path: 'b',
    state: 'conflict',
    outcome: 'conflict',
    reason: 'overlap',
    base: 'x',
    ours: 'y',
    theirs: 'z',
  },
  {
    path: 'c',
    state: 'conflict',
    outcome: 'conflict',
    reason: 'deleted_upstream',
    base: 'x',
    ours: 'y',
    theirs: null,
  },
  { path: 'd', state: 'conflict', outcome: 'kept_mine' },
];

test('conflicts must all be chosen before the request is sent, and only chosen paths are sent', () => {
  assert.deepEqual(
    pendingConflicts(files).map((f) => f.path),
    ['b', 'c'],
  );
  assert.equal(allChosen(files, {}), false);
  assert.equal(allChosen(files, { b: 'mine' }), false);
  assert.equal(allChosen(files, { b: 'mine', c: 'theirs' }), true);
  assert.equal(allChosen([{ path: 'a', state: 'same', outcome: 'unchanged' }], {}), true);
  assert.deepEqual(toResolutions({ b: 'mine', c: undefined, d: 'theirs' }), {
    b: 'mine',
    d: 'theirs',
  });
});

test('the message after a refresh says what happened, and that approval is needed again', () => {
  const merged: RefreshFile[] = [
    { path: 'a', state: 'changed', outcome: 'merged' },
    { path: 'b', state: 'already_applied', outcome: 'dropped' },
    { path: 'c', state: 'conflict', outcome: 'kept_theirs' },
  ];
  assert.equal(
    refreshDoneMessage({
      files: merged,
      nothingLeft: false,
      unchanged: false,
      approvalCleared: true,
    }),
    "Refreshed: 1 file merged, 1 already in the repository, dropped, 1 dropped for the repository's text. It is a draft again and needs approval.",
  );
  assert.match(
    refreshDoneMessage({ files: [], nothingLeft: true, unchanged: false, approvalCleared: true }),
    /Nothing left to apply/,
  );
  assert.match(
    refreshDoneMessage({ files: [], nothingLeft: false, unchanged: true, approvalCleared: false }),
    /as it was/,
  );
  assert.equal(
    refreshDoneMessage({
      files: merged.slice(0, 1),
      nothingLeft: false,
      unchanged: false,
      approvalCleared: false,
    }),
    'Refreshed: 1 file merged.',
  );
});

test('conflictsFrom reads the 409 body and nothing else', () => {
  const body = { error: 'refresh_conflicts', files, conflicts: 2, refreshedFrom: 'abc' };
  assert.deepEqual(conflictsFrom(body), { files, conflicts: 2, refreshedFrom: 'abc' });
  assert.equal(conflictsFrom({ error: 'invalid_state' }), undefined);
  assert.equal(conflictsFrom({ error: 'refresh_conflicts' }), undefined);
});
