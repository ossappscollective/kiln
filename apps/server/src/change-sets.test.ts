import assert from 'node:assert/strict';
import {
  BranchExistsError,
  GithubError,
  GithubRateLimitError,
  PullRequestFailedError,
} from '@kiln/connectors';
import { dbTest } from '@kiln/db/testing';
import { bootRepoApp, FakeRepo, TOKEN } from './repo-test-helpers.ts';

const SUBTITLE = 'fastlane/metadata/en-US/subtitle.txt';

dbTest('draft, approve, apply: the change lands as a pull request on a new branch', async (db) => {
  const repo = new FakeRepo();
  const t = await bootRepoApp(db, repo);
  const { repositoryId } = await t.connect();
  await t.call(t.owner, 'POST', `/repositories/${repositoryId}/scan`);

  const { res, id } = await t.draft(repositoryId);
  assert.equal(res.status, 201);
  const draft = res.body.changeSet;
  assert.equal(draft.status, 'draft');
  assert.equal(draft.createdBy.type, 'user');
  assert.equal(draft.filesChanged, 1);
  assert.deepEqual(draft.files, [
    { path: SUBTITLE, change: 'modified', before: 'Old subtitle\n', after: 'New subtitle\n' },
  ]);
  assert.ok(Array.isArray(res.body.problems));
  // A draft writes nothing.
  assert.equal(repo.proposals.length, 0);

  // The list has no file contents.
  const listed = await t.call(t.owner, 'GET', '/change-sets');
  assert.equal(listed.body.changeSets.length, 1);
  assert.deepEqual(listed.body.changeSets[0].files, [{ path: SUBTITLE, change: 'modified' }]);
  assert.equal(
    (await t.call(t.owner, 'GET', `/change-sets?status=applied`)).body.changeSets.length,
    0,
  );
  assert.equal(
    (await t.call(t.owner, 'GET', `/change-sets?repositoryId=${repositoryId}`)).body.changeSets
      .length,
    1,
  );

  // Not approved yet: apply is refused and nothing is written.
  const early = await t.call(t.owner, 'POST', `/change-sets/${id}/apply`);
  assert.equal(early.status, 409);
  assert.equal(early.body.error, 'invalid_state');
  assert.equal(early.body.status, 'draft');
  assert.equal(repo.proposals.length, 0);

  const approved = await t.call(t.owner, 'POST', `/change-sets/${id}/approve`);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.changeSet.status, 'approved');
  assert.ok(approved.body.changeSet.approvedBy);
  assert.ok(approved.body.changeSet.approvedAt > 0);

  const applied = await t.call(t.owner, 'POST', `/change-sets/${id}/apply`);
  assert.equal(applied.status, 200);
  const done = applied.body.changeSet;
  assert.equal(done.status, 'applied');
  assert.match(done.branch, /^mrm\/[0-9a-f]{8}-update-the-subtitle$/);
  assert.equal(done.prUrl, 'https://github.com/acme/app/pull/1');
  assert.equal(done.prNumber, 1);
  assert.equal(done.commitSha, 'a'.repeat(40));
  assert.ok(done.appliedAt > 0);
  assert.equal(done.error, null);

  // What the connector received.
  assert.equal(repo.proposals.length, 1);
  const sent = repo.proposals[0];
  assert.equal(sent?.options.branch, done.branch);
  assert.equal(sent?.options.title, 'Update the subtitle');
  assert.equal(sent?.changeSet.target, 'repo');
  assert.equal(sent?.changeSet.workspaceId, t.workspaceId);
  assert.equal(sent?.changeSet.files[0]?.after, 'New subtitle\n');
  // The default branch is untouched; the change is on its own branch.
  assert.equal(repo.files.get(SUBTITLE), 'Old subtitle\n');
  assert.equal(repo.branches.get(done.branch)?.get(SUBTITLE), 'New subtitle\n');

  // Audit: who did what, with ids and no file contents or secrets.
  const audit = await t.auditActions();
  const mine = audit.filter((a) => a.action.startsWith('changeset.'));
  assert.deepEqual(
    mine.map((a) => a.action),
    ['changeset.create', 'changeset.approve', 'changeset.apply'],
  );
  for (const a of mine) {
    assert.equal(a.actorType, 'user');
    assert.equal(a.targetId, id);
    assert.doesNotMatch(a.detail, /subtitle\b.*New|Old subtitle|New subtitle/);
  }
  assert.match(mine[2]?.detail ?? '', /pull\/1/);
  for (const text of [...t.texts, ...audit.map((a) => a.detail)]) {
    assert.doesNotMatch(text, /ghp_abcdef/, 'the token must never appear');
  }
  assert.ok(TOKEN.length > 20);
});

