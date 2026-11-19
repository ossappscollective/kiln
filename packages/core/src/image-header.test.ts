import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_HEADER_SCAN_BYTES, readImageHeader, sniffImageFormat } from './image-header.ts';

// ----- builders: only the bytes a header parser looks at -------------------------------------

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));

function png(
  width: number,
  height: number,
  colourType = 2,
  extra: 'trns' | 'none' = 'none',
): Uint8Array {
  const ihdr = [
    ...be32(13),
    ...text('IHDR'),
    ...be32(width),
    ...be32(height),
    8,
    colourType,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
  const trns = extra === 'trns' ? [...be32(1), ...text('tRNS'), 0, 0, 0, 0, 0] : [];
  const idat = [...be32(4), ...text('IDAT'), 1, 2, 3, 4, 0, 0, 0, 0];
  return Uint8Array.from([0x89, ...text('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...trns, ...idat]);
}

function jpeg(width: number, height: number, padding = 0, sof = 0xc0): Uint8Array {
  const app0 = [0xff, 0xe0, ...be16(16), ...text('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const comment =
    padding > 0 ? [0xff, 0xfe, ...be16(padding + 2), ...new Array(padding).fill(0x41)] : [];
  const frame = [
    0xff,
    sof,
    ...be16(17),
    8,
    ...be16(height),
    ...be16(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ];
  return Uint8Array.from([0xff, 0xd8, ...app0, ...comment, ...frame, 0xff, 0xda, 0, 0]);
}

function webpLossy(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    ...text('RIFF'),
    0,
    0,
    0,
    0,
    ...text('WEBP'),
    ...text('VP8 '),
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0x9d,
    0x01,
    0x2a,
    ...le16(width),
    ...le16(height),
  ]);
}

function webpLossless(width: number, height: number, alpha: boolean): Uint8Array {
  const bits = (width - 1) | ((height - 1) << 14) | ((alpha ? 1 : 0) << 28);
  return Uint8Array.from([
    ...text('RIFF'),
    0,
    0,
    0,
    0,
    ...text('WEBP'),
    ...text('VP8L'),
    0,
    0,
    0,
    0,
    0x2f,
    bits & 255,
    (bits >> 8) & 255,
    (bits >> 16) & 255,
    (bits >>> 24) & 255,
  ]);
}

function webpExtended(width: number, height: number, flags: number): Uint8Array {
  return Uint8Array.from([
    ...text('RIFF'),
    0,
    0,
    0,
    0,
    ...text('WEBP'),
    ...text('VP8X'),
    10,
    0,
    0,
    0,
    flags,
    0,
    0,
    0,
    ...le24(width - 1),
    ...le24(height - 1),
  ]);
}

function gif(width: number, height: number, version = '89a'): Uint8Array {
  return Uint8Array.from([...text(`GIF${version}`), ...le16(width), ...le16(height), 0, 0, 0]);
}

// ----- tables ---------------------------------------------------------------------------------

const valid: {
  name: string;
  bytes: Uint8Array;
  format: string;
  width: number;
  height: number;
  hasAlpha: boolean | null;
}[] = [
  {
    name: 'png rgb',
    bytes: png(1242, 2688),
    format: 'png',
    width: 1242,
    height: 2688,
    hasAlpha: false,
  },
  {
    name: 'png rgba',
    bytes: png(512, 512, 6),
    format: 'png',
    width: 512,
    height: 512,
    hasAlpha: true,
  },
  {
    name: 'png grey alpha',
    bytes: png(10, 20, 4),
    format: 'png',
    width: 10,
    height: 20,
    hasAlpha: true,
  },
  {
    name: 'png palette with tRNS',
    bytes: png(64, 64, 3, 'trns'),
    format: 'png',
    width: 64,
    height: 64,
    hasAlpha: true,
  },
  {
    name: 'png palette without tRNS',
    bytes: png(64, 64, 3),
    format: 'png',
    width: 64,
    height: 64,
    hasAlpha: false,
  },
  {
    name: 'jpeg baseline',
    bytes: jpeg(1290, 2796),
    format: 'jpeg',
    width: 1290,
    height: 2796,
    hasAlpha: false,
  },
  {
    name: 'jpeg progressive after a 3 KB comment',
    bytes: jpeg(1024, 500, 3000, 0xc2),
    format: 'jpeg',
    width: 1024,
    height: 500,
    hasAlpha: false,
  },
  {
    name: 'webp lossy',
    bytes: webpLossy(1080, 1920),
    format: 'webp',
    width: 1080,
    height: 1920,
    hasAlpha: false,
  },
  {
    name: 'webp lossless with alpha',
    bytes: webpLossless(300, 200, true),
    format: 'webp',
    width: 300,
    height: 200,
    hasAlpha: true,
  },
  {
    name: 'webp extended',
    bytes: webpExtended(4000, 3000, 0x10),
    format: 'webp',
    width: 4000,
    height: 3000,
    hasAlpha: true,
  },
  {
    name: 'webp extended without alpha',
    bytes: webpExtended(800, 600, 0),
    format: 'webp',
    width: 800,
    height: 600,
    hasAlpha: false,
  },
  { name: 'gif 89a', bytes: gif(320, 240), format: 'gif', width: 320, height: 240, hasAlpha: null },
  { name: 'gif 87a', bytes: gif(1, 1, '87a'), format: 'gif', width: 1, height: 1, hasAlpha: null },
];

test('header parsers read format, size and alpha', () => {
  for (const v of valid) {
    const header = readImageHeader(v.bytes);
    assert.deepEqual(
      header,
      { ok: true, format: v.format, width: v.width, height: v.height, hasAlpha: v.hasAlpha },
      v.name,
    );
    assert.equal(sniffImageFormat(v.bytes), v.format, v.name);
  }
});

test('JPEG start-of-frame markers other than DHT, JPG and DAC are frames', () => {
  for (const sof of [
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]) {
    assert.deepEqual(
      readImageHeader(jpeg(30, 40, 0, sof)),
      { ok: true, format: 'jpeg', width: 30, height: 40, hasAlpha: false },
      sof.toString(16),
    );
  }
  // 0xC4 is a Huffman table, 0xC8 is reserved and 0xCC is arithmetic conditioning: never a frame.
  for (const marker of [0xc4, 0xc8, 0xcc]) {
    const header = readImageHeader(jpeg(30, 40, 0, marker));
    assert.equal(header.ok, false, marker.toString(16));
  }
});

test('a cut-off header is truncated and never gives a wrong size', () => {
  for (const v of valid) {
    for (let length = 0; length < v.bytes.length; length++) {
      const header = readImageHeader(v.bytes.subarray(0, length));
      if (header.ok) {
        // A PNG or GIF can be complete enough for its size before the end of the sample.
        assert.equal(header.width, v.width, `${v.name} at ${length}`);
        assert.equal(header.height, v.height, `${v.name} at ${length}`);
        assert.equal(header.format, v.format);
      } else {
        assert.ok(['truncated', 'unknown_format', 'malformed'].includes(header.reason));
      }
    }
  }
  assert.deepEqual(readImageHeader(jpeg(100, 100).subarray(0, 25)), {
    ok: false,
    reason: 'truncated',
  });
  assert.deepEqual(readImageHeader(png(100, 100).subarray(0, 20)), {
    ok: false,
    reason: 'truncated',
  });
});

test('what is not one of the four formats is not an image, whatever it is called', () => {
  const cases: [string, Uint8Array][] = [
    [
      'svg',
      new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
      ),
    ],
    ['svg with xml prolog', new TextEncoder().encode('<?xml version="1.0"?><svg/>')],
    ['html', new TextEncoder().encode('<!DOCTYPE html><html><body>hi</body></html>')],
    ['json', new TextEncoder().encode('{"a":1,"b":[1,2,3,4,5,6]}')],
    ['pdf', new TextEncoder().encode('%PDF-1.7 some pdf bytes here')],
    ['bmp', Uint8Array.from([0x42, 0x4d, ...new Array(40).fill(0)])],
    [
      'riff but not webp',
      Uint8Array.from([...text('RIFF'), 0, 0, 0, 0, ...text('WAVE'), ...new Array(12).fill(0)]),
    ],
    [
      'git lfs pointer',
      new TextEncoder().encode(
        'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12345\n',
      ),
    ],
  ];
  for (const [name, bytes] of cases) {
    assert.deepEqual(readImageHeader(bytes), { ok: false, reason: 'unknown_format' }, name);
    assert.equal(sniffImageFormat(bytes), null, name);
  }
});

test('hostile headers are refused, not trusted', () => {
  // Zero and absurd dimensions.
  assert.deepEqual(readImageHeader(png(0, 10)), { ok: false, reason: 'malformed' });
  assert.deepEqual(readImageHeader(png(10, 0)), { ok: false, reason: 'malformed' });
  assert.deepEqual(readImageHeader(png(0xffffffff, 0xffffffff)), {
    ok: false,
    reason: 'malformed',
  });
  assert.deepEqual(readImageHeader(png(2_000_000, 10)), { ok: false, reason: 'malformed' });
  assert.deepEqual(readImageHeader(jpeg(0, 10)), { ok: false, reason: 'malformed' });
  assert.deepEqual(readImageHeader(gif(0, 0)), { ok: false, reason: 'malformed' });
  // PNG whose first chunk is not IHDR, or has the wrong length, or an impossible colour type.
  const notIhdr = png(10, 10);
  notIhdr.set(text('XXXX'), 12);
  assert.deepEqual(readImageHeader(notIhdr), { ok: false, reason: 'malformed' });
  const badLength = png(10, 10);
  badLength.set(be32(99), 8);
  assert.deepEqual(readImageHeader(badLength), { ok: false, reason: 'malformed' });
  const badColour = png(10, 10);
  badColour[25] = 9;
  assert.deepEqual(readImageHeader(badColour), { ok: false, reason: 'malformed' });
  // A PNG chunk that claims 4 GB: the walk stops, the size is still read.
  const huge = Uint8Array.from([
    ...png(10, 10, 3).subarray(0, 33),
    ...be32(0xffffffff),
    ...text('abcd'),
  ]);
  assert.deepEqual(readImageHeader(huge), {
    ok: true,
    format: 'png',
    width: 10,
    height: 10,
    hasAlpha: null,
  });
  // JPEG segment lengths of 0 and 1 are impossible (the length counts its own two bytes).
  for (const length of [0, 1]) {
    const j = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...be16(length), 0, 0, 0, 0]);
    assert.deepEqual(readImageHeader(j), { ok: false, reason: 'malformed' }, `length ${length}`);
  }
  // JPEG: SOS or EOI before any frame header.
  assert.deepEqual(readImageHeader(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2])), {
    ok: false,
    reason: 'malformed',
  });
  assert.deepEqual(readImageHeader(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9, 0, 2])), {
    ok: false,
    reason: 'malformed',
  });
  // JPEG: not a marker where one must be.
  assert.deepEqual(
    readImageHeader(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0x41, 0x41, 0x41, 0x41])),
    { ok: false, reason: 'malformed' },
  );
  // WebP: wrong start code, wrong lossless signature, unknown first chunk.
  const lossy = webpLossy(10, 10);
  lossy[23] = 0;
  assert.deepEqual(readImageHeader(lossy), { ok: false, reason: 'malformed' });
  const lossless = webpLossless(10, 10, false);
  lossless[20] = 0;
  assert.deepEqual(readImageHeader(lossless), { ok: false, reason: 'malformed' });
  const unknown = webpLossy(10, 10);
  unknown.set(text('JUNK'), 12);
  assert.deepEqual(readImageHeader(unknown), { ok: false, reason: 'malformed' });
});

