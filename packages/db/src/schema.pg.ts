import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Portable on purpose, so the same model runs on Postgres and SQLite:
 * ids are application-generated text, times are epoch milliseconds, JSON is text.
 * Keep this file and schema.sqlite.ts in step; see docs/spikes/dual-dialect.md.
 */

const epochMs = (name: string) => bigint(name, { mode: 'number' });

export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: epochMs('created_at').notNull(),
});

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  createdAt: epochMs('created_at').notNull(),
  passwordHash: text('password_hash'),
});

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export const credentials = pgTable('credentials', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  /** app_store_connect, google_play, github_app or llm. */
  kind: text('kind').notNull(),
  label: text('label').notNull(),
  /** Output of @mrm/vault encryptSecret. Never plain text. */
  ciphertext: text('ciphertext').notNull(),
  createdAt: epochMs('created_at').notNull(),
  rotatedAt: epochMs('rotated_at'),
  /** The last "test connection": when, whether it passed (0 or 1), and a sentence for people. */
  lastTestAt: epochMs('last_test_at'),
  lastTestOk: integer('last_test_ok'),
  lastTestMessage: text('last_test_message'),
});

export const auditEvents = pgTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** user, token, assistant or system. */
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    detail: text('detail'),
    createdAt: epochMs('created_at').notNull(),
  },
  (t) => [index('audit_events_workspace_idx').on(t.workspaceId, t.createdAt)],
);

export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    queue: text('queue').notNull(),
    payload: text('payload').notNull(),
    /** queued, running, done or failed. */
    status: text('status').notNull(),
    runAt: epochMs('run_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    lockedAt: epochMs('locked_at'),
    createdAt: epochMs('created_at').notNull(),
  },
  (t) => [index('jobs_ready_idx').on(t.status, t.runAt)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: epochMs('created_at').notNull(),
    expiresAt: epochMs('expires_at').notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const invitations = pgTable(
  'invitations',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    email: text('email').notNull(),
    role: text('role').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: epochMs('created_at').notNull(),
    expiresAt: epochMs('expires_at').notNull(),
    acceptedAt: epochMs('accepted_at'),
    acceptedBy: text('accepted_by').references(() => users.id),
    revokedAt: epochMs('revoked_at'),
  },
  (t) => [index('invitations_workspace_idx').on(t.workspaceId)],
);

export const repositories = pgTable(
  'repositories',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** No foreign key: a credential can be deleted while a repository still names it. NULL for a local-only repository. */
    credentialId: text('credential_id'),
    /** NULL for a local-only repository (a folder on this machine, no GitHub). */
    owner: text('owner'),
    repo: text('repo'),
    defaultBranch: text('default_branch').notNull(),
    projectKind: text('project_kind'),
    detectedAt: epochMs('detected_at'),
    /** The last ProjectDetection as JSON. */
    detectionJson: text('detection_json'),
    createdAt: epochMs('created_at').notNull(),
  },
  (t) => [uniqueIndex('repositories_workspace_repo_idx').on(t.workspaceId, t.owner, t.repo)],
);

export const changeSets = pgTable(
  'change_sets',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id),
    summary: text('summary').notNull(),
    /** draft, approved, applying, applied, discarded or failed. */
    status: text('status').notNull(),
    createdByType: text('created_by_type').notNull(),
    createdById: text('created_by_id').notNull(),
    /** The file changes as JSON: path, before, after. */
    filesJson: text('files_json').notNull(),
    branch: text('branch'),
    prUrl: text('pr_url'),
    prNumber: integer('pr_number'),
    commitSha: text('commit_sha'),
    error: text('error'),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
    approvedBy: text('approved_by'),
    approvedAt: epochMs('approved_at'),
    appliedAt: epochMs('applied_at'),
    /** What a local commit did (commit, push, pull request) as JSON; null for the GitHub API apply. */
    outcomeJson: text('outcome_json'),
    /** Set while a push or pull request of a local commit is being made. */
    publishClaimAt: epochMs('publish_claim_at'),
    /** What the change set was made from (the store pull's request) as JSON, so it can be recomputed; null otherwise. */
    originJson: text('origin_json'),
  },
  (t) => [
    index('change_sets_workspace_idx').on(t.workspaceId, t.createdAt),
    index('change_sets_repository_idx').on(t.repositoryId),
  ],
);

export const apps = pgTable(
  'apps',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    name: text('name').notNull(),
    /** ios or android. */
    platform: text('platform').notNull(),
    /** The bundle id (iOS) or package name (Android). */
    identifier: text('identifier').notNull(),
    /** The store's own id (Apple's numeric app id), filled by the first sync. */
    storeAppId: text('store_app_id'),
    /** No foreign key: a credential can be deleted while an app still names it. */
    credentialId: text('credential_id').notNull(),
    /** No foreign key: a repository can be disconnected while an app still names it. */
    repositoryId: text('repository_id'),
    lastSyncedAt: epochMs('last_synced_at'),
    lastSyncAttemptAt: epochMs('last_sync_attempt_at'),
    lastSyncError: text('last_sync_error'),
    createdAt: epochMs('created_at').notNull(),
  },
  (t) => [uniqueIndex('apps_workspace_identifier_idx').on(t.workspaceId, t.platform, t.identifier)],
);

export const appReleases = pgTable(
  'app_releases',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    platform: text('platform').notNull(),
    version: text('version').notNull(),
    /** The Play track; empty on iOS. */
    track: text('track').notNull().default(''),
    build: text('build'),
    /** The normalized lifecycle state, or null when the store's state is not mapped. */
    status: text('status'),
    /** The store's own state name, verbatim. */
    rawState: text('raw_state').notNull(),
    /** Version codes and rollout fraction as JSON. */
    detailsJson: text('details_json'),
    storeUpdatedAt: epochMs('store_updated_at'),
    /** When the sync first saw the version (or track release) in its current state, state name or build (migration 28). */
    statusSince: epochMs('status_since'),
    syncedAt: epochMs('synced_at').notNull(),
  },
  (t) => [
    uniqueIndex('app_releases_app_version_idx').on(t.appId, t.platform, t.version, t.track),
    index('app_releases_workspace_idx').on(t.workspaceId),
  ],
);

