import { credentialKinds, invitableRoles, roles } from '@mrm/core';
import { z } from 'zod';
import { eventTypes } from './event-types.ts';
import type { Operation } from './openapi.ts';
import { createTokenBody } from './tokens.ts';
import { createWebhookBody, updateWebhookBody } from './webhooks.ts';

/**
 * The registry: every operation of the API that is documented, with the permission it needs and
 * the risk it carries. It feeds `GET /api/openapi.json` and decides which routes an API token may
 * call (bearer.ts): a route that is not listed here is reachable with a session cookie only.
 *
 * Request bodies for the routes that existed before this file mirror the schemas in their route
 * files (they are not exported). Where a route's body or answer is large or still moving, the
 * operation says `partial` and describes only what is stable. The tests check that every listed
 * operation exists in the app and that the permission listed here is the one the route enforces.
 */

const id = z.string().min(1).max(100);
const timestamp = z.number().int().describe('Epoch milliseconds.');

// ----- resources ---------------------------------------------------------------------------------

export const eventSchema = z.object({
  id: z.number().int().describe('Increases with every event. Use it as the `since` cursor.'),
  type: z.enum(eventTypes),
  workspaceId: z.string(),
  subject: z.object({ appId: z.string().optional(), repositoryId: z.string().optional(), releaseId: z.string().optional() }),
  payload: z.record(z.unknown()).describe('Plain JSON. Never holds a secret.'),
  createdAt: timestamp,
});

export const tokenSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string().describe('`mrm_` and six more characters, to recognise the token. Not enough to use it.'),
  role: z.enum(['viewer', 'member', 'admin']),
  appIds: z.array(z.string()).nullable(),
  actions: z.array(z.string()).nullable(),
  expiresAt: timestamp.nullable(),
  lastUsedAt: timestamp.nullable(),
  revokedAt: timestamp.nullable(),
  createdAt: timestamp,
  createdBy: z.object({ id: z.string(), name: z.string().nullable() }),
  status: z.enum(['active', 'revoked', 'expired']),
});

export const webhookSchema = z.object({
  id: z.string(),
  url: z.string(),
  description: z.string().nullable(),
  eventTypes: z.array(z.string()),
  enabled: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp,
  lastDelivery: z.object({ status: z.string(), at: timestamp, responseCode: z.number().int().nullable() }).nullable(),
});

export const deliverySchema = z.object({
  id: z.string(),
  endpointId: z.string(),
  eventId: z.number().int().nullable(),
  eventType: z.string(),
  status: z.enum(['pending', 'retrying', 'success', 'failed']),
  attempts: z.number().int(),
  responseCode: z.number().int().nullable(),
  responseBody: z.string().nullable().describe('Truncated, with the signing secret removed.'),
  error: z.string().nullable(),
  redeliveryOf: z.string().nullable(),
  createdAt: timestamp,
  deliveredAt: timestamp.nullable(),
});

const userSchema = z.object({ id: z.string(), email: z.string(), displayName: z.string() });
const credentialSchema = z.object({
  id: z.string(),
  kind: z.enum(credentialKinds),
  label: z.string(),
  createdAt: timestamp,
  rotatedAt: timestamp.nullable(),
  lastTest: z.object({ at: timestamp, ok: z.boolean(), message: z.string() }).nullable(),
});
const memberSchema = z.object({ userId: z.string(), email: z.string(), displayName: z.string(), role: z.enum(roles) });
const invitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(invitableRoles),
  createdAt: timestamp,
  expiresAt: timestamp,
  createdByName: z.string().nullable(),
});
const appSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.enum(['ios', 'android']),
  identifier: z.string(),
  storeAppId: z.string().nullable(),
  credentialId: z.string(),
  repositoryId: z.string().nullable(),
  createdAt: timestamp,
  lastSyncedAt: timestamp.nullable(),
  lastSyncAttemptAt: timestamp.nullable(),
  lastSyncError: z.string().nullable(),
});
const releaseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  platform: z.enum(['ios', 'android']),
  version: z.string(),
  track: z.string().nullable(),
  build: z.string().nullable(),
  status: z.string().nullable().describe('The normalized lifecycle state, or null when the store state is not mapped.'),
  rawState: z.string(),
  rolloutFraction: z.number().nullable(),
  versionCodes: z.array(z.string()).nullable(),
  storeUpdatedAt: timestamp.nullable(),
  syncedAt: timestamp,
});
const changeSetSchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  summary: z.string(),
  status: z.string(),
  createdBy: z.object({ type: z.enum(['user', 'token', 'assistant', 'system']), id: z.string() }),
  branch: z.string().nullable(),
  prUrl: z.string().nullable(),
  prNumber: z.number().int().nullable(),
  commitSha: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  approvedBy: z.string().nullable(),
  approvedAt: timestamp.nullable(),
  appliedAt: timestamp.nullable(),
  filesChanged: z.number().int(),
  files: z.array(z.object({ path: z.string(), change: z.enum(['added', 'modified', 'deleted']) })),
});
const object = z.record(z.unknown());
const changeSetAnswer = { description: 'The change set.', schema: z.object({ changeSet: changeSetSchema }) };
const none = { description: 'Done. No body.' };
const testOutcome = z.object({ ok: z.boolean(), message: z.string(), details: z.array(z.string()).optional(), superseded: z.boolean().optional() });

