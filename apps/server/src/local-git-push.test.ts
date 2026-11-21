import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BRANCH,
  buildRepo,
  FASTLANE,
  git,
  SUBTITLE,
  scratch,
  setup,
  snapshot,
  withPrivateTmp,
} from './local-git-test-helpers.ts';
import {
  classifyPush,
  createBranchCommit,
  pushBranchCommit,
  scrubPushText,
} from './services/local-git.ts';

/** Pushing a local commit through the managed code path (ADR 0005): a bare repository or a local HTTP stub is the remote. */

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');

async function committed() {
  const s = setup();
  const done = await createBranchCommit({
    gitPath: s.wrapper.path,
    path: s.dir,
    roots: s.roots,
    baseBranch: 'main',
    branch: BRANCH,
    files: [SUBTITLE],
    message: 'Update the subtitle',
    author: { name: 'Ada', email: 'ada@example.com' },
    now: Date.UTC(2026, 10, 18),
  });
  assert.equal(done.ok, true);
  const commit = done.ok ? done.commit : '';
  const bare = join(s.base, 'remote.git');
  git(s.base, 'init', '-q', '--bare', bare);
  const push = (over: Partial<Parameters<typeof pushBranchCommit>[0]> = {}) =>
    pushBranchCommit({
      gitPath: s.wrapper.path,
      path: s.dir,
      roots: s.roots,
      commit,
      branch: BRANCH,
      url: bare,
      protocol: 'file',
      ...over,
    });
  return { s, commit, bare, push };
}

test('the commit arrives as a branch of the remote, with its history, and the clone is untouched', async () => {
  const { s, commit, bare, push } = await committed();
  const before = snapshot(s.dir);
  const { done, left } = await withPrivateTmp(async (tmp) => {
    const result = await push();
    return { done: result, left: readdirSync(tmp) };
  });
  assert.deepEqual(done, { ok: true, upToDate: false });
  assert.equal(git(bare, 'rev-parse', `refs/heads/${BRANCH}`), commit);
  assert.equal(git(bare, 'rev-parse', `${commit}^`), git(s.dir, 'rev-parse', 'main'));
  assert.deepEqual(
    git(bare, 'for-each-ref', '--format=%(refname)').split('\n'),
    [`refs/heads/${BRANCH}`],
    'one ref, no tags, no main',
  );
  assert.deepEqual(
    snapshot(s.dir),
    before,
    'working tree, index, HEAD, config, hooks and refs are the same',
  );
  assert.deepEqual(left, [], 'the private repository is removed');
  // Pushing the same commit again changes nothing and says so: a retry is safe.
  assert.deepEqual(await push(), { ok: true, upToDate: true });
});

