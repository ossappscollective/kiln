import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migration 71: where a batch publish is. `store_publish_claims` (migration 29) said "a publish is running for this app" and nothing
 * else, so no screen could tell a person WHICH steps run or which one is running now. Three nullable columns: `steps` (the step
 * types the batch runs, a JSON array of words such as `["push_draft","submit"]`, never a text), `current_step` (the step that runs
 * now, NULL between steps) and `step_at` (epoch milliseconds, set whenever a step starts or ends: the claim's heartbeat, so a claim
 * that nobody has touched for the time to live is a process that died). Rows of migration 29 keep NULL and read as "a publish, no
 * detail". Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const publishProgressMigrations: Migration[] = [
  {
    id: 71,
    name: 'Store publish claims: the steps of the batch, the step that runs now and its heartbeat',
    statements: (dialect) => [
      'ALTER TABLE store_publish_claims ADD COLUMN steps TEXT',
      'ALTER TABLE store_publish_claims ADD COLUMN current_step TEXT',
      `ALTER TABLE store_publish_claims ADD COLUMN step_at ${epoch(dialect)}`,
    ],
  },
];
