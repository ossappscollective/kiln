import { defineConfig } from 'drizzle-kit';

// Not used at runtime: the server applies the SQL in src/migrations.ts. Use this to see the SQL
// drizzle would write for a schema change (`pnpm --filter @kiln/db generate:pg`), then copy what you
// need into a new migration there. schema-drift.test.ts keeps the schema and migrations in step.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.pg.ts',
  out: './migrations/pg',
});
