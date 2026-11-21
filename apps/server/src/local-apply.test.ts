import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { GithubError } from '@kiln/connectors';
import type { Database } from '@kiln/db';
import { dbTest } from '@kiln/db/testing';
import {
  mapsApp,
  SCAN_APP,
  scannerMonorepo,
  weatherApp,
} from '../../../packages/connectors/src/fastlane.fixtures.ts';
import {
  buildRepo,
  fakeProgram,
  git,
  gitWrapper,
  SSH_KEYGEN,
  snapshot,
  sshKey,
  sshVerifies,
} from './local-git-test-helpers.ts';
import { bootRepoApp, FakeRepo, fastlaneFiles, TOKEN } from './repo-test-helpers.ts';
import { createCloneReads } from './services/clone-reads.ts';
import type { GitSigning } from './services/local-git.ts';
import { clearRepoSnapshots } from './services/repo-snapshot.ts';

/**
 * Applying a change set as a commit on a new branch of a local clone, with an optional push to a
 * bare repository (standing in for GitHub) and an optional pull request through the fake
 * connector (ADR 0005, "Writing to a local clone"). Real git repositories; no network.
 */

type Files = Record<string, string>;

const dirs: string[] = [];
const scratch = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mrm-apply-')));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

class ApiRepo extends FakeRepo {
  constructor(files: Files) {
    super();
    this.files = new Map(Object.entries(files));
  }
}

type Boot = {
  files?: Files;
  write?: boolean;
  author?: { name?: string; email?: string };
  signing?: GitSigning;
};

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
  const remote = { url: bare };
  const api = new ApiRepo(options.files ?? fastlaneFiles());
  clearRepoSnapshots();
  const localWrite = {
    enabled: options.write !== false,
    ...(options.author?.name ? { authorName: options.author.name } : {}),
    ...(options.author?.email ? { authorEmail: options.author.email } : {}),
    ...(options.signing ? { signing: options.signing } : {}),
    push: { url: () => remote.url, protocol: 'file' as const },
  };
  const t = await bootRepoApp(db, api, { reads, localWrite });
  return { t, app: t.app, api, reads, base, root, bare, remote, wrapper, logs };
}
type Booted = Awaited<ReturnType<typeof boot>>;

const repoPath = (id: string, suffix = '') => `/repositories/${id}${suffix}`;

