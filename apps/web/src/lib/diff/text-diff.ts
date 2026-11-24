/**
 * Text diff, pure and dependency free (docs/adr/0067-diff-and-preview.md). Word level by default (characters for short texts and
 * for scripts without spaces), line level (paragraph aware, changed line pairs refined by words) for long texts. Myers O(ND) with a
 * cap on the edit distance and on the input, so a 4000 character description never freezes the page: over the cap the answer falls
 * back to coarser steps and ends with "everything changed" (`capped: true`), which is still a correct diff.
 * Invariant: the `same` + `del` segments joined are the (normalised) before text, the `same` + `add` segments joined are the after text.
 */

export type DiffKind = 'same' | 'add' | 'del';
export type Segment = { kind: DiffKind; text: string };
export type DiffMode = 'word' | 'char' | 'line';
export type DiffStats = {
  addedWords: number;
  removedWords: number;
  addedChars: number;
  removedChars: number;
  beforeChars: number;
  afterChars: number;
};
export type DiffResult = {
  mode: DiffMode;
  segments: Segment[];
  stats: DiffStats;
  identical: boolean;
  /** The work cap was hit: part of the answer is one coarse block, not a fine grained diff. */
  capped: boolean;
};
export type DiffOptions = {
  mode?: DiffMode | 'auto';
  /** Longest input (characters, per side) that is diffed at all; the rest is one block. Default 20000. */
  maxChars?: number;
  /** Largest edit distance Myers explores before it gives up on a level. Default 400. */
  maxEdits?: number;
};

export const DIFF_MAX_CHARS = 20000;
export const DIFF_MAX_EDITS = 400;
const SHORT = 40;
const LONG = 3000;

/** Line endings to `\n` (a store may hold `\r\n`), so a difference in line ending alone is not a change. */
export const normalizeText = (s: string): string => s.replace(/\r\n?/g, '\n');

/** Unicode code points, the unit of the store limits (not UTF-16 units). */
export const countChars = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

const CJK = '\\p{Script=Han}|\\p{Script=Hiragana}|\\p{Script=Katakana}|\\p{Script=Thai}';
const TOKEN = new RegExp(`\\n|[^\\S\\n]+|${CJK}|[\\p{L}\\p{N}\\p{M}_'’-]+|[^\\s]`, 'gu');
const WORD = new RegExp(`^(?:${CJK}|[\\p{L}\\p{N}\\p{M}_'’-]+)$`, 'u');

const tokensOf = (s: string): string[] => s.match(TOKEN) ?? [];
const linesOf = (s: string): string[] => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const charsOf = (s: string): string[] => Array.from(s);
export const wordsIn = (s: string): number => tokensOf(s).filter((x) => WORD.test(x)).length;

type Op = { kind: DiffKind; a: number; b: number; len: number };

/** Myers: the edit script between two token lists, or null when the distance passes `maxEdits`. */
function myers(a: readonly string[], b: readonly string[], maxEdits: number): Segment[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const size = 2 * max + 3;
  const off = max + 1;
  let v = new Int32Array(size);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[off + k - 1] ?? 0) < (v[off + k + 1] ?? 0))
          ? (v[off + k + 1] ?? 0)
          : (v[off + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;
  // Walk back through the trace.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vv = trace[d]!;
    const k = x - y;
    const down = k === -d || (k !== d && (vv[off + k - 1] ?? 0) < (vv[off + k + 1] ?? 0));
    const pk = down ? k + 1 : k - 1;
    const px = vv[off + pk] ?? 0;
    const py = px - pk;
    while (x > px && y > py) {
      ops.push({ kind: 'same', a: x - 1, b: y - 1, len: 1 });
      x--;
      y--;
    }
    ops.push(
      down ? { kind: 'add', a: x, b: y - 1, len: 1 } : { kind: 'del', a: x - 1, b: y, len: 1 },
    );
    x = px;
    y = py;
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: 'same', a: x - 1, b: y - 1, len: 1 });
    x--;
    y--;
  }
  const out: Segment[] = [];
  for (const op of ops.reverse())
    push(out, { kind: op.kind, text: op.kind === 'add' ? (b[op.b] ?? '') : (a[op.a] ?? '') });
  return out;
}

/** Append a segment, joining it to the previous one of the same kind. */
function push(out: Segment[], seg: Segment): void {
  if (seg.text === '') return;
  const last = out[out.length - 1];
  if (last && last.kind === seg.kind) last.text += seg.text;
  else out.push({ kind: seg.kind, text: seg.text });
}

/** Within one run of changes put the removed text before the added text, so a replacement reads "old new". */
function tidy(segments: readonly Segment[]): Segment[] {
  const out: Segment[] = [];
  let del = '';
  let add = '';
  const flush = () => {
    push(out, { kind: 'del', text: del });
    push(out, { kind: 'add', text: add });
    del = '';
    add = '';
  };
  for (const s of segments) {
    if (s.kind === 'same') {
      flush();
      push(out, s);
    } else if (s.kind === 'del') del += s.text;
    else add += s.text;
  }
  flush();
  return out;
}

