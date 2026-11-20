import { type Action, can, canToken } from '@mrm/core';
import type { Database } from '@mrm/db';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody } from '../../http.ts';
import { memberRole } from '../../services/accounts.ts';
import type { Failure } from '../../services/repositories.ts';
import { requireStepUp, stepUpCovers } from '../../services/step-up.ts';
import type { AssetsContext } from '../listing/asset-repo.ts';
import { getPending, PUBLISH_STEPS, pendingSummary } from './pending.ts';
import {
  type DraftConnectorFactory,
  type DraftContext,
  defaultDraftConnectorFactory,
} from './store-draft.ts';
import {
  applyPublish,
  type PublishContext,
  type PublishRights,
  previewPublish,
  publishConfig,
  STEP_ACTION,
  type StepRequest,
} from './store-publish.ts';
import {
  defaultReleaseConnectorFactory,
  type ReleaseConnectorFactory,
  type ReleaseContext,
} from './store-release.ts';
import {
  defaultRolloutConnectorFactory,
  type RolloutConnectorFactory,
  type RolloutContext,
} from './store-rollout.ts';
import {
  defaultSubmitConnectorFactory,
  type SubmitConnectorFactory,
  type SubmitContext,
} from './store-submit.ts';

/**
 * Everything an app has pending, and publishing it in one go (docs/api/pending.md, docs/adr/0015-pending-and-batch-publish.md).
 *
 * - `GET /apps/:id/pending` and `GET /pending/summary` read STORED state only (no store, no repository) and need `listing.read`.
 * - `POST /apps/:id/publish/preview` and `POST /apps/:id/publish` need `store.publish` (owner and admin; a token only when its
 *   actions name it) AND, for every step they include, that step's own right (`store.push_draft`, `store.submit`, `store.release`,
 *   `releases.rollout`) and switch. The batch is OFF unless MRM_STORE_PUBLISH_BATCH_ENABLED=true and turns no step on by itself.
 *
 * Mounted under /api/workspaces.
 */
export type PendingRoutesContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  /** The repository seam the staged files are read through (the same the staged routes use). */
  repo: AssetsContext['repo'];
  publish?: {
    /** MRM_STORE_PUBLISH_BATCH_ENABLED (default false). */
    enabled?: boolean;
    claimTtlMs?: number;
  };
  /** The same seams as the individual steps (fakes in tests), so the batch reaches the stores the way they do. */
  draft?: {
    enabled?: boolean;
    connectorFactory?: DraftConnectorFactory;
    timeoutMs?: number;
    claimTtlMs?: number;
  };
  submit?: {
    enabled?: boolean;
    connectorFactory?: SubmitConnectorFactory;
    timeoutMs?: number;
    claimTtlMs?: number;
  };
  release?: {
    enabled?: boolean;
    connectorFactory?: ReleaseConnectorFactory;
    timeoutMs?: number;
    claimTtlMs?: number;
  };
  rollout?: {
    enabled?: boolean;
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
const releaseFields = {
  version: z.string().min(1).max(40).optional(),
  track: z.string().min(1).max(100).optional(),
  versionCodes: z
    .array(z.string().regex(/^[0-9]{1,12}$/, 'A version code is a whole number.'))
    .min(1)
    .max(50)
    .optional(),
  userFraction: z.number().finite().optional(),
  /** Google Play release: release the staged fields in one step (docs/adr/0029-direct-play-release.md). */
  direct: z.boolean().optional(),
};
/** One step of a batch. Which fields apply is checked per step; a field a step does not take is `422 invalid_steps`. */
export const stepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('push_draft') }).strict(),
  z.object({ type: z.literal('submit') }).strict(),
  z.object({ type: z.literal('release'), ...releaseFields }).strict(),
  z
    .object({ type: z.literal('rollout'), action: z.string().min(1).max(40), ...releaseFields })
    .strict(),
]);
export const publishPreviewBody = z
  .object({ steps: z.array(stepSchema).min(1).max(4).optional() })
  .strict()
  .optional();
export const publishApplyBody = z
  .object({
    planHash: z.string().regex(hash64, 'The planHash of a preview, 64 hexadecimal characters.'),
    phrase: z.string().max(300).optional(),
    steps: z.array(stepSchema).min(1).max(4),
  })
  .strict();

