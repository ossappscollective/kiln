import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StagedChangesView } from '@kiln/core';
import {
  clipText,
  stagedCellMark,
  stagedChangeText,
  stagedCountForLocale,
} from './staged-marks.ts';

const view = (text: [string, string, string | null, string][], assets: string[] = []) =>
  ({
    text: text.map(([locale, field, before, value]) => ({ locale, field, before, value })),
    assets: assets.map((locale) => ({ locale, pushed: false, files: [] })),
  }) as unknown as StagedChangesView;

test('clipText: one line, at most the limit, with an ellipsis', () => {
  assert.equal(clipText('a  b\n c'), 'a b c');
  const long = clipText('x'.repeat(100));
  assert.equal(long.length, 60);
  assert.ok(long.endsWith('…'));
});

test('the change reads Staged: before to after, and an empty side reads as nothing', () => {
  assert.equal(stagedChangeText('Old', 'New'), 'Staged: Old → New');
  assert.match(stagedChangeText(null, 'New'), /^Staged: .* → New$/);
  assert.notEqual(stagedChangeText(null, 'New'), stagedChangeText('Old', 'New'));
});

test('a cell has a mark only while a staged text exists for it; discarding removes it', () => {
  const v = view([['en-US', 'name', 'Old', 'New']]);
  const input = (view: StagedChangesView | null, field = 'name') => [
    { platform: 'ios', platformName: 'iOS', view, locale: 'en-US', field },
  ];
  assert.deepEqual(stagedCellMark(input(v)), { count: 1, text: 'Staged: Old → New' });
  assert.deepEqual(stagedCellMark(input(v, 'subtitle')), { count: 0, text: '' });
  assert.deepEqual(stagedCellMark(input(null)), { count: 0, text: '' });
  assert.deepEqual(stagedCellMark(input(view([]))), { count: 0, text: '' }); // after the discard the store view is empty
});

test('two platforms in one cell: the text names the platform that has a staged value', () => {
  const both = [
    {
      platform: 'ios',
      platformName: 'iOS',
      view: view([['en-US', 'name', 'A', 'B']]),
      locale: 'en-US',
      field: 'name',
    },
    {
      platform: 'android',
      platformName: 'Android',
      view: view([]),
      locale: 'en-US',
      field: 'title',
    },
  ];
  assert.deepEqual(stagedCellMark(both), { count: 1, text: 'iOS: Staged: A → B' });
});

test('the locale count adds listing texts and graphics sets of that locale across the records', () => {
  const a = view(
    [
      ['en-US', 'name', null, 'x'],
      ['en-US', 'subtitle', null, 'y'],
      ['fr-FR', 'name', null, 'z'],
    ],
    ['en-US'],
  );
  const b = view([['en-US', 'title', null, 'q']]);
  assert.equal(stagedCountForLocale([a, b, null], 'en-US'), 4);
  assert.equal(stagedCountForLocale([a, b], 'de-DE'), 0);
  assert.equal(stagedCountForLocale([view([]), null], 'en-US'), 0);
  // A graphic set that was pushed already is not something a push would send: it is not counted (the unpushed family).
  const pushed = {
    ...view([], ['en-US']),
    assets: [{ locale: 'en-US', pushed: true, files: [] }],
  } as never;
  assert.equal(stagedCountForLocale([pushed], 'en-US'), 0);
});