test('hostile loops end: padding, endless markers and endless chunks', () => {
  // A million 0xFF bytes after SOI: the fill-byte loop is bounded by the input and the scan cap.
  const fill = new Uint8Array(2_000_000).fill(0xff);
  fill[0] = 0xff;
  fill[1] = 0xd8;
  const started = Date.now();
  const header = readImageHeader(fill);
  assert.equal(header.ok, false);
  // Standalone markers forever (RST0 repeated): bounded by MAX_JPEG_SEGMENTS.
  const rst = new Uint8Array(100_000);
  rst.set([0xff, 0xd8]);
  for (let i = 2; i + 1 < rst.length; i += 2) rst.set([0xff, 0xd0], i);
  assert.equal(readImageHeader(rst).ok, false);
  // Thousands of empty PNG chunks before IDAT: bounded by MAX_PNG_CHUNKS, the size is still read.
  const chunks: number[] = [];
  for (let i = 0; i < 5000; i++) chunks.push(...be32(0), ...text('abCd'), 0, 0, 0, 0);
  const manyChunks = Uint8Array.from([...png(7, 9, 2).subarray(0, 33), ...chunks]);
  assert.deepEqual(readImageHeader(manyChunks), {
    ok: true,
    format: 'png',
    width: 7,
    height: 9,
    hasAlpha: null,
  });
  assert.ok(Date.now() - started < 2000, 'finishes quickly');
});

