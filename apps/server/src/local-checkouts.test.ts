import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import type { Database } from '@mrm/db';
import { dbTest, openSqliteTestDatabase } from '@mrm/db/testing';
import {
  mapsApp,
  scannerMonorepo,
  SCAN_APP,
  weatherApp,
} from '../../../packages/connectors/src/fastlane.fixtures.ts';
import { FakeRepo, TOKEN, bootRepoApp, fastlaneFiles } from './repo-test-helpers.ts';
import { createCloneReads } from './services/clone-reads.ts';
import { isInside } from './services/local-git.ts';
import { clearRepoSnapshots } from './services/repo-snapshot.ts';

/**
 * Local clones (ADR 0005): attaching a folder to a GitHub repository, connecting a folder as a
 * repository of its own, and reading from it. Every repository here is a real git repository made
 * with the git CLI in a temp folder; there is no network and no GitHub.
 */

type Files = Record<string, string>;

const dirs: string[] = [];
const scratch = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
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

function writeAll(dir: string, files: Files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

/** A real git repository with these files in one commit on `main`. */
function buildRepo(parent: string, name: string, files: Files, origin?: string): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeAll(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  if (origin) git(dir, 'remote', 'add', 'origin', origin);
  return dir;
}

function commitMore(dir: string, files: Files): string {
  writeAll(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'more');
  return git(dir, 'rev-parse', 'HEAD');
}

/** A `gitPath` that logs the folder and arguments of every call, then runs the real git. */
function gitWrapper(): { path: string; calls: () => { cwd: string; args: string }[] } {
  const dir = scratch('mrm-wrap-');
  const log = join(dir, 'calls.log');
  const path = join(dir, 'git');
  writeFileSync(path, `#!/bin/sh\necho "$PWD|$*" >> '${log}'\nexec '${REAL_GIT}' "$@"\n`);
  chmodSync(path, 0o755);
  return {
    path,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const at = line.indexOf('|');
              return { cwd: line.slice(0, at), args: line.slice(at + 1) };
            })
        : [],
  };
}

/** The GitHub connector fake: counts reads, so a test can prove they came from the folder. */
class ApiRepo extends FakeRepo {
  readCalls = 0;
  constructor(files: Files) {
    super();
    this.files = new Map(Object.entries(files));
  }
  override async readFile(path: string): Promise<string | undefined> {
    this.readCalls++;
    return super.readFile(path);
  }
  get apiReads() {
    return this.listCalls + this.readCalls;
  }
}

type Boot = { files?: Files; mode?: 'api' | 'clone' | 'auto'; roots?: 'default' | 'none' };

async function boot(db: Database, options: Boot = {}) {
  const base = scratch('mrm-local-');
  const root = join(base, 'dev');
  const outside = join(base, 'outside');
  const dataDir = join(base, 'data');
  const cloneDir = join(dataDir, 'clones');
  for (const d of [root, outside, dataDir]) mkdirSync(d);
  const wrapper = gitWrapper();
  const logs: string[] = [];
  const reads = createCloneReads({
    mode: options.mode ?? 'clone',
    cloneDir,
    gitPath: wrapper.path,
    log: (line) => logs.push(line),
    ...(options.roots === 'none' ? {} : { local: { roots: [root], excluded: [dataDir, cloneDir] } }),
  });
  const files = options.files ?? fastlaneFiles();
  const api = new ApiRepo(files);
  clearRepoSnapshots();
  const t = await bootRepoApp(db, api, { reads });
  return { t, api, reads, base, root, outside, dataDir, cloneDir, wrapper, logs, files };
}
type Booted = Awaited<ReturnType<typeof boot>>;

