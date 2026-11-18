import assert from 'node:assert/strict';
import { GithubError, GithubRateLimitError } from '@mrm/connectors';
import { dbTest } from '@mrm/db/testing';
import { FakeRepo, TOKEN, bootRepoApp } from './repo-test-helpers.ts';

dbTest('connect, scan and read the listing of a fastlane repository', async (db) => {
  const t = await bootRepoApp(db);
  const { credentialId, repositoryId, res } = await t.connect();
  assert.equal(res.status, 201);
  assert.equal(res.body.repository.defaultBranch, 'main');
  assert.equal(res.body.repository.projectKind, null);
  assert.equal(res.body.repository.credentialId, credentialId);
  // The connector was built from the decrypted credential, with the right kind.
  assert.deepEqual(t.built, [{ kind: 'github_token', secret: TOKEN, owner: 'acme', repo: 'app' }]);

  const list = await t.call(t.owner, 'GET', '/repositories');
  assert.equal(list.body.repositories.length, 1);

  const scan = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/scan`);
  assert.equal(scan.status, 200);
  assert.equal(scan.body.detection.kind, 'fastlane');
  assert.deepEqual(scan.body.detection.locales.ios, ['de-DE', 'en-US']);
  assert.equal(scan.body.repository.projectKind, 'fastlane');
  assert.ok(scan.body.repository.detectedAt > 0);

  const one = await t.call(t.owner, 'GET', `/repositories/${repositoryId}`);
  assert.equal(one.body.detection.kind, 'fastlane');

  const listing = await t.call(t.owner, 'GET', `/repositories/${repositoryId}/listing`);
  assert.equal(listing.status, 200);
  assert.equal(listing.body.listing.appStore.locales['en-US'].subtitle, 'Old subtitle');
  assert.equal(listing.body.listing.appStore.locales['de-DE'].subtitle, 'Alter Untertitel');
  assert.equal(listing.body.found.appStore, true);
  assert.ok(Array.isArray(listing.body.problems));

  const actions = (await t.auditActions()).map((a) => a.action);
  assert.ok(actions.includes('repository.connect'));
  assert.ok(actions.includes('repository.scan'));
  assert.ok(actions.includes('credential.use'));
});

dbTest('the same repository cannot be connected twice, whatever the case', async (db) => {
  const t = await bootRepoApp(db);
  const { credentialId } = await t.connect();
  const again = await t.call(t.owner, 'POST', '/repositories', {
    credentialId,
    owner: 'ACME',
    repo: 'App',
  });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'already_connected');
  assert.equal((await t.call(t.owner, 'GET', '/repositories')).body.repositories.length, 1);
});

dbTest('only github credentials of this workspace can connect a repository', async (db) => {
  const t = await bootRepoApp(db);
  const store = await t.addCredential(
    'google_play',
    JSON.stringify({ client_email: 'a@b.c', private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----' }),
  );
  const wrongKind = await t.call(t.owner, 'POST', '/repositories', {
    credentialId: store,
    owner: 'acme',
    repo: 'app',
  });
  assert.equal(wrongKind.status, 422);
  assert.equal(wrongKind.body.error, 'credential_kind');

  const unknown = await t.call(t.owner, 'POST', '/repositories', {
    credentialId: 'nope',
    owner: 'acme',
    repo: 'app',
  });
  assert.equal(unknown.status, 422);
  assert.equal(unknown.body.error, 'credential_not_found');

  // A credential of another workspace looks exactly like a missing one.
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  const foreign = await t.addCredential('github_token', TOKEN, outsider, 'other');
  const cross = await t.call(t.owner, 'POST', '/repositories', {
    credentialId: foreign,
    owner: 'acme',
    repo: 'app',
  });
  assert.equal(cross.status, 422);
  assert.equal(cross.body.error, 'credential_not_found');
  assert.equal(t.built.length, 0);
});

dbTest('connect validates names and reports what GitHub said', async (db) => {
  const repo = new FakeRepo();
  const t = await bootRepoApp(db, repo);
  const credentialId = await t.addCredential();
  const bad = await t.call(t.owner, 'POST', '/repositories', {
    credentialId,
    owner: 'acme/evil',
    repo: '..',
  });
  assert.equal(bad.status, 400);

  repo.defaultBranchError = new GithubError('not_found', 'GitHub says acme/app was not found.', 404);
  const missing = await t.call(t.owner, 'POST', '/repositories', { credentialId, owner: 'acme', repo: 'app' });
  assert.equal(missing.status, 422);
  assert.equal(missing.body.error, 'github_not_found');

  repo.defaultBranchError = new GithubError('auth', 'Bad credentials.', 401);
  assert.equal((await t.call(t.owner, 'POST', '/repositories', { credentialId, owner: 'acme', repo: 'app' })).body.error, 'github_auth');

  repo.defaultBranchError = new GithubRateLimitError(403, 'primary', 42);
  const limited = await t.call(t.owner, 'POST', '/repositories', { credentialId, owner: 'acme', repo: 'app' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '42');
  assert.equal(limited.body.retryAfterSeconds, 42);

  // Nothing was saved by the failures.
  assert.equal((await t.call(t.owner, 'GET', '/repositories')).body.repositories.length, 0);
});

dbTest('a connector error that carries the token is redacted', async (db) => {
  const repo = new FakeRepo();
  const t = await bootRepoApp(db, repo);
  const { repositoryId } = await t.connect();
  repo.listError = new GithubError('server', `upstream said: token ${TOKEN} is odd`, 500);
  const res = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/scan`);
  assert.equal(res.status, 502);
  assert.doesNotMatch(res.text, /ghp_abcdef/);
  assert.match(res.body.message, /redacted/);
});

