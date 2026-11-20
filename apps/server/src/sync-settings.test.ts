import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dbTest } from '@mrm/db/testing';
import { bootCi } from './ci-test-helpers.ts';
import { createScheduler } from './scheduler.ts';
import { APP_SYNC_QUEUE } from './services/apps.ts';
import {
  effectiveSync,
  isSyncIntervalMinutes,
  lastScheduledSyncAt,
  loadSyncPrefs,
} from './services/sync-schedule.ts';
import { bootTranslation } from './translation-test-helpers.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = 1_800_000_000_000 + 10 * MINUTE;

test('sync schedule: pure rules', () => {
  assert.equal(isSyncIntervalMinutes(15), true);
  assert.equal(isSyncIntervalMinutes(4), false);
  assert.equal(isSyncIntervalMinutes(10_081), false);
  assert.equal(isSyncIntervalMinutes(30.5), false);
  assert.equal(isSyncIntervalMinutes('30'), false);
  assert.deepEqual(effectiveSync(0, { enabled: true, intervalMinutes: 15 }), {
    enabled: false,
    minutes: 0,
    reason: 'server_off',
  });
  assert.deepEqual(effectiveSync(30, { enabled: false }), {
    enabled: false,
    minutes: 0,
    reason: 'workspace_off',
  });
  assert.deepEqual(effectiveSync(30, undefined), { enabled: true, minutes: 30, reason: null });
  assert.deepEqual(effectiveSync(30, { intervalMinutes: 360 }), {
    enabled: true,
    minutes: 360,
    reason: null,
  });
});

const setting = (
  db: Parameters<typeof loadSyncPrefs>[0],
  workspaceId: string,
  key: string,
  value: unknown,
) =>
  db.execute(
    `INSERT INTO workspace_settings (workspace_id, key, value_json, updated_at, updated_by)
     VALUES (?, ?, ?, 0, 'test')`,
    [workspaceId, key, JSON.stringify(value)],
  );

dbTest('scheduler: a workspace that turned the refresh off is skipped', async (db) => {
  const t = await bootCi(db);
  await t.seedApp('ios', [{ version: '1.0', build: '1' }]);
  await setting(db, t.workspaceId, 'sync.enabled', false);
  const scheduler = createScheduler({
    db,
    now: () => START,
    syncIntervalMs: HOUR,
    jitter: () => 0,
  });
  const summary = await scheduler.tick();
  assert.equal(summary.syncsQueued, 0);
  assert.equal(summary.skipped.disabled, 1);
  const jobs = await db.query('SELECT id FROM jobs WHERE queue = ?', [APP_SYNC_QUEUE]);
  assert.equal(jobs.length, 0);
});

dbTest(
  'scheduler: a workspace interval replaces the server one; the server off wins',
  async (db) => {
    const t = await bootCi(db);
    const app = await t.seedApp('ios', [{ version: '1.0', build: '1' }]);
    await db.execute('UPDATE apps SET last_sync_attempt_at = ? WHERE id = ?', [
      START - 20 * MINUTE,
      app,
    ]);

    // Server: hourly. Not due yet.
    const hourly = createScheduler({ db, now: () => START, syncIntervalMs: HOUR, jitter: () => 0 });
    assert.equal((await hourly.tick()).syncsQueued, 0);

    // The workspace chooses 15 minutes: the same app is now due.
    await setting(db, t.workspaceId, 'sync.intervalMinutes', 15);
    assert.equal((await hourly.tick()).syncsQueued, 1);

    // A longer choice (daily) is honoured too: a stale app is still not due.
    await db.execute('UPDATE jobs SET status = ?', ['done']);
    await db.execute('UPDATE workspace_settings SET value_json = ? WHERE key = ?', [
      '1440',
      'sync.intervalMinutes',
    ]);
    await db.execute('UPDATE apps SET last_sync_attempt_at = ? WHERE id = ?', [
      START - 3 * HOUR,
      app,
    ]);
    const again = await hourly.tick();
    assert.equal(again.syncsQueued, 0);
    assert.equal(again.skipped.recent, 1);

    // Server interval off (0): nothing is queued whatever the workspace chose.
    await db.execute('UPDATE apps SET last_sync_attempt_at = ? WHERE id = ?', [
      START - 48 * HOUR,
      app,
    ]);
    const off = createScheduler({ db, now: () => START, syncIntervalMs: 0 });
    assert.equal((await off.tick()).syncsQueued, 0);
  },
);

