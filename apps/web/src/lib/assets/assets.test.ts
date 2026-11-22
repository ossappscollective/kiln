import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssetProblem, AssetSet } from '@kiln/core';
import { t } from '../i18n/t.ts';
import type { AssetItem } from '../types.ts';
import {
  ALL,
  assetFileUrl,
  compareWithStore,
  countText,
  dimensionsText,
  filterOptions,
  formatBytes,
  groupAssets,
  isFiltered,
  localeLabel,
  matchesFilter,
  NO_FILTER,
  NOT_COMPARED,
  previewNote,
  previewState,
  problemCountsText,
  problemsByPath,
  sanitizeFilter,
  severityTone,
  shortCommit,
  sourceHint,
  sourceText,
  summaryText,
  worstSeverity,
} from './assets.ts';

const item = (over: Partial<AssetItem> & { path: string }): AssetItem => ({
  locale: 'en-US',
  kind: 'screenshot',
  device: 'iphone_6_9',
  deviceLabel: 'iPhone 6.9"',
  order: 1,
  bytes: 1000,
  width: 1320,
  height: 2868,
  format: 'png',
  hasAlpha: false,
  oid: 'a'.repeat(40),
  read: 'read',
  origin: 'store',
  ...over,
});

const problem = (over: Partial<AssetProblem>): AssetProblem => ({
  rule: 'apple.screenshot.size',
  severity: 'error',
  message: 'x',
  source: 'https://example.test',
  verified: true,
  ...over,
});

const assets: AssetItem[] = [
  item({ path: 'm/de-DE/2.png', locale: 'de-DE', order: 2 }),
  item({ path: 'm/en-US/2.png', order: 2 }),
  item({ path: 'm/en-US/1.png', order: 1 }),
  item({
    path: 'm/en-US/ipad.png',
    device: 'ipad_13',
    deviceLabel: 'iPad 13"',
    width: 2064,
    height: 2752,
  }),
  item({
    path: 'm/en-US/p.mov',
    kind: 'preview',
    device: null,
    deviceLabel: 'Unclassified',
    format: 'video',
    width: null,
    height: null,
    bytes: 5000,
  }),
  item({
    path: 'icon.png',
    locale: '',
    kind: 'app_icon',
    device: null,
    deviceLabel: 'Unclassified',
    origin: 'project',
  }),
];

const sets: AssetSet[] = [
  {
    locale: 'en-US',
    kind: 'screenshot',
    device: 'iphone_6_9',
    deviceLabel: 'iPhone 6.9"',
    count: 12,
    max: 10,
    rule: 'apple.screenshot.count',
  },
  {
    locale: 'en-US',
    kind: 'screenshot',
    device: 'ipad_13',
    deviceLabel: 'iPad 13"',
    count: 1,
    max: 10,
    rule: 'apple.screenshot.count',
  },
  {
    locale: 'de-DE',
    kind: 'screenshot',
    device: 'iphone_6_9',
    deviceLabel: 'iPhone 6.9"',
    count: 1,
    max: 10,
    rule: 'apple.screenshot.count',
  },
];

const problems: AssetProblem[] = [
  problem({ path: 'm/en-US/1.png', severity: 'info', rule: 'inspect.unread' }),
  problem({ path: 'm/en-US/1.png', severity: 'error' }),
  problem({ path: 'm/en-US/2.png', severity: 'warning', rule: 'apple.screenshot.alpha' }),
  problem({
    severity: 'error',
    rule: 'apple.screenshot.count',
    locale: 'en-US',
    kind: 'screenshot',
    device: 'iphone_6_9',
  }),
  problem({ severity: 'info', rule: 'play.tv.pair' }),
];

const index = { assets, sets, problems };

test('groups are locale, then kind and device; the project icon comes last', () => {
  const groups = groupAssets(index);
  assert.deepEqual(
    groups.map((g) => g.locale),
    ['de-DE', 'en-US', ''],
  );
  const en = groups[1];
  assert.deepEqual(
    en?.groups.map((g) => `${g.kind}/${g.device}`),
    ['screenshot/ipad_13', 'screenshot/iphone_6_9', 'preview/null'],
  );
  assert.equal(groups[2]?.isLocale, false);
  assert.equal(groups[2]?.label, 'Project (no locale)');
  assert.equal(en?.assetCount, 4);
});

