import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, createApi } from '../api.ts';
import { applyFilters, defaultFilters, downloadBlocker, installGuide, kindLabel, rowsOf } from '../builds.ts';
import {
  type EasBuildView,
  type EasStatusView,
  type EasSubmissionView,
  easBuildDetail,
  easBuildState,
  easBuildTitle,
  easDistributionLabel,
  easStatusAvailable,
  easStatusErrorText,
  easSubmissionBuild,
  easSubmissionState,
  easSubmissionTarget,
  easSyncLine,
} from './eas-status.ts';

const NOW = 1_900_000_000_000;
const MINUTE = 60_000;

const build = (overrides: Partial<EasBuildView> = {}): EasBuildView => ({
  id: 'b0000000-0000-4000-8000-000000000001',
  platform: 'ios',
  status: 'finished',
  rawStatus: 'FINISHED',
  active: false,
  buildProfile: 'production',
  channel: 'production',
  appVersion: '1.4.0',
  buildNumber: '57',
  buildNumberLabel: 'Build',
  sdkVersion: '52.0.0',
  runtimeVersion: '1.4.0',
  distribution: 'store',
  internal: false,
  simulator: false,
  appIdentifier: 'com.acme.trail',
  gitCommitHash: '0123456789abcdef0123456789abcdef01234567',
  gitCommitMessage: 'Fix the trail map',
  error: null,
  hasArtifact: true,
  artifactExpiresAt: NOW + 10 * 24 * 60 * MINUTE,
  createdAt: NOW - 60 * MINUTE,
  updatedAt: NOW - 50 * MINUTE,
  completedAt: NOW - 50 * MINUTE,
  expoUrl: 'https://expo.dev/accounts/acme/projects/trail-notes/builds/b0000000-0000-4000-8000-000000000001',
  ...overrides,
});

const submission = (overrides: Partial<EasSubmissionView> = {}): EasSubmissionView => ({
  id: 's1',
  platform: 'android',
  status: 'errored',
  rawStatus: 'ERRORED',
  active: false,
  buildId: 'b0000000-0000-4000-8000-000000000001',
  build: { appVersion: '1.4.0', buildNumber: '57', buildNumberLabel: 'Version code' },
  store: { id: 'googleplay', name: 'Google Play Console' },
  identifier: 'com.acme.trail',
  track: 'INTERNAL',
  releaseStatus: 'DRAFT',
  error: { code: 'X', message: 'Refused.' },
  createdAt: NOW,
  completedAt: null,
  expoUrl: 'https://expo.dev/accounts/acme/projects/trail-notes/submissions/s1',
  ...overrides,
});

const status = (overrides: Partial<EasStatusView> = {}): EasStatusView => ({
  project: { fullName: '@acme/trail-notes', projectId: 'p', url: 'https://expo.dev/accounts/acme/projects/trail-notes', credentialAvailable: true },
  supported: true,
  builds: [build()],
  submissions: [],
  active: false,
  sync: { readAt: NOW - 5 * MINUTE, lastAttemptAt: NOW - 5 * MINUTE, lastError: null, consecutiveFailures: 0, buildsTruncated: false, submissionsTruncated: false },
  ...overrides,
});

test('every Expo status has a word and a tone; an unknown one says what Expo sent', () => {
  const word = (s: string) => easBuildState({ status: s, rawStatus: s.toUpperCase() });
  assert.deepEqual(word('finished'), { label: 'Finished', tone: 'ok' });
  assert.deepEqual(word('errored'), { label: 'Failed', tone: 'bad' });
  assert.deepEqual(word('canceled'), { label: 'Cancelled', tone: 'neutral' });
  assert.equal(word('in_progress').tone, 'info');
  assert.equal(word('in_queue').label, 'In the queue');
  assert.equal(word('new').label, 'Waiting');
  assert.equal(word('pending_cancel').tone, 'warn');
  assert.deepEqual(easBuildState({ status: 'unknown', rawStatus: 'SOMETHING_NEW' }), { label: 'Something new', tone: 'neutral' });
  assert.deepEqual(easBuildState({ status: 'unknown', rawStatus: null }), { label: 'Unknown status', tone: 'neutral' });
  assert.deepEqual(easSubmissionState({ status: 'awaiting_build', rawStatus: 'AWAITING_BUILD' }), { label: 'Waiting for the build', tone: 'info' });
  assert.deepEqual(easSubmissionState({ status: 'finished', rawStatus: 'FINISHED' }), { label: 'Submitted', tone: 'ok' });
  assert.equal(easSubmissionState({ status: 'errored', rawStatus: 'ERRORED' }).tone, 'bad');
});

