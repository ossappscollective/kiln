import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listingBudget, type StagedChangesView } from '@kiln/core';
import {
  asksToAddKeywords,
  budgetHeadline,
  coachHref,
  countriesForLocale,
  fieldsFromDrift,
  fitFieldOf,
  keywordsForLocale,
  meterNumber,
  meterTitle,
  meterTone,
  overlayStaged,
  withoutParam,
} from './budget.ts';

const side = (value: string | null) => ({ value, observedAt: null, sourceRef: null, source: null });
const drift = (field: string, live: string | null, db: string | null = null, locale = 'en-US') => ({
  locale,
  field,
  live: side(live),
  db: side(db),
});
const view = (text: { locale: string; field: string; value: string }[]): StagedChangesView =>
  ({ text }) as unknown as StagedChangesView;

test('fitFieldOf maps the store field ids of each platform and ignores the rest', () => {
  assert.equal(fitFieldOf('ios', 'name'), 'title');
  assert.equal(fitFieldOf('macos', 'keywords'), 'keywords');
  assert.equal(fitFieldOf('android', 'short_description'), 'shortDescription');
  assert.equal(fitFieldOf('android', 'full_description'), 'description');
  assert.equal(fitFieldOf('ios', 'promotional_text'), null);
  assert.equal(fitFieldOf('android', 'name'), null);
});

test('fieldsFromDrift: the store copy, the last synced one when the store has none, staged text on top', () => {
  const rows = [
    drift('name', 'Hydro Buddy'),
    drift('subtitle', null, 'Old subtitle'),
    drift('keywords', 'a,b'),
    drift('promotional_text', 'ignored'),
  ];
  const plain = fieldsFromDrift('ios', 'en-US', rows, null);
  assert.deepEqual(plain.fields, {
    title: 'Hydro Buddy',
    subtitle: 'Old subtitle',
    keywords: 'a,b',
  });
  assert.deepEqual(plain.staged, []);
  const withStaged = fieldsFromDrift(
    'ios',
    'en-US',
    rows,
    view([
      { locale: 'en-US', field: 'keywords', value: 'water,habit' },
      { locale: 'de-DE', field: 'name', value: 'other locale' },
      { locale: 'en-US', field: 'promotional_text', value: 'not a budget field' },
    ]),
  );
  assert.equal(withStaged.fields.keywords, 'water,habit');
  assert.equal(withStaged.fields.title, 'Hydro Buddy');
  assert.deepEqual(withStaged.staged, ['keywords']);
});

test('overlayStaged: a staged text for a field the base lacks is added', () => {
  const out = overlayStaged(
    'android',
    'en-US',
    { title: 'Pocket' },
    view([{ locale: 'en-US', field: 'short_description', value: 'Short' }]),
  );
  assert.deepEqual(out.fields, { title: 'Pocket', shortDescription: 'Short' });
  assert.deepEqual(out.staged, ['shortDescription']);
});

test('keywordsForLocale takes the exact locale only; countries are sorted and unique', () => {
  const k = [
    { id: '1', term: 'a', priority: 2, locale: 'en-US', country: 'us' },
    { id: '2', term: 'b', priority: 3, locale: 'en_us', country: 'ca' },
    { id: '3', term: 'c', priority: 2, locale: 'en-GB', country: 'gb' },
    { id: '4', term: 'd', priority: 2, locale: 'en-US', country: 'us' },
  ];
  assert.deepEqual(
    keywordsForLocale(k, 'en-US').map((x) => x.id),
    ['1', '2', '4'],
  );
  assert.deepEqual(countriesForLocale(k, 'en-US'), ['ca', 'us']);
});

test('meter words: tone, number and title say the same thing', () => {
  const b = listingBudget({
    platform: 'ios',
    locale: 'en-US',
    fields: { title: 'x'.repeat(31), subtitle: 'x'.repeat(28), keywords: 'habit' },
    keywords: [],
  });
  const [title, subtitle, keywords] = b.fields;
  assert.equal(meterTone(title as never), 'bad');
  assert.equal(meterTitle(title as never), '1 over the limit of 30 characters');
  assert.equal(meterTone(subtitle as never), 'warn');
  assert.equal(meterNumber(subtitle as never), '28/30');
  assert.equal(meterTone(keywords as never), 'ok');
  assert.equal(meterTitle(keywords as never), '5 of 100 bytes, 95 left');
});

test('budgetHeadline: nothing to say is an empty line', () => {
  const quiet = listingBudget({
    platform: 'ios',
    locale: 'en-US',
    fields: { title: 'Water', subtitle: 'Drink', keywords: 'habit' },
    keywords: [{ id: 'a', term: 'habit' }],
  });
  assert.equal(budgetHeadline(quiet), '');
  const loud = listingBudget({
    platform: 'ios',
    locale: 'en-US',
    fields: { title: 'Water Tracker', subtitle: '', keywords: 'tracker, habit' },
    keywords: [{ id: 'a', term: 'sleep' }],
  });
  assert.equal(
    budgetHeadline(loud),
    '9 characters could be freed, 1 tracked keyword not in the listing',
  );
});

test('addresses: add=1 opens the add panel once, and the listing link names the locale', () => {
  assert.equal(
    coachHref({ to: 'keywords_add', label: 'x' }, 'a1', null),
    '#/portfolio/a1/insights?view=keywords&add=1',
  );
  assert.equal(
    coachHref({ to: 'keywords_add', label: 'x' }, 'a1', 'ios'),
    '#/portfolio/a1/insights?platform=ios&view=keywords&add=1',
  );
  assert.equal(
    coachHref({ to: 'competitors', label: 'x' }, 'a1', 'ios'),
    '#/portfolio/a1/insights?platform=ios&view=competitors',
  );
  assert.equal(
    coachHref({ to: 'listing', locale: 'de-DE', label: 'x' }, 'a1', 'ios'),
    '#/portfolio/a1/listing?platform=ios&locale=de-DE',
  );
  assert.equal(coachHref({ to: 'listing', label: 'x' }, 'a1'), '#/portfolio/a1/listing');
  assert.equal(asksToAddKeywords('#/portfolio/a1/aso?platform=ios&add=1'), true);
  assert.equal(asksToAddKeywords('#/portfolio/a1/aso'), false);
  assert.equal(
    withoutParam('#/portfolio/a1/aso?platform=ios&add=1', 'add'),
    '#/portfolio/a1/aso?platform=ios',
  );
  assert.equal(withoutParam('#/portfolio/a1/aso?add=1', 'add'), '#/portfolio/a1/aso');
  assert.equal(withoutParam('#/portfolio/a1/aso', 'add'), '#/portfolio/a1/aso');
});
