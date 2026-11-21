/**
 * Numbers, money, dates, lists and sizes in the active language, through `Intl`. Every helper takes an optional `locale` and otherwise
 * uses the active language (with the region of the browser's matching language, see `formatLocaleFor`), so a call inside a template
 * follows a language change. Plain TypeScript, safe in `node --test`. A value that cannot be formatted (NaN, an invalid date) gives ''.
 */
import { currentLocale } from './t.ts';
import { formatLocaleFor } from './locales.ts';

type WithLocale = { locale?: string | undefined };

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages && navigator.languages.length > 0 ? navigator.languages : navigator.language ? [navigator.language] : [];
}

/** The tag `Intl` is given when the caller passes none. Reads the active language (so it is reactive in templates). */
export const formatLocale = (): string => formatLocaleFor(currentLocale(), browserLanguages());

const cache = new Map<string, unknown>();

function memo<T>(kind: string, locale: string, options: object, make: () => T): T {
  const id = `${kind}|${locale}|${JSON.stringify(options)}`;
  let hit = cache.get(id) as T | undefined;
  if (hit === undefined) {
    hit = make();
    cache.set(id, hit);
  }
  return hit;
}

function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  return memo('n', locale, options, () => new Intl.NumberFormat(locale, options));
}

function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return memo('d', locale, options, () => new Intl.DateTimeFormat(locale, options));
}

// ---------------------------------------------------------------------------------------------
// Numbers

/** 12345.6 is "12,345.6" in English, "12 345,6" in French. */
export function formatNumber(value: number, options: Intl.NumberFormatOptions & WithLocale = {}): string {
  if (!Number.isFinite(value)) return '';
  const { locale, ...rest } = options;
  return numberFormat(locale ?? formatLocale(), rest).format(value);
}

/** A fraction as a percentage: 0.256 is "26%" (pass `maximumFractionDigits` for more). */
export function formatPercent(fraction: number, options: Intl.NumberFormatOptions & WithLocale = {}): string {
  return formatNumber(fraction, { ...options, style: 'percent' });
}

/** 12900 is "12.9K" in English and "12,9 k" in French. */
export function formatCompact(value: number, options: Intl.NumberFormatOptions & WithLocale = {}): string {
  return formatNumber(value, { maximumFractionDigits: 1, ...options, notation: 'compact' });
}

// ---------------------------------------------------------------------------------------------
// Money. The app keeps money two ways: analytics figures are numbers in major units (12.5 dollars), store prices are strings of
// minor units ("499" is 4.99 USD, see `Price` in lib/types.ts). Each has its own helper; money is never converted between currencies.

type CurrencyOptions = WithLocale & {
  /** Fixed number of decimals (both minimum and maximum). Default: what the currency uses (2 for USD, 0 for JPY). */
  digits?: number | undefined;
};

/** Major units to text: `formatCurrency(1234.5, 'USD')` is "$1,234.50". A missing or unknown currency is written as its code before the number. */
export function formatCurrency(amount: number | string, currency: string | null, options: CurrencyOptions = {}): string {
  // A string is an exact decimal such as "4.99" (what `formatMinorUnits` passes for amounts too long for a double).
  if (typeof amount === 'number' ? !Number.isFinite(amount) : !/^-?\d+(\.\d+)?$/.test(amount)) return '';
  const locale = options.locale ?? formatLocale();
  const fixed = options.digits === undefined ? {} : { minimumFractionDigits: options.digits, maximumFractionDigits: options.digits };
  if (currency && /^[A-Za-z]{3}$/.test(currency)) {
    try {
      return numberFormat(locale, { style: 'currency', currency: currency.toUpperCase(), ...fixed }).format(amount as number);
    } catch {
      // fall through to the plain form
    }
  }
  const plain = formatNumber(Number(amount), { locale, minimumFractionDigits: options.digits ?? 2, maximumFractionDigits: options.digits ?? 2 });
  return currency ? `${currency} ${plain}` : plain;
}

