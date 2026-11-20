import { z } from 'zod';
import type { Operation } from './openapi.ts';

/**
 * The MCP status of the workspace (docs/api/mcp.md), for the "Connect an AI assistant" card of Settings. Admin and owner with a session:
 * `tokens.manage` is closed to API tokens, so a token cannot call it. The MCP endpoint itself (`POST /mcp`) is outside `/api` and is not
 * an operation of this registry: its tools are views of the operations listed here and answer to their rules.
 */

const W = '/api/workspaces/{workspaceId}';

const statusSchema = z.object({
  enabled: z.boolean().describe('MRM_MCP_ENABLED is on. While it is off, `POST /mcp` answers 404.'),
  endpoint: z.string().describe('The path of the MCP endpoint on this server.'),
  protocolVersion: z.string(),
  envName: z.string(),
  switches: z
    .array(z.object({ env: z.string(), enabled: z.boolean() }))
    .describe('The server switches the write and preview tools also need.'),
  tools: z.array(
    z.object({
      name: z.string(),
      title: z.string(),
      description: z.string(),
      kind: z
        .enum(['read', 'write', 'preview'])
        .describe(
          "`read`: reads. `write`: changes the workspace's own data (a triage mark, a reply DRAFT). `preview`: shows what a store action would do and gives a confirmHash and a link; it never applies.",
        ),
      action: z
        .string()
        .nullable()
        .describe(
          "The action a token must hold. For `write` and `preview` the token's `actions` list must name it.",
        ),
      switch: z.string().nullable().describe('The server switch the tool also needs, or null.'),
      switchOn: z.boolean(),
    }),
  ),
  preset: z
    .object({
      name: z.string(),
      role: z.literal('viewer'),
      actions: z.array(z.string()),
      expiresInDays: z.number().int(),
    })
    .describe(
      'The "MCP read-only" token: create it with `POST /tokens` using this role and these actions.',
    ),
});

export const mcpOperations: Operation[] = [
  {
    id: 'getMcpStatus',
    method: 'get',
    path: `${W}/mcp/status`,
    tags: ['mcp'],
    summary: 'Whether the MCP server is on, and which tools it offers',
    description:
      'Owner and admin, session only. `enabled` is the server switch MRM_MCP_ENABLED (off by default). The tools are the whole catalog with what each needs; what a given token is offered is decided by its role, its actions and the switches.',
    risk: 'read',
    access: { action: 'tokens.manage' },
    responses: { '200': { description: 'The status and the tool catalog.', schema: statusSchema } },
  },
];
