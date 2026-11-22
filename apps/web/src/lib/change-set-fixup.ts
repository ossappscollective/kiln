/**
 * Fixing up a branch, and recomputing a store pull (docs/api/repositories.md, "Fix up a change
 * set", and docs/api/listing.md, "Recompute a pull"). Pure functions: FixupDialog.svelte and
 * RecomputeDialog.svelte only draw what they return. The server decides; this file keeps the
 * screens from offering what it will refuse, and puts the server's answers into words.
 */
import { can, type Role } from '@kiln/core';
import { formatList } from './i18n/format.ts';
import { t } from './i18n/t.ts';
import type { ConflictReason, FileState, Resolution } from './change-set-refresh.ts';
import type { ChangeSetView } from './types.ts';

// ---------------------------------------------------------------------------------------------
// The shapes of the answers

/** One file of a fix up: what the comparison with the repository found, and what happens on the branch. */
export type FixupFile = {
  path: string;
  state: FileState | 'recomputed' | 'removed';
  outcome: 'commit' | 'unchanged' | 'kept_branch' | 'kept_mine' | 'kept_theirs' | 'conflict';
  /** The file leaves the change set (the repository has it already, or "keep theirs"). */
  leavesSet: boolean;
  /** For a conflict: which comparison found it. */
  stage?: 'repository' | 'branch';
  reason?: ConflictReason;
  base?: string | null;
  ours?: string | null;
  theirs?: string | null;
};

export type FixupResult = {
  changeSet: ChangeSetView;
  mode: 'local_branch' | 'github_pr';
  branch: string;
  nothingToFix: boolean;
  files: FixupFile[];
  refreshedFrom: string;
  tip: string;
  willCommit: string[];
  commit?: { sha: string; parent: string; files: number; signed: boolean };
  pullRequest: { state: 'open' | 'opened' | 'none'; number?: number; url?: string };
  dryRun?: true;
  recompute?: RecomputeSummary;
};

export type FixupBody = {
  resolutions?: Record<string, Resolution>;
  branchResolutions?: Record<string, Resolution>;
  push?: boolean;
  openPr?: boolean;
  dryRun?: boolean;
  recompute?: boolean;
};

/** What the server answers when files conflict (`409 refresh_conflicts` or `409 fixup_conflicts`); nothing was written. */
export type FixupConflicts = {
  stage: 'repository' | 'branch';
  files: FixupFile[];
  conflicts: number;
};

export type FieldChange = 'store_changed' | 'unchanged' | 'added' | 'dropped';
export type FieldDiff = {
  locale: string;
  repoLocale: string;
  field: string;
  change: FieldChange;
  reason?: string;
};

/** The parts of a pull-shaped answer the screens use. */
export type RecomputeSummary = {
  diffFromPrevious: FieldDiff[];
  changes?: {
    locale: string;
    field: string;
    label: string;
    before: string | null;
    after: string;
  }[];
  skipped?: { locale: string; field?: string; reason: string; message: string }[];
  store?: { readAt: number | null; error: string | null; refreshed: boolean };
};

export type RecomputeResult = RecomputeSummary & {
  changeSet: ChangeSetView;
  changes: NonNullable<RecomputeSummary['changes']>;
  skipped: NonNullable<RecomputeSummary['skipped']>;
  problems: { locale: string; field: string; message: string }[];
  unchanged: boolean;
  nothingLeft: boolean;
  approvalCleared: boolean;
  warnings?: string[];
};

// ---------------------------------------------------------------------------------------------
// What may be offered

const FIXABLE = ['applied', 'failed'];
const RECOMPUTABLE = ['draft', 'approved', 'failed'];

/** A change set that has a branch to add a commit to. */
export function hasBranch(changeSet: Pick<ChangeSetView, 'status' | 'branch'>): boolean {
  return FIXABLE.includes(changeSet.status) && changeSet.branch !== null && changeSet.branch !== '';
}

/** Fixing up needs the right that applying needs. */
export function canFixup(role: Role, changeSet: Pick<ChangeSetView, 'status' | 'branch'>): boolean {
  return can(role, 'changesets.approve') && hasBranch(changeSet);
}

/** The change set is a pull of the live store listing, which can be made again from the store. */
export function isStorePull(changeSet: Pick<ChangeSetView, 'origin'>): boolean {
  return changeSet.origin?.source === 'store_pull';
}

/** Recomputing a store pull that has no branch yet: the rights of a pull. */
export function canRecompute(
  role: Role,
  changeSet: Pick<ChangeSetView, 'status' | 'branch' | 'origin'>,
): boolean {
  return (
    can(role, 'changesets.write') &&
    can(role, 'listing.read') &&
    isStorePull(changeSet) &&
    RECOMPUTABLE.includes(changeSet.status) &&
    !changeSet.branch
  );
}

/** Reading the store first needs the right to sync. */
export const canRefreshFromStore = (role: Role): boolean => can(role, 'apps.sync');

