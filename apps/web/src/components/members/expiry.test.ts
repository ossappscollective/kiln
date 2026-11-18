import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expiresIn } from './expiry.ts';

const now = 1_000_000_000_000;
const MIN = 60_000;

test('expiry reads in the largest sensible unit', () => {
  assert.equal(expiresIn(now + 7 * 24 * 60 * MIN, now), 'Expires in 7 days');
  assert.equal(expiresIn(now + 24 * 60 * MIN, now), 'Expires in 1 day');
  assert.equal(expiresIn(now + 5 * 60 * MIN + 1, now), 'Expires in 5 hours');
  assert.equal(expiresIn(now + 60 * MIN, now), 'Expires in 1 hour');
  assert.equal(expiresIn(now + 20 * MIN, now), 'Expires in 20 minutes');
  assert.equal(expiresIn(now + 1, now), 'Expires in 1 minute');
});

test('a passed expiry says expired', () => {
  assert.equal(expiresIn(now, now), 'Expired');
  assert.equal(expiresIn(now - 1, now), 'Expired');
});
