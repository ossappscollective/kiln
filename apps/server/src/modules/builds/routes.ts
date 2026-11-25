import { type Action, can } from '@kiln/core';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import type { AppEnv } from '../../http.ts';
import { memberRole } from '../../services/accounts.ts';
import { inspectArtifact } from './artifact-inspect.ts';
import {
  type BuildsContext,
  createDownloadLink,
  linkStillAllowed,
  listBuildArtifacts,
  openArtifactDownload,
  readDownloadLink,
  releaseLink,
  reserveLink,
} from './service.ts';

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

/** What a download answers with: the zip as it comes, never cached, never sniffed. */
const zipResponse = (opened: {
  body: ReadableStream<Uint8Array>;
  contentLength: number | null;
  filename: string;
}) =>
  new Response(opened.body, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${opened.filename}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...(opened.contentLength !== null ? { 'content-length': String(opened.contentLength) } : {}),
    },
  });

/** Builds to test: the CI artifacts of an app and its store builds, a download through the server, and a link for a phone. */
export function buildsRoutes(ctx: BuildsContext) {
  const app = new Hono<AppEnv>();
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(ctx.db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };

  app.get('/:workspaceId/apps/:id/builds/artifacts', needs('builds.read'), async (c) => {
    const wait = ctx.listLimiter.take(ws(c));
    if (wait > 0) {
      return respond(c, {
        ok: false,
        status: 429,
        body: { error: 'rate_limited', retryAfterSeconds: wait },
        headers: { 'Retry-After': String(wait) },
      });
    }
    const done = await listBuildArtifacts(
      ctx,
      { workspaceId: ws(c), appId: param(c, 'id') },
      actor(c),
    );
    if (!done.ok) return respond(c, done);
    return c.json({ ...done.list, canDownload: can(c.get('role'), 'builds.download') });
  });

  app.get(
    '/:workspaceId/apps/:id/builds/artifacts/:artifactId/download',
    needs('builds.download'),
    async (c) => {
      const opened = await openArtifactDownload(
        ctx,
        {
          workspaceId: ws(c),
          appId: param(c, 'id'),
          artifactId: param(c, 'artifactId'),
          via: 'session',
        },
        actor(c),
      );
      return opened.ok ? zipResponse(opened) : respond(c, opened);
    },
  );

  // The real build number of a CI artifact, read from inside the file (once: the answer is kept). Same rights, switch and limits as a download.
  app.post(
    '/:workspaceId/apps/:id/builds/artifacts/:artifactId/inspect',
    needs('builds.download'),
    async (c) => {
      const done = await inspectArtifact(
        ctx,
        { workspaceId: ws(c), appId: param(c, 'id'), artifactId: param(c, 'artifactId') },
        actor(c),
      );
      if (!done.ok) return respond(c, done);
      return c.json({ artifact: done.artifact });
    },
  );

  // A link a phone can open without signing in: ten minutes, once. The path is relative: the browser knows the address it reached us at.
  app.post(
    '/:workspaceId/apps/:id/builds/artifacts/:artifactId/link',
    needs('builds.download'),
    async (c) => {
      const done = await createDownloadLink(
        ctx,
        {
          workspaceId: ws(c),
          appId: param(c, 'id'),
          artifactId: param(c, 'artifactId'),
          userId: c.get('user').id,
        },
        actor(c),
      );
      if (!done.ok) return respond(c, done);
      return c.json({
        path: `/api/builds/dl/${done.token}`,
        expiresAt: done.expiresAt,
        filename: done.filename,
      });
    },
  );

  return app;
}

/** Public: the phone that scans the code is not signed in. The signed, single use token is the permission. */
export function publicBuildsRoutes(ctx: BuildsContext) {
  const app = new Hono<AppEnv>();
  app.get('/dl/:token', async (c) => {
    if (!ctx.builds.downloadEnabled) return c.json({ error: 'builds_download_disabled' }, 409);
    const read = readDownloadLink(ctx, param(c, 'token'));
    if (!read.ok) {
      if (read.reason === 'invalid') return c.json({ error: 'not_found' }, 404);
      return c.json(
        {
          error: read.reason === 'expired' ? 'link_expired' : 'link_used',
          message: 'Ask for a new link in Kiln.',
        },
        410,
      );
    }
    const { payload } = read;
    if (!reserveLink(ctx, payload))
      return c.json({ error: 'link_used', message: 'Ask for a new link in Kiln.' }, 410);
    if (!(await linkStillAllowed(ctx, payload))) {
      releaseLink(ctx, payload);
      return c.json({ error: 'not_found' }, 404);
    }
    const opened = await openArtifactDownload(
      ctx,
      { workspaceId: payload.w, appId: payload.a, artifactId: payload.i, via: 'link' },
      { type: 'user', id: payload.u },
    );
    if (!opened.ok) {
      releaseLink(ctx, payload);
      return respond(c, opened);
    }
    return zipResponse(opened);
  });
  return app;
}
