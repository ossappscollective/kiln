/**
 * Loads the server's catalogs (`apps/server/locales/<namespace>/<language>.json`) and builds translators. English is the source and the
 * fallback of every other language. Files are read once, on first use, with plain `fs` (the server has no bundler); a missing file is
 * an empty catalog, so a language that is not translated yet answers in English.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type Catalog,
  escapeHtml,
  type Lookup,
  type Params,
  resolveMessage,
  richToHtml,
  richToText,
  SOURCE_LOCALE,
} from './runtime.ts';

export const LOCALES_DIR = fileURLToPath(new URL('../../locales/', import.meta.url));

const cache = new Map<string, Catalog>();

const slot = (locale: string, ns: string) => `${locale}/${ns}`;

/** Registers a catalog by hand (tests). */
export function registerCatalog(locale: string, ns: string, catalog: Catalog): void {
  cache.set(slot(locale, ns), catalog);
}

/** Forgets everything that was read or registered (tests). */
export function clearCatalogs(): void {
  cache.clear();
}

/** The catalog of a namespace in a language, read from disk on first use. */
export const diskLookup: Lookup = (locale, ns) => {
  const id = slot(locale, ns);
  let hit = cache.get(id);
  if (hit === undefined) {
    // The names come from our own code, never from a request; the check keeps them to [a-z0-9-] anyway.
    if (!/^[a-z][a-z0-9-]*$/.test(ns) || !/^[a-z]{2,3}$/.test(locale)) return undefined;
    try {
      hit = JSON.parse(readFileSync(`${LOCALES_DIR}${ns}/${locale}.json`, 'utf8')) as Catalog;
    } catch {
      hit = {};
    }
    cache.set(id, hit);
  }
  return hit;
};

export type Translate = {
  /** The message as plain text (tags removed). A key found nowhere comes back as written. */
  (key: string, params?: Params): string;
  /** The message as HTML: text and values escaped, `<strong>`, `<em>` and `<code>` as elements. */
  html(key: string, params?: Params, links?: Readonly<Record<string, (innerHtml: string) => string>>): string;
  /** The language this translator answers in (the one asked for; a key missing there is read from English). */
  readonly locale: string;
};

/** A translator for a language. Pass `lookup` only in tests. */
export function translator(locale: string = SOURCE_LOCALE, lookup: Lookup = diskLookup): Translate {
  const t = ((key: string, params?: Params): string => {
    const found = resolveMessage(key, params, locale, lookup);
    return found ? richToText(found.raw, params, locale) : key;
  }) as Translate & { locale: string };
  t.html = (key, params, links) => {
    const found = resolveMessage(key, params, locale, lookup);
    return found ? richToHtml(found.raw, params, locale, links) : escapeHtml(key);
  };
  Object.defineProperty(t, 'locale', { value: locale, enumerable: true });
  return t;
}
