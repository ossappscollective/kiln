import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ASSET_SYNC_LIMITS,
  compareFile,
  compareSet,
  compareText,
  compareTotals,
  fixAdvice,
  nearestRequiredSize,
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