dbTest('a draft with nothing different is refused, and bad listings are 400', async (db) => {
  const t = await bootRepoApp(db);
  const { repositoryId } = await t.connect();
  const read = await t.call(t.owner, 'GET', `/repositories/${repositoryId}/listing`);
  const same = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/change-sets`, {
    summary: 'No change',
    listing: read.body.listing,
  });
  assert.equal(same.status, 422);
  assert.equal(same.body.error, 'no_changes');
  assert.equal((await t.call(t.owner, 'GET', '/change-sets')).body.changeSets.length, 0);

  const post = (body: unknown) =>
    t.call(t.owner, 'POST', `/repositories/${repositoryId}/change-sets`, body);
  assert.equal((await post({ summary: '', listing: {} })).status, 400);
  assert.equal((await post({ summary: 'two\nlines', listing: {} })).status, 400);
  assert.equal(
    (
      await post({
        summary: 'x',
        listing: { appStore: { locales: { '../../.github': { name: 'x' } } } },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post({
        summary: 'x',
        listing: { googlePlay: { locales: {}, changelogs: { en: { 'a/b': 'x' } } } },
      })
    ).status,
    400,
  );
});

dbTest('a locale missing from the listing deletes its files, shown in the diff', async (db) => {
  const t = await bootRepoApp(db);
  const { repositoryId } = await t.connect();
  const read = await t.call(t.owner, 'GET', `/repositories/${repositoryId}/listing`);
  const listing = read.body.listing;
  listing.appStore.locales['de-DE'] = undefined;
  const res = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/change-sets`, {
    summary: 'Drop German',
    listing,
  });
  assert.equal(res.status, 201);
  assert.deepEqual(
    res.body.changeSet.files.map((f: { path: string; change: string }) => f.change),
    ['deleted', 'deleted'],
  );
});

dbTest('a double click applies once: one pull request, the second click is told', async (db) => {
  const repo = new FakeRepo();
  const t = await bootRepoApp(db, repo);
  const { repositoryId } = await t.connect();
  const { id } = await t.draft(repositoryId);
  await t.call(t.owner, 'POST', `/change-sets/${id}/approve`);

  // Two clicks while the first request is still talking to GitHub.
  let release: () => void = () => {};
  repo.proposeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = t.call(t.owner, 'POST', `/change-sets/${id}/apply`);
  await new Promise((r) => setTimeout(r, 20));
  const second = await t.call(t.owner, 'POST', `/change-sets/${id}/apply`);
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'apply_in_progress');
  release();
  const done = await first;
  assert.equal(done.status, 200);
  assert.equal(repo.proposals.length, 1);

  // A click after it finished gets the same result, and nothing new happens.
  const third = await t.call(t.owner, 'POST', `/change-sets/${id}/apply`);
  assert.equal(third.status, 200);
  assert.equal(third.body.alreadyApplied, true);
  assert.equal(third.body.changeSet.prUrl, done.body.changeSet.prUrl);
  assert.equal(repo.proposals.length, 1);
  assert.equal((await t.auditActions()).filter((a) => a.action === 'changeset.apply').length, 1);
});

