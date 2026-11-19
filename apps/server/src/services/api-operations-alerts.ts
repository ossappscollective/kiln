import { z } from 'zod';
import {
  markReadBody,
  muteBody,
  preferenceBody,
  ruleBody,
  settingsBody,
  testBody,
} from '../routes/alerts.ts';
import { alertChannels, alertGroups, alertSeverities } from './alert-catalog.ts';
import type { Operation } from './openapi.ts';

/**
 * The operations of alerts (docs/api/alerts.md), kept in their own file and added to the registry in api-operations.ts. Reading the
 * catalog, the person's own inbox and the delivery log needs `alerts.read` (every role). A person's own settings, channels, mutes and
 * tests need `alerts.write` (members and above); the workspace rules need `alerts.manage` (admins). The last two are EXPLICIT-ONLY for
 * tokens, and the operations that change a person's own state (`token: false`) are never open to a token: they belong to the person.
 */

const W = '/api/workspaces/{workspaceId}';
const timestamp = z.number().int().describe('Epoch milliseconds.');
const none = { description: 'Done. No body.' };
const channel = z.enum(alertChannels);
const severity = z.enum(alertSeverities);

const ruleSchema = z.object({
  alertType: z.string(),
  enabled: z.boolean(),
  channels: z
    .array(channel)
    .describe(
      'What people get who made no choice of their own; `webhook` is the workspace channel itself.',
    ),
  maxPerHour: z.number().int(),
  params: z.record(z.number()).describe('The numeric thresholds of the type, by key.'),
  custom: z.boolean().describe('False while the catalog defaults apply.'),
});

const catalogEntry = z.object({
  id: z.string(),
  group: z.enum(alertGroups),
  groupLabel: z.string(),
  label: z.string(),
  description: z.string(),
  severity,
  scope: z.enum(['workspace', 'app']),
  defaultChannels: z.array(channel),
  allowedChannels: z.array(channel),
  audience: z.string().describe('The action that decides who is told: people whose role has it.'),
  source: z.enum(['event', 'state']),
  events: z.array(z.string()),
  dedupe: z.string().describe('The key template under which repeats collapse.'),
  dedupeWindowHours: z.number().int(),
  params: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      unit: z.string(),
      default: z.number(),
      min: z.number(),
      max: z.number(),
    }),
  ),
  visible: z.boolean().describe("Whether the caller's role can ever receive it."),
  rule: ruleSchema,
});

const inboxAlert = z.object({
  id: z.string(),
  type: z.string(),
  severity,
  title: z.string(),
  body: z.string().describe('Ids and names only: never a secret and never the text of a review.'),
  appId: z.string().nullable(),
  count: z.number().int().describe('How many times it happened: repeats collapse into one alert.'),
  firstAt: timestamp,
  lastAt: timestamp,
  resolvedAt: timestamp.nullable().describe('Set when the condition behind a state alert ended.'),
  read: z.boolean(),
  desktop: z
    .boolean()
    .describe(
      "The person's choices allow a desktop notification for it: the client shows it once.",
    ),
});

const deliverySchema = z.object({
  id: z.string(),
  alertId: z.string().nullable(),
  alertType: z.string().nullable(),
  title: z.string().nullable(),
  userId: z.string().nullable(),
  channel,
  kind: z.enum(['alert', 'digest', 'test']),
  status: z.enum(['queued', 'retrying', 'sent', 'failed', 'skipped', 'deferred']),
  outcome: z
    .string()
    .describe('A code from a fixed vocabulary (docs/api/alerts.md); never text a provider said.'),
  attempts: z.number().int(),
  createdAt: timestamp,
  deliveredAt: timestamp.nullable(),
});

const settingsSchema = z.object({
  minSeverity: severity,
  quietStart: z.number().int().nullable().describe('Minutes after midnight in `timezone`.'),
  quietEnd: z.number().int().nullable(),
  timezone: z.string().nullable(),
  digest: z.enum(['off', 'daily', 'weekly']),
  digestHour: z.number().int(),
  lastDigestAt: timestamp.nullable(),
});
const preferenceSchema = z.object({
  alertType: z.string(),
  appId: z.string().nullable(),
  channels: z.array(channel),
});
const muteSchema = z.object({
  id: z.string(),
  appId: z.string().nullable(),
  alertType: z.string().nullable(),
  until: timestamp.nullable(),
  createdAt: timestamp,
});

