import {
  type AssetKind,
  type AssetProblem,
  assetSlotSupport,
  can,
  type Platform,
  PUSHABLE_IMAGE_FORMATS,
  platformMeta,
  type Role,
  STAGEABLE_TEXT_FIELDS,
  type STAGED_LIMITS,
  type StagedAssetView,
  type StagedChangesView,
  type StagedProblem,
  type StagedTextView,
  slotKey,
  slotMaxFiles,
  supports,
} from '@kiln/core';
import { ApiError, waitPhrase } from './api.ts';
import { formatList, formatNumber } from './i18n/format.ts';
import { k, t } from './i18n/t.ts';
import type { AssetItem, DriftField } from './types.ts';

/**
 * Staged changes and pushing them to a store as a DRAFT (docs/api/staged-changes.md,
 * docs/adr/0009-staged-store-drafts.md): the types of the API that the web app owns, and the pure logic of
 * the tray, the stage buttons and the push dialog. Pushing writes to the store's editable draft only;
 * it never submits, sends for review or publishes, and nothing here does either.
 *
 * The server decides every rule; the checks here explain things before a request.
 * Written for the ES2017 web build: no flatMap, no fromEntries.
 */

export const DRAFT_ENV = 'KILN_STORE_DRAFT_WRITE_ENABLED';

/** The sentence the dialog and the tray keep saying: a push is not a submit. */
export const notSubmittedNote = (): string => t('publish:staged.notSubmitted');

/** The note under the tray: where the next step is, and what this tool never does. */
export const submitNextStepNote = (): string => t('publish:staged.submitNextStep');

export const reverseImageSyncNote = (): string => t('publish:staged.reverseImageSyncNote');

// ---------------------------------------------------------------------------------------------
// API shapes (the staged view itself comes from @kiln/core)

export type StoreDraftConfig = {
  enabled: boolean;
  envName: string;
  submit: { implemented: false; note: string };
  limits: typeof STAGED_LIMITS;
};

export type DraftStep = {
  type: 'text' | 'asset' | 'locale';
  locale: string;
  target: string;
  outcome: 'applied' | 'already_same';
  uploaded?: number;
  removed?: number;
};

export type PreviewText = {
  id: string;
  locale: string;
  field: string;
  before: string | null;
  after: string;
  localeExists: boolean;
  status: 'changed' | 'unchanged' | 'new_locale';
};

export type PreviewAssetSet = {
  id: string;
  locale: string;
  slot: { kind: AssetKind; device: string | null };
  slotKey: string;
  target: string;
  before: {
    setExists: boolean;
    files: { id: string; name: string | null; checksum: string | null; state: string | null }[];
  };
  after: {
    files: {
      path: string;
      name: string;
      oid: string;
      bytes: number;
      width: number | null;
      height: number | null;
      format: string | null;
    }[];
  };
  status: 'changed' | 'unchanged';
  willUpload: number;
  willRemove: number;
};

export type PreviewReleaseField = {
  id: string;
  field: string;
  label: string;
  locale: string;
  before: string | null;
  after: string;
  status: 'changed' | 'unchanged' | 'local';
  localOnly: boolean;
};

export type PushCheck = {
  code: string;
  severity: 'blocking' | 'warning';
  message: string;
  item?: string;
};

export type DraftPreview = {
  app: { id: string; name: string; platform: Platform; store: string };
  version: { id: string; versionString: string | null; state: string } | null;
  text: PreviewText[];
  assets: PreviewAssetSet[];
  /** Staged release fields: a build, a version, a track, ... Present from the server. */
  release?: PreviewReleaseField[];
  /** What the store says about the staged release fields. Present from the server. */
  checks?: { blocking: PushCheck[]; warnings: PushCheck[]; canPush: boolean };
  summary: {
    /** Release fields that differ from the store (local-only ones are not counted). Present from the server. */
    fieldsChanged?: number;
    fieldsUnchanged?: number;
    textChanged: number;
    textUnchanged: number;
    assetSetsChanged: number;
    assetSetsUnchanged: number;
    filesToUpload: number;
    filesToRemove: number;
    nothingToDo: boolean;
  };
  submits: false;
  confirmHash: string;
  warnings: string[];
  readAt: number;
};

