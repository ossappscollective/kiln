import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, createApi } from '../api.ts';
import {
  type EasUpdateChannel,
  type EasUpdateInsights,
  type EasUpdateRow,
  type EasUpdateState,
  type RuntimeCheck,
  channelsWithMismatch,
  checkLabel,
  checkTone,
  crashRateText,
  easUpdateErrorText,
  formatBytes,
  formatCount,
  insightLines,
  mappingText,
  parseShare,
  rolloutFailure,
  updateDetail,
  updateSummary,
  updateTitle,
} from './eas-update.ts';

const NOW = Date.parse('2026-11-20T12:00:00Z');

const check = (over: Partial<RuntimeCheck> = {}): RuntimeCheck => ({
  channel: 'production',
  status: 'ok',
  severity: 'none',
  latestUpdate: null,
  latestBuild: null,
  shippedRuntimeVersions: ['1.4.0'],
  message: 'The newest update matches the newest store build.',
  ...over,
});

const channel = (over: Partial<EasUpdateChannel> = {}): EasUpdateChannel => ({
  id: 'c1',
  name: 'production',
  isPaused: false,
  isProtected: false,
  updatedAt: null,
  mapping: { kind: 'branch', entries: [{ branchId: 'b1', branchName: 'main', logic: 'always', condition: null }] },
  branches: [],
  rollouts: [],
  runtimeCheck: check(),
  ...over,
});

const state = (channels: EasUpdateChannel[]): EasUpdateState => ({
  project: { id: 'p', fullName: '@acme/trail-notes' },
  platform: 'ios',
  channels,
  channelsTruncated: false,
  builds: [],
  rolloutWriteEnabled: false,
  readAt: NOW,
});

const row = (over: Partial<EasUpdateRow> = {}): EasUpdateRow => ({
  id: 'u1',
  group: 'g1',
  message: 'Fix the login button',
  createdAt: NOW - 3 * 24 * 3600_000,
  platform: 'ios',
  runtimeVersion: '1.4.0',
  gitCommitHash: '0123456789abcdef',
  isRollBackToEmbedded: false,
  rolloutPercentage: null,
  rolloutControlGroup: null,
  ...over,
});

test('each runtime check has a tone and a label that say it without colour', () => {
  assert.equal(checkTone(check()), 'ok');
  assert.equal(checkTone(check({ status: 'mismatch', severity: 'error' })), 'bad');
  assert.equal(checkTone(check({ status: 'newest_build_unreached', severity: 'warning' })), 'warn');
  assert.equal(checkTone(check({ status: 'no_builds', severity: 'info' })), 'neutral');
  assert.equal(checkLabel('mismatch'), 'Reaches no shipped build');
  assert.equal(checkLabel('no_builds'), 'No store build');
  assert.equal(checkLabel('unknown'), 'Cannot compare');
});

test('only a mismatch and an unreached newest build are warnings, errors first', () => {
  const s = state([
    channel({ id: 'a', name: 'a', runtimeCheck: check({ status: 'newest_build_unreached', severity: 'warning' }) }),
    channel({ id: 'b', name: 'b' }),
    channel({ id: 'c', name: 'c', runtimeCheck: check({ status: 'mismatch', severity: 'error' }) }),
    channel({ id: 'd', name: 'd', runtimeCheck: check({ status: 'no_updates', severity: 'info' }) }),
  ]);
  assert.deepEqual(channelsWithMismatch(s).map((c) => c.name), ['c', 'a']);
});

test('the collapsed summary says what was read, the warnings and the rollouts', () => {
  assert.equal(updateSummary(null, true), 'Reading from Expo');
  assert.equal(updateSummary(null, false), 'Not read yet');
  assert.equal(updateSummary(state([channel()]), false), '1 channel');
  const busy = state([
    channel({ rollouts: [{ branch: 'next', group: 'g', updateId: 'u', runtimeVersion: null, percentage: 25, controlGroup: null }] }),
    channel({ id: 'x', runtimeCheck: check({ status: 'mismatch', severity: 'error' }) }),
  ]);
  assert.equal(updateSummary(busy, false), '2 channels · 1 warning · 1 rollout');
});

test('a channel says where its clients get updates from', () => {
  assert.equal(mappingText(channel()), 'Every client gets branch main.');
  assert.equal(mappingText(channel({ mapping: { kind: 'none', entries: [] } })), 'Points at no branch: clients get no update.');
  assert.equal(mappingText(channel({ mapping: { kind: 'unreadable', entries: [] } })), 'The branch mapping could not be read.');
  const rollout = channel({
    mapping: {
      kind: 'rollout',
      entries: [
        { branchId: 'n', branchName: 'next', logic: 'conditional', condition: 'rolloutToken hash_lt 0.25' },
        { branchId: 'm', branchName: null, logic: 'always', condition: null },
      ],
    },
  });
  assert.equal(mappingText(rollout), 'Rollout between branches next and another branch (rolloutToken hash_lt 0.25).');
});

