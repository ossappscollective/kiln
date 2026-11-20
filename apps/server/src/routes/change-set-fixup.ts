import { type Action, can } from '@mrm/core';
import type { Database } from '@mrm/db';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AppEnv } from '../http.ts';
import { planRecompute, recomputeStorePull } from '../modules/listing/pull.ts';
import { memberRole } from '../services/accounts.ts';
import { type AppsContext, syncApp } from '../services/apps.ts';
import { fixupChangeSet } from '../services/change-set-fixup.ts';
import { parseOrigin, rowOf } from '../services/change-sets.ts';
import type { TestLimiter } from '../services/credential-tests.ts';
import type { Failure, RepoContext } from '../services/repositories.ts';

/**
 * The two operations that can take the content of a change set from somewhere other than the
 * stored files: fixing up a branch that exists (docs/api/repositories.md, "Fix up a branch") and
 * recomputing a store pull (docs/api/listing.md, "Recompute a pull"). Mounted under /api/workspaces.
 */
export type ChangeSetFixupRoutesContext = {
  db: Database;
  now: () => number;
  repo: RepoContext;
  /** Repository reads per workspace per minute for a recompute. Its own budget, like the pull's. */
  limiter: TestLimiter;
  /** The store read of `refresh: true`: the app sync's context and per workspace budget (the same instances the pull uses). */
  sync?: { apps: AppsContext; limiter: TestLimiter };
};

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });

const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

/** A body is a few choices per file: bounded in size and in the number of choices. */
const BODY_LIMIT = 64 * 1024;
const MAX_CHOICES = 500;
const choices = z
  .record(z.string().min(1).max(1000), z.enum(['mine', 'theirs']))
  .refine((value) => Object.keys(value).length <= MAX_CHOICES, `At most ${MAX_CHOICES} choices.`);

const fixupBody = z
  .object({
    resolutions: choices.optional(),
    branchResolutions: choices.optional(),
    push: z.boolean().optional(),
    openPr: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    recompute: z.boolean().optional(),
    refresh: z.boolean().optional(),
  })
  .strict()
  .default({});

const recomputeBody = z.object({ refresh: z.boolean().optional() }).strict().default({});