/** A GitHub repository (acme/app) with the fastlane fixture and a local clone attached whose origin is it. */
async function attached(b: Booted, files: Files = fastlaneFiles()) {
  const dir = buildRepo(b.root, 'app', files);
  git(dir, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  const { repositoryId } = await b.t.connect();
  const res = await b.t.call(b.t.owner, 'PUT', repoPath(repositoryId, '/local'), { path: dir });
  assert.equal(res.status, 200, res.text);
  return { dir, repositoryId };
}

/** An approved change set that changes the en-US subtitle. */
async function approved(b: Booted, repositoryId: string, summary = 'Update the subtitle') {
  const read = await b.t.call(b.t.owner, 'GET', repoPath(repositoryId, '/listing'));
  const listing = read.body.listing;
  listing.appStore.locales['en-US'].subtitle = 'New subtitle';
  const made = await b.t.call(b.t.owner, 'POST', repoPath(repositoryId, '/change-sets'), {
    summary,
    listing,
  });
  assert.equal(made.status, 201, made.text);
  const id = made.body.changeSet.id as string;
  assert.equal((await b.t.call(b.t.owner, 'POST', `/change-sets/${id}/approve`)).status, 200);
  return id;
}

const apply = (b: Booted, id: string, body?: Record<string, unknown>, cookie = b.t.owner) =>
  b.t.call(cookie, 'POST', `/change-sets/${id}/apply`, body);
const local = { mode: 'local_branch' } as const;
const SUBTITLE_PATH = 'fastlane/metadata/en-US/subtitle.txt';

// ---------------------------------------------------------------------------------------------
// The switch, permissions, isolation

dbTest(
  'without MRM_LOCAL_REPO_WRITE a local_branch apply is refused, says which setting, and changes nothing',
  async (db) => {
    const b = await boot(db, { write: false });
    const { dir, repositoryId } = await attached(b);
    const id = await approved(b, repositoryId);
    const before = snapshot(dir);
    const res = await apply(b, id, local);
    assert.equal(res.status, 409, res.text);
    assert.equal(res.body.error, 'local_write_disabled');
    assert.equal(res.body.envName, 'MRM_LOCAL_REPO_WRITE');
    assert.match(res.body.message, /MRM_LOCAL_REPO_WRITE=true/);
    assert.equal(
      (await b.t.call(b.t.owner, 'GET', `/change-sets/${id}`)).body.changeSet.status,
      'approved',
    );
    assert.deepEqual(snapshot(dir), before);
    const config = await b.t.call(b.t.owner, 'GET', '/repositories/local/config');
    assert.equal(config.body.local.write.enabled, false);
    assert.equal(config.body.local.write.envName, 'MRM_LOCAL_REPO_WRITE');
    // The push route is gated the same way.
    assert.equal((await b.t.call(b.t.owner, 'POST', `/change-sets/${id}/push`)).status, 409);
    // The GitHub apply is unaffected by the switch.
    const pr = await apply(b, id);
    assert.equal(pr.status, 200, pr.text);
    assert.equal(b.api.proposals.length, 1);
  },
);

dbTest(
  'roles: admin and owner may apply to a clone; members and viewers may not; non-members get 404',
  async (db) => {
    const b = await boot(db);
    const { repositoryId } = await attached(b);
    const id = await approved(b, repositoryId);
    const member = await b.t.addMember('member');
    const viewer = await b.t.addMember('viewer');
    assert.equal((await apply(b, id, local, member)).status, 403);
    assert.equal((await apply(b, id, local, viewer)).status, 403);
    assert.equal((await b.t.call(member, 'POST', `/change-sets/${id}/push`)).status, 403);
    assert.equal((await b.t.call(viewer, 'POST', `/change-sets/${id}/push`)).status, 403);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
    const stranger = await b.t.addMember('owner', 'other');
    for (const path of ['apply', 'push']) {
      assert.equal(
        (await b.t.call(stranger, 'POST', `/change-sets/${id}/${path}`, local, 'other')).status,
        404,
        `${path} with my ids from their workspace`,
      );
      assert.equal(
        (await b.t.call(stranger, 'POST', `/change-sets/${id}/${path}`, local, b.t.workspaceId))
          .status,
        404,
        `${path} in my workspace`,
      );
    }
    const admin = await b.t.addMember('admin');
    assert.equal((await apply(b, id, local, admin)).status, 200);
  },
);

// ---------------------------------------------------------------------------------------------
// The commit

dbTest(
  'attached: a commit on a new branch of the clone, nothing touched, nothing sent to GitHub, audited with the path',
  async (db) => {
    const b = await boot(db);
    const { dir, repositoryId } = await attached(b);
    const id = await approved(b, repositoryId);
    const before = snapshot(dir);
    const base = git(dir, 'rev-parse', 'main');
    const res = await apply(b, id, local);
    assert.equal(res.status, 200, res.text);
    const set = res.body.changeSet;
    assert.equal(set.status, 'applied');
    assert.match(set.branch, /^mrm\/update-the-subtitle-[0-9a-f]{8}$/);
    assert.ok(set.branch.endsWith(id.replace(/-/g, '').slice(0, 8)));
    assert.equal(set.commitSha, git(dir, 'rev-parse', `refs/heads/${set.branch}`));
    assert.equal(set.prUrl, null);
    assert.deepEqual(set.outcome, {
      mode: 'local_branch',
      base: { branch: 'main', commit: base },
      commit: { branch: set.branch, sha: set.commitSha, at: set.appliedAt },
      requested: { push: false, openPr: false },
      push: { status: 'not_requested' },
      pr: { status: 'not_requested' },
    });
    assert.equal(git(dir, 'rev-parse', `${set.commitSha}^`), base);
    assert.equal(git(dir, 'show', `${set.commitSha}:${SUBTITLE_PATH}`), 'New subtitle');
    assert.equal(git(dir, 'diff', '--name-only', base, set.commitSha), SUBTITLE_PATH);
    // Author: the person who applied it (Ada), not the machine's git identity.
    assert.equal(
      git(dir, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', set.commitSha),
      'Ada <ada@example.com>|Ada <ada@example.com>',
    );
    const message = git(dir, 'log', '-1', '--format=%B', set.commitSha);
    assert.match(
      message,
      /^Update the subtitle\n\nChanged files \(1\):\n- fastlane\/metadata\/en-US\/subtitle\.txt \(modified\)\n\nChange set /,
    );
    assert.equal(message.includes(TOKEN), false);
    // The user's repository: byte-identical except for the one new ref.
    const after = snapshot(dir);
    assert.deepEqual({ ...after, refs: '' }, { ...before, refs: '' });
    assert.equal(after.refs.split('\n').length, before.refs.split('\n').length + 1);
    assert.equal(git(dir, 'symbolic-ref', '--short', 'HEAD'), 'main');
    // GitHub saw nothing: no propose, no pull request.
    assert.equal(b.api.proposals.length, 0);
    assert.equal(b.api.pullRequests.length, 0);
    // Audit: the path and the commit, never content.
    const events = (await b.t.auditActions()).filter((a) => a.action === 'changeset.apply_local');
    assert.equal(events.length, 1);
    const { repositoryId: auditedRepository, ...detail } = JSON.parse(events[0]?.detail ?? '{}');
    assert.equal(auditedRepository, repositoryId);
    assert.deepEqual(detail, {
      mode: 'local_branch',
      branch: set.branch,
      commitSha: set.commitSha,
      baseBranch: 'main',
      baseCommit: base,
      path: dir,
      files: 1,
      signed: false,
      signature: null,
      pushRequested: false,
      prRequested: false,
    });
    assert.equal(
      JSON.stringify(await db.query('SELECT detail FROM audit_events')).includes('New subtitle'),
      false,
    );
    // Applying again changes nothing.
    const again = await apply(b, id, local);
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyApplied, true);
    assert.equal(git(dir, 'for-each-ref', 'refs/heads').split('\n').length, 2);
    // The apply event is emitted as changeset.applied for webhooks and streams.
    const emitted = await db.query("SELECT type FROM events WHERE type = 'changeset.applied'");
    assert.equal(emitted.length, 1);
  },
);

dbTest(
  'the branch is chosen: a custom name is used, a taken name is branch_exists, bad names are refused',
  async (db) => {
    const b = await boot(db);
    const { dir, repositoryId } = await attached(b);
    const id = await approved(b, repositoryId);
    git(dir, 'branch', 'taken');
    const refs = git(dir, 'for-each-ref');
    const exists = await apply(b, id, { ...local, branch: 'taken' });
    assert.equal(exists.status, 409);
    assert.equal(exists.body.error, 'branch_exists');
    const onMain = await apply(b, id, { ...local, branch: 'main' });
    assert.equal(onMain.body.error, 'branch_exists');
    for (const name of [
      '--force',
      'a..b',
      'a b',
      'refs/heads/x',
      'HEAD',
      'x.lock',
      'a@{b',
      '-x',
      'ünï',
      'a~1',
      'a//b',
      'a/',
      `${'x'.repeat(201)}`,
    ]) {
      const res = await apply(b, id, { ...local, branch: name });
      assert.equal(res.status, name.length > 200 ? 400 : 422, `${name}: ${res.text}`);
      assert.equal(res.body.error, name.length > 200 ? 'invalid_request' : 'invalid_branch', name);
    }
    assert.equal(git(dir, 'for-each-ref'), refs, 'nothing was created by any refused request');
    assert.equal(
      (await b.t.call(b.t.owner, 'GET', `/change-sets/${id}`)).body.changeSet.status,
      'approved',
      'and it is still approved',
    );
    const ok = await apply(b, id, { ...local, branch: 'feature/listing-update' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.changeSet.branch, 'feature/listing-update');
    assert.equal(
      git(dir, 'rev-parse', 'refs/heads/feature/listing-update'),
      ok.body.changeSet.commitSha,
    );
  },
);

dbTest(
  'base_changed: the clone moved on, the paths are listed, nothing is written and the change set stays approved',
  async (db) => {
    const b = await boot(db);
    const { dir, repositoryId } = await attached(b);
    const id = await approved(b, repositoryId);
    writeFileSync(join(dir, SUBTITLE_PATH), 'Edited by a colleague\n');
    git(dir, 'commit', '-q', '-am', 'colleague');
    const refs = git(dir, 'for-each-ref');
    const res = await apply(b, id, local);
    assert.equal(res.status, 409, res.text);
    assert.equal(res.body.error, 'base_changed');
    assert.deepEqual(res.body.paths, [SUBTITLE_PATH]);
    assert.equal(git(dir, 'for-each-ref'), refs);
    const set = (await b.t.call(b.t.owner, 'GET', `/change-sets/${id}`)).body.changeSet;
    assert.equal(set.status, 'approved');
    assert.match(set.error, /changed after it was created/);
    assert.equal(
      b.wrapper.calls().some((c) => /commit-tree|update-ref/.test(c.args)),
      false,
    );
    // Uncommitted edits are not the base: after reverting the colleague's commit it applies.
    git(dir, 'reset', '-q', '--hard', 'HEAD~1');
    assert.equal((await apply(b, id, local)).status, 200);
  },
);

dbTest(
  'no local clone, an unusable folder and bad options are refused before anything is claimed',
  async (db) => {
    const b = await boot(db);
    const { dir, repositoryId } = await attached(b);
    const id = await approved(b, repositoryId);
    assert.equal(
      (await b.t.call(b.t.owner, 'DELETE', repoPath(repositoryId, '/local'))).status,
      200,
    );
    const none = await apply(b, id, local);
    assert.equal(none.status, 409);
    assert.equal(none.body.error, 'no_local_checkout');
    const bad = await apply(b, id, { mode: 'github_pr', push: true });
    assert.equal(bad.status, 400, 'push belongs to local_branch');
    assert.equal((await apply(b, id, { mode: 'zip' })).status, 400);
    assert.equal((await apply(b, id, local, undefined)).status, 409);
    const garbage = await b.app.request(
      `/api/workspaces/${b.t.workspaceId}/change-sets/${id}/apply`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: b.t.owner },
        body: '{not json',
      },
    );
    assert.equal(garbage.status, 400);
    await b.t.call(b.t.owner, 'PUT', repoPath(repositoryId, '/local'), { path: dir });
    rmSync(join(dir, '.git'), { recursive: true });
    const broken = await apply(b, id, local);
    assert.equal(broken.status, 422);
    assert.equal(broken.body.error, 'local_not_a_repository');
    assert.equal(
      (await b.t.call(b.t.owner, 'GET', `/change-sets/${id}`)).body.changeSet.status,
      'approved',
    );
  },
);