export const repositoryListingTargets = pgTable(
  'repository_listing_targets',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id),
    name: text('name').notNull(),
    /** The app id of a monorepo app (informational). */
    appId: text('app_id'),
    /** A repository relative folder, or null when the target has none for this store. */
    appStoreRoot: text('app_store_root'),
    googlePlayRoot: text('google_play_root'),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => [uniqueIndex('repository_listing_targets_name_idx').on(t.repositoryId, t.name)],
);

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    createdBy: text('created_by').notNull(),
    name: text('name').notNull(),
    /** SHA-256 of the token. The token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    prefix: text('prefix').notNull(),
    /** The role ceiling: admin, member or viewer. Never owner. */
    role: text('role').notNull(),
    /** JSON array of app ids, or null for all apps. */
    appIds: text('app_ids'),
    /** JSON array of actions, or null for everything the role ceiling allows. */
    actions: text('actions'),
    expiresAt: epochMs('expires_at'),
    lastUsedAt: epochMs('last_used_at'),
    revokedAt: epochMs('revoked_at'),
    createdAt: epochMs('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('api_tokens_hash_idx').on(t.tokenHash),
    index('api_tokens_workspace_idx').on(t.workspaceId),
  ],
);

export const events = pgTable(
  'events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    type: text('type').notNull(),
    appId: text('app_id'),
    repositoryId: text('repository_id'),
    releaseId: text('release_id'),
    /** JSON. Never holds a secret. */
    payload: text('payload').notNull(),
    createdAt: epochMs('created_at').notNull(),
  },
  (t) => [index('events_workspace_idx').on(t.workspaceId, t.id)],
);

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    url: text('url').notNull(),
    description: text('description'),
    /** The signing secret, encrypted with the vault. */
    ciphertext: text('ciphertext').notNull(),
    /** JSON array of event types, or ["*"]. */
    eventTypes: text('event_types').notNull(),
    enabled: integer('enabled').notNull().default(1),
    createdBy: text('created_by').notNull(),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => [index('webhook_endpoints_workspace_idx').on(t.workspaceId)],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    endpointId: text('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id),
    eventId: epochMs('event_id'),
    eventType: text('event_type').notNull(),
    /** The exact JSON that is signed and sent. Never holds a secret. */
    body: text('body').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    responseCode: integer('response_code'),
    responseBody: text('response_body'),
    error: text('error'),
    redeliveryOf: text('redelivery_of'),
    createdAt: epochMs('created_at').notNull(),
    deliveredAt: epochMs('delivered_at'),
  },
  (t) => [index('webhook_deliveries_endpoint_idx').on(t.endpointId, t.createdAt)],
);

export const listingSnapshots = pgTable(
  'listing_snapshots',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** No foreign key: deleting an app removes its rows in code. */
    appId: text('app_id').notNull(),
    platform: text('platform').notNull(),
    locale: text('locale').notNull(),
    field: text('field').notNull(),
    /** `live` or `editable` for the store; `default` for repo and change_set. */
    channel: text('channel').notNull().default('live'),
    /** Null when the field is absent. */
    value: text('value'),
    valueHash: text('value_hash').notNull(),
    /** `store`, `repo` or `change_set`. */
    source: text('source').notNull(),
    /** A store version, a commit sha or a change set id. */
    sourceRef: text('source_ref'),
    observedAt: epochMs('observed_at').notNull(),
    actorType: text('actor_type'),
    actorId: text('actor_id'),
  },
  (t) => [
    index('listing_snapshots_field_idx').on(t.appId, t.locale, t.field, t.observedAt),
    index('listing_snapshots_ref_idx').on(t.appId, t.source, t.sourceRef),
    index('listing_snapshots_workspace_idx').on(t.workspaceId),
  ],
);

export const appListingStatus = pgTable('app_listing_status', {
  appId: text('app_id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  listingReadAt: epochMs('listing_read_at'),
  listingError: text('listing_error'),
  /** When the last listing read was tried (any path, success or not). */
  listingAttemptAt: epochMs('listing_attempt_at'),
  /** Failed reads in a row; 0 after a success. */
  listingFailures: integer('listing_failures').notNull().default(0),
  /** The connector's warnings of the last successful read, a JSON array of sentences. */
  listingWarnings: text('listing_warnings'),
  repoReadAt: epochMs('repo_read_at'),
  repoRef: text('repo_ref'),
  repoError: text('repo_error'),
});

export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** No foreign key: a repository can be disconnected while rows remain; the services purge them. */
    repositoryId: text('repository_id').notNull(),
    /** The app the run was dispatched for, when it was started from this tool for one. */
    appId: text('app_id'),
    /** GitHub's run id, or `pending-<uuid>` for a dispatch whose run is not known yet. */
    runId: text('run_id').notNull(),
    workflow: text('workflow').notNull(),
    workflowPath: text('workflow_path'),
    /** The run title (`run-name`, or GitHub's default). */
    title: text('title'),
    /** GitHub's own status and conclusion, verbatim; `pending` for a placeholder. */
    status: text('status').notNull(),
    conclusion: text('conclusion'),
    headSha: text('head_sha'),
    commitMessage: text('commit_message'),
    branch: text('branch'),
    event: text('event'),
    runNumber: integer('run_number'),
    url: text('url'),
    /** The inputs this tool dispatched with, as JSON. */
    inputsJson: text('inputs_json'),
    dispatchedBy: text('dispatched_by'),
    startedAt: epochMs('started_at').notNull(),
    runUpdatedAt: epochMs('run_updated_at').notNull(),
    syncedAt: epochMs('synced_at').notNull(),
  },
  (t) => [
    uniqueIndex('workflow_runs_repository_run_idx').on(t.repositoryId, t.runId),
    index('workflow_runs_repository_started_idx').on(t.repositoryId, t.startedAt),
    index('workflow_runs_workspace_idx').on(t.workspaceId),
  ],
);

export const buildLinks = pgTable(
  'build_links',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** No foreign key: deleting an app must stay possible; the services purge orphans. */
    appId: text('app_id').notNull(),
    platform: text('platform').notNull(),
    buildNumber: text('build_number').notNull(),
    repositoryId: text('repository_id').notNull(),
    runId: text('run_id').notNull(),
    headSha: text('head_sha').notNull(),
    runUrl: text('run_url'),
    workflow: text('workflow'),
    /** `manual`, or the id of the matcher that found the link. */
    source: text('source').notNull(),
    reason: text('reason'),
    linkedBy: text('linked_by'),
    /** Why a tag-based link was made, as JSON (tag, pattern, commit, reason, confidence). */
    evidenceJson: text('evidence_json'),
    linkedAt: epochMs('linked_at').notNull(),
  },
  (t) => [
    uniqueIndex('build_links_app_build_idx').on(t.appId, t.platform, t.buildNumber),
    index('build_links_workspace_idx').on(t.workspaceId),
  ],
);

