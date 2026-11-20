import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPLACING_NOTE, replyHint, reviewByline } from './reply-dialog.ts';

const base = { authorName: null, device: null, appVersion: null, buildNumber: null, territory: null, language: null };

test('reviewByline: author first, then what the review carries; nothing for what is missing', () => {
  assert.deepEqual(reviewByline(base), []);
  assert.deepEqual(reviewByline({ ...base, authorName: ' Ana ', appVersion: '3.2.0', buildNumber: '412', device: 'iPhone' }), [
    'by Ana',
    'iPhone',
    'Version 3.2.0 (412)',
  ]);
  assert.deepEqual(reviewByline({ ...base, authorName: '  ' }), []);
});

test('replyHint: the limit, the store, and that it stays a draft', () => {
  assert.equal(
    replyHint('Google Play', 350),
    'Plain text only, up to 350 characters in Google Play. It stays a draft until an admin sends it.',
  );
});

test('REPLACING_NOTE is one short note', () => {
  assert.ok(REPLACING_NOTE.length < 140);
});