// ---------------------------------------------------------------------------------------------
// Push and pull request

const eventsOf = async (b: Booted, action: string) =>
  (await b.t.auditActions())
    .filter((a) => a.action === action)
    .map((a) => JSON.parse(a.detail || '{}'));

dbTest(
  'commit, push to the remote and open the pull request: each step is reported, the token is nowhere',
  async (db) => {
    const b = await boot(db);
    const { dir, repositoryId } = await attached(b);
    const id = await approved(b, repositoryId);
    const before = snapshot(dir);
    const res = await apply(b, id, { ...local, push: true, openPr: true });
    assert.equal(res.status, 200, res.text);
    const set = res.body.changeSet;
    assert.equal(set.status, 'applied');
    assert.deepEqual(
      { ...snapshot(dir), refs: '' },
      { ...before, refs: '' },
      'the clone is unchanged apart from the new branch',
    );
    assert.equal(
      git(b.bare, 'rev-parse', `refs/heads/${set.branch}`),
      set.commitSha,
      'the branch is on the remote',
    );
    assert.equal(git(b.bare, 'for-each-ref', '--format=%(refname)'), `refs/heads/${set.branch}`);
    assert.equal(set.outcome.push.status, 'pushed');
    assert.equal(set.outcome.pr.status, 'opened');
    assert.equal(set.prNumber, 1);
    assert.equal(set.prUrl, 'https://github.com/acme/app/pull/1');
    assert.deepEqual(set.outcome.requested, { push: true, openPr: true });
    assert.equal(b.api.proposals.length, 0, 'not through the GitHub API');
    assert.equal(b.api.pullRequests.length, 1);
    const pr = b.api.pullRequests[0];
    assert.equal(pr?.branch, set.branch);
    assert.equal(pr?.base, 'main', 'into the branch the commit was made on');
    assert.equal(pr?.title, 'Update the subtitle');
    assert.match(pr?.body ?? '', /fastlane\/metadata\/en-US\/subtitle\.txt/);

    const audit = await b.t.auditActions();
    assert.deepEqual(
      audit
        .map((a) => a.action)
        .filter((a) => /^changeset\.(apply|push|pr)/.test(a))
        .sort(),
      ['changeset.apply_local', 'changeset.pr_open', 'changeset.push'],
    );
    assert.equal(
      audit.some((a) => a.action === 'credential.use' && /changeset\.push/.test(a.detail)),
      true,
    );
    const everything = [
      ...b.t.texts,
      ...b.logs,
      JSON.stringify(await db.query('SELECT * FROM audit_events')),
      JSON.stringify(await db.query('SELECT * FROM change_sets')),
    ].join('\n');
    assert.equal(
      everything.includes(TOKEN),
      false,
      'the token is in no response, log, audit row or change set',
    );
    assert.equal(
      everything.includes(Buffer.from(`x-access-token:${TOKEN}`).toString('base64')),
      false,
    );
    assert.equal(
      b.wrapper.calls().some((c) => c.args.includes(TOKEN)),
      false,
      'nor in any argument of git',
    );
  },
);

