import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ArtifactItem,
  type BuildsList,
  type StoreBuildItem,
  DOWNLOADS_OFF_TEXT,
  NO_RIGHT_TEXT,
  applyFilters,
  artifactRow,
  buildNumberOfTitle,
  defaultFilters,
  downloadBlocker,
  downloadPath,
  expiryText,
  hiddenBy,
  humanSize,
  installGuide,
  phoneCannotReach,
  phoneUrl,
  problemNotice,
  rowsOf,
  secondsLeft,
  storeRow,
  testBuildsHref,
} from './builds.ts';

const DAY = 24 * 60 * 60_000;
const NOW = 1_900_000_000_000;

const artifact = (over: Partial<ArtifactItem> = {}): ArtifactItem => ({
  id: '1', name: 'ios-build', kind: 'zip', guessed: true, platform: 'ios', sizeBytes: 12 * 1024 * 1024, expired: false,
  createdAt: NOW - DAY, expiresAt: NOW + 30 * DAY, downloadable: true, tooLarge: false,
  run: { id: '101', number: 7, workflow: 'iOS release', title: null, branch: 'main', shortSha: 'abc1234', status: 'completed', conclusion: 'success', url: 'https://github.com/acme/app/actions/runs/101' },
  ...over,
});
const store = (over: Partial<StoreBuildItem> = {}): StoreBuildItem => ({
  platform: 'ios', buildNumber: '240', version: '2.4.0', state: 'processed', rawState: 'VALID', expired: false, uploadedAt: NOW - 2 * DAY,
  expiresAt: NOW + 88 * DAY, expiresAtEstimated: true, channel: 'testflight', tracks: [], releaseStatus: null, optInUrl: null, runId: null, ...over,
});
const list = (over: Partial<BuildsList> = {}): BuildsList => ({
  app: { id: 'a', name: 'Acme', platform: 'ios', identifier: 'com.acme' }, repository: { id: 'r', owner: 'acme', repo: 'app' },
  artifacts: [], hiddenArtifacts: 0, truncated: false, store: [], problem: null, downloadEnabled: true, maxDownloadBytes: 500 * 1024 * 1024,
  canDownload: true, readAt: NOW, cached: false, ...over,
});

test('rows: CI artifacts and store builds together, newest first, undated last', () => {
  const rows = rowsOf(list({ artifacts: [artifact({ id: '2', createdAt: NOW - 5 * DAY }), artifact({ id: '1' })], store: [store(), store({ buildNumber: '1', uploadedAt: null })] }));
  assert.deepEqual(rows.map((r) => r.key), ['ci:1', 'store:ios:240', 'ci:2', 'store:ios:1']);
  const [ci, tf] = rows;
  assert.equal(ci?.detail, 'iOS release #7 · main · abc1234');
  assert.equal(ci?.runUrl, 'https://github.com/acme/app/actions/runs/101');
  assert.equal(tf?.title, '2.4.0 (240)');
  assert.equal(tf?.detail, 'TestFlight');
  assert.deepEqual(tf?.state, { label: 'Ready to test', tone: 'ok' });
});

test('states are words, not only colours', () => {
  assert.equal(artifactRow(artifact({ expired: true })).state.label, 'Expired');
  assert.equal(artifactRow(artifact({ tooLarge: true })).state.label, 'Too large to download');
  assert.equal(artifactRow(artifact({ run: { ...artifact().run, conclusion: 'failure' } })).state.label, 'Run failure');
  assert.equal(storeRow(store({ state: 'processing' })).state.label, 'Processing');
  assert.equal(storeRow(store({ expired: true })).state.label, 'Expired');
  assert.equal(storeRow(store({ channel: 'play', tracks: ['internal'], buildNumber: '7' })).detail, 'Track internal');
});

test('filters: platform, source, hide expired and hide reports', () => {
  const rows = rowsOf(list({
    artifacts: [artifact({ id: '1' }), artifact({ id: '2', expired: true }), artifact({ id: '3', kind: 'other' }), artifact({ id: '4', kind: 'apk', platform: 'android' })],
    store: [store()],
  }));
  assert.deepEqual(applyFilters(rows, defaultFilters).map((r) => r.key).sort(), ['ci:1', 'ci:4', 'store:ios:240']);
  assert.equal(hiddenBy(rows, defaultFilters), 2);
  assert.deepEqual(applyFilters(rows, { ...defaultFilters, platform: 'android' }).map((r) => r.key), ['ci:4']);
  assert.deepEqual(applyFilters(rows, { ...defaultFilters, source: 'store' }).map((r) => r.key), ['store:ios:240']);
  assert.equal(applyFilters(rows, { platform: 'all', source: 'all', hideExpired: false, hideOther: false }).length, 5);
});

test('sizes and expiry in plain words', () => {
  assert.equal(humanSize(null), '');
  assert.equal(humanSize(512), '512 B');
  assert.equal(humanSize(1536), '1.5 KB');
  assert.equal(humanSize(12 * 1024 * 1024), '12 MB');
  assert.equal(humanSize(500 * 1024 * 1024), '500 MB');
  assert.equal(humanSize(2.5 * 1024 ** 3), '2.5 GB');
  assert.equal(expiryText(artifactRow(artifact()), NOW), 'expires in 30 days');
  assert.equal(expiryText(artifactRow(artifact({ expiresAt: NOW + DAY })), NOW), 'expires in 1 day');
  assert.equal(expiryText(artifactRow(artifact({ expiresAt: NOW + 1000 })), NOW), 'expires today');
  assert.equal(expiryText(artifactRow(artifact({ expired: true, expiresAt: NOW - 3 * DAY })), NOW), 'expired 3 days ago');
  assert.equal(expiryText(storeRow(store()), NOW), 'expires about in 88 days');
  assert.equal(expiryText(artifactRow(artifact({ expiresAt: null })), NOW), '');
});

