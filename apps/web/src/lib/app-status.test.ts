import assert from 'node:assert/strict';
import { test } from 'node:test';
import { platformStatusLines } from './app-status.ts';
import type { ReleaseSummary } from './types.ts';

const rel = (over: Partial<ReleaseSummary>): ReleaseSummary => ({
  id: 'r',
  appId: 'a',
  platform: 'ios',
  version: '1.0.0',
  track: null,
  build: null,
  status: 'live',
  rawState: 'READY_FOR_SALE',
  rolloutFraction: null,
  versionCodes: null,
  storeUpdatedAt: null,
  syncedAt: 0,
  ...over,
});

const ios = { id: 'i', platform: 'ios' as const, lastSyncedAt: 1 };
const android = { id: 'a', platform: 'android' as const, lastSyncedAt: 1 };

test('one line per platform, iOS before Android, each with its state and version', () => {
  const lines = platformStatusLines([android, ios], {
    i: [rel({ id: 'i1', appId: 'i', version: '2.9.0', status: 'in_review' })],
    a: [rel({ id: 'a1', appId: 'a', platform: 'android', version: '2.8.1', status: 'live' })],
  });
  assert.deepEqual(
    lines.map((l) => [l.platform, l.label, l.version, l.tone]),
    [
      ['ios', 'In review', '2.9.0', 'info'],
      ['android', 'Live', '2.8.1', 'ok'],
    ],
  );
  assert.equal(lines[0]?.text, 'In review, version 2.9.0');
});

test('a rejected release is a bad tone; the newest version of the platform is the one shown', () => {
  const lines = platformStatusLines([ios], {
    i: [
      rel({ id: 'old', appId: 'i', version: '2.0.0', status: 'live' }),
      rel({ id: 'new', appId: 'i', version: '2.1.0', status: 'rejected' }),
    ],
  });
  assert.equal(lines[0]?.label, 'Rejected');
  assert.equal(lines[0]?.version, '2.1.0');
  assert.equal(lines[0]?.tone, 'bad');
});

test('no release, never synced and not loaded yet say so quietly', () => {
  const lines = platformStatusLines(
    [ios, android, { id: 'm', platform: 'macos', lastSyncedAt: null }],
    { i: [], m: [] },
  );
  assert.deepEqual(
    lines.map((l) => [l.platform, l.label, l.version]),
    [
      ['ios', 'No release yet', null],
      ['macos', 'Not synced yet', null],
      ['android', 'Reading', null],
    ],
  );
});
