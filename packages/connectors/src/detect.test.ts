import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectProject } from './detect.ts';

type Repo = Record<string, string>;

const detect = (repo: Repo) => detectProject(Object.keys(repo), async (path) => repo[path]);

const omit = (repo: Repo, ...keys: string[]): Repo =>
  Object.fromEntries(Object.entries(repo).filter(([key]) => !keys.includes(key)));

const classic: Repo = {
  Gemfile: "source 'https://rubygems.org'\ngem 'fastlane'\n",
  'fastlane/Appfile': 'app_identifier("com.example.trail")\napple_id("dev@example.com")\n',
  'fastlane/Fastfile': [
    'default_platform(:ios)',
    'platform :ios do',
    '  lane :beta do',
    '    # upload_to_play_store would be a comment',
    '    upload_to_testflight',
    '  end',
    'end',
  ].join('\n'),
  'fastlane/metadata/en-US/name.txt': 'Trail',
  'fastlane/metadata/en-US/description.txt': 'Trail notes',
  'fastlane/metadata/de-DE/name.txt': 'Weg',
  'fastlane/metadata/default/support_url.txt': 'https://example.com',
  'fastlane/metadata/review_information/notes.txt': 'n',
  'fastlane/screenshots/en-US/1_iphone.png': 'x',
  'fastlane/metadata/android/en-US/title.txt': 'Trail',
  'fastlane/metadata/android/en-US/images/icon.png': 'x',
  'fastlane/metadata/android/en-US/changelogs/42.txt': 'x',
};

test('a classic fastlane project', async () => {
  const d = await detect(classic);
  assert.equal(d.kind, 'fastlane');
  assert.deepEqual(d.platforms, ['android', 'ios']);
  assert.deepEqual(d.locales, { ios: ['de-DE', 'en-US'], android: ['en-US'] });
  assert.equal(d.paths.iosMetadata, 'fastlane/metadata');
  assert.equal(d.paths.androidMetadata, 'fastlane/metadata/android');
  assert.equal(d.paths.iosScreenshots, 'fastlane/screenshots');
  assert.equal(d.paths.androidImages, 'fastlane/metadata/android');
  assert.deepEqual(d.paths.fastfiles, ['fastlane/Fastfile']);
  assert.equal(d.expo, undefined);
  assert.deepEqual(d.warnings, []);
});

test('a comment in the Fastfile is not evidence', async () => {
  const d = await detect({
    'fastlane/Fastfile': '# platform :android\n# upload_to_play_store\n',
  });
  assert.equal(d.kind, 'fastlane');
  assert.deepEqual(d.platforms, []);
  assert.deepEqual(d.platformsInferred, []);
  assert.match(d.warnings.join('\n'), /no metadata folder/);
});

test('Fastfile contents only ever infer a platform', async () => {
  const d = await detect({
    'fastlane/Fastfile': 'platform :android do\n  upload_to_play_store\nend\n',
  });
  assert.deepEqual(d.platforms, []);
  assert.deepEqual(d.platformsInferred, ['android']);
  assert.ok(d.evidence.every((e) => !e.platform || e.strength === 'inferred'));
});

test('metadata files without a fastlane folder are a guess, not a fastlane project', async () => {
  const d = await detect({ 'metadata/en-US/name.txt': 'x', 'metadata/en-US/description.txt': 'y' });
  assert.equal(d.kind, 'unknown');
  assert.deepEqual(d.platforms, []);
  assert.deepEqual(d.platformsInferred, ['ios']);
  assert.deepEqual(d.locales.ios, ['en-US']);
  assert.match(d.warnings.join('\n'), /not treated as a fastlane project/);
});

const expoFiles: Repo = {
  'package.json': JSON.stringify({ dependencies: { expo: '~52.0.0', react: '18' } }),
  'app.json': JSON.stringify({
    expo: {
      name: 'Trail',
      slug: 'trail',
      version: '1.2.3',
      ios: { bundleIdentifier: 'com.example.trail' },
      android: { package: 'com.example.trail' },
    },
  }),
  'eas.json': JSON.stringify({
    cli: { version: '>= 10' },
    build: { development: {}, production: {} },
    submit: { production: { ios: { ascAppId: '1' } } },
  }),
  'store.config.json': JSON.stringify({
    configVersion: 0,
    apple: { info: { 'en-US': { title: 'Trail' }, ja: { title: 'T' } } },
  }),
};

test('an Expo project with EAS Metadata', async () => {
  const d = await detect(expoFiles);
  assert.equal(d.kind, 'expo');
  assert.deepEqual(d.platforms, ['android', 'ios']);
  assert.deepEqual(d.locales, { ios: ['en-US', 'ja'], android: [] });
  assert.equal(d.expo?.name, 'Trail');
  assert.equal(d.expo?.iosBundleIdentifier, 'com.example.trail');
  assert.equal(d.expo?.androidPackage, 'com.example.trail');
  assert.deepEqual(d.expo?.buildProfiles, ['development', 'production']);
  assert.deepEqual(d.expo?.submitProfiles, ['production']);
  assert.deepEqual(d.expo?.storeConfigs, [{ path: 'store.config.json', dynamic: false }]);
  // Google Play listings are not covered by EAS Metadata.
  assert.match(d.warnings.join('\n'), /does not manage Google Play/);
});

