import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/** Mirror of schema.pg.ts. See that file for the portability rules. */

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  createdAt: integer('created_at').notNull(),
  passwordHash: text('password_hash'),
  locale: text('locale'),
});

export const workspaceMembers = sqliteTable(
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

export const credentials = sqliteTable('credentials', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  kind: text('kind').notNull(),
  label: text('label').notNull(),
  ciphertext: text('ciphertext').notNull(),
  createdAt: integer('created_at').notNull(),
  rotatedAt: integer('rotated_at'),
  lastTestAt: integer('last_test_at'),
  lastTestOk: integer('last_test_ok'),
  lastTestMessage: text('last_test_message'),
});

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    detail: text('detail'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('audit_events_workspace_idx').on(t.workspaceId, t.createdAt)],
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    queue: text('queue').notNull(),
    payload: text('payload').notNull(),
    status: text('status').notNull(),
    runAt: integer('run_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    lockedAt: integer('locked_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('jobs_ready_idx').on(t.status, t.runAt)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const invitations = sqliteTable(
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
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    acceptedAt: integer('accepted_at'),
    acceptedBy: text('accepted_by').references(() => users.id),
    revokedAt: integer('revoked_at'),
  },
  (t) => [index('invitations_workspace_idx').on(t.workspaceId)],
);

export const repositories = sqliteTable(
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
    detectedAt: integer('detected_at'),
    /** The last ProjectDetection as JSON. */
    detectionJson: text('detection_json'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('repositories_workspace_repo_idx').on(t.workspaceId, t.owner, t.repo)],
);

export const changeSets = sqliteTable(
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
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    approvedBy: text('approved_by'),
    approvedAt: integer('approved_at'),
    appliedAt: integer('applied_at'),
    /** What a local commit did (commit, push, pull request) as JSON; null for the GitHub API apply. */
    outcomeJson: text('outcome_json'),
    /** Set while a push or pull request of a local commit is being made. */
    publishClaimAt: integer('publish_claim_at'),
    /** What the change set was made from (the store pull's request) as JSON, so it can be recomputed; null otherwise. */
    originJson: text('origin_json'),
  },
  (t) => [
    index('change_sets_workspace_idx').on(t.workspaceId, t.createdAt),
    index('change_sets_repository_idx').on(t.repositoryId),
  ],
);

export const apps = sqliteTable(
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
    lastSyncedAt: integer('last_synced_at'),
    lastSyncAttemptAt: integer('last_sync_attempt_at'),
    lastSyncError: text('last_sync_error'),
    /** The stable code of the note and its parameters as JSON, for translation (migration 50). Null for notes written before it. */
    lastSyncErrorCode: text('last_sync_error_code'),
    lastSyncErrorParams: text('last_sync_error_params'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('apps_workspace_identifier_idx').on(t.workspaceId, t.platform, t.identifier)],
);

export const appReleases = sqliteTable(
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
    storeUpdatedAt: integer('store_updated_at'),
    /** When the sync first saw the version (or track release) in its current state, state name or build (migration 28). */
    statusSince: integer('status_since'),
    syncedAt: integer('synced_at').notNull(),
  },
  (t) => [
    uniqueIndex('app_releases_app_version_idx').on(t.appId, t.platform, t.version, t.track),
    index('app_releases_workspace_idx').on(t.workspaceId),
  ],
);

export const repositoryListingTargets = sqliteTable(
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
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('repository_listing_targets_name_idx').on(t.repositoryId, t.name)],
);

export const apiTokens = sqliteTable(
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
    expiresAt: integer('expires_at'),
    lastUsedAt: integer('last_used_at'),
    revokedAt: integer('revoked_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('api_tokens_hash_idx').on(t.tokenHash),
    index('api_tokens_workspace_idx').on(t.workspaceId),
  ],
);

export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    type: text('type').notNull(),
    appId: text('app_id'),
    repositoryId: text('repository_id'),
    releaseId: text('release_id'),
    /** JSON. Never holds a secret. */
    payload: text('payload').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('events_workspace_idx').on(t.workspaceId, t.id)],
);

export const webhookEndpoints = sqliteTable(
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
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('webhook_endpoints_workspace_idx').on(t.workspaceId)],
);

export const webhookDeliveries = sqliteTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    endpointId: text('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id),
    eventId: integer('event_id'),
    eventType: text('event_type').notNull(),
    /** The exact JSON that is signed and sent. Never holds a secret. */
    body: text('body').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    responseCode: integer('response_code'),
    responseBody: text('response_body'),
    error: text('error'),
    redeliveryOf: text('redelivery_of'),
    createdAt: integer('created_at').notNull(),
    deliveredAt: integer('delivered_at'),
  },
  (t) => [index('webhook_deliveries_endpoint_idx').on(t.endpointId, t.createdAt)],
);

export const listingSnapshots = sqliteTable(
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
    observedAt: integer('observed_at').notNull(),
    actorType: text('actor_type'),
    actorId: text('actor_id'),
  },
  (t) => [
    index('listing_snapshots_field_idx').on(t.appId, t.locale, t.field, t.observedAt),
    index('listing_snapshots_ref_idx').on(t.appId, t.source, t.sourceRef),
    index('listing_snapshots_workspace_idx').on(t.workspaceId),
  ],
);

export const appListingStatus = sqliteTable('app_listing_status', {
  appId: text('app_id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  listingReadAt: integer('listing_read_at'),
  listingError: text('listing_error'),
  /** When the last listing read was tried (any path, success or not). */
  listingAttemptAt: integer('listing_attempt_at'),
  /** Failed reads in a row; 0 after a success. */
  listingFailures: integer('listing_failures').notNull().default(0),
  /** The connector's warnings of the last successful read, a JSON array of sentences. */
  listingWarnings: text('listing_warnings'),
  repoReadAt: integer('repo_read_at'),
  repoRef: text('repo_ref'),
  repoError: text('repo_error'),
});

export const workflowRuns = sqliteTable(
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
    /** Migration 46: `github` or `eas-workflows` (packages/core/src/ci-providers.ts). */
    provider: text('provider').notNull().default('github'),
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
    startedAt: integer('started_at').notNull(),
    runUpdatedAt: integer('run_updated_at').notNull(),
    syncedAt: integer('synced_at').notNull(),
  },
  (t) => [
    uniqueIndex('workflow_runs_repository_run_idx').on(t.repositoryId, t.runId),
    index('workflow_runs_repository_started_idx').on(t.repositoryId, t.startedAt),
    index('workflow_runs_workspace_idx').on(t.workspaceId),
  ],
);

