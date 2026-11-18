import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  BRANCH,
  buildRepo,
  FASTLANE,
  git,
  REAL_GIT,
  scratch,
  setup,
  SUBTITLE,
  snapshot,
  withPrivateTmp,
} from './local-git-test-helpers.ts';
import {
  checkNewBranchName,
  cleanIdentity,
  createBranchCommit,
  type FileEdit,
} from './services/local-git.ts';

/**
 * Writing a commit on a new branch of a local clone (ADR 0005). Real git repositories made with
 * the git CLI in temp folders. The push is in local-git-push.test.ts.
 */

type Setup = ReturnType<typeof setup>;
const gitEnv = {
  PATH: process.env.PATH ?? '',
  HOME: tmpdir(),
  GIT_AUTHOR_NAME: 'Dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'Dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

const commitInput = (s: Setup, over: Partial<Parameters<typeof createBranchCommit>[0]> = {}) => ({
  gitPath: s.wrapper.path,
  path: s.dir,
  roots: s.roots,
  baseBranch: 'main',
  branch: BRANCH,
  files: [SUBTITLE],
  message: 'Update the subtitle\n\nChanged files (1):\n- fastlane/metadata/en-US/subtitle.txt (modified)',
  author: { name: 'Ada Lovelace', email: 'ada@example.com' },
  now: NOW,
  ...over,
});

const treeOf = (dir: string, rev: string): Record<string, string> =>
  Object.fromEntries(
    git(dir, 'ls-tree', '-r', rev)
      .split('\n')
      .map((line) => {
        const [meta = '', path = ''] = line.split('\t');
        return [path, meta.split(' ')[2] ?? ''];
      }),
  );

// ---------------------------------------------------------------------------------------------
// The commit

test('the commit is the base tree plus the changes, on a new branch whose parent is the base', async () => {
  const s = setup();
  const base = git(s.dir, 'rev-parse', 'main');
  const files: FileEdit[] = [
    SUBTITLE,
    { path: 'fastlane/metadata/fr-FR/name.txt', after: 'Appli Acme\n' },
    { path: 'fastlane/metadata/de-DE/subtitle.txt', before: 'Alter Untertitel\n' },
  ];
  const done = await createBranchCommit(commitInput(s, { files }));
  assert.equal(done.ok, true, JSON.stringify(done));
  if (!done.ok) return;
  assert.equal(done.base, base);
  assert.equal(done.changed, 3);
  assert.equal(git(s.dir, 'rev-parse', `refs/heads/${BRANCH}`), done.commit);
  assert.equal(git(s.dir, 'rev-parse', `${done.commit}^`), base);
  assert.equal(git(s.dir, 'rev-parse', `${done.commit}^{tree}`), done.tree);

  const before = treeOf(s.dir, base);
  const after = treeOf(s.dir, done.commit);
  const changedPaths = Object.keys({ ...before, ...after }).filter((p) => before[p] !== after[p]).sort();
  assert.deepEqual(changedPaths, [
    'fastlane/metadata/de-DE/subtitle.txt',
    'fastlane/metadata/en-US/subtitle.txt',
    'fastlane/metadata/fr-FR/name.txt',
  ]);
  assert.equal(after['fastlane/metadata/de-DE/subtitle.txt'], undefined, 'deleted');
  assert.equal(git(s.dir, 'show', `${done.commit}:fastlane/metadata/en-US/subtitle.txt`), 'New subtitle');
  assert.equal(git(s.dir, 'show', `${done.commit}:fastlane/metadata/fr-FR/name.txt`), 'Appli Acme');
  assert.equal(git(s.dir, 'show', `${done.commit}:README.md`), 'hello');

  const seconds = NOW / 1000;
  assert.equal(
    git(s.dir, 'log', '-1', '--format=%an|%ae|%cn|%ce|%at|%ct', done.commit),
    `Ada Lovelace|ada@example.com|Ada Lovelace|ada@example.com|${seconds}|${seconds}`,
  );
  assert.equal(git(s.dir, 'log', '-1', '--format=%s', done.commit), 'Update the subtitle');
  assert.match(git(s.dir, 'log', '-1', '--format=%b', done.commit), /Changed files \(1\)/);
  assert.equal(git(s.dir, 'cat-file', '-p', done.commit).includes('gpgsig'), false, 'not signed');
  git(s.dir, 'fsck', '--strict');
});

test('a file mode is kept and a new file is a regular file', async () => {
  const s = setup();
  writeFileSync(join(s.dir, 'run.sh'), 'echo 1\n');
  chmodSync(join(s.dir, 'run.sh'), 0o755);
  git(s.dir, 'add', 'run.sh');
  git(s.dir, 'commit', '-q', '-m', 'script');
  const done = await createBranchCommit(
    commitInput(s, { files: [{ path: 'run.sh', before: 'echo 1\n', after: 'echo 2\n' }, { path: 'new.txt', after: 'x\n' }] }),
  );
  assert.equal(done.ok, true);
  if (!done.ok) return;
  assert.match(git(s.dir, 'ls-tree', done.commit, 'run.sh', 'new.txt'), /^100644 blob \w+\tnew\.txt\n100755 blob \w+\trun\.sh$/);
});

test('the working tree, index, HEAD, config and current branch are untouched, in a dirty clone on another branch', async () => {
  const s = setup();
  git(s.dir, 'switch', '-q', '-c', 'feature');
  writeFileSync(join(s.dir, 'README.md'), 'edited, not staged\n');
  writeFileSync(join(s.dir, 'fastlane/Fastfile'), 'staged\n');
  git(s.dir, 'add', 'fastlane/Fastfile');
  writeFileSync(join(s.dir, 'untracked.txt'), 'x\n');
  const before = snapshot(s.dir);
  const done = await createBranchCommit(commitInput(s, { baseBranch: 'main' }));
  assert.equal(done.ok, true, JSON.stringify(done));
  const after = snapshot(s.dir);
  const { refs: refsBefore, ...restBefore } = before;
  const { refs: refsAfter, ...restAfter } = after;
  assert.deepEqual(restAfter, restBefore, 'status, HEAD, index, config, hooks and every file are byte-identical');
  assert.equal(git(s.dir, 'symbolic-ref', '--short', 'HEAD'), 'feature');
  const was = refsBefore.split('\n');
  const now = refsAfter.split('\n');
  assert.deepEqual(now.filter((line) => !was.includes(line)).map((l) => l.split(' ')[0]), [`refs/heads/${BRANCH}`]);
  assert.equal(was.every((line) => now.includes(line)), true, 'no ref moved');
});

test('git only gets plumbing that creates objects and one branch: a spy on every call', async () => {
  const s = setup();
  const { done, left } = await withPrivateTmp(async (tmp) => {
    const result = await createBranchCommit(commitInput(s));
    return { done: result, left: readdirSync(tmp) };
  });
  assert.equal(done.ok, true);
  const calls = s.wrapper.calls();
  const subcommand = (args: string) => {
    const words = args.split(' ');
    let i = 0;
    while (i < words.length && (words[i] === '--no-pager' || words[i] === '-c')) i += words[i] === '-c' ? 2 : 1;
    return words[i] ?? '';
  };
  const seen = new Set(calls.map((c) => subcommand(c.args)));
  const allowed = new Set(['rev-parse', 'ls-tree', 'cat-file', 'hash-object', 'read-tree', 'update-index', 'write-tree', 'commit-tree', 'update-ref']);
  for (const name of seen) assert.ok(allowed.has(name), `unexpected git command: ${name}`);
  for (const forbidden of ['checkout', 'switch', 'reset', 'add', 'commit', 'merge', 'stash', 'clean', 'push', 'restore', 'rm', 'apply', 'rebase', 'branch', 'tag', 'gc', 'config', 'status']) {
    assert.equal(seen.has(forbidden), false, `${forbidden} must never run`);
  }
  const refWrites = calls.filter((c) => /^(update-ref|symbolic-ref|branch|tag)$/.test(subcommand(c.args)));
  assert.equal(refWrites.length, 1);
  assert.match(
    refWrites[0]?.args ?? '',
    new RegExp(`update-ref -m mrm: commit change set refs/heads/${BRANCH} [0-9a-f]{40} 0{40}$`),
    'create only: the old value is the zero id',
  );
  for (const call of calls) {
    if (call.index) {
      assert.match(basename(dirname(call.index)), /^mrm-index-/, `index ${call.index}`);
      assert.equal(call.index.startsWith(s.dir), false);
    }
    assert.match(call.args, /core\.hooksPath=\/dev\/null/);
    assert.match(call.args, /commit\.gpgSign=false/);
    assert.equal(call.args.includes('safe.directory'), false);
  }
  assert.equal(calls.every((c) => c.cwd === s.dir), true, 'git only ran in the clone');
  assert.deepEqual(left, [], 'the temporary index folder is removed');
});

test('no hook fires: pre-commit, post-commit, commit-msg, reference-transaction, post-checkout, pre-push', async () => {
  const s = setup();
  const marker = join(s.base, 'hook-ran');
  const hooksDir = join(s.dir, '.git', 'hooks');
  const elsewhere = join(s.base, 'other-hooks');
  mkdirSync(elsewhere);
  for (const name of ['pre-commit', 'post-commit', 'commit-msg', 'reference-transaction', 'post-checkout', 'pre-push', 'post-index-change', 'prepare-commit-msg', 'post-rewrite']) {
    for (const dir of [hooksDir, elsewhere]) {
      writeFileSync(join(dir, name), `#!/bin/sh\necho ${name} >> '${marker}'\n`);
      chmodSync(join(dir, name), 0o755);
    }
  }
  git(s.dir, 'update-ref', 'refs/heads/control', 'HEAD');
  assert.equal(existsSync(marker), true, 'control: reference-transaction runs under plain git');
  rmSync(marker);
  git(s.dir, 'config', 'core.hooksPath', elsewhere);
  const done = await createBranchCommit(commitInput(s));
  assert.equal(done.ok, true);
  assert.equal(existsSync(marker), false, 'no hook ran');
});

test('a hostile repository config runs nothing and cannot sign: fsmonitor, filters, aliases, gpg, editor, pager', async () => {
  const s = setup();
  const marker = join(s.base, 'pwned');
  const touch = `touch '${marker}'`;
  writeFileSync(join(s.dir, '.gitattributes'), '* filter=evil\n*.txt diff=evil\n');
  git(s.dir, 'add', '.gitattributes');
  git(s.dir, 'commit', '-q', '-m', 'attrs');
  writeFileSync(join(s.base, 'gpg'), `#!/bin/sh\n${touch}\nexit 1\n`);
  chmodSync(join(s.base, 'gpg'), 0o755);
  const config: [string, string][] = [
    ['core.fsmonitor', touch],
    ['filter.evil.clean', touch],
    ['filter.evil.smudge', touch],
    ['filter.evil.process', touch],
    ['filter.evil.required', 'true'],
    ['diff.external', touch],
    ['diff.evil.textconv', touch],
    ['core.pager', touch],
    ['core.editor', touch],
    ['core.sshCommand', touch],
    ['core.askPass', touch],
    ['core.alternateRefsCommand', touch],
    ['credential.helper', `!${touch}`],
    ['gpg.program', join(s.base, 'gpg')],
    ['commit.gpgsign', 'true'],
    ['alias.update-ref', `!${touch}`],
    ['alias.commit-tree', `!${touch}`],
    ['alias.write-tree', `!${touch}`],
    ['core.splitIndex', 'true'],
    ['core.sparseCheckout', 'true'],
    ['core.autocrlf', 'true'],
    ['core.safecrlf', 'true'],
  ];
  for (const [key, value] of config) git(s.dir, 'config', key, value);
  const before = git(s.dir, 'rev-parse', 'HEAD');
  const crlf: FileEdit = { path: SUBTITLE.path, before: 'Old subtitle\n', after: 'New subtitle\r\n' };
  const done = await createBranchCommit(commitInput(s, { files: [crlf] }));
  assert.equal(done.ok, true, JSON.stringify(done));
  if (!done.ok) return;
  assert.equal(existsSync(marker), false, 'nothing from the config ran');
  assert.equal(git(s.dir, 'rev-parse', 'HEAD'), before);
  assert.equal(git(s.dir, 'cat-file', '-p', done.commit).includes('gpgsig'), false);
  const stored = execFileSync(REAL_GIT, ['cat-file', 'blob', `${done.commit}:${SUBTITLE.path}`], { cwd: s.dir, env: gitEnv }).toString();
  assert.equal(stored, 'New subtitle\r\n', 'stored exactly as given: no filter, no line-ending conversion');
  assert.equal(readdirSync(join(s.dir, '.git')).some((n) => n.startsWith('sharedindex')), false);
});

test('an existing branch is never moved: branch_exists, also when it only conflicts with an existing name', async () => {
  const s = setup();
  git(s.dir, 'branch', 'taken');
  const tip = git(s.dir, 'rev-parse', 'taken');
  const exists = await createBranchCommit(commitInput(s, { branch: 'taken' }));
  assert.equal(exists.ok === false && exists.code, 'branch_exists');
  assert.equal(git(s.dir, 'rev-parse', 'taken'), tip);
  const asFolder = await createBranchCommit(commitInput(s, { branch: 'taken/sub' }));
  assert.equal(asFolder.ok === false && asFolder.code, 'branch_exists');
  git(s.dir, 'branch', 'mrm/deep/er');
  const asFile = await createBranchCommit(commitInput(s, { branch: 'mrm/deep' }));
  assert.equal(asFile.ok === false && asFile.code, 'branch_exists');
  assert.deepEqual(git(s.dir, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n'), [
    'refs/heads/main',
    'refs/heads/mrm/deep/er',
    'refs/heads/taken',
  ]);
});

test('branch names: a table of what is refused and what is accepted', () => {
  const refused: [string, RegExp][] = [
    ['', /Enter/],
    ['-x', /start with/],
    ['--upload-pack=x', /start with/],
    ['a..b', /\.\./],
    ['a@{b', /@\{/],
    ['HEAD', /reserved/],
    ['@', /reserved/],
    ['refs/heads/x', /reserved/],
    ['a b', /letters/],
    ['a~b', /letters/],
    ['a^b', /letters/],
    ['a:b', /letters/],
    ['a?b', /letters/],
    ['a*b', /letters/],
    ['a[b', /letters/],
    ['a\\b', /letters/],
    ['a//b', /letters/],
    ['a/', /letters/],
    ['a.', /letters/],
    ['.hidden', /letters/],
    ['a/.hidden', /letters/],
    ['x.lock', /\.lock/],
    ['x.lock/y', /\.lock/],
    ['a\nb', /control/],
    ['a\u0000b', /control/],
    ['a\u007fb', /control/],
    ['ünï', /letters/],
    ['x'.repeat(201), /longer/],
  ];
  for (const [name, why] of refused) {
    const result = checkNewBranchName(name);
    assert.equal(result.ok, false, JSON.stringify(name));
    if (!result.ok) assert.match(result.message, why, JSON.stringify(name));
  }
  for (const name of ['mrm/update-subtitle-1234abcd', 'feature/x', 'a', '_x', 'v1.2.3', 'x'.repeat(200)]) {
    assert.deepEqual(checkNewBranchName(name), { ok: true, name }, name);
  }
  assert.equal(checkNewBranchName(undefined).ok, false);
});

test('git itself agrees that every accepted name is a valid branch', () => {
  const s = setup();
  for (const name of ['mrm/update-subtitle-1234abcd', 'feature/x', 'v1.2.3', 'a_b-c/d.e']) {
    assert.equal(checkNewBranchName(name).ok, true);
    git(s.dir, 'check-ref-format', `refs/heads/${name}`);
  }
});

test('a name that is refused never reaches git', async () => {
  const s = setup();
  const done = await createBranchCommit(commitInput(s, { branch: '--force' }));
  assert.equal(done.ok === false && done.code, 'invalid_branch');
  assert.equal(s.wrapper.calls().length, 0);
});

// ---------------------------------------------------------------------------------------------
// The base

test('base_changed: a file that is not what the change set was made from is listed, nothing is written', async () => {
  const s = setup();
  writeFileSync(join(s.dir, 'fastlane/metadata/en-US/subtitle.txt'), 'Someone else edited this\n');
  git(s.dir, 'commit', '-q', '-am', 'edit');
  const refs = git(s.dir, 'for-each-ref');
  const german: FileEdit = { path: 'fastlane/metadata/de-DE/subtitle.txt', before: 'Alter Untertitel\n', after: 'Neuer Untertitel\n' };
  const done = await createBranchCommit(commitInput(s, { files: [SUBTITLE, german] }));
  assert.equal(done.ok, false);
  if (done.ok) return;
  assert.equal(done.code, 'base_changed');
  assert.deepEqual(done.paths, ['fastlane/metadata/en-US/subtitle.txt']);
  assert.equal(git(s.dir, 'for-each-ref'), refs);
  assert.equal(s.wrapper.calls().some((c) => /commit-tree|update-ref/.test(c.args)), false);
});

test('base_changed also for a new file that now exists, and for a deleted file whose text changed', async () => {
  const s = setup();
  const done = await createBranchCommit(
    commitInput(s, {
      files: [
        { path: 'README.md', after: 'new text\n' },
        { path: 'fastlane/metadata/en-US/name.txt', before: 'Something else\n' },
      ],
    }),
  );
  assert.equal(done.ok === false && done.code, 'base_changed');
  assert.deepEqual(done.ok === false && done.paths, ['README.md', 'fastlane/metadata/en-US/name.txt']);
});

test('the base is the committed tip of the chosen branch: uncommitted edits are neither read nor lost', async () => {
  const s = setup();
  writeFileSync(join(s.dir, SUBTITLE.path), 'uncommitted edit\n');
  const done = await createBranchCommit(commitInput(s));
  assert.equal(done.ok, true);
  assert.equal(readFileSync(join(s.dir, SUBTITLE.path), 'utf8'), 'uncommitted edit\n');
});

test('a change that is already in the branch is skipped; when nothing is left it is no_changes', async () => {
  const s = setup();
  const partly = await createBranchCommit(
    commitInput(s, { files: [{ path: 'README.md', before: 'x\n', after: 'hello\n' }, SUBTITLE], branch: 'one' }),
  );
  assert.equal(partly.ok, true);
  if (partly.ok) assert.equal(partly.skipped, 1);
  const none = await createBranchCommit(
    commitInput(s, { files: [{ path: 'README.md', before: 'x\n', after: 'hello\n' }, { path: 'gone.txt', before: 'x\n' }], branch: 'two' }),
  );
  assert.equal(none.ok === false && none.code, 'no_changes');
  assert.equal(git(s.dir, 'for-each-ref', '--format=%(refname)', 'refs/heads/two'), '');
});

test('a symbolic link, a folder in the way and bad paths are refused before anything is written', async () => {
  const s = setup();
  execFileSync('ln', ['-s', 'README.md', join(s.dir, 'link.txt')]);
  git(s.dir, 'add', 'link.txt');
  git(s.dir, 'commit', '-q', '-m', 'link');
  const refs = git(s.dir, 'for-each-ref');
  const link = await createBranchCommit(commitInput(s, { files: [{ path: 'link.txt', before: 'README.md', after: 'x\n' }] }));
  assert.equal(link.ok === false && link.code, 'unsupported_entry');
  const folder = await createBranchCommit(commitInput(s, { files: [{ path: 'fastlane', after: 'x\n' }] }));
  assert.equal(folder.ok === false && folder.code, 'path_conflict');
  const under = await createBranchCommit(commitInput(s, { files: [{ path: 'README.md/x.txt', after: 'x\n' }] }));
  assert.equal(under.ok === false && under.code, 'path_conflict');
  for (const path of ['../x', '/abs', 'a//b', '.git/config', 'a/.GIT/x', 'a\\b', '']) {
    const bad = await createBranchCommit(commitInput(s, { files: [{ path, after: 'x\n' }] }));
    assert.equal(bad.ok === false && bad.code, 'invalid_file_path', JSON.stringify(path));
  }
  assert.equal(git(s.dir, 'for-each-ref'), refs);
});

test('the folder is validated again immediately before writing: outside the roots, missing, or a branch that is gone', async () => {
  const s = setup();
  const outside = buildRepo(scratch(), 'elsewhere', FASTLANE);
  const out = await createBranchCommit(commitInput(s, { path: outside }));
  assert.equal(out.ok === false && out.code, 'outside_roots');
  const gone = await createBranchCommit(commitInput(s, { path: join(s.root, 'missing') }));
  assert.equal(gone.ok === false && gone.code, 'not_found');
  const noBranch = await createBranchCommit(commitInput(s, { baseBranch: 'nope' }));
  assert.equal(noBranch.ok === false && noBranch.code, 'branch_not_found');
  assert.equal(s.wrapper.calls().some((c) => /update-ref/.test(c.args)), false);
});

test('a deadline in the past stops before the branch is made', async () => {
  const s = setup();
  const done = await createBranchCommit(commitInput(s, { deadline: Date.now() - 1 }));
  assert.equal(done.ok === false && done.code, 'timeout');
  assert.equal(git(s.dir, 'for-each-ref', '--format=%(refname)', 'refs/heads'), 'refs/heads/main');
});

test('the author is cleaned: no angle brackets or line breaks, a fallback for a bad email', () => {
  assert.deepEqual(cleanIdentity({ name: 'Ada <ada@x>\nEvil', email: 'ada@example.com' }), { name: 'Ada ada@x Evil', email: 'ada@example.com' });
  assert.deepEqual(cleanIdentity({ name: '', email: 'not an email' }), { name: 'Mobile Release Manager', email: 'noreply@localhost' });
  assert.deepEqual(cleanIdentity({ name: 'x', email: 'a@b>\n' }), { name: 'x', email: 'noreply@localhost' });
  assert.deepEqual(cleanIdentity(undefined), { name: 'Mobile Release Manager', email: 'noreply@localhost' });
});
