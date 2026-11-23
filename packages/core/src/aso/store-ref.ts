/**
 * Reading a store reference out of what a person typed or pasted: a numeric App Store id, `id123`, an
 * apps.apple.com link, an Android package name or a play.google.com details link. Pure (no network); the web uses it to
 * decide "this is a link or an id, resolve it directly" against "this is a name, search for it", and the server may reuse it.
 * Browser safe: no newer library calls than ES2017.
 */

export type StoreRef =
  | { store: 'app_store'; id: string; country?: string }
  | { store: 'google_play'; id: string };

const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** An Android application id such as `com.example.app` (at least two parts, each starting with a letter). */
export const isPackageName = (value: string): boolean =>
  value.length <= 255 && PACKAGE_NAME.test(value);

const APPLE_HOSTS = ['apps.apple.com', 'itunes.apple.com'];

function parseUrl(text: string): URL | undefined {
  if (/\s/.test(text) || text.length > 1000) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The store reference in `raw`, normalised, or undefined when it is not one (then it is a name to search for).
 * `bare` says what a text without a link is read as: a pure number or `id123` is always an App Store id; a dotted
 * name such as `com.example.app` is a package name only when `bare` is `google_play` (on an App Store app it is a search).
 */
export function parseStoreRef(
  raw: string,
  bare: 'app_store' | 'google_play' = 'app_store',
): StoreRef | undefined {
  const text = raw.trim();
  if (text === '') return undefined;
  const digits = /^(?:id)?([0-9]{1,15})$/i.exec(text);
  if (digits) return { store: 'app_store', id: digits[1] as string };
  if (bare === 'google_play' && isPackageName(text)) return { store: 'google_play', id: text };
  if (!text.includes('.') || !text.includes('/')) return undefined;
  const url = parseUrl(text);
  if (!url) return undefined;
  const host = url.hostname.toLowerCase();
  if (APPLE_HOSTS.indexOf(host) !== -1) {
    const id = /\/id([0-9]{1,15})(?:[/?#]|$)/.exec(url.pathname)?.[1];
    if (!id) return undefined;
    const first = url.pathname.split('/')[1] ?? '';
    return /^[a-z]{2}$/i.test(first)
      ? { store: 'app_store', id, country: first.toLowerCase() }
      : { store: 'app_store', id };
  }
  if (host === 'play.google.com') {
    const pkg = url.searchParams.get('id') ?? '';
    return isPackageName(pkg) ? { store: 'google_play', id: pkg } : undefined;
  }
  return undefined;
}