/** Every git call ran in, and named only, folders inside the allowed ones. */
function assertGitStaysInside(b: Booted, allowed: string[]) {
  const ok = (path: string) => path === '/dev/null' || allowed.some((a) => isInside(path, a));
  for (const call of b.wrapper.calls()) {
    assert.ok(ok(call.cwd), `git ran in ${call.cwd}`);
    for (const m of call.args.matchAll(/(?:^|[\s=])(?:file:\/\/)?(\/[^\s'"]+)/g)) {
      const path = decodeURIComponent(m[1] ?? '');
      assert.ok(ok(path), `git was given ${path} (${call.args.slice(0, 120)})`);
    }
    assert.equal(call.args.includes('safe.directory'), false, 'safe.directory must never be set');
  }
}

const repoPath = (id: string, suffix = '') => `/repositories/${id}${suffix}`;

// ---------------------------------------------------------------------------------------------
// The setting

dbTest('without MRM_LOCAL_REPO_ROOTS every local route is refused and says which setting to use', async (db) => {
  const b = await boot(db, { roots: 'none' });
  const { t } = b;
  const dir = buildRepo(b.root, 'p', fastlaneFiles());
  const config = await t.call(t.owner, 'GET', '/repositories/local/config');
  assert.equal(config.status, 200);
  assert.equal(config.body.local.enabled, false);
  assert.equal(config.body.local.envName, 'MRM_LOCAL_REPO_ROOTS');
  assert.match(config.body.local.message, /MRM_LOCAL_REPO_ROOTS=/);
  assert.equal(config.body.local.roots, undefined);
  assert.equal(config.body.local.write.enabled, false);
  const { repositoryId } = await t.connect();
  for (const [method, path, body] of [
    ['POST', '/repositories/local/check', { path: dir }],
    ['POST', '/repositories/local', { path: dir }],
    ['PUT', repoPath(repositoryId, '/local'), { path: dir }],
  ] as const) {
    const res = await t.call(t.owner, method, path, body);
    assert.equal(res.status, 409, `${method} ${path}`);
    assert.equal(res.body.error, 'local_not_enabled');
    assert.match(res.body.message, /MRM_LOCAL_REPO_ROOTS/);
  }
  assert.equal(b.wrapper.calls().length, 0, 'git was never run');
});

dbTest('the setting lists the allowed folders to people who may attach one, not to the rest', async (db) => {
  const b = await boot(db);
  const { t } = b;
  const owner = await t.call(t.owner, 'GET', '/repositories/local/config');
  const write = { enabled: false, envName: 'MRM_LOCAL_REPO_WRITE', message: owner.body.local.write.message };
  assert.match(write.message, /MRM_LOCAL_REPO_WRITE=true/);
  assert.deepEqual(owner.body.local, { enabled: true, envName: 'MRM_LOCAL_REPO_ROOTS', roots: [b.root], write });
  const member = await t.addMember('member');
  const seen = await t.call(member, 'GET', '/repositories/local/config');
  assert.deepEqual(seen.body.local, { enabled: true, envName: 'MRM_LOCAL_REPO_ROOTS', write });
});

dbTest('MRM_READS=api means git is never run: local clones are refused with a clear error', async (db) => {
  const b = await boot(db, { mode: 'api' });
  const { t } = b;
  const dir = buildRepo(b.root, 'p', fastlaneFiles());
  const config = await t.call(t.owner, 'GET', '/repositories/local/config');
  assert.equal(config.body.local.enabled, false);
  assert.equal(config.body.local.reason, 'reads_api');
  for (const [path, body] of [
    ['/repositories/local/check', { path: dir }],
    ['/repositories/local', { path: dir }],
  ] as const) {
    const res = await t.call(t.owner, 'POST', path, body);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'local_reads_disabled');
    assert.match(res.body.message, /MRM_READS=api/);
  }
  assert.equal(b.wrapper.calls().length, 0);
});

dbTest('an attached folder is ignored (reads use GitHub) when MRM_READS=api, and the status says why', async (db) => {
  const b = await boot(db, { mode: 'api' });
  const { t } = b;
  const { repositoryId } = await t.connect();
  // Attached while the feature was on (here: written straight to the database).
  const dir = buildRepo(b.root, 'p', fastlaneFiles());
  await db.execute(
    `INSERT INTO repository_local_checkouts (repository_id, workspace_id, path, branch, name, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'main', 'p', 'u', 1, 1)`,
    [repositoryId, t.workspaceId, dir],
  );
  const one = await t.call(t.owner, 'GET', repoPath(repositoryId));
  assert.equal(one.body.repository.local.status, 'reads_api');
  const listing = await t.call(t.owner, 'GET', repoPath(repositoryId, '/listing'));
  assert.equal(listing.status, 200);
  assert.ok(b.api.apiReads > 0, 'the GitHub connector was read');
  assert.equal(b.wrapper.calls().length, 0, 'git was never run');
});

// ---------------------------------------------------------------------------------------------
// Check

dbTest('check: real path, branch, commit, origin, uncommitted files, and the matching connected repository', async (db) => {
  const b = await boot(db);
  const { t } = b;
  const dir = buildRepo(b.root, 'oss-weather', weatherApp(), 'https://ada:ghp_hunter2@github.com/acme/app.git');
  git(dir, 'branch', 'feature/x');
  writeFileSync(join(dir, 'fastlane/metadata/android/en-US/title.txt'), 'Edited, not committed\n');
  writeFileSync(join(dir, 'scratch.txt'), 'untracked\n');
  const head = git(dir, 'rev-parse', 'HEAD');
  const { repositoryId } = await t.connect();

  const res = await t.call(t.owner, 'POST', '/repositories/local/check', { path: dir });
  assert.equal(res.status, 200, res.text);
  const c = res.body.check;
  assert.equal(c.realPath, dir);
  assert.equal(c.checkedOutBranch, 'main');
  assert.equal(c.branch, 'main');
  assert.deepEqual(c.branches, ['feature/x', 'main']);
  assert.equal(c.headSha, head);
  assert.equal(c.dirtyCount, 2);
  assert.deepEqual(c.remote, { host: 'github.com', owner: 'acme', repo: 'app', github: true });
  assert.equal(c.match.id, repositoryId);
  assert.equal(c.match.name, 'acme/app');
  assert.equal(c.existing, null);
  assert.equal(res.text.includes('hunter2'), false, 'credentials in the origin URL are never returned');

  // Nothing was written in the folder or the database (apart from the audit row).
  assert.equal(git(dir, 'status', '--porcelain').split('\n').length, 2);
  assert.deepEqual(await db.query('SELECT * FROM repository_local_checkouts'), []);
  assertGitStaysInside(b, [b.root, b.cloneDir]);
});

dbTest('check refuses a folder outside the roots, a link out, traversal, a non-repository and a bare repository', async (db) => {
  const b = await boot(db);
  const { t } = b;
  const elsewhere = buildRepo(b.outside, 'secret', fastlaneFiles());
  symlinkSync(elsewhere, join(b.root, 'link-out'));
  mkdirSync(join(b.root, 'plain'));
  const bare = join(b.root, 'bare.git');
  mkdirSync(bare);
  git(bare, 'init', '-q', '--bare');
  const check = (path: string) => t.call(t.owner, 'POST', '/repositories/local/check', { path });
  const expectations: [string, number, string][] = [
    [elsewhere, 422, 'local_outside_roots'],
    [join(b.root, 'link-out'), 422, 'local_outside_roots'],
    [`${b.root}/../outside/secret`, 422, 'local_invalid_path'],
    ['relative/path', 422, 'local_invalid_path'],
    ['/etc', 422, 'local_outside_roots'],
    [join(b.root, 'nope'), 422, 'local_not_found'],
    [join(b.root, 'plain'), 422, 'local_not_a_repository'],
    [bare, 422, 'local_bare_repository'],
    [b.dataDir, 422, 'local_outside_roots'],
  ];
  for (const [path, status, code] of expectations) {
    const res = await check(path);
    assert.equal(res.status, status, path);
    assert.equal(res.body.error, code, path);
  }
  const nul = await check(`${b.root}/x\u0000y`);
  assert.equal(nul.status, 422);
  assert.equal((await check('a'.repeat(5000))).status, 400);
  assert.equal(b.wrapper.calls().length, 0, 'git never saw any of these paths');
});

dbTest('check explains a detached HEAD and a repository without commits', async (db) => {
  const b = await boot(db);
  const { t } = b;
  const dir = buildRepo(b.root, 'p', fastlaneFiles());
  git(dir, 'checkout', '-q', '--detach');
  const res = await t.call(t.owner, 'POST', '/repositories/local/check', { path: dir });
  assert.equal(res.status, 200);
  assert.equal(res.body.check.checkedOutBranch, null);
  assert.equal(res.body.check.branch, null);
  assert.match(res.body.check.warnings.join(' '), /detached/i);
  const empty = join(b.root, 'empty');
  mkdirSync(empty);
  git(empty, 'init', '-q', '-b', 'main');
  const none = await t.call(t.owner, 'POST', '/repositories/local/check', { path: empty });
  assert.equal(none.status, 422);
  assert.equal(none.body.error, 'local_no_commits');
});

// ---------------------------------------------------------------------------------------------
// Attach to a connected repository

const LAYOUTS: [string, () => Files][] = [
  ['one app, ios and android folders (weather)', () => weatherApp()],
  ['a monorepo with a folder per app id', () => scannerMonorepo({ cardChangelogs: 12, scanChangelogs: 12 })],
  ['android only (maps)', () => mapsApp()],
];

for (const [name, files] of LAYOUTS) {
  test(`attached: scan and listing from the folder equal the API result: ${name}`, async () => {
    const dbLocal = await openSqliteTestDatabase();
    const dbApi = await openSqliteTestDatabase();
    try {
      const viaLocal = await boot(dbLocal, { files: files() });
      const viaApi = await boot(dbApi, { files: files(), mode: 'api' });
      const dir = buildRepo(viaLocal.root, 'project', files(), 'git@github.com:acme/app.git');
      const local = await viaLocal.t.connect();
      const remote = await viaApi.t.connect();
      const attach = await viaLocal.t.call(viaLocal.t.owner, 'PUT', repoPath(local.repositoryId, '/local'), { path: dir });
      assert.equal(attach.status, 200, attach.text);
      assert.equal(attach.body.repository.local.path, dir);
      assert.equal(attach.body.repository.local.branch, 'main');
      assert.equal(attach.body.repository.local.status, 'ok');
      assert.equal(attach.body.repository.localOnly, false);
      assert.equal(attach.body.repository.owner, 'acme');

      const urls = ['/listing'];
      if (name.includes('monorepo')) urls.push(`/listing?target=${encodeURIComponent(`auto:app:${SCAN_APP}`)}`);
      const one = (x: typeof viaLocal, id: string, method: string, path: string) =>
        x.t.call(x.t.owner, method, repoPath(id, path));
      const scanLocal = await one(viaLocal, local.repositoryId, 'POST', '/scan');
      const scanApi = await one(viaApi, remote.repositoryId, 'POST', '/scan');
      assert.equal(scanLocal.status, 200, scanLocal.text);
      assert.deepEqual(scanLocal.body.detection, scanApi.body.detection);
      assert.deepEqual(scanLocal.body.listingSources, scanApi.body.listingSources);
      for (const url of urls) {
        const a = await one(viaLocal, local.repositoryId, 'GET', url);
        const e = await one(viaApi, remote.repositoryId, 'GET', url);
        assert.equal(a.status, 200, a.text);
        assert.deepEqual(a.body, e.body, url);
        assert.equal(a.body.found.appStore || a.body.found.googlePlay, true);
      }
      // GitHub was never asked for a tree or a file; the managed copy of the folder is separate from a GitHub clone.
      assert.equal(viaLocal.api.apiReads, 0);
      assert.ok(existsSync(join(viaLocal.cloneDir, viaLocal.t.workspaceId, `${local.repositoryId}-local`, 'mrm-clone.json')));
      assert.equal(existsSync(join(viaLocal.cloneDir, viaLocal.t.workspaceId, local.repositoryId)), false);
      const audit = await dbLocal.query("SELECT detail FROM audit_events WHERE action = 'repository.scan'");
      assert.equal(JSON.parse(String(audit[0]?.detail)).reads, 'local');
      assertGitStaysInside(viaLocal, [viaLocal.root, viaLocal.cloneDir]);
    } finally {
      await dbLocal.close();
      await dbApi.close();
    }
  });
}

dbTest('attach, read, change set from the folder, apply as a pull request through GitHub, audited with the path', async (db) => {
  const b = await boot(db);
  const { t } = b;
  const dir = buildRepo(b.root, 'oss-weather', fastlaneFiles(), 'https://github.com/acme/app.git');
  const { repositoryId } = await t.connect();

  const attach = await t.call(t.owner, 'PUT', repoPath(repositoryId, '/local'), { path: `${dir}/` });
  assert.equal(attach.status, 200, attach.text);
  const list = await t.call(t.owner, 'GET', '/repositories');
  assert.equal(list.body.repositories[0].local.path, dir);
  assert.equal(list.body.repositories[0].name, 'acme/app');

  const draft = await t.draft(repositoryId, 'Read from the folder');
  assert.equal(draft.res.status, 201, draft.res.text);
  assert.equal(b.api.apiReads, 0, 'the change set was made from the folder');
  assert.equal((await t.call(t.owner, 'POST', `/change-sets/${draft.id}/approve`)).status, 200);
  const applied = await t.call(t.owner, 'POST', `/change-sets/${draft.id}/apply`);
  assert.equal(applied.status, 200, applied.text);
  assert.equal(applied.body.changeSet.status, 'applied');
  assert.equal(b.api.proposals.length, 1, 'applying still goes through GitHub');
  assert.match(applied.text, /github\.com/);

  // The last commit read is recorded.
  const one = await t.call(t.owner, 'GET', repoPath(repositoryId));
  assert.equal(one.body.repository.local.headSha, git(dir, 'rev-parse', 'HEAD'));
  assert.ok(one.body.repository.local.lastReadAt > 0);

  const audit = (await t.auditActions()).filter((a) => a.action === 'repository.local_attach');
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0]?.detail ?? '{}'), { path: dir, branch: 'main' });
  assert.equal(JSON.stringify(await db.query('SELECT * FROM audit_events')).includes('Old subtitle'), false, 'no file content in audit rows');
  assertGitStaysInside(b, [b.root, b.cloneDir]);
});

