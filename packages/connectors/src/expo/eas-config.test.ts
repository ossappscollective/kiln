import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeEasConfig,
  type EasConfig,
  type EasConfigReport,
  type EasFinding,
  type EasFindingCode,
  looksLikeSecret,
  parseJsonLenient,
  readEasConfig,
  readExpoAppConfig,
  relaxJson,
} from './eas-config.ts';
import {
  APP_PLAIN,
  APP_UPDATES,
  app,
  COMMENTED_EAS,
  CYCLE_EAS,
  DEEP_EAS,
  DEFAULT_EAS,
  FULL_EAS,
  INVALID_EAS,
  MISSING_EAS,
  PROTO_EAS,
  SECRET_TOKEN,
  SENTRY_TOKEN,
  WRONG_TYPES_EAS,
} from './eas-config.fixtures.ts';

const analyze = (easJson: string, appText?: string, extra: { dynamic?: string } = {}) =>
  analyzeEasConfig({
    easJson,
    ...(appText === undefined ? {} : { appConfig: { path: 'app.json', text: appText } }),
    ...(extra.dynamic === undefined ? {} : { dynamicAppConfig: extra.dynamic }),
  });

const config = (report: EasConfigReport): EasConfig => {
  assert.ok(report.config, 'the file was parsed');
  return report.config;
};
const codes = (report: EasConfigReport) => report.findings.map((f) => f.code);
const find = (report: EasConfigReport, code: EasFindingCode, profile?: string) =>
  report.findings.filter((f) => f.code === code && (profile === undefined || f.profile === profile));
const one = (report: EasConfigReport, code: EasFindingCode, profile?: string): EasFinding => {
  const hits = find(report, code, profile);
  assert.equal(hits.length, 1, `${code} ${profile ?? ''}: ${JSON.stringify(codes(report))}`);
  return hits[0] as EasFinding;
};
const profile = (c: EasConfig, name: string) => {
  const found = c.build.find((b) => b.name === name);
  assert.ok(found, `build profile ${name}`);
  return found;
};

test('the default file Expo writes: profiles, channels, cli', () => {
  const report = analyze(DEFAULT_EAS);
  const c = config(report);
  assert.deepEqual(
    c.build.map((b) => b.name),
    ['development', 'preview', 'production'],
  );
  assert.equal(c.cli.version, '>= 16.0.0');
  assert.equal(c.cli.appVersionSource, 'remote');
  assert.equal(profile(c, 'development').developmentClient, true);
  assert.equal(profile(c, 'development').distribution, 'internal');
  assert.equal(profile(c, 'preview').channel, 'preview');
  assert.equal(profile(c, 'production').autoIncrement, true);
  assert.deepEqual(
    c.submit.map((s) => s.name),
    ['production'],
  );
  assert.equal(c.submit[0]?.ios, null);
  assert.equal(c.submit[0]?.android, null);
  assert.equal(c.truncated, false);
});

test('appVersionSource remote is reported as information, not as a problem', () => {
  const report = analyze(DEFAULT_EAS);
  const finding = one(report, 'app_version_source_remote');
  assert.equal(finding.severity, 'info');
  assert.equal(finding.scope, 'cli');
  // Without a field the CLI uses local and says it will become required.
  const missing = analyze('{"build":{}}');
  assert.equal(one(missing, 'app_version_source_missing').severity, 'info');
  assert.equal(config(missing).cli.appVersionSourceEffective, 'local');
  assert.equal(config(report).cli.appVersionSourceEffective, 'remote');
});

test('an appVersionSource that is not local or remote is a warning and counts as local', () => {
  const report = analyze('{"cli":{"appVersionSource":"cloud"}}');
  assert.equal(one(report, 'app_version_source_unknown').severity, 'warning');
  assert.equal(config(report).cli.appVersionSource, null);
  assert.equal(find(report, 'app_version_source_missing').length, 0);
});

test('autoIncrement without appVersionSource is a warning that names the profile', () => {
  const report = analyze('{"build":{"production":{"autoIncrement":true},"dev":{}}}');
  const finding = one(report, 'auto_increment_without_source');
  assert.match(finding.message, /"production"/);
  assert.doesNotMatch(finding.message, /"dev"/);
  assert.equal(find(analyze(DEFAULT_EAS), 'auto_increment_without_source').length, 0);
  const android = analyze('{"build":{"p":{"android":{"autoIncrement":"versionCode"}}}}');
  assert.equal(find(android, 'auto_increment_without_source').length, 1);
  const off = analyze('{"build":{"p":{"autoIncrement":false}}}');
  assert.equal(find(off, 'auto_increment_without_source').length, 0);
});

