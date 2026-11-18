import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeText, splitLines } from './text-merge.ts';

const lines = (...l: string[]) => l.map((x) => `${x}\n`).join('');

test('splitLines keeps terminators and treats the last line without one as a line', () => {
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a'), ['a']);
  assert.deepEqual(splitLines('a\n'), ['a\n']);
  assert.deepEqual(splitLines('a\r\nb\n\nc'), ['a\r\n', 'b\n', '\n', 'c']);
});

type Case = {
  name: string;
  base: string;
  ours: string;
  theirs: string;
  /** The merged text, or null for a conflict. */
  merged: string | null;
};

const cases: Case[] = [
  {
    name: 'edits in different places merge',
    base: lines('a', 'b', 'c', 'd', 'e'),
    ours: lines('a', 'B', 'c', 'd', 'e'),
    theirs: lines('a', 'b', 'c', 'd', 'E'),
    merged: lines('a', 'B', 'c', 'd', 'E'),
  },
  {
    name: 'the same hunk edited differently is a conflict',
    base: lines('a', 'b', 'c'),
    ours: lines('a', 'ours', 'c'),
    theirs: lines('a', 'theirs', 'c'),
    merged: null,
  },
  {
    name: 'the same edit on both sides is made once',
    base: lines('a', 'b', 'c'),
    ours: lines('a', 'same', 'c'),
    theirs: lines('a', 'same', 'c'),
    merged: lines('a', 'same', 'c'),
  },
  {
    name: 'identical change next to another change on one side only',
    base: lines('a', 'b', 'c', 'd', 'e', 'f'),
    ours: lines('a', 'x', 'c', 'd', 'e', 'f'),
    theirs: lines('a', 'x', 'c', 'd', 'e', 'F'),
    merged: lines('a', 'x', 'c', 'd', 'e', 'F'),
  },
  {
    name: 'a line added at the start by one side and at the end by the other',
    base: lines('a', 'b'),
    ours: lines('top', 'a', 'b'),
    theirs: lines('a', 'b', 'bottom'),
    merged: lines('top', 'a', 'b', 'bottom'),
  },
  {
    name: 'both add at the end: a conflict when different, once when the same',
    base: lines('a'),
    ours: lines('a', 'x'),
    theirs: lines('a', 'y'),
    merged: null,
  },
  {
    name: 'both add the same line at the end',
    base: lines('a'),
    ours: lines('a', 'x'),
    theirs: lines('a', 'x'),
    merged: lines('a', 'x'),
  },
  {
    name: 'a deletion and an edit of the same line conflict',
    base: lines('a', 'b', 'c'),
    ours: lines('a', 'c'),
    theirs: lines('a', 'B', 'c'),
    merged: null,
  },
  {
    name: 'edits on adjacent lines conflict (as in git)',
    base: lines('a', 'b', 'c', 'd'),
    ours: lines('a', 'B', 'c', 'd'),
    theirs: lines('a', 'b', 'C', 'd'),
    merged: null,
  },
  {
    name: 'a deletion in one place and an addition in another merge',
    base: lines('a', 'b', 'c', 'd', 'e'),
    ours: lines('a', 'c', 'd', 'e'),
    theirs: lines('a', 'b', 'c', 'd', 'e', 'f'),
    merged: lines('a', 'c', 'd', 'e', 'f'),
  },
  {
    name: 'CRLF files merge and stay CRLF',
    base: 'a\r\nb\r\nc\r\nd\r\ne\r\n',
    ours: 'a\r\nB\r\nc\r\nd\r\ne\r\n',
    theirs: 'a\r\nb\r\nc\r\nd\r\nE\r\n',
    merged: 'a\r\nB\r\nc\r\nd\r\nE\r\n',
  },
  {
    name: 'CRLF against LF on the same line is a conflict',
    base: 'a\nb\nc\n',
    ours: 'a\r\nb\nc\n',
    theirs: 'a\nB\nc\n',
    // Different lines (a and b) but adjacent: a conflict, never a silent mix of line endings.
    merged: null,
  },
  {
    name: 'a file converted to CRLF by one side and edited by the other conflicts',
    base: 'a\nb\nc\n',
    ours: 'a\r\nb\r\nc\r\n',
    theirs: 'a\nb\nC\n',
    merged: null,
  },
  {
    name: 'trailing newline added by one side and a middle edit by the other',
    base: 'a\nb\nc\nd\ne',
    ours: 'a\nb\nc\nd\ne\n',
    theirs: 'a\nB\nc\nd\ne',
    merged: 'a\nB\nc\nd\ne\n',
  },
  {
    name: 'trailing newline added and the last line edited conflict',
    base: 'a\nb',
    ours: 'a\nb\n',
    theirs: 'a\nB',
    merged: null,
  },
  {
    name: 'an empty base: both add different text is a conflict',
    base: '',
    ours: 'x\n',
    theirs: 'y\n',
    merged: null,
  },
  {
    name: 'an empty base: one side adds',
    base: '',
    ours: 'x\n',
    theirs: '',
    merged: 'x\n',
  },
  {
    name: 'an emptied file against an untouched one',
    base: lines('a', 'b'),
    ours: '',
    theirs: lines('a', 'b'),
    merged: '',
  },
  {
    name: 'one side empties the file, the other edits a line: conflict',
    base: lines('a', 'b'),
    ours: '',
    theirs: lines('a', 'B'),
    merged: null,
  },
  {
    name: 'a single-line value changed on both sides (a listing field)',
    base: 'Old subtitle\n',
    ours: 'Our subtitle\n',
    theirs: 'Their subtitle\n',
    merged: null,
  },
  {
    name: 'a single-line value changed on one side only',
    base: 'Old subtitle\n',
    ours: 'Our subtitle\n',
    theirs: 'Old subtitle\n',
    merged: 'Our subtitle\n',
  },
  {
    name: 'a block moved by one side and an edit elsewhere by the other',
    base: lines('a', 'b', 'c', 'd', 'e', 'f', 'g'),
    ours: lines('c', 'a', 'b', 'd', 'e', 'f', 'g'),
    theirs: lines('a', 'b', 'c', 'd', 'e', 'f', 'G'),
    merged: lines('c', 'a', 'b', 'd', 'e', 'f', 'G'),
  },
];

