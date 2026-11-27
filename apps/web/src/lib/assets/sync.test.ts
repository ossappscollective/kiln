import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssetDiffSet, StagedChangesView } from '@kiln/core';
import { ApiError } from '../api.ts';
import {
  canChangeAssets,
  checkPickedFile,
  compareLabel,
  compareSummary,
  compareTone,
  diffBadge,
  diffSetOf,
  fixLabel,
  imageFilesOf,
  isHexColour,
  type PullReport,
  pullableKeys,
  pullKeyOf,
  setIdOf,
  shortChecksum,
  sizeLine,
  specErrorsOf,
  stagedBlobUrl,
  stagedFileRows,
  stagedSetOf,
  storeKeyOf,
  storeThumbUrl,
  summarizePull,
  summarizeToRepo,
  UPLOAD_ACCEPT,
} from './sync.ts';

const totals = (over: Partial<AssetDiffSet['totals']> = {}): AssetDiffSet['totals'] => ({
  identical: 0,
  likely_same: 0,
  differs: 0,
  only_repo: 0,
  only_store: 0,
  ...over,
});
const row = (
  position: number,
  status: AssetDiffSet['rows'][number]['status'],
  ref: string | null,
): AssetDiffSet['rows'][number] => ({
  index: position - 1,
  position,
  status,
  repo: null,
  store: ref === null ? null : ({ ref } as never),
  reason: '',
  group: ref === null ? null : 'APP_IPHONE_67',
  storeRef: ref,
  storePosition: ref === null ? null : position,
});
const set = (over: Partial<AssetDiffSet> = {}): AssetDiffSet => ({
  platform: 'ios',
  locale: 'en-US',
  kind: 'screenshot',
  device: 'iphone_6_9',
  deviceLabel: 'iPhone 6.9',
  target: null,
  rows: [],
  totals: totals(),
  inSync: false,
  primary: true,
  ...over,
});

test('ids and urls are encoded and carry no address of a store', () => {
  assert.equal(setIdOf('en-US', 'screenshot', 'iphone_6_9'), 'en-US/screenshot:iphone_6_9');
  assert.equal(setIdOf('en-US', 'icon', null), 'en-US/icon');
  assert.equal(
    storeKeyOf('ios', 'en-US', 'screenshot', 'iphone_6_9'),
    'ios/en-US/screenshot:iphone_6_9',
  );
  assert.equal(
    storeThumbUrl('w 1', 'a/1', 'abc', 160),
    '/api/workspaces/w%201/apps/a%2F1/assets/store/thumb?ref=abc&size=160',
  );
  assert.equal(
    stagedBlobUrl('w', 'a', 'f'.repeat(40)),
    `/api/workspaces/w/apps/a/staged/assets/blob?oid=${'f'.repeat(40)}`,
  );
});

test('a picked file is checked by size and name before any request', () => {
  assert.equal(checkPickedFile({ name: 'a.png', size: 1000 }), '');
  assert.equal(checkPickedFile({ name: 'a.JPG', size: 1000, type: '' }), '');
  assert.equal(checkPickedFile({ name: 'noext', size: 1000, type: 'image/png' }), '');
  assert.match(
    checkPickedFile({ name: 'a.gif', size: 1000, type: 'image/gif' }),
    /not a PNG or JPEG/,
  );
  assert.match(checkPickedFile({ name: 'a.png', size: 0 }), /empty/);
  assert.match(
    checkPickedFile({ name: 'big.png', size: 9 * 1024 * 1024 }),
    /at most 8\.0 MB|at most 8 MB/,
  );
  assert.match(UPLOAD_ACCEPT, /png/);
  assert.deepEqual(imageFilesOf(null), []);
  assert.equal(imageFilesOf([{ name: 'x' } as File]).length, 1);
});

test('a comparison row says what is different, and which images a pull would take', () => {
  assert.equal(compareTone('identical'), 'ok');
  assert.equal(compareTone('differs'), 'warn');
  assert.equal(compareTone('only_store'), 'accent');
  assert.equal(shortChecksum(null), 'none');
  assert.equal(shortChecksum('abcdef0123456789'), 'abcdef012345...');
  assert.equal(sizeLine(1290, 2796, 2048), '1290 x 2796, 2 kB');
  assert.equal(sizeLine(null, null, null), 'unknown size');
  const s = set({
    rows: [
      { ...row(1, 'identical', 'r1') },
      { ...row(2, 'differs', 'r2'), reason: 'x' },
      { ...row(3, 'only_repo', null), repo: {} as never },
      { ...row(4, 'only_store', 'r4') },
    ],
    totals: totals({ identical: 1, differs: 1, only_repo: 1, only_store: 1 }),
  });
  assert.deepEqual(pullableKeys(s, 'ios'), [
    'ios/en-US/screenshot:iphone_6_9#2',
    'ios/en-US/screenshot:iphone_6_9#4',
  ]);
  // A sibling group of a display is never pulled (the pull takes the primary group), and the key is the store's position of the image.
  assert.deepEqual(pullableKeys({ ...s, primary: false }, 'ios'), []);
  const shifted = set({ rows: [{ ...row(1, 'only_store', 'r11'), storePosition: 11 }] });
  assert.deepEqual(pullableKeys(shifted, 'ios'), ['ios/en-US/screenshot:iphone_6_9#11']);
  assert.equal(pullKeyOf(shifted, { storePosition: null }, 'ios'), null);
  assert.equal(diffBadge(null), null);
  assert.deepEqual(diffBadge(set({ inSync: true })), { tone: 'ok', text: 'Same as the store' });
  assert.equal(diffBadge(s)?.text, '3 files differ from the store');
  assert.equal(
    diffBadge(set({ totals: totals({ differs: 1 }) }))?.text,
    '1 file differs from the store',
  );
  const view = { sets: [s] } as never;
  assert.equal(diffSetOf(view, 'en-US', 'screenshot', 'iphone_6_9'), s);
  assert.equal(diffSetOf(view, 'de-DE', 'screenshot', 'iphone_6_9'), null);
});

