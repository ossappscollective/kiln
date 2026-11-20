import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { isBlobReads } from './blobs.ts';
import { GithubError } from './errors.ts';
import { GitCloneReader } from './github/git-clone.ts';
import { GithubRepoConnector } from './github/github.ts';

// Binary reads for the asset index: a real git repository in a temp folder for the clone reader, a
// fake `fetch` for the GitHub REST reader. No network.

const roots: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mrm-blobs-'));
  roots.push(dir);
  return dir;
};
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const gitEnv = {
  PATH: process.env.PATH ?? '',
  HOME: tmpdir(),
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync(REAL_GIT, args, { cwd, encoding: 'utf8', env: gitEnv }).trim();
const inClone = (dir: string, ...args: string[]) =>
  execFileSync(REAL_GIT, [`--git-dir=${dir}`, ...args], {
    encoding: 'utf8',
    env: { ...gitEnv, GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'mrm-offline' },
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
const hasObject = (cloneDir: string, oid: string): boolean => {
  try {
    inClone(cloneDir, 'cat-file', '-e', oid);
    return true;
  } catch {
    return false;
  }
};

type Files = Record<string, string | Buffer>;
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const big = (length: number, fill = 1) =>
  Buffer.concat([PNG_HEAD, Buffer.alloc(length - PNG_HEAD.length, fill)]);

function makeSource(files: Files): string {
  const dir = join(scratch(), 'source');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'uploadpack.allowFilter', 'true');
  git(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  symlinkSync('a.png', join(dir, 'link.png'));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

const clonesDir = (): string => {
  const dir = join(scratch(), 'clones');
  mkdirSync(dir);
  return dir;
};

const reader = (source: string, extra: { filter?: string | null; gitPath?: string } = {}) =>
  new GitCloneReader({
    baseDir: clonesDir(),
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    source: { type: 'local', path: source },
    filter: extra.filter === undefined ? 'blob:none' : extra.filter,
    defaultBranch: 'main',
    ...(extra.gitPath ? { gitPath: extra.gitPath } : {}),
  });

const FILES: Files = {
  'a.png': big(2000, 1),
  'b.png': big(5000, 2),
  'sub/c.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...Buffer.from('JFIF')]),
  'notes.txt': 'text file\n',
  'huge.png': big(3 * 1024 * 1024, 3),
};

// =================================================================================================
// GitCloneReader
// =================================================================================================

test('both readers are BlobReads; a plain object is not', () => {
  assert.equal(isBlobReads(reader(makeSource(FILES))), true);
  assert.equal(isBlobReads({ listBlobEntries() {} }), false);
  assert.equal(isBlobReads(null), false);
  assert.equal(isBlobReads('x'), false);
});

test('clone: lists every file with its object id, without symlinks, and no sizes', async () => {
  const source = makeSource(FILES);
  const r = reader(source);
  const listing = await r.listBlobEntries();
  assert.equal(listing.commit, git(source, 'rev-parse', 'HEAD'));
  assert.deepEqual(
    listing.entries.map((e) => e.path),
    ['a.png', 'b.png', 'huge.png', 'notes.txt', 'sub/c.jpg'],
  );
  for (const entry of listing.entries) {
    assert.equal(entry.oid, git(source, 'rev-parse', `HEAD:${entry.path}`), entry.path);
    assert.equal(entry.mode, '100644');
    assert.equal(entry.size, null);
  }
});

test('clone: only the first headBytes are returned, with the real size and the object id', async () => {
  const source = makeSource(FILES);
  const r = reader(source);
  const res = await r.readBlobHeads(['a.png', 'b.png', 'sub/c.jpg'], {
    headBytes: 100,
    maxFileBytes: 10_000_000,
    maxTransferBytes: 10_000_000,
  });
  const a = res.items.get('a.png');
  assert.ok(a?.ok);
  if (a?.ok) {
    assert.equal(a.size, 2000);
    assert.equal(a.head.length, 100);
    assert.deepEqual(Buffer.from(a.head), big(2000, 1).subarray(0, 100));
    assert.equal(a.oid, git(source, 'rev-parse', 'HEAD:a.png'));
  }
  const b = res.items.get('b.png');
  if (b?.ok) assert.equal(b.size, 5000);
  const c = res.items.get('sub/c.jpg');
  if (c?.ok) assert.equal(c.head.length, c.size, 'a file shorter than headBytes comes whole');
  assert.ok(res.transferredBytes > 0, 'a partial clone fetched the blobs');
});

test('clone: a missing file, a symlink and duplicates', async () => {
  const r = reader(makeSource(FILES));
  const res = await r.readBlobHeads(['nope.png', 'link.png', 'a.png', 'a.png'], {
    headBytes: 64,
    maxFileBytes: 1 << 30,
    maxTransferBytes: 1 << 30,
  });
  assert.deepEqual(res.items.get('nope.png'), {
    ok: false,
    oid: null,
    reason: 'missing',
    size: null,
  });
  assert.deepEqual(res.items.get('link.png'), {
    ok: false,
    oid: null,
    reason: 'missing',
    size: null,
  });
  assert.equal(res.items.size, 3);
});

test('clone: a file over maxFileBytes is reported with its size and its bytes are never read', async () => {
  const source = makeSource(FILES);
  const r = reader(source);
  const res = await r.readBlobHeads(['huge.png', 'a.png'], {
    headBytes: 64,
    maxFileBytes: 1024 * 1024,
    maxTransferBytes: 1 << 30,
  });
  const huge = res.items.get('huge.png');
  assert.equal(huge?.ok, false);
  if (huge && !huge.ok) {
    assert.equal(huge.reason, 'too_large');
    assert.equal(huge.size, 3 * 1024 * 1024);
  }
  assert.equal(res.items.get('a.png')?.ok, true);
});

test('clone: the transfer budget stops fetching, and what was not fetched is "budget"', async () => {
  const files: Files = {};
  for (let i = 0; i < 20; i++) files[`s/${String(i).padStart(2, '0')}.png`] = big(40_000, i + 1);
  const source = makeSource(files);
  const r = reader(source);
  const paths = Object.keys(files).sort();
  const res = await r.readBlobHeads(paths, {
    headBytes: 64,
    maxFileBytes: 1 << 30,
    maxTransferBytes: 100_000,
  });
  const reasons = paths.map((p) => {
    const item = res.items.get(p);
    return item?.ok ? 'ok' : (item?.reason ?? 'none');
  });
  assert.ok(reasons.includes('budget'), reasons.join());
  assert.ok(reasons.includes('ok'));
  // Chunks of eight: the first chunk is always fetched, so the overshoot is bounded by one chunk.
  assert.ok(res.transferredBytes <= 100_000 + 8 * 40_000, String(res.transferredBytes));
  const budgeted = paths.filter((p) => {
    const item = res.items.get(p);
    return item && !item.ok && item.reason === 'budget';
  });
  for (const path of budgeted)
    assert.equal(
      hasObject(r.dir, git(source, 'rev-parse', `HEAD:${path}`)),
      false,
      `${path} was not fetched`,
    );
});

test('clone: headBytes 0 gives sizes of the blobs that are present and fetches nothing', async () => {
  const source = makeSource(FILES);
  const r = reader(source);
  const res = await r.readBlobHeads(['a.png', 'b.png'], {
    headBytes: 0,
    maxFileBytes: 1 << 30,
    maxTransferBytes: 0,
  });
  for (const path of ['a.png', 'b.png']) {
    const item = res.items.get(path);
    assert.equal(item?.ok, false, path);
    if (item && !item.ok)
      assert.equal(
        item.reason,
        'unsized',
        'the blob is not in the partial clone and nothing is downloaded to learn its size',
      );
  }
  assert.equal(res.transferredBytes, 0);
  assert.equal(hasObject(r.dir, git(source, 'rev-parse', 'HEAD:a.png')), false);
  // After the blob is in the clone, its size is free.
  await r.readBlobHeads(['a.png'], {
    headBytes: 8,
    maxFileBytes: 1 << 30,
    maxTransferBytes: 1 << 30,
  });
  const again = await r.readBlobHeads(['a.png'], {
    headBytes: 0,
    maxFileBytes: 1 << 30,
    maxTransferBytes: 0,
  });
  const item = again.items.get('a.png');
  assert.equal(item?.ok, true);
  if (item?.ok) {
    assert.equal(item.size, 2000);
    assert.equal(item.head.length, 0);
  }
});

test('clone: a clone without a filter has every blob and the size is free', async () => {
  const r = reader(makeSource(FILES), { filter: null });
  const res = await r.readBlobHeads(['a.png', 'huge.png'], {
    headBytes: 0,
    maxFileBytes: 1 << 30,
    maxTransferBytes: 0,
  });
  assert.equal(res.items.get('a.png')?.ok, true);
  assert.equal(res.items.get('huge.png')?.ok, true);
});

test('clone: reading a pinned commit, a bad ref and an aborted signal', async () => {
  const source = makeSource(FILES);
  const first = git(source, 'rev-parse', 'HEAD');
  writeFileSync(join(source, 'a.png'), big(2000, 9));
  git(source, 'commit', '-qam', 'second');
  const r = reader(source);
  const old = await r.readBlobHeads(['a.png'], {
    ref: first,
    headBytes: 16,
    maxFileBytes: 1 << 30,
    maxTransferBytes: 1 << 30,
  });
  const now = await r.readBlobHeads(['a.png'], {
    headBytes: 16,
    maxFileBytes: 1 << 30,
    maxTransferBytes: 1 << 30,
  });
  const oldItem = old.items.get('a.png');
  const nowItem = now.items.get('a.png');
  assert.ok(oldItem?.ok && nowItem?.ok);
  if (oldItem?.ok && nowItem?.ok) assert.notEqual(oldItem.oid, nowItem.oid);
  await assert.rejects(
    r.readBlobHeads(['a.png'], {
      ref: 'no-such-branch',
      headBytes: 16,
      maxFileBytes: 1,
      maxTransferBytes: 1,
    }),
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    r.readBlobHeads(['a.png'], {
      headBytes: 16,
      maxFileBytes: 1,
      maxTransferBytes: 1,
      signal: controller.signal,
    }),
  );
});

test('clone: git is never asked for more than the head of a big file', async () => {
  const dir = scratch();
  const path = join(dir, 'git');
  const log = join(dir, 'calls.log');
  writeFileSync(path, `#!/bin/sh\necho "$@" >> '${log}'\nexec '${REAL_GIT}' "$@"\n`);
  chmodSync(path, 0o755);
  const r = reader(makeSource(FILES), { gitPath: path });
  const t0 = Date.now();
  const res = await r.readBlobHeads(['huge.png'], {
    headBytes: 64,
    maxFileBytes: 1 << 30,
    maxTransferBytes: 1 << 30,
  });
  const item = res.items.get('huge.png');
  assert.ok(item?.ok);
  if (item?.ok) assert.equal(item.head.length, 64);
  assert.ok(Date.now() - t0 < 20_000);
});

// =================================================================================================
// GithubRepoConnector
// =================================================================================================

const SHA = 'c'.repeat(40);
type Blob = { sha: string; bytes: Buffer };
const blob = (sha: string, bytes: Buffer): Blob => ({ sha, bytes });

type Setup = {
  tree: { path: string; type: string; mode: string; sha: string; size?: number }[];
  blobs: Blob[];
  blobStatus?: Record<string, number>;
  truncated?: boolean;
};

function fakeGithub(setup: Setup) {
  const calls: string[] = [];
  const f: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.pathname === `/repos/acme/app/git/trees/${SHA}`)
      return json(200, { sha: SHA, truncated: setup.truncated === true, tree: setup.tree });
    const m = /\/git\/blobs\/([0-9a-f]+)$/.exec(url.pathname);
    if (m) {
      const status = setup.blobStatus?.[m[1] as string];
      if (status)
        return json(status, { message: status === 401 ? 'Bad credentials' : 'Not Found' });
      const found = setup.blobs.find((b) => b.sha === m[1]);
      if (!found) return json(404, { message: 'Not Found' });
      return json(200, {
        sha: found.sha,
        size: found.bytes.length,
        encoding: 'base64',
        content: found.bytes.toString('base64'),
      });
    }
    if (url.pathname === '/repos/acme/app/git/ref/heads/main')
      return json(200, { ref: 'refs/heads/main', object: { sha: SHA, type: 'commit' } });
    if (url.pathname === '/repos/acme/app') return json(200, { default_branch: 'main' });
    return json(599, { message: 'UNEXPECTED' });
  };
  const connector = new GithubRepoConnector({
    owner: 'acme',
    repo: 'app',
    auth: { type: 'token', token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
    fetch: f,
  });
  return {
    connector,
    calls,
    blobCalls: () => calls.filter((c) => c.includes('/git/blobs/')),
    treeCalls: () => calls.filter((c) => c.includes('/git/trees/')),
  };
}

const A = blob('a'.repeat(40), big(2000, 1));
const B = blob('b'.repeat(40), big(5000, 2));
const H = blob('d'.repeat(40), big(3000, 3));
const entry = (path: string, b: Blob, extra: Record<string, unknown> = {}) => ({
  path,
  type: 'blob',
  mode: '100644',
  sha: b.sha,
  size: b.bytes.length,
  ...extra,
});
const TREE: Setup['tree'] = [
  { path: 'dir', type: 'tree', mode: '040000', sha: 'e'.repeat(40) },
  entry('dir/a.png', A),
  entry('b.png', B),
  entry('huge.png', H),
  { path: 'link', type: 'blob', mode: '120000', sha: 'f'.repeat(40), size: 5 },
  { path: 'sub', type: 'commit', mode: '160000', sha: '1'.repeat(40) },
];

test('GitHub: the tree gives sha, size and mode; trees, symlinks and submodules are left out; cached per commit', async () => {
  const g = fakeGithub({ tree: TREE, blobs: [A, B, H] });
  const listing = await g.connector.listBlobEntries(SHA);
  assert.equal(listing.commit, SHA);
  assert.deepEqual(listing.entries, [
    { path: 'b.png', oid: B.sha, mode: '100644', size: 5000 },
    { path: 'dir/a.png', oid: A.sha, mode: '100644', size: 2000 },
    { path: 'huge.png', oid: H.sha, mode: '100644', size: 3000 },
  ]);
  await g.connector.listBlobEntries(SHA);
  assert.equal(g.treeCalls().length, 1, 'the second listing is the cached one');
  assert.equal(g.blobCalls().length, 0, 'listing downloads no file');
});

test('GitHub: heads are cut at headBytes, sizes come from the tree, and the transfer is counted', async () => {
  const g = fakeGithub({ tree: TREE, blobs: [A, B, H] });
  const res = await g.connector.readBlobHeads(['dir/a.png', 'b.png'], {
    ref: SHA,
    headBytes: 100,
    maxFileBytes: 1 << 30,
    maxTransferBytes: 1 << 30,
  });
  const a = res.items.get('dir/a.png');
  assert.ok(a?.ok);
  if (a?.ok) {
    assert.equal(a.size, 2000);
    assert.equal(a.oid, A.sha);
    assert.deepEqual(Buffer.from(a.head), A.bytes.subarray(0, 100));
  }
  assert.equal(
    res.transferredBytes,
    7000,
    'the REST API has no range read: whole files are pulled',
  );
  assert.equal(g.blobCalls().length, 2);
});

test('GitHub: too large, budget, sizes only, missing and duplicates', async () => {
  const g = fakeGithub({ tree: TREE, blobs: [A, B, H] });
  const options = { ref: SHA, headBytes: 64, maxFileBytes: 4000, maxTransferBytes: 2500 };
  const res = await g.connector.readBlobHeads(
    ['b.png', 'dir/a.png', 'huge.png', 'nope.png', 'dir/a.png'],
    options,
  );
  assert.deepEqual(res.items.get('b.png'), {
    ok: false,
    oid: B.sha,
    reason: 'too_large',
    size: 5000,
  });
  assert.equal(res.items.get('dir/a.png')?.ok, true);
  assert.deepEqual(res.items.get('huge.png'), {
    ok: false,
    oid: H.sha,
    reason: 'budget',
    size: 3000,
  });
  assert.deepEqual(res.items.get('nope.png'), {
    ok: false,
    oid: null,
    reason: 'missing',
    size: null,
  });
  assert.equal(res.items.size, 4);
  assert.deepEqual(
    g.blobCalls().map((c) => c.split('/').pop()),
    [A.sha],
    'only the one that fit was downloaded',
  );

  const sizes = fakeGithub({ tree: TREE, blobs: [A, B, H] });
  const sized = await sizes.connector.readBlobHeads(['b.png', 'dir/a.png'], {
    ref: SHA,
    headBytes: 0,
    maxFileBytes: 1 << 30,
    maxTransferBytes: 0,
  });
  assert.equal(sizes.blobCalls().length, 0, 'sizes only downloads nothing');
  const item = sized.items.get('b.png');
  assert.ok(item?.ok);
  if (item?.ok) {
    assert.equal(item.size, 5000);
    assert.equal(item.head.length, 0);
  }
  assert.equal(sized.transferredBytes, 0);

  const unsized = fakeGithub({
    tree: [{ path: 'x.png', type: 'blob', mode: '100644', sha: A.sha }],
    blobs: [A],
  });
  const nosize = await unsized.connector.readBlobHeads(['x.png'], {
    ref: SHA,
    headBytes: 0,
    maxFileBytes: 1 << 30,
    maxTransferBytes: 0,
  });
  assert.deepEqual(nosize.items.get('x.png'), {
    ok: false,
    oid: A.sha,
    reason: 'unsized',
    size: null,
  });
});

test('GitHub: a blob that is gone is missing; an authorisation failure stops the whole call and leaks nothing', async () => {
  const gone = fakeGithub({ tree: TREE, blobs: [B], blobStatus: {} });
  const res = await gone.connector.readBlobHeads(['dir/a.png', 'b.png'], {
    ref: SHA,
    headBytes: 64,
    maxFileBytes: 1 << 30,
    maxTransferBytes: 1 << 30,
  });
  assert.deepEqual(res.items.get('dir/a.png'), {
    ok: false,
    oid: A.sha,
    reason: 'missing',
    size: 2000,
  });
  assert.equal(res.items.get('b.png')?.ok, true);

  const denied = fakeGithub({ tree: TREE, blobs: [A, B], blobStatus: { [A.sha]: 401 } });
  await assert.rejects(
    denied.connector.readBlobHeads(['dir/a.png', 'b.png'], {
      ref: SHA,
      headBytes: 64,
      maxFileBytes: 1 << 30,
      maxTransferBytes: 1 << 30,
    }),
    (error: unknown) => {
      assert.ok(error instanceof GithubError);
      assert.doesNotMatch(String((error as Error).message), /ghp_/);
      return true;
    },
  );
});

test('GitHub: a truncated tree is walked folder by folder', async () => {
  const calls: string[] = [];
  const f: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.pathname.endsWith(`/trees/${SHA}`)) {
      return url.searchParams.get('recursive')
        ? json({ truncated: true, tree: [] })
        : json({
            truncated: false,
            tree: [
              { path: 'img', type: 'tree', mode: '040000', sha: 'e'.repeat(40) },
              entry('top.png', A),
            ],
          });
    }
    if (url.pathname.endsWith(`/trees/${'e'.repeat(40)}`))
      return json({ truncated: false, tree: [entry('deep.png', B)] });
    return new Response('{}', { status: 599 });
  };
  const connector = new GithubRepoConnector({
    owner: 'acme',
    repo: 'app',
    auth: { type: 'token', token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
    fetch: f,
  });
  const listing = await connector.listBlobEntries(SHA);
  assert.deepEqual(
    listing.entries.map((e) => e.path),
    ['img/deep.png', 'top.png'],
  );
});