dbTest('scan times out instead of hanging', async (db) => {
  const repo = new FakeRepo();
  const t = await bootRepoApp(db, repo, { repositoryTimeoutMs: 30 });
  const { repositoryId } = await t.connect();
  repo.listDelayMs = 300;
  const res = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/scan`);
  assert.equal(res.status, 504);
  assert.equal(res.body.error, 'timeout');
});

dbTest('scan and listing report a deleted credential', async (db) => {
  const t = await bootRepoApp(db);
  const { credentialId, repositoryId } = await t.connect();
  assert.equal((await t.call(t.owner, 'DELETE', `/credentials/${credentialId}`)).status, 204);
  const scan = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/scan`);
  assert.equal(scan.status, 422);
  assert.equal(scan.body.error, 'credential_not_found');
});

dbTest('disconnect is audited and refused while a change set is open', async (db) => {
  const t = await bootRepoApp(db);
  const { repositoryId } = await t.connect();
  const { id } = await t.draft(repositoryId);
  const blocked = await t.call(t.owner, 'DELETE', `/repositories/${repositoryId}`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'open_change_sets');
  await t.call(t.owner, 'POST', `/change-sets/${id}/discard`);
  assert.equal((await t.call(t.owner, 'DELETE', `/repositories/${repositoryId}`)).status, 204);
  assert.equal((await t.call(t.owner, 'GET', `/repositories/${repositoryId}`)).status, 404);
  assert.equal((await t.call(t.owner, 'GET', `/change-sets/${id}`)).status, 404);
  assert.ok((await t.auditActions()).some((a) => a.action === 'repository.disconnect'));
});

dbTest('who may do what with repositories', async (db) => {
  const t = await bootRepoApp(db);
  const { credentialId, repositoryId } = await t.connect();
  const viewer = await t.addMember('viewer');
  const member = await t.addMember('member');
  const admin = await t.addMember('admin');
  const base = `/repositories/${repositoryId}`;

  for (const cookie of [viewer, member, admin]) {
    assert.equal((await t.call(cookie, 'GET', '/repositories')).status, 200);
  }
  // The listing is read from GitHub with the stored credential: viewers may not trigger that.
  const callsBefore = t.repo.listCalls;
  assert.equal((await t.call(viewer, 'GET', `${base}/listing`)).status, 403);
  assert.equal(t.repo.listCalls, callsBefore, 'no GitHub traffic for a viewer');
  assert.equal((await t.call(viewer, 'GET', base)).status, 200, 'stored data stays readable');
  for (const cookie of [member, admin]) {
    assert.equal((await t.call(cookie, 'GET', `${base}/listing`)).status, 200);
  }
  const connectBody = { credentialId, owner: 'acme', repo: 'other' };
  assert.equal((await t.call(viewer, 'POST', '/repositories', connectBody)).status, 403);
  assert.equal((await t.call(member, 'POST', '/repositories', connectBody)).status, 403);
  assert.equal((await t.call(viewer, 'POST', `${base}/scan`)).status, 403);
  assert.equal((await t.call(member, 'POST', `${base}/scan`)).status, 200);
  assert.equal((await t.call(viewer, 'DELETE', base)).status, 403);
  assert.equal((await t.call(member, 'DELETE', base)).status, 403);
  assert.equal((await t.call(admin, 'POST', '/repositories', connectBody)).status, 201);
  assert.equal((await t.call(admin, 'DELETE', base)).status, 204);
});