export type DraftPushResult = {
  app: { id: string; name: string; platform: Platform; store: string };
  version: { id: string; versionString: string | null; state: string } | null;
  steps: DraftStep[];
  counts: { applied: number; alreadySame: number; filesUploaded: number; filesRemoved: number };
  commit: 'not_sent_for_review' | 'draft_release' | 'none';
  draft: true;
  submitted: false;
  confirmedByReread: boolean;
  pushedAt: number;
  note: string;
};

// ---------------------------------------------------------------------------------------------
// Who may do what

/** Staging, unstaging and clearing: member and up. */
export const canStage = (role: Role): boolean => can(role, 'changesets.write');

/** Preview and push: admin and up (`store.push_draft`). */
export const canPush = (role: Role): boolean => can(role, 'store.push_draft');

export const stageRoleReason = (): string => t('publish:staged.stageRoleReason');
export const pushRoleReason = (): string => t('publish:staged.pushRoleReason');

export type PushAvailability =
  | { state: 'ready' }
  | { state: 'loading' }
  | { state: 'role'; message: string }
  | { state: 'unknown'; message: string }
  | { state: 'off'; message: string };

/** Whether the push button can work at all: the role, then the server's switch. */
export function pushAvailability(
  role: Role,
  config: StoreDraftConfig | null,
  loadFailed: boolean,
): PushAvailability {
  if (!canPush(role)) return { state: 'role', message: pushRoleReason() };
  if (loadFailed) {
    return {
      state: 'unknown',
      message: t('publish:staged.availability.unknown'),
    };
  }
  if (!config) return { state: 'loading' };
  if (!config.enabled) {
    return {
      state: 'off',
      message: t('publish:staged.availability.off', { env: config.envName || DRAFT_ENV }),
    };
  }
  return { state: 'ready' };
}

export const storeName = (platform: Platform): string =>
  platformMeta(platform).storeNameWithArticle;

// ---------------------------------------------------------------------------------------------
// The tray

export const releaseCount = (view: StagedChangesView | null): number =>
  view === null ? 0 : (view.release ?? []).length;

export const itemCount = (view: StagedChangesView | null): number =>
  view === null ? 0 : view.text.length + view.assets.length + releaseCount(view);

/** "3 texts, 2 graphic sets (7 files)", or "Nothing staged". */
export function trayCountText(view: StagedChangesView | null): string {
  if (view === null || itemCount(view) === 0) return t('publish:staged.nothingStaged');
  const parts: string[] = [];
  if (view.text.length > 0)
    parts.push(t('publish:staged.count.texts', { count: view.text.length }));
  if (releaseCount(view) > 0)
    parts.push(t('publish:staged.count.releaseFields', { count: releaseCount(view) }));
  if (view.assets.length > 0) {
    const files = view.assets.reduce((n, s) => n + s.files.length, 0);
    parts.push(
      t('publish:staged.count.graphicSets', {
        count: view.assets.length,
        files: t('publish:staged.count.files', { count: files }),
      }),
    );
  }
  return formatList(parts, { type: 'unit' });
}

/** Why a push cannot start for this staged view, or null. */
export function pushBlockedReason(view: StagedChangesView | null): string | null {
  if (view === null) return t('publish:staged.blocked.notLoaded');
  if (itemCount(view) === 0) return t('publish:staged.blocked.nothingStaged');
  if (!view.valid) return t('publish:staged.blocked.invalid');
  return null;
}

export const problemsOf = (
  item: { problems: StagedProblem[] },
  severity: 'error' | 'warning',
): StagedProblem[] => item.problems.filter((p) => p.severity === severity);

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  repo: k('publish:staged.source.repo'),
  local: k('publish:staged.source.local'),
  store: k('publish:staged.source.store'),
};

export const sourceLabel = (source: string): string =>
  SOURCE_LABELS[source] ? t(SOURCE_LABELS[source]) : source;

export type StagedTone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info';

export function textStatus(item: Pick<StagedTextView, 'status'>): {
  label: string;
  tone: StagedTone;
} {
  if (item.status === 'invalid') return { label: t('publish:staged.status.error'), tone: 'bad' };
  if (item.status === 'unchanged')
    return { label: t('publish:staged.status.same'), tone: 'neutral' };
  return { label: t('publish:staged.status.differs'), tone: 'info' };
}

/** "Pushed to the draft" only while the staged value is still the one that was pushed. */
export const pushedLabel = (item: { pushed: boolean }): string | null =>
  item.pushed ? t('publish:staged.inStoreDraft') : null;

