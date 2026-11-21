/**
 * Preloaded by `pnpm test` (`node --import ./src/lib/i18n/test-setup.ts --test ...`): registers the English catalogs from
 * `apps/web/locales` so lib modules that call `t()` return real text in tests. Other languages on request: `useLocale('fr')`.
 * Run a single file the same way: `node --import ./src/lib/i18n/test-setup.ts --test src/lib/foo.test.ts`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SOURCE_LOCALE, type Catalog } from './core.ts';
import { registerCatalog, setLocaleSource } from './t.ts';

const LOCALES = fileURLToPath(new URL('../../../locales/', import.meta.url));

/** Reads one language's files from disk and registers them. */
export function loadLocaleFromDisk(code: string): void {
  for (const ns of readdirSync(LOCALES)) {
    try {
      registerCatalog(code, ns, JSON.parse(readFileSync(`${LOCALES}${ns}/${code}.json`, 'utf8')) as Catalog);
    } catch {
      // This namespace has no file in that language.
    }
  }
}

/** Loads a language and makes it the active one for the rest of the test file (`useLocale('en')` restores English). */
export function useLocale(code: string): void {
  loadLocaleFromDisk(code);
  setLocaleSource(() => code);
}

loadLocaleFromDisk(SOURCE_LOCALE);
