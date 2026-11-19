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
  {
    id: 15,
    name: 'release plan rollout steps and reminder log',
    statements: (dialect) => {
      const t = epoch(dialect);
      // Staged rollout as planning data (nothing here is read from or written to a store).
      // release_plans.rollout_kind: NULL when the plan has no rollout plan, 'steps' (our own list of
      // percentages) or 'apple_phased' (Apple's fixed 7-day schedule, shown for information, with no
      // rows of its own). rollout_template: the built-in template the plan started from, if any.
      // rollout_start_at: epoch milliseconds of the expected day 1 of an Apple phased release.
      // plan_rollout_steps: one row per step, in position order (a plain index, not a unique one,
      // so a step can be moved without a transient clash). percent is a whole number 1 to 100;
      // status is planned, done or skipped; done_source is manual or store (a person confirmed it
      // against the share a sync saw). A table, not JSON on the plan: a step changes state on its
      // own (UPDATE ... WHERE status = ... is atomic between server instances) and the reminder
      // scan finds due steps with an index instead of parsing every plan.
      // plan_reminders: which reminder was already sent, so a restart, a second tick or a second
      // server instance never sends one twice. The primary key is the lock: an instance sends a
      // reminder only if its INSERT ... ON CONFLICT DO NOTHING added the row. item_id is
      // 'target_date' for the deadline of the plan or a rollout step id; kind is due_soon,
      // overdue or rollout_step_due; due_key is the due date (YYYY-MM-DD) or the planned time of
      // the step, so changing the date makes a new key and re-arms the reminder.
      return [
        'ALTER TABLE release_plans ADD COLUMN rollout_kind TEXT',
        'ALTER TABLE release_plans ADD COLUMN rollout_template TEXT',
        `ALTER TABLE release_plans ADD COLUMN rollout_start_at ${t}`,
        `CREATE TABLE IF NOT EXISTS plan_rollout_steps (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           plan_id TEXT NOT NULL REFERENCES release_plans(id),
           position INTEGER NOT NULL,
           percent INTEGER NOT NULL,
           planned_at ${t},
           note TEXT,
           status TEXT NOT NULL DEFAULT 'planned',
           done_at ${t},
           done_by TEXT,
           done_source TEXT
         )`,
        'CREATE INDEX IF NOT EXISTS plan_rollout_steps_plan_idx ON plan_rollout_steps (plan_id, position)',
        'CREATE INDEX IF NOT EXISTS plan_rollout_steps_due_idx ON plan_rollout_steps (status, planned_at)',
        `CREATE TABLE IF NOT EXISTS plan_reminders (
           plan_id TEXT NOT NULL REFERENCES release_plans(id),
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           item_id TEXT NOT NULL,
           kind TEXT NOT NULL,
           due_key TEXT NOT NULL,
           sent_at ${t} NOT NULL,
           PRIMARY KEY (plan_id, item_id, kind, due_key)
         )`,
        'CREATE INDEX IF NOT EXISTS plan_reminders_workspace_idx ON plan_reminders (workspace_id)',
      ];
    },
  },
  {
    id: 16,
    name: 'listing read attempts: listing_attempt_at, listing_failures and listing_warnings',
    statements: (dialect) => {
      const t = epoch(dialect);
      // app_listing_status.listing_attempt_at: when the last listing read of the app was tried, by
      // any path (a manual refresh, an app sync or a scheduled read), successful or not. The
      // scheduled listing read (MRM_LISTING_INTERVAL_MINUTES) is due an interval after it, and
      // claims a read with a compare-and-set on it so two instances do not read one app at once.
      // listing_failures: reads in a row that failed (0 after a success); the scheduler backs off
      // by it. Both are NULL / 0 for every row that existed before: such an app is simply due.
      // listing_warnings: the connector's warnings of the last successful read (a JSON array of
      // short sentences), NULL when there were none or no read has happened since the upgrade.
      // The new listing sections (categories, age rating, ...) need no column: they are rows of
      // listing_snapshots (locale _app, field section:<name>).
      return [
        `ALTER TABLE app_listing_status ADD COLUMN listing_attempt_at ${t}`,
        'ALTER TABLE app_listing_status ADD COLUMN listing_failures INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE app_listing_status ADD COLUMN listing_warnings TEXT',
      ];
    },
  },
  {
    id: 17,
    name: 'change set origin: the request a change set was made from (origin_json)',
    statements: () => {
      // change_sets.origin_json: what a change set was made from, as JSON, so it can be made again
      // from the current sources (docs/api/listing.md, "Recompute a pull"). Today only the store
      // pull writes it: { v, source: 'store_pull', appId, channel, request (the locales, fields,
      // items, addLocales, folders and summary of the pull), fields (per pulled field: locale, repo
      // locale, field and a hash of the text, never the text) }. NULL for every row that existed
      // before and for change sets from other sources: those cannot be recomputed.
      return ['ALTER TABLE change_sets ADD COLUMN origin_json TEXT'];
    },
  },
  {
    id: 18,
    name: 'app icons: app_icons, the resolved icon of an app',
    statements: (dialect) => {
      const t = epoch(dialect);
      // app_icons: at most one row per app (app_id is the key; it has no foreign key on purpose,
      // deleting an app removes the row in code, like the listing snapshots). The icon is stored
      // as base64 text (at most 256 KB of image, so at most about 342 KB of text), which both
      // dialects take without a binary column. source is repository, app_store or google_play;
      // source_id is what identifies the bytes there: the git blob id of the file, or the host
      // of the image URL. etag is a hash of the bytes (the HTTP ETag of the icon route).
      // checked_at is the last time the source was looked at (a successful read or not),
      // failures the failed attempts in a row and backoff_until when the next attempt is allowed.
      // A row without data records only a failed or empty look (there is no icon to show).
      return [
        `CREATE TABLE IF NOT EXISTS app_icons (
           app_id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           source TEXT,
           source_id TEXT,
           media_type TEXT,
           data TEXT,
           size INTEGER,
           width INTEGER,
           height INTEGER,
           etag TEXT,
           fetched_at ${t},
           checked_at ${t} NOT NULL,
           failures INTEGER NOT NULL DEFAULT 0,
           backoff_until ${t},
           last_error TEXT
         )`,
        'CREATE INDEX IF NOT EXISTS app_icons_workspace_idx ON app_icons (workspace_id)',
      ];
    },
  },
  {
    id: 19,
    name: 'customer reviews inbox: app_reviews, review_sync_state and app_rating_summaries',
    statements: (dialect) => {
      const t = epoch(dialect);
      // app_reviews: one row per review the store returned (read only; nothing is ever sent to a
      // store). The review text and the public display name are third-party personal data that the
      // store itself shows: only what the store returns is kept, and MRM_REVIEW_RETENTION_DAYS
      // prunes old rows. app_id has no foreign key on purpose (deleting an app removes its rows in
      // code, like the listing snapshots). store is appstoreconnect or googleplay; store_review_id
      // is the store's own id, unique per app, so a re-sync upserts. created_at and updated_at are
      // the store's times (Google Play sends only a last modification time: it fills both on the
      // first read, and created_at is kept after that); first_seen_at is when we first read it and
      // fetched_at the last read. developer_response is JSON {body, at?, state?} or NULL.
      // status is our own triage state (new, triaged, replied_in_console, ignored) with the
      // assignee, an internal note and who changed it when; none of it goes to a store.
      // low_rating_notified_at: when review.new_low_rating was emitted for this review (or when it
      // was recorded as part of a quiet baseline), so a re-sync never emits it twice.
      // review_sync_state: one row per app and store with the continuation cursor of an unfinished
      // read (App Store), the last attempt and success, the last error, the failure streak, the
      // time before which the scheduler does not try again (backoff), when review.sync_failed was
      // last emitted for the streak, when a gap (a Play window missed) was last detected, and the
      // last result as JSON. app_rating_summaries: the store-wide rating of an app per territory
      // (public iTunes lookup), a row only when a value changed; averages are thousandths.
      return [
        `CREATE TABLE IF NOT EXISTS app_reviews (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           app_id TEXT NOT NULL,
           store TEXT NOT NULL,
           store_review_id TEXT NOT NULL,
           rating INTEGER NOT NULL,
           title TEXT,
           body TEXT NOT NULL,
           author_name TEXT,
           territory TEXT,
           language TEXT,
           app_version TEXT,
           build_number TEXT,
           device TEXT,
           created_at ${t} NOT NULL,
           updated_at ${t} NOT NULL,
           first_seen_at ${t} NOT NULL,
           fetched_at ${t} NOT NULL,
           developer_response TEXT,
           status TEXT NOT NULL DEFAULT 'new',
           assignee_user_id TEXT,
           internal_note TEXT,
           status_changed_at ${t},
           status_changed_by TEXT,
           low_rating_notified_at ${t}
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS app_reviews_store_id_idx ON app_reviews (app_id, store_review_id)',
        'CREATE INDEX IF NOT EXISTS app_reviews_app_created_idx ON app_reviews (app_id, created_at)',
        'CREATE INDEX IF NOT EXISTS app_reviews_app_rating_idx ON app_reviews (app_id, rating)',
        'CREATE INDEX IF NOT EXISTS app_reviews_app_status_idx ON app_reviews (app_id, status)',
        'CREATE INDEX IF NOT EXISTS app_reviews_workspace_idx ON app_reviews (workspace_id)',
        `CREATE TABLE IF NOT EXISTS review_sync_state (
           app_id TEXT NOT NULL,
           store TEXT NOT NULL,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           cursor TEXT,
           last_attempt_at ${t},
           last_success_at ${t},
           last_error TEXT,
           consecutive_failures INTEGER NOT NULL DEFAULT 0,
           backoff_until ${t},
           failure_notified_at ${t},
           last_gap_at ${t},
           last_result TEXT,
           PRIMARY KEY (app_id, store)
         )`,
        'CREATE INDEX IF NOT EXISTS review_sync_state_workspace_idx ON review_sync_state (workspace_id)',
        `CREATE TABLE IF NOT EXISTS app_rating_summaries (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           app_id TEXT NOT NULL,
           store TEXT NOT NULL,
           territory TEXT NOT NULL,
           average_milli INTEGER,
           rating_count INTEGER,
           current_average_milli INTEGER,
           current_count INTEGER,
           observed_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS app_rating_summaries_app_idx ON app_rating_summaries (app_id, store, territory, observed_at)',
        'CREATE INDEX IF NOT EXISTS app_rating_summaries_workspace_idx ON app_rating_summaries (workspace_id)',
      ];
    },
  },
  {
    id: 20,
    name: 'workspace settings, review translations and translation usage',
    statements: (dialect) => {
      const t = epoch(dialect);
      // workspace_settings: one row per workspace and setting key; value_json is the JSON of the
      // value. The registry of known keys, their validation and their defaults live in code
      // (services/workspace-settings.ts): a key that is not set has no row. Secrets never go here:
      // they live in the vault. updated_by is the user (or token owner) who last changed it.
      // review_translations: the translation of one field (title or body) of a review into a target
      // language by one provider, reused until the review text changes: source_hash is the SHA-256 of
      // the source text, so an edited review misses and is translated again. review_id and app_id
      // have no foreign key on purpose (a review that is pruned, or an app that is deleted, leaves
      // rows that code removes, like the other review tables). The translated text is derived from
      // third-party personal data and is treated like the review itself.
      // translation_usage: characters sent to a provider per workspace and UTC day (YYYY-MM-DD),
      // for the daily budget.
      return [
        `CREATE TABLE IF NOT EXISTS workspace_settings (
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           key TEXT NOT NULL,
           value_json TEXT NOT NULL,
           updated_at ${t} NOT NULL,
           updated_by TEXT,
           PRIMARY KEY (workspace_id, key)
         )`,
        `CREATE TABLE IF NOT EXISTS review_translations (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           app_id TEXT NOT NULL,
           review_id TEXT NOT NULL,
           field TEXT NOT NULL,
           target_lang TEXT NOT NULL,
           provider TEXT NOT NULL,
           source_hash TEXT NOT NULL,
           translated_text TEXT NOT NULL,
           detected_source TEXT,
           created_at ${t} NOT NULL
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS review_translations_key_idx ON review_translations (review_id, field, target_lang, provider, source_hash)',
        'CREATE INDEX IF NOT EXISTS review_translations_app_idx ON review_translations (app_id)',
        'CREATE INDEX IF NOT EXISTS review_translations_workspace_idx ON review_translations (workspace_id)',
        `CREATE TABLE IF NOT EXISTS translation_usage (
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           day TEXT NOT NULL,
           chars INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (workspace_id, day)
         )`,
      ];
    },
  },
  {
    id: 21,
    name: 'review replies (drafts, templates) and workspace-wide inbox indexes',
    statements: (dialect) => {
      const t = epoch(dialect);
      // review_reply_drafts: the reply a person is preparing for a review, and, once sent, the record
      // of the last reply this server published. ONE ROW PER REVIEW (UNIQUE review_id) with replace
      // semantics: saving a draft over a sent one resets it to a draft (the store keeps the text that
      // is live; the history is in the audit log by hash and length, never by text). A second active
      // draft per review cannot exist, so there is nothing to merge and the claim below is per row.
      // status: draft, sending (a send is in flight: claim_at is its start and expires), sent, failed
      // (the store refused or the call failed: the draft is kept) or unknown (the outcome could not
      // be told, a re-read of the review settles it). text is the plain text that goes to the store
      // and text_hash its SHA-256 hex (what the person confirms). evidence is JSON about how an
      // unknown outcome was settled: NEVER the text. store_response_id is the store's id of the
      // response (App Store) when it said. review_id is a real foreign key with ON DELETE CASCADE:
      // retention pruning and deleting an app remove the drafts (the code also deletes them, so it does
      // not depend on foreign key enforcement). app_id is kept for scoping and has no foreign key
      // (like the other review tables).
      // review_reply_templates: workspace-wide reply templates with {{author}} and {{app}}.
      // The three indexes on app_reviews serve the workspace-wide inbox (workspace_id first, then
      // the sort key and id, so a page is an index range scan without a sort).
      return [
        `CREATE TABLE IF NOT EXISTS review_reply_drafts (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           app_id TEXT NOT NULL,
           review_id TEXT NOT NULL REFERENCES app_reviews(id) ON DELETE CASCADE,
           store TEXT NOT NULL,
           text TEXT NOT NULL,
           text_hash TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'draft',
           error_code TEXT,
           evidence TEXT,
           created_by TEXT NOT NULL,
           updated_by TEXT NOT NULL,
           created_at ${t} NOT NULL,
           updated_at ${t} NOT NULL,
           sent_at ${t},
           sent_by TEXT,
           claim_at ${t},
           store_response_id TEXT
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS review_reply_drafts_review_idx ON review_reply_drafts (review_id)',
        'CREATE INDEX IF NOT EXISTS review_reply_drafts_workspace_idx ON review_reply_drafts (workspace_id, status)',
        'CREATE INDEX IF NOT EXISTS review_reply_drafts_app_idx ON review_reply_drafts (app_id)',
        `CREATE TABLE IF NOT EXISTS review_reply_templates (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           name TEXT NOT NULL,
           body TEXT NOT NULL,
           created_by TEXT NOT NULL,
           created_at ${t} NOT NULL,
           updated_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS review_reply_templates_workspace_idx ON review_reply_templates (workspace_id)',
        'CREATE INDEX IF NOT EXISTS app_reviews_ws_created_idx ON app_reviews (workspace_id, created_at, id)',
        'CREATE INDEX IF NOT EXISTS app_reviews_ws_updated_idx ON app_reviews (workspace_id, updated_at, id)',
        'CREATE INDEX IF NOT EXISTS app_reviews_ws_rating_idx ON app_reviews (workspace_id, rating, created_at, id)',
      ];
    },
  },
  {
    id: 22,
    name: 'store rollout claims (one live-store rollout write in flight per app and platform)',
    statements: (dialect) => {
      const t = epoch(dialect);
      // store_rollout_claims: the claim a gated rollout write takes before it touches a store (see
      // docs/adr/0008-store-rollout-writes.md). One row per (app, platform): the primary key is what
      // makes "one write in flight" true across several processes. status: writing (a write is in
      // flight; claim_at is its start and the claim expires after a time to live) or unknown (the
      // outcome of the last write could not be told; it blocks writing until a successful re-read of
      // the store, i.e. a new preview, clears it). The row is deleted when a write settles. No foreign
      // key on app_id (like the review tables): deleting an app deletes its claims in the code.
      // action is the requested change (halt, resume, ...); never a credential or a store response.
      return [
        `CREATE TABLE IF NOT EXISTS store_rollout_claims (
           app_id TEXT NOT NULL,
           platform TEXT NOT NULL,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           action TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'writing',
           claimed_by TEXT NOT NULL,
           claim_at ${t} NOT NULL,
           PRIMARY KEY (app_id, platform)
         )`,
        'CREATE INDEX IF NOT EXISTS store_rollout_claims_workspace_idx ON store_rollout_claims (workspace_id)',
      ];
    },
  },
  {
    id: 23,
    name: 'staged store changes (listing text and graphics collected per app) and store draft write claims',
    statements: (dialect) => {
      const t = epoch(dialect);
      // staged_changes: what a person has collected to be written into a store as a DRAFT (see
      // docs/adr/0009-staged-store-drafts.md). Nothing here is ever sent to a store by itself.
      // One row is a listing text of one locale (kind listing_text, target = the listing field,
      // ordinal 0) or one FILE of a set of graphics (kind asset, target = the slot such as
      // `screenshot:iphone_6_5` or `icon`, ordinal = its place in the set). A push replaces the whole
      // set, so the rows of one slot are the set. Assets are kept by REFERENCE (repository path, commit
      // and git blob id): the bytes are read from the clone at push time and checked against the oid.
      // value_hash: SHA-256 of the normalized text, or the blob id of a file. pushed_at / pushed_hash:
      // when the row was last written to a store as a draft and with which hash. No foreign key on
      // app_id (like the review tables): deleting an app deletes its rows in the code. The text is
      // listing text, never a credential; audit entries and events carry hashes and ids only.
      // store_draft_claims: the claim a draft write takes before it touches a store, one row per app and
      // platform (the primary key is what makes one write in flight true across processes). status:
      // writing (claim_at is its start; it expires after a time to live) or unknown (the outcome of the
      // last write could not be told; it blocks writing until a successful re-read, i.e. a new preview).
      return [
        `CREATE TABLE IF NOT EXISTS staged_changes (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           app_id TEXT NOT NULL,
           platform TEXT NOT NULL,
           kind TEXT NOT NULL,
           locale TEXT NOT NULL,
           target TEXT NOT NULL,
           ordinal INTEGER NOT NULL DEFAULT 0,
           source TEXT NOT NULL,
           value_text TEXT,
           value_hash TEXT NOT NULL,
           asset_path TEXT,
           asset_commit TEXT,
           asset_bytes INTEGER,
           asset_width INTEGER,
           asset_height INTEGER,
           asset_format TEXT,
           asset_alpha INTEGER,
           created_by TEXT NOT NULL,
           created_at ${t} NOT NULL,
           updated_at ${t} NOT NULL,
           pushed_at ${t},
           pushed_hash TEXT
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS staged_changes_slot_idx ON staged_changes (app_id, kind, locale, target, ordinal)',
        'CREATE INDEX IF NOT EXISTS staged_changes_workspace_idx ON staged_changes (workspace_id, app_id)',
        `CREATE TABLE IF NOT EXISTS store_draft_claims (
           app_id TEXT NOT NULL,
           platform TEXT NOT NULL,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           action TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'writing',
           claimed_by TEXT NOT NULL,
           claim_at ${t} NOT NULL,
           PRIMARY KEY (app_id, platform)
         )`,
        'CREATE INDEX IF NOT EXISTS store_draft_claims_workspace_idx ON store_draft_claims (workspace_id)',
      ];
    },
  },

  {
    id: 24,
    name: 'store draft pushes (what was written to a store draft) and store submit claims',
    statements: (dialect) => {
      const t = epoch(dialect);
      // store_draft_pushes: the record of what the last SUCCESSFUL draft pushes of an app and platform
      // wrote to the store's draft (see docs/adr/0010-store-submit.md). A submit for review requires
      // it, and reads the store again to check the draft still holds exactly this. One row per
      // (app, platform); a later push merges its items into `items`; a successful submit deletes
      // the row, so a second submit needs a new push. `items` is JSON: for each pushed text
      // locale, field and the SHA-256 of the normalized value; for each pushed set locale, slot,
      // the store's name of it, the pixel size of the first file and each file's MD5 and SHA-256.
      // Hashes and ids only: never a text, a file or a credential. confirm_hash is the hash of
      // the push's own confirmation. version_id and version_string: the App Store version that
      // was written (null on Google Play). No foreign key on app_id (like the other store tables):
      // deleting an app deletes its row in the code.
      // store_submit_claims: the claim a submit for review takes before it touches a store, one row
      // per app and platform, with the semantics of store_rollout_claims: status writing (claim_at
      // is its start, it expires after a time to live) or unknown (the outcome of the last submit
      // could not be told; it blocks submitting until a successful re-read, i.e. a new preview).
      return [
        `CREATE TABLE IF NOT EXISTS store_draft_pushes (
           app_id TEXT NOT NULL,
           platform TEXT NOT NULL,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           version_id TEXT,
           version_string TEXT,
           confirm_hash TEXT NOT NULL,
           items TEXT NOT NULL,
           pushed_by TEXT NOT NULL,
           pushed_at ${t} NOT NULL,
           updated_at ${t} NOT NULL,
           PRIMARY KEY (app_id, platform)
         )`,
        'CREATE INDEX IF NOT EXISTS store_draft_pushes_workspace_idx ON store_draft_pushes (workspace_id)',
        `CREATE TABLE IF NOT EXISTS store_submit_claims (
           app_id TEXT NOT NULL,
           platform TEXT NOT NULL,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           action TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'writing',
           claimed_by TEXT NOT NULL,
           claim_at ${t} NOT NULL,
           PRIMARY KEY (app_id, platform)
         )`,
        'CREATE INDEX IF NOT EXISTS store_submit_claims_workspace_idx ON store_submit_claims (workspace_id)',
      ];
    },
  },

  {
    id: 25,
    name: 'ASO: tracked keywords, rank checks, competitors, competitor snapshots and per app run state',
    statements: (dialect) => {
      const t = epoch(dialect);
      // App Store Optimization (docs/adr/0011-aso-keywords-competitors.md). Everything here is PUBLIC
      // store data read without a credential (the iTunes Search API; optionally the public pages of
      // Google Play), kept for ranking history. Nothing is ever written to a store. app_id has no
      // foreign key on purpose (like the review and listing tables): deleting an app deletes its rows
      // in code. Counts, ids and public short fields only; MRM_ASO_RETENTION_DAYS prunes old rows.
      // aso_keywords: one tracked search term of an app in one storefront (country, two letters, lower
      // case) and listing locale. term is as typed (white space collapsed), term_key the normalized form
      // that makes two spellings one keyword (unique per app, country and locale). priority 1 low, 2
      // normal, 3 high (orders the gaps of the listing fit). last_* and prev_* are the latest and the
      // previous check, kept here so lists need no join: last_state is ranked, not_ranked or
      // unavailable (the source could not say: a changed page, a block; never "not ranked"), last_total
      // the number of results looked at, last_error a short code (no text from the store).
      // aso_rank_checks: one row per check of a keyword. rank_pos is the 1-based position in the
      // source's results, NULL when the app is not among the first `total` results. source is
      // apple_search or play_public. top_results is JSON [{id, name}] of the first results (at most 20,
      // public app ids and names), what competitor suggestions are computed from.
      // aso_competitors: an app a person chose to follow, for one of our apps. store is app_store or
      // google_play, external_id the numeric App Store id or the Android package name, country the
      // storefront. last_state is ok, not_found or unavailable.
      // aso_competitor_snapshots: the public data of a competitor, stored on its first look, when it
      // changed, and as a heartbeat (kind first, change or heartbeat). rating_milli is the average in
      // thousandths. text_hash covers title, subtitle and description, description_hash the description
      // alone, media_hash the icon and screenshot addresses; description_excerpt is at most 1000
      // characters of the public description; changes is a JSON list of the fields that differ from the
      // previous snapshot.
      // aso_app_state: one row per app: the last run, its failure streak and backoff for the scheduler,
      // and the claim (claimed_at, which expires) that keeps one refresh of an app at a time across
      // processes; last_result is a JSON summary of counts.
      return [
        `CREATE TABLE IF NOT EXISTS aso_keywords (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           app_id TEXT NOT NULL,
           platform TEXT NOT NULL,
           country TEXT NOT NULL,
           locale TEXT NOT NULL,
           term TEXT NOT NULL,
           term_key TEXT NOT NULL,
           tag TEXT,
           notes TEXT,
           priority INTEGER NOT NULL DEFAULT 2,
           created_by TEXT NOT NULL,
           created_at ${t} NOT NULL,
           updated_at ${t} NOT NULL,
           last_checked_at ${t},
           last_state TEXT,
           last_rank_pos INTEGER,
           last_total INTEGER,
           prev_state TEXT,
           prev_rank_pos INTEGER,
           last_error TEXT
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS aso_keywords_unique_idx ON aso_keywords (app_id, country, locale, term_key)',
        'CREATE INDEX IF NOT EXISTS aso_keywords_workspace_idx ON aso_keywords (workspace_id, app_id)',
        `CREATE TABLE IF NOT EXISTS aso_rank_checks (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           keyword_id TEXT NOT NULL REFERENCES aso_keywords(id) ON DELETE CASCADE,
           app_id TEXT NOT NULL,
           checked_at ${t} NOT NULL,
           rank_pos INTEGER,
           total INTEGER NOT NULL,
           source TEXT NOT NULL,
           top_results TEXT
         )`,
        'CREATE INDEX IF NOT EXISTS aso_rank_checks_keyword_idx ON aso_rank_checks (keyword_id, checked_at)',
        'CREATE INDEX IF NOT EXISTS aso_rank_checks_workspace_idx ON aso_rank_checks (workspace_id, checked_at)',
        `CREATE TABLE IF NOT EXISTS aso_competitors (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           app_id TEXT NOT NULL,
           store TEXT NOT NULL,
           external_id TEXT NOT NULL,
           country TEXT NOT NULL,
           name TEXT NOT NULL,
           added_by TEXT NOT NULL,
           added_at ${t} NOT NULL,
           last_checked_at ${t},
           last_state TEXT,
           last_error TEXT
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS aso_competitors_unique_idx ON aso_competitors (app_id, store, external_id, country)',
        'CREATE INDEX IF NOT EXISTS aso_competitors_workspace_idx ON aso_competitors (workspace_id, app_id)',
        `CREATE TABLE IF NOT EXISTS aso_competitor_snapshots (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           competitor_id TEXT NOT NULL REFERENCES aso_competitors(id) ON DELETE CASCADE,
           app_id TEXT NOT NULL,
           checked_at ${t} NOT NULL,
           kind TEXT NOT NULL,
           version TEXT,
           rating_milli INTEGER,
           rating_count INTEGER,
           price TEXT,
           currency TEXT,
           title TEXT,
           subtitle TEXT,
           description_excerpt TEXT,
           text_hash TEXT NOT NULL,
           description_hash TEXT,
           screenshot_count INTEGER,
           media_hash TEXT,
           changes TEXT
         )`,
        'CREATE INDEX IF NOT EXISTS aso_competitor_snapshots_competitor_idx ON aso_competitor_snapshots (competitor_id, checked_at)',
        'CREATE INDEX IF NOT EXISTS aso_competitor_snapshots_workspace_idx ON aso_competitor_snapshots (workspace_id, checked_at)',
        `CREATE TABLE IF NOT EXISTS aso_app_state (
           app_id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           last_attempt_at ${t},
           last_success_at ${t},
           last_error TEXT,
           consecutive_failures INTEGER NOT NULL DEFAULT 0,
           backoff_until ${t},
           claimed_at ${t},
           claimed_by TEXT,
           last_result TEXT
         )`,
        'CREATE INDEX IF NOT EXISTS aso_app_state_workspace_idx ON aso_app_state (workspace_id)',
      ];
    },
  },
  {
    id: 26,
    name: 'staged asset blobs (images uploaded or fixed here, kept until pushed or removed)',
    statements: (dialect) => {
      const t = epoch(dialect);
      // staged_asset_blobs: the bytes of an image a person uploaded (or fixed in the app) to a staged set of
      // graphics, see docs/adr/0012-assets-two-way-sync.md. A staged_changes row of `source = 'local'` and `kind = 'asset'`
      // points at its blob by (app_id, oid): `value_hash` of the row is the git blob id of the bytes, so the push
      // checks them exactly as it checks a file of the repository. The bytes are base64 text (the database layer has
      // no binary parameter, like app_icons), at most 8 MiB of image per row and 64 MiB per app (enforced in code).
      // sha256 is kept for the store comparison and for the preview. No foreign key on app_id (like the other staged
      // tables): deleting an app deletes its blobs in code. A blob nothing refers to any more is deleted by the code
      // that removes a staged row. Bytes are never audited, logged or put in an event.
      return [
        `CREATE TABLE IF NOT EXISTS staged_asset_blobs (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           app_id TEXT NOT NULL,
           oid TEXT NOT NULL,
           sha256 TEXT NOT NULL,
           size INTEGER NOT NULL,
           media_type TEXT NOT NULL,
           data TEXT NOT NULL,
           created_by TEXT NOT NULL,
           created_at ${t} NOT NULL
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS staged_asset_blobs_oid_idx ON staged_asset_blobs (app_id, oid)',
        'CREATE INDEX IF NOT EXISTS staged_asset_blobs_workspace_idx ON staged_asset_blobs (workspace_id, app_id)',
      ];
    },
  },
  {
    id: 27,
    name: 'store release claims (releasing an approved App Store version, starting a Google Play draft release)',
    statements: (dialect) => {
      const t = epoch(dialect);
      // store_release_claims: the claim a RELEASE takes before it touches a store (docs/adr/0014-release-management.md),
      // one row per app and platform, with the semantics of store_submit_claims: status writing (claim_at is its
      // start, it expires after a time to live) or unknown (the outcome of the last release could not be told; it
      // blocks releasing until a successful re-read, i.e. a new preview). The primary key is what makes "one release
      // in flight per app and platform" true across processes. No foreign key on app_id (like the other store
      // tables): deleting an app deletes its row in code.
      // Nothing else changes: the new staged item kind `release_field` (an App Store version field or a Google Play
      // draft release field, collected like a listing text) needs no column, because staged_changes.kind is free text
      // and the existing columns hold it (locale '' for a field that has none, target = the field id, value_text = the
      // value, value_hash = its SHA-256). Rows of migrations 1 to 26 are not touched.
      return [
        `CREATE TABLE IF NOT EXISTS store_release_claims (
           app_id TEXT NOT NULL,
           platform TEXT NOT NULL,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           action TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'writing',
           claimed_by TEXT NOT NULL,
           claim_at ${t} NOT NULL,
           PRIMARY KEY (app_id, platform)
         )`,
        'CREATE INDEX IF NOT EXISTS store_release_claims_workspace_idx ON store_release_claims (workspace_id)',
      ];
    },
  },
  {
    id: 28,
    name: 'multi-app CI runs, store builds seen, release step times and the release/review reminder logs',
    statements: (dialect) => {
      const t = epoch(dialect);
      // ci_run_apps: the apps a CI run builds. One workflow can build one app or several that share a repository, so a run
      // links to a SET of apps (docs/api/ci.md). run_ref is workflow_runs.id (the row's own id, which does not change when a
      // pending dispatch is adopted by the real run); the row goes with its run (ON DELETE CASCADE, and the scheduler also
      // deletes rows whose run is gone). A run with NO row here counts for every app of its repository (it was not started
      // for an app). workflow_runs.app_id is kept for compatibility and always holds the first app of the set (or NULL): it
      // is not dropped. DATA MIGRATION: every run that named an app in workflow_runs.app_id gets its row here (apps that no
      // longer exist are skipped).
      // app_builds: the builds the last store sync saw, for the release pipeline ("a build appeared and nothing moved").
      // iOS and macOS: one row per App Store Connect build of the platform (build_number = CFBundleVersion, version = the
      // marketing version, raw_state = Apple's processingState, processing_state = processing, processed, invalid or unknown,
      // uploaded_at = Apple's uploadedDate). Android: one row per version code seen in a track release (uploaded_at is NULL:
      // Google does not say when it was uploaded, first_seen_at is when this server first saw it). first_seen_at is kept
      // across syncs; a build the store no longer lists is deleted by the sync.
      // app_releases.status_since: when this server first saw the version (or track release) in its current state, state
      // name or build (set by the sync). DATA MIGRATION: existing rows get synced_at, which is a LOWER bound of the real
      // time (the clock of a stalled release starts at the upgrade, never earlier, so no old release is reported stalled
      // by an invented age).
      // release_stall_reminders: one row per app and platform while a release is stalled: the episode (what is stuck, as
      // step:anchor), when the reminder was first and last sent and how many were sent. A reminder is sent by the instance
      // whose compare-and-set on (episode_key, last_sent_at) won; the row is deleted when the app stops being stalled.
      // review_unanswered_reminders: one row per workspace, the last digest of unanswered reviews (when, how many, the
      // oldest), so a digest is sent at most once per configured interval across instances.
      return [
        `CREATE TABLE IF NOT EXISTS ci_run_apps (
           run_ref TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
           app_id TEXT NOT NULL,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           created_at ${t} NOT NULL,
           PRIMARY KEY (run_ref, app_id)
         )`,
        'CREATE INDEX IF NOT EXISTS ci_run_apps_app_idx ON ci_run_apps (workspace_id, app_id)',
        `INSERT INTO ci_run_apps (run_ref, app_id, workspace_id, created_at)
         SELECT r.id, r.app_id, r.workspace_id, r.started_at FROM workflow_runs r
          WHERE r.app_id IS NOT NULL AND r.app_id IN (SELECT a.id FROM apps a)`,
        `CREATE TABLE IF NOT EXISTS app_builds (
           app_id TEXT NOT NULL,
           platform TEXT NOT NULL,
           build_number TEXT NOT NULL,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           store_id TEXT,
           version TEXT,
           processing_state TEXT NOT NULL,
           raw_state TEXT,
           expired INTEGER,
           uploaded_at ${t},
           first_seen_at ${t} NOT NULL,
           last_seen_at ${t} NOT NULL,
           PRIMARY KEY (app_id, platform, build_number)
         )`,
        'CREATE INDEX IF NOT EXISTS app_builds_workspace_idx ON app_builds (workspace_id, app_id)',
        `ALTER TABLE app_releases ADD COLUMN status_since ${t}`,
        'UPDATE app_releases SET status_since = synced_at WHERE status_since IS NULL',
        `CREATE TABLE IF NOT EXISTS release_stall_reminders (
           app_id TEXT NOT NULL,
           platform TEXT NOT NULL,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           episode_key TEXT NOT NULL,
           step TEXT NOT NULL,
           first_sent_at ${t} NOT NULL,
           last_sent_at ${t} NOT NULL,
           sent_count INTEGER NOT NULL DEFAULT 1,
           PRIMARY KEY (app_id, platform)
         )`,
        'CREATE INDEX IF NOT EXISTS release_stall_reminders_workspace_idx ON release_stall_reminders (workspace_id)',
        `CREATE TABLE IF NOT EXISTS review_unanswered_reminders (
           workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
           last_sent_at ${t} NOT NULL,
           last_count INTEGER NOT NULL,
           last_oldest_at ${t}
         )`,
      ];
    },
  },
];
