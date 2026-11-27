import { type Action, can } from '@kiln/core';
import type { Database } from '@kiln/db';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody } from '../../http.ts';
import { memberRole } from '../../services/accounts.ts';
import type { Failure } from '../../services/repositories.ts';
import { requireStepUp } from '../../services/step-up.ts';
import { notWhilePublishing } from './publishing.ts';
import {
  applyReviewCopy,
  applyVersion,
  defaultVersionConnectorFactory,
  previewReviewCopy,
  previewVersion,
  type VersionConnectorFactory,
  type VersionContext,
  versionDisabledFailure,
} from './store-version.ts';

/**
 * Creating the next App Store version (docs/api/store-version.md, docs/adr/0031-create-app-store-version.md): a reversible store
 * write behind the draft-write switch (KILN_STORE_DRAFT_WRITE_ENABLED) and the `store.push_draft` action (owner and admin; a token
 * only when its actions name it). Preview, then create with the preview's hash; no typed phrase. Mounted under /api/workspaces.
 */
export type VersionRoutesContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  /** The time to live of a batch publish claim (tests): while one runs for the app, the writes that guard themselves refuse. */
  publishClaimTtlMs?: number | undefined;
  version?: {
    /** KILN_STORE_DRAFT_WRITE_ENABLED (default false). */
    enabled?: boolean;
    /** Builds the connector that can read and create versions (fakes in tests). */
    connectorFactory?: VersionConnectorFactory;
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
const what = {
  versionString: z.string().trim().min(1).max(40),
  releaseType: z.enum(['MANUAL', 'AFTER_APPROVAL']).optional(),
};
export const versionPreviewBody = z.object(what).strict();
export const versionApplyBody = z
  .object({
    ...what,
    confirmHash: z
      .string()
      .regex(hash64, 'The confirmHash of the preview, 64 hexadecimal characters.'),
  })
  .strict();

export const reviewCopyBody = z
  .object({
    confirmHash: z
      .string()
      .regex(hash64, 'The confirmHash of the preview, 64 hexadecimal characters.'),
  })
  .strict();

export function storeVersionRoutes(ctx: VersionRoutesContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();
  /** Refused with `409 publish_in_progress` while a batch publish of the app runs (publishing.ts). */
  const notPublishing = notWhilePublishing({ db, now: ctx.now, claimTtlMs: ctx.publishClaimTtlMs });
  const version: VersionContext = {
    db,
    masterKey: ctx.masterKey,
    now: ctx.now,
    versionEnabled: ctx.version?.enabled ?? false,
    versionConnectorFactory: ctx.version?.connectorFactory ?? defaultVersionConnectorFactory,
    ...(ctx.version?.timeoutMs !== undefined ? { versionTimeoutMs: ctx.version.timeoutMs } : {}),
    ...(ctx.version?.claimTtlMs !== undefined ? { claimTtlMs: ctx.version.claimTtlMs } : {}),
  };

  /** Not a member and no such workspace look the same (404). A member without the right gets 403. */
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };

  routes.post(
    '/:workspaceId/apps/:id/store-version/preview',
    needs('store.push_draft'),
    async (c) => {
      if (!version.versionEnabled) return respond(c, versionDisabledFailure());
      const body = await parseBody(c, versionPreviewBody);
      if (!body.ok) return body.response;
      const done = await previewVersion(version, {
        workspaceId: ws(c),
        appId: param(c, 'id'),
        versionString: body.data.versionString,
        releaseType: body.data.releaseType,
        actor: actor(c),
      });
      c.header('Cache-Control', 'no-store');
      return done.ok ? c.json({ preview: done.preview }) : respond(c, done);
    },
  );

  // Creates one version of one app per request. It writes the version only: no text, no build, no submission, no release.
  routes.post(
    '/:workspaceId/apps/:id/store-version',
    needs('store.push_draft'),
    notPublishing,
    async (c) => {
      if (!version.versionEnabled) return respond(c, versionDisabledFailure());
      const stepUpRefusal = await requireStepUp({ db, now: ctx.now }, c, 'store.push_draft', {
        id: param(c, 'id'),
        hashField: 'confirmHash',
      });
      if (stepUpRefusal) return stepUpRefusal;
      const body = await parseBody(c, versionApplyBody);
      if (!body.ok) return body.response;
      const done = await applyVersion(version, {
        workspaceId: ws(c),
        appId: param(c, 'id'),
        versionString: body.data.versionString,
        releaseType: body.data.releaseType,
        confirmHash: body.data.confirmHash,
        actor: actor(c),
      });
      return done.ok ? c.json({ result: done.result }) : respond(c, done);
    },
  );

  // The App Review Information of the previous version, copied to the editable version that has none (docs/api/review-information.md).
  // Preview: a store read, masked (initials and yes/no), writes nothing. Apply: blank attributes only, never over a filled one.
  routes.post(
    '/:workspaceId/apps/:id/review-information/preview',
    needs('store.push_draft'),
    async (c) => {
      if (!version.versionEnabled) return respond(c, versionDisabledFailure());
      const done = await previewReviewCopy(version, {
        workspaceId: ws(c),
        appId: param(c, 'id'),
        actor: actor(c),
      });
      c.header('Cache-Control', 'no-store');
      return done.ok ? c.json({ preview: done.preview }) : respond(c, done);
    },
  );

  routes.post(
    '/:workspaceId/apps/:id/review-information',
    needs('store.push_draft'),
    notPublishing,
    async (c) => {
      if (!version.versionEnabled) return respond(c, versionDisabledFailure());
      const stepUpRefusal = await requireStepUp({ db, now: ctx.now }, c, 'store.push_draft', {
        id: param(c, 'id'),
        hashField: 'confirmHash',
      });
      if (stepUpRefusal) return stepUpRefusal;
      const body = await parseBody(c, reviewCopyBody);
      if (!body.ok) return body.response;
      const done = await applyReviewCopy(version, {
        workspaceId: ws(c),
        appId: param(c, 'id'),
        confirmHash: body.data.confirmHash,
        actor: actor(c),
      });
      c.header('Cache-Control', 'no-store');
      return done.ok ? c.json({ result: done.result }) : respond(c, done);
    },
  );

  return routes;
}
