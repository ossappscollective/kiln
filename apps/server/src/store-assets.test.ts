import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appHints,
  discoverProjectIcons,
  discoverStoreAssets,
  expoIconPaths,
  orderWithinSets,
  previewFolders,
  resolveRelative,
  screenshotFolders,
} from './services/store-assets.ts';

/** Which files are store media. Pure: lists of paths in, candidates out. */

const IOS = { appStore: 'fastlane/metadata', googlePlay: '' };
const summary = (
  files: string[],
  roots: { appStore: string; googlePlay: string },
  store: 'app_store' | 'google_play',
) =>
  discoverStoreAssets(files, roots, store).candidates.map((c) => [
    c.path,
    c.locale,
    c.kind,
    c.device,
    c.imessage,
  ]);

test('the screenshot folders: inside the locale root, and next to a metadata folder', () => {
  assert.deepEqual(screenshotFolders('fastlane/metadata'), [
    'fastlane/metadata/screenshots',
    'fastlane/screenshots',
  ]);
  assert.deepEqual(screenshotFolders('metadata'), ['metadata/screenshots', 'screenshots']);
  assert.deepEqual(screenshotFolders('fastlane/metadata/ios'), [
    'fastlane/metadata/ios/screenshots',
  ]);
  assert.deepEqual(screenshotFolders('store/apple'), ['store/apple/screenshots']);
  assert.deepEqual(previewFolders('fastlane/metadata'), [
    'fastlane/metadata/app-previews',
    'fastlane/app-previews',
  ]);
});

test('App Store: png, jpg and jpeg in any case, the iMessage and appleTV folders, default, previews', () => {
  const files = [
    'fastlane/screenshots/en-US/1.png',
    'fastlane/screenshots/en-US/2.JPG',
    'fastlane/screenshots/en-US/3.jpeg',
    'fastlane/screenshots/en-US/4.webp',
    'fastlane/screenshots/en-US/5.gif',
    'fastlane/screenshots/en-US/README.md',
    'fastlane/screenshots/default/1.png',
    'fastlane/screenshots/iMessage/fr-FR/1.png',
    'fastlane/screenshots/appleTV/de-DE/1.png',
    'fastlane/screenshots/not a locale/1.png',
    'fastlane/screenshots/en-US/deep/er/1.png',
    'fastlane/app-previews/en-US/IPHONE_67_1.mp4',
    'fastlane/app-previews/en-US/clip.mov',
    'fastlane/app-previews/en-US/notes.txt',
    'node_modules/pkg/screenshots/en-US/1.png',
    'fastlane/metadata/en-US/name.txt',
  ];
  const d = discoverStoreAssets(files, IOS, 'app_store');
  const byPath = new Map(d.candidates.map((c) => [c.path, c]));
  assert.deepEqual([...byPath.keys()].sort(), [
    'fastlane/app-previews/en-US/IPHONE_67_1.mp4',
    'fastlane/app-previews/en-US/clip.mov',
    'fastlane/screenshots/appleTV/de-DE/1.png',
    'fastlane/screenshots/default/1.png',
    'fastlane/screenshots/en-US/1.png',
    'fastlane/screenshots/en-US/2.JPG',
    'fastlane/screenshots/en-US/3.jpeg',
    'fastlane/screenshots/iMessage/fr-FR/1.png',
  ]);
  assert.equal(byPath.get('fastlane/screenshots/iMessage/fr-FR/1.png')?.imessage, true);
  assert.equal(byPath.get('fastlane/screenshots/iMessage/fr-FR/1.png')?.locale, 'fr-FR');
  assert.equal(byPath.get('fastlane/screenshots/appleTV/de-DE/1.png')?.imessage, false);
  assert.equal(byPath.get('fastlane/screenshots/default/1.png')?.locale, 'default');
  assert.equal(byPath.get('fastlane/screenshots/en-US/2.JPG')?.extension, 'jpg');
  assert.equal(byPath.get('fastlane/app-previews/en-US/IPHONE_67_1.mp4')?.kind, 'preview');
  assert.equal(byPath.get('fastlane/app-previews/en-US/clip.mov')?.device, null);
  assert.ok(
    byPath.get('fastlane/app-previews/en-US/IPHONE_67_1.mp4')?.device,
    'the device of a preview comes from its name',
  );
  assert.match(d.notes.join(' '), /2 image files .* not .png, .jpg or .jpeg/);
  assert.equal(
    d.candidates.every((c) => c.origin === 'store'),
    true,
  );
});

