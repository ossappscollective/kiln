import {
  credentialKinds,
  invitableRoles,
  PLATFORMS,
  roles,
  translationModes,
  translationProviders,
} from '@kiln/core';
import { z } from 'zod';
import { eventTypes } from '../services/event-types.ts';
import { createTokenBody } from '../services/tokens.ts';
import { createWebhookBody, updateWebhookBody } from '../services/webhooks.ts';
import { type Draft, id, none, object, platform, timestamp, translationLang, W } from './shared.ts';

export const eventSchema = z.object({
  id: z.number().int().describe('Increases with every event. Use it as the `since` cursor.'),
  type: z.enum(eventTypes),
  workspaceId: z.string(),
  subject: z.object({
    appId: z.string().optional(),
    repositoryId: z.string().optional(),
    releaseId: z.string().optional(),
  }),
  payload: z.record(z.unknown()).describe('Plain JSON. Never holds a secret.'),
  createdAt: timestamp,
});

export const tokenSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z
    .string()
    .describe('`kiln_` and six more characters, to recognise the token. Not enough to use it.'),
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
  lastDelivery: z
    .object({ status: z.string(), at: timestamp, responseCode: z.number().int().nullable() })
    .nullable(),
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

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  locale: z
    .enum(['en', 'fr', 'es', 'de'])
    .nullable()
    .describe(
      'The language of emails sent without a request (alerts, the digest), or null for none (English). Set with `PATCH /api/me`.',
    ),
});

const credentialSchema = z.object({
  id: z.string(),
  kind: z.enum(credentialKinds),
  label: z.string(),
  createdAt: timestamp,
  rotatedAt: timestamp.nullable(),
  lastTest: z.object({ at: timestamp, ok: z.boolean(), message: z.string() }).nullable(),
  identifiers: z.array(
    z.object({ key: z.string(), label: z.string(), value: z.string(), copyable: z.boolean() }),
  ),
});

const memberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: z.enum(roles),
});

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
  platform: z.enum(PLATFORMS),
  identifier: z.string(),
  storeAppId: z.string().nullable(),
  credentialId: z.string(),
  repositoryId: z.string().nullable(),
  createdAt: timestamp,
  lastSyncedAt: timestamp.nullable(),
  lastSyncAttemptAt: timestamp.nullable(),
  lastSyncError: z.string().nullable(),
  lastSyncErrorCode: z
    .string()
    .nullable()
    .describe(
      'The stable code (dot.case) of `lastSyncError`, for translation. Null for a note written before codes existed or a failure with no code.',
    ),
  lastSyncErrorParams: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .nullable()
    .describe(
      'What the sentence of `lastSyncErrorCode` needs (a store name, a number). Never a secret.',
    ),
  hasIcon: z
    .boolean()
    .describe(
      'Whether the tool holds an icon for the app right now. A hint: `GET /apps/{id}/icon` is the truth.',
    ),
  iconUrl: z
    .string()
    .nullable()
    .describe(
      'Where to load the icon from (ends in `?v=<etag>` when one is held), or null when the last look found none and the next one is not due.',
    ),
});

const releaseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  platform: z.enum(PLATFORMS),
  version: z.string(),
  track: z.string().nullable(),
  build: z.string().nullable(),
  status: z
    .string()
    .nullable()
    .describe('The normalized lifecycle state, or null when the store state is not mapped.'),
  rawState: z.string(),
  rolloutFraction: z.number().nullable(),
  versionCodes: z.array(z.string()).nullable(),
  storeUpdatedAt: timestamp.nullable(),
  statusSince: timestamp
    .nullable()
    .describe('When this server first saw the release in its current state.'),
  sentForReviewAt: timestamp
    .nullable()
    .optional()
    .describe(
      'Google Play: when this server sent the release to Google (in the last 7 days). Google Play does not report the review state through its API, so a release read as live may still be in review.',
    ),
  syncedAt: timestamp,
});

const testOutcome = z.object({
  ok: z.boolean(),
  message: z.string(),
  details: z.array(z.string()).optional(),
  superseded: z.boolean().optional(),
});

// ----- request bodies that mirror their route files ---------------------------------------------

