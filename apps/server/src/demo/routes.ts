import type { Database } from '@mrm/db';
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { z } from 'zod';
import { sameOrigin } from '../http.ts';
import { SESSION_COOKIE } from '../routes/auth.ts';
import { SESSION_TTL_MS, createSession } from '../services/accounts.ts';
import { FAIL_CONNECTORS, FAIL_KINDS } from './failures.ts';
import type { DemoWorld } from './world.ts';

/**
 * The demo-only endpoints. They exist only in the demo server (`createDemoRoutes` is mounted by demo/boot.ts, never by
 * `createApp`), under `/demo` and, for the web layer, `/api/demo`.
 */

export const DEMO_USERS = [
  { key: 'owner', email: 'owner@demo.example.com', name: 'Demo Owner', role: 'owner' },
  { key: 'admin', email: 'admin@demo.example.com', name: 'Demo Admin', role: 'admin' },
  { key: 'member', email: 'member@demo.example.com', name: 'Demo Member', role: 'member' },
  { key: 'viewer', email: 'viewer@demo.example.com', name: 'Demo Viewer', role: 'viewer' },
] as const;

export type DemoRoutesDeps = {
  db: Database;
  world: DemoWorld;
  now: () => number;
  reset: () => Promise<void>;
  seededAt: () => number | null;
  save: () => void;
  /** Runs the alert evaluator once at the demo clock (state alerts: a failing sync, a failing credential, ...). */
  evaluateAlerts?: () => Promise<{ checked: number; raised: number; resolved: number }>;
  trustedOrigins: string[];
};

const advanceBody = z.object({ hours: z.number().min(0).max(24 * 90).default(24), outcome: z.enum(['approve', 'reject', 'none']).default('approve') }).strict();
const failBody = z.object({ connector: z.enum(FAIL_CONNECTORS), kind: z.enum(FAIL_KINDS), count: z.number().int().min(1).max(100).default(1) }).strict();

export function createDemoRoutes(deps: DemoRoutesDeps) {
  const app = new Hono();
  app.use('*', sameOrigin(deps.trustedOrigins));

  app.get('/status', async (c) => {
    const ws = (await deps.db.query('SELECT id, name FROM workspaces ORDER BY created_at LIMIT 1'))[0];
    c.header('Cache-Control', 'no-store');
    return c.json({
      demo: true,
      seededAt: deps.seededAt(),
      resetAvailable: true,
      workspace: ws ? { id: String(ws.id), name: String(ws.name) } : null,
      clock: { now: deps.world.now(), skewHours: Math.round((deps.world.skewMs / 3_600_000) * 10) / 10 },
      users: DEMO_USERS.map((u) => ({ key: u.key, role: u.role, login: `/demo/login?as=${u.key}` })),
      failures: deps.world.failures.list(),
      simulated: ['App Store Connect', 'Google Play', 'GitHub', 'translation', 'AI', 'analytics', 'ASO'],
    });
  });

  // Signs in without a password. A GET so a browser can open it; loopback only (the demo server listens on 127.0.0.1).
  app.get('/login', async (c) => {
    const as = c.req.query('as') ?? 'owner';
    const user = DEMO_USERS.find((u) => u.key === as);
    if (!user) return c.json({ error: 'unknown_user', users: DEMO_USERS.map((u) => u.key) }, 404);
    const row = (await deps.db.query('SELECT id FROM users WHERE email = ?', [user.email]))[0];
    if (!row) return c.json({ error: 'not_seeded', message: 'The demo workspace is not ready yet.' }, 503);
    const { token } = await createSession(deps.db, String(row.id), Date.now());
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: false, path: '/', maxAge: Math.floor(SESSION_TTL_MS / 1000) });
    const next = c.req.query('next');
    c.header('Cache-Control', 'no-store');
    if (c.req.query('json') !== undefined) return c.json({ ok: true, user: { key: user.key, role: user.role, email: user.email } });
    return c.redirect(next && next.startsWith('/') && !next.startsWith('//') ? next : '/', 302);
  });

  app.post('/reset', async (c) => {
    await deps.reset();
    return c.json({ ok: true, seededAt: deps.seededAt() });
  });

  app.post('/advance', async (c) => {
    const parsed = advanceBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }, 400);
    const notes = deps.world.advance(parsed.data.hours, parsed.data.outcome);
    deps.save();
    // The clock moved: let the alert evaluator look once, so what the time brought shows up in the inbox and the bell.
    const alerts = deps.evaluateAlerts ? await deps.evaluateAlerts().catch(() => null) : null;
    return c.json({ ok: true, now: deps.world.now(), skewHours: Math.round((deps.world.skewMs / 3_600_000) * 10) / 10, happened: notes, alerts });
  });

  app.post('/fail', async (c) => {
    const parsed = failBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }, 400);
    deps.world.failures.add(parsed.data.connector, parsed.data.kind, parsed.data.count);
    return c.json({ ok: true, failures: deps.world.failures.list() });
  });
  app.delete('/fail', (c) => {
    deps.world.failures.clear();
    return c.json({ ok: true, failures: [] });
  });
  app.get('/fail', (c) => c.json({ failures: deps.world.failures.list(), connectors: FAIL_CONNECTORS, kinds: FAIL_KINDS }));

  return app;
}
