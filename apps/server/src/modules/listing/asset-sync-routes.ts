import {
  type Action,
  ASSET_KINDS,
  ASSET_SYNC_LIMITS,
  type AssetKind,
  can,
  findDisplay,
  FIX_KINDS,
  type FixKind,
  groupStoreImages,
  refsOfDisplay,
  sniffImageFormat,
} from '@kiln/core';
import type { Database } from '@kiln/db';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody } from '../../http.ts';
import { memberRole } from '../../services/accounts.ts';
import { getApp } from '../../services/apps.ts';
import { createTestLimiter, type TestLimiter } from '../../services/credential-tests.ts';
import { parseHexColour } from '../../services/image-fix.ts';
import { type Failure, failure, type RepoContext } from '../../services/repositories.ts';
import { getBlob } from '../publish/staged-asset-blobs.ts';
import {
  fixFile,
  inspectForSlot,
  moveInSet,
  removeFiles,
  removeFromSet,
  stagedSetsToRepo,
  stageUpload,
} from '../publish/staged-asset-ops.ts';
import type { StagedContext } from '../publish/staged-changes.ts';
import {
  type DraftConnectorFactory,
  type DraftContext,
  defaultDraftConnectorFactory,
} from '../publish/store-draft.ts';
import { buildAssetDiff } from './asset-diff.ts';
import { mountAssetProposalRoutes } from './asset-proposal-routes.ts';
import { pullStoreImages } from './asset-pull.ts';
import { IMAGE_TYPES, matchesEtag, safeImageHeaders } from './asset-routes.ts';
import { withinDeadline } from './compare-deadline.ts';
import { storeSeed } from './staged-store-seed.ts';
import type { StoreImageNet } from './store-image-net.ts';
import { getStoreImages, storeImageBytes, storeThumbnail, thumbSizeOf } from './store-images.ts';

/** A thumbnail's ref names the image and its checksum, so the same ref is the same picture: private, an hour, then revalidated by ETag. */
export const THUMB_CACHE_CONTROL = 'private, max-age=3600, stale-while-revalidate=86400';

import { coded } from '../../i18n/problem.ts';
/**
 * Two way sync of the app's graphics (docs/api/assets.md, docs/api/staged-changes.md, docs/adr/0012-assets-two-way-sync.md):
 * the store's images, their comparison with the repository, pulling them into a change set, uploading, replacing, removing
 * and fixing the files of a staged set, and putting staged sets into the repository. Reads of a store change nothing in it;
 * the only store write stays the gated draft push of staged-changes.ts. Mounted under /api/workspaces.
 */
export type AssetSyncRoutesContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  repo: RepoContext;
  /** Reads of the repository that miss the cache (the limiter of the Assets tab). */
  limiter: TestLimiter;
  draft?: { connectorFactory?: DraftConnectorFactory; timeoutMs?: number };
  /** Address checks and the exchange of the CDN downloads (tests and development). */
  net?: StoreImageNet;
  /** Store reads that miss the cache, per workspace (default 12 a minute). */
  storeLimiter?: TestLimiter;
  /** Thumbnails and downloads from the CDN, per workspace (default 300 a minute). */
  fetchLimiter?: TestLimiter;
  /** Uploads, inspections and fixes, per workspace (default 60 a minute). */
  uploadLimiter?: TestLimiter;
  /** The time limit of a comparison with the store (`GET assets/diff`, the release asset proposal): default 25 seconds, tests make it short. */
  compareDeadlineMs?: number;
};

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });

const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

const asBody = (bytes: Uint8Array) => bytes as unknown as ConstructorParameters<typeof Response>[0];

/** The request body as bytes, at most `max`: refused by `Content-Length` first, then while it is read. */
export async function readBodyCapped(
  req: Request,
  max: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: 400 | 413; message: string }> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max)
    return {
      ok: false,
      status: 413,
      message: `The file is larger than ${Math.floor(max / (1024 * 1024))} MB.`,
    };
  if (!req.body)
    return { ok: false, status: 400, message: 'The request has no body: send the image bytes.' };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return {
        ok: false,
        status: 413,
        message: `The file is larger than ${Math.floor(max / (1024 * 1024))} MB.`,
      };
    }
    chunks.push(value);
  }
  if (total === 0)
    return { ok: false, status: 400, message: 'The request has no body: send the image bytes.' };
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { ok: true, bytes };
}