export const buildLinks = sqliteTable(
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
    linkedAt: integer('linked_at').notNull(),
  },
  (t) => [
    uniqueIndex('build_links_app_build_idx').on(t.appId, t.platform, t.buildNumber),
    index('build_links_workspace_idx').on(t.workspaceId),
  ],
);

export const buildConventions = sqliteTable(
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
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('build_conventions_scope_idx').on(t.repositoryId, t.appId),
    index('build_conventions_workspace_idx').on(t.workspaceId),
  ],
);

export const buildScans = sqliteTable(
  'build_scans',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** No foreign key, like workflow_runs. One row per repository. */
    repositoryId: text('repository_id').notNull(),
    scannedAt: integer('scanned_at').notNull(),
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

export const releasePlans = sqliteTable(
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
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    /** Null: no rollout plan. steps (our own percentages) or apple_phased (Apple's fixed schedule, informational). */
    rolloutKind: text('rollout_kind'),
    /** The built-in rollout template the plan started from, if any. */
    rolloutTemplate: text('rollout_template'),
    /** Epoch milliseconds of the expected day 1 of an Apple phased release. */
    rolloutStartAt: integer('rollout_start_at'),
  },
  (t) => [
    uniqueIndex('release_plans_app_version_idx').on(t.appId, t.version),
    index('release_plans_workspace_idx').on(t.workspaceId),
  ],
);

export const checklistItems = sqliteTable(
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
    doneAt: integer('done_at'),
  },
  (t) => [
    index('checklist_items_plan_idx').on(t.planId, t.position),
    index('checklist_items_workspace_idx').on(t.workspaceId),
  ],
);

export const releaseNotes = sqliteTable(
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
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('release_notes_plan_locale_idx').on(t.planId, t.locale),
    index('release_notes_workspace_idx').on(t.workspaceId),
  ],
);

export const checklistTemplates = sqliteTable(
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
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('checklist_templates_name_idx').on(t.workspaceId, t.name)],
);

/**
 * Where a repository's local clone is (docs/adr/0005-local-clone-reads.md). One row per
 * repository: the optional local copy reads come from for a GitHub repository, or the repository
 * itself when it has no GitHub connection (then credentialId, owner and repo are NULL).
 */
export const repositoryLocalCheckouts = sqliteTable(
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
    lastReadAt: integer('last_read_at'),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('repository_local_checkouts_path_idx').on(t.workspaceId, t.path)],
);

export const planRolloutSteps = sqliteTable(
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
    plannedAt: integer('planned_at'),
    note: text('note'),
    /** planned, done or skipped. */
    status: text('status').notNull().default('planned'),
    doneAt: integer('done_at'),
    doneBy: text('done_by'),
    /** manual, or store when a person confirmed the step against the share a sync saw. */
    doneSource: text('done_source'),
  },
  (t) => [
    index('plan_rollout_steps_plan_idx').on(t.planId, t.position),
    index('plan_rollout_steps_due_idx').on(t.status, t.plannedAt),
  ],
);

export const planReminders = sqliteTable(
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
    sentAt: integer('sent_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.planId, t.itemId, t.kind, t.dueKey] }),
    index('plan_reminders_workspace_idx').on(t.workspaceId),
  ],
);

/** Customer reviews read from a store (read only). See migration 19 for what each column means. */
export const appReviews = sqliteTable(
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
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    firstSeenAt: integer('first_seen_at').notNull(),
    fetchedAt: integer('fetched_at').notNull(),
    /** JSON { body, at?, state? } or null. */
    developerResponse: text('developer_response'),
    /** Our own triage state: new, triaged, replied_in_console or ignored. Never sent to a store. */
    status: text('status').notNull().default('new'),
    assigneeUserId: text('assignee_user_id'),
    internalNote: text('internal_note'),
    statusChangedAt: integer('status_changed_at'),
    statusChangedBy: text('status_changed_by'),
    lowRatingNotifiedAt: integer('low_rating_notified_at'),
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

export const reviewSyncState = sqliteTable(
  'review_sync_state',
  {
    appId: text('app_id').notNull(),
    store: text('store').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** Where an unfinished read continues (App Store). */
    cursor: text('cursor'),
    lastAttemptAt: integer('last_attempt_at'),
    lastSuccessAt: integer('last_success_at'),
    lastError: text('last_error'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    backoffUntil: integer('backoff_until'),
    failureNotifiedAt: integer('failure_notified_at'),
    lastGapAt: integer('last_gap_at'),
    /** JSON of the last result: counts and warnings. */
    lastResult: text('last_result'),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.store] }),
    index('review_sync_state_workspace_idx').on(t.workspaceId),
  ],
);

/** The store-wide rating per territory, a row only when a value changed. Averages are thousandths. */
export const appRatingSummaries = sqliteTable(
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
    observedAt: integer('observed_at').notNull(),
  },
  (t) => [
    index('app_rating_summaries_app_idx').on(t.appId, t.store, t.territory, t.observedAt),
    index('app_rating_summaries_workspace_idx').on(t.workspaceId),
  ],
);

/** The resolved icon of an app (services/app-icons.ts): the image as base64 text, or only the state of a failed look. */
export const appIcons = sqliteTable(
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
    fetchedAt: integer('fetched_at'),
    checkedAt: integer('checked_at').notNull(),
    failures: integer('failures').notNull().default(0),
    backoffUntil: integer('backoff_until'),
    lastError: text('last_error'),
  },
  (t) => [index('app_icons_workspace_idx').on(t.workspaceId)],
);

