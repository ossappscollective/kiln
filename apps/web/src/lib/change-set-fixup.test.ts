import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allFixupChosen,
  behindNote,
  canFixup,
  canFixupFromStore,
  canRecompute,
  canRefreshFromStore,
  diffSummary,
  droppedReason,
  type FixupFile,
  fixupBody,
  fixupConflictsFrom,
  fixupDoneMessage,
  fixupPending,
  fixupPreviewMessage,
  fixupPromise,
  hasBranch,
  recomputeBody,
  recomputeDoneMessage,
} from './change-set-fixup.ts';
import type { ChangeSetView } from './types.ts';

const set = (patch: Partial<ChangeSetView> = {}): ChangeSetView =>
  ({
    id: 'c1',
    status: 'applied',
    branch: 'mrm/x',
    outcome: null,
    origin: null,
    fixups: [],
    files: [],
    ...patch,
  }) as unknown as ChangeSetView;

test('who may fix up: applying rights, a branch, and an applied or failed change set', () => {
  assert.equal(canFixup('owner', set()), true);
  assert.equal(canFixup('admin', set({ status: 'failed' })), true);
  assert.equal(canFixup('member', set()), false);
  assert.equal(canFixup('viewer', set()), false);
  assert.equal(canFixup('owner', set({ branch: null })), false);
  assert.equal(canFixup('owner', set({ status: 'draft' })), false);
  assert.equal(canFixup('owner', set({ status: 'discarded' })), false);
  assert.equal(hasBranch(set({ branch: '' })), false);
});

test('who may recompute: a store pull without a branch, changesets.write and listing.read', () => {
  const pull = set({
    status: 'draft',
    branch: null,
    origin: { source: 'store_pull', appId: 'a', channel: 'live' },
  });
  assert.equal(canRecompute('member', pull), true);
  assert.equal(canRecompute('owner', set({ ...pull, status: 'approved' })), true);
  assert.equal(canRecompute('owner', set({ ...pull, status: 'failed' })), true);
  assert.equal(canRecompute('viewer', pull), false);
  assert.equal(canRecompute('owner', set({ ...pull, status: 'applied' })), false);
  assert.equal(canRecompute('owner', set({ ...pull, status: 'failed', branch: 'mrm/x' })), false);
  assert.equal(canRecompute('owner', set({ ...pull, origin: null })), false);
  assert.equal(canRefreshFromStore('member'), true);
  assert.equal(canRefreshFromStore('viewer'), false);
  const applied = set({ origin: { source: 'store_pull' } });
  assert.equal(canFixupFromStore('owner', applied), true);
  assert.equal(canFixupFromStore('member', applied), false);
  assert.equal(canFixupFromStore('owner', set()), false);
});

test('the request body carries only the choices made, and push and PR only for a local commit', () => {
  const base = { push: false, openPr: false, local: true, recompute: false };
  assert.deepEqual(fixupBody(base, {}, {}, false), {});
  assert.deepEqual(fixupBody(base, { a: 'mine', b: undefined }, { c: 'theirs' }, true), {
    resolutions: { a: 'mine' },
    branchResolutions: { c: 'theirs' },
    dryRun: true,
  });
  assert.deepEqual(fixupBody({ ...base, push: true }, {}, {}, false), { push: true });
  assert.deepEqual(fixupBody({ ...base, openPr: true }, {}, {}, false), {
    push: true,
    openPr: true,
  });
  assert.deepEqual(
    fixupBody({ ...base, push: true, openPr: true, local: false }, {}, {}, false),
    {},
    'GitHub mode updates the pull request itself',
  );
  assert.deepEqual(fixupBody({ ...base, recompute: true }, {}, {}, false), { recompute: true });
});

