import { createHash } from 'node:crypto';
import { imageKey, type ListingChange } from '@kiln/core';
import type { Sql } from '@kiln/db';
import { coded } from '../../i18n/problem.ts';
import { registerCache } from '../../services/cache-registry.ts';
import type { TestLimiter } from '../../services/credential-tests.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import {
  type DownloadFailure,
  downloadStoreImage,
  type StoreImageNet,
} from '../listing/store-image-net.ts';
import { parseChanges, parseListingState } from './competitor-watch.ts';

/**
 * The thumbnails of a followed competitor's screenshots and icon, and of the icons in the add-competitor search
 * (docs/adr/0056-competitor-listing-watch.md). The app's CSP is `img-src 'self' data:` (ADR 0049), so the browser cannot load
 * `mzstatic.com` itself; this proxy does, and only for addresses THIS SERVER STORED. A client never sends an address: it sends a ref
 * (`icon`, `s.p.3`, `c.<changeId>.a.i.0`) that is looked up in the stored listing state or change row of a competitor of the app, or an
 * opaque ref the search handed out (kept in memory for a quarter of an hour). Then every layer of the other image proxy applies:
 * https only, host `mzstatic.com` or a subdomain (Apple's CDN, nothing else, also for redirects), the resolved addresses must be
 * public, at most 2 MiB, the type comes from the bytes (PNG, JPEG, WebP or GIF, never SVG), a per workspace fetch limit, and a small
 * in-memory cache. Nothing is logged.
 */

export const COMPETITOR_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const COMPETITOR_IMAGE_SIZES = [96, 160, 320, 640] as const;
export const competitorImageSizeOf = (raw: string | undefined): number => {
  const n = Number(raw);
  return COMPETITOR_IMAGE_SIZES.find((s) => s === n) ?? 160;
};

export const isAppleImageHost = (host: string): boolean => {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'mzstatic.com' || h.endsWith('.mzstatic.com');
};

/** The grammar of a stored ref: nothing else reaches the lookup. */
export const COMPETITOR_IMAGE_REF =
  /^(icon|s\.[pi]\.\d{1,2}|c\.[A-Za-z0-9-]{8,64}\.[ba]\.(icon|[pi])\.\d{1,2})$/;
/** The grammar of a search ref (a 32 character hex digest). */
export const SEARCH_IMAGE_REF = /^[0-9a-f]{32}$/;

const RENDITION = /\/\d+x\d+[a-z]{0,3}(?:-\d+)?\.(?:jpe?g|png|webp)$/i;

/** The address of a thumbnail: https on Apple's image host, no credentials or port; a rendition segment is rewritten to the size, any other path is used as it is. Null otherwise. */
export function renditionUrl(raw: string, size: number): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    !isAppleImageHost(url.hostname)
  )
    return null;
  url.search = '';
  url.hash = '';
  if (RENDITION.test(url.pathname))
    url.pathname = url.pathname.replace(RENDITION, `/${size}x${size}bb.jpg`);
  return url.toString();
}

// ---- refs of the add-competitor search (memory) -----------------------------------------------------------

const SEARCH_REF_TTL_MS = 15 * 60_000;
const SEARCH_REF_MAX = 500;
const searchRefs = new Map<
  string,
  { workspaceId: string; appId: string; url: string; at: number }
>();
registerCache({
  name: 'aso.competitor_search_refs',
  owner: 'modules/aso/competitor-images.ts',
  ttlMs: SEARCH_REF_TTL_MS,
  invalidatedBy: [],
  why: 'Opaque refs of the add-competitor search (public store pages of OTHER apps): nothing an app event changes. Expires by TTL and is bounded.',
  drop: () => searchRefs.clear(),
});

export function clearCompetitorImageCaches(): void {
  searchRefs.clear();
  thumbs.clear();
  thumbBytes = 0;
}

/** An opaque ref for an icon address of a search result, or null when the address is not Apple's CDN. */
export function registerSearchImage(
  workspaceId: string,
  appId: string,
  url: string | null,
  now: number,
): string | null {
  if (url === null || renditionUrl(url, 96) === null) return null;
  const ref = createHash('sha256')
    .update(`${workspaceId}\0${appId}\0${url}`)
    .digest('hex')
    .slice(0, 32);
  searchRefs.delete(ref);
  searchRefs.set(ref, { workspaceId, appId, url, at: now });
  while (searchRefs.size > SEARCH_REF_MAX) {
    const oldest = searchRefs.keys().next().value;
    if (oldest === undefined) break;
    searchRefs.delete(oldest);
  }
  return ref;
}

