import type { AssetKind, AssetProblem } from '@mrm/core';
import type { LeadTone } from '../page-lead.ts';

/**
 * The top of the Graphics view (components/assets/AssetsTab): what the checks found in a few words, which sets are affected, and one line
 * per blocking problem with what to do about it (docs/design/readability.md, rule 4: a blocking problem is never folded).
 */

/** Blocking problems (errors) first and always shown; warnings and notes fold behind "Problems found". */
export function splitProblems(problems: readonly AssetProblem[]): {
  blocking: AssetProblem[];
  other: AssetProblem[];
} {
  return {
    blocking: problems.filter((p) => p.severity === 'error'),
    other: problems.filter((p) => p.severity !== 'error'),
  };
}

/** "2 warnings, 1 note" for the folded part. */
export function otherCountsText(other: readonly AssetProblem[]): string {
  const warnings = other.filter((p) => p.severity === 'warning').length;
  const notes = other.length - warnings;
  const parts: string[] = [];
  if (warnings > 0) parts.push(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`);
  if (notes > 0) parts.push(`${notes} ${notes === 1 ? 'note' : 'notes'}`);
  return parts.join(', ');
}

const setKey = (p: Pick<AssetProblem, 'locale' | 'kind' | 'device'>): string | null =>
  p.locale === undefined || p.kind === undefined ? null : `${p.locale}|${p.kind}|${p.device ?? ''}`;

/** How many sets (locale, kind and device) the problems touch, and the one kind they share (or null). Problems with no set count as one each. */
export function affectedSets(problems: readonly AssetProblem[]): {
  count: number;
  kind: AssetKind | null;
} {
  const keys = new Set<string>();
  const kinds = new Set<AssetKind>();
  let loose = 0;
  for (const p of problems) {
    const key = setKey(p);
    if (key === null) loose += 1;
    else keys.add(key);
    if (p.kind !== undefined) kinds.add(p.kind);
  }
  const count = keys.size + loose;
  const only = kinds.size === 1 && loose === 0 ? ([...kinds][0] ?? null) : null;
  return { count, kind: only };
}

const KIND_NOUN: Partial<Record<AssetKind, string>> = {
  screenshot: 'screenshot',
  preview: 'app preview',
  feature_graphic: 'feature graphic',
  promo_graphic: 'promo graphic',
  tv_banner: 'TV banner',
  icon: 'icon',
  app_icon: 'app icon',
};

export type AssetsLead = { headline: string; hint: string; tone: LeadTone; blocking: number };

/** "2 screenshot sets have problems" when something blocks, a warning line, or "All files pass the store checks". */
export function assetsLead(input: {
  problems: readonly AssetProblem[];
  /** The existing "12 files, 3 locales, 4.2 MB" text. */
  summary: string;
}): AssetsLead {
  const { blocking, other } = splitProblems(input.problems);
  if (blocking.length > 0) {
    const { count, kind } = affectedSets(blocking);
    const noun = kind ? `${KIND_NOUN[kind] ?? kind} set` : 'set';
    const sets = count === 1 ? noun : `${noun}s`;
    return {
      headline: `${count} ${sets} ${count === 1 ? 'has a problem' : 'have problems'}`,
      hint: `${input.summary}. The stores will not take these files as they are; each line below says what to change.`,
      tone: 'bad',
      blocking: blocking.length,
    };
  }
  const warnings = other.filter((p) => p.severity === 'warning');
  if (warnings.length > 0) {
    const { count, kind } = affectedSets(warnings);
    const noun = kind ? `${KIND_NOUN[kind] ?? kind} set` : 'set';
    const sets = count === 1 ? noun : `${noun}s`;
    return {
      headline: `${count} ${sets} ${count === 1 ? 'has a warning' : 'have warnings'}`,
      hint: `${input.summary}. The stores accept them, but read the warnings under Problems found.`,
      tone: 'warn',
      blocking: 0,
    };
  }
  return {
    headline: 'All files pass the store checks',
    hint: `${input.summary}. Checked against the sizes and counts the stores document; nothing is written to a store from here.`,
    tone: 'ok',
    blocking: 0,
  };
}

/** One short sentence on what to do about a problem, from the end of its rule code. Empty when there is nothing general to say. */
export function problemAction(rule: string): string {
  const end = rule.split('.').at(-1) ?? '';
  switch (end) {
    case 'size':
    case 'dimension':
    case 'ratio':
      return 'Replace the file with one of an accepted size.';
    case 'bytes':
      return 'Export it again as a smaller file.';
    case 'format':
      return 'Convert it to an accepted format.';
    case 'count':
      return 'Remove files from the set, or split it, to stay within the limit.';
    case 'minimum':
      return 'Add more files to this set.';
    case 'unread':
      return 'Open the file to check it is not damaged, or replace it.';
    default:
      return '';
  }
}
