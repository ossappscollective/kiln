/**
 * Refreshing a change set that is out of date (docs/api/repositories.md, "Refresh a change set"):
 * when to offer it, and the words for what the server found. Pure functions: the screens
 * (ChangeSetStale.svelte, ChangeSetRefreshDialog.svelte) only draw what they return. The server
 * decides; this file only keeps the screen from offering what the server will refuse.
 */
import { type Role, can } from '@mrm/core';
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
  return REFRESHABLE.includes(changeSet.status) && !(changeSet.status === 'failed' && changeSet.branch);
}

/** Refreshing needs the right to create change sets. */
export function canRefresh(role: Role, changeSet: Pick<ChangeSetView, 'status' | 'branch'>): boolean {
  return can(role, 'changesets.write') && isRefreshable(changeSet);
}

/** Checking reads the repository with the stored credential: the right a scan needs. */
export function canCheckForUpdates(role: Role, changeSet: Pick<ChangeSetView, 'status' | 'branch'>): boolean {
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
  return /repository changed since|changed after it was created|not what the change set was made from/i.test(changeSet.error);
}

export const fileStateInfo: Record<FileState, { label: string; tone: 'ok' | 'info' | 'warn' | 'neutral'; hint: string }> = {
  same: { label: 'Unchanged', tone: 'neutral', hint: 'The repository has not changed this file.' },
  changed: { label: 'Can be merged', tone: 'info', hint: 'The file changed elsewhere; your change fits on top of it.' },
  already_applied: { label: 'Already there', tone: 'ok', hint: 'The repository already has this change. It leaves the change set.' },
  conflict: { label: 'Conflict', tone: 'warn', hint: 'The file changed in the same place. You choose.' },
};

export const conflictReasonText: Record<ConflictReason, string> = {
  overlap: 'Both changed the same lines.',
  added_upstream: 'Your change adds this file, but the repository added it with other text.',
  edited_upstream: 'Your change deletes this file, but the repository edited it.',
  deleted_upstream: 'Your change edits this file, but the repository deleted it.',
  invalid_json: 'The merged file would not be valid JSON.',
  too_large: 'The two versions differ too much to merge line by line.',
};

export const resolutionInfo: Record<Resolution, { label: string; description: string }> = {
  mine: { label: 'Keep mine', description: 'Overwrites what the repository has with your text.' },
  theirs: { label: 'Keep theirs', description: 'Drops your change to this file.' },
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One sentence for the result of "Check for updates". */
export function stalenessSummary(result: Pick<Staleness, 'stale' | 'files'>): string {
  if (!result.stale) return 'Up to date: the repository has not changed these files.';
  const count = (state: FileState) => result.files.filter((f) => f.state === state).length;
  const parts: string[] = [];
  if (count('changed') > 0) parts.push(`${plural(count('changed'), 'file')} can be merged`);
  if (count('already_applied') > 0) parts.push(`${count('already_applied')} already in the repository`);
  if (count('conflict') > 0) parts.push(`${plural(count('conflict'), 'file')} in conflict`);
  return `Out of date: ${parts.join(', ')}.`;
}

/** The unresolved conflicts in a refresh answer. */
export const pendingConflicts = (files: readonly RefreshFile[]): RefreshFile[] =>
  files.filter((f) => f.outcome === 'conflict');

/** Every conflict has a choice. */
export function allChosen(files: readonly RefreshFile[], choices: Readonly<Record<string, Resolution | undefined>>): boolean {
  return pendingConflicts(files).every((f) => choices[f.path] !== undefined);
}

/** The choices as the request body sends them: only the paths that were chosen. */
export function toResolutions(choices: Readonly<Record<string, Resolution | undefined>>): Record<string, Resolution> {
  const out: Record<string, Resolution> = {};
  for (const [path, choice] of Object.entries(choices)) if (choice) out[path] = choice;
  return out;
}

/** What to tell the person after a refresh that went through. */
export function refreshDoneMessage(result: Pick<RefreshResult, 'files' | 'nothingLeft' | 'unchanged' | 'approvalCleared'>): string {
  if (result.nothingLeft) return 'Nothing left to apply: the repository already has this change. Discard the change set.';
  if (result.unchanged) return 'Nothing changed in the repository: the change set is as it was.';
  const count = (outcome: RefreshFile['outcome']) => result.files.filter((f) => f.outcome === outcome).length;
  const parts: string[] = [];
  if (count('merged') > 0) parts.push(`${plural(count('merged'), 'file')} merged`);
  if (count('dropped') > 0) parts.push(`${count('dropped')} already in the repository, dropped`);
  if (count('kept_mine') > 0) parts.push(`${count('kept_mine')} kept as yours`);
  if (count('kept_theirs') > 0) parts.push(`${count('kept_theirs')} dropped for the repository's text`);
  const done = parts.length > 0 ? `Refreshed: ${parts.join(', ')}.` : 'Refreshed.';
  return result.approvalCleared ? `${done} It is a draft again and needs approval.` : done;
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
