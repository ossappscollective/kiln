import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moveActive, primaryCountry, readField } from './competitor-search.ts';

test('readField: links and ids resolve directly, names search, short and bad text is told apart', () => {
  assert.deepEqual(readField('  ', 'app_store'), { kind: 'empty' });
  assert.deepEqual(readField('id389801252', 'app_store'), { kind: 'ref', ref: { store: 'app_store', id: '389801252' } });
  assert.deepEqual(readField('https://apps.apple.com/fr/app/x/id12', 'app_store'), {
    kind: 'ref',
    ref: { store: 'app_store', id: '12', country: 'fr' },
  });
  assert.equal(readField('a', 'app_store').kind, 'short');
  assert.deepEqual(readField('  photo   editor ', 'app_store'), { kind: 'search', term: 'photo editor' });
  assert.equal(readField('com.example.app', 'app_store').kind, 'search');
  assert.equal(readField('https://play.google.com/store/apps/details?id=com.x.y', 'app_store').kind, 'wrongStore');
  assert.equal(readField('com.x.y', 'google_play').kind, 'ref');
  assert.equal(readField('https://play.google.com/store/apps/details?id=com.x.y&hl=de', 'google_play').kind, 'ref');
  assert.equal(readField('instagram', 'google_play').kind, 'badPackage');
  assert.equal(readField('https://apps.apple.com/us/app/x/id12', 'google_play').kind, 'wrongStore');
  assert.equal(readField('389801252', 'google_play').kind, 'wrongStore');
});

test('primaryCountry: the most common storefront, us without data', () => {
  assert.equal(primaryCountry([]), 'us');
  assert.equal(primaryCountry(['de', 'DE', 'fr', 'zzz']), 'de');
  assert.equal(primaryCountry(['fr', 'de']), 'fr');
});

test('moveActive wraps', () => {
  assert.equal(moveActive(-1, 3, 'ArrowDown'), 0);
  assert.equal(moveActive(2, 3, 'ArrowDown'), 0);
  assert.equal(moveActive(-1, 3, 'ArrowUp'), 2);
  assert.equal(moveActive(0, 3, 'ArrowUp'), 2);
  assert.equal(moveActive(1, 3, 'ArrowUp'), 0);
  assert.equal(moveActive(0, 0, 'ArrowDown'), -1);
});
