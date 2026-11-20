import { type Platform, platformLabel } from '@mrm/core';
import { usage, usageText } from './drift.ts';
import { type CellStatus, cellStatus } from './matrix.ts';
import type { DriftField } from '../types.ts';

/**
 * Pure parts of the locale drawer of Store listing (docs/design/readability.md, "Second pass: forms and dialogs"): what the drawer opens
 * on (what must be done for THIS locale), one word per field, which fields come first, the quiet counter and the blocking problems of a
 * field, and the one primary action. The components only draw; nothing here reads or changes a store.
 */

export type LeadTone = 'neutral' | 'ok' | 'warn' | 'bad';

/** The one word a field shows: the same fact as its dot, never a second badge. */
export function fieldWord(status: CellStatus): string {
  switch (status) {
    case 'sync':
      return 'In sync';
    case 'repo-differs':
      return 'Store ahead';
    case 'store-differs':
      return 'Repo ahead';
    case 'diverged':
      return 'Diverged';
    case 'missing':
      return 'Missing';
    case 'over':
      return 'Over limit';
    default:
      return 'Not here';
  }
}

const RANK: Record<CellStatus, number> = {
  over: 0,
  diverged: 1,
  missing: 2,
  'repo-differs': 3,
  'store-differs': 4,
  sync: 5,
  na: 6,
};

/** Blocked first (over the limit), then what both sides changed, what is missing, what the store changed, what the repository changed, then what is in sync. Stable. */
export function orderFields(fields: readonly DriftField[]): DriftField[] {
  return fields
    .map((f, i) => ({ f, i, r: RANK[cellStatus(f)] }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.f);
}

/** The fields that need a look (in `orderFields` order), and the ones that are in sync and within their limit. */
export function splitFields(fields: readonly DriftField[]): {
  attention: DriftField[];
  inSync: DriftField[];
} {
  const ordered = orderFields(fields);
  return {
    attention: ordered.filter((f) => cellStatus(f) !== 'sync'),
    inSync: ordered.filter((f) => cellStatus(f) === 'sync'),
  };
}

const unitWord = (unit: 'characters' | 'bytes', n: number): string =>
  unit === 'bytes' ? (n === 1 ? 'byte' : 'bytes') : n === 1 ? 'character' : 'characters';

/**
 * The quiet counter of a field ("27 / 30 characters": the larger of the two sides) and, when a side is over the limit, the one sentence
 * that says so. Null when the field has no limit or no value.
 */
export function fieldLimitNote(field: DriftField): {
  text: string;
  over: boolean;
  message: string | null;
} | null {
  if (field.limit === null) return null;
  const sides = [
    {
      name: 'The repository',
      u: usage(field.repo.value, field.limit, field.unit),
      has: field.repo.value !== null,
    },
    {
      name: 'The store',
      u: usage(field.live.value, field.limit, field.unit),
      has: field.live.value !== null,
    },
  ].filter((s) => s.has);
  const first = sides[0];
  if (first === undefined) return null;
  const biggest = sides.reduce((a, b) => (b.u.count > a.u.count ? b : a), first);
  const over = sides.filter((s) => s.u.over);
  let message: string | null = null;
  if (over.length === 1 && over[0] !== undefined) {
    const by = over[0].u.count - field.limit;
    message = `${over[0].name} is ${by} ${unitWord(field.unit, by)} over the limit of ${field.limit}.`;
  } else if (over.length > 1) {
    message = `The repository and the store are over the limit of ${field.limit} ${unitWord(field.unit, field.limit)}.`;
  }
  return { text: usageText(biggest.u), over: over.length > 0, message };
}

/**
 * The problems of a field that stay visible even when the comparison is folded: the server's own messages (with the side they are about),
 * and, when no message says it already, that a side is over the limit.
 */
export function blockingLines(field: DriftField): string[] {
  const lines = [
    ...field.problems.repo.map((p) => `Repository: ${p.message}`),
    ...field.problems.live.map((p) => `Store: ${p.message}`),
  ];
  const tooLong = [...field.problems.repo, ...field.problems.live].some(
    (p) => p.code === 'too_long',
  );
  const note = fieldLimitNote(field);
  if (!tooLong && note?.message) lines.push(note.message);
  return lines;
}

/** What the top of the drawer says about this locale, from the fields of every platform. */
export function localeLead(platforms: readonly { fields: readonly DriftField[] }[]): {
  headline: string;
  hint: string;
  tone: LeadTone;
  differ: number;
  over: number;
} {
  const all = platforms.flatMap((p) => p.fields);
  if (all.length === 0)
    return {
      headline: 'This locale has no fields',
      hint: 'None of the stores in scope has a field for it.',
      tone: 'neutral',
      differ: 0,
      over: 0,
    };
  const status = all.map(cellStatus);
  const count = (s: CellStatus) => status.filter((x) => x === s).length;
  const over = count('over');
  const differ = status.filter((s) => s !== 'sync').length;
  if (differ === 0)
    return {
      headline: 'Everything is in sync',
      hint: 'The repository and the store have the same text in every field.',
      tone: 'ok',
      differ,
      over,
    };
  const parts = [
    [count('store-differs'), 'changed in the repository'],
    [count('repo-differs'), 'changed in the store'],
    [count('diverged'), 'changed on both sides'],
    [count('missing'), 'missing a value'],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, text]) => `${n} ${text}`);
  if (over > 0) {
    const rest = differ - over;
    return {
      headline: `${over} ${over === 1 ? 'field is' : 'fields are'} over the store's limit`,
      hint:
        rest > 0
          ? `Shorten the text before it can be pushed. ${rest} more ${rest === 1 ? 'differs' : 'differ'} from the store.`
          : 'Shorten the text before it can be pushed.',
      tone: 'bad',
      differ,
      over,
    };
  }
  return {
    headline: `${differ} ${differ === 1 ? 'field differs' : 'fields differ'} from the store`,
    hint: parts.length > 0 ? `${parts.join(', ')}.` : 'Look at each one below.',
    tone: 'warn',
    differ,
    over,
  };
}