dbTest('only committed content is read: edits in the working folder are not, a new commit is, at once', async (db) => {
  const b = await boot(db);
  const { t } = b;
  const dir = buildRepo(b.root, 'p', fastlaneFiles(), 'git@github.com:acme/app.git');
  const { repositoryId } = await t.connect();
  await t.call(t.owner, 'PUT', repoPath(repositoryId, '/local'), { path: dir });
  const subtitle = async () =>
    (await t.call(t.owner, 'GET', repoPath(repositoryId, '/listing'))).body.listing.appStore.locales['en-US'].subtitle;
  assert.equal(await subtitle(), 'Old subtitle');
  writeFileSync(join(dir, 'fastlane/metadata/en-US/subtitle.txt'), 'Uncommitted subtitle\n');
  assert.equal(await subtitle(), 'Old subtitle', 'the working folder is not read');
  git(dir, 'checkout', '-q', '--', '.');
  const sha = commitMore(dir, { 'fastlane/metadata/en-US/subtitle.txt': 'Committed subtitle\n' });
  assert.equal(await subtitle(), 'Committed subtitle');
  const one = await t.call(t.owner, 'GET', repoPath(repositoryId));
  assert.equal(one.body.repository.local.headSha, sha);
  assert.equal(b.api.apiReads, 0);
  // And the folder was only read: nothing was written into it.
  assert.equal(readFileSync(join(dir, 'fastlane/metadata/en-US/subtitle.txt'), 'utf8'), 'Committed subtitle\n');
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

dbTest('another branch: changing it reads that branch; a missing, odd or option-like branch is refused', async (db) => {
  const b = await boot(db);
  const { t } = b;
  const dir = buildRepo(b.root, 'p', fastlaneFiles(), 'git@github.com:acme/app.git');
  git(dir, 'checkout', '-q', '-b', 'feature/new-copy');
  commitMore(dir, { 'fastlane/metadata/en-US/subtitle.txt': 'Branch subtitle\n' });
  git(dir, 'checkout', '-q', 'main');
  const { repositoryId } = await t.connect();
  const url = repoPath(repositoryId, '/local');
  await t.call(t.owner, 'PUT', url, { path: dir });
  const subtitle = async () =>
    (await t.call(t.owner, 'GET', repoPath(repositoryId, '/listing'))).body.listing.appStore.locales['en-US'].subtitle;
  assert.equal(await subtitle(), 'Old subtitle');

  const change = await t.call(t.owner, 'PUT', url, { branch: 'feature/new-copy' });
  assert.equal(change.status, 200, change.text);
  assert.equal(change.body.repository.local.branch, 'feature/new-copy');
  assert.equal(change.body.repository.defaultBranch, 'main', 'GitHub’s default branch is not touched');
  assert.equal(await subtitle(), 'Branch subtitle');

  for (const [branch, code] of [['nope', 'local_branch_not_found'], ['--upload-pack=x', 'local_invalid_branch'], ['a..b', 'local_invalid_branch']] as const) {
    const res = await t.call(t.owner, 'PUT', url, { branch });
    assert.equal(res.status, 422, branch);
    assert.equal(res.body.error, code, branch);
  }
  assert.equal(await subtitle(), 'Branch subtitle', 'a refused change changed nothing');
  const actions = (await t.auditActions()).map((a) => a.action);
  assert.ok(actions.includes('repository.local_change'));
});

dbTest('a detached HEAD needs a branch to be chosen', async (db) => {
  const b = await boot(db);
  const { t } = b;
  const dir = buildRepo(b.root, 'p', fastlaneFiles());
  git(dir, 'checkout', '-q', '--detach');
  const { repositoryId } = await t.connect();
  const url = repoPath(repositoryId, '/local');
  const refused = await t.call(t.owner, 'PUT', url, { path: dir, allowRemoteMismatch: true });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error, 'local_detached_head');
  const ok = await t.call(t.owner, 'PUT', url, { path: dir, branch: 'main' });
  assert.equal(ok.status, 200, ok.text);
});

dbTest('a clone whose origin is another repository needs confirmation; no origin is accepted', async (db) => {
  const b = await boot(db);
  const { t } = b;
  const { repositoryId } = await t.connect();
  const url = repoPath(repositoryId, '/local');
  const other = buildRepo(b.root, 'other', fastlaneFiles(), 'git@github.com:acme/other.git');
  const refused = await t.call(t.owner, 'PUT', url, { path: other });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'remote_mismatch');
  assert.match(refused.body.message, /acme\/other/);
  assert.equal((await t.call(t.owner, 'GET', repoPath(repositoryId))).body.repository.local, null);
  const confirmed = await t.call(t.owner, 'PUT', url, { path: other, allowRemoteMismatch: true });
  assert.equal(confirmed.status, 200, confirmed.text);
  const audit = (await t.auditActions()).find((a) => a.action === 'repository.local_attach');
  assert.equal(JSON.parse(audit?.detail ?? '{}').originConfirmed, 'acme/other');
  // No origin at all, and a case-insensitive match, are fine.
  const bare = buildRepo(b.root, 'no-origin', fastlaneFiles());
  assert.equal((await t.call(t.owner, 'PUT', url, { path: bare })).status, 200);
  const same = buildRepo(b.root, 'same', fastlaneFiles(), 'https://github.com/ACME/App.git');
  assert.equal((await t.call(t.owner, 'PUT', url, { path: same })).status, 200);
});

