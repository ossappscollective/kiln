import { can } from '@mrm/core';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { type AppEnv, clientIp, type Services } from '../http.ts';
import { createLoginLimiter, type LoginLimiter } from '../limiter.ts';
import { memberRole } from '../services/accounts.ts';
import { recordAudit, runAsToken } from '../services/audit.ts';
import { createTestLimiter, type TestLimiter } from '../services/credential-tests.ts';
import { authenticateToken, type TokenPrincipal } from '../services/tokens.ts';
import { FLAG_ENV, type McpFlags } from './flags.ts';
import {
  ERROR_CODES,
  type JsonRpcResponse,
  LATEST_PROTOCOL_VERSION,
  RPC_MESSAGES,
  rpcError,
  SUPPORTED_PROTOCOL_VERSIONS,
} from './protocol.ts';
import { handleMessage, type ServerContext } from './server.ts';
import {
  type Dispatch,
  type DispatchResult,
  operationOf,
  readOnlyActions,
  tools,
} from './tools.ts';

/**
 * `POST /mcp`, the MCP endpoint (docs/adr/0023-mcp-server.md, docs/api/mcp.md), and the admin status route for the Settings card.
 *
 * - OFF by default (MRM_MCP_ENABLED): while off, every method answers 404 as if the route did not exist.
 * - Streamable HTTP, stateless: a POST with a JSON-RPC message (or a batch) is answered with `application/json`; notifications get 202.
 *   GET (the optional server to client stream) and DELETE (ending a session, which does not exist) answer 405.
 * - Authentication is the API token and nothing else: `Authorization: Bearer mrm_...` is REQUIRED, the session cookie is ignored, so a
 *   page in a browser can never act through this endpoint. A request with an `Origin` header is refused unless the origin is one the
 *   server already trusts (MRM_PUBLIC_ORIGIN, MRM_TRUSTED_ORIGINS): real MCP clients are not browsers and send none, and a rebound DNS name
 *   shows up as a foreign origin. In single user mode the host guard of the app (single-user.ts) runs before this as well.
 * - A tool call goes through the app's own routes with the same bearer token (see `dispatcher`), so the registry allow-list, the role
 *   ceiling, the app restriction, the per token rate limit and the audit attribution are the routes' own.
 * - Bad tokens count against the client address like on the API; each token also has an MCP request budget of its own.
 */

/** MCP requests per token per minute (tool calls then also count against the API's 300 a minute). */
export const MCP_RATE_LIMIT = 120;
/** Largest request body in bytes. */
export const MCP_BODY_LIMIT = 256 * 1024;
/** Most messages in one batch (the 2025-03-26 revision allows batches, later ones do not). */
export const MAX_BATCH = 16;
/** How long one tool call may take, in milliseconds. */
export const CALL_TIMEOUT_MS = 25_000;
/** Largest answer of a route that is read, in characters. */
const MAX_ROUTE_ANSWER = 4_000_000;

export type McpDeps = {
  /** MRM_MCP_ENABLED. Default false. */
  enabled?: boolean;
  /** MCP requests per token per minute. */
  limiter?: TestLimiter;
  /** Bad tokens per client address. */
  badTokenLimiter?: LoginLimiter;
};

export type MountOptions = {
  services: Services;
  deps: McpDeps | undefined;
  flags: McpFlags;
  version: string;
  publicOrigin?: string | undefined;
  trustedOrigins?: string[] | undefined;
};

const json = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 405 | 413 | 415 | 429,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) => {
  for (const [name, value] of Object.entries(headers)) c.header(name, value);
  c.header('Cache-Control', 'no-store');
  return c.json(body, status);
};

const safeOrigin = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

