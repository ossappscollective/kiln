import { type Action, can, invitableBy, invitableRoles } from '@mrm/core';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { type AppEnv, parseBody, type Services } from '../http.ts';
import { memberRole, resolveSession, SESSION_TTL_MS } from '../services/accounts.ts';
import {
  acceptInvitation,
  createInvitation,
  hashInvitationToken,
  isUniqueViolation,
  listPendingInvitations,
  previewInvitation,
  revokeInvitation,
} from '../services/invitations.ts';
import { SESSION_COOKIE } from './auth.ts';

const param = (c: Context, name: string) => c.req.param(name) ?? '';

const createBody = z.object({
  email: z.string().trim().email().max(254),
  role: z.enum(invitableRoles),
});

// Both optional here: a signed-in person with a matching email sends neither.
const acceptBody = z.object({
  displayName: z.string().trim().max(100).optional(),
  password: z.string().max(200).optional(),
});

const disabled = (c: Context) =>
  c.json(
    {
      error: 'disabled_in_single_user_mode',
      message: 'Invitations are not available in single-user mode.',
    },
    403,
  );

/** Invitation management for one workspace, mounted under /api/workspaces. */
export function workspaceInvitationRoutes(services: Services) {
  const { db, now, singleUser } = services;
  const app = new Hono<AppEnv>();

  if (singleUser) {
    app.all('/:workspaceId/invitations', disabled);
    app.all('/:workspaceId/invitations/*', disabled);
    return app;
  }

  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, param(c, 'workspaceId'), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };

  app.get('/:workspaceId/invitations', needs('members.manage'), async (c) =>
    c.json({ invitations: await listPendingInvitations(db, param(c, 'workspaceId'), now()) }),
  );

  app.post('/:workspaceId/invitations', needs('members.manage'), async (c) => {
    const body = await parseBody(c, createBody);
    if (!body.ok) return body.response;
    // Admins cannot invite admins; the schema already refuses owners.
    if (!invitableBy(c.get('role')).includes(body.data.role)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const result = await createInvitation(
      db,
      { workspaceId: param(c, 'workspaceId'), ...body.data },
      { id: c.get('user').id, role: c.get('role') },
      now(),
    );
    if (result === 'already_member') return c.json({ error: 'already_member' }, 409);
    if (result === 'already_invited') return c.json({ error: 'already_invited' }, 409);
    // The token is in this response and nowhere else, ever.
    c.header('Cache-Control', 'no-store');
    return c.json(result, 201);
  });

  app.delete('/:workspaceId/invitations/:id', needs('members.manage'), async (c) => {
    const done = await revokeInvitation(
      db,
      { workspaceId: param(c, 'workspaceId'), id: param(c, 'id') },
      { id: c.get('user').id, role: c.get('role') },
      now(),
    );
    return done ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
  });

  return app;
}

/**
 * Public routes for the person holding an invitation link. Every unusable token (unknown,
 * expired, used, revoked) gets the same 404, so nothing says which tokens exist. Attempts are
 * counted per token with the invitation limiter (its own instance, so unknown tokens cannot push
 * login lockouts out of memory), because there is no address to count on behind a proxy;
 * guessing a 256-bit token is hopeless anyway, this stops hammering one link. An attempt is
 * counted before the work and given back when it turns out fine.
 */
export function publicInvitationRoutes(services: Services) {
  const { db, now, inviteLimiter: limiter, singleUser, cost } = services;
  const app = new Hono<AppEnv>();

  if (singleUser) {
    app.all('/*', disabled);
    return app;
  }

  const key = (token: string) => `invite:${hashInvitationToken(token).slice(0, 32)}`;
  /** Counts this attempt. A response when the link is locked, else undefined. */
  const tooMany = (c: Context, token: string) => {
    const wait = limiter.attempt(key(token));
    if (wait <= 0) return undefined;
    c.header('Retry-After', String(wait));
    return c.json({ error: 'too_many_attempts' }, 429);
  };

  app.get('/:token', async (c) => {
    const token = param(c, 'token');
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    const limited = tooMany(c, token);
    if (limited) return limited;
    let preview: Awaited<ReturnType<typeof previewInvitation>>;
    try {
      preview = await previewInvitation(db, token, now());
    } catch (error) {
      limiter.refund(key(token));
      throw error;
    }
    if (!preview) return c.json({ error: 'not_found' }, 404);
    limiter.refund(key(token));
    return c.json(preview);
  });

  app.post('/:token/accept', async (c) => {
    const token = param(c, 'token');
    c.header('Cache-Control', 'no-store');
    const limited = tooMany(c, token);
    if (limited) return limited;
    const body = await parseBody(c, acceptBody);
    if (!body.ok) {
      limiter.refund(key(token));
      return body.response;
    }

    const cookie = getCookie(c, SESSION_COOKIE);
    const signedIn = cookie ? await resolveSession(db, cookie, now()) : undefined;
    const { displayName, password } = body.data;
    if (!signedIn) {
      const issues = [
        ...(displayName ? [] : [{ path: 'displayName', message: 'Enter your name' }]),
        ...((password?.length ?? 0) >= 12
          ? []
          : [{ path: 'password', message: 'Use at least 12 characters' }]),
      ];
      if (issues.length > 0) {
        limiter.refund(key(token));
        return c.json({ error: 'invalid_request', issues }, 400);
      }
    }

    let result: Awaited<ReturnType<typeof acceptInvitation>>;
    try {
      result = await acceptInvitation(
        db,
        token,
        { signedIn, displayName, password },
        { now: now(), cost },
      );
    } catch (error) {
      // Two invitations for one new address accepted at the same moment: the second finds the account.
      limiter.refund(key(token));
      if (isUniqueViolation(error)) return c.json({ error: 'account_exists' }, 409);
      throw error;
    }

    if (!result.ok) {
      // The attempt stays counted: a bad link or a wrong account is what the limit is for.
      switch (result.reason) {
        case 'invalid':
          return c.json({ error: 'not_found' }, 404);
        case 'email_mismatch':
          return c.json({ error: 'email_mismatch' }, 403);
        case 'account_exists':
          return c.json({ error: 'account_exists' }, 409);
        case 'already_member':
          return c.json({ error: 'already_member' }, 409);
      }
    }

    limiter.reset(key(token));
    if (result.sessionToken) {
      const proto =
        c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '');
      setCookie(c, SESSION_COOKIE, result.sessionToken, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: proto === 'https',
        path: '/',
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
      });
    }
    return c.json({ user: result.user, workspaceId: result.workspaceId, role: result.role }, 201);
  });

  return app;
}
