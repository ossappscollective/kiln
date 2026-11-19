/**
 * Image headers without decoding. Pure, no dependency, never throws.
 *
 * `readImageHeader` looks at the first bytes of a file and answers what format it is, how large it
 * is in pixels and (PNG, WebP) whether it has an alpha channel. Nothing is decompressed: a PNG is
 * read up to its IHDR and the chunks before the first IDAT, a JPEG up to its first start-of-frame
 * marker, a WebP at its first chunk, a GIF at its screen descriptor.
 *
 * The input is hostile (it is a file of somebody's repository). The rules:
 *
 * - Every read is bounds checked against the bytes given, and at most `MAX_HEADER_SCAN_BYTES` of
 *   them are looked at, however long the array is.
 * - Loops are bounded (`MAX_PNG_CHUNKS`, `MAX_JPEG_SEGMENTS`), so a file of 0xFF bytes cannot spin.
 * - A header that is cut short is `truncated` (more bytes may help), a header that cannot be what
 *   it claims is `malformed`, anything else is `unknown_format`. SVG, HTML and text are never an
 *   image here: only the four formats below are, whatever the file is called.
 * - Dimensions of 0 or above `MAX_DIMENSION` are `malformed`.
 */

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif';

export type ImageHeader =
  | {
      ok: true;
      format: ImageFormat;
      width: number;
      height: number;
      /**
       * Whether the image has transparency: `true` or `false` when the header says (PNG colour type
       * and `tRNS`, WebP `VP8X`/`VP8L`), `null` when it does not (GIF, or a PNG cut off before the
       * first IDAT chunk with no alpha colour type).
       */
      hasAlpha: boolean | null;
    }
  | { ok: false; reason: 'unknown_format' | 'truncated' | 'malformed' };

/** Never look at more than this many bytes of the input. */
export const MAX_HEADER_SCAN_BYTES = 1024 * 1024;
/** Largest width or height accepted (JPEG and PNG allow more; no store does). */
export const MAX_DIMENSION = 1_000_000;
const MAX_PNG_CHUNKS = 64;
const MAX_JPEG_SEGMENTS = 4096;

type Bytes = Uint8Array;