test('install guidance: honest by kind', () => {
  const g = (kind: ArtifactItem['kind'], platform: ArtifactItem['platform'] = 'android') => installGuide(artifactRow(artifact({ kind, platform })));
  assert.equal(g('apk').qr, true);
  assert.match(g('apk').steps.join(' '), /adb install/);
  assert.equal(g('aab').qr, false);
  assert.match(g('aab').steps.join(' '), /bundletool build-apks/);
  assert.equal(g('ipa', 'ios').qr, false);
  assert.match(g('ipa', 'ios').steps.join(' '), /UDID|provisioning profile/);
  assert.match(g('ipa', 'ios').caution ?? '', /not offered/);
  assert.match(g('dmg', 'macos').steps.join(' '), /Gatekeeper/);
  assert.equal(g('zip', 'android').qr, true);
  assert.equal(g('zip', 'ios').qr, false);
  assert.equal(g('other', null).downloads, true);
  const tf = installGuide(storeRow(store()));
  assert.equal(tf.downloads, false);
  assert.match(tf.steps.join(' '), /TestFlight app/);
  assert.match(installGuide(storeRow(store({ state: 'processing' }))).caution ?? '', /still processing/);
  const play = installGuide(storeRow(store({ channel: 'play', tracks: ['beta'], optInUrl: 'https://play.google.com/apps/testing/com.acme' })));
  assert.equal(play.link?.href, 'https://play.google.com/apps/testing/com.acme');
  assert.equal(installGuide(storeRow(store({ channel: 'play', tracks: ['internal'] }))).link, null);
});

test('no download button without the switch, the right, a live artifact or room under the limit; the reason is a sentence', () => {
  const row = artifactRow(artifact());
  assert.equal(downloadBlocker(row, list()), null);
  assert.equal(downloadBlocker(row, list({ downloadEnabled: false })), DOWNLOADS_OFF_TEXT);
  assert.match(DOWNLOADS_OFF_TEXT, /MRM_BUILDS_DOWNLOAD_ENABLED/);
  assert.match(DOWNLOADS_OFF_TEXT, /Actions: read/);
  assert.equal(downloadBlocker(row, list({ canDownload: false })), NO_RIGHT_TEXT);
  assert.match(downloadBlocker(artifactRow(artifact({ expired: true })), list()) ?? '', /no longer keeps/);
  assert.match(downloadBlocker(artifactRow(artifact({ tooLarge: true })), list()) ?? '', /500 MB/);
  assert.equal(downloadBlocker(storeRow(store()), list()), null, 'a store build has no download to block');
});

test('notices say what to do about GitHub', () => {
  assert.equal(problemNotice(null, null), null);
  const denied = problemNotice({ reason: 'no_access', needs: 'actions: read' }, { owner: 'acme', repo: 'app' });
  assert.equal(denied?.tone, 'warn');
  assert.match(denied?.body ?? '', /acme\/app/);
  assert.match(denied?.body ?? '', /Actions: read/);
  assert.equal(problemNotice({ reason: 'no_repository', needs: null }, null)?.tone, 'info');
  assert.match(problemNotice({ reason: 'rate_limited', needs: null }, null)?.body ?? '', /minute/);
});

test('addresses: the download path, the phone address, and a phone that cannot reach localhost', () => {
  assert.equal(downloadPath('w 1', 'a/1', '9'), '/api/workspaces/w%201/apps/a%2F1/builds/artifacts/9/download');
  assert.equal(phoneUrl('http://192.168.1.5:8787/', '/api/builds/dl/x.y'), 'http://192.168.1.5:8787/api/builds/dl/x.y');
  assert.equal(phoneCannotReach('http://localhost:5173'), true);
  assert.equal(phoneCannotReach('http://127.0.0.1:8787'), true);
  assert.equal(phoneCannotReach('https://mrm.example.com'), false);
  assert.equal(phoneCannotReach('nonsense'), true);
  assert.equal(secondsLeft(NOW + 90_500, NOW), 91);
  assert.equal(secondsLeft(NOW - 1, NOW), 0);
  assert.equal(testBuildsHref('app 1', 'ios', '240'), '#/portfolio/app%201/test-builds?platform=ios&build=240');
  assert.equal(testBuildsHref('app1'), '#/portfolio/app1/test-builds');
  assert.equal(buildNumberOfTitle('Build 240'), '240');
  assert.equal(buildNumberOfTitle('Build (number unknown)'), null);
});

test('the API calls go to the documented paths', async () => {
  const { createApi } = await import('./api.ts');
  const calls: { path: string; method: string | undefined }[] = [];
  const api = createApi({
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ path: String(input), method: init?.method });
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  await api.buildArtifacts('w1', 'a 1');
  await api.createBuildLink('w1', 'a 1', '9');
  assert.deepEqual(calls, [
    { path: '/api/workspaces/w1/apps/a%201/builds/artifacts', method: 'GET' },
    { path: '/api/workspaces/w1/apps/a%201/builds/artifacts/9/link', method: 'POST' },
  ]);
});
