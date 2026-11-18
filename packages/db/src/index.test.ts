import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase, migrate, migrations, toPostgresPlaceholders } from './index.ts';
import { dbTest, tableColumns, tableNames } from './testing.ts';

const INSERT_WORKSPACE = 'INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)';

dbTest('migrate applies every migration once and is a no-op the second time', async (db) => {
  assert.deepEqual(await migrate(db), migrations.map((m) => m.id));
  assert.deepEqual(await migrate(db), []);
  const names = await tableNames(db);
  for (const expected of ['users', 'sessions', 'credentials', 'jobs', 'audit_events']) {
    assert.ok(names.includes(expected), expected);
  }
});

dbTest('migrate adopts a database made by the old bootstrap', async (db) => {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, created_at ${t} NOT NULL)`);
  await db.execute(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at ${t} NOT NULL)`);
  await migrate(db);
  const columns = await tableColumns(db, 'users');
  assert.ok(columns.some((c) => c.name === 'password_hash'));
});

dbTest('migrate upgrades a database made by an earlier build and keeps its rows', async (db) => {
  // Build 1 had only the first migration. Recreate that state, with data in it.
  for (const statement of migrations[0]?.statements(db.dialect) ?? []) await db.execute(statement);
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(`CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`);
  await db.execute('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [1, 'initial tables', 1]);
  await db.execute('INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)', ['u1', 'a@b.co', 'Ada', 1]);

  assert.deepEqual(await migrate(db), migrations.slice(1).map((m) => m.id));
  const rows = await db.query('SELECT email, password_hash FROM users');
  assert.deepEqual(rows, [{ email: 'a@b.co', password_hash: null }]);
});

dbTest('query binds parameters and execute reports rows changed', async (db) => {
  await migrate(db);
  const changed = await db.execute(INSERT_WORKSPACE, ['w1', 'Acme', 5]);
  assert.equal(changed, 1);
  const rows = await db.query('SELECT name, created_at FROM workspaces WHERE id = ?', ['w1']);
  assert.deepEqual(rows, [{ name: 'Acme', created_at: 5 }]);
  assert.equal(await db.execute('UPDATE workspaces SET name = ? WHERE id = ?', ['x', 'nobody']), 0);
  assert.equal(await db.execute('DELETE FROM workspaces WHERE id = ?', ['w1']), 1);
});

dbTest('epoch milliseconds beyond 32 bits come back as numbers', async (db) => {
  await migrate(db);
  const now = 1_790_000_000_123;
  await db.execute(INSERT_WORKSPACE, ['w1', 'Acme', now]);
  const [row] = await db.query('SELECT created_at FROM workspaces');
  assert.strictEqual(row?.created_at, now);
});

dbTest('COUNT(*) comes back as a number', async (db) => {
  await migrate(db);
  await db.execute(INSERT_WORKSPACE, ['w1', 'A', 1]);
  await db.execute(INSERT_WORKSPACE, ['w2', 'B', 2]);
  const [row] = await db.query('SELECT COUNT(*) AS n FROM workspaces');
  assert.strictEqual(row?.n, 2);
});

dbTest('NULL parameters are stored and read back as null', async (db) => {
  await migrate(db);
  await db.execute(
    `INSERT INTO jobs (id, queue, payload, status, run_at, attempts, last_error, locked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['j1', 'q', '{}', 'queued', 1, 0, null, null, 1],
  );
  const [row] = await db.query('SELECT last_error, locked_at FROM jobs WHERE id = ?', ['j1']);
  assert.deepEqual(row, { last_error: null, locked_at: null });
});

dbTest('LIMIT takes a parameter', async (db) => {
  await migrate(db);
  for (const n of [1, 2, 3]) await db.execute(INSERT_WORKSPACE, [`w${n}`, `W${n}`, n]);
  const rows = await db.query('SELECT id FROM workspaces ORDER BY created_at DESC LIMIT ?', [2]);
  assert.deepEqual(rows.map((r) => r.id), ['w3', 'w2']);
});

dbTest('a question mark inside a string literal is not a placeholder', async (db) => {
  await migrate(db);
  await db.execute(INSERT_WORKSPACE, ['w1', '?', 1]);
  await db.execute(INSERT_WORKSPACE, ['w2', 'other', 2]);
  const rows = await db.query("SELECT id FROM workspaces WHERE name = '?' OR id = ? ORDER BY id", ['w2']);
  assert.deepEqual(rows.map((r) => r.id), ['w1', 'w2']);
});

dbTest('a transaction commits what it did and returns its result', async (db) => {
  await migrate(db);
  const result = await db.transaction(async (tx) => {
    await tx.execute(INSERT_WORKSPACE, ['w1', 'A', 1]);
    const [row] = await tx.query('SELECT COUNT(*) AS n FROM workspaces');
    return Number(row?.n);
  });
  assert.equal(result, 1);
  assert.equal((await db.query('SELECT id FROM workspaces')).length, 1);
});

dbTest('a failed transaction rolls back everything it did', async (db) => {
  await migrate(db);
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.execute(INSERT_WORKSPACE, ['w1', 'A', 1]);
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.deepEqual(await db.query('SELECT id FROM workspaces'), []);
});

dbTest('a database error inside a transaction rolls it back and the connection stays usable', async (db) => {
  await migrate(db);
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.execute(INSERT_WORKSPACE, ['w1', 'A', 1]);
      await tx.execute(INSERT_WORKSPACE, ['w1', 'duplicate key', 2]);
    }),
  );
  assert.deepEqual(await db.query('SELECT id FROM workspaces'), []);
  // Later work is not stuck behind an aborted transaction or a connection left open.
  await db.execute(INSERT_WORKSPACE, ['w2', 'B', 3]);
  assert.equal((await db.query('SELECT id FROM workspaces')).length, 1);
});

dbTest('statements from other callers wait for an open transaction instead of joining it', async (db) => {
  await migrate(db);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const failing = db
    .transaction(async (tx) => {
      await tx.execute(INSERT_WORKSPACE, ['inside', 'A', 1]);
      await gate;
      throw new Error('abort');
    })
    .catch(() => {});
  // Runs while the transaction is open. If it joined the transaction it would be rolled back.
  const outside = db.execute(INSERT_WORKSPACE, ['outside', 'B', 2]);
  release();
  await Promise.all([failing, outside]);
  const ids = (await db.query<{ id: string }>('SELECT id FROM workspaces')).map((r) => r.id);
  assert.deepEqual(ids, ['outside']);
});

dbTest('close can be called twice', async (db) => {
  await db.close();
  await db.close();
});

test('placeholders convert for Postgres', () => {
  assert.equal(toPostgresPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'), 'SELECT * FROM t WHERE a = $1 AND b = $2');
});

test('placeholder conversion leaves quoted text alone', () => {
  assert.equal(
    toPostgresPlaceholders(`SELECT 1 WHERE a = '?' AND b = ? AND c = 'it''s ?' AND "weird?" = ?`),
    `SELECT 1 WHERE a = '?' AND b = $1 AND c = 'it''s ?' AND "weird?" = $2`,
  );
});

// ----- SQLite only ------------------------------------------------------------------------------

test('sqlite: the connection reports its dialect and migrations record themselves', async () => {
  const db = await createDatabase(':memory:');
  await migrate(db);
  assert.equal(db.dialect, 'sqlite');
  const rows = await db.query<{ name: string }>('SELECT name FROM pragma_table_info(?)', ['schema_migrations']);
  assert.deepEqual(rows.map((r) => r.name).sort(), ['applied_at', 'id', 'name']);
  const master = await db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'jobs_ready_idx'");
  assert.equal(master.length, 1);
  await db.close();
});

// ----- Postgres only ----------------------------------------------------------------------------

dbTest('postgres: two instances migrating at once apply each migration exactly once', { dialects: ['postgres'] }, async (db) => {
  const other = await createDatabase(db.url);
  try {
    const [a, b] = await Promise.all([migrate(db), migrate(other)]);
    assert.deepEqual([...a, ...b].sort(), migrations.map((m) => m.id));
  } finally {
    await other.close();
  }
});

dbTest('postgres: epoch columns are BIGINT and email is unique', { dialects: ['postgres'] }, async (db) => {
  await migrate(db);
  const users = await tableColumns(db, 'users');
  assert.equal(users.find((c) => c.name === 'created_at')?.type, 'bigint');
  await db.execute('INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)', ['u1', 'a@b.co', 'A', 1]);
  await assert.rejects(
    db.execute('INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)', ['u2', 'a@b.co', 'B', 2]),
  );
});

dbTest('postgres: a transaction does not show its rows to other connections until it commits', { dialects: ['postgres'] }, async (db) => {
  await migrate(db);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let inserted: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    inserted = resolve;
  });
  const open = db.transaction(async (tx) => {
    await tx.execute(INSERT_WORKSPACE, ['w1', 'A', 1]);
    inserted();
    await gate;
  });
  await ready;
  assert.deepEqual(await db.query('SELECT id FROM workspaces'), []);
  release();
  await open;
  assert.equal((await db.query('SELECT id FROM workspaces')).length, 1);
});