export const alertOperations: Operation[] = [
  {
    id: 'listAlertCatalog',
    method: 'get',
    path: `${W}/alerts/catalog`,
    tags: ['alerts'],
    summary: 'Every alert type, with the workspace rule for each',
    risk: 'read',
    access: { action: 'alerts.read' },
    responses: {
      '200': { description: 'The catalog.', schema: z.object({ catalog: z.array(catalogEntry) }) },
    },
  },
  {
    id: 'listAlerts',
    method: 'get',
    path: `${W}/alerts/inbox`,
    tags: ['alerts'],
    summary: 'The alert inbox of the caller',
    description: 'Newest first. A token reads the inbox of the person it acts for.',
    risk: 'read',
    access: { action: 'alerts.read' },
    query: z.object({
      unread: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      before: z.number().int().optional(),
    }),
    responses: {
      '200': {
        description: 'Alerts.',
        schema: z.object({
          alerts: z.array(inboxAlert),
          unreadCount: z.number().int(),
          hasMore: z.boolean(),
          now: timestamp,
        }),
      },
    },
  },
  {
    id: 'getAlertUnreadCount',
    method: 'get',
    path: `${W}/alerts/unread-count`,
    tags: ['alerts'],
    summary: 'How many alerts of the caller are unread',
    risk: 'read',
    access: { action: 'alerts.read' },
    responses: {
      '200': { description: 'The count.', schema: z.object({ unreadCount: z.number().int() }) },
    },
  },
  {
    id: 'markAlertsRead',
    method: 'post',
    path: `${W}/alerts/inbox/read`,
    tags: ['alerts'],
    summary: 'Mark alerts read',
    description: "Give `ids`, or `all: true`. Changes only the caller's own inbox.",
    risk: 'write',
    access: { action: 'alerts.read' },
    token: false,
    body: markReadBody,
    bodyLimit: 8 * 1024,
    responses: {
      '200': {
        description: 'How many changed.',
        schema: z.object({ marked: z.number().int(), unreadCount: z.number().int() }),
      },
    },
  },
  {
    id: 'getAlertSettings',
    method: 'get',
    path: `${W}/alerts/settings`,
    tags: ['alerts'],
    summary: 'Your alert settings, channels per type and mutes',
    risk: 'read',
    access: { action: 'alerts.read' },
    token: false,
    responses: {
      '200': {
        description: "The caller's own choices.",
        schema: z.object({
          settings: settingsSchema,
          preferences: z.array(preferenceSchema),
          mutes: z.array(muteSchema),
        }),
      },
    },
  },
  {
    id: 'updateAlertSettings',
    method: 'put',
    path: `${W}/alerts/settings`,
    tags: ['alerts'],
    summary: 'Change your alert settings',
    description:
      'Lowest severity, quiet hours (minutes after midnight in your timezone; critical alerts ignore them) and the email digest.',
    risk: 'write',
    access: { action: 'alerts.write' },
    token: false,
    body: settingsBody,
    bodyLimit: 8 * 1024,
    responses: {
      '200': { description: 'The settings.', schema: z.object({ settings: settingsSchema }) },
    },
  },
  {
    id: 'setAlertPreference',
    method: 'put',
    path: `${W}/alerts/preferences/{alertType}`,
    tags: ['alerts'],
    summary: 'Choose your channels for one alert type',
    description:
      'For all apps, or one with `appId`. `channels: null` removes your choice so the workspace rule applies.',
    risk: 'write',
    access: { action: 'alerts.write' },
    token: false,
    body: preferenceBody,
    bodyLimit: 8 * 1024,
    responses: {
      '200': {
        description: 'The choice, or null when removed.',
        schema: z.object({ preference: preferenceSchema.nullable() }),
      },
    },
  },
  {
    id: 'createAlertMute',
    method: 'post',
    path: `${W}/alerts/mutes`,
    tags: ['alerts'],
    summary: 'Mute or snooze alerts',
    description:
      'An app, an alert type or both (leave out for all). `hours` snoozes; without it the mute lasts until removed.',
    risk: 'write',
    access: { action: 'alerts.write' },
    token: false,
    body: muteBody,
    bodyLimit: 8 * 1024,
    responses: { '201': { description: 'The mute.', schema: z.object({ mute: muteSchema }) } },
  },
  {
    id: 'deleteAlertMute',
    method: 'delete',
    path: `${W}/alerts/mutes/{id}`,
    tags: ['alerts'],
    summary: 'Remove a mute',
    risk: 'destructive',
    access: { action: 'alerts.write' },
    token: false,
    responses: { '204': none },
  },
  {
    id: 'setAlertRule',
    method: 'put',
    path: `${W}/alerts/rules/{alertType}`,
    tags: ['alerts'],
    summary: 'Set the workspace rule of an alert type',
    description:
      'Whether it is on, the channels people get without a choice of their own (and the webhook channel), the hourly cap and the thresholds.',
    risk: 'write',
    access: { action: 'alerts.manage' },
    body: ruleBody,
    bodyLimit: 8 * 1024,
    responses: { '200': { description: 'The rule.', schema: z.object({ rule: ruleSchema }) } },
  },
  {
    id: 'resetAlertRule',
    method: 'delete',
    path: `${W}/alerts/rules/{alertType}`,
    tags: ['alerts'],
    summary: 'Back to the catalog defaults for an alert type',
    risk: 'destructive',
    access: { action: 'alerts.manage' },
    responses: {
      '200': { description: 'The rule now in force.', schema: z.object({ rule: ruleSchema }) },
    },
  },
  {
    id: 'listAlertDeliveries',
    method: 'get',
    path: `${W}/alerts/deliveries`,
    tags: ['alerts'],
    summary: 'The delivery log',
    description:
      "Your own rows; `scope=workspace` (admins) lists everyone's, webhook rows included.",
    risk: 'read',
    access: { action: 'alerts.read' },
    query: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      scope: z.enum(['mine', 'workspace']).optional(),
    }),
    responses: {
      '200': {
        description: 'Deliveries, newest first.',
        schema: z.object({ deliveries: z.array(deliverySchema) }),
      },
    },
  },
  {
    id: 'sendTestAlert',
    method: 'post',
    path: `${W}/alerts/test`,
    tags: ['alerts'],
    summary: 'Send a test alert on one channel',
    description:
      'To yourself; the webhook channel goes to the workspace endpoints and needs an admin. Rate limited per workspace.',
    risk: 'write',
    access: { action: 'alerts.write' },
    token: false,
    rateLimited: true,
    body: testBody,
    bodyLimit: 8 * 1024,
    responses: {
      '202': {
        description: 'Raised; the deliveries it made so far.',
        schema: z.object({ alertId: z.string(), deliveries: z.array(deliverySchema) }),
      },
    },
  },
];
