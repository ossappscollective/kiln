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
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import type { Database } from '@kiln/db';
import { dbTest } from '@kiln/db/testing';
import { bootRepoApp, FakeRepo, fastlaneFiles } from './repo-test-helpers.ts';
import { createCloneReads } from './services/clone-reads.ts';
import {
  type CloneUpkeepConfig,
  createCloneUpkeep,
  IN_USE_GRACE_MS,
} from './services/clone-upkeep.ts';
import { clearRepoSnapshots } from './services/repo-snapshot.ts';

/**
 * Upkeep of the clone folder: idle pruning, the byte limit, what is never removed, a clone made
 * again after it was pruned, one fetch for simultaneous reads, and the routes. Real git
 * repositories in temp folders as the source; no network.
 */

const roots: string[] = [];
const scratch = (prefix = 'mrm-upkeep-'): string => {
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

type Files = Record<string, string>;

function writeAll(dir: string, files: Files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

function buildRepo(files: Files): string {
  const dir = join(scratch('mrm-src-'), 'source');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  writeAll(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

/** A git wrapper that logs every call, and sleeps in `fetch` while the flag file exists. */
function wrapper(): { path: string; calls: () => string[]; slow: (on: boolean) => void } {
  const dir = scratch('mrm-wrap-');
  const log = join(dir, 'calls.log');
  const flag = join(dir, 'slow');
  const path = join(dir, 'git');
  writeFileSync(
    path,
    `#!/bin/sh\necho "$@" >> '${log}'\ncase "$*" in *" fetch "*) [ -f '${flag}' ] && sleep 1;; esac\nexec '${REAL_GIT}' "$@"\n`,
  );
  chmodSync(path, 0o755);
  return {
    path,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
    slow: (on) => (on ? writeFileSync(flag, '1') : rmSync(flag, { force: true })),
  };
}

const DAY = 24 * 3600_000;
const WORKSPACE_FILES: Files = {
  'fastlane/Fastfile': 'lane :x do\nend\n',
  'a.txt': 'x'.repeat(2000),
};

async function setup(db: Database, config: Partial<CloneUpkeepConfig> = {}) {
  const cloneDir = join(scratch(), 'clones');
  const wrap = wrapper();
  const logs: string[] = [];
  const reads = createCloneReads({
    mode: 'clone',
    cloneDir,
    gitPath: wrap.path,
    log: (line) => logs.push(line),
  });
  const api = new FakeRepo();
  const t = await bootRepoApp(db, api, { reads });
  const source = buildRepo(WORKSPACE_FILES);
  const upkeep = createCloneUpkeep({
    reads,
    db,
    config: { maxBytes: 0, idleDays: 0, ...config },
    log: (line) => logs.push(line),
  });
  /** A clone of the source under `<workspace>/<id>`, last used `daysAgo` days ago. */
  const clone = async (id: string, daysAgo: number, workspaceId = t.workspaceId) => {
    const reader = reads.reader(
      {
        workspaceId,
        repositoryId: id,
        owner: 'o',
        repo: 'r',
        defaultBranch: 'main',
        source: { type: 'local', path: source },
      },
      '',
    );
    await reader.refresh();
    await reader.listFiles();
    age(workspaceId, id, daysAgo);
    return { reader, dir: join(cloneDir, workspaceId, id) };
  };
  const age = (workspaceId: string, id: string, daysAgo: number, extraMs = 0) => {
    const when = new Date(Date.now() - daysAgo * DAY - extraMs);
    utimesSync(join(cloneDir, workspaceId, id, 'mrm-clone.json'), when, when);
  };
  const exists = (id: string, workspaceId = t.workspaceId) =>
    existsSync(join(cloneDir, workspaceId, id));
  const prunes = async () =>
    (await t.auditActions())
      .filter((a) => a.action === 'clone.prune')
      .map((a) => ({ ...a, detail: JSON.parse(a.detail) }));
  return { t, reads, cloneDir, wrap, logs, source, upkeep, clone, age, exists, prunes };
}

// ---------------------------------------------------------------------------------------------
// Idle pruning

dbTest('a sweep removes clones idle longer than the limit and keeps the others', async (db) => {
  const s = await setup(db, { idleDays: 30 });
  await s.clone('old', 40);
  await s.clone('older', 31);
  await s.clone('recent', 5);
  const result = await s.upkeep.sweep();
  assert.equal(result.scanned, 3);
  assert.equal(result.removed, 2);
  assert.equal(result.idle, 2);
  assert.equal(result.budget, 0);
  assert.ok(result.freedBytes > 0);
  assert.equal(result.bytesAfter, result.bytesBefore - result.freedBytes);
  assert.equal(s.exists('old'), false);
  assert.equal(s.exists('older'), false);
  assert.equal(s.exists('recent'), true);
  // One audit row for the workspace, with counts and no path.
  const rows = await s.prunes();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.actorType, 'system');
  assert.equal(rows[0]?.detail.removed, 2);
  assert.equal(rows[0]?.detail.idle, 2);
  assert.equal(rows[0]?.detail.freedBytes, result.freedBytes);
  assert.doesNotMatch(
    rows[0]?.detail ? JSON.stringify(rows[0].detail) : '',
    /clones|mrm-upkeep|\//,
  );
  assert.ok(s.logs.some((l) => /Clones: removed 2 \(2 idle, 0 over the limit\)/.test(l)));
  // Nothing due: no row, no log line.
  const again = await s.upkeep.sweep();
  assert.equal(again.removed, 0);
  assert.equal((await s.prunes()).length, 1);
});

dbTest('idle days 0 never prunes for age, and no limit prunes nothing at all', async (db) => {
  const s = await setup(db, { idleDays: 0, maxBytes: 0 });
  await s.clone('ancient', 900);
  const result = await s.upkeep.sweep();
  assert.equal(result.removed, 0);
  assert.equal(s.exists('ancient'), true);
});

// ---------------------------------------------------------------------------------------------
// The byte limit: least recently used first

dbTest(
  'over the byte limit, the least recently used clones go first, until it fits',
  async (db) => {
    const s = await setup(db, { idleDays: 0, maxBytes: 0 });
    await s.clone('c4', 4);
    await s.clone('c3', 3);
    await s.clone('c2', 2);
    await s.clone('c1', 1);
    const sizes = Object.fromEntries(
      (await s.upkeep.report(s.t.workspaceId)).clones.map((c) => [c.repositoryId, c.bytes]),
    );
    assert.ok(sizes.c1 && sizes.c2 && sizes.c3 && sizes.c4);
    // Room for the two newest only.
    const limit = (sizes.c1 as number) + (sizes.c2 as number) + 10;
    const bounded = createCloneUpkeep({
      reads: s.reads,
      db,
      config: { maxBytes: limit, idleDays: 0 },
      log: () => undefined,
    });
    const result = await bounded.sweep();
    assert.equal(result.budget, 2);
    assert.equal(result.idle, 0);
    assert.equal(result.overBudget, false);
    assert.ok(result.bytesAfter <= limit);
    assert.deepEqual(
      [s.exists('c4'), s.exists('c3'), s.exists('c2'), s.exists('c1')],
      [false, false, true, true],
    );
    const rows = await s.prunes();
    assert.equal(rows[0]?.detail.budget, 2);
  },
);

dbTest(
  'idle ones go before the budget is looked at, and the budget works across workspaces',
  async (db) => {
    const s = await setup(db, { idleDays: 10, maxBytes: 0 });
    const other = 'ws-other';
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES (?, 'Other', 0)", [
      other,
    ]);
    await s.clone('mine-old', 20);
    await s.clone('mine-new', 1);
    await s.clone('theirs-new', 2, other);
    const sizes = (await s.upkeep.report(s.t.workspaceId)).clones;
    const one = sizes.find((c) => c.repositoryId === 'mine-new')?.bytes ?? 0;
    const bounded = createCloneUpkeep({
      reads: s.reads,
      db,
      config: { maxBytes: one + 10, idleDays: 10 },
      log: () => undefined,
    });
    const result = await bounded.sweep();
    assert.equal(result.idle, 1, 'mine-old is idle');
    assert.equal(result.budget, 1, 'then the least recent of the two left');
    assert.equal(s.exists('mine-old'), false);
    assert.equal(s.exists('theirs-new', other), false, 'it was the older of the two that fit');
    assert.equal(s.exists('mine-new'), true);
    // One audit row per workspace, each with its own count.
    const rows = await s.prunes();
    assert.deepEqual(rows.map((r) => r.detail.removed).sort(), [1, 1]);
  },
);

dbTest(
  'clones that are used now are never removed, even over the limit; the sweep says so',
  async (db) => {
    const s = await setup(db, { idleDays: 0, maxBytes: 0 });
    await s.clone('busy-in-a-minute', 0);
    s.age(s.t.workspaceId, 'busy-in-a-minute', 0, 60_000);
    await s.clone('idle', 2);
    const tiny = createCloneUpkeep({
      reads: s.reads,
      db,
      config: { maxBytes: 1, idleDays: 0 },
      log: (l) => s.logs.push(l),
    });
    const result = await tiny.sweep();
    assert.equal(s.exists('busy-in-a-minute'), true, 'used within the grace period');
    assert.equal(s.exists('idle'), false);
    assert.equal(result.skippedInUse, 1);
    assert.equal(result.overBudget, true);
    assert.ok(s.logs.some((l) => /Still over KILN_CLONE_MAX_BYTES/.test(l)));
    assert.ok(IN_USE_GRACE_MS >= 5 * 60_000);
  },
);

dbTest('a clone whose lock is held is skipped even when it is idle', async (db) => {
  const s = await setup(db, { idleDays: 1, maxBytes: 0 });
  const { reader } = await s.clone('held', 40);
  s.wrap.slow(true);
  const running = reader.refresh();
  await new Promise((done) => setTimeout(done, 400));
  const during = await s.upkeep.sweep();
  assert.equal(during.removed, 0);
  assert.equal(during.skippedInUse, 1);
  assert.equal(s.exists('held'), true);
  await running;
  s.wrap.slow(false);
  // The fetch has finished (and does not touch an already touched reader): now it is just idle.
  s.age(s.t.workspaceId, 'held', 40);
  const after = await s.upkeep.sweep();
  assert.equal(after.removed, 1);
  assert.equal(s.exists('held'), false);
});

// ---------------------------------------------------------------------------------------------
// Containment

dbTest(
  'links and strangers are never followed or removed, and the sweep says it refused them',
  async (db) => {
    const s = await setup(db, { idleDays: 1, maxBytes: 1 });
    await s.clone('real-old', 40);
    // A folder that is not a clone of ours, in the clone folder.
    mkdirSync(join(s.cloneDir, s.t.workspaceId, 'stranger'), { recursive: true });
    writeFileSync(join(s.cloneDir, s.t.workspaceId, 'stranger', 'precious.txt'), 'mine');
    // A look-alike outside the folder, reached through links at both levels.
    const outside = scratch('mrm-outside-');
    mkdirSync(join(outside, 'victim'), { recursive: true });
    writeFileSync(
      join(outside, 'victim', 'mrm-clone.json'),
      '{"version":1,"url":"x","createdAt":1}',
    );
    writeFileSync(join(outside, 'victim', 'precious.txt'), 'outside');
    const when = new Date(Date.now() - 400 * DAY);
    utimesSync(join(outside, 'victim', 'mrm-clone.json'), when, when);
    symlinkSync(join(outside, 'victim'), join(s.cloneDir, s.t.workspaceId, 'linked-clone'));
    symlinkSync(outside, join(s.cloneDir, 'linked-workspace'));
    // A clone folder whose marker is a link to a file outside.
    mkdirSync(join(s.cloneDir, s.t.workspaceId, 'marker-link'));
    symlinkSync(
      join(outside, 'victim', 'mrm-clone.json'),
      join(s.cloneDir, s.t.workspaceId, 'marker-link', 'mrm-clone.json'),
    );

    const result = await s.upkeep.sweep();
    assert.equal(result.removed, 1, 'only the real, idle clone');
    assert.equal(result.refused, 4);
    assert.equal(s.exists('real-old'), false);
    assert.equal(readFileSync(join(outside, 'victim', 'precious.txt'), 'utf8'), 'outside');
    assert.equal(
      readFileSync(join(s.cloneDir, s.t.workspaceId, 'stranger', 'precious.txt'), 'utf8'),
      'mine',
    );
    assert.deepEqual(readdirSync(join(outside, 'victim')).sort(), [
      'mrm-clone.json',
      'precious.txt',
    ]);
    // The listing does not show them either.
    assert.deepEqual((await s.upkeep.report(s.t.workspaceId)).clones, []);
  },
);

// ---------------------------------------------------------------------------------------------
// A pruned clone is made again

dbTest(
  'after a prune the next read clones again, transparently, through the same reader',
  async (db) => {
    const s = await setup(db, { idleDays: 1 });
    const { reader, dir } = await s.clone('again', 40);
    assert.deepEqual(await reader.listFiles(), ['a.txt', 'fastlane/Fastfile']);
    assert.equal((await s.upkeep.sweep()).removed, 1);
    assert.equal(existsSync(dir), false);
    // The pooled reader still has what it learned; its caches were cleared with the clone.
    assert.deepEqual(await reader.listFiles(), ['a.txt', 'fastlane/Fastfile']);
    assert.equal(await reader.readFile('fastlane/Fastfile'), 'lane :x do\nend\n');
    assert.equal(existsSync(dir), true);
    // And it counts as used again: the next sweep leaves it.
    assert.equal((await s.upkeep.sweep()).removed, 0);
  },
);

// ---------------------------------------------------------------------------------------------
// The app: single flight, and the routes

async function bootApp(db: Database, config: Partial<CloneUpkeepConfig> = {}) {
  const cloneDir = join(scratch(), 'clones');
  const wrap = wrapper();
  const source = buildRepo(fastlaneFiles());
  const reads = createCloneReads({
    mode: 'clone',
    cloneDir,
    gitPath: wrap.path,
    log: () => undefined,
    source: () => ({ type: 'local', path: source }),
  });
  clearRepoSnapshots();
  const api = new FakeRepo();
  // Built here (as index.ts does) and handed to the app, so the test can sweep the same one.
  const upkeep = createCloneUpkeep({
    reads,
    db,
    config: { maxBytes: 0, idleDays: 0, ...config },
    log: () => undefined,
  });
  const t = await bootRepoApp(db, api, { reads, cloneUpkeep: upkeep });
  const { repositoryId } = await t.connect();
  const fetches = () => wrap.calls().filter((c) => / fetch /.test(c)).length;
  return { t, reads, cloneDir, wrap, source, upkeep, repositoryId, fetches };
}

dbTest(
  'single flight: simultaneous scans and listings of one repository share one clone refresh',
  async (db) => {
    const b = await bootApp(db);
    const { t, repositoryId } = b;
    const scan = () => t.call(t.owner, 'POST', `/repositories/${repositoryId}/scan`);
    // What one scan costs on a fresh clone.
    const first = await scan();
    assert.equal(first.status, 200, first.text);
    const one = b.fetches();
    assert.ok(one >= 1);
    assert.equal(
      (await t.call(t.owner, 'POST', `/repositories/${repositoryId}/clone/purge`)).status,
      200,
    );

    // Slow the fetch so the requests overlap, then ask three times, plus two listings.
    b.wrap.slow(true);
    const before = b.fetches();
    const all = await Promise.all([
      scan(),
      scan(),
      scan(),
      t.call(t.owner, 'GET', `/repositories/${repositoryId}/listing`),
      t.call(t.owner, 'GET', `/repositories/${repositoryId}/listing`),
    ]);
    b.wrap.slow(false);
    for (const res of all) assert.equal(res.status, 200, res.text);
    assert.equal(b.fetches() - before, one, 'five requests, the cost of one');
    assert.equal(all[0]?.body.detection.kind, all[2]?.body.detection.kind);
  },
);

dbTest(
  'single flight: a scan after the first finished fetches again (it asked for the newest)',
  async (db) => {
    const b = await bootApp(db);
    const scan = () => b.t.call(b.t.owner, 'POST', `/repositories/${b.repositoryId}/scan`);
    await scan();
    const one = b.fetches();
    await scan();
    assert.ok(b.fetches() > one, 'not served from the previous answer');
  },
);

const clonePath = (id: string) => `/repositories/${id}/clone`;

dbTest(
  "GET /clones: size and last use of this workspace's clones, for admin and owner only",
  async (db) => {
    const b = await bootApp(db);
    const { t, repositoryId } = b;
    const empty = await t.call(t.owner, 'GET', '/clones');
    assert.equal(empty.status, 200, empty.text);
    assert.deepEqual(empty.body.clones, []);
    assert.equal(empty.body.enabled, true);
    await t.call(t.owner, 'POST', `/repositories/${repositoryId}/scan`);
    const res = await t.call(t.owner, 'GET', '/clones');
    assert.equal(res.body.clones.length, 1);
    const [one] = res.body.clones;
    assert.equal(one.repositoryId, repositoryId);
    assert.equal(one.name, 'acme/app');
    assert.equal(one.kind, 'github');
    assert.ok(one.bytes > 0);
    assert.equal(one.sizeIsLowerBound, false);
    assert.ok(Math.abs(one.lastUsedAt - Date.now()) < 60_000);
    assert.equal(one.inUse, true, 'used a moment ago');
    assert.equal(res.body.totalBytes, one.bytes);
    assert.deepEqual(res.body.limits, { maxBytes: 0, idleDays: 0 });
    // No path of the server anywhere.
    assert.doesNotMatch(res.text, new RegExp(b.cloneDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    // Roles: members and viewers may not list; a viewer may see one repository's clone.
    const member = await t.addMember('member');
    const viewer = await t.addMember('viewer');
    assert.equal((await t.call(member, 'GET', '/clones')).status, 403);
    assert.equal((await t.call(viewer, 'GET', '/clones')).status, 403);
    assert.equal((await t.call(viewer, 'GET', clonePath(repositoryId))).status, 200);
    const single = await t.call(t.owner, 'GET', clonePath(repositoryId));
    assert.equal(single.body.clone.repositoryId, repositoryId);
    assert.equal(single.body.enabled, true);
    assert.equal((await t.call(t.owner, 'GET', clonePath('nope'))).status, 404);
  },
);

dbTest(
  "GET /clones does not show another workspace's clones, and a repository id of another workspace is a 404",
  async (db) => {
    const b = await bootApp(db);
    const { t, repositoryId } = b;
    await t.call(t.owner, 'POST', `/repositories/${repositoryId}/scan`);
    // A second workspace with its own owner and a clone of its own.
    const { createSession } = await import('./services/accounts.ts');
    await db.execute(
      'INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, 0)',
      ['u2', 'u2@x.io', 'U2'],
    );
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('ws2', 'Two', 0)");
    await db.execute(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws2', 'u2', 'owner')",
    );
    const cookie = `mrm_session=${(await createSession(db, 'u2', Date.now())).token}`;
    b.reads.reader(
      {
        workspaceId: 'ws2',
        repositoryId: 'secret-repo',
        owner: 'o',
        repo: 'r',
        defaultBranch: 'main',
        source: { type: 'local', path: b.source },
      },
      '',
    );
    await b.reads
      .reader(
        {
          workspaceId: 'ws2',
          repositoryId: 'secret-repo',
          owner: 'o',
          repo: 'r',
          defaultBranch: 'main',
          source: { type: 'local', path: b.source },
        },
        '',
      )
      .refresh();

    const mine = await t.call(t.owner, 'GET', '/clones');
    assert.deepEqual(
      mine.body.clones.map((c: { repositoryId: string }) => c.repositoryId),
      [repositoryId],
    );
    const theirs = await t.call(cookie, 'GET', '/clones', undefined, 'ws2');
    assert.deepEqual(
      theirs.body.clones.map((c: { repositoryId: string }) => c.repositoryId),
      ['secret-repo'],
    );
    assert.equal(theirs.body.clones[0].name, null, 'no repository row: shown as left over');
    assert.equal(
      (await t.call(cookie, 'POST', clonePath(repositoryId).concat('/purge'), undefined, 'ws2'))
        .status,
      404,
    );
    assert.equal(
      (await t.call(cookie, 'GET', '/clones')).status,
      404,
      'not a member of the first workspace',
    );
    assert.ok(existsSync(join(b.cloneDir, t.workspaceId, repositoryId)), 'untouched');
  },
);

dbTest(
  "POST purge frees one repository's clone now, audits it, and the next read clones again",
  async (db) => {
    const b = await bootApp(db);
    const { t, repositoryId } = b;
    await t.call(t.owner, 'POST', `/repositories/${repositoryId}/scan`);
    const dir = join(b.cloneDir, t.workspaceId, repositoryId);
    assert.ok(existsSync(dir));
    const member = await t.addMember('member');
    assert.equal((await t.call(member, 'POST', `${clonePath(repositoryId)}/purge`)).status, 403);
    assert.ok(existsSync(dir));
    const done = await t.call(t.owner, 'POST', `${clonePath(repositoryId)}/purge`);
    assert.equal(done.status, 200, done.text);
    assert.equal(done.body.removed, 1);
    assert.ok(done.body.freedBytes > 0);
    assert.equal(existsSync(dir), false);
    const audit = (await t.auditActions()).filter((a) => a.action === 'clone.purge');
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.targetId, repositoryId);
    assert.equal(JSON.parse(audit[0]?.detail ?? '{}').removed, 1);
    assert.doesNotMatch(audit[0]?.detail ?? '', /clones/);
    // Nothing to remove: not an error.
    const none = await t.call(t.owner, 'POST', `${clonePath(repositoryId)}/purge`);
    assert.equal(none.status, 200);
    assert.equal(none.body.removed, 0);
    assert.equal((await t.call(t.owner, 'POST', `${clonePath('nope')}/purge`)).status, 404);
    // A scan makes it again.
    assert.equal((await t.call(t.owner, 'POST', `/repositories/${repositoryId}/scan`)).status, 200);
    assert.ok(existsSync(dir));
  },
);

dbTest(
  'POST purge while a read holds the clone is 409 clone_busy and removes nothing',
  async (db) => {
    const b = await bootApp(db);
    const { t, repositoryId } = b;
    await t.call(t.owner, 'POST', `/repositories/${repositoryId}/scan`);
    b.wrap.slow(true);
    const scan = t.call(t.owner, 'POST', `/repositories/${repositoryId}/scan`);
    await new Promise((done) => setTimeout(done, 400));
    const refused = await t.call(t.owner, 'POST', `${clonePath(repositoryId)}/purge`);
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.error, 'clone_busy');
    assert.ok(existsSync(join(b.cloneDir, t.workspaceId, repositoryId)));
    assert.equal((await scan).status, 200);
    b.wrap.slow(false);
  },
);

dbTest('disconnecting a repository still removes its clones', async (db) => {
  const b = await bootApp(db);
  const { t, repositoryId } = b;
  await t.call(t.owner, 'POST', `/repositories/${repositoryId}/scan`);
  assert.equal((await t.call(t.owner, 'DELETE', `/repositories/${repositoryId}`)).status, 204);
  assert.equal(existsSync(join(b.cloneDir, t.workspaceId, repositoryId)), false);
});

dbTest('without clones (KILN_READS=api) the routes answer, with nothing to show', async (db) => {
  const t = await bootRepoApp(db);
  const { repositoryId } = await t.connect();
  const list = await t.call(t.owner, 'GET', '/clones');
  assert.equal(list.status, 200);
  assert.equal(list.body.enabled, false);
  assert.deepEqual(list.body.clones, []);
  const one = await t.call(t.owner, 'GET', clonePath(repositoryId));
  assert.equal(one.body.clone, null);
  assert.equal(one.body.enabled, false);
  assert.deepEqual((await t.call(t.owner, 'POST', `${clonePath(repositoryId)}/purge`)).body, {
    removed: 0,
    freedBytes: 0,
  });
});

dbTest('the scheduler sweeps on its interval, through the same upkeep', async (db) => {
  const b = await bootApp(db, { idleDays: 1 });
  const { createScheduler } = await import('./scheduler.ts');
  await b.t.call(b.t.owner, 'POST', `/repositories/${b.repositoryId}/scan`);
  utimesSync(
    join(b.cloneDir, b.t.workspaceId, b.repositoryId, 'mrm-clone.json'),
    new Date(Date.now() - 5 * DAY),
    new Date(Date.now() - 5 * DAY),
  );
  let clock = 1_000_000;
  let runs = 0;
  const scheduler = createScheduler({
    db,
    now: () => clock,
    cloneSweep: {
      intervalMs: 60 * 60_000,
      run: async () => {
        runs++;
        return b.upkeep.sweep();
      },
    },
  });
  const first = await scheduler.tick();
  assert.equal(runs, 1, 'the first tick sweeps');
  assert.equal((first.cloneSweep as { removed: number }).removed, 1);
  clock += 59 * 60_000;
  assert.equal((await scheduler.tick()).cloneSweep, undefined);
  clock += 2 * 60_000;
  assert.notEqual((await scheduler.tick()).cloneSweep, undefined);
  assert.equal(runs, 2);
  // A failing sweep is reported and does not stop the tick.
  const errors: string[] = [];
  const failing = createScheduler({
    db,
    now: () => clock,
    cloneSweep: {
      intervalMs: 60_000,
      run: async () => {
        throw new Error('boom');
      },
    },
    onError: (message) => errors.push(message),
  });
  await failing.tick();
  assert.deepEqual(errors, ['clone sweep failed']);
});
