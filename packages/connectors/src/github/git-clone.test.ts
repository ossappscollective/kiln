import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { GithubError, GithubRateLimitError } from '../errors.ts';
import {
  cloneSize,
  defaultWarmPaths,
  GitCloneError,
  GitCloneReader,
  type GitCloneReaderOptions,
  isCloneBusy,
  listClones,
  removeClone,
  removeWorkspaceClones,
} from './git-clone.ts';
import { GithubRepoConnector } from './github.ts';

// No network: every repository here is a throwaway one built with the git CLI in a temp folder,
// and the "GitHub" is a stub HTTP server on 127.0.0.1.

const posix = process.platform !== 'win32';
/** Tests that run shell wrappers or process groups. */
const posixTest = posix ? test : test.skip;
const roots: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'kiln-clone-'));
  roots.push(dir);
  return dir;
};
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const gitEnv = (extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? '',
  HOME: tmpdir(),
  ...IDENTITY,
  ...extra,
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync(REAL_GIT, args, { cwd, encoding: 'utf8', env: gitEnv() }).trim();
const inClone = (dir: string, ...args: string[]) =>
  execFileSync(REAL_GIT, [`--git-dir=${dir}`, ...args], {
    encoding: 'utf8',
    env: gitEnv({ GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'kiln-offline' }),
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

type Files = Record<string, string | Buffer>;

function write(dir: string, files: Files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

function commit(dir: string, files: Files, message = 'change', remove: string[] = []): string {
  write(dir, files);
  for (const path of remove) rmSync(join(dir, path), { force: true });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/** A source repository that allows partial clones and fetching blobs by id, like GitHub does. */
function makeSource(files: Files): string {
  const dir = join(scratch(), 'source');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'uploadpack.allowFilter', 'true');
  git(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  commit(dir, files, 'first');
  return dir;
}

function reader(
  source: string,
  extra: Partial<GitCloneReaderOptions> & { base?: string } = {},
): GitCloneReader {
  const { base, ...options } = extra;
  return new GitCloneReader({
    baseDir: base ?? join(scratch(), 'clones'),
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    source: { type: 'local', path: source },
    filter: 'blob:none',
    defaultBranch: 'main',
    ...options,
  });
}

function hasObject(cloneDir: string, oid: string): boolean {
  try {
    inClone(cloneDir, 'cat-file', '-e', oid);
    return true;
  } catch {
    return false;
  }
}

const rejection = async (promise: Promise<unknown>): Promise<GithubError> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof GithubError, `expected a GithubError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected a rejection');
};

/** A `gitPath` that records argv and the environment of every invocation, then runs real git. */
type Invocation = { argv: string; env: string };

function wrapper(extraShell = ''): { path: string; invocations(): Invocation[] } {
  const dir = scratch();
  const path = join(dir, 'git-wrapper.sh');
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      `f=$(mktemp '${dir}/inv.XXXXXX')`,
      'printf \'%s\\n\' "$*" > "$f.argv"',
      'env | sort > "$f.env"',
      extraShell,
      `exec '${REAL_GIT}' "$@"`,
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return {
    path,
    invocations: () =>
      readdirSync(dir)
        .filter((n) => n.endsWith('.argv'))
        .sort()
        .map((n) => ({
          argv: readFileSync(join(dir, n), 'utf8'),
          env: readFileSync(join(dir, n.replace(/\.argv$/, '.env')), 'utf8'),
        })),
  };
}

function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allFiles(full));
    else out.push(full);
  }
  return out;
}

const isFetch = (argv: string) => / fetch --quiet /.test(argv);
const fetches = <T extends { argv: string }>(calls: T[]): T[] =>
  calls.filter((c) => isFetch(c.argv));

// -----------------------------------------------------------------------------------------------
// Reading

const PROJECT: Files = {
  'package.json': '{"name":"trail","dependencies":{"expo":"~51.0.0"}}\n',
  'fastlane/Fastfile': 'default_platform(:ios)\n',
  'fastlane/metadata/en-US/name.txt': 'Trail',
  'fastlane/metadata/de-DE/name.txt': 'Weg',
  'fastlane/metadata/android/en-US/changelogs/12.txt': 'Fixes\n',
  'src/deep/er/index.ts': 'export {};\n',
  'ü/日本.txt': 'unicode path',
};

test('lists files and reads them at the default branch, nested paths included', async () => {
  const r = reader(makeSource(PROJECT));
  assert.deepEqual(await r.listFiles(), Object.keys(PROJECT).sort());
  assert.equal(await r.readFile('fastlane/metadata/de-DE/name.txt'), 'Weg');
  assert.equal(await r.readFile('src/deep/er/index.ts'), 'export {};\n');
  assert.equal(await r.readFile('ü/日本.txt'), 'unicode path');
});

test('a missing file, a folder and a missing parent are undefined', async () => {
  const r = reader(makeSource(PROJECT));
  assert.equal(await r.readFile('nope.txt'), undefined);
  assert.equal(await r.readFile('fastlane'), undefined);
  assert.equal(await r.readFile('fastlane/metadata'), undefined);
  assert.equal(await r.readFile('package.json/inside'), undefined);
});

test('reads a branch, a tag and a full commit sha', async () => {
  const source = makeSource({ 'a.txt': 'one' });
  const first = git(source, 'rev-parse', 'HEAD');
  git(source, 'tag', 'v1');
  git(source, 'tag', '-a', 'v1-annotated', '-m', 'annotated');
  git(source, 'checkout', '-q', '-b', 'release');
  commit(source, { 'a.txt': 'two', 'release-only.txt': 'r' });
  git(source, 'checkout', '-q', 'main');
  commit(source, { 'a.txt': 'three' });
  const r = reader(source);
  assert.equal(await r.readFile('a.txt'), 'three');
  assert.equal(await r.readFile('a.txt', 'release'), 'two');
  assert.equal(await r.readFile('a.txt', 'refs/heads/release'), 'two');
  assert.equal(await r.readFile('a.txt', 'v1'), 'one');
  assert.equal(await r.readFile('a.txt', 'tags/v1'), 'one');
  assert.equal(await r.readFile('a.txt', 'v1-annotated'), 'one');
  assert.equal(await r.readFile('a.txt', first), 'one');
  assert.deepEqual(await r.listFiles('release'), ['a.txt', 'release-only.txt']);
});

test('an unknown ref is a not_found error that names it', async () => {
  const r = reader(makeSource({ 'a.txt': 'x' }));
  const error = await rejection(r.listFiles('nope'));
  assert.equal(error.kind, 'not_found');
  assert.match(error.message, /no branch or tag named nope/);
  const sha = await rejection(r.listFiles('0123456789abcdef0123456789abcdef01234567'));
  assert.equal(sha.kind, 'not_found');
});

test('the default branch comes from the source when none is configured', async () => {
  const source = makeSource({ 'a.txt': 'x' });
  git(source, 'checkout', '-q', '-b', 'trunk');
  git(source, 'branch', '-q', '-D', 'main');
  const r = reader(source, { defaultBranch: undefined });
  assert.equal(await r.defaultBranch(), 'trunk');
  assert.deepEqual(await r.listFiles(), ['a.txt']);
});

test('path rules are the GitHub connector rules', async () => {
  const r = reader(makeSource({ 'a.txt': 'x' }));
  const github = new GithubRepoConnector({
    owner: 'o',
    repo: 'r',
    auth: { type: 'token', token: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    fetch: async () => {
      throw new Error('no network');
    },
  });
  const bad = [
    '',
    '/etc/passwd',
    '../x',
    'a/../b',
    'a/./b',
    'a//b',
    '.git/config',
    'sub/.GIT/config',
    'a\\b',
    'a\0b',
    './a',
    'a/',
  ];
  for (const path of bad) {
    const ours = await rejection(r.readFile(path));
    const theirs = await rejection(github.readFile(path));
    assert.equal(ours.kind, 'invalid_input', path);
    assert.equal(ours.message, theirs.message, path);
  }
});

test('file content: BOM and CRLF kept, NUL is text, invalid UTF-8 is not_text', async () => {
  const source = makeSource({
    'bom.txt': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi')]),
    'crlf.txt': 'a\r\nb\r\n',
    'empty.txt': '',
    'nul.txt': Buffer.from('a\0b'),
    'latin1.bin': Buffer.from([0x61, 0xe9, 0x62]),
    'png.bin': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]),
  });
  const r = reader(source);
  assert.equal(await r.readFile('bom.txt'), '﻿hi');
  assert.equal(await r.readFile('crlf.txt'), 'a\r\nb\r\n');
  assert.equal(await r.readFile('empty.txt'), '');
  assert.equal(await r.readFile('nul.txt'), 'a\0b');
  for (const path of ['latin1.bin', 'png.bin']) {
    const error = await rejection(r.readFile(path));
    assert.equal(error.kind, 'not_text', path);
    assert.match(error.message, /not UTF-8 text/);
  }
  // Listing a binary file is fine; only reading its text is refused.
  assert.ok((await r.listFiles()).includes('png.bin'));
});

test('a file over the limit is refused with too_large, others are unaffected', async () => {
  const source = makeSource({
    'small.txt': 'ok',
    'exact.txt': 'x'.repeat(1000),
    'big.txt': 'y'.repeat(1001),
  });
  const r = reader(source, { maxFileBytes: 1000, warmPaths: null });
  assert.equal(await r.readFile('small.txt'), 'ok');
  assert.equal((await r.readFile('exact.txt'))?.length, 1000);
  const error = await rejection(r.readFile('big.txt'));
  assert.equal(error.kind, 'too_large');
  assert.match(error.message, /big\.txt is 1001 bytes, over the 1000 byte limit/);
  assert.equal(await r.readFile('small.txt'), 'ok');
});

test('the default limit is 5 MiB', async () => {
  const source = makeSource({
    'under.txt': 'a'.repeat(5 * 1024 * 1024),
    'over.txt': 'a'.repeat(5 * 1024 * 1024 + 1),
  });
  const r = reader(source);
  assert.equal((await r.readFile('under.txt'))?.length, 5 * 1024 * 1024);
  assert.equal((await rejection(r.readFile('over.txt'))).kind, 'too_large');
});

test('a tree listing over the limit is refused, not truncated', async () => {
  const source = makeSource({ 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' });
  const error = await rejection(reader(source, { maxListBytes: 50 }).listFiles());
  assert.equal(error.kind, 'too_large');
});

// -----------------------------------------------------------------------------------------------
// Partial and shallow behaviour

test('the clone is shallow and partial: blobs arrive only when read, in one batch', async () => {
  const source = makeSource({ 'a.txt': 'one', 'b.txt': 'two', 'c.txt': 'three' });
  commit(source, { 'a.txt': 'one!' });
  commit(source, { 'a.txt': 'one!!' });
  const wrap = wrapper();
  const r = reader(source, { gitPath: wrap.path, warmPaths: null });
  await r.listFiles();
  const head = git(source, 'rev-parse', 'HEAD');
  const oid = (path: string) => git(source, 'rev-parse', `HEAD:${path}`);

  assert.ok(existsSync(join(r.dir, 'shallow')), 'a shallow clone has a shallow file');
  assert.equal(inClone(r.dir, 'rev-list', '--count', head), '1');
  assert.equal(hasObject(r.dir, oid('a.txt')), false, 'no blob came with the fetch');
  assert.equal(hasObject(r.dir, oid('b.txt')), false);
  assert.match(readFileSync(join(r.dir, 'config'), 'utf8'), /partialclonefilter = blob:none/);

  // Three reads at once are one fetch of blobs.
  const before = fetches(wrap.invocations()).filter((i) => /--stdin/.test(i.argv)).length;
  const [a, b] = await Promise.all([r.readFile('a.txt'), r.readFile('b.txt'), r.readFile('c.txt')]);
  assert.deepEqual([a, b], ['one!!', 'two']);
  const blobFetches = fetches(wrap.invocations()).filter((i) => /--stdin/.test(i.argv)).length;
  assert.equal(blobFetches - before, 1);
  assert.equal(hasObject(r.dir, oid('a.txt')), true);
});

test('the first read downloads the project files in one batch, then reads are local', async () => {
  const source = makeSource({ ...PROJECT, 'src/big.js': 'not a project file' });
  const wrap = wrapper();
  const r = reader(source, { gitPath: wrap.path });
  assert.equal(await r.readFile('package.json'), PROJECT['package.json']);
  assert.equal(fetches(wrap.invocations()).length, 2, 'one for the commit, one for the warm batch');
  for (const path of ['fastlane/Fastfile', 'fastlane/metadata/de-DE/name.txt']) {
    await r.readFile(path);
  }
  assert.equal(fetches(wrap.invocations()).length, 2, 'no more network after warm');
  assert.equal(hasObject(r.dir, git(source, 'rev-parse', 'HEAD:src/big.js')), false);
  assert.deepEqual(
    defaultWarmPaths(['package.json', 'src/a.ts', 'fastlane/metadata/en-US/name.txt']),
    ['package.json', 'fastlane/metadata/en-US/name.txt'],
  );
});

test('warm() prefetches the named paths and skips ones that do not exist', async () => {
  const source = makeSource({ 'a.txt': 'one', 'b.txt': 'two' });
  const r = reader(source, { warmPaths: null });
  await r.warm(['a.txt', 'missing.txt']);
  assert.equal(hasObject(r.dir, git(source, 'rev-parse', 'HEAD:a.txt')), true);
  assert.equal(hasObject(r.dir, git(source, 'rev-parse', 'HEAD:b.txt')), false);
  assert.equal((await rejection(r.warm(['../x']))).kind, 'invalid_input');
});

test('a clone without a filter holds every blob and reads need no second fetch', async () => {
  const source = makeSource({ 'a.txt': 'one', 'b.txt': 'two' });
  const wrap = wrapper();
  const r = reader(source, { gitPath: wrap.path, filter: null });
  assert.equal(await r.readFile('b.txt'), 'two');
  assert.equal(fetches(wrap.invocations()).filter((i) => /--stdin/.test(i.argv)).length, 0);
});

// -----------------------------------------------------------------------------------------------
// Freshness

test('reads reuse the fetched tip until the TTL passes; refresh() always fetches', async () => {
  const source = makeSource({ 'a.txt': 'v1' });
  let clock = 1_000_000;
  const r = reader(source, { ttlMs: 60_000, now: () => clock });
  assert.equal(await r.readFile('a.txt'), 'v1');
  const first = await r.resolve();
  const second = commit(source, { 'a.txt': 'v2' });

  assert.equal(await r.readFile('a.txt'), 'v1', 'inside the TTL the old tip is used');
  clock += 59_000;
  assert.equal(await r.readFile('a.txt'), 'v1');
  clock += 2_000;
  assert.equal(await r.readFile('a.txt'), 'v2', 'after the TTL the next read fetches');
  assert.equal(await r.resolve(), second);

  const third = commit(source, { 'a.txt': 'v3' });
  const refreshed = await r.refresh();
  assert.equal(refreshed.commit, third);
  assert.equal(refreshed.changed, true);
  assert.equal(refreshed.ref, 'main');
  assert.equal(await r.readFile('a.txt'), 'v3');
  assert.equal((await r.refresh()).changed, false);

  // The earlier commit is still readable by sha while its objects are in the clone.
  assert.equal(await r.readFile('a.txt', second), 'v2');
  assert.notEqual(first, second);
  assert.equal(inClone(r.dir, 'rev-list', '--count', third), '1', 'still depth 1');
});

test('a force-pushed branch is fetched too', async () => {
  const source = makeSource({ 'a.txt': 'v1' });
  const r = reader(source);
  const before = (await r.refresh()).commit;
  write(source, { 'a.txt': 'rewritten' });
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '--amend', '-m', 'rewritten');
  const result = await r.refresh();
  assert.notEqual(result.commit, before);
  assert.equal(await r.readFile('a.txt', result.commit), 'rewritten');
});

test('resolveCommit() names the commit, like the GitHub connector', async () => {
  const source = makeSource({ 'a.txt': 'v1' });
  const r = reader(source);
  const controller = new AbortController();
  assert.equal(await r.resolveCommit('main', controller.signal), git(source, 'rev-parse', 'HEAD'));
  assert.equal(await r.resolveCommit(), git(source, 'rev-parse', 'HEAD'));
  controller.abort();
  const error = await rejection(r.resolveCommit('other-branch', controller.signal));
  assert.ok(error instanceof GitCloneError);
});

test('pin() keeps one commit steady while the branch moves', async () => {
  const source = makeSource({ 'a.txt': 'v1', 'b.txt': 'b' });
  const r = reader(source);
  const pinned = await r.pin();
  commit(source, { 'a.txt': 'v2' }, 'next', ['b.txt']);
  await r.refresh();
  assert.equal(await pinned.readFile('a.txt'), 'v1');
  assert.deepEqual(await pinned.listFiles(), ['a.txt', 'b.txt']);
  assert.equal(await r.readFile('a.txt'), 'v2');
  assert.deepEqual(await r.listFiles(), ['a.txt']);
  assert.match(pinned.commit, /^[0-9a-f]{40}$/);
});

test('ttlMs: Infinity reads the local copy, even with the source gone', async () => {
  const source = makeSource({ 'a.txt': 'v1' });
  const base = join(scratch(), 'clones');
  assert.equal(await reader(source, { base }).readFile('a.txt'), 'v1');
  rmSync(source, { recursive: true, force: true });
  const offline = reader(source, { base, ttlMs: Number.POSITIVE_INFINITY });
  assert.equal(await offline.readFile('a.txt'), 'v1');
});

test('concurrent refreshes and reads on one clone do not corrupt it', async () => {
  const source = makeSource({ 'a.txt': 'v1', 'b.txt': 'b' });
  git(source, 'branch', 'other');
  const base = join(scratch(), 'clones');
  const one = reader(source, { base, ttlMs: 0 });
  const two = reader(source, { base, ttlMs: 0 }); // a second reader of the same folder
  const jobs: Promise<unknown>[] = [];
  for (let i = 0; i < 4; i++) {
    jobs.push(one.refresh(), two.refresh('other'), one.listFiles(), two.readFile('b.txt', 'other'));
    commit(source, { 'a.txt': `v${i + 2}` });
  }
  await Promise.all(jobs);
  const tip = (await one.refresh()).commit;
  assert.equal(await two.readFile('a.txt', tip), 'v5');
  inClone(one.dir, 'fsck', '--connectivity-only');
});

test('compact() prunes and the clone still reads', async () => {
  const source = makeSource({ 'a.txt': 'v1' });
  const r = reader(source);
  const sha = (await r.refresh()).commit;
  await r.readFile('a.txt', sha);
  commit(source, { 'a.txt': 'v2' });
  await r.refresh();
  await r.compact();
  assert.equal(await r.readFile('a.txt'), 'v2');
  assert.ok((await r.diskUsage()) > 0);
});

// -----------------------------------------------------------------------------------------------
// Failures: source, git, abort, timeout

test('a missing or non-git local source is not_found, and a missing git is reported', async () => {
  const base = join(scratch(), 'clones');
  const gone = await rejection(reader(join(scratch(), 'nope'), { base }).listFiles());
  assert.equal(gone.kind, 'not_found');
  const notRepo = await rejection(reader(scratch(), { base }).listFiles());
  assert.equal(notRepo.kind, 'not_found');
  const noGit = await rejection(
    reader(makeSource({ 'a.txt': 'x' }), { gitPath: join(scratch(), 'no-such-git') }).listFiles(),
  );
  assert.ok(noGit instanceof GitCloneError);
  assert.equal(noGit.reason, 'git_missing');
});

posixTest('an aborted signal cancels a git process and kills its group', async () => {
  const source = makeSource({ 'a.txt': 'x' });
  const pids = join(scratch(), 'pids');
  const slow = wrapper(
    `case "$*" in *" fetch "*) sleep 30 & echo $! > '${pids}.sleep'; echo $$ > '${pids}.sh'; wait;; esac`,
  );
  const r = reader(source, { gitPath: slow.path });

  const early = new AbortController();
  early.abort();
  const pre = await rejection(r.refresh(undefined, { signal: early.signal }));
  assert.ok(pre instanceof GitCloneError);
  assert.equal(pre.reason, 'aborted');

  const controller = new AbortController();
  const started = Date.now();
  const running = r.refresh(undefined, { signal: controller.signal });
  // Abort once the slow fetch has really started (its wrapper writes the pid file); a fixed delay was a race on a busy machine.
  const waitFor = Date.now();
  const poll = setInterval(() => {
    if (existsSync(`${pids}.sleep`) || Date.now() - waitFor > 10_000) {
      clearInterval(poll);
      controller.abort();
    }
  }, 25);
  const error = await rejection(running);
  assert.ok(error instanceof GitCloneError);
  assert.equal(error.reason, 'aborted');
  assert.ok(Date.now() - started < 15_000, 'did not wait for the 30 second sleep');

  // The shell and the sleep it started are gone: the process group was killed.
  await new Promise((done) => setTimeout(done, 300));
  for (const name of ['.sleep', '.sh']) {
    const pid = Number(readFileSync(`${pids}${name}`, 'utf8').trim());
    assert.throws(() => process.kill(pid, 0), /ESRCH/, `process ${name} still running`);
  }
});

posixTest('a git process that takes too long is killed: a timeout', async () => {
  const slow = wrapper(`case "$*" in *" fetch "*) sleep 30;; esac`);
  const r = reader(makeSource({ 'a.txt': 'x' }), { gitPath: slow.path, fetchTimeoutMs: 400 });
  const started = Date.now();
  const error = await rejection(r.refresh());
  assert.ok(error instanceof GitCloneError);
  assert.equal(error.reason, 'timeout');
  assert.equal(error.kind, 'network');
  assert.match(error.message, /timed out/);
  assert.ok(Date.now() - started < 5_000);
});

// -----------------------------------------------------------------------------------------------
// Hostile repository content

const ATTRIBUTES = '* filter=evil\n*.txt diff=evil text eol=crlf\n';

posixTest('repository content is read as data, never acted on', async () => {
  const outside = join(scratch(), 'outside.txt');
  writeFileSync(outside, 'SECRET OUTSIDE THE REPOSITORY');
  const pwned = join(scratch(), 'pwned');
  const source = makeSource({
    '.gitattributes': ATTRIBUTES,
    '.gitmodules': '[submodule "x"]\n\tpath = sub\n\turl = file:///nonexistent/never-fetched\n',
    'hooks/post-checkout': `#!/bin/sh\ntouch '${pwned}'\n`,
    '.husky/pre-commit': `#!/bin/sh\ntouch '${pwned}'\n`,
    'notes.txt': 'plain\n',
    'weird name\nwith newline.txt': 'newline in the path',
    'lfs.bin': 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123456789\n',
  });
  symlinkSync(outside, join(source, 'passwd'));
  symlinkSync('../../../../../..', join(source, 'up'));
  mkdirSync(join(source, 'dir'));
  symlinkSync('../../outside', join(source, 'dir', 'escape'));
  git(source, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},sub`);
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', 'hostile');

  const base = join(scratch(), 'clones');
  const r = reader(source, { base });
  await r.refresh();
  // Even a filter, a textconv, an fsmonitor and hooks present in the clone itself must not run.
  const config = join(r.dir, 'config');
  writeFileSync(
    config,
    `${readFileSync(config, 'utf8')}[filter "evil"]\n\tsmudge = touch '${pwned}'\n\tclean = touch '${pwned}'\n\tprocess = touch '${pwned}'\n\trequired = true\n[diff "evil"]\n\ttextconv = touch '${pwned}'\n[core]\n\tfsmonitor = touch '${pwned}'\n`,
  );
  mkdirSync(join(r.dir, 'hooks'), { recursive: true });
  for (const hook of ['reference-transaction', 'post-fetch', 'pre-auto-gc', 'post-checkout']) {
    writeFileSync(join(r.dir, 'hooks', hook), `#!/bin/sh\ntouch '${pwned}'\n`, { mode: 0o755 });
  }

  commit(source, { 'notes.txt': 'plain, edited\n' });
  await r.refresh(); // would fire reference-transaction if hooks could run
  assert.equal(await r.readFile('notes.txt'), 'plain, edited\n', 'raw bytes, no conversion');
  assert.equal(await r.readFile('.gitattributes'), ATTRIBUTES);
  assert.match((await r.readFile('.gitmodules')) ?? '', /never-fetched/);
  assert.equal(await r.readFile('weird name\nwith newline.txt'), 'newline in the path');
  assert.match((await r.readFile('lfs.bin')) ?? '', /^version https:\/\/git-lfs/, 'LFS: text');
  await r.compact();

  const files = await r.listFiles();
  for (const link of ['passwd', 'up', 'dir/escape']) {
    assert.ok(files.includes(link), `${link} is listed as a file`);
    assert.equal(await r.readFile(link), undefined, `${link} is never followed`);
  }
  assert.equal(await r.readFile('up/etc/passwd'), undefined);
  assert.equal(await r.readFile('dir/escape/outside.txt'), undefined);
  assert.ok(!files.includes('sub'), 'a submodule is not a file');
  assert.equal(await r.readFile('sub'), undefined);

  assert.equal(existsSync(pwned), false, 'nothing from the repository or the config ran');
  // Nothing was written outside the clone: the base holds only the workspace folder.
  assert.deepEqual(readdirSync(base), ['ws1']);
  assert.deepEqual(readdirSync(join(base, 'ws1')), ['repo1']);
  assert.ok(!allFiles(r.dir).some((f) => f.includes('never-fetched')));
  assert.ok(!existsSync(join(r.dir, 'sub')) && !existsSync(join(r.dir, 'modules')));
  assert.equal(readFileSync(outside, 'utf8'), 'SECRET OUTSIDE THE REPOSITORY');
});