test('eas.json can point to a store config elsewhere', async () => {
  const d = await detect({
    ...omit(expoFiles, 'store.config.json'),
    'eas.json': JSON.stringify({
      submit: { production: { ios: { metadataPath: './config/store.json' } } },
    }),
    'config/store.json': JSON.stringify({ configVersion: 0, apple: { info: { fr: {} } } }),
  });
  assert.deepEqual(d.expo?.storeConfigs, [
    { path: 'config/store.json', profile: 'production', dynamic: false },
  ]);
  assert.deepEqual(d.locales.ios, ['fr']);
});

test('a missing or dynamic store config is reported, not guessed', async () => {
  const missing = await detect({
    ...omit(expoFiles, 'store.config.json'),
    'eas.json': JSON.stringify({ submit: { production: { ios: { metadataPath: 'nope.json' } } } }),
  });
  assert.match(missing.warnings.join('\n'), /nope\.json.*not in the repository/);
  const dynamic = await detect({
    'package.json': expoFiles['package.json'] as string,
    'eas.json': JSON.stringify({
      submit: { production: { ios: { metadataPath: 'store.config.js' } } },
    }),
    'store.config.js': 'module.exports = {}',
  });
  assert.deepEqual(dynamic.expo?.storeConfigs, [
    { path: 'store.config.js', profile: 'production', dynamic: true },
  ]);
  assert.deepEqual(dynamic.locales.ios, []);
  assert.match(dynamic.warnings.join('\n'), /store\.config\.js is code and was not run/);
});

test('a dynamic app config is never evaluated', async () => {
  const d = await detect({
    'package.json': expoFiles['package.json'] as string,
    'app.config.ts': 'export default () => ({ name: "x" })',
  });
  assert.equal(d.kind, 'expo');
  assert.deepEqual(d.platforms, []);
  assert.equal(d.expo?.dynamicConfig, true);
  assert.equal(d.expo?.name, undefined);
  assert.match(d.warnings.join('\n'), /app\.config\.ts is code and was not run/);
});

test('bare React Native app.json and a lone eas.json are not Expo', async () => {
  const bare = await detect({
    'app.json': JSON.stringify({ name: 'Trail', displayName: 'Trail' }),
  });
  assert.equal(bare.kind, 'unknown');
  const lone = await detect({ 'eas.json': '{"build":{}}' });
  assert.equal(lone.kind, 'unknown');
  assert.match(lone.warnings.join('\n'), /nothing else says this is an Expo project/);
});

test('app.json with a slug but no expo key is only inferred to be Expo', async () => {
  const d = await detect({ 'app.json': JSON.stringify({ name: 'Trail', slug: 'trail' }) });
  assert.equal(d.kind, 'unknown');
  assert.equal(d.evidence[0]?.strength, 'inferred');
});

test('an Expo project that also uses fastlane is both', async () => {
  const d = await detect({ ...expoFiles, ...classic });
  assert.equal(d.kind, 'both');
  assert.deepEqual(d.locales.ios, ['de-DE', 'en-US', 'ja']);
  assert.deepEqual(d.locales.android, ['en-US']);
});

test('native folders are inferred platform evidence only', async () => {
  const d = await detect({
    ...expoFiles,
    'app.json': JSON.stringify({ expo: { name: 'T', slug: 't' } }),
    'ios/Podfile': '',
    'android/app/build.gradle': '',
  });
  assert.deepEqual(d.platforms, ['ios']); // from the store config only
  assert.deepEqual(d.platformsInferred, ['android']);
});

test('invalid JSON is a warning, never a throw', async () => {
  const d = await detect({ 'app.json': '{', 'eas.json': '{', 'package.json': '{' });
  assert.equal(d.kind, 'unknown');
  assert.equal(d.warnings.length >= 3, true);
});

test('files in dependencies and build folders are ignored', async () => {
  const d = await detect({
    'node_modules/pkg/fastlane/Fastfile': '',
    'ios/Pods/x/fastlane/metadata/en-US/name.txt': '',
  });
  assert.equal(d.kind, 'unknown');
  assert.deepEqual(d.evidence, []);
});

test('nested Expo configs (monorepos) are reported, not inspected', async () => {
  const d = await detect({ 'apps/mobile/app.json': '{"expo":{}}', 'apps/mobile/eas.json': '{}' });
  assert.equal(d.kind, 'unknown');
  assert.match(d.warnings.join('\n'), /subfolders was not inspected/);
});

test('fastlane inside ios/ and android/ folders (React Native layout) is found', async () => {
  const d = await detect({
    'ios/fastlane/Fastfile': 'platform :ios do\nend\n',
    'ios/fastlane/metadata/en-US/name.txt': 'x',
    'ios/Podfile': '',
  });
  assert.equal(d.kind, 'fastlane');
  assert.deepEqual(d.paths.fastlaneDirs, ['ios/fastlane']);
  assert.equal(d.paths.iosMetadata, 'ios/fastlane/metadata');
  assert.deepEqual(d.platforms, ['ios']);
});