test('the clone’s own config, hooks and remotes are never consulted: insteadOf, pre-push, credential helper, ssh command', async () => {
  const { s, commit, bare, push } = await committed();
  const decoy = join(s.base, 'decoy.git');
  git(s.base, 'init', '-q', '--bare', decoy);
  const marker = join(s.base, 'ran');
  git(s.dir, 'remote', 'add', 'origin', decoy);
  git(s.dir, 'config', `url.${decoy}.insteadOf`, bare);
  git(s.dir, 'config', 'url.https://evil.example/.insteadOf', 'https://github.com/');
  git(s.dir, 'config', 'credential.helper', `!touch '${marker}'`);
  git(s.dir, 'config', 'core.sshCommand', `touch '${marker}'`);
  git(s.dir, 'config', 'push.default', 'matching');
  git(s.dir, 'config', 'remote.origin.pushurl', decoy);
  git(s.dir, 'config', 'remote.origin.push', '+refs/*:refs/*');
  for (const hook of ['pre-push', 'reference-transaction', 'post-update']) {
    writeFileSync(join(s.dir, '.git', 'hooks', hook), `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(join(s.dir, '.git', 'hooks', hook), 0o755);
  }
  const done = await push();
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(
    git(bare, 'rev-parse', `refs/heads/${BRANCH}`),
    commit,
    'it went to the address we named',
  );
  assert.equal(git(decoy, 'for-each-ref'), '', 'nothing went to the configured remote');
  assert.equal(existsSync(marker), false, 'nothing of the clone ran');
});

test('a branch that exists on the remote with other history is rejected, never forced, and the commit stays', async () => {
  const { s, commit, bare, push } = await committed();
  const other = buildRepo(s.root, 'other', { 'x.txt': 'x\n' });
  git(other, 'push', '-q', bare, `main:refs/heads/${BRANCH}`);
  const theirs = git(bare, 'rev-parse', `refs/heads/${BRANCH}`);
  const done = await push();
  assert.equal(done.ok, false);
  if (!done.ok) {
    assert.equal(done.code, 'push_rejected');
    assert.match(done.message, /already exists there/);
  }
  assert.equal(git(bare, 'rev-parse', `refs/heads/${BRANCH}`), theirs, 'not moved');
  assert.equal(
    git(s.dir, 'rev-parse', `refs/heads/${BRANCH}`),
    commit,
    'the local commit is still there',
  );
});

test('a remote that cannot be reached is a failure with a message, and a retry works once it can', async () => {
  const { s, commit, bare, push } = await committed();
  const missing = join(s.base, 'nowhere.git');
  const failed = await push({ url: missing });
  assert.equal(failed.ok, false);
  assert.equal(git(s.dir, 'rev-parse', `refs/heads/${BRANCH}`), commit);
  const ok = await push({ url: bare });
  assert.equal(ok.ok, true);
});

test('input is checked: protocol, credentials in the address, token characters, branch, commit, folder', async () => {
  const { s, commit, bare, push } = await committed();
  const code = async (over: Parameters<typeof push>[0]) => {
    const r = await push(over);
    return r.ok ? 'ok' : r.code;
  };
  assert.equal(await code({ protocol: 'https' }), 'invalid_url', 'a file address is not https');
  assert.equal(await code({ protocol: 'file', url: `file://u:p@host${bare}` }), 'invalid_url');
  assert.equal(
    await code({ protocol: 'http', url: 'http://u:p@127.0.0.1:1/x.git' }),
    'invalid_url',
  );
  assert.equal(
    await code({ protocol: 'https', url: 'https://github.com/a/b.git?x=1' }),
    'invalid_url',
  );
  assert.equal(
    await code({ protocol: 'https', url: 'ssh://git@github.com/a/b.git' }),
    'invalid_url',
  );
  assert.equal(
    await code({ protocol: 'https', url: 'https://github.com/a/b.git', token: 'bad token\n' }),
    'invalid_token',
  );
  assert.equal(await code({ branch: '--all' }), 'git_failed');
  assert.equal(await code({ branch: 'HEAD' }), 'git_failed');
  assert.equal(await code({ commit: 'main' }), 'commit_missing');
  assert.equal(await code({ commit: 'a'.repeat(40) }), 'commit_missing');
  const outside = buildRepo(scratch(), 'elsewhere', FASTLANE);
  assert.equal(await code({ path: outside }), 'outside_roots');
  assert.equal(await code({ path: join(s.root, 'missing') }), 'not_found');
  assert.equal(commit.length, 40);
  assert.equal(git(bare, 'for-each-ref'), '', 'nothing was pushed by any of them');
});

test('the token reaches the remote only as the scoped header and never appears in an argument, a result or a message', async () => {
  const { s, commit, push } = await committed();
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    res.statusCode = 403;
    res.end('forbidden');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const { done, left } = await withPrivateTmp(async (tmp) => {
      const result = await push({
        protocol: 'http',
        url: `http://127.0.0.1:${port}/acme/app.git`,
        token: TOKEN,
      });
      return { done: result, left: readdirSync(tmp) };
    });
    assert.equal(done.ok, false);
    if (!done.ok) assert.equal(done.code, 'push_auth');
    assert.ok(seen.length > 0, 'git reached the stub');
    assert.equal(seen[0]?.authorization, `Basic ${BASIC}`);
    const all =
      JSON.stringify(done) +
      s.wrapper
        .calls()
        .map((c) => c.args + c.cwd)
        .join('\n');
    for (const secret of [TOKEN, BASIC])
      assert.equal(all.includes(secret), false, 'the secret is in no argument or result');
    assert.equal(commit.length, 40);
    assert.deepEqual(left, []);
  } finally {
    server.close();
  }
});

test('a remote that never answers is stopped at the timeout and its process is gone', async () => {
  const { push } = await committed();
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(() => {
    // Never answers.
  });
  server.on('connection', (socket) => sockets.add(socket));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const started = Date.now();
    const done = await push({
      protocol: 'http',
      url: `http://127.0.0.1:${port}/acme/app.git`,
      timeoutMs: 700,
    });
    assert.equal(done.ok === false && done.code, 'push_timeout');
    assert.ok(Date.now() - started < 5000);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(
      [...sockets].every((s) => s.destroyed || s.readableEnded),
      true,
      'the connection was closed',
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
  }
});

test('scrubbing removes the token, its encodings, Authorization lines, address credentials and folders', () => {
  const text = `fatal: unable to access 'https://x-access-token:${TOKEN}@github.com/a/b.git/': ${TOKEN} ${BASIC}\nAuthorization: Basic ${BASIC}\n/home/u/secret/clone /tmp/kiln-push-1`;
  const out = scrubPushText(
    text,
    [TOKEN, BASIC, `Authorization: Basic ${BASIC}`],
    ['/home/u/secret/clone', '/tmp/kiln-push-1'],
  );
  assert.equal(out.includes(TOKEN), false);
  assert.equal(out.includes(BASIC), false);
  assert.equal(out.includes('/home/u'), false);
  assert.match(out, /\[redacted\]/);
});

test('classification: one fixed message per class, from what git says', () => {
  const r = (stderr: string, failed?: 'timeout' | 'missing') =>
    classifyPush({ code: 1, stdout: Buffer.alloc(0), stderr, ...(failed ? { failed } : {}) });
  assert.equal(r('remote: Permission to a/b.git denied to x').code, 'push_auth');
  assert.equal(r('fatal: Authentication failed for ...').code, 'push_auth');
  assert.equal(
    r('error: failed to push some refs\n ! [rejected] x -> y (fetch first)').code,
    'push_rejected',
  );
  assert.equal(r('remote: error: GH006: Protected branch update failed').code, 'push_declined');
  assert.equal(
    r('fatal: unable to access: Could not resolve host: github.com').code,
    'push_network',
  );
  assert.equal(r('fatal: repository not found').code, 'push_not_found');
  assert.equal(r('', 'timeout').code, 'push_timeout');
  assert.equal(r('', 'missing').code, 'git_missing');
  const unknown = r('something strange with ghp_secretsecretsecretsecret');
  assert.equal(unknown.code, 'push_failed');
  assert.equal(unknown.message.includes('ghp_'), false);
});
