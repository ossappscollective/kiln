// The competitor listing watch: what changed between two reads of an App Store competitor's public page
// (docs/adr/0056-competitor-listing-watch.md). Pure; ES2017 (the web imports it). Adapted in approach from Open Screenshot
// Generator (MIT), see THIRD_PARTY_NOTICES.md: compare by a stable image identity, ignore whitespace, treat noise as no change.

/** Everything of the listing the watch compares, as Apple's lookup gives it. The addresses are kept as read so the proxy can show them. */
export type ListingState = {
  name: string | null;
  description: string | null;
  releaseNotes: string | null;
  version: string | null;
  price: string | null;
  category: string | null;
  icon: string | null;
  iphone: string[];
  ipad: string[];
  ratingMilli: number | null;
  ratingCount: number | null;
};

export type ScreenshotDevice = 'iphone' | 'ipad';
export type TextChangeKind = 'name' | 'description' | 'releaseNotes' | 'version' | 'price' | 'category';

export type ListingChange =
  | {
      kind: 'screenshots';
      device: ScreenshotDevice;
      /** Images that are new (not counting those that took the place of another). */
      added: number;
      removed: number;
      /** Pairs of one image gone and one new: a replaced screenshot. */
      replaced: number;
      /** The images that stayed came in another order. */
      reordered: boolean;
      before: string[];
      after: string[];
    }
  | { kind: 'icon'; before: string | null; after: string | null }
  | { kind: TextChangeKind; before: string | null; after: string | null }
  | { kind: 'rating' | 'ratingCount'; before: number | null; after: number | null };

/** Kept per text change (characters), so a change row stays small. */
export const LISTING_TEXT_KEEP = 2000;
/** Retention of the change rows. */
export const COMPETITOR_CHANGE_RETENTION_DAYS = 180;
export const COMPETITOR_CHANGES_MAX_PER_COMPETITOR = 200;
/** Rating noise: the average counts from 0.1 star, the count from 10 % and at least 50. */
export const LISTING_RATING_MILLI = 100;
export const LISTING_RATING_COUNT_RATIO = 0.1;
export const LISTING_RATING_COUNT_MIN = 50;

/**
 * A stable identity for an image address: the host of Apple's CDN (`is1-ssl.mzstatic.com`, `is3-ssl...`) is one, and the trailing
 * rendition segment (`/392x696bb.jpg`, `/600x0w.webp`, `/1242x2688bb-85.png`) and the query are dropped, so a re-encode or another
 * size of the same picture is the same key.
 */
export function imageKey(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url.trim();
  }
  const host = /(^|\.)mzstatic\.com$/i.test(parsed.hostname) ? 'mzstatic.com' : parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/\d+x\d+[a-z]{0,3}(?:-\d+)?\.(?:jpe?g|png|webp|heic|tiff?)$/i, '');
  return `${host}${path}`;
}

