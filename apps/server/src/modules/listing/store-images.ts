import { createHash } from 'node:crypto';
import type { StoreImageRecord, StoreImagesRead } from '@kiln/connectors';
import {
  ASSET_SYNC_LIMITS,
  type AssetPlatform,
  type AssetStore,
  assetStoreOf,
  deviceLabel,
  type StoreImageSet,
  type StoreImagesView,
  storeImageKey,
} from '@kiln/core';
import { coded } from '../../i18n/problem.ts';
import type { ManagedApp } from '../../services/apps.ts';
import type { TestLimiter } from '../../services/credential-tests.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { type DraftContext, onDraftPushed, readStoreImagesOf } from '../publish/store-draft.ts';
import {
  type Downloaded,
  type DownloadFailure,
  downloadStoreImage,
  type ImageProbe,
  type ImageSource,
  imageUrlOf,
  probeStoreImage,
  type StoreImageNet,
} from './store-image-net.ts';

/**
 * The images a store holds for an app, as this server shows them (docs/adr/0012-assets-two-way-sync.md): read through the
 * connector (never a write), kept for `storeCacheSeconds`, and served as thumbnails by a proxy that only fetches from the
 * stores' CDN hosts (store-image-net.ts). A client never receives a store address: each image has an opaque `ref`, a hash of the
 * app, the image and its checksum, that this module maps back to the address it read. The map is bounded and forgets after
 * `REF_TTL_MS`; a ref that is not known any more is a `404 ref_expired` and the client reads the diff again.
 */

type Actor = { type: 'user' | 'token' | 'system'; id: string };

export type StoreImagesContext = {
  draft: DraftContext;
  net?: StoreImageNet;
  /** Store reads that miss the cache, per workspace. */
  limiter: TestLimiter;
  /** Thumbnails and downloads from the CDN, per workspace. */
  fetchLimiter: TestLimiter;
};

const REF_TTL_MS = 15 * 60 * 1000;
const REF_MAX = 4000;

export type RefEntry = {
  workspaceId: string;
  appId: string;
  src: ImageSource | null;
  checksum: string | null;
  checksumKind: 'sha256' | 'md5' | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  key: string;
  at: number;
};

const refs = new Map<string, RefEntry>();
const views = new Map<string, { at: number; view: StoreImagesView }>();
const thumbs = new Map<string, { bytes: Uint8Array; format: Downloaded['format'] }>();
let thumbBytes = 0;
const THUMB_MAX_BYTES = 24 * 1024 * 1024;
const THUMB_MAX_ENTRIES = 400;

/** The seconds a store read is reused (`ASSET_SYNC_LIMITS.storeCacheSeconds`); a staged change, a publish or a fresh read drops it. */
export const STORE_VIEW_TTL_SECONDS = ASSET_SYNC_LIMITS.storeCacheSeconds;

/** Header probes (pixel size and length of images whose store gives neither): at most this many per read, this many at once. */
export const PROBE_MAX_PER_READ = 80;
const PROBE_CONCURRENCY = 4;
const PROBE_CACHE_MAX = 4000;
const probes = new Map<string, ImageProbe>();

/** For tests. */
export function clearStoreImageCaches(): void {
  refs.clear();
  views.clear();
  probes.clear();
  thumbs.clear();
  thumbBytes = 0;
}

/** App Store: `editable` is the version a push edits (else the live one), `live` the live version only. Google Play has one listing. */
export type StoreChannel = 'editable' | 'live';

const viewKey = (workspaceId: string, appId: string, channel: StoreChannel = 'editable') =>
  channel === 'live' ? `${workspaceId}|${appId}|live` : `${workspaceId}|${appId}`;

/** Drops the cached store reads of an app, of both channels (a staged change, a publish or a refresh makes them stale). */
export function invalidateStoreImages(workspaceId: string, appId: string): void {
  views.delete(viewKey(workspaceId, appId));
  views.delete(viewKey(workspaceId, appId, 'live'));
}

onDraftPushed(invalidateStoreImages);

/**
 * Fills in the pixel size and length of images the store does not state (Google Play gives only an address) by reading the first
 * bytes of each, so that the store side checks can run. A probe that fails leaves the image unchecked. Bounded by
 * `PROBE_MAX_PER_READ`, `PROBE_CONCURRENCY` and a per-workspace cache that is keyed by the image id and its checksum.
 */
