/**
 * Property lists, read just far enough for an `Info.plist`: the binary form (`bplist00`, what Xcode
 * puts in an IPA) and the XML form. Values come back as plain data (dictionaries have no
 * prototype). Everything is capped (objects, depth, input size) so a hostile file cannot use more
 * than a little memory or time. Written from the published layout of both formats (CFBinaryPList.c,
 * PropertyList-1.0.dtd); NOT checked against a real IPA here. A malformed file is a thrown
 * `PlistError`.
 */

export type PlistValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | Date
  | Buffer
  | PlistValue[]
  | { [key: string]: PlistValue };

export class PlistError extends Error {}

const MAX_OBJECTS = 200_000;
const MAX_DEPTH = 32;
const MAX_INPUT = 8 * 1024 * 1024;
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

export function parsePlist(input: Buffer): PlistValue {
  if (input.length > MAX_INPUT) throw new PlistError('too large');
  if (input.length >= 8 && input.toString('latin1', 0, 8) === 'bplist00')
    return parseBinaryPlist(input);
  return parseXmlPlist(input.toString('utf8'));
}

// ---------------------------------------------------------------------------------------------
// Binary

function uintAt(buf: Buffer, at: number, bytes: number): number {
  if (bytes < 1 || bytes > 8 || at < 0 || at + bytes > buf.length) throw new PlistError('range');
  let n = 0;
  for (let i = 0; i < bytes; i += 1) n = n * 256 + buf.readUInt8(at + i);
  return n;
}

function parseBinaryPlist(buf: Buffer): PlistValue {
  if (buf.length < 8 + 32) throw new PlistError('short');
  const trailer = buf.length - 32;
  const offsetSize = buf.readUInt8(trailer + 6);
  const refSize = buf.readUInt8(trailer + 7);
  const count = uintAt(buf, trailer + 8, 8);
  const top = uintAt(buf, trailer + 16, 8);
  const tableAt = uintAt(buf, trailer + 24, 8);
  if (offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8) throw new PlistError('sizes');
  if (count < 1 || count > MAX_OBJECTS || top >= count) throw new PlistError('count');
  if (tableAt + count * offsetSize > trailer) throw new PlistError('offset table');
  let visited = 0;

  const offsetOf = (index: number): number => {
    if (index >= count) throw new PlistError('reference');
    const at = uintAt(buf, tableAt + index * offsetSize, offsetSize);
    if (at < 8 || at >= trailer) throw new PlistError('object offset');
    return at;
  };
  /** The length in the low nibble of a marker, or in an integer object that follows it. */
  const lengthAt = (at: number, info: number): { length: number; start: number } => {
    if (info !== 0xf) return { length: info, start: at + 1 };
    const marker = buf.readUInt8(at + 1);
    if (marker >> 4 !== 1) throw new PlistError('length');
    const bytes = 2 ** (marker & 0xf);
    return { length: uintAt(buf, at + 2, bytes), start: at + 2 + bytes };
  };

  const read = (index: number, depth: number): PlistValue => {
    if (depth > MAX_DEPTH) throw new PlistError('too deep');
    visited += 1;
    if (visited > MAX_OBJECTS) throw new PlistError('too many objects');
    const at = offsetOf(index);
    const marker = buf.readUInt8(at);
    const type = marker >> 4;
    const info = marker & 0xf;
    switch (type) {
      case 0x0:
        if (info === 8) return false;
        if (info === 9) return true;
        if (info === 0) return null;
        throw new PlistError('simple value');
      case 0x1: {
        const bytes = 2 ** info;
        if (bytes > 16 || at + 1 + bytes > trailer) throw new PlistError('integer');
        if (bytes === 8) return buf.readBigInt64BE(at + 1) as bigint;
        if (bytes > 8) throw new PlistError('integer size');
        return uintAt(buf, at + 1, bytes);
      }
      case 0x2:
        if (info === 2) return buf.readFloatBE(at + 1);
        if (info === 3) return buf.readDoubleBE(at + 1);
        throw new PlistError('real');
      case 0x3:
        return new Date(APPLE_EPOCH_MS + buf.readDoubleBE(at + 1) * 1000);
      case 0x4: {
        const { length, start } = lengthAt(at, info);
        if (start + length > trailer) throw new PlistError('data');
        return Buffer.from(buf.subarray(start, start + length));
      }
      case 0x5: {
        const { length, start } = lengthAt(at, info);
        if (start + length > trailer) throw new PlistError('string');
        return buf.toString('latin1', start, start + length);
      }
      case 0x6: {
        const { length, start } = lengthAt(at, info);
        if (start + length * 2 > trailer) throw new PlistError('string');
        return Buffer.from(buf.subarray(start, start + length * 2)).swap16().toString('utf16le');
      }
      case 0x8:
        return uintAt(buf, at + 1, info + 1);
      case 0xa: {
        const { length, start } = lengthAt(at, info);
        if (start + length * refSize > trailer) throw new PlistError('array');
        const out: PlistValue[] = [];
        for (let i = 0; i < length; i += 1)
          out.push(read(uintAt(buf, start + i * refSize, refSize), depth + 1));
        return out;
      }
      case 0xd: {
        const { length, start } = lengthAt(at, info);
        if (start + length * refSize * 2 > trailer) throw new PlistError('dictionary');
        const out: { [key: string]: PlistValue } = Object.create(null);
        for (let i = 0; i < length; i += 1) {
          const key = read(uintAt(buf, start + i * refSize, refSize), depth + 1);
          if (typeof key !== 'string') throw new PlistError('key');
          out[key] = read(uintAt(buf, start + (length + i) * refSize, refSize), depth + 1);
        }
        return out;
      }
      default:
        throw new PlistError(`object type ${type}`);
    }
  };
  return read(top, 0);
}