// ----- request bodies that mirror their route files ---------------------------------------------

const registerBody = z.object({
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(200),
  workspaceName: z.string().trim().min(1).max(100),
});
const loginBody = z.object({ email: z.string().max(254), password: z.string().max(200) });
const secretText = z.string().min(1).max(64 * 1024).describe('Write only: never returned.');
const credentialBody = z.object({ kind: z.enum(credentialKinds), label: z.string().trim().min(1).max(100), secret: secretText });
const rotateBody = z.object({ secret: secretText });
const testBody = z.object({ kind: z.enum(credentialKinds), secret: secretText });
const roleBody = z.object({ role: z.enum(roles) });
const inviteBody = z.object({ email: z.string().trim().email().max(254), role: z.enum(invitableRoles) });
const acceptBody = z.object({ displayName: z.string().trim().max(100).optional(), password: z.string().max(200).optional() });
const platform = z.enum(['ios', 'android']);
const appBody = z.object({
  platform,
  identifier: z.string().trim().min(1).max(255),
  credentialId: id,
  name: z.string().trim().min(1).max(100).optional(),
  repositoryId: id.optional(),
});
const discoverBody = z.object({
  credentialId: id,
  packages: z.array(z.string().trim().min(1).max(255)).min(1).max(50).optional().describe('Google Play only: package names to verify.'),
});
const importBody = z.object({
  credentialId: id,
  items: z
    .array(
      z.object({
        platform,
        identifier: z.string().trim().min(1).max(255),
        storeAppId: z.string().trim().min(1).max(255).optional(),
        name: z.string().trim().max(100).optional(),
        repositoryId: id.optional(),
      }),
    )
    .min(1)
    .max(50),
});
const connectBody = z.object({
  credentialId: id,
  owner: z.string().trim().describe('A GitHub user or organization name.'),
  repo: z.string().trim().max(100).describe('A GitHub repository name.'),
});
const targetBody = z.object({
  name: z.string().max(200),
  appId: z.string().max(400).nullable().optional(),
  appStoreRoot: z.string().max(400).nullable().optional(),
  googlePlayRoot: z.string().max(400).nullable().optional(),
});
const changeSetBody = z.object({
  target: z.string().min(1).max(200).optional().describe('A saved listing target id, or `auto:<key>`.'),
  roots: z.object({ appStore: z.string().max(400).optional(), googlePlay: z.string().max(400).optional() }).strict().optional(),
  summary: z.string().trim().min(1).max(200),
  listing: z.record(z.unknown()).describe('The store listing to write: `{ appStore?: {...}, googlePlay?: {...} }`. See docs/api/repositories.md.'),
});

const listingQuery = z.object({
  target: z.string().max(200).optional(),
  appStoreRoot: z.string().max(400).optional(),
  googlePlayRoot: z.string().max(400).optional(),
});

const W = '/api/workspaces/{workspaceId}';
type Draft = Omit<Operation, 'tags'> & { tags?: string[] };

