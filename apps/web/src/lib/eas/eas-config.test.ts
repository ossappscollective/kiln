import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApi } from '../api.ts';
import type {
  EasBuildProfile,
  EasBuildTarget,
  EasConfig,
  EasConfigView,
  EasFinding,
  EasSubmitProfile,
  ExpoAppSummary,
} from '../types.ts';
import {
  alertTone,
  badgeTone,
  buildChips,
  collapsedSummary,
  emptyState,
  envText,
  extendsText,
  findingCounts,
  findingsHeadline,
  platformSections,
  readCaption,
  runtimeLines,
  runtimeVersionText,
  severityLabel,
  shortCommit,
  sortFindings,
  submitLines,
  updatesText,
  versionSourceText,
} from './eas-config.ts';

const target = (overrides: Partial<EasBuildTarget> = {}): EasBuildTarget => ({
  distribution: null,
  channel: null,
  developmentClient: null,
  autoIncrement: null,
  resourceClass: null,
  image: null,
  buildType: null,
  gradleCommand: null,
  simulator: null,
  buildConfiguration: null,
  scheme: null,
  ...overrides,
});

const profile = (name: string, overrides: Partial<EasBuildProfile> = {}): EasBuildProfile => ({
  ...target(),
  name,
  extends: null,
  extendsChain: [name],
  node: null,
  environment: null,
  credentialsSource: null,
  releaseChannel: null,
  envNames: [],
  ios: null,
  android: null,
  unknownKeys: [],
  ...overrides,
});

const submit = (name: string, overrides: Partial<EasSubmitProfile> = {}): EasSubmitProfile => ({
  name,
  extends: null,
  extendsChain: [name],
  ios: null,
  android: null,
  unknownKeys: [],
  ...overrides,
});

const finding = (
  severity: EasFinding['severity'],
  message: string,
  extra: Partial<EasFinding> = {},
): EasFinding => ({
  code: 'x',
  severity,
  scope: 'build',
  message,
  ...extra,
});

const expoApp = (overrides: Partial<ExpoAppSummary> = {}): ExpoAppSummary => ({
  path: 'app.json',
  dynamicPath: null,
  unreadable: false,
  version: '1.0.0',
  runtimeVersion: null,
  iosRuntimeVersion: null,
  androidRuntimeVersion: null,
  updatesUrl: null,
  updatesEnabled: null,
  easProjectId: null,
  iosBundleIdentifier: null,
  androidPackage: null,
  iosBuildNumber: null,
  androidVersionCode: null,
  updatesConfigured: false,
  ...overrides,
});

const config = (overrides: Partial<EasConfig> = {}): EasConfig => ({
  cli: {
    version: null,
    requireCommit: null,
    appVersionSource: null,
    appVersionSourceEffective: 'local',
  },
  build: [],
  submit: [],
  unknownKeys: [],
  truncated: false,
  ...overrides,
});

const view = (overrides: Partial<EasConfigView> = {}): EasConfigView => ({
  app: { id: 'a1', name: 'Trail Notes', platform: 'ios', identifier: 'com.example.trailnotes' },
  repository: { id: 'r1', owner: 'acme', repo: 'app', localOnly: false },
  branch: 'main',
  commit: '0123456789abcdef0123456789abcdef01234567',
  readAt: 1_000_000,
  found: true,
  reason: null,
  nested: [],
  path: 'eas.json',
  config: config(),
  expoApp: expoApp(),
  findings: [],
  ...overrides,
});

test('findings: tone, label and order (errors, warnings, notes; the server order within each)', () => {
  assert.deepEqual(
    ['error', 'warning', 'info'].map((s) => alertTone(s as 'error')),
    ['error', 'warn', 'info'],
  );
  assert.deepEqual(
    ['error', 'warning', 'info'].map((s) => badgeTone(s as 'error')),
    ['bad', 'warn', 'info'],
  );
  assert.deepEqual(
    ['error', 'warning', 'info'].map((s) => severityLabel(s as 'error')),
    ['Error', 'Warning', 'Note'],
  );
  const sorted = sortFindings([
    finding('info', 'i1'),
    finding('warning', 'w1'),
    finding('error', 'e1'),
    finding('warning', 'w2'),
    finding('info', 'i2'),
    finding('error', 'e2'),
  ]);
  assert.deepEqual(
    sorted.map((f) => f.message),
    ['e1', 'e2', 'w1', 'w2', 'i1', 'i2'],
  );
  const input = [finding('info', 'a'), finding('error', 'b')];
  sortFindings(input);
  assert.deepEqual(
    input.map((f) => f.message),
    ['a', 'b'],
    'the input is not changed',
  );
});

