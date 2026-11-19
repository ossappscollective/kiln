import { clip, cleanText } from './ai-task-types.ts';

/**
 * Lenient reading of what a model answered (docs/adr/0024-ai-features.md). The schemas of the new tasks are deliberately loose in the
 * places a small local model gets wrong (a word instead of a choice, a number written as text, one value where a list was asked): a run
 * should not be thrown away, and its tokens wasted, over "Negative" instead of "negative". What the server can decide itself it decides
 * (counts, lengths, limits, evidence ids); what is left is read here, mapped to a known value, and the fallback is always the safe one.
 */

export const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

/** One line of text from a model: cleaned and cut. */
export const line = (value: unknown, max: number): string => clip(cleanText(str(value)).text, max);

/** A paragraph from a model: control characters removed, line breaks kept, cut. */
export const paragraphOf = (value: unknown, max: number): string => clip(cleanText(str(value), { multiline: true }).text, max);

/** A choice: the value matched ignoring case and surrounding space, through `aliases`, else `fallback`. */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T, aliases: Record<string, T> = {}): T {
  const key = str(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (key === '') return fallback;
  for (const a of allowed) if (a === key) return a;
  const alias = aliases[key];
  if (alias !== undefined) return alias;
  // "negative sentiment" or "issue (bug)": the first allowed word that starts it.
  for (const a of allowed) if (key.indexOf(a) === 0) return a;
  return fallback;
}

/** A list of short strings from a list, or from one comma separated string. Empty and repeated entries are dropped. */
export function strings(value: unknown, maxItems: number, maxChars: number): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const seen: Record<string, boolean> = {};
  const out: string[] = [];
  for (const entry of raw) {
    const text = line(entry, maxChars);
    const key = text.toLowerCase();
    if (text === '' || seen[key]) continue;
    seen[key] = true;
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** A whole number in a range from a number or numeric text, else the fallback. */
export function int(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value.replace('%', '')) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === 'yes' || v === 'y' || v === '1') return true;
    if (v === 'false' || v === 'no' || v === 'n' || v === '0') return false;
  }
  return fallback;
}

/**
 * Whether a text states a rank or position number that the data did not hold ("ranks #3", "position 12"). The allowed numbers are the
 * ranks that were SENT. A model never gets to introduce a rank of its own.
 */
export function claimsUnknownRank(text: string, allowed: readonly number[]): boolean {
  const re = /\b(?:rank(?:s|ed|ing)?|position(?:ed)?|place[sd]?)\b[^0-9\n]{0,12}#?\s*(\d{1,4})\b|#(\d{1,4})\b/gi;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const n = Number(m[1] ?? m[2]);
    if (allowed.indexOf(n) === -1) return true;
  }
  return false;
}
