export type Dialect = 'postgres' | 'sqlite';

/** postgres://… or postgresql://… selects Postgres. file:… or :memory: selects SQLite. */
export function detectDialect(url: string): Dialect {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return 'postgres';
  if (url.startsWith('file:') || url === ':memory:') return 'sqlite';
  throw new Error(
    'DATABASE_URL must start with postgres://, postgresql:// or file: (for SQLite), or be :memory:',
  );
}

/** file:./a/b.db → ./a/b.db. Leaves :memory: alone. */
export function sqlitePath(url: string): string {
  return url === ':memory:' ? url : url.slice('file:'.length);
}
