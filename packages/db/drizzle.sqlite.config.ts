import { defineConfig } from 'drizzle-kit';

// Not used at runtime. See drizzle.pg.config.ts.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.sqlite.ts',
  out: './migrations/sqlite',
});
