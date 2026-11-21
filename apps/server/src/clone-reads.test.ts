import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { GitCloneError, GithubError } from '@kiln/connectors';
import type { Database, Sql } from '@kiln/db';
import { dbTest, openSqliteTestDatabase } from '@kiln/db/testing';
import {
  CARD_APP,
  mapsApp,
  SCAN_APP,
  scannerMonorepo,
  weatherApp,
} from '../../../packages/connectors/src/fastlane.fixtures.ts';
import { bootRepoApp, FakeRepo, fastlaneFiles, TOKEN } from './repo-test-helpers.ts';
import {
  type CloneReader,
  type CloneReads,
  canFallBack,
  createCloneReads,
  setUpReads,
  withCloneReads,
} from './services/clone-reads.ts';
import { clearRepoSnapshots } from './services/repo-snapshot.ts';

/**
 * Scan and listing reads from a local clone (ADR 0005). Every source repository here is a real
 * git repository made with the git CLI in a temp folder and read through the `local` source
 * option of the reader (file://). No network, no GitHub.
 */

type Files = Record<string, string>;

const roots: string[] = [];
const scratch = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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

function writeAll(dir: string, files: Files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

/** A real git repository with these files in one commit on `main`. */
function buildRepo(files: Files): string {
  const dir = join(scratch('mrm-src-'), 'source');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  writeAll(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

function commitMore(dir: string, files: Files): string {
  writeAll(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'more');
  return git(dir, 'rev-parse', 'HEAD');
}

/** A `gitPath` that logs its arguments, may run `body` first, then runs the real git. */
function gitWrapper(body = ''): { path: string; calls: () => string[] } {
  const dir = scratch('mrm-wrap-');
  const log = join(dir, 'calls.log');
  const path = join(dir, 'git');
  writeFileSync(path, `#!/bin/sh\necho "$@" >> '${log}'\n${body}\nexec '${REAL_GIT}' "$@"\n`);
  chmodSync(path, 0o755);
  return {
    path,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
  };
}

/** The API connector fake: counts reads, so a test can prove they came from the clone. */
class ApiRepo extends FakeRepo {
  readCalls = 0;
  resolveCalls = 0;
  tokenCalls = 0;
  constructor(files: Files) {
    super();
    this.files = new Map(Object.entries(files));
  }
  override async readFile(path: string): Promise<string | undefined> {
    this.readCalls++;
    return super.readFile(path);
  }
  async resolveCommit(): Promise<string> {
    this.resolveCalls++;
    return 'c'.repeat(40);
  }
  async installationToken(): Promise<string> {
    this.tokenCalls++;
    return 'ghs_installation_token_for_tests_0123456789';
  }
  get apiReads() {
    return this.listCalls + this.readCalls;
  }
}

type Boot = {
  files: Files;
  mode?: 'api' | 'clone' | 'auto';
  gitPath?: string;
  ttlMs?: number;
  timeoutMs?: number;
};

async function boot(db: Database, options: Boot) {
  const source = buildRepo(options.files);
  const cloneDir = join(scratch('mrm-clones-'), 'clones');
  const logs: string[] = [];
  let sourceAsked = 0;
  const reads = createCloneReads({
    mode: options.mode ?? 'clone',
    cloneDir,
    ...(options.gitPath ? { gitPath: options.gitPath } : {}),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    log: (line) => logs.push(line),
    source: () => {
      sourceAsked++;
      return { type: 'local', path: source };
    },
  });
  const api = new ApiRepo(options.files);
  clearRepoSnapshots();
  const t = await bootRepoApp(db, api, {
    reads,
    ...(options.timeoutMs ? { repositoryTimeoutMs: options.timeoutMs } : {}),
  });
  const connected = await t.connect();
  return {
    t,
    api,
    reads,
    cloneDir,
    logs,
    source,
    repositoryId: connected.repositoryId,
    sourceAsked: () => sourceAsked,
  };
}

const cloneOf = (b: { cloneDir: string; t: { workspaceId: string } }, repositoryId: string) =>
  join(b.cloneDir, b.t.workspaceId, repositoryId);

/** The token is in no audit row, no response, no log line. */
async function assertNoToken(
  b: { t: { db: Sql; texts: string[] }; logs: string[] },
  extra: string[] = [],
) {
  const audit = JSON.stringify(await b.t.db.query('SELECT * FROM audit_events'));
  const haystacks = [audit, b.t.texts.join('\n'), b.logs.join('\n')];
  for (const secret of [
    TOKEN,
    Buffer.from(`x-access-token:${TOKEN}`).toString('base64'),
    ...extra,
  ]) {
    for (const text of haystacks) assert.equal(text.includes(secret), false, 'a secret leaked');
  }
}

// ---------------------------------------------------------------------------------------------
// Through the clone: the fastlane layouts

const LAYOUTS: [string, () => Files][] = [
  ['one app, ios and android folders (weather)', () => weatherApp()],
  [
    'a monorepo with a folder per app id',
    () => scannerMonorepo({ cardChangelogs: 12, scanChangelogs: 12 }),
  ],
  ['android only (maps)', () => mapsApp()],
];

for (const [name, files] of LAYOUTS) {
  test(`scan and listing from the clone equal the API result: ${name}`, async () => {
    const dbClone = await openSqliteTestDatabase();
    const dbApi = await openSqliteTestDatabase();
    try {
      const viaClone = await boot(dbClone, { files: files(), mode: 'clone' });
      const viaApi = await boot(dbApi, { files: files(), mode: 'api' });
      const urls = ['/listing'];
      if (name.includes('monorepo')) {
        urls.push(`/listing?target=${encodeURIComponent(`auto:app:${SCAN_APP}`)}`);
        urls.push(`/listing?target=${encodeURIComponent(`auto:app:${CARD_APP}`)}`);
      }
      const one = (b: typeof viaClone, method: string, path: string) =>
        b.t.call(b.t.owner, method, `/repositories/${b.repositoryId}${path}`);

      const cloneScan = await one(viaClone, 'POST', '/scan');
      const apiScan = await one(viaApi, 'POST', '/scan');
      assert.equal(cloneScan.status, 200, cloneScan.text);
      assert.equal(apiScan.status, 200);
      assert.equal(cloneScan.body.detection.kind, 'fastlane');
      assert.deepEqual(cloneScan.body.detection, apiScan.body.detection);
      assert.deepEqual(cloneScan.body.listingSources, apiScan.body.listingSources);

      for (const url of urls) {
        const fromClone = await one(viaClone, 'GET', url);
        const fromApi = await one(viaApi, 'GET', url);
        assert.equal(fromClone.status, 200, fromClone.text);
        assert.deepEqual(fromClone.body, fromApi.body, url);
        assert.equal(fromClone.body.found.appStore || fromClone.body.found.googlePlay, true);
      }

      // The clone served every read; the API connector was never asked for a file or a tree.
      assert.equal(viaClone.api.apiReads, 0);
      assert.ok(viaApi.api.apiReads > 0);
      assert.ok(existsSync(join(cloneOf(viaClone, viaClone.repositoryId), 'mrm-clone.json')));
      assert.deepEqual(viaClone.logs, []);
      const rows = await dbClone.query(
        "SELECT detail FROM audit_events WHERE action = 'repository.scan'",
      );
      assert.equal(JSON.parse(String(rows[0]?.detail)).reads, 'clone');
      await assertNoToken(viaClone);
    } finally {
      await dbClone.close();
      await dbApi.close();
    }
  });
}

dbTest(
  'the by-commit cache keeps working with real shas: a second listing lists the tree once',
  async (db) => {
    const wrapper = gitWrapper();
    const b = await boot(db, { files: weatherApp(), mode: 'clone', gitPath: wrapper.path });
    const url = `/repositories/${b.repositoryId}/listing`;
    assert.equal((await b.t.call(b.t.owner, 'GET', url)).status, 200);
    const trees = () => wrapper.calls().filter((c) => c.includes(' ls-tree ')).length;
    assert.equal(trees(), 1);
    const again = await b.t.call(b.t.owner, 'GET', url);
    assert.equal(again.status, 200);
    assert.equal(trees(), 1);
    // The commit is the one the clone resolved, not the API connector's.
    assert.match(git(b.source, 'rev-parse', 'HEAD'), /^[0-9a-f]{40}$/);
    assert.equal(b.api.resolveCalls, 0);
  },
);

dbTest(
  'a scan fetches the newest commit; a listing within the window may use the one it has',
  async (db) => {
    const b = await boot(db, { files: fastlaneFiles(), mode: 'clone', ttlMs: 60_000 });
    const listing = () => b.t.call(b.t.owner, 'GET', `/repositories/${b.repositoryId}/listing`);
    assert.equal((await listing()).body.listing.appStore.locales['en-US'].subtitle, 'Old subtitle');

    commitMore(b.source, { 'fastlane/metadata/en-US/subtitle.txt': 'Newer subtitle\n' });
    // Within the freshness window the listing does not look again.
    assert.equal((await listing()).body.listing.appStore.locales['en-US'].subtitle, 'Old subtitle');
    // A scan always fetches, and the listing after it sees the new commit.
    assert.equal(
      (await b.t.call(b.t.owner, 'POST', `/repositories/${b.repositoryId}/scan`)).status,
      200,
    );
    assert.equal(
      (await listing()).body.listing.appStore.locales['en-US'].subtitle,
      'Newer subtitle',
    );
    assert.equal(b.api.apiReads, 0);
  },
);

dbTest(
  'change set creation reads from the clone; approve and apply go through the API connector',
  async (db) => {
    const b = await boot(db, { files: fastlaneFiles(), mode: 'clone' });
    const made = await b.t.draft(b.repositoryId, 'Subtitle from a clone');
    assert.equal(made.res.status, 201, made.res.text);
    assert.deepEqual(
      made.res.body.changeSet.files.map((f: { path: string }) => f.path),
      ['fastlane/metadata/en-US/subtitle.txt'],
    );
    assert.equal(b.api.apiReads, 0, 'the change set was made from clone reads');

    assert.equal(
      (await b.t.call(b.t.owner, 'POST', `/change-sets/${made.id}/approve`)).status,
      200,
    );
    const applied = await b.t.call(b.t.owner, 'POST', `/change-sets/${made.id}/apply`);
    assert.equal(applied.status, 200, applied.text);
    assert.equal(b.api.proposals.length, 1, 'propose is the API connector');
    const branch = b.api.branches.get(applied.body.changeSet.branch);
    assert.equal(
      branch?.get('fastlane/metadata/en-US/subtitle.txt')?.trim(),
      'Subtitle from a clone',
    );
    assert.equal(b.api.apiReads, 0);
    await assertNoToken(b);
  },
);

// ---------------------------------------------------------------------------------------------
// Modes

dbTest('api mode never touches git or the clone folder', async (db) => {
  const wrapper = gitWrapper();
  const b = await boot(db, { files: fastlaneFiles(), mode: 'api', gitPath: wrapper.path });
  assert.equal(
    (await b.t.call(b.t.owner, 'POST', `/repositories/${b.repositoryId}/scan`)).status,
    200,
  );
  assert.equal(
    (await b.t.call(b.t.owner, 'GET', `/repositories/${b.repositoryId}/listing`)).status,
    200,
  );
  assert.equal((await b.t.draft(b.repositoryId)).res.status, 201);
  assert.deepEqual(wrapper.calls(), []);
  assert.equal(b.sourceAsked(), 0);
  assert.equal(existsSync(b.cloneDir), false);
  assert.ok(b.api.apiReads > 0);
  const scan = await b.t.db.query(
    "SELECT detail FROM audit_events WHERE action = 'repository.scan'",
  );
  assert.equal('reads' in JSON.parse(String(scan[0]?.detail)), false);
});

dbTest('auto uses the clone when git works, and records no fall back', async (db) => {
  const wrapper = gitWrapper();
  const b = await boot(db, { files: fastlaneFiles(), mode: 'auto', gitPath: wrapper.path });
  assert.equal(
    (await b.t.call(b.t.owner, 'POST', `/repositories/${b.repositoryId}/scan`)).status,
    200,
  );
  assert.ok(wrapper.calls().length > 0);
  assert.equal(b.api.apiReads, 0);
  assert.ok(!(await b.t.auditActions()).some((a) => a.action === 'repository.read_fallback'));
});

dbTest(
  'auto falls back to the API when git is missing, and says so in the audit log and the server log',
  async (db) => {
    const b = await boot(db, {
      files: fastlaneFiles(),
      mode: 'auto',
      gitPath: '/nonexistent/dir/git',
    });
    const scan = await b.t.call(b.t.owner, 'POST', `/repositories/${b.repositoryId}/scan`);
    assert.equal(scan.status, 200, scan.text);
    assert.equal(scan.body.detection.kind, 'fastlane');
    assert.ok(b.api.apiReads > 0, 'the API connector did the reads');

    const listing = await b.t.call(b.t.owner, 'GET', `/repositories/${b.repositoryId}/listing`);
    assert.equal(listing.status, 200, listing.text);
    assert.equal(listing.body.listing.appStore.locales['en-US'].subtitle, 'Old subtitle');

    const audit = await b.t.db.query(
      "SELECT action, detail, target_id FROM audit_events WHERE action IN ('repository.read_fallback', 'repository.scan') ORDER BY created_at",
    );
    const fallbacks = audit.filter((r) => r.action === 'repository.read_fallback');
    assert.equal(fallbacks.length, 2, 'one per request');
    const detail = JSON.parse(String(fallbacks[0]?.detail));
    assert.equal(detail.reason, 'git_missing');
    assert.equal(detail.purpose, 'repository.scan');
    assert.equal(fallbacks[0]?.target_id, b.repositoryId);
    assert.equal(JSON.parse(String(fallbacks[1]?.detail)).purpose, 'repository.listing');
    const scanDetail = JSON.parse(
      String(audit.find((r) => r.action === 'repository.scan')?.detail),
    );
    assert.equal(scanDetail.reads, 'api_fallback');
    assert.equal(scanDetail.fallback.reason, 'git_missing');

    assert.equal(b.logs.length, 2);
    assert.match(
      b.logs[0] ?? '',
      /Reads: repository\.scan of repository .* used the GitHub API instead of the clone/,
    );
    assert.match(b.logs[0] ?? '', /git_missing/);
    await assertNoToken(b);
  },
);

dbTest(
  'auto does not fall back for an error the API would repeat (a missing branch is a not_found)',
  async (db) => {
    const b = await boot(db, { files: fastlaneFiles(), mode: 'auto' });
    await b.t.db.execute("UPDATE repositories SET default_branch = 'gone' WHERE id = ?", [
      b.repositoryId,
    ]);
    const scan = await b.t.call(b.t.owner, 'POST', `/repositories/${b.repositoryId}/scan`);
    assert.equal(scan.status, 422);
    assert.equal(scan.body.error, 'github_not_found');
    assert.equal(b.api.apiReads, 0);
    assert.ok(!(await b.t.auditActions()).some((a) => a.action === 'repository.read_fallback'));
  },
);

dbTest('clone mode surfaces the error and never falls back', async (db) => {
  const b = await boot(db, {
    files: fastlaneFiles(),
    mode: 'clone',
    gitPath: '/nonexistent/dir/git',
  });
  const scan = await b.t.call(b.t.owner, 'POST', `/repositories/${b.repositoryId}/scan`);
  assert.equal(scan.status, 502, scan.text);
  assert.equal(scan.body.error, 'github_unavailable');
  assert.match(scan.body.message, /git/i);
  assert.equal(
    (await b.t.call(b.t.owner, 'GET', `/repositories/${b.repositoryId}/listing`)).status,
    502,
  );
  const draft = await b.t.call(b.t.owner, 'POST', `/repositories/${b.repositoryId}/change-sets`, {
    summary: 'Edit',
    listing: { appStore: { locales: {} }, googlePlay: { locales: {}, changelogs: {} } },
  });
  assert.equal(draft.status, 502, draft.text);
  assert.equal(b.api.apiReads, 0);
  assert.ok(!(await b.t.auditActions()).some((a) => a.action === 'repository.read_fallback'));
  assert.deepEqual(b.logs, []);
  await assertNoToken(b);
});

dbTest(
  'a token that git prints is redacted from responses, audit rows and the log, in clone and auto mode',
  async (db) => {
    const noisy = gitWrapper(`echo "fatal: something odd happened with ${TOKEN}" >&2\nexit 128`);
    const strict = await boot(db, { files: fastlaneFiles(), mode: 'clone', gitPath: noisy.path });
    const failed = await strict.t.call(
      strict.t.owner,
      'POST',
      `/repositories/${strict.repositoryId}/scan`,
    );
    assert.ok(failed.status >= 400, failed.text);
    await assertNoToken(strict);

    const second = await openSqliteTestDatabase();
    try {
      const lenient = await boot(second, {
        files: fastlaneFiles(),
        mode: 'auto',
        gitPath: noisy.path,
      });
      const scan = await lenient.t.call(
        lenient.t.owner,
        'POST',
        `/repositories/${lenient.repositoryId}/scan`,
      );
      assert.equal(scan.status, 200, scan.text);
      assert.ok(lenient.logs.length >= 1);
      assert.match(lenient.logs.join('\n'), /something odd/);
      await assertNoToken(lenient);
    } finally {
      await second.close();
    }
  },
);

dbTest('the request timeout kills a running git', async (db) => {
  const pids = join(scratch('mrm-pids-'), 'pids');
  const slow = gitWrapper(`case " $* " in *" fetch "*) echo $$ >> '${pids}'; exec sleep 30;; esac`);
  const b = await boot(db, {
    files: fastlaneFiles(),
    mode: 'auto',
    gitPath: slow.path,
    // Long enough that a busy machine has started the fetch (the clone steps before it count too).
    timeoutMs: 2500,
  });
  const started = Date.now();
  const scan = await b.t.call(b.t.owner, 'POST', `/repositories/${b.repositoryId}/scan`);
  assert.equal(scan.status, 504, scan.text);
  assert.equal(scan.body.error, 'timeout');
  assert.ok(Date.now() - started < 10_000);
  // Not a fall back: the request was out of time.
  assert.equal(b.api.apiReads, 0);
  assert.ok(existsSync(pids), 'git fetch was started');
  const pid = Number(readFileSync(pids, 'utf8').trim().split('\n')[0]);
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, 'git was killed when the request timed out');
});

dbTest(
  'folders chosen by hand outside the default set are downloaded in one request, not one by one',
  async (db) => {
    const files: Files = { 'package.json': '{"name":"x"}\n', Gemfile: 'gem "fastlane"\n' };
    for (const locale of ['en-US', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'ja']) {
      files[`store/apple/${locale}/name.txt`] = `Name ${locale}\n`;
      files[`store/apple/${locale}/description.txt`] = `Description ${locale}\n`;
      files[`store/apple/${locale}/subtitle.txt`] = `Subtitle ${locale}\n`;
    }
    files['store/apple/en-US/image.png'] = 'binary';
    const wrapper = gitWrapper();
    const b = await boot(db, { files, mode: 'clone', gitPath: wrapper.path });
    const url = `/repositories/${b.repositoryId}/listing?appStoreRoot=${encodeURIComponent('store/apple')}`;
    const res = await b.t.call(b.t.owner, 'GET', url);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.listing.appStore.locales['de-DE'].subtitle, 'Subtitle de-DE');
    assert.equal(res.body.listing.appStore.locales.ja.name, 'Name ja');
    // A local source is cloned without a filter, so there is nothing left to fetch by id; what
    // matters is that the reads did not fall to the API and no fetch was made per file.
    const fetches = wrapper.calls().filter((c) => / fetch /.test(` ${c} `));
    assert.ok(fetches.length <= 3, `${fetches.length} fetches`);
    assert.equal(b.api.apiReads, 0);
  },
);

// ---------------------------------------------------------------------------------------------
// Disconnect

dbTest('disconnect removes the clone after the transaction commits', async (db) => {
  const b = await boot(db, { files: fastlaneFiles(), mode: 'clone' });
  assert.equal(
    (await b.t.call(b.t.owner, 'POST', `/repositories/${b.repositoryId}/scan`)).status,
    200,
  );
  const dir = cloneOf(b, b.repositoryId);
  assert.ok(existsSync(dir));
  const gone = await b.t.call(b.t.owner, 'DELETE', `/repositories/${b.repositoryId}`);
  assert.ok(gone.status === 200 || gone.status === 204, gone.text);
  assert.equal(existsSync(dir), false);
  assert.equal((await b.t.call(b.t.owner, 'GET', '/repositories')).body.repositories.length, 0);
});

dbTest('a disconnect refused for open change sets keeps the clone', async (db) => {
  const b = await boot(db, { files: fastlaneFiles(), mode: 'clone' });
  assert.equal((await b.t.draft(b.repositoryId)).res.status, 201);
  const dir = cloneOf(b, b.repositoryId);
  assert.ok(existsSync(dir));
  assert.equal(
    (await b.t.call(b.t.owner, 'DELETE', `/repositories/${b.repositoryId}`)).status,
    409,
  );
  assert.ok(existsSync(dir));
});

dbTest('a clone that cannot be removed is logged and does not fail the disconnect', async (db) => {
  const b = await boot(db, { files: fastlaneFiles(), mode: 'clone' });
  assert.equal(
    (await b.t.call(b.t.owner, 'POST', `/repositories/${b.repositoryId}/scan`)).status,
    200,
  );
  // Without its marker the folder is not ours to delete: the reader refuses.
  rmSync(join(cloneOf(b, b.repositoryId), 'mrm-clone.json'));
  const gone = await b.t.call(b.t.owner, 'DELETE', `/repositories/${b.repositoryId}`);
  assert.ok(gone.status === 200 || gone.status === 204, gone.text);
  assert.equal((await b.t.call(b.t.owner, 'GET', '/repositories')).body.repositories.length, 0);
  assert.match(b.logs.join('\n'), /Could not remove the clone/);
});

// ---------------------------------------------------------------------------------------------
// Tokens and the request signal, with a stand-in for the reader

/** An in-memory reader that records what the server hands it. */
function stubReads(files: Files) {
  const seen = {
    tokens: [] as (string | (() => string | Promise<string>))[],
    signals: [] as (AbortSignal | undefined)[],
    refreshes: 0,
    warmed: [] as string[][],
  };
  const sha = 'd'.repeat(40);
  const reader = {
    async listFiles(_ref?: string, o?: { signal?: AbortSignal }) {
      seen.signals.push(o?.signal);
      return Object.keys(files).sort();
    },
    async readFile(path: string, _ref?: string, o?: { signal?: AbortSignal }) {
      seen.signals.push(o?.signal);
      return files[path];
    },
    async resolveCommit(_ref?: string, signal?: AbortSignal) {
      seen.signals.push(signal);
      return sha;
    },
    async defaultBranch() {
      return 'main';
    },
    async refresh() {
      seen.refreshes++;
      return { ref: 'main', commit: sha, changed: false, fetchedAt: 0 };
    },
    async warm(paths: readonly string[]) {
      seen.warmed.push([...paths]);
    },
    async remove() {
      return true;
    },
  };
  const reads: CloneReads = {
    mode: 'clone',
    cloneDir: '/unused',
    active: true,
    fallback: false,
    log: () => undefined,
    reader: (_target, token) => {
      seen.tokens.push(token);
      return reader as unknown as CloneReader;
    },
    remove: async () => undefined,
    removeWorkspace: async () => undefined,
  };
  return { reads, seen, reader };
}

dbTest(
  'the reader gets the PAT for github_token, and the installation token function for github_app',
  async (db) => {
    const stub = stubReads(fastlaneFiles());
    const api = new ApiRepo(fastlaneFiles());
    clearRepoSnapshots();
    const t = await bootRepoApp(db, api, { reads: stub.reads });
    const pat = await t.connect();
    assert.equal(
      (await t.call(t.owner, 'POST', `/repositories/${pat.repositoryId}/scan`)).status,
      200,
    );
    assert.deepEqual(stub.seen.tokens, [TOKEN]);
    assert.equal(stub.seen.refreshes, 1, 'a scan refreshes first');
    assert.equal(api.apiReads, 0);

    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const appCredential = await t.addCredential(
      'github_app',
      JSON.stringify({ appId: '1', installationId: '2', privateKey }),
    );
    const other = await t.call(t.owner, 'POST', '/repositories', {
      credentialId: appCredential,
      owner: 'acme',
      repo: 'other',
    });
    assert.equal(other.status, 201, other.text);
    const listing = await t.call(
      t.owner,
      'GET',
      `/repositories/${other.body.repository.id}/listing`,
    );
    assert.equal(listing.status, 200, listing.text);
    const token = stub.seen.tokens[1];
    assert.equal(typeof token, 'function');
    assert.equal(
      await (token as unknown as () => Promise<string>)(),
      'ghs_installation_token_for_tests_0123456789',
    );
    assert.equal(api.tokenCalls, 1);
  },
);

dbTest('the request signal reaches the reader and is aborted by the timeout', async (db) => {
  const stub = stubReads(fastlaneFiles());
  let seenSignal: AbortSignal | undefined;
  // A tree listing that never finishes by itself and stops when the request is aborted.
  (stub.reader as { listFiles: unknown }).listFiles = (
    _ref: unknown,
    o?: { signal?: AbortSignal },
  ) =>
    new Promise((_, reject) => {
      seenSignal = o?.signal;
      o?.signal?.addEventListener('abort', () => reject(new GithubError('network', 'cancelled')));
    });
  const api = new ApiRepo(fastlaneFiles());
  clearRepoSnapshots();
  const t = await bootRepoApp(db, api, { reads: stub.reads, repositoryTimeoutMs: 150 });
  const { repositoryId } = await t.connect();
  const scan = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/scan`);
  assert.equal(scan.status, 504);
  assert.ok(seenSignal, 'a signal was passed to listFiles');
  assert.equal(seenSignal?.aborted, true);
  assert.ok(stub.seen.signals.every((s) => s instanceof AbortSignal));
});

dbTest(
  'a listing of folders chosen by hand asks the reader to warm their text files once',
  async (db) => {
    const files: Files = {
      ...fastlaneFiles(),
      'store/apple/en-US/name.txt': 'Name\n',
      'store/apple/en-US/image.png': 'binary',
      'other/readme.txt': 'x\n',
    };
    const stub = stubReads(files);
    const api = new ApiRepo(files);
    clearRepoSnapshots();
    const t = await bootRepoApp(db, api, { reads: stub.reads });
    const { repositoryId } = await t.connect();
    await t.call(t.owner, 'GET', `/repositories/${repositoryId}/listing`);
    assert.deepEqual(stub.seen.warmed, [], 'detected folders are in the reader default warm set');
    const chosen = `/repositories/${repositoryId}/listing?appStoreRoot=${encodeURIComponent('store/apple')}`;
    assert.equal((await t.call(t.owner, 'GET', chosen)).status, 200);
    assert.deepEqual(stub.seen.warmed, [['store/apple/en-US/name.txt']]);
  },
);

// ---------------------------------------------------------------------------------------------
// The adapter

const apiStub = () => {
  const calls: string[] = [];
  class Api {
    readonly kind = 'github' as const;
    #private = 'secret field';
    async listFiles(ref?: string) {
      calls.push(`api.listFiles ${ref}`);
      return ['from-api'];
    }
    async readFile(path: string, ref?: string) {
      calls.push(`api.readFile ${path} ${ref}`);
      return 'api text';
    }
    async resolveCommit() {
      calls.push('api.resolveCommit');
      return 'a'.repeat(40);
    }
    async defaultBranch() {
      return 'main';
    }
    async propose() {
      calls.push(`api.propose ${this.#private}`);
      return { branch: 'b', url: 'u', number: 1, commitSha: 'c' };
    }
    async dispatchWorkflow() {
      return { ok: true };
    }
    async listWorkflowRuns() {
      return [];
    }
    async somethingAddedLater() {
      return `later ${this.#private}`;
    }
  }
  return { api: new Api() as unknown as Parameters<typeof withCloneReads>[0], calls };
};

const failingReader = (error: unknown): CloneReader => {
  const fail = async () => {
    throw error;
  };
  return {
    listFiles: fail,
    readFile: fail,
    resolveCommit: fail,
    defaultBranch: fail,
    refresh: fail,
    warm: fail,
    remove: async () => true,
  } as unknown as CloneReader;
};

test('the adapter reads from the reader, and everything else is the API connector, private fields included', async () => {
  const { api, calls } = apiStub();
  const reader = {
    listFiles: async () => ['from-clone'],
    readFile: async () => 'clone text',
    resolveCommit: async () => 'b'.repeat(40),
    defaultBranch: async () => 'trunk',
    refresh: async () => ({ ref: 'trunk', commit: 'b'.repeat(40), changed: false, fetchedAt: 0 }),
    warm: async () => undefined,
    remove: async () => true,
  } as unknown as CloneReader;
  const client = withCloneReads(api, reader);
  assert.deepEqual(await client.listFiles('x'), ['from-clone']);
  assert.equal(await client.readFile('a.txt', 'x'), 'clone text');
  assert.equal(await client.resolveCommit?.('main'), 'b'.repeat(40));
  assert.equal(await client.defaultBranch(), 'trunk');
  assert.equal(client.kind, 'github');
  await client.propose({} as never, {} as never);
  const later = client as unknown as { somethingAddedLater(): Promise<string> };
  assert.equal(await later.somethingAddedLater(), 'later secret field');
  assert.deepEqual(calls, ['api.propose secret field']);
});

test('with fallback, a git_missing, not_managed or unexpected failure moves the rest of the request to the API', async () => {
  for (const error of [
    new GitCloneError('unexpected', 'git is not installed', 'git_missing'),
    new GitCloneError('unexpected', 'not ours', 'not_managed'),
    new GitCloneError('unexpected', 'strange'),
    new TypeError('a bug in the reader'),
  ]) {
    const { api, calls } = apiStub();
    const seen: string[] = [];
    const client = withCloneReads(api, failingReader(error), {
      fallback: true,
      onFallback: (f) => void seen.push(`${f.operation}:${f.kind}:${f.reason}`),
    });
    assert.equal(await client.resolveCommit?.('main'), 'a'.repeat(40));
    assert.deepEqual(await client.listFiles('sha'), ['from-api']);
    assert.equal(await client.readFile('p.txt', 'sha'), 'api text');
    assert.equal(seen.length, 1, 'recorded once');
    assert.deepEqual(calls, ['api.resolveCommit', 'api.listFiles sha', 'api.readFile p.txt sha']);
    assert.equal(client.reads.fallbacks.length, 1);
  }
});

test('the adapter does not fall back without the option, on other errors, after an abort, or with no API commit resolver', async () => {
  const unexpected = new GitCloneError('unexpected', 'strange');
  const { api } = apiStub();
  await assert.rejects(withCloneReads(api, failingReader(unexpected)).listFiles('x'), unexpected);
  for (const error of [
    new GitCloneError('auth', 'no', 'git_failed'),
    new GitCloneError('not_found', 'no', 'ref_missing'),
    new GitCloneError('network', 'late', 'timeout'),
    new GithubError('too_large', 'big'),
  ]) {
    assert.equal(canFallBack(error), false, error.message);
    await assert.rejects(
      withCloneReads(api, failingReader(error), { fallback: true }).listFiles('x'),
      error,
    );
  }
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(
    withCloneReads(api, failingReader(unexpected), {
      fallback: true,
      signal: stopped.signal,
    }).listFiles('x'),
    unexpected,
  );
  // An API connector that cannot name commits has nothing to fall back to for resolveCommit.
  const noResolve = withCloneReads(new FakeRepo(), failingReader(unexpected), { fallback: true });
  await assert.rejects(() => noResolve.resolveCommit?.('main') ?? Promise.resolve(), unexpected);
});

// ---------------------------------------------------------------------------------------------
// Start-up

test('setUpReads: api mode checks nothing; auto without git reads through the API; clone without git says so', async () => {
  const dir = join(scratch('mrm-setup-'), 'clones');
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);

  const api = await setUpReads({ mode: 'api', cloneDir: dir, gitPath: '/nonexistent/git', log });
  assert.equal(api.active, false);
  assert.deepEqual(lines, []);
  assert.equal(existsSync(dir), false);

  const auto = await setUpReads({ mode: 'auto', cloneDir: dir, gitPath: '/nonexistent/git', log });
  assert.equal(auto.active, false, 'auto behaves as api');
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /git is not installed/);
  assert.match(lines[0] ?? '', /GitHub API/);

  lines.length = 0;
  const clone = await setUpReads({
    mode: 'clone',
    cloneDir: dir,
    gitPath: '/nonexistent/git',
    log,
  });
  assert.equal(clone.active, true);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /KILN_READS=clone but git is not installed/);

  lines.length = 0;
  const fresh = join(scratch('mrm-setup-'), 'deep', 'clones');
  const ok = await setUpReads({ mode: 'auto', cloneDir: fresh, gitPath: REAL_GIT, log });
  assert.equal(ok.active, true);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /^Reads: auto, git \d/);
  // Created private to the server's user.
  assert.equal(existsSync(fresh), true);
  if (process.platform !== 'win32') assert.equal(statSync(fresh).mode & 0o077, 0);
});

dbTest('auto with git missing at start behaves as api: no fall back rows, no clone', async (db) => {
  const inactive = await setUpReads({
    mode: 'auto',
    cloneDir: join(scratch('mrm-setup-'), 'clones'),
    gitPath: '/nonexistent/git',
    log: () => undefined,
    source: () => assert.fail('no clone expected'),
  });
  assert.equal(inactive.active, false);
  const api = new ApiRepo(fastlaneFiles());
  clearRepoSnapshots();
  const t = await bootRepoApp(db, api, { reads: inactive });
  const { repositoryId } = await t.connect();
  assert.equal((await t.call(t.owner, 'POST', `/repositories/${repositoryId}/scan`)).status, 200);
  assert.ok(api.apiReads > 0);
  assert.ok(!(await t.auditActions()).some((a) => a.action === 'repository.read_fallback'));
});