/** A label for a graphic set: "en-US: Screenshots, iphone_6_5" from the server's label, plus the locale. */
export const setTitle = (set: Pick<StagedAssetView, 'locale' | 'label'>): string =>
  t('publish:staged.setTitle', { locale: set.locale, label: set.label });

// ---------------------------------------------------------------------------------------------
// Staging a text

const LOCALE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/;

/** The locale codes the server can stage (a store locale such as en-US); the project folder and `default` are not. */
export const isStageableLocale = (locale: string): boolean =>
  locale.length <= 35 && LOCALE.test(locale);

export const isStageableTextField = (platform: Platform, field: string): boolean =>
  STAGEABLE_TEXT_FIELDS[platform].indexOf(field) !== -1;

/** Line breaks and trailing white space, as the server normalizes a value. */
export const normalizeText = (value: string): string =>
  value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\s+$/, '');

export function findStagedText(
  view: StagedChangesView | null,
  locale: string,
  field: string,
): StagedTextView | null {
  if (view === null) return null;
  for (const item of view.text) if (item.locale === locale && item.field === field) return item;
  return null;
}

export type FieldStage = {
  /** `hidden`: nothing to stage (identical, nothing staged). `not_pushable`: a draft push cannot write the field. */
  state: 'hidden' | 'not_pushable' | 'available' | 'disabled';
  reason: string | null;
  staged: StagedTextView | null;
  /** The staged text is the repository's text as it is now. */
  upToDate: boolean;
};

const NOT_PUSHABLE: Record<Platform, string> = {
  ios: k('publish:staged.notPushable.apple'),
  macos: k('publish:staged.notPushable.apple'),
  android: k('publish:staged.notPushable.generic'),
};

/** What the "Stage from repo" control of one listing field does. */
export function fieldStage(input: {
  role: Role;
  platform: Platform;
  field: Pick<DriftField, 'locale' | 'field' | 'status' | 'repo'>;
  view: StagedChangesView | null;
}): FieldStage {
  const { field, view } = input;
  const staged = findStagedText(view, field.locale, field.field);
  const repoValue = field.repo.value;
  const upToDate =
    staged !== null &&
    repoValue !== null &&
    normalizeText(staged.value) === normalizeText(repoValue);
  const base = { staged, upToDate };
  if (!isStageableTextField(input.platform, field.field))
    return { state: 'not_pushable', reason: t(NOT_PUSHABLE[input.platform]), ...base };
  if (field.status === 'identical' && staged === null)
    return { state: 'hidden', reason: null, ...base };
  if (!canStage(input.role)) return { state: 'disabled', reason: stageRoleReason(), ...base };
  if (!isStageableLocale(field.locale))
    return {
      state: 'disabled',
      reason: t('publish:staged.field.notStoreLocale'),
      ...base,
    };
  if (repoValue === null || repoValue.trim() === '')
    return { state: 'disabled', reason: t('publish:staged.field.noRepoValue'), ...base };
  if (field.status === 'identical') return { state: 'hidden', reason: null, ...base };
  return { state: 'available', reason: null, ...base };
}

/** The staged text of a cell's field, for the marker in the grid. */
export const cellStagedText = (
  view: StagedChangesView | null,
  field: Pick<DriftField, 'locale' | 'field'> | null,
): StagedTextView | null =>
  field === null ? null : findStagedText(view, field.locale, field.field);

// ---------------------------------------------------------------------------------------------
// Staging a set of graphics

export const stagedSetId = (locale: string, kind: AssetKind, device: string | null): string =>
  `${locale}/${slotKey({ kind, device })}`;

export function findStagedSet(view: StagedChangesView | null, id: string): StagedAssetView | null {
  if (view === null) return null;
  for (const s of view.assets) if (s.id === id) return s;
  return null;
}

export type SetStaging = {
  canStage: boolean;
  /** Why not, in a sentence. */
  reason: string | null;
  /** The files to stage, in the set's order: `paths` of the request. */
  paths: string[];
  id: string;
  staged: StagedAssetView | null;
  /** `current`: the staged files are the repository's files now. `outdated`: the repository's files changed since. */
  stagedState: 'none' | 'current' | 'outdated';
};

const MiB = 1024 * 1024;

/**
 * Whether one set of the Assets tab (a locale, a kind, a device) can be staged, and as which files.
 * `assets` are the files of the set in order; `problems` the spec problems of the index by path and of the set.
 * A set with a spec error is not staged (docs/ux-ia.md: invalid items cannot be staged).
 */
