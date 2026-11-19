/**
 * "Connect an AI assistant" (docs/mcp.md): the status the server reports, the token the card creates, and the copy and paste
 * configuration for the assistants. Pure functions, no network: the Settings card (components/settings/McpSettings.svelte) calls them.
 */

export type McpToolKind = 'read' | 'write' | 'preview';

export type McpTool = {
  name: string;
  title: string;
  description: string;
  kind: McpToolKind;
  action: string | null;
  switch: string | null;
  switchOn: boolean;
};

export type McpStatus = {
  enabled: boolean;
  endpoint: string;
  protocolVersion: string;
  envName: string;
  switches: { env: string; enabled: boolean }[];
  tools: McpTool[];
  preset: { name: string; role: 'viewer'; actions: string[]; expiresInDays: number };
};

const DAY = 24 * 60 * 60 * 1000;

/** The one warning that goes with every token handed to an assistant. */
export const MCP_WARNING =
  'An assistant that holds this token can read everything the token may read, and text from stores and customers passes through it. ' +
  'It cannot publish, submit, release or send anything: those can only be previewed, and you confirm them here in the app.';

export const kindLabel: Record<McpToolKind, string> = {
  read: 'Read',
  write: 'Change the workspace\'s own data',
  preview: 'Preview only (you confirm in the app)',
};

export const kindHelp: Record<McpToolKind, string> = {
  read: 'On for the read-only token.',
  write: 'Needs a token that names the action, and a server switch where a store is involved. Never reaches a store.',
  preview: 'Shows what a store action would do and gives a link. Needs a token that names the action and the server switch. Never applies.',
};

/** The tools by kind, in a stable order, with empty groups left out. */
export function groupTools(tools: readonly McpTool[]): { kind: McpToolKind; label: string; help: string; tools: McpTool[] }[] {
  return (['read', 'write', 'preview'] as const)
    .map((kind) => ({ kind, label: kindLabel[kind], help: kindHelp[kind], tools: tools.filter((t) => t.kind === kind) }))
    .filter((g) => g.tools.length > 0);
}

/** What a tool needs beyond a token that names its action, in words. */
export function toolNeeds(tool: McpTool): string {
  if (tool.kind === 'read') return tool.action ? `needs ${tool.action}` : '';
  const parts = [tool.action ? `token names ${tool.action}` : 'token names the action'];
  if (tool.switch) parts.push(`${tool.switch}=true${tool.switchOn ? '' : ' (off now)'}`);
  return parts.join(', ');
}

export type McpStateView = { tone: 'ok' | 'warn'; label: string; detail: string };

export function stateView(status: McpStatus): McpStateView {
  if (!status.enabled) {
    return {
      tone: 'warn',
      label: 'Off on this server',
      detail: `Set ${status.envName}=true in the server's environment and restart it. While it is off, ${status.endpoint} answers 404.`,
    };
  }
  return { tone: 'ok', label: 'On', detail: `Assistants connect to ${status.endpoint} with an API token.` };
}

/** The request body that creates the "MCP read-only" token. `now` is a parameter so tests are exact. */
export function presetTokenInput(status: McpStatus, now: number = Date.now()): { name: string; role: 'viewer'; actions: string[]; expiresAt: number } {
  return { name: status.preset.name, role: status.preset.role, actions: [...status.preset.actions], expiresAt: now + status.preset.expiresInDays * DAY };
}

export type McpClient = 'claude-code' | 'claude-desktop' | 'cursor';
export type McpTransport = 'http' | 'stdio';

export type Snippet = {
  client: McpClient;
  transport: McpTransport;
  title: string;
  /** Where it goes. */
  where: string;
  language: 'json' | 'sh';
  text: string;
};

export const TOKEN_PLACEHOLDER = '<your API token>';
const SERVER_NAME = 'mobile-release-manager';
const BRIDGE = '/path/to/mobile-release-manager/apps/server/src/mcp/stdio.ts';

/** The address the assistants use for the HTTP transport. */
export const mcpUrl = (origin: string, endpoint = '/mcp'): string => `${origin.replace(/\/+$/, '')}${endpoint}`;

const json = (value: unknown) => JSON.stringify(value, null, 2);
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Copy and paste configuration for each assistant, over HTTP (the assistant talks to the server) and over stdio (the assistant starts
 * a small local command that talks to the server). `token` is the one just created, or null for a placeholder.
 */
export function snippets(origin: string, token: string | null, endpoint = '/mcp'): Snippet[] {
  const secret = token ?? TOKEN_PLACEHOLDER;
  const url = mcpUrl(origin, endpoint);
  const base = origin.replace(/\/+$/, '');
  const stdioEnv = { MRM_URL: base, MRM_TOKEN: secret };
  const stdioServer = { command: 'node', args: [BRIDGE], env: stdioEnv };
  return [
    {
      client: 'claude-code', transport: 'http', title: 'Claude Code (HTTP)', where: 'Run in a terminal', language: 'sh',
      text: `claude mcp add --transport http ${SERVER_NAME} ${shellQuote(url)} --header ${shellQuote(`Authorization: Bearer ${secret}`)}`,
    },
    {
      client: 'claude-code', transport: 'stdio', title: 'Claude Code (stdio)', where: 'Run in a terminal', language: 'sh',
      text: `claude mcp add ${SERVER_NAME} --env MRM_URL=${shellQuote(base)} --env MRM_TOKEN=${shellQuote(secret)} -- node ${BRIDGE}`,
    },
    {
      client: 'claude-desktop', transport: 'stdio', title: 'Claude Desktop (stdio)', where: 'claude_desktop_config.json, then restart Claude Desktop', language: 'json',
      text: json({ mcpServers: { [SERVER_NAME]: stdioServer } }),
    },
    {
      client: 'cursor', transport: 'http', title: 'Cursor (HTTP)', where: '~/.cursor/mcp.json or .cursor/mcp.json', language: 'json',
      text: json({ mcpServers: { [SERVER_NAME]: { url, headers: { Authorization: `Bearer ${secret}` } } } }),
    },
    {
      client: 'cursor', transport: 'stdio', title: 'Cursor (stdio)', where: '~/.cursor/mcp.json or .cursor/mcp.json', language: 'json',
      text: json({ mcpServers: { [SERVER_NAME]: stdioServer } }),
    },
  ];
}

export const mcpErrorMessage = (status: number | undefined): string => {
  if (status === 403) return 'Only owners and admins can connect an assistant.';
  if (status === 404) return 'This workspace was not found.';
  return 'Could not load the assistant settings.';
};