dbTest(
  'a failed push keeps the commit and can be retried; the pull request waits for the push',
  async (db) => {
    const b = await boot(db);
    const { dir, repositoryId } = await attached(b);
    const id = await approved(b, repositoryId);
    b.remote.url = join(b.base, 'does-not-exist.git');
    const res = await apply(b, id, { ...local, push: true, openPr: true });
    assert.equal(res.status, 200, 'the commit was made, so the apply worked');
    const set = res.body.changeSet;
    assert.equal(set.status, 'applied');
    assert.equal(
      git(dir, 'rev-parse', `refs/heads/${set.branch}`),
      set.commitSha,
      'the commit is not rolled back',
    );
    assert.equal(set.outcome.push.status, 'failed');
    assert.equal(typeof set.outcome.push.error, 'string');
    assert.equal(set.outcome.pr.status, 'skipped');
    assert.equal(b.api.pullRequests.length, 0);
    assert.equal((await eventsOf(b, 'changeset.push_failed')).length, 1);
    assert.equal(set.error, null, 'the change set itself did not fail');

    // The retry, once the remote exists.
    b.remote.url = b.bare;
    const retry = await b.t.call(b.t.owner, 'POST', `/change-sets/${id}/push`, { openPr: true });
    assert.equal(retry.status, 200, retry.text);
    assert.equal(retry.body.changeSet.outcome.push.status, 'pushed');
    assert.equal(retry.body.changeSet.outcome.pr.status, 'opened');
    assert.equal(git(b.bare, 'rev-parse', `refs/heads/${set.branch}`), set.commitSha);
    assert.equal(b.api.pullRequests.length, 1);
    // Done is done: another call changes nothing.
    const done = await b.t.call(b.t.owner, 'POST', `/change-sets/${id}/push`, { openPr: true });
    assert.equal(done.status, 200);
    assert.equal(done.body.alreadyDone, true);
    assert.equal(b.api.pullRequests.length, 1);
    assert.deepEqual(
      (await b.t.auditActions())
        .map((a) => a.action)
        .filter((a) => /^changeset\.(apply|push|pr)/.test(a))
        .sort(),
      ['changeset.apply_local', 'changeset.pr_open', 'changeset.push', 'changeset.push_failed'],
    );
  },
);

