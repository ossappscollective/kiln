import { measureField } from '@kiln/core';
import { formatDisplayName, formatList, formatNumber } from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';
import type { BadgeTone } from '../portfolio.ts';
import type {
  DriftField,
  DriftLocale,
  DriftStatus,
  ListingDrift,
  ListingHistoryEntry,
  ListingValueSource,
} from '../types.ts';

// ---------------------------------------------------------------------------------------------
// Status labels. The words carry the meaning; the tone only supports it.

export const DRIFT_ORDER: readonly DriftStatus[] = [
  'diverged',
  'repo-ahead',
  'store-ahead',
  'missing-in-one',
  'identical',
];

/** `label` and `explain` are message keys; `count` is the key of the "3 identical" phrase of the summary line. */
type StatusInfo = { label: string; tone: BadgeTone; explain: string; count: string };

const STATUS: Record<DriftStatus, StatusInfo> = {
  identical: {
    label: k('listing:drift.status.identical'),
    tone: 'ok',
    explain: k('listing:drift.statusExplain.identical'),
    count: k('listing:drift.count.identical'),
  },
  'repo-ahead': {
    label: k('listing:drift.status.repoAhead'),
    tone: 'info',
    explain: k('listing:drift.statusExplain.repoAhead'),
    count: k('listing:drift.count.repoAhead'),
  },
  'store-ahead': {
    label: k('listing:drift.status.storeAhead'),
    tone: 'warn',
    explain: k('listing:drift.statusExplain.storeAhead'),
    count: k('listing:drift.count.storeAhead'),
  },
  diverged: {
    label: k('listing:drift.status.diverged'),
    tone: 'bad',
    explain: k('listing:drift.statusExplain.diverged'),
    count: k('listing:drift.count.diverged'),
  },
  'missing-in-one': {
    label: k('listing:drift.status.missingInOne'),
    tone: 'neutral',
    explain: k('listing:drift.statusExplain.missingInOne'),
    count: k('listing:drift.count.missingInOne'),
  },
};

export const statusLabel = (status: DriftStatus): string => t(STATUS[status].label);

export const statusTone = (status: DriftStatus): BadgeTone => STATUS[status].tone;

export const statusExplanation = (status: DriftStatus): string => t(STATUS[status].explain);

/** "Missing in the repository" or "Missing in the store": which side has no value. */
export function statusDetail(field: Pick<DriftField, 'status' | 'missingIn'>): string {
  if (field.status !== 'missing-in-one') return t(STATUS[field.status].label);
  if (field.missingIn === 'repo') return t('listing:drift.missingInRepo');
  if (field.missingIn === 'store') return t('listing:drift.missingInStore');
  return t(STATUS['missing-in-one'].label);
}

// ---------------------------------------------------------------------------------------------
// Character counts

export type Usage = {
  count: number;
  limit: number | null;
  unit: 'characters' | 'bytes';
  over: boolean;
};

/** The size of a value against the field's limit, counted as the store counts it. */
export function usage(
  value: string | null,
  limit: number | null,
  unit: 'characters' | 'bytes',
): Usage {
  const count = value === null ? 0 : measureField({ unit }, value);
  return { count, limit, unit, over: limit !== null && count > limit };
}

/** "27 / 30 characters", "12 characters" without a limit. */
export function usageText(u: Usage): string {
  const bytes = u.unit === 'bytes';
  if (u.limit === null) {
    return bytes
      ? t('listing:drift.usage.bytes', { count: u.count })
      : t('listing:drift.usage.characters', { count: u.count });
  }
  const used = formatNumber(u.count);
  return bytes
    ? t('listing:drift.usage.bytesOf', { count: u.limit, used })
    : t('listing:drift.usage.charactersOf', { count: u.limit, used });
}

// ---------------------------------------------------------------------------------------------
// Inline text diff: word level, so a changed sentence shows which words differ.

export type DiffPart = { kind: 'same' | 'del' | 'ins'; text: string };

/** Beyond this many tokens a side is shown as one replaced block: the diff is quadratic. */
export const DIFF_TOKEN_CAP = 1500;

