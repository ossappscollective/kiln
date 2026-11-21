import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listingRows } from '@kiln/core';
import { asoViewFromHash, asoViewHref, asoViews } from './aso.ts';
import { coachHref } from './budget.ts';
import {
  buildPlan,
  freshnessText,
  keywordFieldText,
  LISTING_TAG,
  planItemId,
  planKeywordItems,
  rankMark,
  roomText,
  sourcesText,
  termKeywordItem,
  termMark,
} from './listing.ts';

const NOW = 1_760_000_000_000;

const rows = () =>
  listingRows({
    platform: 'ios',
    locales: [
      {
        locale: 'en-US',
        fields: {
          title: 'Water Tracker',
          subtitle: 'Hydration notes',
          keywords: 'tracker,habit,hydration,sleep',
        },
      },
      { locale: 'de-DE', fields: { title: 'Wasser', keywords: 'gewohnheit' } },
      { locale: 'not a locale', fields: { keywords: 'oops' } },
    ],
    tracked: [{ id: 'a', term: 'habit', country: 'us', locale: 'en-US', state: 'ranked', rank: 9 }],
  });

test('the view is a tab of its own, in the address, and the coach links to it', () => {
  assert.deepEqual(
    asoViews.slice(0, 2).map((v) => v.id),
    ['keywords', 'listing'],
  );
  assert.equal(
    asoViewHref('a1', 'listing', 'ios'),
    '#/portfolio/a1/insights?platform=ios&view=listing',
  );
  assert.equal(asoViewFromHash('#/portfolio/a1/insights?view=listing'), 'listing');
  assert.equal(
    coachHref({ to: 'listing_keywords', locale: 'en-US', label: 'x' }, 'a1', 'ios'),
    '#/portfolio/a1/insights?platform=ios&view=listing',
  );
});

test('freshness: where and how long ago, or that nothing was read', () => {
  assert.equal(
    freshnessText('ios', NOW - 3 * 3_600_000, NOW),
    'Read from the App Store 3 hours ago',
  );
  assert.equal(
    freshnessText('android', NOW - 10 * 60_000, NOW),
    'Read from Google Play 10 minutes ago',
  );
  assert.equal(freshnessText('ios', null, NOW), 'Not read from the App Store yet');
});

test('words for fields, marks for waste and repeats, the rank as a small number', () => {
  assert.equal(sourcesText('ios', ['keywords']), 'keyword field');
  assert.equal(
    sourcesText('ios', ['keywords', 'title', 'subtitle']),
    'keyword field, name and subtitle',
  );
  assert.equal(
    sourcesText('android', ['title', 'shortDescription']),
    'title and short description',
  );
  assert.equal(
    termMark({ waste: 'in_title_or_subtitle', duplicate: false, entries: 1 })?.text,
    'wasted',
  );
  assert.equal(
    termMark({ waste: 'plural_variant', duplicate: false, entries: 2 })?.text,
    'repeated',
  );
  assert.equal(termMark({ waste: null, duplicate: true, entries: 0 })?.text, 'twice');
  assert.equal(termMark({ waste: null, duplicate: false, entries: 1 }), null);
  assert.equal(rankMark({ tracked: false, state: null, rank: null }), null);
  assert.equal(rankMark({ tracked: true, state: 'ranked', rank: 12 })?.text, '12');
  assert.equal(rankMark({ tracked: true, state: 'not_ranked', rank: null }, 50)?.text, '50+');
  assert.equal(rankMark({ tracked: true, state: null, rank: null })?.text, '–');
  assert.equal(
    keywordFieldText({ bytes: 26, limit: 100, remaining: 74, over: false }),
    '26 of 100 bytes, 74 left',
  );
  assert.equal(
    keywordFieldText({ bytes: 112, limit: 100, remaining: -12, over: true }),
    '12 bytes over the limit of 100',
  );
});

test('plan: what is not tracked, per locale and storefront; a locale code the API refuses is left out', () => {
  const plan = buildPlan([{ appId: 'a1', platform: 'ios', rows: rows() }]);
  assert.deepEqual(
    plan.groups.map((g) => [g.locale, g.country, g.items.map((i) => i.term)]),
    [
      ['en-US', 'us', ['tracker', 'hydration', 'sleep', 'water', 'notes']],
      ['de-DE', 'de', ['gewohnheit', 'wasser']],
    ],
  );
  assert.equal(plan.total, 7);
  const one = buildPlan([{ appId: 'a1', platform: 'ios', rows: rows() }], {
    appId: 'a1',
    locale: 'de-DE',
  });
  assert.deepEqual(
    one.groups.map((g) => g.locale),
    ['de-DE'],
  );
  assert.equal(
    buildPlan([{ appId: 'a1', platform: 'ios', rows: rows() }], { appId: 'other', locale: 'de-DE' })
      .total,
    0,
  );
});

test('plan items: the chosen terms in the storefront and locale of the group, tagged from listing', () => {
  const group = buildPlan([{ appId: 'a1', platform: 'ios', rows: rows() }]).groups[0];
  assert.ok(group);
  const skip = planItemId(group, 'sleep');
  const items = planKeywordItems(group, (i) => planItemId(group, i.key) !== skip);
  assert.deepEqual(
    items.map((i) => i.term),
    ['tracker', 'hydration', 'water', 'notes'],
  );
  assert.deepEqual(items[0], { term: 'tracker', country: 'us', locale: 'en-US', tag: LISTING_TAG });
  assert.equal(LISTING_TAG, 'from listing');
  const row = rows()[1];
  assert.ok(row);
  assert.deepEqual(termKeywordItem(row, { term: 'wasser' }), {
    term: 'wasser',
    country: 'de',
    locale: 'de-DE',
    tag: 'from listing',
  });
  assert.deepEqual(
    termKeywordItem({ locale: 'zh_Hans', country: 'cn' }, { term: 'x' }).locale,
    'zh-Hans',
  );
});

test('room: says how many more fit in the limit', () => {
  assert.equal(roomText(50, 40, 5), 'Room for 10 more of 50.');
  assert.equal(
    roomText(50, 48, 5),
    'Only 2 more fit in the limit of 50 keywords an app tracks, so the rest will not be added.',
  );
  assert.equal(roomText(undefined, 0, 5), '');
});