/** A store pull whose branch exists can take the recomputed content in a fix up. */
export function canFixupFromStore(
  role: Role,
  changeSet: Pick<ChangeSetView, 'status' | 'branch' | 'origin'>,
): boolean {
  return canFixup(role, changeSet) && isStorePull(changeSet) && can(role, 'listing.read');
}

/** A fix up of a commit in the local clone can push and open the pull request; one through GitHub cannot (it updates the PR). */
export const isLocalCommit = (changeSet: Pick<ChangeSetView, 'outcome'>): boolean =>
  changeSet.outcome !== null;

/** The fixes added so far. */
export const fixupCount = (changeSet: Pick<ChangeSetView, 'fixups'>): number =>
  changeSet.fixups?.length ?? 0;

// ---------------------------------------------------------------------------------------------
// Words

/** The promise the dialog makes before anything is written. */
export function fixupPromise(branch: string): string {
  return t('publish:fixup.promise', { branch });
}

/** The words below are looked up when read, so they follow the active language. */
export const outcomeLabel: Record<FixupFile['outcome'], string> = {
  get commit() {
    return t('publish:fixup.outcome.commit');
  },
  get unchanged() {
    return t('publish:fixup.outcome.unchanged');
  },
  get kept_branch() {
    return t('publish:fixup.outcome.keptBranch');
  },
  get kept_mine() {
    return t('publish:fixup.outcome.keptMine');
  },
  get kept_theirs() {
    return t('publish:fixup.outcome.keptTheirs');
  },
  get conflict() {
    return t('publish:fixup.outcome.conflict');
  },
};

export const outcomeTone: Record<FixupFile['outcome'], 'ok' | 'info' | 'warn' | 'neutral'> = {
  commit: 'info',
  unchanged: 'neutral',
  kept_branch: 'neutral',
  kept_mine: 'info',
  kept_theirs: 'neutral',
  conflict: 'warn',
};

/** The comparison with the repository, in a few words. */
export function fixupStateLabel(state: FixupFile['state']): string {
  switch (state) {
    case 'same':
      return t('publish:fixup.state.same');
    case 'changed':
      return t('publish:fixup.state.changed');
    case 'already_applied':
      return t('publish:fixup.state.applied');
    case 'conflict':
      return t('publish:fixup.state.conflict');
    case 'recomputed':
      return t('publish:fixup.state.recomputed');
    case 'removed':
      return t('publish:fixup.state.removed');
  }
}

export const stageLabel: Record<'repository' | 'branch', string> = {
  get repository() {
    return t('publish:fixup.stage.repository');
  },
  get branch() {
    return t('publish:fixup.stage.branch');
  },
};

export const fixupChoiceInfo: Record<
  'repository' | 'branch',
  Record<Resolution, { readonly label: string; readonly description: string }>
> = {
  repository: {
    mine: {
      get label() {
        return t('publish:fixup.choice.repoMine');
      },
      get description() {
        return t('publish:fixup.choice.repoMineDesc');
      },
    },
    theirs: {
      get label() {
        return t('publish:fixup.choice.repoTheirs');
      },
      get description() {
        return t('publish:fixup.choice.repoTheirsDesc');
      },
    },
  },
  branch: {
    mine: {
      get label() {
        return t('publish:fixup.choice.branchMine');
      },
      get description() {
        return t('publish:fixup.choice.branchMineDesc');
      },
    },
    theirs: {
      get label() {
        return t('publish:fixup.choice.branchTheirs');
      },
      get description() {
        return t('publish:fixup.choice.branchTheirsDesc');
      },
    },
  },
};

/** The conflicts of a fix up, from an ApiError body, or undefined when it is something else. */
export function fixupConflictsFrom(body: Record<string, unknown>): FixupConflicts | undefined {
  const stage: 'repository' | 'branch' | undefined =
    body.error === 'refresh_conflicts'
      ? 'repository'
      : body.error === 'fixup_conflicts'
        ? 'branch'
        : undefined;
  if (!stage || !Array.isArray(body.files)) return undefined;
  const files = (body.files as FixupFile[]).map((f) =>
    f.outcome === 'conflict' && !f.stage ? { ...f, stage } : f,
  );
  return {
    stage,
    files,
    conflicts: Number(body.conflicts ?? files.filter((f) => f.outcome === 'conflict').length),
  };
}

/** The unresolved conflicts, whichever comparison found them. */
export const fixupPending = (files: readonly FixupFile[]): FixupFile[] =>
  files.filter((f) => f.outcome === 'conflict');

type Choices = Readonly<Record<string, Resolution | undefined>>;

/** Every conflict has a choice (in the map of its own comparison). */
export function allFixupChosen(
  files: readonly FixupFile[],
  repository: Choices,
  branch: Choices,
): boolean {
  return fixupPending(files).every(
    (f) => (f.stage === 'branch' ? branch : repository)[f.path] !== undefined,
  );
}

const only = (choices: Choices): Record<string, Resolution> => {
  const out: Record<string, Resolution> = {};
  for (const [path, choice] of Object.entries(choices)) if (choice) out[path] = choice;
  return out;
};

export type FixupOptions = { push: boolean; openPr: boolean; local: boolean; recompute: boolean };

