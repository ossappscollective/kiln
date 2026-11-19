import { type Action, can, type Platform, parsePlatform } from '@mrm/core';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { type AppEnv, parseBody, queryInt } from '../http.ts';
import { memberRole } from '../services/accounts.ts';
import { conventionsBody } from '../services/build-conventions.ts';
import {
  buildChanges,
  type CiContext,
  cachedRunJobs,
  dispatchRun,
  fetchRun,
  getConventions,
  getWorkflowInputs,
  linkBuildToRun,
  listAppBuilds,
  listRepositoryTags,
  listWorkflows,
  readRunJobs,
  refreshRuns,
  rematchBuilds,
  setConventions,
  unlinkBuild,
} from '../services/ci.ts';
import { listActiveRuns } from '../services/ci-active.ts';
import { countActiveRuns, getRunView, listRuns, runCountsForApp } from '../services/ci-runs.ts';
import { type Failure, getRepository } from '../services/repositories.ts';

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });

const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

const invalid = (c: Context<AppEnv>, path: string, message: string) =>
  c.json({ error: 'invalid_request', issues: [{ path, message }] }, 400);

/** A workflow file name (`ios.yml`) or a numeric id. */
const WORKFLOW = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const RUN_ID = /^[0-9]{1,20}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const BUILD_NUMBER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const refSchema = z
  .string()
  .trim()
  .regex(REF, 'Use a branch or tag name.')
  .refine(
    (v) => !v.includes('..') && !v.endsWith('/') && !v.endsWith('.lock'),
    'Not a valid branch or tag name.',
  );

const dispatchBody = z.object({
  ref: refSchema.optional(),
  inputs: z
    .record(
      z
        .string()
        .min(1)
        .max(100)
        .regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, underscores and hyphens only.'),
      z.union([z.string().max(4096), z.number(), z.boolean()]).transform((v) => String(v)),
    )
    .refine((v) => Object.keys(v).length <= 25, 'GitHub accepts at most 25 inputs.')
    .optional(),
  appId: z.string().min(1).max(100).optional(),
  /** Every app this run builds (one workflow can build several apps of the repository). Joined with `appId`. */
  appIds: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
});

const linkBody = z.object({ runId: z.string().regex(RUN_ID, 'A run id is a number.') });

/** The conventions are a few short patterns; 16 KiB is far more than they need. */
export const CONVENTIONS_BODY_LIMIT = 16 * 1024;

const platformOf = (value: string): Platform | undefined =>
  value === parsePlatform(value) ? parsePlatform(value) : undefined;

