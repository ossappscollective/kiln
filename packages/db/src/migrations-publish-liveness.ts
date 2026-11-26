import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migration 74: how a person (and the server) can tell a publish that runs from a claim that nobody works on any more. Migration 71 gave
 * a batch claim a heartbeat that moved only at a step boundary, so a step that legitimately took minutes looked the same as a process that
 * had died, and a server restart left a claim that read as "running" until the time to live was over. Five nullable columns:
 * `instance_id` (the boot id of the server process that owns the claim: a claim of another process is a ghost after a restart),
 * `heartbeat_at` (epoch milliseconds, renewed by a timer while the batch runs), `detail` and `detail_at` (what the running step says it
 * is doing, a small JSON of a fixed word and two numbers such as `{"phase":"uploading","done":12,"total":40}`, never a text of the store)
 * and `steps_done` (how many steps ended applied, so a run that was interrupted can say which ones went through). Rows of migration 71
 * keep NULL and read as before. Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const publishLivenessMigrations: Migration[] = [
  {
    id: 74,
    name: 'Store publish claims: the owning process, a heartbeat, what the running step is doing and how many steps are done',
    statements: (dialect) => [
      'ALTER TABLE store_publish_claims ADD COLUMN instance_id TEXT',
      `ALTER TABLE store_publish_claims ADD COLUMN heartbeat_at ${epoch(dialect)}`,
      'ALTER TABLE store_publish_claims ADD COLUMN detail TEXT',
      `ALTER TABLE store_publish_claims ADD COLUMN detail_at ${epoch(dialect)}`,
      'ALTER TABLE store_publish_claims ADD COLUMN steps_done INTEGER',
    ],
  },
];