export function setStaging(input: {
  role: Role;
  platform: Platform;
  locale: string;
  kind: AssetKind;
  device: string | null;
  assets: readonly AssetItem[];
  setProblems: readonly AssetProblem[];
  problemsByPath: Readonly<Record<string, AssetProblem[]>>;
  commit: string | null;
  maxFileBytes?: number;
  view: StagedChangesView | null;
}): SetStaging {
  const id = stagedSetId(input.locale, input.kind, input.device);
  const staged = findStagedSet(input.view, id);
  const paths = input.assets.map((a) => a.path);
  let stagedState: SetStaging['stagedState'] = 'none';
  if (staged !== null) {
    const same =
      staged.files.length === input.assets.length &&
      staged.files.every((f, i) => f.oid === (input.assets[i] as AssetItem).oid);
    stagedState = same ? 'current' : 'outdated';
  }
  const no = (reason: string): SetStaging => ({
    canStage: false,
    reason,
    paths,
    id,
    staged,
    stagedState,
  });
  const maxFile = input.maxFileBytes ?? 8 * MiB;

  if (!canStage(input.role)) return no(stageRoleReason());
  if (input.assets.length === 0) return no(t('publish:staged.set.noFiles'));
  if (input.commit === null) return no(t('publish:staged.set.noCommit'));
  if (!isStageableLocale(input.locale)) return no(t('publish:staged.set.noLocale'));
  const support = assetSlotSupport(input.platform, { kind: input.kind, device: input.device });
  if (!support.ok) return no(support.reason);
  const max = slotMaxFiles(input.platform, { kind: input.kind, device: input.device });
  if (input.assets.length > max)
    return no(t('publish:staged.set.tooMany', { count: max, have: input.assets.length }));
  for (const a of input.assets) {
    const name = a.path.slice(a.path.lastIndexOf('/') + 1);
    if (a.origin !== 'store') return no(t('publish:staged.set.iconNotStore', { name }));
    if (a.read !== 'read' || a.oid === null) return no(t('publish:staged.set.notRead', { name }));
    if (a.format === null || PUSHABLE_IMAGE_FORMATS.indexOf(a.format) === -1)
      return no(t('publish:staged.set.notImage', { name }));
    if (a.bytes === null || a.bytes > maxFile)
      return no(
        t('publish:staged.set.tooLarge', { name, mb: formatNumber(Math.round(maxFile / MiB)) }),
      );
  }
  const errors: AssetProblem[] = [];
  for (const p of input.setProblems) if (p.severity === 'error') errors.push(p);
  for (const a of input.assets)
    for (const p of input.problemsByPath[a.path] ?? []) if (p.severity === 'error') errors.push(p);
  if (errors.length > 0)
    return no(t('publish:staged.set.fixSpec', { message: (errors[0] as AssetProblem).message }));
  return { canStage: true, reason: null, paths, id, staged, stagedState };
}

