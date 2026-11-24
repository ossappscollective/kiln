import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countChars, diffText, normalizeText, sidesOf, statsLine, wordsIn } from './text-diff.ts';

const join = (segs: { kind: string; text: string }[], skip: string) => segs.filter((s) => s.kind !== skip).map((s) => s.text).join('');
const holds = (a: string, b: string, o = {}) => {
  const r = diffText(a, b, o);
  assert.equal(join(r.segments, 'add'), normalizeText(a));
  assert.equal(join(r.segments, 'del'), normalizeText(b));
  return r;
};

test('empty and identical', () => {
  assert.deepEqual(diffText('', '').segments, []);
  assert.equal(diffText('', '').identical, true);
  const same = diffText('Hello world', 'Hello world');
  assert.deepEqual(same.segments, [{ kind: 'same', text: 'Hello world' }]);
  assert.equal(same.identical, true);
  assert.deepEqual(diffText('', 'new').segments, [{ kind: 'add', text: 'new' }]);
  assert.deepEqual(diffText('old', '').segments, [{ kind: 'del', text: 'old' }]);
});

test('word level: a replaced word reads old then new, stats count words', () => {
  const r = holds('The quick brown fox jumps over the lazy dog today', 'The quick red fox jumps over the lazy cat today');
  assert.equal(r.mode, 'word');
  assert.deepEqual(r.segments.filter((s) => s.kind !== 'same').map((s) => `${s.kind}:${s.text}`), ['del:brown', 'add:red', 'del:dog', 'add:cat']);
  assert.equal(r.stats.addedWords, 2);
  assert.equal(r.stats.removedWords, 2);
  assert.equal(statsLine(r.stats), '+2 / -2');
  assert.equal(r.identical, false);
});

test('short texts are diffed by characters', () => {
  const r = holds('Kiln', 'Kilns');
  assert.equal(r.mode, 'char');
  assert.deepEqual(r.segments, [{ kind: 'same', text: 'Kiln' }, { kind: 'add', text: 's' }]);
});

test('line endings are normalised: CRLF alone is no change', () => {
  assert.equal(diffText('a\r\nb', 'a\nb').identical, true);
  assert.equal(normalizeText('a\rb\r\nc'), 'a\nb\nc');
});

test('unicode, emoji, CJK and RTL', () => {
  const emoji = holds('Fast app \u{1F680} for you', 'Fast app \u{1F389} for you');
  assert.ok(emoji.segments.some((s) => s.kind === 'add' && s.text === '\u{1F389}'));
  const cjk = holds('こんにちは世界です', 'こんにちはユーザーです');
  assert.ok(cjk.stats.addedChars > 0);
  const rtl = holds('مرحبا بكم في التطبيق الجديد', 'مرحبا بكم في المتجر الجديد', { mode: 'word' });
  assert.deepEqual(rtl.segments.filter((s) => s.kind !== 'same').map((s) => s.kind), ['del', 'add']);
  assert.equal(countChars('a\u{1F680}'), 2);
  assert.equal(wordsIn('one, two  three!'), 3);
});

test('line mode for long multi paragraph text refines changed lines by words', () => {
  const before = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} says something useful about the app.`).join('\n\n');
  const after = before.replace('Paragraph 5 says something', 'Paragraph 5 states something');
  const r = holds(before, after, { mode: 'line' });
  assert.equal(r.mode, 'line');
  assert.deepEqual(r.segments.filter((s) => s.kind !== 'same').map((s) => `${s.kind}:${s.text}`), ['del:says', 'add:states']);
  assert.equal(diffText(before, after).mode, 'line');
});

test('4000+ characters are fast and the caps give a correct coarse diff', () => {
  const words = (n: number, seed: number) => Array.from({ length: n }, (_, i) => `w${(i * seed) % 97}`).join(' ');
  const a = words(1200, 7);
  const b = words(1200, 11);
  const t0 = Date.now();
  const r = holds(a, b);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(r.capped, true);
  const huge = holds('x'.repeat(30000), 'y'.repeat(30000));
  assert.equal(huge.capped, true);
  assert.deepEqual(huge.segments.map((s) => s.kind), ['del', 'add']);
  const near = holds(a, a.replace('w14', 'w99'));
  assert.equal(near.capped, false);
});

test('sidesOf returns the two sides', () => {
  const r = diffText('one two three', 'one 2 three');
  const s = sidesOf(r.segments);
  assert.equal(s.before.map((x) => x.text).join(''), 'one two three');
  assert.equal(s.after.map((x) => x.text).join(''), 'one 2 three');
  assert.equal(statsLine(diffText('a', 'a').stats), '');
});