export const buildConventions = pgTable(
  'build_conventions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** No foreign key: a repository can be disconnected while rows remain; the services purge them. */
    repositoryId: text('repository_id').notNull(),
    /** An app's own convention, or '' for the whole repository. */
    appId: text('app_id').notNull(),
    /** JSON array of tag patterns; empty means the built-in defaults. */
    tagPatternsJson: text('tag_patterns_json').notNull(),
    /** JSON array of release-name patterns; empty means the built-in defaults. */
    releasePatternsJson: text('release_patterns_json').notNull(),
    /** The literal that fills {prefix} in a pattern. */
    tagPrefix: text('tag_prefix').notNull(),
    /** The release workflow (file name or name) for matching a tag to a run by time. */
    workflow: text('workflow'),
    updatedBy: text('updated_by').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('build_conventions_scope_idx').on(t.repositoryId, t.appId),
    index('build_conventions_workspace_idx').on(t.workspaceId),
  ],
);

export const buildScans = pgTable(
  'build_scans',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** No foreign key, like workflow_runs. One row per repository. */
    repositoryId: text('repository_id').notNull(),
    scannedAt: epochMs('scanned_at').notNull(),
    /** 0 or 1: did the last read of tags and releases work. */
    ok: integer('ok').notNull(),
    error: text('error'),
    /** What the scan saw and why builds did not match, as JSON. */
    summaryJson: text('summary_json').notNull(),
  },
  (t) => [
    uniqueIndex('build_scans_repository_idx').on(t.repositoryId),
    index('build_scans_workspace_idx').on(t.workspaceId),
  ],
);

export const releasePlans = pgTable(
  'release_plans',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** No foreign key: deleting an app must stay possible; plans of a deleted app are not shown. */
    appId: text('app_id').notNull(),
    version: text('version').notNull(),
    /** ios, android, or null for a plan that covers both. */
    platform: text('platform'),
    /** A calendar day, YYYY-MM-DD, compared in UTC. */
    targetDate: text('target_date'),
    /** 0 or 1. */
    blocked: integer('blocked').notNull().default(0),
    blockedReason: text('blocked_reason'),
    notes: text('notes').notNull().default(''),
    createdBy: text('created_by').notNull(),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
    /** Null: no rollout plan. steps (our own percentages) or apple_phased (Apple's fixed schedule, informational). */
    rolloutKind: text('rollout_kind'),
    /** The built-in rollout template the plan started from, if any. */
    rolloutTemplate: text('rollout_template'),
    /** Epoch milliseconds of the expected day 1 of an Apple phased release. */
    rolloutStartAt: epochMs('rollout_start_at'),
  },
  (t) => [
    uniqueIndex('release_plans_app_version_idx').on(t.appId, t.version),
    index('release_plans_workspace_idx').on(t.workspaceId),
  ],
);

export const checklistItems = pgTable(
  'checklist_items',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    planId: text('plan_id')
      .notNull()
      .references(() => releasePlans.id),
    position: integer('position').notNull(),
    text: text('text').notNull(),
    /** 0 or 1. */
    required: integer('required').notNull().default(0),
    /** 0 or 1. */
    done: integer('done').notNull().default(0),
    /** The user who ticked it. No foreign key, so a later kind of actor can be stored. */
    doneBy: text('done_by'),
    doneAt: epochMs('done_at'),
  },
  (t) => [
    index('checklist_items_plan_idx').on(t.planId, t.position),
    index('checklist_items_workspace_idx').on(t.workspaceId),
  ],
);

export const releaseNotes = pgTable(
  'release_notes',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    planId: text('plan_id')
      .notNull()
      .references(() => releasePlans.id),
    locale: text('locale').notNull(),
    /** May be empty: an expected locale that is not written yet. */
    text: text('text').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('release_notes_plan_locale_idx').on(t.planId, t.locale),
    index('release_notes_workspace_idx').on(t.workspaceId),
  ],
);

export const checklistTemplates = pgTable(
  'checklist_templates',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    name: text('name').notNull(),
    /** A JSON array of { text, required }. */
    itemsJson: text('items_json').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => [uniqueIndex('checklist_templates_name_idx').on(t.workspaceId, t.name)],
);

/**
 * Where a repository's local clone is (docs/adr/0005-local-clone-reads.md). One row per
 * repository: the optional local copy reads come from for a GitHub repository, or the repository
 * itself when it has no GitHub connection (then credentialId, owner and repo are NULL).
 */
export const repositoryLocalCheckouts = pgTable(
  'repository_local_checkouts',
  {
    repositoryId: text('repository_id')
      .primaryKey()
      .references(() => repositories.id),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** The real path (symbolic links resolved) when it was attached, inside an allowed root. */
    path: text('path').notNull(),
    /** The branch whose tip is read. */
    branch: text('branch').notNull(),
    /** What a local-only repository is called: the folder's name unless a person chose one. */
    name: text('name').notNull(),
    /** The commit the last read used, for the UI. */
    lastCommit: text('last_commit'),
    lastReadAt: epochMs('last_read_at'),
    createdBy: text('created_by').notNull(),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => [uniqueIndex('repository_local_checkouts_path_idx').on(t.workspaceId, t.path)],
);

export const planRolloutSteps = pgTable(
  'plan_rollout_steps',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    planId: text('plan_id')
      .notNull()
      .references(() => releasePlans.id),
    position: integer('position').notNull(),
    /** A whole number, 1 to 100. */
    percent: integer('percent').notNull(),
    plannedAt: epochMs('planned_at'),
    note: text('note'),
    /** planned, done or skipped. */
    status: text('status').notNull().default('planned'),
    doneAt: epochMs('done_at'),
    doneBy: text('done_by'),
    /** manual, or store when a person confirmed the step against the share a sync saw. */
    doneSource: text('done_source'),
  },
  (t) => [
    index('plan_rollout_steps_plan_idx').on(t.planId, t.position),
    index('plan_rollout_steps_due_idx').on(t.status, t.plannedAt),
  ],
);

