import { can, listingStoreOf, type Platform, platformMeta, type Role } from '@kiln/core';
import type { ApiError } from '../api.ts';
import { k, t } from '../i18n/t.ts';
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
} from '../types.ts';

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
export const pullKey = (field: Pick<DriftField, 'locale' | 'field'>): string =>
  `${field.locale}\u0000${field.field}`;

/** The fields of the drift view that can be pulled, in display order. */
export function pullableFields(locales: readonly DriftLocale[]): DriftField[] {
  const out: DriftField[] = [];
  for (const locale of locales) out.push(...locale.fields.filter(canPullField));
  return out;
}

export const pullableInLocale = (locale: DriftLocale): DriftField[] =>
  locale.fields.filter(canPullField);

/** The selected fields that can still be pulled (a reload may have changed a row), in display order. */
export function selectedFields(
  locales: readonly DriftLocale[],
  selected: ReadonlySet<string>,
): DriftField[] {
  return pullableFields(locales).filter((f) => selected.has(pullKey(f)));
}

/** The "select all differences" shortcut: everything pullable, or nothing when it is all selected already. */
export function toggleAllDifferences(
  locales: readonly DriftLocale[],
  selected: ReadonlySet<string>,
): Set<string> {
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
    return t('listing:pull.disabled.role');
  }
  if (input.repositoryId === null) {
    return t('listing:pull.disabled.noRepository');
  }
  if (!input.storeRead) {
    return t('listing:pull.disabled.notRead');
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
export function buildPullRequest(
  fields: readonly DriftField[],
  options: PullRequestOptions,
): PullRequestBody {
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
  return t('listing:pull.selection', {
    count: fields.length,
    locales: t('listing:pull.localesCount', { count: locales }),
  });
}

/** The suggested summary of the change set, which the person may edit. */
export function defaultPullSummary(appName: string, platform: Platform): string {
  return t('listing:pull.defaultSummary', { store: platformMeta(platform).storeName, app: appName }).slice(0, 200);
}

// ---------------------------------------------------------------------------------------------
// The target, in words

export const sourceKindLabel = (source: ListingSourceKind): string =>
  source === 'expo-store-config' ? t('listing:pull.source.expo') : t('listing:pull.source.fastlane');

/**
 * Where the listing would be written, judged from a stored scan (the real choice is made when the
 * change set is created, and the answer says it). `null`: the scan found no listing source.
 */
export function detectedPullSource(
  detection: ProjectDetection | null,
  platform: Platform,
): { source: ListingSourceKind; path: string } | null {
  if (!detection) return null;
  if (listingStoreOf(platform) === 'app_store') {
    const config = detection.expo?.storeConfigs.find((c) => !c.dynamic);
    if (config) return { source: 'expo-store-config', path: config.path };
    return detection.paths.iosMetadata
      ? { source: 'fastlane', path: detection.paths.iosMetadata }
      : null;
  }
  return detection.paths.androidMetadata
    ? { source: 'fastlane', path: detection.paths.androidMetadata }
    : null;
}

/** "acme/app, branch main, store.config.json". */
export function targetText(target: { repository: string; branch: string; path: string }): string {
  return t('listing:pull.target', { repository: target.repository, branch: target.branch, path: target.path });
}

// ---------------------------------------------------------------------------------------------
// The answer

const SKIP_LABELS: Record<PullSkipReason, string> = {
  repo_ahead: k('listing:pull.skip.repoAhead'),
  missing_in_store: k('listing:pull.skip.missingInStore'),
  identical: k('listing:pull.skip.identical'),
  over_limit: k('listing:pull.skip.overLimit'),
  locale_not_in_repo: k('listing:pull.skip.localeNotInRepo'),
  locale_ambiguous: k('listing:pull.skip.localeAmbiguous'),
  locale_invalid: k('listing:pull.skip.localeInvalid'),
  locale_unsupported: k('listing:pull.skip.localeUnsupported'),
  locale_conflict: k('listing:pull.skip.localeConflict'),
};

export const skipReasonLabel = (reason: PullSkipReason): string =>
  SKIP_LABELS[reason] ? t(SKIP_LABELS[reason]) : reason;

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
export const skipSubject = (
  skip: Pick<PullSkip, 'locale' | 'field'>,
  labelOf: (field: string) => string,
): string =>
  skip.field === undefined ? skip.locale : t('listing:pull.skipSubject', { locale: skip.locale, field: labelOf(skip.field) });

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
    details.push(t('listing:pull.leftOut', { count: skipped }));
  }
  if (result.changeSet === null) {
    return {
      tone: 'info',
      headline: result.explanation ?? t('listing:pull.nothing'),
      details,
    };
  }
  const fields = result.changes.length;
  const files = result.changeSet.filesChanged;
  const locales = new Set(result.changes.map((c) => c.repoLocale)).size;
  const headline = t('listing:pull.created', {
    count: fields,
    locales: t('listing:pull.localesCount', { count: locales }),
    files: t('listing:pull.filesCount', { count: files }),
  });
  if (result.problems.some((p) => p.severity === 'warning')) {
    details.push(t('listing:pull.limitWarnings'));
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
    ? list.filter(
        (c): c is PullCandidate =>
          typeof c === 'object' && c !== null && typeof (c as PullCandidate).id === 'string',
      )
    : [];
}

/** A sentence a person can act on for the ways a pull can fail. */
export function pullErrorMessage(
  error: Pick<ApiError, 'code' | 'status' | 'message' | 'retryAfter'>,
): string {
  switch (error.code) {
    case 'no_repository':
      return t('listing:pull.error.noRepository');
    case 'no_store_listing':
      return t('listing:pull.error.noStoreListing');
    case 'target_required':
      return t('listing:pull.error.targetRequired');
    case 'no_target_folder':
      return error.message;
    case 'rate_limited': {
      const wait = error.retryAfter;
      return wait === undefined ? t('listing:pull.error.rateLimited') : t('listing:pull.error.rateLimitedWait', { count: wait });
    }
    case 'sync_in_progress':
      return t('listing:pull.error.syncInProgress');
    case 'invalid_field':
      return error.message;
    default:
      return error.message;
  }
}