export function changeSetFixupRoutes(ctx: ChangeSetFixupRoutesContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();

  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const limited = (limiter: TestLimiter, c: Context<AppEnv>, what: string): Failure | undefined => {
    const wait = limiter.take(ws(c));
    if (wait === 0) return undefined;
    return {
      ok: false,
      status: 429,
      headers: { 'Retry-After': String(wait) },
      body: {
        error: 'rate_limited',
        message: `Too many ${what}. Try again in ${wait} seconds.`,
        retryAfterSeconds: wait,
      },
    };
  };
  /** The optional body: none (or an empty one) is `{}`. */
  const readBody = async <S extends z.ZodTypeAny>(
    c: Context<AppEnv>,
    schema: S,
  ): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: Response }> => {
    const raw = await c.req.text();
    let json: unknown = {};
    if (raw.trim() !== '') {
      try {
        json = JSON.parse(raw);
      } catch {
        return {
          ok: false,
          response: c.json(
            { error: 'invalid_request', issues: [{ path: '', message: 'The body is not JSON.' }] },
            400,
          ),
        };
      }
    }
    const result = schema.safeParse(json);
    if (!result.success) {
      return {
        ok: false,
        response: c.json(
          {
            error: 'invalid_request',
            issues: result.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
          400,
        ),
      };
    }
    return { ok: true, data: result.data };
  };
  const tooLarge = bodyLimit({
    maxSize: BODY_LIMIT,
    onError: (c) =>
      c.json({ error: 'payload_too_large', message: 'The request body is too large.' }, 413),
  });

  /** The store read of `refresh: true`: the sync of the app the change set was pulled for, under the sync budget. */
  const storeRefresh = (c: Context<AppEnv>, appId: string) => {
    const sync = ctx.sync;
    return async (): Promise<Failure | undefined> => {
      if (!sync)
        return {
          ok: false,
          status: 422,
          body: { error: 'refresh_unavailable', message: 'This server cannot read the store.' },
        };
      const waited = limited(sync.limiter, c, 'store reads');
      if (waited) return waited;
      const synced = await syncApp(sync.apps, { workspaceId: ws(c), id: appId }, actor(c));
      if (synced.ok) return undefined;
      const { transient: _transient, ...failed } = synced;
      return failed;
    };
  };

  // Adds one commit to the branch of an applied (or failed) change set. Same right as apply.
  routes.post(
    '/:workspaceId/change-sets/:id/fixup',
    needs('changesets.approve'),
    tooLarge,
    async (c) => {
      const body = await readBody(c, fixupBody);
      if (!body.ok) return body.response;
      const data = body.data;
      if (data.refresh && !data.recompute) {
        return c.json(
          {
            error: 'invalid_request',
            message: '"refresh" reads the store for a recompute: set "recompute" too.',
          },
          400,
        );
      }
      const id = param(c, 'id');
      if (!data.recompute) {
        const done = await fixupChangeSet(ctx.repo, { workspaceId: ws(c), id, ...data }, actor(c));
        if (!done.ok) return respond(c, done);
        return c.json(done.result);
      }

      // The content comes from the live store listing: the same rights as the pull (and the store read for `refresh`).
      if (!can(c.get('role'), 'listing.read')) return c.json({ error: 'forbidden' }, 403);
      if (data.refresh && !can(c.get('role'), 'apps.sync'))
        return c.json({ error: 'forbidden' }, 403);
      const row = await rowOf(db, ws(c), id);
      if (!row) return c.json({ error: 'not_found' }, 404);
      const origin = parseOrigin(row);
      const waited = limited(ctx.limiter, c, 'repository reads');
      if (waited) return respond(c, waited);
      const planned = await planRecompute(
        { repo: ctx.repo },
        {
          workspaceId: ws(c),
          id,
          row,
          ...(data.refresh && origin?.appId ? { refresh: storeRefresh(c, origin.appId) } : {}),
        },
        actor(c),
      );
      if (!planned.ok) return respond(c, planned);
      const { plan } = planned;
      const { recompute: _recompute, refresh: _refresh, ...options } = data;
      const done = await fixupChangeSet(
        ctx.repo,
        { workspaceId: ws(c), id, ...options, desired: { files: plan.files, origin: plan.origin } },
        actor(c),
      );
      if (!done.ok) return respond(c, done);
      return c.json({
        ...done.result,
        recompute: { ...plan.result, diffFromPrevious: plan.diffFromPrevious },
      });
    },
  );

  // Makes a store pull again from the current store snapshot and the current repository: the files
  // of the same change set are replaced (it goes back to draft). A set with a branch is fixed up instead.
  routes.post(
    '/:workspaceId/change-sets/:id/recompute',
    needs('changesets.write'),
    tooLarge,
    async (c) => {
      if (!can(c.get('role'), 'listing.read')) return c.json({ error: 'forbidden' }, 403);
      const body = await readBody(c, recomputeBody);
      if (!body.ok) return body.response;
      const refresh = body.data.refresh === true;
      // A store read uses the app's credential: the right to sync, as the sync route needs.
      if (refresh && !can(c.get('role'), 'apps.sync')) return c.json({ error: 'forbidden' }, 403);
      if (refresh && !ctx.sync) {
        return c.json(
          { error: 'refresh_unavailable', message: 'This server cannot read the store.' },
          422,
        );
      }
      const id = param(c, 'id');
      const row = await rowOf(db, ws(c), id);
      if (!row) return c.json({ error: 'not_found' }, 404);
      const origin = parseOrigin(row);
      const waited = limited(ctx.limiter, c, 'repository reads');
      if (waited) return respond(c, waited);
      const done = await recomputeStorePull(
        { repo: ctx.repo },
        {
          workspaceId: ws(c),
          id,
          ...(refresh && origin?.appId ? { refresh: storeRefresh(c, origin.appId) } : {}),
        },
        actor(c),
      );
      if (!done.ok) return respond(c, done);
      return c.json(done.result);
    },
  );

  return routes;
}
