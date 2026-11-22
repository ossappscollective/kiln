import { k, t } from './i18n/t.ts';

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
export const MCP_WARNING = k('workspace:mcp.warning');

/** Message keys: the screen translates them where it draws them (`groupTools` does it for its groups). */
export const kindLabel: Record<McpToolKind, string> = {
  read: k('workspace:mcp.kind.read'),
  write: k('workspace:mcp.kind.write'),
  preview: k('workspace:mcp.kind.preview'),
};

export const kindHelp: Record<McpToolKind, string> = {
  read: k('workspace:mcp.kindHelp.read'),
  write: k('workspace:mcp.kindHelp.write'),
  preview: k('workspace:mcp.kindHelp.preview'),
};

/** The tools by kind, in a stable order, with empty groups left out. */
export function groupTools(
  tools: readonly McpTool[],
): { kind: McpToolKind; label: string; help: string; tools: McpTool[] }[] {
  return (['read', 'write', 'preview'] as const)
    .map((kind) => ({
      kind,
      label: t(kindLabel[kind]),
      help: t(kindHelp[kind]),
      tools: tools.filter((t) => t.kind === kind),
    }))
    .filter((g) => g.tools.length > 0);
}

/** What a tool needs beyond a token that names its action, in words. */
export function toolNeeds(tool: McpTool): string {
  if (tool.kind === 'read') return tool.action ? t('workspace:mcp.needs.read', { action: tool.action }) : '';
  const parts = [
    tool.action
      ? t('workspace:mcp.needs.tokenNames', { action: tool.action })
      : t('workspace:mcp.needs.tokenNamesAction'),
  ];
  if (tool.switch)
    parts.push(
      tool.switchOn
        ? t('workspace:mcp.needs.switchOn', { switch: tool.switch })
        : t('workspace:mcp.needs.switchOff', { switch: tool.switch }),
    );
  return parts.join(', ');
}

export type McpStateView = { tone: 'ok' | 'warn'; label: string; detail: string };

export function stateView(status: McpStatus): McpStateView {
  if (!status.enabled) {
    return {
      tone: 'warn',
      label: t('workspace:mcp.state.offLabel'),
      detail: t('workspace:mcp.state.offDetail', { env: status.envName, endpoint: status.endpoint }),
    };
  }
  return {
    tone: 'ok',
    label: t('workspace:mcp.state.onLabel'),
    detail: t('workspace:mcp.state.onDetail', { endpoint: status.endpoint }),
  };
}

/** The request body that creates the "MCP read-only" token. `now` is a parameter so tests are exact. */
export function presetTokenInput(
  status: McpStatus,
  now: number = Date.now(),
): { name: string; role: 'viewer'; actions: string[]; expiresAt: number } {
  return {
    name: status.preset.name,
    role: status.preset.role,
    actions: [...status.preset.actions],
    expiresAt: now + status.preset.expiresInDays * DAY,
  };
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
const SERVER_NAME = 'kiln';
const BRIDGE = '/path/to/kiln/apps/server/src/mcp/stdio.ts';

/** The address the assistants use for the HTTP transport. */
export const mcpUrl = (origin: string, endpoint = '/mcp'): string =>
  `${origin.replace(/\/+$/, '')}${endpoint}`;

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
  const stdioEnv = { KILN_URL: base, KILN_TOKEN: secret };
  const stdioServer = { command: 'node', args: [BRIDGE], env: stdioEnv };
  return [
    {
      client: 'claude-code',
      transport: 'http',
      title: 'Claude Code (HTTP)',
      where: t('workspace:mcp.where.terminal'),
      language: 'sh',
      text: `claude mcp add --transport http ${SERVER_NAME} ${shellQuote(url)} --header ${shellQuote(`Authorization: Bearer ${secret}`)}`,
    },
    {
      client: 'claude-code',
      transport: 'stdio',
      title: 'Claude Code (stdio)',
      where: t('workspace:mcp.where.terminal'),
      language: 'sh',
      text: `claude mcp add ${SERVER_NAME} --env KILN_URL=${shellQuote(base)} --env KILN_TOKEN=${shellQuote(secret)} -- node ${BRIDGE}`,
    },
    {
      client: 'claude-desktop',
      transport: 'stdio',
      title: 'Claude Desktop (stdio)',
      where: t('workspace:mcp.where.desktop'),
      language: 'json',
      text: json({ mcpServers: { [SERVER_NAME]: stdioServer } }),
    },
    {
      client: 'cursor',
      transport: 'http',
      title: 'Cursor (HTTP)',
      where: '~/.cursor/mcp.json or .cursor/mcp.json',
      language: 'json',
      text: json({
        mcpServers: { [SERVER_NAME]: { url, headers: { Authorization: `Bearer ${secret}` } } },
      }),
    },
    {
      client: 'cursor',
      transport: 'stdio',
      title: 'Cursor (stdio)',
      where: '~/.cursor/mcp.json or .cursor/mcp.json',
      language: 'json',
      text: json({ mcpServers: { [SERVER_NAME]: stdioServer } }),
    },
  ];
}

export const mcpErrorMessage = (status: number | undefined): string => {
  if (status === 403) return t('workspace:mcp.error.forbidden');
  if (status === 404) return t('workspace:mcp.error.notFound');
  return t('workspace:mcp.error.load');
};
