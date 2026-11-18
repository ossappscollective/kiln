import { getConnInfo } from '@hono/node-server/conninfo';
import type { Role } from '@mrm/core';
import type { Context, MiddlewareHandler } from 'hono';
import type { z } from 'zod';
import type { User } from './services/accounts.ts';

export type AppEnv = {
  Variables: {
    user: User;
    role: Role;
    /** Set only when the request was authenticated with an API token (see bearer.ts). */
    token?: import('./services/tokens.ts').TokenPrincipal;
  };
};

/** Everything the routes need, injected so tests can control the clock and the cost. */
export type Services = {
  db: import('@mrm/db').Database;
  masterKey: Buffer;
  now: () => number;
  /** Failed logins per email address. */
  limiter: import('./limiter.ts').LoginLimiter;
  /** Failed logins per client address; looser than `limiter`. */
  ipLimiter: import('./limiter.ts').LoginLimiter;
  /** Bad attempts per invitation link. Its own instance: unknown tokens must not push out login lockouts. */
  inviteLimiter: import('./limiter.ts').LoginLimiter;
  /** Believe X-Forwarded-For (MRM_TRUST_PROXY=1). Only safe behind a proxy that sets it. */
  trustProxy?: boolean;
  cost?: import('./passwords.ts').ScryptCost;
  /** Present only in single-user mode. Its absence is what keeps multi-user mode unchanged. */
  singleUser?: { gate: import('./single-user.ts').LaunchGate };
};

export type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

/** Reads a JSON body and validates it. On failure the response is ready to return. */
export async function parseBody<S extends z.ZodTypeAny>(
  c: Context,
  schema: S,
): Promise<Parsed<z.infer<S>>> {
  const raw = await c.req.json().catch(() => undefined);
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    response: c.json(
      {
        error: 'invalid_request',
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    ),
  };
}

/**
 * Browsers send Origin on every cross-site POST. A state-changing request whose Origin is not
 * this server is refused, which stops cross-site form posts and fetches even if a cookie rides
 * along. Requests without an Origin (curl, the CLI, server to server) pass; they carry no ambient
 * browser cookie to abuse. Extra origins, for example a dev server, come from `trusted`.
 */
export function sameOrigin(trusted: string[] = []): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    // A bearer token with no session cookie is not ambient: a browser never adds it on its own, so
    // a cross-site page cannot ride on it. Any request that carries the session cookie keeps the
    // check below, whatever else it carries.
    if (isBearerOnly(c)) return next();
    const origin = c.req.header('origin');
    if (!origin) return next();
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      return c.json({ error: 'bad_origin' }, 403);
    }
    const own = c.req.header('x-forwarded-host') ?? c.req.header('host');
    if (host === own || trusted.includes(origin)) return next();
    return c.json({ error: 'bad_origin' }, 403);
  };
}

/** The session cookie's name, repeated here so this file needs nothing from the routes (a test pins it). */
export const SESSION_COOKIE_NAME = 'mrm_session';
const SESSION_COOKIE_PRESENT = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=`);

/**
 * True for a request that authenticates with `Authorization: Bearer` and carries no session cookie.
 * Only the presence of the cookie matters, not whether it is valid: an invalid cookie still means a
 * browser is involved.
 */
export function isBearerOnly(c: Context): boolean {
  if (SESSION_COOKIE_PRESENT.test(c.req.header('cookie') ?? '')) return false;
  return /^Bearer\s+\S+$/i.test(c.req.header('authorization') ?? '');
}

/**
 * The address of the client, for rate limiting. It is the socket address, unless `trustProxy` is
 * set (MRM_TRUST_PROXY=1): then the last X-Forwarded-For entry, which is the one the single
 * trusted proxy appended itself. Earlier entries are written by the client and are ignored.
 * Undefined when there is no socket (in-process tests): callers then skip address limiting.
 */
export function clientIp(c: Context, trustProxy = false): string | undefined {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for');
    const last = forwarded?.split(',').pop()?.trim();
    if (last) return last.slice(0, 64);
  }
  try {
    return getConnInfo(c).remote.address || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A query parameter as a whole number from 1 to `max`. Absent or empty gives `fallback`; anything
 * else (1.5, 0, -3, abc, 1e3, 0x10, a number above `max`) gives undefined, for a 400.
 */
export function queryInt(raw: string | undefined, options: { fallback: number; max: number }): number | undefined {
  if (raw === undefined || raw === '') return options.fallback;
  if (!/^[0-9]{1,9}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= 1 && n <= options.max ? n : undefined;
}
