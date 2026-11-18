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
    /** No foreign key: a credential can be deleted while a repository still names it. */
    credentialId: text('credential_id').notNull(),
    owner: text('owner').notNull(),
    repo: text('repo').notNull(),
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
  },
  (t) => [
    index('change_sets_workspace_idx').on(t.workspaceId, t.createdAt),
    index('change_sets_repository_idx').on(t.repositoryId),
  ],
);
