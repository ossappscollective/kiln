/**
 * `t()`: the translation function every screen and lib module uses. It is plain TypeScript (no Svelte, no Vite) so it works in
 * `node --test`. Reactivity comes from the locale source: the reactive wrapper (`i18n.svelte.ts`) installs one that reads a `$state`, so
 * a `t()` call inside a template, `$derived` or `$effect` re-runs when the language changes. Without it the language is English.
 * Never call `t()` at module top level (it would be evaluated once, in whatever language was active): call it in a function, a
 * template or a `$derived`, or keep the key (`k('ns:key')`) and translate where it is drawn.
 */
import { type Catalog, type Params, type RichPart, SOURCE_LOCALE, translate, translateParts } from './core.ts';

const catalogs = new Map<string, Catalog>();
const slot = (locale: string, ns: string): string => `${locale}/${ns}`;

/** Registers the catalog of a namespace in a language (the loader does this; tests too). */
export function registerCatalog(locale: string, ns: string, catalog: Catalog): void {
  catalogs.set(slot(locale, ns), catalog);
}

/** Registers every namespace of a language. */
export function registerCatalogs(locale: string, byNamespace: Readonly<Record<string, Catalog>>): void {
  for (const ns of Object.keys(byNamespace)) registerCatalog(locale, ns, byNamespace[ns] as Catalog);
}

/** Whether any catalog of the language is registered. */
export function hasCatalogs(locale: string): boolean {
  const prefix = `${locale}/`;
  for (const name of catalogs.keys()) if (name.indexOf(prefix) === 0) return true;
  return false;
}

/** Forgets every catalog (tests). */
export function clearCatalogs(): void {
  catalogs.clear();
}

let localeSource: () => string = () => SOURCE_LOCALE;

/** Installs the function that says which language is active. Called once by `i18n.svelte.ts`. */
export function setLocaleSource(source: () => string): void {
  localeSource = source;
}

/** The active language. Reading it inside a template or `$derived` makes that code follow language changes. */
export const currentLocale = (): string => localeSource();

let missingReporter: ((key: string, locale: string) => void) | null = null;
const reported = new Set<string>();

/** Installs what happens when a key exists nowhere (development builds log once per key). */
export function setMissingReporter(report: ((key: string, locale: string) => void) | null): void {
  missingReporter = report;
}

const onMissing = (key: string, locale: string): void => {
  if (!missingReporter || reported.has(key)) return;
  reported.add(key);
  missingReporter(key, locale);
};

const lookup = (locale: string, ns: string): Catalog | undefined => catalogs.get(slot(locale, ns));

/**
 * The message for `ns:key` in the active language. `t('shell:nav.allApps')`, `t('app:greeting', { name })` for
 * `Hello {{name}}`, `t('shell:badge.unanswered', { count })` for the plural keys `badge.unanswered_one` and `badge.unanswered_other`.
 * A key missing from the active language is read from English; a key missing everywhere comes back as written.
 */
export function t(key: string, params?: Params): string {
  return translate(key, params, { locale: localeSource(), lookup, onMissing });
}

/** The message split at its `<link>…</link>`-style tags, for the `<T>` component. */
export function tParts(key: string, params?: Params): RichPart[] {
  return translateParts(key, params, { locale: localeSource(), lookup, onMissing });
}

/**
 * Marks a message key without translating it, so the key is a literal the tooling can see (`pnpm i18n:check` verifies it exists):
 * `const labels = { open: k('app:status.open') }` now, `t(labels[status])` where it is drawn. Returns the key unchanged.
 */
export function k<T extends string>(key: T): T {
  return key;
}
