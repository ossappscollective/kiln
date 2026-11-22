import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CredentialGuide } from '@kiln/core';
import { ApiError } from './api.ts';
import {
  announceTest,
  formatCheckedOn,
  guideSections,
  isWebUrl,
  summarizeTest,
  testErrorMessage,
  testStatus,
} from './credentials.ts';

const now = Date.UTC(2026, 10, 18, 12, 0, 0);

test('a credential that was never tested says so', () => {
  const status = testStatus(null, now);
  assert.equal(status.state, 'untested');
  assert.equal(status.label, 'Never tested');
  assert.equal(status.tone, 'none');
  assert.equal(status.when, '');
  assert.equal(testStatus(undefined, now).state, 'untested');
});

test('a passing test is Working with a relative time', () => {
  const status = testStatus({ at: now - 5 * 60_000, ok: true, message: 'Connected.' }, now);
  assert.equal(status.state, 'working');
  assert.equal(status.label, 'Working');
  assert.equal(status.tone, 'ok');
  assert.equal(status.when, '5 minutes ago');
  assert.match(status.title, /^Working, tested .*\. Connected\.$/);
});

test('a failing test is Failed and carries the message in the tooltip', () => {
  const status = testStatus(
    { at: now - 3 * 3_600_000, ok: false, message: 'The key was rejected.' },
    now,
  );
  assert.equal(status.state, 'failed');
  assert.equal(status.tone, 'bad');
  assert.equal(status.when, '3 hours ago');
  assert.match(status.title, /The key was rejected\.$/);
});

test('a result is trimmed, deduplicated and given a message when the provider sent none', () => {
  const summary = summarizeTest({
    ok: true,
    message: '  Connected.  ',
    details: [' Key valid ', 'Key valid', '', '   ', 'Access to 3 apps'],
  });
  assert.deepEqual(summary, {
    ok: true,
    tone: 'ok',
    message: 'Connected.',
    details: ['Key valid', 'Access to 3 apps'],
  });
  assert.equal(summarizeTest({ ok: false, message: '' }).message, 'The test failed.');
  assert.equal(summarizeTest({ ok: true, message: ' ' }).message, 'The connection works.');
  assert.deepEqual(summarizeTest({ ok: false, message: 'x' }).details, []);
});

test('a result with very long or too many details is capped', () => {
  const many = Array.from({ length: 50 }, (_, i) => `line ${i}`);
  assert.equal(summarizeTest({ ok: true, message: 'ok', details: many }).details.length, 20);
  const long = summarizeTest({ ok: false, message: 'm'.repeat(1000) });
  assert.equal(long.message.length, 300);
  assert.ok(long.message.endsWith('…'));
});

test('a malformed details field does not throw', () => {
  const odd = { ok: true, message: 'ok', details: 'nope' } as unknown as Parameters<
    typeof summarizeTest
  >[0];
  assert.deepEqual(summarizeTest(odd).details, []);
});

test('errors become sentences; API errors keep their own wording', () => {
  assert.equal(
    testErrorMessage(
      new ApiError(429, 'rate_limited', 'Too many requests. Try again in 30 seconds.', 30),
    ),
    'Too many requests. Try again in 30 seconds.',
  );
  assert.equal(
    testErrorMessage(
      new ApiError(0, 'network', 'Cannot reach the server. Check that it is running.'),
    ),
    'Cannot reach the server. Check that it is running.',
  );
  assert.equal(testErrorMessage(new Error('boom')), 'Could not run the test. Try again.');
});

test('screen reader announcements name the credential and the outcome', () => {
  assert.equal(
    announceTest('Acme key', { ok: true, message: 'Connected.' }),
    'Acme key: test passed. Connected.',
  );
  assert.equal(
    announceTest('Acme key', { ok: false, message: 'Rejected.' }),
    'Acme key: test failed. Rejected.',
  );
});

const draft: CredentialGuide = {
  summary: 's',
  prerequisites: [],
  steps: [],
  permissions: [],
  troubleshooting: [],
  links: [],
  checkedOn: '',
};

test('a draft guide has no sections to show', () => {
  assert.deepEqual(guideSections(draft), {
    prerequisites: false,
    steps: false,
    permissions: false,
    troubleshooting: false,
    links: false,
  });
});

test('a filled-in guide shows the sections that have content', () => {
  const sections = guideSections({
    ...draft,
    steps: [{ title: 'Open', body: 'b' }],
    troubleshooting: [{ problem: 'p', fix: 'f' }],
  });
  assert.equal(sections.steps, true);
  assert.equal(sections.troubleshooting, true);
  assert.equal(sections.prerequisites, false);
});

test('the checked date is formatted without shifting by time zone, and bad dates are ignored', () => {
  assert.equal(formatCheckedOn('2026-11-18'), 'November 18, 2026');
  assert.equal(formatCheckedOn('2026-01-01'), 'January 1, 2026');
  assert.equal(formatCheckedOn(''), '');
  assert.equal(formatCheckedOn('2026-13-40'), '');
  assert.equal(formatCheckedOn('2026-02-31'), '');
  assert.equal(formatCheckedOn('November 2026'), '');
});

test('only web addresses count as links', () => {
  assert.equal(isWebUrl('https://developer.apple.com/documentation'), true);
  assert.equal(isWebUrl('http://example.com'), true);
  assert.equal(isWebUrl('javascript:alert(1)'), false);
  assert.equal(isWebUrl('data:text/html,hi'), false);
  assert.equal(isWebUrl('not a url'), false);
  assert.equal(isWebUrl(''), false);
});