const report = (over: Partial<PullReport> = {}): PullReport => ({
  changeSet: null,
  written: 0,
  deleted: 0,
  unchanged: 0,
  bytes: 0,
  skipped: [],
  unverified: [],
  left: [],
  notes: [],
  ...over,
});

test('a pull is summarised with what was left out and what was not checked', () => {
  assert.equal(summarizePull(report()).headline, 'Nothing was pulled.');
  assert.equal(
    summarizePull(report({ unchanged: 3 })).headline,
    'The repository already has these images.',
  );
  const made = summarizePull(
    report({
      changeSet: {} as never,
      written: 2,
      unchanged: 1,
      unverified: ['ios/en-US/screenshot:iphone_6_9#1'],
      skipped: [{ key: 'k', reason: 'checksum_mismatch', message: 'm' }],
    }),
  );
  assert.equal(made.tone, 'warn');
  assert.match(made.headline, /2 files written, 1 already the same/);
  assert.ok(made.details.some((d) => /without a checksum/.test(d)));
  assert.ok(made.details.some((d) => /1 image was left out/.test(d)));
  assert.equal(summarizePull(report({ changeSet: {} as never, written: 1 })).tone, 'ok');
  assert.equal(
    summarizeToRepo({
      changeSet: null,
      written: 0,
      deleted: 0,
      unchanged: 2,
      skipped: [],
      notes: [],
    }).tone,
    'info',
  );
  assert.match(
    summarizeToRepo({
      changeSet: {} as never,
      written: 1,
      deleted: 1,
      unchanged: 0,
      skipped: ['a'],
      notes: [],
    }).headline,
    /1 file written, 1 file deleted/,
  );
});

test('a refused upload gives its problems and fixes; other errors give none', () => {
  const refused = new ApiError(422, 'spec_errors', 'm', undefined, {
    problems: [{ rule: 'apple.screenshot.alpha', severity: 'error', message: 'Has alpha.' }],
    fix: { options: [{ kind: 'remove_alpha', label: 'Remove', detail: 'PNG' }], manual: ['m1'] },
  });
  const got = specErrorsOf(refused);
  assert.equal(got?.problems.length, 1);
  assert.equal(got?.advice.options[0]?.kind, 'remove_alpha');
  assert.deepEqual(got?.advice.manual, ['m1']);
  assert.equal(specErrorsOf(new ApiError(422, 'empty_set', 'm')), null);
  assert.equal(specErrorsOf(new Error('x')), null);
  assert.deepEqual(specErrorsOf(new ApiError(422, 'spec_errors', 'm'))?.advice, {
    options: [],
    manual: [],
  });
  assert.ok(isHexColour('#ffffff') && !isHexColour('white') && !isHexColour('#fff'));
  assert.match(fixLabel('remove_alpha'), /alpha/);
  assert.match(fixLabel('resize'), /Resize/);
});

test('staged sets are found by their id and listed in order with their upload mark', () => {
  const view = {
    assets: [
      {
        id: 'en-US/screenshot:iphone_6_9',
        files: [
          {
            id: 'a',
            position: 1,
            path: 'uploads/ab12cd34/shot.png',
            commit: '',
            oid: 'o1',
            bytes: 10,
            width: 1,
            height: 2,
            format: 'png',
            hasAlpha: false,
            upload: true,
          },
          {
            id: 'b',
            position: 2,
            path: 'fastlane/screenshots/en-US/2.png',
            commit: 'c',
            oid: 'o2',
            bytes: null,
            width: null,
            height: null,
            format: null,
            hasAlpha: null,
          },
        ],
      },
    ],
  } as unknown as StagedChangesView;
  const found = stagedSetOf(view, 'en-US', 'screenshot', 'iphone_6_9');
  assert.ok(found);
  const rows = stagedFileRows(found);
  assert.deepEqual(
    rows.map((r) => [r.position, r.name, r.upload]),
    [
      [1, 'shot.png', true],
      [2, '2.png', false],
    ],
  );
  assert.equal(stagedSetOf(view, 'en-US', 'icon', null), null);
  assert.deepEqual(stagedFileRows(null), []);
  assert.ok(canChangeAssets('owner'));
  assert.ok(!canChangeAssets('viewer'));
});

test('compareLabel and compareSummary read in words, with plurals', () => {
  assert.equal(compareLabel('only_store'), 'Only in the store');
  assert.equal(
    compareSummary({ identical: 3, likely_same: 0, differs: 1, only_repo: 0, only_store: 2 }),
    '3 identical, 1 differs, 2 only in the store',
  );
  assert.equal(
    compareSummary({ identical: 0, likely_same: 0, differs: 2, only_repo: 1, only_store: 0 }),
    '2 differ, 1 only in the repository',
  );
  assert.equal(
    compareSummary({ identical: 0, likely_same: 0, differs: 0, only_repo: 0, only_store: 0 }),
    '',
  );
});