dbTest(
  'a failed pull request keeps the push; the retry opens it without pushing again; the push route answers 502 on a failure',
  async (db) => {
    const b = await boot(db);
    const { repositoryId } = await attached(b);
    const id = await approved(b, repositoryId);
    b.api.openPullRequestErrors = [
      new GithubError('validation', 'Validation Failed [PullRequest.custom]', 422),
    ];
    const res = await apply(b, id, { ...local, push: true, openPr: true });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.changeSet.outcome.push.status, 'pushed');
    assert.equal(res.body.changeSet.outcome.pr.status, 'failed');
    assert.match(res.body.changeSet.outcome.pr.error, /Validation Failed/);
    assert.equal(res.body.changeSet.prUrl, null);
    // A push-only retry that still has a failing pull request step reports it.
    b.api.openPullRequestErrors = [new GithubError('network', 'Could not reach GitHub.')];
    const failed = await b.t.call(b.t.owner, 'POST', `/change-sets/${id}/push`, { openPr: true });
    assert.equal(failed.status, 502, failed.text);
    assert.equal(failed.body.step, 'pr');
    assert.equal(failed.body.changeSet.outcome.pr.status, 'failed');
    const retry = await b.t.call(b.t.owner, 'POST', `/change-sets/${id}/push`, { openPr: true });
    assert.equal(retry.status, 200, retry.text);
    assert.equal(retry.body.changeSet.outcome.pr.status, 'opened');
    assert.equal((await eventsOf(b, 'changeset.push')).length, 1, 'the branch was pushed once');
    assert.equal((await eventsOf(b, 'changeset.pr_failed')).length, 2);
    assert.equal((await eventsOf(b, 'changeset.pr_open')).length, 1);
  },
);

dbTest('a commit alone can be published later, with or without the pull request', async (db) => {
  const b = await boot(db);
  const { repositoryId } = await attached(b);
  const id = await approved(b, repositoryId);
  const res = await apply(b, id, local);
  const branch = res.body.changeSet.branch as string;
  assert.equal(git(b.bare, 'for-each-ref'), '', 'nothing pushed yet');
  const pushed = await b.t.call(b.t.owner, 'POST', `/change-sets/${id}/push`);
  assert.equal(pushed.status, 200, pushed.text);
  assert.equal(pushed.body.changeSet.outcome.push.status, 'pushed');
  assert.equal(pushed.body.changeSet.outcome.pr.status, 'not_requested');
  assert.equal(git(b.bare, 'rev-parse', `refs/heads/${branch}`), res.body.changeSet.commitSha);
  const pr = await b.t.call(b.t.owner, 'POST', `/change-sets/${id}/push`, { openPr: true });
  assert.equal(pr.status, 200, pr.text);
  assert.equal(pr.body.changeSet.outcome.pr.status, 'opened');
  assert.deepEqual(pr.body.changeSet.outcome.requested, { push: true, openPr: true });
  // A change set that was applied as a pull request through GitHub has no local commit to push.
  const second = await approved(b, repositoryId, 'Another');
  assert.equal(
    (await b.t.call(b.t.owner, 'POST', `/change-sets/${second}/push`)).status,
    409,
    'not applied yet',
  );
});

dbTest(
  'what push needs: a GitHub connection and an origin that is that repository; openPr needs push; nothing is written when refused',
  async (db) => {
    const b = await boot(db);
    const { dir, repositoryId } = await attached(b);
    const id = await approved(b, repositoryId);
    const refs = git(dir, 'for-each-ref');
    const noPush = await apply(b, id, { ...local, openPr: true });
    assert.equal(noPush.status, 422);
    assert.equal(noPush.body.error, 'invalid_request');
    git(dir, 'remote', 'set-url', 'origin', 'https://github.com/someone/else.git');
    const mismatch = await apply(b, id, { ...local, push: true });
    assert.equal(mismatch.status, 409, mismatch.text);
    assert.equal(mismatch.body.error, 'remote_mismatch');
    assert.match(mismatch.body.message, /someone\/else/);
    git(dir, 'remote', 'remove', 'origin');
    assert.equal((await apply(b, id, { ...local, push: true })).body.error, 'remote_mismatch');
    assert.equal(git(dir, 'for-each-ref'), refs, 'refused before the commit');
    assert.equal(
      (await b.t.call(b.t.owner, 'GET', `/change-sets/${id}`)).body.changeSet.status,
      'approved',
    );
    // Without a push the mismatch does not matter.
    assert.equal((await apply(b, id, local)).status, 200);
    assert.equal(
      (await b.t.call(b.t.owner, 'POST', `/change-sets/${id}/push`)).body.error,
      'remote_mismatch',
    );
  },
);

dbTest('two applies at the same moment make one commit', async (db) => {
  const b = await boot(db);
  const { dir, repositoryId } = await attached(b);
  const id = await approved(b, repositoryId);
  const results = await Promise.all([
    apply(b, id, local),
    apply(b, id, { ...local, branch: 'second/try' }),
    apply(b, id, local),
  ]);
  const winners = results.filter((r) => r.status === 200 && !r.body.alreadyApplied);
  assert.equal(
    winners.length,
    1,
    results.map((r) => `${r.status} ${r.body.error ?? ''}`).join(', '),
  );
  for (const r of results) assert.ok([200, 409].includes(r.status));
  assert.equal(
    git(dir, 'for-each-ref', 'refs/heads').split('\n').length,
    2,
    'main and one new branch',
  );
  assert.equal((await eventsOf(b, 'changeset.apply_local')).length, 1);
});