for (const c of cases) {
  test(`merge: ${c.name}`, () => {
    const result = mergeText(c.base, c.ours, c.theirs);
    if (c.merged === null) {
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, 'conflict');
    } else {
      assert.deepEqual(result, { ok: true, text: c.merged });
    }
  });
}

test('merge: the result does not depend on which side is which when it is clean', () => {
  for (const c of cases) {
    const a = mergeText(c.base, c.ours, c.theirs);
    const b = mergeText(c.base, c.theirs, c.ours);
    assert.equal(a.ok, b.ok, c.name);
    if (a.ok && b.ok) assert.equal(a.text, b.text, c.name);
  }
});

test('merge: random disjoint edits always merge to the union of both', () => {
  // A small deterministic generator, so a failure can be reproduced.
  let seed = 12345;
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let round = 0; round < 200; round++) {
    const size = 12 + next(30);
    const base = Array.from({ length: size }, (_, i) => `line ${i}`);
    const ours = [...base];
    const theirs = [...base];
    const expected = [...base];
    // Even indices are ours, odd are theirs, never adjacent: indices at least 2 apart per side and
    // 3 apart across sides is guaranteed by stepping 3.
    for (let i = 1; i < size - 1; i += 3) {
      const kind = next(3);
      const target = next(2) === 0 ? ours : theirs;
      if (kind === 0) {
        target[i] = `changed ${i}`;
        expected[i] = `changed ${i}`;
      } else if (kind === 1) {
        target[i] = `${target[i]}\nextra ${i}`;
        expected[i] = `${expected[i]}\nextra ${i}`;
      } else {
        target[i] = '';
        expected[i] = '';
      }
    }
    const text = (l: string[]) => l.filter((x) => x !== '').map((x) => `${x}\n`).join('');
    const result = mergeText(text(base), text(ours), text(theirs));
    assert.equal(result.ok, true, `round ${round}`);
    if (result.ok) assert.equal(result.text, text(expected), `round ${round}`);
  }
});

test('merge: a large file with a few edits is cheap and exact', () => {
  const big = Array.from({ length: 200_000 }, (_, i) => `row ${i}`);
  const base = `${big.join('\n')}\n`;
  const ours = [...big];
  const theirs = [...big];
  ours[10] = 'ours at the top';
  theirs[199_990] = 'theirs at the bottom';
  const started = Date.now();
  const result = mergeText(base, `${ours.join('\n')}\n`, `${theirs.join('\n')}\n`);
  assert.ok(Date.now() - started < 5000, 'finishes in seconds');
  assert.equal(result.ok, true);
  if (result.ok) {
    const lines = result.text.split('\n');
    assert.equal(lines[10], 'ours at the top');
    assert.equal(lines[199_990], 'theirs at the bottom');
    assert.equal(lines.length, 200_001);
  }
});

test('merge: a rewrite bigger than the bound is refused, not computed', () => {
  const base = Array.from({ length: 5000 }, (_, i) => `a ${i}\n`).join('');
  const ours = Array.from({ length: 5000 }, (_, i) => `b ${i}\n`).join('');
  const theirs = `${base}tail\n`;
  const started = Date.now();
  const result = mergeText(base, ours, theirs);
  assert.deepEqual(result, { ok: false, reason: 'too_large' });
  assert.ok(Date.now() - started < 5000);
  // A larger bound lets it through (as a conflict here: both changed the end).
  assert.equal(mergeText(base, ours, theirs, { maxEdits: 20_000 }).ok, false);
});
