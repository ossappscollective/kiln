import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPackageName, parseStoreRef } from './store-ref.ts';

// Hand-written strings in the shapes the stores use; nothing here was fetched.
test('numbers and id123 are App Store ids', () => {
  assert.deepEqual(parseStoreRef('389801252'), { store: 'app_store', id: '389801252' });
  assert.deepEqual(parseStoreRef(' ID389801252 '), { store: 'app_store', id: '389801252' });
  assert.equal(parseStoreRef('1234567890123456'), undefined);
});

test('an apps.apple.com link gives the id and the storefront', () => {
  assert.deepEqual(parseStoreRef('https://apps.apple.com/de/app/instagram/id389801252?uo=4'), {
    store: 'app_store',
    id: '389801252',
    country: 'de',
  });
  assert.deepEqual(parseStoreRef('apps.apple.com/app/id389801252'), {
    store: 'app_store',
    id: '389801252',
  });
  assert.deepEqual(parseStoreRef('https://itunes.apple.com/us/app/x/id12#frag'), {
    store: 'app_store',
    id: '12',
    country: 'us',
  });
  assert.equal(parseStoreRef('https://apps.apple.com/us/app/no-id'), undefined);
});

test('a play.google.com link gives the package; other hosts are not links', () => {
  assert.deepEqual(
    parseStoreRef('https://play.google.com/store/apps/details?id=com.example.app&hl=en&gl=US'),
    { store: 'google_play', id: 'com.example.app' },
  );
  assert.equal(parseStoreRef('https://play.google.com/store/apps/details?id=nope'), undefined);
  assert.equal(
    parseStoreRef('https://evil.example/store/apps/details?id=com.example.app'),
    undefined,
  );
  assert.equal(parseStoreRef('https://apps.apple.com.evil.example/us/app/x/id12'), undefined);
});

test('a bare package name is a reference only for a Google Play app', () => {
  assert.deepEqual(parseStoreRef('com.example.app', 'google_play'), {
    store: 'google_play',
    id: 'com.example.app',
  });
  assert.equal(parseStoreRef('com.example.app', 'app_store'), undefined);
  assert.equal(parseStoreRef('com..app', 'google_play'), undefined);
  assert.equal(isPackageName('com.x.y'), true);
  assert.equal(isPackageName('1com.x'), false);
  assert.equal(isPackageName('single'), false);
});

test('a name is not a reference', () => {
  assert.equal(parseStoreRef('instagram'), undefined);
  assert.equal(parseStoreRef('photo editor pro'), undefined);
  assert.equal(parseStoreRef(''), undefined);
});