const drafts: Draft[] = [
  // ----- system and auth ------------------------------------------------------------------------
  {
    id: 'getHealth', method: 'get', path: '/api/health', tags: ['system'], summary: 'Health of the server and its database', risk: 'read', access: 'public',
    responses: { '200': { description: 'Healthy. `503` with `status: degraded` when the database does not answer.', schema: z.object({ status: z.string(), version: z.string(), database: z.object({ dialect: z.string(), ok: z.boolean() }) }) } },
  },
  {
    id: 'getAuthStatus', method: 'get', path: '/api/auth/status', tags: ['auth'], summary: 'Whether setup is needed and who is signed in', risk: 'read', access: 'public',
    responses: { '200': { description: 'The mode, whether first-run setup is open, and the signed-in user or null.', schema: z.object({ mode: z.enum(['multi', 'single_user']), setupRequired: z.boolean(), user: userSchema.nullable() }) } },
  },
  {
    id: 'register', method: 'post', path: '/api/auth/register', tags: ['auth'], summary: 'Create the first account and workspace', description: 'Only on an empty instance; later it answers `403 registration_closed`. Sets the session cookie.', risk: 'write', access: 'public', body: registerBody, bodyLimit: 256 * 1024,
    responses: { '201': { description: 'The owner and the new workspace.', schema: z.object({ user: userSchema, workspaceId: z.string() }) } },
  },
  {
    id: 'login', method: 'post', path: '/api/auth/login', tags: ['auth'], summary: 'Sign in with email and password', description: 'Sets the session cookie. Rate limited per email address and per client address (`429 too_many_attempts`).', risk: 'write', access: 'public', body: loginBody, bodyLimit: 256 * 1024, rateLimited: true,
    responses: { '200': { description: 'The signed-in user.', schema: z.object({ user: userSchema }) } },
  },
  { id: 'logout', method: 'post', path: '/api/auth/logout', tags: ['auth'], summary: 'End the session', risk: 'write', access: 'public', responses: { '204': none } },
  {
    id: 'getMe', method: 'get', path: '/api/me', tags: ['auth'], summary: 'The signed-in user and their workspaces', description: 'Session cookie only: an API token is limited to one workspace and has no identity of its own here.', risk: 'read', access: 'user',
    responses: { '200': { description: 'The user and each workspace with their role.', schema: z.object({ user: userSchema, workspaces: z.array(z.object({ id: z.string(), name: z.string(), role: z.enum(roles) })) }) } },
  },
  {
    id: 'getOpenApi', method: 'get', path: '/api/openapi.json', tags: ['system'], summary: 'This document', description: 'The OpenAPI 3.1 description of the API. For signed-in users and API tokens only.', risk: 'read', access: 'user', token: true,
    responses: { '200': { description: 'The OpenAPI document.', schema: object } },
  },

  // ----- credentials and audit ------------------------------------------------------------------
  { id: 'listCredentials', method: 'get', path: `${W}/credentials`, tags: ['credentials'], summary: 'List credentials (metadata only)', risk: 'read', access: { action: 'credentials.read' }, responses: { '200': { description: 'Credentials without their secrets.', schema: z.object({ credentials: z.array(credentialSchema) }) } } },
  { id: 'createCredential', method: 'post', path: `${W}/credentials`, tags: ['credentials'], summary: 'Store a credential', risk: 'write', access: { action: 'credentials.write' }, body: credentialBody, responses: { '201': { description: 'The credential, without its secret.', schema: z.object({ credential: credentialSchema }) } } },
  { id: 'testCredentialSecret', method: 'post', path: `${W}/credentials/test`, tags: ['credentials'], summary: 'Test a secret that is not saved', risk: 'read', access: { action: 'credentials.write' }, body: testBody, rateLimited: true, responses: { '200': { description: 'The outcome of the test.', schema: testOutcome } } },
  { id: 'rotateCredential', method: 'put', path: `${W}/credentials/{id}`, tags: ['credentials'], summary: 'Replace the secret of a credential', risk: 'write', access: { action: 'credentials.write' }, body: rotateBody, responses: { '204': none } },
  { id: 'deleteCredential', method: 'delete', path: `${W}/credentials/{id}`, tags: ['credentials'], summary: 'Delete a credential', risk: 'destructive', access: { action: 'credentials.write' }, responses: { '204': none } },
  { id: 'testCredential', method: 'post', path: `${W}/credentials/{id}/test`, tags: ['credentials'], summary: 'Test a saved credential and remember the result', risk: 'read', access: { action: 'credentials.write' }, rateLimited: true, responses: { '200': { description: 'The outcome of the test.', schema: testOutcome } } },
  {
    id: 'listAudit', method: 'get', path: `${W}/audit`, tags: ['workspaces'], summary: 'The audit log, newest first', description: 'Every write is recorded with its actor. `actorType` is `user`, `token`, `assistant` or `system`; for a token, `actorId` is the token id and `actorName` its name.', risk: 'read', access: { action: 'audit.read' },
    query: z.object({ limit: z.number().int().min(1).max(500).optional() }),
    responses: { '200': { description: 'Audit events.', schema: z.object({ events: z.array(z.object({ id: z.string(), actorType: z.string(), actorId: z.string(), actorName: z.string().nullable(), action: z.string(), targetType: z.string().nullable(), targetId: z.string().nullable(), detail: object.nullable(), at: timestamp })) }) } },
  },

  // ----- members and invitations ----------------------------------------------------------------
  { id: 'listMembers', method: 'get', path: `${W}/members`, tags: ['members'], summary: 'List members', risk: 'read', access: { action: 'members.read' }, responses: { '200': { description: 'Members.', schema: z.object({ members: z.array(memberSchema) }) } } },
  { id: 'changeMemberRole', method: 'patch', path: `${W}/members/{userId}`, tags: ['members'], summary: 'Change a member’s role', risk: 'write', access: { action: 'members.manage' }, body: roleBody, responses: { '204': none } },
  { id: 'removeMember', method: 'delete', path: `${W}/members/{userId}`, tags: ['members'], summary: 'Remove a member, or leave the workspace', description: 'Any member may call this on themselves; removing someone else needs `members.manage`.', risk: 'destructive', access: 'member', responses: { '204': none } },
  { id: 'listInvitations', method: 'get', path: `${W}/invitations`, tags: ['invitations'], summary: 'List pending invitations', risk: 'read', access: { action: 'members.manage' }, responses: { '200': { description: 'Pending invitations.', schema: z.object({ invitations: z.array(invitationSchema) }) } } },
  { id: 'createInvitation', method: 'post', path: `${W}/invitations`, tags: ['invitations'], summary: 'Create an invitation link', description: 'The one-time `token` is in this response only.', risk: 'write', access: { action: 'members.manage' }, body: inviteBody, responses: { '201': { description: 'The invitation and its one-time token.', schema: z.object({ invitation: invitationSchema, token: z.string() }) } } },
  { id: 'revokeInvitation', method: 'delete', path: `${W}/invitations/{id}`, tags: ['invitations'], summary: 'Revoke an invitation', risk: 'destructive', access: { action: 'members.manage' }, responses: { '204': none } },
  { id: 'previewInvitation', method: 'get', path: '/api/invitations/{token}', tags: ['invitations'], summary: 'What an invitation link is for', description: 'Public. An unknown, used, expired or revoked token is `404`.', risk: 'read', access: 'public', responses: { '200': { description: 'The workspace name, email and role.', schema: z.object({ workspaceName: z.string(), email: z.string(), role: z.enum(invitableRoles), valid: z.literal(true) }) } } },
  { id: 'acceptInvitation', method: 'post', path: '/api/invitations/{token}/accept', tags: ['invitations'], summary: 'Accept an invitation', description: 'Public. Signed in with the matching email, or a new account with `displayName` and `password`.', risk: 'write', access: 'public', body: acceptBody, bodyLimit: 256 * 1024, responses: { '201': { description: 'The member.', schema: z.object({ user: userSchema, workspaceId: z.string(), role: z.enum(roles) }) } } },

  // ----- repositories and change sets -----------------------------------------------------------
  { id: 'listRepositories', method: 'get', path: `${W}/repositories`, tags: ['repositories'], summary: 'List connected repositories', risk: 'read', access: { action: 'repositories.read' }, partial: true, responses: { '200': { description: 'Repositories.', schema: z.object({ repositories: z.array(object) }) } } },
  { id: 'connectRepository', method: 'post', path: `${W}/repositories`, tags: ['repositories'], summary: 'Connect a GitHub repository', risk: 'write', access: { action: 'repositories.write' }, body: connectBody, partial: true, responses: { '201': { description: 'The repository.', schema: z.object({ repository: object }) } } },
  { id: 'getRepository', method: 'get', path: `${W}/repositories/{id}`, tags: ['repositories'], summary: 'A repository and what was detected in it', risk: 'read', access: { action: 'repositories.read' }, partial: true, responses: { '200': { description: 'The repository and its detection.', schema: object } } },
  { id: 'disconnectRepository', method: 'delete', path: `${W}/repositories/{id}`, tags: ['repositories'], summary: 'Disconnect a repository', risk: 'destructive', access: { action: 'repositories.write' }, responses: { '204': none } },
  { id: 'scanRepository', method: 'post', path: `${W}/repositories/{id}/scan`, tags: ['repositories'], summary: 'Scan a repository and store what is detected', risk: 'write', access: { action: 'repositories.scan' }, partial: true, responses: { '200': { description: 'The repository and its detection.', schema: object } } },
  { id: 'getRepositoryListing', method: 'get', path: `${W}/repositories/{id}/listing`, tags: ['repositories'], summary: 'The store listing found in the repository', risk: 'read', access: { action: 'repositories.scan' }, query: listingQuery, partial: true, responses: { '200': { description: 'The listing and its problems.', schema: object } } },
  { id: 'listListingTargets', method: 'get', path: `${W}/repositories/{id}/listing-targets`, tags: ['repositories'], summary: 'Saved listing targets of a repository', risk: 'read', access: { action: 'repositories.read' }, partial: true, responses: { '200': { description: 'Targets.', schema: z.object({ targets: z.array(object) }) } } },
  { id: 'createListingTarget', method: 'post', path: `${W}/repositories/{id}/listing-targets`, tags: ['repositories'], summary: 'Save a listing target', risk: 'write', access: { action: 'repositories.write' }, body: targetBody, partial: true, responses: { '201': { description: 'The target.', schema: z.object({ target: object }) } } },
  { id: 'updateListingTarget', method: 'patch', path: `${W}/repositories/{id}/listing-targets/{targetId}`, tags: ['repositories'], summary: 'Change a listing target', risk: 'write', access: { action: 'repositories.write' }, body: targetBody.partial(), partial: true, responses: { '200': { description: 'The target.', schema: z.object({ target: object }) } } },
  { id: 'deleteListingTarget', method: 'delete', path: `${W}/repositories/{id}/listing-targets/{targetId}`, tags: ['repositories'], summary: 'Delete a listing target', risk: 'destructive', access: { action: 'repositories.write' }, responses: { '204': none } },
  { id: 'createChangeSet', method: 'post', path: `${W}/repositories/{id}/change-sets`, tags: ['change-sets'], summary: 'Draft a change set from a listing', description: 'Writes nothing to the repository: a person with approval rights approves it, then it is applied as a pull request.', risk: 'write', access: { action: 'changesets.write' }, body: changeSetBody, partial: true, responses: { '201': { description: 'The draft, its problems and warnings.', schema: z.object({ changeSet: changeSetSchema, problems: z.array(object), warnings: z.array(z.string()).optional() }) } } },
  { id: 'listChangeSets', method: 'get', path: `${W}/change-sets`, tags: ['change-sets'], summary: 'List change sets', risk: 'read', access: { action: 'repositories.read' }, query: z.object({ repositoryId: z.string().optional(), status: z.string().optional() }), responses: { '200': { description: 'Change sets.', schema: z.object({ changeSets: z.array(changeSetSchema) }) } } },
  { id: 'getChangeSet', method: 'get', path: `${W}/change-sets/{id}`, tags: ['change-sets'], summary: 'A change set with its file contents', risk: 'read', access: { action: 'repositories.read' }, responses: { '200': changeSetAnswer } },
  { id: 'approveChangeSet', method: 'post', path: `${W}/change-sets/{id}/approve`, tags: ['change-sets'], summary: 'Approve a draft change set', risk: 'write', access: { action: 'changesets.approve' }, responses: { '200': changeSetAnswer } },
  { id: 'applyChangeSet', method: 'post', path: `${W}/change-sets/{id}/apply`, tags: ['change-sets'], summary: 'Apply an approved change set (opens a pull request)', risk: 'write', access: { action: 'changesets.approve' }, responses: { '200': { description: 'The applied change set.', schema: z.object({ changeSet: changeSetSchema, alreadyApplied: z.boolean().optional() }) } } },
  { id: 'discardChangeSet', method: 'post', path: `${W}/change-sets/{id}/discard`, tags: ['change-sets'], summary: 'Discard a change set', risk: 'destructive', access: { action: 'changesets.write' }, responses: { '200': changeSetAnswer } },

  // ----- apps -----------------------------------------------------------------------------------
  { id: 'listApps', method: 'get', path: `${W}/apps`, tags: ['apps'], summary: 'List apps', description: 'A token restricted to some apps sees only those.', risk: 'read', access: { action: 'apps.read' }, appScope: { kind: 'list' }, responses: { '200': { description: 'Apps.', schema: z.object({ apps: z.array(appSchema) }) } } },
  { id: 'createApp', method: 'post', path: `${W}/apps`, tags: ['apps'], summary: 'Add an app', risk: 'write', access: { action: 'apps.write' }, body: appBody, responses: { '201': { description: 'The app.', schema: z.object({ app: appSchema }) } } },
  { id: 'discoverApps', method: 'post', path: `${W}/apps/discover`, tags: ['apps'], summary: 'Find the apps behind a credential', description: 'Reads the store. Shares the per-workspace sync budget.', risk: 'read', access: { action: 'apps.write' }, body: discoverBody, bodyLimit: 16 * 1024, rateLimited: true, partial: true, responses: { '200': { description: 'Candidates and failures.', schema: object } } },
  { id: 'importApps', method: 'post', path: `${W}/apps/import`, tags: ['apps'], summary: 'Add several apps at once', risk: 'write', access: { action: 'apps.write' }, body: importBody, bodyLimit: 32 * 1024, partial: true, responses: { '200': { description: 'A result per item and a summary.', schema: z.object({ results: z.array(object), summary: z.object({ created: z.number().int(), skipped: z.number().int(), failed: z.number().int() }) }) } } },
  { id: 'getApp', method: 'get', path: `${W}/apps/{id}`, tags: ['apps'], summary: 'An app and its stored releases', risk: 'read', access: { action: 'apps.read' }, appScope: { kind: 'param', name: 'id' }, responses: { '200': { description: 'The app and its releases.', schema: z.object({ app: appSchema, releases: z.array(releaseSchema) }) } } },
  { id: 'deleteApp', method: 'delete', path: `${W}/apps/{id}`, tags: ['apps'], summary: 'Remove an app', risk: 'destructive', access: { action: 'apps.write' }, appScope: { kind: 'param', name: 'id' }, responses: { '204': none } },
  { id: 'syncApp', method: 'post', path: `${W}/apps/{id}/sync`, tags: ['apps'], summary: 'Read the store and replace the stored snapshot', description: 'Read-only toward the store. `?background=true` queues it as a job and answers `202` with `jobId`. Rate limited per workspace.', risk: 'write', access: { action: 'apps.sync' }, appScope: { kind: 'param', name: 'id' }, rateLimited: true, query: z.object({ background: z.enum(['true']).optional() }), responses: { '200': { description: 'The app, its releases and what the sync changed.', schema: z.object({ app: appSchema, releases: z.array(releaseSchema), sync: z.object({ at: timestamp, found: z.number().int(), added: z.number().int(), updated: z.number().int(), removed: z.number().int(), unmapped: z.number().int() }) }) }, '202': { description: 'Queued (with `?background=true`).', schema: z.object({ jobId: z.string() }) } } },

  // ----- tokens ---------------------------------------------------------------------------------
  { id: 'listTokens', method: 'get', path: `${W}/tokens`, tags: ['tokens'], summary: 'List API tokens', description: 'Metadata only: the token itself is shown once, when it is made.', risk: 'read', access: { action: 'tokens.read' }, responses: { '200': { description: 'Tokens, newest first.', schema: z.object({ tokens: z.array(tokenSummarySchema) }) } } },
  { id: 'createToken', method: 'post', path: `${W}/tokens`, tags: ['tokens'], summary: 'Create an API token', description: 'The `token` is in this response and nowhere else, ever. The role cannot be above your own, and never `owner`.', risk: 'write', access: { action: 'tokens.manage' }, body: createTokenBody, bodyLimit: 16 * 1024, responses: { '201': { description: 'The token (shown once) and its metadata.', schema: z.object({ token: z.string(), summary: tokenSummarySchema }) } } },
  { id: 'revokeToken', method: 'delete', path: `${W}/tokens/{id}`, tags: ['tokens'], summary: 'Revoke an API token', description: 'Takes effect at once. Revoking twice is fine.', risk: 'destructive', access: { action: 'tokens.manage' }, responses: { '204': none } },

  // ----- events ---------------------------------------------------------------------------------
  { id: 'listEvents', method: 'get', path: `${W}/events`, tags: ['events'], summary: 'Events, oldest first from a cursor', description: 'With `since`: events after that id, up to `limit`; `hasMore` says to ask again with `nextCursor`. Without it: the newest `limit` events. Only events about things the role may read are returned; an app restricted token sees only events about its apps.', risk: 'read', access: { action: 'events.read' }, appScope: { kind: 'events' }, query: z.object({ since: z.number().int().min(0).optional().describe('Return events with an id above this.'), limit: z.number().int().min(1).max(200).optional(), type: z.string().optional().describe('Comma separated event types to keep.') }), responses: { '200': { description: 'A page of events.', schema: z.object({ events: z.array(eventSchema), hasMore: z.boolean(), nextCursor: z.number().int() }) } } },
  { id: 'streamEvents', method: 'get', path: `${W}/events/stream`, tags: ['events'], summary: 'Server-sent events: the live event stream', description: 'Each event is an SSE message with `id` (the event id), `event` (the type) and `data` (the event as JSON). A comment heartbeat is sent every 15 seconds. Reconnect with `Last-Event-ID` (or `?since=`) to resume. At most 5 open streams per person.', risk: 'read', access: { action: 'events.read' }, appScope: { kind: 'events' }, query: z.object({ since: z.number().int().min(0).optional(), type: z.string().optional() }), responses: { '200': { description: 'An event stream.', contentType: 'text/event-stream' } } },

  // ----- webhooks -------------------------------------------------------------------------------
  { id: 'listWebhooks', method: 'get', path: `${W}/webhooks`, tags: ['webhooks'], summary: 'List webhook endpoints', risk: 'read', access: { action: 'webhooks.read' }, responses: { '200': { description: 'Endpoints (never their secrets).', schema: z.object({ webhooks: z.array(webhookSchema) }) } } },
  { id: 'createWebhook', method: 'post', path: `${W}/webhooks`, tags: ['webhooks'], summary: 'Add a webhook endpoint', description: 'The signing `secret` is in this response only. https URLs to public addresses only.', risk: 'write', access: { action: 'webhooks.manage' }, body: createWebhookBody, bodyLimit: 16 * 1024, responses: { '201': { description: 'The endpoint and its secret (shown once).', schema: z.object({ webhook: webhookSchema, secret: z.string() }) } } },
  { id: 'getWebhook', method: 'get', path: `${W}/webhooks/{id}`, tags: ['webhooks'], summary: 'A webhook endpoint', risk: 'read', access: { action: 'webhooks.read' }, responses: { '200': { description: 'The endpoint.', schema: z.object({ webhook: webhookSchema }) } } },
  { id: 'updateWebhook', method: 'patch', path: `${W}/webhooks/{id}`, tags: ['webhooks'], summary: 'Change a webhook endpoint', risk: 'write', access: { action: 'webhooks.manage' }, body: updateWebhookBody, bodyLimit: 16 * 1024, responses: { '200': { description: 'The endpoint.', schema: z.object({ webhook: webhookSchema }) } } },
  { id: 'deleteWebhook', method: 'delete', path: `${W}/webhooks/{id}`, tags: ['webhooks'], summary: 'Delete a webhook endpoint and its delivery log', risk: 'destructive', access: { action: 'webhooks.manage' }, responses: { '204': none } },
  { id: 'rotateWebhookSecret', method: 'post', path: `${W}/webhooks/{id}/rotate-secret`, tags: ['webhooks'], summary: 'Make a new signing secret', description: 'The old secret stops working at once. The new one is in this response only.', risk: 'write', access: { action: 'webhooks.manage' }, responses: { '200': { description: 'The new secret.', schema: z.object({ secret: z.string() }) } } },
  { id: 'testWebhook', method: 'post', path: `${W}/webhooks/{id}/test`, tags: ['webhooks'], summary: 'Send a test event', description: 'Queues a `webhook.test` delivery through the normal path. Rate limited per workspace.', risk: 'write', access: { action: 'webhooks.manage' }, rateLimited: true, responses: { '202': { description: 'Queued.', schema: z.object({ deliveryId: z.string() }) } } },
  { id: 'listWebhookDeliveries', method: 'get', path: `${W}/webhooks/{id}/deliveries`, tags: ['webhooks'], summary: 'Recent deliveries of an endpoint', risk: 'read', access: { action: 'webhooks.read' }, query: z.object({ limit: z.number().int().min(1).max(100).optional() }), responses: { '200': { description: 'Deliveries, newest first.', schema: z.object({ deliveries: z.array(deliverySchema) }) } } },
  { id: 'redeliverWebhook', method: 'post', path: `${W}/webhooks/{id}/deliveries/{deliveryId}/redeliver`, tags: ['webhooks'], summary: 'Send a delivery again', description: 'A new delivery with the same body. Rate limited per workspace.', risk: 'write', access: { action: 'webhooks.manage' }, rateLimited: true, responses: { '202': { description: 'Queued.', schema: z.object({ deliveryId: z.string() }) } } },

  // ----- plans and checklist templates ----------------------------------------------------------
  // Described in part: the plan shape is still moving. Permissions are exact.
  { id: 'listPlans', method: 'get', path: `${W}/plans`, tags: ['plans'], summary: 'List release plans of the workspace', risk: 'read', access: { action: 'plans.read' }, partial: true, responses: { '200': { description: 'Plans.', schema: z.object({ plans: z.array(object) }) } } },
  { id: 'listAppPlans', method: 'get', path: `${W}/apps/{id}/plans`, tags: ['plans'], summary: 'List the release plans of an app', risk: 'read', access: { action: 'plans.read' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'Plans.', schema: z.object({ plans: z.array(object) }) } } },
  { id: 'createPlan', method: 'post', path: `${W}/apps/{id}/plans`, tags: ['plans'], summary: 'Create a release plan', risk: 'write', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, body: object, partial: true, responses: { '201': { description: 'The plan.', schema: z.object({ plan: object }) } } },
  { id: 'getPlan', method: 'get', path: `${W}/apps/{id}/plans/{planId}`, tags: ['plans'], summary: 'A release plan with its items', risk: 'read', access: { action: 'plans.read' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'The plan.', schema: z.object({ plan: object }) } } },
  { id: 'updatePlan', method: 'patch', path: `${W}/apps/{id}/plans/{planId}`, tags: ['plans'], summary: 'Change a release plan', risk: 'write', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, body: object, partial: true, responses: { '200': { description: 'The plan.', schema: z.object({ plan: object }) } } },
  { id: 'deletePlan', method: 'delete', path: `${W}/apps/{id}/plans/{planId}`, tags: ['plans'], summary: 'Delete a release plan', risk: 'destructive', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, responses: { '204': none } },
  { id: 'addPlanItem', method: 'post', path: `${W}/apps/{id}/plans/{planId}/items`, tags: ['plans'], summary: 'Add an item to a release plan', risk: 'write', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, body: object, partial: true, responses: { '201': { description: 'The plan and the new item id.', schema: z.object({ plan: object, itemId: z.string() }) } } },
  { id: 'orderPlanItems', method: 'put', path: `${W}/apps/{id}/plans/{planId}/items/order`, tags: ['plans'], summary: 'Set the order of the items of a plan', risk: 'write', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, body: object, partial: true, responses: { '200': { description: 'The plan.', schema: z.object({ plan: object }) } } },
  { id: 'updatePlanItem', method: 'patch', path: `${W}/apps/{id}/plans/{planId}/items/{itemId}`, tags: ['plans'], summary: 'Change an item of a plan', risk: 'write', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, body: object, partial: true, responses: { '200': { description: 'The plan.', schema: z.object({ plan: object }) } } },
  { id: 'deletePlanItem', method: 'delete', path: `${W}/apps/{id}/plans/{planId}/items/{itemId}`, tags: ['plans'], summary: 'Remove an item from a plan', risk: 'destructive', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'The plan.', schema: z.object({ plan: object }) } } },
  { id: 'applyPlanTemplate', method: 'post', path: `${W}/apps/{id}/plans/{planId}/apply-template`, tags: ['plans'], summary: 'Add the items of a checklist template to a plan', risk: 'write', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, body: object, partial: true, responses: { '200': { description: 'The plan.', schema: z.object({ plan: object }) } } },
  { id: 'setPlanNotes', method: 'put', path: `${W}/apps/{id}/plans/{planId}/notes/{locale}`, tags: ['plans'], summary: 'Set the release notes of one locale', risk: 'write', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, body: object, partial: true, responses: { '200': { description: 'The plan.', schema: z.object({ plan: object }) } } },
  { id: 'deletePlanNotes', method: 'delete', path: `${W}/apps/{id}/plans/{planId}/notes/{locale}`, tags: ['plans'], summary: 'Remove the release notes of one locale', risk: 'destructive', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'The plan.', schema: z.object({ plan: object }) } } },
  { id: 'listChecklistTemplates', method: 'get', path: `${W}/checklist-templates`, tags: ['plans'], summary: 'List checklist templates', risk: 'read', access: { action: 'plans.read' }, partial: true, responses: { '200': { description: 'Templates.', schema: z.object({ templates: z.array(object) }) } } },
  { id: 'createChecklistTemplate', method: 'post', path: `${W}/checklist-templates`, tags: ['plans'], summary: 'Create a checklist template', risk: 'write', access: { action: 'plans.write' }, body: object, partial: true, responses: { '201': { description: 'The template.', schema: z.object({ template: object }) } } },
  { id: 'updateChecklistTemplate', method: 'patch', path: `${W}/checklist-templates/{templateId}`, tags: ['plans'], summary: 'Change a checklist template', risk: 'write', access: { action: 'plans.write' }, body: object, partial: true, responses: { '200': { description: 'The template.', schema: z.object({ template: object }) } } },
  { id: 'deleteChecklistTemplate', method: 'delete', path: `${W}/checklist-templates/{templateId}`, tags: ['plans'], summary: 'Delete a checklist template', risk: 'destructive', access: { action: 'plans.write' }, responses: { '204': none } },

  // ----- store listing: live, drift, history ----------------------------------------------------
  { id: 'getLiveListing', method: 'get', path: `${W}/apps/{id}/listing/live`, tags: ['listing'], summary: 'The listing as the store has it (from the last sync)', description: 'Reads the database. Nothing is sent to a store.', risk: 'read', access: { action: 'listing.read' }, appScope: { kind: 'param', name: 'id' }, query: listingQuery, partial: true, responses: { '200': { description: 'The live listing.', schema: object } } },
  { id: 'getListingDrift', method: 'get', path: `${W}/apps/{id}/listing/drift`, tags: ['listing'], summary: 'How the live listing differs from the repository', risk: 'read', access: { action: 'listing.read' }, appScope: { kind: 'param', name: 'id' }, query: listingQuery, partial: true, responses: { '200': { description: 'The differences.', schema: object } } },
  { id: 'getListingHistory', method: 'get', path: `${W}/apps/{id}/listing/history`, tags: ['listing'], summary: 'How a listing field changed between syncs', risk: 'read', access: { action: 'listing.read' }, appScope: { kind: 'param', name: 'id' }, query: z.object({ locale: z.string().optional(), field: z.string().optional(), limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional() }), partial: true, responses: { '200': { description: 'Changes, newest first.', schema: object } } },
  { id: 'refreshListingFromRepo', method: 'post', path: `${W}/apps/{id}/listing/repo-refresh`, tags: ['listing'], summary: 'Read the listing from the connected repository again', description: 'Reads GitHub; writes only to this server’s database.', risk: 'write', access: { action: 'repositories.scan' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'The refreshed listing.', schema: object } } },

  // ----- CI workflows and builds ----------------------------------------------------------------
  { id: 'listWorkflows', method: 'get', path: `${W}/repositories/{id}/workflows`, tags: ['ci'], summary: 'GitHub Actions workflows of a repository', risk: 'read', access: { action: 'repositories.scan' }, partial: true, responses: { '200': { description: 'Workflows.', schema: object } } },
  { id: 'listWorkflowRuns', method: 'get', path: `${W}/repositories/{id}/workflows/runs`, tags: ['ci'], summary: 'Recent workflow runs', risk: 'read', access: { action: 'repositories.read' }, query: z.object({ limit: z.number().int().min(1).max(100).optional(), workflow: z.string().optional(), branch: z.string().optional(), refresh: z.enum(['true']).optional(), active: z.enum(['true']).optional(), appId: z.string().optional() }), partial: true, responses: { '200': { description: 'Runs.', schema: object } } },
  { id: 'getWorkflowRun', method: 'get', path: `${W}/repositories/{id}/workflows/runs/{runId}`, tags: ['ci'], summary: 'A workflow run', risk: 'read', access: { action: 'repositories.read' }, query: z.object({ refresh: z.enum(['true']).optional() }), partial: true, responses: { '200': { description: 'The run.', schema: object } } },
  { id: 'getWorkflowInputs', method: 'get', path: `${W}/repositories/{id}/workflows/{workflow}/inputs`, tags: ['ci'], summary: 'The inputs a workflow accepts', risk: 'read', access: { action: 'repositories.scan' }, query: z.object({ ref: z.string().optional() }), partial: true, responses: { '200': { description: 'The inputs.', schema: object } } },
  { id: 'dispatchWorkflow', method: 'post', path: `${W}/repositories/{id}/workflows/{workflow}/dispatches`, tags: ['ci'], summary: 'Start a workflow run', description: 'Runs a workflow on GitHub. It can ship a build: assistants should ask a person first.', risk: 'write', access: { action: 'ci.dispatch' }, body: object, partial: true, responses: { '202': { description: 'The dispatch was accepted.', schema: z.object({ dispatched: z.boolean(), runKnown: z.boolean(), run: object.nullable() }) } } },
  { id: 'listBuilds', method: 'get', path: `${W}/apps/{id}/builds`, tags: ['ci'], summary: 'Builds of an app and the runs linked to them', risk: 'read', access: { action: 'apps.read' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'Builds.', schema: object } } },
  { id: 'getBuildChanges', method: 'get', path: `${W}/apps/{id}/builds/changes`, tags: ['ci'], summary: 'Commits between two builds', risk: 'read', access: { action: 'repositories.scan' }, appScope: { kind: 'param', name: 'id' }, query: z.object({ platform: z.enum(['ios', 'android']), build: z.string(), base: z.string().optional() }), partial: true, responses: { '200': { description: 'The changes.', schema: object } } },
  { id: 'linkBuild', method: 'put', path: `${W}/apps/{id}/builds/{platform}/{buildNumber}/link`, tags: ['ci'], summary: 'Link a build to a workflow run', risk: 'write', access: { action: 'apps.sync' }, appScope: { kind: 'param', name: 'id' }, body: object, partial: true, responses: { '200': { description: 'The build.', schema: z.object({ build: object }) } } },
  { id: 'unlinkBuild', method: 'delete', path: `${W}/apps/{id}/builds/{platform}/{buildNumber}/link`, tags: ['ci'], summary: 'Remove the link of a build', risk: 'destructive', access: { action: 'apps.sync' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'The build.', schema: z.object({ build: object }) } } },
];

export const operations: readonly Operation[] = drafts.map((d) => ({ ...d, tags: d.tags ?? [] }));
