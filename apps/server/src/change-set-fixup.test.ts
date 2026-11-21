import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { GithubError } from '@kiln/connectors';
import type { Database } from '@kiln/db';
import { dbTest } from '@kiln/db/testing';
import { BranchRepo } from './fixup-test-helpers.ts';
import { buildRepo, git, gitWrapper, snapshot } from './local-git-test-helpers.ts';
import { bootRepoApp, FakeRepo, fastlaneFiles, TOKEN } from './repo-test-helpers.ts';
import { fixupMessageFor, planBranchFile } from './services/change-set-fixup.ts';
import { createCloneReads } from './services/clone-reads.ts';
import { clearRepoSnapshots } from './services/repo-snapshot.ts';

/**
 * Fixing up a branch that already exists: ONE new commit on top of it, never a rewrite (ADR 0005,
 * "Fixing up a branch"). Real git repositories for the local mode, a fake connector for GitHub.
 */

type Files = Record<string, string>;

const dirs: string[] = [];
const scratch = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kiln-fixup-')));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const DESCRIPTION = 'fastlane/metadata/en-US/description.txt';
const THREE = 'Line one\n\nLine two\n\nLine three\n';
const files = (): Files => ({ ...fastlaneFiles(), [DESCRIPTION]: THREE });

// ---------------------------------------------------------------------------------------------
// The pure part

test('planBranchFile: the rules for one file against the branch', () => {
  assert.deepEqual(planBranchFile('a', 'A', 'D', 'D'), { kind: 'keep', final: 'D', why: 'same' });
  // Nothing new wanted: a person's edit on the branch stays.
  assert.deepEqual(planBranchFile('a', 'A', 'A', 'T'), {
    kind: 'keep',
    final: 'T',
    why: 'nothing_new',
  });
  // Untouched on the branch: write the wanted text.
  assert.deepEqual(planBranchFile('a', 'A', 'D', 'A'), {
    kind: 'write',
    content: 'D',
    final: 'D',
    why: 'clean',
  });
  // Added and deleted files.
  assert.deepEqual(planBranchFile('a', undefined, 'D', undefined), {
    kind: 'write',
    content: 'D',
    final: 'D',
    why: 'clean',
  });
  assert.deepEqual(planBranchFile('a', 'A', undefined, 'A'), {
    kind: 'write',
    content: undefined,
    final: undefined,
    why: 'clean',
  });
  // Both changed, different lines: merged.
  const merged = planBranchFile(
    'a',
    'one\n\ntwo\n\nthree\n',
    'one\n\ntwo\n\nTHREE\n',
    'ONE\n\ntwo\n\nthree\n',
  );
  assert.deepEqual(merged, {
    kind: 'write',
    content: 'ONE\n\ntwo\n\nTHREE\n',
    final: 'ONE\n\ntwo\n\nTHREE\n',
    why: 'merged',
  });
  // Both changed the same line: a conflict, until a choice is made.
  assert.equal(planBranchFile('a', 'one\n', 'two\n', 'three\n').kind, 'conflict');
  assert.deepEqual(planBranchFile('a', 'one\n', 'two\n', 'three\n', 'mine'), {
    kind: 'write',
    content: 'two\n',
    final: 'two\n',
    why: 'chose_mine',
  });
  assert.deepEqual(planBranchFile('a', 'one\n', 'two\n', 'three\n', 'theirs'), {
    kind: 'keep',
    final: 'three\n',
    why: 'chose_theirs',
  });
});