export async function probeMissingSizes(
  ctx: StoreImagesContext,
  workspaceId: string,
  appId: string,
  images: StoreImageRecord[],
): Promise<{ probed: number; failed: number }> {
  const todo = images.filter(
    (i) => i.width === null && i.height === null && i.url !== null && i.urlKind === 'play_url',
  );
  let probed = 0;
  let failed = 0;
  const apply = (image: StoreImageRecord, hit: ImageProbe) => {
    image.width = hit.width;
    image.height = hit.height;
    image.sizeFrom = 'header';
    if (image.bytes === null) image.bytes = hit.bytes;
  };
  const queue: StoreImageRecord[] = [];
  for (const image of todo) {
    const key = `${workspaceId}|${appId}|${image.id}|${image.checksum ?? ''}`;
    const hit = probes.get(key);
    if (hit) apply(image, hit);
    else if (queue.length < PROBE_MAX_PER_READ) queue.push(image);
    else failed += 1;
  }
  const worker = async () => {
    for (let image = queue.shift(); image; image = queue.shift()) {
      // The ORIGINAL size (`=s0`): a default Google rendition is downscaled and its size must never be checked.
      const address =
        image.url === null
          ? null
          : imageUrlOf(
              { url: image.url, urlKind: 'play_url', width: null, height: null },
              { original: true },
            );
      const got = address === null ? null : await probeStoreImage(ctx.net, address);
      if (!got) {
        failed += 1;
        continue;
      }
      probed += 1;
      apply(image, got);
      const key = `${workspaceId}|${appId}|${image.id}|${image.checksum ?? ''}`;
      probes.delete(key);
      probes.set(key, got);
      while (probes.size > PROBE_CACHE_MAX) {
        const oldest = probes.keys().next().value;
        if (oldest === undefined) break;
        probes.delete(oldest);
      }
    }
  };
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));
  return { probed, failed };
}

const rememberRef = (ref: string, entry: RefEntry) => {
  refs.delete(ref);
  refs.set(ref, entry);
  while (refs.size > REF_MAX) {
    const oldest = refs.keys().next().value;
    if (oldest === undefined) break;
    refs.delete(oldest);
  }
};

export const refOf = (
  workspaceId: string,
  appId: string,
  key: string,
  id: string,
  checksum: string | null,
): string =>
  createHash('sha256')
    .update(`${workspaceId}\0${appId}\0${key}\0${id}\0${checksum ?? ''}`)
    .digest('hex')
    .slice(0, 32);

/** The address data behind a ref, when it is known, belongs to this workspace and app, and is not too old. */
export function resolveRef(
  ref: string,
  workspaceId: string,
  appId: string,
  now: number,
): RefEntry | undefined {
  const entry = refs.get(ref);
  if (
    !entry ||
    entry.workspaceId !== workspaceId ||
    entry.appId !== appId ||
    now - entry.at > REF_TTL_MS
  )
    return undefined;
  return entry;
}

const platformOf = (app: ManagedApp): AssetPlatform => app.platform;

/** The view of a read, and the refs of its images. */
function build(
  ctx: StoreImagesContext,
  workspaceId: string,
  app: ManagedApp,
  read: StoreImagesRead,
  now: number,
): StoreImagesView {
  const platform = platformOf(app);
  const store: AssetStore = assetStoreOf(app.platform);
  const sets = new Map<string, StoreImageSet>();
  const ordered = read.images
    .slice()
    .sort(
      (a, b) =>
        a.locale.localeCompare(b.locale) ||
        a.kind.localeCompare(b.kind) ||
        (a.device ?? '').localeCompare(b.device ?? '') ||
        a.position - b.position,
    );
  for (const image of ordered) {
    const setId = `${image.locale}\0${image.kind}\0${image.device ?? ''}\0${image.target}`;
    let set = sets.get(setId);
    if (!set) {
      set = {
        platform,
        locale: image.locale,
        kind: image.kind,
        device: image.device,
        deviceLabel: deviceLabel(store, image.device),
        target: image.target,
        files: [],
      };
      sets.set(setId, set);
    }
    const key = storeImageKey(
      platform,
      image.locale,
      { kind: image.kind, device: image.device },
      image.position,
    );
    const ref = refOf(workspaceId, app.id, key, image.id, image.checksum);
    const src = sourceOf(image);
    rememberRef(ref, {
      workspaceId,
      appId: app.id,
      src,
      checksum: image.checksum,
      checksumKind: image.checksumKind,
      bytes: image.bytes,
      width: image.width,
      height: image.height,
      key,
      at: now,
    });
    set.files.push({
      ref,
      position: image.position,
      name: image.name,
      width: image.width,
      height: image.height,
      bytes: image.bytes,
      sizeFrom: image.width === null || image.height === null ? null : (image.sizeFrom ?? 'store'),
      checksum: image.checksum,
      checksumKind: image.checksumKind,
      state: image.state,
      downloadable: src !== null && imageUrlOf(src) !== null,
    });
  }
  void ctx;
  return {
    appId: app.id,
    platform,
    store,
    version: read.version,
    readAt: now,
    sets: [...sets.values()],
    unplaced: read.unplaced,
    notes: read.notes,
  };
}

