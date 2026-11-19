import {
  type AssetKind,
  type AssetProblem,
  assetSlotSupport,
  can,
  type Platform,
  PUSHABLE_IMAGE_FORMATS,
  type Role,
  STAGEABLE_TEXT_FIELDS,
  type STAGED_LIMITS,
  type StagedAssetView,
  type StagedChangesView,
  type StagedProblem,
  type StagedTextView,
  slotKey,
  slotMaxFiles,
} from '@mrm/core';
import { ApiError, waitPhrase } from './api.ts';
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

export const DRAFT_ENV = 'MRM_STORE_DRAFT_WRITE_ENABLED';

/** The sentence the dialog and the tray keep saying: a push is not a submit. */
export const NOT_SUBMITTED =
  'Nothing is submitted for review or published by a push. Submitting is a separate step with its own switch and confirmation.';

/** The note under the tray: where the next step is, and what this tool never does. */
export const SUBMIT_NEXT_STEP =
  'After a push, "Submit for review…" (admin and up, when the server allows it) hands the draft to the store\'s review. Releasing is a separate step with its own switch and confirmation.';

export const REVERSE_IMAGE_SYNC_NOTE =
  'The store\'s images cannot be staged directly. "Pull from store" puts them into the repository as a draft change set to review and apply; after that they can be staged from there. Files you upload here are staged as they are.';

// ---------------------------------------------------------------------------------------------
// API shapes (the staged view itself comes from @mrm/core)

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
  commit: 'not_sent_for_review' | 'none';
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

export const STAGE_ROLE_REASON = 'Your role cannot stage changes. A member, admin or owner can.';
export const PUSH_ROLE_REASON = 'Pushing a draft to a store needs the admin or owner role.';

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
  if (!canPush(role)) return { state: 'role', message: PUSH_ROLE_REASON };
  if (loadFailed) {
    return {
      state: 'unknown',
      message:
        'Could not find out whether pushing drafts is switched on. Reload the page to try again.',
    };
  }
  if (!config) return { state: 'loading' };
  if (!config.enabled) {
    return {
      state: 'off',
      message: `Writing drafts to a store is switched off on this server. Someone who runs it sets ${config.envName || DRAFT_ENV}=true and restarts it (see docs/api/staged-changes.md). Staging works meanwhile; nothing here can reach a store until then.`,
    };
  }
  return { state: 'ready' };
}

export const storeName = (platform: Platform): string =>
  platform === 'android'
    ? 'Google Play'
    : platform === 'macos'
      ? 'the Mac App Store'
      : 'the App Store';

// ---------------------------------------------------------------------------------------------
// The tray

export const releaseCount = (view: StagedChangesView | null): number =>
  view === null ? 0 : (view.release ?? []).length;

export const itemCount = (view: StagedChangesView | null): number =>
  view === null ? 0 : view.text.length + view.assets.length + releaseCount(view);

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "3 texts, 2 graphic sets (7 files)", or "Nothing staged". */
export function trayCountText(view: StagedChangesView | null): string {
  if (view === null || itemCount(view) === 0) return 'Nothing staged';
  const parts: string[] = [];
  if (view.text.length > 0) parts.push(plural(view.text.length, 'text', 'texts'));
  if (releaseCount(view) > 0)
    parts.push(plural(releaseCount(view), 'release field', 'release fields'));
  if (view.assets.length > 0) {
    const files = view.assets.reduce((n, s) => n + s.files.length, 0);
    parts.push(
      `${plural(view.assets.length, 'graphic set', 'graphic sets')} (${plural(files, 'file', 'files')})`,
    );
  }
  return parts.join(', ');
}

/** Why a push cannot start for this staged view, or null. */
export function pushBlockedReason(view: StagedChangesView | null): string | null {
  if (view === null) return 'The staged changes are not loaded yet.';
  if (itemCount(view) === 0) return 'Nothing is staged.';
  if (!view.valid) return 'Some staged items have an error. Fix or remove them first.';
  return null;
}

export const problemsOf = (
  item: { problems: StagedProblem[] },
  severity: 'error' | 'warning',
): StagedProblem[] => item.problems.filter((p) => p.severity === severity);

