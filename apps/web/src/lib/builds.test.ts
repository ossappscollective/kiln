import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ArtifactItem,
  applyFilters,
  artifactRow,
  type BuildsList,
  buildNumberOfTitle,
  canOfferShare,
  downloadsOffText,
  defaultFilters,
  downloadBlocker,
  downloadPath,
  entryChoices,
  expiryText,
  hiddenBy,
  humanSize,
  installGuide,
  linkSensitiveText,
  linkKeptText,
  noRightText,
  phoneCannotReach,
  phoneUrl,
  phraseMatches,
  previewFromBody,
  previewNotes,
  previewReady,
  problemNotice,
  rowsOf,
  type SharePreview,
  type StoreBuildItem,
  secondsLeft,
  sharedNote,
  shareErrorMessage,
  shareFailure,
  sharePhrase,
  shortHash,
  statusLine,
  storeRow,
  testflightNoneText,
  testBuildsHref,
  testflightNote,
  testflightView,
  uploadFileText,
  versionCodeText,
} from './builds.ts';

const DAY = 24 * 60 * 60_000;
const NOW = 1_900_000_000_000;

const artifact = (over: Partial<ArtifactItem> = {}): ArtifactItem => ({
  id: '1',
  name: 'ios-build',
  kind: 'zip',
  guessed: true,
  platform: 'ios',
  sizeBytes: 12 * 1024 * 1024,
  expired: false,
  createdAt: NOW - DAY,
  expiresAt: NOW + 30 * DAY,
  downloadable: true,
  tooLarge: false,
  run: {
    id: '101',
    number: 7,
    workflow: 'iOS release',
    title: null,
    branch: 'main',
    shortSha: 'abc1234',
    status: 'completed',
    conclusion: 'success',
    url: 'https://github.com/acme/app/actions/runs/101',
  },
  ...over,
});
const store = (over: Partial<StoreBuildItem> = {}): StoreBuildItem => ({
  platform: 'ios',
  buildNumber: '240',
  version: '2.4.0',
  state: 'processed',
  rawState: 'VALID',
  expired: false,
  uploadedAt: NOW - 2 * DAY,
  expiresAt: NOW + 88 * DAY,
  expiresAtEstimated: true,
  channel: 'testflight',
  tracks: [],
  releaseStatus: null,
  optInUrl: null,
  runId: null,
  testflightGroupIds: null,
  ...over,
});
const list = (over: Partial<BuildsList> = {}): BuildsList => ({
  app: { id: 'a', name: 'Acme', platform: 'ios', identifier: 'com.acme' },
  repository: { id: 'r', owner: 'acme', repo: 'app' },
  artifacts: [],
  hiddenArtifacts: 0,
  truncated: false,
  store: [],
  testflight: null,
  problem: null,
  downloadEnabled: true,
  maxDownloadBytes: 500 * 1024 * 1024,
  canDownload: true,
  readAt: NOW,
  cached: false,
  ...over,
});

test('rows: CI artifacts and store builds together, newest first, undated last', () => {
  const rows = rowsOf(
    list({
      artifacts: [artifact({ id: '2', createdAt: NOW - 5 * DAY }), artifact({ id: '1' })],
      store: [store(), store({ buildNumber: '1', uploadedAt: null })],
    }),
  );
  assert.deepEqual(
    rows.map((r) => r.key),
    ['ci:1', 'store:ios:240', 'ci:2', 'store:ios:1'],
  );
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
  assert.equal(
    artifactRow(artifact({ run: { ...artifact().run, conclusion: 'failure' } })).state.label,
    'Run failed',
  );
  assert.equal(storeRow(store({ state: 'processing' })).state.label, 'Processing');
  assert.equal(storeRow(store({ expired: true })).state.label, 'Expired');
  assert.equal(
    storeRow(store({ channel: 'play', tracks: ['internal'], buildNumber: '7' })).detail,
    'Track internal',
  );
});