const registerBody = z.object({
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(200),
  workspaceName: z.string().trim().min(1).max(100),
});

const loginBody = z.object({ email: z.string().max(254), password: z.string().max(200) });

const secretText = z
  .string()
  .min(1)
  .max(64 * 1024)
  .describe('Write only: never returned.');

const credentialBody = z.object({
  kind: z.enum(credentialKinds),
  label: z.string().trim().min(1).max(100),
  secret: secretText,
});

const rotateBody = z.object({ secret: secretText });

const testBody = z.object({ kind: z.enum(credentialKinds), secret: secretText });

const roleBody = z.object({ role: z.enum(roles) });

const inviteBody = z.object({
  email: z.string().trim().email().max(254),
  role: z.enum(invitableRoles),
});

const acceptBody = z.object({
  displayName: z.string().trim().max(100).optional(),
  password: z.string().max(200).optional(),
});

const appBody = z.object({
  platform,
  identifier: z.string().trim().min(1).max(255),
  credentialId: id,
  name: z.string().trim().min(1).max(100).optional(),
  repositoryId: id.optional(),
});

const discoverBody = z.object({
  credentialId: id,
  packages: z
    .array(z.string().trim().min(1).max(255))
    .min(1)
    .max(50)
    .optional()
    .describe('Google Play only: package names to verify.'),
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

const settingValueSchema = z.union([z.number(), z.boolean(), z.string()]);

const settingsBody = z.object({
  'reviews.lowRatingThreshold': z
    .number()
    .int()
    .min(1)
    .max(4)
    .nullable()
    .optional()
    .describe(
      'Ratings at or below this raise `review.new_low_rating`. Default 2. Raising it never re-sends events for reviews already read.',
    ),
  'aso.rankMoveThreshold': z
    .number()
    .int()
    .min(1)
    .max(100)
    .nullable()
    .optional()
    .describe(
      'A keyword that moves this many places or more between two checks raises `aso.rank_changed`. Default 5. Entering or leaving the results raises it only within the top 10.',
    ),
  'translation.enabled': z.boolean().nullable().optional().describe('Default false.'),
  'prices.writeEnabled': z.boolean().nullable().optional().describe('Default false. Allows price changes of in-app products to be staged and sent; the server switch and the other gates are still needed.'),
  'translation.provider': z
    .enum(translationProviders)
    .nullable()
    .optional()
    .describe('Default google.'),
  'translation.targetLanguage': translationLang.nullable().optional().describe('Default en.'),
  'translation.mode': z.enum(translationModes).nullable().optional().describe('Default on_demand.'),
  'translation.dailyCharBudget': z
    .number()
    .int()
    .min(0)
    .max(100_000_000)
    .nullable()
    .optional()
    .describe('Characters per UTC day; 0 is unlimited. Default 50000.'),
  'translation.libretranslate.url': z
    .string()
    .max(2048)
    .nullable()
    .optional()
    .describe(
      'https://host[/path]. A private or loopback address needs KILN_TRANSLATE_ALLOW_PRIVATE_URLS=true. Credentials in the URL are refused.',
    ),
});

const settingsBase = z.object({
  values: z.record(settingValueSchema).describe('Every key with its effective value.'),
  defaults: z.record(settingValueSchema),
  overridden: z.array(z.string()).describe('Keys that have a stored value.'),
  writable: z.array(z.string()).describe('Keys the caller may change (admins and owners: all).'),
  docs: z.record(z.string()),
});

const settingsSchema = settingsBase.extend({
  translation: z.object({
    provider: z.enum(translationProviders),
    credentialRequired: z.boolean(),
    credentialConfigured: z
      .boolean()
      .describe('A credential of the provider\u2019s kind exists. The oldest one is used.'),
    credential: z
      .object({ id: z.string(), label: z.string() })
      .optional()
      .describe('Only for those who may read credentials.'),
    usage: z.object({
      day: z.string().describe('UTC day, YYYY-MM-DD.'),
      used: z.number().int(),
      budget: z.number().int().describe('0: no limit.'),
    }),
  }),
});

export const workspaceOperations: Draft[] = [
  {
    id: 'getHealth',
    method: 'get',
    path: '/api/health',
    tags: ['system'],
    summary: 'Health of the server and its database',
    risk: 'read',
    access: 'public',
    responses: {
      '200': {
        description: 'Healthy. `503` with `status: degraded` when the database does not answer.',
        schema: z.object({
          status: z.string(),
          version: z.string(),
          database: z.object({ dialect: z.string(), ok: z.boolean() }),
        }),
      },
    },
  },
  {
    id: 'getAuthStatus',
    method: 'get',
    path: '/api/auth/status',
    tags: ['auth'],
    summary: 'Whether setup is needed and who is signed in',
    risk: 'read',
    access: 'public',
    responses: {
      '200': {
        description: 'The mode, whether first-run setup is open, and the signed-in user or null.',
        schema: z.object({
          mode: z.enum(['multi', 'single_user']),
          setupRequired: z.boolean(),
          user: userSchema.nullable(),
        }),
      },
    },
  },
  {
    id: 'register',
    method: 'post',
    path: '/api/auth/register',
    tags: ['auth'],
    summary: 'Create the first account and workspace',
    description:
      'Only on an empty instance; later it answers `403 registration_closed`. Sets the session cookie.',
    risk: 'write',
    access: 'public',
    body: registerBody,
    bodyLimit: 256 * 1024,
    responses: {
      '201': {
        description: 'The owner and the new workspace.',
        schema: z.object({ user: userSchema, workspaceId: z.string() }),
      },
    },
  },
  {
    id: 'login',
    method: 'post',
    path: '/api/auth/login',
    tags: ['auth'],
    summary: 'Sign in with email and password',
    description:
      'Sets the session cookie. Rate limited per email address and per client address (`429 too_many_attempts`).',
    risk: 'write',
    access: 'public',
    body: loginBody,
    bodyLimit: 256 * 1024,
    rateLimited: true,
    responses: {
      '200': { description: 'The signed-in user.', schema: z.object({ user: userSchema }) },
    },
  },
  {
    id: 'logout',
    method: 'post',
    path: '/api/auth/logout',
    tags: ['auth'],
    summary: 'End the session',
    risk: 'write',
    access: 'public',
    responses: { '204': none },
  },
  {
    id: 'getMe',
    method: 'get',
    path: '/api/me',
    tags: ['auth'],
    summary: 'The signed-in user and their workspaces',
    description:
      'Session cookie only: an API token is limited to one workspace and has no identity of its own here.',
    risk: 'read',
    access: 'user',
    responses: {
      '200': {
        description: 'The user and each workspace with their role.',
        schema: z.object({
          user: userSchema,
          workspaces: z.array(z.object({ id: z.string(), name: z.string(), role: z.enum(roles) })),
        }),
      },
    },
  },
  {
    id: 'getOpenApi',
    method: 'get',
    path: '/api/openapi.json',
    tags: ['system'],
    summary: 'This document',
    description: 'The OpenAPI 3.1 description of the API. For signed-in users and API tokens only.',
    risk: 'read',
    access: 'user',
    token: true,
    responses: { '200': { description: 'The OpenAPI document.', schema: object } },
  },
  {
    id: 'listCredentials',
    method: 'get',
    path: `${W}/credentials`,
    tags: ['credentials'],
    summary: 'List credentials (metadata and non-secret identifiers only)',
    risk: 'read',
    access: { action: 'credentials.read' },
    responses: {
      '200': {
        description: 'Credentials without their secrets.',
        schema: z.object({ credentials: z.array(credentialSchema) }),
      },
    },
  },
  {
    id: 'createCredential',
    method: 'post',
    path: `${W}/credentials`,
    tags: ['credentials'],
    summary: 'Store a credential',
    risk: 'write',
    access: { action: 'credentials.write' },
    body: credentialBody,
    responses: {
      '201': {
        description: 'The credential, without its secret.',
        schema: z.object({ credential: credentialSchema }),
      },
    },
  },
  {
    id: 'testCredentialSecret',
    method: 'post',
    path: `${W}/credentials/test`,
    tags: ['credentials'],
    summary: 'Test a secret that is not saved',
    risk: 'read',
    access: { action: 'credentials.write' },
    body: testBody,
    rateLimited: true,
    responses: { '200': { description: 'The outcome of the test.', schema: testOutcome } },
  },
  {
    id: 'rotateCredential',
    method: 'put',
    path: `${W}/credentials/{id}`,
    tags: ['credentials'],
    summary: 'Replace the secret of a credential',
    risk: 'write',
    access: { action: 'credentials.write' },
    body: rotateBody,
    responses: { '204': none },
  },
  {
    id: 'deleteCredential',
    method: 'delete',
    path: `${W}/credentials/{id}`,
    tags: ['credentials'],
    summary: 'Delete a credential',
    risk: 'destructive',
    access: { action: 'credentials.write' },
    responses: { '204': none },
  },
  {
    id: 'testCredential',
    method: 'post',
    path: `${W}/credentials/{id}/test`,
    tags: ['credentials'],
    summary: 'Test a saved credential and remember the result',
    risk: 'read',
    access: { action: 'credentials.write' },
    rateLimited: true,
    responses: { '200': { description: 'The outcome of the test.', schema: testOutcome } },
  },
  {
    id: 'listAudit',
    method: 'get',
    path: `${W}/audit`,
    tags: ['workspaces'],
    summary: 'The audit log, newest first',
    description:
      'Every write is recorded with its actor. `actorType` is `user`, `token`, `assistant` or `system`; for a token, `actorId` is the token id and `actorName` its name.',
    risk: 'read',
    access: { action: 'audit.read' },
    query: z.object({ limit: z.number().int().min(1).max(500).optional() }),
    responses: {
      '200': {
        description: 'Audit events.',
        schema: z.object({
          events: z.array(
            z.object({
              id: z.string(),
              actorType: z.string(),
              actorId: z.string(),
              actorName: z.string().nullable(),
              action: z.string(),
              targetType: z.string().nullable(),
              targetId: z.string().nullable(),
              detail: object.nullable(),
              at: timestamp,
            }),
          ),
        }),
      },
    },
  },
  {
    id: 'listMembers',
    method: 'get',
    path: `${W}/members`,
    tags: ['members'],
    summary: 'List members',
    risk: 'read',
    access: { action: 'members.read' },
    responses: {
      '200': { description: 'Members.', schema: z.object({ members: z.array(memberSchema) }) },
    },
  },
  {
    id: 'changeMemberRole',
    method: 'patch',
    path: `${W}/members/{userId}`,
    tags: ['members'],
    summary: 'Change a member’s role',
    risk: 'write',
    access: { action: 'members.manage' },
    body: roleBody,
    responses: { '204': none },
  },
  {
    id: 'removeMember',
    method: 'delete',
    path: `${W}/members/{userId}`,
    tags: ['members'],
    summary: 'Remove a member, or leave the workspace',
    description:
      'Any member may call this on themselves; removing someone else needs `members.manage`.',
    risk: 'destructive',
    access: 'member',
    responses: { '204': none },
  },
  {
    id: 'listInvitations',
    method: 'get',
    path: `${W}/invitations`,
    tags: ['invitations'],
    summary: 'List pending invitations',
    risk: 'read',
    access: { action: 'members.manage' },
    responses: {
      '200': {
        description: 'Pending invitations.',
        schema: z.object({ invitations: z.array(invitationSchema) }),
      },
    },
  },
  {
    id: 'createInvitation',
    method: 'post',
    path: `${W}/invitations`,
    tags: ['invitations'],
    summary: 'Create an invitation link',
    description: 'The one-time `token` is in this response only.',
    risk: 'write',
    access: { action: 'members.manage' },
    body: inviteBody,
    responses: {
      '201': {
        description: 'The invitation and its one-time token.',
        schema: z.object({ invitation: invitationSchema, token: z.string() }),
      },
    },
  },
  {
    id: 'revokeInvitation',
    method: 'delete',
    path: `${W}/invitations/{id}`,
    tags: ['invitations'],
    summary: 'Revoke an invitation',
    risk: 'destructive',
    access: { action: 'members.manage' },
    responses: { '204': none },
  },
  {
    id: 'previewInvitation',
    method: 'get',
    path: '/api/invitations/{token}',
    tags: ['invitations'],
    summary: 'What an invitation link is for',
    description: 'Public. An unknown, used, expired or revoked token is `404`.',
    risk: 'read',
    access: 'public',
    responses: {
      '200': {
        description: 'The workspace name, email and role.',
        schema: z.object({
          workspaceName: z.string(),
          email: z.string(),
          role: z.enum(invitableRoles),
          valid: z.literal(true),
        }),
      },
    },
  },
  {
    id: 'acceptInvitation',
    method: 'post',
    path: '/api/invitations/{token}/accept',
    tags: ['invitations'],
    summary: 'Accept an invitation',
    description:
      'Public. Signed in with the matching email, or a new account with `displayName` and `password`.',
    risk: 'write',
    access: 'public',
    body: acceptBody,
    bodyLimit: 256 * 1024,
    responses: {
      '201': {
        description: 'The member.',
        schema: z.object({ user: userSchema, workspaceId: z.string(), role: z.enum(roles) }),
      },
    },
  },
  {
    id: 'listApps',
    method: 'get',
    path: `${W}/apps`,
    tags: ['apps'],
    summary: 'List apps',
    description: 'A token restricted to some apps sees only those.',
    risk: 'read',
    access: { action: 'apps.read' },
    appScope: { kind: 'list' },
    responses: { '200': { description: 'Apps.', schema: z.object({ apps: z.array(appSchema) }) } },
  },
  {
    id: 'getSyncActivity',
    method: 'get',
    path: `${W}/sync/activity`,
    tags: ['apps'],
    summary: 'What is being read from the stores right now',
    description:
      'The feeds (`releases`, `reviews`, `analytics`) being read at this moment, per app, and how many store jobs wait. Memory of this process only: it says nothing about earlier runs. A token restricted to some apps sees only those.',
    risk: 'read',
    access: { action: 'apps.read' },
    appScope: { kind: 'list' },
    responses: {
      '200': {
        description: 'The apps with a feed being read, and the number of waiting jobs.',
        schema: z.object({
          apps: z.array(
            z.object({
              id: z.string(),
              feeds: z.array(z.object({ feed: z.string(), since: timestamp })),
            }),
          ),
          queued: z.number().int(),
        }),
      },
    },
  },
  {
    id: 'createApp',
    method: 'post',
    path: `${W}/apps`,
    tags: ['apps'],
    summary: 'Add an app',
    risk: 'write',
    access: { action: 'apps.write' },
    body: appBody,
    responses: { '201': { description: 'The app.', schema: z.object({ app: appSchema }) } },
  },
  {
    id: 'discoverApps',
    method: 'post',
    path: `${W}/apps/discover`,
    tags: ['apps'],
    summary: 'Find the apps behind a credential',
    description: 'Reads the store. Shares the per-workspace sync budget.',
    risk: 'read',
    access: { action: 'apps.write' },
    body: discoverBody,
    bodyLimit: 16 * 1024,
    rateLimited: true,
    partial: true,
    responses: { '200': { description: 'Candidates and failures.', schema: object } },
  },
  {
    id: 'importApps',
    method: 'post',
    path: `${W}/apps/import`,
    tags: ['apps'],
    summary: 'Add several apps at once',
    risk: 'write',
    access: { action: 'apps.write' },
    body: importBody,
    bodyLimit: 32 * 1024,
    partial: true,
    responses: {
      '200': {
        description: 'A result per item and a summary.',
        schema: z.object({
          results: z.array(object),
          summary: z.object({
            created: z.number().int(),
            skipped: z.number().int(),
            failed: z.number().int(),
          }),
        }),
      },
    },
  },
  {
    id: 'getApp',
    method: 'get',
    path: `${W}/apps/{id}`,
    tags: ['apps'],
    summary: 'An app and its stored releases',
    risk: 'read',
    access: { action: 'apps.read' },
    appScope: { kind: 'param', name: 'id' },
    responses: {
      '200': {
        description: 'The app and its releases.',
        schema: z.object({ app: appSchema, releases: z.array(releaseSchema) }),
      },
    },
  },
  {
    id: 'deleteApp',
    method: 'delete',
    path: `${W}/apps/{id}`,
    tags: ['apps'],
    summary: 'Remove an app',
    risk: 'destructive',
    access: { action: 'apps.write' },
    appScope: { kind: 'param', name: 'id' },
    responses: { '204': none },
  },
  {
    id: 'syncApp',
    method: 'post',
    path: `${W}/apps/{id}/sync`,
    tags: ['apps'],
    summary: 'Read the store and replace the stored snapshot',
    description:
      'Read-only toward the store. `?background=true` queues it as a job and answers `202` with `jobId`. Rate limited per workspace.',
    risk: 'write',
    access: { action: 'apps.sync' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    query: z.object({ background: z.enum(['true']).optional() }),
    responses: {
      '200': {
        description: 'The app, its releases and what the sync changed.',
        schema: z.object({
          app: appSchema,
          releases: z.array(releaseSchema),
          sync: z.object({
            at: timestamp,
            found: z.number().int(),
            added: z.number().int(),
            updated: z.number().int(),
            removed: z.number().int(),
            unmapped: z.number().int(),
          }),
        }),
      },
      '202': {
        description: 'Queued (with `?background=true`).',
        schema: z.object({ jobId: z.string() }),
      },
    },
  },
  {
    id: 'syncAppAll',
    method: 'post',
    path: `${W}/apps/{id}/sync-all`,
    tags: ['apps'],
    summary: 'Queue everything an app syncs, critical first',
    description:
      'The one "Sync" of the app: queues one job per kind the app has (`app` = store listing and release state, `reviews`, `eas`, `analytics`, `ads` = the Apple Ads reports of a linked ad account, read only and last), in the order the worker ranks them, and answers `202` at once with what happened to each kind. A kind the caller may not run, that does not apply (`not_linked`, `off`, `not_ready`) or that is already queued or running (`already_queued`) is `skipped` with its reason. Nothing is read from a store here: the existing jobs read it. `?without=app` leaves the `app` kind out (the caller ran it itself). `?kinds=reviews,analytics` queues only those kinds (the others are not in the plan): the page-scoped Sync of the web app asks for what the page needs. `?sources=play_vitals,play_reports` limits the `analytics` kind to those sources (a retry of the failed ones; needs `kinds` to include `analytics`); a value that is not a kind or source is `400`. Counts as one sync of the per workspace budget. See docs/adr/0050-sync-pipeline.md.',
    risk: 'write',
    access: { action: 'apps.sync' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    query: z.object({
      without: z.enum(['app']).optional(),
      kinds: z.string().optional().describe('Comma list of `app`, `reviews`, `eas`, `analytics`, `ads`: only these kinds.'),
      sources: z.string().optional().describe('Comma list of analytics sources: only these (with the `analytics` kind).'),
    }),
    responses: {
      '202': {
        description: 'The plan, in queue order.',
        schema: z.object({
          plan: z.array(
            z.object({
              kind: z.enum(['app', 'reviews', 'eas', 'analytics', 'ads']),
              state: z.enum(['queued', 'skipped']),
              jobId: z.string().optional(),
              reason: z.enum(['forbidden', 'not_linked', 'off', 'not_ready', 'already_queued']).optional(),
            }),
          ),
        }),
      },
    },
  },
  {
    id: 'listTokens',
    method: 'get',
    path: `${W}/tokens`,
    tags: ['tokens'],
    summary: 'List API tokens',
    description: 'Metadata only: the token itself is shown once, when it is made.',
    risk: 'read',
    access: { action: 'tokens.read' },
    responses: {
      '200': {
        description: 'Tokens, newest first.',
        schema: z.object({ tokens: z.array(tokenSummarySchema) }),
      },
    },
  },
  {
    id: 'createToken',
    method: 'post',
    path: `${W}/tokens`,
    tags: ['tokens'],
    summary: 'Create an API token',
    description:
      'The `token` is in this response and nowhere else, ever. The role cannot be above your own, and never `owner`.',
    risk: 'write',
    access: { action: 'tokens.manage' },
    body: createTokenBody,
    bodyLimit: 16 * 1024,
    responses: {
      '201': {
        description: 'The token (shown once) and its metadata.',
        schema: z.object({ token: z.string(), summary: tokenSummarySchema }),
      },
    },
  },
  {
    id: 'revokeToken',
    method: 'delete',
    path: `${W}/tokens/{id}`,
    tags: ['tokens'],
    summary: 'Revoke an API token',
    description: 'Takes effect at once. Revoking twice is fine.',
    risk: 'destructive',
    access: { action: 'tokens.manage' },
    responses: { '204': none },
  },
  {
    id: 'listEvents',
    method: 'get',
    path: `${W}/events`,
    tags: ['events'],
    summary: 'Events, oldest first from a cursor',
    description:
      'With `since`: events after that id, up to `limit`; `hasMore` says to ask again with `nextCursor`. Without it: the newest `limit` events. Only events about things the role may read are returned; an app restricted token sees only events about its apps.',
    risk: 'read',
    access: { action: 'events.read' },
    appScope: { kind: 'events' },
    query: z.object({
      since: z.number().int().min(0).optional().describe('Return events with an id above this.'),
      limit: z.number().int().min(1).max(200).optional(),
      type: z.string().optional().describe('Comma separated event types to keep.'),
    }),
    responses: {
      '200': {
        description: 'A page of events.',
        schema: z.object({
          events: z.array(eventSchema),
          hasMore: z.boolean(),
          nextCursor: z.number().int(),
        }),
      },
    },
  },
  {
    id: 'streamEvents',
    method: 'get',
    path: `${W}/events/stream`,
    tags: ['events'],
    summary: 'Server-sent events: the live event stream',
    description:
      'Each event is an SSE message with `id` (the event id), `event` (the type) and `data` (the event as JSON). A comment heartbeat is sent every 15 seconds. Reconnect with `Last-Event-ID` (or `?since=`) to resume. At most 5 open streams per person.',
    risk: 'read',
    access: { action: 'events.read' },
    appScope: { kind: 'events' },
    query: z.object({ since: z.number().int().min(0).optional(), type: z.string().optional() }),
    responses: { '200': { description: 'An event stream.', contentType: 'text/event-stream' } },
  },
  {
    id: 'listWebhooks',
    method: 'get',
    path: `${W}/webhooks`,
    tags: ['webhooks'],
    summary: 'List webhook endpoints',
    risk: 'read',
    access: { action: 'webhooks.read' },
    responses: {
      '200': {
        description: 'Endpoints (never their secrets).',
        schema: z.object({ webhooks: z.array(webhookSchema) }),
      },
    },
  },
  {
    id: 'createWebhook',
    method: 'post',
    path: `${W}/webhooks`,
    tags: ['webhooks'],
    summary: 'Add a webhook endpoint',
    description:
      'The signing `secret` is in this response only. https URLs to public addresses only.',
    risk: 'write',
    access: { action: 'webhooks.manage' },
    body: createWebhookBody,
    bodyLimit: 16 * 1024,
    responses: {
      '201': {
        description: 'The endpoint and its secret (shown once).',
        schema: z.object({ webhook: webhookSchema, secret: z.string() }),
      },
    },
  },
  {
    id: 'getWebhook',
    method: 'get',
    path: `${W}/webhooks/{id}`,
    tags: ['webhooks'],
    summary: 'A webhook endpoint',
    risk: 'read',
    access: { action: 'webhooks.read' },
    responses: {
      '200': { description: 'The endpoint.', schema: z.object({ webhook: webhookSchema }) },
    },
  },
  {
    id: 'updateWebhook',
    method: 'patch',
    path: `${W}/webhooks/{id}`,
    tags: ['webhooks'],
    summary: 'Change a webhook endpoint',
    risk: 'write',
    access: { action: 'webhooks.manage' },
    body: updateWebhookBody,
    bodyLimit: 16 * 1024,
    responses: {
      '200': { description: 'The endpoint.', schema: z.object({ webhook: webhookSchema }) },
    },
  },
  {
    id: 'deleteWebhook',
    method: 'delete',
    path: `${W}/webhooks/{id}`,
    tags: ['webhooks'],
    summary: 'Delete a webhook endpoint and its delivery log',
    risk: 'destructive',
    access: { action: 'webhooks.manage' },
    responses: { '204': none },
  },
  {
    id: 'rotateWebhookSecret',
    method: 'post',
    path: `${W}/webhooks/{id}/rotate-secret`,
    tags: ['webhooks'],
    summary: 'Make a new signing secret',
    description: 'The old secret stops working at once. The new one is in this response only.',
    risk: 'write',
    access: { action: 'webhooks.manage' },
    responses: {
      '200': { description: 'The new secret.', schema: z.object({ secret: z.string() }) },
    },
  },
  {
    id: 'testWebhook',
    method: 'post',
    path: `${W}/webhooks/{id}/test`,
    tags: ['webhooks'],
    summary: 'Send a test event',
    description:
      'Queues a `webhook.test` delivery through the normal path. Rate limited per workspace.',
    risk: 'write',
    access: { action: 'webhooks.manage' },
    rateLimited: true,
    responses: { '202': { description: 'Queued.', schema: z.object({ deliveryId: z.string() }) } },
  },
  {
    id: 'listWebhookDeliveries',
    method: 'get',
    path: `${W}/webhooks/{id}/deliveries`,
    tags: ['webhooks'],
    summary: 'Recent deliveries of an endpoint',
    risk: 'read',
    access: { action: 'webhooks.read' },
    query: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    responses: {
      '200': {
        description: 'Deliveries, newest first.',
        schema: z.object({ deliveries: z.array(deliverySchema) }),
      },
    },
  },
  {
    id: 'redeliverWebhook',
    method: 'post',
    path: `${W}/webhooks/{id}/deliveries/{deliveryId}/redeliver`,
    tags: ['webhooks'],
    summary: 'Send a delivery again',
    description: 'A new delivery with the same body. Rate limited per workspace.',
    risk: 'write',
    access: { action: 'webhooks.manage' },
    rateLimited: true,
    responses: { '202': { description: 'Queued.', schema: z.object({ deliveryId: z.string() }) } },
  },
  {
    id: 'getWorkspaceSettings',
    method: 'get',
    path: `${W}/settings`,
    tags: ['settings'],
    summary: 'Workspace settings: values, defaults and which keys the caller may change',
    description:
      'A fixed list of keys (`reviews.lowRatingThreshold`, `translation.*`). Secrets are never settings: provider keys live in the credential vault. `translation` adds today\u2019s usage against the daily budget.',
    risk: 'read',
    access: { action: 'settings.read' },
    responses: { '200': { description: 'The settings.', schema: settingsSchema } },
  },
  {
    id: 'updateWorkspaceSettings',
    method: 'put',
    path: `${W}/settings`,
    tags: ['settings'],
    summary: 'Change workspace settings (partial)',
    description:
      'Admin or owner. Send only the keys to change; `null` resets a key to its default. All or nothing: one invalid value changes nothing (`400 invalid_setting`); an unknown key is `400 unknown_setting`. Audited as `settings.update` with the key names and the old and new values.',
    risk: 'write',
    access: { action: 'settings.write' },
    body: settingsBody,
    partial: true,
    responses: {
      '200': {
        description: 'The keys that changed, and the settings after the change.',
        schema: settingsBase.extend({ changed: z.array(z.string()) }),
      },
    },
  },
  {
    id: 'testTranslation',
    method: 'post',
    path: `${W}/translate/test`,
    tags: ['settings'],
    summary: 'Test the translation provider with the saved settings',
    description:
      'Translates one fixed word (not review text) with the saved provider, credential and address. Counts nothing against the budget. The answer is `ok` or a fixed sentence; it never echoes a key or a provider message. Rate limited per workspace.',
    risk: 'read',
    access: { action: 'settings.write' },
    rateLimited: true,
    responses: {
      '200': {
        description: 'The outcome.',
        schema: z.object({
          ok: z.boolean(),
          message: z.string(),
          provider: z.enum(translationProviders).optional(),
          reason: z.string().optional(),
        }),
      },
    },
  },
];