dbTest(
  'a repository that changed since the draft: 409 with a hint, set failed, never applied',
  async (db) => {
    const repo = new FakeRepo();
    const t = await bootRepoApp(db, repo);
    const { repositoryId } = await t.connect();
    const { id } = await t.draft(repositoryId);
    await t.call(t.owner, 'POST', `/change-sets/${id}/approve`);
    repo.files.set(SUBTITLE, 'Someone else edited this\n');

    const res = await t.call(t.owner, 'POST', `/change-sets/${id}/apply`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'change_conflict');
    assert.deepEqual(res.body.paths, [SUBTITLE]);
    assert.match(res.body.hint, /read the listing again/);
    assert.equal(res.body.changeSet.status, 'failed');

    const after = (await t.call(t.owner, 'GET', `/change-sets/${id}`)).body.changeSet;
    assert.equal(after.status, 'failed');
    assert.match(after.error, /changed since/);
    assert.equal(after.prUrl, null);
    assert.equal(repo.branches.size, 0);
    const retry = await t.call(t.owner, 'POST', `/change-sets/${id}/apply`);
    assert.equal(retry.status, 409);
    assert.equal(retry.body.error, 'invalid_state');
    assert.ok((await t.auditActions()).some((a) => a.action === 'changeset.apply_failed'));

    // A failed set can be discarded, and a new draft from the current state works.
    assert.equal((await t.call(t.owner, 'POST', `/change-sets/${id}/discard`)).status, 200);
    assert.equal((await t.draft(repositoryId, 'Fresh subtitle')).res.status, 201);
  },
);

dbTest(
  'a rate limit is a 429 with retry info and leaves the set approved for a retry',
  async (db) => {
    const repo = new FakeRepo();
    const t = await bootRepoApp(db, repo);
    const { repositoryId } = await t.connect();
    const { id } = await t.draft(repositoryId);
    await t.call(t.owner, 'POST', `/change-sets/${id}/approve`);
    repo.proposeErrors.push(new GithubRateLimitError(403, 'secondary', 90));

    const limited = await t.call(t.owner, 'POST', `/change-sets/${id}/apply`);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '90');
    assert.equal(limited.body.retryAfterSeconds, 90);
    const waiting = (await t.call(t.owner, 'GET', `/change-sets/${id}`)).body.changeSet;
    assert.equal(waiting.status, 'approved');
    assert.match(waiting.error, /rate limit/);

    const retry = await t.call(t.owner, 'POST', `/change-sets/${id}/apply`);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.changeSet.status, 'applied');
    assert.equal(retry.body.changeSet.error, null);
  },
);

const failureCases: [string, () => unknown, number, string][] = [
  [
    'no write access',
    () => new GithubError('forbidden', 'No write access.', 403),
    422,
    'github_forbidden',
  ],
  [
    'blocked path',
    () => new GithubError('blocked_path', 'Refusing to change .github/x.'),
    422,
    'github_invalid',
  ],
  [
    'GitHub down',
    () => new GithubError('server', 'GitHub is down.', 503),
    502,
    'github_unavailable',
  ],
  ['default branch', () => new GithubError('default_branch', 'No.'), 409, 'default_branch'],
  ['branch exists', () => new BranchExistsError('mrm/x'), 409, 'branch_exists'],
  ['already matches', () => new GithubError('no_changes', 'Already matches.'), 409, 'no_changes'],
];
for (const [name, error, status, code] of failureCases) {
  dbTest(`apply failure (${name}) is ${status} ${code} and the set is failed`, async (db) => {
    const repo = new FakeRepo();
    const t = await bootRepoApp(db, repo);
    const { repositoryId } = await t.connect();
    const { id } = await t.draft(repositoryId);
    await t.call(t.owner, 'POST', `/change-sets/${id}/approve`);
    repo.proposeErrors.push(error());
    const res = await t.call(t.owner, 'POST', `/change-sets/${id}/apply`);
    assert.equal(res.status, status);
    assert.equal(res.body.error, code);
    const set = (await t.call(t.owner, 'GET', `/change-sets/${id}`)).body.changeSet;
    assert.equal(set.status, 'failed');
    assert.ok(set.error);
    assert.equal(set.prUrl, null);
  });
}