test('fixupMessageFor: the summary and the files, a cap on long lists', () => {
  const message = fixupMessageFor(
    'abc',
    'Update   the\nsubtitle',
    [
      { path: 'a.txt', content: 'x', existed: true },
      { path: 'b.txt', existed: true },
      { path: 'c.txt', content: 'y', existed: false },
    ],
    false,
  );
  assert.match(
    message,
    /^Fix up: Update the subtitle\n\nChanged files \(3\):\n- a\.txt \(modified\)\n- b\.txt \(deleted\)\n- c\.txt \(added\)\n\nChange set abc/,
  );
  const many = fixupMessageFor(
    'abc',
    's',
    Array.from({ length: 60 }, (_, i) => ({ path: `f${i}`, content: 'x', existed: true })),
    false,
  );
  assert.match(many, /- and 10 more/);
  assert.equal(many.split('\n').filter((l) => l.startsWith('- f')).length, 50);
});

// ---------------------------------------------------------------------------------------------
// Local mode

type Boot = { write?: boolean };

async function boot(db: Database, options: Boot = {}) {
  const base = scratch();
  const root = join(base, 'dev');
  const dataDir = join(base, 'data');
  const cloneDir = join(dataDir, 'clones');
  for (const d of [root, dataDir]) mkdirSync(d);
  const wrapper = gitWrapper();
  const logs: string[] = [];
  const reads = createCloneReads({
    mode: 'clone',
    cloneDir,
    gitPath: wrapper.path,
    log: (line) => logs.push(line),
    local: { roots: [root], excluded: [dataDir, cloneDir] },
  });
  const bare = join(base, 'github-remote.git');
  git(base, 'init', '-q', '--bare', bare);
  const api = new FakeRepo();
  api.files = new Map(Object.entries(files()));
  clearRepoSnapshots();
  const localWrite = {
    enabled: options.write !== false,
    push: { url: () => bare, protocol: 'file' as const },
  };
  const t = await bootRepoApp(db, api, { reads, localWrite });
  return { t, api, base, root, bare, wrapper, logs };
}
type Booted = Awaited<ReturnType<typeof boot>>;

const repoPath = (id: string, suffix = '') => `/repositories/${id}${suffix}`;
const local = { mode: 'local_branch' } as const;