/** The request of "Stage for store" for one set. */
export function stageAssetsBody(
  locale: string,
  kind: AssetKind,
  device: string | null,
  paths: string[],
  commit: string | null,
) {
  return {
    locale,
    kind,
    ...(device !== null ? { device } : {}),
    from: 'repo' as const,
    paths,
    ...(commit !== null ? { commit } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Errors of staging

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const bodyMessage = (error: ApiError): string =>
  typeof error.body.message === 'string' && error.body.message !== ''
    ? error.body.message
    : error.message;

/** A sentence for an error of staging, unstaging or clearing (the server's messages are written to be shown). */
/** Plain words for a 429 on a read of the repository or the store: what happened, how long to wait. Never the server's wording. */
export function rateLimitedMessage(retryAfter: number | undefined): string {
  return t('publish:staged.error.rateLimited', {
    wait: waitPhrase(retryAfter && retryAfter > 0 ? retryAfter : 60),
  });
}

export function stagingError(error: unknown): string {
  if (!(error instanceof ApiError)) return t('publish:staged.error.generic');
  switch (error.code) {
    case 'forbidden':
      return stageRoleReason();
    case 'not_found':
      return t('publish:staged.error.notFound');
    case 'field_not_pushable': {
      const allowed = Array.isArray(error.body.allowed)
        ? (error.body.allowed as unknown[]).filter((a): a is string => typeof a === 'string')
        : [];
      return allowed.length > 0
        ? t('publish:staged.error.fieldNotPushable', {
            message: bodyMessage(error),
            fields: formatList(allowed, { type: 'unit' }),
          })
        : bodyMessage(error);
    }
    case 'no_source_value':
      return t('publish:staged.error.noSourceValue', { message: bodyMessage(error) });
    case 'source_not_supported':
      return reverseImageSyncNote();
    case 'rate_limited':
      return rateLimitedMessage(error.retryAfter);
    case 'field_not_stageable':
    case 'empty_value':
    case 'invalid_locale':
    case 'empty_text':
    case 'text_too_long':
    case 'too_many_items':
    case 'invalid_staged':
    case 'slot_not_pushable':
    case 'asset_not_pushable':
    case 'no_assets':
    case 'not_in_index':
    case 'no_repository':
    case 'no_commit':
    case 'too_many_files':
    case 'too_many_bytes':
      return bodyMessage(error);
    default:
      return error.status === 0 || error.status >= 500 ? error.message : bodyMessage(error);
  }
}

// ---------------------------------------------------------------------------------------------
// Errors of the preview and the push

export type PushFailure =
  | { kind: 'state_changed'; message: string; next: DraftPreview | null }
  | { kind: 'write_in_progress'; message: string }
  /** Not known whether anything was written. The caller must NOT send the push again. */
  | { kind: 'outcome_unknown'; message: string }
  | {
      kind: 'partial';
      message: string;
      completed: DraftStep[];
      failed: { type: string; locale: string; target: string } | null;
      matching: number | null;
      total: number | null;
    }
  | { kind: 'not_applied'; message: string }
  | { kind: 'disabled'; message: string }
  /** A staged file changed or vanished: stage the set again. */
  | { kind: 'restage'; message: string }
  | { kind: 'invalid'; message: string; problems: StagedProblem[] }
  /** The store says a staged release field cannot be written as it is. Nothing was written. */
  | { kind: 'blocked'; message: string; checks: PushCheck[] }
  | { kind: 'rate_limited'; message: string; retryAfter: number | null }
  | { kind: 'forbidden'; message: string }
  | { kind: 'other'; message: string; code: string };

function isPreview(value: unknown): value is DraftPreview {
  return (
    isObject(value) &&
    typeof value.confirmHash === 'string' &&
    Array.isArray(value.text) &&
    Array.isArray(value.assets) &&
    isObject(value.summary)
  );
}

/**
 * Sorts an error of the preview or the push. `state_changed` carries a new preview that must be confirmed
 * again. `outcome_unknown` (and a cut connection during the push) is final for that attempt: never sent again
 * by this app. Nothing here retries; a rate limit is only reported.
 */
export function classifyPushFailure(
  error: unknown,
  phase: 'preview' | 'push' = 'push',
): PushFailure {
  if (!(error instanceof ApiError))
    return {
      kind: 'other',
      code: 'error',
      message: t('publish:staged.fail.request'),
    };
  const message = bodyMessage(error);
  const body = error.body;
  switch (error.code) {
    case 'store_draft_disabled':
      return {
        kind: 'disabled',
        message: t('publish:staged.fail.disabled', { env: DRAFT_ENV }),
      };
    case 'forbidden':
      return { kind: 'forbidden', message: pushRoleReason() };
    case 'state_changed':
      return {
        kind: 'state_changed',
        next: isPreview(body.preview) ? body.preview : null,
        message: t('publish:staged.fail.stateChanged'),
      };
    case 'write_in_progress':
      return {
        kind: 'write_in_progress',
        message: t('publish:staged.fail.writeInProgress', { message }),
      };
    case 'outcome_unknown':
      return {
        kind: 'outcome_unknown',
        message: t('publish:staged.fail.outcomeUnknown', { message }),
      };
    case 'draft_partial': {
      const completed = Array.isArray(body.completed) ? (body.completed as DraftStep[]) : [];
      const failed = isObject(body.failed)
        ? (body.failed as { type: string; locale: string; target: string })
        : null;
      const items = isObject(body.items) ? body.items : null;
      let matching: number | null = null;
      let total: number | null = null;
      if (items) {
        const all = [
          ...(Array.isArray(items.text) ? items.text : []),
          ...(Array.isArray(items.assets) ? items.assets : []),
        ] as { matches?: boolean }[];
        total = all.length;
        matching = all.filter((i) => i.matches === true).length;
      }
      return { kind: 'partial', message, completed, failed, matching, total };
    }
    case 'write_failed':
      return body.outcome === 'not_applied'
        ? { kind: 'not_applied', message }
        : {
            kind: 'outcome_unknown',
            message: t('publish:staged.fail.outcomeUnknown', { message }),
          };
    case 'draft_not_allowed':
      return {
        kind: 'other',
        code: error.code,
        message: t('publish:staged.fail.draftNotAllowed', { message }),
      };
    case 'changes_in_review':
      return {
        kind: 'other',
        code: error.code,
        message: t('publish:staged.fail.changesInReview'),
      };
    case 'no_editable_version':
      return {
        kind: 'other',
        code: error.code,
        message: t('publish:staged.fail.noEditableVersion', { message }),
      };
    case 'blocked':
      return {
        kind: 'blocked',
        checks: Array.isArray(body.checks) ? (body.checks as PushCheck[]) : [],
        message: t('publish:staged.fail.blocked'),
      };
    case 'nothing_staged':
      return { kind: 'invalid', message: t('publish:staged.fail.nothingStaged'), problems: [] };
    case 'staged_invalid':
      return {
        kind: 'invalid',
        message,
        problems: Array.isArray(body.problems) ? (body.problems as StagedProblem[]) : [],
      };
    case 'asset_changed':
    case 'asset_unreadable':
      return {
        kind: 'restage',
        message:
          error.code === 'asset_unreadable'
            ? t('publish:staged.fail.restageUnreadable', { message })
            : message,
      };
    case 'rate_limited':
      return {
        kind: 'rate_limited',
        retryAfter: error.retryAfter ?? null,
        message: error.retryAfter
          ? t('publish:staged.fail.rateLimitedSeconds', { count: error.retryAfter })
          : t('publish:staged.fail.rateLimitedMinute'),
      };
    case 'store_auth':
    case 'store_forbidden':
    case 'store_not_found':
    case 'store_rejected':
      return {
        kind: 'other',
        code: error.code,
        message: t('publish:staged.fail.storeRefused', { message }),
      };
    case 'store_unavailable':
      return {
        kind: 'other',
        code: error.code,
        message: t('publish:staged.fail.storeUnavailable', { message }),
      };
    case 'timeout':
      return {
        kind: 'other',
        code: error.code,
        message: t('publish:staged.fail.timeout'),
      };
    case 'app_not_synced':
      return {
        kind: 'other',
        code: error.code,
        message: t('publish:staged.fail.appNotSynced', { message }),
      };
    default:
  }
  if (error.code.startsWith('credential_')) return { kind: 'other', code: error.code, message };
  // A request of the push that the server may have received and not answered: a cut connection or a 5xx without a known code.
  if (phase === 'push' && (error.status === 0 || error.status >= 500)) {
    return {
      kind: 'outcome_unknown',
      message:
        error.status === 0
          ? t('publish:staged.fail.connectionBroke')
          : t('publish:staged.fail.outcomeUnknown', { message }),
    };
  }
  return { kind: 'other', code: error.code, message };
}

/** Whether the person may confirm the same preview again without reading the store first. Never after an unknown outcome. */
export const mayConfirmAgain = (failure: PushFailure): boolean =>
  failure.kind === 'write_in_progress' || failure.kind === 'not_applied';

/** Whether the staged view should be read again after this failure (something may have changed on the server). */
export const shouldReloadStaged = (failure: PushFailure): boolean =>
  failure.kind === 'partial' ||
  failure.kind === 'restage' ||
  failure.kind === 'invalid' ||
  failure.kind === 'blocked' ||
  failure.kind === 'state_changed' ||
  failure.kind === 'outcome_unknown' ||
  failure.kind === 'disabled';

// ---------------------------------------------------------------------------------------------
// The preview dialog

/** What a person types before the push goes out: the name of the app, so a click on the wrong tray does not pass. */
export const confirmPhrase = (preview: Pick<DraftPreview, 'app'>): string =>
  preview.app.name.trim() !== '' ? preview.app.name.trim() : preview.app.id;

export const confirmationMatches = (typed: string, phrase: string): boolean =>
  typed.trim() !== '' && typed.trim().toLowerCase() === phrase.toLowerCase();

/** The push needs something to do, the acknowledgement and the typed name. */
export function canConfirmPush(
  preview: Pick<DraftPreview, 'app' | 'summary'> & { checks?: DraftPreview['checks'] },
  typed: string,
  acknowledged: boolean,
): boolean {
  if (preview.summary.nothingToDo) return false;
  if (preview.checks && (preview.checks.blocking.length > 0 || !preview.checks.canPush))
    return false;
  return acknowledged && confirmationMatches(typed, confirmPhrase(preview));
}

export function previewSummaryText(summary: DraftPreview['summary']): string {
  if (summary.nothingToDo) return t('publish:staged.summary.nothingToDo');
  const parts: string[] = [];
  const add = (key: string, count: number | undefined): void => {
    if ((count ?? 0) > 0) parts.push(t(key, { count: count ?? 0 }));
  };
  add(k('publish:staged.summary.textsChange'), summary.textChanged);
  add(k('publish:staged.summary.textsSame'), summary.textUnchanged);
  add(k('publish:staged.summary.fieldsChange'), summary.fieldsChanged);
  add(k('publish:staged.summary.fieldsSame'), summary.fieldsUnchanged);
  add(k('publish:staged.summary.setsChange'), summary.assetSetsChanged);
  add(k('publish:staged.summary.setsSame'), summary.assetSetsUnchanged);
  add(k('publish:staged.summary.upload'), summary.filesToUpload);
  add(k('publish:staged.summary.remove'), summary.filesToRemove);
  return t('publish:staged.summary.sentence', { parts: formatList(parts, { type: 'unit' }) });
}

export function previewTextStatus(item: Pick<PreviewText, 'status'>): {
  label: string;
  tone: StagedTone;
} {
  if (item.status === 'new_locale')
    return { label: t('publish:staged.preview.newLocale'), tone: 'warn' };
  if (item.status === 'unchanged')
    return { label: t('publish:staged.preview.alreadySame'), tone: 'neutral' };
  return { label: t('publish:staged.preview.willChange'), tone: 'info' };
}

export function previewFieldStatus(f: Pick<PreviewReleaseField, 'status'>): {
  label: string;
  tone: StagedTone;
} {
  if (f.status === 'local') return { label: t('publish:staged.preview.keptHere'), tone: 'neutral' };
  if (f.status === 'unchanged')
    return { label: t('publish:staged.preview.alreadySame'), tone: 'neutral' };
  return { label: t('publish:staged.preview.willChange'), tone: 'info' };
}

export function previewSetText(set: PreviewAssetSet): string {
  if (set.status === 'unchanged') return t('publish:staged.preview.setSame');
  const parts: string[] = [];
  if (set.willUpload > 0) parts.push(t('publish:staged.preview.upload', { count: set.willUpload }));
  if (set.willRemove > 0) parts.push(t('publish:staged.preview.remove', { count: set.willRemove }));
  const list = formatList(parts, { type: 'unit' });
  if (set.before.setExists)
    return parts.length > 0
      ? t('publish:staged.preview.setReplaced', { parts: list })
      : t('publish:staged.preview.setReplacedPlain');
  return parts.length > 0
    ? t('publish:staged.preview.setCreated', { parts: list })
    : t('publish:staged.preview.setCreatedPlain');
}

export function versionText(preview: Pick<DraftPreview, 'app' | 'version'>): string {
  if (preview.version === null)
    return supports(preview.app.platform, 'releaseTracks')
      ? t('publish:staged.version.playEdit')
      : '';
  return preview.version.versionString
    ? t('publish:staged.version.named', {
        version: preview.version.versionString,
        state: preview.version.state,
      })
    : t('publish:staged.version.editable', { state: preview.version.state });
}

/** The sentence after a successful push. Always says nothing was submitted. */
export function resultText(result: DraftPushResult): string {
  const parts: string[] = [t('publish:staged.result.written', { count: result.counts.applied })];
  if (result.counts.alreadySame > 0)
    parts.push(t('publish:staged.result.alreadySame', { count: result.counts.alreadySame }));
  if (result.counts.filesUploaded > 0)
    parts.push(t('publish:staged.result.uploaded', { count: result.counts.filesUploaded }));
  if (result.counts.filesRemoved > 0)
    parts.push(t('publish:staged.result.removed', { count: result.counts.filesRemoved }));
  return t('publish:staged.result.sentence', {
    parts: formatList(parts, { type: 'unit' }),
    note: notSubmittedNote(),
  });
}
