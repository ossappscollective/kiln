import { type Action, can } from '@kiln/core';
import type { Database } from '@kiln/db';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { type AppEnv, parseBody, queryInt } from '../../http.ts';
import { memberRole } from '../../services/accounts.ts';
import {
  getAppListingSettings,
  readAppListingSettings,
  updateAppListingSettings,
} from '../../services/app-listing-settings.ts';
import { type AppsContext, getApp, syncApp } from '../../services/apps.ts';
import type { TestLimiter } from '../../services/credential-tests.ts';
import type { Failure, RepoContext } from '../../services/repositories.ts';
import { isListingField } from './drift.ts';
import {
  getDrift,
  getHistory,
  getLiveListing,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  parseHistoryCursor,
} from './live.ts';
import { pullStoreListing } from './pull.ts';
import { recordAppliedChangeSets, refreshRepoListing } from './repo.ts';

import { coded } from '../../i18n/problem.ts';
export type ListingRoutesContext = {
  db: Database;
  now: () => number;
  /** Used only to read the repository side of an app's listing (GitHub, read-only). */
  repo: RepoContext;
  /** Repository reads per workspace per minute. Its own budget, like the sync's. */
  limiter: TestLimiter;
  /**
   * The store read of `POST .../listing/pull` with `refresh: true`: the app sync's own context and
   * its own per workspace budget (the same instance the sync route uses). Without it, `refresh` is refused.
   */
  sync?: { apps: AppsContext; limiter: TestLimiter };
  /** KILN_LISTING_INTERVAL_MINUTES in milliseconds (0 or absent: off), so the Listing tab can say when the next read is due. */
  listingIntervalMs?: number;
};

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });

const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

const LOCALE = /^[A-Za-z0-9_-]{1,35}$/;

/** A pull body is a list of fields and locales: a few kilobytes at most. */
const listingSettingsBody = z
  .object({ compareRepo: z.boolean().optional(), compareMedia: z.boolean().optional() })
  .strict();

const PULL_BODY_LIMIT = 64 * 1024;
const MAX_PULL_LOCALES = 100;
const MAX_PULL_ITEMS = 1000;
const localeCode = z.string().regex(LOCALE, 'Not a locale code.');
const folderText = z.string().max(400);
const pullBody = z
  .object({
    channel: z.enum(['live', 'editable']).optional(),
    locales: z.array(localeCode).max(MAX_PULL_LOCALES).optional(),
    fields: z.array(z.string().min(1).max(40)).max(20).optional(),
    items: z
      .array(z.object({ locale: localeCode, field: z.string().min(1).max(40) }).strict())
      .max(MAX_PULL_ITEMS)
      .optional(),
    addLocales: z.boolean().optional(),
    summary: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\r\n]+$/, 'One line, please.')
      .optional(),
    refresh: z.boolean().optional(),
    target: z.string().min(1).max(200).optional(),
    roots: z
      .object({ appStore: folderText.optional(), googlePlay: folderText.optional() })
      .strict()
      .optional(),
  })
  .default({});

/**
 * Live listing, drift and history of an app's store listing. Everything here reads the tool's own
 * database, except `repo-refresh`, which reads the repository on GitHub. No route writes to a store,
 * and none changes the store listing in any way. Mounted under /api/workspaces.
 */
