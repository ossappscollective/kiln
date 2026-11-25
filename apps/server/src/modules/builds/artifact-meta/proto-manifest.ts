/**
 * The manifest of an Android App Bundle (`base/manifest/AndroidManifest.xml`) is NOT binary XML:
 * bundletool keeps aapt2's protobuf form, the message `XmlNode` of `Resources.proto`
 * (frameworks/base/tools/aapt2/Resources.proto). From memory:
 *
 *   XmlNode      { element = 1 (XmlElement) | text = 2; source = 3 }
 *   XmlElement   { namespace_declaration = 1; namespace_uri = 2; name = 3;
 *                  attribute = 4 (repeated); child = 5 (repeated) }
 *   XmlAttribute { namespace_uri = 1; name = 2; value = 3; source = 4; resource_id = 5;
 *                  compiled_item = 6 }
 *   Item         { ... prim = 7 }
 *   Primitive    { int_decimal_value = 6 (int32); int_hexadecimal_value = 7 (uint32); ... }
 *
 * A minimal protobuf reader (varints, length delimited fields; fixed width fields are skipped) is
 * enough for this. The attribute's `value` holds the text as written ("167"); the compiled integer
 * is the fallback. NOT checked against a real bundle here.
 */

export type ProtoManifestInfo = {
  versionCode: string | null;
  versionName: string | null;
  packageName: string | null;
};

export class ProtoError extends Error {}

type Field = { field: number; wire: number; varint: bigint; bytes: Buffer };
const NO_BYTES = Buffer.alloc(0);

/** The fields of one message, in order. A truncated or unknown wire type is a `ProtoError`. */
function* fieldsOf(buf: Buffer): Generator<Field> {
  let p = 0;
  const varint = (): bigint => {
    let result = 0n;
    for (let shift = 0n, n = 0; n < 10; n += 1, shift += 7n) {
      if (p >= buf.length) throw new ProtoError('truncated varint');
      const b = buf.readUInt8(p);
      p += 1;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
    }
    throw new ProtoError('varint too long');
  };
  while (p < buf.length) {
    const key = varint();
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (field === 0) throw new ProtoError('field 0');
    if (wire === 0) yield { field, wire, varint: varint(), bytes: NO_BYTES };
    else if (wire === 2) {
      const length = Number(varint());
      if (length < 0 || p + length > buf.length) throw new ProtoError('truncated field');
      yield { field, wire, varint: 0n, bytes: buf.subarray(p, p + length) };
      p += length;
    } else if (wire === 1 || wire === 5) {
      const length = wire === 1 ? 8 : 4;
      if (p + length > buf.length) throw new ProtoError('truncated fixed field');
      p += length;
    } else throw new ProtoError(`wire type ${wire}`);
  }
}

type Attribute = {
  namespace: string;
  name: string;
  value: string;
  resourceId: number;
  compiled: string | null;
};

function readCompiledInt(item: Buffer): string | null {
  for (const f of fieldsOf(item)) {
    if (f.field !== 7 || f.wire !== 2) continue;
    for (const p of fieldsOf(f.bytes)) {
      if (p.wire !== 0) continue;
      if (p.field === 6) return String(BigInt.asIntN(32, p.varint));
      if (p.field === 7) return String(BigInt.asUintN(32, p.varint));
    }
  }
  return null;
}

function readAttribute(buf: Buffer): Attribute {
  const a: Attribute = { namespace: '', name: '', value: '', resourceId: 0, compiled: null };
  for (const f of fieldsOf(buf)) {
    if (f.field === 1 && f.wire === 2) a.namespace = f.bytes.toString('utf8');
    else if (f.field === 2 && f.wire === 2) a.name = f.bytes.toString('utf8');
    else if (f.field === 3 && f.wire === 2) a.value = f.bytes.toString('utf8');
    else if (f.field === 5 && f.wire === 0) a.resourceId = Number(BigInt.asUintN(32, f.varint));
    else if (f.field === 6 && f.wire === 2) a.compiled = readCompiledInt(f.bytes);
  }
  return a;
}

/** The attributes of the root element when it is `<manifest>`, else null. */
export function readManifestProto(buf: Buffer): ProtoManifestInfo | null {
  let element: Buffer | null = null;
  for (const f of fieldsOf(buf)) if (f.field === 1 && f.wire === 2) element = f.bytes;
  if (!element) return null;
  let name = '';
  const attributes: Attribute[] = [];
  for (const f of fieldsOf(element)) {
    if (f.field === 3 && f.wire === 2) name = f.bytes.toString('utf8');
    else if (f.field === 4 && f.wire === 2) attributes.push(readAttribute(f.bytes));
  }
  if (name !== 'manifest') return null;
  const info: ProtoManifestInfo = { versionCode: null, versionName: null, packageName: null };
  const text = (a: Attribute) => (a.value !== '' ? a.value : a.compiled);
  for (const a of attributes) {
    if (a.name === 'versionCode' || a.resourceId === 0x0101021b) info.versionCode = text(a);
    else if (a.name === 'versionName' || a.resourceId === 0x0101021c) info.versionName = text(a);
    else if (a.name === 'package' && a.namespace === '') info.packageName = text(a);
  }
  return info;
}
