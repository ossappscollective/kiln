import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssetProblem } from '@kiln/core';
import { chipOf, commonText, groupProblems, splitGroups, UNREAD_RULE } from './problem-groups.ts';

const unread = (n: number, locale = 'en-US'): AssetProblem[] =>
  Array.from({ length: n }, (_, i) => ({
    rule: UNREAD_RULE,
    severity: 'info' as const,
    message: 'The file was not opened (too large, over the read budget or unreadable), so its format and size could not be checked. (not read).',
    source: 'https://example.test/rule',
    verified: true,
    path: `${locale}/screenshot/phone#${i + 1}`,
  }));
const size = (device: string, found: string, severity: 'error' | 'warning' = 'error'): AssetProblem => ({
  rule: 'play.screenshot.size',
  severity,
  message: `A phone screenshot is between 320 and 3840 px on a side. ${found}`,
  source: 'https://example.test/size',
  verified: true,
  path: `en-US/screenshot/${device}#1`,
});

test('nineteen identical notes are one group with one rule text and nineteen chips', () => {
  const groups = groupProblems([...unread(10), ...unread(9, 'fr-FR')]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.count, 19);
  assert.equal(groups[0]?.items.length, 19);
  assert.equal(groups[0]?.items[0]?.chip, 'en-US phone#1', 'the locale is in the chip when several are present');
});

test('problems come before notes, and the biggest group first', () => {
  const groups = groupProblems([...unread(3), size('phone', 'It is 100x100.'), size('tablet', 'It is 200x200.'), size('tv', 'x', 'warning')]);
  assert.deepEqual(groups.map((g) => `${g.severity}:${g.count}`), ['error:2', 'warning:1', 'info:3']);
});

test('the shared rule text is split from what was found per image', () => {
  const g = groupProblems([size('phone', 'It is 100x100.'), size('tablet', 'It is 200x200.')])[0];
  assert.equal(g?.text, 'A phone screenshot is between 320 and 3840 px on a side.');
  assert.deepEqual(g?.items.map((i) => i.found), ['It is 100x100.', 'It is 200x200.']);
  assert.equal(commonText(['One. Two']), 'One. Two', 'a single message is kept whole');
});

test('splitGroups separates the unread line from problems and notes, with counts', () => {
  const s = splitGroups([...unread(19), size('phone', 'It is 100x100.')]);
  assert.equal(s.counts.unread, 19);
  assert.equal(s.counts.problems, 1);
  assert.equal(s.notes.length, 0);
  assert.equal(s.unread?.items.length, 19);
  assert.deepEqual(splitGroups([]), { problems: [], notes: [], unread: null, counts: { problems: 0, notes: 0, unread: 0 } });
});

test('chips name the device, or the kind for a set without one', () => {
  assert.equal(chipOf('en-US/feature_graphic/all#1', false), 'Feature graphic#1');
  assert.equal(chipOf('en-US/screenshot/iphone_6_9#3', false), 'iphone_6_9#3');
});
