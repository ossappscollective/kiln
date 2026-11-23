import { createHash } from 'node:crypto';
import { ASSET_SYNC_LIMITS, readImageHeader, sniffImageFormat } from '@kiln/core';
import { type Exchange, safeGet } from '../../services/safe-fetch.ts';
import type { Resolver } from '../../services/webhook-transport.ts';

/**
 * Downloads an image a store serves from its CDN (docs/adr/0012-assets-two-way-sync.md). The address always comes from a
 * store's own API answer (App Store Connect `imageAsset.templateUrl`, Google Play `Image.url`), never from a client, and it
 * is still treated as untrusted:
 *
 * - https only, and the host must be in the allowlist below, for the first URL and for EVERY redirect (safe-fetch.ts), so a
 *   redirect to anywhere else is refused, never followed;
 * - the resolved addresses are checked (no loopback, private or link local addresses), the connection goes to the checked
 *   address, never a second look-up (safe-fetch.ts);
 * - at most `maxBytes` of body, a timeout covering redirects, no cookie and no credential sent (the CDN URLs are not
 *   authenticated and the store's token is never given to this module);
 * - the type comes from the bytes (core/image-header.ts: PNG, JPEG, WebP or GIF), never from the header of the answer.
 *
 * Hosts. Apple: `mzstatic.com` and subdomains (the host of Apple's own example, `is1.mzstatic.com`, VERIFIED on Apple's
 * page). Google: `googleusercontent.com` and `ggpht.com` and subdomains (the usual hosts of Play images, UNVERIFIED: Google's
 * page says only "A URL that will serve a preview of the image"). A different host in a store answer is refused with a
 * message that names the host, and the person can see that nothing was fetched.
 */

export type StoreImageNet = {
  resolve?: Resolver;
  exchange?: Exchange;
  allowPrivate?: boolean;
  timeoutMs?: number;
};

const HOST_SUFFIXES = ['mzstatic.com', 'googleusercontent.com', 'ggpht.com'] as const;

export const isStoreImageHost = (host: string): boolean => {
  const h = host.toLowerCase().replace(/\.$/, '');
  return HOST_SUFFIXES.some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
};

export type ImageSource = {
  url: string;
  urlKind: 'apple_template' | 'play_url';
  width: number | null;
  height: number | null;
};

/**
 * The address of an image. Apple's template has `{w}`, `{h}` and `{f}` ("substitute width, height, and format into
 * `templateUrl`", VERIFIED); `maxSide` makes a thumbnail of that long side. A Google Play url is used as it is.
 * Null when the URL is not an https URL of an allowed host or an Apple template cannot be filled.
 *
 * A Google image address serves a DOWNSCALED rendition unless it carries a size option, so a Play address is always given one:
 * `=s0` (the original size) for `original`, `=s<maxSide>` for a thumbnail. The pixel size of a file fetched without it must
 * never be used for a check (UNVERIFIED: Google documents the option only for its image hosts in general, not for Play's `url`).
 * Apple: the template is filled with the asset's own width and height, so the original is what is asked for.
 */
export function imageUrlOf(
  src: ImageSource,
  opts: { maxSide?: number; format?: 'png' | 'jpg'; original?: boolean } = {},
): string | null {
  let raw = src.url;
  if (src.urlKind === 'apple_template') {
    if (src.width === null || src.height === null || src.width < 1 || src.height < 1) return null;
    let w = src.width;
    let h = src.height;
    if (opts.maxSide !== undefined && Math.max(w, h) > opts.maxSide) {
      const k = opts.maxSide / Math.max(w, h);
      w = Math.max(1, Math.round(w * k));
      h = Math.max(1, Math.round(h * k));
    }
    raw = raw
      .replace('{w}', String(w))
      .replace('{h}', String(h))
      .replace('{f}', opts.format ?? 'png');
    if (/[{}]/.test(raw)) return null;
  }
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
    !isStoreImageHost(url.hostname)
  )
    return null;
  if (src.urlKind === 'play_url') {
    const option = opts.original ? 's0' : opts.maxSide !== undefined ? `s${opts.maxSide}` : 's0';
    url.pathname = `${url.pathname.replace(/=[A-Za-z0-9_-]+$/, '')}=${option}`;
  }
  return url.toString();
}

export type Downloaded = {
  ok: true;
  bytes: Uint8Array;
  format: 'png' | 'jpeg' | 'webp' | 'gif';
  width: number;
  height: number;
  hasAlpha: boolean | null;
  sha256: string;
};
export type DownloadFailure = {
  ok: false;
  code: 'blocked' | 'unavailable' | 'too_large' | 'not_an_image' | 'rate_limited';
  message: string;
  retryAfter?: number;
};