export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  repo: 'From the repository',
  local: 'Typed or uploaded here',
  store: 'From the store',
};

export const sourceLabel = (source: string): string => SOURCE_LABELS[source] ?? source;

export type StagedTone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info';

export function textStatus(item: Pick<StagedTextView, 'status'>): {
  label: string;
  tone: StagedTone;
} {
  if (item.status === 'invalid') return { label: 'Has an error', tone: 'bad' };
  if (item.status === 'unchanged') return { label: 'Same as the store', tone: 'neutral' };
  return { label: 'Differs from the store', tone: 'info' };
}

/** "Pushed to the draft" only while the staged value is still the one that was pushed. */
export const pushedLabel = (item: { pushed: boolean }): string | null =>
  item.pushed ? 'In the store draft' : null;

/** A label for a graphic set: "en-US: Screenshots, iphone_6_5" from the server's label, plus the locale. */
export const setTitle = (set: Pick<StagedAssetView, 'locale' | 'label'>): string =>
  `${set.locale}: ${set.label}`;

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
  for (const t of view.text) if (t.locale === locale && t.field === field) return t;
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

const APPLE_NOT_PUSHABLE =
  'A draft push cannot write this field: the App Store keeps the name, subtitle and privacy policy URL on the app information, not on the version.';

const NOT_PUSHABLE: Record<Platform, string> = {
  ios: APPLE_NOT_PUSHABLE,
  macos: APPLE_NOT_PUSHABLE,
  android: 'A draft push cannot write this field.',
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
    return { state: 'not_pushable', reason: NOT_PUSHABLE[input.platform], ...base };
  if (field.status === 'identical' && staged === null)
    return { state: 'hidden', reason: null, ...base };
  if (!canStage(input.role)) return { state: 'disabled', reason: STAGE_ROLE_REASON, ...base };
  if (!isStageableLocale(field.locale))
    return {
      state: 'disabled',
      reason: 'This is not a store locale code, so it cannot be staged.',
      ...base,
    };
  if (repoValue === null || repoValue.trim() === '')
    return { state: 'disabled', reason: 'The repository has no value for this field.', ...base };
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

  if (!canStage(input.role)) return no(STAGE_ROLE_REASON);
  if (input.assets.length === 0) return no('The set has no files.');
  if (input.commit === null)
    return no(
      'The repository read named no commit, so the files cannot be pinned. Read the repository again.',
    );
  if (!isStageableLocale(input.locale))
    return no(
      'Files in the project folder or a flat folder have no store locale, so they cannot be staged.',
    );
  const support = assetSlotSupport(input.platform, { kind: input.kind, device: input.device });
  if (!support.ok) return no(support.reason);
  const max = slotMaxFiles(input.platform, { kind: input.kind, device: input.device });
  if (input.assets.length > max)
    return no(
      `The store takes at most ${max} ${max === 1 ? 'file' : 'files'} in this set and the repository has ${input.assets.length}. Remove the extra files from the repository first.`,
    );
  for (const a of input.assets) {
    const name = a.path.slice(a.path.lastIndexOf('/') + 1);
    if (a.origin !== 'store') return no(`${name} is the icon of the project, not a store file.`);
    if (a.read !== 'read' || a.oid === null)
      return no(
        `${name} was not read (too large, over the read budget or unreadable), so it cannot be staged.`,
      );
    if (a.format === null || PUSHABLE_IMAGE_FORMATS.indexOf(a.format) === -1)
      return no(`${name} is not a PNG or JPEG: only those are uploaded.`);
    if (a.bytes === null || a.bytes > maxFile)
      return no(`${name} is larger than the ${Math.round(maxFile / MiB)} MB this server uploads.`);
  }
  const errors: AssetProblem[] = [];
  for (const p of input.setProblems) if (p.severity === 'error') errors.push(p);
  for (const a of input.assets)
    for (const p of input.problemsByPath[a.path] ?? []) if (p.severity === 'error') errors.push(p);
  if (errors.length > 0)
    return no(`Fix the spec problem first: ${(errors[0] as AssetProblem).message}`);
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
  return `The repository is being read too often. Try again in ${waitPhrase(retryAfter && retryAfter > 0 ? retryAfter : 60)}.`;
}

