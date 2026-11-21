import { normalizeGitRef, normalizeWorkflowFileName, isExpoRunId } from '@kiln/connectors';
import { type Action, can } from '@kiln/core';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody } from '../../http.ts';
import { memberRole } from '../../services/accounts.ts';
import { getApp } from '../../services/apps.ts';
import type { Failure } from '../../services/repositories.ts';
import type { EasPart } from './parts.ts';
import {
  dispatchEasWorkflow,
  type EasWorkflowContext,
  getEasRun,
  listEasRuns,
  refreshEasRun,
} from './workflows.ts';

/** Our own cap on the inputs of one dispatch (Expo's is not documented). */
export const MAX_EAS_INPUTS = 25;

/** The body of `POST .../expo/workflows/dispatches`. Unknown keys are refused. */
export const dispatchEasBody = z.strictObject({
  workflow: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine(
      (v) => normalizeWorkflowFileName(v) !== undefined,
      'Name a workflow file in .eas/workflows, such as build.yml.',
    ),
  ref: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((v) => normalizeGitRef(v) !== undefined, 'Use a branch, a tag or a commit.')
    .optional(),
  inputs: z
    .record(
      z
        .string()
        .min(1)
        .max(100)
        .regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, underscores and hyphens only.'),
      z.union([z.string().max(4096), z.number(), z.boolean()]),
    )
    .refine((v) => Object.keys(v).length <= MAX_EAS_INPUTS, `At most ${MAX_EAS_INPUTS} inputs.`)
    .optional(),
});

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });
const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

/**
 * EAS Workflows of an app (docs/api/eas.md): start a run (`ci.dispatch`, like a GitHub dispatch), list the runs started here, read one
 * (and, with `refresh=true` for a member or admin, ask Expo for its state and jobs). Not being a member and an unknown app look the
 * same (404).
 */
export function easWorkflowRoutes(ctx: EasWorkflowContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const appExists = async (c: Context<AppEnv>) => (await getApp(db, ws(c), param(c, 'appId'))) !== undefined;

  routes.post('/:workspaceId/apps/:appId/expo/workflows/dispatches', needs('ci.dispatch'), async (c) => {
    const body = await parseBody(c, dispatchEasBody);
    if (!body.ok) return body.response;
    if (!(await appExists(c))) return c.json({ error: 'not_found' }, 404);
    const done = await dispatchEasWorkflow(
      ctx,
      { workspaceId: ws(c), appId: param(c, 'appId'), ...body.data },
      actor(c),
    );
    return done.ok ? c.json({ dispatched: true, run: done.run }, 202) : respond(c, done);
  });

  routes.get('/:workspaceId/apps/:appId/expo/workflows/runs', needs('apps.read'), async (c) => {
    if (!(await appExists(c))) return c.json({ error: 'not_found' }, 404);
    return c.json({ runs: await listEasRuns(ctx, ws(c), param(c, 'appId')) });
  });

  routes.get('/:workspaceId/apps/:appId/expo/workflows/runs/:runId', needs('apps.read'), async (c) => {
    const appId = param(c, 'appId');
    const runId = param(c, 'runId');
    if (!(await appExists(c))) return c.json({ error: 'not_found' }, 404);
    if (!isExpoRunId(runId)) {
      return c.json({ error: 'invalid_request', issues: [{ path: 'runId', message: 'A run id is a UUID.' }] }, 400);
    }
    const wantsRefresh = c.req.query('refresh') === 'true';
    if (wantsRefresh && !can(c.get('role'), 'apps.sync')) return c.json({ error: 'forbidden' }, 403);
    const stored = await getEasRun(ctx, ws(c), appId, runId.toLowerCase());
    if (!stored) return c.json({ error: 'not_found' }, 404);
    if (!wantsRefresh) return c.json({ run: stored, jobs: [], refreshed: false });
    const done = await refreshEasRun(ctx, { workspaceId: ws(c), appId, runId: stored.id }, actor(c));
    return done.ok ? c.json({ run: done.run, jobs: done.jobs, refreshed: true }) : respond(c, done);
  });

  return routes;
}

/** The mount of the EAS workflows routes (parts.ts). They share the CI dispatch budget and the build matchers of `shared.ci`. */
export const easWorkflowsPart: EasPart = (app, services, deps, shared) => {
  app.route(
    '/api/workspaces',
    easWorkflowRoutes({
      db: services.db,
      masterKey: services.masterKey,
      now: services.now,
      deps,
      limiter: shared.ci.limiter,
      matchers: shared.ci.matchers,
    }),
  );
};
