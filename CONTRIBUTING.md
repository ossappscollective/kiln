# Contributing

The project is at Phase 0. Read [docs/phase-0.md](docs/phase-0.md) and
[docs/architecture.md](docs/architecture.md) first.

- Use Node 22.18 or newer and pnpm 10.
- Keep TypeScript to erasable syntax and use `.ts` extensions in relative imports.
- Add a test with every change to `core`, `vault`, `db` or `connectors`.
- Run `pnpm lint`, `pnpm typecheck` and `pnpm test` before opening a pull request.
- Contributions are licensed under Apache-2.0.

## Testing against Postgres

Tests for the database and the server run on SQLite (in memory) always, and on Postgres too when
`KILN_TEST_POSTGRES_URL` is set. Without it, the Postgres cases show up as skipped (`[postgres]` in
the test name) instead of being left out, so a green run on a laptop without Postgres is not a
Postgres pass. CI sets the variable.

To run both locally:

```sh
docker compose -f docker-compose.test.yml up -d --wait
KILN_TEST_POSTGRES_URL=postgres://mrm_test:mrm_test@localhost:55432/mrm_test pnpm test
docker compose -f docker-compose.test.yml down
```

Each Postgres test creates its own schema with a random name in that database and drops it when
it ends, so tests do not see each other's data. Use a database you do not mind us creating schemas
in; the one from the compose file is thrown away with the container.

When you write a test that touches the database, use `dbTest` from `@kiln/db/testing`. It runs the
body once per available database and closes the database afterwards:

```ts
import { migrate } from '@kiln/db';
import { dbTest } from '@kiln/db/testing';

dbTest('inserts a workspace', async (db) => {
  await migrate(db);
  // ...
});
```

Keep a test that needs a SQLite-only feature (`pragma_*`, `sqlite_master`) as a plain `test`, and
write its Postgres counterpart with `dbTest(name, { dialects: ['postgres'] }, body)`. `tableNames`, `tableColumns` and
`tableIndexes` in the same module read the schema of either database.
