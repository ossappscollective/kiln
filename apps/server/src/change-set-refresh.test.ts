import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { GithubError } from '@kiln/connectors';
import type { FileChange } from '@kiln/core';
import type { Database } from '@kiln/db';
import { dbTest } from '@kiln/db/testing';
import { buildRepo, git, gitWrapper } from './local-git-test-helpers.ts';
import { bootRepoApp, FakeRepo, fastlaneFiles } from './repo-test-helpers.ts';
import { evaluateFile, resolveConflict } from './services/change-set-refresh.ts';
import { createCloneReads } from './services/clone-reads.ts';
import { clearRepoSnapshots } from './services/repo-snapshot.ts';

const dirs: string[] = [];
const scratch = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kiln-refresh-')));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const NAME = 'fastlane/metadata/en-US/name.txt';
const SUBTITLE = 'fastlane/metadata/en-US/subtitle.txt';
const DESCRIPTION = 'fastlane/metadata/en-US/description.txt';
const DE_SUBTITLE = 'fastlane/metadata/de-DE/subtitle.txt';

const DESCRIPTION_OLD =
  'Line one of the text.\nLine two of the text.\nLine three of the text.\nLine four of the text.\nLine five of the text.\n';
const DESCRIPTION_OURS = DESCRIPTION_OLD.replace('Line one', 'Line ONE');
const DESCRIPTION_THEIRS = DESCRIPTION_OLD.replace('Line five', 'Line FIVE');
const DESCRIPTION_BOTH = DESCRIPTION_OURS.replace('Line five', 'Line FIVE');

function files(): Record<string, string> {
  return { ...fastlaneFiles(), [DESCRIPTION]: DESCRIPTION_OLD };
}

// ---------------------------------------------------------------------------------------------
// The pure part

const mod = (path: string, before: string, after: string): FileChange => ({ path, before, after });

test('evaluateFile: unchanged, already there, merged', () => {
  const file = mod('a.txt', 'a\nb\nc\nd\ne\n', 'A\nb\nc\nd\ne\n');
  assert.deepEqual(evaluateFile(file, 'a\nb\nc\nd\ne\n'), { state: 'same' });
  assert.deepEqual(evaluateFile(file, 'A\nb\nc\nd\ne\n'), { state: 'already_applied' });
  assert.deepEqual(evaluateFile(file, 'a\nb\nc\nd\nE\n'), {
    state: 'changed',
    file: { path: 'a.txt', before: 'a\nb\nc\nd\nE\n', after: 'A\nb\nc\nd\nE\n' },
  });
  // Theirs has our change and one more: the merge is what is there, so there is nothing to apply.
  assert.deepEqual(evaluateFile(file, 'A\nb\nc\nd\nE\n'), { state: 'already_applied' });
});

test('evaluateFile: conflicts say what kind and carry the three texts', () => {
  const file = mod('a.txt', 'one\n', 'ours\n');
  assert.deepEqual(evaluateFile(file, 'theirs\n'), {
    state: 'conflict',
    reason: 'overlap',
    base: 'one\n',
    ours: 'ours\n',
    theirs: 'theirs\n',
  });
  // We add a file that exists now with other text.
  assert.deepEqual(evaluateFile({ path: 'n.txt', after: 'x\n' }, 'y\n'), {
    state: 'conflict',
    reason: 'added_upstream',
    base: undefined,
    ours: 'x\n',
    theirs: 'y\n',
  });
  assert.deepEqual(evaluateFile({ path: 'n.txt', after: 'x\n' }, undefined), { state: 'same' });
  assert.deepEqual(evaluateFile({ path: 'n.txt', after: 'x\n' }, 'x\n'), {
    state: 'already_applied',
  });
  // We delete a file that was edited, or is already gone, or is untouched.
  assert.equal(
    (evaluateFile({ path: 'd.txt', before: 'x\n' }, 'edited\n') as { reason: string }).reason,
    'edited_upstream',
  );
  assert.deepEqual(evaluateFile({ path: 'd.txt', before: 'x\n' }, undefined), {
    state: 'already_applied',
  });
  assert.deepEqual(evaluateFile({ path: 'd.txt', before: 'x\n' }, 'x\n'), { state: 'same' });
  // We edit a file that was deleted.
  assert.equal((evaluateFile(file, undefined) as { reason: string }).reason, 'deleted_upstream');
});