const OID = /^[0-9a-f]{40}$/;
const REF = /^[0-9a-f]{32}$/;
const kinds = z.enum(ASSET_KINDS as unknown as [AssetKind, ...AssetKind[]]);
const selectionBody = z
  .object({
    sets: z.array(z.string().min(3).max(200)).max(200).optional(),
    files: z.array(z.string().min(3).max(220)).max(ASSET_SYNC_LIMITS.maxPullFiles).optional(),
    prune: z.boolean().optional(),
  })
  .strict();
const fixBody = z
  .object({
    locale: z.string().min(2).max(35),
    kind: kinds,
    device: z.string().min(1).max(60).nullable().optional(),
    position: z.number().int().min(1).max(200),
    fix: z.enum(FIX_KINDS as unknown as [FixKind, ...FixKind[]]),
    background: z.string().max(9).optional(),
  })
  .strict();
const moveBody = z
  .object({
    locale: z.string().min(2).max(35),
    kind: kinds,
    device: z.string().min(1).max(60).nullable().optional(),
    from: z.number().int().min(1).max(200),
    to: z.number().int().min(1).max(200),
    base: z.enum(['store']).optional(),
  })
  .strict();
const removeBody = z
  .object({
    locale: z.string().min(2).max(35),
    kind: kinds,
    device: z.string().min(1).max(60).nullable().optional(),
    files: z
      .array(
        z
          .object({
            ref: z.string().min(1).max(400).optional(),
            oid: z.string().min(1).max(64).optional(),
            position: z.number().int().min(1).max(100_000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    base: z.enum(['store']).optional(),
  })
  .strict();
const toRepoBody = z
  .object({ sets: z.array(z.string().min(3).max(200)).max(200).optional() })
  .strict();

export function assetSyncRoutes(ctx: AssetSyncRoutesContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();
  const staged: StagedContext = { db, now: ctx.now, assets: { repo: ctx.repo } };
  const draft: DraftContext = {
    db,
    masterKey: ctx.masterKey,
    now: ctx.now,
    // Reading a store's images is never a write: the draft switch does not apply, and nothing here writes a draft.
    draftEnabled: false,
    draftConnectorFactory: ctx.draft?.connectorFactory ?? defaultDraftConnectorFactory,
    assets: { repo: ctx.repo },
    ...(ctx.draft?.timeoutMs !== undefined ? { draftTimeoutMs: ctx.draft.timeoutMs } : {}),
  };
  const store = {
    draft,
    limiter: ctx.storeLimiter ?? createTestLimiter({ now: ctx.now, limit: 12 }),
    fetchLimiter: ctx.fetchLimiter ?? createTestLimiter({ now: ctx.now, limit: 300 }),
    ...(ctx.net ? { net: ctx.net } : {}),
  };
  const sync = { assets: { repo: ctx.repo }, store };
  const uploads = ctx.uploadLimiter ?? createTestLimiter({ now: ctx.now, limit: 60 });

  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const gate = (c: Context<AppEnv>) => (): Failure | undefined => {
    const wait = ctx.limiter.take(ws(c));
    if (wait <= 0) return undefined;
    return {
      ...failure(
        429,
        'rate_limited',
        `Too many repository reads. Try again in ${wait} seconds.`,
        coded('rate.repositoryReads', { count: wait }),
      ),
      headers: { 'Retry-After': String(wait) },
    };
  };
  const uploadGate = (c: Context<AppEnv>): Failure | undefined => {
    const wait = uploads.take(ws(c));
    return wait <= 0
      ? undefined
      : {
          ...failure(
            429,
            'rate_limited',
            `Too many uploads. Try again in ${wait} seconds.`,
            coded('rate.uploads', { count: wait }),
          ),
          headers: { 'Retry-After': String(wait) },
        };
  };
  const notFound = (c: Context<AppEnv>) => c.json({ error: 'not_found' }, 404);
  /** `base=store`: an unstaged set starts from the images the store holds (the Graphics tab edits the store's side). */
  const seedOf = async (
    c: Context<AppEnv>,
    slot: { locale: string; kind: string; device: string | null },
    base: string | undefined,
  ) => {
    if (base !== 'store') return undefined;
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return undefined;
    return storeSeed(store, {
      workspaceId: ws(c),
      app,
      locale: slot.locale,
      slot: { kind: slot.kind as AssetKind, device: slot.device },
      actor: actor(c),
    });
  };
  const slotQuery = (c: Context<AppEnv>) => {
    const kind = kinds.safeParse(c.req.query('kind'));
    const locale = c.req.query('locale') ?? '';
    const device = c.req.query('device');
    const issues: { path: string; message: string }[] = [];
    if (!kind.success) issues.push({ path: 'kind', message: 'A kind of graphic.' });
    if (locale.length < 2 || locale.length > 35)
      issues.push({ path: 'locale', message: 'A store locale code such as en-US.' });
    if (device !== undefined && (device.length < 1 || device.length > 60))
      issues.push({ path: 'device', message: 'A display or device id.' });
    return issues.length > 0 || !kind.success
      ? { issues }
      : { slot: { locale, kind: kind.data as string, device: device ?? null } };
  };

  // ---- Reading the store ------------------------------------------------------------------------

  routes.get('/:workspaceId/apps/:id/assets/store', needs('listing.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const done = await getStoreImages(store, {
      workspaceId: ws(c),
      app,
      actor: actor(c),
      fresh: c.req.query('fresh') === '1',
      channel: c.req.query('channel') === 'live' ? 'live' : 'editable',
    });
    if (!done.ok) return respond(c, done);
    c.header('Cache-Control', 'no-store');
    return c.json({ store: done.view, cached: done.cached });
  });

  routes.get('/:workspaceId/apps/:id/assets/diff', needs('listing.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    // The step of Prepare release compares on a click, whatever the `compareMedia` setting says: this route never reads that setting.
    const done = await withinDeadline(
      buildAssetDiff(sync, {
        workspaceId: ws(c),
        app,
        actor: actor(c),
        fresh: c.req.query('fresh') === '1',
        gate: gate(c),
      }),
      ctx.compareDeadlineMs,
    );
    if (!done.ok) return respond(c, done);
    c.header('Cache-Control', 'no-store');
    return c.json({ diff: done.diff, cachedStore: done.cachedStore });
  });

  routes.get('/:workspaceId/apps/:id/assets/store/thumb', needs('listing.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const ref = c.req.query('ref') ?? '';
    if (!REF.test(ref))
      return c.json(
        {
          error: 'invalid_request',
          issues: [{ path: 'ref', message: 'The ref of an image of the comparison.' }],
        },
        400,
      );
    const size = thumbSizeOf(c.req.query('size'));
    // The ref names the image and its checksum, so the same ref is the same picture: a cheap 304.
    const etag = `"t-${ref}-${size}"`;
    const cache = THUMB_CACHE_CONTROL;
    if (matchesEtag(c.req.header('If-None-Match'), etag)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' },
      });
    }
    const done = await storeThumbnail(store, { workspaceId: ws(c), appId: app.id, ref, size });
    if (!done.ok) return respond(c, done);
    return new Response(asBody(done.bytes), {
      status: 200,
      headers: safeImageHeaders(IMAGE_TYPES[done.format], etag, done.bytes.length, cache),
    });
  });

  // The ORIGINAL file of one store image, for the viewer's Save and Copy (never a rendition): a download the person asked for.
  routes.get('/:workspaceId/apps/:id/assets/store/file', needs('listing.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const ref = c.req.query('ref') ?? '';
    if (!REF.test(ref))
      return c.json(
        {
          error: 'invalid_request',
          issues: [{ path: 'ref', message: 'The ref of an image of the store view.' }],
        },
        400,
      );
    const etag = `"f-${ref}"`;
    const cache = 'private, max-age=600';
    if (matchesEtag(c.req.header('If-None-Match'), etag)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' },
      });
    }
    const done = await storeImageBytes(store, {
      workspaceId: ws(c),
      appId: app.id,
      ref,
      maxBytes: ASSET_SYNC_LIMITS.maxUploadBytes,
    });
    if (!done.ok) return respond(c, done);
    return new Response(asBody(done.image.bytes), {
      status: 200,
      headers: safeImageHeaders(
        IMAGE_TYPES[done.image.format],
        etag,
        done.image.bytes.length,
        cache,
      ),
    });
  });

  // ---- Pull ---------------------------------------------------------------------------------------

  routes.post('/:workspaceId/apps/:id/assets/pull', needs('changesets.write'), async (c) => {
    const body = await parseBody(c, selectionBody);
    if (!body.ok) return body.response;
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const done = await pullStoreImages(sync, {
      workspaceId: ws(c),
      app,
      actor: actor(c),
      ...body.data,
      gate: gate(c),
    });
    return done.ok ? c.json({ pull: done.report }) : respond(c, done);
  });

  // ---- Staged uploads -------------------------------------------------------------------------------

  routes.post('/:workspaceId/apps/:id/assets/inspect', needs('changesets.write'), async (c) => {
    const q = slotQuery(c);
    if (!q.slot) return c.json({ error: 'invalid_request', issues: q.issues }, 400);
    const limited = uploadGate(c);
    if (limited) return respond(c, limited);
    const body = await readBodyCapped(c.req.raw, ASSET_SYNC_LIMITS.maxUploadBytes);
    if (!body.ok)
      return c.json(
        { error: body.status === 413 ? 'too_large' : 'invalid_request', message: body.message },
        body.status,
      );
    const done = await inspectForSlot(staged, {
      workspaceId: ws(c),
      appId: param(c, 'id'),
      ...q.slot,
      actor: actor(c),
      name: c.req.query('name'),
      bytes: body.bytes,
    });
    return done.ok ? c.json({ inspected: done.inspected }) : respond(c, done);
  });

  routes.put(
    '/:workspaceId/apps/:id/staged/assets/upload',
    needs('changesets.write'),
    async (c) => {
      const q = slotQuery(c);
      if (!q.slot) return c.json({ error: 'invalid_request', issues: q.issues }, 400);
      const mode = c.req.query('mode') ?? 'add';
      const positionRaw = c.req.query('position');
      const position = positionRaw === undefined ? undefined : Number(positionRaw);
      if (mode !== 'add' && mode !== 'replace')
        return c.json(
          { error: 'invalid_request', issues: [{ path: 'mode', message: 'add or replace.' }] },
          400,
        );
      if (position !== undefined && !Number.isInteger(position))
        return c.json(
          {
            error: 'invalid_request',
            issues: [{ path: 'position', message: 'A whole number, from 1.' }],
          },
          400,
        );
      const fixRaw = c.req.query('fix');
      const fix = fixRaw === undefined ? undefined : FIX_KINDS.find((k) => k === fixRaw);
      if (fixRaw !== undefined && fix === undefined)
        return c.json(
          { error: 'invalid_request', issues: [{ path: 'fix', message: FIX_KINDS.join(', ') }] },
          400,
        );
      const bgRaw = c.req.query('background');
      const background = bgRaw === undefined ? undefined : parseHexColour(bgRaw);
      if (bgRaw !== undefined && background === undefined)
        return c.json(
          {
            error: 'invalid_request',
            issues: [{ path: 'background', message: 'A colour such as #ffffff.' }],
          },
          400,
        );
      const limited = uploadGate(c);
      if (limited) return respond(c, limited);
      const body = await readBodyCapped(c.req.raw, ASSET_SYNC_LIMITS.maxUploadBytes);
      if (!body.ok)
        return c.json(
          { error: body.status === 413 ? 'too_large' : 'invalid_request', message: body.message },
          body.status,
        );
      const done = await stageUpload(staged, {
        workspaceId: ws(c),
        appId: param(c, 'id'),
        ...q.slot,
        actor: actor(c),
        gate: gate(c),
        seed: await seedOf(c, q.slot, c.req.query('base')),
        mode,
        position,
        name: c.req.query('name'),
        bytes: body.bytes,
        fix,
        background,
      });
      return done.ok ? c.json({ staged: done.staged, position: done.position }) : respond(c, done);
    },
  );

  routes.delete(
    '/:workspaceId/apps/:id/staged/assets/file',
    needs('changesets.write'),
    async (c) => {
      const q = slotQuery(c);
      if (!q.slot) return c.json({ error: 'invalid_request', issues: q.issues }, 400);
      const position = Number(c.req.query('position'));
      if (!Number.isInteger(position) || position < 1)
        return c.json(
          {
            error: 'invalid_request',
            issues: [{ path: 'position', message: 'A whole number, from 1.' }],
          },
          400,
        );
      const done = await removeFromSet(staged, {
        workspaceId: ws(c),
        appId: param(c, 'id'),
        ...q.slot,
        actor: actor(c),
        gate: gate(c),
        seed: await seedOf(c, q.slot, c.req.query('base')),
        position,
      });
      return done.ok ? c.json({ staged: done.staged }) : respond(c, done);
    },
  );

  routes.post(
    '/:workspaceId/apps/:id/staged/assets/remove',
    needs('changesets.write'),
    async (c) => {
      const body = await parseBody(c, removeBody);
      if (!body.ok) return body.response;
      const { base, device, files, ...rest } = body.data;
      const slot = { locale: rest.locale, kind: rest.kind as string, device: device ?? null };
      const app = await getApp(db, ws(c), param(c, 'id'));
      const done = await removeFiles(staged, {
        workspaceId: ws(c),
        appId: param(c, 'id'),
        ...rest,
        device: slot.device,
        actor: actor(c),
        gate: gate(c),
        seed: await seedOf(c, slot, base),
        files,
        knownStoreRefs: async () => {
          if (!app) return undefined;
          const read = await getStoreImages(store, { workspaceId: ws(c), app, actor: actor(c) });
          if (!read.ok) return undefined;
          // Every image of the display (all its groups): a removal may name any of them.
          const display = findDisplay(groupStoreImages(read.view), {
            locale: slot.locale,
            kind: slot.kind as AssetKind,
            device: slot.device,
          });
          return new Set(display === undefined ? [] : refsOfDisplay(display));
        },
      });
      return done.ok
        ? c.json({
            results: done.results,
            summary: done.summary,
            emptied: done.emptied,
            remaining: done.remaining,
            staged: done.staged,
          })
        : respond(c, done);
    },
  );

  routes.post('/:workspaceId/apps/:id/staged/assets/move', needs('changesets.write'), async (c) => {
    const body = await parseBody(c, moveBody);
    if (!body.ok) return body.response;
    const limited = uploadGate(c);
    if (limited) return respond(c, limited);
    const { base, device, ...rest } = body.data;
    const slot = { locale: rest.locale, kind: rest.kind as string, device: device ?? null };
    const done = await moveInSet(staged, {
      workspaceId: ws(c),
      appId: param(c, 'id'),
      ...rest,
      device: slot.device,
      actor: actor(c),
      gate: gate(c),
      seed: await seedOf(c, slot, base),
    });
    return done.ok ? c.json({ staged: done.staged }) : respond(c, done);
  });

  routes.post('/:workspaceId/apps/:id/staged/assets/fix', needs('changesets.write'), async (c) => {
    const body = await parseBody(c, fixBody);
    if (!body.ok) return body.response;
    const colour =
      body.data.background === undefined ? undefined : parseHexColour(body.data.background);
    if (body.data.background !== undefined && colour === undefined)
      return c.json(
        {
          error: 'invalid_request',
          issues: [{ path: 'background', message: 'A colour such as #ffffff.' }],
        },
        400,
      );
    const limited = uploadGate(c);
    if (limited) return respond(c, limited);
    const { background: _background, device, ...rest } = body.data;
    const done = await fixFile(staged, {
      workspaceId: ws(c),
      appId: param(c, 'id'),
      ...rest,
      device: device ?? null,
      actor: actor(c),
      gate: gate(c),
      background: colour,
    });
    return done.ok ? c.json({ staged: done.staged, summary: done.summary }) : respond(c, done);
  });

  routes.get('/:workspaceId/apps/:id/staged/assets/blob', needs('listing.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const oid = c.req.query('oid') ?? '';
    if (!OID.test(oid))
      return c.json(
        {
          error: 'invalid_request',
          issues: [{ path: 'oid', message: 'The blob id of a staged upload.' }],
        },
        400,
      );
    const etag = `"${oid}"`;
    const cache = 'private, max-age=31536000, immutable';
    if (matchesEtag(c.req.header('If-None-Match'), etag)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' },
      });
    }
    const blob = await getBlob(db, ws(c), app.id, oid);
    const format = blob ? sniffImageFormat(blob.bytes) : null;
    if (!blob || (format !== 'png' && format !== 'jpeg')) return notFound(c);
    return new Response(asBody(blob.bytes), {
      status: 200,
      headers: safeImageHeaders(IMAGE_TYPES[format], etag, blob.bytes.length, cache),
    });
  });

  routes.post(
    '/:workspaceId/apps/:id/staged/assets/to-repo',
    needs('changesets.write'),
    async (c) => {
      const body = await parseBody(c, toRepoBody);
      if (!body.ok) return body.response;
      const done = await stagedSetsToRepo(staged, {
        workspaceId: ws(c),
        appId: param(c, 'id'),
        sets: body.data.sets,
        actor: actor(c),
        gate: gate(c),
      });
      return done.ok ? c.json({ result: done.result }) : respond(c, done);
    },
  );

  // The release asset proposal (docs/adr/0063-release-asset-proposal.md): the repository's changes since the previous release, staged on request.
  mountAssetProposalRoutes(routes, {
    ctx: { sync, staged },
    needs,
    gate,
    respond,
    deadlineMs: ctx.compareDeadlineMs,
  });

  return routes;
}
