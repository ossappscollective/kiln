import { type Action, can } from '@mrm/core';
import type { Database } from '@mrm/db';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody } from '../../http.ts';
import { memberRole } from '../../services/accounts.ts';
import type { Failure } from '../../services/repositories.ts';
import { requireStepUp } from '../../services/step-up.ts';
import {
  applyRollout,
  defaultRolloutConnectorFactory,
  previewRollout,
  type RolloutConnectorFactory,
  type RolloutContext,
  readRolloutState,
  rolloutConfig,
  rolloutDisabledFailure,
} from './store-rollout.ts';

/**
 * Changing the live rollout of an app in its store (docs/api/rollout.md, docs/adr/0008-store-rollout-writes.md):
 * a store write, OFF unless MRM_STORE_ROLLOUT_ENABLED=true. Mounted under /api/workspaces.
 */
export type RolloutRoutesContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  rollout?: {
    /** MRM_STORE_ROLLOUT_ENABLED (default false). */
    enabled?: boolean;
    /** Builds the connector that can read and change a rollout (fakes in tests). */
    connectorFactory?: RolloutConnectorFactory;
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
/** The change and the release it is about. Which fields apply depends on the app's platform (checked by the service). */
const requestShape = {
  action: z.string().min(1).max(40),
  track: z.string().min(1).max(100).optional(),
  versionCodes: z.array(z.string().min(1).max(12)).min(1).max(50).optional(),
  version: z.string().min(1).max(64).optional(),
  userFraction: z.number().finite().optional(),
};
const previewBody = z.object(requestShape).strict();
const applyBody = z
  .object({
    ...requestShape,
    confirmHash: z
      .string()
      .regex(hash64, 'The confirmHash of the preview, 64 hexadecimal characters.'),
  })
  .strict();

/** A comma separated or repeated query parameter as a list of strings. */
const list = (c: Context<AppEnv>, name: string): string[] =>
  (c.req.queries(name) ?? [])
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => v !== '');

export function rolloutRoutes(ctx: RolloutRoutesContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();
  const rolloutCtx: RolloutContext = {
    db,
    masterKey: ctx.masterKey,
    now: ctx.now,
    rolloutEnabled: ctx.rollout?.enabled ?? false,
    rolloutConnectorFactory: ctx.rollout?.connectorFactory ?? defaultRolloutConnectorFactory,
    ...(ctx.rollout?.timeoutMs !== undefined ? { rolloutTimeoutMs: ctx.rollout.timeoutMs } : {}),
    ...(ctx.rollout?.claimTtlMs !== undefined ? { claimTtlMs: ctx.rollout.claimTtlMs } : {}),
  };
  const off = (c: Context<AppEnv>) => respond(c, rolloutDisabledFailure());

  /** Not a member and no such workspace look the same (404). A member without the right gets 403. */
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };

  routes.get('/:workspaceId/rollout/config', needs('apps.read'), (c) =>
    c.json(rolloutConfig(rolloutCtx)),
  );

  routes.get('/:workspaceId/apps/:id/rollout/state', needs('releases.rollout'), async (c) => {
    if (!rolloutCtx.rolloutEnabled) return off(c);
    const versionCodes = list(c, 'versionCodes');
    const done = await readRolloutState(rolloutCtx, {
      workspaceId: ws(c),
      appId: param(c, 'id'),
      target: {
        track: c.req.query('track'),
        versionCodes: versionCodes.length > 0 ? versionCodes : undefined,
        version: c.req.query('version'),
      },
      actor: actor(c),
    });
    return done.ok ? c.json(done.state) : respond(c, done);
  });

  routes.post('/:workspaceId/apps/:id/rollout/preview', needs('releases.rollout'), async (c) => {
    if (!rolloutCtx.rolloutEnabled) return off(c);
    const body = await parseBody(c, previewBody);
    if (!body.ok) return body.response;
    const done = await previewRollout(rolloutCtx, {
      workspaceId: ws(c),
      appId: param(c, 'id'),
      request: body.data,
      actor: actor(c),
    });
    return done.ok ? c.json({ preview: done.preview }) : respond(c, done);
  });

  // The only route that changes a rollout in a store. One app per request: no bulk change.
  routes.post('/:workspaceId/apps/:id/rollout/apply', needs('releases.rollout'), async (c) => {
    if (!rolloutCtx.rolloutEnabled) return off(c);
    const stepUpRefusal = await requireStepUp({ db, now: ctx.now }, c, 'rollout', {
      id: param(c, 'id'),
      hashField: 'confirmHash',
    });
    if (stepUpRefusal) return stepUpRefusal;
    const body = await parseBody(c, applyBody);
    if (!body.ok) return body.response;
    const { confirmHash, ...request } = body.data;
    const done = await applyRollout(rolloutCtx, {
      workspaceId: ws(c),
      appId: param(c, 'id'),
      request,
      confirmHash,
      actor: actor(c),
    });
    return done.ok ? c.json({ result: done.result }) : respond(c, done);
  });

  return routes;
}