export const planReminders = pgTable(
  'plan_reminders',
  {
    planId: text('plan_id')
      .notNull()
      .references(() => releasePlans.id),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** target_date for the plan's deadline, or a rollout step id. */
    itemId: text('item_id').notNull(),
    /** due_soon, overdue or rollout_step_due. */
    kind: text('kind').notNull(),
    /** The due date (YYYY-MM-DD) or the planned time of the step: a new date is a new key. */
    dueKey: text('due_key').notNull(),
    sentAt: epochMs('sent_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.planId, t.itemId, t.kind, t.dueKey] }),
    index('plan_reminders_workspace_idx').on(t.workspaceId),
  ],
);

/** Customer reviews read from a store (read only). See migration 19 for what each column means. */
export const appReviews = pgTable(
  'app_reviews',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** No foreign key: deleting an app removes its rows in code. */
    appId: text('app_id').notNull(),
    /** appstoreconnect or googleplay. */
    store: text('store').notNull(),
    storeReviewId: text('store_review_id').notNull(),
    rating: integer('rating').notNull(),
    title: text('title'),
    body: text('body').notNull(),
    authorName: text('author_name'),
    territory: text('territory'),
    language: text('language'),
    appVersion: text('app_version'),
    buildNumber: text('build_number'),
    device: text('device'),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
    firstSeenAt: epochMs('first_seen_at').notNull(),
    fetchedAt: epochMs('fetched_at').notNull(),
    /** JSON { body, at?, state? } or null. */
    developerResponse: text('developer_response'),
    /** Our own triage state: new, triaged, replied_in_console or ignored. Never sent to a store. */
    status: text('status').notNull().default('new'),
    assigneeUserId: text('assignee_user_id'),
    internalNote: text('internal_note'),
    statusChangedAt: epochMs('status_changed_at'),
    statusChangedBy: text('status_changed_by'),
    lowRatingNotifiedAt: epochMs('low_rating_notified_at'),
  },
  (t) => [
    uniqueIndex('app_reviews_store_id_idx').on(t.appId, t.storeReviewId),
    index('app_reviews_app_created_idx').on(t.appId, t.createdAt),
    index('app_reviews_app_rating_idx').on(t.appId, t.rating),
    index('app_reviews_app_status_idx').on(t.appId, t.status),
    index('app_reviews_workspace_idx').on(t.workspaceId),
    index('app_reviews_ws_created_idx').on(t.workspaceId, t.createdAt, t.id),
    index('app_reviews_ws_updated_idx').on(t.workspaceId, t.updatedAt, t.id),
    index('app_reviews_ws_rating_idx').on(t.workspaceId, t.rating, t.createdAt, t.id),
  ],
);

export const reviewSyncState = pgTable(
  'review_sync_state',
  {
    appId: text('app_id').notNull(),
    store: text('store').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** Where an unfinished read continues (App Store). */
    cursor: text('cursor'),
    lastAttemptAt: epochMs('last_attempt_at'),
    lastSuccessAt: epochMs('last_success_at'),
    lastError: text('last_error'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    backoffUntil: epochMs('backoff_until'),
    failureNotifiedAt: epochMs('failure_notified_at'),
    lastGapAt: epochMs('last_gap_at'),
    /** JSON of the last result: counts and warnings. */
    lastResult: text('last_result'),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.store] }),
    index('review_sync_state_workspace_idx').on(t.workspaceId),
  ],
);

/** The store-wide rating per territory, a row only when a value changed. Averages are thousandths. */
export const appRatingSummaries = pgTable(
  'app_rating_summaries',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    appId: text('app_id').notNull(),
    store: text('store').notNull(),
    territory: text('territory').notNull(),
    averageMilli: integer('average_milli'),
    ratingCount: integer('rating_count'),
    currentAverageMilli: integer('current_average_milli'),
    currentCount: integer('current_count'),
    observedAt: epochMs('observed_at').notNull(),
  },
  (t) => [
    index('app_rating_summaries_app_idx').on(t.appId, t.store, t.territory, t.observedAt),
    index('app_rating_summaries_workspace_idx').on(t.workspaceId),
  ],
);

/** The resolved icon of an app (services/app-icons.ts): the image as base64 text, or only the state of a failed look. */
export const appIcons = pgTable(
  'app_icons',
  {
    appId: text('app_id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** repository, app_store or google_play. */
    source: text('source'),
    /** The git blob id of the file, or the host of the image URL. */
    sourceId: text('source_id'),
    mediaType: text('media_type'),
    /** The image bytes in base64 (at most 256 KB of image). */
    data: text('data'),
    size: integer('size'),
    width: integer('width'),
    height: integer('height'),
    etag: text('etag'),
    fetchedAt: epochMs('fetched_at'),
    checkedAt: epochMs('checked_at').notNull(),
    failures: integer('failures').notNull().default(0),
    backoffUntil: epochMs('backoff_until'),
    lastError: text('last_error'),
  },
  (t) => [index('app_icons_workspace_idx').on(t.workspaceId)],
);

/** One row per workspace and setting key; the known keys and their defaults live in code. Never a secret. */
export const workspaceSettings = pgTable(
  'workspace_settings',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    key: text('key').notNull(),
    /** JSON of the value. */
    valueJson: text('value_json').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
    updatedBy: text('updated_by'),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);

/** A translation of one field of a review, reused until the review text (its hash) changes. */
export const reviewTranslations = pgTable(
  'review_translations',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    appId: text('app_id').notNull(),
    reviewId: text('review_id').notNull(),
    /** title or body. */
    field: text('field').notNull(),
    targetLang: text('target_lang').notNull(),
    provider: text('provider').notNull(),
    /** SHA-256 of the source text. */
    sourceHash: text('source_hash').notNull(),
    translatedText: text('translated_text').notNull(),
    detectedSource: text('detected_source'),
    createdAt: epochMs('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('review_translations_key_idx').on(t.reviewId, t.field, t.targetLang, t.provider, t.sourceHash),
    index('review_translations_app_idx').on(t.appId),
    index('review_translations_workspace_idx').on(t.workspaceId),
  ],
);

/** Characters sent to a translation provider per workspace and UTC day (YYYY-MM-DD). */
export const translationUsage = pgTable(
  'translation_usage',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    day: text('day').notNull(),
    chars: integer('chars').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.day] })],
);

/**
 * The reply being prepared for a review, and once sent the record of the last reply this server
 * published: one row per review (see migration 21). The text is plain text and never goes to the
 * audit log, an event or a log line.
 */
export const reviewReplyDrafts = pgTable(
  'review_reply_drafts',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    appId: text('app_id').notNull(),
    reviewId: text('review_id')
      .notNull()
      .references(() => appReviews.id, { onDelete: 'cascade' }),
    store: text('store').notNull(),
    text: text('text').notNull(),
    /** SHA-256 hex of the text: what a person confirms before it is sent. */
    textHash: text('text_hash').notNull(),
    /** draft, sending, sent, failed or unknown. */
    status: text('status').notNull().default('draft'),
    errorCode: text('error_code'),
    /** JSON about how an unknown outcome was settled. Never the text. */
    evidence: text('evidence'),
    createdBy: text('created_by').notNull(),
    updatedBy: text('updated_by').notNull(),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
    sentAt: epochMs('sent_at'),
    sentBy: text('sent_by'),
    /** When the send in flight started; the claim expires after a TTL. */
    claimAt: epochMs('claim_at'),
    storeResponseId: text('store_response_id'),
  },
  (t) => [
    uniqueIndex('review_reply_drafts_review_idx').on(t.reviewId),
    index('review_reply_drafts_workspace_idx').on(t.workspaceId, t.status),
    index('review_reply_drafts_app_idx').on(t.appId),
  ],
);

