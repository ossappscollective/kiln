/**
 * Android binary XML (AXML), the format of `AndroidManifest.xml` inside an APK, read just far
 * enough to get the attributes of the `<manifest>` element: `versionCode`, `versionName` and
 * `package`. A chunk based format (every chunk starts with a type, a header size and a total size,
 * little endian): a string pool, an optional table of resource ids, then the XML events. Written
 * from the public layout of `ResXMLTree` (frameworks/base/include/androidfw/ResourceTypes.h); NOT
 * checked against real APKs here.
 *
 * Attribute names are matched by their resource id too (`versionCode` is 0x0101021b, `versionName`
 * 0x0101021c), because a manifest whose names were shortened by a tool keeps the ids. Any malformed
 * input is a thrown `AxmlError`; `readManifestAxml` turns that into null.
 */

export type ManifestInfo = {
  versionCode: string | null;
  versionName: string | null;
  packageName: string | null;
};

export class AxmlError extends Error {}

const CHUNK_XML = 0x0003;
const CHUNK_STRING_POOL = 0x0001;
const CHUNK_RESOURCE_MAP = 0x0180;
const CHUNK_START_ELEMENT = 0x0102;
const RES_VERSION_CODE = 0x0101021b;
const RES_VERSION_NAME = 0x0101021c;
const MAX_STRINGS = 200_000;

const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_BOOLEAN = 0x12;

function need(buf: Buffer, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > buf.length) throw new AxmlError('truncated');
}

function readStringPool(buf: Buffer, at: number, end: number): string[] {
  need(buf, at, 28);
  const count = buf.readUInt32LE(at + 8);
  const flags = buf.readUInt32LE(at + 16);
  const stringsStart = buf.readUInt32LE(at + 20);
  if (count > MAX_STRINGS || at + 28 + count * 4 > end) throw new AxmlError('string pool');
  const utf8 = (flags & 0x100) !== 0;
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let p = at + stringsStart + buf.readUInt32LE(at + 28 + i * 4);
    if (p >= end) throw new AxmlError('string offset');
    if (utf8) {
      const lengthOf = () => {
        need(buf, p, 1);
        const b = buf.readUInt8(p);
        if ((b & 0x80) === 0) {
          p += 1;
          return b;
        }
        need(buf, p, 2);
        const v = ((b & 0x7f) << 8) | buf.readUInt8(p + 1);
        p += 2;
        return v;
      };
      lengthOf(); // characters
      const bytes = lengthOf();
      need(buf, p, bytes);
      out.push(buf.toString('utf8', p, p + bytes));
    } else {
      need(buf, p, 2);
      let units = buf.readUInt16LE(p);
      p += 2;
      if ((units & 0x8000) !== 0) {
        need(buf, p, 2);
        units = ((units & 0x7fff) << 16) | buf.readUInt16LE(p);
        p += 2;
      }
      need(buf, p, units * 2);
      out.push(buf.toString('utf16le', p, p + units * 2));
    }
  }
  return out;
}

/**
 * The attributes of the root `<manifest>` element, or null when the document does not start with
 * one.
 */
export function readManifestAxml(buf: Buffer): ManifestInfo | null {
  need(buf, 0, 8);
  if (buf.readUInt16LE(0) !== CHUNK_XML) throw new AxmlError('not binary XML');
  const total = Math.min(buf.readUInt32LE(4), buf.length);
  let strings: string[] = [];
  let resourceIds: number[] = [];
  let at = buf.readUInt16LE(2);
  if (at < 8) throw new AxmlError('header');
  while (at + 8 <= total) {
    const type = buf.readUInt16LE(at);
    const header = buf.readUInt16LE(at + 2);
    const size = buf.readUInt32LE(at + 4);
    if (size < 8 || header < 8 || header > size || at + size > total) throw new AxmlError('chunk');
    if (type === CHUNK_STRING_POOL) strings = readStringPool(buf, at, at + size);
    else if (type === CHUNK_RESOURCE_MAP) {
      resourceIds = [];
      for (let p = at + header; p + 4 <= at + size; p += 4) resourceIds.push(buf.readUInt32LE(p));
    } else if (type === CHUNK_START_ELEMENT) {
      need(buf, at, 36);
      const nameIndex = buf.readInt32LE(at + 20);
      if (strings[nameIndex] !== 'manifest') return null;
      const attributeStart = buf.readUInt16LE(at + 24);
      const attributeSize = buf.readUInt16LE(at + 26);
      const attributeCount = buf.readUInt16LE(at + 28);
      if (attributeSize < 20) throw new AxmlError('attribute size');
      const info: ManifestInfo = { versionCode: null, versionName: null, packageName: null };
      for (let i = 0; i < attributeCount; i += 1) {
        const a = at + 16 + attributeStart + i * attributeSize;
        need(buf, a, 20);
        const namespace = buf.readInt32LE(a);
        const name = buf.readInt32LE(a + 4);
        const raw = buf.readInt32LE(a + 8);
        const dataType = buf.readUInt8(a + 15);
        const data = buf.readUInt32LE(a + 16);
        const text = (): string | null => {
          if (dataType === TYPE_STRING) return strings[data] ?? null;
          if (dataType === TYPE_INT_DEC || dataType === TYPE_INT_HEX) return String(data);
          if (dataType === TYPE_BOOLEAN || dataType === TYPE_REFERENCE) return null;
          return raw >= 0 ? (strings[raw] ?? null) : null;
        };
        const label = strings[name];
        const id = resourceIds[name];
        if (label === 'versionCode' || id === RES_VERSION_CODE) info.versionCode = text();
        else if (label === 'versionName' || id === RES_VERSION_NAME) info.versionName = text();
        else if (label === 'package' && namespace < 0) info.packageName = text();
      }
      return info;
    }
    at += size;
  }
  return null;
}