test('titles and detail lines say what is known and nothing else', () => {
  assert.equal(easBuildTitle(build()), '1.4.0 (57)');
  assert.equal(easBuildTitle(build({ buildNumber: null })), '1.4.0');
  assert.equal(easBuildTitle(build({ appVersion: null })), '(57)');
  assert.equal(easBuildTitle(build({ appVersion: null, buildNumber: null })), 'Build b0000000');
  assert.equal(easBuildDetail(build()), 'Profile production · Channel production · Store distribution · Runtime 1.4.0 · 0123456');
  assert.equal(
    easBuildDetail(build({ buildProfile: null, channel: null, distribution: 'internal', runtimeVersion: null, gitCommitHash: null })),
    'Internal distribution',
  );
  assert.equal(easBuildDetail(build({ buildProfile: null, channel: null, distribution: null, runtimeVersion: null, gitCommitHash: null })), '');
  assert.equal(easDistributionLabel('simulator'), 'Simulator');
  assert.equal(easDistributionLabel('unknown'), '');
  assert.equal(easSubmissionBuild(submission()), '1.4.0 (57)');
  assert.equal(easSubmissionBuild(submission({ build: null })), 'Build b0000000');
  assert.equal(easSubmissionBuild(submission({ build: null, buildId: null })), 'No build named');
  assert.equal(easSubmissionTarget(submission()), 'Google Play Console · com.acme.trail · internal track');
  assert.equal(easSubmissionTarget(submission({ identifier: null, track: null })), 'Google Play Console');
});

test('the build list takes EAS builds as one more source, newest first, with its own filter', () => {
  const list = { artifacts: [], store: [] };
  const rows = rowsOf(
    list,
    [
      build({ id: 'old', createdAt: NOW - 3 * 60 * MINUTE }),
      build({ id: 'new', createdAt: NOW - MINUTE, status: 'errored', rawStatus: 'ERRORED', hasArtifact: false }),
      build({ id: 'gone', createdAt: NOW - 2 * 60 * MINUTE, artifactExpiresAt: NOW - MINUTE }),
    ],
    NOW,
  );
  assert.deepEqual(rows.map((r) => r.key), ['eas:new', 'eas:gone', 'eas:old']);
  assert.ok(rows.every((r) => r.source === 'eas' && r.kind === 'eas' && r.artifact === null && r.store === null));
  assert.equal(kindLabel('eas'), 'EAS');
  const [failed, expired, ok] = rows;
  assert.deepEqual(failed?.state, { label: 'Failed', tone: 'bad' });
  assert.deepEqual(expired?.state, { label: 'Expired', tone: 'bad' });
  assert.equal(expired?.expired, true);
  assert.deepEqual(ok?.state, { label: 'Finished', tone: 'ok' });
  assert.equal(ok?.title, '1.4.0 (57)');
  assert.equal(ok?.platform, 'ios');
  assert.equal(ok?.runUrl, build().expoUrl);
  assert.equal(ok?.at, NOW - 3 * 60 * MINUTE);

  // The source filter and "hide expired" work on them like on the others.
  assert.equal(applyFilters(rows, { ...defaultFilters, source: 'eas' }).length, 2, 'the expired one is hidden by default');
  assert.equal(applyFilters(rows, { ...defaultFilters, source: 'ci' }).length, 0);
  assert.equal(applyFilters(rows, { ...defaultFilters, source: 'eas', hideExpired: false }).length, 3);
  assert.equal(applyFilters(rows, { ...defaultFilters, platform: 'android' }).length, 0);
  // Without EAS builds the list is what it always was.
  assert.deepEqual(rowsOf(list), []);
});

test('an EAS row has no download button, and its guide points at the Expo page', () => {
  const [row] = rowsOf({ artifacts: [], store: [] }, [build({ distribution: 'internal', internal: true, platform: 'android' })], NOW);
  assert.ok(row);
  const blocker = downloadBlocker(row, { downloadEnabled: true, canDownload: true, maxDownloadBytes: 1 });
  assert.equal(blocker, null, 'no artifact: nothing to block, and nothing to offer');
  const guide = installGuide(row);
  assert.equal(guide.title, 'Install an internal distribution build');
  assert.deepEqual(guide.link, { label: 'Open on Expo', href: build().expoUrl });
  assert.equal(guide.downloads, false);
  assert.equal(guide.qr, false);

  const guideOf = (b: Partial<EasBuildView>) => {
    const [r] = rowsOf({ artifacts: [], store: [] }, [build(b)], NOW);
    return installGuide(r as NonNullable<typeof r>);
  };
  assert.equal(guideOf({ distribution: 'store' }).title, 'A build for store distribution');
  assert.equal(guideOf({ distribution: 'simulator', simulator: true }).title, 'An iOS Simulator build');
  assert.equal(guideOf({ status: 'errored', rawStatus: 'ERRORED' }).title, 'This EAS build failed');
  assert.equal(guideOf({ status: 'in_progress', rawStatus: 'IN_PROGRESS' }).title, 'This EAS build has not finished');
  assert.equal(guideOf({ expoUrl: null }).link, null);
  // Whatever the guide says, it promises no download or phone code.
  for (const b of [{ distribution: 'internal', internal: true }, { distribution: 'store' }, { status: 'errored' }]) {
    const g = guideOf(b);
    assert.equal(g.downloads, false);
    assert.equal(g.qr, false);
  }
});