export function pendingRoutes(ctx: PendingRoutesContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();
  const assets: AssetsContext = { repo: ctx.repo };
  const draft: DraftContext = {
    db,
    masterKey: ctx.masterKey,
    now: ctx.now,
    draftEnabled: ctx.draft?.enabled ?? false,
    draftConnectorFactory: ctx.draft?.connectorFactory ?? defaultDraftConnectorFactory,
    assets,
    ...(ctx.draft?.timeoutMs !== undefined ? { draftTimeoutMs: ctx.draft.timeoutMs } : {}),
    ...(ctx.draft?.claimTtlMs !== undefined ? { claimTtlMs: ctx.draft.claimTtlMs } : {}),
  };
  const submit: SubmitContext = {
    db,
    masterKey: ctx.masterKey,
    now: ctx.now,
    submitEnabled: ctx.submit?.enabled ?? false,
    submitConnectorFactory: ctx.submit?.connectorFactory ?? defaultSubmitConnectorFactory,
    ...(ctx.submit?.timeoutMs !== undefined ? { submitTimeoutMs: ctx.submit.timeoutMs } : {}),
    ...(ctx.submit?.claimTtlMs !== undefined ? { claimTtlMs: ctx.submit.claimTtlMs } : {}),
  };
  const release: ReleaseContext = {
    db,
    masterKey: ctx.masterKey,
    now: ctx.now,
    releaseEnabled: ctx.release?.enabled ?? false,
    releaseConnectorFactory: ctx.release?.connectorFactory ?? defaultReleaseConnectorFactory,
    ...(ctx.release?.timeoutMs !== undefined ? { releaseTimeoutMs: ctx.release.timeoutMs } : {}),
    ...(ctx.release?.claimTtlMs !== undefined ? { claimTtlMs: ctx.release.claimTtlMs } : {}),
  };
  const rollout: RolloutContext = {
    db,
    masterKey: ctx.masterKey,
    now: ctx.now,
    rolloutEnabled: ctx.rollout?.enabled ?? false,
    rolloutConnectorFactory: ctx.rollout?.connectorFactory ?? defaultRolloutConnectorFactory,
    ...(ctx.rollout?.timeoutMs !== undefined ? { rolloutTimeoutMs: ctx.rollout.timeoutMs } : {}),
    ...(ctx.rollout?.claimTtlMs !== undefined ? { claimTtlMs: ctx.rollout.claimTtlMs } : {}),
  };
  const publish: PublishContext = {
    db,
    now: ctx.now,
    publishEnabled: ctx.publish?.enabled ?? false,
    draft,
    submit,
    release,
    rollout,
    ...(ctx.publish?.claimTtlMs !== undefined ? { claimTtlMs: ctx.publish.claimTtlMs } : {}),
  };

  /** Not a member and no such workspace look the same (404). A member without the right gets 403. */
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };

  /**
   * What the caller may do per step: the role of the member (already lowered to the token's ceiling) AND, for a token, its own list.
   * The registry checks `store.publish` only; each step's right is checked here, so a token needs the batch AND every step.
   */
  const rightsOf = (c: Context<AppEnv>): PublishRights => {
    const role = c.get('role');
    const token = c.get('token');
    const allowed = (action: Action) =>
      can(role, action) &&
      (token === undefined || canToken(token.ceiling, token.actions as Action[] | null, action));
    return Object.fromEntries(
      PUBLISH_STEPS.map((step) => [step, allowed(STEP_ACTION[step])]),
    ) as PublishRights;
  };

  routes.get('/:workspaceId/store-publish/config', needs('apps.read'), (c) =>
    c.json(publishConfig(publish)),
  );

  // Stored state only: no store and no repository is read, so these are cheap and need no switch.
  routes.get('/:workspaceId/apps/:id/pending', needs('listing.read'), async (c) => {
    const done = await getPending(db, {
      workspaceId: ws(c),
      appId: param(c, 'id'),
      now: ctx.now(),
    });
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ pending: done.pending }) : respond(c, done);
  });

  routes.get('/:workspaceId/pending/summary', needs('listing.read'), async (c) => {
    const tokenApps = c.get('token')?.appIds ?? undefined;
    const summary = await pendingSummary(db, {
      workspaceId: ws(c),
      ...(tokenApps ? { appIds: tokenApps as string[] } : {}),
      now: ctx.now(),
    });
    c.header('Cache-Control', 'no-store');
    return c.json(summary);
  });

  routes.post('/:workspaceId/apps/:id/publish/preview', needs('store.publish'), async (c) => {
    const body = await parseBody(c, publishPreviewBody);
    if (!body.ok) return body.response;
    const done = await previewPublish(publish, {
      workspaceId: ws(c),
      appId: param(c, 'id'),
      steps: body.data?.steps as StepRequest[] | undefined,
      rights: rightsOf(c),
      actor: actor(c),
      stepUpCovers: await stepUpCovers({ db, now: ctx.now }, c, 'store.publish'),
    });
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ plan: done.plan }) : respond(c, done);
  });

  // The only route that runs several gated store steps. One app per request: no bulk publish.
  routes.post('/:workspaceId/apps/:id/publish', needs('store.publish'), async (c) => {
    const stepUpRefusal = await requireStepUp({ db, now: ctx.now }, c, 'store.publish', {
      id: param(c, 'id'),
      hashField: 'planHash',
    });
    if (stepUpRefusal) return stepUpRefusal;
    const body = await parseBody(c, publishApplyBody);
    if (!body.ok) return body.response;
    const done = await applyPublish(publish, {
      workspaceId: ws(c),
      appId: param(c, 'id'),
      planHash: body.data.planHash,
      phrase: body.data.phrase,
      steps: body.data.steps as StepRequest[],
      rights: rightsOf(c),
      actor: actor(c),
      stepUpCovers: await stepUpCovers({ db, now: ctx.now }, c, 'store.publish'),
    });
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ result: done.result }) : respond(c, done);
  });

  return routes;
}