/** One row per workspace and setting key; the known keys and their defaults live in code. Never a secret. */
export const workspaceSettings = sqliteTable(
  'workspace_settings',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    key: text('key').notNull(),
    /** JSON of the value. */
    valueJson: text('value_json').notNull(),
    updatedAt: integer('updated_at').notNull(),
    updatedBy: text('updated_by'),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);

/** A translation of one field of a review, reused until the review text (its hash) changes. */
export const reviewTranslations = sqliteTable(
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
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('review_translations_key_idx').on(
      t.reviewId,
      t.field,
      t.targetLang,
      t.provider,
      t.sourceHash,
    ),
    index('review_translations_app_idx').on(t.appId),
    index('review_translations_workspace_idx').on(t.workspaceId),
  ],
);

/** Characters sent to a translation provider per workspace and UTC day (YYYY-MM-DD). */
export const translationUsage = sqliteTable(
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
export const reviewReplyDrafts = sqliteTable(
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
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    sentAt: integer('sent_at'),
    sentBy: text('sent_by'),
    /** When the send in flight started; the claim expires after a TTL. */
    claimAt: integer('claim_at'),
    storeResponseId: text('store_response_id'),
  },
  (t) => [
    uniqueIndex('review_reply_drafts_review_idx').on(t.reviewId),
    index('review_reply_drafts_workspace_idx').on(t.workspaceId, t.status),
    index('review_reply_drafts_app_idx').on(t.appId),
  ],
);

/** Workspace-wide reply templates with {author} and {app} placeholders. */
export const reviewReplyTemplates = sqliteTable(
  'review_reply_templates',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    name: text('name').notNull(),
    body: text('body').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('review_reply_templates_workspace_idx').on(t.workspaceId)],
);

/**
 * The claim a gated store rollout write holds while it runs, one row per app and platform (see
 * migration 22 and docs/adr/0008-store-rollout-writes.md). Deleted when the write settles.
 */
export const storeRolloutClaims = sqliteTable(
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
    claimAt: integer('claim_at').notNull(),
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
export const stagedChanges = sqliteTable(
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
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    pushedAt: integer('pushed_at'),
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
export const storeDraftClaims = sqliteTable(
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
    claimAt: integer('claim_at').notNull(),
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
export const storeDraftPushes = sqliteTable(
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
    pushedAt: integer('pushed_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
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
export const storeSubmitClaims = sqliteTable(
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
    claimAt: integer('claim_at').notNull(),
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
export const storeReleaseClaims = sqliteTable(
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
    claimAt: integer('claim_at').notNull(),
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
export const asoKeywords = sqliteTable(
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
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastCheckedAt: integer('last_checked_at'),
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

export const asoRankChecks = sqliteTable(
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
    checkedAt: integer('checked_at').notNull(),
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

export const asoCompetitors = sqliteTable(
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
    addedAt: integer('added_at').notNull(),
    lastCheckedAt: integer('last_checked_at'),
    /** ok, not_found or unavailable. */
    lastState: text('last_state'),
    lastError: text('last_error'),
  },
  (t) => [
    uniqueIndex('aso_competitors_unique_idx').on(t.appId, t.store, t.externalId, t.country),
    index('aso_competitors_workspace_idx').on(t.workspaceId, t.appId),
  ],
);

export const asoCompetitorSnapshots = sqliteTable(
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
    checkedAt: integer('checked_at').notNull(),
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
export const asoAppState = sqliteTable(
  'aso_app_state',
  {
    appId: text('app_id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    lastAttemptAt: integer('last_attempt_at'),
    lastSuccessAt: integer('last_success_at'),
    lastError: text('last_error'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    backoffUntil: integer('backoff_until'),
    claimedAt: integer('claimed_at'),
    claimedBy: text('claimed_by'),
    lastResult: text('last_result'),
  },
  (t) => [index('aso_app_state_workspace_idx').on(t.workspaceId)],
);

/**
 * The bytes of an image uploaded or fixed in the app for a staged set of graphics (see migration 26 and
 * docs/adr/0012-assets-two-way-sync.md). base64 text; the staged row refers to it by (app_id, oid).
 */
export const stagedAssetBlobs = sqliteTable(
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
    createdAt: integer('created_at').notNull(),
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
export const ciRunApps = sqliteTable(
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
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runRef, t.appId] }),
    index('ci_run_apps_app_idx').on(t.workspaceId, t.appId),
  ],
);

/** The builds the last store sync saw (iOS and macOS: App Store Connect builds; Android: version codes of track releases). Migration 28. */
export const appBuilds = sqliteTable(
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
    uploadedAt: integer('uploaded_at'),
    firstSeenAt: integer('first_seen_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.platform, t.buildNumber] }),
    index('app_builds_workspace_idx').on(t.workspaceId, t.appId),
  ],
);

/** The reminder about a stalled release that was sent, one row per app and platform while the stall lasts (migration 28). */
export const releaseStallReminders = sqliteTable(
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
    firstSentAt: integer('first_sent_at').notNull(),
    lastSentAt: integer('last_sent_at').notNull(),
    sentCount: integer('sent_count').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.platform] }),
    index('release_stall_reminders_workspace_idx').on(t.workspaceId),
  ],
);

/** The last digest of unanswered reviews that was sent, one row per workspace (migration 28). */
export const reviewUnansweredReminders = sqliteTable('review_unanswered_reminders', {
  workspaceId: text('workspace_id')
    .primaryKey()
    .references(() => workspaces.id),
  lastSentAt: integer('last_sent_at').notNull(),
  lastCount: integer('last_count').notNull(),
  lastOldestAt: integer('last_oldest_at'),
});

/**
 * The claim a BATCH PUBLISH takes before it runs its steps (see migration 29 and docs/adr/0015-pending-and-batch-publish.md): one row
 * per app and platform. Same shape as `store_release_claims`; only `writing` is used.
 */
export const storePublishClaims = sqliteTable(
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
    claimAt: integer('claim_at').notNull(),
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
export const aiUsage = sqliteTable(
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
    createdAt: integer('created_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (t) => [index('ai_usage_workspace_idx').on(t.workspaceId, t.createdAt)],
);

/**
 * What an AI task proposed (migration 30): validated, post-processed output that a person accepts or dismisses. Accepting hands
 * it to an existing mechanism (keywords, staged text, reply draft); nothing here is ever sent to a store.
 */
export const aiSuggestions = sqliteTable(
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
    createdAt: integer('created_at').notNull(),
    decidedBy: text('decided_by'),
    decidedAt: integer('decided_at'),
    /** JSON: ids of what accepting created. */
    accepted: text('accepted'),
  },
  (t) => [
    index('ai_suggestions_app_idx').on(t.workspaceId, t.appId, t.createdAt),
    index('ai_suggestions_created_idx').on(t.createdAt),
  ],
);

/** The normalised daily metrics every analytics source writes (docs/adr/0017-analytics-foundation.md). Migration 31. */
export const analyticsDaily = sqliteTable(
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
    valueMicro: integer('value_micro').notNull(),
    /** The day the store produced the number; a later one replaces an earlier one. */
    processingDate: text('processing_date').notNull().default(''),
    /** sync or import. */
    origin: text('origin').notNull().default('sync'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.appId, t.platform, t.source, t.metric, t.day, t.dimType, t.dimValue],
    }),
    index('analytics_daily_workspace_idx').on(t.workspaceId, t.appId, t.day),
    index('analytics_daily_day_idx').on(t.day),
  ],
);

/** One row per sync of one app and source: counts and a fixed error code, nothing else. Migration 31. */
export const analyticsSyncRuns = sqliteTable(
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
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (t) => [
    index('analytics_sync_runs_app_idx').on(t.workspaceId, t.appId, t.startedAt),
    index('analytics_sync_runs_started_idx').on(t.startedAt),
  ],
);

/** The Apple analytics report request an explicit "enable analytics" created or found. Migration 31. */
export const analyticsReportRequests = sqliteTable(
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
    createdAt: integer('created_at').notNull(),
    lastCheckedAt: integer('last_checked_at'),
    lastErrorCode: text('last_error_code'),
  },
  (t) => [
    uniqueIndex('analytics_report_requests_app_idx').on(t.appId, t.accessType),
    index('analytics_report_requests_workspace_idx').on(t.workspaceId),
  ],
);

/** The Apple report instances already read, so a sync reads each processed instance once. Migration 31. */
export const analyticsInstances = sqliteTable(
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
    readAt: integer('read_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.appleInstanceId] }),
    index('analytics_instances_workspace_idx').on(t.workspaceId, t.appId, t.readAt),
  ],
);

/** Per-app analytics switches. Migration 31. */
export const analyticsAppConfig = sqliteTable(
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
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('analytics_app_config_workspace_idx').on(t.workspaceId)],
);