// ---------------------------------------------------------------------------------------------
// Local-only repositories and the layouts

/** Connects a folder as a local-only repository. */
async function localOnly(b: Booted, files: Files, name = 'project') {
  const dir = buildRepo(b.root, name, files);
  const res = await b.t.call(b.t.owner, 'POST', '/repositories/local', { path: dir });
  assert.equal(res.status, 201, res.text);
  return { dir, repositoryId: res.body.repository.id as string };
}

/** Changes one field of the first locale of each store the listing has, and makes an approved change set. */
async function approvedListingChange(b: Booted, repositoryId: string, target?: string) {
  const query = target ? `?target=${encodeURIComponent(target)}` : '';
  const read = await b.t.call(b.t.owner, 'GET', repoPath(repositoryId, `/listing${query}`));
  assert.equal(read.status, 200, read.text);
  const listing = read.body.listing;
  if (listing.appStore) {
    const locale = Object.keys(listing.appStore.locales)[0] as string;
    listing.appStore.locales[locale].name = 'Changed by the test';
  }
  if (listing.googlePlay) {
    const locale = Object.keys(listing.googlePlay.locales)[0] as string;
    listing.googlePlay.locales[locale].title = 'Changed by the test';
  }
  const made = await b.t.call(b.t.owner, 'POST', repoPath(repositoryId, '/change-sets'), {
    summary: 'Change the name',
    listing,
    ...(target ? { target } : {}),
  });
  assert.equal(made.status, 201, made.text);
  const id = made.body.changeSet.id as string;
  assert.equal((await b.t.call(b.t.owner, 'POST', `/change-sets/${id}/approve`)).status, 200);
  return id;
}

dbTest(
  'local-only: applies without GitHub: no credential, no connector, no network; github_pr stays refused',
  async (db) => {
    const b = await boot(db);
    const { dir, repositoryId } = await localOnly(b, weatherApp());
    const id = await approvedListingChange(b, repositoryId);
    const before = snapshot(dir);
    const refused = await apply(b, id);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'local_only');
    assert.match(refused.body.message, /commit on a new branch of the local clone/);
    assert.equal(
      (await b.t.call(b.t.owner, 'GET', `/change-sets/${id}`)).body.changeSet.status,
      'approved',
    );
    assert.equal((await apply(b, id, { mode: 'github_pr' })).body.error, 'local_only');
    // Push and pull request make no sense without GitHub.
    const push = await apply(b, id, { ...local, push: true });
    assert.equal(push.status, 409);
    assert.equal(push.body.error, 'local_only');

    const res = await apply(b, id, local);
    assert.equal(res.status, 200, res.text);
    const set = res.body.changeSet;
    assert.equal(set.status, 'applied');
    assert.equal(git(dir, 'rev-parse', `refs/heads/${set.branch}`), set.commitSha);
    assert.equal(git(dir, 'rev-parse', `${set.commitSha}^`), before.head);
    assert.deepEqual({ ...snapshot(dir), refs: '' }, { ...before, refs: '' });
    assert.equal(b.api.proposals.length + b.api.pullRequests.length, 0);
    assert.equal(
      (await b.t.auditActions()).some((a) => a.action === 'credential.use'),
      false,
      'no credential was ever used',
    );
    // Not pushable.
    const publish = await b.t.call(b.t.owner, 'POST', `/change-sets/${id}/push`);
    assert.equal(publish.status, 409);
    assert.equal(publish.body.error, 'local_only');
    // The commit message keeps the text as typed (nothing is pushed to GitHub from here).
    assert.equal(git(dir, 'log', '-1', '--format=%s', set.commitSha), 'Change the name');
  },
);

const LAYOUTS: [string, () => Files, string | undefined][] = [
  ['fastlane: one app with ios and android folders (weather)', () => weatherApp(), undefined],
  [
    'fastlane: a monorepo with a folder per app id',
    () => scannerMonorepo({ cardChangelogs: 3, scanChangelogs: 3 }),
    `auto:app:${SCAN_APP}`,
  ],
  ['fastlane: android only (maps)', () => mapsApp(), undefined],
  [
    'Expo: store.config.json',
    () => ({
      'package.json': '{ "name": "acme", "dependencies": { "expo": "^52.0.0" } }\n',
      'app.json': '{ "expo": { "name": "Acme", "slug": "acme" } }\n',
      'store.config.json':
        '{\n  "configVersion": 0,\n  "apple": {\n    "info": {\n      "en-US": {\n        "title": "Acme Expo",\n        "subtitle": "Old expo subtitle",\n        "description": "A description that is long enough.",\n        "keywords": ["acme"]\n      }\n    }\n  }\n}\n',
    }),
    undefined,
  ],
];

