import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { type AppEnv, type Services, parseBody } from '../http.ts';
import {
  SESSION_TTL_MS,
  countUsers,
  createSession,
  endSession,
  ensureLocalUser,
  listWorkspaces,
  normalizeEmail,
  registerFirstUser,
  resolveSession,
  verifyLogin,
} from '../services/accounts.ts';
import { LOCAL_USER_EMAIL } from '../single-user.ts';

export const SESSION_COOKIE = 'mrm_session';

const registerBody = z.object({
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(12, 'Use at least 12 characters').max(200),
  workspaceName: z.string().trim().min(1).max(100),
});

const loginBody = z.object({ email: z.string().max(254), password: z.string().max(200) });

export function authRoutes(services: Services) {
  const { db, now, limiter, singleUser } = services;
  const app = new Hono<AppEnv>();

  // Single-user mode has no passwords. Sessions come only from /launch. These handlers answer
  // first, so the real register, login and logout below are unreachable in that mode.
  if (singleUser) {
    const disabled = (c: import('hono').Context) =>
      c.json(
        {
          error: 'disabled_in_single_user_mode',
          message: 'This server is in single-user mode. Open the app from the desktop shell.',
        },
        403,
      );
    app.post('/register', disabled);
    app.post('/login', disabled);
    app.post('/logout', disabled);
  }

  const startSession = async (c: Parameters<typeof setCookie>[0], userId: string) => {
    const { token } = await createSession(db, userId, now());
    const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '');
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: proto === 'https',
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
  };

  // Tells the UI which screen to show. Public, and reveals nothing beyond "is there an account".
  app.get('/status', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    const user = token ? await resolveSession(db, token, now()) : undefined;
    if (singleUser) return c.json({ mode: 'single_user', setupRequired: false, user: user ?? null });
    return c.json({ mode: 'multi', setupRequired: (await countUsers(db)) === 0, user: user ?? null });
  });

  // Single-user mode only: trades the launch secret for a session cookie, once.
  // GET because the desktop shell opens it as a plain navigation. The secret is in the query
  // string, so the response is never cached, sends no Referer, and redirects at once so the
  // secret does not stay in the address bar or history. Nothing here logs the URL.
  if (singleUser) {
    app.get('/launch', async (c) => {
      c.header('Cache-Control', 'no-store');
      c.header('Referrer-Policy', 'no-referrer');
      const { gate } = singleUser;
      if (!gate.consume(c.req.query('secret') ?? '')) {
        return c.json({ error: 'invalid_launch_secret' }, 403);
      }
      try {
        const local = await ensureLocalUser(db, { email: LOCAL_USER_EMAIL, now: now() });
        if (local === 'not_a_single_user_database') {
          gate.restore();
          return c.json({ error: 'not_a_single_user_database' }, 409);
        }
        await startSession(c, local.user.id);
      } catch (error) {
        gate.restore();
        throw error;
      }
      return c.redirect('/', 302);
    });
  }

  app.post('/register', async (c) => {
    const body = await parseBody(c, registerBody);
    if (!body.ok) return body.response;
    const result = await registerFirstUser(db, body.data, { now: now(), cost: services.cost });
    if (result === 'already_set_up') return c.json({ error: 'registration_closed' }, 403);
    await startSession(c, result.user.id);
    return c.json({ user: result.user, workspaceId: result.workspaceId }, 201);
  });

  app.post('/login', async (c) => {
    const body = await parseBody(c, loginBody);
    if (!body.ok) return body.response;
    const key = normalizeEmail(body.data.email);
    const wait = limiter.retryAfter(key);
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return c.json({ error: 'too_many_attempts' }, 429);
    }
    const user = await verifyLogin(db, body.data.email, body.data.password);
    if (!user) {
      limiter.fail(key);
      return c.json({ error: 'invalid_credentials' }, 401);
    }
    limiter.reset(key);
    await startSession(c, user.id);
    return c.json({ user });
  });

  app.post('/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await endSession(db, token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.body(null, 204);
  });

  return app;
}

/** Resolves the session cookie to a user, or answers 401. */
export function requireUser(services: Services) {
  return async (c: import('hono').Context<AppEnv>, next: import('hono').Next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const user = token ? await resolveSession(services.db, token, services.now()) : undefined;
    if (!user) return c.json({ error: 'unauthenticated' }, 401);
    c.set('user', user);
    return next();
  };
}

export function meRoute(services: Services) {
  const app = new Hono<AppEnv>();
  app.get('/', async (c) => {
    const user = c.get('user');
    return c.json({ user, workspaces: await listWorkspaces(services.db, user.id) });
  });
  return app;
}
