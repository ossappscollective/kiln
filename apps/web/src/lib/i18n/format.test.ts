import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  currencyDigits,
  formatBytes,
  formatCompact,
  formatCurrency,
  formatDate,
  formatDisplayName,
  formatDateTime,
  formatDuration,
  formatList,
  formatMinorUnits,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatTime,
} from './format.ts';
import { useLocale } from './test-setup.ts';

const UTC = { timeZone: 'UTC' } as const;
const plain = (text: string): string => text.replace(/[\u00a0\u202f]/g, ' ');
const instant = Date.UTC(2026, 10, 21, 14, 14, 0);

test('numbers follow the language', () => {
  assert.equal(formatNumber(12345.6, { locale: 'en' }), '12,345.6');
  assert.equal(formatNumber(12345.6, { locale: 'de' }), '12.345,6');
  assert.equal(plain(formatNumber(12345.6, { locale: 'fr' })), '12 345,6');
  assert.equal(formatNumber(Number.NaN), '');
  assert.equal(formatNumber(Number.POSITIVE_INFINITY), '');
  assert.equal(formatNumber(1.005, { locale: 'en', maximumFractionDigits: 2 }), '1.01');
});

test('percent and compact', () => {
  assert.equal(formatPercent(0.256, { locale: 'en' }), '26%');
  assert.equal(formatPercent(0.0123, { locale: 'en', maximumFractionDigits: 1 }), '1.2%');
  assert.equal(plain(formatPercent(0.256, { locale: 'fr' })), '26 %');
  assert.equal(formatCompact(12_900, { locale: 'en' }), '12.9K');
  assert.equal(formatCompact(4_200_000, { locale: 'en' }), '4.2M');
  assert.equal(formatCompact(-12_900, { locale: 'en' }), '-12.9K');
});

test('currency in major units', () => {
  assert.equal(formatCurrency(1234.5, 'USD', { locale: 'en' }), '$1,234.50');
  assert.equal(plain(formatCurrency(1234.5, 'EUR', { locale: 'de' })), '1.234,50 €');
  assert.equal(plain(formatCurrency(1234.5, 'EUR', { locale: 'fr' })), '1 234,50 €');
  assert.equal(formatCurrency(1234.5, 'USD', { locale: 'en', digits: 0 }), '$1,235');
  assert.equal(formatCurrency(500, 'JPY', { locale: 'en' }), '¥500');
  assert.equal(formatCurrency(12.5, 'zz', { locale: 'en' }), 'zz 12.50');
  assert.equal(formatCurrency(12.5, null, { locale: 'en' }), '12.50');
  assert.equal(formatCurrency(Number.NaN, 'USD'), '');
});

test('currency decimals', () => {
  assert.equal(currencyDigits('USD'), 2);
  assert.equal(currencyDigits('JPY'), 0);
  assert.equal(currencyDigits('KWD'), 3);
});

test('minor units move by text, never by floating point', () => {
  assert.equal(formatMinorUnits('499', 'USD', { locale: 'en' }), '$4.99');
  assert.equal(formatMinorUnits('5', 'USD', { locale: 'en' }), '$0.05');
  assert.equal(formatMinorUnits('0', 'USD', { locale: 'en' }), '$0.00');
  assert.equal(formatMinorUnits('-250', 'USD', { locale: 'en' }), '-$2.50');
  assert.equal(formatMinorUnits('500', 'JPY', { locale: 'en' }), '¥500');
  assert.equal(plain(formatMinorUnits('1234', 'KWD', { locale: 'en' })), 'KWD 1.234');
  assert.equal(formatMinorUnits('123456789012345', 'USD', { locale: 'en' }), '$1,234,567,890,123.45');
  assert.equal(formatMinorUnits('0000499', 'USD', { locale: 'en' }), '$4.99');
  assert.equal(formatMinorUnits('4.99', 'USD'), '');
  assert.equal(formatMinorUnits('', 'USD'), '');
  assert.equal(plain(formatMinorUnits('499', 'EUR', { locale: 'de' })), '4,99 €');
  // 0.1 + 0.2 style traps: 29 cents is 0.29, not 0.28999.
  assert.equal(formatMinorUnits('29', 'USD', { locale: 'en' }), '$0.29');
});

test('dates, times and date-times (UTC here so the test is the same everywhere)', () => {
  assert.equal(formatDate(instant, { locale: 'en', ...UTC }), 'Nov 21, 2026');
  assert.equal(formatDate(instant, { locale: 'fr', ...UTC }), '21 nov. 2026');
  assert.equal(formatDate(instant, { locale: 'de', ...UTC }), '21. Nov. 2026');
  assert.equal(formatDate(instant, { locale: 'en-GB', ...UTC }), '21 Nov 2026');
  assert.equal(formatDate(new Date(instant), { locale: 'en', ...UTC, weekday: 'short', day: 'numeric' }), '21 Sat');
  assert.equal(plain(formatTime(instant, { locale: 'en', ...UTC })), '2:14 PM');
  assert.equal(formatTime(instant, { locale: 'de', ...UTC }), '14:14');
  assert.equal(plain(formatDateTime(instant, { locale: 'en', ...UTC })), 'Nov 21, 2026, 2:14 PM');
  assert.equal(formatDate(new Date(Number.NaN)), '');
  assert.equal(formatDate('not a date'), '');
  assert.equal(formatDate('2026-11-21T14:14:00Z', { locale: 'en', ...UTC }), 'Nov 21, 2026');
  assert.equal(formatDate(instant, { locale: 'en', ...UTC, dateStyle: 'long' }), 'November 21, 2026');
});