dbTest(
  'a branch without a pull request is failed, with the branch kept, never applied',
  async (db) => {
    const repo = new FakeRepo();
    const t = await bootRepoApp(db, repo);
    const { repositoryId } = await t.connect();
    const { id } = await t.draft(repositoryId);
    await t.call(t.owner, 'POST', `/change-sets/${id}/approve`);
    repo.proposeErrors.push(
      new PullRequestFailedError(
        'mrm/x',
        'b'.repeat(40),
        new GithubError('validation', 'No PR.', 422),
      ),
    );
    const res = await t.call(t.owner, 'POST', `/change-sets/${id}/apply`);
    assert.equal(res.status, 502);
    assert.equal(res.body.error, 'pull_request_failed');
    const set = res.body.changeSet;
    assert.equal(set.status, 'failed');
    assert.equal(set.branch, 'mrm/x');
    assert.equal(set.commitSha, 'b'.repeat(40));
    assert.equal(set.prUrl, null);
  },
);

dbTest(
  'a connector that returns neither a pull request nor a commit does not count as applied',
  async (db) => {
    const repo = new FakeRepo();
    const t = await bootRepoApp(db, repo);
    const { repositoryId } = await t.connect();
    const { id } = await t.draft(repositoryId);
    await t.call(t.owner, 'POST', `/change-sets/${id}/approve`);
    repo.proposeResult = { url: undefined, commitSha: undefined };
    const res = await t.call(t.owner, 'POST', `/change-sets/${id}/apply`);
    assert.equal(res.status, 502);
    assert.equal(res.body.changeSet.status, 'failed');
    const rows = await db.query("SELECT id FROM change_sets WHERE status = 'applied'");
    assert.equal(rows.length, 0);
  },
);

dbTest('a deleted credential is reported and leaves the set approved', async (db) => {
  const repo = new FakeRepo();
  const t = await bootRepoApp(db, repo);
  const { repositoryId, credentialId } = await t.connect();
  const { id } = await t.draft(repositoryId);
  await t.call(t.owner, 'POST', `/change-sets/${id}/approve`);
  await t.call(t.owner, 'DELETE', `/credentials/${credentialId}`);
  const res = await t.call(t.owner, 'POST', `/change-sets/${id}/apply`);
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'credential_not_found');
  assert.equal(res.body.changeSet.status, 'approved');
  assert.equal(repo.proposals.length, 0);
});

dbTest('a stale applying claim can be taken over, a fresh one cannot', async (db) => {
  const repo = new FakeRepo();
  const t = await bootRepoApp(db, repo);
  const { repositoryId } = await t.connect();
  const { id } = await t.draft(repositoryId);
  await t.call(t.owner, 'POST', `/change-sets/${id}/approve`);
  await db.execute("UPDATE change_sets SET status = 'applying', updated_at = ? WHERE id = ?", [
    Date.now(),
    id,
  ]);
  assert.equal(
    (await t.call(t.owner, 'POST', `/change-sets/${id}/apply`)).body.error,
    'apply_in_progress',
  );
  await db.execute('UPDATE change_sets SET updated_at = ? WHERE id = ?', [
    Date.now() - 11 * 60_000,
    id,
  ]);
  const res = await t.call(t.owner, 'POST', `/change-sets/${id}/apply`);
  assert.equal(res.status, 200);
  assert.equal(res.body.changeSet.status, 'applied');
});

dbTest('discard: states, and a draft cannot be approved afterwards', async (db) => {
  const repo = new FakeRepo();
  const t = await bootRepoApp(db, repo);
  const { repositoryId } = await t.connect();
  const { id } = await t.draft(repositoryId);
  const discarded = await t.call(t.owner, 'POST', `/change-sets/${id}/discard`);
  assert.equal(discarded.status, 200);
  assert.equal(discarded.body.changeSet.status, 'discarded');
  for (const action of ['approve', 'apply', 'discard']) {
    const res = await t.call(t.owner, 'POST', `/change-sets/${id}/${action}`);
    assert.equal(res.status, 409, action);
    assert.equal(res.body.error, 'invalid_state', action);
  }
  assert.equal(repo.proposals.length, 0);
  assert.ok((await t.auditActions()).some((a) => a.action === 'changeset.discard'));

  // An applied change set cannot be discarded either.
  const second = await t.draft(repositoryId, 'Another');
  await t.call(t.owner, 'POST', `/change-sets/${second.id}/approve`);
  await t.call(t.owner, 'POST', `/change-sets/${second.id}/apply`);
  assert.equal((await t.call(t.owner, 'POST', `/change-sets/${second.id}/discard`)).status, 409);
});

