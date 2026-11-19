import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QR_MAX_BYTES, codewordsOf, qrMatrix, qrPath } from './qr.ts';

// Checked structurally and by the algebra of the code (no decoder is available here): the finder patterns, the timing rows, the
// format bits (BCH), and the Reed-Solomon codewords. A scan with a real phone is the last check (docs/research/test-builds.md).

const finderAt = (m: boolean[][], x: number, y: number) => {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const edge = dx === 0 || dx === 6 || dy === 0 || dy === 6;
      const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      assert.equal(m[y + dy]?.[x + dx], edge || core, `finder module ${dx},${dy} at ${x},${y}`);
    }
  }
};

test('the size follows the version, and the three finder patterns and the timing rows are in place', () => {
  const m = qrMatrix('https://ex.co/a') as boolean[][];
  assert.equal(m.length, 21, 'version 1 for a short text');
  finderAt(m, 0, 0);
  finderAt(m, 14, 0);
  finderAt(m, 0, 14);
  for (let i = 8; i < 13; i++) {
    assert.equal(m[6]?.[i], i % 2 === 0);
    assert.equal(m[i]?.[6], i % 2 === 0);
  }
  assert.equal(m[13]?.[8], true, 'the dark module');
  const big = qrMatrix(`https://x.example/${'a'.repeat(80)}`) as boolean[][];
  assert.equal(big.length, 4 * 5 + 17, 'a longer text takes version 5 (106 bytes)');
});

test('the format information carries error correction level L and a mask, with a valid BCH code', () => {
  for (const text of ['a', 'https://example.com/api/builds/dl/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB']) {
    const m = qrMatrix(text) as boolean[][];
    const size = m.length;
    let first = 0;
    for (let i = 0; i <= 5; i++) first |= (m[i]?.[8] ? 1 : 0) << i;
    first |= (m[7]?.[8] ? 1 : 0) << 6;
    first |= (m[8]?.[8] ? 1 : 0) << 7;
    first |= (m[8]?.[7] ? 1 : 0) << 8;
    for (let i = 9; i < 15; i++) first |= (m[8]?.[14 - i] ? 1 : 0) << i;
    let second = 0;
    for (let i = 0; i < 8; i++) second |= (m[8]?.[size - 1 - i] ? 1 : 0) << i;
    for (let i = 8; i < 15; i++) second |= (m[size - 15 + i]?.[8] ? 1 : 0) << i;
    assert.equal(first, second, 'both copies agree');
    const data = (first ^ 0x5412) >>> 10;
    assert.equal(data >>> 3, 1, 'level L');
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    assert.equal(((data << 10) | rem) ^ 0x5412, first, 'BCH remainder');
  }
});

test('the codewords hold the text (mode, length, bytes, padding) and check words that vanish at the roots of the generator', () => {
  const coded = codewordsOf(Array.from(new TextEncoder().encode('hi')));
  assert.ok(coded);
  assert.equal(coded.version, 1);
  assert.equal(coded.words.length, 26, 'version 1 has 26 codewords');
  // 0100 | 00000010 | 'h' | 'i' | 0000 (terminator), then the pad bytes 0xEC 0x11.
  assert.deepEqual(coded.words.slice(0, 7), [0x40, 0x26, 0x86, 0x90, 0xec, 0x11, 0xec]);
  // A valid Reed-Solomon codeword is zero at alpha^0 .. alpha^(n-1), where n is the number of check words (7 for version 1-L).
  const mul = (x: number, y: number) => {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  };
  let root = 1;
  for (let k = 0; k < 7; k++) {
    let value = 0;
    for (const w of coded.words) value = mul(value, root) ^ w;
    assert.equal(value, 0, `zero at alpha^${k}`);
    root = mul(root, 2);
  }
  assert.deepEqual(codewordsOf(Array.from(new TextEncoder().encode('hi')))?.words, coded.words, 'stable');
});

test('several blocks are interleaved to the raw capacity of the version', () => {
  const text = 'https://example.com/api/builds/dl/'.padEnd(140, 'z'); // version 7: two blocks
  const coded = codewordsOf(Array.from(new TextEncoder().encode(text)));
  assert.ok(coded);
  assert.equal(coded.version, 7);
  assert.equal(coded.words.length, 196);
});

test('a text that is too long gives null; the limit is the capacity of version 10', () => {
  assert.notEqual(qrMatrix('x'.repeat(QR_MAX_BYTES)), null);
  assert.equal(qrMatrix('x'.repeat(QR_MAX_BYTES + 1)), null);
  assert.equal(QR_MAX_BYTES, 271, 'version 10-L holds 271 bytes');
});

test('the path draws every dark module and adds the quiet zone', () => {
  const m = qrMatrix('a') as boolean[][];
  const { d, size } = qrPath(m, 4);
  assert.equal(size, 29);
  let area = 0;
  for (const part of d.split('z')) {
    const match = /^M\d+ \d+h(\d+)v1h-\d+$/.exec(part);
    if (match) area += Number(match[1]);
  }
  assert.equal(area, m.flat().filter(Boolean).length);
});