dbTest('detach: reads go back to GitHub, the managed copy goes, it is audited, and doing it twice is a 404', async (db) => {
  const b = await boot(db);
  const { t } = b;
  const dir = buildRepo(b.root, 'p', fastlaneFiles(), 'git@github.com:acme/app.git');
  const { repositoryId } = await t.connect();
  const url = repoPath(repositoryId, '/local');
  await t.call(t.owner, 'PUT', url, { path: dir });
  assert.equal((await t.call(t.owner, 'GET', repoPath(repositoryId, '/listing'))).status, 200);
  const managed = join(b.cloneDir, t.workspaceId, `${repositoryId}-local`);
  assert.ok(existsSync(managed));

  const done = await t.call(t.owner, 'DELETE', url);
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.repository.local, null);
  assert.equal(existsSync(managed), false);
  assert.equal(existsSync(join(dir, 'fastlane')), true, 'the user’s folder is never touched');
  const audit = (await t.auditActions()).find((a) => a.action === 'repository.local_detach');
  assert.deepEqual(JSON.parse(audit?.detail ?? '{}'), { path: dir, branch: 'main' });

  const again = await t.call(t.owner, 'DELETE', url);
  assert.equal(again.status, 404);
  assert.equal(again.body.error, 'no_local_checkout');
  assert.equal((await t.call(t.owner, 'DELETE', repoPath('nope', '/local'))).status, 404);
});

