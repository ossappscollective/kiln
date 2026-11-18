import type { Dialect } from './dialect.ts';

/**
 * Forward-only SQL migrations, applied in order at boot (see migrate() in index.ts).
 *
 * Rules, so one list serves both dialects: text ids, epoch milliseconds in BIGINT (INTEGER on
 * SQLite), JSON as text, no vendor functions. Never edit a migration that has shipped; add a
 * new one. The drizzle schemas next to this file describe the same tables and are checked
 * against these migrations by schema-drift.test.ts.
 */
export type Migration = {
  id: number;
  name: string;
  statements: (dialect: Dialect) => string[];
};

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const migrations: Migration[] = [
  {
    id: 1,
    name: 'initial tables',
    statements: (dialect) => {
      const t = epoch(dialect);
      return [
        `CREATE TABLE IF NOT EXISTS workspaces (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           created_at ${t} NOT NULL
         )`,
        `CREATE TABLE IF NOT EXISTS users (
           id TEXT PRIMARY KEY,
           email TEXT NOT NULL UNIQUE,
           display_name TEXT NOT NULL,
           created_at ${t} NOT NULL
         )`,
        `CREATE TABLE IF NOT EXISTS workspace_members (
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           user_id TEXT NOT NULL REFERENCES users(id),
           role TEXT NOT NULL,
           PRIMARY KEY (workspace_id, user_id)
         )`,
        `CREATE TABLE IF NOT EXISTS credentials (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           kind TEXT NOT NULL,
           label TEXT NOT NULL,
           ciphertext TEXT NOT NULL,
           created_at ${t} NOT NULL,
           rotated_at ${t}
         )`,
        `CREATE TABLE IF NOT EXISTS audit_events (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           actor_type TEXT NOT NULL,
           actor_id TEXT NOT NULL,
           action TEXT NOT NULL,
           target_type TEXT,
           target_id TEXT,
           detail TEXT,
           created_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS audit_events_workspace_idx ON audit_events (workspace_id, created_at)',
        `CREATE TABLE IF NOT EXISTS jobs (
           id TEXT PRIMARY KEY,
           queue TEXT NOT NULL,
           payload TEXT NOT NULL,
           status TEXT NOT NULL,
           run_at ${t} NOT NULL,
           attempts INTEGER NOT NULL DEFAULT 0,
           last_error TEXT,
           locked_at ${t},
           created_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs (status, run_at)',
      ];
    },
  },
  {
    id: 2,
    name: 'local accounts and sessions',
    statements: (dialect) => {
      const t = epoch(dialect);
      return [
        // Nullable so rows from before this migration stay valid; a user without a hash cannot log in.
        'ALTER TABLE users ADD COLUMN password_hash TEXT',
        `CREATE TABLE IF NOT EXISTS sessions (
           id TEXT PRIMARY KEY,
           user_id TEXT NOT NULL REFERENCES users(id),
           created_at ${t} NOT NULL,
           expires_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id)',
      ];
    },
  },
  {
    id: 3,
    name: 'credential last test',
    statements: (dialect) => {
      const t = epoch(dialect);
      // All nullable: a credential that was never tested has no last test. last_test_ok is 0 or 1.
      return [
        `ALTER TABLE credentials ADD COLUMN last_test_at ${t}`,
        'ALTER TABLE credentials ADD COLUMN last_test_ok INTEGER',
        'ALTER TABLE credentials ADD COLUMN last_test_message TEXT',
      ];
    },
  },
  {
    id: 4,
    name: 'repositories and change sets',
    statements: (dialect) => {
      const t = epoch(dialect);
      // credential_id has no foreign key on purpose: deleting a credential must stay possible,
      // and a repository whose credential is gone reports that when it is used.
      // files_json holds the file changes (path, before, after) of a change set; detection_json
      // the last project scan. status: draft, approved, applying, applied, discarded, failed.
      return [
        `CREATE TABLE IF NOT EXISTS repositories (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           credential_id TEXT NOT NULL,
           owner TEXT NOT NULL,
           repo TEXT NOT NULL,
           default_branch TEXT NOT NULL,
           project_kind TEXT,
           detected_at ${t},
           detection_json TEXT,
           created_at ${t} NOT NULL
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS repositories_workspace_repo_idx ON repositories (workspace_id, owner, repo)',
        `CREATE TABLE IF NOT EXISTS change_sets (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           repository_id TEXT NOT NULL REFERENCES repositories(id),
           summary TEXT NOT NULL,
           status TEXT NOT NULL,
           created_by_type TEXT NOT NULL,
           created_by_id TEXT NOT NULL,
           files_json TEXT NOT NULL,
           branch TEXT,
           pr_url TEXT,
           pr_number INTEGER,
           commit_sha TEXT,
           error TEXT,
           created_at ${t} NOT NULL,
           updated_at ${t} NOT NULL,
           approved_by TEXT,
           approved_at ${t},
           applied_at ${t}
         )`,
        'CREATE INDEX IF NOT EXISTS change_sets_workspace_idx ON change_sets (workspace_id, created_at)',
        'CREATE INDEX IF NOT EXISTS change_sets_repository_idx ON change_sets (repository_id)',
      ];
    },
  },
  {
    id: 5,
    name: 'invitations',
    statements: (dialect) => {
      const t = epoch(dialect);
      // Only the SHA-256 of the one-time token is stored. A row is pending while accepted_at and
      // revoked_at are null and expires_at is in the future.
      return [
        `CREATE TABLE IF NOT EXISTS invitations (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           email TEXT NOT NULL,
           role TEXT NOT NULL,
           token_hash TEXT NOT NULL UNIQUE,
           created_by TEXT NOT NULL REFERENCES users(id),
           created_at ${t} NOT NULL,
           expires_at ${t} NOT NULL,
           accepted_at ${t},
           accepted_by TEXT REFERENCES users(id),
           revoked_at ${t}
         )`,
        'CREATE INDEX IF NOT EXISTS invitations_workspace_idx ON invitations (workspace_id)',
      ];
    },
  },
  {
    id: 6,
    name: 'apps and store releases',
    statements: (dialect) => {
      const t = epoch(dialect);
      // credential_id and repository_id have no foreign key on purpose: deleting a credential or
      // disconnecting a repository must stay possible; the app reports it when it is used.
      // platform is ios or android; identifier is the bundle id or package name; store_app_id is
      // the store's own id (Apple's numeric app id), filled by the first sync.
      // app_releases is a snapshot of the store: track is '' on iOS, status is the normalized
      // lifecycle state (NULL when the store's state is not mapped), raw_state the store's own,
      // details_json holds version codes and the rollout fraction.
      return [
        `CREATE TABLE IF NOT EXISTS apps (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           name TEXT NOT NULL,
           platform TEXT NOT NULL,
           identifier TEXT NOT NULL,
           store_app_id TEXT,
           credential_id TEXT NOT NULL,
           repository_id TEXT,
           last_synced_at ${t},
           last_sync_attempt_at ${t},
           last_sync_error TEXT,
           created_at ${t} NOT NULL
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS apps_workspace_identifier_idx ON apps (workspace_id, platform, identifier)',
        `CREATE TABLE IF NOT EXISTS app_releases (
           id TEXT PRIMARY KEY,
           app_id TEXT NOT NULL REFERENCES apps(id),
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           platform TEXT NOT NULL,
           version TEXT NOT NULL,
           track TEXT NOT NULL DEFAULT '',
           build TEXT,
           status TEXT,
           raw_state TEXT NOT NULL,
           details_json TEXT,
           store_updated_at ${t},
           synced_at ${t} NOT NULL
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS app_releases_app_version_idx ON app_releases (app_id, platform, version, track)',
        'CREATE INDEX IF NOT EXISTS app_releases_workspace_idx ON app_releases (workspace_id)',
      ];
    },
  },
  {
    id: 7,
    name: 'repository listing targets',
    statements: (dialect) => {
      const t = epoch(dialect);
      // A named place a repository's store listing lives: one app of a monorepo, or a custom
      // folder. Each root is a repository relative folder, or NULL when the target has no folder
      // for that store. repository_id has a foreign key: disconnecting a repository deletes its
      // targets first. The name is unique per repository.
      return [
        `CREATE TABLE IF NOT EXISTS repository_listing_targets (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           repository_id TEXT NOT NULL REFERENCES repositories(id),
           name TEXT NOT NULL,
           app_id TEXT,
           app_store_root TEXT,
           google_play_root TEXT,
           created_at ${t} NOT NULL,
           updated_at ${t} NOT NULL
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS repository_listing_targets_name_idx ON repository_listing_targets (repository_id, name)',
      ];
    },
  },
  {
    id: 8,
    name: 'api tokens, events and webhooks',
    statements: (dialect) => {
      const t = epoch(dialect);
      // The event log gets a monotonically increasing integer id (the cursor for paging and for
      // Last-Event-ID); the other ids stay application generated text.
      const eventId =
        dialect === 'postgres'
          ? 'id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY'
          : 'id INTEGER PRIMARY KEY AUTOINCREMENT';
      return [
        // Only the SHA-256 of a token is stored. role is the ceiling (admin, member or viewer);
        // app_ids and actions are JSON arrays, NULL meaning "no restriction".
        `CREATE TABLE IF NOT EXISTS api_tokens (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           created_by TEXT NOT NULL,
           name TEXT NOT NULL,
           token_hash TEXT NOT NULL,
           prefix TEXT NOT NULL,
           role TEXT NOT NULL,
           app_ids TEXT,
           actions TEXT,
           expires_at ${t},
           last_used_at ${t},
           revoked_at ${t},
           created_at ${t} NOT NULL
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS api_tokens_hash_idx ON api_tokens (token_hash)',
        'CREATE INDEX IF NOT EXISTS api_tokens_workspace_idx ON api_tokens (workspace_id)',
        `CREATE TABLE IF NOT EXISTS events (
           ${eventId},
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           type TEXT NOT NULL,
           app_id TEXT,
           repository_id TEXT,
           release_id TEXT,
           payload TEXT NOT NULL,
           created_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS events_workspace_idx ON events (workspace_id, id)',
        // The secret is encrypted with the vault, like a credential. event_types is a JSON array.
        `CREATE TABLE IF NOT EXISTS webhook_endpoints (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           url TEXT NOT NULL,
           description TEXT,
           ciphertext TEXT NOT NULL,
           event_types TEXT NOT NULL,
           enabled INTEGER NOT NULL DEFAULT 1,
           created_by TEXT NOT NULL,
           created_at ${t} NOT NULL,
           updated_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS webhook_endpoints_workspace_idx ON webhook_endpoints (workspace_id)',
        // body is the exact JSON that is signed and sent (no secrets), so a redelivery repeats it.
        `CREATE TABLE IF NOT EXISTS webhook_deliveries (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id),
           event_id ${t},
           event_type TEXT NOT NULL,
           body TEXT NOT NULL,
           status TEXT NOT NULL,
           attempts INTEGER NOT NULL DEFAULT 0,
           response_code INTEGER,
           response_body TEXT,
           error TEXT,
           redelivery_of TEXT,
           created_at ${t} NOT NULL,
           delivered_at ${t}
         )`,
        'CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at)',
      ];
    },
  },
  {
    id: 9,
    name: 'listing snapshots and listing status',
    statements: (dialect) => {
      const t = epoch(dialect);
      // History of store listing fields. A row is written only when a value differs from the
      // previous row of the same stream (same app, platform, locale, field, channel and source), so
      // the rows of one field are the sequence of its changes. value is NULL when the field is
      // absent (removed); value_hash tells NULL from an empty string. source is store, repo or
      // change_set; source_ref is a store version, a commit sha or a change set id. channel is
      // live or editable for the store, default for the others. app_id has no foreign key on
      // purpose (like credential_id on apps): deleting an app removes its rows in code.
      // app_listing_status is the last listing read per app, kept apart from apps so a failed
      // listing read never touches the release sync status.
      return [
        `CREATE TABLE IF NOT EXISTS listing_snapshots (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           app_id TEXT NOT NULL,
           platform TEXT NOT NULL,
           locale TEXT NOT NULL,
           field TEXT NOT NULL,
           channel TEXT NOT NULL DEFAULT 'live',
           value TEXT,
           value_hash TEXT NOT NULL,
           source TEXT NOT NULL,
           source_ref TEXT,
           observed_at ${t} NOT NULL,
           actor_type TEXT,
           actor_id TEXT
         )`,
        'CREATE INDEX IF NOT EXISTS listing_snapshots_field_idx ON listing_snapshots (app_id, locale, field, observed_at)',
        'CREATE INDEX IF NOT EXISTS listing_snapshots_ref_idx ON listing_snapshots (app_id, source, source_ref)',
        'CREATE INDEX IF NOT EXISTS listing_snapshots_workspace_idx ON listing_snapshots (workspace_id)',
        `CREATE TABLE IF NOT EXISTS app_listing_status (
           app_id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           listing_read_at ${t},
           listing_error TEXT,
           repo_read_at ${t},
           repo_ref TEXT,
           repo_error TEXT
         )`,
      ];
    },
  },
  {
    id: 10,
    name: 'ci workflow runs and build links',
    statements: (dialect) => {
      const t = epoch(dialect);
      // workflow_runs: one row per GitHub Actions run of a connected repository, or a placeholder
      // (status 'pending', run_id 'pending-<uuid>') for a dispatch whose run is not known yet.
      // repository_id and app_id have no foreign key on purpose (a repository can be disconnected
      // and an app deleted while rows remain; the services delete orphans). status and conclusion
      // are GitHub's own words, kept verbatim. started_at falls back to the creation time so the
      // column is never NULL and sorts the same on both dialects.
      // build_links: the run (and so the commit) a store build was made by. source is 'manual' or
      // the id of the matcher that found it; head_sha is kept so the link outlives the run row.
      return [
        `CREATE TABLE IF NOT EXISTS workflow_runs (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           repository_id TEXT NOT NULL,
           app_id TEXT,
           run_id TEXT NOT NULL,
           workflow TEXT NOT NULL,
           workflow_path TEXT,
           title TEXT,
           status TEXT NOT NULL,
           conclusion TEXT,
           head_sha TEXT,
           commit_message TEXT,
           branch TEXT,
           event TEXT,
           run_number INTEGER,
           url TEXT,
           inputs_json TEXT,
           dispatched_by TEXT,
           started_at ${t} NOT NULL,
           run_updated_at ${t} NOT NULL,
           synced_at ${t} NOT NULL
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_repository_run_idx ON workflow_runs (repository_id, run_id)',
        'CREATE INDEX IF NOT EXISTS workflow_runs_repository_started_idx ON workflow_runs (repository_id, started_at)',
        'CREATE INDEX IF NOT EXISTS workflow_runs_workspace_idx ON workflow_runs (workspace_id)',
        `CREATE TABLE IF NOT EXISTS build_links (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           app_id TEXT NOT NULL,
           platform TEXT NOT NULL,
           build_number TEXT NOT NULL,
           repository_id TEXT NOT NULL,
           run_id TEXT NOT NULL,
           head_sha TEXT NOT NULL,
           run_url TEXT,
           workflow TEXT,
           source TEXT NOT NULL,
           reason TEXT,
           linked_by TEXT,
           linked_at ${t} NOT NULL
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS build_links_app_build_idx ON build_links (app_id, platform, build_number)',
        'CREATE INDEX IF NOT EXISTS build_links_workspace_idx ON build_links (workspace_id)',
      ];
    },
  },
  {
    id: 11,
    name: 'release plans, checklists and release notes',
    statements: (dialect) => {
      const t = epoch(dialect);
      // Release planning is our own data: nothing here is read from or written to a store.
      // release_plans: one plan per app and version. platform is ios, android or NULL for a plan
      // that covers both; target_date is a calendar day (YYYY-MM-DD, compared in UTC); blocked is
      // 0 or 1 with its reason. app_id has no foreign key on purpose: deleting an app must stay
      // possible, and plans of a deleted app are not shown (the join with apps finds none).
      // checklist_items: position orders the list, required and done are 0 or 1, done_by is the user
      // who ticked it (no foreign key, so a later actor kind can be stored). release_notes: one row
      // per plan and locale; the text may be empty (an expected locale not written yet).
      // checklist_templates: items_json is a JSON array of { text, required }; the templates that ship
      // with the product are not stored.
      return [
        `CREATE TABLE IF NOT EXISTS release_plans (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           app_id TEXT NOT NULL,
           version TEXT NOT NULL,
           platform TEXT,
           target_date TEXT,
           blocked INTEGER NOT NULL DEFAULT 0,
           blocked_reason TEXT,
           notes TEXT NOT NULL DEFAULT '',
           created_by TEXT NOT NULL,
           created_at ${t} NOT NULL,
           updated_at ${t} NOT NULL
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS release_plans_app_version_idx ON release_plans (app_id, version)',
        'CREATE INDEX IF NOT EXISTS release_plans_workspace_idx ON release_plans (workspace_id)',
        `CREATE TABLE IF NOT EXISTS checklist_items (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           plan_id TEXT NOT NULL REFERENCES release_plans(id),
           position INTEGER NOT NULL,
           text TEXT NOT NULL,
           required INTEGER NOT NULL DEFAULT 0,
           done INTEGER NOT NULL DEFAULT 0,
           done_by TEXT,
           done_at ${t}
         )`,
        'CREATE INDEX IF NOT EXISTS checklist_items_plan_idx ON checklist_items (plan_id, position)',
        'CREATE INDEX IF NOT EXISTS checklist_items_workspace_idx ON checklist_items (workspace_id)',
        `CREATE TABLE IF NOT EXISTS release_notes (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           plan_id TEXT NOT NULL REFERENCES release_plans(id),
           locale TEXT NOT NULL,
           text TEXT NOT NULL,
           updated_at ${t} NOT NULL
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS release_notes_plan_locale_idx ON release_notes (plan_id, locale)',
        'CREATE INDEX IF NOT EXISTS release_notes_workspace_idx ON release_notes (workspace_id)',
        `CREATE TABLE IF NOT EXISTS checklist_templates (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           name TEXT NOT NULL,
           items_json TEXT NOT NULL,
           created_by TEXT NOT NULL,
           created_at ${t} NOT NULL,
           updated_at ${t} NOT NULL
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS checklist_templates_name_idx ON checklist_templates (workspace_id, name)',
      ];
    },
  },
  {
    id: 12,
    name: 'build number conventions, tag scans and link evidence',
    statements: (dialect) => {
      const t = epoch(dialect);
      // build_conventions: how a team names the tags and releases that carry a build number, per
      // repository (app_id '' ) or per app (the app's own row wins). *_patterns_json are JSON arrays
      // of pattern strings (see @mrm/core build-patterns); an empty array means "use the defaults".
      // tag_prefix is the literal that fills {prefix}; workflow is the release workflow (file name
      // or name) used when a tag is matched to a run by time, NULL to detect it.
      // build_scans: what the last tag and release read of a repository saw (counts, newest tag,
      // why builds did not match), as JSON, so the builds panel can explain an unlinked build
      // without asking GitHub. One row per repository, kept until the repository goes.
      // build_links.evidence_json: why a tag-based link was made (tag, pattern, commit, reason,
      // confidence). A link without a run has run_id '' and the tag's commit in head_sha.
      return [
        `CREATE TABLE IF NOT EXISTS build_conventions (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           repository_id TEXT NOT NULL,
           app_id TEXT NOT NULL,
           tag_patterns_json TEXT NOT NULL,
           release_patterns_json TEXT NOT NULL,
           tag_prefix TEXT NOT NULL,
           workflow TEXT,
           updated_by TEXT NOT NULL,
           updated_at ${t} NOT NULL
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS build_conventions_scope_idx ON build_conventions (repository_id, app_id)',
        'CREATE INDEX IF NOT EXISTS build_conventions_workspace_idx ON build_conventions (workspace_id)',
        `CREATE TABLE IF NOT EXISTS build_scans (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           repository_id TEXT NOT NULL,
           scanned_at ${t} NOT NULL,
           ok INTEGER NOT NULL,
           error TEXT,
           summary_json TEXT NOT NULL
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS build_scans_repository_idx ON build_scans (repository_id)',
        'CREATE INDEX IF NOT EXISTS build_scans_workspace_idx ON build_scans (workspace_id)',
        'ALTER TABLE build_links ADD COLUMN evidence_json TEXT',
      ];
    },
  },
  {
    id: 13,
    name: 'local clones: repositories without GitHub, and repository_local_checkouts',
    statements: (dialect) => {
      const t = epoch(dialect);
      // A repository that is only a folder on this machine has no credential, owner or repo, so
      // those three columns lose NOT NULL (NULL, never a made-up value: the unique index on
      // (workspace_id, owner, repo) treats NULLs as distinct, so any number of local-only
      // repositories can exist). Postgres changes the columns in place. SQLite cannot, so the
      // table is rebuilt: change_sets and repository_listing_targets point at repositories(id), so
      // the foreign key check is deferred to the commit of this migration's transaction and the
      // rows are copied through a backup table. DROP TABLE removes the old rows, which the deferred
      // check counts as children without a parent; inserting the same ids into the new table
      // resolves them, and the commit fails (rolling the whole migration back) if any is left.
      // repository_local_checkouts holds where a repository's clone is, one row per repository:
      // for a GitHub repository it is the optional local copy reads come from, for a local-only one
      // it is the repository itself. The path is unique per workspace. name is what a local-only
      // repository is called (the folder's name unless a person chose one). last_commit and
      // last_read_at are the commit the last read used. The default branch of a local-only
      // repository is the branch it reads.
      const rebuild =
        dialect === 'postgres'
          ? [
              'ALTER TABLE repositories ALTER COLUMN credential_id DROP NOT NULL',
              'ALTER TABLE repositories ALTER COLUMN owner DROP NOT NULL',
              'ALTER TABLE repositories ALTER COLUMN repo DROP NOT NULL',
            ]
          : [
              'PRAGMA defer_foreign_keys = ON',
              'CREATE TABLE repositories_backup AS SELECT * FROM repositories',
              'DROP TABLE repositories',
              `CREATE TABLE repositories (
                 id TEXT PRIMARY KEY,
                 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
                 credential_id TEXT,
                 owner TEXT,
                 repo TEXT,
                 default_branch TEXT NOT NULL,
                 project_kind TEXT,
                 detected_at ${t},
                 detection_json TEXT,
                 created_at ${t} NOT NULL
               )`,
              `INSERT INTO repositories
                 (id, workspace_id, credential_id, owner, repo, default_branch, project_kind,
                  detected_at, detection_json, created_at)
               SELECT id, workspace_id, credential_id, owner, repo, default_branch, project_kind,
                      detected_at, detection_json, created_at
                 FROM repositories_backup`,
              'DROP TABLE repositories_backup',
              'CREATE UNIQUE INDEX IF NOT EXISTS repositories_workspace_repo_idx ON repositories (workspace_id, owner, repo)',
            ];
      return [
        ...rebuild,
        `CREATE TABLE IF NOT EXISTS repository_local_checkouts (
           repository_id TEXT PRIMARY KEY REFERENCES repositories(id),
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           path TEXT NOT NULL,
           branch TEXT NOT NULL,
           name TEXT NOT NULL,
           last_commit TEXT,
           last_read_at ${t},
           created_by TEXT NOT NULL,
           created_at ${t} NOT NULL,
           updated_at ${t} NOT NULL
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS repository_local_checkouts_path_idx ON repository_local_checkouts (workspace_id, path)',
      ];
    },
  },
  {
    id: 14,
    name: 'change set outcomes of local commits: outcome_json and publish_claim_at',
    statements: (dialect) => {
      const t = epoch(dialect);
      // change_sets.outcome_json: what applying as a commit on a new branch of a local clone did,
      // step by step (the commit, the optional push, the optional pull request), as JSON with no
      // secret and no path (docs/adr/0005-local-clone-reads.md). NULL for a change set applied
      // through the GitHub API, whose result is in branch, pr_url, pr_number and commit_sha.
      // publish_claim_at: epoch milliseconds while a push or a pull request is being made for an
      // applied local commit, so two requests cannot publish at once; NULL otherwise. A claim
      // older than ten minutes is taken to be abandoned.
      return [
        'ALTER TABLE change_sets ADD COLUMN outcome_json TEXT',
        `ALTER TABLE change_sets ADD COLUMN publish_claim_at ${t}`,
      ];
    },
  },
];
