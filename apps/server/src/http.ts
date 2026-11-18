import type { Role } from '@mrm/core';
import type { Context, MiddlewareHandler } from 'hono';
import type { z } from 'zod';
import type { User } from './services/accounts.ts';

export type AppEnv = { Variables: { user: User; role: Role } };

/** Everything the routes need, injected so tests can control the clock and the cost. */
export type Services = {
  db: import('@mrm/db').Database;
  masterKey: Buffer;
  now: () => number;
  limiter: import('./limiter.ts').LoginLimiter;
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