/** The request body: only the choices that were made, and push and PR only where they mean something. */
export function fixupBody(
  options: FixupOptions,
  repository: Choices,
  branch: Choices,
  dryRun: boolean,
): FixupBody {
  const resolutions = only(repository);
  const branchResolutions = only(branch);
  return {
    ...(Object.keys(resolutions).length > 0 ? { resolutions } : {}),
    ...(Object.keys(branchResolutions).length > 0 ? { branchResolutions } : {}),
    ...(options.local && (options.push || options.openPr) ? { push: true } : {}),
    ...(options.local && options.openPr ? { openPr: true } : {}),
    ...(options.recompute ? { recompute: true } : {}),
    ...(dryRun ? { dryRun: true } : {}),
  };
}

/** What a preview (dry run) found, in one sentence. */
export function fixupPreviewMessage(
  result: Pick<FixupResult, 'nothingToFix' | 'willCommit'>,
): string {
  if (result.nothingToFix) return t('publish:fixup.preview.nothing');
  const n = result.willCommit.length;
  return n === 0
    ? t('publish:fixup.preview.noFiles')
    : t('publish:fixup.preview.files', { count: n });
}

/** What to tell the person after a fix up. */
export function fixupDoneMessage(
  result: Pick<FixupResult, 'nothingToFix' | 'commit' | 'branch' | 'pullRequest'>,
): string {
  if (result.nothingToFix) return t('publish:fixup.preview.nothing');
  const opened = result.pullRequest.state === 'opened';
  if (!result.commit)
    return opened
      ? t('publish:fixup.done.upToDatePr', { branch: result.branch })
      : t('publish:fixup.done.upToDate', { branch: result.branch });
  const args = { sha: result.commit.sha.slice(0, 7), branch: result.branch };
  return opened ? t('publish:fixup.done.addedPr', args) : t('publish:fixup.done.added', args);
}

/** The push step after a fix up: said when the remote is behind. */
export function behindNote(changeSet: Pick<ChangeSetView, 'outcome'>): string | null {
  return changeSet.outcome?.push.status === 'behind'
    ? t('publish:fixup.behind')
    : null;
}

// ---------------------------------------------------------------------------------------------
// Recompute

export const fieldChangeInfo: Record<
  FieldChange,
  { readonly label: string; readonly tone: 'ok' | 'info' | 'warn' | 'neutral' }
> = {
  store_changed: {
    get label() {
      return t('publish:fixup.field.storeChanged');
    },
    tone: 'info',
  },
  unchanged: {
    get label() {
      return t('publish:fixup.field.unchanged');
    },
    tone: 'neutral',
  },
  added: {
    get label() {
      return t('publish:fixup.field.added');
    },
    tone: 'ok',
  },
  dropped: {
    get label() {
      return t('publish:fixup.field.dropped');
    },
    tone: 'warn',
  },
};

/** Why a field left the pull. */
export function droppedReason(reason: string | undefined): string {
  switch (reason) {
    case 'identical':
      return t('publish:fixup.dropped.identical');
    case 'repo_ahead':
      return t('publish:fixup.dropped.repoAhead');
    case 'missing_in_store':
      return t('publish:fixup.dropped.missingInStore');
    case 'over_limit':
      return t('publish:fixup.dropped.overLimit');
    default:
      return t('publish:fixup.dropped.other');
  }
}

/** A field's name for a list: `en-US subtitle`. */
export const fieldName = (d: Pick<FieldDiff, 'repoLocale' | 'locale' | 'field'>): string =>
  `${d.repoLocale || d.locale} ${d.field}`;

/** How many fields moved, in one sentence. */
export function diffSummary(diff: readonly FieldDiff[]): string {
  const count = (change: FieldChange) => diff.filter((d) => d.change === change).length;
  const parts: string[] = [];
  if (count('store_changed') > 0)
    parts.push(t('publish:fixup.diff.changed', { count: count('store_changed') }));
  if (count('added') > 0) parts.push(t('publish:fixup.diff.added', { count: count('added') }));
  if (count('dropped') > 0)
    parts.push(t('publish:fixup.diff.dropped', { count: count('dropped') }));
  if (parts.length === 0) return t('publish:fixup.diff.same');
  return t('publish:fixup.diff.sentence', { parts: formatList(parts, { type: 'unit' }) });
}

/** What to tell the person after a recompute. */
export function recomputeDoneMessage(
  result: Pick<
    RecomputeResult,
    'nothingLeft' | 'unchanged' | 'approvalCleared' | 'diffFromPrevious'
  >,
): string {
  if (result.nothingLeft) return t('publish:fixup.recompute.nothingLeft');
  if (result.unchanged) return t('publish:fixup.recompute.unchanged');
  const summary = diffSummary(result.diffFromPrevious);
  return result.approvalCleared
    ? t('publish:fixup.recompute.doneDraft', { summary })
    : t('publish:fixup.recompute.done', { summary });
}

/** The body of a recompute request. */
export function recomputeBody(refresh: boolean): { refresh?: boolean } {
  return refresh ? { refresh: true } : {};
}