test('findings: counts and the headline, with notes kept apart from problems', () => {
  assert.deepEqual(findingCounts([]), { error: 0, warning: 0, info: 0 });
  assert.equal(findingsHeadline([]), 'No problems found');
  assert.equal(findingsHeadline([finding('info', 'a')]), 'No problems found, 1 note');
  assert.equal(findingsHeadline([finding('error', 'a')]), '1 error');
  assert.equal(
    findingsHeadline([
      finding('error', 'a'),
      finding('warning', 'b'),
      finding('warning', 'c'),
      finding('info', 'd'),
      finding('info', 'e'),
    ]),
    '1 error, 2 warnings, 2 notes',
  );
});

test('build chips: distribution, channel, development client, auto increment, simulator', () => {
  assert.deepEqual(buildChips(profile('bare')), []);
  assert.deepEqual(
    buildChips(profile('p', { distribution: 'store', channel: 'production', autoIncrement: true })),
    [
      { text: 'Store distribution', tone: 'ok' },
      { text: 'Channel production', tone: 'accent' },
      { text: 'Auto increment', tone: 'neutral' },
    ],
  );
  assert.deepEqual(
    buildChips(profile('dev', { distribution: 'internal', developmentClient: true })),
    [
      { text: 'Internal distribution', tone: 'info' },
      { text: 'Development client', tone: 'neutral' },
    ],
  );
  assert.deepEqual(buildChips(profile('odd', { distribution: 'ota' })), [
    { text: 'Distribution ota', tone: 'warn' },
  ]);
  assert.deepEqual(buildChips(profile('x', { autoIncrement: false })), []);
});

test('build chips: a platform that differs says which platform; one that only inherits adds nothing', () => {
  const root = { distribution: 'store', channel: 'production' };
  const same = profile('same', { ...root, ios: target(root), android: target(root) });
  assert.deepEqual(
    buildChips(same).map((c) => c.text),
    ['Store distribution', 'Channel production'],
  );
  const differs = profile('differs', {
    ...root,
    ios: target({ ...root, channel: 'production-ios', simulator: true }),
    android: target({ ...root, distribution: 'internal', autoIncrement: 'versionCode' }),
  });
  assert.deepEqual(
    buildChips(differs).map((c) => c.text),
    [
      'Store distribution',
      'Channel production',
      'iOS: Channel production-ios',
      'Android: Internal distribution',
      'Auto increment',
      'Simulator',
    ],
  );
  assert.deepEqual(
    platformSections(differs).map((s) => s.label),
    ['iOS', 'Android'],
  );
  assert.deepEqual(platformSections(profile('none')), []);
});

test('env names: none, a few, and how many more', () => {
  assert.equal(envText([]), 'None');
  assert.equal(envText(['A', 'B']), 'A, B');
  assert.equal(envText(['A', 'B', 'C', 'D']), 'A, B, C, D');
  assert.equal(envText(['A', 'B', 'C', 'D', 'E', 'F']), 'A, B, C, D and 2 more');
  assert.equal(envText(['A', 'B', 'C'], 2), 'A, B and 1 more');
});

test('extends text: nothing, one step, a chain', () => {
  assert.equal(extendsText(profile('p')), '');
  assert.equal(
    extendsText(profile('p', { extends: 'base', extendsChain: ['p', 'base'] })),
    'Extends base',
  );
  assert.equal(
    extendsText(profile('p', { extends: 'mid', extendsChain: ['p', 'mid', 'base'] })),
    'Extends mid > base',
  );
  // a missing profile stops the chain: the direct parent is still named
  assert.equal(
    extendsText(profile('p', { extends: 'ghost', extendsChain: ['p'] })),
    'Extends ghost',
  );
});