const u16be = (b: Bytes, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u16le = (b: Bytes, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Bytes, i: number) =>
  (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);
const u32be = (b: Bytes, i: number) =>
  ((b[i] ?? 0) * 0x1000000 +
    (((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0))) >>>
  0;

const ascii = (b: Bytes, i: number, text: string): boolean => {
  if (i < 0 || i + text.length > b.length) return false;
  for (let k = 0; k < text.length; k++) if (b[i + k] !== text.charCodeAt(k)) return false;
  return true;
};

const bad = (reason: 'unknown_format' | 'truncated' | 'malformed'): ImageHeader => ({
  ok: false,
  reason,
});

const sized = (
  format: ImageFormat,
  width: number,
  height: number,
  hasAlpha: boolean | null,
): ImageHeader =>
  width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION
    ? bad('malformed')
    : { ok: true, format, width, height, hasAlpha };

/** The format named by the first bytes, or null. Looks at 12 bytes at most. */
export function sniffImageFormat(input: Bytes): ImageFormat | null {
  const b = input.length > 16 ? input.subarray(0, 16) : input;
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    ascii(b, 1, 'PNG') &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return 'png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'webp';
  if (b.length >= 6 && (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'))) return 'gif';
  return null;
}

function readPng(b: Bytes): ImageHeader {
  // 8 byte signature, then IHDR: length (13), 'IHDR', width, height, depth, colour type, ...
  if (b.length < 8 + 8 + 13) return bad('truncated');
  if (u32be(b, 8) !== 13 || !ascii(b, 12, 'IHDR')) return bad('malformed');
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  const colourType = b[25] ?? 255;
  if (![0, 2, 3, 4, 6].includes(colourType)) return bad('malformed');
  let alpha: boolean | null = colourType === 4 || colourType === 6 ? true : null;
  if (alpha === null) {
    // Palette and grey/RGB images are transparent when a tRNS chunk comes before the pixel data.
    let pos = 8 + 8 + 13 + 4; // after the IHDR chunk and its CRC
    for (let n = 0; n < MAX_PNG_CHUNKS && pos + 8 <= b.length; n++) {
      const length = u32be(b, pos);
      if (ascii(b, pos + 4, 'tRNS')) {
        alpha = true;
        break;
      }
      if (ascii(b, pos + 4, 'IDAT') || ascii(b, pos + 4, 'IEND')) {
        alpha = false;
        break;
      }
      pos += 12 + length;
      if (length > 0x7fffffff) break;
    }
  }
  return sized('png', width, height, alpha);
}

function readJpeg(b: Bytes): ImageHeader {
  let pos = 2;
  for (let n = 0; n < MAX_JPEG_SEGMENTS; n++) {
    // Markers are 0xFF, optional 0xFF fill bytes, then the marker code.
    while (pos < b.length && b[pos] === 0xff && b[pos + 1] === 0xff) pos++;
    if (pos + 1 >= b.length) return bad('truncated');
    if (b[pos] !== 0xff) return bad('malformed');
    const marker = b[pos + 1] ?? 0;
    pos += 2;
    // Standalone markers have no length: TEM, RSTn, SOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (marker === 0xd9 || marker === 0xda) return bad('malformed'); // EOI or SOS before any frame header
    if (pos + 2 > b.length) return bad('truncated');
    const length = u16be(b, pos);
    if (length < 2) return bad('malformed');
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      // length, precision, height, width, components
      if (pos + 7 > b.length) return bad('truncated');
      return sized('jpeg', u16be(b, pos + 5), u16be(b, pos + 3), false);
    }
    pos += length;
  }
  return bad('malformed');
}

function readWebp(b: Bytes): ImageHeader {
  if (b.length < 20) return bad('truncated');
  const chunk =
    b.length >= 16 ? String.fromCharCode(b[12] ?? 0, b[13] ?? 0, b[14] ?? 0, b[15] ?? 0) : '';
  const data = 20;
  if (chunk === 'VP8X') {
    if (b.length < data + 10) return bad('truncated');
    const flags = b[data] ?? 0;
    return sized('webp', u24le(b, data + 4) + 1, u24le(b, data + 7) + 1, (flags & 0x10) !== 0);
  }
  if (chunk === 'VP8L') {
    if (b.length < data + 5) return bad('truncated');
    if (b[data] !== 0x2f) return bad('malformed');
    const bits =
      (b[data + 1] ?? 0) |
      ((b[data + 2] ?? 0) << 8) |
      ((b[data + 3] ?? 0) << 16) |
      ((b[data + 4] ?? 0) * 0x1000000);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return sized('webp', width, height, ((bits >>> 28) & 1) === 1);
  }
  if (chunk === 'VP8 ') {
    // 3 byte frame tag, 3 byte start code, then 14 bit width and height (little endian).
    if (b.length < data + 10) return bad('truncated');
    if (b[data + 3] !== 0x9d || b[data + 4] !== 0x01 || b[data + 5] !== 0x2a)
      return bad('malformed');
    return sized('webp', u16le(b, data + 6) & 0x3fff, u16le(b, data + 8) & 0x3fff, false);
  }
  return bad('malformed');
}

function readGif(b: Bytes): ImageHeader {
  if (b.length < 10) return bad('truncated');
  return sized('gif', u16le(b, 6), u16le(b, 8), null);
}

/**
 * Format, size and alpha of an image from its first bytes (64 KiB is plenty for a PNG, a WebP and
 * a GIF; a JPEG with a large EXIF block or thumbnail can need more: `truncated` says so).
 */
export function readImageHeader(input: Bytes): ImageHeader {
  try {
    const b =
      input.length > MAX_HEADER_SCAN_BYTES ? input.subarray(0, MAX_HEADER_SCAN_BYTES) : input;
    switch (sniffImageFormat(b)) {
      case 'png':
        return readPng(b);
      case 'jpeg':
        return readJpeg(b);
      case 'webp':
        return readWebp(b);
      case 'gif':
        return readGif(b);
      default:
        return bad(b.length < 12 ? 'truncated' : 'unknown_format');
    }
  } catch {
    return bad('malformed');
  }
}

/** The media type of a sniffed format. Only these four are ever served as images. */
export const IMAGE_MEDIA_TYPES: Readonly<Record<ImageFormat, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};
