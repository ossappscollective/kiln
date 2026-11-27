import { TEXT_MERGE_DEFAULT_MAX_EDITS as DEFAULT_MAX_EDITS } from '@kiln/core';

export { DEFAULT_MAX_EDITS };

/**
 * A small three-way merge of text, line by line (diff3), with no dependency. Used to re-base a
 * change set onto a repository that has moved on (change-set-refresh.ts): `base` is the text the
 * change set was made against, `ours` is the text it wants, `theirs` is what the repository holds
 * now.
 *
 * - Lines keep their line terminator, so a CRLF file stays CRLF and a missing final newline is part
 *   of the last line: changing it is a change of that line.
 * - Two changes that touch the same stretch of base lines, or sit right next to each other, are a
 *   conflict unless both sides made the very same change. There is no partial result and no
 *   conflict marker: the caller shows the three versions and a person chooses.
 * - The diff is Myers' O(ND) algorithm, bounded by `maxEdits` (default 2000 changed lines), so a
 *   rewritten huge file is refused (`too_large`) instead of taking the server's time. Common first
 *   and last lines are skipped first, so a large file with a few edits is cheap.
 */

export type MergeResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'conflict'; conflicts: number }
  | { ok: false; reason: 'too_large' };

export type MergeOptions = {
  /** Most changed lines (inserted plus removed) the diff of one side may have. Default 2000. */
  maxEdits?: number;
};

/** The lines of a text, each with its terminator. '' has no lines; 'a\n' has one; 'a' has one. */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

type Hunk = { bs: number; be: number; xs: number; xe: number };

/** Index pairs of equal lines (ascending), or undefined when the diff has more than `maxEdits` edits. */
function matchingLines(
  a: readonly string[],
  b: readonly string[],
  maxEdits: number,
): [number, number][] | undefined {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const n = a.length - prefix - suffix;
  const m = b.length - prefix - suffix;
  const pairs: [number, number][] = [];
  for (let i = 0; i < prefix; i++) pairs.push([i, i]);

  if (n > 0 && m > 0) {
    const middle = myers(a, b, prefix, n, m, maxEdits);
    if (!middle) return undefined;
    for (const [i, j] of middle) pairs.push([prefix + i, prefix + j]);
  } else if (n + m > maxEdits) {
    return undefined;
  }
  for (let k = suffix; k > 0; k--) pairs.push([a.length - k, b.length - k]);
  return pairs;
}

/** Myers' greedy diff on `a[from..from+n)` against `b[from..from+m)`. Pairs are relative to `from`. */
function myers(
  a: readonly string[],
  b: readonly string[],
  from: number,
  n: number,
  m: number,
  maxEdits: number,
): [number, number][] | undefined {
  const limit = Math.min(n + m, maxEdits);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    // The state after round d - 1, for k in [-d - 1, d + 1]: index k + d + 1.
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))) {
        x = v[offset + k + 1] as number;
      } else {
        x = (v[offset + k - 1] as number) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[from + x] === b[from + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return undefined;

  const pairs: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const previous = trace[d] as Int32Array;
    const at = (k: number) => previous[k + d + 1] as number;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    const midX = down ? previousX : previousX + 1;
    const midY = midX - k;
    while (x > midX && y > midY) {
      x--;
      y--;
      pairs.push([x, y]);
    }
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    pairs.push([x, y]);
  }
  return pairs.reverse();
}

/** The stretches of base that a side changed, in order: base lines [bs, be) became side lines [xs, xe). */
function hunksOf(
  pairs: readonly [number, number][],
  baseLength: number,
  sideLength: number,
): Hunk[] {
  const hunks: Hunk[] = [];
  let bi = 0;
  let xi = 0;
  for (const [i, j] of pairs) {
    if (i > bi || j > xi) hunks.push({ bs: bi, be: i, xs: xi, xe: j });
    bi = i + 1;
    xi = j + 1;
  }
  if (baseLength > bi || sideLength > xi)
    hunks.push({ bs: bi, be: baseLength, xs: xi, xe: sideLength });
  return hunks;
}

/** Not `push(...lines)`: a big file would overflow the argument limit. */
const append = (target: string[], lines: readonly string[]): void => {
  for (const line of lines) target.push(line);
};

const sameLines = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((line, i) => line === b[i]);

/**
 * Merges `ours` and `theirs`, which both come from `base`. A side that did not change gives way
 * to the other, and the same change on both sides is made once.
 */
export function mergeText(
  base: string,
  ours: string,
  theirs: string,
  options: MergeOptions = {},
): MergeResult {
  if (ours === theirs) return { ok: true, text: ours };
  if (base === ours) return { ok: true, text: theirs };
  if (base === theirs) return { ok: true, text: ours };

  const maxEdits = options.maxEdits ?? DEFAULT_MAX_EDITS;
  const b = splitLines(base);
  const o = splitLines(ours);
  const t = splitLines(theirs);
  const pairsOurs = matchingLines(b, o, maxEdits);
  const pairsTheirs = matchingLines(b, t, maxEdits);
  if (!pairsOurs || !pairsTheirs) return { ok: false, reason: 'too_large' };
  const hunksOurs = hunksOf(pairsOurs, b.length, o.length);
  const hunksTheirs = hunksOf(pairsTheirs, b.length, t.length);

  const all = [
    ...hunksOurs.map((h) => ({ h, side: 'o' as const })),
    ...hunksTheirs.map((h) => ({ h, side: 't' as const })),
  ].sort((p, q) => p.h.bs - q.h.bs || p.h.be - q.h.be || (p.side < q.side ? -1 : 1));

  const out: string[] = [];
  let conflicts = 0;
  let cursor = 0;
  let i = 0;
  while (i < all.length) {
    // A group: every hunk that overlaps or touches the one before it, from either side.
    const first = all[i] as (typeof all)[number];
    let end = first.h.be;
    const group = [first];
    i++;
    while (i < all.length && (all[i] as (typeof all)[number]).h.bs <= end) {
      const next = all[i] as (typeof all)[number];
      end = Math.max(end, next.h.be);
      group.push(next);
      i++;
    }
    const start = first.h.bs;
    append(out, b.slice(cursor, start));
    cursor = end;

    const text = (side: 'o' | 't', lines: readonly string[]): string[] => {
      const mine = group.filter((g) => g.side === side).map((g) => g.h);
      if (mine.length === 0) return b.slice(start, end);
      const head = mine[0] as Hunk;
      const tail = mine[mine.length - 1] as Hunk;
      return lines.slice(head.xs - (head.bs - start), tail.xe + (end - tail.be));
    };
    const fromOurs = text('o', o);
    const fromTheirs = text('t', t);
    const original = b.slice(start, end);
    if (sameLines(fromOurs, fromTheirs)) append(out, fromOurs);
    else if (sameLines(fromOurs, original)) append(out, fromTheirs);
    else if (sameLines(fromTheirs, original)) append(out, fromOurs);
    else conflicts++;
  }
  if (conflicts > 0) return { ok: false, reason: 'conflict', conflicts };
  append(out, b.slice(cursor));
  return { ok: true, text: out.join('') };
}