test('a fresh clone has no hooks folder, and its config holds no credentials', async () => {
  const r = reader(makeSource({ 'a.txt': 'x' }));
  await r.refresh();
  assert.equal(existsSync(join(r.dir, 'hooks')), false);
  const config = readFileSync(join(r.dir, 'config'), 'utf8');
  assert.match(config, /hooksPath = \/dev\/null/);
  assert.match(config, /fsckObjects = true/);
  assert.ok(existsSync(join(r.dir, 'kiln-clone.json')));
});

posixTest('a tree with a .git entry is refused by the fsck of the fetch', async () => {
  const source = makeSource({ 'a.txt': 'x' });
  const blob = git(source, 'hash-object', '-w', '--stdin');
  const tree = execFileSync(REAL_GIT, ['mktree'], {
    cwd: source,
    env: gitEnv(),
    input: `100644 blob ${blob}\t.git\n`,
    encoding: 'utf8',
  }).trim();
  git(source, 'update-ref', 'refs/heads/main', git(source, 'commit-tree', tree, '-m', 'dotgit'));
  const error = await rejection(reader(source).refresh());
  assert.ok(['unexpected', 'not_found'].includes(error.kind), error.kind);
});

// -----------------------------------------------------------------------------------------------
// Authentication: a stub GitHub over http on 127.0.0.1

