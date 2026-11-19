/**
 * A small QR code encoder: byte mode, error correction level L, versions 1 to 10 (up to 271 bytes), the best of the eight masks.
 * It exists so a phone can scan a short-lived download link without a library or a network call. The algorithm follows the
 * QR Code specification (ISO/IEC 18004), written out for this one case. Pure: no DOM.
 */

const ECC_PER_BLOCK = [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18];
const BLOCKS = [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4];
export const QR_MAX_VERSION = 10;

const rawModules = (v: number): number => {
  let r = (16 * v + 128) * v + 64;
  if (v >= 2) {
    const n = Math.floor(v / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (v >= 7) r -= 36;
  }
  return r;
};
const dataCodewords = (v: number): number =>
  Math.floor(rawModules(v) / 8) - (ECC_PER_BLOCK[v] as number) * (BLOCKS[v] as number);

/** The most bytes a code of this kind can hold. */
export const QR_MAX_BYTES = dataCodewords(QR_MAX_VERSION) - 3;

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function divisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j] as number, root);
      if (j + 1 < degree) result[j] = (result[j] as number) ^ (result[j + 1] as number);
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function remainder(data: readonly number[], div: readonly number[]): number[] {
  const result = div.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    div.forEach((coef, i) => {
      result[i] = (result[i] as number) ^ gfMul(coef, factor);
    });
  }
  return result;
}

const bit = (x: number, i: number): boolean => ((x >>> i) & 1) !== 0;

/** The codewords (data, then error correction, interleaved) of a byte string at the smallest version that holds it. */
export function codewordsOf(bytes: readonly number[]): { version: number; words: number[] } | null {
  let version = 0;
  for (let v = 1; v <= QR_MAX_VERSION; v++) {
    const ccBits = v <= 9 ? 8 : 16;
    if (4 + ccBits + 8 * bytes.length <= dataCodewords(v) * 8) {
      version = v;
      break;
    }
  }
  if (version === 0) return null;
  const bits: number[] = [];
  const push = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacity = dataCodewords(version) * 8;
  push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8)
    data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < dataCodewords(version); pad ^= 0xec ^ 0x11) data.push(pad);

  const numBlocks = BLOCKS[version] as number;
  const eccLen = ECC_PER_BLOCK[version] as number;
  const raw = Math.floor(rawModules(version) / 8);
  const shortBlocks = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const div = divisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = remainder(dat, div);
    if (i < shortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const words: number[] = [];
  for (let i = 0; i < (blocks[0] as number[]).length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= shortBlocks) words.push(block[i] as number);
    });
  }
  return { version, words };
}

export type QrMatrix = boolean[][];

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const n = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = Math.ceil((version * 4 + 4) / (n * 2 - 2)) * 2;
  const result = [6];
  for (let i = 0, pos = size - 7; i < n - 1; i++, pos -= step) result.splice(1, 0, pos);
  return result;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** The dark modules of the code for a string (UTF-8), or null when it is longer than `QR_MAX_BYTES`. */
export function qrMatrix(text: string): QrMatrix | null {
  const bytes = Array.from(new TextEncoder().encode(text));
  const coded = codewordsOf(bytes);
  if (!coded) return null;
  const { version, words } = coded;
  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const fixed: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const set = (x: number, y: number, dark: boolean) => {
    (modules[y] as boolean[])[x] = dark;
    (fixed[y] as boolean[])[x] = true;
  };

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const align = alignmentPositions(version);
  align.forEach((ax, i) => {
    align.forEach((ay, j) => {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === align.length - 1) ||
        (i === align.length - 1 && j === 0)
      )
        return;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    });
  });

  const formatBits = (mask: number) => {
    const data = (1 << 3) | mask; // error correction level L is 01
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) set(8, i, bit(bits, i));
    set(8, 7, bit(bits, 6));
    set(8, 8, bit(bits, 7));
    set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(bits, i));
    set(8, size - 8, true);
  };
  formatBits(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit(bits, i));
      set(b, a, bit(bits, i));
    }
  }

  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!(fixed[y] as boolean[])[x] && i < words.length * 8) {
          (modules[y] as boolean[])[x] = bit(words[i >>> 3] as number, 7 - (i & 7));
          i++;
        }
      }
    }
  }

  const applyMask = (mask: number) => {
    const rule = MASKS[mask] as (x: number, y: number) => boolean;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!(fixed[y] as boolean[])[x] && rule(x, y))
          (modules[y] as boolean[])[x] = !(modules[y] as boolean[])[x];
      }
    }
  };
  let best = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    formatBits(mask);
    const score = penalty(modules);
    if (score < bestScore) {
      best = mask;
      bestScore = score;
    }
    applyMask(mask);
  }
  applyMask(best);
  formatBits(best);
  return modules;
}

/** The four penalty rules of the specification: runs, 2x2 blocks, finder-like patterns and balance. */
export function penalty(m: QrMatrix): number {
  const size = m.length;
  let score = 0;
  const line = (get: (k: number) => boolean) => {
    let run = 1;
    for (let k = 1; k < size; k++) {
      if (get(k) === get(k - 1)) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score++;
      } else run = 1;
    }
    for (let k = 0; k + 11 <= size; k++) {
      const window = Array.from({ length: 11 }, (_, n) => (get(k + n) ? 1 : 0)).join('');
      if (window === '10111010000' || window === '00001011101') score += 40;
    }
  };
  for (let y = 0; y < size; y++) line((x) => (m[y] as boolean[])[x] as boolean);
  for (let x = 0; x < size; x++) line((y) => (m[y] as boolean[])[x] as boolean);
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = (m[y] as boolean[])[x];
      if (c) dark++;
      if (
        x + 1 < size &&
        y + 1 < size &&
        c === (m[y] as boolean[])[x + 1] &&
        c === (m[y + 1] as boolean[])[x] &&
        c === (m[y + 1] as boolean[])[x + 1]
      )
        score += 3;
    }
  }
  const total = size * size;
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return score;
}

/** An SVG path for the dark modules (horizontal runs), with a quiet zone of `quiet` modules around the code. */
export function qrPath(m: QrMatrix, quiet = 4): { d: string; size: number } {
  const parts: string[] = [];
  m.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let end = x;
      while (end + 1 < row.length && row[end + 1]) end++;
      parts.push(`M${x + quiet} ${y + quiet}h${end - x + 1}v1h${-(end - x + 1)}z`);
      x = end;
    }
  });
  return { d: parts.join(''), size: m.length + quiet * 2 };
}