test('a store that is not read, or an empty root, finds nothing', () => {
  const files = [
    'fastlane/screenshots/en-US/1.png',
    'fastlane/metadata/android/en-US/images/icon.png',
  ];
  assert.deepEqual(
    discoverStoreAssets(files, { appStore: '', googlePlay: '' }, 'app_store').candidates,
    [],
  );
  assert.deepEqual(
    discoverStoreAssets(files, { appStore: '', googlePlay: '' }, 'google_play').candidates,
    [],
  );
  assert.deepEqual(
    summary(files, { appStore: 'fastlane/metadata', googlePlay: '' }, 'google_play'),
    [],
  );
});

test('Google Play: graphics and every screenshot folder, per locale', () => {
  const root = 'fastlane/metadata/android';
  const files = [
    `${root}/en-US/images/icon.png`,
    `${root}/en-US/images/featureGraphic.jpg`,
    `${root}/en-US/images/promoGraphic.png`,
    `${root}/en-US/images/tvBanner.png`,
    `${root}/en-US/images/other.png`,
    `${root}/en-US/images/phoneScreenshots/1.png`,
    `${root}/en-US/images/sevenInchScreenshots/1.png`,
    `${root}/en-US/images/tenInchScreenshots/1.png`,
    `${root}/en-US/images/tvScreenshots/1.png`,
    `${root}/en-US/images/wearScreenshots/1.png`,
    `${root}/en-US/images/miscScreenshots/1.png`,
    `${root}/fr-FR/images/phoneScreenshots/2.webp`,
    `${root}/en-US/title.txt`,
    `${root}/images/icon.png`,
  ];
  const d = discoverStoreAssets(files, { appStore: '', googlePlay: root }, 'google_play');
  const got = new Map(
    d.candidates.map((c) => [c.path.slice(root.length + 1), `${c.kind}:${c.device ?? ''}`]),
  );
  assert.deepEqual(Object.fromEntries(got), {
    'en-US/images/icon.png': 'icon:',
    'en-US/images/featureGraphic.jpg': 'feature_graphic:',
    'en-US/images/promoGraphic.png': 'promo_graphic:',
    'en-US/images/tvBanner.png': 'tv_banner:',
    'en-US/images/phoneScreenshots/1.png': 'screenshot:phone',
    'en-US/images/sevenInchScreenshots/1.png': 'screenshot:tablet_7',
    'en-US/images/tenInchScreenshots/1.png': 'screenshot:tablet_10',
    'en-US/images/tvScreenshots/1.png': 'screenshot:tv',
    'en-US/images/wearScreenshots/1.png': 'screenshot:wear',
  });
  assert.equal(d.folders.androidImages, root);
  assert.match(d.notes.join(' '), /1 image file/);
});

test('candidates come most important first (the GitHub budget reads icons and graphics before screenshots)', () => {
  const root = 'm';
  const files = [
    'm/en-US/images/phoneScreenshots/1.png',
    'm/en-US/images/featureGraphic.png',
    'm/en-US/images/icon.png',
  ];
  const kinds = discoverStoreAssets(
    files,
    { appStore: '', googlePlay: root },
    'google_play',
  ).candidates.map((c) => c.kind);
  assert.deepEqual(kinds, ['icon', 'feature_graphic', 'screenshot']);
});

test('order within a set follows the file name, as deliver and Google Play do', () => {
  const items = ['b/10.png', 'b/2.png', 'b/1.png', 'a/9.png'].map((path) => ({
    path,
    locale: 'en-US',
    kind: 'screenshot' as const,
    device: path.startsWith('a') ? 'x' : 'y',
  }));
  const order = orderWithinSets(items);
  assert.equal(order.get('b/1.png'), 1);
  assert.equal(order.get('b/10.png'), 2, 'code point order: "10.png" sorts before "2.png"');
  assert.equal(order.get('b/2.png'), 3);
  assert.equal(order.get('a/9.png'), 1, 'another device is its own set');
});

test('relative paths of an Expo config never leave the repository', () => {
  assert.equal(resolveRelative('', './assets/icon.png'), 'assets/icon.png');
  assert.equal(resolveRelative('apps/x', '../shared/icon.png'), 'apps/shared/icon.png');
  assert.equal(resolveRelative('', '../icon.png'), undefined);
  assert.equal(resolveRelative('', '/etc/passwd'), undefined);
  assert.equal(resolveRelative('', 'a\\b.png'), undefined);
  assert.equal(resolveRelative('', 'a/../../b.png'), undefined);
});

