import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { GitCloneError } from '@mrm/connectors';
import { LocalReadError } from './services/clone-reads.ts';
import {
  checkPathText,
  countUncommitted,
  DUBIOUS_OWNERSHIP_MESSAGE,
  gitProblem,
  inspectLocalRepo,
  isInside,
  isSafeBranchName,
  parseRemoteUrl,
  validateLocalPath,
} from './services/local-git.ts';
import { translateLocalError } from './services/local-reads.ts';

const dirs: string[] = [];
const scratch = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mrm-lg-')));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const gitEnv = {
  PATH: process.env.PATH ?? '',
  HOME: tmpdir(),
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim();

function repo(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

/** root/ (allowed), outside/ (not), data/ (the server's own). */
function layout() {
  const base = scratch();
  const root = join(base, 'dev');
  const outside = join(base, 'outside');
  const data = join(base, 'data');
  for (const d of [root, outside, data]) mkdirSync(d);
  return {
    base,
    root,
    outside,
    data,
    cfg: { roots: [root], excluded: [data, join(data, 'clones')] },
  };
}

test('isInside: the folder itself and what is under it, not a sibling with the same prefix', () => {
  assert.equal(isInside('/a/b', '/a/b'), true);
  assert.equal(isInside('/a/b/c', '/a/b'), true);
  assert.equal(isInside('/a/bc', '/a/b'), false);
  assert.equal(isInside('/a', '/a/b'), false);
  assert.equal(isInside('/x', '/a/b'), false);
});

test('path text rules: NUL, control characters, relative, ~, .., length, type', () => {
  const bad: unknown[] = [
    '',
    '   ',
    'relative/x',
    '~/code',
    './x',
    '/a/../b',
    '/a\u0000b',
    '/a\nb',
    `/${'x'.repeat(4100)}`,
    42,
    null,
    undefined,
    {},
  ];
  for (const value of bad)
    assert.equal(checkPathText(value).ok, false, JSON.stringify(value)?.slice(0, 30));
  const ok = checkPathText('  /Volumes/dev/nativescript/oss-weather  ');
  assert.deepEqual(ok, { ok: true, path: '/Volumes/dev/nativescript/oss-weather' });
});

test('validateLocalPath accepts a clone inside a root and returns its real path', async () => {
  const { root, cfg } = layout();
  const dir = repo(root, 'oss-weather');
  const ok = await validateLocalPath(dir, cfg);
  assert.deepEqual(ok, { ok: true, realPath: dir, root, worktree: false });
  // A trailing slash and a nested clone are fine too.
  assert.equal((await validateLocalPath(`${dir}/`, cfg)).ok, true);
  const nested = repo(join(root, 'nativescript'), 'OSS-DocumentScanner');
  assert.equal((await validateLocalPath(nested, cfg)).ok, true);
});

test('validateLocalPath refuses a path outside every root, with a symlink resolved first', async () => {
  const { root, outside, cfg } = layout();
  const elsewhere = repo(outside, 'secret-project');
  const a = await validateLocalPath(elsewhere, cfg);
  assert.equal(a.ok, false);
  assert.equal(a.ok === false && a.code, 'outside_roots');

  // A link inside the root that leads out of it: the real path decides.
  const link = join(root, 'looks-inside');
  symlinkSync(elsewhere, link);
  const b = await validateLocalPath(link, cfg);
  assert.equal(b.ok === false && b.code, 'outside_roots');
  // A link inside the root that leads to another folder inside it is fine, and resolved.
  const inside = repo(root, 'real');
  symlinkSync(inside, join(root, 'alias'));
  const c = await validateLocalPath(join(root, 'alias'), cfg);
  assert.equal(c.ok && c.realPath, inside);
  // A folder that merely shares the root's name as a prefix is not inside it.
  const sibling = repo(join(root, '..'), 'dev-other');
  assert.equal((await validateLocalPath(sibling, cfg)).ok, false);
});

test('validateLocalPath: traversal, relative paths and NUL bytes never reach the file system', async () => {
  const { root, outside, cfg } = layout();
  repo(outside, 'p');
  for (const path of [`${root}/../outside/p`, 'dev/x', `${root}/x\u0000/../../etc`, '~/x']) {
    const result = await validateLocalPath(path, cfg);
    assert.equal(result.ok === false && result.code, 'invalid_path', path);
  }
});

test('validateLocalPath: not found, a file, not a repository, a bare repository, the root itself', async () => {
  const { root, cfg } = layout();
  const code = async (p: string) => {
    const r = await validateLocalPath(p, cfg);
    return r.ok ? 'ok' : r.code;
  };
  assert.equal(await code(join(root, 'missing')), 'not_found');
  writeFileSync(join(root, 'file.txt'), 'x');
  assert.equal(await code(join(root, 'file.txt')), 'not_directory');
  mkdirSync(join(root, 'plain'));
  assert.equal(await code(join(root, 'plain')), 'not_a_repository');
  const bare = join(root, 'server.git');
  mkdirSync(bare);
  git(bare, 'init', '-q', '--bare');
  assert.equal(await code(bare), 'bare_repository');
  assert.equal(await code(root), 'not_a_repository');
  // A `.git` that is a link, or a `.git` folder that is empty.
  const linked = join(root, 'linked');
  mkdirSync(linked);
  symlinkSync(join(root, 'plain'), join(linked, '.git'));
  assert.equal(await code(linked), 'not_a_repository');
  const empty = join(root, 'emptygit');
  mkdirSync(join(empty, '.git'), { recursive: true });
  assert.equal(await code(empty), 'not_a_repository');
});

test('validateLocalPath refuses the server’s own data and clone folders and managed clones', async () => {
  const { root, data, cfg } = layout();
  // The data folder is outside the root here; put it inside to prove the exclusion on its own.
  const inner = { roots: [root], excluded: [join(root, 'data-in-root')] };
  const dataInRoot = repo(join(root, 'data-in-root'), 'clone');
  const r = await validateLocalPath(dataInRoot, inner);
  assert.equal(r.ok === false && r.code, 'data_folder');
  const managed = repo(root, 'managed');
  writeFileSync(join(managed, 'mrm-clone.json'), '{}');
  const m = await validateLocalPath(managed, cfg);
  assert.equal(m.ok === false && m.code, 'data_folder');
  assert.ok(data);
});

test('validateLocalPath: a worktree is accepted when its git folder is inside a root, refused when not', async () => {
  const { root, outside, cfg } = layout();
  const main = repo(root, 'main-clone');
  git(main, 'worktree', 'add', '-q', '-b', 'topic', join(root, 'wt'));
  const wt = await validateLocalPath(join(root, 'wt'), cfg);
  assert.equal(wt.ok && wt.worktree, true);

  // Main clone outside the roots, worktree inside: the .git file points out, so it is refused.
  const far = repo(outside, 'far-clone');
  git(far, 'worktree', 'add', '-q', '-b', 'topic', join(root, 'wt-far'));
  const refused = await validateLocalPath(join(root, 'wt-far'), cfg);
  assert.equal(refused.ok === false && refused.code, 'outside_roots');

  // A forged .git file naming any repository on the machine.
  const forged = join(root, 'forged');
  mkdirSync(forged);
  writeFileSync(join(forged, '.git'), `gitdir: ${join(far, '.git')}\n`);
  const f = await validateLocalPath(forged, cfg);
  assert.equal(f.ok === false && f.code, 'outside_roots');
  writeFileSync(join(forged, '.git'), 'nonsense\n');
  assert.equal((await validateLocalPath(forged, cfg)).ok, false);
});

test('a root that does not exist allows nothing', async () => {
  const { root } = layout();
  const dir = repo(root, 'x');
  const r = await validateLocalPath(dir, { roots: [join(root, 'not-mounted')], excluded: [] });
  assert.equal(r.ok === false && r.code, 'outside_roots');
  const none = await validateLocalPath(dir, { roots: [], excluded: [] });
  assert.equal(none.ok === false && none.code, 'outside_roots');
});

test('branch names: refs that are safe as one git argument', () => {
  for (const ok of ['main', 'feature/x', 'release-1.2', 'a_b', 'v1.0.0', 'x'.repeat(200)])
    assert.equal(isSafeBranchName(ok), true, ok);
  for (const bad of [
    '',
    '-rf',
    '--upload-pack=x',
    'a..b',
    'a//b',
    'a/',
    'a.',
    'a.lock',
    '.hidden',
    'a/.b',
    'a b',
    'a@{1}',
    'a;b',
    'a\nb',
    'x'.repeat(201),
    '$(x)',
    42,
    null,
  ]) {
    assert.equal(isSafeBranchName(bad), false, String(bad));
  }
});

test('remote URLs: owner and repo only, credentials in the URL are never returned', () => {
  const gh = { host: 'github.com', owner: 'acme', repo: 'app', github: true };
  for (const url of [
    'https://github.com/acme/app.git',
    'https://github.com/acme/app',
    'https://github.com/acme/app/',
    'https://ada:ghp_secret@github.com/acme/app.git',
    'https://x-access-token:ghs_secret@github.com/acme/app.git',
    'git@github.com:acme/app.git',
    'ssh://git@github.com/acme/app.git',
    'ssh://git@github.com:22/acme/app.git',
    'git://github.com/acme/app.git',
    'HTTPS://GitHub.com/acme/app.git',
  ]) {
    const parsed = parseRemoteUrl(url);
    assert.deepEqual(parsed, gh, url);
    assert.equal(JSON.stringify(parsed).includes('secret'), false);
  }
  assert.deepEqual(parseRemoteUrl('git@gitlab.com:team/app.git'), {
    host: 'gitlab.com',
    owner: 'team',
    repo: 'app',
    github: false,
  });
  for (const url of [
    '',
    '/Volumes/dev/x',
    'file:///x/y',
    '../x',
    'https://github.com/acme',
    'https://github.com/a/b/c',
    'https://github.com/-bad/x',
    'https://github.com/acme/..',
  ]) {
    assert.equal(parseRemoteUrl(url), null, url);
  }
});

test('inspectLocalRepo: branch, tip, branches, origin, uncommitted count; read only', async () => {
  const { root } = layout();
  const dir = repo(root, 'p');
  git(dir, 'remote', 'add', 'origin', 'https://ada:ghp_hunter2@github.com/acme/app.git');
  git(dir, 'branch', 'feature/x');
  const head = git(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'a.txt'), 'changed\n');
  writeFileSync(join(dir, 'new.txt'), 'untracked\n');
  const before = git(dir, 'status', '--porcelain');
  const out = await inspectLocalRepo({ gitPath: 'git', realPath: dir });
  assert.ok(out.ok);
  if (!out.ok) return;
  const i = out.inspection;
  assert.equal(i.checkedOutBranch, 'main');
  assert.equal(i.branch, 'main');
  assert.deepEqual(i.branches, ['feature/x', 'main']);
  assert.equal(i.headSha, head);
  assert.equal(i.branchSha, head);
  assert.equal(i.dirtyCount, 2);
  assert.deepEqual(i.remote, { host: 'github.com', owner: 'acme', repo: 'app', github: true });
  assert.equal(JSON.stringify(i).includes('hunter2'), false);
  assert.equal(git(dir, 'status', '--porcelain'), before, 'nothing was changed');
  // An explicit branch.
  const other = await inspectLocalRepo({ gitPath: 'git', realPath: dir, branch: 'feature/x' });
  assert.equal(other.ok && other.inspection.branch, 'feature/x');
  const missing = await inspectLocalRepo({ gitPath: 'git', realPath: dir, branch: 'nope' });
  assert.equal(missing.ok === false && missing.code, 'branch_not_found');
  const evil = await inspectLocalRepo({
    gitPath: 'git',
    realPath: dir,
    branch: '--upload-pack=touch x',
  });
  assert.equal(evil.ok === false && evil.code, 'invalid_branch');
});