test('an update has a title and a detail line', () => {
  assert.equal(updateTitle(row()), 'Fix the login button');
  assert.equal(updateTitle(row({ message: null })), 'No message');
  assert.equal(updateTitle(row({ message: ' ' })), 'No message');
  assert.equal(updateTitle(row({ isRollBackToEmbedded: true, message: null })), 'Roll back to the embedded update');
  assert.equal(updateDetail(row(), NOW), 'runtime 1.4.0 · 3 days ago · 0123456');
  assert.equal(updateDetail(row({ runtimeVersion: null, createdAt: null, gitCommitHash: null }), NOW), 'no runtime version');
});

test('insights are shown as counts, a crash rate and sizes, and what Expo did not report says so', () => {
  const i: EasUpdateInsights = {
    group: 'g',
    platform: 'ios',
    days: 7,
    start: 0,
    end: 1,
    insights: {
      updateId: 'u',
      platform: 'ios',
      launches: 12345,
      failedLaunches: 20,
      crashRatePercent: 0.16,
      uniqueUsers: 900,
      launchAssetCount: 3,
      averagePayloadBytes: 482_113,
    },
  };
  assert.deepEqual(insightLines(i), [
    { label: 'Launches', text: '12,345' },
    { label: 'Failed launches', text: '20' },
    { label: 'Crash rate', text: '0.16%' },
    { label: 'Unique users', text: '900' },
    { label: 'Payload size', text: '471 kB' },
  ]);
  assert.equal(crashRateText(null), 'no launches yet');
  assert.equal(formatBytes(null), 'not reported');
  assert.equal(formatBytes(512), '512 byte');
  assert.equal(formatBytes(5 * 1024 * 1024), '5 MB');
  assert.equal(formatCount(null), 'not reported');
});

test('a new share must be a whole percent above the current one and at most 100', () => {
  assert.deepEqual(parseShare('50', 25), { ok: true, percentage: 50 });
  assert.deepEqual(parseShare(' 100% ', 25), { ok: true, percentage: 100 });
  for (const bad of ['', 'abc', '12.5', '-5', '1000']) assert.equal(parseShare(bad, 25).ok, false, bad);
  const same = parseShare('25', 25);
  assert.equal(same.ok, false);
  assert.match(same.ok ? '' : same.message, /only be raised/);
  assert.equal(parseShare('101', 25).ok, false);
});

const apiError = (code: string, status = 409, body: Record<string, unknown> = {}) => new ApiError(status, code, 'generic', undefined, body);

test('a failed preview or apply says what happened and whether the outcome is known', () => {
  assert.equal(rolloutFailure(apiError('state_changed')).kind, 'changed');
  assert.equal(rolloutFailure(apiError('rollout_not_found')).kind, 'changed');
  assert.equal(rolloutFailure(apiError('outcome_unknown')).kind, 'unknown');
  assert.equal(rolloutFailure(apiError('eas_update_write_disabled')).kind, 'off');
  assert.match(rolloutFailure(apiError('write_failed', 502)).message, /as before/);
  assert.equal(rolloutFailure(new Error('x')).kind, 'other');
});

test('errors of the reads have a fixed sentence per code', () => {
  assert.match(easUpdateErrorText(apiError('expo_not_linked')), /not linked/);
  assert.match(easUpdateErrorText(apiError('platform_unsupported', 422)), /no updates for this platform/);
  assert.match(easUpdateErrorText(apiError('rate_limited', 429)), /Try again in 1 minute/);
  assert.equal(easUpdateErrorText(apiError('expo_forbidden', 422, { message: 'Use a robot user.' })), 'Use a robot user.');
  assert.match(easUpdateErrorText(apiError('boom', 500)), /server had a problem/);
  assert.equal(easUpdateErrorText('nope'), 'Something went wrong. Try again.');
});

test('the API client sends the four EAS Update calls with the grant header on apply only', async () => {
  const seen: { method: string; url: string; headers: Record<string, string>; body: string | undefined }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    seen.push({
      method: String(init?.method),
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const api = createApi({ fetch: fakeFetch });
  await api.easUpdates('w', 'a b');
  await api.easUpdateInsights('w', 'a', 'g1', 14);
  await api.easUpdateRolloutPreview('w', 'a', { group: 'g1', percentage: 50 });
  await api.easUpdateRolloutApply('w', 'a', { group: 'g1', percentage: 50, confirmHash: 'h' }, 'sug_x');
  assert.deepEqual(seen.map((s) => `${s.method} ${s.url.replace(/^.*\/api/, '/api')}`), [
    'GET /api/workspaces/w/apps/a%20b/expo/updates',
    'GET /api/workspaces/w/apps/a/expo/updates/g1/insights?days=14',
    'POST /api/workspaces/w/apps/a/expo/updates/rollout/preview',
    'POST /api/workspaces/w/apps/a/expo/updates/rollout/apply',
  ]);
  const grant = (h: Record<string, string>) => Object.keys(h).filter((k) => k.toLowerCase() === 'x-step-up-grant').length;
  assert.equal(grant(seen[2]?.headers ?? {}), 0);
  assert.equal(grant(seen[3]?.headers ?? {}), 1);
  assert.equal(JSON.parse(seen[3]?.body ?? '{}').confirmHash, 'h');
});