test('files are in order, and the count and maximum come from the set', () => {
  const iphone = groupAssets(index)[1]?.groups.find((g) => g.device === 'iphone_6_9');
  assert.deepEqual(
    iphone?.assets.map((a) => a.order),
    [1, 2],
  );
  assert.equal(iphone?.count, 12);
  assert.equal(iphone?.max, 10);
  assert.equal(countText(iphone as never), '12 of at most 10');
  assert.equal(countText({ count: 3, max: null }), '3');
});

test('set problems are the ones with no path, matched by locale, kind and device', () => {
  const iphone = groupAssets(index)[1]?.groups.find((g) => g.device === 'iphone_6_9');
  assert.equal(iphone?.setProblems.length, 1);
  assert.equal(iphone?.setProblems[0]?.rule, 'apple.screenshot.count');
  const ipad = groupAssets(index)[1]?.groups.find((g) => g.device === 'ipad_13');
  assert.equal(ipad?.setProblems.length, 0);
});

test('filters narrow by locale, device and kind', () => {
  assert.equal(groupAssets(index, { locale: 'de-DE', device: ALL, kind: ALL }).length, 1);
  const ipad = groupAssets(index, { locale: ALL, device: 'ipad_13', kind: ALL });
  assert.equal(ipad.length, 1);
  assert.equal(ipad[0]?.assetCount, 1);
  const previews = groupAssets(index, { locale: ALL, device: ALL, kind: 'preview' });
  assert.equal(previews[0]?.groups[0]?.kind, 'preview');
  // a null device is the empty device value
  const unclassified = groupAssets(index, { locale: ALL, device: '', kind: ALL });
  assert.ok(unclassified.some((g) => g.locale === ''));
  assert.deepEqual(groupAssets(index, { locale: 'fr-FR', device: ALL, kind: ALL }), []);
});

test('matchesFilter and isFiltered', () => {
  assert.equal(matchesFilter({ locale: 'a', device: null, kind: 'icon' }, NO_FILTER), true);
  assert.equal(
    matchesFilter(
      { locale: 'a', device: null, kind: 'icon' },
      { ...NO_FILTER, kind: 'screenshot' },
    ),
    false,
  );
  assert.equal(isFiltered(NO_FILTER), false);
  assert.equal(isFiltered({ ...NO_FILTER, device: 'x' }), true);
});

test('filter options list only what the index holds', () => {
  const options = filterOptions(index);
  assert.deepEqual(
    options.locales.map((o) => o.value),
    ['de-DE', 'en-US', ''],
  );
  assert.deepEqual(
    options.kinds.map((o) => o.value),
    ['screenshot', 'preview', 'app_icon'],
  );
  assert.ok(options.devices.some((o) => o.value === '' && o.label === 'Unclassified'));
  assert.ok(options.devices.some((o) => o.value === 'ipad_13'));
});

test('sanitizeFilter drops values that are gone', () => {
  const options = filterOptions(index);
  assert.deepEqual(
    sanitizeFilter({ locale: 'xx', device: 'ipad_13', kind: 'tv_banner' }, options),
    {
      locale: ALL,
      device: 'ipad_13',
      kind: ALL,
    },
  );
});

test('problems by path are worst first; no-path problems are left out', () => {
  const map = problemsByPath(problems);
  assert.deepEqual(
    map['m/en-US/1.png']?.map((p) => p.severity),
    ['error', 'info'],
  );
  assert.equal(Object.keys(map).length, 2);
  assert.equal(worstSeverity(problems), 'error');
  assert.equal(worstSeverity([]), null);
  assert.equal(severityTone('error'), 'bad');
  assert.equal(severityTone('warning'), 'warn');
  assert.equal(severityTone('info'), 'info');
});

