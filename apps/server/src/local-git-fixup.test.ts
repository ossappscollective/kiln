import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BRANCH,
  git,
  scratch,
  setup,
  SSH_KEYGEN,
  SUBTITLE,
  snapshot,
  sshKey,
  sshVerifies,
} from './local-git-test-helpers.ts';
import {
  createBranchCommit,
  fixupBranchCommit,
  parseWorktreeBranches,
  readBranchFiles,
  type GitSigning,
} from './services/local-git.ts';

/**
 * Adding one commit on top of an existing branch of a local clone (ADR 0005, "Fixing up a branch").
 * Real git repositories in temp folders; the API-level scenarios are in change-set-fixup.test.ts.
 */

type Setup = ReturnType<typeof setup>;
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const PATH = SUBTITLE.path;

/** A repository with the branch made by the usual first commit. */
async function withBranch() {
  const s = setup();
  const first = await createBranchCommit({
    gitPath: s.wrapper.path,
    path: s.dir,
    roots: s.roots,
    baseBranch: 'main',
    branch: BRANCH,
    files: [SUBTITLE],
    message: 'first',
    author: { name: 'Ada', email: 'ada@example.com' },
    now: NOW,
  });
  assert.equal(first.ok, true);
  if (!first.ok) throw new Error('setup');
  return { s, tip: first.commit };
}

const fix = (s: Setup, tip: string, over: Partial<Parameters<typeof fixupBranchCommit>[0]> = {}) =>
  fixupBranchCommit({
    gitPath: s.wrapper.path,
    path: s.dir,
    roots: s.roots,
    branch: BRANCH,
    expectedTip: tip,
    changes: [{ path: PATH, content: 'Newer subtitle\n' }],
    message: 'Fix up: subtitle',
    author: { name: 'Ada', email: 'ada@example.com' },
    now: NOW + 1000,
    ...over,
  });

test('parseWorktreeBranches reads the branch lines of the porcelain output', () => {
  const out = 'worktree /a\nHEAD abc\nbranch refs/heads/main\n\nworktree /b\nHEAD def\nbranch refs/heads/mrm/x\n\nworktree /c\nHEAD 123\ndetached\n';
  assert.deepEqual(parseWorktreeBranches(out), ['main', 'mrm/x']);
});

test('a fix up is one commit on the old tip; the ref moves forward with the old value supplied; nothing else changes', async () => {
  const { s, tip } = await withBranch();
  const before = snapshot(s.dir);
  const done = await fix(s, tip);
  assert.equal(done.ok, true, JSON.stringify(done));
  if (!done.ok) return;
  assert.equal(done.parent, tip);
  assert.equal(done.changed, 1);
  assert.equal(git(s.dir, 'rev-parse', `refs/heads/${BRANCH}`), done.commit);
  assert.equal(git(s.dir, 'rev-parse', `${done.commit}^`), tip);
  assert.equal(git(s.dir, 'rev-list', '--count', `${tip}..${done.commit}`), '1');
  assert.equal(git(s.dir, 'show', `${done.commit}:${PATH}`), 'Newer subtitle');
  assert.equal(git(s.dir, 'diff', '--name-only', tip, done.commit), PATH);
  assert.equal(git(s.dir, 'log', '-1', '--format=%an <%ae>', done.commit), 'Ada <ada@example.com>');
  const after = snapshot(s.dir);
  assert.deepEqual({ ...after, refs: '' }, { ...before, refs: '' }, 'status, HEAD, index, config, hooks and files are byte-identical');
  const writes = s.wrapper.calls().filter((c) => /update-ref/.test(c.args));
  assert.ok(writes.at(-1)?.args.endsWith(` ${done.commit} ${tip}`), 'update-ref <ref> <new> <old>');
  assert.equal(s.wrapper.calls().some((c) => /--force|reset|checkout|rebase|--amend|push/.test(c.args)), false);
  // A second fix up needs the new tip.
  const stale = await fix(s, tip, { changes: [{ path: PATH, content: 'Third\n' }] });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, 'branch_moved');
  assert.equal(git(s.dir, 'rev-parse', `refs/heads/${BRANCH}`), done.commit, 'the ref was not touched');
});