export function listingRoutes(ctx: ListingRoutesContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();

  /** Not a member and no such workspace look the same (404). A member without the right gets 403. */
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const notFound = (c: Context<AppEnv>) => c.json({ error: 'not_found' }, 404);

  routes.get('/:workspaceId/apps/:id/listing/live', needs('listing.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    return c.json(await getLiveListing(db, ws(c), app, { intervalMs: ctx.listingIntervalMs ?? 0 }));
  });

  routes.get('/:workspaceId/apps/:id/listing/drift', needs('listing.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    // Derived data: change sets applied since the last look. A failure here must not hide the rest.
    await recordAppliedChangeSets(db, ws(c), app, ctx.now()).catch(() => 0);
    // The repository is compared only when the app's listing settings say so (default: off, store checks only).
    const settings = await readAppListingSettings(db, ws(c), app.id);
    return c.json(
      await getDrift(db, ws(c), app, {
        compareRepo: settings.compareRepo,
        compareMedia: settings.compareMedia,
      }),
    );
  });

  routes.get('/:workspaceId/apps/:id/listing-settings', needs('apps.read'), async (c) => {
    const done = await getAppListingSettings(db, { workspaceId: ws(c), appId: param(c, 'id') });
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ settings: done.settings }) : respond(c, done);
  });

  routes.put('/:workspaceId/apps/:id/listing-settings', needs('apps.write'), async (c) => {
    const body = await parseBody(c, listingSettingsBody);
    if (!body.ok) return body.response;
    const done = await updateAppListingSettings(
      db,
      { workspaceId: ws(c), appId: param(c, 'id'), changes: body.data, actor: actor(c) },
      ctx.now(),
    );
    return done.ok ? c.json({ settings: done.settings, changed: done.changed }) : respond(c, done);
  });

  routes.get('/:workspaceId/apps/:id/listing/history', needs('listing.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const issues: { path: string; message: string }[] = [];
    const locale = c.req.query('locale');
    const field = c.req.query('field');
    if (locale !== undefined && !LOCALE.test(locale)) {
      issues.push({ path: 'locale', message: 'A locale such as en-US.' });
    }
    if (field !== undefined && !isListingField(app.platform, field)) {
      issues.push({ path: 'field', message: `Not a listing field of an ${app.platform} app.` });
    }
    const limit = queryInt(c.req.query('limit'), {
      fallback: HISTORY_DEFAULT_LIMIT,
      max: HISTORY_MAX_LIMIT,
    });
    if (limit === undefined) {
      issues.push({ path: 'limit', message: `A whole number from 1 to ${HISTORY_MAX_LIMIT}.` });
    }
    const rawCursor = c.req.query('cursor');
    const cursor =
      rawCursor === undefined || rawCursor === '' ? undefined : parseHistoryCursor(rawCursor);
    if (rawCursor !== undefined && rawCursor !== '' && cursor === undefined) {
      issues.push({ path: 'cursor', message: 'Use the nextCursor of the previous page.' });
    }
    if (issues.length > 0 || limit === undefined)
      return c.json({ error: 'invalid_request', issues }, 400);
    await recordAppliedChangeSets(db, ws(c), app, ctx.now()).catch(() => 0);
    return c.json(await getHistory(db, ws(c), app, { locale, field, limit, cursor }));
  });

  // Reads the linked repository on GitHub and records its listing. Needs the right to read
  // repository listings from GitHub (member and up), and shares the rate limit of store reads.
  routes.post(
    '/:workspaceId/apps/:id/listing/repo-refresh',
    needs('repositories.scan'),
    async (c) => {
      const app = await getApp(db, ws(c), param(c, 'id'));
      if (!app) return notFound(c);
      if (!app.repositoryId) {
        return c.json(
          {
            error: 'no_repository',
            message: 'This app is not linked to a repository. Link one to compare it.',
            ...coded('listing.notLinkedCompare'),
          },
          422,
        );
      }
      const wait = ctx.limiter.take(ws(c));
      if (wait > 0) {
        c.header('Retry-After', String(wait));
        return c.json(
          {
            error: 'rate_limited',
            message: `Too many repository reads. Try again in ${wait} seconds.`,
            ...coded('rate.repositoryReads', { count: wait }),
            retryAfterSeconds: wait,
          },
          429,
        );
      }
      const done = await refreshRepoListing(ctx.repo, { workspaceId: ws(c), app }, actor(c));
      if (!done.ok) return respond(c, done);
      const { ok: _ok, ...result } = done;
      return c.json(result);
    },
  );

  // Turns the live store listing into a draft change set on the linked repository: the store's
  // values applied to the repository's own listing files. Reads GitHub (and, with `refresh`, the
  // store), writes only a draft: it then follows the usual review, approve and apply flow.
  routes.post(
    '/:workspaceId/apps/:id/listing/pull',
    needs('listing.read'),
    needs('changesets.write'),
    bodyLimit({
      maxSize: PULL_BODY_LIMIT,
      onError: (c) =>
        c.json({ error: 'payload_too_large', message: 'The request body is too large.' }, 413),
    }),
    async (c) => {
      const body = await parseBody(c, pullBody);
      if (!body.ok) return body.response;
      const app = await getApp(db, ws(c), param(c, 'id'));
      if (!app) return notFound(c);
      if (!app.repositoryId) {
        return c.json(
          {
            error: 'no_repository',
            message: 'This app is not linked to a repository. Link one to pull into it.',
            ...coded('listing.notLinkedPull'),
          },
          422,
        );
      }
      const refresh = body.data.refresh === true;
      // A store read uses the app's credential: the right to sync, as the sync route needs.
      if (refresh && !can(c.get('role'), 'apps.sync')) return c.json({ error: 'forbidden' }, 403);
      if (refresh && !ctx.sync) {
        return c.json(
          {
            error: 'refresh_unavailable',
            message: 'This server cannot read the store.',
            ...coded('listing.cannotReadStore'),
          },
          422,
        );
      }
      const limited = (limiter: TestLimiter, what: string) => {
        const wait = limiter.take(ws(c));
        if (wait === 0) return undefined;
        return {
          ok: false as const,
          status: 429 as const,
          headers: { 'Retry-After': String(wait) },
          body: {
            error: 'rate_limited',
            message: `Too many ${what}. Try again in ${wait} seconds.`,
            ...coded('rate.requests', { count: wait }),
            retryAfterSeconds: wait,
          },
        } satisfies Failure;
      };
      const waited = limited(ctx.limiter, 'repository reads');
      if (waited) return respond(c, waited);
      const { sync } = ctx;
      const done = await pullStoreListing(
        { repo: ctx.repo },
        {
          workspaceId: ws(c),
          app,
          channel: body.data.channel,
          locales: body.data.locales,
          fields: body.data.fields,
          items: body.data.items,
          addLocales: body.data.addLocales,
          summary: body.data.summary,
          selection: {
            ...(body.data.target ? { target: body.data.target } : {}),
            ...(body.data.roots ? { roots: body.data.roots } : {}),
          },
          ...(refresh && sync
            ? {
                refresh: async (): Promise<Failure | undefined> => {
                  const store = limited(sync.limiter, 'store reads');
                  if (store) return store;
                  const synced = await syncApp(
                    sync.apps,
                    { workspaceId: ws(c), id: app.id },
                    actor(c),
                  );
                  if (synced.ok) return undefined;
                  const { transient: _transient, ...failed } = synced;
                  return failed;
                },
              }
            : {}),
        },
        actor(c),
      );
      if (!done.ok) return respond(c, done);
      return c.json(done.result, done.result.changeSet ? 201 : 200);
    },
  );

  return routes;
}
