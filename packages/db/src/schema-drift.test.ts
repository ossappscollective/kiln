import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AnyColumn, getTableColumns, getTableName, is } from 'drizzle-orm';
import type { Dialect } from './dialect.ts';
import { migrate } from './index.ts';
import { dbTest, tableColumns, tableIndexes, tableNames } from './testing.ts';

type Described = {
  name: string;
  columns: { name: string; type: string; nullable: boolean }[];
  indexes: string[];
};

const indexNames = (config: { indexes: { config: { name?: string } }[] }) =>
  config.indexes.flatMap((i) => (i.config.name ? [i.config.name] : [])).sort();

/** What the drizzle schema file for a dialect says the tables look like. */
async function describeSchema(dialect: Dialect): Promise<Described[]> {
  const describeColumns = (table: Parameters<typeof getTableColumns>[0]) =>
    Object.values(getTableColumns(table) as Record<string, AnyColumn>)
      .map((c) => ({ name: c.name, type: c.getSQLType(), nullable: !c.notNull }))
      .sort((a, b) => a.name.localeCompare(b.name));

  if (dialect === 'postgres') {
    const { PgTable, getTableConfig } = await import('drizzle-orm/pg-core');
    const schema = await import('./schema.pg.ts');
    return Object.values(schema)
      .filter((value) => is(value, PgTable))
      .map((table) => ({
        name: getTableName(table),
        columns: describeColumns(table),
        indexes: indexNames(getTableConfig(table)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const { SQLiteTable, getTableConfig } = await import('drizzle-orm/sqlite-core');
  const schema = await import('./schema.sqlite.ts');
  return Object.values(schema)
    .filter((value) => is(value, SQLiteTable))
    .map((table) => ({
      name: getTableName(table),
      columns: describeColumns(table),
      indexes: indexNames(getTableConfig(table)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The runtime uses the SQL migrations; the drizzle schemas are the typed description of the
// same tables. This keeps the two from drifting apart, on each database we can reach.
dbTest(
  'the drizzle schema matches the migrated database: tables, columns, types, nullability, indexes',
  async (db) => {
    await migrate(db);
    const expected = await describeSchema(db.dialect);
    assert.ok(expected.length >= 7);
    assert.deepEqual(
      (await tableNames(db)).filter((n) => n !== 'schema_migrations'),
      expected.map((t) => t.name),
      'tables',
    );
    for (const table of expected) {
      assert.deepEqual(
        await tableColumns(db, table.name),
        table.columns,
        `columns of ${table.name}`,
      );
      const indexes = await tableIndexes(db, table.name);
      for (const index of table.indexes) {
        assert.ok(indexes.includes(index), `index ${index} on ${table.name}`);
      }
    }
  },
);

test('schema.pg.ts defines the same tables and columns as schema.sqlite.ts', async () => {
  const names = (tables: Described[]) =>
    tables.map((t) => [t.name, t.columns.map((c) => c.name), t.indexes]);
  assert.deepEqual(names(await describeSchema('postgres')), names(await describeSchema('sqlite')));
});