test('extends is resolved: values, platform sections and env names are merged', () => {
  const c = config(analyze(FULL_EAS));
  const preview = profile(c, 'preview');
  assert.deepEqual(preview.extendsChain, ['preview', 'base']);
  assert.equal(preview.extends, 'base');
  assert.equal(preview.node, '22.11.0', 'inherited from base');
  assert.equal(preview.distribution, 'internal', 'the child wins');
  assert.equal(preview.channel, 'preview');
  assert.equal(preview.developmentClient, false);
  // android: buildType replaced by the child, image kept from the base
  assert.equal(preview.android?.buildType, 'apk');
  assert.equal(preview.android?.image, 'latest');
  assert.equal(preview.android?.distribution, 'internal', 'a platform inherits the root value');
  // ios: simulator from the child, resourceClass and buildConfiguration from the base
  assert.equal(preview.ios?.simulator, true);
  assert.equal(preview.ios?.resourceClass, 'm-medium');
  assert.equal(preview.ios?.buildConfiguration, 'Release');
  // env names of root and platform sections, base and child, sorted
  assert.deepEqual(preview.envNames, ['ANDROID_ONLY', 'API_URL', 'FLAVOR', 'SENTRY_AUTH_TOKEN']);
  const base = profile(c, 'base');
  assert.deepEqual(base.extendsChain, ['base']);
  assert.equal(base.channel, null);
  assert.equal(base.distribution, 'store');
});

test('a platform section overrides the root value for that platform only', () => {
  const production = profile(config(analyze(FULL_EAS)), 'production');
  assert.equal(production.channel, 'production');
  assert.equal(production.ios?.channel, 'production-ios');
  assert.equal(production.android?.channel, 'production');
  assert.equal(production.ios?.autoIncrement, 'buildNumber');
  assert.equal(production.android?.autoIncrement, true);
  assert.equal(production.distribution, 'store');
});

test('submit profiles: iOS and Android fields, paths as written, the Apple ID is not kept', () => {
  const c = config(analyze(FULL_EAS));
  const production = c.submit.find((s) => s.name === 'production');
  assert.ok(production?.ios && production.android);
  assert.equal(production.ios.ascAppId, '1234567890');
  assert.equal(production.ios.appleTeamId, 'ABCDE12345');
  assert.equal(production.ios.ascApiKeyPath, './keys/AuthKey_ABC.p8');
  assert.equal(production.ios.metadataPath, './store.config.json');
  assert.deepEqual(production.ios.groups, ['Internal testers']);
  assert.equal(production.ios.hasAppleId, true);
  assert.equal(JSON.stringify(c).includes('dev@example.com'), false);
  assert.equal(production.android.track, 'production');
  assert.equal(production.android.releaseStatus, 'inProgress');
  assert.equal(production.android.rollout, 0.1);
  assert.equal(production.android.changesNotSentForReview, true);
  assert.equal(production.android.serviceAccountKeyPath, '$GOOGLE_SERVICE_ACCOUNT_KEY_PATH');
  assert.equal(production.android.applicationId, 'com.example.trailnotes');
});

test('a submit profile extends another and Google Play combinations are checked on the result', () => {
  const report = analyze(FULL_EAS);
  const preview = config(report).submit.find((s) => s.name === 'preview');
  assert.deepEqual(preview?.extendsChain, ['preview', 'production']);
  assert.equal(preview?.android?.track, 'internal');
  assert.equal(preview?.android?.rollout, 0.1, 'inherited');
  assert.equal(preview?.ios?.ascAppId, '1234567890');
  // preview inherits rollout 0.1 but sets releaseStatus completed: refused
  const finding = one(report, 'submit_rollout_needs_in_progress', 'preview');
  assert.equal(finding.severity, 'error');
  assert.equal(find(report, 'submit_rollout_needs_in_progress', 'production').length, 0);
});

const androidFindings = (android: Record<string, unknown>) =>
  codes(analyze(JSON.stringify({ submit: { production: { android } } }))).filter((c) =>
    c.startsWith('submit_'),
  );

