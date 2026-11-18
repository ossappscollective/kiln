import assert from 'node:assert/strict';
import { migrate, migrations } from './index.ts';
import { dbTest } from './testing.ts';

const ROLLOUT = 15;

dbTest('migration 15 adds rollout columns, steps and the reminder log, and keeps existing plans', async (db) => {
  assert.ok(migrations.some((m) => m.id === ROLLOUT), 'the migration exists');
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < ROLLOUT)) {
    await db.transaction(async (tx) => {
      for (const statement of migration.statements(tx.dialect)) await tx.execute(statement);
      await tx.execute('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [migration.id, migration.name, 1]);
    });
  }
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
  await db.execute(
    `INSERT INTO release_plans (id, workspace_id, app_id, version, platform, target_date, blocked, notes, created_by, created_at, updated_at)
     VALUES ('p1', 'w1', 'a1', '2.0.0', 'android', '2027-02-01', 0, 'keep me', 'u1', 5, 6)`,
  );
  await db.execute(
    `INSERT INTO checklist_items (id, workspace_id, plan_id, position, text, required, done) VALUES ('i1', 'w1', 'p1', 0, 'Screenshots', 1, 1)`,
  );

  const applied = await migrate(db);
  assert.ok(applied.includes(ROLLOUT));

  // The existing plan and its checklist are untouched; the new columns read NULL (no rollout plan).
  const [plan] = await db.query(
    'SELECT version, target_date, notes, rollout_kind, rollout_template, rollout_start_at FROM release_plans WHERE id = ?',
    ['p1'],
  );
  assert.equal(plan?.version, '2.0.0');
  assert.equal(plan?.target_date, '2027-02-01');
  assert.equal(plan?.notes, 'keep me');
  assert.equal(plan?.rollout_kind, null);
  assert.equal(plan?.rollout_template, null);
  assert.equal(plan?.rollout_start_at, null);
  assert.equal((await db.query('SELECT id FROM checklist_items WHERE plan_id = ?', ['p1'])).length, 1);

  await db.execute("UPDATE release_plans SET rollout_kind = 'steps', rollout_template = 'builtin:play-default' WHERE id = 'p1'");
  await db.execute(
    `INSERT INTO plan_rollout_steps (id, workspace_id, plan_id, position, percent, planned_at, note, status)
     VALUES ('s1', 'w1', 'p1', 0, 5, 1000, NULL, 'planned')`,
  );
  const [step] = await db.query('SELECT percent, status, done_at, done_source FROM plan_rollout_steps WHERE id = ?', ['s1']);
  assert.equal(Number(step?.percent), 5);
  assert.equal(step?.status, 'planned');
  assert.equal(step?.done_at, null);

  // The reminder log's primary key is the lock: the second identical insert adds nothing.
  const insert = () =>
    db.execute(
      `INSERT INTO plan_reminders (plan_id, workspace_id, item_id, kind, due_key, sent_at)
       VALUES ('p1', 'w1', 'target_date', 'overdue', '2027-02-01', 7) ON CONFLICT DO NOTHING`,
    );
  assert.equal(await insert(), 1);
  assert.equal(await insert(), 0);
  await db.execute(
    `INSERT INTO plan_reminders (plan_id, workspace_id, item_id, kind, due_key, sent_at)
     VALUES ('p1', 'w1', 'target_date', 'overdue', '2027-03-01', 8)`,
  );
  assert.equal((await db.query('SELECT plan_id FROM plan_reminders')).length, 2);
});