/** The Google Play reports bucket of a Play developer account, shared by its Android apps (migration 42). Not a secret. */
export const analyticsCredentialConfig = sqliteTable(
  'analytics_credential_config',
  {
    credentialId: text('credential_id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    playBucketId: text('play_bucket_id'),
    updatedBy: text('updated_by').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('analytics_credential_config_workspace_idx').on(t.workspaceId)],
);

/** The last result per app, platform and source; the status endpoint reads it. Migration 31. */
export const analyticsSourceState = sqliteTable(
  'analytics_source_state',
  {
    appId: text('app_id').notNull(),
    platform: text('platform').notNull(),
    source: text('source').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    setupCode: text('setup_code'),
    lastAttemptAt: integer('last_attempt_at'),
    lastOkAt: integer('last_ok_at'),
    lastErrorCode: text('last_error_code'),
    oldestDay: text('oldest_day'),
    newestDay: text('newest_day'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.platform, t.source] }),
    index('analytics_source_state_workspace_idx').on(t.workspaceId),
  ],
);

/** Google Play search terms per app, storefront and period, from a file the developer exports from Play Console. Migration 32. */
export const playSearchTerms = sqliteTable(
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
    visitors: integer('visitors'),
    installs: integer('installs'),
    conversionMicro: integer('conversion_micro'),
    importedAt: integer('imported_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.country, t.periodFrom, t.periodTo, t.termKey] }),
    index('play_search_terms_workspace_idx').on(t.workspaceId, t.appId, t.periodTo),
  ],
);

/** The latest search terms import per app (the freshness line). Migration 32. */
export const playSearchTermImports = sqliteTable(
  'play_search_term_imports',
  {
    appId: text('app_id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    lastImportAt: integer('last_import_at').notNull(),
    lastPeriodFrom: text('last_period_from'),
    lastPeriodTo: text('last_period_to'),
    imports: integer('imports').notNull().default(0),
    updatedBy: text('updated_by').notNull(),
  },
  (t) => [index('play_search_term_imports_workspace_idx').on(t.workspaceId)],
);

/** A passkey (WebAuthn credential) of a person, used to confirm hard actions. Migration 33. Never a private key. */
export const stepUpCredentials = sqliteTable(
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
    signCount: integer('sign_count').notNull().default(0),
    name: text('name').notNull(),
    transports: text('transports'),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
  },
  (t) => [index('step_up_credentials_user_idx').on(t.userId)],
);

/** A one-time challenge for a passkey registration or assertion; deleted when used. Migration 33. */
export const stepUpChallenges = sqliteTable(
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
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('step_up_challenges_expires_idx').on(t.expiresAt)],
);

/** A passed confirmation: single use, bound to session, user, action and target. Keyed by the SHA-256 of the grant. Migration 33. */
export const stepUpGrants = sqliteTable(
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
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
  },
  (t) => [index('step_up_grants_expires_idx').on(t.expiresAt)],
);

/** The optional confirmation password of a person and the failure counter with its lockout. Migration 33. */
export const stepUpUsers = sqliteTable('step_up_users', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id),
  confirmationHash: text('confirmation_hash'),
  failedCount: integer('failed_count').notNull().default(0),
  lockedUntil: integer('locked_until'),
  updatedAt: integer('updated_at').notNull(),
});