for (const [name, files, target] of LAYOUTS) {
  dbTest(`the commit holds exactly the change set's files, with its texts: ${name}`, async (db) => {
    const b = await boot(db);
    const { dir, repositoryId } = await localOnly(b, files());
    const id = await approvedListingChange(b, repositoryId, target);
    const set = (await b.t.call(b.t.owner, 'GET', `/change-sets/${id}`)).body.changeSet;
    assert.ok(set.files.length > 0);
    const base = git(dir, 'rev-parse', 'HEAD');
    const res = await apply(b, id, local);
    assert.equal(res.status, 200, res.text);
    const commit = res.body.changeSet.commitSha as string;
    assert.deepEqual(
      git(dir, 'diff', '--name-only', base, commit).split('\n').sort(),
      set.files.map((f: { path: string }) => f.path).sort(),
    );
    for (const file of set.files as { path: string; change: string; after?: string }[]) {
      if (file.change === 'deleted') {
        assert.equal(git(dir, 'ls-tree', commit, file.path), '');
      } else {
        assert.equal(
          git(dir, 'cat-file', 'blob', `${commit}:${file.path}`),
          (file.after ?? '').replace(/\n+$/, ''),
          file.path,
        );
      }
    }
    // The next listing read sees the new commit only on its branch: the checked out branch is as it was.
    assert.equal(git(dir, 'rev-parse', 'HEAD'), base);
  });
}

dbTest(
  'new and deleted files: a new locale is added, a removed file is deleted, the rest of the tree is the base',
  async (db) => {
    const b = await boot(db);
    const { dir, repositoryId } = await localOnly(b, fastlaneFiles());
    const files = [
      { path: 'fastlane/metadata/fr-FR/name.txt', after: 'Appli Acme\n' },
      { path: 'fastlane/metadata/de-DE/subtitle.txt', before: 'Alter Untertitel\n' },
      { path: SUBTITLE_PATH, before: 'Old subtitle\n', after: 'Ein neuer\n' },
    ];
    await db.execute(
      `INSERT INTO change_sets (id, workspace_id, repository_id, summary, status, created_by_type, created_by_id, files_json, created_at, updated_at)
     VALUES ('cs-manual', ?, ?, 'Add French, drop the German subtitle', 'approved', 'user', 'u', ?, 1, 1)`,
      [b.t.workspaceId, repositoryId, JSON.stringify(files)],
    );
    const base = git(dir, 'rev-parse', 'HEAD');
    const res = await apply(b, 'cs-manual', local);
    assert.equal(res.status, 200, res.text);
    const commit = res.body.changeSet.commitSha as string;
    assert.equal(
      git(dir, 'diff', '--name-status', base, commit),
      'D\tfastlane/metadata/de-DE/subtitle.txt\nM\tfastlane/metadata/en-US/subtitle.txt\nA\tfastlane/metadata/fr-FR/name.txt',
    );
    assert.equal(git(dir, 'show', `${commit}:fastlane/metadata/fr-FR/name.txt`), 'Appli Acme');
    assert.equal(
      git(dir, 'show', `${commit}:fastlane/Fastfile`),
      git(dir, 'show', `${base}:fastlane/Fastfile`),
    );
    assert.equal(
      readFileSync(join(dir, 'fastlane/metadata/de-DE/subtitle.txt'), 'utf8'),
      'Alter Untertitel\n',
      'the working tree keeps its file',
    );
  },
);

dbTest(
  'a hostile repository (hooks, fsmonitor, filters) runs nothing when a change set is applied through the API',
  async (db) => {
    const b = await boot(db);
    const { dir, repositoryId } = await attached(b);
    const marker = join(b.base, 'pwned');
    const touch = `touch '${marker}'`;
    for (const hook of [
      'pre-commit',
      'post-commit',
      'reference-transaction',
      'pre-push',
      'post-update',
    ]) {
      writeFileSync(join(dir, '.git', 'hooks', hook), `#!/bin/sh\n${touch}\n`, { mode: 0o755 });
    }
    git(dir, 'config', 'core.fsmonitor', touch);
    git(dir, 'config', 'core.sshCommand', touch);
    git(dir, 'config', 'credential.helper', `!${touch}`);
    git(dir, 'config', 'commit.gpgsign', 'true');
    git(dir, 'config', 'gpg.program', join(b.base, 'nogpg'));
    writeFileSync(join(b.base, 'nogpg'), `#!/bin/sh\n${touch}\n`, { mode: 0o755 });
    const id = await approved(b, repositoryId);
    assert.equal((await apply(b, id, { ...local, push: true })).status, 200);
    assert.equal(existsSync(marker), false, 'nothing from the repository ran');
  },
);

// ---------------------------------------------------------------------------------------------
// Signing (MRM_GIT_SIGN)

const NO_SSH = SSH_KEYGEN ? undefined : 'ssh-keygen is not installed';

dbTest(
  'signing off: the config says so, the commit is unsigned and the outcome has no signature',
  async (db) => {
    const b = await boot(db);
    const { dir, repositoryId } = await attached(b);
    const config = await b.t.call(b.t.owner, 'GET', '/repositories/local/config');
    assert.deepEqual(config.body.local.signing, { enabled: false });
    const id = await approved(b, repositoryId);
    const res = await apply(b, id, local);
    assert.equal(res.status, 200, res.text);
    assert.equal('signature' in res.body.changeSet.outcome, false);
    assert.equal(
      git(dir, 'cat-file', 'commit', res.body.changeSet.commitSha).includes('gpgsig'),
      false,
    );
  },
);