test('Google Play: track, releaseStatus and rollout combinations', () => {
  assert.deepEqual(androidFindings({ track: 'production', releaseStatus: 'completed' }), []);
  assert.deepEqual(androidFindings({ track: 'internal', releaseStatus: 'draft' }), []);
  assert.deepEqual(
    androidFindings({ track: 'production', releaseStatus: 'inProgress', rollout: 0.25 }),
    [],
  );
  // a rollout without inProgress
  assert.deepEqual(androidFindings({ releaseStatus: 'completed', rollout: 0.5 }), [
    'submit_rollout_needs_in_progress',
  ]);
  assert.deepEqual(androidFindings({ releaseStatus: 'halted', rollout: 0.5 }), [
    'submit_rollout_needs_in_progress',
  ]);
  // inProgress needs a fraction, and Google's fraction is an open range
  assert.deepEqual(androidFindings({ releaseStatus: 'inProgress' }), [
    'submit_in_progress_needs_rollout',
  ]);
  assert.deepEqual(androidFindings({ releaseStatus: 'inProgress', rollout: 1 }), [
    'submit_rollout_out_of_range',
  ]);
  assert.deepEqual(androidFindings({ releaseStatus: 'inProgress', rollout: 0 }), [
    'submit_rollout_out_of_range',
  ]);
  // values the Expo reference does not list
  assert.deepEqual(androidFindings({ track: 'nightly' }), ['submit_track_unknown']);
  assert.deepEqual(androidFindings({ releaseStatus: 'rolling' }), ['submit_release_status_unknown']);
});

test('a rollout with no releaseStatus is a warning, with a wrong one an error', () => {
  const none = analyze('{"submit":{"p":{"android":{"rollout":0.5}}}}');
  assert.equal(one(none, 'submit_rollout_needs_in_progress').severity, 'warning');
  const wrong = analyze('{"submit":{"p":{"android":{"rollout":0.5,"releaseStatus":"draft"}}}}');
  assert.equal(one(wrong, 'submit_rollout_needs_in_progress').severity, 'error');
});

test('a submit profile without a build profile of its name is information', () => {
  const report = analyze(
    '{"build":{"production":{}},"submit":{"production":{},"store-only":{"ios":{}}}}',
  );
  const finding = one(report, 'submit_profile_without_build_profile');
  assert.equal(finding.profile, 'store-only');
  assert.equal(finding.severity, 'info');
  // nothing to compare with when there are no build profiles at all
  assert.equal(
    find(analyze('{"submit":{"x":{}}}'), 'submit_profile_without_build_profile').length,
    0,
  );
});

test('env: only the names are kept, and values that look like secrets are reported by key', () => {
  const report = analyze(FULL_EAS);
  const text = JSON.stringify(report);
  for (const value of [SECRET_TOKEN, SENTRY_TOKEN, 'do-not-keep-this-value', 'https://api.example.com']) {
    assert.equal(text.includes(value), false, `${value} must not appear`);
  }
  const keys = find(report, 'env_secret_like').map((f) => `${f.profile}:${f.key}`);
  assert.deepEqual(keys.sort(), ['preview:SENTRY_AUTH_TOKEN', 'production:GITHUB']);
  const finding = one(report, 'env_secret_like', 'production');
  assert.equal(finding.severity, 'warning');
  assert.equal(finding.key, 'GITHUB');
  assert.match(finding.message, /GITHUB/);
  // API_URL, FLAVOR and a $REFERENCE are fine
  assert.equal(keys.some((k) => /API_URL|FLAVOR|REF/.test(k)), false);
});