async function attached(b: Booted) {
  const dir = buildRepo(b.root, 'app', files());
  git(dir, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  const { repositoryId } = await b.t.connect();
  const res = await b.t.call(b.t.owner, 'PUT', repoPath(repositoryId, '/local'), { path: dir });
  assert.equal(res.status, 200, res.text);
  return { dir, repositoryId };
}

async function approvedSet(b: Booted, repositoryId: string) {
  const read = await b.t.call(b.t.owner, 'GET', repoPath(repositoryId, '/listing'));
  const listing = read.body.listing;
  listing.appStore.locales['en-US'].description = 'LINE ONE\n\nLine two\n\nLine three';
  const made = await b.t.call(b.t.owner, 'POST', repoPath(repositoryId, '/change-sets'), {
    summary: 'Update the description',
    listing,
  });
  assert.equal(made.status, 201, made.text);
  const id = made.body.changeSet.id as string;
  assert.equal((await b.t.call(b.t.owner, 'POST', `/change-sets/${id}/approve`)).status, 200);
  return id;
}

/** A set that changes line one of the description, approved and applied to a branch of the clone. */
async function appliedLocal(b: Booted, body: Record<string, unknown> = local) {
  const { dir, repositoryId } = await attached(b);
  const id = await approvedSet(b, repositoryId);
  const applied = await b.t.call(b.t.owner, 'POST', `/change-sets/${id}/apply`, body);
  assert.equal(applied.status, 200, applied.text);
  const set = applied.body.changeSet;
  assert.equal(
    git(dir, 'show', `${set.branch}:${DESCRIPTION}`),
    'LINE ONE\n\nLine two\n\nLine three',
  );
  return { dir, repositoryId, id, set, tip: set.commitSha as string, branch: set.branch as string };
}

/** A colleague edits the description on main of the clone. */
function colleague(dir: string, text = 'Line one\n\nLine two\n\nLINE THREE\n') {
  writeFileSync(join(dir, DESCRIPTION), text);
  git(dir, 'commit', '-q', '-am', 'colleague');
  clearRepoSnapshots();
}

/** A person's commit on the branch, made in a private worktree (the clone itself is not touched). */
function personCommit(dir: string, branch: string, text: string): string {
  const wt = join(scratch(), 'wt');
  git(dir, 'worktree', 'add', '-q', '--detach', wt, branch);
  writeFileSync(join(wt, DESCRIPTION), text);
  git(wt, 'commit', '-q', '-am', 'edit on the branch');
  const sha = git(wt, 'rev-parse', 'HEAD');
  git(dir, 'update-ref', `refs/heads/${branch}`, sha);
  git(dir, 'worktree', 'remove', '--force', wt);
  return sha;
}

const fixup = (b: Booted, id: string, body?: Record<string, unknown>, cookie = b.t.owner) =>
  b.t.call(cookie, 'POST', `/change-sets/${id}/fixup`, body);
const getSet = async (b: Booted, id: string) =>
  (await b.t.call(b.t.owner, 'GET', `/change-sets/${id}`)).body.changeSet;

dbTest(
  'fixup adds one commit on top of the branch: parent is the old tip, only the changed path, the clone untouched',
  async (db) => {
    const b = await boot(db);
    const a = await appliedLocal(b);
    colleague(a.dir);
    const before = snapshot(a.dir);
    const res = await fixup(b, a.id);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.nothingToFix, false);
    assert.equal(res.body.mode, 'local_branch');
    assert.equal(res.body.branch, a.branch);
    assert.equal(res.body.tip, a.tip);
    assert.deepEqual(res.body.willCommit, [DESCRIPTION]);
    const sha = res.body.commit.sha as string;
    assert.equal(res.body.commit.parent, a.tip);
    assert.equal(
      git(a.dir, 'rev-parse', `refs/heads/${a.branch}`),
      sha,
      'the branch moved forward',
    );
    assert.equal(
      git(a.dir, 'rev-parse', `${sha}^`),
      a.tip,
      'one new commit whose parent is the old tip',
    );
    assert.equal(git(a.dir, 'rev-list', '--count', `${a.tip}..${sha}`), '1');
    assert.equal(git(a.dir, 'diff', '--name-only', a.tip, sha), DESCRIPTION);
    assert.equal(git(a.dir, 'show', `${sha}:${DESCRIPTION}`), 'LINE ONE\n\nLine two\n\nLINE THREE');
    assert.match(
      git(a.dir, 'log', '-1', '--format=%B', sha),
      /^Fix up: Update the description\n\nChanged files \(1\):/,
    );
    // The clone: byte-identical apart from the branch ref.
    assert.deepEqual({ ...snapshot(a.dir), refs: '' }, { ...before, refs: '' });
    assert.equal(git(a.dir, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(
      git(a.dir, 'for-each-ref', 'refs/heads').split('\n').length,
      2,
      'no other branch was made',
    );
    // The record: latest commit in commitSha / outcome.commit, the history in fixups[].
    const set = res.body.changeSet;
    assert.equal(set.status, 'applied');
    assert.equal(set.commitSha, sha);
    assert.equal(set.branch, a.branch);
    assert.equal(set.outcome.commit.sha, sha);
    assert.equal(
      set.outcome.base.commit,
      a.set.outcome.base.commit,
      'the base of the first commit is unchanged',
    );
    assert.equal(set.fixups.length, 1);
    assert.deepEqual(
      { ...set.fixups[0], at: 0 },
      { at: 0, commit: sha, parent: a.tip, files: 1, pushed: false },
    );
    assert.equal(
      set.files[0].after,
      'LINE ONE\n\nLine two\n\nLINE THREE\n',
      'the stored text is what the branch holds now',
    );
    // Audit: counts and hashes, never text.
    const events = (await b.t.auditActions()).filter((e) => e.action === 'changeset.fixup');
    assert.equal(events.length, 1);
    assert.equal(
      JSON.stringify(await db.query('SELECT detail FROM audit_events')).includes('LINE THREE'),
      false,
    );
    // The same delta again: nothing to fix, no commit, no audit event.
    const again = await fixup(b, a.id);
    assert.equal(again.status, 200, again.text);
    assert.equal(again.body.nothingToFix, true);
    assert.equal(git(a.dir, 'rev-parse', `refs/heads/${a.branch}`), sha);
    assert.equal(
      (await b.t.auditActions()).filter((e) => e.action === 'changeset.fixup').length,
      1,
    );
    assert.equal((await getSet(b, a.id)).fixups.length, 1);
    // Never a force: update-ref was given the old value; nothing rewrites history.
    const refUpdates = b.wrapper.calls().filter((c) => /update-ref/.test(c.args));
    assert.ok(
      refUpdates.some((c) => c.args.endsWith(` ${sha} ${a.tip}`)),
      'update-ref <ref> <new> <old>',
    );
    assert.deepEqual(
      b.wrapper
        .calls()
        .filter(
          (c) =>
            !/ fetch /.test(c.args) &&
            /--force|\+refs|(^|\s)reset|rebase|checkout|--amend/.test(c.args),
        )
        .map((c) => c.args),
      [],
    );
  },
);

dbTest('a dry run reports what would happen and writes nothing', async (db) => {
  const b = await boot(db);
  const a = await appliedLocal(b);
  colleague(a.dir);
  const refs = git(a.dir, 'for-each-ref');
  const res = await fixup(b, a.id, { dryRun: true });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.dryRun, true);
  assert.deepEqual(res.body.willCommit, [DESCRIPTION]);
  assert.equal(res.body.commit, undefined);
  assert.equal(git(a.dir, 'for-each-ref'), refs);
  assert.equal((await getSet(b, a.id)).fixups.length, 0);
  assert.equal(
    (await b.t.auditActions()).some((e) => e.action === 'changeset.fixup'),
    false,
  );
});

dbTest('nothing_to_fix when the repository has not moved', async (db) => {
  const b = await boot(db);
  const a = await appliedLocal(b);
  const res = await fixup(b, a.id);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.nothingToFix, true);
  assert.equal(res.body.commit, undefined);
  assert.equal(git(a.dir, 'rev-parse', `refs/heads/${a.branch}`), a.tip);
});