test('filters: platform, source, hide expired and hide reports', () => {
  const rows = rowsOf(
    list({
      artifacts: [
        artifact({ id: '1' }),
        artifact({ id: '2', expired: true }),
        artifact({ id: '3', kind: 'other' }),
        artifact({ id: '4', kind: 'apk', platform: 'android' }),
      ],
      store: [store()],
    }),
  );
  assert.deepEqual(
    applyFilters(rows, defaultFilters)
      .map((r) => r.key)
      .sort(),
    ['ci:1', 'ci:4', 'store:ios:240'],
  );
  assert.equal(hiddenBy(rows, defaultFilters), 2);
  assert.deepEqual(
    applyFilters(rows, { ...defaultFilters, platform: 'android' }).map((r) => r.key),
    ['ci:4'],
  );
  assert.deepEqual(
    applyFilters(rows, { ...defaultFilters, source: 'store' }).map((r) => r.key),
    ['store:ios:240'],
  );
  assert.equal(
    applyFilters(rows, { platform: 'all', source: 'all', hideExpired: false, hideOther: false })
      .length,
    5,
  );
});

test('sizes and expiry in plain words', () => {
  assert.equal(humanSize(null), '');
  assert.equal(humanSize(512), '512 byte');
  assert.equal(humanSize(1536), '1.5 kB');
  assert.equal(humanSize(12 * 1024 * 1024), '12 MB');
  assert.equal(humanSize(500 * 1024 * 1024), '500 MB');
  assert.equal(humanSize(2.5 * 1024 ** 3), '2.5 GB');
  assert.equal(expiryText(artifactRow(artifact()), NOW), 'expires in 30 days');
  assert.equal(
    expiryText(artifactRow(artifact({ expiresAt: NOW + DAY })), NOW),
    'expires in 1 day',
  );
  assert.equal(expiryText(artifactRow(artifact({ expiresAt: NOW + 1000 })), NOW), 'expires today');
  assert.equal(
    expiryText(artifactRow(artifact({ expired: true, expiresAt: NOW - 3 * DAY })), NOW),
    'expired 3 days ago',
  );
  assert.equal(expiryText(storeRow(store()), NOW), 'expires in about 88 days');
  assert.equal(expiryText(artifactRow(artifact({ expiresAt: null })), NOW), '');
});

test('install guidance: honest by kind', () => {
  const g = (kind: ArtifactItem['kind'], platform: ArtifactItem['platform'] = 'android') =>
    installGuide(artifactRow(artifact({ kind, platform })));
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
  assert.match(
    installGuide(storeRow(store({ state: 'processing' }))).caution ?? '',
    /still processing/,
  );
  const play = installGuide(
    storeRow(
      store({
        channel: 'play',
        tracks: ['beta'],
        optInUrl: 'https://play.google.com/apps/testing/com.acme',
      }),
    ),
  );
  assert.equal(play.link?.href, 'https://play.google.com/apps/testing/com.acme');
  assert.equal(installGuide(storeRow(store({ channel: 'play', tracks: ['internal'] }))).link, null);
});

test('no download button without the switch, the right, a live artifact or room under the limit; the reason is a sentence', () => {
  const row = artifactRow(artifact());
  assert.equal(downloadBlocker(row, list()), null);
  assert.equal(downloadBlocker(row, list({ downloadEnabled: false })), downloadsOffText());
  assert.match(downloadsOffText(), /KILN_BUILDS_DOWNLOAD_ENABLED/);
  assert.match(downloadsOffText(), /Actions: read/);
  assert.equal(downloadBlocker(row, list({ canDownload: false })), noRightText());
  assert.match(
    downloadBlocker(artifactRow(artifact({ expired: true })), list()) ?? '',
    /no longer keeps/,
  );
  assert.match(downloadBlocker(artifactRow(artifact({ tooLarge: true })), list()) ?? '', /500 MB/);
  assert.equal(
    downloadBlocker(storeRow(store()), list()),
    null,
    'a store build has no download to block',
  );
});

test('notices say what to do about GitHub', () => {
  assert.equal(problemNotice(null, null), null);
  const denied = problemNotice(
    { reason: 'no_access', needs: 'actions: read' },
    { owner: 'acme', repo: 'app' },
  );
  assert.equal(denied?.tone, 'warn');
  assert.match(denied?.body ?? '', /acme\/app/);
  assert.match(denied?.body ?? '', /Actions: read/);
  assert.equal(problemNotice({ reason: 'no_repository', needs: null }, null)?.tone, 'info');
  assert.match(problemNotice({ reason: 'rate_limited', needs: null }, null)?.body ?? '', /minute/);
});

