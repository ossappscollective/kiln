import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addLabel,
  addTargets,
  addTermToText,
  editableFields,
  fieldIdForSource,
  fieldInfo,
  measureField,
  notStageableReason,
  sameText,
  sourceWord,
  stageBlockedReason,
  whereText,
} from './edit.ts';

test('each store lists its main text fields with limits and whether a draft push can write them', () => {
  const ios = editableFields('ios');
  assert.deepEqual(
    ios.map((f) => f.id),
    ['name', 'subtitle', 'keywords', 'promotional_text', 'description'],
  );
  assert.equal(ios.find((f) => f.id === 'keywords')?.limit, 100);
  assert.equal(ios.find((f) => f.id === 'keywords')?.unit, 'bytes');
  assert.equal(ios.find((f) => f.id === 'name')?.stageable, false);
  assert.equal(ios.find((f) => f.id === 'subtitle')?.stageable, false);
  assert.equal(ios.find((f) => f.id === 'promotional_text')?.stageable, true);
  const play = editableFields('android');
  assert.deepEqual(
    play.map((f) => f.id),
    ['title', 'short_description', 'full_description'],
  );
  assert.equal(
    play.every((f) => f.stageable),
    true,
  );
  assert.equal(fieldInfo('android', 'subtitle'), null);
  assert.equal(fieldInfo('ios', 'support_url'), null, 'urls are not edited here');
  assert.equal(fieldInfo('android', 'title')?.limit, 30);
});

test('the counter counts bytes for the keyword field and characters elsewhere, and says what is left or over', () => {
  const kw = fieldInfo('ios', 'keywords');
  assert.ok(kw);
  const m = measureField(kw, 'abc,é');
  assert.equal(m.used, 6, 'é is two bytes');
  assert.equal(m.remaining, 94);
  assert.equal(m.over, false);
  assert.equal(m.text, '6 of 100 bytes, 94 left');
  const title = fieldInfo('android', 'title');
  assert.ok(title);
  const over = measureField(title, 'x'.repeat(33));
  assert.equal(over.over, true);
  assert.equal(over.text, '3 over the limit of 30 characters');
  assert.equal(over.percent, 100);
  assert.equal(measureField(title, '😀😀').used, 2, 'one emoji is one character');
});

test('where a keyword appears is said in words, the same on both stores', () => {
  assert.equal(whereText(['title']), 'In the title');
  assert.equal(whereText(['title', 'keywords']), 'In the title and keyword field');
  assert.equal(
    whereText(['title', 'subtitle', 'keywords']),
    'In the title, subtitle and keyword field',
  );
  assert.equal(whereText([]), 'Not in the listing');
  assert.equal(sourceWord('shortDescription'), 'short description');
  assert.equal(fieldIdForSource('ios', 'title'), 'name');
  assert.equal(fieldIdForSource('android', 'title'), 'title');
  assert.equal(fieldIdForSource('android', 'description'), 'full_description');
  assert.equal(fieldIdForSource('macos', 'description'), 'description');
  assert.equal(fieldIdForSource('ios', 'keywords'), 'keywords');
});

test('the targets of "Add to ..." start with the keyword field on the App Store and the title on Google Play', () => {
  assert.equal(addTargets('ios')[0]?.id, 'keywords');
  assert.equal(addLabel(addTargets('ios')[0] as never), 'Add to keyword field');
  assert.equal(addTargets('android')[0]?.id, 'title');
  assert.equal(addLabel(addTargets('android')[1] as never), 'Add to short description');
});

test('adding a keyword to the keyword field appends it after a comma, without a space, and never twice', () => {
  const kw = { id: 'keywords', lower: 'keyword field' };
  assert.deepEqual(addTermToText(kw, 'habit,sleep', 'water', 'en-US').text, 'habit,sleep,water');
  assert.equal(addTermToText(kw, 'habit,sleep,', 'water', 'en-US').text, 'habit,sleep,water');
  assert.equal(addTermToText(kw, '', 'water', 'en-US').text, 'water');
  const again = addTermToText(kw, 'habit,Waters', 'water', 'en-US');
  assert.equal(again.changed, false, 'a plural of an entry is the same entry');
  assert.equal(again.text, 'habit,Waters');
  assert.match(again.note, /already in the keyword field/);
});

test('adding a keyword to a text field gives a starting point to edit, and refuses a term that is already in it', () => {
  const name = { id: 'name', lower: 'title' };
  assert.equal(
    addTermToText(name, 'Water Tracker', 'hydration', 'en').text,
    'Water Tracker - hydration',
  );
  const short = { id: 'short_description', lower: 'short description' };
  assert.equal(
    addTermToText(short, 'Drink more.', 'hydration', 'en').text,
    'Drink more, hydration',
  );
  const long = { id: 'full_description', lower: 'full description' };
  assert.equal(addTermToText(long, 'Hello.', 'hydration', 'en').text, 'Hello.\n\nhydration');
  assert.equal(addTermToText(long, '', 'hydration', 'en').text, 'hydration');
  const dup = addTermToText(name, 'Hydration Tracker', 'hydration', 'en');
  assert.equal(dup.changed, false);
  assert.match(dup.note, /already in the title/);
  assert.equal(addTermToText(name, 'x', '   ', 'en').changed, false);
});

test('the App Store name and subtitle cannot be staged and say why; stageable fields give the reasons "Stage" is blocked', () => {
  assert.match(notStageableReason('ios', 'subtitle') ?? '', /cannot write them/);
  assert.match(notStageableReason('ios', 'subtitle') ?? '', /Nothing is saved from here/);
  assert.equal(notStageableReason('ios', 'keywords'), null);
  const base = {
    platform: 'ios' as const,
    field: 'keywords',
    canStage: true,
    empty: false,
    over: false,
    unchanged: false,
  };
  assert.equal(stageBlockedReason(base), null);
  assert.match(stageBlockedReason({ ...base, field: 'name' }) ?? '', /draft push/);
  assert.match(stageBlockedReason({ ...base, canStage: false }) ?? '', /role/);
  assert.match(stageBlockedReason({ ...base, empty: true }) ?? '', /empty/);
  assert.match(stageBlockedReason({ ...base, over: true }) ?? '', /over the limit/);
  assert.match(
    stageBlockedReason({ ...base, unchanged: true }) ?? '',
    /same as the one in the store/,
  );
});

test('sameText ignores line endings and trailing white space like the server', () => {
  assert.equal(sameText('a  \r\nb \n', 'a\nb'), true);
  assert.equal(sameText('a', 'b'), false);
});
