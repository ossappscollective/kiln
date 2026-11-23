import assert from 'node:assert/strict';
import { test } from 'node:test';
import { languageCoverage, sameLanguages } from './language-coverage.ts';

const rows = [
  { country: 'US', count: 500 },
  { country: 'DE', count: 150 },
  { country: 'AT', count: 30 },
  { country: 'BR', count: 120 },
  { country: 'ZZ', count: 20 },
];

test('joins countries with their language and the live locales', () => {
  const c = languageCoverage({ countries: rows, storeLocales: ['en-US', 'pt-BR'] });
  assert.equal(c.total, 820);
  assert.deepEqual(
    c.languages.map((l) => [l.language, l.count, l.coveredBy]),
    [
      ['en', 500, 'en-US'],
      ['de', 180, null],
      ['pt', 120, 'pt-BR'],
    ],
  );
  assert.deepEqual(c.languages[1]?.countries.map((x) => x.country), ['DE', 'AT']);
  assert.equal(c.unknownCount, 20);
  assert.ok(Math.abs(c.uncoveredShare - 180 / 820) < 1e-9);
  assert.equal(c.countries[0]?.country, 'US');
  assert.equal(c.countries.find((x) => x.country === 'AT')?.coveredBy, null);
});

test('a country given twice is added, bad rows are dropped', () => {
  const c = languageCoverage({
    countries: [
      { country: 'de', count: 5 },
      { country: 'DE', count: 5 },
      { country: 'FR', count: 0 },
      { country: 'FRA', count: 9 },
      { country: 'IT', count: Number.NaN },
      { country: 'IT', count: -3 },
    ],
    storeLocales: [],
  });
  assert.equal(c.total, 10);
  assert.deepEqual(c.countries.map((x) => [x.country, x.count]), [['DE', 10]]);
  assert.equal(c.uncoveredShare, 1);
});

test('no downloads is an empty, not a divided-by-zero, result', () => {
  const c = languageCoverage({ countries: [], storeLocales: ['en-US'] });
  assert.deepEqual([c.total, c.languages.length, c.uncoveredShare], [0, 0, 0]);
});

test('Google Play knows more languages than the App Store', () => {
  const rows2 = [{ country: 'BG', count: 10 }];
  assert.equal(languageCoverage({ countries: rows2, storeLocales: ['en-US'] }).languages[0]?.coveredBy, 'en-US');
  const play = languageCoverage({ countries: rows2, storeLocales: ['en-US'], store: 'google_play' });
  assert.equal(play.languages[0]?.language, 'bg');
  assert.equal(play.languages[0]?.coveredBy, null);
});

test('sameLanguages ignores regions and order', () => {
  assert.equal(sameLanguages(['en-US', 'pt-BR'], ['pt-PT', 'en-GB']), true);
  assert.equal(sameLanguages(['en-US'], ['en-US', 'de-DE']), false);
});