dbTest('loadSyncPrefs ignores values that no longer validate', async (db) => {
  const t = await bootCi(db);
  await setting(db, t.workspaceId, 'sync.enabled', 'yes');
  await setting(db, t.workspaceId, 'sync.intervalMinutes', 2);
  const prefs = await loadSyncPrefs(db);
  assert.deepEqual(prefs.get(t.workspaceId) ?? {}, {});
});

dbTest(
  'settings: sync keys, validation, audit, and what the Settings screen is told',
  async (db) => {
    const t = await bootTranslation(db, { app: { appSync: { intervalMinutes: 45 } } });
    const member = await t.addMember('member');
    const admin = await t.addMember('admin');

    const read = await t.call(member, 'GET', '/settings');
    assert.equal(read.body.values['sync.enabled'], true);
    assert.equal(
      read.body.values['sync.intervalMinutes'],
      45,
      'shows what applies: the server interval until a choice is made',
    );
    assert.equal(read.body.defaults['sync.intervalMinutes'], 30);
    assert.deepEqual(read.body.writable, []);
    assert.equal(read.body.sync.serverMinutes, 45);
    assert.equal(read.body.sync.running, true);
    assert.equal(read.body.sync.lastScheduledAt, null);
    assert.equal(read.body.sync.off, undefined);

    assert.equal((await t.put(member, { 'sync.enabled': false })).status, 403);
    for (const bad of [4, 10_081, 30.5, '30', true]) {
      const res = await t.put(admin, { 'sync.intervalMinutes': bad });
      assert.equal(res.status, 400, String(bad));
      assert.equal(res.body.error, 'invalid_setting');
    }
    assert.equal((await t.put(admin, { 'sync.enabled': 'no' })).status, 400);

    const done = await t.put(admin, { 'sync.intervalMinutes': 360 });
    assert.equal(done.status, 200);
    assert.deepEqual(done.body.changed, ['sync.intervalMinutes']);
    assert.equal(done.body.sync.intervalMinutes, 360);
    const off = await t.put(admin, { 'sync.enabled': false });
    assert.equal(off.body.sync.running, false);
    assert.equal(off.body.sync.off, 'workspace_off');

    const audit = await db.query(
      "SELECT detail FROM audit_events WHERE workspace_id = ? AND action = 'settings.update' ORDER BY created_at",
      [t.workspaceId],
    );
    const details = audit.map((r) => JSON.parse(String(r.detail)) as { keys: string[] });
    assert.deepEqual(
      details.map((d) => d.keys),
      [['sync.intervalMinutes'], ['sync.enabled']],
    );

    // Reset goes back to the server's interval and to on.
    const reset = await t.put(admin, { 'sync.enabled': null, 'sync.intervalMinutes': null });
    assert.equal(reset.body.sync.intervalMinutes, 45);
    assert.equal(reset.body.sync.running, true);
  },
);

dbTest(
  'settings: the last scheduled refresh is read from the audit trail; server off is said',
  async (db) => {
    const t = await bootTranslation(db, { app: { appSync: { intervalMinutes: 0 } } });
    const admin = await t.addMember('admin');
    const insert = (at: number, detail: unknown) =>
      db.execute(
        `INSERT INTO audit_events (id, workspace_id, actor_type, actor_id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, 'system', 'app.sync', 'app.sync', 'app', 'a', ?, ?)`,
        [`e${at}`, t.workspaceId, JSON.stringify(detail), at],
      );
    await insert(1_000, { ok: true, trigger: 'job', requestedBy: 'scheduler' });
    await insert(2_000, { ok: false, trigger: 'job', requestedBy: 'scheduler' });
    await insert(3_000, { ok: true, trigger: 'request' });
    await insert(4_000, { ok: true, trigger: 'job', requestedBy: 'someone' });
    assert.equal(await lastScheduledSyncAt(db, t.workspaceId), 2_000);
    const res = await t.call(admin, 'GET', '/settings');
    assert.equal(res.body.sync.lastScheduledAt, 2_000);
    assert.equal(res.body.sync.running, false);
    assert.equal(res.body.sync.off, 'server_off');
    assert.equal(res.body.sync.serverMinutes, 0);
  },
);