/** How many decimals a currency has (2 for USD, 0 for JPY, 3 for KWD). */
export function currencyDigits(currency: string): number {
  try {
    return numberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * Minor units to text: `formatMinorUnits('499', 'USD')` is "$4.99". The digits are moved by text, never by floating-point arithmetic, so
 * no amount that fits in 15 digits changes. Anything that is not a whole number of digits gives ''.
 */
export function formatMinorUnits(minor: string | number, currency: string, options: CurrencyOptions = {}): string {
  const match = /^(-?)(\d+)$/.exec(String(minor).trim());
  if (!match) return '';
  const digits = options.digits ?? currencyDigits(currency);
  const whole = (match[2] as string).replace(/^0+(?=\d)/, '');
  const sign = match[1] === '-' && whole !== '0' ? '-' : '';
  const padded = whole.padStart(digits + 1, '0');
  const decimal = digits === 0 ? whole : `${padded.slice(0, padded.length - digits)}.${padded.slice(padded.length - digits)}`;
  // Beyond 15 digits a double cannot hold the amount: hand Intl the decimal text (exact where the runtime supports it).
  const text = sign + decimal;
  return formatCurrency(whole.length <= 15 ? Number(text) : text, currency, { ...options, digits });
}

// ---------------------------------------------------------------------------------------------
// Dates and times (in the viewer's time zone)

type DateLike = Date | number | string;
type DateOptions = Intl.DateTimeFormatOptions & WithLocale;

const FIELD_KEYS = ['dateStyle', 'timeStyle', 'weekday', 'era', 'year', 'month', 'day', 'hour', 'minute', 'second', 'dayPeriod'];

function format(value: DateLike, defaults: Intl.DateTimeFormatOptions, options: DateOptions): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const { locale, ...rest } = options;
  const custom = FIELD_KEYS.some((key) => (rest as Record<string, unknown>)[key] !== undefined);
  return dateFormat(locale ?? formatLocale(), custom ? rest : { ...defaults, ...rest }).format(date);
}

/** "Nov 21, 2026" / "21 nov. 2026". Pass options (`{ weekday: 'short', day: 'numeric' }`) to choose the fields yourself. */
export const formatDate = (value: DateLike, options: DateOptions = {}): string =>
  format(value, { year: 'numeric', month: 'short', day: 'numeric' }, options);

/** "Nov 21, 2026, 2:14 PM". */
export const formatDateTime = (value: DateLike, options: DateOptions = {}): string =>
  format(value, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }, options);

/** "2:14 PM" / "14:14". */
export const formatTime = (value: DateLike, options: DateOptions = {}): string =>
  format(value, { hour: 'numeric', minute: '2-digit' }, options);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "5 minutes ago", "in 2 hours", "yesterday", "now": the largest whole unit between `value` and `now` (default: the current time).
 * It is always relative; for "a date after a week" choose between this and `formatDate` yourself.
 */
export function formatRelativeTime(
  value: DateLike,
  options: WithLocale & { now?: number | undefined; style?: 'long' | 'short' | 'narrow' | undefined } = {},
): string {
  const at = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(at)) return '';
  const diff = at - (options.now ?? Date.now());
  const abs = Math.abs(diff);
  const [unit, size]: [Intl.RelativeTimeFormatUnit, number] =
    abs < MINUTE
      ? ['second', 1000]
      : abs < HOUR
        ? ['minute', MINUTE]
        : abs < DAY
          ? ['hour', HOUR]
          : abs < 7 * DAY
            ? ['day', DAY]
            : abs < 30 * DAY
              ? ['week', 7 * DAY]
              : abs < 365 * DAY
                ? ['month', 30 * DAY]
                : ['year', 365 * DAY];
  // Under a minute is "now": counting seconds in a list that refreshes rarely is noise.
  const amount = unit === 'second' ? 0 : Math.trunc(diff / size);
  const rtf = memo('r', options.locale ?? formatLocale(), { style: options.style ?? 'long' }, () =>
    new Intl.RelativeTimeFormat(options.locale ?? formatLocale(), { numeric: 'auto', style: options.style ?? 'long' }),
  );
  return rtf.format(amount, unit);
}

