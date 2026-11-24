import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchBuild, matchOta, matchRelease, matchSubmission, releaseSteps } from './eas-release.ts';
import type { EasBuildView, EasStatusView, EasSubmissionView, EasUpdateView } from './eas-status.ts';

let n = 0;
const build = (over: Partial<EasBuildView>): EasBuildView =>
  ({
    id: `b${++n}`, platform: 'ios', status: 'finished', active: false, appVersion: '1.4.0', buildNumber: '57', distribution: 'store',
    internal: false, simulator: false, createdAt: 100 + n, completedAt: 200 + n, ...over,
  }) as EasBuildView;
const sub = (over: Partial<EasSubmissionView>): EasSubmissionView =>
  ({ id: `s${++n}`, platform: 'ios', status: 'finished', buildId: 'b1', createdAt: 300 + n, completedAt: 400 + n, ...over }) as EasSubmissionView;
const release = (over: Record<string, unknown> = {}) =>
  ({ platform: 'ios', version: '1.4.0', build: '57', versionCodes: null, status: 'in_review', ...over }) as never;
const snapshot = (builds: EasBuildView[], submissions: EasSubmissionView[] = []): EasStatusView =>
  ({ project: { fullName: '@a/b', projectId: 'p', url: 'u', credentialAvailable: true }, supported: true, builds, submissions, active: false }) as EasStatusView;

test('matches by platform, version and build number; another version or number is no match', () => {
  const a = build({ id: 'a' });
  assert.equal(matchBuild(release(), [a])?.id, 'a');
  assert.equal(matchBuild(release({ version: '1.5.0' }), [a]), null);
  assert.equal(matchBuild(release({ build: '58' }), [a]), null);
  assert.equal(matchBuild(release(), [build({ platform: 'android' })]), null);
  assert.equal(matchBuild(release(), [build({ appVersion: null })]), null);
});

test('internal and simulator builds are never the store build', () => {
  assert.equal(matchBuild(release(), [build({ distribution: 'internal', internal: true })]), null);
  assert.equal(matchBuild(release(), [build({ simulator: true })]), null);
});

test('a finished build wins over an errored retry of the same number; newest of equals', () => {
  const failed = build({ id: 'f', status: 'errored', createdAt: 900 });
  const ok1 = build({ id: 'o1', createdAt: 100 });
  const ok2 = build({ id: 'o2', createdAt: 200 });
  assert.equal(matchBuild(release(), [failed, ok1, ok2])?.id, 'o2');
  assert.equal(matchBuild(release(), [failed])?.id, 'f');
});

test('Google Play: one of the version codes names the build', () => {
  const a = build({ id: 'g', platform: 'android', buildNumber: '212' });
  const r = release({ platform: 'android', build: null, versionCodes: ['211', '212'] });
  assert.equal(matchBuild(r, [a])?.id, 'g');
  assert.equal(matchBuild(release({ platform: 'android', build: null, versionCodes: ['300'] }), [a]), null);
});

test('without a number in the release: one build number is certain, two are not', () => {
  const r = release({ build: null });
  assert.equal(matchBuild(r, [build({ id: 'x' }), build({ id: 'y' })])?.id, 'y');
  assert.equal(matchBuild(r, [build({ buildNumber: '57' }), build({ buildNumber: '58' })]), null);
  assert.equal(matchBuild(r, [build({ buildNumber: null })]), null);
});

test('the submission is the one of the build id, never of the version alone', () => {
  const b = build({ id: 'b1' });
  assert.equal(matchSubmission(b, [sub({ buildId: 'other' })]), null);
  const failed = sub({ id: 'sf', buildId: 'b1', status: 'errored', createdAt: 900 });
  const ok = sub({ id: 'so', buildId: 'b1', createdAt: 500 });
  assert.equal(matchSubmission(b, [failed, ok])?.id, 'so');
  assert.equal(matchSubmission(b, [failed])?.id, 'sf');
  assert.equal(matchSubmission(b, [sub({ buildId: 'b1', platform: 'android' })]), null);
});

test('steps: built, submitted from the submission, review from the store state of the release', () => {
  const b = build({ id: 'b1' });
  const states = (status: string | null, s: EasSubmissionView | null, bb = b) =>
    releaseSteps({ status } as never, bb, s).map((x) => x.state);
  assert.deepEqual(states('in_review', sub({})), ['done', 'done', 'current']);
  assert.deepEqual(states('live', sub({})), ['done', 'done', 'done']);
  assert.deepEqual(states('rejected', sub({})), ['done', 'done', 'failed']);
  assert.deepEqual(states(null, null), ['done', 'todo', 'todo']);
  assert.deepEqual(states(null, sub({ status: 'in_progress' })), ['done', 'current', 'todo']);
  assert.deepEqual(states(null, sub({ status: 'errored' })), ['done', 'failed', 'todo']);
  assert.deepEqual(states(null, null, build({ status: 'in_progress', active: true })), ['current', 'todo', 'todo']);
  assert.deepEqual(states(null, null, build({ status: 'errored' })), ['failed', 'todo', 'todo']);
});

test('matchRelease: nothing for an app that is not linked, an unsupported platform or no confident build', () => {
  const b = build({ id: 'b1' });
  assert.equal(matchRelease(release(), null), null);
  assert.equal(matchRelease(release(), { ...snapshot([b]), project: null }), null);
  assert.equal(matchRelease(release({ platform: 'macos' }), snapshot([b])), null);
  assert.equal(matchRelease(release({ version: '9.9.9' }), snapshot([b])), null);
  const m = matchRelease(release(), snapshot([b], [sub({ buildId: 'b1' })]));
  assert.equal(m?.build.id, 'b1');
  assert.equal(m?.steps.length, 3);
});

const update = (over: Partial<EasUpdateView> = {}): EasUpdateView =>
  ({ id: 'u1', group: 'g1', platform: 'ios', channel: 'production', branch: 'main', runtimeVersion: '1.4.0', message: 'Fix', createdAt: 500, rolloutPercentage: null, rolloutSince: null, expoUrl: 'https://expo.dev/x', ...over }) as EasUpdateView;
const withUpdates = (s: EasStatusView, current: EasUpdateView | null, channel = 'production'): EasStatusView =>
  ({ ...s, updates: { readAt: 5, lastError: null, channels: [{ channel, current, rollouts: [] }] } }) as EasStatusView;

test('OTA: only the current update of the build channel with exactly the build runtime version shows; anything else shows nothing', () => {
  const b = build({ id: 'a', channel: 'production', runtimeVersion: '1.4.0' });
  const base = snapshot([b]);
  assert.equal(matchOta(b, withUpdates(base, update()))?.id, 'u1');
  assert.equal(matchRelease(release(), withUpdates(base, update()))?.ota?.group, 'g1');
  // Another runtime version, platform or channel; a build without a channel or runtime; nothing stored; a status from before updates were stored.
  assert.equal(matchOta(b, withUpdates(base, update({ runtimeVersion: '1.5.0' }))), null);
  assert.equal(matchOta(b, withUpdates(base, update({ platform: 'android' }))), null);
  assert.equal(matchOta(b, withUpdates(base, update(), 'staging')), null);
  assert.equal(matchOta(build({ channel: null, runtimeVersion: '1.4.0' }), withUpdates(base, update())), null);
  assert.equal(matchOta(build({ channel: 'production', runtimeVersion: null }), withUpdates(base, update())), null);
  assert.equal(matchOta(b, withUpdates(base, null)), null);
  assert.equal(matchOta(b, base), null);
  assert.equal(matchRelease(release(), base)?.ota, null);
});