/** One one-time recovery code of a person, as a salted SHA-256. Migration 34. */
export const stepUpRecoveryCodes = sqliteTable(
  'step_up_recovery_codes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    codeHash: text('code_hash').notNull(),
    createdAt: integer('created_at').notNull(),
    usedAt: integer('used_at'),
  },
  (t) => [index('step_up_recovery_codes_user_idx').on(t.userId)],
);

/** A build handed to Google Play internal app sharing. The link is encrypted and cleared after 24 hours. Migration 34. */
export const playInternalShares = sqliteTable(
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
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    certificateFingerprint: text('certificate_fingerprint'),
    urlSecret: text('url_secret'),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('play_internal_shares_app_idx').on(t.workspaceId, t.appId, t.createdAt)],
);

/** One upload in flight per app (writing), or one whose outcome is not known (unknown). Migration 34. */
export const playInternalShareClaims = sqliteTable('play_internal_share_claims', {
  appId: text('app_id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  status: text('status').notNull(),
  claimedBy: text('claimed_by').notNull(),
  claimAt: integer('claim_at').notNull(),
});

/** What a person told the assistant about an app (migration 40, docs/adr/0024-ai-features.md). Sent with every AI task of the app. */
export const aiAppContext = sqliteTable(
  'ai_app_context',
  {
    appId: text('app_id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** JSON: about, audience, tone, brandVoice, bannedWords, brandTerms, doList, dontList. */
    context: text('context').notNull(),
    updatedBy: text('updated_by').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('ai_app_context_workspace_idx').on(t.workspaceId)],
);

/** The tags the assistant gave a review, a cache so a review is tagged once (migration 41). Holds a hash of the text, never the text. */
export const reviewClassifications = sqliteTable(
  'review_classifications',
  {
    reviewId: text('review_id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    appId: text('app_id').notNull(),
    taskVersion: integer('task_version').notNull(),
    textHash: text('text_hash').notNull(),
    /** JSON list from a fixed vocabulary. */
    topics: text('topics').notNull(),
    sentiment: text('sentiment').notNull(),
    severity: text('severity').notNull(),
    language: text('language'),
    needsReply: integer('needs_reply').notNull().default(0),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('review_classifications_app_idx').on(t.workspaceId, t.appId)],
);

/** One setting of the whole server, encrypted (the SMTP settings). Migration 35. */
export const instanceSettings = sqliteTable('instance_settings', {
  key: text('key').primaryKey(),
  valueEnc: text('value_enc').notNull(),
  updatedAt: integer('updated_at').notNull(),
  updatedBy: text('updated_by'),
});

/** The address a person verified for email codes. Migration 35. */
export const userMail = sqliteTable('user_mail', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id),
  email: text('email').notNull(),
  verifiedAt: integer('verified_at'),
  createdAt: integer('created_at').notNull(),
});

/** One mailed six digit code (an HMAC, never the code). Migration 35. */
export const mailCodes = sqliteTable(
  'mail_codes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    purpose: text('purpose').notNull(),
    workspaceId: text('workspace_id'),
    binding: text('binding'),
    action: text('action'),
    targetId: text('target_id'),
    targetHash: text('target_hash'),
    email: text('email').notNull(),
    codeMac: text('code_mac').notNull(),
    attempts: integer('attempts').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
  },
  (t) => [
    index('mail_codes_user_idx').on(t.userId, t.createdAt),
    index('mail_codes_workspace_idx').on(t.workspaceId, t.createdAt),
  ],
);

/** The TOTP secret of a person, encrypted. Migration 36. */
export const userTotp = sqliteTable('user_totp', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id),
  secretEnc: text('secret_enc').notNull(),
  confirmedAt: integer('confirmed_at'),
  lastStep: integer('last_step'),
  createdAt: integer('created_at').notNull(),
});

/** Between a right password and the second factor. Migration 36. */
export const loginChallenges = sqliteTable(
  'login_challenges',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind').notNull(),
    attempts: integer('attempts').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('login_challenges_expires_idx').on(t.expiresAt)],
);

/** What an admin decided for one alert type of a workspace (docs/alerts.md). Migration 37. */
export const alertWorkspaceRules = sqliteTable(
  'alert_workspace_rules',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    alertType: text('alert_type').notNull(),
    enabled: integer('enabled').notNull().default(1),
    channels: text('channels').notNull(),
    maxPerHour: integer('max_per_hour'),
    params: text('params'),
    updatedBy: text('updated_by').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.alertType] })],
);

/** A person's alert settings in a workspace: lowest severity, quiet hours, digest. Migration 37. */
export const alertUserSettings = sqliteTable(
  'alert_user_settings',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    minSeverity: text('min_severity').notNull().default('info'),
    quietStart: integer('quiet_start'),
    quietEnd: integer('quiet_end'),
    timezone: text('timezone'),
    digest: text('digest').notNull().default('off'),
    digestHour: integer('digest_hour').notNull().default(8),
    lastDigestAt: integer('last_digest_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

/** A person's own channels for one alert type, for all apps (app_id '') or one. Migration 37. */
export const alertPreferences = sqliteTable(
  'alert_preferences',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    alertType: text('alert_type').notNull(),
    appId: text('app_id').notNull().default(''),
    channels: text('channels').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId, t.alertType, t.appId] })],
);

/** A snooze (until set) or a mute (until null) of an app, an alert type or both (null = all). Migration 37. */
export const alertMutes = sqliteTable(
  'alert_mutes',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    appId: text('app_id'),
    alertType: text('alert_type'),
    until: integer('until'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('alert_mutes_user_idx').on(t.workspaceId, t.userId)],
);