/** Diff two token lists: common prefix and suffix first (cheap, and most edits are local), Myers on the middle. */
function diffTokens(
  a: readonly string[],
  b: readonly string[],
  maxEdits: number,
): Segment[] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const middle = myers(a.slice(start, endA), b.slice(start, endB), maxEdits);
  if (middle === null) return null;
  const out: Segment[] = [];
  push(out, { kind: 'same', text: a.slice(0, start).join('') });
  for (const s of middle) push(out, s);
  push(out, { kind: 'same', text: a.slice(endA).join('') });
  return out;
}

const block = (before: string, after: string): Segment[] => {
  const out: Segment[] = [];
  push(out, { kind: 'del', text: before });
  push(out, { kind: 'add', text: after });
  return out;
};

function statsOf(segments: readonly Segment[]): DiffStats {
  const s: DiffStats = {
    addedWords: 0,
    removedWords: 0,
    addedChars: 0,
    removedChars: 0,
    beforeChars: 0,
    afterChars: 0,
  };
  for (const seg of segments) {
    const chars = countChars(seg.text);
    if (seg.kind !== 'add') s.beforeChars += chars;
    if (seg.kind !== 'del') s.afterChars += chars;
    if (seg.kind === 'add') {
      s.addedChars += chars;
      s.addedWords += wordsIn(seg.text);
    } else if (seg.kind === 'del') {
      s.removedChars += chars;
      s.removedWords += wordsIn(seg.text);
    }
  }
  return s;
}

/** Line level, then each run of removed lines followed by added lines refined by words when it is small enough. */
function diffLines(
  before: string,
  after: string,
  maxEdits: number,
): { segments: Segment[]; capped: boolean } {
  const lines = diffTokens(linesOf(before), linesOf(after), maxEdits);
  if (lines === null) return { segments: block(before, after), capped: true };
  const out: Segment[] = [];
  let capped = false;
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i]!;
    const next = lines[i + 1];
    if (cur.kind === 'del' && next?.kind === 'add') {
      const fine = diffTokens(tokensOf(cur.text), tokensOf(next.text), maxEdits);
      if (fine) for (const s of tidy(fine)) push(out, s);
      else {
        for (const s of block(cur.text, next.text)) push(out, s);
        capped = true;
      }
      i++;
    } else push(out, cur);
  }
  return { segments: out, capped };
}

/** The diff of two texts. Line endings are normalised first. Never throws and never runs unbounded. */
export function diffText(
  beforeRaw: string,
  afterRaw: string,
  options: DiffOptions = {},
): DiffResult {
  const before = normalizeText(beforeRaw);
  const after = normalizeText(afterRaw);
  const maxChars = options.maxChars ?? DIFF_MAX_CHARS;
  const maxEdits = options.maxEdits ?? DIFF_MAX_EDITS;
  const requested = options.mode ?? 'auto';
  const lineCount = Math.max(linesOf(before).length, linesOf(after).length);
  const mode: DiffMode =
    requested !== 'auto'
      ? requested
      : Math.max(before.length, after.length) > LONG || lineCount >= 8
        ? 'line'
        : Math.max(before.length, after.length) <= SHORT
          ? 'char'
          : 'word';
  const done = (segments: Segment[], capped: boolean): DiffResult => {
    const tidied = tidy(segments);
    return { mode, segments: tidied, stats: statsOf(tidied), identical: before === after, capped };
  };
  if (before === after) return done(before === '' ? [] : [{ kind: 'same', text: before }], false);
  if (before === '' || after === '') return done(block(before, after), false);
  if (before.length > maxChars || after.length > maxChars) return done(block(before, after), true);
  if (mode === 'line') {
    const r = diffLines(before, after, maxEdits);
    return done(r.segments, r.capped);
  }
  const split = mode === 'char' ? charsOf : tokensOf;
  const fine = diffTokens(split(before), split(after), maxEdits);
  if (fine) return done(fine, false);
  // Too different for words: lines (and words inside changed line pairs), then one block.
  const r = diffLines(before, after, maxEdits);
  return done(r.segments, true);
}

/** The two sides of a diff for the side by side view: what was there (`same` + `del`) and what is there (`same` + `add`). */
export function sidesOf(segments: readonly Segment[]): { before: Segment[]; after: Segment[] } {
  return {
    before: segments.filter((s) => s.kind !== 'add'),
    after: segments.filter((s) => s.kind !== 'del'),
  };
}

/** A short plain-text summary of the stats, e.g. `+3 / -1 words`; empty when nothing changed. */
export function statsLine(stats: DiffStats): string {
  if (stats.addedChars === 0 && stats.removedChars === 0) return '';
  return `+${stats.addedWords} / -${stats.removedWords}`;
}

/** One changed text for the diff dialog (DiffModal). */
export type DiffItem = {
  key: string;
  title: string;
  subtitle?: string | undefined;
  before: string | null;
  after: string | null;
  limit?: number | null | undefined;
  unit?: 'characters' | 'bytes' | undefined;
};
