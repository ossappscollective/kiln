import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pendingBar, pendingPlacement, statusDot } from './app-page.ts';

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

test('announcePublished sends one window event with the app id, and is false without a window', async () => {
  const { announcePublished, PUBLISHED_EVENT } = await import('./app-page.ts');
  const seen: { type: string; appId?: string }[] = [];
  const target = new EventTarget();
  target.addEventListener(PUBLISHED_EVENT, (e) =>
    seen.push({ type: e.type, appId: (e as CustomEvent<{ appId: string }>).detail.appId }),
  );
  assert.equal(announcePublished('app-1', target), true);
  assert.deepEqual(seen, [{ type: 'kiln:published', appId: 'app-1' }]);
  assert.equal(announcePublished('app-1', null), false);
});

test('the bar names the platform the changes wait on when the page shows another one', () => {
  const line = { count: 1, blocking: 0, waiting: 0 };
  assert.equal(
    pendingBar(line, 'releases', 'iOS')?.text,
    '1 change waiting on iOS. Nothing is published until you review them.',
  );
  assert.equal(pendingBar(null, 'releases', 'iOS'), null);
});

test('the pending bar has a one-line link for the Next step card', () => {
  assert.equal(
    pendingBar({ count: 2, blocking: 0, waiting: 0 }, 'dashboard')?.link,
    '2 changes waiting. Review and publish',
  );
  assert.equal(
    pendingBar({ count: 1, blocking: 0, waiting: 0 }, 'dashboard', 'iOS')?.link,
    '1 change waiting on iOS. Review and publish',
  );
});

test('on the Overview the changes are a link in the Next step card; a blocking error and every other page keep the bar', () => {
  const calm = pendingBar({ count: 2, blocking: 0, waiting: 0 }, 'dashboard');
  assert.deepEqual(pendingPlacement(calm, 'dashboard'), {
    bar: null,
    link: '2 changes waiting. Review and publish',
  });
  assert.equal(pendingPlacement(calm, 'releases').bar, calm);
  assert.equal(pendingPlacement(calm, 'releases').link, null);
  const blocked = pendingBar({ count: 2, blocking: 1, waiting: 0 }, 'dashboard');
  assert.equal(pendingPlacement(blocked, 'dashboard').bar, blocked);
  assert.equal(pendingPlacement(blocked, 'dashboard').link, null);
  assert.deepEqual(pendingPlacement(null, 'dashboard'), { bar: null, link: null });
});

test('after a create or publish the page goes to the releases, but never closes an open Prepare release', async () => {
  const { addressAfterPublished } = await import('./app-page.ts');
  const releases = '#/apps/a1/releases';
  assert.equal(addressAfterPublished('#/apps/a1/releases?step=build', releases), null);
  assert.equal(
    addressAfterPublished('#/apps/a1/releases?platform=ios&step=confirm', releases),
    null,
  );
  assert.equal(addressAfterPublished('#/apps/a1/listing', releases), releases);
  assert.equal(addressAfterPublished('#/apps/a1/releases', releases), releases);
});

test('regression: the stepper is not closed by the app page when CreateVersion announces', async () => {
  const { readFileSync } = await import('node:fs');
  const shell = readFileSync(new URL('../components/app/AppShell.svelte', import.meta.url), 'utf8');
  assert.match(shell, /addressAfterPublished\(window\.location\.hash/);
  assert.doesNotMatch(shell, /window\.location\.hash = appAddress\(/);
});