test('evaluateFile: JSON that merges as text must still parse', () => {
  const base = '{\n  "a": 1,\n  "b": 2,\n  "c": 3,\n  "d": 4,\n  "e": 5\n}\n';
  const ours = base.replace('"e": 5', '"e": 50');
  // Theirs edits another entry: a clean merge that parses.
  const fine = evaluateFile(
    mod('store.config.json', base, ours),
    base.replace('"a": 1', '"a": 10'),
  );
  assert.equal(fine.state, 'changed');
  if (fine.state === 'changed') assert.equal(JSON.parse(fine.file.after ?? '').e, 50);
  // Theirs drops the comma after "b": textually a clean merge, but the result is not JSON.
  const broken = evaluateFile(
    mod('store.config.json', base, ours),
    base.replace('"b": 2,', '"b": 2'),
  );
  assert.equal(broken.state === 'conflict' ? broken.reason : broken.state, 'invalid_json');
  // A file named .json whose own text is not JSON is not held to it.
  assert.equal(
    evaluateFile(mod('notes.json', 'a\nb\nc\nd\ne\n', 'A\nb\nc\nd\ne\n'), 'a\nb\nc\nd\nE\n').state,
    'changed',
  );
});

test('resolveConflict: mine overwrites theirs (their text becomes the base), theirs drops the file', () => {
  const file = mod('a.txt', 'one\n', 'ours\n');
  assert.deepEqual(resolveConflict(file, 'theirs\n', 'mine'), {
    path: 'a.txt',
    before: 'theirs\n',
    after: 'ours\n',
  });
  assert.equal(resolveConflict(file, 'theirs\n', 'theirs'), undefined);
  // Theirs deleted the file and we keep ours: it becomes an added file.
  assert.deepEqual(resolveConflict(file, undefined, 'mine'), { path: 'a.txt', after: 'ours\n' });
  // We delete, theirs edited, we keep ours: a deletion of what is there now.
  assert.deepEqual(resolveConflict({ path: 'd.txt', before: 'x\n' }, 'edited\n', 'mine'), {
    path: 'd.txt',
    before: 'edited\n',
  });
});

// ---------------------------------------------------------------------------------------------
// The API

async function boot(db: Database, repoFiles: Record<string, string> = files()) {
  const repo = new FakeRepo();
  repo.files = new Map(Object.entries(repoFiles));
  const t = await bootRepoApp(db, repo);
  const { repositoryId } = await t.connect();
  await t.call(t.owner, 'POST', `/repositories/${repositoryId}/scan`);
  return { t, repo, repositoryId };
}
type Booted = Awaited<ReturnType<typeof boot>>;

/** A draft that changes name, subtitle, description and the German subtitle. */
async function draftFour(b: Booted, summary = 'Update the listing') {
  const read = await b.t.call(b.t.owner, 'GET', `/repositories/${b.repositoryId}/listing`);
  const listing = read.body.listing;
  listing.appStore.locales['en-US'].name = 'Acme Pro';
  listing.appStore.locales['en-US'].subtitle = 'Our subtitle';
  listing.appStore.locales['en-US'].description = DESCRIPTION_OURS.trimEnd();
  listing.appStore.locales['de-DE'].subtitle = 'Unser Untertitel';
  const made = await b.t.call(b.t.owner, 'POST', `/repositories/${b.repositoryId}/change-sets`, {
    summary,
    listing,
  });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.body.changeSet.filesChanged, 4);
  return made.body.changeSet.id as string;
}

const set = async (b: Booted, id: string) =>
  (await b.t.call(b.t.owner, 'GET', `/change-sets/${id}`)).body.changeSet;
const refresh = (b: Booted, id: string, body?: unknown, cookie = b.t.owner) =>
  b.t.call(cookie, 'POST', `/change-sets/${id}/refresh`, body);
const staleness = (b: Booted, id: string, cookie = b.t.owner) =>
  b.t.call(cookie, 'GET', `/change-sets/${id}/staleness`);
const approve = (b: Booted, id: string) =>
  b.t.call(b.t.owner, 'POST', `/change-sets/${id}/approve`);
const refreshAudit = async (b: Booted) =>
  (await b.t.auditActions()).filter((a) => a.action === 'changeset.refresh');