/** Whitespace, words (with inner apostrophes and hyphens) and single punctuation marks. */
const tokenize = (text: string): string[] =>
  text.match(/\s+|[\p{L}\p{N}_]+(?:['’-][\p{L}\p{N}_]+)*|[^\s]/gu) ?? [];

function merge(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  for (const part of parts) {
    if (part.text === '') continue;
    const last = out[out.length - 1];
    if (last && last.kind === part.kind) last.text += part.text;
    else out.push({ ...part });
  }
  return out;
}

/**
 * The words that turn `from` into `to`. `del` parts exist only in `from`, `ins` parts only in `to`.
 * Whitespace is part of the tokens, so joining the `same` and `del` parts gives `from` back and the
 * `same` and `ins` parts give `to`.
 */
export function diffWords(from: string, to: string): DiffPart[] {
  if (from === to) return from === '' ? [] : [{ kind: 'same', text: from }];
  const a = tokenize(from);
  const b = tokenize(to);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const prefix: DiffPart = { kind: 'same', text: a.slice(0, head).join('') };
  const suffix: DiffPart = { kind: 'same', text: a.slice(a.length - tail).join('') };
  if (midA.length > DIFF_TOKEN_CAP || midB.length > DIFF_TOKEN_CAP) {
    return merge([
      prefix,
      { kind: 'del', text: midA.join('') },
      { kind: 'ins', text: midB.join('') },
      suffix,
    ]);
  }
  // Longest common subsequence over the differing middle.
  const w = midB.length + 1;
  const table = new Uint16Array((midA.length + 1) * w);
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      table[i * w + j] =
        midA[i] === midB[j]
          ? (table[(i + 1) * w + j + 1] as number) + 1
          : Math.max(table[(i + 1) * w + j] as number, table[i * w + j + 1] as number);
    }
  }
  const middle: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      middle.push({ kind: 'same', text: midA[i] as string });
      i++;
      j++;
    } else if ((table[(i + 1) * w + j] as number) >= (table[i * w + j + 1] as number)) {
      middle.push({ kind: 'del', text: midA[i++] as string });
    } else {
      middle.push({ kind: 'ins', text: midB[j++] as string });
    }
  }
  while (i < midA.length) middle.push({ kind: 'del', text: midA[i++] as string });
  while (j < midB.length) middle.push({ kind: 'ins', text: midB[j++] as string });
  return merge([prefix, ...middle, suffix]);
}

// ---------------------------------------------------------------------------------------------
// Which two columns to compare when a field differs

export type Comparison = {
  from: 'repo' | 'live';
  to: 'repo' | 'live';
  fromValue: string;
  toValue: string;
};

/**
 * The pair the inline diff shows: the repository's value against the live store value, when both
 * exist and differ. A field with one side only has nothing to diff.
 */
export function comparison(field: DriftField): Comparison | null {
  const repo = field.repo.value;
  const live = field.live.value;
  if (repo === null || live === null || repo === live) return null;
  return { from: 'live', to: 'repo', fromValue: live, toValue: repo };
}

// ---------------------------------------------------------------------------------------------
// Filters

export type DriftFilter = { status: DriftStatus | 'all' | 'differing'; query: string };

export const defaultFilter = (): DriftFilter => ({ status: 'all', query: '' });

const matchesStatus = (field: DriftField, status: DriftFilter['status']): boolean =>
  status === 'all'
    ? true
    : status === 'differing'
      ? field.status !== 'identical'
      : field.status === status;

/** The locales that remain after filtering; a locale with no matching field is dropped. */
export function filterLocales(locales: readonly DriftLocale[], filter: DriftFilter): DriftLocale[] {
  const query = filter.query.trim().toLowerCase();
  const out: DriftLocale[] = [];
  for (const locale of locales) {
    const localeMatches = query !== '' && locale.locale.toLowerCase().includes(query);
    const fields = locale.fields.filter((field) => {
      if (!matchesStatus(field, filter.status)) return false;
      if (query === '' || localeMatches) return true;
      return [field.label, field.field, field.repo.value, field.live.value, field.db.value].some(
        (text) => (text ?? '').toLowerCase().includes(query),
      );
    });
    if (fields.length > 0) out.push({ locale: locale.locale, fields });
  }
  return out;
}