dbTest(
  'signing on (ssh): the commit is signed, pushed as it is, the outcome and the audit say so, the key is nowhere',
  async (db, t) => {
    if (NO_SSH) return t.skip(NO_SSH);
    const k = sshKey();
    const b = await boot(db, { signing: { format: 'ssh', key: k.key, program: SSH_KEYGEN ?? '' } });
    const { dir, repositoryId } = await attached(b);
    const id = await approved(b, repositoryId);
    const res = await apply(b, id, { ...local, push: true, openPr: true });
    assert.equal(res.status, 200, res.text);
    const set = res.body.changeSet;
    assert.equal(set.status, 'applied');
    assert.deepEqual(set.outcome.signature, { status: 'signed', format: 'ssh' });
    assert.equal(set.outcome.push.status, 'pushed');
    assert.match(
      git(dir, 'cat-file', 'commit', set.commitSha),
      /^gpgsig -----BEGIN SSH SIGNATURE-----$/m,
    );
    assert.equal(sshVerifies(dir, set.commitSha, k.signers), true);
    // The push sends the commit that was signed, unchanged.
    assert.equal(git(b.bare, 'rev-parse', `refs/heads/${set.branch}`), set.commitSha);
    assert.match(
      git(b.bare, 'cat-file', 'commit', set.commitSha),
      /^gpgsig -----BEGIN SSH SIGNATURE-----$/m,
    );

    const [audited] = await eventsOf(b, 'changeset.apply_local');
    assert.equal(audited.signed, true);
    assert.equal(audited.signature, 'ssh');
    // Who may look sees whether commits are signed and how; nobody sees the key or where it is.
    const viewer = await b.t.addMember('viewer');
    for (const cookie of [b.t.owner, viewer]) {
      const config = await b.t.call(cookie, 'GET', '/repositories/local/config');
      assert.deepEqual(config.body.local.signing, { enabled: true, format: 'ssh' });
    }
    const keyBody = readFileSync(k.key, 'utf8').split('\n')[1] ?? 'x';
    const everything = [
      ...b.t.texts,
      ...b.logs,
      JSON.stringify(await db.query('SELECT * FROM audit_events')),
      JSON.stringify(await db.query('SELECT * FROM change_sets')),
    ].join('\n');
    assert.equal(
      everything.includes(k.key),
      false,
      'the key path is in no response, log, audit row or change set',
    );
    assert.equal(
      everything.includes(k.key.split('/').slice(0, -1).join('/')),
      false,
      'nor its folder',
    );
    assert.equal(everything.includes(keyBody), false, 'nor any key material');
  },
);

dbTest(
  'signing on and it fails: nothing is committed, the change set stays approved with signing_failed, and the key path is not told',
  async (db, t) => {
    if (NO_SSH) return t.skip(NO_SSH);
    const locked = sshKey('Zq9-unlikely-phrase');
    const b = await boot(db, {
      signing: { format: 'ssh', key: locked.key, program: SSH_KEYGEN ?? '' },
    });
    const { dir, repositoryId } = await attached(b);
    const id = await approved(b, repositoryId);
    const before = snapshot(dir);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await apply(b, id, { ...local, push: true });
      assert.equal(res.status, 502, res.text);
      assert.equal(res.body.error, 'signing_failed');
      assert.equal(res.body.reason, 'locked');
      assert.match(res.body.message, /passphrase/);
      assert.equal(
        res.body.changeSet.status,
        'approved',
        'back to approved, ready for another try',
      );
      assert.equal(res.body.changeSet.error, res.body.message);
      assert.deepEqual(snapshot(dir), before, 'no branch, nothing touched');
      assert.equal(git(b.bare, 'for-each-ref'), '', 'nothing was pushed');
    }
    assert.equal((await eventsOf(b, 'changeset.apply_local')).length, 0);
    const everything = [
      ...b.t.texts,
      ...b.logs,
      JSON.stringify(await db.query('SELECT * FROM audit_events')),
      JSON.stringify(await db.query('SELECT * FROM change_sets')),
    ].join('\n');
    assert.equal(everything.includes(locked.key), false);
    assert.equal(everything.includes('Zq9-unlikely-phrase'), false);
    // The GitHub apply is another way, with no signing by this server: it still works.
    assert.equal((await apply(b, id)).status, 200);
  },
);

dbTest(
  'signing on and the program never answers: 504 signing_failed after the timeout, the process is gone, nothing is written',
  async (db, t) => {
    if (NO_SSH) return t.skip(NO_SSH);
    const k = sshKey();
    const slow = fakeProgram('slow', undefined, 'exec sleep 30\n');
    const b = await boot(db, {
      signing: { format: 'ssh', key: k.key, program: slow.path, timeoutMs: 700 },
    });
    const { dir, repositoryId } = await attached(b);
    const id = await approved(b, repositoryId);
    const before = snapshot(dir);
    const started = Date.now();
    const res = await apply(b, id, local);
    assert.equal(res.status, 504, res.text);
    assert.equal(res.body.error, 'signing_failed');
    assert.equal(res.body.reason, 'timeout');
    assert.ok(Date.now() - started < 10_000);
    assert.equal(res.body.changeSet.status, 'approved');
    assert.deepEqual(snapshot(dir), before);
  },
);