test('inspectLocalRepo: detached HEAD has no checked out branch; a repository without commits is refused', async () => {
  const { root } = layout();
  const dir = repo(root, 'p');
  git(dir, 'checkout', '-q', '--detach');
  const out = await inspectLocalRepo({ gitPath: 'git', realPath: dir });
  assert.ok(out.ok);
  assert.equal(out.ok && out.inspection.checkedOutBranch, null);
  assert.equal(out.ok && out.inspection.branch, null);
  const empty = join(root, 'empty');
  mkdirSync(empty);
  git(empty, 'init', '-q', '-b', 'main');
  const none = await inspectLocalRepo({ gitPath: 'git', realPath: empty });
  assert.equal(none.ok === false && none.code, 'no_commits');
});

test('nothing in the repository config can run a program: fsmonitor, hooks, filters, alternates, pager', async () => {
  const { root, base } = layout();
  const dir = repo(root, 'hostile');
  const marker = join(base, 'PWNED');
  const run = `sh -c 'echo ran >> ${marker}'`;
  writeFileSync(join(dir, '.gitattributes'), '*.txt filter=evil\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'attrs');
  for (const [key, value] of [
    ['core.fsmonitor', run],
    ['core.hooksPath', join(dir, 'hooks')],
    ['core.pager', run],
    ['core.sshCommand', run],
    ['core.alternateRefsCommand', run],
    ['core.askPass', run],
    ['credential.helper', `!${run}`],
    ['diff.external', run],
    ['filter.evil.clean', run],
    ['filter.evil.smudge', run],
    ['filter.evil.process', run],
    ['alias.status', `!${run}`],
  ] as const) {
    git(dir, 'config', key, value);
  }
  mkdirSync(join(dir, 'hooks'));
  for (const hook of ['reference-transaction', 'post-checkout', 'pre-commit']) {
    writeFileSync(join(dir, 'hooks', hook), `#!/bin/sh\necho ran >> ${marker}\n`, { mode: 0o755 });
  }
  // Make a tracked file's stat data stale, so status wants to look at its content (and its filter).
  writeFileSync(join(dir, 'a.txt'), 'edited\n');
  const ran = () => existsSync(marker);
  // Control: plain git in this folder does run something from the config.
  execFileSync('git', ['status', '--porcelain'], { cwd: dir, env: gitEnv, stdio: 'ignore' });
  assert.equal(ran(), true, 'the control did not trigger the config, so this test proves nothing');
  rmSync(marker);

  const out = await inspectLocalRepo({ gitPath: 'git', realPath: dir });
  assert.ok(out.ok, JSON.stringify(out));
  // a.txt, and the hooks folder this test made (untracked).
  assert.equal(out.ok && out.inspection.dirtyCount, 2);
  assert.equal(await countUncommitted('git', dir), 2);
  assert.equal(ran(), false, 'a program from the repository config ran');
});

test('a filter name that cannot be passed safely skips the count instead of guessing', async () => {
  const { root } = layout();
  const dir = repo(root, 'p');
  git(dir, 'config', 'filter.we ird.clean', 'cat');
  assert.equal(await countUncommitted('git', dir), null);
});

test('git failures are classified without echoing git’s text; dubious ownership explains the fix', () => {
  const dubious = gitProblem({
    code: 128,
    stdout: '',
    stderr: "fatal: detected dubious ownership in repository at '/Volumes/dev/x'\n",
  });
  assert.equal(dubious.code, 'dubious_ownership');
  assert.equal(dubious.message, DUBIOUS_OWNERSHIP_MESSAGE);
  assert.match(dubious.message, /chown/);
  assert.match(dubious.message, /safe\.directory/);
  assert.equal(dubious.message.includes('/Volumes/dev/x'), false);
  assert.equal(
    gitProblem({ code: null, stdout: '', stderr: '', failed: 'missing' }).code,
    'git_missing',
  );
  assert.equal(
    gitProblem({ code: null, stdout: '', stderr: '', failed: 'timeout' }).code,
    'git_timeout',
  );
  assert.equal(
    gitProblem({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }).code,
    'not_a_repository',
  );
  assert.equal(
    gitProblem({ code: 1, stdout: '', stderr: 'secret stuff' }).message.includes('secret'),
    false,
  );
});

test('reader errors on a local source become coded errors a person can act on', () => {
  const t = (e: unknown) => translateLocalError(e, 'main');
  const own = new LocalReadError('x', 'y');
  assert.equal(t(own), own);
  const dubious = t(
    new GitCloneError(
      'forbidden',
      'git refuses to read the local repository because another user owns it.',
    ),
  );
  assert.ok(dubious instanceof LocalReadError);
  assert.equal((dubious as LocalReadError).code, 'dubious_ownership');
  const branch = t(new GitCloneError('not_found', 'x', 'ref_missing', 404)) as LocalReadError;
  assert.equal(branch.code, 'local_branch_missing');
  assert.match(branch.message, /main/);
  assert.equal(
    (t(new GitCloneError('not_found', 'gone', undefined, 404)) as LocalReadError).code,
    'local_missing',
  );
  assert.equal(
    (t(new GitCloneError('unexpected', 'no git', 'git_missing')) as LocalReadError).code,
    'local_git_missing',
  );
  const other = new GitCloneError('network', 'timed out', 'timeout');
  assert.equal(t(other), other);
});