const sourceOf = (image: StoreImageRecord): ImageSource | null =>
  image.url === null || image.urlKind === null
    ? null
    : { url: image.url, urlKind: image.urlKind, width: image.width, height: image.height };

/** The cached view, if there is a fresh one. Never reads a store. */
export function peekStoreImages(
  workspaceId: string,
  appId: string,
  now: number,
  channel: StoreChannel = 'editable',
): StoreImagesView | undefined {
  const hit = views.get(viewKey(workspaceId, appId, channel));
  return hit && now - hit.at < STORE_VIEW_TTL_SECONDS * 1000 ? hit.view : undefined;
}

/** The last store read of an app whatever its age (the cart's "before" count; never reads a store). */
export function lastStoreImages(workspaceId: string, appId: string): StoreImagesView | undefined {
  return views.get(viewKey(workspaceId, appId))?.view;
}

export type StoreSide = {
  observedAt: number;
  counts: { locale: string; kind: StoreImageSet['kind']; device: string | null; count: number }[];
};

/** The counts per locale, kind and device that the Assets tab shows next to the repository's. */
export const storeSideOf = (view: StoreImagesView): StoreSide => ({
  observedAt: view.readAt,
  counts: view.sets
    .filter((s) => !(s.device ?? '').startsWith('imessage:'))
    .map((s) => ({ locale: s.locale, kind: s.kind, device: s.device, count: s.files.length })),
});

/**
 * The store's images. A fresh cached view is returned as it is (`cached`); a read that misses the cache costs a store request
 * and counts against the limit of the workspace.
 */
export async function getStoreImages(
  ctx: StoreImagesContext,
  input: {
    workspaceId: string;
    app: ManagedApp;
    actor: Actor;
    fresh?: boolean;
    channel?: StoreChannel;
  },
): Promise<{ ok: true; view: StoreImagesView; cached: boolean } | Failure> {
  const now = ctx.draft.now();
  const channel = input.channel ?? 'editable';
  if (!input.fresh) {
    const hit = peekStoreImages(input.workspaceId, input.app.id, now, channel);
    if (hit) return { ok: true, view: hit, cached: true };
  }
  const wait = ctx.limiter.take(input.workspaceId);
  if (wait > 0)
    return {
      ...failure(
        429,
        'rate_limited',
        `Too many store reads. Try again in ${wait} seconds.`,
        coded('rate.storeReads', { count: wait }),
      ),
      headers: { 'Retry-After': String(wait) },
    };
  const done = await readStoreImagesOf(ctx.draft, {
    workspaceId: input.workspaceId,
    app: input.app,
    actor: input.actor,
    channel,
  });
  if (!done.ok) return done;
  await probeMissingSizes(ctx, input.workspaceId, input.app.id, done.read.images);
  const view = build(ctx, input.workspaceId, input.app, done.read, now);
  views.set(viewKey(input.workspaceId, input.app.id, channel), { at: now, view });
  while (views.size > 64) {
    const oldest = views.keys().next().value;
    if (oldest === undefined) break;
    views.delete(oldest);
  }
  return { ok: true, view, cached: false };
}

// ---------------------------------------------------------------------------------------------
// Bytes from the CDN