dbTest(
  "a person's commit on the branch is kept: the fix up goes on top of it and merges on another line",
  async (db) => {
    const b = await boot(db);
    const a = await appliedLocal(b);
    colleague(a.dir);
    const person = personCommit(a.dir, a.branch, 'LINE ONE\n\nLINE TWO\n\nLine three\n');
    const res = await fixup(b, a.id);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.commit.parent, person);
    assert.equal(
      git(a.dir, 'show', `${res.body.commit.sha}:${DESCRIPTION}`),
      'LINE ONE\n\nLINE TWO\n\nLINE THREE',
    );
  },
);

dbTest(
  'a conflict with the branch is listed and nothing is written; "mine" overwrites, "theirs" keeps the branch text',
  async (db) => {
    const b = await boot(db);
    const a = await appliedLocal(b);
    colleague(a.dir);
    const person = personCommit(a.dir, a.branch, 'LINE ONE\n\nLine two\n\nBranch edit of three\n');
    const refs = git(a.dir, 'for-each-ref');
    const res = await fixup(b, a.id);
    assert.equal(res.status, 409, res.text);
    assert.equal(res.body.error, 'fixup_conflicts');
    assert.equal(
      res.body.files.find((f: { path: string }) => f.path === DESCRIPTION).stage,
      'branch',
    );
    assert.equal(git(a.dir, 'for-each-ref'), refs, 'nothing written');
    assert.equal((await getSet(b, a.id)).fixups.length, 0);
    const wrong = await fixup(b, a.id, { branchResolutions: { 'nope.txt': 'mine' } });
    assert.equal(wrong.status, 422);
    assert.equal(wrong.body.error, 'unknown_path');
    const theirs = await fixup(b, a.id, { branchResolutions: { [DESCRIPTION]: 'theirs' } });
    assert.equal(theirs.status, 200, theirs.text);
    assert.equal(
      theirs.body.nothingToFix,
      true,
      'keeping the branch text leaves nothing to commit',
    );
    const mine = await fixup(b, a.id, { branchResolutions: { [DESCRIPTION]: 'mine' } });
    assert.equal(mine.status, 200, mine.text);
    assert.equal(mine.body.commit.parent, person);
    assert.equal(
      git(a.dir, 'show', `${mine.body.commit.sha}:${DESCRIPTION}`),
      'LINE ONE\n\nLine two\n\nLINE THREE',
    );
  },
);