test('conflicts of both comparisons are read from the 409 bodies and need their own choices', () => {
  const file = (path: string, stage?: 'repository' | 'branch'): FixupFile => ({
    path,
    state: 'conflict',
    outcome: 'conflict',
    leavesSet: false,
    ...(stage ? { stage } : {}),
  });
  const repo = fixupConflictsFrom({
    error: 'refresh_conflicts',
    files: [file('a'), { ...file('b'), outcome: 'commit' }],
    conflicts: 1,
  });
  assert.equal(repo?.stage, 'repository');
  assert.equal(repo?.files[0]?.stage, 'repository');
  const branch = fixupConflictsFrom({
    error: 'fixup_conflicts',
    files: [file('a'), file('b', 'repository')],
  });
  assert.equal(branch?.stage, 'branch');
  assert.equal(branch?.conflicts, 2);
  assert.equal(branch?.files[0]?.stage, 'branch');
  assert.equal(branch?.files[1]?.stage, 'repository', 'a stage the server named is kept');
  assert.equal(fixupConflictsFrom({ error: 'branch_moved' }), undefined);
  assert.equal(fixupConflictsFrom({ error: 'fixup_conflicts' }), undefined);
  const files = [file('a', 'repository'), file('b', 'branch')];
  assert.equal(fixupPending(files).length, 2);
  assert.equal(allFixupChosen(files, { a: 'mine' }, {}), false);
  assert.equal(
    allFixupChosen(files, { a: 'mine' }, { a: 'theirs' }),
    false,
    'b needs a branch choice',
  );
  assert.equal(allFixupChosen(files, { a: 'mine' }, { b: 'theirs' }), true);
  assert.equal(allFixupChosen([], {}, {}), true);
});

test('the words: the promise, the preview, the result', () => {
  assert.match(
    fixupPromise('mrm/x'),
    /adds one commit to the branch mrm\/x\. It does not rewrite history/,
  );
  assert.equal(
    fixupPreviewMessage({ nothingToFix: true, willCommit: [] }),
    'Nothing to fix up: the branch already has everything.',
  );
  assert.equal(
    fixupPreviewMessage({ nothingToFix: false, willCommit: ['a'] }),
    '1 file would be in the new commit.',
  );
  assert.equal(
    fixupPreviewMessage({ nothingToFix: false, willCommit: ['a', 'b'] }),
    '2 files would be in the new commit.',
  );
  assert.match(fixupPreviewMessage({ nothingToFix: false, willCommit: [] }), /step is left/);
  const done = {
    nothingToFix: false,
    branch: 'mrm/x',
    commit: { sha: 'abcdef123456', parent: 'p', files: 1, signed: false },
    pullRequest: { state: 'none' as const },
  };
  assert.equal(fixupDoneMessage(done), 'Added commit abcdef1 to mrm/x.');
  assert.equal(
    fixupDoneMessage({ ...done, pullRequest: { state: 'opened' } }),
    'Added commit abcdef1 to mrm/x. The pull request is open.',
  );
  assert.match(
    fixupDoneMessage({ nothingToFix: true, branch: 'b', pullRequest: { state: 'none' } }),
    /^Nothing to fix up/,
  );
  assert.equal(
    behindNote(set({ outcome: { push: { status: 'behind' } } as ChangeSetView['outcome'] })),
    'The commit is in the local clone only. Push the branch to put it on GitHub.',
  );
  assert.equal(behindNote(set()), null);
});

test('recompute: the summary of what moved, and the message after it', () => {
  const d = (field: string, change: 'store_changed' | 'unchanged' | 'added' | 'dropped') => ({
    locale: 'en-US',
    repoLocale: 'en-US',
    field,
    change,
  });
  assert.equal(
    diffSummary([d('a', 'unchanged')]),
    'The store text is the same as when the pull was made.',
  );
  assert.equal(
    diffSummary([
      d('a', 'store_changed'),
      d('b', 'store_changed'),
      d('c', 'added'),
      d('d', 'dropped'),
    ]),
    '2 fields changed in the store, 1 new, 1 left out.',
  );
  assert.equal(diffSummary([d('a', 'store_changed')]), '1 field changed in the store.');
  const base = {
    nothingLeft: false,
    unchanged: false,
    approvalCleared: false,
    diffFromPrevious: [d('a', 'store_changed')],
  };
  assert.equal(
    recomputeDoneMessage(base),
    'Recomputed from the live store. 1 field changed in the store.',
  );
  assert.match(
    recomputeDoneMessage({ ...base, approvalCleared: true }),
    /draft again and needs approval/,
  );
  assert.match(recomputeDoneMessage({ ...base, nothingLeft: true }), /Discard the change set/);
  assert.match(recomputeDoneMessage({ ...base, unchanged: true }), /unchanged/);
  assert.match(droppedReason('identical'), /already/);
  assert.match(droppedReason('repo_ahead'), /undo/);
  assert.match(droppedReason(undefined), /cannot be pulled/);
  assert.deepEqual(recomputeBody(false), {});
  assert.deepEqual(recomputeBody(true), { refresh: true });
});