/** CI routes: workflows, dispatch and runs of a repository, and the builds of an app. */
export function ciRoutes(ctx: CiContext) {
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
  const canScan = (c: Context<AppEnv>) => can(c.get('role'), 'repositories.scan');
  const forbidden = (c: Context<AppEnv>) => c.json({ error: 'forbidden' }, 403);

  // ----- workflows ------------------------------------------------------------------------

  // These ask GitHub with the stored credential, so they need the right of a scan, not of a look.
  app.get('/:workspaceId/repositories/:id/workflows', needs('repositories.scan'), async (c) => {
    const done = await listWorkflows(
      ctx,
      { workspaceId: ws(c), repositoryId: param(c, 'id') },
      actor(c),
    );
    if (!done.ok) return respond(c, done);
    return c.json({ workflows: done.workflows, cached: done.cached });
  });

  // ----- running now (workspace wide) -----------------------------------------------------------

  // Every repository's runs that have not finished, and those finished in the last day. Stored runs for
  // everybody who may read; a member or admin also refreshes them from GitHub (cached for seconds,
  // rate limited per workspace). An API token limited to some apps sees only their repositories' runs.
  app.get('/:workspaceId/ci/runs/active', needs('repositories.read'), async (c) => {
    const raw = c.req.query('repositoryId');
    let repositoryIds: string[] | undefined;
    if (raw !== undefined) {
      repositoryIds = raw
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v !== '');
      if (
        repositoryIds.length === 0 ||
        repositoryIds.length > 50 ||
        repositoryIds.some((v) => v.length > 100)
      ) {
        return invalid(c, 'repositoryId', 'Up to 50 repository ids, comma separated.');
      }
    }
    const wait = ctx.activeLimiter.take(ws(c));
    if (wait > 0) {
      return respond(c, {
        ok: false,
        status: 429,
        body: {
          error: 'rate_limited',
          message: `Too many requests. Try again in ${wait} seconds.`,
          retryAfterSeconds: wait,
        },
        headers: { 'Retry-After': String(wait) },
      });
    }
    const forApp = c.req.query('appId');
    if (forApp !== undefined && (forApp.length === 0 || forApp.length > 100))
      return invalid(c, 'appId', 'An app id.');
    const answer = await listActiveRuns(
      ctx,
      {
        workspaceId: ws(c),
        canScan: canScan(c),
        repositoryIds,
        appIds: c.get('token')?.appIds ?? null,
      },
      actor(c),
    );
    // One app's view: the runs started for it (alone or with other apps) and those not started for an app.
    if (forApp !== undefined) {
      return c.json({
        ...answer,
        runs: answer.runs.filter((r) => runCountsForApp(r, forApp)),
        recent: answer.recent.filter((r) => runCountsForApp(r, forApp)),
      });
    }
    return c.json(answer);
  });

  // ----- runs (registered before /:workflow/..., so "runs" is never read as a workflow) ------

  app.get(
    '/:workspaceId/repositories/:id/workflows/runs',
    needs('repositories.read'),
    async (c) => {
      const repository = await getRepository(db, ws(c), param(c, 'id'));
      if (!repository) return notFound(c);
      const limit = queryInt(c.req.query('limit'), { fallback: 30, max: 100 });
      if (limit === undefined) return invalid(c, 'limit', 'A whole number from 1 to 100.');
      const workflow = c.req.query('workflow');
      if (workflow !== undefined && workflow.length > 200)
        return invalid(c, 'workflow', 'Too long.');
      const branch = c.req.query('branch');
      if (branch !== undefined && branch.length > 200) return invalid(c, 'branch', 'Too long.');

      const wantsRefresh = c.req.query('refresh') === 'true';
      let refreshed = false;
      let refreshedAt: number | null = null;
      if (wantsRefresh) {
        if (!canScan(c)) return forbidden(c);
        const read = await refreshRuns(ctx, { workspaceId: ws(c), repository }, actor(c));
        if (!read.ok) return respond(c, read);
        refreshed = read.refreshed;
        refreshedAt = read.refreshedAt;
      }
      const runs = await listRuns(db, ws(c), repository.id, {
        limit,
        workflow,
        branch,
        activeOnly: c.req.query('active') === 'true',
        appId: c.req.query('appId'),
      });
      return c.json({
        runs,
        active: await countActiveRuns(db, ws(c), repository.id),
        refreshed,
        refreshedAt,
      });
    },
  );

  app.get(
    '/:workspaceId/repositories/:id/workflows/runs/:runId',
    needs('repositories.read'),
    async (c) => {
      const repository = await getRepository(db, ws(c), param(c, 'id'));
      if (!repository) return notFound(c);
      const runId = param(c, 'runId');
      if (!RUN_ID.test(runId)) return invalid(c, 'runId', 'A run id is a number.');
      const wantsRefresh = c.req.query('refresh') === 'true';
      if (wantsRefresh && !canScan(c)) return forbidden(c);
      const stored = await getRunView(db, ws(c), repository.id, runId);
      if (stored && !wantsRefresh) return c.json({ run: stored });
      // Not stored yet, or a fresh read was asked for: ask GitHub (needs the right of a scan).
      if (!canScan(c)) return notFound(c);
      const done = await fetchRun(ctx, { workspaceId: ws(c), repository, runId }, actor(c));
      return done.ok ? c.json({ run: done.run }) : respond(c, done);
    },
  );

  // Jobs and steps of a run (names, states, times; never logs). A member or admin reads them from GitHub
  // (kept 10 seconds while the run is going); a viewer sees what was read lately, which may be nothing.
  app.get(
    '/:workspaceId/repositories/:id/workflows/runs/:runId/jobs',
    needs('repositories.read'),
    async (c) => {
      const repository = await getRepository(db, ws(c), param(c, 'id'));
      if (!repository) return notFound(c);
      const runId = param(c, 'runId');
      if (!RUN_ID.test(runId)) return invalid(c, 'runId', 'A run id is a number.');
      const stored = await getRunView(db, ws(c), repository.id, runId);
      if (!canScan(c)) {
        if (!stored) return notFound(c);
        const seen = cachedRunJobs(repository.id, runId, ctx.now());
        return c.json({
          runId,
          jobs: seen?.jobs ?? [],
          truncated: seen?.truncated ?? false,
          readAt: seen?.readAt ?? null,
          cached: true,
          live: false,
        });
      }
      const done = await readRunJobs(
        ctx,
        { workspaceId: ws(c), repository, runId, active: stored?.active ?? true },
        actor(c),
      );
      if (!done.ok) return respond(c, done);
      return c.json({
        runId,
        jobs: done.jobs.jobs,
        truncated: done.jobs.truncated,
        readAt: done.jobs.readAt,
        cached: done.cached,
        live: true,
      });
    },
  );

  app.get(
    '/:workspaceId/repositories/:id/workflows/:workflow/inputs',
    needs('repositories.scan'),
    async (c) => {
      const workflow = param(c, 'workflow');
      if (!WORKFLOW.test(workflow)) return invalid(c, 'workflow', 'A workflow file name or id.');
      const ref = c.req.query('ref');
      if (ref !== undefined && !refSchema.safeParse(ref).success)
        return invalid(c, 'ref', 'Use a branch or tag name.');
      const done = await getWorkflowInputs(
        ctx,
        { workspaceId: ws(c), repositoryId: param(c, 'id'), workflow, ref },
        actor(c),
      );
      if (!done.ok) return respond(c, done);
      const { ok: _ok, ...view } = done;
      return c.json(view);
    },
  );

  app.post(
    '/:workspaceId/repositories/:id/workflows/:workflow/dispatches',
    needs('ci.dispatch'),
    async (c) => {
      const workflow = param(c, 'workflow');
      if (!WORKFLOW.test(workflow)) return invalid(c, 'workflow', 'A workflow file name or id.');
      const body = await parseBody(c, dispatchBody);
      if (!body.ok) return body.response;
      const done = await dispatchRun(
        ctx,
        { workspaceId: ws(c), repositoryId: param(c, 'id'), workflow, ...body.data },
        actor(c),
      );
      if (!done.ok) return respond(c, done);
      return c.json({ dispatched: true, runKnown: done.runKnown, run: done.run }, 202);
    },
  );

  // ----- build number conventions ---------------------------------------------------------

  const tooLarge = (c: Context<AppEnv>) =>
    c.json({ error: 'payload_too_large', message: 'The request body is too large.' }, 413);

  app.get(
    '/:workspaceId/repositories/:id/build-conventions',
    needs('repositories.read'),
    async (c) => {
      const appId = c.req.query('appId');
      if (appId !== undefined && (appId.length === 0 || appId.length > 100))
        return invalid(c, 'appId', 'An app id.');
      const done = await getConventions(ctx, {
        workspaceId: ws(c),
        repositoryId: param(c, 'id'),
        appId,
      });
      if (!done.ok) return done.status === 422 ? notFound(c) : respond(c, done);
      return c.json(done.conventions);
    },
  );

  app.put(
    '/:workspaceId/repositories/:id/build-conventions',
    needs('repositories.write'),
    bodyLimit({ maxSize: CONVENTIONS_BODY_LIMIT, onError: tooLarge }),
    async (c) => {
      const body = await parseBody(c, conventionsBody);
      if (!body.ok) return body.response;
      const { appId, ...rest } = body.data;
      const done = await setConventions(
        ctx,
        {
          workspaceId: ws(c),
          repositoryId: param(c, 'id'),
          appId,
          conventions: {
            tagPatterns: rest.tagPatterns,
            releasePatterns: rest.releasePatterns,
            prefix: rest.prefix,
            workflow: rest.workflow ?? null,
          },
        },
        actor(c),
      );
      return done.ok ? c.json(done.conventions) : respond(c, done);
    },
  );

  // Reads GitHub (the tags and releases the dialog previews patterns against): a right of a scan.
  app.get(
    '/:workspaceId/repositories/:id/build-conventions/tags',
    needs('repositories.scan'),
    async (c) => {
      const done = await listRepositoryTags(
        ctx,
        { workspaceId: ws(c), repositoryId: param(c, 'id') },
        actor(c),
      );
      return done.ok ? c.json({ ...done.data, cached: done.cached }) : respond(c, done);
    },
  );

  // ----- builds ---------------------------------------------------------------------------

  app.get('/:workspaceId/apps/:id/builds', needs('apps.read'), async (c) => {
    const done = await listAppBuilds(ctx, { workspaceId: ws(c), appId: param(c, 'id') });
    return done ? c.json(done) : notFound(c);
  });

  // Reads the runs, tags and releases from GitHub again and links what it can: a right of a scan.
  app.post('/:workspaceId/apps/:id/builds/rematch', needs('repositories.scan'), async (c) => {
    const wait = ctx.rematchLimiter.take(ws(c));
    if (wait > 0) {
      return respond(c, {
        ok: false,
        status: 429,
        body: {
          error: 'rate_limited',
          message: `Too many requests. Try again in ${wait} seconds.`,
          retryAfterSeconds: wait,
        },
        headers: { 'Retry-After': String(wait) },
      });
    }
    const done = await rematchBuilds(ctx, { workspaceId: ws(c), appId: param(c, 'id') }, actor(c));
    return done.ok ? c.json({ ...done.builds, rematch: done.rematch }) : respond(c, done);
  });

  // Reads GitHub (the compare API), so it needs the right of a scan.
  app.get('/:workspaceId/apps/:id/builds/changes', needs('repositories.scan'), async (c) => {
    const platform = platformOf(c.req.query('platform') ?? '');
    if (!platform) return invalid(c, 'platform', 'ios, macos or android.');
    const build = c.req.query('build') ?? '';
    if (!BUILD_NUMBER.test(build)) return invalid(c, 'build', 'A build number.');
    const base = c.req.query('base');
    if (base !== undefined && !BUILD_NUMBER.test(base))
      return invalid(c, 'base', 'A build number.');
    const done = await buildChanges(
      ctx,
      { workspaceId: ws(c), appId: param(c, 'id'), platform, buildNumber: build, base },
      actor(c),
    );
    return done.ok ? c.json(done.changes) : respond(c, done);
  });

  const buildTarget = (c: Context<AppEnv>) => {
    const platform = platformOf(param(c, 'platform'));
    const buildNumber = param(c, 'buildNumber');
    if (!platform) return { error: invalid(c, 'platform', 'ios, macos or android.') } as const;
    if (!BUILD_NUMBER.test(buildNumber))
      return { error: invalid(c, 'buildNumber', 'A build number.') } as const;
    return { ref: { workspaceId: ws(c), appId: param(c, 'id'), platform, buildNumber } } as const;
  };

  app.put(
    '/:workspaceId/apps/:id/builds/:platform/:buildNumber/link',
    needs('apps.sync'),
    async (c) => {
      const target = buildTarget(c);
      if ('error' in target) return target.error;
      const body = await parseBody(c, linkBody);
      if (!body.ok) return body.response;
      const done = await linkBuildToRun(ctx, { ...target.ref, runId: body.data.runId }, actor(c));
      return done.ok ? c.json({ build: done.build }) : respond(c, done);
    },
  );

  app.delete(
    '/:workspaceId/apps/:id/builds/:platform/:buildNumber/link',
    needs('apps.sync'),
    async (c) => {
      const target = buildTarget(c);
      if ('error' in target) return target.error;
      const done = await unlinkBuild(ctx, target.ref, actor(c));
      return done.ok ? c.json({ build: done.build }) : respond(c, done);
    },
  );

  return app;
}