type Seen = { url: string; authorization?: string | undefined };
const TOKEN = 'plainsecret-9f8e7d6c5b4a39281706';
const B64 = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');

let stub: Server;
let stubPort = 0;
let other: Server;
let otherPort = 0;
let mode = '404';
const seen: Seen[] = [];
const otherSeen: Seen[] = [];
const savedEnv = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };

const listen = (server: Server) =>
  new Promise<number>((done) =>
    server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port)),
  );

before(async () => {
  process.env.NO_PROXY = '127.0.0.1,localhost';
  process.env.no_proxy = '127.0.0.1,localhost';
  other = createServer((req, res) => {
    otherSeen.push({ url: req.url ?? '', authorization: req.headers.authorization });
    res.writeHead(404).end('other');
  });
  otherPort = await listen(other);
  stub = createServer((req, res) => {
    seen.push({ url: req.url ?? '', authorization: req.headers.authorization });
    if (mode === 'redirect') {
      res.writeHead(302, { location: `http://127.0.0.1:${otherPort}${req.url}` }).end();
    } else if (mode === '401') {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="github"' }).end('Bad credentials');
    } else {
      res.writeHead(Number(mode)).end(mode === '404' ? 'Repository not found.' : 'nope');
    }
  });
  stubPort = await listen(stub);
});

