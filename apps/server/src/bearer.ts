import { canToken, lowerRole, type Role } from '@kiln/core';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { type AppEnv, clientIp, type Services } from './http.ts';
import { createLoginLimiter, type LoginLimiter } from './limiter.ts';
import { compilePath, tokenAllowedFor } from './operations/openapi.ts';
import { operations } from './operations/registry.ts';
import { requireUser, SESSION_COOKIE } from './routes/auth.ts';
import { runAsToken } from './services/audit.ts';
import { createTestLimiter, type TestLimiter } from './services/credential-tests.ts';
import { authenticateToken, type TokenPrincipal, touchToken } from './services/tokens.ts';

/**
 * Authentication for `/api/workspaces/*` and `/api/openapi.json`: the session cookie, as before, or
 * `Authorization: Bearer kiln_...`.
 *
 * - A request that carries the session cookie goes through `requireUser` exactly as it always did.
 *   A bearer header next to a cookie is ignored, so the bearer path can never change how cookies
 *   are handled (and `sameOrigin` still applies to them, see http.ts).
 * - A request with a bearer header and no cookie is checked here: the token, its workspace, and
 *   what it may do. What it may do comes from the operation registry (api-operations.ts): the
 *   route must be listed, tokens must be allowed to call it, the role ceiling and the token's
 *   action list must allow it, and an app restricted token must stay inside its apps. A route that
 *   is not listed cannot be called with a token.
 * - Tokens have their own rate limit, and bad tokens count against the client address.
 * - Everything the request writes to the audit log is attributed to the token (audit.ts), and any
 *   role a route reads for the request is capped at the token's ceiling.
 */

/** Requests per token per minute. */
export const TOKEN_RATE_LIMIT = 300;
/** Bad tokens per client address per 5 minutes before it is refused for the rest of the window. */
export const BAD_TOKEN_LIMIT = 60;

export type BearerOptions = {
  /** Default: 300 requests per minute per token. */
  limiter?: TestLimiter;
  /** Default: 60 bad tokens per 5 minutes per client address. */
  badTokenLimiter?: LoginLimiter;
};

const compiled = operations.map((op) => ({
  op,
  match: compilePath(op.path),
  method: op.method.toUpperCase(),
}));

/** The operation a request is for, with its path parameters. */
export function findOperation(method: string, path: string) {
  for (const entry of compiled) {
    if (entry.method !== method) continue;
    const params = entry.match(path);
    if (params) return { op: entry.op, params };
  }
  return undefined;
}

const deny = (
  c: Context,
  status: 401 | 403 | 404 | 429,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) => {
  for (const [name, value] of Object.entries(headers)) c.header(name, value);
  return c.json(body, status);
};

