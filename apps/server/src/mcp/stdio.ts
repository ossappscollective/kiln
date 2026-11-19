/**
 * A stdio bridge for MCP clients that start a local command (docs/adr/0023-mcp-server.md, docs/mcp.md):
 *
 *   MRM_URL=https://mrm.example.com MRM_TOKEN=mrm_... node apps/server/src/mcp/stdio.ts
 *
 * It reads newline delimited JSON-RPC from stdin, POSTs each message to `<MRM_URL>/mcp` with the token, and writes the answers to stdout.
 * It is a transport only: every rule (what the token may do, size caps, untrusted markers, previews instead of writes) is the server's.
 * No dependency, no state, nothing is logged but a fixed line on stderr; the token is read from the environment and never printed.
 * It refuses a plain `http` address unless it is this machine (the token must not cross a network unencrypted).
 */
import { pathToFileURL } from 'node:url';

export type BridgeOptions = {
  url: string;
  token: string;
  input: AsyncIterable<string | Uint8Array>;
  write: (line: string) => void;
  log?: (line: string) => void;
  fetch?: typeof fetch;
};

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const REQUEST_TIMEOUT_MS = 60_000;

const STATUS_TEXT: Record<number, string> = {
  400: 'The server did not accept the request.',
  401: 'The API token was refused (wrong, revoked or expired).',
  403: 'The server refused the request.',
  404: 'The MCP server is off (MRM_MCP_ENABLED) or MRM_URL is wrong.',
  413: 'The request is too large.',
  429: 'Too many requests. Try again later.',
};

/** The MCP endpoint for an address: the server's base address, or the full `/mcp` address. Throws a fixed message when it is not usable. */
export function endpointFor(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('MRM_URL is not a valid address.');
  }
  const local =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('MRM_URL must be https (plain http is accepted for localhost only).');
  }
  if (url.username || url.password)
    throw new Error('MRM_URL must not contain a user name or password.');
  url.search = '';
  url.hash = '';
  if (!url.pathname.replace(/\/+$/, '').endsWith('/mcp'))
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/mcp`;
  return url;
}

type Id = string | number | null;
const errorLine = (id: Id, code: number, message: string) =>
  JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });

export async function runBridge(options: BridgeOptions): Promise<void> {
  const endpoint = endpointFor(options.url);
  const doFetch = options.fetch ?? fetch;
  const log = options.log ?? (() => undefined);
  let version: string | undefined;

  const post = async (message: unknown): Promise<void> => {
    const isObject = typeof message === 'object' && message !== null && !Array.isArray(message);
    const id: Id | undefined =
      isObject && 'id' in message ? ((message as { id: Id }).id ?? null) : undefined;
    const isInitialize = isObject && (message as { method?: unknown }).method === 'initialize';
    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${options.token}`,
          ...(version && !isInitialize ? { 'mcp-protocol-version': version } : {}),
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch {
      log('The MCP server could not be reached.');
      if (id !== undefined)
        options.write(errorLine(id, -32603, 'The MCP server could not be reached.'));
      return;
    }
    if (response.status === 202) {
      await response.body?.cancel();
      return;
    }
    const text = await response.text();
    if (!response.ok) {
      log(`The MCP server answered ${response.status}.`);
      if (id !== undefined)
        options.write(
          errorLine(
            id,
            -32603,
            STATUS_TEXT[response.status] ?? 'The MCP server could not do that.',
          ),
        );
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      if (id !== undefined)
        options.write(errorLine(id, -32603, 'The MCP server sent an answer that is not JSON.'));
      return;
    }
    if (isInitialize) {
      const negotiated = (body as { result?: { protocolVersion?: unknown } } | null)?.result
        ?.protocolVersion;
      if (typeof negotiated === 'string' && PROTOCOL_VERSIONS.includes(negotiated))
        version = negotiated;
    }
    options.write(JSON.stringify(body));
  };

  let buffer = '';
  const decoder = new TextDecoder();
  const lines = async (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) await handle(line);
      index = buffer.indexOf('\n');
    }
    if (buffer.length > 1_000_000) {
      buffer = '';
      options.write(errorLine(null, -32600, 'The message is too large.'));
    }
  };
  const handle = async (line: string) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      options.write(errorLine(null, -32700, 'The input is not valid JSON.'));
      return;
    }
    await post(message);
  };

  for await (const chunk of options.input)
    await lines(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
  const rest = buffer.trim();
  if (rest) await handle(rest);
}

const isMain =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const url = process.env.MRM_URL ?? '';
  const token = process.env.MRM_TOKEN ?? '';
  if (!url || !token) {
    process.stderr.write(
      'Set MRM_URL (the address of Mobile Release Manager) and MRM_TOKEN (an API token).\n',
    );
    process.exit(2);
  }
  runBridge({
    url,
    token,
    input: process.stdin,
    write: (line) => process.stdout.write(`${line}\n`),
    log: (line) => process.stderr.write(`${line}\n`),
  }).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error && /^MRM_URL/.test(error.message) ? error.message : 'The bridge stopped.'}\n`,
    );
    process.exit(1);
  });
}