dbTest('permission matrix for change sets', async (db) => {
  const repo = new FakeRepo();
  const t = await bootRepoApp(db, repo);
  const { repositoryId } = await t.connect();
  const viewer = await t.addMember('viewer');
  const member = await t.addMember('member');
  const admin = await t.addMember('admin');
  const create = (cookie: string, subtitle: string) => t.draft(repositoryId, subtitle, cookie);

  // Everyone in the workspace reads; a viewer cannot draft.
  assert.equal((await create(viewer, 'v')).res.status, 403);
  const mine = await create(member, 'From a member');
  assert.equal(mine.res.status, 201);
  assert.equal(mine.res.body.changeSet.createdBy.type, 'user');
  for (const cookie of [viewer, member, admin]) {
    assert.equal((await t.call(cookie, 'GET', '/change-sets')).status, 200);
    assert.equal((await t.call(cookie, 'GET', `/change-sets/${mine.id}`)).status, 200);
  }

  // A member cannot approve, not even their own draft; nor can a viewer.
  for (const cookie of [viewer, member]) {
    assert.equal((await t.call(cookie, 'POST', `/change-sets/${mine.id}/approve`)).status, 403);
    assert.equal((await t.call(cookie, 'POST', `/change-sets/${mine.id}/apply`)).status, 403);
  }
  assert.equal((await t.call(admin, 'POST', `/change-sets/${mine.id}/approve`)).status, 200);
  // Approved by an admin: the member who drafted it still cannot apply or discard it.
  assert.equal((await t.call(member, 'POST', `/change-sets/${mine.id}/apply`)).status, 403);
  assert.equal((await t.call(member, 'POST', `/change-sets/${mine.id}/discard`)).status, 403);
  assert.equal((await t.call(admin, 'POST', `/change-sets/${mine.id}/apply`)).status, 200);

  // A member discards their own draft but not someone else's.
  const own = await create(member, 'Own draft');
  const theirs = await create(admin, 'Admin draft');
  assert.equal((await t.call(viewer, 'POST', `/change-sets/${own.id}/discard`)).status, 403);
  assert.equal((await t.call(member, 'POST', `/change-sets/${theirs.id}/discard`)).status, 403);
  assert.equal((await t.call(member, 'POST', `/change-sets/${own.id}/discard`)).status, 200);

  // An admin may approve and apply their own change set, and discard anyone's.
  assert.equal((await t.call(admin, 'POST', `/change-sets/${theirs.id}/approve`)).status, 200);
  const approvedBy = (await t.call(admin, 'GET', `/change-sets/${theirs.id}`)).body.changeSet;
  assert.equal(approvedBy.approvedBy, approvedBy.createdBy.id);
  assert.equal((await t.call(t.owner, 'POST', `/change-sets/${theirs.id}/discard`)).status, 200);

  // The audit log names the actor of each step.
  const audit = await t.auditActions();
  const approve = audit.find((a) => a.action === 'changeset.approve' && a.targetId === mine.id);
  assert.equal(approve?.actorId, `user-admin-${t.workspaceId}`);
});

dbTest(
  'a change set is applied with the credential of its repository, nothing else',
  async (db) => {
    const repo = new FakeRepo();
    const t = await bootRepoApp(db, repo);
    const { repositoryId } = await t.connect();
    const { id } = await t.draft(repositoryId);
    await t.call(t.owner, 'POST', `/change-sets/${id}/approve`);
    await t.call(t.owner, 'POST', `/change-sets/${id}/apply`);
    assert.ok(
      t.built.every((b) => b.kind === 'github_token' && b.owner === 'acme' && b.repo === 'app'),
    );
    const uses = (await t.auditActions()).filter((a) => a.action === 'credential.use');
    assert.ok(uses.some((u) => u.detail.includes('changeset.apply')));
  },
);

