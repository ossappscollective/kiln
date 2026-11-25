import { createWriteStream } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw, inflateRaw } from 'node:zlib';

/**
 * A small, defensive reader of a .zip archive with random access: from a Buffer or from a file path
 * (only the central directory and the entries asked for are read, so a 300 MB artifact is never
 * held whole). Stored and deflate entries only. No dependency: `node:zlib` reads a deflate stream
 * but not the archive around it.
 *
 * Nothing here trusts the archive. The end record, the central directory, every offset and every
 * size are checked against the real size of the source; an entry whose declared size is over the
 * cap, or whose declared size is far larger than its compressed bytes (a zip bomb), is refused
 * BEFORE anything is inflated, and the inflate itself stops at the declared size, so a lie in the
 * header cannot make it write more. zip64, encryption and other compression methods fail with a
 * clear `ZipError` code instead of being guessed at. Entry names are used to choose what to read;
 * they are never used as a path.
 */

export type ZipErrorCode =
  | 'bad_zip'
  | 'zip64'
  | 'encrypted'
  | 'unsupported_method'
  | 'too_large'
  | 'bomb'
  | 'too_many_entries';

export class ZipError extends Error {
  readonly code: ZipErrorCode;
  constructor(code: ZipErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ZipError';
    this.code = code;
  }
}

export type ZipEntry = {
  name: string;
  /** 0 stored, 8 deflate. */
  method: number;
  /** Bytes in the archive. */
  compressedSize: number;
  /** Bytes after inflating, as the archive declares them. */
  size: number;
  localOffset: number;
  /** Encrypted entries are listed but never read. */
  encrypted: boolean;
};

/** Where bytes come from: a memory buffer or a file, read by position. */
export type ByteSource = {
  readonly size: number;
  read(offset: number, length: number): Promise<Buffer>;
  close(): Promise<void>;
};

export const MAX_ENTRIES = 50_000;
export const MAX_DIRECTORY_BYTES = 32 * 1024 * 1024;
/**
 * A declared size over this many times the compressed size is a bomb, from this size on (below it
 * the size cap is enough).
 */
export const MAX_RATIO = 200;
const RATIO_FROM_BYTES = 1024 * 1024;
const CHUNK = 1024 * 1024;

export const bufferSource = (bytes: Uint8Array): ByteSource => {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    size: buffer.length,
    read: async (offset, length) => {
      if (offset < 0 || length < 0 || offset + length > buffer.length)
        throw new ZipError('bad_zip');
      return buffer.subarray(offset, offset + length);
    },
    close: async () => undefined,
  };
};

class FileSource implements ByteSource {
  readonly size: number;
  readonly #handle: FileHandle;
  constructor(handle: FileHandle, size: number) {
    this.#handle = handle;
    this.size = size;
  }
  async read(offset: number, length: number): Promise<Buffer> {
    if (offset < 0 || length < 0 || offset + length > this.size) throw new ZipError('bad_zip');
    const out = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await this.#handle.read(out, done, length - done, offset + done);
      if (bytesRead === 0) throw new ZipError('bad_zip');
      done += bytesRead;
    }
    return out;
  }
  async close(): Promise<void> {
    await this.#handle.close().catch(() => undefined);
  }
}

/**
 * A window on another source (a stored entry that is itself a zip). Closing it leaves the parent
 * open.
 */
const sliceSource = (parent: ByteSource, start: number, size: number): ByteSource => ({
  size,
  read: async (offset, length) => {
    if (offset < 0 || length < 0 || offset + length > size) throw new ZipError('bad_zip');
    return parent.read(start + offset, length);
  },
  close: async () => undefined,
});

const inflateToBuffer = (data: Buffer, expected: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    // maxOutputLength is the declared size: a stream that inflates to more is refused by zlib
    // itself.
    inflateRaw(data, { maxOutputLength: Math.max(1, expected) }, (error, result) => {
      if (!error) return resolve(result);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError)
        return reject(new ZipError('bomb', 'The entry inflates to more than it declares.'));
      reject(new ZipError('bad_zip', 'The entry could not be inflated.'));
    });
  });

export class ZipArchive {
  readonly entries: ZipEntry[];
  readonly #source: ByteSource;

  private constructor(source: ByteSource, entries: ZipEntry[]) {
    this.#source = source;
    this.entries = entries;
  }

  /** Opens an archive; on any failure the source is closed and a `ZipError` is thrown. */
  static async open(source: ByteSource): Promise<ZipArchive> {
    try {
      return new ZipArchive(source, await readDirectory(source));
    } catch (error) {
      await source.close();
      throw error instanceof ZipError ? error : new ZipError('bad_zip');
    }
  }

  find(want: (name: string) => boolean): ZipEntry | undefined {
    return this.entries.find((e) => want(e.name));
  }