/** One alert after repeats collapsed (count). Migration 38. */
export const alerts = sqliteTable(
  'alerts',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    type: text('type').notNull(),
    severity: text('severity').notNull(),
    appId: text('app_id'),
    dedupeKey: text('dedupe_key').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    data: text('data').notNull(),
    count: integer('count').notNull().default(1),
    firstAt: integer('first_at').notNull(),
    lastAt: integer('last_at').notNull(),
    resolvedAt: integer('resolved_at'),
    isTest: integer('is_test').notNull().default(0),
  },
  (t) => [
    index('alerts_key_idx').on(t.workspaceId, t.dedupeKey, t.lastAt),
    index('alerts_workspace_idx').on(t.workspaceId, t.lastAt),
    index('alerts_type_idx').on(t.workspaceId, t.type, t.firstAt),
  ],
);

/** The in-app channel: one row per person and alert. Migration 38. */
export const alertInbox = sqliteTable(
  'alert_inbox',
  {
    alertId: text('alert_id')
      .notNull()
      .references(() => alerts.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    desktop: integer('desktop').notNull().default(0),
    readAt: integer('read_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.alertId, t.userId] }),
    index('alert_inbox_user_idx').on(t.workspaceId, t.userId, t.readAt),
  ],
);

/** The alert delivery log: one row per channel attempt, outcome from a fixed vocabulary. Migration 38. */
export const alertDeliveries = sqliteTable(
  'alert_deliveries',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    alertId: text('alert_id'),
    userId: text('user_id'),
    channel: text('channel').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    outcome: text('outcome').notNull(),
    attempts: integer('attempts').notNull().default(0),
    subject: text('subject'),
    body: text('body'),
    html: text('html'),
    eventId: integer('event_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deliveredAt: integer('delivered_at'),
  },
  (t) => [
    index('alert_deliveries_workspace_idx').on(t.workspaceId, t.createdAt),
    index('alert_deliveries_alert_idx').on(t.alertId),
  ],
);

/** What the alert evaluator last saw for a state condition. Migration 38. */
export const alertConditions = sqliteTable(
  'alert_conditions',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    dedupeKey: text('dedupe_key').notNull(),
    type: text('type').notNull(),
    appId: text('app_id'),
    firstSeenAt: integer('first_seen_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    raisedAt: integer('raised_at').notNull(),
    active: integer('active').notNull().default(1),
    alertId: text('alert_id'),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.dedupeKey] }),
    index('alert_conditions_active_idx').on(t.workspaceId, t.active),
  ],
);

/** The link between an app and its Expo (EAS) project (migration 44). Not a secret: the token stays in `credentials`. */
export const appExpoLinks = sqliteTable(
  'app_expo_links',
  {
    /** No foreign key: deleteApp removes the row. */
    appId: text('app_id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** No foreign key: a credential can be deleted while a link still names it. */
    credentialId: text('credential_id').notNull(),
    /** The EAS project id (a UUID). */
    projectId: text('project_id').notNull(),
    accountName: text('account_name').notNull(),
    slug: text('slug').notNull(),
    projectName: text('project_name').notNull(),
    /** When Expo last confirmed the project with the credential. */
    verifiedAt: integer('verified_at').notNull(),
    linkedBy: text('linked_by').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('app_expo_links_workspace_idx').on(t.workspaceId),
    index('app_expo_links_project_idx').on(t.projectId),
    index('app_expo_links_credential_idx').on(t.credentialId),
  ],
);

/**
 * In-app purchases and subscriptions read from the stores (migration 45, docs/adr/0034-in-app-products.md): one row per product of an app
 * record. No foreign key to apps: deleteApp removes the rows.
 */
export const storeProducts = sqliteTable(
  'store_products',
  {
    appId: text('app_id').notNull(),
    productId: text('product_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** Apple's resource id; null for Google Play. */
    storeRef: text('store_ref'),
    /** consumable, non_consumable or subscription. */
    kind: text('kind').notNull(),
    referenceName: text('reference_name').notNull(),
    /** The normalized state (draft, in_review, action_needed, active, inactive, removed, unknown). */
    state: text('state').notNull(),
    rawState: text('raw_state'),
    groupName: text('group_name'),
    period: text('period'),
    baseTerritory: text('base_territory'),
    /** JSON: { territories, availableInNewTerritories }, or null when the store gave none. */
    availabilityJson: text('availability_json'),
    /** JSON: the plans and offers. */
    detailJson: text('detail_json').notNull().default('{}'),
    rawHash: text('raw_hash').notNull(),
    syncedAt: integer('synced_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.productId] }),
    index('store_products_workspace_idx').on(t.workspaceId),
  ],
);

/** The display name and description of a product per locale (migration 45). */
export const storeProductLocalizations = sqliteTable(
  'store_product_localizations',
  {
    appId: text('app_id').notNull(),
    productId: text('product_id').notNull(),
    locale: text('locale').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    name: text('name').notNull(),
    description: text('description').notNull(),
    /** Apple's id of the localization; null for Google Play. */
    storeRef: text('store_ref'),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.productId, t.locale] }),
    index('store_product_localizations_workspace_idx').on(t.workspaceId),
  ],
);

/** The price of a product per territory in minor units, as a string (migration 45). `planId` is '' when there is no plan. */
export const storeProductPrices = sqliteTable(
  'store_product_prices',
  {
    appId: text('app_id').notNull(),
    productId: text('product_id').notNull(),
    planId: text('plan_id').notNull().default(''),
    territory: text('territory').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    currency: text('currency').notNull(),
    amount: text('amount').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.productId, t.planId, t.territory] }),
    index('store_product_prices_workspace_idx').on(t.workspaceId),
  ],
);

