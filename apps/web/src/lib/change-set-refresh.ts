/**
 * Refreshing a change set that is out of date (docs/api/repositories.md, "Refresh a change set"):
 * when to offer it, and the words for what the server found. Pure functions: the screens
 * (ChangeSetStale.svelte, ChangeSetRefreshDialog.svelte) only draw what they return. The server
 * decides; this file only keeps the screen from offering what the server will refuse.
 */
import { can, type Role } from '@kiln/core';
import { formatList } from './i18n/format.ts';
import { t } from './i18n/t.ts';
import type { ChangeSetView } from './types.ts';

export type FileState = 'same' | 'changed' | 'already_applied' | 'conflict';
export type Resolution = 'mine' | 'theirs';
export type ConflictReason =
  | 'overlap'
  | 'added_upstream'
  | 'edited_upstream'
  | 'deleted_upstream'
  | 'invalid_json'
  | 'too_large';

export type StalenessFile = { path: string; state: FileState };
export type Staleness = { stale: boolean; files: StalenessFile[]; readAt: string };

export type RefreshFile = {
  path: string;
  state: FileState;
  outcome: 'unchanged' | 'merged' | 'dropped' | 'kept_mine' | 'kept_theirs' | 'conflict';
  reason?: ConflictReason;
  /** For an unresolved conflict only; null where the file does not exist. */
  base?: string | null;
  ours?: string | null;
  theirs?: string | null;
};

export type RefreshResult = {
  changeSet: ChangeSetView;
  files: RefreshFile[];
  refreshedFrom: string;
  unchanged: boolean;
  nothingLeft: boolean;
  approvalCleared: boolean;
};

/** What the server answers when files conflict (`409 refresh_conflicts`); nothing was changed. */
export type RefreshConflicts = { files: RefreshFile[]; conflicts: number; refreshedFrom: string };

const REFRESHABLE = ['draft', 'approved', 'failed'];

/** A change set in a state that can be re-based. A failed one that already made a branch cannot. */
export function isRefreshable(changeSet: Pick<ChangeSetView, 'status' | 'branch'>): boolean {
  return (
    REFRESHABLE.includes(changeSet.status) && !(changeSet.status === 'failed' && changeSet.branch)
  );
}

/** Refreshing needs the right to create change sets. */
export function canRefresh(
  role: Role,
  changeSet: Pick<ChangeSetView, 'status' | 'branch'>,
): boolean {
  return can(role, 'changesets.write') && isRefreshable(changeSet);
}

/** Checking reads the repository with the stored credential: the right a scan needs. */
export function canCheckForUpdates(
  role: Role,
  changeSet: Pick<ChangeSetView, 'status' | 'branch'>,
): boolean {
  return can(role, 'repositories.scan') && isRefreshable(changeSet);
}

/** The error codes of an apply that failed because the repository moved on. */
export const STALE_APPLY_CODES: readonly string[] = ['change_conflict', 'base_changed'];

/**
 * The change set looks out of date without asking the server again: an apply of this page just
 * failed with a conflict (`applyCode`), or the stored error of its last apply says the files
 * changed (GitHub: "The repository changed since this change set was made"; a local clone: "they
 * changed after it was created").
 */
export function looksStale(
  changeSet: Pick<ChangeSetView, 'status' | 'error' | 'branch'>,
  applyCode?: string | null,
): boolean {
  if (!isRefreshable(changeSet)) return false;
  if (applyCode && STALE_APPLY_CODES.includes(applyCode)) return true;
  if (changeSet.status === 'draft' || !changeSet.error) return false;
  return /repository changed since|changed after it was created|not what the change set was made from/i.test(
    changeSet.error,
  );
}

export const fileStateInfo: Record<
  FileState,
  {
    readonly label: string;
    readonly tone: 'ok' | 'info' | 'warn' | 'neutral';
    readonly hint: string;
  }
> = {
  same: {
    get label() {
      return t('publish:refresh.state.same');
    },
    tone: 'neutral',
    get hint() {
      return t('publish:refresh.state.sameHint');
    },
  },
  changed: {
    get label() {
      return t('publish:refresh.state.changed');
    },
    tone: 'info',
    get hint() {
      return t('publish:refresh.state.changedHint');
    },
  },
  already_applied: {
    get label() {
      return t('publish:refresh.state.applied');
    },
    tone: 'ok',
    get hint() {
      return t('publish:refresh.state.appliedHint');
    },
  },
  conflict: {
    get label() {
      return t('publish:refresh.state.conflict');
    },
    tone: 'warn',
    get hint() {
      return t('publish:refresh.state.conflictHint');
    },
  },
};