// --------------------------------------------------------------------------------------------- XML

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1] === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[name] ?? whole;
  });

type Frame =
  | { kind: 'array'; value: PlistValue[] }
  | { kind: 'dict'; value: { [key: string]: PlistValue }; key: string | null };

function parseXmlPlist(xml: string): PlistValue {
  // comment | declaration | doctype | CDATA (1) | tag: closing slash (2), name (3), self closing
  // slash (4) | text (5)
  const token = new RegExp(
    [
      '<!--[\\s\\S]*?-->',
      '<\\?[\\s\\S]*?\\?>',
      '<!DOCTYPE[^>]*>',
      '<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>',
      '<(/?)([A-Za-z]+)(?:\\s[^>]*?)?(/?)>',
      '([^<]+)',
    ].join('|'),
    'g',
  );
  const stack: Frame[] = [];
  let root: PlistValue | undefined;
  let text = '';
  let open: string | null = null;
  let objects = 0;

  const put = (value: PlistValue): void => {
    objects += 1;
    if (objects > MAX_OBJECTS) throw new PlistError('too many objects');
    const top = stack[stack.length - 1];
    if (!top) {
      root = value;
      return;
    }
    if (top.kind === 'array') top.value.push(value);
    else {
      if (top.key === null) throw new PlistError('value without key');
      top.value[top.key] = value;
      top.key = null;
    }
  };
  const scalar = (name: string, raw: string): PlistValue => {
    switch (name) {
      case 'string':
        return decodeEntities(raw);
      case 'integer': {
        const n = raw.trim();
        if (!/^-?[0-9]+$/.test(n)) throw new PlistError('integer');
        const value = BigInt(n);
        return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(value)
          : value;
      }
      case 'real': {
        const n = Number(raw.trim());
        if (Number.isNaN(n)) throw new PlistError('real');
        return n;
      }
      case 'date':
        return new Date(raw.trim());
      case 'data':
        return Buffer.from(raw.replace(/\s+/g, ''), 'base64');
      default:
        throw new PlistError(`element ${name}`);
    }
  };

  for (let m = token.exec(xml); m !== null; m = token.exec(xml)) {
    if (m[1] !== undefined) {
      text += m[1];
      continue;
    }
    if (m[5] !== undefined) {
      if (open !== null) text += m[5];
      continue;
    }
    const name = m[3];
    if (name === undefined) continue; // a comment, declaration or doctype
    const closing = m[2] === '/';
    const selfClosing = m[4] === '/';
    if (!closing) {
      if (name === 'plist') continue;
      if (name === 'dict') {
        const frame: Frame = { kind: 'dict', value: Object.create(null), key: null };
        if (stack.length >= MAX_DEPTH) throw new PlistError('too deep');
        stack.push(frame);
        if (selfClosing) {
          stack.pop();
          put(frame.value);
        }
        continue;
      }
      if (name === 'array') {
        if (stack.length >= MAX_DEPTH) throw new PlistError('too deep');
        const frame: Frame = { kind: 'array', value: [] };
        stack.push(frame);
        if (selfClosing) {
          stack.pop();
          put(frame.value);
        }
        continue;
      }
      if (name === 'true' || name === 'false') {
        put(name === 'true');
        continue;
      }
      if (selfClosing) {
        if (name === 'key') {
          const top = stack[stack.length - 1];
          if (top?.kind !== 'dict') throw new PlistError('key outside a dictionary');
          top.key = '';
        } else put(scalar(name, ''));
        continue;
      }
      open = name;
      text = '';
      continue;
    }
    // A closing tag.
    if (name === 'plist') continue;
    if (name === 'dict' || name === 'array') {
      const frame = stack.pop();
      if (!frame || frame.kind !== name) throw new PlistError('unbalanced');
      if (frame.kind === 'dict' && frame.key !== null) throw new PlistError('key without value');
      put(frame.value);
      continue;
    }
    if (open !== name) throw new PlistError('unbalanced');
    open = null;
    if (name === 'key') {
      const top = stack[stack.length - 1];
      if (top?.kind !== 'dict') throw new PlistError('key outside a dictionary');
      top.key = decodeEntities(text);
    } else put(scalar(name, text));
    text = '';
  }
  if (stack.length > 0 || root === undefined) throw new PlistError('incomplete');
  return root;
}
