/**
 * The view-model of "Store assets changed in the repository" (components/release/stepper/AssetProposalCard.svelte, docs/adr/0063-release-asset-proposal.md):
 * which form the card takes, the default selection, the findings in the order they are read (errors first), and the words of a row.
 * The server decides what is proposed; nothing here changes it.
 */
import {
  ASSET_KIND_LABELS,
  type AssetProposalView,
  type CheckCode,
  defaultSelection,
  orderIssues,
  type ProposalIssue,
  type ProposalItem,
  type ProposalRef,
  selectedWithErrors,
} from '@kiln/core';
import { formatDisplayName, formatList } from './i18n/format.ts';
import { k, t } from './i18n/t.ts';
import { fieldName, issueText } from './insights/insights.ts';

export { defaultSelection, selectedWithErrors };

export type CardMode = 'hidden' | 'proposal' | 'locked' | 'later' | 'skipped' | 'all_staged';

/**
 * `hidden`: nothing to say (no repository, no repository metadata, nothing changed). `all_staged`: everything the repository changed is in the cart.
 * `skipped` and `later` follow the saved decision of this release. `locked`: the changes are listed but cannot be staged yet.
 */
export function cardMode(view: AssetProposalView | null): CardMode {
  if (view === null || view.unavailable !== null) return 'hidden';
  if (view.changes.length === 0) return view.alreadyStaged.length > 0 ? 'all_staged' : 'hidden';
  if (view.state.state === 'skipped') return 'skipped';
  if (view.state.state === 'later') return 'later';
  return view.locked.locked ? 'locked' : 'proposal';
}

export type IssueGroups = {
  errors: ProposalIssue[];
  warnings: ProposalIssue[];
  tips: ProposalIssue[];
  /** How many findings of each severity (a screen never counts the lists itself). */
  counts: { errors: number; warnings: number; tips: number; total: number };
};

export const NO_ISSUES: IssueGroups = { errors: [], warnings: [], tips: [], counts: { errors: 0, warnings: 0, tips: 0, total: 0 } };

/** The findings by severity, each in the order the server found them. Errors and warnings are shown; tips are collapsed. */
export function issueGroups(issues: readonly ProposalIssue[]): IssueGroups {
  const ordered = orderIssues(issues);
  const errors = ordered.filter((i) => i.severity === 'error');
  const warnings = ordered.filter((i) => i.severity === 'warning');
  const tips = ordered.filter((i) => i.severity === 'tip');
  return {
    errors,
    warnings,
    tips,
    counts: { errors: errors.length, warnings: warnings.length, tips: tips.length, total: errors.length + warnings.length + tips.length },
  };
}

export const localeName = (locale: string): string =>
  formatDisplayName(locale, 'language') || locale;

export function itemTitle(item: ProposalItem): string {
  if (item.kind === 'text') return fieldName(item.field);
  return item.slotKind === 'screenshot' && item.deviceLabel !== ''
    ? item.deviceLabel
    : ASSET_KIND_LABELS[item.slotKind];
}

/** The sentence of a finding: the listing checks have their own translated text; the rules of the limits and of the graphics carry theirs (English). */
export function issueSentence(
  issue: ProposalIssue,
  items: readonly ProposalItem[],
): { title: string; explain: string } {
  if (issue.source === 'listing_check')
    return issueText({ code: issue.code as CheckCode, params: issue.params, field: issue.field });
  const item = items.filter((i) => i.id === issue.itemId)[0];
  const name =
    issue.source === 'graphics_rule' && issue.field
      ? (issue.field.split('/').pop() ?? issue.field)
      : item
        ? itemTitle(item)
        : issue.code;
  return { title: name, explain: issue.message ?? issue.code };
}

/** "3 texts in 2 languages, 1 graphics set". */
export function summaryLine(summary: AssetProposalView['summary']): string {
  const parts: string[] = [];
  if (summary.texts > 0)
    parts.push(
      `${t('release-stepper:ap.sum.texts', { count: summary.texts })} ${t('release-stepper:ap.sum.locales', { count: summary.locales })}`,
    );
  if (summary.graphics > 0)
    parts.push(t('release-stepper:ap.sum.graphics', { count: summary.graphics }));
  return formatList(parts);
}

const shortSha = (ref: ProposalRef): string => ref.sha.slice(0, 7);

/** What was compared with what, in one sentence; null when the refs are not known. */
export function refsLine(view: Pick<AssetProposalView, 'baseRef' | 'targetRef'>): string | null {
  const { baseRef, targetRef } = view;
  if (targetRef === null) return null;
  if (baseRef === null) return t('release-stepper:ap.refsNoBase', { target: shortSha(targetRef) });
  return t(
    targetRef.source === 'default_branch'
      ? k('release-stepper:ap.refsBranch')
      : k('release-stepper:ap.refs'),
    { base: shortSha(baseRef), target: shortSha(targetRef) },
  );
}

/** The ids to stage when the person presses "Stage selected": only ids of the items on the card, in the order of the card. */
export function idsToStage(
  view: Pick<AssetProposalView, 'changes'>,
  selected: readonly string[],
): string[] {
  const picked: Record<string, true> = {};
  for (const id of selected) picked[id] = true;
  return view.changes.filter((c) => picked[c.id]).map((c) => c.id);
}

/** The line after a staging answer: how many were staged and how many were left as they were. */
export function resultLine(results: readonly { status: string }[]): {
  staged: number;
  left: number;
  failed: number;
} {
  let staged = 0;
  let left = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === 'staged') staged += 1;
    else if (r.status === 'failed') failed += 1;
    else left += 1;
  }
  return { staged, left, failed };
}