/** The repository moves on: name is already what we want, subtitle is changed differently, the description in another line. */
function moveOn(b: Booted) {
  b.repo.files.set(NAME, 'Acme Pro\n');
  b.repo.files.set(SUBTITLE, 'Their subtitle\n');
  b.repo.files.set(DESCRIPTION, DESCRIPTION_THEIRS);
}

dbTest('staleness: one state per file, read only', async (db) => {
  const b = await boot(db);
  const id = await draftFour(b);
  const fresh = await staleness(b, id);
  assert.equal(fresh.status, 200, fresh.text);
  assert.equal(fresh.body.stale, false);
  assert.deepEqual(
    fresh.body.files.map((f: { state: string }) => f.state),
    ['same', 'same', 'same', 'same'],
  );
  moveOn(b);
  const before = await set(b, id);
  const res = await staleness(b, id);
  assert.equal(res.body.stale, true);
  const states = Object.fromEntries(
    res.body.files.map((f: { path: string; state: string }) => [f.path, f.state]),
  );
  assert.deepEqual(states, {
    [NAME]: 'already_applied',
    [SUBTITLE]: 'conflict',
    [DESCRIPTION]: 'changed',
    [DE_SUBTITLE]: 'same',
  });
  assert.equal(typeof res.body.readAt, 'string');
  // Nothing was written: the same row, and no audit event of a refresh.
  assert.deepEqual(await set(b, id), before);
  assert.equal((await refreshAudit(b)).length, 0);
  // The answer carries no file text.
  assert.doesNotMatch(res.text, /Their subtitle|Line FIVE/);
});

dbTest(
  'refresh: a conflict changes nothing and reports the three texts; choices settle it',
  async (db) => {
    const b = await boot(db);
    const id = await draftFour(b);
    assert.equal((await approve(b, id)).status, 200);
    moveOn(b);
    const original = await set(b, id);

    const first = await refresh(b, id);
    assert.equal(first.status, 409, first.text);
    assert.equal(first.body.error, 'refresh_conflicts');
    assert.equal(first.body.conflicts, 1);
    const conflict = first.body.files.find((f: { outcome: string }) => f.outcome === 'conflict');
    assert.equal(conflict.path, SUBTITLE);
    assert.equal(conflict.reason, 'overlap');
    assert.equal(conflict.base, 'Old subtitle\n');
    assert.equal(conflict.ours, 'Our subtitle\n');
    assert.equal(conflict.theirs, 'Their subtitle\n');
    // As it was: still approved, same files, same time.
    assert.deepEqual(await set(b, id), original);
    assert.equal(original.status, 'approved');
    assert.equal((await refreshAudit(b)).length, 0);

    // 'theirs' drops our subtitle; the name leaves (already there); the description is merged; the German one stays.
    const done = await refresh(b, id, { resolutions: { [SUBTITLE]: 'theirs' } });
    assert.equal(done.status, 200, done.text);
    assert.equal(done.body.unchanged, false);
    assert.equal(done.body.nothingLeft, false);
    assert.equal(done.body.approvalCleared, true);
    assert.equal(done.body.refreshedFrom, 'main');
    const outcomes = Object.fromEntries(
      done.body.files.map((f: { path: string; outcome: string }) => [f.path, f.outcome]),
    );
    assert.deepEqual(outcomes, {
      [NAME]: 'dropped',
      [SUBTITLE]: 'kept_theirs',
      [DESCRIPTION]: 'merged',
      [DE_SUBTITLE]: 'unchanged',
    });
    for (const f of done.body.files)
      assert.equal(f.ours, undefined, 'no file text for settled files');
    const cs = done.body.changeSet;
    assert.equal(cs.id, id);
    assert.equal(cs.status, 'draft');
    assert.equal(cs.approvedBy, null);
    assert.equal(cs.approvedAt, null);
    assert.equal(cs.error, null);
    assert.deepEqual(
      cs.files.map((f: { path: string }) => f.path),
      [DE_SUBTITLE, DESCRIPTION],
    );
    const description = cs.files.find((f: { path: string }) => f.path === DESCRIPTION);
    assert.equal(description.before, DESCRIPTION_THEIRS);
    assert.equal(description.after, DESCRIPTION_BOTH);
    assert.equal(
      cs.files.find((f: { path: string }) => f.path === DE_SUBTITLE).before,
      'Alter Untertitel\n',
    );

    // The audit row has counts and the commit, never text.
    const audit = await refreshAudit(b);
    assert.equal(audit.length, 1);
    const detail = JSON.parse(audit[0]?.detail ?? '{}');
    assert.deepEqual(
      {
        merged: detail.merged,
        dropped: detail.dropped,
        keptTheirs: detail.keptTheirs,
        keptMine: detail.keptMine,
        unchanged: detail.unchanged,
        approvalCleared: detail.approvalCleared,
        was: detail.was,
      },
      {
        merged: 1,
        dropped: 1,
        keptTheirs: 1,
        keptMine: 0,
        unchanged: 1,
        approvalCleared: true,
        was: 'approved',
      },
    );
    assert.deepEqual(detail.files, { before: 4, after: 2 });
    assert.equal(detail.refreshedFrom, 'main');
    assert.doesNotMatch(audit[0]?.detail ?? '', /subtitle|Line|Acme Pro/i);

    // The approval did not carry over: it must be approved again, and then it applies.
    assert.equal((await b.t.call(b.t.owner, 'POST', `/change-sets/${id}/apply`)).status, 409);
    assert.equal((await approve(b, id)).status, 200);
    const applied = await b.t.call(b.t.owner, 'POST', `/change-sets/${id}/apply`);
    assert.equal(applied.status, 200, applied.text);
    assert.equal(applied.body.changeSet.status, 'applied');
    const tree = b.repo.branches.get(applied.body.changeSet.branch);
    assert.equal(tree?.get(DESCRIPTION), DESCRIPTION_BOTH);
    assert.equal(tree?.get(DE_SUBTITLE), 'Unser Untertitel\n');
    assert.equal(tree?.get(SUBTITLE), 'Their subtitle\n');
  },
);

