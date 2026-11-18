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