export function requireAuth(
  services: Services,
  options: BearerOptions = {},
): MiddlewareHandler<AppEnv> {
  const cookieAuth = requireUser(services);
  const limiter =
    options.limiter ?? createTestLimiter({ limit: TOKEN_RATE_LIMIT, now: services.now });
  const badTokens =
    options.badTokenLimiter ??
    createLoginLimiter({ max: BAD_TOKEN_LIMIT, windowMs: 5 * 60_000, now: services.now });

  return async (c: Context<AppEnv>, next: Next) => {
    if (getCookie(c, SESSION_COOKIE)) return cookieAuth(c, next);
    const header = c.req.header('authorization') ?? '';
    const presented = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    if (presented === undefined) return cookieAuth(c, next);

    const ip = clientIp(c, services.trustProxy);
    const blocked = ip ? badTokens.retryAfter(ip) : 0;
    if (blocked > 0)
      return deny(c, 429, { error: 'too_many_attempts' }, { 'Retry-After': String(blocked) });

    const principal = await authenticateToken(services.db, presented, services.now());
    if (!principal) {
      if (ip) badTokens.fail(ip);
      return deny(
        c,
        401,
        {
          error: 'invalid_token',
          message: 'The API token is not valid. It may be revoked or expired.',
        },
        {
          'WWW-Authenticate': 'Bearer error="invalid_token"',
        },
      );
    }

    const wait = limiter.take(principal.tokenId);
    if (wait > 0) {
      return deny(
        c,
        429,
        {
          error: 'rate_limited',
          message: `Too many requests for this token. Try again in ${wait} seconds.`,
          retryAfterSeconds: wait,
        },
        {
          'Retry-After': String(wait),
        },
      );
    }

    const refusal = check(c, principal);
    if (refusal) return refusal;

    await touchToken(services.db, principal.tokenId, services.now());
    c.set('user', principal.user);
    c.set('token', principal);
    capRole(c, principal.ceiling);
    await runAsToken({ tokenId: principal.tokenId, userId: principal.user.id }, () => next());
    await filterApps(c, principal);
  };
}

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Whether the token may make this request. Returns the refusal when it may not. */
function check(c: Context<AppEnv>, principal: TokenPrincipal): Response | undefined {
  const path = c.req.path;
  const workspace = /^\/api\/workspaces\/([^/]+)(?:\/|$)/.exec(path)?.[1];
  // Another workspace looks like no workspace at all.
  if (workspace !== undefined && safeDecode(workspace) !== principal.workspaceId) {
    return c.json({ error: 'not_found' }, 404);
  }
  const found = findOperation(c.req.method, path);
  if (!found || !tokenAllowedFor(found.op)) {
    return c.json(
      {
        error: 'token_not_allowed',
        message: 'API tokens cannot call this endpoint. Use a signed-in session.',
      },
      403,
    );
  }
  const { op, params } = found;
  if (
    typeof op.access === 'object' &&
    !canToken(principal.ceiling, principal.actions, op.access.action)
  ) {
    return c.json({ error: 'forbidden', message: 'This token does not allow that.' }, 403);
  }
  // Workspace wide endpoints are closed to an app restricted token. The OpenAPI document is not in a workspace.
  if (principal.appIds !== null && workspace !== undefined) {
    const scope = op.appScope;
    if (!scope) {
      return c.json(
        {
          error: 'forbidden',
          message: 'This token is limited to some apps; this endpoint is workspace wide.',
        },
        403,
      );
    }
    if (scope.kind === 'param' && !principal.appIds.includes(params[scope.name] ?? '')) {
      return c.json({ error: 'not_found' }, 404);
    }
  }
  return undefined;
}

/**
 * Whatever role a route stores for the request (`c.set('role', ...)`, after it looked the person
 * up) is lowered to the token's ceiling, so the route's own decisions ("may this person discard
 * anyone's draft?") see the token's rights and not those of the person behind it.
 */
function capRole(c: Context<AppEnv>, ceiling: Role): void {
  const set = c.set.bind(c) as (key: string, value: unknown) => void;
  (c as unknown as { set: (key: string, value: unknown) => void }).set = (key, value) =>
    set(key, key === 'role' ? lowerRole(value as Role, ceiling) : value);
}

/** A token limited to some apps sees only those in the list of apps (an entry is an app or `{ app }`). */
async function filterApps(c: Context<AppEnv>, principal: TokenPrincipal): Promise<void> {
  if (principal.appIds === null) return;
  const found = findOperation(c.req.method, c.req.path);
  if (found?.op.appScope?.kind !== 'list' || !c.res.ok) return;
  const body = (await c.res
    .clone()
    .json()
    .catch(() => undefined)) as { apps?: { id?: string; app?: { id?: string } }[] } | undefined;
  if (!body || !Array.isArray(body.apps)) return;
  const allowed = new Set(principal.appIds);
  const headers = new Headers(c.res.headers);
  headers.delete('content-length');
  c.res = new Response(
    JSON.stringify({
      ...body,
      apps: body.apps.filter((a) => allowed.has(String(a.id ?? a.app?.id))),
    }),
    {
      status: c.res.status,
      headers,
    },
  );
}