/** The words are looked up when read, so they follow the active language. */
export const conflictReasonText: Record<ConflictReason, string> = {
  get overlap() {
    return t('publish:refresh.reason.overlap');
  },
  get added_upstream() {
    return t('publish:refresh.reason.addedUpstream');
  },
  get edited_upstream() {
    return t('publish:refresh.reason.editedUpstream');
  },
  get deleted_upstream() {
    return t('publish:refresh.reason.deletedUpstream');
  },
  get invalid_json() {
    return t('publish:refresh.reason.invalidJson');
  },
  get too_large() {
    return t('publish:refresh.reason.tooLarge');
  },
};

export const resolutionInfo: Record<
  Resolution,
  { readonly label: string; readonly description: string }
> = {
  mine: {
    get label() {
      return t('publish:refresh.resolution.mine');
    },
    get description() {
      return t('publish:refresh.resolution.mineDesc');
    },
  },
  theirs: {
    get label() {
      return t('publish:refresh.resolution.theirs');
    },
    get description() {
      return t('publish:refresh.resolution.theirsDesc');
    },
  },
};

/** One sentence for the result of "Check for updates". */
export function stalenessSummary(result: Pick<Staleness, 'stale' | 'files'>): string {
  if (!result.stale) return t('publish:refresh.summary.upToDate');
  const count = (state: FileState) => result.files.filter((f) => f.state === state).length;
  const parts: string[] = [];
  if (count('changed') > 0)
    parts.push(t('publish:refresh.summary.mergeable', { count: count('changed') }));
  if (count('already_applied') > 0)
    parts.push(t('publish:refresh.summary.alreadyIn', { count: count('already_applied') }));
  if (count('conflict') > 0)
    parts.push(t('publish:refresh.summary.conflict', { count: count('conflict') }));
  return t('publish:refresh.summary.outOfDate', { parts: formatList(parts, { type: 'unit' }) });
}

/** The unresolved conflicts in a refresh answer. */
export const pendingConflicts = (files: readonly RefreshFile[]): RefreshFile[] =>
  files.filter((f) => f.outcome === 'conflict');

/** Every conflict has a choice. */
export function allChosen(
  files: readonly RefreshFile[],
  choices: Readonly<Record<string, Resolution | undefined>>,
): boolean {
  return pendingConflicts(files).every((f) => choices[f.path] !== undefined);
}

/** The choices as the request body sends them: only the paths that were chosen. */
export function toResolutions(
  choices: Readonly<Record<string, Resolution | undefined>>,
): Record<string, Resolution> {
  const out: Record<string, Resolution> = {};
  for (const [path, choice] of Object.entries(choices)) if (choice) out[path] = choice;
  return out;
}

/** What to tell the person after a refresh that went through. */
export function refreshDoneMessage(
  result: Pick<RefreshResult, 'files' | 'nothingLeft' | 'unchanged' | 'approvalCleared'>,
): string {
  if (result.nothingLeft) return t('publish:refresh.done.nothingLeft');
  if (result.unchanged) return t('publish:refresh.done.unchanged');
  const count = (outcome: RefreshFile['outcome']) =>
    result.files.filter((f) => f.outcome === outcome).length;
  const parts: string[] = [];
  if (count('merged') > 0) parts.push(t('publish:refresh.done.merged', { count: count('merged') }));
  if (count('dropped') > 0)
    parts.push(t('publish:refresh.done.dropped', { count: count('dropped') }));
  if (count('kept_mine') > 0)
    parts.push(t('publish:refresh.done.keptMine', { count: count('kept_mine') }));
  if (count('kept_theirs') > 0)
    parts.push(t('publish:refresh.done.keptTheirs', { count: count('kept_theirs') }));
  const done =
    parts.length > 0
      ? t('publish:refresh.done.refreshedParts', { parts: formatList(parts, { type: 'unit' }) })
      : t('publish:refresh.done.refreshed');
  return result.approvalCleared ? t('publish:refresh.done.draftAgain', { message: done }) : done;
}

/** The conflict answer of a refresh, from an ApiError body, or undefined when it is something else. */
export function conflictsFrom(body: Record<string, unknown>): RefreshConflicts | undefined {
  if (body.error !== 'refresh_conflicts' || !Array.isArray(body.files)) return undefined;
  return {
    files: body.files as RefreshFile[],
    conflicts: Number(body.conflicts ?? 0),
    refreshedFrom: String(body.refreshedFrom ?? ''),
  };
}