test('addresses: the download path, the phone address, and a phone that cannot reach localhost', () => {
  assert.equal(
    downloadPath('w 1', 'a/1', '9'),
    '/api/workspaces/w%201/apps/a%2F1/builds/artifacts/9/download',
  );
  assert.equal(
    phoneUrl('http://192.168.1.5:8787/', '/api/builds/dl/x.y'),
    'http://192.168.1.5:8787/api/builds/dl/x.y',
  );
  assert.equal(phoneCannotReach('http://localhost:5173'), true);
  assert.equal(phoneCannotReach('http://127.0.0.1:8787'), true);
  assert.equal(phoneCannotReach('https://kiln.example.com'), false);
  assert.equal(phoneCannotReach('nonsense'), true);
  assert.equal(secondsLeft(NOW + 90_500, NOW), 91);
  assert.equal(secondsLeft(NOW - 1, NOW), 0);
  assert.equal(
    testBuildsHref('app 1', 'ios', '240'),
    '#/portfolio/app%201/builds?platform=ios&view=tests&build=240',
  );
  assert.equal(testBuildsHref('app1'), '#/portfolio/app1/builds?view=tests');
  assert.equal(buildNumberOfTitle('Build 240'), '240');
  assert.equal(buildNumberOfTitle('Build (number unknown)'), null);
});

test('the API calls go to the documented paths', async () => {
  const { createApi } = await import('./api.ts');
  const calls: { path: string; method: string | undefined }[] = [];
  const api = createApi({
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ path: String(input), method: init?.method });
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });
  await api.buildArtifacts('w1', 'a 1');
  await api.createBuildLink('w1', 'a 1', '9');
  assert.deepEqual(calls, [
    { path: '/api/workspaces/w1/apps/a%201/builds/artifacts', method: 'GET' },
    { path: '/api/workspaces/w1/apps/a%201/builds/artifacts/9/link', method: 'POST' },
  ]);
});

test('TestFlight row: links with state and limit, and plain words when there is none, nothing for Play, a fixed message for errors', () => {
  const info = (
    over: Partial<NonNullable<BuildsList['testflight']>> = {},
  ): BuildsList['testflight'] => ({
    groups: [
      {
        id: 'g1',
        name: 'Beta',
        publicLink: 'https://testflight.apple.com/join/AbC',
        enabled: true,
        limit: 500,
      },
      {
        id: 'g2',
        name: 'Off',
        publicLink: 'https://testflight.apple.com/join/Off',
        enabled: false,
        limit: null,
      },
    ],
    withoutLink: 0,
    problem: null,
    readAt: NOW,
    cached: false,
    ...over,
  });
  const links = testflightView({ testflight: info() }, store({ testflightGroupIds: ['g1', 'g2'] }));
  assert.equal(links.kind, 'links');
  if (links.kind === 'links') {
    assert.deepEqual(
      links.links.map((l) => [l.name, l.stateText, l.limitText]),
      [
        ['Beta', 'Link on', 'Up to 500 testers'],
        ['Off', 'Link off', 'No tester limit'],
      ],
    );
  }
  const some = testflightView({ testflight: info() }, store({ testflightGroupIds: ['g2'] }));
  assert.equal(some.kind === 'links' && some.links.length, 1);
  assert.match(
    (testflightView({ testflight: info() }, store({ testflightGroupIds: [] })) as { text: string })
      .text,
    /not in a TestFlight group/,
  );
  // Whole-list words are not repeated on every row: they come once, from testflightNote.
  assert.equal(
    testflightView({ testflight: info({ groups: [] }) }, store({ testflightGroupIds: [] })).kind,
    'hidden',
  );
  assert.match(testflightNoneText(), /never creates or turns on/);
  assert.equal(testflightView({ testflight: info() }, store({ expired: true })).kind, 'hidden');
  assert.equal(testflightView({ testflight: info() }, store({ channel: 'play' })).kind, 'hidden');
  assert.equal(testflightView({ testflight: null }, store()).kind, 'hidden');
  const broken = info({ groups: [], problem: { reason: 'no_access', needs: 'x' } });
  assert.equal(testflightView({ testflight: broken }, store()).kind, 'hidden');
  const withStore = (testflight: BuildsList['testflight'], builds = [store()]) => ({
    testflight,
    store: builds,
  });
  const denied = testflightNote(withStore(broken));
  assert.equal(denied?.tone, 'warn');
  assert.equal(denied?.retry, true);
  assert.match(denied?.text ?? '', /App Manager/);
  assert.match(
    testflightNote(withStore(info({ groups: [], problem: { reason: 'not_synced', needs: null } })))
      ?.text ?? '',
    /Sync this app/,
  );
  assert.equal(
    testflightNote(withStore(info({ groups: [], problem: { reason: 'unavailable', needs: null } })))
      ?.short,
    'TestFlight links could not be read.',
  );
  assert.equal(testflightNote(withStore(info({ groups: [] })))?.text, testflightNoneText());
  assert.equal(testflightNote(withStore(info())), null);
  assert.equal(testflightNote(withStore(broken, [store({ channel: 'play' })])), null);
  assert.equal(testflightNote(withStore(null)), null);
});

