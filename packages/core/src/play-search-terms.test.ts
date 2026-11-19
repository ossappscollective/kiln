import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type SearchTermPoint, SEARCH_TERM_OTHER_KEY, readSearchTerm, searchTermInsights, summariseSearchTerms } from './play-search-terms.ts';

const row = (over: Partial<SearchTermPoint> & { term: string }): SearchTermPoint => {
  const read = readSearchTerm(over.term);
  return {
    country: '',
    from: '2026-11-01',
    to: '2026-11-01',
    key: read ? read.key : SEARCH_TERM_OTHER_KEY,
    visitors: 10,
    installs: 2,
    conversion: null,
    ...over,
  };
};

test('readSearchTerm keeps the text and folds the key, and refuses what is not a term', () => {
  assert.deepEqual(readSearchTerm('  Habit   Tracker '), { term: 'Habit Tracker', key: 'habit tracker' });
  assert.deepEqual(readSearchTerm('Hàbit-tracker'), { term: 'Hàbit-tracker', key: 'habit tracker' });
  assert.equal(readSearchTerm(''), undefined);
  assert.equal(readSearchTerm('***'), undefined);
  assert.equal(readSearchTerm('a\u0000b'), undefined);
  assert.equal(readSearchTerm('x'.repeat(101)), undefined);
  assert.ok(readSearchTerm('x'.repeat(100)));
});