/** Workspace-wide reply templates with {author} and {app} placeholders. */
export const reviewReplyTemplates = pgTable(
  'review_reply_templates',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    name: text('name').notNull(),
    body: text('body').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => [index('review_reply_templates_workspace_idx').on(t.workspaceId)],
);

/**
 * The claim a gated store rollout write holds while it runs, one row per app and platform (see
 * migration 22 and docs/adr/0008-store-rollout-writes.md). Deleted when the write settles.
 */
export const storeRolloutClaims = pgTable(
  'store_rollout_claims',
  {
    appId: text('app_id').notNull(),
    platform: text('platform').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    action: text('action').notNull(),
    /** writing (in flight, expires after a TTL) or unknown (outcome not told; a re-read clears it). */
    status: text('status').notNull().default('writing'),
    claimedBy: text('claimed_by').notNull(),
    claimAt: epochMs('claim_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.platform] }),
    index('store_rollout_claims_workspace_idx').on(t.workspaceId),
  ],
);

/**
 * Listing texts and graphics collected per app to be written into a store as a draft (see migration
 * 23 and docs/adr/0009-staged-store-drafts.md). A row is one text, or one file of a set of graphics.
 */
export const stagedChanges = pgTable(
  'staged_changes',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    appId: text('app_id').notNull(),
    platform: text('platform').notNull(),
    /** listing_text or asset. */
    kind: text('kind').notNull(),
    locale: text('locale').notNull(),
    /** The listing field, or the slot of a set of graphics (`screenshot:iphone_6_5`, `icon`). */
    target: text('target').notNull(),
    ordinal: integer('ordinal').notNull().default(0),
    /** repo, local or store. */
    source: text('source').notNull(),
    valueText: text('value_text'),
    /** SHA-256 of the normalized text, or the git blob id of the file. */
    valueHash: text('value_hash').notNull(),
    assetPath: text('asset_path'),
    assetCommit: text('asset_commit'),
    assetBytes: integer('asset_bytes'),
    assetWidth: integer('asset_width'),
    assetHeight: integer('asset_height'),
    assetFormat: text('asset_format'),
    assetAlpha: integer('asset_alpha'),
    createdBy: text('created_by').notNull(),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
    pushedAt: epochMs('pushed_at'),
    pushedHash: text('pushed_hash'),
  },
  (t) => [
    uniqueIndex('staged_changes_slot_idx').on(t.appId, t.kind, t.locale, t.target, t.ordinal),
    index('staged_changes_workspace_idx').on(t.workspaceId, t.appId),
  ],
);

/**
 * The claim a gated store draft write holds while it runs, one row per app and platform (see
 * migration 23). Deleted when the write settles.
 */
export const storeDraftClaims = pgTable(
  'store_draft_claims',
  {
    appId: text('app_id').notNull(),
    platform: text('platform').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    action: text('action').notNull(),
    /** writing (in flight, expires after a TTL) or unknown (outcome not told; a re-read clears it). */
    status: text('status').notNull().default('writing'),
    claimedBy: text('claimed_by').notNull(),
    claimAt: epochMs('claim_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.platform] }),
    index('store_draft_claims_workspace_idx').on(t.workspaceId),
  ],
);

/**
 * What the last successful draft pushes of an app and platform wrote to the store's draft: the
 * record a submit for review checks the store against (see migration 24). Hashes and ids only.
 */
export const storeDraftPushes = pgTable(
  'store_draft_pushes',
  {
    appId: text('app_id').notNull(),
    platform: text('platform').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    versionId: text('version_id'),
    versionString: text('version_string'),
    confirmHash: text('confirm_hash').notNull(),
    /** JSON: pushed texts (locale, field, SHA-256) and sets (locale, slot, size, per file MD5 and SHA-256). */
    items: text('items').notNull(),
    pushedBy: text('pushed_by').notNull(),
    pushedAt: epochMs('pushed_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.platform] }),
    index('store_draft_pushes_workspace_idx').on(t.workspaceId),
  ],
);

/**
 * The claim a gated submit for review holds while it runs, one row per app and platform (see
 * migration 24). Deleted when the submit settles.
 */
export const storeSubmitClaims = pgTable(
  'store_submit_claims',
  {
    appId: text('app_id').notNull(),
    platform: text('platform').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    action: text('action').notNull(),
    /** writing (in flight, expires after a TTL) or unknown (outcome not told; a re-read clears it). */
    status: text('status').notNull().default('writing'),
    claimedBy: text('claimed_by').notNull(),
    claimAt: epochMs('claim_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.platform] }),
    index('store_submit_claims_workspace_idx').on(t.workspaceId),
  ],
);

/**
 * The claim a store RELEASE takes before it touches a store (see migration 27 and docs/adr/0014-release-management.md): one row
 * per app and platform. Same semantics as `store_submit_claims`.
 */
export const storeReleaseClaims = pgTable(
  'store_release_claims',
  {
    appId: text('app_id').notNull(),
    platform: text('platform').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    action: text('action').notNull(),
    /** writing (in flight, expires after a TTL) or unknown (outcome not told; a re-read clears it). */
    status: text('status').notNull().default('writing'),
    claimedBy: text('claimed_by').notNull(),
    claimAt: epochMs('claim_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.platform] }),
    index('store_release_claims_workspace_idx').on(t.workspaceId),
  ],
);

/**
 * App Store Optimization (see migration 25 and docs/adr/0011-aso-keywords-competitors.md): tracked
 * search terms, their rank checks, followed competitors and their public snapshots. Public store
 * data only; nothing is ever written to a store.
 */
export const asoKeywords = pgTable(
  'aso_keywords',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    appId: text('app_id').notNull(),
    platform: text('platform').notNull(),
    /** Two letter storefront, lower case. */
    country: text('country').notNull(),
    locale: text('locale').notNull(),
    term: text('term').notNull(),
    /** The normalized term: two spellings of one keyword share it. */
    termKey: text('term_key').notNull(),
    tag: text('tag'),
    notes: text('notes'),
    /** 1 low, 2 normal, 3 high. */
    priority: integer('priority').notNull().default(2),
    createdBy: text('created_by').notNull(),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
    lastCheckedAt: epochMs('last_checked_at'),
    /** ranked, not_ranked or unavailable. */
    lastState: text('last_state'),
    lastRankPos: integer('last_rank_pos'),
    lastTotal: integer('last_total'),
    prevState: text('prev_state'),
    prevRankPos: integer('prev_rank_pos'),
    lastError: text('last_error'),
  },
  (t) => [
    uniqueIndex('aso_keywords_unique_idx').on(t.appId, t.country, t.locale, t.termKey),
    index('aso_keywords_workspace_idx').on(t.workspaceId, t.appId),
  ],
);

export const asoRankChecks = pgTable(
  'aso_rank_checks',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    keywordId: text('keyword_id')
      .notNull()
      .references(() => asoKeywords.id, { onDelete: 'cascade' }),
    appId: text('app_id').notNull(),
    checkedAt: epochMs('checked_at').notNull(),
    /** 1-based position in the source's results; null: not among the first `total`. */
    rankPos: integer('rank_pos'),
    total: integer('total').notNull(),
    /** apple_search or play_public. */
    source: text('source').notNull(),
    /** JSON [{id, name}]: the first results (public), for competitor suggestions. */
    topResults: text('top_results'),
  },
  (t) => [
    index('aso_rank_checks_keyword_idx').on(t.keywordId, t.checkedAt),
    index('aso_rank_checks_workspace_idx').on(t.workspaceId, t.checkedAt),
  ],
);

export const asoCompetitors = pgTable(
  'aso_competitors',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    appId: text('app_id').notNull(),
    /** app_store or google_play. */
    store: text('store').notNull(),
    /** The numeric App Store id, or the Android package name. */
    externalId: text('external_id').notNull(),
    country: text('country').notNull(),
    name: text('name').notNull(),
    addedBy: text('added_by').notNull(),
    addedAt: epochMs('added_at').notNull(),
    lastCheckedAt: epochMs('last_checked_at'),
    /** ok, not_found or unavailable. */
    lastState: text('last_state'),
    lastError: text('last_error'),
  },
  (t) => [
    uniqueIndex('aso_competitors_unique_idx').on(t.appId, t.store, t.externalId, t.country),
    index('aso_competitors_workspace_idx').on(t.workspaceId, t.appId),
  ],
);

export const asoCompetitorSnapshots = pgTable(
  'aso_competitor_snapshots',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    competitorId: text('competitor_id')
      .notNull()
      .references(() => asoCompetitors.id, { onDelete: 'cascade' }),
    appId: text('app_id').notNull(),
    checkedAt: epochMs('checked_at').notNull(),
    /** first, change or heartbeat. */
    kind: text('kind').notNull(),
    version: text('version'),
    ratingMilli: integer('rating_milli'),
    ratingCount: integer('rating_count'),
    price: text('price'),
    currency: text('currency'),
    title: text('title'),
    subtitle: text('subtitle'),
    descriptionExcerpt: text('description_excerpt'),
    textHash: text('text_hash').notNull(),
    descriptionHash: text('description_hash'),
    screenshotCount: integer('screenshot_count'),
    mediaHash: text('media_hash'),
    /** JSON: the fields that differ from the previous snapshot. */
    changes: text('changes'),
  },
  (t) => [
    index('aso_competitor_snapshots_competitor_idx').on(t.competitorId, t.checkedAt),
    index('aso_competitor_snapshots_workspace_idx').on(t.workspaceId, t.checkedAt),
  ],
);