test('Expo: the platform icon first, then the general icon; nothing for broken or odd config', () => {
  const json = JSON.stringify({
    expo: {
      icon: './assets/icon.png',
      ios: { icon: './assets/ios.png' },
      android: { icon: './assets/droid.jpg' },
    },
  });
  assert.deepEqual(expoIconPaths(json, 'ios'), ['assets/ios.png', 'assets/icon.png']);
  assert.deepEqual(expoIconPaths(json, 'android'), ['assets/droid.jpg', 'assets/icon.png']);
  assert.deepEqual(
    expoIconPaths(JSON.stringify({ icon: 'icon.png' }), 'ios'),
    ['icon.png'],
    'a bare config without the expo key',
  );
  assert.deepEqual(expoIconPaths(JSON.stringify({ expo: { icon: './icon.svg' } }), 'ios'), []);
  assert.deepEqual(
    expoIconPaths(JSON.stringify({ expo: { icon: '../../outside.png' } }), 'ios'),
    [],
  );
  assert.deepEqual(
    expoIconPaths(JSON.stringify({ expo: { icon: `./${'a'.repeat(400)}.png` } }), 'ios'),
    [],
  );
  assert.deepEqual(expoIconPaths(JSON.stringify({ expo: { icon: 5 } }), 'ios'), []);
  assert.deepEqual(expoIconPaths('{ not json', 'ios'), []);
  assert.deepEqual(expoIconPaths('[]', 'ios'), []);
  assert.deepEqual(expoIconPaths('null', 'ios'), []);
  assert.deepEqual(expoIconPaths(undefined, 'ios'), []);
});

test('project icons: an Xcode icon set and the largest Android launcher icon, tied to the app by name when several exist', () => {
  const hints = appHints('com.acme.coffee', 'Coffee Time');
  assert.ok(
    hints.includes('coffee') && hints.includes('com.acme.coffee') && hints.includes('coffeetime'),
  );
  const one = discoverProjectIcons(
    [
      'App/Assets.xcassets/AppIcon.appiconset/icon-1024.png',
      'App/Assets.xcassets/AppIcon.appiconset/Contents.json',
    ],
    { platform: 'ios', store: 'app_store', expoPaths: [], hints },
  );
  assert.deepEqual(
    one.candidates.map((c) => c.path),
    ['App/Assets.xcassets/AppIcon.appiconset/icon-1024.png'],
  );
  assert.equal(one.candidates[0]?.kind, 'app_icon');
  assert.equal(one.candidates[0]?.origin, 'project');

  const two = [
    'Coffee/Assets.xcassets/AppIcon.appiconset/a.png',
    'Tea/Assets.xcassets/AppIcon.appiconset/a.png',
  ];
  assert.deepEqual(
    discoverProjectIcons(two, {
      platform: 'ios',
      store: 'app_store',
      expoPaths: [],
      hints,
    }).candidates.map((c) => c.path),
    ['Coffee/Assets.xcassets/AppIcon.appiconset/a.png'],
  );
  const unnamed = discoverProjectIcons(two, {
    platform: 'ios',
    store: 'app_store',
    expoPaths: [],
    hints: appHints('com.acme.other', 'Other'),
  });
  assert.deepEqual(unnamed.candidates, []);
  assert.match(unnamed.notes.join(' '), /2 Xcode app icon sets; none could be tied/);

  const droid = discoverProjectIcons(
    [
      'app/src/main/res/mipmap-mdpi/ic_launcher.png',
      'app/src/main/res/mipmap-xxxhdpi/ic_launcher.png',
      'app/src/main/res/mipmap-hdpi/ic_launcher.png',
      'app/src/main/res/mipmap-xxhdpi/ic_launcher_round.png',
    ],
    { platform: 'android', store: 'google_play', expoPaths: [], hints },
  );
  assert.deepEqual(
    droid.candidates.map((c) => c.path),
    ['app/src/main/res/mipmap-xxxhdpi/ic_launcher.png'],
  );

  const expo = discoverProjectIcons(['assets/icon.png'], {
    platform: 'ios',
    store: 'app_store',
    expoPaths: ['assets/icon.png', 'assets/missing.png'],
    hints,
  });
  assert.deepEqual(
    expo.candidates.map((c) => c.path),
    ['assets/icon.png'],
    'only files that exist',
  );
  const ignored = discoverProjectIcons(
    ['node_modules/x/AppIcon.appiconset/a.png', 'Pods/y/AppIcon.appiconset/a.png'],
    { platform: 'ios', store: 'app_store', expoPaths: [], hints },
  );
  assert.deepEqual(ignored.candidates, []);
});
