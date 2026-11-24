import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkListing } from '../insights/listing-checks.ts';
import { countBytes } from './listing.ts';
import { analyzeFixes, fitKeywords, keywordTerms, proposeFixes, stageableFixesOf, tidyKeywords, tidyText } from './fixes.ts';

const apple = (fields: Record<string, string>, locale = 'en-US') => ({ platform: 'ios' as const, store: 'app_store' as const, locale, fields });
const play = (fields: Record<string, string>) => ({ platform: 'android' as const, store: 'google_play' as const, locale: 'en-US', fields });
const page = { name: 'Pocket Notes Pro', subtitle: 'Write, plan and remember', description: 'A long description. '.repeat(20), promotional_text: 'New.' };
const ids = (fixes: { id: string; field: string }[]) => fixes.map((f) => `${f.id}:${f.field}`);

test('hygiene: spaces, empty terms, trailing commas and repeated terms go; the first of a repeat stays', () => {
  const out = tidyKeywords(' journal ,  diary,, todo ,Journal,  ', 'en');
  assert.equal(out.value, 'journal,diary,todo');
  assert.deepEqual(out.removed, ['Journal']);
  assert.deepEqual(keywordTerms('a  b , ,c,'), ['a b', 'c']);
});

test('a tidy fix is safe, staged as the whole field, and idempotent', () => {
  const input = apple({ ...page, keywords: 'journal, diary, journal ,todo,' });
  const fixes = proposeFixes(input);
  assert.deepEqual(ids(fixes), ['keywords_tidy:keywords']);
  const fix = fixes[0];
  assert.equal(fix?.after, 'journal,diary,todo');
  assert.equal(fix?.risk, 'safe');
  assert.deepEqual(fix?.removed, ['journal']);
  assert.deepEqual(proposeFixes(apple({ ...page, keywords: fix?.after ?? '' })), []);
});

test('already valid input yields no fix and no unfixable finding', () => {
  const out = analyzeFixes(apple({ ...page, keywords: 'journal,diary,todo,checklist,memo' }));
  assert.deepEqual(out, { fixes: [], cannot: [] });
  assert.deepEqual(analyzeFixes(play({ title: 'Pocket Notes', short_description: 'Write and plan', full_description: 'Long text.' })), { fixes: [], cannot: [] });
});

test('over the byte limit: whole trailing terms go, names the exact terms, and the result passes checkListing', () => {
  const keywords = ['journal', 'diary', 'todo', 'checklist', 'memo', 'ideas', 'writing', 'planner', 'tasks', 'reminder', 'agenda', 'organizer', 'schedule', 'calendar', 'project'].join(',');
  assert.ok(countBytes(keywords) > 100);
  const input = apple({ ...page, keywords });
  const fit = proposeFixes(input).find((f) => f.id === 'keywords_fit');
  assert.ok(fit?.after);
  assert.ok(countBytes(fit.after) <= 100);
  assert.equal(fit.after, keywords.split(',').slice(0, fit.after.split(',').length).join(','), 'only trailing terms were dropped');
  assert.deepEqual(fit.removed, keywords.split(',').slice(fit.after.split(',').length).reverse());
  assert.equal(fit.risk, 'review');
  const check = checkListing({ store: 'app_store', locales: [{ locale: 'en-US', fields: { ...input.fields, keywords: fit.after } }] });
  assert.equal(check.locales[0]?.issues.some((i) => i.code === 'too_long'), false);
});

test('terms the name or subtitle already index are dropped first, wherever they stand', () => {
  const terms = ['notes', 'journal', 'diary', 'todo', 'checklist', 'memo', 'ideas', 'writing', 'planner', 'tasks', 'reminder', 'agenda', 'organizer', 'calendar', 'project', 'habit'];
  const out = fitKeywords(terms.join(','), { language: 'en', name: 'Pocket Notes Pro', subtitle: 'Write, plan and remember', maxBytes: 100 });
  assert.ok(out);
  assert.equal(out.removed[0], 'notes');
  assert.ok(!out.value.split(',').includes('notes'));
  assert.ok(countBytes(out.value) <= 100);
});