/** The run state of the ASO refresh per app: last run, failure streak, backoff and the claim. */
export const asoAppState = pgTable(
  'aso_app_state',
  {
    appId: text('app_id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    lastAttemptAt: epochMs('last_attempt_at'),
    lastSuccessAt: epochMs('last_success_at'),
    lastError: text('last_error'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    backoffUntil: epochMs('backoff_until'),
    claimedAt: epochMs('claimed_at'),
    claimedBy: text('claimed_by'),
    lastResult: text('last_result'),
  },
  (t) => [index('aso_app_state_workspace_idx').on(t.workspaceId)],
);

/**
 * The bytes of an image uploaded or fixed in the app for a staged set of graphics (see migration 26 and
 * docs/adr/0012-assets-two-way-sync.md). base64 text; the staged row refers to it by (app_id, oid).
 */
export const stagedAssetBlobs = pgTable(
  'staged_asset_blobs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    appId: text('app_id').notNull(),
    /** The git blob id of the bytes: the `value_hash` of the staged rows that use it. */
    oid: text('oid').notNull(),
    sha256: text('sha256').notNull(),
    size: integer('size').notNull(),
    mediaType: text('media_type').notNull(),
    /** The image bytes in base64 (at most 8 MiB of image). */
    data: text('data').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: epochMs('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('staged_asset_blobs_oid_idx').on(t.appId, t.oid),
    index('staged_asset_blobs_workspace_idx').on(t.workspaceId, t.appId),
  ],
);

/**
 * The apps a CI run builds (migration 28): a run links to a SET of apps. A run with no row counts for every app of its
 * repository. `workflow_runs.app_id` stays and holds the first app of the set.
 */
export const ciRunApps = pgTable(
  'ci_run_apps',
  {
    /** workflow_runs.id; the row goes with its run. */
    runRef: text('run_ref')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    appId: text('app_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    createdAt: epochMs('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runRef, t.appId] }),
    index('ci_run_apps_app_idx').on(t.workspaceId, t.appId),
  ],
);

/** The builds the last store sync saw (iOS and macOS: App Store Connect builds; Android: version codes of track releases). Migration 28. */
export const appBuilds = pgTable(
  'app_builds',
  {
    appId: text('app_id').notNull(),
    platform: text('platform').notNull(),
    buildNumber: text('build_number').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    storeId: text('store_id'),
    version: text('version'),
    /** processing, processed, invalid or unknown. */
    processingState: text('processing_state').notNull(),
    /** The store's own processing state, verbatim. */
    rawState: text('raw_state'),
    /** 0 or 1; null when the store did not say. */
    expired: integer('expired'),
    /** The store's upload time; null on Android (Google does not say). */
    uploadedAt: epochMs('uploaded_at'),
    firstSeenAt: epochMs('first_seen_at').notNull(),
    lastSeenAt: epochMs('last_seen_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.platform, t.buildNumber] }),
    index('app_builds_workspace_idx').on(t.workspaceId, t.appId),
  ],
);

/** The reminder about a stalled release that was sent, one row per app and platform while the stall lasts (migration 28). */
export const releaseStallReminders = pgTable(
  'release_stall_reminders',
  {
    appId: text('app_id').notNull(),
    platform: text('platform').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** What is stuck, as `step:anchor` (a new one is a new episode). */
    episodeKey: text('episode_key').notNull(),
    step: text('step').notNull(),
    firstSentAt: epochMs('first_sent_at').notNull(),
    lastSentAt: epochMs('last_sent_at').notNull(),
    sentCount: integer('sent_count').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.platform] }),
    index('release_stall_reminders_workspace_idx').on(t.workspaceId),
  ],
);

