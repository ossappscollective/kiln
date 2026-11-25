/**
 * One import for components: `import { t, i18n, setLocale, formatDate } from '../lib/i18n/index.ts'`.
 * Lib modules that have `node --test` tests import from `t.ts` and `format.ts` directly (this file pulls in Svelte runes).
 */

export type { Params } from './core.ts';
export * from './format.ts';
export { i18n, initI18n, pickerLocales, setLocale } from './i18n.svelte.ts';
export { availableLocales, localeInfo } from './locales.ts';
export { currentLocale, k, t, tParts } from './t.ts';