test('branch_moved: the tip is not the one that was read; nothing is written, not even an object for the ref', async () => {
  const { s, tip } = await withBranch();
  git(s.dir, 'update-ref', `refs/heads/${BRANCH}`, git(s.dir, 'rev-parse', 'main'));
  const moved = await fix(s, tip);
  assert.equal(moved.ok, false);
  if (!moved.ok) assert.equal(moved.code, 'branch_moved');
  assert.equal(git(s.dir, 'rev-parse', `refs/heads/${BRANCH}`), git(s.dir, 'rev-parse', 'main'));
  const gone = await fix(s, tip, { branch: 'mrm/no-such-branch' });
  assert.equal(gone.ok, false);
});

test('a branch that is checked out (HEAD or a linked worktree) or being rebased is refused; the ref is not moved', async () => {
  const { s, tip } = await withBranch();
  git(s.dir, 'checkout', '-q', BRANCH);
  const head = await fix(s, tip);
  assert.equal(head.ok, false);
  if (!head.ok) assert.equal(head.code, 'branch_checked_out');
  const read = await readBranchFiles({ gitPath: s.wrapper.path, path: s.dir, roots: s.roots, branch: BRANCH, paths: [PATH] });
  assert.equal(read.ok, false);
  git(s.dir, 'checkout', '-q', 'main');
  const wt = join(scratch(), 'wt');
  git(s.dir, 'worktree', 'add', '-q', wt, BRANCH);
  const other = await fix(s, tip);
  assert.equal(other.ok, false);
  if (!other.ok) assert.equal(other.code, 'branch_checked_out');
  git(s.dir, 'worktree', 'remove', '--force', wt);
  // A rebase in progress that names the branch.
  const rebase = join(s.dir, '.git', 'rebase-merge');
  mkdirSync(rebase);
  writeFileSync(join(rebase, 'head-name'), `refs/heads/${BRANCH}\n`);
  const rebasing = await fix(s, tip);
  assert.equal(rebasing.ok, false);
  if (!rebasing.ok) assert.equal(rebasing.code, 'branch_checked_out');
  rmSync(rebase, { recursive: true });
  assert.equal(git(s.dir, 'rev-parse', `refs/heads/${BRANCH}`), tip);
  assert.equal((await fix(s, tip)).ok, true, 'and once it is free the fix up works');
});

test('refused: the default branch of the clone is another branch, but a bad name, a bad path, a symlink and a folder outside the roots are all refused', async () => {
  const { s, tip } = await withBranch();
  for (const branch of ['--force', 'a..b', 'HEAD', 'x.lock']) {
    const res = await fix(s, tip, { branch });
    assert.equal(res.ok, false, branch);
  }
  for (const path of ['../x', '/etc/passwd', '.git/config', 'a/../../b', '']) {
    const res = await fix(s, tip, { changes: [{ path, content: 'x' }] });
    assert.equal(res.ok, false, path);
  }
  const outside = await fix(s, tip, { path: scratch() });
  assert.equal(outside.ok, false);
  assert.equal(git(s.dir, 'rev-parse', `refs/heads/${BRANCH}`), tip);
  const same = await fix(s, tip, { changes: [{ path: PATH, content: SUBTITLE.after ?? '' }] });
  assert.equal(same.ok, false, 'no change, no commit');
  if (!same.ok) assert.equal(same.code, 'no_changes');
});

