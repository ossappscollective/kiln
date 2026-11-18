import { type Platform, type Role, can } from '@mrm/core';
import type { ApiError } from './api.ts';
import type {
  DriftField,
  DriftLocale,
  ListingSourceKind,
  ProjectDetection,
  PullCandidate,
  PullRequestBody,
  PullResult,
  PullSkip,
  PullSkipReason,
} from './types.ts';

/**
 * Pull the live store listing into the repository: which rows can be pulled, how a selection
 * becomes a request, and how the answer is put into words. Pure; the dialog and the listing tab
 * only call these.
 */

// ---------------------------------------------------------------------------------------------
// Which rows can be pulled

/** A field can be pulled when the store has a value and the store is ahead of the repository, or the two diverged. */
export function canPullField(field: Pick<DriftField, 'status' | 'live' | 'repo'>): boolean {
  return (
    (field.status === 'store-ahead' || field.status === 'diverged') &&
    field.live.value !== null &&
    field.live.value.trim() !== '' &&
    field.repo.value !== null
  );
}

/** The key a field has in a selection. */
export const pullKey = (field: Pick<DriftField, 'locale' | 'field'>): string => `${field.locale}\u0000${field.field}`;

/** The fields of the drift view that can be pulled, in display order. */
export function pullableFields(locales: readonly DriftLocale[]): DriftField[] {
  const out: DriftField[] = [];
  for (const locale of locales) out.push(...locale.fields.filter(canPullField));
  return out;
}

export const pullableInLocale = (locale: DriftLocale): DriftField[] => locale.fields.filter(canPullField);

/** The selected fields that can still be pulled (a reload may have changed a row), in display order. */
export function selectedFields(locales: readonly DriftLocale[], selected: ReadonlySet<string>): DriftField[] {
  return pullableFields(locales).filter((f) => selected.has(pullKey(f)));
}

/** The "select all differences" shortcut: everything pullable, or nothing when it is all selected already. */
export function toggleAllDifferences(locales: readonly DriftLocale[], selected: ReadonlySet<string>): Set<string> {
  const all = pullableFields(locales).map(pullKey);
  const every = all.length > 0 && all.every((key) => selected.has(key));
  return every ? new Set<string>() : new Set(all);
}