dbTest(
  'a connector that outlives the timeout is cancelled and the set is not recorded as failed',
  async (db) => {
    const repo = new FakeRepo();
    const t = await bootRepoApp(db, repo, { repositoryTimeoutMs: 40 });
    const { repositoryId } = await t.connect();
    const { id } = await t.draft(repositoryId);
    await t.call(t.owner, 'POST', `/change-sets/${id}/approve`);

    repo.proposeDelayMs = 200; // ignores the signal and still writes its branch afterwards
    const res = await t.call(t.owner, 'POST', `/change-sets/${id}/apply`);
    assert.equal(res.status, 504);
    assert.equal(res.body.error, 'timeout');
    assert.match(res.body.message, /may already exist/);
    assert.equal(repo.proposeSignals[0]?.aborted, true, 'the connector was told to stop');

    // Not "failed": a branch or pull request may exist. Still applying, with the reason on it.
    assert.equal(res.body.changeSet.status, 'applying');
    assert.match(res.body.changeSet.error, /stays "applying"/);
    const actions = (await t.auditActions()).map((a) => a.action);
    assert.ok(actions.includes('changeset.apply_timeout'));
    assert.ok(!actions.includes('changeset.apply_failed'));
    assert.ok(!actions.includes('changeset.apply'));

    // Let the late connector finish: it must not change the set behind our back.
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(
      (await t.call(t.owner, 'GET', `/change-sets/${id}`)).body.changeSet.status,
      'applying',
    );

    // Meanwhile it cannot be applied again or discarded...
    assert.equal(
      (await t.call(t.owner, 'POST', `/change-sets/${id}/apply`)).body.error,
      'apply_in_progress',
    );
    assert.equal((await t.call(t.owner, 'POST', `/change-sets/${id}/discard`)).status, 409);

    // ...until the claim is stale, as for a crash.
    repo.proposeDelayMs = 0;
    await db.execute('UPDATE change_sets SET updated_at = ? WHERE id = ?', [
      Date.now() - 11 * 60_000,
      id,
    ]);
    const again = await t.call(t.owner, 'POST', `/change-sets/${id}/apply`);
    assert.equal(again.status, 200);
    assert.equal(again.body.changeSet.status, 'applied');
  },
);

dbTest(
  'what a person typed in the summary cannot mention, link or close anything on GitHub',
  async (db) => {
    const repo = new FakeRepo();
    const t = await bootRepoApp(db, repo);
    const { repositoryId } = await t.connect();
    const summary =
      'Fixes #12, closes acme/app#3, resolved https://github.com/acme/app/issues/4 cc @octocat @acme/team';
    const read = await t.call(t.owner, 'GET', `/repositories/${repositoryId}/listing`);
    const listing = read.body.listing;
    listing.appStore.locales['en-US'].subtitle = 'Newer subtitle';
    const made = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/change-sets`, {
      summary,
      listing,
    });
    assert.equal(made.status, 201);
    const id = made.body.changeSet.id as string;
    assert.equal(made.body.changeSet.summary, summary, 'the set keeps what was typed');
    await t.call(t.owner, 'POST', `/change-sets/${id}/approve`);
    assert.equal((await t.call(t.owner, 'POST', `/change-sets/${id}/apply`)).status, 200);

    const sent = repo.proposals[0];
    const outgoing = [
      sent?.options.title ?? '',
      sent?.options.body ?? '',
      sent?.changeSet.summary ?? '',
    ];
    for (const text of outgoing) {
      assert.doesNotMatch(text, /@(?=\w)/, text);
      assert.doesNotMatch(text, /#(?=\d)/, text);
      assert.doesNotMatch(text, /:\/\//, text);
      assert.doesNotMatch(text, /\b(fix(es|ed)?|close[sd]?|resolve[sd]?)\b/i, text);
    }
    // Still readable: with the invisible characters removed it is the original text.
    assert.equal(outgoing[0]?.replaceAll('​', ''), summary);
    assert.equal(outgoing[2]?.replaceAll('​', ''), summary);
    // In the body it is a one-line quote, so it cannot open a heading, list or code block.
    assert.match(sent?.options.body ?? '', /^> /);
    assert.equal((sent?.options.body ?? '').split('\n')[0]?.replaceAll('​', ''), `> ${summary}`);
  },
);
