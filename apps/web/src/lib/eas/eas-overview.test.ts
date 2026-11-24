import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expoCardVisible, expoRow, expoRows, latestBuild, latestSubmission, otaSummary } from './eas-overview.ts';
import type { EasBuildView, EasStatusView, EasSubmissionView } from './eas-status.ts';

const build = (id: string, platform: 'ios' | 'android', createdAt: number | null): EasBuildView =>
  ({ id, platform, status: 'finished', createdAt }) as EasBuildView;
const sub = (id: string, platform: 'ios' | 'android', createdAt: number | null): EasSubmissionView =>
  ({ id, platform, status: 'finished', createdAt }) as EasSubmissionView;
const view = (over: Partial<EasStatusView>): EasStatusView =>
  ({
    project: { fullName: '@a/b', projectId: 'p', url: 'u', credentialAvailable: true },
    supported: true,
    builds: [],
    submissions: [],
    active: false,
    sync: { readAt: 5, lastAttemptAt: 5, lastError: null, consecutiveFailures: 0, buildsTruncated: false, submissionsTruncated: false },
    ...over,
  }) as EasStatusView;

test('the latest build and submission are the newest of the platform, whatever the order', () => {
  const builds = [build('a', 'ios', 10), build('b', 'ios', 30), build('c', 'android', 99), build('d', 'ios', null)];
  assert.equal(latestBuild(builds, 'ios')?.id, 'b');
  assert.equal(latestBuild(builds, 'android')?.id, 'c');
  assert.equal(latestSubmission([sub('x', 'ios', 1), sub('y', 'ios', 2)], 'ios')?.id, 'y');
  assert.equal(latestSubmission([], 'ios'), null);
});

test('row states: loading, unreadable, not linked, no builds yet, ready', () => {
  const app = { id: 'a1', platform: 'ios' as const };
  assert.equal(expoRow(app, undefined).state, 'loading');
  assert.equal(expoRow(app, null).state, 'unavailable');
  assert.equal(expoRow(app, view({ project: null })).state, 'not_linked');
  assert.equal(expoRow(app, view({})).state, 'no_builds');
  const ready = expoRow(app, view({ builds: [build('b', 'ios', 1)], submissions: [sub('s', 'ios', 2)] }));
  assert.equal(ready.state, 'ready');
  assert.equal(ready.build?.id, 'b');
  assert.equal(ready.submission?.id, 's');
  assert.equal(ready.readAt, 5);
});

test('a submission without a build still makes a ready row; macOS has no row', () => {
  const only = expoRow({ id: 'a', platform: 'android' }, view({ submissions: [sub('s', 'android', 2)] }));
  assert.equal(only.state, 'ready');
  assert.equal(only.build, null);
  const rows = expoRows(
    [{ id: 'm', platform: 'macos' }, { id: 'i', platform: 'ios' }],
    { m: view({}), i: view({}) },
  );
  assert.deepEqual(rows.map((r) => r.appId), ['i']);
});

test('the card is hidden without rows or when no row could be read', () => {
  assert.equal(expoCardVisible([]), false);
  assert.equal(expoCardVisible(expoRows([{ id: 'i', platform: 'ios' }], { i: null })), false);
  assert.equal(expoCardVisible(expoRows([{ id: 'i', platform: 'ios' }], { i: view({ project: null }) })), true);
});

test('the current update per channel comes from the stored read: sorted by name, empty and failed states are honest', () => {
  const up = (channel: string, current: boolean) => ({ channel, current: current ? { id: channel, channel, platform: 'ios', rolloutPercentage: null } : null, rollouts: [] });
  const ready = otaSummary(view({ updates: { readAt: 9, lastError: null, channels: [up('staging', true), up('production', true), up('empty', false)] } } as never));
  assert.equal(ready.state, 'ready');
  assert.deepEqual(ready.channels.map((c) => c.channel), ['production', 'staging']);
  assert.equal(ready.readAt, 9);
  assert.equal(ready.failed, false);
  const never = otaSummary(view({ updates: { readAt: null, lastError: null, channels: [] } } as never));
  assert.deepEqual([never.state, never.readAt, never.failed], ['none', null, false]);
  const failed = otaSummary(view({ updates: { readAt: 4, lastError: 'expo_auth', channels: [up('production', true)] } } as never));
  assert.deepEqual([failed.state, failed.failed], ['ready', true]);
  assert.equal(otaSummary(view({})).state, 'none', 'a status without updates reads as none');
  // The row carries it, also when there are no builds yet.
  const row = expoRow({ id: 'a1', platform: 'ios' }, view({ updates: { readAt: 9, lastError: null, channels: [up('production', true)] } } as never));
  assert.equal(row.state, 'no_builds');
  assert.equal(row.ota?.channels.length, 1);
  assert.equal(expoRow({ id: 'a1', platform: 'ios' }, view({ project: null })).ota, null);
});