dbTest(
  'refresh: "mine" keeps our text over theirs, and the set applies against the new base',
  async (db) => {
    const b = await boot(db);
    const id = await draftFour(b);
    moveOn(b);
    const done = await refresh(b, id, { resolutions: { [SUBTITLE]: 'mine' } });
    assert.equal(done.status, 200, done.text);
    const subtitle = done.body.changeSet.files.find((f: { path: string }) => f.path === SUBTITLE);
    assert.deepEqual(subtitle, {
      path: SUBTITLE,
      change: 'modified',
      before: 'Their subtitle\n',
      after: 'Our subtitle\n',
    });
    assert.equal(
      done.body.files.find((f: { path: string }) => f.path === SUBTITLE).outcome,
      'kept_mine',
    );
    await approve(b, id);
    const applied = await b.t.call(b.t.owner, 'POST', `/change-sets/${id}/apply`);
    assert.equal(applied.status, 200, applied.text);
    assert.equal(
      b.repo.branches.get(applied.body.changeSet.branch)?.get(SUBTITLE),
      'Our subtitle\n',
    );
  },
);

dbTest('refresh: a bad body or a path that is not in the set is refused', async (db) => {
  const b = await boot(db);
  const id = await draftFour(b);
  const res = await refresh(b, id, { resolutions: { 'nope.txt': 'mine' } });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'unknown_path');
  assert.equal((await refresh(b, id, { resolutions: { [SUBTITLE]: 'both' } })).status, 400);
  const raw = await b.t.app.request(
    `/api/workspaces/${b.t.workspaceId}/change-sets/${id}/refresh`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: b.t.owner },
      body: 'not json',
    },
  );
  assert.equal(raw.status, 400);
});

dbTest('refresh: nothing moved keeps the approval and writes nothing', async (db) => {
  const b = await boot(db);
  const id = await draftFour(b);
  await approve(b, id);
  const before = await set(b, id);
  const res = await refresh(b, id);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.unchanged, true);
  assert.equal(res.body.approvalCleared, false);
  assert.deepEqual(await set(b, id), before);
  assert.equal(before.status, 'approved');
  assert.equal((await refreshAudit(b)).length, 0);
});

