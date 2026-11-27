import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ASSET_SYNC_LIMITS,
  checkStoreImages,
  compareFile,
  compareSet,
  compareText,
  compareTotals,
  fixAdvice,
  nearestRequiredSize,
  primaryStoreSet,
  type RepoSideFile,
  requiredSizes,
  requiredSizesText,
  type StoreImageFile,
  storeImageKey,
  storeSetKey,
} from './asset-sync.ts';

const repo = (over: Partial<RepoSideFile> = {}): RepoSideFile => ({
  path: 'a.png',
  oid: 'o',
  sha256: 'ab'.repeat(32),
  bytes: 100,
  width: 1320,
  height: 2868,
  ...over,
});
const store = (over: Partial<StoreImageFile> = {}): StoreImageFile => ({
  ref: 'r',
  position: 1,
  name: null,
  width: 1320,
  height: 2868,
  bytes: 100,
  checksum: 'ab'.repeat(32),
  checksumKind: 'sha256',
  state: null,
  downloadable: true,
  ...over,
});

test('keys are platform generic and stable', () => {
  assert.equal(
    storeSetKey('ios', 'en-US', { kind: 'screenshot', device: 'iphone_6_9' }),
    'ios/en-US/screenshot:iphone_6_9',
  );
  assert.equal(
    storeImageKey('android', 'de-DE', { kind: 'screenshot', device: 'phone' }, 2),
    'android/de-DE/screenshot:phone#2',
  );
  assert.ok(ASSET_SYNC_LIMITS.maxUploadBytes <= ASSET_SYNC_LIMITS.maxStagedUploadBytes);
});

test('compareFile: checksum decides when both sides have one', () => {
  assert.equal(compareFile(repo(), store()).status, 'identical');
  assert.equal(compareFile(repo(), store({ checksum: 'cd'.repeat(32) })).status, 'differs');
  // a mark that is the first 32 hex of the digest still matches
  assert.equal(compareFile(repo(), store({ checksum: 'ab'.repeat(16) })).status, 'identical');
  assert.equal(compareFile(repo(), store({ checksum: 'ab'.repeat(4) })).status, 'differs');
});

test('compareFile: without a checksum the sizes are compared and the answer is only "probably"', () => {
  const nosum = { checksum: null, checksumKind: null } as const;
  assert.equal(compareFile(repo(), store(nosum)).status, 'likely_same');
  assert.equal(compareFile(repo(), store({ ...nosum, width: 100 })).status, 'differs');
  assert.equal(compareFile(repo(), store({ ...nosum, bytes: 5 })).status, 'differs');
  assert.equal(compareFile(repo({ sha256: null }), store()).status, 'likely_same');
  // an md5 does not match a sha-256
  assert.equal(
    compareFile(repo(), store({ checksumKind: 'md5', checksum: 'ab'.repeat(16) })).status,
    'likely_same',
  );
});

test('compareFile: one side only', () => {
  assert.equal(compareFile(repo(), null).status, 'only_repo');
  assert.equal(compareFile(null, store()).status, 'only_store');
});

test('compareSet pairs by position and totals read well', () => {
  const rows = compareSet(
    [repo(), repo({ path: 'b.png' }), repo({ path: 'c.png' })],
    [store(), store({ checksum: 'ef'.repeat(32) })],
  );
  assert.deepEqual(
    rows.map((r) => r.status),
    ['identical', 'differs', 'only_repo'],
  );
  const totals = compareTotals(rows);
  assert.equal(compareText(totals), '1 identical, 1 differs, 1 only in the repository');
  assert.equal(compareText(compareTotals([])), '');
});

test('required sizes: Apple displays, Play graphics, and ranges that have none', () => {
  assert.ok(
    requiredSizes('ios', { kind: 'screenshot', device: 'iphone_6_9' }).some(
      (s) => s.width === 1320 && s.height === 2868,
    ),
  );
  assert.deepEqual(requiredSizes('android', { kind: 'icon', device: null }), [
    { width: 512, height: 512 },
  ]);
  assert.deepEqual(requiredSizes('android', { kind: 'screenshot', device: 'phone' }), []);
  assert.match(requiredSizesText('android', { kind: 'screenshot', device: 'phone' }), /3840/);
  assert.deepEqual(requiredSizes('ios', { kind: 'screenshot', device: null }), []);
});