// ---------------------------------------------------------------------------------------------
// Lists, sizes, durations

/** ["a", "b", "c"] is "a, b, and c" in English, "a, b et c" in French. `type: 'disjunction'` says "or". */
export function formatList(
  items: readonly string[],
  options: WithLocale & { type?: 'conjunction' | 'disjunction' | 'unit' | undefined; style?: 'long' | 'short' | 'narrow' | undefined } = {},
): string {
  const locale = options.locale ?? formatLocale();
  const type = options.type ?? 'conjunction';
  const style = options.style ?? 'long';
  if (typeof Intl.ListFormat !== 'function') return items.join(', ');
  return memo('l', locale, { type, style }, () => new Intl.ListFormat(locale, { type, style })).format(items);
}

const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

/**
 * 1536 is "1.5 kB" in English, "1,5 ko" in French. Steps of 1024, one decimal under 10, none above. The unit names come from
 * `Intl`, so they are the language's own.
 */
export function formatBytes(bytes: number, options: WithLocale & { unitDisplay?: 'short' | 'long' | 'narrow' | undefined } = {}): string {
  if (!Number.isFinite(bytes)) return '';
  let value = Math.max(bytes, 0);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return formatNumber(unit === 0 ? Math.round(value) : value, {
    locale: options.locale,
    style: 'unit',
    unit: BYTE_UNITS[unit] as string,
    unitDisplay: options.unitDisplay ?? 'short',
    maximumFractionDigits: unit === 0 || value >= 10 ? 0 : 1,
  });
}

const DURATION_UNITS: readonly (readonly [string, number])[] = [
  ['day', DAY],
  ['hour', HOUR],
  ['minute', MINUTE],
  ['second', 1000],
];

/** 3 725 000 ms is "1 hr, 2 min" (the two largest non-zero units). Under a second is "0 sec". */
export function formatDuration(ms: number, options: WithLocale & { parts?: number | undefined } = {}): string {
  if (!Number.isFinite(ms)) return '';
  let rest = Math.max(Math.round(ms / 1000) * 1000, 0);
  const pieces: string[] = [];
  for (const [unit, size] of DURATION_UNITS) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n > 0 && pieces.length < (options.parts ?? 2)) {
      pieces.push(formatNumber(n, { locale: options.locale, style: 'unit', unit, unitDisplay: 'short' }));
    }
  }
  if (pieces.length === 0) pieces.push(formatNumber(0, { locale: options.locale, style: 'unit', unit: 'second', unitDisplay: 'short' }));
  return formatList(pieces, { locale: options.locale, type: 'unit', style: 'narrow' });
}

// ---------------------------------------------------------------------------------------------
// Names of languages, regions and currencies

type DisplayNamesCtor = new (locales: string[], options: { type: string }) => { of(code: string): string | undefined };

/**
 * "German (Germany)" for the language `de-DE`, "United States" for the region `US`, "Euro" for the currency `EUR`, written in the active
 * language. The code itself comes back when the runtime cannot name it (`Intl.DisplayNames` is newer than the TypeScript library level
 * of this project, so it is reached through a cast).
 */
export function formatDisplayName(code: string, type: 'language' | 'region' | 'currency', options: WithLocale = {}): string {
  const Names = (Intl as unknown as { DisplayNames?: DisplayNamesCtor }).DisplayNames;
  if (!Names) return code;
  try {
    const locale = options.locale ?? formatLocale();
    const names = memo('dn', locale, { type }, () => new Names([locale], { type }));
    const wanted = type === 'region' || type === 'currency' ? code.toUpperCase() : code.replace('_', '-');
    const name = names.of(wanted);
    return name && name !== wanted ? name : code;
  } catch {
    return code;
  }
}