dbTest(
  'refresh: when the repository has everything already, nothing is left and it cannot be approved',
  async (db) => {
    const b = await boot(db);
    const id = await draftFour(b);
    b.repo.files.set(NAME, 'Acme Pro\n');
    b.repo.files.set(SUBTITLE, 'Our subtitle\n');
    b.repo.files.set(DESCRIPTION, DESCRIPTION_OURS);
    b.repo.files.set(DE_SUBTITLE, 'Unser Untertitel\n');
    const res = await refresh(b, id);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.nothingLeft, true);
    assert.equal(res.body.changeSet.filesChanged, 0);
    assert.equal(res.body.changeSet.status, 'draft');
    const refused = await approve(b, id);
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error, 'nothing_to_apply');
    const discarded = await b.t.call(b.t.owner, 'POST', `/change-sets/${id}/discard`);
    assert.equal(discarded.status, 200);
    assert.equal(discarded.body.changeSet.status, 'discarded');
  },
);

dbTest(
  'refresh: only a draft, approved or failed set; a failed one with a branch is refused',
  async (db) => {
    const b = await boot(db);
    const id = await draftFour(b);
    await approve(b, id);
    assert.equal((await b.t.call(b.t.owner, 'POST', `/change-sets/${id}/apply`)).status, 200);
    for (const [verb, route] of [
      ['POST', 'refresh'],
      ['GET', 'staleness'],
    ] as const) {
      const res = await b.t.call(b.t.owner, verb, `/change-sets/${id}/${route}`);
      assert.equal(res.status, 409);
      assert.equal(res.body.error, 'invalid_state');
      assert.equal(res.body.status, 'applied');
    }
    const other = await draftFour(b, 'Another');
    await b.t.call(b.t.owner, 'POST', `/change-sets/${other}/discard`);
    assert.equal((await refresh(b, other)).body.status, 'discarded');
    const third = await draftFour(b, 'Third');
    await b.t.db.execute("UPDATE change_sets SET status = 'applying' WHERE id = ?", [third]);
    assert.equal((await refresh(b, third)).body.status, 'applying');
    await b.t.db.execute(
      "UPDATE change_sets SET status = 'failed', branch = 'kiln/abc' WHERE id = ?",
      [third],
    );
    const withBranch = await refresh(b, third);
    assert.equal(withBranch.status, 409);
    assert.equal(withBranch.body.error, 'branch_created');
    assert.equal((await refresh(b, 'no-such-id')).status, 404);
  },
);

dbTest(
  'refresh: a set whose apply failed on a conflict is refreshed back to a draft and applies',
  async (db) => {
    const b = await boot(db);
    const id = await draftFour(b);
    await approve(b, id);
    b.repo.files.set(DE_SUBTITLE, 'Neuer Untertitel\n');
    const failed = await b.t.call(b.t.owner, 'POST', `/change-sets/${id}/apply`);
    assert.equal(failed.status, 409);
    assert.equal(failed.body.error, 'change_conflict');
    assert.match(failed.body.hint, /Refresh it/);
    assert.equal((await set(b, id)).status, 'failed');
    const stale = await staleness(b, id);
    assert.equal(stale.body.stale, true);
    assert.equal(
      stale.body.files.find((f: { path: string }) => f.path === DE_SUBTITLE).state,
      'conflict',
    );
    const done = await refresh(b, id, { resolutions: { [DE_SUBTITLE]: 'mine' } });
    assert.equal(done.status, 200, done.text);
    assert.equal(done.body.changeSet.status, 'draft');
    assert.equal(done.body.changeSet.error, null);
    await approve(b, id);
    assert.equal((await b.t.call(b.t.owner, 'POST', `/change-sets/${id}/apply`)).status, 200);
  },
);

dbTest('roles and isolation', async (db) => {
  const b = await boot(db);
  const id = await draftFour(b);
  moveOn(b);
  const viewer = await b.t.addMember('viewer');
  const member = await b.t.addMember('member');
  assert.equal((await refresh(b, id, undefined, viewer)).status, 403);
  assert.equal((await staleness(b, id, viewer)).status, 403);
  assert.equal((await staleness(b, id, member)).status, 200);
  // A member may refresh (they may create change sets), and the audit row is theirs.
  const done = await refresh(b, id, { resolutions: { [SUBTITLE]: 'theirs' } }, member);
  assert.equal(done.status, 200, done.text);
  const rows = await refreshAudit(b);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.actorId, `user-member-${b.t.workspaceId}`);
  // Another workspace's owner sees a 404 in their own workspace and in this one.
  const stranger = await strangerOwner(b);
  assert.equal(
    (
      await b.t.call(
        stranger.cookie,
        'POST',
        `/change-sets/${id}/refresh`,
        undefined,
        stranger.workspaceId,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await b.t.call(
        stranger.cookie,
        'GET',
        `/change-sets/${id}/staleness`,
        undefined,
        stranger.workspaceId,
      )
    ).status,
    404,
  );
  assert.equal((await b.t.call(stranger.cookie, 'POST', `/change-sets/${id}/refresh`)).status, 404);
  assert.equal(
    (await b.t.call(stranger.cookie, 'GET', `/change-sets/${id}/staleness`)).status,
    404,
  );
});

