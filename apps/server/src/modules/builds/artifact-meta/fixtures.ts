import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Builders of tiny build files for the tests and the demo: a zip, Android binary XML, an aapt2
 * protobuf manifest and a property list, assembled by hand from the documented layouts. They are
 * NOT real APK, AAB or IPA files (no code, no resources, no signature), and the reader has not been
 * run against real ones: these only prove that the reader and the builders agree on the layouts.
 */

const le = (value: number, bytes: number): Buffer => {
  const out = Buffer.alloc(bytes);
  if (bytes === 1) out.writeUInt8(value);
  else if (bytes === 2) out.writeUInt16LE(value);
  else out.writeUInt32LE(value >>> 0);
  return out;
};

export type ZipInput = { name: string; data: Uint8Array | string; method?: 'store' | 'deflate' };

/** A zip archive with stored or deflate entries, real CRCs and the usual central directory. */
export function zipOf(files: ZipInput[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.from(typeof f.data === 'string' ? Buffer.from(f.data) : f.data);
    const name = Buffer.from(f.name);
    const deflate = f.method === 'deflate';
    const body = deflate ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const common = Buffer.concat([
      le(deflate ? 8 : 0, 2),
      le(0, 2), // time
      le(0x21, 2), // date
      le(crc, 4),
      le(body.length, 4),
      le(data.length, 4),
      le(name.length, 2),
      le(0, 2), // extra
    ]);
    const local = Buffer.concat([le(0x04034b50, 4), le(20, 2), le(0, 2), common, name, body]);
    central.push(
      Buffer.concat([
        le(0x02014b50, 4),
        le(20, 2),
        le(20, 2),
        le(0, 2),
        common,
        le(0, 2), // comment
        le(0, 2), // disk
        le(0, 2), // internal attributes
        le(0, 4), // external attributes
        le(offset, 4),
        name,
      ]),
    );
    parts.push(local);
    offset += local.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.concat([
    le(0x06054b50, 4),
    le(0, 2),
    le(0, 2),
    le(files.length, 2),
    le(files.length, 2),
    le(dir.length, 4),
    le(offset, 4),
    le(0, 2),
  ]);
  return Buffer.concat([...parts, dir, end]);
}

// ---------------------------------------------------------------------------------------------
// Android binary XML

export type ManifestFields = {
  /** null leaves the attribute out. */
  versionCode?: number | null;
  versionName?: string | null;
  packageName?: string | null;
  /** The name of the root element (default `manifest`). */
  root?: string;
};

const pad4 = (b: Buffer): Buffer =>
  b.length % 4 === 0 ? b : Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]);

function stringPool(strings: string[], utf8: boolean): Buffer {
  const encoded = strings.map((s) => {
    if (utf8) {
      const bytes = Buffer.from(s, 'utf8');
      return Buffer.concat([Buffer.from([s.length, bytes.length]), bytes, Buffer.alloc(1)]);
    }
    const chars = Buffer.from(s, 'utf16le');
    return Buffer.concat([le(s.length, 2), chars, Buffer.alloc(2)]);
  });
  const offsets: number[] = [];
  let at = 0;
  for (const e of encoded) {
    offsets.push(at);
    at += e.length;
  }
  const data = pad4(Buffer.concat(encoded));
  const start = 28 + strings.length * 4;
  return Buffer.concat([
    le(0x0001, 2),
    le(28, 2),
    le(start + data.length, 4),
    le(strings.length, 4),
    le(0, 4),
    le(utf8 ? 0x100 : 0, 4),
    le(start, 4),
    le(0, 4),
    ...offsets.map((o) => le(o, 4)),
    data,
  ]);
}

/**
 * The binary `AndroidManifest.xml` of an APK, with the three attributes of `<manifest>` the reader
 * looks for.
 */