/** The state of the last product sync of an app (migration 45). A failed sync keeps the last good snapshot. */
export const storeProductSync = sqliteTable(
  'store_product_sync',
  {
    appId: text('app_id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    lastAttemptAt: integer('last_attempt_at'),
    lastSyncedAt: integer('last_synced_at'),
    lastError: text('last_error'),
    failures: integer('failures').notNull().default(0),
    productCount: integer('product_count').notNull().default(0),
    complete: integer('complete').notNull().default(1),
    warningsJson: text('warnings_json').notNull().default('[]'),
  },
  (t) => [index('store_product_sync_workspace_idx').on(t.workspaceId)],
);

/** One localization write in flight per app (migration 45). `unknown`: the outcome of the last write is not known. */
export const storeProductClaims = sqliteTable(
  'store_product_claims',
  {
    appId: text('app_id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    productId: text('product_id').notNull(),
    status: text('status').notNull().default('writing'),
    claimedBy: text('claimed_by').notNull(),
    claimAt: integer('claim_at').notNull(),
  },
  (t) => [index('store_product_claims_workspace_idx').on(t.workspaceId)],
);

/**
 * Apple's Product Page Optimization experiments and custom product pages as the last sync read them (migration 53,
 * docs/adr/0048-store-experiments.md): one row per experiment (`kind` experiment) or page (`kind` custom_page). `detailJson` holds the
 * treatments, versions and locales. No foreign key to apps: deleteApp removes the rows.
 */
export const storeExperiments = sqliteTable(
  'store_experiments',
  {
    appId: text('app_id').notNull(),
    kind: text('kind').notNull(),
    itemId: text('item_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    name: text('name').notNull(),
    /** The normalized state (draft, in_review, approved, rejected, completed, stopped, replaced, unknown). */
    state: text('state').notNull(),
    rawState: text('raw_state'),
    startsAt: integer('starts_at'),
    endsAt: integer('ends_at'),
    url: text('url'),
    detailJson: text('detail_json').notNull().default('{}'),
    syncedAt: integer('synced_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.kind, t.itemId] }),
    index('store_experiments_workspace_idx').on(t.workspaceId),
  ],
);

/** The state of the last experiments sync of an app (migration 53). A failed sync keeps the last good snapshot. */
export const storeExperimentsSync = sqliteTable(
  'store_experiments_sync',
  {
    appId: text('app_id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    lastAttemptAt: integer('last_attempt_at'),
    lastSyncedAt: integer('last_synced_at'),
    lastError: text('last_error'),
    failures: integer('failures').notNull().default(0),
    experimentCount: integer('experiment_count').notNull().default(0),
    pageCount: integer('page_count').notNull().default(0),
    complete: integer('complete').notNull().default(1),
    warningsJson: text('warnings_json').notNull().default('[]'),
  },
  (t) => [index('store_experiments_sync_workspace_idx').on(t.workspaceId)],
);

/** The manual tracker of experiments and custom pages (migration 53): what a person writes down, for Google Play and for anything else. */
export const storeExperimentNotes = sqliteTable(
  'store_experiment_notes',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    appId: text('app_id').notNull(),
    /** experiment or custom_page. */
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    /** planned, running, finished or stopped. */
    status: text('status').notNull(),
    /** YYYY-MM-DD, or null. */
    startedOn: text('started_on'),
    endedOn: text('ended_on'),
    url: text('url'),
    /** The Google Play custom store listing parameter, or null. */
    listing: text('listing'),
    note: text('note').notNull().default(''),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('store_experiment_notes_workspace_idx').on(t.workspaceId),
    index('store_experiment_notes_app_idx').on(t.appId),
  ],
);

/**
 * The cached status of the EAS builds of an app record's Expo project (migration 47, docs/adr/0036-eas-build-submit-status.md). Read
 * from Expo by the status sync, never written back. No foreign key to apps: deleteApp removes the rows. The address of a build file is
 * deliberately not stored.
 */
export const easBuilds = sqliteTable(
  'eas_builds',
  {
    appId: text('app_id').notNull(),
    buildId: text('build_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** Expo's platform: ios or android. */
    platform: text('platform').notNull(),
    /** new, in_queue, in_progress, pending_cancel, finished, errored, canceled or unknown. */
    status: text('status').notNull(),
    /** Expo's own status, verbatim. */
    rawStatus: text('raw_status'),
    buildProfile: text('build_profile'),
    channel: text('channel'),
    appVersion: text('app_version'),
    appBuildVersion: text('app_build_version'),
    sdkVersion: text('sdk_version'),
    runtimeVersion: text('runtime_version'),
    /** store, internal, simulator or unknown. */
    distribution: text('distribution'),
    /** 0 or 1; null when Expo did not say. */
    simulator: integer('simulator'),
    appIdentifier: text('app_identifier'),
    gitCommitHash: text('git_commit_hash'),
    /** The first line, at most 200 characters. */
    gitCommitMessage: text('git_commit_message'),
    errorCode: text('error_code'),
    /** Expo's text, at most 500 characters. */
    errorMessage: text('error_message'),
    /** 0 or 1: Expo holds a build file. */
    hasArtifact: integer('has_artifact').notNull().default(0),
    createdAt: integer('created_at'),
    updatedAt: integer('updated_at'),
    completedAt: integer('completed_at'),
    /** When Expo deletes the build file. */
    expiresAt: integer('expires_at'),
    fetchedAt: integer('fetched_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.buildId] }),
    index('eas_builds_app_idx').on(t.appId, t.createdAt),
    index('eas_builds_workspace_idx').on(t.workspaceId),
  ],
);

/** The cached EAS submissions of an app record's Expo project (migration 47). */
export const easSubmissions = sqliteTable(
  'eas_submissions',
  {
    appId: text('app_id').notNull(),
    submissionId: text('submission_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    platform: text('platform').notNull(),
    /** awaiting_build, in_queue, in_progress, finished, errored, canceled or unknown. */
    status: text('status').notNull(),
    rawStatus: text('raw_status'),
    /** The EAS build that was submitted. */
    buildId: text('build_id'),
    /** The bundle id or package name Expo reports for the submission. */
    targetIdentifier: text('target_identifier'),
    /** Google Play's track, from the submission config. */
    track: text('track'),
    releaseStatus: text('release_status'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: integer('created_at'),
    completedAt: integer('completed_at'),
    fetchedAt: integer('fetched_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.submissionId] }),
    index('eas_submissions_app_idx').on(t.appId, t.createdAt),
    index('eas_submissions_workspace_idx').on(t.workspaceId),
  ],
);

/** The state of the status sync of one app record (migration 47): attempts, the failure streak and the backoff. */
export const easStatusSync = sqliteTable(
  'eas_status_sync',
  {
    appId: text('app_id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** The project and credential the snapshot was read with: a changed link starts again. */
    projectId: text('project_id'),
    credentialId: text('credential_id'),
    lastAttemptAt: integer('last_attempt_at'),
    lastSuccessAt: integer('last_success_at'),
    /** A short code (never Expo's text). */
    lastError: text('last_error'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    backoffUntil: integer('backoff_until'),
    buildsTruncated: integer('builds_truncated').notNull().default(0),
    submissionsTruncated: integer('submissions_truncated').notNull().default(0),
  },
  (t) => [index('eas_status_sync_workspace_idx').on(t.workspaceId)],
);

/**
 * RevenueCat next to the store products (migration 48, docs/adr/0039-revenuecat.md): the link between an app record and a RevenueCat
 * project and app. Not a secret: the key stays in `credentials`. No foreign keys to apps or credentials: deleteApp removes the rows.
 */
export const appRevenuecatLinks = sqliteTable(
  'app_revenuecat_links',
  {
    appId: text('app_id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** No foreign key: a credential can be deleted while a link still names it. */
    credentialId: text('credential_id').notNull(),
    projectId: text('project_id').notNull(),
    projectName: text('project_name').notNull(),
    rcAppId: text('rc_app_id').notNull(),
    rcAppName: text('rc_app_name').notNull(),
    /** app_store, mac_app_store or play_store. */
    rcAppType: text('rc_app_type').notNull(),
    /** The bundle id or package name RevenueCat holds for the app. */
    rcIdentifier: text('rc_identifier'),
    verifiedAt: integer('verified_at').notNull(),
    linkedBy: text('linked_by').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('app_revenuecat_links_workspace_idx').on(t.workspaceId),
    index('app_revenuecat_links_credential_idx').on(t.credentialId),
  ],
);

/** The products of the linked RevenueCat app, as last read (migration 48). */
export const revenuecatProducts = sqliteTable(
  'revenuecat_products',
  {
    appId: text('app_id').notNull(),
    rcProductId: text('rc_product_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** The store product id, or `subscription_id:base_plan_id` on Google Play. */
    storeIdentifier: text('store_identifier').notNull(),
    /** RevenueCat's type, kept as text so a new one still shows. */
    productType: text('product_type').notNull(),
    /** active, archived or unknown. */
    state: text('state').notNull(),
    rawState: text('raw_state'),
    displayName: text('display_name'),
    duration: text('duration'),
    gracePeriod: text('grace_period'),
    trialDuration: text('trial_duration'),
    fetchedAt: integer('fetched_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.rcProductId] }),
    index('revenuecat_products_workspace_idx').on(t.workspaceId),
  ],
);

/** The entitlements of the project that hold a product of the linked app, or none (migration 48). */
export const revenuecatEntitlements = sqliteTable(
  'revenuecat_entitlements',
  {
    appId: text('app_id').notNull(),
    entitlementId: text('entitlement_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    lookupKey: text('lookup_key').notNull(),
    displayName: text('display_name'),
    state: text('state').notNull(),
    rawState: text('raw_state'),
    /** JSON: the RevenueCat product ids of this app attached to the entitlement. */
    productIdsJson: text('product_ids_json').notNull().default('[]'),
    /** Every product attached in the project, of any app. */
    projectProductCount: integer('project_product_count').notNull().default(0),
    fetchedAt: integer('fetched_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.entitlementId] }),
    index('revenuecat_entitlements_workspace_idx').on(t.workspaceId),
  ],
);

/** The offerings of the project with the packages that hold a product of the linked app (migration 48). */
export const revenuecatOfferings = sqliteTable(
  'revenuecat_offerings',
  {
    appId: text('app_id').notNull(),
    offeringId: text('offering_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    lookupKey: text('lookup_key').notNull(),
    displayName: text('display_name'),
    isCurrent: integer('is_current').notNull().default(0),
    state: text('state').notNull(),
    rawState: text('raw_state'),
    /** JSON: the packages (lookup key, position, product ids with eligibility). */
    packagesJson: text('packages_json').notNull().default('[]'),
    fetchedAt: integer('fetched_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.offeringId] }),
    index('revenuecat_offerings_workspace_idx').on(t.workspaceId),
  ],
);

/** The state of the last RevenueCat read of one app record (migration 48). */
export const revenuecatSync = sqliteTable(
  'revenuecat_sync',
  {
    appId: text('app_id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    projectId: text('project_id'),
    credentialId: text('credential_id'),
    lastAttemptAt: integer('last_attempt_at'),
    lastSyncedAt: integer('last_synced_at'),
    /** A fixed sentence (never RevenueCat's text). */
    lastError: text('last_error'),
    failures: integer('failures').notNull().default(0),
    productCount: integer('product_count').notNull().default(0),
    otherAppProductCount: integer('other_app_product_count').notNull().default(0),
    complete: integer('complete').notNull().default(1),
    warningsJson: text('warnings_json').notNull().default('[]'),
  },
  (t) => [index('revenuecat_sync_workspace_idx').on(t.workspaceId)],
);

/**
 * The last good read of the RevenueCat metrics overview of the project an app record is linked to (migration 49,
 * docs/adr/0043-revenuecat-metrics.md), and how the last attempt went. The figures cover the whole project, not one app.
 */
export const revenuecatMetrics = sqliteTable(
  'revenuecat_metrics',
  {
    appId: text('app_id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    projectId: text('project_id').notNull(),
    /** The currency RevenueCat reported for its money figures; null when it said none. */
    currency: text('currency'),
    /** JSON: the metrics as read (id, name, unit, period, value, last_updated_at). */
    metricsJson: text('metrics_json').notNull().default('[]'),
    fetchedAt: integer('fetched_at'),
    lastAttemptAt: integer('last_attempt_at'),
    /** A fixed sentence (never RevenueCat's text). */
    lastError: text('last_error'),
    failures: integer('failures').notNull().default(0),
  },
  (t) => [index('revenuecat_metrics_workspace_idx').on(t.workspaceId)],
);