export function toggleKey(selected: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

// ---------------------------------------------------------------------------------------------
// Why the action is not available

export type PullAvailability = {
  role: Role;
  repositoryId: string | null;
  /** Something was read from the store (the drift view has a channel). */
  storeRead: boolean;
};

/** The reason the pull actions are disabled, in a sentence, or null when they are available. */
export function pullDisabledReason(input: PullAvailability): string | null {
  if (!can(input.role, 'changesets.write')) {
    return 'Your role cannot create change sets. A member, admin or owner can pull the listing into the repository.';
  }
  if (input.repositoryId === null) {
    return 'This app is not linked to a repository. Link it to a repository to pull the store listing into its files.';
  }
  if (!input.storeRead) {
    return 'Nothing has been read from the store yet. Refresh from the store first.';
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The request

export type PullRequestOptions = {
  /** The store copy the listing view shows. */
  channel: 'live' | 'editable' | null;
  refresh: boolean;
  summary?: string;
  /** A target the person chose when the server asked for one (`target_required`). */
  target?: string;
};

/** The exact fields the person selected, as the request the server takes. */
export function buildPullRequest(fields: readonly DriftField[], options: PullRequestOptions): PullRequestBody {
  const summary = options.summary?.trim();
  return {
    items: fields.map((f) => ({ locale: f.locale, field: f.field })),
    ...(options.channel === null ? {} : { channel: options.channel }),
    ...(options.refresh ? { refresh: true } : {}),
    ...(summary ? { summary } : {}),
    ...(options.target ? { target: options.target } : {}),
  };
}

/** "3 fields in 2 locales". */
export function selectionText(fields: readonly Pick<DriftField, 'locale'>[]): string {
  const locales = new Set(fields.map((f) => f.locale)).size;
  const n = fields.length;
  return `${n} ${n === 1 ? 'field' : 'fields'} in ${locales} ${locales === 1 ? 'locale' : 'locales'}`;
}

/** The suggested summary of the change set, which the person may edit. */
export function defaultPullSummary(appName: string, platform: Platform): string {
  return `Pull the ${platform === 'ios' ? 'App Store' : 'Google Play'} listing of ${appName} into the repository`.slice(0, 200);
}

// ---------------------------------------------------------------------------------------------
// The target, in words

export const sourceKindLabel = (source: ListingSourceKind): string =>
  source === 'expo-store-config' ? 'Expo store config (store.config.json)' : 'fastlane metadata files';

/**
 * Where the listing would be written, judged from a stored scan (the real choice is made when the
 * change set is created, and the answer says it). `null`: the scan found no listing source.
 */
export function detectedPullSource(
  detection: ProjectDetection | null,
  platform: Platform,
): { source: ListingSourceKind; path: string } | null {
  if (!detection) return null;
  if (platform === 'ios') {
    const config = detection.expo?.storeConfigs.find((c) => !c.dynamic);
    if (config) return { source: 'expo-store-config', path: config.path };
    return detection.paths.iosMetadata ? { source: 'fastlane', path: detection.paths.iosMetadata } : null;
  }
  return detection.paths.androidMetadata ? { source: 'fastlane', path: detection.paths.androidMetadata } : null;
}

/** "acme/app, branch main, store.config.json". */
export function targetText(target: { repository: string; branch: string; path: string }): string {
  return `${target.repository}, branch ${target.branch}, ${target.path}`;
}

// ---------------------------------------------------------------------------------------------
// The answer

const SKIP_LABELS: Record<PullSkipReason, string> = {
  repo_ahead: 'Repository is ahead of the store',
  missing_in_store: 'The store has no value',
  identical: 'Already the same',
  over_limit: 'Over the store limit',
  locale_not_in_repo: 'Locale is not in the repository',
  locale_ambiguous: 'Locale matches several folders',
  locale_invalid: 'Not a usable locale folder name',
  locale_unsupported: 'Locale not supported by the Expo store config',
  locale_conflict: 'Two locales for one folder',
};

export const skipReasonLabel = (reason: PullSkipReason): string => SKIP_LABELS[reason] ?? reason;

export type SkipGroup = { reason: PullSkipReason; label: string; items: PullSkip[] };

/** The skipped fields grouped by reason, in the order the reasons are listed above. */
export function groupSkipped(skipped: readonly PullSkip[]): SkipGroup[] {
  const order = Object.keys(SKIP_LABELS) as PullSkipReason[];
  const groups: SkipGroup[] = [];
  for (const reason of order) {
    const items = skipped.filter((s) => s.reason === reason);
    if (items.length > 0) groups.push({ reason, label: skipReasonLabel(reason), items });
  }
  return groups;
}

/** What one skipped item names: "en-US, Subtitle", or just the locale for a whole locale. */
export const skipSubject = (skip: Pick<PullSkip, 'locale' | 'field'>, labelOf: (field: string) => string): string =>
  skip.field === undefined ? skip.locale : `${skip.locale}, ${labelOf(skip.field)}`;

export type PullSummary = {
  tone: 'ok' | 'info' | 'warn';
  headline: string;
  /** Short sentences under the headline. */
  details: string[];
};

/** What happened, in words, for the toast and the summary on the listing tab. */
export function summarizePull(result: PullResult): PullSummary {
  const details: string[] = [];
  const skipped = result.skipped.length;
  if (skipped > 0) {
    details.push(`${skipped} ${skipped === 1 ? 'field was' : 'fields were'} left out. See why below.`);
  }
  if (result.changeSet === null) {
    return {
      tone: 'info',
      headline: result.explanation ?? 'Nothing to pull.',
      details,
    };
  }
  const fields = result.changes.length;
  const files = result.changeSet.filesChanged;
  const locales = new Set(result.changes.map((c) => c.repoLocale)).size;
  const headline = `Created a draft change set: ${fields} ${fields === 1 ? 'field' : 'fields'} in ${locales} ${locales === 1 ? 'locale' : 'locales'}, ${files} ${files === 1 ? 'file' : 'files'}.`;
  if (result.problems.some((p) => p.severity === 'warning')) {
    details.push('Some pulled values have limit warnings. Review them in the change set.');
  }
  for (const warning of result.warnings) details.push(warning);
  return { tone: skipped > 0 || result.warnings.length > 0 ? 'warn' : 'ok', headline, details };
}

// ---------------------------------------------------------------------------------------------
// Errors

/** The listing targets an answer of `target_required` offers, or an empty list. */
export function candidatesOf(error: Pick<ApiError, 'code' | 'body'>): PullCandidate[] {
  if (error.code !== 'target_required') return [];
  const list = error.body.candidates;
  return Array.isArray(list)
    ? (list.filter((c): c is PullCandidate => typeof c === 'object' && c !== null && typeof (c as PullCandidate).id === 'string'))
    : [];
}

/** A sentence a person can act on for the ways a pull can fail. */
export function pullErrorMessage(error: Pick<ApiError, 'code' | 'status' | 'message' | 'retryAfter'>): string {
  switch (error.code) {
    case 'no_repository':
      return 'This app is not linked to a repository, or the repository was disconnected.';
    case 'no_store_listing':
      return 'No store listing has been read for this app yet. Refresh from the store, then try again.';
    case 'target_required':
      return 'This repository has more than one place this listing could be. Choose where to pull it into.';
    case 'no_target_folder':
      return error.message;
    case 'rate_limited': {
      const wait = error.retryAfter;
      return wait === undefined
        ? 'Reads are limited to 10 a minute for the workspace. Try again in a minute.'
        : `Reads are limited to 10 a minute for the workspace. Try again in ${wait} ${wait === 1 ? 'second' : 'seconds'}.`;
    }
    case 'sync_in_progress':
      return 'A sync of this app is already running. Wait for it to finish, then try again.';
    case 'invalid_field':
      return error.message;
    default:
      return error.message;
  }
}