test('submit lines: iOS and Android, paths as written, the Apple ID never shown', () => {
  assert.deepEqual(submitLines(submit('empty')), []);
  const lines = submitLines(
    submit('production', {
      ios: {
        ascAppId: '1234567890',
        appleTeamId: 'ABCDE12345',
        sku: null,
        language: null,
        companyName: null,
        appName: null,
        bundleIdentifier: 'com.example.app',
        ascApiKeyPath: './keys/AuthKey.p8',
        ascApiKeyId: null,
        ascApiKeyIssuerId: null,
        hasAppleId: true,
        metadataPath: './store.config.json',
        groups: ['Internal', 'QA'],
      },
      android: {
        track: 'production',
        releaseStatus: 'inProgress',
        rollout: 0.1,
        changesNotSentForReview: true,
        serviceAccountKeyPath: '$GOOGLE_KEY',
        applicationId: 'com.example.app',
      },
    }),
  );
  assert.deepEqual(
    lines.map((l) => l.label),
    ['iOS', 'Android'],
  );
  assert.equal(
    lines[0]?.text,
    'App Store Connect app 1234567890 · team ABCDE12345 · com.example.app · API key ./keys/AuthKey.p8 · TestFlight groups Internal, QA · store config ./store.config.json',
  );
  assert.equal(
    lines[1]?.text,
    'track production · release status inProgress · 10% rollout · changes not sent for review · com.example.app · service account key $GOOGLE_KEY',
  );
  const appleId = submitLines(
    submit('p', {
      ios: {
        ascAppId: null,
        appleTeamId: null,
        sku: null,
        language: null,
        companyName: null,
        appName: null,
        bundleIdentifier: null,
        ascApiKeyPath: null,
        ascApiKeyId: null,
        ascApiKeyIssuerId: null,
        hasAppleId: true,
        metadataPath: null,
        groups: ['One'],
      },
      android: {
        track: null,
        releaseStatus: null,
        rollout: null,
        changesNotSentForReview: null,
        serviceAccountKeyPath: null,
        applicationId: null,
      },
    }),
  );
  assert.equal(appleId[0]?.text, 'signs in with an Apple ID · TestFlight group One');
  assert.equal(appleId[1]?.text, 'Nothing set: EAS asks when you submit');
});

test('rollout percentages are rounded to two places', () => {
  const android = (rollout: number) =>
    submitLines(
      submit('p', {
        android: {
          track: null,
          releaseStatus: null,
          rollout,
          changesNotSentForReview: null,
          serviceAccountKeyPath: null,
          applicationId: null,
        },
      }),
    )[0]?.text;
  assert.equal(android(0.5), '50% rollout');
  assert.equal(android(0.125), '12.5% rollout');
  assert.equal(android(0.333333), '33.33% rollout');
});

test('runtime version and update setup in words', () => {
  assert.equal(runtimeVersionText(null), 'Not set');
  assert.equal(runtimeVersionText({ kind: 'string', value: '1.0.0' }), '1.0.0');
  assert.equal(runtimeVersionText({ kind: 'policy', policy: 'appVersion' }), 'Policy appVersion');
  assert.deepEqual(runtimeLines(expoApp()), [{ label: 'Runtime version', text: 'Not set' }]);
  assert.deepEqual(
    runtimeLines(
      expoApp({
        runtimeVersion: { kind: 'string', value: '1.0.0' },
        iosRuntimeVersion: { kind: 'policy', policy: 'fingerprint' },
        androidRuntimeVersion: { kind: 'string', value: '1.0.1' },
      }),
    ),
    [
      { label: 'Runtime version', text: '1.0.0' },
      { label: 'iOS runtime version', text: 'Policy fingerprint' },
      { label: 'Android runtime version', text: '1.0.1' },
    ],
  );
  assert.equal(
    updatesText(expoApp({ updatesConfigured: true, updatesUrl: 'https://u.expo.dev/x' })),
    'Configured (updates.url is set)',
  );
  assert.equal(
    updatesText(expoApp({ updatesConfigured: false })),
    'Not configured (no updates.url)',
  );
  assert.equal(
    updatesText(expoApp({ updatesConfigured: false, updatesEnabled: false })),
    'Turned off (updates.enabled is false)',
  );
  assert.equal(
    updatesText(expoApp({ unreadable: true, updatesConfigured: null })),
    'The app config could not be read',
  );
  assert.equal(
    updatesText(expoApp({ updatesConfigured: null, dynamicPath: 'app.config.ts' })),
    'Unknown: app.config.ts is code and is not run',
  );
  assert.equal(
    updatesText(expoApp({ updatesConfigured: null, path: null })),
    'Unknown: no app config was read',
  );
});