dbTest('another workspace cannot see or use a repository: 404 everywhere', async (db) => {
  const t = await bootRepoApp(db);
  const { repositoryId } = await t.connect();
  const { id } = await t.draft(repositoryId);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  const out = (method: string, path: string, body?: unknown, ws = 'other') =>
    t.call(outsider, method, path, body, ws);

  // Their own workspace, my ids.
  assert.equal((await out('GET', '/repositories')).body.repositories.length, 0);
  for (const [method, path] of [
    ['GET', `/repositories/${repositoryId}`],
    ['POST', `/repositories/${repositoryId}/scan`],
    ['GET', `/repositories/${repositoryId}/listing`],
    ['DELETE', `/repositories/${repositoryId}`],
    ['GET', `/change-sets/${id}`],
    ['POST', `/change-sets/${id}/approve`],
    ['POST', `/change-sets/${id}/apply`],
    ['POST', `/change-sets/${id}/discard`],
  ] as const) {
    const res = await out(method, path);
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  assert.equal(
    (await out('POST', `/repositories/${repositoryId}/change-sets`, { summary: 'x', listing: {} })).status,
    404,
  );
  assert.equal((await out('GET', '/change-sets')).body.changeSets.length, 0);
  // My workspace, their session.
  assert.equal((await out('GET', '/repositories', undefined, t.workspaceId)).status, 404);
  assert.equal((await out('GET', `/change-sets/${id}`, undefined, t.workspaceId)).status, 404);
});

dbTest('disconnect meeting a change set created at the same moment is a 409, not a 500, and deletes nothing', async (db) => {
  const t = await bootRepoApp(db);
  const { repositoryId } = await t.connect();
  const { disconnectRepository } = await import('./services/repositories.ts');

  // A database whose transaction lets another request slip in a draft right after the
  // "any open change sets?" check, which is the window a real second request would use.
  const racy: typeof db = {
    ...db,
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          ...tx,
          async query(statement, params) {
            const rows = await tx.query(statement, params);
            if (/FROM change_sets/.test(statement) && /status IN/.test(statement)) {
              await tx.execute(
                `INSERT INTO change_sets (id, workspace_id, repository_id, summary, status, created_by_type,
                   created_by_id, files_json, created_at, updated_at)
                 VALUES ('raced', ?, ?, 'raced', 'draft', 'user', 'u', '[]', 1, 1)`,
                [t.workspaceId, repositoryId],
              );
            }
            return rows;
          },
        } as typeof tx),
      ),
  };
  const ctx = { db: racy, masterKey: Buffer.alloc(32), now: () => 1, connectorFactory: () => t.repo, timeoutMs: 1000 };
  const result = await disconnectRepository(ctx, { workspaceId: t.workspaceId, id: repositoryId }, { type: 'user', id: 'u' });
  assert.equal(result.ok, false);
  assert.equal((result as { status: number }).status, 409);
  assert.equal((result as { body: { error: string } }).body.error, 'open_change_sets');
  // Rolled back: the repository and the new change set are both still there.
  assert.equal((await t.call(t.owner, 'GET', `/repositories/${repositoryId}`)).status, 200);
  const [row] = await db.query("SELECT COUNT(*) AS n FROM change_sets WHERE id = 'raced'");
  assert.equal(Number(row?.n), 0, 'the simulated draft was inside the rolled back transaction');
});

dbTest('a repository disconnected while a change set is being made gives 404, not 500', async (db) => {
  const repo = new FakeRepo();
  const t = await bootRepoApp(db, repo);
  const { repositoryId } = await t.connect();
  const read = await t.call(t.owner, 'GET', `/repositories/${repositoryId}/listing`);
  const listing = read.body.listing;
  listing.appStore.locales['en-US'].subtitle = 'Changed';

  repo.listDelayMs = 60; // GitHub is slow to answer; the repository goes away meanwhile
  const creating = t.call(t.owner, 'POST', `/repositories/${repositoryId}/change-sets`, { summary: 'X', listing });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await t.call(t.owner, 'DELETE', `/repositories/${repositoryId}`)).status, 204);
  const res = await creating;
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});