test('a file can be added and deleted by a fix up, and a text file is read back byte for byte', async () => {
  const { s, tip } = await withBranch();
  const done = await fix(s, tip, { changes: [{ path: 'fastlane/metadata/en-US/keywords.txt', content: 'a,b\r\nc\n' }, { path: 'fastlane/metadata/de-DE/subtitle.txt' }] });
  assert.equal(done.ok, true, JSON.stringify(done));
  if (!done.ok) return;
  assert.equal(git(s.dir, 'ls-tree', '--name-only', done.commit, 'fastlane/metadata/de-DE/subtitle.txt'), '');
  const read = await readBranchFiles({ gitPath: s.wrapper.path, path: s.dir, roots: s.roots, branch: BRANCH, paths: ['fastlane/metadata/en-US/keywords.txt', 'fastlane/metadata/de-DE/subtitle.txt'] });
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.tip, done.commit);
  assert.equal(read.texts.get('fastlane/metadata/en-US/keywords.txt'), 'a,b\r\nc\n');
  assert.equal(read.texts.get('fastlane/metadata/de-DE/subtitle.txt'), undefined);
});

test('no hook fires and a hostile config runs nothing', async () => {
  const { s, tip } = await withBranch();
  const marker = join(s.base, 'pwned');
  const touch = `touch '${marker}'`;
  const hooksDir = join(s.dir, '.git', 'hooks');
  writeFileSync(join(s.dir, '.gitattributes'), '* filter=evil\n');
  git(s.dir, 'add', '.gitattributes');
  git(s.dir, 'commit', '-q', '-m', 'attrs');
  for (const name of ['pre-commit', 'post-commit', 'commit-msg', 'reference-transaction', 'pre-push', 'post-index-change']) {
    writeFileSync(join(hooksDir, name), `#!/bin/sh\n${touch}\n`);
    chmodSync(join(hooksDir, name), 0o755);
  }
  for (const [key, value] of [['core.fsmonitor', touch], ['filter.evil.clean', touch], ['filter.evil.smudge', touch], ['filter.evil.required', 'true'], ['core.editor', touch], ['gpg.program', touch], ['commit.gpgsign', 'true']]) {
    git(s.dir, 'config', key as string, value as string);
  }
  const done = await fix(s, tip);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(existsSync(marker), false, 'nothing from the repository ran');
  if (done.ok) assert.equal(git(s.dir, 'cat-file', '-p', done.commit).includes('gpgsig'), false, 'the repository config cannot make it sign');
});

const NO_SSH = SSH_KEYGEN ? undefined : 'ssh-keygen is not installed';
const sshSigning = (key: string, program: string): GitSigning => ({ format: 'ssh', key, program });

test('signing: with the server key the fix up commit is signed; a failing signer leaves the ref where it was', { skip: NO_SSH }, async () => {
  const { s, tip } = await withBranch();
  const k = sshKey();
  const done = await fix(s, tip, { signing: sshSigning(k.key, SSH_KEYGEN ?? '') });
  assert.equal(done.ok, true, JSON.stringify(done));
  if (!done.ok) return;
  assert.deepEqual(done.signature, { format: 'ssh' });
  assert.equal(sshVerifies(s.dir, done.commit, k.signers), true);
  assert.equal(git(s.dir, 'rev-parse', `${done.commit}^`), tip);
  const broken = await fix(s, done.commit, { changes: [{ path: PATH, content: 'Again\n' }], signing: sshSigning(join(s.base, 'no-such-key'), SSH_KEYGEN ?? '') });
  assert.equal(broken.ok, false);
  if (!broken.ok) assert.equal(broken.code, 'signing_failed');
  assert.equal(git(s.dir, 'rev-parse', `refs/heads/${BRANCH}`), done.commit, 'unsigned commits are never written when signing was asked for');
});

test('the repository text is read from the branch, not from the working tree', async () => {
  const { s } = await withBranch();
  writeFileSync(join(s.dir, PATH), 'working tree edit\n');
  const read = await readBranchFiles({ gitPath: s.wrapper.path, path: s.dir, roots: s.roots, branch: BRANCH, paths: [PATH] });
  assert.equal(read.ok, true);
  if (read.ok) assert.equal(read.texts.get(PATH), 'New subtitle\n');
});
