import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  carryOver,
  changeKinds,
  diffListing,
  imageKey,
  isListingChange,
  type ListingState,
  normalizeListingText,
  wordDiff,
} from './competitor-listing.ts';

const img = (id: string, host = 'is1-ssl', size = '392x696bb.jpg') => `https://${host}.mzstatic.com/image/thumb/PurpleSource/v4/aa/${id}/${id}.png/${size}`;
const state = (over: Partial<ListingState> = {}): ListingState => ({
  name: 'Habit', description: 'Build streaks.\nTrack goals.', releaseNotes: 'Bug fixes', version: '1.0', price: 'Free', category: 'Health',
  icon: img('icon', 'is1-ssl', '512x512bb.jpg'), iphone: [img('a'), img('b'), img('c')], ipad: [img('p')], ratingMilli: 4500, ratingCount: 1000, ...over,
});

test('the first look is no change', () => {
  assert.deepEqual(diffListing(undefined, state()), []);
});

test('a re-encoded or re-hosted image is the same image', () => {
  assert.equal(imageKey(img('a', 'is1-ssl', '392x696bb.jpg')), imageKey(img('a', 'is4-ssl', '1242x2688bb-85.webp')));
  const next = state({ iphone: [img('a', 'is2-ssl', '600x0w.webp'), img('b', 'is3-ssl'), img('c')], icon: img('icon', 'is5-ssl', '1024x1024bb.png') });
  assert.deepEqual(diffListing(state(), next), []);
});

test('reorder, replace one, add one, remove one', () => {
  const reordered = diffListing(state(), state({ iphone: [img('b'), img('a'), img('c')] }));
  assert.equal(reordered.length, 1);
  assert.deepEqual(reordered[0] && 'reordered' in reordered[0] && [reordered[0].reordered, reordered[0].added, reordered[0].removed, reordered[0].replaced], [true, 0, 0, 0]);
  const replaced = diffListing(state(), state({ iphone: [img('a'), img('z'), img('c')] }))[0];
  assert.ok(replaced && replaced.kind === 'screenshots');
  assert.deepEqual([replaced.replaced, replaced.added, replaced.removed, replaced.reordered, replaced.device], [1, 0, 0, false, 'iphone']);
  const added = diffListing(state(), state({ ipad: [img('p'), img('q')] }))[0];
  assert.ok(added && added.kind === 'screenshots');
  assert.deepEqual([added.device, added.added, added.removed], ['ipad', 1, 0]);
  const removed = diffListing(state(), state({ iphone: [img('a'), img('b')] }))[0];
  assert.ok(removed && removed.kind === 'screenshots');
  assert.deepEqual([removed.added, removed.removed], [0, 1]);
});

test('an empty read after a full one is a failed read, and carryOver keeps the old values', () => {
  const next = state({ iphone: [], ipad: [], icon: null, description: null, name: null });
  assert.deepEqual(diffListing(state(), next), []);
  assert.deepEqual(carryOver(state(), next).iphone, state().iphone);
  assert.equal(carryOver(state(), next).description, state().description);
});

test('whitespace-only text changes are ignored, real ones are found', () => {
  assert.equal(normalizeListingText('  a \r\n\r\n  b\t c '), 'a\nb c');
  assert.deepEqual(diffListing(state(), state({ description: 'Build streaks.  \n\n Track goals. ', releaseNotes: ' Bug   fixes' })), []);
  const changes = diffListing(state(), state({ name: 'Habit Pro', version: '1.1', releaseNotes: 'New widgets', price: '$1.99', category: 'Lifestyle', icon: img('icon2') }));
  assert.deepEqual(changeKinds(changes), ['icon', 'name', 'releaseNotes', 'category', 'price', 'version']);
});

test('rating noise is ignored, a jump is a change but not a listing change', () => {
  assert.deepEqual(diffListing(state(), state({ ratingMilli: 4540, ratingCount: 1030 })), []);
  const changes = diffListing(state(), state({ ratingMilli: 4300, ratingCount: 1400 }));
  assert.deepEqual(changeKinds(changes), ['rating', 'ratingCount']);
  assert.ok(changes.every((c) => !isListingChange(c)));
});

test('wordDiff shows equal runs, removed and added words', () => {
  assert.deepEqual(wordDiff('the quick brown fox', 'the slow brown fox jumps'), [
    { op: 'same', text: 'the' },
    { op: 'del', text: 'quick' },
    { op: 'ins', text: 'slow' },
    { op: 'same', text: 'brown fox' },
    { op: 'ins', text: 'jumps' },
  ]);
  assert.deepEqual(wordDiff(null, 'new text'), [{ op: 'ins', text: 'new text' }]);
});