export function resolveSearchImage(
  ref: string,
  workspaceId: string,
  appId: string,
  now: number,
): string | undefined {
  const e = searchRefs.get(ref);
  return e && e.workspaceId === workspaceId && e.appId === appId && now - e.at <= SEARCH_REF_TTL_MS
    ? e.url
    : undefined;
}

// ---- refs of a stored competitor ---------------------------------------------------------------------------

/** The stored address a ref names, for a competitor of this workspace (the caller has checked the competitor belongs to the app). */
export async function resolveStoredImage(
  sql: Sql,
  workspaceId: string,
  competitorId: string,
  ref: string,
): Promise<string | undefined> {
  if (!COMPETITOR_IMAGE_REF.test(ref)) return undefined;
  const parts = ref.split('.');
  if (parts[0] === 'icon' || parts[0] === 's') {
    const [row] = await sql.query(
      'SELECT listing_state FROM aso_competitors WHERE id = ? AND workspace_id = ?',
      [competitorId, workspaceId],
    );
    const state = parseListingState(row?.listing_state);
    if (!state) return undefined;
    if (parts[0] === 'icon') return state.icon ?? undefined;
    return (parts[1] === 'p' ? state.iphone : state.ipad)[Number(parts[2])];
  }
  const [, changeId, side, what, index] = parts;
  const [row] = await sql.query(
    'SELECT changes FROM aso_competitor_changes WHERE id = ? AND competitor_id = ? AND workspace_id = ?',
    [changeId ?? '', competitorId, workspaceId],
  );
  if (!row) return undefined;
  const changes: ListingChange[] = parseChanges(row.changes);
  if (what === 'icon') {
    const c = changes.find((x) => x.kind === 'icon');
    return c && c.kind === 'icon' ? ((side === 'b' ? c.before : c.after) ?? undefined) : undefined;
  }
  const c = changes.find(
    (x) => x.kind === 'screenshots' && x.device === (what === 'p' ? 'iphone' : 'ipad'),
  );
  return c && c.kind === 'screenshots'
    ? (side === 'b' ? c.before : c.after)[Number(index)]
    : undefined;
}

// ---- the fetch ---------------------------------------------------------------------------------------------

type Thumb = { bytes: Uint8Array; format: 'png' | 'jpeg' | 'webp' | 'gif' };
const thumbs = new Map<string, Thumb>();
let thumbBytes = 0;
registerCache({
  name: 'aso.competitor_thumbs',
  owner: 'modules/aso/competitor-images.ts',
  ttlMs: null,
  invalidatedBy: [],
  why: 'Keyed by a competitor image ref (content of a public store image). Bounded by entries and bytes.',
  drop() {
    thumbs.clear();
    thumbBytes = 0;
  },
});
const THUMB_MAX_BYTES = 16 * 1024 * 1024;
const THUMB_MAX_ENTRIES = 300;

export type CompetitorImageContext = { net?: StoreImageNet; limiter: TestLimiter };

const failed = (f: DownloadFailure): Failure => ({
  ...failure(
    f.code === 'blocked' || f.code === 'too_large' || f.code === 'not_an_image'
      ? 422
      : f.code === 'rate_limited'
        ? 429
        : 502,
    `image_${f.code}`,
    f.message,
  ),
  ...(f.retryAfter ? { headers: { 'Retry-After': String(f.retryAfter) } } : {}),
});

/** The thumbnail of a stored address, from the cache or Apple's CDN. */
export async function competitorThumbnail(
  ctx: CompetitorImageContext,
  input: { workspaceId: string; url: string; size: number },
): Promise<({ ok: true } & Thumb) | Failure> {
  const address = renditionUrl(input.url, input.size);
  if (address === null)
    return failure(
      422,
      'image_blocked',
      'The stored image address is not one this server downloads from. Nothing was fetched.',
      coded('listing.imageAddressRefused'),
    );
  const key = `${imageKey(input.url)}|${input.size}`;
  const hit = thumbs.get(key);
  if (hit) {
    thumbs.delete(key);
    thumbs.set(key, hit);
    return { ok: true, ...hit };
  }
  const wait = ctx.limiter.take(input.workspaceId);
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
  const got = await downloadStoreImage(ctx.net, address, { maxBytes: COMPETITOR_IMAGE_MAX_BYTES });
  if (!got.ok) return failed(got);
  thumbs.set(key, { bytes: got.bytes, format: got.format });
  thumbBytes += got.bytes.length;
  while (thumbs.size > THUMB_MAX_ENTRIES || thumbBytes > THUMB_MAX_BYTES) {
    const oldest = thumbs.keys().next().value;
    if (oldest === undefined) break;
    thumbBytes -= thumbs.get(oldest)?.bytes.length ?? 0;
    thumbs.delete(oldest);
  }
  return { ok: true, bytes: got.bytes, format: got.format };
}
