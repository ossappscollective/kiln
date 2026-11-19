# ADR 0002: SQLite through node:sqlite, and SQL migrations

Status: accepted for Phase 0.

## Context

The scaffold used `better-sqlite3` for the desktop and single-user mode. It is a native module:
it has to be compiled or downloaded per platform, it needs an install script allowed in pnpm 10,
and it is the hardest part of bundling the server as a sidecar. The scaffold also planned
Drizzle-generated migrations, but runtime queries need to run on two dialects, and Drizzle's
typed query builders are separate per dialect.

## Decisions

1. **SQLite uses `node:sqlite`**, built into Node 22.18 and newer, which is already our minimum.
   No native module, nothing to compile for the image, CI or the desktop sidecar.
2. **Runtime queries are portable SQL** behind one small interface (`Sql`: `query`, `execute`,
   `transaction`) with `?` placeholders. The Postgres adapter rewrites them to `$1, $2`.
3. **Migrations are an ordered list of SQL** in `packages/db/src/migrations.ts`, applied at boot,
   each in a transaction, recorded in `schema_migrations`. Postgres takes an advisory lock (per schema) so two
   instances cannot race.
4. **The Drizzle schemas stay** as the typed description of the tables, and
   `schema-drift.test.ts` checks them against the migrated database and against each other.

## Consequences

- `node:sqlite` is still marked experimental in Node 22. Its API for what we use (prepare, run,
  all, exec) is small. Node prints an experimental warning, which the start scripts silence. If it
  breaks, only `connectSqlite` in `packages/db/src/index.ts` changes.
- One SQLite connection, so transactions queue. Fine for one user on a desktop. Hosted installs use
  Postgres.
- Postgres code paths are written but not yet run against a real server. CI needs a Postgres
  service container to run the same tests on both (see the dual-dialect spike).
- We write SQL by hand and give up compile-time column checking. Tests that touch each query are
  the safety net.
