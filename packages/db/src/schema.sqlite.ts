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
    /** No foreign key: a credential can be deleted while a repository still names it. */
    credentialId: text('credential_id').notNull(),
    owner: text('owner').notNull(),
    repo: text('repo').notNull(),
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