dbTest('disconnecting a repository removes its local checkout row and managed copy but not the folder', async (db) => {
  const b = await boot(db);
  const { t } = b;
  const dir = buildRepo(b.root, 'p', fastlaneFiles(), 'git@github.com:acme/app.git');
  const { repositoryId } = await t.connect();
  await t.call(t.owner, 'PUT', repoPath(repositoryId, '/local'), { path: dir });
  await t.call(t.owner, 'GET', repoPath(repositoryId, '/listing'));
  const res = await t.call(t.owner, 'DELETE', repoPath(repositoryId));
  assert.equal(res.status, 204, res.text);
  assert.deepEqual(await db.query('SELECT * FROM repository_local_checkouts'), []);
  assert.equal(existsSync(join(b.cloneDir, t.workspaceId, `${repositoryId}-local`)), false);
  assert.equal(existsSync(join(dir, '.git')), true);
});

// ---------------------------------------------------------------------------------------------
// Local-only

dbTest('local-only: connect a folder with no GitHub, read it, make a change set, and apply is refused', async (db) => {
  const b = await boot(db);
  const { t } = b;
  const dir = buildRepo(b.root, 'oss-weather', weatherApp());
  const res = await t.call(t.owner, 'POST', '/repositories/local', { path: dir });
  assert.equal(res.status, 201, res.text);
  const r = res.body.repository;
  assert.equal(r.localOnly, true);
  assert.equal(r.credentialId, null);
  assert.equal(r.owner, null);
  assert.equal(r.repo, null);
  assert.equal(r.name, 'oss-weather');
  assert.equal(r.defaultBranch, 'main');
  assert.equal(r.local.path, dir);
  assert.equal(r.local.status, 'ok');
  assert.equal(t.built.length, 0, 'no connector and no credential were ever used');

  const list = await t.call(t.owner, 'GET', '/repositories');
  assert.equal(list.body.repositories.length, 1);
  assert.equal(list.body.repositories[0].localOnly, true);

  const scan = await t.call(t.owner, 'POST', repoPath(r.id, '/scan'));
  assert.equal(scan.status, 200, scan.text);
  assert.equal(scan.body.detection.kind, 'fastlane');
  const listing = await t.call(t.owner, 'GET', repoPath(r.id, '/listing'));
  assert.equal(listing.status, 200, listing.text);
  assert.equal(listing.body.found.appStore || listing.body.found.googlePlay, true);

  // A change set from the folder: the draft is made, so the review is possible.
  const read = listing.body.listing;
  const locale = Object.keys(read.googlePlay?.locales ?? read.appStore?.locales ?? {})[0] ?? 'en-US';
  const store = read.googlePlay ? 'googlePlay' : 'appStore';
  const field = store === 'googlePlay' ? 'title' : 'name';
  read[store].locales[locale][field] = 'A local change';
  const draftRes = await t.call(t.owner, 'POST', repoPath(r.id, '/change-sets'), { summary: 'A local change', listing: read });
  assert.equal(draftRes.status, 201, draftRes.text);
  const draftId = draftRes.body.changeSet.id as string;
  assert.equal((await t.call(t.owner, 'POST', `/change-sets/${draftId}/approve`)).status, 200);
  const apply = await t.call(t.owner, 'POST', `/change-sets/${draftId}/apply`);
  assert.equal(apply.status, 409, apply.text);
  assert.equal(apply.body.error, 'local_only');
  assert.match(apply.body.message, /commit on a new branch of the local clone/);
  assert.equal(b.api.proposals.length, 0);
  const after = await t.call(t.owner, 'GET', `/change-sets/${draftId}`);
  assert.equal(after.body.changeSet.status, 'approved', 'it stays approved, nothing was claimed');

  // GitHub features say the same, instead of failing on an empty credential.
  const workflows = await t.call(t.owner, 'GET', repoPath(r.id, '/workflows'));
  assert.equal(workflows.status, 409);
  assert.equal(workflows.body.error, 'local_only');

  // It has no GitHub to detach from; it is disconnected instead (after its change set is discarded).
  const detach = await t.call(t.owner, 'DELETE', repoPath(r.id, '/local'));
  assert.equal(detach.status, 409);
  assert.equal(detach.body.error, 'local_only');
  assert.equal((await t.call(t.owner, 'DELETE', repoPath(r.id))).status, 409, 'an open change set blocks it');
  await t.call(t.owner, 'POST', `/change-sets/${draftId}/discard`);
  assert.equal((await t.call(t.owner, 'DELETE', repoPath(r.id))).status, 204);
  assert.deepEqual(await db.query('SELECT * FROM repository_local_checkouts'), []);
  assert.deepEqual(await db.query('SELECT id FROM repositories'), []);

  const actions = await t.auditActions();
  const connect = actions.find((a) => a.action === 'repository.local_connect');
  assert.deepEqual(JSON.parse(connect?.detail ?? '{}'), { path: dir, branch: 'main', name: 'oss-weather' });
  const disconnect = actions.find((a) => a.action === 'repository.disconnect');
  assert.equal(JSON.parse(disconnect?.detail ?? '{}').localOnly, true);
  assert.equal(actions.some((a) => a.action === 'credential.use'), false);
  assertGitStaysInside(b, [b.root, b.cloneDir]);
});

