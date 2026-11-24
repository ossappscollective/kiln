import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Fix } from '@kiln/core';
import {
  cannotFix,
  fixAllOf,
  fixBlockedReason,
  fixForIssue,
  hashText,
  type LocaleFixes,
  stagedItemOf,
  termMarks,
} from './fixes.ts';

const fix = (over: Partial<Fix>): Fix => ({
  id: 'keywords_tidy',
  labelKey: 'x',
  kind: 'stage',
  locale: 'en-US',
  field: 'keywords',
  before: 'a, b',
  after: 'a,b',
  removed: [],
  risk: 'safe',
  resolves: ['keywords_spaces'],
  limit: 100,
  unit: 'bytes',
  stageable: true,
  ...over,
});
const locale: LocaleFixes = {
  locale: 'en-US',
  fixes: [
    fix({}),
    fix({
      id: 'keywords_drop_in_title',
      risk: 'review',
      resolves: ['keywords_in_title', 'keywords_spaces'],
    }),
    fix({ id: 'keywords_fit', risk: 'review', resolves: ['too_long'] }),
    fix({
      id: 'shorten_ai',
      kind: 'ai_shorten',
      field: 'name',
      after: null,
      resolves: ['too_long'],
      stageable: false,
    }),
  ],
  cannot: [{ locale: 'en-US', field: 'subtitle', code: 'too_long' }],
  staged: [{ field: 'keywords', id: 'row1' }],
};

test('a finding offers the gentlest fix that settles it', () => {
  assert.equal(
    fixForIssue(locale, { field: 'keywords', code: 'keywords_spaces' })?.id,
    'keywords_tidy',
  );
  assert.equal(
    fixForIssue(locale, { field: 'keywords', code: 'keywords_in_title' })?.id,
    'keywords_drop_in_title',
  );
  assert.equal(fixForIssue(locale, { field: 'keywords', code: 'too_long' })?.id, 'keywords_fit');
  assert.equal(fixForIssue(locale, { field: 'name', code: 'too_long' }, 'stage'), null);
  assert.equal(
    fixForIssue(locale, { field: 'name', code: 'too_long' }, 'ai_shorten')?.id,
    'shorten_ai',
  );
  assert.equal(fixForIssue(undefined, { field: 'keywords', code: 'too_long' }), null);
});

test('"cannot be fixed automatically", fix all and the staged item', () => {
  assert.equal(cannotFix(locale, { field: 'subtitle', code: 'too_long' }), true);
  assert.equal(cannotFix(locale, { field: 'keywords', code: 'too_long' }), false);
  assert.deepEqual(
    fixAllOf(locale).map((f) => f.id),
    ['keywords_fit'],
  );
  assert.deepEqual(fixAllOf(undefined), []);
  assert.equal(stagedItemOf(locale, 'keywords'), 'row1');
  assert.equal(stagedItemOf(locale, 'name'), null);
});

test('removed terms are struck once each, keeping the order of the field', () => {
  assert.deepEqual(termMarks('Notes, journal ,notes,diary', ['notes']), [
    { term: 'Notes', removed: true },
    { term: 'journal', removed: false },
    { term: 'notes', removed: false },
    { term: 'diary', removed: false },
  ]);
});

test('the hash matches the server: SHA-256 of the text with line breaks as \\n and no trailing white space', async () => {
  assert.equal(
    await hashText('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(await hashText('abc \r\n'), await hashText('abc'));
});

test('a fix is blocked by a locked version, a role that cannot stage, or a field a push cannot write', () => {
  const base = {
    canStage: true,
    locked: false,
    stageable: true,
    platform: 'ios' as const,
    field: 'keywords',
  };
  assert.equal(fixBlockedReason(base), null);
  assert.match(fixBlockedReason({ ...base, locked: true }) ?? '', /live or in review/);
  assert.match(fixBlockedReason({ ...base, canStage: false }) ?? '', /role/);
  assert.match(fixBlockedReason({ ...base, stageable: false, field: 'name' }) ?? '', /draft push/);
});