/** Text as compared: line ends and runs of spaces collapsed, blank lines dropped, ends trimmed. Null and empty are the same. */
export function normalizeListingText(value: string | null | undefined): string | null {
  const s = (value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t   ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return s === '' ? null : s;
}

const keep = (s: string | null): string | null => (s === null ? null : s.length > LISTING_TEXT_KEEP ? s.slice(0, LISTING_TEXT_KEEP) : s);

function diffShots(device: ScreenshotDevice, before: string[], after: string[]): ListingChange | null {
  const b = before.map(imageKey);
  const a = after.map(imageKey);
  // A store read with no screenshot at all after one with some is a failed read, not a change.
  if (a.length === 0 && b.length > 0) return null;
  const inB = new Set(b);
  const inA = new Set(a);
  const added = a.filter((k) => !inB.has(k)).length;
  const removed = b.filter((k) => !inA.has(k)).length;
  const common = b.filter((k) => inA.has(k));
  const commonAfter = a.filter((k) => inB.has(k));
  const reordered = common.some((k, i) => k !== commonAfter[i]);
  if (added === 0 && removed === 0 && !reordered) return null;
  const replaced = Math.min(added, removed);
  return { kind: 'screenshots', device, added: added - replaced, removed: removed - replaced, replaced, reordered, before, after };
}

/**
 * What changed from `previous` to `next`. Without `previous` (the first look) nothing changed. Whitespace-only text changes and CDN
 * re-encodes are no change; an empty name, description or icon, or an empty screenshot list, after a filled one is a failed read and is
 * ignored (`carryOver` keeps the old value in the stored state). The rating counts only from 0.1 star, the rating count from 10 % and 50.
 */
export function diffListing(previous: ListingState | undefined, next: ListingState): ListingChange[] {
  if (!previous) return [];
  const out: ListingChange[] = [];
  const shots = diffShots('iphone', previous.iphone, next.iphone);
  if (shots) out.push(shots);
  const shotsIpad = diffShots('ipad', previous.ipad, next.ipad);
  if (shotsIpad) out.push(shotsIpad);
  if (previous.icon && next.icon && imageKey(previous.icon) !== imageKey(next.icon))
    out.push({ kind: 'icon', before: previous.icon, after: next.icon });
  const text = (kind: TextChangeKind, ignoreEmpty: boolean) => {
    const b = normalizeListingText(previous[kind]);
    const a = normalizeListingText(next[kind]);
    if (b === a || (ignoreEmpty && a === null)) return;
    out.push({ kind, before: keep(b), after: keep(a) });
  };
  text('name', true);
  text('description', true);
  text('releaseNotes', false);
  text('category', true);
  text('price', true);
  text('version', true);
  if (previous.ratingMilli !== null && next.ratingMilli !== null && Math.abs(next.ratingMilli - previous.ratingMilli) >= LISTING_RATING_MILLI)
    out.push({ kind: 'rating', before: previous.ratingMilli, after: next.ratingMilli });
  if (previous.ratingCount !== null && next.ratingCount !== null) {
    const d = Math.abs(next.ratingCount - previous.ratingCount);
    if (d >= LISTING_RATING_COUNT_MIN && d >= previous.ratingCount * LISTING_RATING_COUNT_RATIO)
      out.push({ kind: 'ratingCount', before: previous.ratingCount, after: next.ratingCount });
  }
  return out;
}

/** The state to store after a read: a part the store left empty keeps its last known value, so the next read does not see a false change. */
export function carryOver(previous: ListingState | undefined, next: ListingState): ListingState {
  if (!previous) return next;
  return {
    ...next,
    name: next.name || previous.name,
    description: next.description || previous.description,
    icon: next.icon || previous.icon,
    iphone: next.iphone.length > 0 ? next.iphone : previous.iphone,
    ipad: next.ipad.length > 0 ? next.ipad : previous.ipad,
  };
}

export const changeKey = (c: ListingChange): string => (c.kind === 'screenshots' ? `screenshots_${c.device}` : c.kind);

/** The changes the watch tells people about (events, alerts): everything except rating drift. */
export const isListingChange = (c: ListingChange): boolean => c.kind !== 'rating' && c.kind !== 'ratingCount';

const KIND_ORDER = ['screenshots', 'icon', 'name', 'description', 'releaseNotes', 'category', 'price', 'version', 'rating', 'ratingCount'];

/** The distinct kinds in a fixed order (`screenshots` covers both devices). */
export function changeKinds(changes: readonly ListingChange[]): string[] {
  const seen = new Set<string>();
  for (const c of changes) seen.add(c.kind);
  return KIND_ORDER.filter((k) => seen.has(k));
}

export type WordSegment = { op: 'same' | 'del' | 'ins'; text: string };
const WORD_DIFF_MAX = 400;

/** A word level diff of two texts for a short display (equal runs, removed words, added words). Very long middles fall back to one removal and one insertion. */
export function wordDiff(before: string | null, after: string | null): WordSegment[] {
  const a = (before ?? '').split(/\s+/).filter(Boolean);
  const b = (after ?? '').split(/\s+/).filter(Boolean);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const out: WordSegment[] = [];
  const push = (op: WordSegment['op'], words: string[]) => {
    if (words.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += ` ${words.join(' ')}`;
    else out.push({ op, text: words.join(' ') });
  };
  push('same', a.slice(0, start));
  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);
  if (ma.length > WORD_DIFF_MAX || mb.length > WORD_DIFF_MAX) {
    push('del', ma);
    push('ins', mb);
  } else {
    const n = ma.length;
    const m = mb.length;
    const lcs: number[][] = [];
    for (let i = 0; i <= n; i += 1) lcs.push(new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i -= 1)
      for (let j = m - 1; j >= 0; j -= 1)
        (lcs[i] as number[])[j] = ma[i] === mb[j] ? ((lcs[i + 1] as number[])[j + 1] as number) + 1 : Math.max((lcs[i + 1] as number[])[j] as number, (lcs[i] as number[])[j + 1] as number);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ma[i] === mb[j]) {
        push('same', [ma[i] as string]);
        i += 1;
        j += 1;
      } else if (i < n && (j >= m || ((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number))) {
        push('del', [ma[i] as string]);
        i += 1;
      } else {
        push('ins', [mb[j] as string]);
        j += 1;
      }
    }
  }
  push('same', a.slice(endA));
  return out;
}