test('looksLikeSecret: names, shapes, references and plain values', () => {
  const yes: [string, string][] = [
    ['API_TOKEN', 'abc'],
    ['sentryAuthToken', 'abc'],
    ['DB_PASSWORD', 'hunter2'],
    ['CLIENT_SECRET', 'x'],
    ['STRIPE_API_KEY', 'x'],
    ['PRIVATE_KEY', 'x'],
    ['X', '-----BEGIN PRIVATE KEY-----abc'],
    ['X', 'ghp_0123456789abcdefghijklmnopqrstuvwxyz'],
    ['X', 'sk_live_abcdefghijklmnop'],
    ['X', 'AKIAABCDEFGHIJKLMNOP'],
    ['X', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij'],
    ['X', 'xoxb-1234567890-abcdefghij'],
    ['X', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2'],
  ];
  for (const [name, value] of yes) assert.equal(looksLikeSecret(name, value), true, `${name}`);
  const no: [string, unknown][] = [
    ['API_URL', 'https://api.example.com'],
    ['AUTHOR', 'someone'],
    ['KEY', 'value'],
    ['APP_ENV', 'production'],
    ['EXPO_PUBLIC_NAME', 'Trail Notes'],
    ['API_TOKEN', ''],
    ['API_TOKEN', '$TOKEN_FROM_CI'],
    ['API_TOKEN', '${TOKEN_FROM_CI}'],
    ['API_TOKEN', 12345],
    ['API_TOKEN', null],
    ['X', 'a-very-long-plain-word-without-any-digits-in-it-at-all-really'],
    ['X', '1234'],
  ];
  for (const [name, value] of no) assert.equal(looksLikeSecret(name, value), false, `${name}`);
});

test('comments and trailing commas are read and reported once', () => {
  const report = analyze(COMMENTED_EAS);
  const c = config(report);
  assert.equal(one(report, 'eas_json_lenient').severity, 'warning');
  assert.equal(c.cli.version, '>= 16.0.0');
  assert.equal(profile(c, 'production').channel, 'production');
  assert.deepEqual(profile(c, 'production').envNames, ['DOCS']);
  // valid JSON never gets that finding
  assert.equal(find(analyze(DEFAULT_EAS), 'eas_json_lenient').length, 0);
});

test('relaxJson keeps positions and leaves strings alone', () => {
  const text = '{ "a": "x // y", /* c */ "b": [1, 2,], // end\n}';
  const relaxed = relaxJson(text);
  assert.equal(relaxed.length, text.length);
  assert.deepEqual(JSON.parse(relaxed), { a: 'x // y', b: [1, 2] });
  const quoted = '{"a": "say \\"hi\\" // not a comment", }';
  assert.deepEqual(JSON.parse(relaxJson(quoted)), { a: 'say "hi" // not a comment' });
  assert.equal(relaxJson('{"a":1}'), '{"a":1}');
  // an unterminated comment does not hang or throw
  assert.equal(typeof relaxJson('{"a":1} /* never closed'), 'string');
});

test('parseJsonLenient: a byte order mark, valid, lenient and broken', () => {
  assert.deepEqual(parseJsonLenient('﻿{"a":1}'), { ok: true, value: { a: 1 }, lenient: false });
  assert.deepEqual(parseJsonLenient('{"a":1,}'), { ok: true, value: { a: 1 }, lenient: true });
  assert.equal(parseJsonLenient('{"a":').ok, false);
  assert.equal(parseJsonLenient('').ok, false);
});

test('malformed input: no model, one error, and the message never repeats the text', () => {
  const report = analyze(INVALID_EAS);
  assert.equal(report.config, null);
  const finding = one(report, 'eas_json_invalid');
  assert.equal(finding.severity, 'error');
  assert.equal(finding.scope, 'file');
  assert.equal(JSON.stringify(report).includes(SECRET_TOKEN), false);
  assert.equal(JSON.stringify(report).includes('API_TOKEN'), false);
  for (const bad of ['', '{', 'not json', '{"build": {"a": }}', 'nul', '{"a":1}}']) {
    const r = analyze(bad);
    assert.equal(r.config, null, bad);
    assert.deepEqual(codes(r), ['eas_json_invalid'], bad);
  }
});

test('a file that is JSON but not an object', () => {
  for (const text of ['[]', '"x"', '12', 'null', 'true']) {
    const r = analyze(text);
    assert.equal(r.config, null, text);
    assert.deepEqual(codes(r), ['eas_json_not_object'], text);
  }
});

test('a file over 1 MB is refused without parsing', () => {
  const r = analyze(`{"build":{"a":{"env":{"X":"${'x'.repeat(1_100_000)}"}}}}`);
  assert.equal(r.config, null);
  assert.deepEqual(codes(r), ['eas_json_too_large']);
});

test('an empty object and a file with only unknown keys are fine', () => {
  const empty = analyze('{}');
  const c = config(empty);
  assert.deepEqual([c.build, c.submit, c.unknownKeys], [[], [], []]);
  const unknown = analyze('{"build":{"p":{"channel":"c","frobnicate":{"token":"keep-out"}}},"x":1}');
  const u = config(unknown);
  assert.deepEqual(u.unknownKeys, ['x']);
  assert.deepEqual(profile(u, 'p').unknownKeys, ['frobnicate']);
  assert.equal(profile(u, 'p').channel, 'c');
  assert.equal(JSON.stringify(unknown).includes('keep-out'), false, 'values of unknown keys are not kept');
  assert.equal(one(unknown, 'unknown_keys', 'p').severity, 'info');
});

test('keys of the Expo reference are not reported as unknown', () => {
  const r = analyze(FULL_EAS);
  assert.deepEqual(
    find(r, 'unknown_keys').map((f) => f.profile ?? f.scope),
    ['file'],
  );
  assert.deepEqual(config(r).unknownKeys, ['x-future']);
});

test('extends cycles: a loop, a self reference, and a profile that leads into a loop', () => {
  const report = analyze(CYCLE_EAS);
  const c = config(report);
  const cycles = find(report, 'extends_cycle');
  assert.equal(cycles.length, 2, 'one for b <-> c, one for self (a only leads into it)');
  assert.ok(cycles.every((f) => f.severity === 'error'));
  assert.ok(cycles.some((f) => /"b" -> "c" -> "b"/.test(f.message)));
  assert.ok(cycles.some((f) => /"self" -> "self"/.test(f.message)));
  assert.deepEqual(profile(c, 'a').extendsChain, ['a', 'b', 'c']);
  assert.deepEqual(profile(c, 'b').extendsChain, ['b', 'c']);
  assert.deepEqual(profile(c, 'self').extendsChain, ['self']);
  assert.equal(profile(c, 'fine').channel, 'fine');
});

test('extends: a missing profile, a value that is not a name, and a missing submit profile', () => {
  const report = analyze(MISSING_EAS);
  const c = config(report);
  const missing = find(report, 'extends_missing').find((f) => f.scope === 'build');
  assert.ok(missing);
  assert.equal(missing.profile, 'child');
  assert.equal(missing.severity, 'error');
  assert.match(missing.message, /"nope"/);
  assert.equal(profile(c, 'child').channel, 'x', 'the profile is still read');
  assert.deepEqual(profile(c, 'child').extendsChain, ['child']);
  assert.equal(one(report, 'extends_invalid', 'other').severity, 'warning');
  const submit = report.findings.find((f) => f.code === 'extends_missing' && f.scope === 'submit');
  assert.ok(submit);
  assert.equal(profile(c, 'other').extends, null);
});

test('extends deeper than five steps is a warning and the chain stops there', () => {
  const report = analyze(DEEP_EAS);
  const c = config(report);
  const finding = one(report, 'extends_too_deep', 'p6');
  assert.equal(finding.severity, 'warning');
  assert.equal(profile(c, 'p5').extendsChain.length, 6, 'five steps are allowed');
  assert.equal(find(report, 'extends_too_deep', 'p5').length, 0);
  assert.equal(profile(c, 'p5').channel, 'zero');
  assert.equal(profile(c, 'p6').channel, null, 'the base was not reached');
});

test('keys named like Object.prototype members are ordinary keys', () => {
  const report = analyze(PROTO_EAS);
  const c = config(report);
  assert.deepEqual(
    c.build.map((b) => b.name),
    ['__proto__', 'constructor', 'ok'],
  );
  assert.equal(profile(c, '__proto__').channel, 'evil');
  assert.equal(profile(c, 'constructor').channel, 'evil', 'extends "__proto__" resolves to that profile');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(profile(c, 'ok').channel, null);
});

test('wrong types are findings; the rest of the file is still read', () => {
  const report = analyze(WRONG_TYPES_EAS);
  const c = config(report);
  assert.equal(one(report, 'section_invalid', undefined).scope, 'cli');
  assert.equal(one(report, 'profile_invalid', 'bad').severity, 'warning');
  const keys = find(report, 'invalid_value', 'typed').map((f) => f.key);
  for (const key of ['channel', 'developmentClient', 'autoIncrement', 'env', 'ios', 'android.buildType']) {
    assert.ok(keys.includes(key), `${key} in ${JSON.stringify(keys)}`);
  }
  assert.equal(profile(c, 'typed').channel, null);
  assert.equal(profile(c, 'typed').distribution, 'ota');
  assert.equal(one(report, 'distribution_unknown', 'typed').severity, 'warning');
  assert.equal(profile(c, 'good').channel, 'good');
  assert.equal(
    c.build.some((b) => b.name === 'bad'),
    false,
  );
  const submitKeys = find(report, 'invalid_value', 'typed').map((f) => f.key);
  assert.ok(submitKeys.includes('ios.ascAppId') && submitKeys.includes('ios.groups'));
  assert.ok(submitKeys.includes('android.rollout'));
  assert.equal(codes(report).includes('submit_track_unknown'), true);
});

test('"build" and "submit" that are not objects are findings', () => {
  const report = analyze('{"build":[],"submit":"x"}');
  assert.deepEqual(
    find(report, 'section_invalid').map((f) => f.scope),
    ['build', 'submit'],
  );
  assert.deepEqual(config(report).build, []);
});

test('more than 100 profiles: the rest is not read', () => {
  const build: Record<string, unknown> = {};
  for (let i = 0; i < 120; i++) build[`p${i}`] = { channel: `c${i}` };
  const report = analyze(JSON.stringify({ build }));
  assert.equal(config(report).build.length, 100);
  assert.equal(config(report).truncated, true);
  assert.equal(one(report, 'too_many_profiles').severity, 'warning');
});

test('a channel with developmentClient has no effect: information', () => {
  const report = analyze('{"build":{"dev":{"developmentClient":true,"channel":"dev"}}}');
  assert.equal(one(report, 'channel_ignored_dev_client', 'dev').severity, 'info');
  assert.equal(find(analyze(DEFAULT_EAS), 'channel_ignored_dev_client').length, 0);
});

test('releaseChannel is deprecated: information', () => {
  const report = analyze('{"build":{"p":{"releaseChannel":"default"}}}');
  assert.equal(one(report, 'release_channel_deprecated', 'p').severity, 'info');
  assert.equal(profile(config(report), 'p').releaseChannel, 'default');
});

// ---- the app config ------------------------------------------------------------------------

test('app.json: the fields that relate to eas.json', () => {
  const summary = readExpoAppConfig({ path: 'app.json', text: APP_UPDATES });
  assert.deepEqual(summary, {
    path: 'app.json',
    dynamicPath: null,
    unreadable: false,
    version: '1.4.0',
    runtimeVersion: { kind: 'policy', policy: 'appVersion' },
    iosRuntimeVersion: null,
    androidRuntimeVersion: null,
    updatesUrl: 'https://u.expo.dev/0cd3da2d-1111-2222-3333-444444444444',
    updatesEnabled: null,
    easProjectId: '0cd3da2d-1111-2222-3333-444444444444',
    iosBundleIdentifier: 'com.example.trailnotes',
    androidPackage: 'com.example.trailnotes',
    iosBuildNumber: '12',
    androidVersionCode: 34,
    updatesConfigured: true,
  });
});

test('an app config without the expo wrapper, a string runtime version and platform overrides', () => {
  const text = app(
    {
      version: '2.0.0',
      runtimeVersion: '2.0.0',
      ios: { runtimeVersion: { policy: 'fingerprint' } },
      android: { runtimeVersion: '2.0.1' },
    },
    false,
  );
  const summary = readExpoAppConfig({ path: 'app.config.json', text });
  assert.deepEqual(summary.runtimeVersion, { kind: 'string', value: '2.0.0' });
  assert.deepEqual(summary.iosRuntimeVersion, { kind: 'policy', policy: 'fingerprint' });
  assert.deepEqual(summary.androidRuntimeVersion, { kind: 'string', value: '2.0.1' });
  assert.equal(summary.updatesConfigured, false, 'a readable JSON config with no updates.url');
});

test('app config problems: not JSON, not an object, nothing at all, a dynamic file', () => {
  const broken = analyze(DEFAULT_EAS, '{ "expo": ');
  assert.equal(one(broken, 'app_config_unreadable').severity, 'warning');
  assert.equal(broken.app.unreadable, true);
  assert.equal(broken.app.updatesConfigured, null);
  assert.equal(find(broken, 'channel_without_updates').length, 0, 'nothing is claimed from a file that was not read');
  assert.equal(analyze(DEFAULT_EAS, '[]').app.unreadable, true);
  const none = analyze(DEFAULT_EAS);
  assert.equal(one(none, 'app_config_missing').severity, 'info');
  assert.equal(none.app.updatesConfigured, null);
  assert.equal(find(none, 'channel_without_updates').length, 0);
  const dynamic = analyze(DEFAULT_EAS, APP_PLAIN, { dynamic: 'app.config.ts' });
  assert.equal(one(dynamic, 'app_config_dynamic').severity, 'info');
  assert.equal(dynamic.app.updatesConfigured, null, 'the code may set updates.url');
  assert.equal(find(dynamic, 'channel_without_updates').length, 0);
  const dynamicOnly = analyze(DEFAULT_EAS, undefined, { dynamic: 'app.config.js' });
  assert.match(one(dynamicOnly, 'app_config_dynamic').message, /no JSON config/);
});

test('channels without expo-updates configured', () => {
  const report = analyze(DEFAULT_EAS, APP_PLAIN);
  const finding = one(report, 'channel_without_updates');
  assert.equal(finding.severity, 'warning');
  assert.match(finding.message, /"preview", "production"/);
  assert.equal(report.app.updatesConfigured, false);
  // with expo-updates configured the same channels are fine
  const ok = analyze(DEFAULT_EAS, APP_UPDATES);
  assert.equal(find(ok, 'channel_without_updates').length, 0);
});

test('updates.enabled false with channels is a warning', () => {
  const text = app({ version: '1', updates: { url: 'https://u.expo.dev/p', enabled: false } });
  const report = analyze(DEFAULT_EAS, text);
  assert.equal(one(report, 'updates_disabled_with_channel').severity, 'warning');
  assert.equal(report.app.updatesConfigured, false);
});

test('expo-updates configured but no channel in any build profile', () => {
  const report = analyze('{"build":{"production":{}}}', APP_UPDATES);
  assert.equal(one(report, 'updates_without_channel').severity, 'info');
  // only a development client profile: nothing to say
  const dev = analyze('{"build":{"development":{"developmentClient":true}}}', APP_UPDATES);
  assert.equal(find(dev, 'updates_without_channel').length, 0);
  // a channel only in a platform section counts
  const ios = analyze('{"build":{"p":{"ios":{"channel":"x"}}}}', APP_UPDATES);
  assert.equal(find(ios, 'updates_without_channel').length, 0);
  // no build profiles at all: no claim
  assert.equal(find(analyze('{}', APP_UPDATES), 'updates_without_channel').length, 0);
});

test('updates.url without a runtime version, and a project id that differs from the url', () => {
  const text = app({ version: '1', updates: { url: 'https://u.expo.dev/aaa' } });
  const report = analyze(DEFAULT_EAS, text);
  assert.equal(one(report, 'updates_without_runtime_version').severity, 'warning');
  const mismatch = app({
    version: '1',
    runtimeVersion: '1.0.0',
    updates: { url: 'https://u.expo.dev/aaa' },
    extra: { eas: { projectId: 'bbb' } },
  });
  const r2 = analyze(DEFAULT_EAS, mismatch);
  assert.equal(one(r2, 'updates_url_project_mismatch').severity, 'warning');
  assert.equal(find(r2, 'updates_without_runtime_version').length, 0);
  assert.equal(find(analyze(DEFAULT_EAS, APP_UPDATES), 'updates_url_project_mismatch').length, 0);
  // a runtime version set for one platform only is enough to say there is one
  const ios = app({
    version: '1',
    updates: { url: 'https://u.expo.dev/aaa' },
    ios: { runtimeVersion: '1.0.0' },
  });
  assert.equal(find(analyze(DEFAULT_EAS, ios), 'updates_without_runtime_version').length, 0);
});

test('runtime version: string format, policies, and what a policy needs', () => {
  const run = (runtimeVersion: unknown, extra: Record<string, unknown> = {}) =>
    analyze(
      '{"cli":{"appVersionSource":"local"}}',
      app({ version: '1.0.0', updates: { url: 'https://u.expo.dev/p' }, runtimeVersion, ...extra }),
    );
  assert.deepEqual(codes(run('1.0.0')).filter((c) => c.startsWith('runtime_')), []);
  assert.deepEqual(codes(run('exposdk:52.0.0')).filter((c) => c.startsWith('runtime_')), []);
  assert.equal(one(run('1.0 0'), 'runtime_version_invalid').severity, 'warning');
  assert.equal(find(run('-1'), 'runtime_version_invalid').length, 1);
  assert.equal(find(run('x'.repeat(256)), 'runtime_version_invalid').length, 1);
  assert.equal(find(run('x'.repeat(255)), 'runtime_version_invalid').length, 0);
  for (const policy of ['appVersion', 'nativeVersion', 'sdkVersion', 'fingerprint']) {
    assert.equal(find(run({ policy }), 'runtime_policy_unknown').length, 0, policy);
  }
  assert.equal(one(run({ policy: 'custom' }), 'runtime_policy_unknown').severity, 'warning');
  assert.equal(one(run(7), 'app_config_invalid_value').severity, 'warning');
  const noVersion = analyze(
    '{}',
    app({ updates: { url: 'https://u.expo.dev/p' }, runtimeVersion: { policy: 'appVersion' } }),
  );
  assert.equal(one(noVersion, 'runtime_policy_needs_version').severity, 'warning');
  // fingerprint needs no version
  const fingerprint = analyze(
    '{}',
    app({ updates: { url: 'https://u.expo.dev/p' }, runtimeVersion: { policy: 'fingerprint' } }),
  );
  assert.equal(find(fingerprint, 'runtime_policy_needs_version').length, 0);
});

test('nativeVersion policy with a remote version source is flagged as information', () => {
  const text = app({
    version: '1.0.0',
    updates: { url: 'https://u.expo.dev/p' },
    runtimeVersion: { policy: 'nativeVersion' },
  });
  const remote = analyze('{"cli":{"appVersionSource":"remote"}}', text);
  assert.equal(one(remote, 'runtime_policy_native_version').severity, 'info');
  const local = analyze('{"cli":{"appVersionSource":"local"}}', text);
  assert.equal(find(local, 'runtime_policy_native_version').length, 0);
});

test('a submit profile that names another identifier than the app config', () => {
  const eas = JSON.stringify({
    submit: {
      production: {
        ios: { bundleIdentifier: 'com.other.app' },
        android: { applicationId: 'com.other.app' },
      },
      ok: { ios: { bundleIdentifier: 'com.example.trailnotes' } },
    },
  });
  const report = analyze(eas, APP_PLAIN);
  const keys = find(report, 'submit_identifier_mismatch').map((f) => `${f.profile}:${f.key}`);
  assert.deepEqual(keys.sort(), ['production:android.applicationId', 'production:ios.bundleIdentifier']);
  assert.equal(find(analyze(eas), 'submit_identifier_mismatch').length, 0, 'no app config: nothing to compare');
});

// ---- from a repository ---------------------------------------------------------------------

const reader = (files: Record<string, string>) => {
  const reads: string[] = [];
  return {
    reads,
    list: Object.keys(files),
    read: async (path: string) => {
      reads.push(path);
      return files[path];
    },
  };
};

test('readEasConfig reads eas.json and the JSON app config at the root, nothing else', async () => {
  const repo = reader({
    'eas.json': DEFAULT_EAS,
    'app.json': APP_UPDATES,
    'package.json': '{}',
    'src/App.tsx': 'x',
  });
  const result = await readEasConfig(repo.list, repo.read);
  assert.equal(result.found, true);
  assert.ok(result.found);
  assert.equal(result.path, 'eas.json');
  assert.equal(result.app.path, 'app.json');
  assert.equal(config(result).build.length, 3);
  assert.deepEqual([...repo.reads].sort(), ['app.json', 'eas.json']);
});

test('app.config.json is preferred over app.json, and a dynamic config is only named', async () => {
  const repo = reader({
    'eas.json': '{}',
    'app.config.json': app({ version: '9.9.9' }),
    'app.json': app({ version: '1.0.0' }),
    'app.config.ts': 'export default {}',
  });
  const result = await readEasConfig(repo.list, repo.read);
  assert.ok(result.found);
  assert.equal(result.app.path, 'app.config.json');
  assert.equal(result.app.version, '9.9.9');
  assert.equal(result.app.dynamicPath, 'app.config.ts');
  assert.deepEqual(repo.reads.sort(), ['app.config.json', 'eas.json'], 'the dynamic file is never read');
});

test('no eas.json at the root: found false, with the ones in subfolders', async () => {
  const repo = reader({
    'package.json': '{}',
    'apps/mobile/eas.json': '{}',
    'apps/web/eas.json': '{}',
    'node_modules/pkg/eas.json': '{}',
    'app.json': APP_PLAIN,
  });
  const result = await readEasConfig(repo.list, repo.read);
  assert.equal(result.found, false);
  assert.ok(!result.found);
  assert.equal(result.reason, 'no_eas_json');
  assert.deepEqual(result.nested, ['apps/mobile/eas.json', 'apps/web/eas.json']);
  assert.match(result.message, /Only the root is read/);
  assert.equal(result.app.iosBundleIdentifier, 'com.example.trailnotes');
  const bare = await readEasConfig([], async () => undefined);
  assert.ok(!bare.found);
  assert.equal(bare.message, 'There is no eas.json at the repository root.');
  assert.deepEqual(bare.nested, []);
});

test('an eas.json that is listed but cannot be read counts as missing', async () => {
  const result = await readEasConfig(['eas.json'], async () => undefined);
  assert.equal(result.found, false);
});

test('an eas.json that is not valid JSON is found, with no model', async () => {
  const repo = reader({ 'eas.json': INVALID_EAS });
  const result = await readEasConfig(repo.list, repo.read);
  assert.ok(result.found);
  assert.equal(result.config, null);
  assert.deepEqual(codes(result), ['eas_json_invalid']);
});