dbTest('a conflict with the repository is listed with the usual resolutions', async (db) => {
  const b = await boot(db);
  const a = await appliedLocal(b);
  colleague(a.dir, 'Other first line\n\nLine two\n\nLine three\n');
  const res = await fixup(b, a.id);
  assert.equal(res.status, 409, res.text);
  assert.equal(res.body.error, 'refresh_conflicts');
  const theirs = await fixup(b, a.id, { resolutions: { [DESCRIPTION]: 'theirs' } });
  assert.equal(theirs.status, 200, theirs.text);
  // The file leaves the change set: the branch is reset to the repository's text by one commit.
  assert.equal(
    git(a.dir, 'show', `${theirs.body.commit.sha}:${DESCRIPTION}`),
    'Other first line\n\nLine two\n\nLine three',
  );
  assert.equal((await getSet(b, a.id)).filesChanged, 0);
});

dbTest(
  'branch_checked_out: HEAD of the clone or another worktree; the ref is never moved',
  async (db) => {
    const b = await boot(db);
    const a = await appliedLocal(b);
    colleague(a.dir);
    git(a.dir, 'checkout', '-q', a.branch);
    const refs = git(a.dir, 'for-each-ref');
    const head = await fixup(b, a.id);
    assert.equal(head.status, 409, head.text);
    assert.equal(head.body.error, 'branch_checked_out');
    assert.equal(git(a.dir, 'for-each-ref'), refs);
    git(a.dir, 'checkout', '-q', 'main');
    const wt = join(scratch(), 'wt');
    git(a.dir, 'worktree', 'add', '-q', wt, a.branch);
    const other = await fixup(b, a.id);
    assert.equal(other.status, 409, other.text);
    assert.equal(other.body.error, 'branch_checked_out');
    assert.equal(git(a.dir, 'rev-parse', `refs/heads/${a.branch}`), a.tip);
    git(a.dir, 'worktree', 'remove', '--force', wt);
    assert.equal((await fixup(b, a.id)).status, 200);
    assert.equal(
      (await b.t.auditActions()).filter((e) => e.action === 'changeset.fixup_failed').length,
      2,
    );
  },
);

dbTest('invalid_state, no_branch, the rights, isolation and a bad body', async (db) => {
  const b = await boot(db);
  const { repositoryId } = await attached(b);
  const id = await approvedSet(b, repositoryId);
  const approved = await fixup(b, id);
  assert.equal(approved.status, 409);
  assert.equal(approved.body.error, 'invalid_state');
  await db.execute("UPDATE change_sets SET status = 'failed' WHERE id = ?", [id]);
  const none = await fixup(b, id);
  assert.equal(none.status, 409);
  assert.equal(none.body.error, 'no_branch');
  const member = await b.t.addMember('member');
  const viewer = await b.t.addMember('viewer');
  assert.equal((await fixup(b, id, {}, member)).status, 403);
  assert.equal((await fixup(b, id, {}, viewer)).status, 403);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const stranger = await b.t.addMember('owner', 'other');
  assert.equal(
    (await b.t.call(stranger, 'POST', `/change-sets/${id}/fixup`, {}, 'other')).status,
    404,
  );
  assert.equal(
    (await b.t.call(stranger, 'POST', `/change-sets/${id}/fixup`, {}, b.t.workspaceId)).status,
    404,
  );
  assert.equal((await fixup(b, id, { extra: 1 })).status, 400);
  assert.equal(
    (await fixup(b, id, { refresh: true })).status,
    400,
    'refresh belongs with recompute',
  );
  assert.equal((await fixup(b, 'no-such-id')).status, 404);
});