export type LeadAction =
  | { kind: 'edit'; platform: Platform; field: DriftField; label: string }
  | { kind: 'pull'; platform: Platform; count: number; label: string }
  | { kind: 'stage'; platform: Platform; field: DriftField; label: string };

export type LeadActionInput = {
  platform: Platform;
  fields: readonly DriftField[];
  /** The fields that can be pulled into the repository (`pullableInLocale`). */
  pullable: readonly DriftField[];
  /** Pulling is available for this platform now (an app record, no reason against it). */
  canPull: boolean;
  canEdit: (field: DriftField) => boolean;
  canStage: (field: DriftField) => boolean;
};

/**
 * The ONE primary action of the locale, using only actions the drawer already has: shorten a field that is over its limit (it blocks a
 * push), else pull what the store changed into the repository, else stage what the repository changed. Null when none applies.
 */
export function leadAction(platforms: readonly LeadActionInput[]): LeadAction | null {
  const many = platforms.length > 1;
  for (const p of platforms) {
    const found = orderFields(p.fields).find((f) => cellStatus(f) === 'over' && p.canEdit(f));
    if (found)
      return {
        kind: 'edit',
        platform: p.platform,
        field: found,
        label: `Shorten ${many ? `${platformLabel(p.platform)} ` : ''}${found.label.toLowerCase()}`,
      };
  }
  for (const p of platforms) {
    if (p.canPull && p.pullable.length > 0) {
      const n = p.pullable.length;
      return {
        kind: 'pull',
        platform: p.platform,
        count: n,
        label: `Pull ${n} ${platformLabel(p.platform)} ${n === 1 ? 'change' : 'changes'} into the repository`,
      };
    }
  }
  for (const p of platforms) {
    const found = orderFields(p.fields).find((f) => p.canStage(f));
    if (found)
      return {
        kind: 'stage',
        platform: p.platform,
        field: found,
        label: `Stage ${many ? `${platformLabel(p.platform)} ` : ''}${found.label.toLowerCase()} from the repository`,
      };
  }
  return null;
}