// ---- Share to device (Google Play internal app sharing) ----

const preview = (over: Partial<SharePreview> = {}): SharePreview => ({
  app: { id: 'a', name: 'Acme', platform: 'android', identifier: 'com.acme.app' },
  artifact: {
    id: '9',
    name: 'android-release',
    kind: 'aab',
    sizeBytes: 1024,
    zipSha256: null,
    runId: '101',
    headSha: 'abc',
    createdAt: NOW,
    expiresAt: null,
  },
  upload: {
    packageName: 'com.acme.app',
    kind: 'bundle',
    fileName: 'app-release.aab',
    entry: null,
    versionCode: null,
    sha256: null,
    maxSizeBytes: 1000,
  },
  effects: ['x'],
  linkRetentionHours: 24,
  checks: { blocking: [], warnings: [], canShare: true },
  confirmHash: 'a'.repeat(64),
  confirmation: { phrase: 'SHARE com.acme.app', instruction: 'Type it.' },
  readAt: NOW,
  ...over,
});

test('the share button needs the switch, the role and an Android CI artifact that can still be read', () => {
  const on = { enabled: true, canShare: true };
  const droid = artifactRow(
    artifact({ platform: 'android', name: 'android-release', kind: 'aab' }),
  );
  assert.equal(canOfferShare(droid, on), true);
  assert.equal(canOfferShare(droid, null), false);
  assert.equal(canOfferShare(droid, { enabled: false, canShare: true }), false);
  assert.equal(canOfferShare(droid, { enabled: true, canShare: false }), false);
  assert.equal(canOfferShare(artifactRow(artifact({ platform: 'ios' })), on), false);
  assert.equal(
    canOfferShare(artifactRow(artifact({ platform: 'android', expired: true })), on),
    false,
  );
  assert.equal(
    canOfferShare(artifactRow(artifact({ platform: 'android', tooLarge: true })), on),
    false,
  );
  assert.equal(canOfferShare(storeRow(store({ platform: 'android', channel: 'play' })), on), false);
});

test('the typed phrase is SHARE and the package, exactly', () => {
  assert.equal(sharePhrase('com.acme.app'), 'SHARE com.acme.app');
  assert.equal(phraseMatches('SHARE com.acme.app', 'SHARE com.acme.app'), true);
  assert.equal(phraseMatches('  SHARE com.acme.app ', 'SHARE com.acme.app'), true);
  assert.equal(phraseMatches('share com.acme.app', 'SHARE com.acme.app'), false);
  assert.equal(phraseMatches('SHARE', 'SHARE com.acme.app'), false);
  assert.equal(phraseMatches('anything', null), false);
});

test('a preview is ready only with no blocking check, a hash and a phrase', () => {
  assert.equal(previewReady(preview()), true);
  assert.equal(previewReady(preview({ confirmHash: null })), false);
  assert.equal(previewReady(preview({ confirmation: null })), false);
  const blocked = preview({
    checks: {
      blocking: [{ code: 'share_in_progress', severity: 'blocking', message: 'Wait.' }],
      warnings: [{ code: 'previous_upload_unknown', severity: 'warning', message: 'Unknown.' }],
      canShare: false,
    },
  });
  assert.equal(previewReady(blocked), false);
  assert.deepEqual(
    previewNotes(blocked).map((n) => n.tone),
    ['error', 'warn'],
  );
});