/** "German (Germany)" for `de-DE`; the code itself when the runtime cannot name it. */
export function localeName(code: string): string {
  if (code === 'default') return t('listing:drift.localeDefault');
  const name = formatDisplayName(code.replace('_', '-'), 'language');
  return name && name !== code ? name : code;
}

/** How many fields differ (are not identical) in a locale. */
export const differingCount = (locale: DriftLocale): number =>
  locale.fields.filter((f) => f.status !== 'identical').length;

/** "3 differ" or "All identical", for a locale heading. */
export function localeSummary(locale: DriftLocale): string {
  const n = differingCount(locale);
  return n === 0 ? t('listing:drift.allIdentical') : t('listing:drift.fieldsDiffer', { count: n });
}

/** A one-line summary of the whole drift view. */
export function driftSummaryText(drift: ListingDrift): string {
  const parts: string[] = [];
  for (const status of DRIFT_ORDER) {
    const n = drift.summary[status];
    if (n > 0) parts.push(t(STATUS[status].count, { count: n }));
  }
  return parts.length === 0 ? t('listing:drift.noValues') : formatList(parts, { type: 'unit' });
}

/** True when neither the repository nor the store has anything to compare. */
export const isEmptyDrift = (drift: ListingDrift): boolean => drift.locales.length === 0;

// ---------------------------------------------------------------------------------------------
// History

const SOURCE_LABELS: Record<ListingValueSource, string> = {
  store: k('listing:drift.source.store'),
  repo: k('listing:drift.source.repo'),
  change_set: k('listing:drift.source.changeSet'),
};

export const sourceLabel = (source: ListingValueSource): string =>
  SOURCE_LABELS[source] ? t(SOURCE_LABELS[source]) : source;

/** A commit sha shortened; other references (store versions, change set ids) are shown as they are. */
export function shortRef(source: ListingValueSource, ref: string | null): string | null {
  if (ref === null || ref === '') return null;
  if (source === 'repo' && /^[0-9a-f]{40}$/i.test(ref)) return ref.slice(0, 7);
  if (source === 'change_set' && ref.length > 12) return `${ref.slice(0, 8)}…`;
  return ref;
}

/** "Store · live · 2.1.0", "Repository · 3fa9c1b", "Change set · 1b2c3d4e…". */
export function describeSource(
  entry: Pick<ListingHistoryEntry, 'source' | 'sourceRef' | 'channel'>,
): string {
  const parts: string[] = [sourceLabel(entry.source)];
  if (entry.source === 'store' && entry.channel !== '')
    parts.push(
      entry.channel === 'editable'
        ? t('listing:drift.channel.editable')
        : t('listing:drift.channel.live'),
    );
  const ref = shortRef(entry.source, entry.sourceRef);
  if (ref) parts.push(ref);
  return parts.join(' · ');
}

/** Who recorded an entry, in words. A sync or a repository read by a person is theirs; scheduled reads are the system's. */
export function actorText(actor: ListingHistoryEntry['actor']): string {
  if (actor === null) return '';
  if (actor.type === 'user') return t('listing:drift.actor.user');
  if (actor.type === 'system') return t('listing:drift.actor.system');
  return t('listing:drift.actor.other', { type: actor.type });
}

export type HistoryStep = {
  entry: ListingHistoryEntry;
  /** The value of the previous entry of the same source and channel. `undefined`: none is loaded. */
  previous: string | null | undefined;
  removed: boolean;
};

/**
 * Pairs each entry (newest first, as the API returns them) with the entry before it in the same
 * stream (the same source and channel), so a step can show what it changed.
 */
export function historySteps(entries: readonly ListingHistoryEntry[]): HistoryStep[] {
  const next = new Map<string, string | null>();
  const out: HistoryStep[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as ListingHistoryEntry;
    const stream = `${entry.locale}\u0000${entry.field}\u0000${entry.source}\u0000${entry.channel}`;
    out.push({
      entry,
      previous: next.has(stream) ? next.get(stream) : undefined,
      removed: entry.value === null,
    });
    next.set(stream, entry.value);
  }
  return out.reverse();
}
