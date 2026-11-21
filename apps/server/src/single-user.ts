import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

/**
 * Single-user mode (desktop app). See docs/adr/0003-single-user-mode.md.
 *
 * There is no password. The desktop shell starts the server with a random launch secret, then
 * opens the window at /api/auth/launch?secret=... which trades the secret for a session cookie.
 */

/**
 * The only user single-user mode has. It has no password hash, so it can never log in. The address keeps
 * the working-title name on purpose: the user is found by it, so changing it would create a second user
 * next to the one that owns an existing desktop workspace.
 */
export const LOCAL_USER_EMAIL = 'local-user@mrm.invalid';

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** Constant-time string comparison. Hashing first makes both sides the same length. */
export function secretsMatch(candidate: string, expected: string): boolean {
  return timingSafeEqual(sha256(candidate), sha256(expected));
}

export type LaunchGate = {
  /**
   * Checks the candidate and, when it is right, spends the secret in the same synchronous step,
   * so two concurrent requests cannot both win. Returns false for a wrong or already spent secret.
   */
  consume(candidate: string): boolean;
  /** Gives the secret back after a server-side failure that happened before a session existed. */
  restore(): void;
  readonly spent: boolean;
};

/** Holds the launch secret for the life of the process. The secret is never logged or exposed. */
export function createLaunchGate(secret: string): LaunchGate {
  let spent = false;
  return {
    consume(candidate) {
      // Always compare, so a spent secret costs the same as a wrong one.
      const matches = secretsMatch(candidate, secret);
      if (!matches || spent) return false;
      spent = true;
      return true;
    },
    restore() {
      spent = false;
    },
    get spent() {
      return spent;
    },
  };
}

/** Host header values a browser may use to reach a local server on `port`. */
export function allowedHosts(port: number): string[] {
  return [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
}

const LOOPBACK_WITH_PORT = /^(localhost|127\.0\.0\.1|\[::1\]):([0-9]{1,5})$/;

/**
 * Parses KILN_ALLOWED_HOSTS: extra Host values to accept, for a dev server in front of the API
 * (Vite on localhost:5173 forwards its own Host). Each entry must be a loopback name with an
 * explicit port. Anything else would let a rebound DNS name through, so it is an error, not a
 * warning. Returns the lowercased entries.
 */
export function parseExtraHosts(list: string): string[] {
  const hosts: string[] = [];
  for (const raw of list.split(',')) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    const match = LOOPBACK_WITH_PORT.exec(entry);
    const port = Number(match?.[2]);
    if (!match || port < 1 || port > 65535) {
      throw new Error(
        `KILN_ALLOWED_HOSTS entry "${raw.trim()}" must be localhost, 127.0.0.1 or [::1] with a port, for example localhost:5173`,
      );
    }
    hosts.push(entry);
  }
  return hosts;
}

/**
 * Refuses any request whose Host is not this machine on this port. A page on evil.example that
 * rebinds its DNS name to 127.0.0.1 still sends `Host: evil.example:PORT`, so it gets nothing.
 * Proxy headers are refused too: nothing may sit in front of a single-user server, and the
 * same-origin check would otherwise trust X-Forwarded-Host.
 */
export function hostGuard(port: number, extraHosts: string[] = []): MiddlewareHandler {
  const allowed = new Set([...allowedHosts(port), ...extraHosts]);
  return async (c, next) => {
    const host = (c.req.header('host') ?? new URL(c.req.url).host).toLowerCase();
    if (!allowed.has(host) || c.req.header('x-forwarded-host')) {
      return c.json({ error: 'bad_host' }, 403);
    }
    return next();
  };
}
