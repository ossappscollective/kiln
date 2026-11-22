import { type Action, can } from '@kiln/core';
import type { Database } from '@kiln/db';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { type AppEnv, parseBody, queryInt } from '../../http.ts';
import { storedLocale } from '../../i18n/user-locale.ts';
import { memberRole } from '../../services/accounts.ts';
import { createTestLimiter, type TestLimiter } from '../../services/credential-tests.ts';
import { alertChannels, alertSeverities, alertTypeIds } from './catalog.ts';
import {
  catalogEntries,
  DEFAULT_INBOX_LIMIT,
  listDeliveries,
  listInbox,
  MAX_DELIVERIES_LIMIT,
  MAX_INBOX_LIMIT,
  markRead,
  sendTestAlert,
  unreadCount,
} from './inbox.ts';
import {
  createMute,
  deleteMute,
  listMutes,
  listPreferences,
  listRuleViews,
  loadUserSettings,
  resetRule,
  saveUserSettings,
  setPreference,
  setRule,
} from './prefs.ts';
import { digestModes } from './time.ts';

import { coded, codingOf } from '../../i18n/problem.ts';
/** Bodies, exported for the operations registry (services/api-operations-alerts.ts). */
export const markReadBody = z
  .object({
    ids: z.array(z.string().min(1).max(100)).max(100).optional(),
    all: z.boolean().optional(),
  })
  .strict()
  .refine((b) => (b.ids !== undefined) !== (b.all === true), {
    message: 'Give either ids or all: true.',
  });
export const settingsBody = z
  .object({
    minSeverity: z.enum(alertSeverities).optional(),
    quietStart: z.number().int().min(0).max(1439).nullable().optional(),
    quietEnd: z.number().int().min(0).max(1439).nullable().optional(),
    timezone: z.string().max(64).nullable().optional(),
    digest: z.enum(digestModes as unknown as [string, ...string[]]).optional(),
    digestHour: z.number().int().min(0).max(23).optional(),
  })
  .strict();
export const preferenceBody = z
  .object({
    appId: z.string().min(1).max(100).nullable().optional(),
    channels: z.array(z.enum(alertChannels)).max(4).nullable(),
  })
  .strict();
export const muteBody = z
  .object({
    appId: z.string().min(1).max(100).nullable().optional(),
    alertType: z
      .enum(alertTypeIds as unknown as [string, ...string[]])
      .nullable()
      .optional(),
    /** Hours from now; leave out to mute until it is turned back on. */
    hours: z
      .number()
      .int()
      .min(1)
      .max(24 * 366)
      .optional(),
  })
  .strict();
export const ruleBody = z
  .object({
    enabled: z.boolean().optional(),
    channels: z.array(z.enum(alertChannels)).max(4).optional(),
    maxPerHour: z.number().int().min(1).max(1000).nullable().optional(),
    params: z.record(z.number().int()).optional(),
  })
  .strict();
export const testBody = z.object({ channel: z.enum(alertChannels) }).strict();

const ALERT_BODY_LIMIT = 8 * 1024;

export type AlertRoutesContext = {
  db: Database;
  now: () => number;
  /** Test alerts per workspace per minute (default 10). */
  limiter?: TestLimiter;
};

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const uid = (c: Context<AppEnv>) => c.get('user').id;

/**
 * Alerts, mounted under /api/workspaces (docs/api/alerts.md). Everyone who may read alerts sees their own inbox and the catalog;
 * members (and above) change their own settings, channels and mutes; admins change the workspace rules and read the whole delivery
 * log. Alerts only tell: nothing here publishes or changes a store.
 */
