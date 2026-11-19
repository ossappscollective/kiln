import { inflateRaw } from 'node:zlib';
import { AnalyticsError } from './analytics-types.ts';

/**
 * A minimal, defensive reader of a .zip file (stored and deflate entries only), for a report that comes as a zip of CSV files. No
 * dependency: `node:zlib` reads a deflate stream but not the archive around it. Every step has a cap so an archive cannot use more
 * memory than `maxTotalBytes`: the entry count, the declared and the real size of each entry (the inflate is capped DURING
 * decompression), the total. Anything unexpected (encryption, zip64, a bad offset, a name with a path out of the archive) is `bad_zip`,
 * and an entry or total over the cap is `file_too_large`. Entry names are returned for choosing what to read; they are never stored.
 */

export const isZip = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06));

export type ZipEntry = { name: string; bytes: Uint8Array };

export type ZipLimits = {
  /** Most entries in the central directory. */
  maxEntries?: number;
  /** Largest single entry after decompression. */
  maxEntryBytes: number;
  /** Largest sum of the entries read. */
  maxTotalBytes: number;
};

const u16 = (b: Uint8Array, o: number) => (b[o] as number) | ((b[o + 1] as number) << 8);
const u32 = (b: Uint8Array, o: number) => ((b[o] as number) | ((b[o + 1] as number) << 8) | ((b[o + 2] as number) << 16) | ((b[o + 3] as number) << 24)) >>> 0;

function inflate(data: Uint8Array, max: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    inflateRaw(data, { maxOutputLength: max }, (error, result) => {
      if (!error) return resolve(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError) return reject(new AnalyticsError('file_too_large'));
      reject(new AnalyticsError('bad_zip'));
    });
  });
}

/** The entries of a zip whose name satisfies `want` (directories and names that climb out of the archive are never read). */
export async function readZipEntries(bytes: Uint8Array, want: (name: string) => boolean, limits: ZipLimits): Promise<ZipEntry[]> {
  const maxEntries = limits.maxEntries ?? 200;
  // The end of central directory record: the last 22 to 65557 bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i -= 1) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new AnalyticsError('bad_zip');
  const count = u16(bytes, eocd + 10);
  const dirSize = u32(bytes, eocd + 12);
  const dirOffset = u32(bytes, eocd + 16);
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) throw new AnalyticsError('bad_zip'); // zip64
  if (count > maxEntries || dirOffset + dirSize > bytes.length) throw new AnalyticsError('bad_zip');

  const out: ZipEntry[] = [];
  let total = 0;
  let p = dirOffset;
  const decoder = new TextDecoder('utf-8');
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > bytes.length || u32(bytes, p) !== 0x02014b50) throw new AnalyticsError('bad_zip');
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const compressed = u32(bytes, p + 20);
    const size = u32(bytes, p + 24);
    const nameLength = u16(bytes, p + 28);
    const extraLength = u16(bytes, p + 30);
    const commentLength = u16(bytes, p + 32);
    const localOffset = u32(bytes, p + 42);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength));
    p += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/') || name.indexOf('..') >= 0 || name.startsWith('/') || !want(name)) continue;
    if ((flags & 1) !== 0) throw new AnalyticsError('bad_zip'); // encrypted
    if (compressed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new AnalyticsError('bad_zip');
    if (size > limits.maxEntryBytes) throw new AnalyticsError('file_too_large');
    if (localOffset + 30 > bytes.length || u32(bytes, localOffset) !== 0x04034b50) throw new AnalyticsError('bad_zip');
    const start = localOffset + 30 + u16(bytes, localOffset + 26) + u16(bytes, localOffset + 28);
    if (start + compressed > bytes.length) throw new AnalyticsError('bad_zip');
    const data = bytes.subarray(start, start + compressed);
    let content: Uint8Array;
    if (method === 0) content = data;
    else if (method === 8) content = await inflate(data, limits.maxEntryBytes);
    else throw new AnalyticsError('bad_zip');
    if (content.length > limits.maxEntryBytes) throw new AnalyticsError('file_too_large');
    total += content.length;
    if (total > limits.maxTotalBytes) throw new AnalyticsError('file_too_large');
    out.push({ name, bytes: content });
  }
  return out;
}