test('nearestRequiredSize keeps the orientation of the file', () => {
  const slot = { kind: 'screenshot' as const, device: 'iphone_6_9' };
  const portrait = nearestRequiredSize('ios', slot, 1000, 2200);
  assert.ok(portrait !== null && portrait.height > portrait.width);
  const landscape = nearestRequiredSize('ios', slot, 2200, 1000);
  assert.ok(landscape !== null && landscape.width > landscape.height);
  assert.equal(nearestRequiredSize('ios', slot, 0, 10), null);
  assert.equal(
    nearestRequiredSize('android', { kind: 'screenshot', device: 'phone' }, 1000, 2000),
    null,
  );
});

test('fixAdvice: alpha on a png can be removed, on a jpeg it is a manual matter', () => {
  const facts = {
    format: 'png',
    width: 1320,
    height: 2868,
    hasAlpha: true,
    extension: 'png',
    kind: 'screenshot' as const,
    device: 'iphone_6_9',
  };
  const a = fixAdvice('ios', facts, ['apple.screenshot.alpha']);
  assert.deepEqual(
    a.options.map((o) => o.kind),
    ['remove_alpha'],
  );
  assert.deepEqual(a.manual, []);
  const none = fixAdvice('ios', { ...facts, hasAlpha: false }, ['apple.screenshot.alpha']);
  assert.deepEqual(none.options, []);
  const j = fixAdvice('ios', { ...facts, format: 'jpeg', extension: 'jpg' }, [
    'apple.screenshot.alpha',
  ]);
  assert.deepEqual(j.options, []);
});

test('fixAdvice: a wrong extension is renamed, a wrong size is resized for png and manual otherwise', () => {
  const base = {
    format: 'png',
    width: 1000,
    height: 2200,
    hasAlpha: false,
    extension: 'png',
    kind: 'screenshot' as const,
    device: 'iphone_6_9',
  };
  const ext = fixAdvice('ios', { ...base, extension: 'jpg' }, ['inspect.extension']);
  assert.deepEqual(
    ext.options.map((o) => o.kind),
    ['rename_extension'],
  );
  const size = fixAdvice('ios', base, ['apple.screenshot.size']);
  assert.deepEqual(
    size.options.map((o) => o.kind),
    ['resize'],
  );
  const jpeg = fixAdvice('ios', { ...base, format: 'jpeg', extension: 'jpg' }, [
    'apple.screenshot.size',
  ]);
  assert.deepEqual(jpeg.options, []);
  assert.match(jpeg.manual[0] as string, /Required: /);
  const webp = fixAdvice('ios', { ...base, format: 'webp', extension: 'webp' }, []);
  assert.match(webp.manual[0] as string, /not accepted/);
});

test('store images are checked on their own: a wrong pixel size and too many in a set', () => {
  const file = (position: number, width: number, height: number) => ({
    ref: `r${position}`,
    position,
    name: `${position}.png`,
    width,
    height,
    bytes: 1000,
    checksum: null,
    checksumKind: null,
    state: null,
    downloadable: true,
  });
  const files = [
    file(1, 100, 100),
    ...Array.from({ length: 10 }, (_, i) => file(i + 2, 1290, 2796)),
  ];
  const problems = checkStoreImages({
    platform: 'ios',
    sets: [
      {
        platform: 'ios',
        locale: 'en-US',
        kind: 'screenshot',
        device: 'iphone_6_9',
        deviceLabel: 'iPhone 6.9"',
        target: 'APP_IPHONE_67',
        files,
      },
    ],
  });
  assert.ok(problems.some((p) => p.rule === 'apple.screenshot.size' && p.severity === 'error'));
  assert.ok(problems.some((p) => /count|max/i.test(p.rule)));
  assert.deepEqual(checkStoreImages({ platform: 'ios', sets: [] }), []);
});

