import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pendingBar, statusDot } from './app-page.ts';

test('the pending bar says how many changes wait and offers one button', () => {
  const bar = pendingBar({ count: 3, blocking: 0, waiting: 0 }, 'dashboard');
  assert.equal(bar?.text, '3 changes waiting. Nothing is published until you review them.');
  assert.equal(bar?.action, 'Review and publish');
  assert.equal(bar?.blocking, false);
  assert.equal(
    pendingBar({ count: 1, blocking: 0, waiting: 0 }, 'listing')?.text,
    '1 change waiting. Nothing is published until you review them.',
  );
  assert.equal(
    pendingBar({ count: 120, blocking: 0, waiting: 0 }, 'reviews')?.text.startsWith('99+ changes'),
    true,
  );
});

test('an error that blocks a change is flagged; with only blocking items the count is the blocking ones', () => {
  assert.equal(pendingBar({ count: 2, blocking: 1, waiting: 0 }, 'releases')?.blocking, true);
  assert.equal(
    pendingBar({ count: 0, blocking: 2, waiting: 0 }, 'releases')?.text.startsWith('2 changes'),
    true,
  );
});

test('the bar is hidden with nothing pending, when only the store has to act, and on the pending page', () => {
  assert.equal(pendingBar(null, 'dashboard'), null);
  assert.equal(pendingBar(undefined, 'dashboard'), null);
  assert.equal(pendingBar({ count: 0, blocking: 0, waiting: 0 }, 'dashboard'), null);
  assert.equal(pendingBar({ count: 0, blocking: 0, waiting: 2 }, 'dashboard'), null);
  assert.equal(pendingBar({ count: 3, blocking: 0, waiting: 0 }, 'pending'), null);
});

test('the Status dot: a failed sync warns, all synced is fine, otherwise unknown', () => {
  assert.equal(
    statusDot([
      { lastSyncedAt: 1, lastSyncError: null },
      { lastSyncedAt: 2, lastSyncError: 'rate limited' },
    ]),
    'warn',
  );
  assert.equal(
    statusDot([
      { lastSyncedAt: 1, lastSyncError: null },
      { lastSyncedAt: 2, lastSyncError: '  ' },
    ]),
    'ok',
  );
  assert.equal(statusDot([{ lastSyncedAt: null, lastSyncError: null }]), 'neutral');
  assert.equal(statusDot([]), 'neutral');
});