dbTest('local-only: a name, a branch, the same folder twice, a monorepo, and the check says what a folder already is', async (db) => {
  const b = await boot(db);
  const { t } = b;
  const monorepo = buildRepo(join(b.root, 'nativescript'), 'OSS-DocumentScanner', scannerMonorepo({ cardChangelogs: 3, scanChangelogs: 3 }));
  git(monorepo, 'branch', 'develop');
  const named = await t.call(t.owner, 'POST', '/repositories/local', { path: monorepo, branch: 'develop', name: '  Document   Scanner ' });
  assert.equal(named.status, 201, named.text);
  assert.equal(named.body.repository.name, 'Document Scanner');
  assert.equal(named.body.repository.local.branch, 'develop');
  assert.equal(named.body.repository.defaultBranch, 'develop');
  const listing = await t.call(t.owner, 'GET', repoPath(named.body.repository.id, `/listing?target=${encodeURIComponent(`auto:app:${SCAN_APP}`)}`));
  assert.equal(listing.status, 200, listing.text);
  assert.equal(listing.body.selected.origin, 'detected');

  const twice = await t.call(t.owner, 'POST', '/repositories/local', { path: monorepo });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.error, 'already_connected');
  const second = buildRepo(b.root, 'second', weatherApp());
  assert.equal((await t.call(t.owner, 'POST', '/repositories/local', { path: second })).status, 201);
  assert.equal((await t.call(t.owner, 'GET', '/repositories')).body.repositories.length, 2);

  // A GitHub repository cannot take a folder that another repository already uses.
  const { repositoryId } = await t.connect();
  const used = await t.call(t.owner, 'PUT', repoPath(repositoryId, '/local'), { path: monorepo, allowRemoteMismatch: true });
  assert.equal(used.status, 409);
  assert.equal(used.body.error, 'path_in_use');
  const check = await t.call(t.owner, 'POST', '/repositories/local/check', { path: monorepo });
  assert.equal(check.body.check.existing.id, named.body.repository.id);
  assert.equal(check.body.check.existing.localOnly, true);
});

// ---------------------------------------------------------------------------------------------
// Re-validation on every read

dbTest('a folder swapped for a link out of the roots is refused at the next read, and git never sees the target', async (db) => {
  const b = await boot(db);
  const { t } = b;
  const dir = buildRepo(b.root, 'p', fastlaneFiles());
  const secret = buildRepo(b.outside, 'secret', { 'fastlane/metadata/en-US/name.txt': 'TOP SECRET\n', 'fastlane/Fastfile': 'x' });
  const res = await t.call(t.owner, 'POST', '/repositories/local', { path: dir });
  const id = res.body.repository.id as string;
  assert.equal((await t.call(t.owner, 'GET', repoPath(id, '/listing'))).status, 200);
  const callsBefore = b.wrapper.calls().length;

  // Swap the folder for a link to a repository outside the roots.
  renameSync(dir, `${dir}.moved`);
  symlinkSync(secret, dir);
  const listing = await t.call(t.owner, 'GET', repoPath(id, '/listing'));
  assert.equal(listing.status, 422, listing.text);
  assert.equal(listing.body.error, 'local_outside_roots');
  assert.equal(listing.text.includes('SECRET'), false);
  const scan = await t.call(t.owner, 'POST', repoPath(id, '/scan'));
  assert.equal(scan.status, 422);
  const draft = await t.call(t.owner, 'POST', repoPath(id, '/change-sets'), { summary: 'x', listing: { appStore: { locales: {} } } });
  assert.equal(draft.status, 422);
  assert.equal(b.wrapper.calls().length, callsBefore, 'no git process was started for the swapped folder');
  assert.equal(b.wrapper.calls().some((c) => c.args.includes('secret') || c.cwd.includes('secret')), false);
  const one = await t.call(t.owner, 'GET', repoPath(id));
  assert.equal(one.body.repository.local.status, 'outside_roots');

  // Put it back and it works again.
  rmSync(dir);
  renameSync(`${dir}.moved`, dir);
  assert.equal((await t.call(t.owner, 'GET', repoPath(id, '/listing'))).status, 200);
});

