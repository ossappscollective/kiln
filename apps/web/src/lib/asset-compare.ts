import { ASSET_KIND_LABELS, type AssetDiffSet, type AssetDiffView } from '@kiln/core';
import { localeName } from './asset-proposal.ts';
import { formatList } from './i18n/format.ts';
import { k, t } from './i18n/t.ts';

/**
 * The view-model of the comparison table of the Assets step of Prepare release (components/release/stepper/StepAssets.svelte): the
 * screenshots in the repository (local) against the store, one row per language and device, with the counts on each side and one
 * status. The comparison itself is the server's (`GET assets/diff`, by checksum where the store gives one, else by size); nothing
 * here reads or changes anything. Written for the ES2017 web build.
 */
export type CompareStatus = 'changed' | 'missing' | 'extra' | 'probably' | 'same';

export type CompareRow = {
  key: string;
  locale: string;
  language: string;
  /** The device or the kind of graphic ("iPhone 6.5-inch display", "Feature graphic"). */
  what: string;
  repoCount: number;
  storeCount: number;
  status: CompareStatus;
  /** "1 changed, 2 missing", empty for a set that is the same on both sides. */
  detail: string;
};

export type CompareState =
  | { kind: 'no_repository' }
  | { kind: 'nothing' }
  | { kind: 'table'; rows: CompareRow[]; hidden: number; needsAttention: number };

/** Most rows the step shows; the Graphics tab has the rest. */
export const MAX_COMPARE_ROWS = 60;

const ORDER: Record<CompareStatus, number> = {
  changed: 0,
  missing: 1,
  extra: 2,
  probably: 3,
  same: 4,
};

export function statusOf(set: Pick<AssetDiffSet, 'totals'>): CompareStatus {
  const { totals } = set;
  if (totals.differs > 0) return 'changed';
  if (totals.only_repo > 0) return 'missing';
  if (totals.only_store > 0) return 'extra';
  if (totals.likely_same > 0) return 'probably';
  return 'same';
}

export function statusLabel(status: CompareStatus): string {
  switch (status) {
    case 'changed':
      return t(k('release-stepper:sa.status.changed'));
    case 'missing':
      return t(k('release-stepper:sa.status.missing'));
    case 'extra':
      return t(k('release-stepper:sa.status.extra'));
    case 'probably':
      return t(k('release-stepper:sa.status.probably'));
    default:
      return t(k('release-stepper:sa.status.same'));
  }
}

function detailOf(set: AssetDiffSet): string {
  const { totals } = set;
  const parts: string[] = [];
  if (totals.differs > 0) parts.push(t('release-stepper:sa.row.changed', { n: totals.differs }));
  if (totals.only_repo > 0)
    parts.push(t('release-stepper:sa.row.missing', { n: totals.only_repo }));
  if (totals.only_store > 0)
    parts.push(t('release-stepper:sa.row.extra', { n: totals.only_store }));
  return formatList(parts);
}

export function compareRow(set: AssetDiffSet): CompareRow {
  const repoCount = set.rows.filter((r) => r.repo !== null).length;
  const storeCount = set.rows.filter((r) => r.store !== null).length;
  return {
    key: `${set.locale}|${set.kind}|${set.device ?? ''}|${set.target ?? ''}`,
    locale: set.locale,
    language: localeName(set.locale),
    what:
      set.kind === 'screenshot' && set.deviceLabel !== ''
        ? set.deviceLabel
        : ASSET_KIND_LABELS[set.kind],
    repoCount,
    storeCount,
    status: statusOf(set),
    detail: detailOf(set),
  };
}

/** What the step shows for an answer of the server: no repository, nothing on either side, or the table (what needs a look first). */
export function compareState(diff: AssetDiffView): CompareState {
  if (diff.repoStatus === 'no_repository') return { kind: 'no_repository' };
  // A display the store keeps in several sets (the App Store's 13" and legacy 12.9" groups) is one row per set, each named by its group,
  // so one row is never the sum of two sets nor stands for the others.
  const perDisplay: Record<string, number> = {};
  for (const set of diff.sets) {
    const display = `${set.locale}|${set.kind}|${set.device ?? ''}`;
    perDisplay[display] = (perDisplay[display] || 0) + 1;
  }
  const rows = diff.sets
    .map((set) => {
      const row = compareRow(set);
      const several = (perDisplay[`${set.locale}|${set.kind}|${set.device ?? ''}`] || 0) > 1;
      return several && set.target ? { ...row, what: `${row.what} (${set.target})` } : row;
    })
    .filter((r) => r.repoCount + r.storeCount > 0);
  if (rows.length === 0) return { kind: 'nothing' };
  rows.sort(
    (a, b) =>
      ORDER[a.status] - ORDER[b.status] ||
      a.locale.localeCompare(b.locale) ||
      a.what.localeCompare(b.what),
  );
  const needsAttention = rows.filter(
    (r) => r.status === 'changed' || r.status === 'missing',
  ).length;
  return {
    kind: 'table',
    rows: rows.slice(0, MAX_COMPARE_ROWS),
    hidden: Math.max(0, rows.length - MAX_COMPARE_ROWS),
    needsAttention,
  };
}
