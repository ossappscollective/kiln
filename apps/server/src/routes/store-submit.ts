import { type Action, can } from '@mrm/core';
import type { Database } from '@mrm/db';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody } from '../http.ts';
import { memberRole } from '../services/accounts.ts';
import type { Failure } from '../services/repositories.ts';
import { requireStepUp, stepUpCovers } from '../services/step-up.ts';
import {
  applySubmit,
  defaultSubmitConnectorFactory,
  getSubmitState,
  previewSubmit,
  type SubmitConnectorFactory,
  type SubmitContext,
  submitConfig,
  submitDisabledFailure,
} from '../services/store-submit.ts';

/**
 * Submitting the pushed store draft for review (docs/api/submit.md, docs/adr/0010-store-submit.md): an IRREVERSIBLE
 * store write, OFF unless MRM_STORE_SUBMIT_ENABLED=true, needing the `store.submit` action (owner and admin; a token
 * only when its actions name it). Never releases a version and never changes a rollout. Mounted under /api/workspaces.
 */
export type SubmitRoutesContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  submit?: {
    /** MRM_STORE_SUBMIT_ENABLED (default false). */
    enabled?: boolean;
    /** Builds the connector that can read and submit (fakes in tests). */
    connectorFactory?: SubmitConnectorFactory;
    timeoutMs?: number;
    claimTtlMs?: number;
  };
};

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });

const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

const hash64 = /^[0-9a-f]{64}$/;
const previewBody = z.object({}).strict().optional();
const applyBody = z
  .object({
    confirmHash: z
      .string()
      .regex(hash64, 'The confirmHash of the preview, 64 hexadecimal characters.'),
    /** Required unless the person's own confirmation (step-up) stands in for it; the service then ignores it. */
    confirmation: z.string().max(300).default(''),
  })
  .strict();

export function storeSubmitRoutes(ctx: SubmitRoutesContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();
  const submit: SubmitContext = {
    db,
    masterKey: ctx.masterKey,
    now: ctx.now,
    submitEnabled: ctx.submit?.enabled ?? false,
    submitConnectorFactory: ctx.submit?.connectorFactory ?? defaultSubmitConnectorFactory,
    ...(ctx.submit?.timeoutMs !== undefined ? { submitTimeoutMs: ctx.submit.timeoutMs } : {}),
    ...(ctx.submit?.claimTtlMs !== undefined ? { claimTtlMs: ctx.submit.claimTtlMs } : {}),
  };

  /** Not a member and no such workspace look the same (404). A member without the right gets 403. */
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };

  routes.get('/:workspaceId/store-submit/config', needs('apps.read'), (c) =>
    c.json(submitConfig(submit)),
  );

  routes.get('/:workspaceId/apps/:id/store-submit', needs('store.submit'), async (c) => {
    const done = await getSubmitState(submit, { workspaceId: ws(c), appId: param(c, 'id') });
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ submit: done.state }) : respond(c, done);
  });

  routes.post('/:workspaceId/apps/:id/store-submit/preview', needs('store.submit'), async (c) => {
    if (!submit.submitEnabled) return respond(c, submitDisabledFailure());
    const body = await parseBody(c, previewBody);
    if (!body.ok) return body.response;
    const done = await previewSubmit(submit, {
      workspaceId: ws(c),
      appId: param(c, 'id'),
      actor: actor(c),
      stepUpCovers: await stepUpCovers({ db, now: ctx.now }, c, 'store.submit'),
    });
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ preview: done.preview }) : respond(c, done);
  });

  // The only route that hands anything to a store's review. One app per request: no bulk submit.
  routes.post('/:workspaceId/apps/:id/store-submit', needs('store.submit'), async (c) => {
    if (!submit.submitEnabled) return respond(c, submitDisabledFailure());
    const stepUpRefusal = await requireStepUp({ db, now: ctx.now }, c, 'store.submit', {
      id: param(c, 'id'),
      hashField: 'confirmHash',
    });
    if (stepUpRefusal) return stepUpRefusal;
    const body = await parseBody(c, applyBody);
    if (!body.ok) return body.response;
    const done = await applySubmit(submit, {
      workspaceId: ws(c),
      appId: param(c, 'id'),
      confirmHash: body.data.confirmHash,
      confirmation: body.data.confirmation,
      actor: actor(c),
      stepUpCovers: await stepUpCovers({ db, now: ctx.now }, c, 'store.submit'),
    });
    return done.ok ? c.json({ result: done.result }) : respond(c, done);
  });

  return routes;
}