/** The last digest of unanswered reviews that was sent, one row per workspace (migration 28). */
export const reviewUnansweredReminders = pgTable('review_unanswered_reminders', {
  workspaceId: text('workspace_id')
    .primaryKey()
    .references(() => workspaces.id),
  lastSentAt: epochMs('last_sent_at').notNull(),
  lastCount: integer('last_count').notNull(),
  lastOldestAt: epochMs('last_oldest_at'),
});

/**
 * The claim a BATCH PUBLISH takes before it runs its steps (see migration 29 and docs/adr/0015-pending-and-batch-publish.md): one row
 * per app and platform. Same shape as `store_release_claims`; only `writing` is used.
 */
export const storePublishClaims = pgTable(
  'store_publish_claims',
  {
    appId: text('app_id').notNull(),
    platform: text('platform').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    action: text('action').notNull(),
    status: text('status').notNull().default('writing'),
    claimedBy: text('claimed_by').notNull(),
    claimAt: epochMs('claim_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.platform] }),
    index('store_publish_claims_workspace_idx').on(t.workspaceId),
  ],
);

/**
 * One row per AI run (migration 30, docs/adr/0016-ai-foundation.md): the tokens reserved before the provider is called and
 * the tokens it reported. No text of any kind. The monthly budget is the sum of these rows since the start of the UTC month.
 */
export const aiUsage = pgTable(
  'ai_usage',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    appId: text('app_id'),
    task: text('task').notNull(),
    taskVersion: integer('task_version').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    /** reserved, ok or failed. */
    status: text('status').notNull().default('reserved'),
    errorCode: text('error_code'),
    reservedTokens: integer('reserved_tokens').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    createdBy: text('created_by').notNull(),
    createdAt: epochMs('created_at').notNull(),
    finishedAt: epochMs('finished_at'),
  },
  (t) => [index('ai_usage_workspace_idx').on(t.workspaceId, t.createdAt)],
);

/**
 * What an AI task proposed (migration 30): validated, post-processed output that a person accepts or dismisses. Accepting hands
 * it to an existing mechanism (keywords, staged text, reply draft); nothing here is ever sent to a store.
 */
export const aiSuggestions = pgTable(
  'ai_suggestions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** No foreign key: deleting an app removes its rows in code. */
    appId: text('app_id').notNull(),
    task: text('task').notNull(),
    taskVersion: integer('task_version').notNull(),
    /** keywords, listing_text or reply_draft. */
    kind: text('kind').notNull(),
    /** proposed, accepted or dismissed. */
    status: text('status').notNull().default('proposed'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    /** JSON: ids and options of the run. Never text. */
    scope: text('scope').notNull(),
    /** JSON: the validated proposal. */
    proposal: text('proposal').notNull(),
    /** SHA-256 of the data sent. */
    inputHash: text('input_hash').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    createdBy: text('created_by').notNull(),
    createdAt: epochMs('created_at').notNull(),
    decidedBy: text('decided_by'),
    decidedAt: epochMs('decided_at'),
    /** JSON: ids of what accepting created. */
    accepted: text('accepted'),
  },
  (t) => [
    index('ai_suggestions_app_idx').on(t.workspaceId, t.appId, t.createdAt),
    index('ai_suggestions_created_idx').on(t.createdAt),
  ],
);

/** The normalised daily metrics every analytics source writes (docs/adr/0017-analytics-foundation.md). Migration 31. */
export const analyticsDaily = pgTable(
  'analytics_daily',
  {
    appId: text('app_id').notNull(),
    platform: text('platform').notNull(),
    source: text('source').notNull(),
    metric: text('metric').notNull(),
    /** YYYY-MM-DD. */
    day: text('day').notNull(),
    /** Empty for a total. */
    dimType: text('dim_type').notNull().default(''),
    dimValue: text('dim_value').notNull().default(''),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** The value times 1,000,000 as an integer. */
    valueMicro: epochMs('value_micro').notNull(),
    /** The day the store produced the number; a later one replaces an earlier one. */
    processingDate: text('processing_date').notNull().default(''),
    /** sync or import. */
    origin: text('origin').notNull().default('sync'),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.platform, t.source, t.metric, t.day, t.dimType, t.dimValue] }),
    index('analytics_daily_workspace_idx').on(t.workspaceId, t.appId, t.day),
    index('analytics_daily_day_idx').on(t.day),
  ],
);

/** One row per sync of one app and source: counts and a fixed error code, nothing else. Migration 31. */
export const analyticsSyncRuns = pgTable(
  'analytics_sync_runs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    appId: text('app_id').notNull(),
    platform: text('platform').notNull(),
    source: text('source').notNull(),
    /** schedule, manual, enable or import. */
    triggerKind: text('trigger_kind').notNull(),
    /** running, ok, partial or failed. */
    status: text('status').notNull(),
    errorCode: text('error_code'),
    pointsWritten: integer('points_written').notNull().default(0),
    reportsRead: integer('reports_read').notNull().default(0),
    dayFrom: text('day_from'),
    dayTo: text('day_to'),
    startedBy: text('started_by'),
    startedAt: epochMs('started_at').notNull(),
    finishedAt: epochMs('finished_at'),
  },
  (t) => [
    index('analytics_sync_runs_app_idx').on(t.workspaceId, t.appId, t.startedAt),
    index('analytics_sync_runs_started_idx').on(t.startedAt),
  ],
);

/** The Apple analytics report request an explicit "enable analytics" created or found. Migration 31. */
export const analyticsReportRequests = pgTable(
  'analytics_report_requests',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    appId: text('app_id').notNull(),
    appleRequestId: text('apple_request_id').notNull(),
    accessType: text('access_type').notNull(),
    /** active or stopped. */
    status: text('status').notNull().default('active'),
    createdBy: text('created_by').notNull(),
    createdAt: epochMs('created_at').notNull(),
    lastCheckedAt: epochMs('last_checked_at'),
    lastErrorCode: text('last_error_code'),
  },
  (t) => [
    uniqueIndex('analytics_report_requests_app_idx').on(t.appId, t.accessType),
    index('analytics_report_requests_workspace_idx').on(t.workspaceId),
  ],
);

