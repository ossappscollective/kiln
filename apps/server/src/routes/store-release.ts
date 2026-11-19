import { type Action, can } from '@mrm/core';
import type { Database } from '@mrm/db';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody } from '../http.ts';
import { memberRole } from '../services/accounts.ts';
import { getApp } from '../services/apps.ts';
import { createTestLimiter } from '../services/credential-tests.ts';
import { type Failure, failure } from '../services/repositories.ts';
import {
  type DraftConnectorFactory,
  type StoreConnectContext,
  defaultDraftConnectorFactory,
  readEditableReleaseOf,
  readReleaseCandidatesOf,
} from '../services/store-draft.ts';
import {
  type ReleaseConnectorFactory,
  type ReleaseContext,
  applyRelease,
  defaultReleaseConnectorFactory,
  getReleaseState,
  previewRelease,
  releaseConfig,
  releaseDisabledFailure,
} from '../services/store-release.ts';

/**
 * Releasing from the app (docs/api/releases-write.md, docs/adr/0014-release-management.md). Two kinds of route:
 *
 * - READS of what a draft release is made of (processed builds, uploaded version codes, the draft's release fields). They look at
 *   the store with the credential of the app and change nothing, so they are not behind a switch (like the store images).
 * - The IRREVERSIBLE step: releasing an approved App Store version, or starting a Google Play draft release at an explicit share of
 *   users. OFF unless MRM_STORE_RELEASE_ENABLED=true, needing the `store.release` action (owner and admin; a token only when its
 *   actions name it), a preview, its `confirmHash` and a typed phrase. One app per request: no bulk release.
 *
 * Mounted under /api/workspaces.
 */
export type ReleaseRoutesContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  /** Reads of the store (the connector the draft push uses; fakes in tests). */
  draft?: { connectorFactory?: DraftConnectorFactory; timeoutMs?: number };
  release?: {
    /** MRM_STORE_RELEASE_ENABLED (default false). */
    enabled?: boolean;
    /** Builds the connector that can read and release (fakes in tests). */
    connectorFactory?: ReleaseConnectorFactory;
    timeoutMs?: number;
    claimTtlMs?: number;
  };
  /** Store reads per workspace per minute (the reads of builds and version codes). */
  readLimit?: number;
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
  version: z.string().min(1).max(40).optional(),
  track: z.string().min(1).max(100).optional(),
  versionCodes: z.array(z.string().regex(/^[0-9]{1,10}$/, 'A version code is a whole number.')).min(1).max(20).optional(),
  userFraction: z.number().gt(0).lte(1).optional(),
};
const previewBody = z.object(what).strict();
const applyBody = z
  .object({
    ...what,
    confirmHash: z.string().regex(hash64, 'The confirmHash of the preview, 64 hexadecimal characters.'),
    confirmation: z.string().min(1).max(300),
  })
  .strict();

export function storeReleaseRoutes(ctx: ReleaseRoutesContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();
  const release: ReleaseContext = {
    db,
    masterKey: ctx.masterKey,
    now: ctx.now,
    releaseEnabled: ctx.release?.enabled ?? false,
    releaseConnectorFactory: ctx.release?.connectorFactory ?? defaultReleaseConnectorFactory,
    ...(ctx.release?.timeoutMs !== undefined ? { releaseTimeoutMs: ctx.release.timeoutMs } : {}),
    ...(ctx.release?.claimTtlMs !== undefined ? { claimTtlMs: ctx.release.claimTtlMs } : {}),
  };
  const reads: StoreConnectContext = {
    db,
    masterKey: ctx.masterKey,
    now: ctx.now,
    draftConnectorFactory: ctx.draft?.connectorFactory ?? defaultDraftConnectorFactory,
    ...(ctx.draft?.timeoutMs !== undefined ? { draftTimeoutMs: ctx.draft.timeoutMs } : {}),
  };
  const limiter = createTestLimiter({ limit: ctx.readLimit ?? 30, now: ctx.now });

  /** Not a member and no such workspace look the same (404). A member without the right gets 403. */
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const throttled = (c: Context<AppEnv>): Failure | undefined => {
    const wait = limiter.take(ws(c));
    if (wait <= 0) return undefined;
    return { ...failure(429, 'rate_limited', `Too many store reads. Try again in ${wait} seconds.`), headers: { 'Retry-After': String(wait) } };
  };

  // ----- reads: what a draft release is made of

  routes.get('/:workspaceId/apps/:id/release/candidates', needs('listing.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return c.json({ error: 'not_found' }, 404);
    const wait = throttled(c);
    if (wait) return respond(c, wait);
    const done = await readReleaseCandidatesOf(reads, { workspaceId: ws(c), app, actor: actor(c), version: c.req.query('version') || undefined, track: c.req.query('track') || undefined });
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ candidates: done.read }) : respond(c, done);
  });

  routes.get('/:workspaceId/apps/:id/release/editable', needs('listing.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return c.json({ error: 'not_found' }, 404);
    const wait = throttled(c);
    if (wait) return respond(c, wait);
    const done = await readEditableReleaseOf(reads, { workspaceId: ws(c), app, actor: actor(c), track: c.req.query('track') || undefined });
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ editable: done.read }) : respond(c, done);
  });

  // ----- the irreversible step

  routes.get('/:workspaceId/store-release/config', needs('apps.read'), (c) => c.json(releaseConfig(release)));

  routes.get('/:workspaceId/apps/:id/store-release', needs('store.release'), async (c) => {
    const done = await getReleaseState(release, { workspaceId: ws(c), appId: param(c, 'id') });
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ release: done.state }) : respond(c, done);
  });

  routes.post('/:workspaceId/apps/:id/store-release/preview', needs('store.release'), async (c) => {
    if (!release.releaseEnabled) return respond(c, releaseDisabledFailure());
    const body = await parseBody(c, previewBody);
    if (!body.ok) return body.response;
    const done = await previewRelease(release, { workspaceId: ws(c), appId: param(c, 'id'), ...body.data, actor: actor(c) });
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ preview: done.preview }) : respond(c, done);
  });

  // The only route that releases anything. One app per request: no bulk release.
  routes.post('/:workspaceId/apps/:id/store-release', needs('store.release'), async (c) => {
    if (!release.releaseEnabled) return respond(c, releaseDisabledFailure());
    const body = await parseBody(c, applyBody);
    if (!body.ok) return body.response;
    const done = await applyRelease(release, { workspaceId: ws(c), appId: param(c, 'id'), ...body.data, actor: actor(c) });
    return done.ok ? c.json({ result: done.result }) : respond(c, done);
  });

  return routes;
}
