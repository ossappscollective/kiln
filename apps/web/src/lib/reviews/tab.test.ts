import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewTranslation } from './translation.ts';
import {
  isLowOnly,
  lowRatings,
  mergeTranslations,
  pendingTranslationBatches,
  ratingsWithLowOnly,
  translateAllLabel,
  unansweredChip,
  unansweredFilters,
} from './tab.ts';

const r = (
  id: string,
  over: Partial<{ title: string | null; body: string; language: string | null }> = {},
) => ({
  id,
  title: null,
  body: 'text',
  language: 'de',
  ...over,
});
const t = (reviewId: string): ReviewTranslation => ({
  reviewId,
  body: 'x',
  provider: 'google',
  cached: false,
});

test('low ratings are 1 up to the threshold, clamped to 0 to 5', () => {
  assert.deepEqual(lowRatings(2), [1, 2]);
  assert.deepEqual(lowRatings(0), []);
  assert.deepEqual(lowRatings(9), [1, 2, 3, 4, 5]);
  assert.deepEqual(lowRatings(2.9), [1, 2]);
});

test('the quick filter is on only for exactly the low ratings', () => {
  assert.equal(isLowOnly([2, 1], 2), true);
  assert.equal(isLowOnly([1], 2), false);
  assert.equal(isLowOnly([1, 2, 3], 2), false);
  assert.equal(isLowOnly([], 0), false);
  assert.deepEqual(ratingsWithLowOnly(true, 2), [1, 2]);
  assert.deepEqual(ratingsWithLowOnly(false, 2), []);
});

test('translate all: skips reviews already in the target language, with no text, or already translated', () => {
  const list = [
    r('a'),
    r('b', { language: 'en' }),
    r('c', { body: ' ', title: null }),
    r('d'),
    r('e', { language: null }),
  ];
  assert.deepEqual(pendingTranslationBatches(list, 'en', {}), [['a', 'd', 'e']]);
  assert.deepEqual(pendingTranslationBatches(list, 'en', { a: t('a') }), [['d', 'e']]);
  assert.deepEqual(pendingTranslationBatches([], 'en', {}), []);
});

test('translate all: more than 25 reviews go out in requests of at most 25', () => {
  const list = Array.from({ length: 60 }, (_, i) => r(`r${i}`));
  const batches = pendingTranslationBatches(list, 'en', {});
  assert.deepEqual(
    batches.map((b) => b.length),
    [25, 25, 10],
  );
});

test('merged translations keep the old ones and replace by review id', () => {
  const old = { ...t('a'), body: 'old' };
  const merged = mergeTranslations({ a: old, b: t('b') }, [{ ...t('a'), body: 'new' }, t('c')]);
  assert.deepEqual(Object.keys(merged).sort(), ['a', 'b', 'c']);
  assert.equal(merged.a?.body, 'new');
});

test('button label', () => {
  assert.equal(translateAllLabel(0, 'English'), 'All visible reviews are translated');
  assert.equal(translateAllLabel(3, 'English'), 'Translate all visible (3) to English');
});

test('the unanswered chip is quiet for none, and says how old the oldest is', () => {
  const now = Date.UTC(2026, 10, 19, 12);
  const hours = (n: number) => now - n * 3_600_000;
  assert.equal(unansweredChip(null, now), null);
  assert.equal(unansweredChip(undefined, now), null);
  assert.equal(unansweredChip({ count: 0, oldestAt: null, maxRating: 5 }, now), null);
  assert.equal(
    unansweredChip({ count: 5, oldestAt: hours(72), maxRating: 5 }, now)?.text,
    '5 unanswered, oldest 3 d',
  );
  assert.equal(
    unansweredChip({ count: 1, oldestAt: hours(5), maxRating: 5 }, now)?.text,
    '1 unanswered, oldest 5 h',
  );
  assert.equal(
    unansweredChip({ count: 2, oldestAt: null, maxRating: 5 }, now)?.text,
    '2 unanswered',
  );
  assert.equal(
    unansweredChip({ count: 2, oldestAt: hours(60), maxRating: 2 }, now)?.text,
    '2 unanswered (2 stars or fewer), oldest 2 d',
  );
  assert.equal(
    unansweredChip({ count: 2, oldestAt: hours(0), maxRating: 1 }, now)?.text,
    '2 unanswered (1 star), oldest under 1 h',
  );
  assert.match(
    unansweredChip({ count: 3, oldestAt: hours(5), maxRating: 5 }, now)?.label ?? '',
    /Show them/,
  );
});

test('"Show unanswered" filters on no response, and on the ratings the count covers', () => {
  assert.deepEqual(unansweredFilters(5), {
    response: 'no',
    statuses: ['new', 'triaged', 'replied_in_console'],
    ratings: [],
  });
  assert.deepEqual(unansweredFilters(2).ratings, [1, 2]);
  assert.equal(unansweredFilters(2).response, 'no');
});
