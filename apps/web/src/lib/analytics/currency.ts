/**
 * Which currency a money chart opens on: the one the person chose last (kept in this browser), else the currency of their locale, else
 * the biggest. Money is never converted or added across currencies; this only decides which one is shown first.
 */

import { readMigrated } from '../legacy-storage.ts';

const CHOICE_KEY = 'kiln.analytics.currency';

/** The currency of a region, for the places people use this app from. Regions that are not listed fall back to the biggest currency. */
const REGION_CURRENCY: Record<string, string> = {
  US: 'USD', CA: 'CAD', MX: 'MXN', BR: 'BRL', AR: 'ARS', CL: 'CLP', CO: 'COP', PE: 'PEN', UY: 'UYU',
  GB: 'GBP', IE: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', PT: 'EUR', NL: 'EUR', BE: 'EUR', LU: 'EUR',
  AT: 'EUR', FI: 'EUR', GR: 'EUR', SK: 'EUR', SI: 'EUR', EE: 'EUR', LV: 'EUR', LT: 'EUR', MT: 'EUR', CY: 'EUR',
  HR: 'EUR', BG: 'EUR', CH: 'CHF', LI: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', IS: 'ISK', PL: 'PLN', CZ: 'CZK',
  HU: 'HUF', RO: 'RON', UA: 'UAH', TR: 'TRY', IL: 'ILS', AE: 'AED', SA: 'SAR', QA: 'QAR', EG: 'EGP', ZA: 'ZAR',
  NG: 'NGN', KE: 'KES', IN: 'INR', PK: 'PKR', BD: 'BDT', LK: 'LKR', CN: 'CNY', HK: 'HKD', TW: 'TWD', JP: 'JPY',
  KR: 'KRW', SG: 'SGD', MY: 'MYR', TH: 'THB', VN: 'VND', ID: 'IDR', PH: 'PHP', AU: 'AUD', NZ: 'NZD', KZ: 'KZT',
};

/** The currency of a locale tag such as `de-CH` or `en`; null when the tag has no region we know. */
export function localeCurrency(locale: string | null | undefined): string | null {
  if (!locale) return null;
  try {
    const region = new Intl.Locale(locale).maximize().region;
    return (region && REGION_CURRENCY[region]) || null;
  } catch {
    return null;
  }
}

/** The locale of this browser, or null (server side, tests). */
export const browserLocale = (): string | null =>
  typeof navigator === 'undefined' ? null : (navigator.language ?? null);

/** What the person chose last, or null. Storage can be missing or refuse; that is never an error. */
export function chosenCurrency(): string | null {
  try {
    const storage = globalThis.localStorage;
    const value = storage ? readMigrated(storage, CHOICE_KEY) : null;
    return value !== null && /^[A-Z]{3}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function rememberCurrency(currency: string): void {
  try {
    globalThis.localStorage?.setItem(CHOICE_KEY, currency);
  } catch {
    // Nothing to keep it in: the choice then lasts until the page is closed.
  }
}

/**
 * The currency to open on, from the ones a card has (biggest first): the one the person chose before, else the one of their locale,
 * else the first. `chosen` and `locale` are passed in so this stays a pure function.
 */
export function defaultCurrency(
  currencies: readonly string[],
  chosen: string | null,
  locale: string | null,
): string {
  if (chosen && currencies.includes(chosen)) return chosen;
  const mine = localeCurrency(locale);
  if (mine && currencies.includes(mine)) return mine;
  return currencies[0] ?? '';
}

/** The currencies in the order they are offered: the default first, the rest as they came (biggest first). */
export const offeredCurrencies = (currencies: readonly string[], first: string): string[] =>
  currencies.includes(first) ? [first, ...currencies.filter((c) => c !== first)] : [...currencies];
