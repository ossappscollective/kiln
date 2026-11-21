import { randomBytes } from 'node:crypto';
import { type TestContext, test } from 'node:test';
import { type Dialect, detectDialect } from './dialect.ts';
import { createDatabase, type Database, type Sql } from './index.ts';

/**
 * Test helpers: run one test body against every database we support.
 *
 * SQLite (in memory) always runs. Postgres runs when KILN_TEST_POSTGRES_URL is set; without it the
 * Postgres cases are reported as skipped, so the gap shows up in the test output.
 * Each Postgres test gets its own schema, dropped when the test ends, so tests never see each
 * other's rows and the server can be shared by parallel test files.
 */
export const POSTGRES_URL_ENV = 'KILN_TEST_POSTGRES_URL';

export type TestDatabase = Database & {
  /** A URL that opens another connection to the same data. Not shareable for in-memory SQLite. */
  url: string;
};

export function postgresTestUrl(): string | undefined {
  const url = process.env[POSTGRES_URL_ENV]?.trim();
  if (!url) return undefined;
  if (detectDialect(url) !== 'postgres') {
    throw new Error(`${POSTGRES_URL_ENV} must start with postgres:// or postgresql://`);
  }
  return url;
}

const once = (fn: () => Promise<void>) => {
  let done: Promise<void> | undefined;
  return () => {
    done ??= fn();
    return done;
  };
};

export async function openSqliteTestDatabase(): Promise<TestDatabase> {
  const db = await createDatabase(':memory:');
  return { ...db, url: ':memory:', close: once(() => db.close()) };
}

/** A fresh schema on the server named by baseUrl. close() drops it. */
export async function openPostgresTestDatabase(baseUrl: string): Promise<TestDatabase> {
  const schema = `mrm_test_${randomBytes(6).toString('hex')}`;
  const admin = await createDatabase(baseUrl);
  try {
    await admin.execute(`CREATE SCHEMA ${schema}`);
  } catch (error) {
    await admin.close();
    throw error;
  }
  // Every connection in the pool starts with this search_path, so unqualified names land in it.
  const options = encodeURIComponent(`-c search_path=${schema}`);
  const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}options=${options}`;
  const db = await createDatabase(url);
  return {
    ...db,
    url,
    close: once(async () => {
      try {
        await db.close();
      } finally {
        try {
          await admin.execute(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        } finally {
          await admin.close();
        }
      }
    }),
  };
}

type Body = (db: TestDatabase, t: TestContext) => Promise<void>;
export type DbTestOptions = { dialects?: Dialect[] };

/**
 * Registers `name [sqlite]` and `name [postgres]`. The database is closed (and its Postgres
 * schema dropped) after the test, so the body must not close it.
 */
export function dbTest(name: string, body: Body): void;
export function dbTest(name: string, options: DbTestOptions, body: Body): void;
export function dbTest(name: string, second: DbTestOptions | Body, third?: Body): void {
  const options = typeof second === 'function' ? {} : second;
  const body = typeof second === 'function' ? second : third;
  if (!body) throw new Error('dbTest needs a test body');
  const dialects = options.dialects ?? ['sqlite', 'postgres'];

  if (dialects.includes('sqlite')) {
    test(`${name} [sqlite]`, async (t) => {
      const db = await openSqliteTestDatabase();
      t.after(() => db.close());
      await body(db, t);
    });
  }
  if (dialects.includes('postgres')) {
    const url = postgresTestUrl();
    const skip = url ? false : `${POSTGRES_URL_ENV} is not set`;
    test(`${name} [postgres]`, { skip }, async (t) => {
      if (!url) return;
      const db = await openPostgresTestDatabase(url);
      t.after(() => db.close());
      await body(db, t);
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Introspection, one implementation per dialect, for tests that compare a migrated database
// with what we expect.
// ---------------------------------------------------------------------------------------------

export type ColumnInfo = {
  name: string;
  /** Lower case: text, integer, bigint. */
  type: string;
  nullable: boolean;
};

export async function tableNames(sql: Sql): Promise<string[]> {
  const rows =
    sql.dialect === 'postgres'
      ? await sql.query<{ name: string }>(
          `SELECT table_name AS name FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
        )
      : await sql.query<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        );
  return rows.map((r) => r.name).sort();
}

export async function tableColumns(sql: Sql, table: string): Promise<ColumnInfo[]> {
  const columns =
    sql.dialect === 'postgres'
      ? (
          await sql.query<{ name: string; type: string; nullable: string }>(
            `SELECT column_name AS name, data_type AS type, is_nullable AS nullable
               FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = ?`,
            [table],
          )
        ).map((r) => ({ name: r.name, type: r.type, nullable: r.nullable === 'YES' }))
      : (
          await sql.query<{ name: string; type: string; notnull: number; pk: number }>(
            'SELECT name, type, "notnull", pk FROM pragma_table_info(?)',
            [table],
          )
        ).map((r) => ({
          name: r.name,
          type: r.type,
          // SQLite lets a TEXT PRIMARY KEY hold NULL; for our purposes a key is never null.
          nullable: r.notnull === 0 && r.pk === 0,
        }));
  return columns
    .map((c) => ({ ...c, type: c.type.toLowerCase() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Names of all indexes on the table, including the automatic ones for keys and UNIQUE. */
export async function tableIndexes(sql: Sql, table: string): Promise<string[]> {
  const rows =
    sql.dialect === 'postgres'
      ? await sql.query<{ name: string }>(
          `SELECT indexname AS name FROM pg_indexes
            WHERE schemaname = current_schema() AND tablename = ?`,
          [table],
        )
      : await sql.query<{ name: string }>('SELECT name FROM pragma_index_list(?)', [table]);
  return rows.map((r) => r.name).sort();
}