dbTest('without KILN_LOCAL_REPO_WRITE a local fixup is refused and nothing changes', async (db) => {
  const b = await boot(db, { write: false });
  const { dir, repositoryId } = await attached(b);
  const id = await approvedSet(b, repositoryId);
  const tip = git(dir, 'rev-parse', 'main');
  const outcome = {
    mode: 'local_branch',
    base: { branch: 'main', commit: tip },
    commit: { branch: 'kiln/x', sha: tip, at: 1 },
    requested: { push: false, openPr: false },
    push: { status: 'not_requested' },
    pr: { status: 'not_requested' },
  };
  await db.execute(
    "UPDATE change_sets SET status = 'applied', branch = 'kiln/x', commit_sha = ?, outcome_json = ? WHERE id = ?",
    [tip, JSON.stringify(outcome), id],
  );
  git(dir, 'branch', 'kiln/x');
  const refs = git(dir, 'for-each-ref');
  const res = await fixup(b, id);
  assert.equal(res.status, 409, res.text);
  assert.equal(res.body.error, 'local_write_disabled');
  assert.equal(res.body.envName, 'KILN_LOCAL_REPO_WRITE');
  assert.equal(git(dir, 'for-each-ref'), refs);
});

dbTest('a fixup in progress is refused (claim) and a stale claim is taken over', async (db) => {
  const b = await boot(db);
  const a = await appliedLocal(b);
  colleague(a.dir);
  await db.execute('UPDATE change_sets SET publish_claim_at = ? WHERE id = ?', [Date.now(), a.id]);
  const busy = await fixup(b, a.id);
  assert.equal(busy.status, 409, busy.text);
  assert.equal(busy.body.error, 'fixup_in_progress');
  assert.equal((await fixup(b, a.id, { dryRun: true })).status, 200, 'a dry run takes no claim');
  await db.execute('UPDATE change_sets SET publish_claim_at = ? WHERE id = ?', [
    Date.now() - 11 * 60_000,
    a.id,
  ]);
  assert.equal((await fixup(b, a.id)).status, 200);
  const [row] = await db.query('SELECT publish_claim_at FROM change_sets WHERE id = ?', [a.id]);
  assert.equal(row?.publish_claim_at ?? null, null, 'the claim is released');
});

