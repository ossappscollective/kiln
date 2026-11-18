import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewTranslation } from './review-translation.ts';
import { isLowOnly, lowRatings, mergeTranslations, pendingTranslationBatches, ratingsWithLowOnly, translateAllLabel } from './reviews-tab.ts';

const r = (id: string, over: Partial<{ title: string | null; body: string; language: string | null }> = {}) => ({
  id,
  title: null,
  body: 'text',
  language: 'de',
  ...over,
});
const t = (reviewId: string): ReviewTranslation => ({ reviewId, body: 'x', provider: 'google', cached: false });

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
  const list = [r('a'), r('b', { language: 'en' }), r('c', { body: ' ', title: null }), r('d'), r('e', { language: null })];
  assert.deepEqual(pendingTranslationBatches(list, 'en', {}), [['a', 'd', 'e']]);
  assert.deepEqual(pendingTranslationBatches(list, 'en', { a: t('a') }), [['d', 'e']]);
  assert.deepEqual(pendingTranslationBatches([], 'en', {}), []);
});

test('translate all: more than 25 reviews go out in requests of at most 25', () => {
  const list = Array.from({ length: 60 }, (_, i) => r(`r${i}`));
  const batches = pendingTranslationBatches(list, 'en', {});
  assert.deepEqual(batches.map((b) => b.length), [25, 25, 10]);
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