test('the line about the last read says how fresh the data is, what failed, and what is missing', () => {
  assert.deepEqual(easSyncLine(status(), NOW), { tone: 'info', text: 'EAS builds read 5 minutes ago.' });
  assert.equal(easSyncLine(status({ active: true }), NOW)?.text, 'EAS builds read 5 minutes ago; a build is still running, so they are read again every few minutes.');
  const never = status({ sync: { ...status().sync, readAt: null, lastAttemptAt: null } });
  assert.equal(easSyncLine(never, NOW)?.text, 'The EAS builds of this app have not been read yet. Use Read again.');
  const failed = status({ sync: { ...status().sync, lastError: 'expo_auth', consecutiveFailures: 2 } });
  assert.deepEqual(easSyncLine(failed, NOW), { tone: 'warn', text: 'Expo could not be read (expo auth). The builds shown were read 5 minutes ago.' });
  const failedFirst = status({ sync: { ...status().sync, lastError: 'rate_limited', readAt: null } });
  assert.equal(easSyncLine(failedFirst, NOW)?.text, 'Expo could not be read (rate limited).');
  const more = status({ sync: { ...status().sync, buildsTruncated: true } });
  assert.match(easSyncLine(more, NOW)?.text ?? '', /Older builds exist at Expo and are not shown\.$/);
});

test('the card needs a link and a platform EAS builds for', () => {
  assert.equal(easStatusAvailable(null), false);
  assert.equal(easStatusAvailable(status({ project: null })), false);
  assert.equal(easStatusAvailable(status({ supported: false })), false);
  assert.equal(easStatusAvailable(status()), true);
});

test('each error code of the status routes has a sentence, none of them the raw text of Expo', () => {
  const err = (status: number, code: string, body: Record<string, unknown> = {}, retryAfter?: number) =>
    new ApiError(status, code, 'generic', retryAfter, body);
  assert.equal(easStatusErrorText(err(403, 'forbidden')), 'Reading EAS builds needs the member role.');
  assert.match(easStatusErrorText(err(409, 'not_linked')), /not linked to an Expo project/);
  assert.match(easStatusErrorText(err(422, 'platform_unsupported')), /iOS and Android/);
  assert.match(easStatusErrorText(err(422, 'credential_not_found')), /Expo credential/);
  assert.equal(easStatusErrorText(err(422, 'expo_auth', { message: 'Expo did not accept the access token.' })), 'Expo did not accept the access token.');
  assert.match(easStatusErrorText(err(502, 'expo_unavailable')), /Expo could not be asked/);
  assert.match(easStatusErrorText(err(429, 'rate_limited', {}, 90)), /^Too many reads\. Try again in /);
  assert.match(easStatusErrorText(err(504, 'timeout')), /too long/);
  assert.equal(easStatusErrorText(err(500, 'boom')), 'The server had a problem. Try again.');
  assert.equal(easStatusErrorText(new Error('x')), 'Something went wrong. Try again.');
});

test('the api client reads the stored status with GET and asks Expo again with POST, in this workspace and app only', async () => {
  const calls: { method: string; url: string }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({ method: String(init?.method ?? 'GET'), url: String(input) });
    return new Response(JSON.stringify({ status: status() }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const api = createApi({ fetch: fetchFn });
  const read = await api.easStatus('w 1', 'a/1');
  assert.equal(read.status.builds.length, 1);
  await api.refreshEasStatus('w 1', 'a/1');
  assert.deepEqual(calls, [
    { method: 'GET', url: '/api/workspaces/w%201/apps/a%2F1/eas/status' },
    { method: 'POST', url: '/api/workspaces/w%201/apps/a%2F1/eas/status/refresh' },
  ]);
});