test('summarise sums per term over the days of a period, orders by installs, derives conversion', () => {
  const rows = [
    row({ term: 'water reminder', from: '2026-11-01', to: '2026-11-01', visitors: 100, installs: 10 }),
    row({ term: 'Water Reminder', from: '2026-11-02', to: '2026-11-02', visitors: 50, installs: 5 }),
    row({ term: 'drink log', visitors: 400, installs: 4 }),
    row({ term: 'old', from: '2026-10-01', to: '2026-10-01', visitors: 999, installs: 999 }),
  ];
  const s = summariseSearchTerms(rows, { from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(s.terms.map((t) => [t.key, t.visitors, t.installs]), [['water reminder', 150, 15], ['drink log', 400, 4]]);
  assert.equal(s.terms[0]?.conversion, 0.1);
  assert.equal(s.termCount, 2);
  assert.deepEqual(s.totals, { visitors: 550, installs: 19 });
  const byVisitors = summariseSearchTerms(rows, { from: '2026-11-01', to: '2026-11-30', sort: 'visitors' });
  assert.deepEqual(byVisitors.terms.map((t) => t.key), ['drink log', 'water reminder']);
  assert.equal(summariseSearchTerms(rows, { from: '2026-11-01', to: '2026-11-30', limit: 1 }).terms.length, 1);
});

test('the Other row is a line of its own, never a term; a row with a missing number is not given a conversion it cannot back', () => {
  const rows = [
    row({ term: 'a term', visitors: 10, installs: null, conversion: null }),
    row({ term: 'b term', visitors: 10, installs: 5 }),
    { country: '', from: '2026-11-01', to: '2026-11-01', term: '', key: SEARCH_TERM_OTHER_KEY, visitors: 70, installs: 3, conversion: null },
  ];
  const s = summariseSearchTerms(rows, { from: '2026-11-01', to: '2026-11-01' });
  assert.deepEqual(s.other, { visitors: 70, installs: 3 });
  assert.equal(s.terms.length, 2);
  assert.equal(s.terms.find((t) => t.key === 'a term')?.conversion, null);
  assert.equal(s.terms.find((t) => t.key === 'b term')?.conversion, 0.5);
  assert.deepEqual(s.totals, { visitors: 90, installs: 8 });
});

test('a single row with only the file\'s own conversion keeps it', () => {
  const s = summariseSearchTerms([row({ term: 'x term', visitors: null, installs: null, conversion: 0.25 })], { from: '2026-11-01', to: '2026-11-01' });
  assert.equal(s.terms[0]?.conversion, 0.25);
  assert.equal(s.terms[0]?.visitors, null);
});

test('rows of a file with no dates are not counted again next to day rows of the same country', () => {
  const rows = [
    row({ term: 'x term', country: 'us', from: '2026-11-01', to: '2026-11-01', visitors: 10, installs: 1 }),
    row({ term: 'x term', country: 'us', from: '2026-11-01', to: '2026-11-07', visitors: 70, installs: 7 }),
    row({ term: 'x term', country: 'de', from: '2026-11-01', to: '2026-11-07', visitors: 5, installs: 1 }),
  ];
  const s = summariseSearchTerms(rows, { from: '2026-11-01', to: '2026-11-30' });
  assert.equal(s.droppedPeriodRows, 1);
  assert.equal(s.terms[0]?.visitors, 15);
  assert.deepEqual(s.terms[0]?.countries, ['de', 'us']);
  assert.equal(summariseSearchTerms(rows, { from: '2026-11-01', to: '2026-11-30', country: 'de' }).terms[0]?.visitors, 5);
});

test('a period that is not fully inside the view is left out; overlapping period files are flagged', () => {
  const rows = [
    row({ term: 'x term', from: '2026-11-01', to: '2026-11-28' }),
    row({ term: 'x term', from: '2026-11-15', to: '2026-12-12' }),
  ];
  const s = summariseSearchTerms(rows, { from: '2026-11-01', to: '2026-11-30' });
  assert.equal(s.rowsUsed, 1);
  assert.equal(s.overlappingPeriods, false);
  const both = summariseSearchTerms(rows, { from: '2026-11-01', to: '2026-12-31' });
  assert.equal(both.overlappingPeriods, true);
});

test('insights: tracked per storefront, in the listing or not, and the hint only for installs outside the listing', () => {
  const rows = [
    row({ term: 'water reminder', visitors: 100, installs: 10 }),
    row({ term: 'hydration alarm', visitors: 80, installs: 6 }),
    row({ term: 'zero installs term', visitors: 80, installs: 0 }),
    row({ term: 'habit streak', visitors: 20, installs: 1 }),
  ];
  const lines = summariseSearchTerms(rows, { from: '2026-11-01', to: '2026-11-30' }).terms;
  const fields = { title: 'Water Reminder: Drink Log', shortDescription: 'Track your habit every day', description: 'Stay hydrated with gentle nudges.' };
  const out = searchTermInsights(lines, {
    locale: 'en-US',
    fields,
    tracked: [{ id: 'k1', key: 'water reminder', country: 'us' }, { id: 'k2', key: 'hydration alarm', country: 'de' }],
  });
  const by = (key: string) => out.find((l) => l.key === key);
  assert.equal(by('water reminder')?.trackedKeywordId, 'k1');
  assert.equal(by('water reminder')?.listing, 'in_listing');
  assert.equal(by('water reminder')?.hint, null);
  assert.equal(by('hydration alarm')?.listing, 'not_in_listing', 'hydrated is not hydration');
  assert.equal(by('hydration alarm')?.trackedKeywordId, 'k2');
  assert.deepEqual(by('hydration alarm')?.trackedCountries, ['de']);
  assert.equal(by('hydration alarm')?.hint, 'add_to_listing');
  assert.equal(by('zero installs term')?.hint, null, 'no installs, no hint');
  assert.equal(by('habit streak')?.listing, 'partly');
  assert.equal(by('habit streak')?.hint, 'add_to_listing');
  // A storefront choice only counts keywords of that storefront.
  const us = searchTermInsights(lines, { locale: 'en-US', fields, tracked: [{ id: 'k2', key: 'hydration alarm', country: 'de' }], country: 'us' });
  assert.equal(us.find((l) => l.key === 'hydration alarm')?.trackedKeywordId, null);
});

test('insights: without stored listing text nothing is claimed about it', () => {
  const lines = summariseSearchTerms([row({ term: 'x term', installs: 5 })], { from: '2026-11-01', to: '2026-11-01' }).terms;
  const out = searchTermInsights(lines, { locale: 'en-US', fields: null, tracked: [] });
  assert.equal(out[0]?.listing, 'unknown');
  assert.equal(out[0]?.hint, null);
});
