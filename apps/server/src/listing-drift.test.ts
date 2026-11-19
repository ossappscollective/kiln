import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ABSENT_HASH,
  classifyDrift,
  type DriftLocale,
  fieldKey,
  flattenListing,
  hashListingValue,
  isListingField,
  listingFieldsFor,
  normalizeListingValue,
  sideProblems,
  summarize,
} from './services/listing-drift.ts';

const h = hashListingValue;

test('values are compared without line-ending and trailing-space noise, and absent is not empty', () => {
  assert.equal(normalizeListingValue('a\r\nb  \n\n'), 'a\nb');
  assert.equal(h('Hello\r\n'), h('Hello'));
  assert.notEqual(h('Hello'), h('hello'));
  assert.equal(h(null), ABSENT_HASH);
  assert.notEqual(h(''), h(null));
  assert.match(h('x'), /^[0-9a-f]{64}$/);
});

test('each platform has its own fields: Play has no subtitle or keywords', () => {
  assert.ok(listingFieldsFor('ios').includes('subtitle'));
  assert.ok(listingFieldsFor('ios').includes('keywords'));
  assert.ok(!listingFieldsFor('android').includes('subtitle'));
  assert.ok(!listingFieldsFor('android').includes('keywords'));
  assert.deepEqual(listingFieldsFor('android'), [
    'title',
    'short_description',
    'full_description',
    'video',
  ]);
  assert.ok(isListingField('android', 'short_description'));
  assert.ok(!isListingField('ios', 'short_description'));
});

test("flattenListing lists the fields of the app's own store, sorted by locale", () => {
  const values = flattenListing(
    {
      appStore: {
        locales: { 'de-DE': { name: 'Kaffee' }, 'en-US': { name: 'Coffee', subtitle: '' } },
      },
      googlePlay: { locales: { 'en-US': { title: 'Coffee (Play)' } }, changelogs: {} },
    },
    'ios',
  );
  assert.deepEqual(values, [
    { locale: 'de-DE', field: 'name', value: 'Kaffee' },
    { locale: 'en-US', field: 'name', value: 'Coffee' },
    { locale: 'en-US', field: 'subtitle', value: '' },
  ]);
  assert.deepEqual(flattenListing({}, 'android'), []);
});

test('classifyDrift: identical, missing in one, and the direction of a difference', () => {
  const none: string[] = [];
  assert.deepEqual(
    classifyDrift({ repo: 'A', live: 'A\n', repoHistory: [h('A')], liveHistory: [h('A')] }),
    { status: 'identical' },
  );
  assert.deepEqual(
    classifyDrift({ repo: null, live: null, repoHistory: none, liveHistory: none }),
    { status: 'identical' },
  );
  assert.deepEqual(classifyDrift({ repo: 'A', live: null, repoHistory: none, liveHistory: none }), {
    status: 'missing-in-one',
    missingIn: 'store',
  });
  assert.deepEqual(classifyDrift({ repo: null, live: 'A', repoHistory: none, liveHistory: none }), {
    status: 'missing-in-one',
    missingIn: 'repo',
  });
  // The repository moved from A to B; the store still shows A, which the repository once had.
  assert.equal(
    classifyDrift({ repo: 'B', live: 'A', repoHistory: [h('B'), h('A')], liveHistory: [h('A')] })
      .status,
    'repo-ahead',
  );
  // The store moved from A to B; the repository still holds A, which the store once showed.
  assert.equal(
    classifyDrift({ repo: 'A', live: 'B', repoHistory: [h('A')], liveHistory: [h('B'), h('A')] })
      .status,
    'store-ahead',
  );
  // Both moved away from A.
  assert.equal(
    classifyDrift({
      repo: 'B',
      live: 'C',
      repoHistory: [h('B'), h('A')],
      liveHistory: [h('C'), h('A')],
    }).status,
    'diverged',
  );
  // They never agreed.
  assert.equal(
    classifyDrift({ repo: 'B', live: 'C', repoHistory: [h('B')], liveHistory: new Set([h('C')]) })
      .status,
    'diverged',
  );
});

test('classifyDrift: the newest shared value is the base, even if older ones were shared too', () => {
  // Repository A, B, C (newest); store A, B. Base is B (the newest repository value the store had).
  assert.equal(
    classifyDrift({
      repo: 'C',
      live: 'B',
      repoHistory: [h('C'), h('B'), h('A')],
      liveHistory: [h('B'), h('A')],
    }).status,
    'repo-ahead',
  );
});

test('sideProblems uses the shared validator: limits per field, nothing for an unread side', () => {
  assert.equal(sideProblems('ios', new Map()).size, 0);
  const values = new Map([
    [fieldKey('en-US', 'name'), 'N'.repeat(31)],
    [fieldKey('en-US', 'subtitle'), 'ok'],
    [fieldKey('en-US', 'keywords'), 'k'.repeat(101)],
  ]);
  const problems = sideProblems('ios', values);
  const name = problems.get(fieldKey('en-US', 'name'));
  assert.deepEqual(
    name?.map((p) => [p.code, p.limit, p.actual, p.unit]),
    [['too_long', 30, 31, 'characters']],
  );
  assert.equal(problems.get(fieldKey('en-US', 'keywords'))?.[0]?.unit, 'bytes');
  assert.equal(problems.get(fieldKey('en-US', 'subtitle')), undefined);
  // The app wide copyright is never read, so it is never reported.
  assert.ok([...problems.keys()].every((k) => !k.includes('copyright')));
  // Play: title limit is 30 too, short description 80.
  const play = sideProblems(
    'android',
    new Map([[fieldKey('en-US', 'short_description'), 'S'.repeat(81)]]),
  );
  assert.equal(play.get(fieldKey('en-US', 'short_description'))?.[0]?.limit, 80);
});

test('summarize counts every status', () => {
  const side = { value: null, observedAt: null, sourceRef: null, source: null };
  const field = (
    status: DriftLocale['fields'][number]['status'],
  ): DriftLocale['fields'][number] => ({
    locale: 'en-US',
    field: 'name',
    label: 'Name',
    limit: 30,
    unit: 'characters',
    status,
    repo: side,
    db: side,
    live: side,
    problems: { repo: [], live: [] },
  });
  assert.deepEqual(
    summarize([
      { locale: 'en-US', fields: [field('identical'), field('identical'), field('diverged')] },
    ]),
    { identical: 2, 'repo-ahead': 0, 'store-ahead': 0, diverged: 1, 'missing-in-one': 0 },
  );
});