dbTest(
  'push: the new tip is pushed without force; a remote that moved is remote_diverged and the commit stays',
  async (db) => {
    const b = await boot(db);
    const a = await appliedLocal(b, { ...local, push: true });
    assert.equal(git(b.bare, 'rev-parse', `refs/heads/${a.branch}`), a.tip);
    colleague(a.dir);
    const res = await fixup(b, a.id, { push: true });
    assert.equal(res.status, 200, res.text);
    const sha = res.body.commit.sha as string;
    assert.equal(
      git(b.bare, 'rev-parse', `refs/heads/${a.branch}`),
      sha,
      'fast-forwarded on the remote',
    );
    assert.equal(git(b.bare, 'rev-parse', `${sha}^`), a.tip);
    assert.equal(res.body.changeSet.outcome.push.status, 'pushed');
    assert.equal(res.body.changeSet.fixups[0].pushed, true);
    assert.equal(
      b.wrapper.calls().some((c) => /push/.test(c.args) && /--force|\+refs/.test(c.args)),
      false,
    );

    // Someone else pushes to the branch on the remote; then we fix up again with push.
    const other = join(scratch(), 'other');
    git(scratch(), 'clone', '-q', b.bare, other);
    git(other, 'checkout', '-q', a.branch);
    writeFileSync(join(other, 'x.txt'), 'x\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'someone else');
    git(other, 'push', '-q', 'origin', a.branch);
    const remote = git(b.bare, 'rev-parse', `refs/heads/${a.branch}`);
    colleague(a.dir, 'Line one\n\nLINE TWO\n\nLINE THREE\n');
    const diverged = await fixup(b, a.id, { push: true });
    assert.equal(diverged.status, 409, diverged.text);
    assert.equal(diverged.body.error, 'remote_diverged');
    assert.equal(
      git(b.bare, 'rev-parse', `refs/heads/${a.branch}`),
      remote,
      'the remote branch is untouched',
    );
    const kept = await getSet(b, a.id);
    assert.equal(kept.fixups.length, 2, 'the commit stays, locally');
    assert.equal(kept.fixups[1].pushed, false);
    assert.equal(git(a.dir, 'rev-parse', `refs/heads/${a.branch}`), kept.commitSha);
  },
);

dbTest(
  'openPr after a fixup opens the pull request when there is none; the token is nowhere',
  async (db) => {
    const b = await boot(db);
    const a = await appliedLocal(b);
    colleague(a.dir);
    const res = await fixup(b, a.id, { push: true, openPr: true });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.pullRequest.state, 'opened');
    assert.equal(b.api.pullRequests.length, 1);
    assert.equal(b.api.pullRequests[0]?.branch, a.branch);
    assert.equal(res.body.changeSet.prNumber, 1);
    const everything = [
      ...b.t.texts,
      ...b.logs,
      JSON.stringify(await db.query('SELECT * FROM audit_events')),
      JSON.stringify(await db.query('SELECT * FROM change_sets')),
    ].join('\n');
    assert.equal(everything.includes(TOKEN), false);
  },
);

// ---------------------------------------------------------------------------------------------
// GitHub mode: a fake connector with the new capabilities

async function bootGithub(db: Database) {
  const api = new BranchRepo();
  api.files = new Map(Object.entries(files()));
  clearRepoSnapshots();
  const t = await bootRepoApp(db, api, {});
  const { repositoryId } = await t.connect();
  const read = await t.call(t.owner, 'GET', repoPath(repositoryId, '/listing'));
  const listing = read.body.listing;
  listing.appStore.locales['en-US'].description = 'LINE ONE\n\nLine two\n\nLine three';
  const made = await t.call(t.owner, 'POST', repoPath(repositoryId, '/change-sets'), {
    summary: 'Update the description',
    listing,
  });
  assert.equal(made.status, 201, made.text);
  const id = made.body.changeSet.id as string;
  assert.equal((await t.call(t.owner, 'POST', `/change-sets/${id}/approve`)).status, 200);
  return { t, api, repositoryId, id };
}
type Gh = Awaited<ReturnType<typeof bootGithub>>;
const ghApply = (g: Gh) => g.t.call(g.t.owner, 'POST', `/change-sets/${g.id}/apply`);
const ghFixup = (g: Gh, body?: Record<string, unknown>) =>
  g.t.call(g.t.owner, 'POST', `/change-sets/${g.id}/fixup`, body);
const ghMoved = (g: Gh) => {
  g.api.files.set(DESCRIPTION, 'Line one\n\nLine two\n\nLINE THREE\n');
  clearRepoSnapshots();
};