test('only the first megabyte is ever looked at', () => {
  // A JPEG whose frame header sits after 2 MB of comment is not found: the scan stops at the cap.
  const comment = new Uint8Array(2 * MAX_HEADER_SCAN_BYTES);
  const j = Uint8Array.from([0xff, 0xd8, 0xff, 0xfe, 0xff, 0xff]);
  const all = new Uint8Array(j.length + comment.length + 200);
  all.set(j);
  all.set(jpeg(10, 10).subarray(2), j.length + comment.length);
  assert.equal(readImageHeader(all).ok, false);
  // A valid PNG with a lot of trailing bytes is fine and is not copied.
  const big = new Uint8Array(3 * MAX_HEADER_SCAN_BYTES);
  big.set(png(100, 50));
  assert.deepEqual(readImageHeader(big), {
    ok: true,
    format: 'png',
    width: 100,
    height: 50,
    hasAlpha: false,
  });
});

test('fuzz: random and mutated bytes never throw and never give nonsense', () => {
  let seed = 0x2545f491;
  const next = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
  const check = (bytes: Uint8Array) => {
    const header = readImageHeader(bytes);
    assert.equal(typeof header.ok, 'boolean');
    if (header.ok) {
      assert.ok(Number.isInteger(header.width) && header.width >= 1 && header.width <= 1_000_000);
      assert.ok(
        Number.isInteger(header.height) && header.height >= 1 && header.height <= 1_000_000,
      );
      assert.ok(['png', 'jpeg', 'webp', 'gif'].includes(header.format));
    } else {
      assert.ok(['unknown_format', 'truncated', 'malformed'].includes(header.reason));
    }
  };
  for (let i = 0; i < 3000; i++) {
    const bytes = new Uint8Array(Math.floor(next() * 80));
    for (let k = 0; k < bytes.length; k++) bytes[k] = Math.floor(next() * 256);
    check(bytes);
  }
  for (const v of valid) {
    for (let i = 0; i < 1500; i++) {
      const mutated = v.bytes.slice();
      const flips = 1 + Math.floor(next() * 4);
      for (let f = 0; f < flips; f++)
        mutated[Math.floor(next() * mutated.length)] = Math.floor(next() * 256);
      check(mutated.subarray(0, Math.max(1, Math.floor(next() * (mutated.length + 1)))));
    }
  }
});