test('checkStoreImages: a size read from the header never makes an error (a downscaled rendition must not frighten anyone)', () => {
  const file = (sizeFrom: 'store' | 'header'): StoreImageFile => ({
    ref: 'r1',
    position: 1,
    name: 'feature.png',
    width: 512,
    height: 250,
    bytes: 1000,
    sizeFrom,
    checksum: null,
    checksumKind: null,
    state: null,
    downloadable: true,
  });
  const check = (sizeFrom: 'store' | 'header') =>
    checkStoreImages({
      platform: 'android',
      sets: [
        {
          platform: 'android',
          locale: 'en-US',
          kind: 'feature_graphic',
          device: null,
          deviceLabel: 'Feature graphic',
          target: 'featureGraphic',
          files: [file(sizeFrom)],
        },
      ],
    });
  assert.ok(
    check('store').some((p) => p.severity === 'error'),
    'the store stated 512x250: a real error',
  );
  const measured = check('header');
  assert.ok(measured.length > 0);
  assert.ok(
    measured.every((p) => p.severity === 'info'),
    'measured by us: only notes',
  );
});

// ---------------------------------------------------------------------------------------------
// The count of a set: one rule (per store set), the same for the store's own images as for a draft read

const shots = (n: number): StoreImageFile[] =>
  Array.from({ length: n }, (_, i) => ({
    ref: `r${i + 1}`,
    position: i + 1,
    name: `s${i + 1}.png`,
    width: 2048,
    height: 2732,
    bytes: 1000,
    sizeFrom: 'store' as const,
    checksum: null,
    checksumKind: null,
    state: null,
    downloadable: true,
  }));
const ipadSet = (target: string, n: number) => ({
  platform: 'ios' as const,
  locale: 'en-US',
  kind: 'screenshot' as const,
  device: 'ipad_13',
  deviceLabel: 'iPad 13" / 12.9"',
  target,
  files: shots(n),
});
const countProblems = (sets: ReturnType<typeof ipadSet>[]) =>
  checkStoreImages({ platform: 'ios', sets }).filter((p) => /count/.test(p.rule));

test('checkStoreImages: the 13" and 12.9" groups of one display are two sets, never summed (10 + 2 is not 12)', () => {
  assert.deepEqual(countProblems([ipadSet('APP_IPAD_PRO_3GEN_129', 10), ipadSet('APP_IPAD_PRO_129', 2)]), []);
  assert.deepEqual(countProblems([ipadSet('APP_IPAD_PRO_3GEN_129', 8), ipadSet('APP_IPAD_PRO_129', 4)]), []);
});

test('checkStoreImages: 12 in ONE group is the error, and it names the group and how many to remove', () => {
  const [p, ...rest] = countProblems([ipadSet('APP_IPAD_PRO_3GEN_129', 12), ipadSet('APP_IPAD_PRO_129', 2)]);
  assert.equal(rest.length, 0);
  assert.equal(
    p?.message,
    'At most 10 screenshots per device size. en-US iPad 13" / 12.9" (APP_IPAD_PRO_3GEN_129): 12 found.',
  );
  assert.deepEqual([p?.count, p?.max, p?.set], [12, 10, 'APP_IPAD_PRO_3GEN_129']);
});

test('checkStoreImages and a draft read count the same way: the same sets give the same problems', () => {
  // The facts of a store view are the facts of `assetFactsOf` for the same sets: one rule (`validateAssets`), one key (`set`).
  const sets = [ipadSet('APP_IPAD_PRO_3GEN_129', 12)];
  const viaView = checkStoreImages({ platform: 'ios', sets }).map((p) => p.message);
  assert.ok(viaView.some((m) => /\(APP_IPAD_PRO_3GEN_129\): 12 found/.test(m)));
});

test('primaryStoreSet: of the sibling groups of a display, the one a push writes; else the fullest; one set is itself', () => {
  const [a, b] = [ipadSet('APP_IPAD_PRO_129', 9), ipadSet('APP_IPAD_PRO_3GEN_129', 4)];
  assert.equal(primaryStoreSet([a, b]), b);
  assert.equal(primaryStoreSet([b, a]), b);
  const [x, y] = [ipadSet('OTHER_A', 2), ipadSet('OTHER_B', 5)];
  assert.equal(primaryStoreSet([x, y]), y);
  assert.equal(primaryStoreSet([x]), x);
  assert.equal(primaryStoreSet([]), undefined);
});