export function axmlManifest(
  fields: ManifestFields & { utf8?: boolean; resourceIds?: boolean } = {},
): Buffer {
  const strings = ['versionCode', 'versionName', 'package', fields.root ?? 'manifest', 'android'];
  const index = (s: string) => {
    const at = strings.indexOf(s);
    if (at >= 0) return at;
    strings.push(s);
    return strings.length - 1;
  };
  const attrs: Buffer[] = [];
  const attr = (ns: number, name: number, raw: number, type: number, data: number) =>
    Buffer.concat([
      le(ns, 4),
      le(name, 4),
      le(raw, 4),
      le(8, 2),
      le(0, 1),
      le(type, 1),
      le(data, 4),
    ]);
  if (fields.versionCode !== null && fields.versionCode !== undefined)
    attrs.push(attr(-1, 0, -1, 0x10, fields.versionCode));
  if (fields.versionName) {
    const v = index(fields.versionName);
    attrs.push(attr(-1, 1, v, 0x03, v));
  }
  if (fields.packageName) {
    const v = index(fields.packageName);
    attrs.push(attr(-1, 2, v, 0x03, v));
  }
  const pool = stringPool(strings, fields.utf8 === true);
  const map = fields.resourceIds
    ? Buffer.concat([
        le(0x0180, 2),
        le(8, 2),
        le(8 + 12, 4),
        le(0x0101021b, 4),
        le(0x0101021c, 4),
        le(0, 4),
      ])
    : Buffer.alloc(0);
  const start = Buffer.concat([
    le(0x0102, 2),
    le(16, 2),
    le(36 + attrs.length * 20, 4),
    le(1, 4),
    le(-1, 4),
    le(-1, 4),
    le(3, 4),
    le(0x14, 2),
    le(0x14, 2),
    le(attrs.length, 2),
    le(0, 2),
    le(0, 2),
    le(0, 2),
    ...attrs,
  ]);
  const end = Buffer.concat([
    le(0x0103, 2),
    le(16, 2),
    le(24, 4),
    le(1, 4),
    le(-1, 4),
    le(-1, 4),
    le(3, 4),
  ]);
  const body = Buffer.concat([pool, map, start, end]);
  return Buffer.concat([le(0x0003, 2), le(8, 2), le(8 + body.length, 4), body]);
}

// ---------------------------------------------------------------------------------------------
// aapt2 protobuf XML (the manifest of an AAB)

const varint = (value: bigint | number): Buffer => {
  let v = BigInt(value);
  if (v < 0n) v = BigInt.asUintN(64, v);
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
};
const lengthField = (field: number, bytes: Buffer) =>
  Buffer.concat([varint((field << 3) | 2), varint(bytes.length), bytes]);
const stringField = (field: number, text: string) => lengthField(field, Buffer.from(text, 'utf8'));
const varintField = (field: number, value: bigint | number) =>
  Buffer.concat([varint(field << 3), varint(value)]);

const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

function protoAttribute(input: {
  namespace: string;
  name: string;
  value?: string;
  resourceId?: number;
  decimal?: number;
}): Buffer {
  const parts = [stringField(1, input.namespace), stringField(2, input.name)];
  if (input.value !== undefined) parts.push(stringField(3, input.value));
  if (input.resourceId !== undefined) parts.push(varintField(5, input.resourceId));
  if (input.decimal !== undefined)
    parts.push(lengthField(6, lengthField(7, varintField(6, input.decimal))));
  return Buffer.concat(parts);
}

/**
 * The `base/manifest/AndroidManifest.xml` of an AAB: an `XmlNode` whose element is `<manifest>`.
 */
export function protoManifest(fields: ManifestFields & { compiledOnly?: boolean } = {}): Buffer {
  const attrs: Buffer[] = [];
  if (fields.versionCode !== null && fields.versionCode !== undefined)
    attrs.push(
      lengthField(
        4,
        fields.compiledOnly
          ? protoAttribute({
              namespace: ANDROID_NS,
              name: 'versionCode',
              resourceId: 0x0101021b,
              decimal: fields.versionCode,
            })
          : protoAttribute({
              namespace: ANDROID_NS,
              name: 'versionCode',
              value: String(fields.versionCode),
              resourceId: 0x0101021b,
            }),
      ),
    );
  if (fields.versionName)
    attrs.push(
      lengthField(
        4,
        protoAttribute({
          namespace: ANDROID_NS,
          name: 'versionName',
          value: fields.versionName,
          resourceId: 0x0101021c,
        }),
      ),
    );
  if (fields.packageName)
    attrs.push(
      lengthField(4, protoAttribute({ namespace: '', name: 'package', value: fields.packageName })),
    );
  const element = Buffer.concat([
    lengthField(1, Buffer.concat([stringField(1, ANDROID_NS), stringField(2, 'android')])),
    stringField(2, ''),
    stringField(3, fields.root ?? 'manifest'),
    ...attrs,
  ]);
  return lengthField(1, element);
}

// ---------------------------------------------------------------------------------------------
// Property lists

