import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STEP_UP_VALIDITY, confirmSentence, enrollChoiceHint, otherWayLabel, waysPhrase } from './auth-copy.ts';

test('the ways are named in a stable order, joined with commas and "or"', () => {
  assert.equal(waysPhrase(['password', 'passkey'], true), 'your passkey or your password');
  assert.equal(
    waysPhrase(['recovery', 'totp', 'password'], true),
    'your password, an authenticator code or a recovery code',
  );
  assert.equal(waysPhrase(['email'], true), 'an emailed code');
});

test('a passkey is not offered in a window that cannot use one', () => {
  assert.equal(waysPhrase(['passkey', 'password'], false), 'your password');
  assert.equal(waysPhrase(['passkey'], false), '');
});

test('the confirm sentence is one sentence and never promises a way that is not there', () => {
  assert.equal(confirmSentence(['passkey', 'password'], true), 'Use your passkey or your password to confirm this one action.');
  assert.equal(confirmSentence(['passkey'], false), 'This action needs to be confirmed again.');
  assert.equal(confirmSentence([], true), 'This action needs to be confirmed again.');
  assert.ok(!STEP_UP_VALIDITY.includes('\n'));
});

test('every second step has a link label and a one sentence hint', () => {
  for (const method of ['totp', 'email', 'recovery'] as const) {
    assert.ok(otherWayLabel(method).length > 0);
    assert.ok(enrollChoiceHint(method).endsWith('.'));
    assert.ok(!enrollChoiceHint(method).includes('. '), 'one sentence');
  }
  assert.equal(otherWayLabel('recovery'), 'Use a recovery code');
});