test('version source in words', () => {
  assert.equal(versionSourceText(config().cli), 'Not set (local)');
  assert.equal(
    versionSourceText({
      ...config().cli,
      appVersionSource: 'remote',
      appVersionSourceEffective: 'remote',
    }),
    'Remote (kept by Expo)',
  );
  assert.equal(
    versionSourceText({ ...config().cli, appVersionSource: 'local' }),
    'Local (in the project files)',
  );
});

test('what was read: commit, branch and age', () => {
  assert.equal(shortCommit('0123456789abcdef'), '0123456');
  assert.equal(
    readCaption(view(), 1_000_000 + 120_000),
    'Read from eas.json at 0123456 on main, 2 minutes ago.',
  );
  assert.equal(readCaption(view({ commit: null }), 1_000_000), 'Read from eas.json on main, now.');
  assert.equal(
    readCaption(view({ commit: null, branch: null, path: null }), 1_000_000),
    'Read from eas.json, now.',
  );
});

test('the collapsed summary: before reading, while reading, after, and when nothing was found', () => {
  assert.equal(
    collapsedSummary(null, 'idle'),
    'Build and submit profiles, channels, runtime version',
  );
  assert.equal(collapsedSummary(null, 'loading'), 'Reading eas.json...');
  assert.equal(collapsedSummary(null, 'error'), 'Could not be read');
  assert.equal(
    collapsedSummary(
      view({
        config: config({ build: [profile('a'), profile('b')], submit: [submit('a')] }),
        findings: [finding('warning', 'w')],
      }),
      'idle',
    ),
    '2 build profiles · 1 submit profile · 1 warning',
  );
  assert.equal(
    collapsedSummary(view({ config: config() }), 'idle'),
    '0 build profiles · 0 submit profiles · no problems found',
  );
  assert.equal(
    collapsedSummary(
      view({ found: false, reason: { code: 'no_eas_json', message: 'm' }, config: null }),
      'idle',
    ),
    'No eas.json',
  );
  assert.equal(
    collapsedSummary(
      view({ found: false, reason: { code: 'no_repository', message: 'm' }, config: null }),
      'idle',
    ),
    'Nothing to show',
  );
  assert.equal(
    collapsedSummary(view({ config: null, findings: [finding('error', 'e')] }), 'idle'),
    'eas.json could not be parsed',
  );
});

test('the empty state says why there is nothing to show', () => {
  const none = (reason: NonNullable<EasConfigView['reason']>, nested: string[] = []) =>
    emptyState(view({ found: false, config: null, reason, nested }));
  assert.deepEqual(none({ code: 'no_repository', message: 'Link one.' }), {
    title: 'No repository linked',
    description: 'Link one.',
  });
  assert.deepEqual(none({ code: 'unreadable', message: 'Too large.' }), {
    title: 'eas.json could not be read',
    description: 'Too large.',
  });
  const missing = none(
    {
      code: 'no_eas_json',
      message: 'Only the root is read; found in subfolders: apps/mobile/eas.json.',
    },
    ['apps/mobile/eas.json'],
  );
  assert.equal(missing.title, 'No eas.json');
  assert.match(missing.description, /apps\/mobile\/eas\.json/);
  const plain = none({
    code: 'no_eas_json',
    message: 'There is no eas.json at the repository root.',
  });
  assert.match(plain.description, /no EAS build or submit profiles/);
});

test('the API method asks for the eas-config of the app, with the ids encoded', async () => {
  const calls: { path: string; method: string }[] = [];
  const fetchImpl = (async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method ?? 'GET' });
    return new Response(JSON.stringify(view()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const api = createApi({ fetch: fetchImpl });
  const read = await api.easConfig('w 1', 'a/1');
  assert.deepEqual(calls, [{ path: '/api/workspaces/w%201/apps/a%2F1/eas-config', method: 'GET' }]);
  assert.equal(read.found, true);
  assert.equal(read.commit, '0123456789abcdef0123456789abcdef01234567');
});