export type PlistInput = string | number | boolean | PlistInput[] | { [key: string]: PlistInput };

/** An `Info.plist` in the binary form (`bplist00`), as Xcode writes it into an IPA. */
export function binaryPlist(root: PlistInput): Buffer {
  const objects: Buffer[] = [];
  const refSize = 2;
  const header = (type: number, length: number): Buffer =>
    length < 15
      ? Buffer.from([(type << 4) | length])
      : Buffer.from([(type << 4) | 0xf, 0x11, length >> 8, length & 0xff]);
  const ref = (n: number) => Buffer.from([n >> 8, n & 0xff]);
  const add = (value: PlistInput): number => {
    const index = objects.length;
    objects.push(Buffer.alloc(0)); // reserved: children come after their parent
    if (typeof value === 'boolean') objects[index] = Buffer.from([value ? 0x09 : 0x08]);
    else if (typeof value === 'number') {
      if (value < 256) objects[index] = Buffer.from([0x10, value]);
      else if (value < 65536) objects[index] = Buffer.from([0x11, value >> 8, value & 0xff]);
      else {
        const b = Buffer.alloc(5);
        b.writeUInt8(0x12);
        b.writeUInt32BE(value, 1);
        objects[index] = b;
      }
    } else if (typeof value === 'string') {
      const ascii = /^[\x00-\x7f]*$/.test(value);
      objects[index] = ascii
        ? Buffer.concat([header(0x5, value.length), Buffer.from(value, 'latin1')])
        : Buffer.concat([header(0x6, value.length), Buffer.from(value, 'utf16le').swap16()]);
    } else if (Array.isArray(value)) {
      const refs = value.map(add);
      objects[index] = Buffer.concat([header(0xa, refs.length), ...refs.map(ref)]);
    } else {
      const keys = Object.keys(value);
      const keyRefs = keys.map((k) => add(k));
      const valueRefs = keys.map((k) => add(value[k] as PlistInput));
      objects[index] = Buffer.concat([
        header(0xd, keys.length),
        ...keyRefs.map(ref),
        ...valueRefs.map(ref),
      ]);
    }
    return index;
  };
  add(root);
  const offsets: number[] = [];
  let at = 8;
  for (const o of objects) {
    offsets.push(at);
    at += o.length;
  }
  const table = Buffer.concat(offsets.map((o) => Buffer.from([o >> 8, o & 0xff])));
  const trailer = Buffer.alloc(32);
  trailer.writeUInt8(2, 6);
  trailer.writeUInt8(refSize, 7);
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(at), 24);
  return Buffer.concat([Buffer.from('bplist00', 'latin1'), ...objects, table, trailer]);
}

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** An `Info.plist` in the XML form. */
export function xmlPlist(root: PlistInput): Buffer {
  const write = (value: PlistInput, depth: number): string => {
    const pad = '\t'.repeat(depth);
    if (typeof value === 'boolean') return `${pad}<${value}/>\n`;
    if (typeof value === 'number') return `${pad}<integer>${value}</integer>\n`;
    if (typeof value === 'string') return `${pad}<string>${escapeXml(value)}</string>\n`;
    if (Array.isArray(value))
      return `${pad}<array>\n${value.map((v) => write(v, depth + 1)).join('')}${pad}</array>\n`;
    const inner = Object.entries(value)
      .map(([k, v]) => `${pad}\t<key>${escapeXml(k)}</key>\n${write(v, depth + 1)}`)
      .join('');
    return `${pad}<dict>\n${inner}${pad}</dict>\n`;
  };
  const doctype = [
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"',
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  ].join(' ');
  const head = `<?xml version="1.0" encoding="UTF-8"?>\n${doctype}\n`;
  return Buffer.from(`${head}<plist version="1.0">\n${write(root, 0)}</plist>\n`);
}

/** The Info.plist fields of a build, in the form a plist writer takes. */
export const infoPlist = (fields: {
  buildNumber: string;
  version?: string;
  bundleId?: string;
  name?: string;
}): PlistInput => ({
  CFBundleName: fields.name ?? 'Fixture',
  CFBundleVersion: fields.buildNumber,
  ...(fields.version ? { CFBundleShortVersionString: fields.version } : {}),
  ...(fields.bundleId ? { CFBundleIdentifier: fields.bundleId } : {}),
  UIDeviceFamily: [1, 2],
  UIRequiresFullScreen: false,
});
