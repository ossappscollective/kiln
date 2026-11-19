import { gunzip } from 'node:zlib';
import { analyticsLimits } from '@mrm/core';
import { AnalyticsError } from './analytics-types.ts';

/**
 * Reading a table that a store hands out as a file: bytes, optional gzip, a text encoding (UTF-8, or UTF-16 with a byte order mark),
 * and a delimited table (tab, comma or semicolon) with quoted fields. Every step has a cap, so a file cannot use more memory than
 * `analyticsLimits` allows, and a failure is an `AnalyticsError` with a fixed code, never the content of the file.
 */

export const isGzip = (bytes: Uint8Array): boolean => bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

/**
 * Decompresses a gzip file. The output is capped DURING decompression (`maxOutputLength`), so a small file that expands to
 * gigabytes stops at the cap. A file that is not a complete gzip stream is `bad_gzip`; one over the cap is `too_large`.
 */
export function gunzipCapped(bytes: Uint8Array, maxBytes: number, tooLarge: 'file_too_large' | 'segment_too_large' = 'file_too_large'): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    gunzip(bytes, { maxOutputLength: maxBytes }, (error, result) => {
      if (!error) return resolve(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError) return reject(new AnalyticsError(tooLarge));
      reject(new AnalyticsError('bad_gzip'));
    });
  });
}

/** A file as received: gzip when it starts with the gzip magic bytes (whatever its name), else as is. */
export async function openFileBytes(
  bytes: Uint8Array,
  limits: { maxFileBytes?: number; maxTextBytes?: number; tooLarge?: 'file_too_large' | 'segment_too_large' } = {},
): Promise<Uint8Array> {
  const maxFile = limits.maxFileBytes ?? analyticsLimits.maxFileBytes;
  const maxText = limits.maxTextBytes ?? analyticsLimits.maxTextBytes;
  const tooLarge = limits.tooLarge ?? 'file_too_large';
  if (bytes.length > maxFile) throw new AnalyticsError(tooLarge);
  if (isGzip(bytes)) return gunzipCapped(bytes, maxText, tooLarge);
  if (bytes.length > maxText) throw new AnalyticsError(tooLarge);
  return bytes;
}

/** UTF-8, UTF-16 LE or BE (by byte order mark, or by the NUL bytes of mostly-ASCII text). A leading mark is removed. */
export function decodeTableText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  // No mark: UTF-16 without one shows as a NUL after (LE) or before (BE) every ASCII character.
  const probe = bytes.subarray(0, Math.min(bytes.length, 400));
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i < probe.length; i++) {
    if (probe[i] === 0) {
      if (i % 2 === 0) evenNul++;
      else oddNul++;
    }
  }
  const pairs = Math.floor(probe.length / 2);
  if (pairs > 8 && oddNul > pairs * 0.6 && evenNul === 0) return new TextDecoder('utf-16le').decode(bytes);
  if (pairs > 8 && evenNul > pairs * 0.6 && oddNul === 0) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

export type Delimiter = '\t' | ',' | ';';

export type Table = {
  delimiter: Delimiter;
  header: string[];
  rows: string[][];
};

/** The delimiter of the header line: the one that occurs most outside quotes, a tab winning a tie. */
export function sniffDelimiter(text: string): Delimiter {
  let end = text.indexOf('\n');
  if (end < 0) end = text.length;
  const line = text.slice(0, end);
  const counts: Record<Delimiter, number> = { '\t': 0, ',': 0, ';': 0 };
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\t' || ch === ',' || ch === ';')) counts[ch]++;
  }
  if (counts['\t'] >= counts[','] && counts['\t'] >= counts[';'] && counts['\t'] > 0) return '\t';
  if (counts[','] >= counts[';'] && counts[','] > 0) return ',';
  if (counts[';'] > 0) return ';';
  return '\t';
}

/**
 * Parses a delimited table. Quotes (`"a, b"`, `""` for a quote), CRLF and LF, blank lines skipped. The header is the first line.
 * More than `maxRows` data rows is `file_too_large`; a header with more than `maxColumns` columns, or none, is `bad_format`.
 */
export function parseTable(text: string, limits: { maxRows?: number; maxColumns?: number } = {}): Table {
  const maxRows = limits.maxRows ?? analyticsLimits.maxRows;
  const maxColumns = limits.maxColumns ?? analyticsLimits.maxColumns;
  const delimiter = sniffDelimiter(text);
  const records: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  let any = false;
  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === '' && !any)) records.push(row);
    row = [];
    any = false;
    if (records.length > maxRows + 1) throw new AnalyticsError('file_too_large');
  };
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      any = true;
    } else if (ch === delimiter) {
      endField();
      any = true;
    } else if (ch === '\n') {
      endRow();
    } else if (ch === '\r') {
      if (text[i + 1] !== '\n') endRow();
    } else {
      field += ch;
      any = true;
    }
  }
  if (quoted) throw new AnalyticsError('bad_format');
  if (field !== '' || row.length > 0) endRow();
  const header = records.shift();
  if (!header || header.every((h) => h.trim() === '') || header.length > maxColumns) throw new AnalyticsError('bad_format');
  return { delimiter, header: header.map((h) => h.trim()), rows: records };
}

/** `Download Type`, `download_type` and ` DOWNLOAD  TYPE ` all become `download type`. */
export const normalizeHeader = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Column positions by normalized header name (the first column with a name wins). */
export function columnIndex(header: string[]): Map<string, number> {
  const index = new Map<string, number>();
  header.forEach((name, i) => {
    const key = normalizeHeader(name);
    if (key !== '' && !index.has(key)) index.set(key, i);
  });
  return index;
}

/** Bytes to a table in one step: gzip, encoding and parse, with the caps. */
export async function readTable(
  bytes: Uint8Array,
  limits: { maxFileBytes?: number; maxTextBytes?: number; maxRows?: number; tooLarge?: 'file_too_large' | 'segment_too_large' } = {},
): Promise<Table> {
  const opened = await openFileBytes(bytes, limits);
  return parseTable(decodeTableText(opened), limits);
}

/** A date written 2026-11-03, 2026-11-03T00:00:00Z or 11/03/2026 (Apple sales), as YYYY-MM-DD; undefined when it is none of those. */
export function parseDay(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(v);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  let y: number;
  let m: number;
  let d: number;
  if (iso) {
    y = Number(iso[1]);
    m = Number(iso[2]);
    d = Number(iso[3]);
  } else if (us) {
    y = Number(us[3]);
    m = Number(us[1]);
    d = Number(us[2]);
  } else return undefined;
  const t = Date.UTC(y, m - 1, d);
  const date = new Date(t);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return undefined;
  return date.toISOString().slice(0, 10);
}

/** A number as a store prints it: `1,234` is not accepted (a comma is a delimiter); `12`, `-3`, `0.25` and `1e-4` are. */
export function parseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (v === '' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