test('relative time', () => {
  const now = instant;
  const at = (ms: number, locale = 'en') => formatRelativeTime(now - ms, { now, locale });
  assert.equal(at(5_000), 'now');
  assert.equal(at(5 * 60_000), '5 minutes ago');
  assert.equal(at(60_000), '1 minute ago');
  assert.equal(at(3 * 3_600_000), '3 hours ago');
  assert.equal(at(24 * 3_600_000), 'yesterday');
  assert.equal(at(3 * 86_400_000), '3 days ago');
  assert.equal(at(14 * 86_400_000), '2 weeks ago');
  assert.equal(at(60 * 86_400_000), '2 months ago');
  assert.equal(at(400 * 86_400_000), 'last year');
  assert.equal(formatRelativeTime(now + 2 * 3_600_000, { now, locale: 'en' }), 'in 2 hours');
  assert.equal(at(5 * 60_000, 'fr'), 'il y a 5 minutes');
  assert.equal(at(5 * 60_000, 'de'), 'vor 5 Minuten');
  assert.equal(at(5 * 60_000, 'es'), 'hace 5 minutos');
  assert.equal(at(24 * 3_600_000, 'fr'), 'hier');
  assert.equal(formatRelativeTime('nope'), '');
});

test('lists', () => {
  assert.equal(formatList(['a', 'b', 'c'], { locale: 'en' }), 'a, b, and c');
  assert.equal(formatList(['a', 'b', 'c'], { locale: 'fr' }), 'a, b et c');
  assert.equal(formatList(['a', 'b', 'c'], { locale: 'de' }), 'a, b und c');
  assert.equal(formatList(['a', 'b'], { locale: 'en', type: 'disjunction' }), 'a or b');
  assert.equal(formatList([], { locale: 'en' }), '');
  assert.equal(formatList(['a'], { locale: 'en' }), 'a');
});

test('byte sizes are 1024-based with the language\'s own unit names', () => {
  assert.equal(formatBytes(0, { locale: 'en' }), '0 byte');
  assert.equal(formatBytes(512, { locale: 'en' }), '512 byte');
  assert.equal(formatBytes(1536, { locale: 'en' }), '1.5 kB');
  assert.equal(plain(formatBytes(1536, { locale: 'fr' })), '1,5 ko');
  assert.equal(formatBytes(15 * 1024 * 1024, { locale: 'en' }), '15 MB');
  assert.equal(formatBytes(3 * 1024 ** 3, { locale: 'en' }), '3 GB');
  assert.equal(formatBytes(-5, { locale: 'en' }), '0 byte');
  assert.equal(formatBytes(Number.NaN), '');
});

test('durations show the two largest units', () => {
  assert.equal(formatDuration(3_725_000, { locale: 'en' }), '1 hr 2 min');
  assert.equal(formatDuration(45_000, { locale: 'en' }), '45 sec');
  assert.equal(formatDuration(0, { locale: 'en' }), '0 sec');
  assert.equal(formatDuration(90_061_000, { locale: 'en' }), '1 day 1 hr');
  assert.equal(formatDuration(90_061_000, { locale: 'en', parts: 4 }), '1 day 1 hr 1 min 1 sec');
});

test('helpers follow the active language when no locale is passed', () => {
  useLocale('de');
  assert.equal(formatNumber(1234.5), '1.234,5');
  assert.equal(plain(formatCurrency(9.99, 'EUR')), '9,99 €');
  assert.equal(formatDate(instant, UTC), '21. Nov. 2026');
  useLocale('fr');
  assert.equal(plain(formatNumber(1234.5)), '1 234,5');
  useLocale('en');
  assert.equal(formatNumber(1234.5), '1,234.5');
});

test('names of languages, regions and currencies', () => {
  assert.equal(formatDisplayName('de-DE', 'language', { locale: 'en' }), 'German (Germany)');
  assert.equal(formatDisplayName('de_DE', 'language', { locale: 'fr' }), 'allemand (Allemagne)');
  assert.equal(formatDisplayName('us', 'region', { locale: 'en' }), 'United States');
  assert.equal(formatDisplayName('US', 'region', { locale: 'de' }), 'Vereinigte Staaten');
  assert.equal(formatDisplayName('EUR', 'currency', { locale: 'en' }), 'Euro');
  assert.equal(formatDisplayName('zzzz', 'region', { locale: 'en' }), 'zzzz');
  assert.equal(formatDisplayName('not a code!', 'language', { locale: 'en' }), 'not a code!');
});