  #check(entry: ZipEntry, maxBytes: number): void {
    if (entry.encrypted) throw new ZipError('encrypted');
    if (entry.method !== 0 && entry.method !== 8) throw new ZipError('unsupported_method');
    if (entry.size > maxBytes) throw new ZipError('too_large');
    if (entry.method === 0 && entry.compressedSize !== entry.size) throw new ZipError('bad_zip');
    if (
      entry.method === 8 &&
      entry.size >= RATIO_FROM_BYTES &&
      entry.size > entry.compressedSize * MAX_RATIO
    )
      throw new ZipError('bomb', 'The entry is far larger than its compressed bytes.');
  }

  /** Where the data of an entry starts in the source, after its local header. */
  async #dataStart(entry: ZipEntry): Promise<number> {
    const head = await this.#source.read(entry.localOffset, 30);
    if (head.readUInt32LE(0) !== 0x04034b50) throw new ZipError('bad_zip');
    const start = entry.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    if (start + entry.compressedSize > this.#source.size) throw new ZipError('bad_zip');
    return start;
  }

  /** The entry's bytes in memory, never more than `maxBytes`. */
  async read(entry: ZipEntry, maxBytes: number): Promise<Buffer> {
    this.#check(entry, maxBytes);
    const start = await this.#dataStart(entry);
    if (entry.method === 0) return this.#source.read(start, entry.size);
    if (entry.size === 0) return Buffer.alloc(0);
    const data = await this.#source.read(start, entry.compressedSize);
    const out = await inflateToBuffer(data, entry.size);
    if (out.length !== entry.size) throw new ZipError('bad_zip', 'The entry has a different size.');
    return out;
  }

  /** A stored entry as a source of its own (no copy), or null when it is deflated. */
  async window(entry: ZipEntry, maxBytes: number): Promise<ByteSource | null> {
    this.#check(entry, maxBytes);
    if (entry.method !== 0) return null;
    return sliceSource(this.#source, await this.#dataStart(entry), entry.size);
  }

  /**
   * Inflates an entry to a file (created new, owner only), stopping at the declared size and at
   * `maxBytes`.
   */
  async extractToFile(entry: ZipEntry, path: string, maxBytes: number): Promise<void> {
    this.#check(entry, maxBytes);
    const start = await this.#dataStart(entry);
    const source = this.#source;
    async function* chunks() {
      for (let at = 0; at < entry.compressedSize; at += CHUNK)
        yield await source.read(start + at, Math.min(CHUNK, entry.compressedSize - at));
    }
    let written = 0;
    const count = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        written += chunk.length;
        if (written > entry.size)
          return done(new ZipError('bomb', 'The entry inflates to more than it declares.'));
        done(null, chunk);
      },
    });
    const sink = createWriteStream(path, { flags: 'wx', mode: 0o600 });
    const raw = Readable.from(chunks());
    const input = entry.method === 0 ? raw : raw.pipe(createInflateRaw());
    try {
      await pipeline(input, count, sink);
    } catch (error) {
      if (error instanceof ZipError) throw error;
      throw new ZipError('bad_zip', 'The entry could not be inflated.');
    }
    if (written !== entry.size) throw new ZipError('bad_zip', 'The entry has a different size.');
  }

  async close(): Promise<void> {
    await this.#source.close();
  }
}

/** Opens a zip held in memory. */
export const openZipBuffer = (bytes: Uint8Array): Promise<ZipArchive> =>
  ZipArchive.open(bufferSource(bytes));

/** Opens a zip on disk; the file is read by position, never whole. */
export async function openZipFile(path: string): Promise<ZipArchive> {
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch {
    throw new ZipError('bad_zip', 'The file could not be opened.');
  }
  const { size } = await handle.stat();
  return ZipArchive.open(new FileSource(handle, size));
}

/** Opens a zip held by a source (the inner file of another archive). */
export const openZipSource = (source: ByteSource): Promise<ZipArchive> => ZipArchive.open(source);

async function readDirectory(source: ByteSource): Promise<ZipEntry[]> {
  if (source.size < 22) throw new ZipError('bad_zip');
  const tailStart = Math.max(0, source.size - 22 - 0xffff);
  const tail = await source.read(tailStart, source.size - tailStart);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) !== 0x06054b50) continue;
    if (i + 22 + tail.readUInt16LE(i + 20) <= tail.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('bad_zip', 'No end of central directory record.');
  if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === 0x07064b50) throw new ZipError('zip64');
  const diskEntries = tail.readUInt16LE(eocd + 8);
  const count = tail.readUInt16LE(eocd + 10);
  const dirSize = tail.readUInt32LE(eocd + 12);
  const dirOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff)
    throw new ZipError('zip64');
  if (diskEntries !== count || tail.readUInt16LE(eocd + 4) !== 0) throw new ZipError('bad_zip');
  if (count > MAX_ENTRIES) throw new ZipError('too_many_entries');
  if (dirSize > MAX_DIRECTORY_BYTES || dirOffset + dirSize > source.size)
    throw new ZipError('bad_zip');
  const dir = await source.read(dirOffset, dirSize);
  const decoder = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > dir.length || dir.readUInt32LE(p) !== 0x02014b50) throw new ZipError('bad_zip');
    const flags = dir.readUInt16LE(p + 8);
    const method = dir.readUInt16LE(p + 10);
    const compressedSize = dir.readUInt32LE(p + 20);
    const size = dir.readUInt32LE(p + 24);
    const nameLength = dir.readUInt16LE(p + 28);
    const extraLength = dir.readUInt16LE(p + 30);
    const commentLength = dir.readUInt16LE(p + 32);
    const localOffset = dir.readUInt32LE(p + 42);
    if (p + 46 + nameLength + extraLength + commentLength > dir.length)
      throw new ZipError('bad_zip');
    const name = decoder.decode(dir.subarray(p + 46, p + 46 + nameLength));
    p += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff)
      throw new ZipError('zip64');
    if (localOffset + 30 > source.size) throw new ZipError('bad_zip');
    entries.push({ name, method, compressedSize, size, localOffset, encrypted: (flags & 1) !== 0 });
  }
  return entries;
}
