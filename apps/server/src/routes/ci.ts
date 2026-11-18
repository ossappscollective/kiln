import { type Action, type Platform, can } from '@mrm/core';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody, queryInt } from '../http.ts';
import { memberRole } from '../services/accounts.ts';
import {
  type CiContext,
  buildChanges,
  dispatchRun,
  fetchRun,
  getWorkflowInputs,
  linkBuildToRun,
  listAppBuilds,
  listWorkflows,
  refreshRuns,
  unlinkBuild,
} from '../services/ci.ts';
import { countActiveRuns, getRunView, listRuns } from '../services/ci-runs.ts';
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
  .refine((v) => !v.includes('..') && !v.endsWith('/') && !v.endsWith('.lock'), 'Not a valid branch or tag name.');

const dispatchBody = z.object({
  ref: refSchema.optional(),
  inputs: z
    .record(
      z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, underscores and hyphens only.'),
      z.union([z.string().max(4096), z.number(), z.boolean()]).transform((v) => String(v)),
    )
    .refine((v) => Object.keys(v).length <= 25, 'GitHub accepts at most 25 inputs.')
    .optional(),
  appId: z.string().min(1).max(100).optional(),
});

const linkBody = z.object({ runId: z.string().regex(RUN_ID, 'A run id is a number.') });

const platformOf = (value: string): Platform | undefined =>
  value === 'ios' || value === 'android' ? value : undefined;

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
    const done = await listWorkflows(ctx, { workspaceId: ws(c), repositoryId: param(c, 'id') }, actor(c));
    if (!done.ok) return respond(c, done);
    return c.json({ workflows: done.workflows, cached: done.cached });
  });

  // ----- runs (registered before /:workflow/..., so "runs" is never read as a workflow) ------

  app.get('/:workspaceId/repositories/:id/workflows/runs', needs('repositories.read'), async (c) => {
    const repository = await getRepository(db, ws(c), param(c, 'id'));
    if (!repository) return notFound(c);
    const limit = queryInt(c.req.query('limit'), { fallback: 30, max: 100 });
    if (limit === undefined) return invalid(c, 'limit', 'A whole number from 1 to 100.');
    const workflow = c.req.query('workflow');
    if (workflow !== undefined && workflow.length > 200) return invalid(c, 'workflow', 'Too long.');
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
  });

  app.get('/:workspaceId/repositories/:id/workflows/runs/:runId', needs('repositories.read'), async (c) => {
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
  });

  app.get('/:workspaceId/repositories/:id/workflows/:workflow/inputs', needs('repositories.scan'), async (c) => {
    const workflow = param(c, 'workflow');
    if (!WORKFLOW.test(workflow)) return invalid(c, 'workflow', 'A workflow file name or id.');
    const ref = c.req.query('ref');
    if (ref !== undefined && !refSchema.safeParse(ref).success) return invalid(c, 'ref', 'Use a branch or tag name.');
    const done = await getWorkflowInputs(
      ctx,
      { workspaceId: ws(c), repositoryId: param(c, 'id'), workflow, ref },
      actor(c),
    );
    if (!done.ok) return respond(c, done);
    const { ok: _ok, ...view } = done;
    return c.json(view);
  });

  app.post('/:workspaceId/repositories/:id/workflows/:workflow/dispatches', needs('ci.dispatch'), async (c) => {
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
  });

  // ----- builds ---------------------------------------------------------------------------

  app.get('/:workspaceId/apps/:id/builds', needs('apps.read'), async (c) => {
    const done = await listAppBuilds(ctx, { workspaceId: ws(c), appId: param(c, 'id') });
    return done ? c.json(done) : notFound(c);
  });

  // Reads GitHub (the compare API), so it needs the right of a scan.
  app.get('/:workspaceId/apps/:id/builds/changes', needs('repositories.scan'), async (c) => {
    const platform = platformOf(c.req.query('platform') ?? '');
    if (!platform) return invalid(c, 'platform', 'ios or android.');
    const build = c.req.query('build') ?? '';
    if (!BUILD_NUMBER.test(build)) return invalid(c, 'build', 'A build number.');
    const base = c.req.query('base');
    if (base !== undefined && !BUILD_NUMBER.test(base)) return invalid(c, 'base', 'A build number.');
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
    if (!platform) return { error: invalid(c, 'platform', 'ios or android.') } as const;
    if (!BUILD_NUMBER.test(buildNumber)) return { error: invalid(c, 'buildNumber', 'A build number.') } as const;
    return { ref: { workspaceId: ws(c), appId: param(c, 'id'), platform, buildNumber } } as const;
  };

  app.put('/:workspaceId/apps/:id/builds/:platform/:buildNumber/link', needs('apps.sync'), async (c) => {
    const target = buildTarget(c);
    if ('error' in target) return target.error;
    const body = await parseBody(c, linkBody);
    if (!body.ok) return body.response;
    const done = await linkBuildToRun(ctx, { ...target.ref, runId: body.data.runId }, actor(c));
    return done.ok ? c.json({ build: done.build }) : respond(c, done);
  });

  app.delete('/:workspaceId/apps/:id/builds/:platform/:buildNumber/link', needs('apps.sync'), async (c) => {
    const target = buildTarget(c);
    if ('error' in target) return target.error;
    const done = await unlinkBuild(ctx, target.ref, actor(c));
    return done.ok ? c.json({ build: done.build }) : respond(c, done);
  });

  return app;
}
