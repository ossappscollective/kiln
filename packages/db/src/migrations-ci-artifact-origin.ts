import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migration 73: when a CI artifact was made and by which run, kept next to what was read from inside it (`ci_artifact_meta`, migration
 * 70). The date and the run came from GitHub's live artifact list only, so a build whose artifact GitHub no longer lists (expired, past
 * the first pages, a run beyond the last hundred) lost its date in Prepare release. They are now written when the file is read (and
 * filled in later from the list while the artifact still appears there) and survive the artifact. All columns are nullable: a row read
 * before this migration has none until the artifact is seen in the list again. `artifact_created_at` and `artifact_expires_at` are epoch
 * milliseconds as GitHub gave them. Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const ciArtifactOriginMigrations: Migration[] = [
  {
    id: 73,
    name: 'CI artifacts: when each was made and the run it came from, kept after GitHub drops it',
    statements: (dialect) => {
      const t = epoch(dialect);
      return [
        'ALTER TABLE ci_artifact_meta ADD COLUMN artifact_name TEXT',
        `ALTER TABLE ci_artifact_meta ADD COLUMN artifact_created_at ${t}`,
        `ALTER TABLE ci_artifact_meta ADD COLUMN artifact_expires_at ${t}`,
        'ALTER TABLE ci_artifact_meta ADD COLUMN run_id TEXT',
        `ALTER TABLE ci_artifact_meta ADD COLUMN run_number ${t}`,
        'ALTER TABLE ci_artifact_meta ADD COLUMN branch TEXT',
        'ALTER TABLE ci_artifact_meta ADD COLUMN head_sha TEXT',
        'ALTER TABLE ci_artifact_meta ADD COLUMN run_url TEXT',
      ];
    },
  },
];
