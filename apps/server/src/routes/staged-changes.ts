import { ASSET_KINDS, type Action, type AssetKind, can } from '@mrm/core';
import type { Database } from '@mrm/db';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody } from '../http.ts';
import { memberRole } from '../services/accounts.ts';
import type { TestLimiter } from '../services/credential-tests.ts';
import { type Failure, type RepoContext, failure } from '../services/repositories.ts';
import {
  type DraftConnectorFactory,
  type DraftContext,
  applyDraftPush,
  defaultDraftConnectorFactory,
  draftConfig,
  draftDisabledFailure,
  previewDraftPush,
} from '../services/store-draft.ts';
import { type StagedContext, clearStaged, getStagedChanges, stageAssets, stageText, unstage } from '../services/staged-changes.ts';

/**
 * Staged listing text and graphics of an app, and writing them to the store as a DRAFT
 * (docs/api/staged-changes.md, docs/adr/0009-staged-store-drafts.md). Staging reads and writes the
 * database only. The push is a store write, OFF unless MRM_STORE_DRAFT_WRITE_ENABLED=true, and never
 * submits anything. Mounted under /api/workspaces.
 */
export type StagedRoutesContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  /** Reads the media files of the app's repository (the same reads as the Assets tab). */
  repo: RepoContext;
  /** Index reads that miss the cache, per workspace per minute (the one of the Assets tab). */
  limiter: TestLimiter;
  draft?: {
    /** MRM_STORE_DRAFT_WRITE_ENABLED (default false). */
    enabled?: boolean;
    /** Builds the connector that can read and write a draft (fakes in tests). */
    connectorFactory?: DraftConnectorFactory;
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

const sources = z.enum(['local', 'repo', 'store']);
const textBody = z
  .object({
    locale: z.string().min(2).max(35),
    field: z.string().min(1).max(60),
    from: sources,
    value: z.string().max(40_000).optional(),
  })
  .strict();
const assetsBody = z
  .object({
    locale: z.string().min(2).max(35),
    kind: z.enum(ASSET_KINDS as unknown as [AssetKind, ...AssetKind[]]),
    device: z.string().min(1).max(60).nullable().optional(),
    from: sources.default('repo'),
    paths: z.array(z.string().min(1).max(1024)).min(1).max(100).optional(),
    commit: z.string().max(64).optional(),
  })
  .strict();
const hash64 = /^[0-9a-f]{64}$/;
const previewBody = z.object({}).strict().optional();
const pushBody = z.object({ confirmHash: z.string().regex(hash64, 'The confirmHash of the preview, 64 hexadecimal characters.') }).strict();

export function stagedRoutes(ctx: StagedRoutesContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();
  const staged: StagedContext = { db, now: ctx.now, assets: { repo: ctx.repo } };
  const draft: DraftContext = {
    db,
    masterKey: ctx.masterKey,
    now: ctx.now,
    draftEnabled: ctx.draft?.enabled ?? false,
    draftConnectorFactory: ctx.draft?.connectorFactory ?? defaultDraftConnectorFactory,
    assets: { repo: ctx.repo },
    ...(ctx.draft?.timeoutMs !== undefined ? { draftTimeoutMs: ctx.draft.timeoutMs } : {}),
    ...(ctx.draft?.claimTtlMs !== undefined ? { claimTtlMs: ctx.draft.claimTtlMs } : {}),
  };

  /** Not a member and no such workspace look the same (404). A member without the right gets 403. */
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const off = (c: Context<AppEnv>) => respond(c, draftDisabledFailure());
  const gate = (c: Context<AppEnv>) => (): Failure | undefined => {
    const wait = ctx.limiter.take(ws(c));
    if (wait <= 0) return undefined;
    return { ...failure(429, 'rate_limited', `Too many repository reads. Try again in ${wait} seconds.`), headers: { 'Retry-After': String(wait) } };
  };

  routes.get('/:workspaceId/store-draft/config', needs('apps.read'), (c) => c.json(draftConfig(draft)));

  routes.get('/:workspaceId/apps/:id/staged', needs('listing.read'), async (c) => {
    const done = await getStagedChanges(staged, { workspaceId: ws(c), appId: param(c, 'id') });
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ staged: done.staged }) : respond(c, done);
  });

  routes.put('/:workspaceId/apps/:id/staged/text', needs('changesets.write'), async (c) => {
    const body = await parseBody(c, textBody);
    if (!body.ok) return body.response;
    const done = await stageText(staged, { workspaceId: ws(c), appId: param(c, 'id'), ...body.data, actor: actor(c) });
    return done.ok ? c.json({ staged: done.staged }) : respond(c, done);
  });

  routes.put('/:workspaceId/apps/:id/staged/assets', needs('changesets.write'), async (c) => {
    const body = await parseBody(c, assetsBody);
    if (!body.ok) return body.response;
    const { device, ...rest } = body.data;
    const done = await stageAssets(staged, { workspaceId: ws(c), appId: param(c, 'id'), ...rest, device: device ?? null, actor: actor(c), gate: gate(c) });
    return done.ok ? c.json({ staged: done.staged }) : respond(c, done);
  });

  // One text (its id) or one whole set (`locale/slotKey`), by query so a slash needs no escaping.
  routes.delete('/:workspaceId/apps/:id/staged/items', needs('changesets.write'), async (c) => {
    const id = c.req.query('id') ?? '';
    if (id.length === 0 || id.length > 200) return c.json({ error: 'invalid_request', issues: [{ path: 'id', message: 'The id of a staged text, or locale/slotKey of a set.' }] }, 400);
    const done = await unstage(staged, { workspaceId: ws(c), appId: param(c, 'id'), id, actor: actor(c) });
    return done.ok ? c.json({ staged: done.staged }) : respond(c, done);
  });

  routes.delete('/:workspaceId/apps/:id/staged', needs('changesets.write'), async (c) => {
    const done = await clearStaged(staged, { workspaceId: ws(c), appId: param(c, 'id'), actor: actor(c) });
    return done.ok ? c.json({ staged: done.staged }) : respond(c, done);
  });

  routes.post('/:workspaceId/apps/:id/staged/push/preview', needs('store.push_draft'), async (c) => {
    if (!draft.draftEnabled) return off(c);
    const body = await parseBody(c, previewBody);
    if (!body.ok) return body.response;
    const done = await previewDraftPush(draft, { workspaceId: ws(c), appId: param(c, 'id'), actor: actor(c) });
    return done.ok ? c.json({ preview: done.preview }) : respond(c, done);
  });

  // The only route that writes to a store. One app per request: no bulk push. It never submits.
  routes.post('/:workspaceId/apps/:id/staged/push', needs('store.push_draft'), async (c) => {
    if (!draft.draftEnabled) return off(c);
    const body = await parseBody(c, pushBody);
    if (!body.ok) return body.response;
    const done = await applyDraftPush(draft, { workspaceId: ws(c), appId: param(c, 'id'), confirmHash: body.data.confirmHash, actor: actor(c) });
    return done.ok ? c.json({ result: done.result }) : respond(c, done);
  });

  return routes;
}