export function stagingError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  switch (error.code) {
    case 'forbidden':
      return STAGE_ROLE_REASON;
    case 'not_found':
      return 'That no longer exists. Reload the page.';
    case 'field_not_pushable': {
      const allowed = Array.isArray(error.body.allowed)
        ? (error.body.allowed as unknown[]).filter((a): a is string => typeof a === 'string')
        : [];
      return `${bodyMessage(error)}${allowed.length > 0 ? ` Fields a draft push can write: ${allowed.join(', ')}.` : ''}`;
    }
    case 'no_source_value':
      return `${bodyMessage(error)} Read the repository again, then stage it.`;
    case 'source_not_supported':
      return REVERSE_IMAGE_SYNC_NOTE;
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

const UNKNOWN_HINT =
  'Do not push again yet: preview again (that only reads the store), then check the draft in the store console.';

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
      message: 'The request failed. Check your connection and read the staged changes again.',
    };
  const message = bodyMessage(error);
  const body = error.body;
  switch (error.code) {
    case 'store_draft_disabled':
      return {
        kind: 'disabled',
        message: `Writing drafts to a store is switched off on this server (${DRAFT_ENV}). Nothing was written. Someone who runs the server sets ${DRAFT_ENV}=true and restarts it.`,
      };
    case 'forbidden':
      return { kind: 'forbidden', message: PUSH_ROLE_REASON };
    case 'state_changed':
      return {
        kind: 'state_changed',
        next: isPreview(body.preview) ? body.preview : null,
        message:
          'The staged changes or the store’s draft changed since you previewed this, so nothing was written. Read the new preview and confirm again.',
      };
    case 'write_in_progress':
      return {
        kind: 'write_in_progress',
        message: `${message} Nothing was written by this request. Wait a moment, then confirm again.`,
      };
    case 'outcome_unknown':
      return { kind: 'outcome_unknown', message: `${message} ${UNKNOWN_HINT}` };
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
        : { kind: 'outcome_unknown', message: `${message} ${UNKNOWN_HINT}` };
    case 'draft_not_allowed':
      return {
        kind: 'other',
        code: error.code,
        message: `${message} Nothing was committed. This tool never retries without holding the changes back, because that could send them for review.`,
      };
    case 'changes_in_review':
      return {
        kind: 'other',
        code: error.code,
        message:
          'The store has changes in review for this app. Wait until they are decided, then try again. This tool never cancels a review.',
      };
    case 'no_editable_version':
      return {
        kind: 'other',
        code: error.code,
        message: `${message} Create the next version in App Store Connect, then preview again.`,
      };
    case 'blocked':
      return {
        kind: 'blocked',
        checks: Array.isArray(body.checks) ? (body.checks as PushCheck[]) : [],
        message:
          'The store says something staged cannot be written as it is. Nothing was written. Fix it in the stepper or remove it, then preview again.',
      };
    case 'nothing_staged':
      return { kind: 'invalid', message: 'Nothing is staged for this app.', problems: [] };
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
        message: `${message}${error.code === 'asset_unreadable' ? ' Stage the set again from the Assets tab.' : ''}`,
      };
    case 'rate_limited':
      return {
        kind: 'rate_limited',
        retryAfter: error.retryAfter ?? null,
        message: `The store is limiting requests. ${error.retryAfter ? `Try again in ${error.retryAfter} seconds.` : 'Try again in a minute.'} This app never retries by itself.`,
      };
    case 'store_auth':
    case 'store_forbidden':
    case 'store_not_found':
    case 'store_rejected':
      return {
        kind: 'other',
        code: error.code,
        message: `The store refused the request: ${message}`,
      };
    case 'store_unavailable':
      return {
        kind: 'other',
        code: error.code,
        message: `${message} The store could not be reached; nothing was changed.`,
      };
    case 'timeout':
      return {
        kind: 'other',
        code: error.code,
        message:
          'A read of the store did not answer in time. If you are not sure whether anything was written, preview again: that reads the draft.',
      };
    case 'app_not_synced':
      return { kind: 'other', code: error.code, message: `${message} Sync the app first.` };
    default:
  }
  if (error.code.startsWith('credential_')) return { kind: 'other', code: error.code, message };
  // A request of the push that the server may have received and not answered: a cut connection or a 5xx without a known code.
  if (phase === 'push' && (error.status === 0 || error.status >= 500)) {
    return {
      kind: 'outcome_unknown',
      message: `${error.status === 0 ? 'The connection broke while the push was running, so it is not known whether the server received it.' : message} ${UNKNOWN_HINT}`,
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
  if (summary.nothingToDo)
    return 'Nothing to do: the store’s draft already holds everything that is staged.';
  const parts: string[] = [];
  if (summary.textChanged > 0)
    parts.push(`${plural(summary.textChanged, 'text', 'texts')} will change`);
  if (summary.textUnchanged > 0)
    parts.push(`${plural(summary.textUnchanged, 'text is', 'texts are')} already the same`);
  if ((summary.fieldsChanged ?? 0) > 0)
    parts.push(
      `${plural(summary.fieldsChanged ?? 0, 'release field', 'release fields')} will change`,
    );
  if ((summary.fieldsUnchanged ?? 0) > 0)
    parts.push(
      `${plural(summary.fieldsUnchanged ?? 0, 'release field is', 'release fields are')} already the same`,
    );
  if (summary.assetSetsChanged > 0)
    parts.push(`${plural(summary.assetSetsChanged, 'graphic set', 'graphic sets')} will change`);
  if (summary.assetSetsUnchanged > 0)
    parts.push(
      `${plural(summary.assetSetsUnchanged, 'graphic set is', 'graphic sets are')} already the same`,
    );
  if (summary.filesToUpload > 0)
    parts.push(`${plural(summary.filesToUpload, 'file', 'files')} will be uploaded`);
  if (summary.filesToRemove > 0)
    parts.push(`${plural(summary.filesToRemove, 'file', 'files')} will be removed from the draft`);
  return `${parts.join('; ')}.`;
}

export function previewTextStatus(t: Pick<PreviewText, 'status'>): {
  label: string;
  tone: StagedTone;
} {
  if (t.status === 'new_locale') return { label: 'New locale in the draft', tone: 'warn' };
  if (t.status === 'unchanged') return { label: 'Already the same', tone: 'neutral' };
  return { label: 'Will change', tone: 'info' };
}

export function previewFieldStatus(f: Pick<PreviewReleaseField, 'status'>): {
  label: string;
  tone: StagedTone;
} {
  if (f.status === 'local') return { label: 'Kept here only', tone: 'neutral' };
  if (f.status === 'unchanged') return { label: 'Already the same', tone: 'neutral' };
  return { label: 'Will change', tone: 'info' };
}

export function previewSetText(set: PreviewAssetSet): string {
  if (set.status === 'unchanged') return 'Already the same in the draft.';
  const parts: string[] = [];
  if (set.willUpload > 0) parts.push(`upload ${plural(set.willUpload, 'file', 'files')}`);
  if (set.willRemove > 0) parts.push(`remove ${plural(set.willRemove, 'file', 'files')}`);
  const head = set.before.setExists
    ? 'The draft’s set is replaced'
    : 'A new set is created in the draft';
  return `${head}${parts.length > 0 ? `: ${parts.join(', ')}` : ''}.`;
}

export function versionText(preview: Pick<DraftPreview, 'app' | 'version'>): string {
  if (preview.version === null)
    return preview.app.platform === 'android'
      ? 'A Google Play edit, committed as changes not sent for review'
      : '';
  const name = preview.version.versionString
    ? `version ${preview.version.versionString}`
    : 'the editable version';
  return `${name} (${preview.version.state})`;
}

/** The sentence after a successful push. Always says nothing was submitted. */
export function resultText(result: DraftPushResult): string {
  const parts: string[] = [
    `${plural(result.counts.applied, 'change', 'changes')} written to the draft`,
  ];
  if (result.counts.alreadySame > 0) parts.push(`${result.counts.alreadySame} already the same`);
  if (result.counts.filesUploaded > 0)
    parts.push(`${plural(result.counts.filesUploaded, 'file', 'files')} uploaded`);
  if (result.counts.filesRemoved > 0)
    parts.push(`${plural(result.counts.filesRemoved, 'file', 'files')} removed`);
  return `${parts.join(', ')}. ${NOT_SUBMITTED}`;
}
