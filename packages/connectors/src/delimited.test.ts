import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import * as fx from './analytics.fixtures.ts';
import { AnalyticsError } from './analytics-types.ts';
import {
  columnIndex,
  decodeTableText,
  gunzipCapped,
  normalizeHeader,
  openFileBytes,
  parseDay,
  parseNumber,
  parseTable,
  readTable,
  sniffDelimiter,
} from './delimited.ts';

const code = (fn: () => unknown) => async () => {
  try {
    await fn();
  } catch (error) {
    return error instanceof AnalyticsError ? error.code : `other:${String(error)}`;
  }
  return 'no error';
};

test('parseTable: tab, comma and semicolon are sniffed from the header; a tab wins a tie', () => {
  assert.equal(sniffDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(sniffDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(sniffDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(sniffDelimiter('"a,b"\tc\n1\t2'), '\t', 'a comma inside quotes does not count');
  assert.equal(parseTable('a\tb\n1\t2\n').delimiter, '\t');
});

test('parseTable: quotes, doubled quotes, CRLF, blank lines, short rows', () => {
  const t = parseTable('Name,Note\r\n"Smith, J","He said ""hi"""\r\n\r\nplain,\r\nshort\r\n');
  assert.deepEqual(t.header, ['Name', 'Note']);
  assert.deepEqual(t.rows, [['Smith, J', 'He said "hi"'], ['plain', ''], ['short']]);
  // A multi-line quoted field stays in one cell.
  assert.deepEqual(parseTable('a,b\n"x\ny",z\n').rows, [['x\ny', 'z']]);
});

test('parseTable: no header, an unterminated quote and too many columns are bad_format', async () => {
  assert.equal(await code(() => parseTable(''))(), 'bad_format');
  assert.equal(await code(() => parseTable('\t\t\n1\t2\t3'))(), 'bad_format');
  assert.equal(await code(() => parseTable('a,b\n"open,1\n'))(), 'bad_format');
  assert.equal(
    await code(() =>
      parseTable(`${Array.from({ length: 20 }, (_, i) => `c${i}`).join(',')}\n`, { maxColumns: 5 }),
    )(),
    'bad_format',
  );
});

test('parseTable: more rows than the cap is file_too_large', async () => {
  const rows = `a,b\n${'1,2\n'.repeat(50)}`;
  assert.equal(parseTable(rows, { maxRows: 50 }).rows.length, 50);
  assert.equal(await code(() => parseTable(rows, { maxRows: 49 }))(), 'file_too_large');
});

test('headers are read by normalized name, whatever the case, spacing or underscores', () => {
  assert.equal(normalizeHeader(' Download_Type '), 'download type');
  assert.equal(normalizeHeader('Pre-Order'), 'pre order');
  const index = columnIndex(['Date', 'UNIQUE  counts', 'Date']);
  assert.equal(index.get('unique counts'), 1);
  assert.equal(index.get('date'), 0, 'the first column of a name wins');
});

test('decodeTableText: UTF-8 with and without a mark, UTF-16 with a mark (LE and BE) and without', () => {
  const text = 'Date,Name\n2026-11-10,Café\n';
  assert.equal(decodeTableText(new Uint8Array(Buffer.from(text))), text);
  assert.equal(
    decodeTableText(
      new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])),
    ),
    text,
  );
  assert.equal(decodeTableText(fx.utf16le(text)), text);
  const be = Buffer.from(text, 'utf16le').swap16();
  assert.equal(
    decodeTableText(new Uint8Array(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))),
    text,
  );
  assert.equal(
    decodeTableText(fx.utf16leNoBom(text.repeat(3))),
    text.repeat(3),
    'NUL bytes of ASCII text give UTF-16 away',
  );
});

test('gunzipCapped: decompresses, refuses a bad file and stops a bomb at the cap', async () => {
  const body = 'x'.repeat(5000);
  assert.equal(Buffer.from(await gunzipCapped(fx.gz(body), 10_000)).toString(), body);
  assert.equal(
    await code(() => gunzipCapped(new Uint8Array(Buffer.from('not gzip at all')), 1000))(),
    'bad_gzip',
  );
  const truncated = fx.gz(body).slice(0, 12);
  assert.equal(await code(() => gunzipCapped(truncated, 10_000))(), 'bad_gzip');
  // 20 MB of zeros compress to a few kilobytes: the cap is applied while decompressing.
  const bomb = new Uint8Array(gzipSync(Buffer.alloc(20 * 1024 * 1024)));
  assert.ok(bomb.length < 100_000);
  assert.equal(await code(() => gunzipCapped(bomb, 1024 * 1024))(), 'file_too_large');
  assert.equal(
    await code(() => gunzipCapped(bomb, 1024 * 1024, 'segment_too_large'))(),
    'segment_too_large',
  );
});

test('openFileBytes and readTable: gzip is recognised by its bytes, not its name, and both sizes are capped', async () => {
  const csv = 'a,b\n1,2\n';
  assert.deepEqual((await readTable(fx.gz(csv))).rows, [['1', '2']]);
  assert.deepEqual((await readTable(new Uint8Array(Buffer.from(csv)))).rows, [['1', '2']]);
  assert.equal(
    await code(() => openFileBytes(new Uint8Array(100), { maxFileBytes: 50 }))(),
    'file_too_large',
  );
  assert.equal(
    await code(() => openFileBytes(new Uint8Array(100), { maxTextBytes: 50 }))(),
    'file_too_large',
  );
  assert.equal(
    await code(() => readTable(fx.gz(csv.repeat(1000)), { maxTextBytes: 100 }))(),
    'file_too_large',
  );
});

test('parseDay and parseNumber accept the likely formats and nothing else', () => {
  assert.equal(parseDay('2026-11-10'), '2026-11-10');
  assert.equal(parseDay('2026-11-10T00:00:00Z'), '2026-11-10');
  assert.equal(parseDay('11/10/2026'), '2026-11-10');
  assert.equal(parseDay('2026-02-30'), undefined);
  assert.equal(parseDay('10 Nov 2026'), undefined);
  assert.equal(parseDay(undefined), undefined);
  assert.equal(parseNumber('12'), 12);
  assert.equal(parseNumber(' -3 '), -3);
  assert.equal(parseNumber('0.25'), 0.25);
  assert.equal(parseNumber('1e-4'), 0.0001);
  assert.equal(parseNumber('1,234'), undefined);
  assert.equal(parseNumber('abc'), undefined);
  assert.equal(parseNumber(''), undefined);
  assert.equal(parseNumber('NaN'), undefined);
});