test('bytes, not characters: multibyte terms count their UTF-8 bytes and a word is never cut', () => {
  const terms = ['日記', '手帳', 'メモ', 'ノート', 'タスク', '予定', '計画', '習慣', '目標', '記録', '整理', '管理', '日程', '備忘', '手記', '覚書', '予約', '年表'];
  const value = terms.join(',');
  assert.ok(Array.from(value).length < 100 && countBytes(value) > 100);
  const out = fitKeywords(value, { language: 'ja', maxBytes: 100 });
  assert.ok(out && countBytes(out.value) <= 100);
  for (const t of out.value.split(',')) assert.ok(terms.indexOf(t) >= 0, 'every kept term is whole');
  assert.equal(countBytes(out.value) + 0, countBytes(terms.slice(0, out.value.split(',').length).join(',')));
});

test('never an empty result: one term that alone is over the limit cannot be fixed automatically', () => {
  assert.equal(fitKeywords('x'.repeat(120), { language: 'en', maxBytes: 100 }), null);
  const out = analyzeFixes(apple({ ...page, keywords: 'x'.repeat(120) }));
  assert.deepEqual(out.fixes, []);
  assert.deepEqual(out.cannot, [{ locale: 'en-US', field: 'keywords', code: 'too_long' }]);
});

test('terms in the name or subtitle: one fix drops them, listing which', () => {
  const fixes = proposeFixes(apple({ ...page, keywords: 'notes,journal,write,diary' }));
  const fix = fixes.find((f) => f.id === 'keywords_drop_in_title');
  assert.equal(fix?.after, 'journal,diary');
  assert.deepEqual(fix?.removed, ['notes', 'write']);
  assert.equal(fix?.risk, 'review');
});

test('fix all takes the strongest stageable fix per field', () => {
  const keywords = ['notes', 'journal', 'diary', 'todo', 'checklist', 'memo', 'ideas', 'writing', 'planner', 'tasks', 'reminder', 'agenda', 'organizer', 'write', 'calendar', 'project'].join(', ');
  const fixes = proposeFixes(apple({ ...page, keywords }));
  assert.ok(fixes.length >= 2);
  const best = stageableFixesOf(fixes);
  assert.deepEqual(ids(best), ['keywords_fit:keywords']);
});

test('prose is never truncated: an over-long Apple name gets editor and AI, and says it cannot be staged', () => {
  const fixes = proposeFixes(apple({ ...page, name: 'A very long name for a small notes app' }));
  assert.deepEqual(ids(fixes), ['shorten_ai:name', 'edit_field:name']);
  assert.ok(fixes.every((f) => f.after === null && f.stageable === false));
  assert.deepEqual(stageableFixesOf(fixes), []);
});

test('Play: an over-long short description gets AI and the editor, stageable; nothing is cut', () => {
  const fixes = proposeFixes(play({ title: 'Pocket Notes', short_description: 'Write, plan and remember everything in one tidy place. '.repeat(2), full_description: 'Long text.' }));
  assert.deepEqual(ids(fixes), ['shorten_ai:short_description', 'edit_field:short_description']);
  assert.ok(fixes.every((f) => f.stageable));
});

test('Play has no keyword fields: no keyword fix whatever the fields hold', () => {
  const fixes = proposeFixes(play({ title: 'Pocket Notes', short_description: 'Write', full_description: 'Long text.', keywords: 'a, b, a' }));
  assert.deepEqual(fixes, []);
});

test('white space that pushes a text over the limit is collapsed (review), only when that makes it fit', () => {
  assert.equal(tidyText('  Write   and\t plan \r\n\r\n\r\n\r\nnow  '), 'Write and plan\n\nnow');
  const fixes = proposeFixes(play({ title: 'Pocket   Notes   for   all   writers', short_description: 'Write', full_description: 'x' }));
  const fix = fixes.find((f) => f.field === 'title');
  assert.equal(fix?.id, 'text_tidy');
  assert.equal(fix?.after, 'Pocket Notes for all writers');
  assert.equal(fix?.risk, 'review');
});

test('a required field left empty: open the editor, no invented text', () => {
  const fixes = proposeFixes(play({ title: '', short_description: 'Write', full_description: 'Long text.' }));
  assert.deepEqual(ids(fixes), ['edit_field:title']);
  assert.equal(fixes[0]?.after, null);
  assert.equal(fixes[0]?.kind, 'edit_field');
});

test('Apple and Play differ: the same long text is a keyword problem on Apple only', () => {
  const long = 'a'.repeat(60) + ',' + 'b'.repeat(60);
  assert.ok(proposeFixes(apple({ ...page, keywords: long })).some((f) => f.id === 'keywords_fit'));
  assert.deepEqual(proposeFixes(play({ title: 'T', short_description: 'S', full_description: 'F', keywords: long })), []);
});
