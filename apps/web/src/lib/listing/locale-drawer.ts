import { type Platform, platformLabel } from '@kiln/core';
import { formatList, formatNumber } from '../i18n/format.ts';
import { t } from '../i18n/t.ts';
import type { DriftField } from '../types.ts';
import { usage, usageText } from './drift.ts';
import { type CellStatus, cellStatus, isStoreOnly } from './matrix.ts';

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
      return isStoreOnly() ? t('listing:matrix.cellShort.fine') : t('listing:drawer.word.sync');
    case 'repo-differs':
      return t('listing:drawer.word.storeAhead');
    case 'store-differs':
      return t('listing:drawer.word.repoAhead');
    case 'diverged':
      return t('listing:drawer.word.diverged');
    case 'missing':
      return t('listing:drawer.word.missing');
    case 'over':
      return t('listing:drawer.word.over');
    default:
      return t('listing:drawer.word.na');
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
      side: 'repo' as const,
      u: usage(field.repo.value, field.limit, field.unit),
      has: field.repo.value !== null,
    },
    {
      side: 'store' as const,
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
    const params = { count: by, limit: formatNumber(field.limit) };
    message =
      over[0].side === 'repo'
        ? field.unit === 'bytes'
          ? t('listing:drawer.limit.repoOverBytes', params)
          : t('listing:drawer.limit.repoOverCharacters', params)
        : field.unit === 'bytes'
          ? t('listing:drawer.limit.storeOverBytes', params)
          : t('listing:drawer.limit.storeOverCharacters', params);
  } else if (over.length > 1) {
    message =
      field.unit === 'bytes'
        ? t('listing:drawer.limit.bothOverBytes', { count: field.limit })
        : t('listing:drawer.limit.bothOverCharacters', { count: field.limit });
  }
  return { text: usageText(biggest.u), over: over.length > 0, message };
}

/**
 * The problems of a field that stay visible even when the comparison is folded: the server's own messages (with the side they are about),
 * and, when no message says it already, that a side is over the limit.
 */
export function blockingLines(field: DriftField): string[] {
  const lines = [
    ...field.problems.repo.map((p) => t('listing:drawer.problem.repo', { message: p.message })),
    ...field.problems.live.map((p) => t('listing:drawer.problem.store', { message: p.message })),
  ];
  const tooLong = [...field.problems.repo, ...field.problems.live].some(
    (p) => p.code === 'too_long',
  );
  const note = fieldLimitNote(field);
  if (!tooLong && note?.message) lines.push(note.message);
  return lines;
}

/** What the top of the drawer says about this locale, from the fields of every platform. */
export function localeLead(
  platforms: readonly { fields: readonly DriftField[]; empty?: readonly string[] | undefined }[],
): {
  headline: string;
  hint: string;
  tone: LeadTone;
  differ: number;
  over: number;
} {
  const all = platforms.flatMap((p) => p.fields);
  // A language the store holds with nothing in it has no fields: say what is wrong, not that there is nothing to see.
  if (all.length === 0 && platforms.some((p) => (p.empty ?? []).length > 0))
    return {
      headline: t('listing:drawer.lead.emptyLocale'),
      hint: t('listing:drawer.lead.emptyLocaleHint'),
      tone: 'warn',
      differ: 0,
      over: 0,
    };
  if (all.length === 0)
    return {
      headline: t('listing:drawer.lead.noFields'),
      hint: t('listing:drawer.lead.noFieldsHint'),
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
      headline: t('listing:drawer.lead.allInSync'),
      hint: t('listing:drawer.lead.allInSyncHint'),
      tone: 'ok',
      differ,
      over,
    };
  const parts: string[] = [];
  if (count('store-differs') > 0)
    parts.push(t('listing:drawer.lead.changedInRepo', { count: count('store-differs') }));
  if (count('repo-differs') > 0)
    parts.push(t('listing:drawer.lead.changedInStore', { count: count('repo-differs') }));
  if (count('diverged') > 0)
    parts.push(t('listing:drawer.lead.changedBoth', { count: count('diverged') }));
  if (count('missing') > 0)
    parts.push(t('listing:drawer.lead.missingValue', { count: count('missing') }));
  if (over > 0) {
    const rest = differ - over;
    return {
      headline: t('listing:drawer.lead.overLimit', { count: over }),
      hint:
        rest > 0
          ? t('listing:drawer.lead.overLimitMore', { count: rest })
          : t('listing:drawer.lead.overLimitHint'),
      tone: 'bad',
      differ,
      over,
    };
  }
  return {
    headline: t('listing:drawer.lead.differ', { count: differ }),
    hint:
      parts.length > 0
        ? t('listing:drawer.lead.partsHint', { parts: formatList(parts, { type: 'unit' }) })
        : t('listing:drawer.lead.lookBelow'),
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
        label: many
          ? t('listing:drawer.action.shortenOn', {
              platform: platformLabel(p.platform),
              field: found.label.toLowerCase(),
            })
          : t('listing:drawer.action.shorten', { field: found.label.toLowerCase() }),
      };
  }
  for (const p of platforms) {
    if (p.canPull && p.pullable.length > 0) {
      const n = p.pullable.length;
      return {
        kind: 'pull',
        platform: p.platform,
        count: n,
        label: t('listing:drawer.action.pull', { count: n, platform: platformLabel(p.platform) }),
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
        label: many
          ? t('listing:drawer.action.stageOn', {
              platform: platformLabel(p.platform),
              field: found.label.toLowerCase(),
            })
          : t('listing:drawer.action.stage', { field: found.label.toLowerCase() }),
      };
  }
  return null;
}