const downloadFailure = (f: DownloadFailure): Failure => {
  const status =
    f.code === 'blocked'
      ? 422
      : f.code === 'too_large' || f.code === 'not_an_image'
        ? 422
        : f.code === 'rate_limited'
          ? 429
          : 502;
  return {
    ...failure(status, `image_${f.code}`, f.message),
    ...(f.retryAfter ? { headers: { 'Retry-After': String(f.retryAfter) } } : {}),
  };
};

export { downloadFailure };

export const THUMB_SIZES = [160, 320, 640] as const;
export const thumbSizeOf = (raw: string | undefined): number => {
  const n = Number(raw);
  return THUMB_SIZES.find((s) => s === n) ?? 320;
};

/** The thumbnail of a store image, from the proxy cache or the CDN. */
export async function storeThumbnail(
  ctx: StoreImagesContext,
  input: { workspaceId: string; appId: string; ref: string; size: number },
): Promise<{ ok: true; bytes: Uint8Array; format: Downloaded['format'] } | Failure> {
  const entry = resolveRef(input.ref, input.workspaceId, input.appId, ctx.draft.now());
  if (!entry)
    return failure(
      404,
      'ref_expired',
      'This image reference is not known any more. Read the comparison again.',
      coded('listing.imageRefUnknown'),
    );
  if (entry.src === null)
    return failure(
      404,
      'no_image',
      'The store gave no image address for this file.',
      coded('listing.noImageAddress'),
    );
  const cacheKey = `${input.ref}|${input.size}`;
  const hit = thumbs.get(cacheKey);
  if (hit) {
    thumbs.delete(cacheKey);
    thumbs.set(cacheKey, hit);
    return { ok: true, ...hit };
  }
  const url = imageUrlOf(entry.src, { maxSide: input.size, format: 'jpg' });
  if (url === null)
    return failure(
      422,
      'image_blocked',
      'The store gave an image address this server does not download from. Nothing was fetched.',
      coded('listing.imageAddressRefused'),
    );
  const wait = ctx.fetchLimiter.take(input.workspaceId);
  if (wait > 0)
    return {
      ...failure(
        429,
        'rate_limited',
        `Too many image requests. Try again in ${wait} seconds.`,
        coded('rate.images', { count: wait }),
      ),
      headers: { 'Retry-After': String(wait) },
    };
  const got = await downloadStoreImage(ctx.net, url);
  if (!got.ok) return downloadFailure(got);
  thumbs.set(cacheKey, { bytes: got.bytes, format: got.format });
  thumbBytes += got.bytes.length;
  while (thumbs.size > THUMB_MAX_ENTRIES || thumbBytes > THUMB_MAX_BYTES) {
    const oldest = thumbs.keys().next().value;
    if (oldest === undefined) break;
    thumbBytes -= thumbs.get(oldest)?.bytes.length ?? 0;
    thumbs.delete(oldest);
  }
  return { ok: true, bytes: got.bytes, format: got.format };
}

/** The whole image of a ref, for a pull. Counted against the fetch limiter like a thumbnail. */
export async function storeImageBytes(
  ctx: StoreImagesContext,
  input: { workspaceId: string; appId: string; ref: string; maxBytes: number },
): Promise<{ ok: true; image: Downloaded; entry: RefEntry } | Failure> {
  const entry = resolveRef(input.ref, input.workspaceId, input.appId, ctx.draft.now());
  if (!entry)
    return failure(
      404,
      'ref_expired',
      'This image reference is not known any more. Read the comparison again.',
      coded('listing.imageRefUnknown'),
    );
  if (entry.src === null)
    return failure(
      404,
      'no_image',
      'The store gave no image address for this file.',
      coded('listing.noImageAddress'),
    );
  const url = imageUrlOf(entry.src, { format: 'png', original: true });
  if (url === null)
    return failure(
      422,
      'image_blocked',
      'The store gave an image address this server does not download from. Nothing was fetched.',
      coded('listing.imageAddressRefused'),
    );
  const wait = ctx.fetchLimiter.take(input.workspaceId);
  if (wait > 0)
    return {
      ...failure(
        429,
        'rate_limited',
        `Too many image requests. Try again in ${wait} seconds.`,
        coded('rate.images', { count: wait }),
      ),
      headers: { 'Retry-After': String(wait) },
    };
  const got = await downloadStoreImage(ctx.net, url, { maxBytes: input.maxBytes });
  if (!got.ok) return downloadFailure(got);
  return { ok: true, image: got, entry };
}