/** The Apple report instances already read, so a sync reads each processed instance once. Migration 31. */
export const analyticsInstances = pgTable(
  'analytics_instances',
  {
    appId: text('app_id').notNull(),
    appleInstanceId: text('apple_instance_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    appleReportId: text('apple_report_id').notNull(),
    reportKind: text('report_kind').notNull(),
    processingDate: text('processing_date').notNull().default(''),
    /** read or failed. */
    status: text('status').notNull(),
    errorCode: text('error_code'),
    segments: integer('segments').notNull().default(0),
    points: integer('points').notNull().default(0),
    readAt: epochMs('read_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.appleInstanceId] }),
    index('analytics_instances_workspace_idx').on(t.workspaceId, t.appId, t.readAt),
  ],
);

/** Per-app analytics switches. Migration 31. */
export const analyticsAppConfig = pgTable(
  'analytics_app_config',
  {
    appId: text('app_id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** off, ongoing or import. */
    appleMode: text('apple_mode').notNull().default('off'),
    /** An optional bucket id that overrides the workspace setting. */
    playBucketId: text('play_bucket_id'),
    updatedBy: text('updated_by').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => [index('analytics_app_config_workspace_idx').on(t.workspaceId)],
);

/** The last result per app, platform and source; the status endpoint reads it. Migration 31. */
export const analyticsSourceState = pgTable(
  'analytics_source_state',
  {
    appId: text('app_id').notNull(),
    platform: text('platform').notNull(),
    source: text('source').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    setupCode: text('setup_code'),
    lastAttemptAt: epochMs('last_attempt_at'),
    lastOkAt: epochMs('last_ok_at'),
    lastErrorCode: text('last_error_code'),
    oldestDay: text('oldest_day'),
    newestDay: text('newest_day'),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.platform, t.source] }),
    index('analytics_source_state_workspace_idx').on(t.workspaceId),
  ],
);

/** Google Play search terms per app, storefront and period, from a file the developer exports from Play Console. Migration 32. */
export const playSearchTerms = pgTable(
  'play_search_terms',
  {
    appId: text('app_id').notNull(),
    /** Two letters, lower case; '' when the file is not split by country. */
    country: text('country').notNull().default(''),
    periodFrom: text('period_from').notNull(),
    periodTo: text('period_to').notNull(),
    /** Folded words of the term; '' is the "Other" line Google groups small terms into. */
    termKey: text('term_key').notNull().default(''),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    term: text('term').notNull().default(''),
    visitors: epochMs('visitors'),
    installs: epochMs('installs'),
    conversionMicro: epochMs('conversion_micro'),
    importedAt: epochMs('imported_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.country, t.periodFrom, t.periodTo, t.termKey] }),
    index('play_search_terms_workspace_idx').on(t.workspaceId, t.appId, t.periodTo),
  ],
);

/** The latest search terms import per app (the freshness line). Migration 32. */
export const playSearchTermImports = pgTable(
  'play_search_term_imports',
  {
    appId: text('app_id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    lastImportAt: epochMs('last_import_at').notNull(),
    lastPeriodFrom: text('last_period_from'),
    lastPeriodTo: text('last_period_to'),
    imports: integer('imports').notNull().default(0),
    updatedBy: text('updated_by').notNull(),
  },
  (t) => [index('play_search_term_imports_workspace_idx').on(t.workspaceId)],
);

/** A passkey (WebAuthn credential) of a person, used to confirm hard actions. Migration 33. Never a private key. */
export const stepUpCredentials = pgTable(
  'step_up_credentials',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    credentialId: text('credential_id').notNull().unique(),
    /** SPKI DER, base64url. */
    publicKey: text('public_key').notNull(),
    /** COSE algorithm: -7 (ES256) or -8 (EdDSA). */
    alg: integer('alg').notNull(),
    signCount: epochMs('sign_count').notNull().default(0),
    name: text('name').notNull(),
    transports: text('transports'),
    createdAt: epochMs('created_at').notNull(),
    lastUsedAt: epochMs('last_used_at'),
  },
  (t) => [index('step_up_credentials_user_idx').on(t.userId)],
);

/** A one-time challenge for a passkey registration or assertion; deleted when used. Migration 33. */
export const stepUpChallenges = pgTable(
  'step_up_challenges',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    sessionId: text('session_id').notNull(),
    purpose: text('purpose').notNull(),
    challenge: text('challenge').notNull(),
    workspaceId: text('workspace_id'),
    action: text('action'),
    targetId: text('target_id'),
    targetHash: text('target_hash'),
    expiresAt: epochMs('expires_at').notNull(),
  },
  (t) => [index('step_up_challenges_expires_idx').on(t.expiresAt)],
);

/** A passed confirmation: single use, bound to session, user, action and target. Keyed by the SHA-256 of the grant. Migration 33. */
export const stepUpGrants = pgTable(
  'step_up_grants',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    sessionId: text('session_id').notNull(),
    action: text('action').notNull(),
    targetId: text('target_id'),
    targetHash: text('target_hash'),
    factor: text('factor').notNull(),
    createdAt: epochMs('created_at').notNull(),
    expiresAt: epochMs('expires_at').notNull(),
    usedAt: epochMs('used_at'),
  },
  (t) => [index('step_up_grants_expires_idx').on(t.expiresAt)],
);

/** The optional confirmation password of a person and the failure counter with its lockout. Migration 33. */
export const stepUpUsers = pgTable('step_up_users', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id),
  confirmationHash: text('confirmation_hash'),
  failedCount: integer('failed_count').notNull().default(0),
  lockedUntil: epochMs('locked_until'),
  updatedAt: epochMs('updated_at').notNull(),
});

/** One one-time recovery code of a person, as a salted SHA-256. Migration 34. */
export const stepUpRecoveryCodes = pgTable(
  'step_up_recovery_codes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    codeHash: text('code_hash').notNull(),
    createdAt: epochMs('created_at').notNull(),
    usedAt: epochMs('used_at'),
  },
  (t) => [index('step_up_recovery_codes_user_idx').on(t.userId)],
);

/** A build handed to Google Play internal app sharing. The link is encrypted and cleared after 24 hours. Migration 34. */
export const playInternalShares = pgTable(
  'play_internal_shares',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    appId: text('app_id').notNull(),
    artifactId: text('artifact_id').notNull(),
    runId: text('run_id'),
    packageName: text('package_name').notNull(),
    fileKind: text('file_kind').notNull(),
    fileName: text('file_name'),
    sizeBytes: epochMs('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    certificateFingerprint: text('certificate_fingerprint'),
    urlSecret: text('url_secret'),
    createdBy: text('created_by').notNull(),
    createdAt: epochMs('created_at').notNull(),
    expiresAt: epochMs('expires_at').notNull(),
  },
  (t) => [index('play_internal_shares_app_idx').on(t.workspaceId, t.appId, t.createdAt)],
);

/** One upload in flight per app (writing), or one whose outcome is not known (unknown). Migration 34. */
export const playInternalShareClaims = pgTable('play_internal_share_claims', {
  appId: text('app_id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  status: text('status').notNull(),
  claimedBy: text('claimed_by').notNull(),
  claimAt: epochMs('claim_at').notNull(),
});