dbTest('a folder that is gone, or no longer a repository, is reported, not read from GitHub', async (db) => {
  const b = await boot(db);
  const { t } = b;
  const dir = buildRepo(b.root, 'p', fastlaneFiles(), 'git@github.com:acme/app.git');
  const { repositoryId } = await t.connect();
  await t.call(t.owner, 'PUT', repoPath(repositoryId, '/local'), { path: dir });
  rmSync(join(dir, '.git'), { recursive: true });
  const a = await t.call(t.owner, 'GET', repoPath(repositoryId, '/listing'));
  assert.equal(a.status, 422);
  assert.equal(a.body.error, 'local_not_a_repository');
  rmSync(dir, { recursive: true });
  const c = await t.call(t.owner, 'GET', repoPath(repositoryId, '/listing'));
  assert.equal(c.body.error, 'local_not_found');
  assert.equal(b.api.apiReads, 0, 'GitHub was not used as a silent substitute');
  assert.equal((await t.call(t.owner, 'GET', repoPath(repositoryId))).body.repository.local.status, 'not_found');
});

dbTest('a branch deleted in the folder is reported with what to do', async (db) => {
  const b = await boot(db);
  const { t } = b;
  const dir = buildRepo(b.root, 'p', fastlaneFiles());
  git(dir, 'branch', 'topic');
  const res = await t.call(t.owner, 'POST', '/repositories/local', { path: dir, branch: 'topic' });
  const id = res.body.repository.id as string;
  assert.equal((await t.call(t.owner, 'GET', repoPath(id, '/listing'))).status, 200);
  git(dir, 'branch', '-D', 'topic');
  const gone = await t.call(t.owner, 'GET', repoPath(id, '/listing'));
  assert.equal(gone.status, 422, gone.text);
  assert.equal(gone.body.error, 'local_branch_missing');
  assert.match(gone.body.message, /topic/);
});

// ---------------------------------------------------------------------------------------------
// Roles and isolation