/** A second workspace with its own owner, in the same database. */
async function strangerOwner(b: Booted) {
  const { createSession } = await import('./services/accounts.ts');
  const workspaceId = 'ws-stranger';
  await b.t.db.execute(
    'INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, 0)',
    ['u-stranger', 'x@x.io', 'X'],
  );
  await b.t.db.execute("INSERT INTO workspaces (id, name, created_at) VALUES (?, 'Other', 0)", [
    workspaceId,
  ]);
  await b.t.db.execute(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, 'u-stranger', 'owner')",
    [workspaceId],
  );
  const { token } = await createSession(b.t.db, 'u-stranger', Date.now());
  return { cookie: `kiln_session=${token}`, workspaceId };
}

dbTest(
  'refresh: a repository that cannot be read is reported and the set is untouched',
  async (db) => {
    const b = await boot(db);
    const id = await draftFour(b);
    await approve(b, id);
    const original = await set(b, id);
    b.repo.listError = new GithubError('network', 'GitHub is down');
    const res = await refresh(b, id);
    assert.equal(res.status, 502, res.text);
    assert.deepEqual(await set(b, id), original);
  },
);

dbTest('refresh: an Expo store config merged as text must still parse', async (db) => {
  const b = await boot(db);
  const base = '{\n  "a": 1,\n  "b": 2,\n  "c": 3,\n  "d": 4,\n  "e": 5\n}\n';
  const ours = base.replace('"e": 5', '"e": 50');
  const id = 'cs-json';
  await b.t.db.execute(
    `INSERT INTO change_sets (id, workspace_id, repository_id, summary, status, created_by_type, created_by_id, files_json, created_at, updated_at)
     VALUES (?, ?, ?, 'Expo', 'draft', 'user', 'u', ?, 1, 1)`,
    [
      id,
      b.t.workspaceId,
      b.repositoryId,
      JSON.stringify([{ path: 'store.config.json', before: base, after: ours }]),
    ],
  );
  // Theirs removes the comma after "b": the merged text would not be JSON.
  b.repo.files.set('store.config.json', base.replace('"b": 2,', '"b": 2'));
  const stale = await staleness(b, id);
  assert.deepEqual(stale.body.files, [{ path: 'store.config.json', state: 'conflict' }]);
  const res = await refresh(b, id);
  assert.equal(res.status, 409);
  assert.equal(res.body.files[0].reason, 'invalid_json');
  // A change that keeps it valid merges.
  b.repo.files.set('store.config.json', base.replace('"a": 1', '"a": 10'));
  const ok = await refresh(b, id);
  assert.equal(ok.status, 200, ok.text);
  const file = ok.body.changeSet.files[0];
  assert.equal(file.before, base.replace('"a": 1', '"a": 10'));
  assert.equal(JSON.parse(file.after).a, 10);
  assert.equal(JSON.parse(file.after).e, 50);
});

dbTest(
  'refresh works for the other fastlane layout (metadata at the repository root)',
  async (db) => {
    const root = {
      Fastfile: 'lane :release do\nend\n',
      'metadata/en-US/name.txt': 'Acme App\n',
      'metadata/en-US/subtitle.txt': 'Old subtitle\n',
      'metadata/en-US/description.txt': DESCRIPTION_OLD,
    };
    const b = await boot(db, root);
    const read = await b.t.call(b.t.owner, 'GET', `/repositories/${b.repositoryId}/listing`);
    assert.equal(read.status, 200, read.text);
    const listing = read.body.listing;
    listing.appStore.locales['en-US'].description = DESCRIPTION_OURS.trimEnd();
    const made = await b.t.call(b.t.owner, 'POST', `/repositories/${b.repositoryId}/change-sets`, {
      summary: 'Root layout',
      listing,
    });
    assert.equal(made.status, 201, made.text);
    const id = made.body.changeSet.id as string;
    assert.deepEqual(
      made.body.changeSet.files.map((f: { path: string }) => f.path),
      ['metadata/en-US/description.txt'],
    );
    b.repo.files.set('metadata/en-US/description.txt', DESCRIPTION_THEIRS);
    assert.equal((await staleness(b, id)).body.files[0].state, 'changed');
    const done = await refresh(b, id);
    assert.equal(done.status, 200, done.text);
    assert.equal(done.body.changeSet.files[0].after, DESCRIPTION_BOTH);
  },
);

