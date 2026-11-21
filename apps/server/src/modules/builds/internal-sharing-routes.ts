import { type Action, can } from '@kiln/core';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody } from '../../http.ts';
import { memberRole } from '../../services/accounts.ts';
import { requireStepUp } from '../../services/step-up.ts';
import {
  applyShare,
  listShares,
  previewShare,
  readShareLink,
  sharingConfig,
  sharingDisabledFailure,
} from './internal-sharing.ts';
import type { BuildsContext } from './service.ts';

/**
 * Google Play internal app sharing from the Test builds panel (docs/api/internal-sharing.md, docs/adr/0020-play-internal-sharing.md).
 * Mounted under /api/workspaces. OFF unless KILN_PLAY_INTERNAL_SHARING_ENABLED=true. Preview and apply need `builds.share` (owner and
 * admin; a token only when its actions name it); the apply also needs the step-up class `internal_sharing`.
 */

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });

type Fail = {
  ok: false;
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string> | undefined;
};
const respond = (c: Context<AppEnv>, f: Fail) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  // biome-ignore lint/suspicious/noExplicitAny: a status from a fixed list of codes
  return c.json(f.body, f.status as any);
};

const entry = z.string().min(1).max(300).optional();
export const internalSharePreviewBody = z.object({ entry }).strict();
export const internalShareApplyBody = z
  .object({
    entry,
    confirmHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'The confirmHash of the preview, 64 hexadecimal characters.'),
    confirmation: z.string().min(1).max(300),
  })
  .strict();

export function internalSharingRoutes(ctx: BuildsContext) {
  const routes = new Hono<AppEnv>();
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(ctx.db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const noStore = (c: Context<AppEnv>) => c.header('Cache-Control', 'no-store');

  routes.get('/:workspaceId/builds/internal-sharing/config', needs('builds.read'), (c) => {
    noStore(c);
    return c.json(sharingConfig(ctx, can(c.get('role'), 'builds.share')));
  });

  routes.get('/:workspaceId/apps/:id/builds/internal-shares', needs('builds.share'), async (c) => {
    const done = await listShares(ctx, { workspaceId: ws(c), appId: param(c, 'id') });
    noStore(c);
    return done.ok ? c.json(done.state) : respond(c, done);
  });

  // The only route that returns a stored link again. Same right as sharing; audited with ids only.
  routes.get(
    '/:workspaceId/apps/:id/builds/internal-shares/:shareId/link',
    needs('builds.share'),
    async (c) => {
      const done = await readShareLink(ctx, {
        workspaceId: ws(c),
        appId: param(c, 'id'),
        shareId: param(c, 'shareId'),
        actor: actor(c),
      });
      noStore(c);
      return done.ok
        ? c.json({ downloadUrl: done.downloadUrl, expiresAt: done.expiresAt })
        : respond(c, done);
    },
  );

  routes.post(
    '/:workspaceId/apps/:id/builds/artifacts/:artifactId/internal-share/preview',
    needs('builds.share'),
    async (c) => {
      if (!ctx.builds.internalSharingEnabled) return respond(c, sharingDisabledFailure());
      const body = await parseBody(c, internalSharePreviewBody);
      if (!body.ok) return body.response;
      const wait = ctx.listLimiter.take(ws(c));
      if (wait > 0)
        return respond(c, {
          ok: false,
          status: 429,
          body: { error: 'rate_limited', retryAfterSeconds: wait },
          headers: { 'Retry-After': String(wait) },
        });
      const done = await previewShare(ctx, {
        workspaceId: ws(c),
        appId: param(c, 'id'),
        artifactId: param(c, 'artifactId'),
        entry: body.data.entry,
        actor: actor(c),
      });
      noStore(c);
      return done.ok ? c.json({ preview: done.preview }) : respond(c, done);
    },
  );

  // The only route that uploads anything. One build per request. The kill switch first, then the step-up confirmation, then the body.
  routes.post(
    '/:workspaceId/apps/:id/builds/artifacts/:artifactId/internal-share',
    needs('builds.share'),
    async (c) => {
      if (!ctx.builds.internalSharingEnabled) return respond(c, sharingDisabledFailure());
      const refusal = await requireStepUp({ db: ctx.db, now: ctx.now }, c, 'internal_sharing', {
        id: param(c, 'id'),
        hashField: 'confirmHash',
      });
      if (refusal) return refusal;
      const body = await parseBody(c, internalShareApplyBody);
      if (!body.ok) return body.response;
      const done = await applyShare(ctx, {
        workspaceId: ws(c),
        appId: param(c, 'id'),
        artifactId: param(c, 'artifactId'),
        entry: body.data.entry,
        confirmHash: body.data.confirmHash,
        confirmation: body.data.confirmation,
        actor: actor(c),
      });
      noStore(c);
      return done.ok ? c.json({ result: done.result }) : respond(c, done);
    },
  );

  return routes;
}