dbTest('only repositories.write may attach or connect; members and viewers get 403, non-members 404', async (db) => {
  const b = await boot(db);
  const { t } = b;
  const dir = buildRepo(b.root, 'p', fastlaneFiles());
  const { repositoryId } = await t.connect();
  const member = await t.addMember('member');
  const viewer = await t.addMember('viewer');
  const admin = await t.addMember('admin');
  const calls: [string, string, unknown][] = [
    ['POST', '/repositories/local/check', { path: dir }],
    ['POST', '/repositories/local', { path: dir }],
    ['PUT', repoPath(repositoryId, '/local'), { path: dir, allowRemoteMismatch: true }],
    ['DELETE', repoPath(repositoryId, '/local'), undefined],
  ];
  for (const who of [member, viewer]) {
    for (const [method, path, body] of calls) {
      const res = await t.call(who, method, path, body);
      assert.equal(res.status, 403, `${method} ${path}`);
    }
  }
  assert.equal(b.wrapper.calls().length, 0, 'a refused request never ran git');
  assert.equal((await t.call(member, 'GET', repoPath(repositoryId))).status, 200);
  assert.equal((await t.call(admin, 'POST', '/repositories/local/check', { path: dir })).status, 200);
  assert.equal((await t.call(admin, 'PUT', repoPath(repositoryId, '/local'), { path: dir, allowRemoteMismatch: true })).status, 200);

  // Not a member of the workspace: the same answer as an unknown workspace.
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  for (const [method, path, body] of calls) {
    const res = await t.call(outsider, method, path, body);
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  assert.equal((await t.call(outsider, 'GET', '/repositories/local/config')).status, 404);
});

dbTest('workspaces are isolated: another workspace cannot attach to, detach from or see a repository, and paths do not collide', async (db) => {
  const b = await boot(db);
  const { t } = b;
  const dir = buildRepo(b.root, 'p', fastlaneFiles(), 'git@github.com:acme/app.git');
  const { repositoryId } = await t.connect();
  await t.call(t.owner, 'PUT', repoPath(repositoryId, '/local'), { path: dir });

  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  const out = (method: string, path: string, body?: unknown) => t.call(outsider, method, path, body, 'other');
  assert.equal((await out('PUT', repoPath(repositoryId, '/local'), { branch: 'main' })).status, 404);
  assert.equal((await out('DELETE', repoPath(repositoryId, '/local'))).status, 404);
  assert.equal((await out('GET', repoPath(repositoryId))).status, 404);
  assert.equal((await out('GET', '/repositories')).body.repositories.length, 0);
  assert.equal((await db.query('SELECT * FROM repository_local_checkouts WHERE workspace_id = ?', [t.workspaceId])).length, 1);

  // The same folder can be connected in the other workspace (the path is unique per workspace), and
  // its checks do not see the first workspace's repositories.
  const check = await out('POST', '/repositories/local/check', { path: dir });
  assert.equal(check.status, 200);
  assert.equal(check.body.check.match, null);
  assert.equal(check.body.check.existing, null);
  assert.equal((await out('POST', '/repositories/local', { path: dir })).status, 201);
});

// ---------------------------------------------------------------------------------------------
// Audit, leaks and what git is told

dbTest('every check, attach, change, detach and connect is audited with the path and no content', async (db) => {
  const b = await boot(db);
  const { t } = b;
  const dir = buildRepo(b.root, 'p', fastlaneFiles(), 'https://ada:ghp_hunter2@github.com/acme/app.git');
  const { repositoryId } = await t.connect();
  await t.call(t.owner, 'POST', '/repositories/local/check', { path: dir });
  await t.call(t.owner, 'POST', '/repositories/local/check', { path: '/etc' });
  await t.call(t.owner, 'PUT', repoPath(repositoryId, '/local'), { path: dir });
  await t.call(t.owner, 'PUT', repoPath(repositoryId, '/local'), { branch: 'main' });
  await t.call(t.owner, 'DELETE', repoPath(repositoryId, '/local'));
  const other = buildRepo(b.root, 'q', fastlaneFiles());
  await t.call(t.owner, 'POST', '/repositories/local', { path: other });
  const rows = (await t.auditActions()).filter((a) => a.action.startsWith('repository.local_'));
  assert.deepEqual(
    rows.map((r) => r.action),
    ['repository.local_check', 'repository.local_check', 'repository.local_attach', 'repository.local_change', 'repository.local_detach', 'repository.local_connect'],
  );
  assert.equal(JSON.parse(rows[0]?.detail ?? '{}').path, dir);
  assert.deepEqual(JSON.parse(rows[1]?.detail ?? '{}'), { path: '/etc', ok: false, code: 'local_outside_roots' });
  for (const row of rows) {
    assert.equal(row.actorType, 'user');
    assert.equal(row.detail.includes('hunter2'), false);
    assert.equal(row.detail.includes('Acme App'), false);
  }
  const everything = JSON.stringify(await db.query('SELECT * FROM audit_events')) + t.texts.join('\n') + b.logs.join('\n');
  for (const secret of ['hunter2', TOKEN]) assert.equal(everything.includes(secret), false, 'a secret leaked');
});

dbTest('git is only ever run in, and told about, folders inside the allowed roots and the clone folder', async (db) => {
  const b = await boot(db);
  const { t } = b;
  const inside = buildRepo(b.root, 'inside', fastlaneFiles());
  const outsideRepo = buildRepo(b.outside, 'outside', fastlaneFiles());
  symlinkSync(outsideRepo, join(b.root, 'escape'));
  const { repositoryId } = await t.connect();
  const attempts = [outsideRepo, join(b.root, 'escape'), `${b.root}/../outside/outside`, b.outside, '/etc', '/', '/tmp'];
  for (const path of attempts) {
    for (const url of ['/repositories/local/check', '/repositories/local']) {
      const res = await t.call(t.owner, 'POST', url, { path });
      assert.ok(res.status >= 400, `${url} ${path}`);
    }
    const attach = await t.call(t.owner, 'PUT', repoPath(repositoryId, '/local'), { path, allowRemoteMismatch: true });
    assert.ok(attach.status >= 400, path);
  }
  assert.equal(b.wrapper.calls().length, 0, 'not one git process for a path outside the roots');
  // And the allowed one works, with every call inside the roots.
  const connected = await t.call(t.owner, 'POST', '/repositories/local', { path: inside });
  assert.equal(connected.status, 201);
  assert.ok(b.wrapper.calls().length > 0);
  await t.call(t.owner, 'GET', repoPath(connected.body.repository.id, '/listing'));
  assertGitStaysInside(b, [b.root, b.cloneDir]);
  // The reader's own git calls use the validated real path, hardened as before.
  const fetches = b.wrapper.calls().filter((c) => /\bfetch\b/.test(c.args));
  assert.ok(fetches.length > 0);
  for (const f of fetches) {
    assert.match(f.args, /core\.hooksPath=\/dev\/null/);
    assert.match(f.args, /core\.fsmonitor=false/);
  }
  for (const call of b.wrapper.calls().filter((c) => c.cwd === inside)) {
    assert.match(call.args, /core\.fsmonitor=false/);
    assert.match(call.args, /core\.hooksPath=\/dev\/null/);
    assert.match(call.args, /--no-pager/);
  }
});

dbTest('a malicious repository config cannot run anything during check, attach and read', async (db) => {
  const b = await boot(db);
  const { t } = b;
  const dir = buildRepo(b.root, 'hostile', fastlaneFiles());
  const marker = join(b.base, 'PWNED');
  const run = `sh -c 'echo ran >> ${marker}'`;
  mkdirSync(join(dir, 'hooks'));
  for (const hook of ['reference-transaction', 'post-checkout', 'pre-commit', 'post-fetch', 'update']) {
    writeFileSync(join(dir, 'hooks', hook), `#!/bin/sh\necho ran >> ${marker}\n`, { mode: 0o755 });
  }
  for (const [key, value] of [
    ['core.fsmonitor', run],
    ['core.hooksPath', join(dir, 'hooks')],
    ['core.pager', run],
    ['core.alternateRefsCommand', run],
    ['uploadpack.packObjectsHook', run],
    ['credential.helper', `!${run}`],
  ] as const) {
    git(dir, 'config', key, value);
  }
  writeFileSync(join(dir, 'fastlane/metadata/en-US/name.txt'), 'edited\n');
  assert.equal((await t.call(t.owner, 'POST', '/repositories/local/check', { path: dir })).status, 200);
  const res = await t.call(t.owner, 'POST', '/repositories/local', { path: dir });
  assert.equal(res.status, 201, res.text);
  const id = res.body.repository.id as string;
  assert.equal((await t.call(t.owner, 'POST', repoPath(id, '/scan'))).status, 200);
  assert.equal((await t.call(t.owner, 'GET', repoPath(id, '/listing'))).status, 200);
  assert.equal(existsSync(marker), false, 'a program from the repository config ran');
});