export function mountMcp(app: Hono<AppEnv>, options: MountOptions): void {
  const { services, flags } = options;
  const enabled = options.deps?.enabled === true;
  const limiter =
    options.deps?.limiter ?? createTestLimiter({ limit: MCP_RATE_LIMIT, now: services.now });
  const badTokens =
    options.deps?.badTokenLimiter ??
    createLoginLimiter({ max: 60, windowMs: 5 * 60_000, now: services.now });
  const trusted = new Set(
    [safeOrigin(options.publicOrigin), ...(options.trustedOrigins ?? []).map(safeOrigin)].filter(
      (o): o is string => o !== undefined,
    ),
  );

  app.use(
    '/mcp',
    bodyLimit({
      maxSize: MCP_BODY_LIMIT,
      onError: (c) => json(c, 413, { error: 'payload_too_large' }),
    }),
  );

  app.all('/mcp', async (c) => {
    if (!enabled) return json(c, 404, { error: 'not_found' });

    // Browsers send Origin on cross-site requests; an MCP client does not. A foreign origin is refused before anything else.
    const origin = c.req.header('origin');
    if (origin !== undefined && !trusted.has(origin)) return json(c, 403, { error: 'bad_origin' });

    if (c.req.method !== 'POST')
      return json(
        c,
        405,
        {
          error: 'method_not_allowed',
          message: 'This server answers POST only (no server initiated stream, no sessions).',
        },
        { Allow: 'POST' },
      );

    const presented = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    const unauthenticated = () =>
      json(
        c,
        401,
        {
          error: 'invalid_token',
          message: 'Send an API token as "Authorization: Bearer mrm_...".',
        },
        { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
      );
    if (presented === undefined) return unauthenticated();

    const ip = clientIp(c, services.trustProxy);
    const blocked = ip ? badTokens.retryAfter(ip) : 0;
    if (blocked > 0)
      return json(c, 429, { error: 'too_many_attempts' }, { 'Retry-After': String(blocked) });
    const principal = await authenticateToken(services.db, presented, services.now());
    if (!principal) {
      if (ip) badTokens.fail(ip);
      return unauthenticated();
    }
    const wait = limiter.take(principal.tokenId);
    if (wait > 0)
      return json(
        c,
        429,
        {
          error: 'rate_limited',
          message: 'Too many MCP requests for this token.',
          retryAfterSeconds: wait,
        },
        { 'Retry-After': String(wait) },
      );

    const versionHeader = c.req.header('mcp-protocol-version');
    if (
      versionHeader !== undefined &&
      !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(versionHeader)
    ) {
      return json(c, 400, {
        error: 'unsupported_protocol_version',
        supported: [...SUPPORTED_PROTOCOL_VERSIONS],
      });
    }
    if (!(c.req.header('content-type') ?? '').toLowerCase().includes('json'))
      return json(c, 415, { error: 'unsupported_media_type', message: 'Send application/json.' });

    let message: unknown;
    try {
      message = await c.req.json();
    } catch {
      c.header('Cache-Control', 'no-store');
      return c.json(rpcError(null, ERROR_CODES.parse, RPC_MESSAGES.parse), 400);
    }

    const requestOrigin = new URL(c.req.url).origin;
    const ctx: ServerContext = {
      principal,
      flags,
      dispatch: dispatcher(app, c.req.header('host'), requestOrigin, presented),
      origin: options.publicOrigin
        ? (safeOrigin(options.publicOrigin) ?? requestOrigin)
        : requestOrigin,
      version: options.version,
      protocolVersion: versionHeader,
      audit: async (entry) => {
        await runAsToken({ tokenId: principal.tokenId, userId: principal.user.id }, () =>
          recordAudit(services.db, {
            workspaceId: principal.workspaceId,
            actor: { type: 'user', id: principal.user.id },
            action: 'mcp.tool_call',
            ...(entry.appId ? { target: { type: 'app', id: entry.appId } } : {}),
            detail: {
              tool: entry.tool,
              kind: entry.kind,
              ok: entry.ok,
              ...(entry.code ? { code: entry.code } : {}),
              via: 'mcp',
            },
            at: services.now(),
          }),
        );
      },
    };

    c.header('Cache-Control', 'no-store');
    if (Array.isArray(message)) {
      if (message.length === 0 || message.length > MAX_BATCH)
        return c.json(rpcError(null, ERROR_CODES.invalidRequest, RPC_MESSAGES.invalidRequest), 400);
      const answers: JsonRpcResponse[] = [];
      for (const item of message) {
        const answer = await handleMessage(ctx, item);
        if (answer) answers.push(answer);
      }
      return answers.length === 0 ? c.body(null, 202) : c.json(answers);
    }
    const answer = await handleMessage(ctx, message);
    return answer ? c.json(answer) : c.body(null, 202);
  });

  // For the Settings card: admins and owners, with a session (tokens can never call it: `tokens.manage` is closed to them).
  app.get('/api/workspaces/:workspaceId/mcp/status', async (c) => {
    const role = await memberRole(services.db, c.req.param('workspaceId') ?? '', c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, 'tokens.manage')) return c.json({ error: 'forbidden' }, 403);
    return c.json(mcpStatus(enabled, flags));
  });
}

export function mcpStatus(enabled: boolean, flags: McpFlags) {
  return {
    enabled,
    endpoint: '/mcp',
    protocolVersion: LATEST_PROTOCOL_VERSION,
    envName: 'MRM_MCP_ENABLED',
    switches: (Object.keys(FLAG_ENV) as (keyof McpFlags)[]).map((key) => ({
      env: FLAG_ENV[key],
      enabled: flags[key],
    })),
    tools: tools
      .filter((t) => t.kind !== 'meta')
      .map((t) => {
        const operation = operationOf(t);
        return {
          name: t.name,
          title: t.title,
          description: t.description,
          kind: t.kind as 'read' | 'write' | 'preview',
          action:
            operation && typeof operation.access === 'object' ? operation.access.action : null,
          switch: t.flag ? FLAG_ENV[t.flag] : null,
          switchOn: t.flag ? flags[t.flag] : true,
        };
      }),
    preset: {
      name: 'MCP read-only',
      role: 'viewer' as const,
      actions: readOnlyActions(),
      expiresInDays: 90,
    },
  };
}

/**
 * Runs a request against the app itself, as the caller: the same bearer token, no cookie. Everything the API does for a token happens
 * (middleware, the operation allow-list, the role ceiling, app restriction, rate limit, audit attribution), because this IS an API call.
 */
function dispatcher(
  app: Hono<AppEnv>,
  host: string | undefined,
  origin: string,
  token: string,
): Dispatch {
  return async ({ method, path, query, body }): Promise<DispatchResult> => {
    const url = new URL(path, origin);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(name, Array.isArray(value) ? value.join(',') : String(value));
    }
    const headers = new Headers({ authorization: `Bearer ${token}`, accept: 'application/json' });
    if (host) headers.set('host', host);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const request = new Request(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        app.fetch(request),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), CALL_TIMEOUT_MS);
        }),
      ]);
      const text = await response.text();
      if (text.length > MAX_ROUTE_ANSWER)
        return { status: 413, body: { error: 'payload_too_large' } };
      let parsed: unknown = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = {};
      }
      return { status: response.status, body: parsed };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

export type { TokenPrincipal };