export function alertRoutes(ctx: AlertRoutesContext) {
  const { db } = ctx;
  const limiter = ctx.limiter ?? createTestLimiter({ now: ctx.now });
  const app = new Hono<AppEnv>();

  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const small = bodyLimit({
    maxSize: ALERT_BODY_LIMIT,
    onError: (c) =>
      c.json({ error: 'payload_too_large', message: 'The request body is too large.' }, 413),
  });
  const failure = (
    c: Context<AppEnv>,
    f: {
      status: 400 | 404;
      error: string;
      message?: string;
      code?: string;
      params?: unknown;
    },
  ) =>
    c.json(
      { error: f.error, ...(f.message ? { message: f.message } : {}), ...codingOf(f) },
      f.status,
    );
  const badQuery = (c: Context<AppEnv>, path: string, max: number) =>
    c.json(
      {
        error: 'invalid_request',
        issues: [{ path, message: `Use a whole number from 1 to ${max}.` }],
      },
      400,
    );

  // ----- what exists -------------------------------------------------------------------------------------
  app.get('/:workspaceId/alerts/catalog', needs('alerts.read'), async (c) => {
    const role = c.get('role');
    const rules = new Map((await listRuleViews(db, ws(c))).map((r) => [r.alertType, r]));
    const catalog = catalogEntries().map((entry) => ({
      ...entry,
      // The audience is who gets it: a person whose role lacks the action never receives it, so the screen can leave it out.
      visible: can(role, entry.audience as Action),
      rule: rules.get(entry.id),
    }));
    return c.json({ catalog });
  });

  // ----- the inbox ---------------------------------------------------------------------------------------------
  app.get('/:workspaceId/alerts/inbox', needs('alerts.read'), async (c) => {
    const limit = queryInt(c.req.query('limit'), {
      fallback: DEFAULT_INBOX_LIMIT,
      max: MAX_INBOX_LIMIT,
    });
    if (limit === undefined) return badQuery(c, 'limit', MAX_INBOX_LIMIT);
    const beforeRaw = c.req.query('before');
    const before =
      beforeRaw === undefined || beforeRaw === ''
        ? undefined
        : /^[0-9]{1,15}$/.test(beforeRaw)
          ? Number(beforeRaw)
          : null;
    if (before === null)
      return c.json(
        {
          error: 'invalid_request',
          issues: [{ path: 'before', message: 'Use an epoch milliseconds number.' }],
        },
        400,
      );
    const result = await listInbox(db, {
      workspaceId: ws(c),
      userId: uid(c),
      unreadOnly: c.req.query('unread') === '1' || c.req.query('unread') === 'true',
      limit,
      ...(before === undefined ? {} : { before }),
    });
    c.header('Cache-Control', 'no-store');
    return c.json({ ...result, now: ctx.now() });
  });

  app.get('/:workspaceId/alerts/unread-count', needs('alerts.read'), async (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ unreadCount: await unreadCount(db, ws(c), uid(c)) });
  });

  // Reading is a state of the person's own inbox, so it needs only the right to read alerts.
  app.post('/:workspaceId/alerts/inbox/read', needs('alerts.read'), small, async (c) => {
    const body = await parseBody(c, markReadBody);
      // The person's own choice (PATCH /api/me); without one the stored English text.
      locale: storedLocale(c.get('user')?.locale) ?? undefined,
    if (!body.ok) return body.response;
    const marked = await markRead(db, {
      workspaceId: ws(c),
      userId: uid(c),
      ...body.data,
      at: ctx.now(),
    });
    return c.json({ marked, unreadCount: await unreadCount(db, ws(c), uid(c)) });
  });

  // ----- a person's own choices --------------------------------------------------------------------------------
  app.get('/:workspaceId/alerts/settings', needs('alerts.read'), async (c) => {
    const [settings, preferences, mutes] = await Promise.all([
      loadUserSettings(db, ws(c), uid(c)),
      listPreferences(db, ws(c), uid(c)),
      listMutes(db, ws(c), uid(c), ctx.now()),
    ]);
    return c.json({ settings, preferences, mutes });
  });

  app.put('/:workspaceId/alerts/settings', needs('alerts.write'), small, async (c) => {
    const body = await parseBody(c, settingsBody);
    if (!body.ok) return body.response;
    const done = await saveUserSettings(ctx, {
      workspaceId: ws(c),
      userId: uid(c),
      settings: body.data as never,
    });
    return done.ok ? c.json({ settings: done.settings }) : failure(c, done);
  });

  app.put(
    '/:workspaceId/alerts/preferences/:alertType',
    needs('alerts.write'),
    small,
    async (c) => {
      const body = await parseBody(c, preferenceBody);
      if (!body.ok) return body.response;
      const done = await setPreference(ctx, {
        workspaceId: ws(c),
        userId: uid(c),
        alertType: param(c, 'alertType'),
        appId: body.data.appId ?? null,
        channels: body.data.channels,
      });
      return done.ok ? c.json({ preference: done.preference }) : failure(c, done);
    },
  );

  app.post('/:workspaceId/alerts/mutes', needs('alerts.write'), small, async (c) => {
    const body = await parseBody(c, muteBody);
    if (!body.ok) return body.response;
    const done = await createMute(ctx, {
      workspaceId: ws(c),
      userId: uid(c),
      appId: body.data.appId ?? null,
      alertType: body.data.alertType ?? null,
      until: body.data.hours === undefined ? null : ctx.now() + body.data.hours * 3_600_000,
    });
    return done.ok ? c.json({ mute: done.mute }, 201) : failure(c, done);
  });

  app.delete('/:workspaceId/alerts/mutes/:id', needs('alerts.write'), async (c) => {
    const done = await deleteMute(db, { workspaceId: ws(c), userId: uid(c), id: param(c, 'id') });
    return done ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
  });

  // ----- the workspace rules (admins) ----------------------------------------------------------------------------
  app.put('/:workspaceId/alerts/rules/:alertType', needs('alerts.manage'), small, async (c) => {
    const body = await parseBody(c, ruleBody);
    if (!body.ok) return body.response;
    const done = await setRule(
      ctx,
      { workspaceId: ws(c), alertType: param(c, 'alertType'), rule: body.data },
      { type: 'user', id: uid(c) },
    );
    return done.ok ? c.json({ rule: done.rule }) : failure(c, done);
  });

  app.delete('/:workspaceId/alerts/rules/:alertType', needs('alerts.manage'), async (c) => {
    const done = await resetRule(
      ctx,
      { workspaceId: ws(c), alertType: param(c, 'alertType') },
      { type: 'user', id: uid(c) },
    );
    return done.ok ? c.json({ rule: done.rule }) : failure(c, done);
  });

  // ----- the delivery log --------------------------------------------------------------------------------------
  app.get('/:workspaceId/alerts/deliveries', needs('alerts.read'), async (c) => {
    const limit = queryInt(c.req.query('limit'), { fallback: 30, max: MAX_DELIVERIES_LIMIT });
    if (limit === undefined) return badQuery(c, 'limit', MAX_DELIVERIES_LIMIT);
    const workspaceWide = c.req.query('scope') === 'workspace';
    if (workspaceWide && !can(c.get('role'), 'alerts.manage'))
      return c.json({ error: 'forbidden' }, 403);
    return c.json({
      deliveries: await listDeliveries(db, {
        workspaceId: ws(c),
        limit,
        ...(workspaceWide ? {} : { userId: uid(c) }),
      }),
    });
  });

  // ----- send a test ---------------------------------------------------------------------------------------------
  app.post('/:workspaceId/alerts/test', needs('alerts.write'), small, async (c) => {
    const body = await parseBody(c, testBody);
    if (!body.ok) return body.response;
    const wait = limiter.take(ws(c));
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return c.json(
        {
          error: 'rate_limited',
          message: `Too many tests. Try again in ${wait} seconds.`,
          ...coded('rate.tests', { count: wait }),
          retryAfterSeconds: wait,
        },
        429,
      );
    }
    const done = await sendTestAlert(ctx, {
      workspaceId: ws(c),
      userId: uid(c),
      role: c.get('role'),
      channel: body.data.channel,
    });
    if (!done.ok)
      return c.json(
        { error: done.error, ...(done.message ? { message: done.message } : {}), ...codingOf(done) },
        done.status,
      );
    return c.json({ alertId: done.alertId, deliveries: done.deliveries }, 202);
  });

  return app;
}
