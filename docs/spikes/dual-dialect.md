# Spike: one data model on Postgres and SQLite

**Question:** can we keep one schema and one set of queries across both databases without drift?

**Status:** open.

## Today

`schema.pg.ts` and `schema.sqlite.ts` are written by hand and kept in step. Ids are text, times
are epoch milliseconds, JSON is text, so the two files differ only in their table builders.
Migrations are hand-written portable SQL applied at boot (`src/migrations.ts`), and queries use a
small `Sql` interface, so there is one set of queries for both. See
[ADR 0002](../adr/0002-node-sqlite-and-sql-migrations.md).

## To prove

The Postgres cases below are written and wired into CI, but **none of them has been run**: no
Postgres server was available where they were written (no `postgres`, `pg_ctl` or Docker on the
machine). The SQLite side runs and passes. Until a run with `KILN_TEST_POSTGRES_URL` set is green,
treat every Postgres line as unverified. See "Testing against Postgres" in CONTRIBUTING.md.

1. A parity test that introspects both databases after migration and compares tables, columns,
   types, nullability and indexes against the drizzle schema. Written for both:
   `schema-drift.test.ts` runs the same check on SQLite (`pragma_table_info`) and, when
   `KILN_TEST_POSTGRES_URL` is set, on Postgres (`information_schema`, `pg_indexes`), and still
   compares the two schema files with each other. Foreign keys and unique constraints are not
   compared yet. Verified on SQLite; Postgres not run.
2. The same repository tests run against both dialects in CI. Done in code: `@kiln/db/testing`
   (`dbTest`) runs `packages/db/src/index.test.ts`, `apps/server/src/app.test.ts` and
   `apps/server/src/jobs.test.ts` on SQLite and on a fresh schema per test in Postgres, and
   reports the Postgres cases as skipped when no server is configured. The CI service container
   is in `docs/ci.yml.example`; it still has to be moved to `.github/workflows/ci.yml`. Not run on
   Postgres. `single-user.test.ts` has not been moved to `dbTest`.
3. The migrations apply cleanly on an empty Postgres database and on one made by an earlier build.
   Tests exist for both (empty schema, a database holding only migration 1 with a user row, and
   two instances migrating at once). Not run on Postgres; verified on SQLite only.
4. The job queue claims work safely on both. It uses an optimistic claim (update the row only if it
   is still queued), which works on both. The tests include two simultaneous claims and four
   workers draining 25 jobs, each job exactly once. Not run on Postgres, where the claims really
   do run on separate connections, so that is the run that matters.

Found by reading the Postgres code paths (also unverified until run):

- `migrate()` created `schema_migrations` outside the advisory lock, so two instances booting
  together could both run `CREATE TABLE IF NOT EXISTS` and one could fail on a catalog duplicate.
  It now runs under the lock.
- `?` inside a string literal was rewritten to `$n` on Postgres but not on SQLite. Quoted text is
  now skipped. Comments are still not recognised.
- An idle connection dropped by the server would emit an unhandled `error` on the pool and crash
  the process. The pool now has an error handler.
- Looked at and fine on paper: BIGINT and `COUNT(*)` arrive as numbers through the type parser
  (so `SUM`, which is `numeric`, would not); `LIMIT ?` and NULL parameters in `INSERT` get their
  types from the target; the `ALTER TABLE ... ADD COLUMN` in migration 2 is valid on both; the
  `LEFT JOIN` in `listAudit` is plain SQL; transactions use one pooled client from BEGIN to
  COMMIT or ROLLBACK; the first-user and migration locks are transaction-scoped.
- Differences to keep in mind: `ORDER BY` on text follows the database collation on Postgres and
  byte order on SQLite, and a failed statement aborts the rest of a Postgres transaction, so code
  must not catch a constraint error inside a transaction and carry on.

## Fallbacks

If drift keeps happening: generate one schema file from the other, move to a query builder that
abstracts dialects, or make Postgres the only database and let the desktop app be a client of a
local server.

## Outcome

_Not decided._