dbTest(
  'GitHub: one commit on the branch through the API, parent = the tip, a fast-forward (never forced)',
  async (db) => {
    const g = await bootGithub(db);
    const applied = await ghApply(g);
    assert.equal(applied.status, 200, applied.text);
    const branch = applied.body.changeSet.branch as string;
    const tip = g.api.heads.get(branch) as string;
    ghMoved(g);
    const res = await ghFixup(g);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.mode, 'github_pr');
    assert.equal(g.api.commitCalls.length, 1);
    const call = g.api.commitCalls[0];
    assert.equal(call?.branch, branch);
    assert.equal(call?.expectedTip, tip);
    assert.deepEqual(call?.changes, [
      { path: DESCRIPTION, content: 'LINE ONE\n\nLine two\n\nLINE THREE\n' },
    ]);
    assert.equal(res.body.commit.parent, tip);
    assert.equal(g.api.heads.get(branch), res.body.commit.sha);
    assert.equal(g.api.proposals.length, 1, 'no new branch, no second propose');
    const set = res.body.changeSet;
    assert.equal(set.status, 'applied');
    assert.equal(set.commitSha, res.body.commit.sha);
    assert.equal(set.branch, branch);
    assert.equal(set.fixups.length, 1);
    assert.equal(res.body.pullRequest.state, 'open');
    assert.equal(set.prNumber, applied.body.changeSet.prNumber, 'the pull request is unchanged');
    const again = await ghFixup(g);
    assert.equal(again.body.nothingToFix, true);
    assert.equal(g.api.commitCalls.length, 1);
    assert.equal(
      (await g.t.auditActions()).filter((e) => e.action === 'changeset.fixup').length,
      1,
    );
    assert.equal(
      JSON.stringify(await db.query('SELECT detail FROM audit_events')).includes('LINE THREE'),
      false,
    );
  },
);

dbTest(
  'GitHub: branch_moved, pr_closed (closed and merged), local-only options refused, a connector failure is audited',
  async (db) => {
    const g = await bootGithub(db);
    const applied = await ghApply(g);
    const branch = applied.body.changeSet.branch as string;
    ghMoved(g);
    g.api.moveOnCommit = true;
    const moved = await ghFixup(g);
    assert.equal(moved.status, 409, moved.text);
    assert.equal(moved.body.error, 'branch_moved');
    g.api.moveOnCommit = false;
    const commitsBefore = g.api.commitCalls.length;
    for (const state of ['closed', 'merged'] as const) {
      g.api.pr = { number: 1, state, branch, base: 'main' };
      const res = await ghFixup(g);
      assert.equal(res.status, 409, res.text);
      assert.equal(res.body.error, 'pr_closed', state);
    }
    assert.equal(
      g.api.commitCalls.length,
      commitsBefore,
      'nothing was committed to a closed pull request',
    );
    g.api.pr = { number: 1, state: 'open', branch, base: 'main' };
    assert.equal((await ghFixup(g, { push: true })).status, 422);
    assert.equal((await ghFixup(g, { openPr: true })).status, 422);
    g.api.commitError = new GithubError('server', 'GitHub failed');
    const failed = await ghFixup(g);
    assert.ok(failed.status >= 500, failed.text);
    g.api.commitError = undefined;
    assert.equal(
      (await g.t.auditActions()).filter((e) => e.action === 'changeset.fixup_failed').length,
      4,
    );
    assert.equal((await getSetGh(g)).fixups.length, 0, 'every refusal left the set as it was');
    assert.equal((await ghFixup(g)).status, 200);
  },
);
const getSetGh = async (g: Gh) =>
  (await g.t.call(g.t.owner, 'GET', `/change-sets/${g.id}`)).body.changeSet;

dbTest(
  'GitHub: a failed set that has a branch is fixed up and ends applied; a dry run commits nothing',
  async (db) => {
    const g = await bootGithub(db);
    await ghApply(g);
    await db.execute(
      "UPDATE change_sets SET status = 'failed', error = 'the pull request could not be opened' WHERE id = ?",
      [g.id],
    );
    ghMoved(g);
    const dry = await ghFixup(g, { dryRun: true });
    assert.equal(dry.status, 200, dry.text);
    assert.deepEqual(dry.body.willCommit, [DESCRIPTION]);
    assert.equal(g.api.commitCalls.length, 0);
    assert.equal((await getSetGh(g)).status, 'failed');
    const res = await ghFixup(g);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.changeSet.status, 'applied');
    assert.equal(res.body.changeSet.error, null);
    assert.equal(g.api.commitCalls.length, 1);
  },
);
