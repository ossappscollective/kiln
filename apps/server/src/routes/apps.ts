import { isPlayPackageName } from '@mrm/connectors';
import { type Action, can } from '@mrm/core';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Context, Next } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody } from '../http.ts';
import { memberRole } from '../services/accounts.ts';
import {
  type AppsContext,
  checkIdentifier,
  deleteApp,
  discoverApps,
  enqueueAppSync,
  getApp,
  importApps,
  MAX_IMPORT_ITEMS,
  listAppReleases,
  listApps,
  registerApp,
  syncApp,
} from '../services/apps.ts';
import { type TestLimiter } from '../services/credential-tests.ts';
import type { Failure } from '../services/repositories.ts';

export type AppRoutesContext = AppsContext & {
  /** Syncs per workspace per minute (default 10, built in createApp). */
  limiter: TestLimiter;
};

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });

const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

const registerBody = z
  .object({
    platform: z.enum(['ios', 'android']),
    identifier: z.string().trim().min(1).max(255),
    credentialId: z.string().min(1).max(100),
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[^\r\n]+$/, 'One line, please.')
      .optional(),
    repositoryId: z.string().min(1).max(100).optional(),
  })
  .superRefine((value, ctx) => {
    const problem = checkIdentifier(value.platform, value.identifier);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['identifier'], message: problem });
  });

const discoverBody = z
  .object({
    credentialId: z.string().min(1).max(100),
    /** Google Play only: the package names to verify. Ignored for App Store Connect. */
    packages: z.array(z.string().trim().min(1).max(255)).min(1).max(MAX_IMPORT_ITEMS).optional(),
  })
  .superRefine((value, ctx) => {
    value.packages?.forEach((name, index) => {
      if (!isPlayPackageName(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['packages', index],
          message: checkIdentifier('android', name) ?? 'Not an Android package name.',
        });
      }
    });
  });

const importItem = z
  .object({
    platform: z.enum(['ios', 'android']),
    identifier: z.string().trim().min(1).max(255),
    storeAppId: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9._-]+$/, 'Letters, digits, dots, hyphens and underscores only.')
      .optional(),
    name: z.string().trim().max(100).optional(),
    repositoryId: z.string().min(1).max(100).optional(),
  })
  .superRefine((value, ctx) => {
    const problem = checkIdentifier(value.platform, value.identifier);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['identifier'], message: problem });
  });

const importBody = z.object({
  credentialId: z.string().min(1).max(100),
  items: z.array(importItem).min(1).max(MAX_IMPORT_ITEMS),
});

/** The two discovery bodies are small: 50 package names or items fit well inside these. */
const DISCOVER_BODY_LIMIT = 16 * 1024;
const IMPORT_BODY_LIMIT = 32 * 1024;

/** App and store sync routes. Mounted under /api/workspaces. */
export function appRoutes(ctx: AppRoutesContext) {
  const { db } = ctx;
  const app = new Hono<AppEnv>();

  /** Not a member and no such workspace look the same (404). A member without the right gets 403. */
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const notFound = (c: Context<AppEnv>) => c.json({ error: 'not_found' }, 404);

  app.get('/:workspaceId/apps', needs('apps.read'), async (c) =>
    c.json({ apps: await listApps(db, ws(c)) }),
  );

  app.post('/:workspaceId/apps', needs('apps.write'), async (c) => {
    const body = await parseBody(c, registerBody);
    if (!body.ok) return body.response;
    const done = await registerApp(ctx, { workspaceId: ws(c), ...body.data }, actor(c));
    return done.ok ? c.json({ app: done.app }, 201) : respond(c, done);
  });

  const tooLarge = (c: Context) =>
    c.json({ error: 'payload_too_large', message: 'The request body is too large.' }, 413);

  // Reads the store with the credential, so it shares the per-workspace budget of syncs.
  app.post(
    '/:workspaceId/apps/discover',
    needs('apps.write'),
    bodyLimit({ maxSize: DISCOVER_BODY_LIMIT, onError: tooLarge }),
    async (c) => {
      const body = await parseBody(c, discoverBody);
      if (!body.ok) return body.response;
      const done = await discoverApps(
        ctx,
        { workspaceId: ws(c), ...body.data },
        actor(c),
        (key) => ctx.limiter.take(key),
      );
      return done.ok ? c.json(done.discovery) : respond(c, done);
    },
  );

  app.post(
    '/:workspaceId/apps/import',
    needs('apps.write'),
    bodyLimit({ maxSize: IMPORT_BODY_LIMIT, onError: tooLarge }),
    async (c) => {
      const body = await parseBody(c, importBody);
      if (!body.ok) return body.response;
      const done = await importApps(ctx, { workspaceId: ws(c), ...body.data }, actor(c));
      return done.ok ? c.json({ results: done.results, summary: done.summary }) : respond(c, done);
    },
  );

  app.get('/:workspaceId/apps/:id', needs('apps.read'), async (c) => {
    const found = await getApp(db, ws(c), param(c, 'id'));
    if (!found) return notFound(c);
    return c.json({ app: found, releases: await listAppReleases(db, ws(c), found.id) });
  });

  app.delete('/:workspaceId/apps/:id', needs('apps.write'), async (c) => {
    const done = await deleteApp(ctx, { workspaceId: ws(c), id: param(c, 'id') }, actor(c));
    return done ? c.body(null, 204) : notFound(c);
  });

  app.post('/:workspaceId/apps/:id/sync', needs('apps.sync'), async (c) => {
    const id = param(c, 'id');
    // An unknown id is a 404 and costs no slot; a known one is counted before any decrypting or
    // network call.
    if (!(await getApp(db, ws(c), id))) return notFound(c);
    const wait = ctx.limiter.take(ws(c));
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return c.json(
        {
          error: 'rate_limited',
          message: `Too many syncs. Try again in ${wait} seconds.`,
          retryAfterSeconds: wait,
        },
        429,
      );
    }
    if (c.req.query('background') === 'true') {
      const jobId = await enqueueAppSync(ctx, {
        workspaceId: ws(c),
        appId: id,
        requestedBy: c.get('user').id,
      });
      return c.json({ jobId }, 202);
    }
    const done = await syncApp(ctx, { workspaceId: ws(c), id }, actor(c));
    if (!done.ok) return respond(c, done);
    return c.json({ app: done.app, releases: done.releases, sync: done.sync });
  });

  return app;
}
