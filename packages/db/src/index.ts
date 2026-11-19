import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { QueryResult } from 'pg';
import { type Dialect, detectDialect, sqlitePath } from './dialect.ts';
import { migrations } from './migrations.ts';

export { type Dialect, detectDialect } from './dialect.ts';
export { type Migration, migrations } from './migrations.ts';

export type Param = string | number | null;
export type Row = Record<string, unknown>;

/**
 * What the rest of the code sees: portable SQL with `?` placeholders, rows as plain objects.
 * Numbers that are epoch milliseconds come back as numbers on both dialects.
 */
export type Sql = {
  readonly dialect: Dialect;
  query<T extends Row = Row>(statement: string, params?: Param[]): Promise<T[]>;
  /** Returns the number of rows changed. */
  execute(statement: string, params?: Param[]): Promise<number>;
};

export type Database = Sql & {
  ping(): Promise<void>;
  /** Runs `fn` in one transaction: commit when it returns, roll back when it throws. */
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export async function createDatabase(url: string): Promise<Database> {
  const dialect = detectDialect(url);
  return dialect === 'postgres' ? connectPostgres(url) : connectSqlite(url);
}

const MIGRATION_LOCK = 'SELECT pg_advisory_xact_lock(727274, hashtext(current_schema()))';

/**
 * Applies every migration that has not run yet, each in its own transaction.
 *
 * The advisory lock is per schema: instances sharing a schema (the normal case, `public`) still
 * take turns, while separate schemas in one database (each test gets its own) do not queue behind
 * each other.
 */
export async function migrate(database: Database): Promise<number[]> {
  const timestamp = database.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  // Under the lock too: two instances running CREATE TABLE IF NOT EXISTS at the same moment can
  // make Postgres fail with a duplicate key on its catalog.
  await database.transaction(async (tx) => {
    if (tx.dialect === 'postgres') await tx.query(MIGRATION_LOCK);
    await tx.execute(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         applied_at ${timestamp} NOT NULL
       )`,
    );
  });
  const applied: number[] = [];
  for (const migration of migrations) {
    await database.transaction(async (tx) => {
      // Two instances booting together must not both run a migration.
      if (tx.dialect === 'postgres') await tx.query(MIGRATION_LOCK);
      const done = await tx.query('SELECT id FROM schema_migrations WHERE id = ?', [migration.id]);
      if (done.length > 0) return;
      for (const statement of migration.statements(tx.dialect)) await tx.execute(statement);
      await tx.execute('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [
        migration.id,
        migration.name,
        Date.now(),
      ]);
      applied.push(migration.id);
    });
  }
  return applied;
}

// ---------------------------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------------------------

/**
 * `?` → `$1, $2, …`. A `?` inside a 'string literal' or a "quoted identifier" is left alone.
 * Comments are not recognised, so do not put a `?` in one.
 */
export function toPostgresPlaceholders(statement: string): string {
  let n = 0;
  return statement.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|\?/g, (token) =>
    token === '?' ? `$${++n}` : token,
  );
}

async function connectPostgres(url: string): Promise<Database> {
  const { default: pg } = await import('pg');
  // BIGINT (oid 20) arrives as a string by default. Epoch milliseconds fit in a double.
  pg.types.setTypeParser(20, (value: string) => Number(value));
  const pool = new pg.Pool({ connectionString: url });
  // An idle connection dropped by the server (restart, failover) emits 'error' on the pool.
  // Unhandled, that would crash the process; the pool discards the client and reconnects on demand.
  pool.on('error', (error) => console.error('Postgres pool error:', error.message));

  const over = (client: {
    query: (text: string, values?: unknown[]) => Promise<QueryResult>;
  }): Sql => ({
    dialect: 'postgres',
    async query(statement, params = []) {
      const result = await client.query(toPostgresPlaceholders(statement), params);
      return result.rows as never;
    },
    async execute(statement, params = []) {
      const result = await client.query(toPostgresPlaceholders(statement), params);
      return result.rowCount ?? 0;
    },
  });

  return {
    ...over(pool),
    async ping() {
      await pool.query('select 1');
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(over(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// SQLite, through the driver built into Node (node:sqlite), so there is no native module to
// build for the container image, CI or the desktop sidecar. See docs/adr/0002-node-sqlite.md.
// ---------------------------------------------------------------------------------------------

async function connectSqlite(url: string): Promise<Database> {
  const { DatabaseSync } = await import('node:sqlite');
  const path = sqlitePath(url);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const client = new DatabaseSync(path);
  client.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  // The connection is shared, so a statement from another caller must never run while a
  // transaction is open (it would join the transaction and be rolled back with it).
  let active = false;
  let tail: Promise<unknown> = Promise.resolve();
  const idle = async () => {
    while (active) await tail;
  };

  const direct: Sql = {
    dialect: 'sqlite',
    async query(statement, params = []) {
      // node:sqlite rows have no prototype. Copy them into plain objects.
      return client
        .prepare(statement)
        .all(...params)
        .map((row) => ({ ...row })) as never;
    },
    async execute(statement, params = []) {
      return Number(client.prepare(statement).run(...params).changes);
    },
  };

  return {
    dialect: 'sqlite',
    async query(statement, params) {
      await idle();
      return direct.query(statement, params);
    },
    async execute(statement, params) {
      await idle();
      return direct.execute(statement, params);
    },
    async ping() {
      await idle();
      client.prepare('select 1').get();
    },
    transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      const run = tail.then(async () => {
        await idle();
        active = true;
        try {
          client.exec('BEGIN IMMEDIATE');
          const result = await fn(direct);
          client.exec('COMMIT');
          return result;
        } catch (error) {
          try {
            client.exec('ROLLBACK');
          } catch {
            // BEGIN itself failed, so there is nothing to roll back.
          }
          throw error;
        } finally {
          active = false;
        }
      });
      tail = run.catch(() => {});
      return run;
    },
    async close() {
      await tail;
      client.close();
    },
  };
}
