import { z } from 'zod';
import type { Operation } from '../../operations/openapi.ts';
import { alertSeverities } from '../alerts/catalog.ts';
import { createDestinationBody, routesBody, updateDestinationBody } from './destinations.ts';
import { chatDigestModes, chatOutcomes, chatProviders, chatStatuses } from './model.ts';

/**
 * The operations of chat integrations (docs/api/chat-integrations.md). Owners and admins, session only: the destinations hold a secret
 * address, so `chat.read` and `chat.manage` are among the actions no API token can hold (packages/core roles), and the MCP server
 * has no chat tool for the same reason.
 */

const W = '/api/workspaces/{workspaceId}';
const timestamp = z.number().int().describe('Epoch milliseconds.');

const routeSchema = z.object({
  id: z.string(),
  alertTypes: z.array(z.string()).describe('Alert type ids, or ["*"] for all.'),
  minSeverity: z.enum(alertSeverities),
  appIds: z.array(z.string()).nullable().describe('Null means all apps.'),
  platforms: z.array(z.string()).nullable().describe('Null means all platforms.'),
  enabled: z.boolean(),
});

export const destinationSchema = z.object({
  id: z.string(),
  provider: z.enum(chatProviders),
  name: z.string(),
  urlHint: z.string().describe('The last four characters of the webhook URL. The URL itself is never returned.'),
  locale: z.string().describe('The language of the messages: en, fr, es or de.'),
  enabled: z.boolean(),
  allowAnyHost: z.boolean().describe("Accept a webhook host outside the provider's known domains."),
  digest: z.enum(chatDigestModes),
  digestHour: z.number().int(),
  timezone: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  routes: z.array(routeSchema),
  lastDelivery: z.object({ status: z.string(), outcome: z.string(), at: timestamp }).nullable(),
});

const deliverySchema = z.object({
  id: z.string(),
  destinationId: z.string(),
  alertId: z.string().nullable(),
  kind: z.enum(['alert', 'digest', 'test']),
  status: z.enum(chatStatuses),
  outcome: z.enum(chatOutcomes),
  httpStatus: z.number().int().nullable(),
  attempts: z.number().int(),
  title: z.string().nullable(),
  createdAt: timestamp,
  deliveredAt: timestamp.nullable(),
});

const one = z.object({ destination: destinationSchema });

export const chatOperations: Operation[] = [
  {
    id: 'listChatDestinations',
    method: 'get',
    path: `${W}/chat/destinations`,
    tags: ['chat'],
    summary: 'List the chat destinations (Slack, Teams) with their routing rules',
    description: 'Never the webhook URL, only its last four characters.',
    risk: 'read',
    access: { action: 'chat.read' },
    responses: { '200': { description: 'The destinations.', schema: z.object({ destinations: z.array(destinationSchema) }) } },
  },
  {
    id: 'createChatDestination',
    method: 'post',
    path: `${W}/chat/destinations`,
    tags: ['chat'],
    summary: 'Add a chat destination',
    description:
      'A Slack incoming webhook or a Microsoft Teams Workflows webhook. https to a known provider host unless `allowAnyHost`. Without `routes` it gets the defaults: every critical alert and every release event. The URL is stored encrypted and is not returned.',
    risk: 'write',
    access: { action: 'chat.manage' },
    body: createDestinationBody,
    bodyLimit: 32 * 1024,
    responses: { '201': { description: 'The destination.', schema: one } },
  },
  {
    id: 'getChatDestination',
    method: 'get',
    path: `${W}/chat/destinations/{id}`,
    tags: ['chat'],
    summary: 'One chat destination',
    risk: 'read',
    access: { action: 'chat.read' },
    responses: { '200': { description: 'The destination.', schema: one } },
  },
  {
    id: 'updateChatDestination',
    method: 'patch',
    path: `${W}/chat/destinations/{id}`,
    tags: ['chat'],
    summary: 'Change a chat destination',
    description: 'Any of name, url (replaces the stored address), locale, enabled, allowAnyHost, digest, digestHour, timezone.',
    risk: 'write',
    access: { action: 'chat.manage' },
    body: updateDestinationBody,
    bodyLimit: 32 * 1024,
    responses: { '200': { description: 'The destination.', schema: one } },
  },
  {
    id: 'setChatRoutes',
    method: 'put',
    path: `${W}/chat/destinations/{id}/routes`,
    tags: ['chat'],
    summary: 'Replace the routing rules of a destination',
    description: 'Which alert types, from which severity, for which apps and platforms go to the destination.',
    risk: 'write',
    access: { action: 'chat.manage' },
    body: routesBody,
    bodyLimit: 32 * 1024,
    responses: { '200': { description: 'The destination with its rules.', schema: one } },
  },
  {
    id: 'deleteChatDestination',
    method: 'delete',
    path: `${W}/chat/destinations/{id}`,
    tags: ['chat'],
    summary: 'Delete a chat destination',
    description: 'Its rules and delivery log go with it.',
    risk: 'destructive',
    access: { action: 'chat.manage' },
    responses: { '204': { description: 'Done. No body.' } },
  },
  {
    id: 'testChatDestination',
    method: 'post',
    path: `${W}/chat/destinations/{id}/test`,
    tags: ['chat'],
    summary: 'Send a test message to a destination',
    description: 'Queued through the normal path; the result is in the deliveries. Rate limited per workspace.',
    risk: 'write',
    access: { action: 'chat.manage' },
    rateLimited: true,
    responses: { '202': { description: 'Queued.', schema: z.object({ deliveryId: z.string() }) } },
  },
  {
    id: 'listChatDeliveries',
    method: 'get',
    path: `${W}/chat/destinations/{id}/deliveries`,
    tags: ['chat'],
    summary: 'The delivery log of a destination',
    risk: 'read',
    access: { action: 'chat.read' },
    query: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    responses: { '200': { description: 'Newest first.', schema: z.object({ deliveries: z.array(deliverySchema) }) } },
  },
];