/** Fetches one image. Never throws; the message never holds an address. */
export async function downloadStoreImage(
  net: StoreImageNet | undefined,
  address: string,
  opts: { maxBytes?: number } = {},
): Promise<Downloaded | DownloadFailure> {
  let host = '';
  try {
    host = new URL(address).hostname;
  } catch {
    return { ok: false, code: 'blocked', message: 'The store gave an address that is not a URL.' };
  }
  if (!address.startsWith('https://') || !isStoreImageHost(host)) {
    return {
      ok: false,
      code: 'blocked',
      message: `The store gave an image address on a host this server does not download from (${host.slice(0, 80)}). Nothing was fetched.`,
    };
  }
  const maxBytes = opts.maxBytes ?? ASSET_SYNC_LIMITS.maxDownloadBytes;
  const got = await safeGet(address, {
    allowHost: isStoreImageHost,
    maxBytes,
    maxRedirects: 3,
    accept: 'image/png,image/jpeg,image/webp,image/*;q=0.8',
    timeoutMs: net?.timeoutMs ?? 15_000,
    ...(net?.allowPrivate ? { allowPrivate: true } : {}),
    ...(net?.resolve ? { resolve: net.resolve } : {}),
    ...(net?.exchange ? { exchange: net.exchange } : {}),
  });
  if (!got.ok) {
    if (got.kind === 'too_large')
      return {
        ok: false,
        code: 'too_large',
        message: `The image is larger than ${Math.round(maxBytes / (1024 * 1024))} MB, so it was not taken.`,
      };
    if (got.kind === 'blocked' || got.kind === 'redirect')
      return {
        ok: false,
        code: 'blocked',
        message:
          'The image address was refused: it is not an https address of the store’s image hosts, or it redirects somewhere else.',
      };
    if (got.status === 429) {
      const wait = Number(got.retryAfter);
      return {
        ok: false,
        code: 'rate_limited',
        message: 'The image host is limiting requests.',
        ...(Number.isFinite(wait) && wait > 0 ? { retryAfter: Math.min(wait, 300) } : {}),
      };
    }
    return {
      ok: false,
      code: 'unavailable',
      message:
        got.kind === 'timeout'
          ? 'The image host did not answer in time.'
          : 'The image could not be fetched.',
    };
  }
  const header = readImageHeader(got.body);
  const format = sniffImageFormat(got.body);
  if (!header.ok || format === null)
    return {
      ok: false,
      code: 'not_an_image',
      message: 'What the store served is not a PNG, JPEG, WebP or GIF image.',
    };
  return {
    ok: true,
    bytes: got.body,
    format,
    width: header.width,
    height: header.height,
    hasAlpha: header.hasAlpha,
    sha256: createHash('sha256').update(got.body).digest('hex'),
  };
}

/** What a header probe learns of one store image. `bytes` is the full length when the host states it. */
export type ImageProbe = {
  width: number;
  height: number;
  format: 'png' | 'jpeg' | 'webp' | 'gif';
  bytes: number | null;
};

/** The first bytes a probe asks for: enough for a PNG, a WebP, a GIF and a JPEG with a normal EXIF block. */
export const PROBE_BYTES = 192 * 1024;

/**
 * Reads only the first bytes of a store image (a ranged GET; a host that ignores the range is cut after `PROBE_BYTES`) to
 * learn its pixel size, format and length, under the same host and address rules as a download. Null on any failure:
 * the caller then leaves the image unchecked, it never guesses.
 */
export async function probeStoreImage(
  net: StoreImageNet | undefined,
  address: string,
): Promise<ImageProbe | null> {
  let host = '';
  try {
    host = new URL(address).hostname;
  } catch {
    return null;
  }
  if (!address.startsWith('https://') || !isStoreImageHost(host)) return null;
  const got = await safeGet(address, {
    allowHost: isStoreImageHost,
    maxBytes: PROBE_BYTES,
    head: true,
    maxRedirects: 3,
    accept: 'image/png,image/jpeg,image/webp,image/*;q=0.8',
    timeoutMs: net?.timeoutMs ?? 8_000,
    ...(net?.allowPrivate ? { allowPrivate: true } : {}),
    ...(net?.resolve ? { resolve: net.resolve } : {}),
    ...(net?.exchange ? { exchange: net.exchange } : {}),
  });
  if (!got.ok) return null;
  const header = readImageHeader(got.body);
  if (!header.ok) return null;
  const range = /\/(\d+)\s*$/.exec(got.headers?.['content-range'] ?? '');
  const declared = Number(got.headers?.['content-length']);
  const total = range
    ? Number(range[1])
    : got.status === 200 && Number.isFinite(declared) && declared > 0
      ? declared
      : got.body.length < PROBE_BYTES
        ? got.body.length
        : null;
  return {
    width: header.width,
    height: header.height,
    format: header.format,
    bytes: total !== null && Number.isFinite(total) ? total : null,
  };
}
