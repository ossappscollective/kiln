import { type Action, can, sniffImageFormat } from '@mrm/core';
import type { Database } from '@mrm/db';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import type { AppEnv } from '../../http.ts';
import { memberRole } from '../../services/accounts.ts';
import type { AppIcons } from '../../services/app-icons.ts';
import { getApp } from '../../services/apps.ts';
import type { TestLimiter } from '../../services/credential-tests.ts';
import { type Failure, failure, type RepoContext } from '../../services/repositories.ts';
import { isCommitSha, openAssets } from './asset-repo.ts';
import { peekStoreImages, storeSideOf } from './store-images.ts';

export type AssetRoutesContext = {
  db: Database;
  now: () => number;
  /** Used only to read the media files of an app's repository (read-only). */
  repo: RepoContext;
  /** Index reads that miss the cache, per workspace per minute. Thumbnails of an indexed commit are not counted. */
  limiter: TestLimiter;
  icons: AppIcons;
};

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });

const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

export const IMAGE_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
} as const;

/** A path as the index lists it: relative, no traversal, no odd characters. The index is still the only authority. */
export function isPlainRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 1024) return false;
  if (path.includes('\0') || path.includes('\\') || path.startsWith('/')) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** `If-None-Match` matches an entity tag (a list, `*`, weak forms). */
export function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const bare = etag.replace(/^W\//, '');
  return header
    .split(',')
    .map((part) => part.trim().replace(/^W\//, ''))
    .some((part) => part === '*' || part === bare);
}

/**
 * Headers of every image this server sends from a third party's bytes (a file of a repository, a
 * store icon). The type is the one SNIFFED from the bytes (never svg or html), the browser must
 * not guess another one, and a sandboxed empty CSP keeps a file that is something else after all
 * from running or loading anything if it is opened in a tab.
 */
export function safeImageHeaders(
  type: string,
  etag: string,
  size: number,
  cache: string,
): Record<string, string> {
  return {
    'Content-Type': type,
    'Content-Length': String(size),
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': cache,
    ETag: etag,
  };
}

const asBody = (bytes: Uint8Array) => bytes as unknown as ConstructorParameters<typeof Response>[0];

const IMMUTABLE = 'private, max-age=31536000, immutable';

/**
 * The media files of an app's repository (the index, and one image at a time for thumbnails) and
 * the icon of an app. Read-only: nothing is sent to a store or written to a repository. Mounted
 * under /api/workspaces.
 */
export function assetRoutes(ctx: AssetRoutesContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();

  /** Not a member and no such workspace look the same (404). A member without the right gets 403. */
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const notFound = (c: Context<AppEnv>) => c.json({ error: 'not_found' }, 404);

  /** The gate in front of a repository read that missed the cache. */
  const gate = (c: Context<AppEnv>) => (): Failure | undefined => {
    const wait = ctx.limiter.take(ws(c));
    if (wait <= 0) return undefined;
    return {
      ...failure(429, 'rate_limited', `Too many repository reads. Try again in ${wait} seconds.`),
      headers: { 'Retry-After': String(wait) },
    };
  };

  routes.get('/:workspaceId/apps/:id/assets', needs('listing.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const opened = await openAssets({ repo: ctx.repo }, { workspaceId: ws(c), app }, actor(c), {
      onCompute: gate(c),
    });
    if (!opened.ok) return respond(c, opened);
    c.header('Cache-Control', 'no-store');
    // The store's counts of the last read that is still cached; no store request is made here.
    const side = peekStoreImages(ws(c), app.id, ctx.now());
    return c.json({
      ...opened.handle.view,
      ...(side ? { storeSide: storeSideOf(side) } : {}),
      cached: opened.cached,
    });
  });

  routes.get('/:workspaceId/apps/:id/assets/file', needs('listing.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const path = c.req.query('path') ?? '';
    const commit = c.req.query('commit');
    const issues: { path: string; message: string }[] = [];
    if (!isPlainRelativePath(path))
      issues.push({ path: 'path', message: 'A path from the asset index.' });
    if (commit !== undefined && !isCommitSha(commit))
      issues.push({ path: 'commit', message: 'The commit of the asset index (a full hash).' });
    if (issues.length > 0) return c.json({ error: 'invalid_request', issues }, 400);

    const opened = await openAssets(
      { repo: ctx.repo },
      { workspaceId: ws(c), app, ...(commit ? { commit } : {}) },
      actor(c),
      { onCompute: gate(c) },
    );
    if (!opened.ok) return respond(c, opened);
    const { handle } = opened;
    // Only what the index lists for this app's target. Anything else is not there.
    const listed =
      handle.view.status === 'ok' ? handle.view.assets.find((a) => a.path === path) : undefined;
    if (!listed || handle.view.commit === null) return notFound(c);
    if (listed.format === 'video') {
      return c.json(
        { error: 'unsupported_media', message: 'App previews are listed and not served.' },
        415,
      );
    }
    const etag = listed.oid ? `"${listed.oid}"` : undefined;
    const cache = commit ? IMMUTABLE : 'private, max-age=300';
    if (etag && matchesEtag(c.req.header('If-None-Match'), etag)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' },
      });
    }
    const file = await handle.readFile(path);
    if (!file.ok) {
      for (const [name, value] of Object.entries(file.headers ?? {})) c.header(name, value);
      return c.json({ error: file.error, message: file.message }, file.status);
    }
    const format = sniffImageFormat(file.bytes);
    if (!format) {
      return c.json(
        { error: 'unsupported_media', message: 'The file is not a png, jpeg, webp or gif image.' },
        415,
      );
    }
    return new Response(asBody(file.bytes), {
      status: 200,
      headers: safeImageHeaders(
        IMAGE_TYPES[format as keyof typeof IMAGE_TYPES],
        `"${file.oid}"`,
        file.bytes.length,
        cache,
      ),
    });
  });

  routes.get('/:workspaceId/apps/:id/icon', needs('apps.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const row = await ctx.icons.serve(ws(c), app, actor(c));
    if (!row?.data || !row.mediaType || !row.etag) {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'not_found', message: 'This app has no icon.' }, 404);
    }
    const etag = `"${row.etag}"`;
    const cache = c.req.query('v') === row.etag ? IMMUTABLE : 'private, max-age=300';
    if (matchesEtag(c.req.header('If-None-Match'), etag)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' },
      });
    }
    return new Response(asBody(row.data), {
      status: 200,
      headers: safeImageHeaders(row.mediaType, etag, row.data.length, cache),
    });
  });

  return routes;
}