after(() => {
  stub.close();
  other.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function github(extra: Partial<GitCloneReaderOptions> = {}): GitCloneReader {
  return new GitCloneReader({
    baseDir: join(scratch(), 'clones'),
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    source: { type: 'github', owner: 'acme', repo: 'app', baseUrl: `http://127.0.0.1:${stubPort}` },
    insecureHttp: true,
    defaultBranch: 'main',
    token: TOKEN,
    ...extra,
  });
}

const leaks = (text: string) => text.includes(TOKEN) || text.includes(B64);

posixTest('the token reaches the host as a scoped header, nowhere else', async () => {
  process.env.GIT_TRACE_CURL = '1';
  process.env.GIT_SSH_COMMAND = 'false';
  process.env.GIT_DIR = '/nonexistent';
  mode = '404';
  seen.length = 0;
  const wrap = wrapper();
  const r = github({ gitPath: wrap.path });
  let error: GithubError | undefined;
  try {
    await r.refresh();
  } catch (e) {
    error = e as GithubError;
  } finally {
    delete process.env.GIT_TRACE_CURL;
    delete process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_DIR;
  }
  assert.ok(error);

  // The host got the header, on the repository's URL.
  assert.ok(seen.length > 0);
  assert.equal(seen[0]?.authorization, `Basic ${B64}`);
  assert.match(seen[0]?.url ?? '', /^\/acme\/app\.git\/info\/refs/);

  const calls = wrap.invocations();
  const fetch = fetches(calls)[0];
  assert.ok(fetch);
  // It is in that one process's environment, as a config entry scoped to the host's URL...
  const key = `GIT_CONFIG_KEY_0=http.http://127.0.0.1:${stubPort}/.extraheader`;
  assert.ok(fetch.env.includes(key), 'header scoped to the host URL');
  assert.ok(fetch.env.includes(`GIT_CONFIG_VALUE_0=Authorization: Basic ${B64}`));
  assert.match(fetch.env, /GIT_ALLOW_PROTOCOL=http\n/);
  assert.match(fetch.env, /GIT_TERMINAL_PROMPT=0/);
  // ...and nowhere else: not in any argument of any git process, not in the clone, not in what
  // was thrown, and not in the environment of a process that does not talk to the host.
  for (const call of calls) {
    assert.ok(!leaks(call.argv), `argv leaked: ${call.argv}`);
    assert.ok(!/GIT_TRACE|GIT_SSH_COMMAND|GIT_DIR=\/nonexistent/.test(call.env), 'dropped');
    assert.match(call.env, /GIT_CONFIG_NOSYSTEM=1/);
    if (!isFetch(call.argv)) {
      assert.ok(!leaks(call.env), `env leaked to: ${call.argv}`);
      assert.match(call.env, /GIT_ALLOW_PROTOCOL=kiln-offline/);
    }
  }
  for (const file of allFiles(r.dir)) {
    assert.ok(!leaks(readFileSync(file, 'latin1')), `${file} holds the token`);
  }
  assert.ok(!leaks(JSON.stringify(error)) && !leaks(error.message) && !leaks(error.stack ?? ''));
  const remote = readFileSync(join(r.dir, 'config'), 'utf8');
  assert.match(remote, new RegExp(`url = http://127\\.0\\.0\\.1:${stubPort}/acme/app\\.git`));
});

test("the host's status codes map to the connector errors, without the token", async () => {
  const expect: Record<string, string> = {
    '401': 'auth',
    '403': 'forbidden',
    '404': 'not_found',
    '500': 'server',
    '503': 'server',
  };
  for (const [status, kind] of Object.entries(expect)) {
    mode = status;
    const error = await rejection(github().refresh());
    assert.equal(error.kind, kind, `${status}: ${error.message}`);
    assert.ok(!leaks(error.message), status);
  }
  mode = '429';
  const limited = await rejection(github().refresh());
  assert.ok(limited instanceof GithubRateLimitError);
  assert.equal(limited.retryAfterSeconds, 60);
});

test('a redirect is not followed, so the header cannot be sent to another host', async () => {
  mode = 'redirect';
  otherSeen.length = 0;
  const error = await rejection(github().refresh());
  assert.ok(error instanceof GitCloneError);
  assert.equal(error.reason, 'redirected');
  assert.equal(otherSeen.length, 0, 'the other host was never contacted');
});

test('a token function is called for every network operation', async () => {
  mode = '404';
  let calls = 0;
  const r = github({ token: () => `renewed-token-${++calls}-0123456789` });
  await rejection(r.refresh());
  await rejection(r.refresh());
  assert.equal(calls, 2);
});

posixTest('whatever git prints is redacted: token, base64 and header', async () => {
  const noisy = wrapper(
    `case "$*" in *" fetch "*) echo "fatal: unable to access: $GIT_CONFIG_VALUE_0 token=${TOKEN} https://user:${TOKEN}@host/x" >&2; exit 128;; esac`,
  );
  const error = await rejection(github({ gitPath: noisy.path }).refresh());
  assert.ok(!leaks(error.message), error.message);
  assert.ok(!error.message.includes('user:'), error.message);
});

test('a token with odd characters is refused before anything runs', async () => {
  const error = await rejection(github({ token: 'bad token\nwith newline' }).refresh());
  assert.equal(error.kind, 'invalid_input');
  assert.ok(!error.message.includes('bad token'));
});

posixTest('a local source gets the file protocol for its fetch only', async () => {
  const wrap = wrapper();
  const r = reader(makeSource({ 'a.txt': 'x' }), { gitPath: wrap.path, token: TOKEN });
  await r.readFile('a.txt');
  const calls = wrap.invocations();
  assert.match(fetches(calls)[0]?.env ?? '', /GIT_ALLOW_PROTOCOL=file\n/);
  for (const call of calls) {
    assert.ok(!leaks(call.env) && !leaks(call.argv));
    if (!isFetch(call.argv)) assert.match(call.env, /GIT_ALLOW_PROTOCOL=kiln-offline/);
  }
});

test('the options are validated', () => {
  const base = { baseDir: scratch(), workspaceId: 'ws1', repositoryId: 'r1' };
  const gh = (over: object) => ({
    ...base,
    source: { type: 'github' as const, owner: 'acme', repo: 'app', ...over },
  });
  const bad: [string, () => unknown][] = [
    ['path in workspace id', () => new GitCloneReader({ ...gh({}), workspaceId: '../x' })],
    ['slash in repository id', () => new GitCloneReader({ ...gh({}), repositoryId: 'a/b' })],
    ['dot id', () => new GitCloneReader({ ...gh({}), repositoryId: '..' })],
    ['empty id', () => new GitCloneReader({ ...gh({}), repositoryId: '' })],
    ['owner with slash', () => new GitCloneReader(gh({ owner: 'a/b' }))],
    ['repo dotdot', () => new GitCloneReader(gh({ repo: '..' }))],
    ['http without the flag', () => new GitCloneReader(gh({ baseUrl: 'http://ghe.example' }))],
    ['userinfo', () => new GitCloneReader(gh({ baseUrl: 'https://u:p@ghe.example' }))],
    ['filter with a space', () => new GitCloneReader({ ...gh({}), filter: 'blob:none --x' })],
    [
      'empty local path',
      () => new GitCloneReader({ ...base, source: { type: 'local', path: ' ' } }),
    ],
  ];
  for (const [name, make] of bad) {
    const invalid = (e: unknown) => e instanceof GithubError && e.kind === 'invalid_input';
    assert.throws(make, invalid, name);
  }
  assert.doesNotThrow(() => new GitCloneReader(gh({ baseUrl: 'https://ghe.example/api' })));
});

// -----------------------------------------------------------------------------------------------
// Removing

test('remove() deletes the clone, is repeatable, and leaves the reader usable', async () => {
  const source = makeSource({ 'a.txt': 'x' });
  const base = join(scratch(), 'clones');
  const keep = reader(source, { base });
  const gone = new GitCloneReader({
    baseDir: base,
    workspaceId: 'ws1',
    repositoryId: 'repo2',
    source: { type: 'local', path: source },
    defaultBranch: 'main',
  });
  await keep.refresh();
  await gone.refresh();
  assert.equal(await gone.remove(), true);
  assert.equal(existsSync(gone.dir), false);
  assert.equal(existsSync(keep.dir), true, 'a sibling clone is untouched');
  assert.equal(await gone.remove(), false);
  assert.equal(await gone.readFile('a.txt'), 'x', 'a removed clone is made again on demand');
});

posixTest('remove() cancels a fetch in flight', async () => {
  const slow = wrapper(`case "$*" in *" fetch "*) sleep 30;; esac`);
  const r = reader(makeSource({ 'a.txt': 'x' }), { gitPath: slow.path });
  const running = r.refresh();
  const outcome = running.then(
    () => undefined,
    (e: unknown) => e,
  );
  await new Promise((done) => setTimeout(done, 300));
  const started = Date.now();
  await r.remove();
  assert.ok(Date.now() - started < 5_000);
  const error = await outcome;
  assert.ok(error instanceof GitCloneError);
  assert.equal(error.reason, 'aborted');
  assert.equal(existsSync(r.dir), false);
});

posixTest('removeClone deletes only a real folder with our marker, in the base', async () => {
  const base = join(scratch(), 'clones');
  mkdirSync(join(base, 'ws1'), { recursive: true });
  const victim = scratch();
  writeFileSync(join(victim, 'precious.txt'), 'keep me');
  writeFileSync(join(victim, 'kiln-clone.json'), '{"version":1,"url":"x"}');
  const invalid = (e: unknown) => e instanceof GithubError && e.kind === 'invalid_input';
  const notManaged = (e: unknown) => e instanceof GitCloneError && e.reason === 'not_managed';

  const badIds = [
    ['..', 'x'],
    ['ws1', '..'],
    ['ws1', 'a/b'],
    ['', 'x'],
    ['ws1', '.'],
  ] as const;
  for (const [ws, id] of badIds) {
    await assert.rejects(removeClone(base, ws, id), invalid, `${ws}/${id}`);
  }
  assert.equal(await removeClone(base, 'ws1', 'missing'), false);
  assert.equal(await removeClone(join(base, 'nope'), 'ws1', 'x'), false);

  // A symlink in the clone's place that points outside, even to a folder with our marker.
  symlinkSync(victim, join(base, 'ws1', 'link'));
  await assert.rejects(removeClone(base, 'ws1', 'link'), notManaged);
  // A workspace folder that is a symlink to elsewhere.
  symlinkSync(victim, join(base, 'wslink'));
  mkdirSync(join(victim, 'inner'));
  writeFileSync(join(victim, 'inner', 'kiln-clone.json'), '{"version":1,"url":"x"}');
  await assert.rejects(removeClone(base, 'wslink', 'inner'), notManaged);
  // A real folder without our marker.
  mkdirSync(join(base, 'ws1', 'foreign'));
  writeFileSync(join(base, 'ws1', 'foreign', 'data.txt'), 'not ours');
  await assert.rejects(removeClone(base, 'ws1', 'foreign'), notManaged);

  assert.equal(readFileSync(join(victim, 'precious.txt'), 'utf8'), 'keep me');
  assert.ok(existsSync(join(victim, 'inner', 'kiln-clone.json')));
  assert.equal(readFileSync(join(base, 'ws1', 'foreign', 'data.txt'), 'utf8'), 'not ours');
});

test('a reader refuses to use or delete a folder that is not a managed clone', async () => {
  const r = reader(makeSource({ 'a.txt': 'x' }));
  mkdirSync(r.dir, { recursive: true });
  writeFileSync(join(r.dir, 'someone-elses.txt'), 'data');
  const error = await rejection(r.refresh());
  assert.ok(error instanceof GitCloneError);
  assert.equal(error.reason, 'not_managed');
  await assert.rejects(r.remove(), (e: unknown) => e instanceof GitCloneError);
  assert.equal(readFileSync(join(r.dir, 'someone-elses.txt'), 'utf8'), 'data');
});

test('a damaged clone, or one for another source, is rebuilt', async () => {
  const source = makeSource({ 'a.txt': 'x' });
  const other = makeSource({ 'b.txt': 'y' });
  const base = join(scratch(), 'clones');
  const first = reader(source, { base });
  await first.refresh();
  rmSync(join(first.dir, 'objects'), { recursive: true, force: true });
  assert.deepEqual(await reader(source, { base }).listFiles(), ['a.txt']);
  // Same folder, different source: the old objects are not mixed in.
  assert.deepEqual(await reader(other, { base }).listFiles(), ['b.txt']);
});

test('removeWorkspaceClones removes every clone of one workspace only', async () => {
  const source = makeSource({ 'a.txt': 'x' });
  const base = join(scratch(), 'clones');
  const make = (workspaceId: string, repositoryId: string) =>
    new GitCloneReader({
      baseDir: base,
      workspaceId,
      repositoryId,
      source: { type: 'local', path: source },
      defaultBranch: 'main',
    });
  await Promise.all([
    make('w1', 'a').refresh(),
    make('w1', 'b').refresh(),
    make('w2', 'c').refresh(),
  ]);
  assert.equal(await removeWorkspaceClones(base, 'w1'), 2);
  assert.deepEqual(readdirSync(base), ['w2']);
  assert.ok(statSync(join(base, 'w2', 'c')).isDirectory());
});

// -----------------------------------------------------------------------------------------------
// Upkeep: sizes, the list of clones, last use, one refresh for simultaneous callers

test('cloneSize adds up the files, does not follow links and stops at its cap', async () => {
  const dir = scratch();
  mkdirSync(join(dir, 'a', 'b'), { recursive: true });
  writeFileSync(join(dir, 'one'), 'x'.repeat(100));
  writeFileSync(join(dir, 'a', 'two'), 'y'.repeat(50));
  writeFileSync(join(dir, 'a', 'b', 'three'), 'z'.repeat(25));
  const outside = scratch();
  writeFileSync(join(outside, 'big'), 'q'.repeat(100_000));
  symlinkSync(outside, join(dir, 'link'));
  const size = await cloneSize(dir);
  assert.equal(size.truncated, false);
  assert.ok(size.bytes >= 175 && size.bytes < 5_000, `link not followed: ${size.bytes}`);
  const capped = await cloneSize(dir, 2);
  assert.equal(capped.truncated, true);
  assert.deepEqual(await cloneSize(join(dir, 'missing')), {
    bytes: 0,
    entries: 0,
    truncated: false,
  });
});

test('listClones lists managed clones with size and last use, and refuses links and strangers', async () => {
  const source = makeSource({ 'a.txt': 'x' });
  const base = join(scratch(), 'clones');
  const make = (workspaceId: string, repositoryId: string) =>
    new GitCloneReader({
      baseDir: base,
      workspaceId,
      repositoryId,
      source: { type: 'local', path: source },
      defaultBranch: 'main',
    });
  await Promise.all([
    make('w1', 'a').refresh(),
    make('w1', 'b-local').refresh(),
    make('w2', 'c').refresh(),
  ]);

  // Things that are not clones: a folder without our marker, a link to a real clone, a link to a folder outside.
  mkdirSync(join(base, 'w1', 'stranger'));
  writeFileSync(join(base, 'w1', 'stranger', 'file'), 'not ours');
  if (posix) {
    symlinkSync(join(base, 'w2', 'c'), join(base, 'w1', 'linked'));
    const outside = scratch();
    writeFileSync(join(outside, 'kiln-clone.json'), '{"version":1,"url":"x","createdAt":1}');
    symlinkSync(outside, join(base, 'w1', 'escape'));
    symlinkSync(outside, join(base, 'w3'));
  }

  const all = await listClones(base);
  assert.deepEqual(all.clones.map((c) => `${c.workspaceId}/${c.cloneId}`).sort(), [
    'w1/a',
    'w1/b-local',
    'w2/c',
  ]);
  assert.equal(all.refused, posix ? 4 : 1);
  for (const clone of all.clones) {
    assert.ok(clone.bytes > 0);
    assert.equal(clone.truncated, false);
    assert.ok(clone.createdAt > 0);
    assert.ok(Math.abs(clone.lastUsedAt - Date.now()) < 60_000);
  }
  assert.deepEqual(
    (await listClones(base, { workspaceId: 'w2' })).clones.map((c) => c.cloneId),
    ['c'],
  );
  assert.deepEqual((await listClones(join(base, 'nope'))).clones, []);
  await assert.rejects(() => listClones(base, { workspaceId: '../etc' }), GithubError);
  // The stranger and the outside folder are untouched.
  assert.equal(readFileSync(join(base, 'w1', 'stranger', 'file'), 'utf8'), 'not ours');
});

test('reading touches the clone: its last use moves, at most every 30 seconds', async () => {
  const source = makeSource({ 'a.txt': 'x' });
  const base = join(scratch(), 'clones');
  const r = reader(source, { base });
  await r.listFiles();
  const marker = join(r.dir, 'kiln-clone.json');
  const old = new Date(Date.now() - 3 * 24 * 3600_000);
  utimesSync(marker, old, old);
  // Within the throttle window of the first read: not touched again.
  await r.readFile('a.txt');
  await new Promise((done) => setTimeout(done, 50));
  assert.ok(statSync(marker).mtimeMs < Date.now() - 24 * 3600_000, 'throttled');
  // A new reader (a new process, in effect) touches at its first use.
  const next = reader(source, { base });
  await next.readFile('a.txt');
  await new Promise((done) => setTimeout(done, 50));
  assert.ok(Math.abs(statSync(marker).mtimeMs - Date.now()) < 60_000, 'touched');
  const [listed] = (await listClones(base)).clones;
  assert.ok(listed && Math.abs(listed.lastUsedAt - Date.now()) < 60_000);
});

posixTest('isCloneBusy is true while git runs for the clone, and false after', async () => {
  const slow = wrapper(`case "$*" in *" fetch "*) sleep 1;; esac`);
  const base = join(scratch(), 'clones');
  const r = reader(makeSource({ 'a.txt': 'x' }), { base, gitPath: slow.path });
  assert.equal(isCloneBusy(base, 'ws1', 'repo1'), false);
  const running = r.refresh();
  await new Promise((done) => setTimeout(done, 200));
  assert.equal(isCloneBusy(base, 'ws1', 'repo1'), true);
  assert.equal(isCloneBusy(base, 'ws1', 'other'), false);
  await running;
  assert.equal(isCloneBusy(base, 'ws1', 'repo1'), false);
});

posixTest('simultaneous refreshes of one ref share one fetch', async () => {
  const slow = wrapper(`case "$*" in *" fetch "*) sleep 1;; esac`);
  const source = makeSource({ 'a.txt': 'x' });
  const r = reader(source, { gitPath: slow.path, warmPaths: null });
  const results = await Promise.all([r.refresh(), r.refresh(), r.refresh('main'), r.refresh()]);
  assert.equal(fetches(slow.invocations()).length, 1, 'one fetch for four callers');
  assert.equal(new Set(results.map((x) => x.commit)).size, 1);
  // The next one, after it finished, fetches again: a person asked for the newest.
  commit(source, { 'a.txt': 'y' });
  const later = await r.refresh();
  assert.equal(fetches(slow.invocations()).length, 2);
  assert.notEqual(later.commit, results[0]?.commit);
});

posixTest(
  'a caller that gives up does not cancel the fetch the others wait for; the last one does',
  async () => {
    const slow = wrapper(`case "$*" in *" fetch "*) sleep 1;; esac`);
    const r = reader(makeSource({ 'a.txt': 'x' }), { gitPath: slow.path, warmPaths: null });
    const first = new AbortController();
    const second = new AbortController();
    const a = r.refresh('main', { signal: first.signal });
    const b = r.refresh('main', { signal: second.signal });
    const c = r.refresh('main');
    const lost = a.then(
      () => 'done',
      (e: unknown) => (e as GitCloneError).reason,
    );
    await new Promise((done) => setTimeout(done, 200));
    first.abort();
    assert.equal(await lost, 'aborted');
    assert.equal((await b).ref, 'main');
    assert.equal((await c).ref, 'main');
    assert.equal(fetches(slow.invocations()).length, 1);

    // Alone, an abort stops the git process, as it did before.
    const stuck = wrapper(`case "$*" in *" fetch "*) sleep 30;; esac`);
    const lone = reader(makeSource({ 'a.txt': 'x' }), { gitPath: stuck.path, warmPaths: null });
    const stop = new AbortController();
    const outcome = lone.refresh('main', { signal: stop.signal }).then(
      () => undefined,
      (e: unknown) => e,
    );
    await new Promise((done) => setTimeout(done, 300));
    const started = Date.now();
    stop.abort();
    const error = await outcome;
    assert.ok(error instanceof GitCloneError && error.reason === 'aborted');
    // The process was killed: the lock is free again quickly.
    await Promise.race([lone.remove(), new Promise((done) => setTimeout(done, 5000))]);
    assert.ok(Date.now() - started < 6_000);
  },
);