// ---------------------------------------------------------------------------------------------
// A local clone: the same, and the apply as a commit on a branch after it

dbTest(
  'local branch: base_changed, then refresh, then the commit is made on a new branch',
  async (db) => {
    const base = scratch();
    const root = join(base, 'dev');
    const dataDir = join(base, 'data');
    const cloneDir = join(dataDir, 'clones');
    for (const d of [root, dataDir]) mkdirSync(d);
    const wrapper = gitWrapper();
    const reads = createCloneReads({
      mode: 'clone',
      cloneDir,
      gitPath: wrapper.path,
      log: () => undefined,
      local: { roots: [root], excluded: [dataDir, cloneDir] },
    });
    const api = new FakeRepo();
    api.files = new Map(Object.entries(files()));
    clearRepoSnapshots();
    const t = await bootRepoApp(db, api, { reads, localWrite: { enabled: true } });
    const dir = buildRepo(root, 'app', files());
    git(dir, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
    const { repositoryId } = await t.connect();
    const attach = await t.call(t.owner, 'PUT', `/repositories/${repositoryId}/local`, {
      path: dir,
    });
    assert.equal(attach.status, 200, attach.text);

    const read = await t.call(t.owner, 'GET', `/repositories/${repositoryId}/listing`);
    const listing = read.body.listing;
    listing.appStore.locales['en-US'].description = DESCRIPTION_OURS.trimEnd();
    listing.appStore.locales['en-US'].subtitle = 'Our subtitle';
    const made = await t.call(t.owner, 'POST', `/repositories/${repositoryId}/change-sets`, {
      summary: 'Local',
      listing,
    });
    assert.equal(made.status, 201, made.text);
    const id = made.body.changeSet.id as string;
    await t.call(t.owner, 'POST', `/change-sets/${id}/approve`);

    // A commit lands on the branch: the description changes in another line, the subtitle becomes what we want.
    writeFileSync(join(dir, DESCRIPTION), DESCRIPTION_THEIRS);
    writeFileSync(join(dir, SUBTITLE), 'Our subtitle\n');
    git(dir, 'commit', '-q', '-am', 'someone else');

    const stale = await t.call(t.owner, 'GET', `/change-sets/${id}/staleness`);
    assert.equal(stale.status, 200, stale.text);
    const states = Object.fromEntries(
      stale.body.files.map((f: { path: string; state: string }) => [f.path, f.state]),
    );
    assert.deepEqual(states, { [DESCRIPTION]: 'changed', [SUBTITLE]: 'already_applied' });

    const refused = await t.call(t.owner, 'POST', `/change-sets/${id}/apply`, {
      mode: 'local_branch',
    });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.error, 'base_changed');

    const done = await t.call(t.owner, 'POST', `/change-sets/${id}/refresh`);
    assert.equal(done.status, 200, done.text);
    assert.match(
      done.body.refreshedFrom,
      /^[0-9a-f]{40}$/,
      'a local clone names the commit it read',
    );
    assert.equal(done.body.changeSet.status, 'draft');
    assert.deepEqual(
      done.body.changeSet.files.map((f: { path: string }) => f.path),
      [DESCRIPTION],
    );

    assert.equal((await t.call(t.owner, 'POST', `/change-sets/${id}/approve`)).status, 200);
    const applied = await t.call(t.owner, 'POST', `/change-sets/${id}/apply`, {
      mode: 'local_branch',
    });
    assert.equal(applied.status, 200, applied.text);
    const branch = applied.body.changeSet.outcome.commit.branch as string;
    assert.equal(`${git(dir, 'show', `${branch}:${DESCRIPTION}`)}\n`, DESCRIPTION_BOTH);
  },
);