test('texts', () => {
  assert.equal(formatBytes(null), 'Size unknown');
  assert.equal(formatBytes(512), '512 byte');
  assert.equal(formatBytes(2048), '2 kB');
  assert.equal(formatBytes(1536), '1.5 kB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5 MB');
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3 GB');
  assert.equal(dimensionsText({ width: 1320, height: 2868, format: 'png' }), '1320 x 2868 px');
  assert.equal(dimensionsText({ width: null, height: null, format: 'video' }), 'Video');
  assert.equal(dimensionsText({ width: null, height: null, format: null }), 'Dimensions unknown');
  assert.equal(localeLabel('en-US'), 'en-US');
  assert.equal(localeLabel('default'), 'Default folder');
  assert.equal(shortCommit('0123456789abcdef'), '0123456');
  assert.equal(shortCommit(null), '');
});

test('source text names the speed of the source', () => {
  assert.equal(
    sourceText({ kind: 'local_clone', label: 'Local clone (fast)', fast: true }),
    'Local clone (fast)',
  );
  assert.equal(
    sourceText({ kind: 'github_api', label: 'GitHub (slower)', fast: false }),
    'GitHub (slower)',
  );
  assert.equal(sourceText(null), 'No repository linked');
  assert.match(sourceHint({ kind: 'github_api', label: 'x', fast: false }), /limited number/);
  assert.equal(sourceHint(null), '');
});

test('summary and problem counts', () => {
  const totals = { assets: 1, read: 1, bytes: 2048, errors: 0, warnings: 0, infos: 0, locales: 1 };
  assert.equal(summaryText({ totals }), '1 file, 1 locale, 2 kB');
  assert.equal(problemCountsText({ totals }), 'No problems found');
  assert.equal(
    problemCountsText({ totals: { ...totals, errors: 1, warnings: 2, infos: 3 } }),
    '1 error, 2 warnings, 3 notes',
  );
});

test('the file URL carries the path and the commit, escaped', () => {
  assert.equal(
    assetFileUrl('w 1', 'a/1', 'fastlane/metadata/en US/1 a.png', 'c'.repeat(40)),
    `/api/workspaces/w%201/apps/a%2F1/assets/file?path=fastlane%2Fmetadata%2Fen%20US%2F1%20a.png&commit=${'c'.repeat(40)}`,
  );
  assert.equal(
    assetFileUrl('w', 'a', 'x.png', null),
    '/api/workspaces/w/apps/a/assets/file?path=x.png',
  );
});

test('preview state: images, videos, big files and unread files', () => {
  const max = 8 * 1024 * 1024;
  assert.equal(previewState(item({ path: 'a.png' }), max), 'image');
  assert.equal(previewState(item({ path: 'a.mov', format: 'video' }), max), 'video');
  assert.equal(previewState(item({ path: 'a.png', bytes: max + 1 }), max), 'too_large');
  assert.equal(
    previewState(item({ path: 'a.png', format: null, oid: null, read: 'unreadable' }), max),
    'unavailable',
  );
  assert.equal(previewNote('image', max), '');
  assert.match(previewNote('too_large', max), /8 MB/);
  assert.match(previewNote('video', max), /listed, not played/);
});

test('without store counts a set is "not yet compared"', () => {
  const group = { count: 3, kind: 'screenshot' as const, device: 'iphone_6_9' };
  assert.deepEqual(compareWithStore(null, group, 'en-US'), {
    state: 'not_compared',
    text: t(NOT_COMPARED),
  });
  const side = {
    observedAt: 1,
    counts: [{ locale: 'en-US', kind: 'screenshot' as const, device: 'iphone_6_9', count: 3 }],
  };
  assert.equal(compareWithStore(side, group, 'en-US').state, 'same');
  assert.equal(compareWithStore(side, { ...group, count: 4 }, 'en-US').state, 'differs');
  assert.equal(compareWithStore(side, group, 'de-DE').state, 'not_compared');
});

test('an index with no assets gives no groups', () => {
  assert.deepEqual(groupAssets({ assets: [], sets: [], problems: [] }), []);
  assert.deepEqual(filterOptions({ assets: [] }), { locales: [], devices: [], kinds: [] });
});