test('unknown file facts are said plainly, not invented', () => {
  assert.equal(versionCodeText(null), 'Not known before the upload');
  assert.equal(versionCodeText(42), '42');
  assert.equal(shortHash(null), 'Not known before the upload');
  assert.equal(shortHash('a'.repeat(64)), `${'a'.repeat(12)}…${'a'.repeat(6)}`);
  assert.match(uploadFileText({ fileName: null, kind: null }), /found when you confirm/);
  assert.equal(uploadFileText({ fileName: 'app.apk', kind: 'apk' }), 'app.apk (APK)');
  assert.equal(uploadFileText({ fileName: null, kind: 'bundle' }), 'Android App Bundle (.aab)');
});

test('every fixed code of the sharing routes has a sentence, and none carries a secret or a vendor text', () => {
  const codes = [
    'internal_sharing_disabled',
    'forbidden',
    'not_android',
    'invalid_entry',
    'entry_required',
    'entry_not_found',
    'no_android_build',
    'bad_zip',
    'artifact_expired',
    'artifact_too_large',
    'confirmation_mismatch',
    'state_changed',
    'blocked',
    'write_in_progress',
    'store_auth',
    'store_forbidden',
    'store_not_found',
    'artifact_rejected',
    'rate_limited',
    'upload_failed',
    'outcome_unknown',
    'link_expired',
    'not_found',
  ];
  for (const code of codes) assert.ok(shareErrorMessage(code), code);
  assert.equal(shareErrorMessage('nope'), undefined);
  assert.match(shareErrorMessage('rate_limited', 30) ?? '', /30 seconds/);
  assert.match(shareErrorMessage('rate_limited', 120) ?? '', /2 minutes/);
  assert.match(shareErrorMessage('outcome_unknown') ?? '', /Preview again/);
});

test('a failure shows the fixed sentence for its code, else the client text, else a fallback', () => {
  assert.match(
    shareFailure({ code: 'store_auth', message: 'raw google words' }),
    /rejected the credential/,
  );
  assert.equal(shareFailure({ code: 'something_else', message: 'Client text.' }), 'Client text.');
  assert.match(shareFailure({}), /Could not share/);
});

test('entry choices and a new preview are read from an error body, and only when they look right', () => {
  assert.deepEqual(entryChoices({ entries: ['a.aab', 3, 'b.apk'] }), ['a.aab', 'b.apk']);
  assert.deepEqual(entryChoices({}), []);
  assert.deepEqual(entryChoices(undefined), []);
  assert.equal(previewFromBody({ preview: preview() })?.confirmHash, 'a'.repeat(64));
  assert.equal(previewFromBody({ preview: 'x' }), null);
  assert.equal(previewFromBody({}), null);
});

test('the link warnings say it is sensitive and how long this server keeps it', () => {
  assert.match(linkSensitiveText(), /sensitive/);
  assert.match(linkKeptText(24), /24 hours/);
  assert.match(linkKeptText(1), /1 hour,/);
});

test('the status line joins "downloads off" and a problem with the artifacts into one line with details', () => {
  const base = { downloadEnabled: true, problem: null, repository: null } as const;
  assert.equal(statusLine(base), null);
  const off = statusLine({ ...base, downloadEnabled: false });
  assert.equal(off?.text, 'Downloads are off');
  assert.equal(off?.tone, 'info');
  assert.deepEqual(
    off?.details.map((d) => d.body),
    [downloadsOffText()],
  );
  const both = statusLine({
    downloadEnabled: false,
    problem: { reason: 'unsupported', needs: null },
    repository: null,
  });
  assert.equal(both?.text, 'Downloads are off · This connection cannot list artifacts');
  assert.equal(both?.details.length, 2);
  const warn = statusLine({
    ...base,
    problem: { reason: 'no_access', needs: 'actions: read' },
    repository: { owner: 'acme', repo: 'app' },
  });
  assert.equal(warn?.tone, 'warn');
  assert.match(warn?.details[0]?.body ?? '', /acme\/app/);
});

test('sharedNote: only an artifact of a shared run with an unknown owner gets the chip text', () => {
  assert.equal(sharedNote(artifact()), '');
  assert.equal(sharedNote(artifact({ sharedWith: null })), '');
  assert.equal(
    sharedNote(artifact({ sharedWith: ['Demo Notes', 'Demo Weather'] })),
    'From a run shared by Demo Notes and Demo Weather',
  );
});
