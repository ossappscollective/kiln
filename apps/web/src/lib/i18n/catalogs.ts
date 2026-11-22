/**
 * The only Vite-specific file of the runtime: it finds the catalogs with `import.meta.glob`.
 *   English (the source language and the fallback of every other one) is bundled and registered when this module loads, so `t()` can
 *   always answer and nothing flashes keys.
 *   Every other language is a set of small chunks, fetched on demand by `loadLocale` before the language becomes active.
 * Not importable from `node --test` (no `import.meta.glob`); tests use `test-setup.ts`.
 */
import { type Catalog, PSEUDO_LOCALE, SOURCE_LOCALE } from './core.ts';
import { registerCatalog } from './t.ts';

const FILE = /locales\/([^/]+)\/([^/.]+)\.json$/;

const bundled = import.meta.glob<Catalog>('../../../locales/*/en.json', {
  eager: true,
  import: 'default',
});
const onDemand = import.meta.glob<Catalog>(
  ['../../../locales/*/*.json', '!../../../locales/*/en.json'],
  { import: 'default' },
);

for (const path of Object.keys(bundled)) {
  const match = FILE.exec(path);
  if (match) registerCatalog(SOURCE_LOCALE, match[1] as string, bundled[path] as Catalog);
}

const loaded = new Set<string>();

/** Fetches and registers every namespace of a language. English and the pseudo-locale need nothing. Rejects if a chunk cannot be fetched. */
export async function loadLocale(code: string): Promise<void> {
  if (code === SOURCE_LOCALE || code === PSEUDO_LOCALE || loaded.has(code)) return;
  const jobs: Promise<void>[] = [];
  for (const path of Object.keys(onDemand)) {
    const match = FILE.exec(path);
    if (!match || match[2] !== code) continue;
    const ns = match[1] as string;
    const load = onDemand[path] as () => Promise<Catalog>;
    jobs.push(load().then((catalog) => registerCatalog(code, ns, catalog)));
  }
  await Promise.all(jobs);
  loaded.add(code);
}
