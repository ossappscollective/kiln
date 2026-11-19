import { type Platform, type Role, can } from '@mrm/core';
import { ApiError } from './api.ts';

/**
 * Submitting the pushed draft for the store's review (docs/api/submit.md, docs/adr/0010-store-submit.md): the
 * types of the API that the web app owns, and the pure logic of the "ready to submit" line, the preview
 * dialog and the errors. A submit is a store write that CANNOT be taken back from this tool, and it never
 * releases or publishes anything. The server decides every rule; what is checked here only explains things.
 * Written for the ES2017 web build: no flatMap, no fromEntries.
 */

export const SUBMIT_ENV = 'MRM_STORE_SUBMIT_ENABLED';

export const SUBMIT_ROLE_REASON = 'Submitting a draft for review needs the admin or owner role.';

// ---------------------------------------------------------------------------------------------
// API shapes

export type StoreSubmitConfig = {
  enabled: boolean;
  envName: string;
  action: string;
  minimumRole: string;
  irreversible: boolean;
  releases: boolean;
  note: string;
};

export type SubmitPushRecord = {
  pushedAt: number;
  pushedBy: string | null;
  versionString: string | null;
  texts: number;
  assetSets: number;
};

export type SubmitState = {
  enabled: boolean;
  pushed: boolean;
  push: SubmitPushRecord | null;
  inFlight: { submit: boolean; push: boolean };
  unknownOutcome: { submit: boolean; push: boolean };
};

export type SubmitCheck = {
  code: string;
  severity: string;
  message: string;
  locale?: string;
  item?: string;
  rule?: string;
  source?: string;
  verified?: boolean;
};

export type SubmitTrack = {
  track: string;
  releases: { name: string | null; status: string | null; userFraction: number | null; versionCodes: (number | string)[] }[];
};

export type SubmitLocale = {
  locale: string;
  textFields: number;
  screenshotSets: { target: string; device: string | null; images: number }[];
};

export type SubmitPreview = {
  app: { id: string; name: string; platform: Platform; store: string };
  version: { id: string; versionString: string | null; state: string | null; releaseType: string | null } | null;
  build: { id: string; version: string | null; processingState: string | null; expired: boolean } | null;
  contents: {
    locales: SubmitLocale[];
    pushed: SubmitPushRecord | null;
    includesChangesNotPushedHere: boolean;
  };
  tracks: SubmitTrack[];
  irreversible: string[];
  submits: boolean;
  releases: boolean;
  checks: { blocking: SubmitCheck[]; warnings: SubmitCheck[]; canSubmit: boolean };
  /** Both null while anything blocks. */
  confirmHash: string | null;
  confirmation: { phrase: string; instruction: string } | null;
  readAt: number;
};

export type SubmitResult = {
  app: { id: string; name: string; platform: Platform; store: string };
  version: { id: string; versionString: string | null } | null;
  submission: { id: string; state: string | null } | null;
  via: 'review_submission' | 'edit_commit' | string;
  submitted: boolean;
  released: boolean;
  confirmedByReread: boolean;
  submittedAt: number;
  note: string;
};

// ---------------------------------------------------------------------------------------------
// Who may, and the line

/** Preview and submit: admin and up (`store.submit`). Not the same right as pushing a draft. */
export const canSubmit = (role: Role): boolean => can(role, 'store.submit');

export const storeLabel = (platform: Platform): string => (platform === 'android' ? 'Google Play review' : platform === 'macos' ? 'Mac App Store review' : 'App Store review');

/** What a submit never does, for the dialog and the result. */
export const releaseStatement = (platform: Platform): string =>
  platform !== 'android'
    ? 'This hands the version to App Review. It does not release it: after approval it stays unreleased until somebody releases it in App Store Connect. This tool never publishes.'
    : 'This sends the held-back changes to Google Play review. It does not publish them and does not start, raise or complete a rollout. This tool never publishes.';

export const OFF_NOTE = (envName: string): string =>
  `Submitting a draft for store review is switched off on this server. Someone who runs it sets ${envName || SUBMIT_ENV}=true and restarts it (see docs/api/submit.md). Nothing here can be submitted until then. Meanwhile, submit the draft in App Store Connect or Play Console.`;

export type SubmitLineInput = {
  role: Role;
  state: SubmitState | null;
  stateFailed: boolean;
  config: StoreSubmitConfig | null;
  configFailed: boolean;
};

export type SubmitLine =
  | { kind: 'hidden' }
  /** Nothing can be shown yet or the read failed: a muted line, no button. */
  | { kind: 'note'; tone: 'neutral' | 'bad'; text: string; retry: boolean }
  /** Switched off: the line, an info popover with `note`, no button. */
  | { kind: 'off'; text: string; note: string }
  | { kind: 'ready'; text: string; button: string; disabled: boolean; reason: string | null };

/**
 * What the "Draft pushed — ready to submit?" line shows. Nothing for a role below admin, and nothing while no
 * draft push is recorded. A button only when the server's switch is on.
 */
export function submitLine(input: SubmitLineInput): SubmitLine {
  if (!canSubmit(input.role)) return { kind: 'hidden' };
  if (input.state === null) {
    return input.stateFailed
      ? { kind: 'note', tone: 'bad', text: 'Could not check whether a pushed draft is waiting to be submitted.', retry: true }
      : { kind: 'hidden' };
  }
  const unknown = input.state.unknownOutcome.submit;
  if (!input.state.pushed && !unknown) return { kind: 'hidden' };
  const text = unknown ? 'Last submit: outcome unknown' : 'Draft pushed — ready to submit?';
  if (input.configFailed) return { kind: 'note', tone: 'bad', text: `${text} Could not check whether submitting is switched on.`, retry: true };
  if (input.config === null) return { kind: 'ready', text, button: 'Submit for review…', disabled: true, reason: 'Checking whether submitting is switched on.' };
  if (!input.config.enabled) {
    return { kind: 'off', text: unknown ? text : 'Draft pushed. Submitting is switched off', note: OFF_NOTE(input.config.envName) };
  }
  if (input.state.inFlight.submit || input.state.inFlight.push) {
    return { kind: 'ready', text, button: 'Submit for review…', disabled: true, reason: 'A submit or a draft push for this app is running.' };
  }
  if (unknown) {
    return { kind: 'ready', text, button: 'Check the store, then preview…', disabled: false, reason: null };
  }
  return { kind: 'ready', text, button: 'Submit for review…', disabled: false, reason: null };
}

/** The muted detail after the line: "2.1 · pushed 3 hours ago by Ana". */
export function pushDetail(push: SubmitPushRecord | null, ago: (at: number) => string): string {
  if (push === null) return '';
  const parts: string[] = [];
  if (push.versionString) parts.push(push.versionString);
  parts.push(`pushed ${ago(push.pushedAt)}${push.pushedBy ? ` by ${push.pushedBy}` : ''}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------------------------
// The preview

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function isSubmitPreview(value: unknown): value is SubmitPreview {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const checks = v.checks as Record<string, unknown> | undefined;
  return (
    typeof v.app === 'object' &&
    v.app !== null &&
    Array.isArray(v.irreversible) &&
    typeof v.contents === 'object' &&
    v.contents !== null &&
    typeof checks === 'object' &&
    checks !== null &&
    Array.isArray(checks.blocking) &&
    Array.isArray(checks.warnings)
  );
}

/** The version line: "2.1 (PREPARE_FOR_SUBMISSION), release type MANUAL"; Google Play has no version object. */
export function versionLine(preview: Pick<SubmitPreview, 'app' | 'version'>): string {
  const v = preview.version;
  if (v === null) return preview.app.platform === 'android' ? 'The changes held back in Google Play' : 'No editable version';
  const parts: string[] = [v.versionString ? `Version ${v.versionString}` : 'The editable version'];
  if (v.state) parts[0] = `${parts[0]} (${v.state})`;
  if (v.releaseType) parts.push(`release type ${v.releaseType}`);
  return parts.join(', ');
}

export function buildLine(build: SubmitPreview['build']): string | null {
  if (build === null) return null;
  const parts: string[] = [build.version ? `Build ${build.version}` : 'A build'];
  if (build.processingState) parts.push(build.processingState);
  if (build.expired) parts.push('expired');
  return parts.join(', ');
}

/** "en-US: 5 text fields, 2 screenshot sets (8 images)". */
export function localeLine(locale: SubmitLocale): string {
  const sets = locale.screenshotSets;
  const images = sets.reduce((n, s) => n + s.images, 0);
  const shots = sets.length === 0 ? 'no screenshots' : `${plural(sets.length, 'screenshot set', 'screenshot sets')} (${plural(images, 'image', 'images')})`;
  return `${locale.locale}: ${plural(locale.textFields, 'text field', 'text fields')}, ${shots}`;
}

export function pushedText(push: SubmitPushRecord | null): string {
  if (push === null) return '';
  return `${plural(push.texts, 'text', 'texts')} and ${plural(push.assetSets, 'graphic set', 'graphic sets')} were pushed`;
}

export function trackLine(track: SubmitTrack): string {
  const releases = track.releases.map((r) => {
    const parts: string[] = [r.name ?? 'Unnamed release'];
    if (r.status) parts.push(r.status);
    if (r.userFraction !== null && r.userFraction !== undefined) parts.push(`${Math.round(r.userFraction * 10000) / 100}% of users`);
    if (r.versionCodes.length > 0) parts.push(`version code ${r.versionCodes.join(', ')}`);
    return parts.join(', ');
  });
  return `${track.track}: ${releases.length === 0 ? 'no release' : releases.join('; ')}`;
}

/** A check as one sentence: the message, and where (locale, item) when the server names it. */
export function checkText(check: SubmitCheck): string {
  const where = [check.locale, check.item].filter((p): p is string => typeof p === 'string' && p !== '').join(' / ');
  return where === '' ? check.message : `${check.message} (${where})`;
}

// ---------------------------------------------------------------------------------------------
// The typed confirmation

/** The server ignores surrounding spaces and compares case-sensitively; so does this. */
export const confirmationMatches = (typed: string, phrase: string | null): boolean => phrase !== null && phrase.trim() !== '' && typed.trim() === phrase.trim();

/** What the confirm button needs: nothing blocks, the preview carries a hash and a phrase, and the phrase was typed. */
export function canConfirmSubmit(preview: Pick<SubmitPreview, 'checks' | 'confirmHash' | 'confirmation'>, typed: string): boolean {
  if (preview.checks.blocking.length > 0 || !preview.checks.canSubmit) return false;
  if (preview.confirmHash === null || preview.confirmation === null) return false;
  return confirmationMatches(typed, preview.confirmation.phrase);
}

/** The request of the submit: the typed text is sent as the person typed it (the server trims it). */
export function submitBody(preview: Pick<SubmitPreview, 'confirmHash'>, typed: string): { confirmHash: string; confirmation: string } | null {
  return preview.confirmHash === null ? null : { confirmHash: preview.confirmHash, confirmation: typed };
}

// ---------------------------------------------------------------------------------------------
// Errors of the preview and the submit

export type SubmitFailure =
  | { kind: 'disabled'; message: string }
  | { kind: 'nothing_pushed'; message: string }
  /** Nothing was read or written. The person fixes the text and confirms again. */
  | { kind: 'mismatch'; message: string }
  | { kind: 'blocked'; message: string; checks: SubmitCheck[] }
  /** Nothing was submitted; `next` is the new preview that must be confirmed again. */
  | { kind: 'state_changed'; message: string; next: SubmitPreview | null }
  | { kind: 'write_in_progress'; message: string }
  | { kind: 'push_unknown'; message: string }
  /** Not known whether anything was submitted. The caller must NOT send the submit again. */
  | { kind: 'outcome_unknown'; message: string }
  | { kind: 'not_applied'; message: string }
  | { kind: 'rate_limited'; message: string; retryAfter: number | null }
  | { kind: 'forbidden'; message: string }
  | { kind: 'other'; message: string; code: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const bodyMessage = (error: ApiError): string => (typeof error.body.message === 'string' && error.body.message !== '' ? error.body.message : error.message);

export const UNKNOWN_SUBMIT_HINT =
  'Do not submit again yet. Look at the store console (App Store Connect or Play Console) to see whether the version is in review, then preview again here: that only reads the store.';

/**
 * Sorts an error of the preview or the submit. Nothing here retries. `outcome_unknown`, and a cut connection or
 * a 5xx during the submit, are final for that attempt: this app never sends the submit again by itself.
 */
export function classifySubmitFailure(error: unknown, phase: 'preview' | 'submit' = 'submit'): SubmitFailure {
  if (!(error instanceof ApiError)) return { kind: 'other', code: 'error', message: 'The request failed. Check your connection, then read the state again.' };
  const message = bodyMessage(error);
  const body = error.body;
  switch (error.code) {
    case 'store_submit_disabled':
      return {
        kind: 'disabled',
        message: `Submitting for review is switched off on this server (${SUBMIT_ENV}). Nothing was submitted. Someone who runs the server sets ${SUBMIT_ENV}=true and restarts it.`,
      };
    case 'forbidden':
      return { kind: 'forbidden', message: SUBMIT_ROLE_REASON };
    case 'nothing_pushed':
      return { kind: 'nothing_pushed', message: 'No pushed draft is recorded for this app (it may have been submitted already). Nothing was submitted. Push the draft first.' };
    case 'confirmation_mismatch': {
      const phrase = typeof body.phrase === 'string' ? body.phrase : null;
      return {
        kind: 'mismatch',
        message: `The text you typed is not the phrase.${phrase ? ` Type exactly: ${phrase}.` : ''} Nothing was read or submitted.`,
      };
    }
    case 'blocked': {
      const checks = Array.isArray(body.checks) ? (body.checks as SubmitCheck[]) : [];
      return {
        kind: 'blocked',
        checks,
        message: 'Something blocks the submit on the store as it is now. Nothing was submitted. Fix it, then preview again.',
      };
    }
    case 'state_changed':
      return {
        kind: 'state_changed',
        next: isSubmitPreview(body.preview) ? body.preview : null,
        message: 'The store is not what you previewed (version, build, listing, draft or tracks changed), so nothing was submitted. Read the new preview and confirm again.',
      };
    case 'write_in_progress':
      return { kind: 'write_in_progress', message: `${message} Nothing was submitted by this request. Wait a moment, then confirm again.` };
    case 'push_outcome_unknown':
      return {
        kind: 'push_unknown',
        message: 'The last draft push has an unknown outcome, so nothing was submitted. Preview that push again from the staged changes first (that only reads the store), then come back.',
      };
    case 'outcome_unknown':
      return { kind: 'outcome_unknown', message: `${message} ${UNKNOWN_SUBMIT_HINT}` };
    case 'write_failed':
      return body.outcome === 'not_applied'
        ? { kind: 'not_applied', message: `${message} The store did not submit the version. You can preview and confirm again.` }
        : { kind: 'outcome_unknown', message: `${message} ${UNKNOWN_SUBMIT_HINT}` };
    case 'changes_in_review':
      return { kind: 'other', code: error.code, message: 'Google Play already has changes in review for this app. Nothing was sent. Wait until they are decided. This tool never cancels a review.' };
    case 'no_editable_version':
      return { kind: 'other', code: error.code, message: `${message} Create the next version in App Store Connect, push the draft, then preview again.` };
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
      return { kind: 'other', code: error.code, message: `The store refused the request: ${message}` };
    case 'store_unavailable':
      return { kind: 'other', code: error.code, message: `${message} The store could not be reached before anything was sent; nothing was submitted.` };
    case 'timeout':
      return {
        kind: 'other',
        code: error.code,
        message: 'A read of the store did not answer in time. If you are unsure whether the version went to review, preview again (that reads the store) and check the store console.',
      };
    case 'app_not_synced':
      return { kind: 'other', code: error.code, message: `${message} Sync the app first.` };
    default:
  }
  if (error.code.startsWith('credential_')) return { kind: 'other', code: error.code, message };
  // The submit may have reached the server and the answer was lost: a cut connection, or a 5xx without a known code.
  if (phase === 'submit' && (error.status === 0 || error.status >= 500)) {
    return {
      kind: 'outcome_unknown',
      message: `${error.status === 0 ? 'The connection broke while the submit was running, so it is not known whether the server received it.' : message} ${UNKNOWN_SUBMIT_HINT}`,
    };
  }
  return { kind: 'other', code: error.code, message };
}

/** The person may confirm the same preview again without a new read: nothing was sent, or the store did not apply it. Never after an unknown outcome. */
export const mayConfirmAgain = (failure: SubmitFailure): boolean =>
  failure.kind === 'mismatch' || failure.kind === 'write_in_progress' || failure.kind === 'not_applied';

/** The state of the app (pushed, in flight, unknown) should be read again after this failure. */
export const shouldReloadState = (failure: SubmitFailure): boolean =>
  failure.kind === 'nothing_pushed' ||
  failure.kind === 'outcome_unknown' ||
  failure.kind === 'push_unknown' ||
  failure.kind === 'disabled' ||
  failure.kind === 'state_changed' ||
  failure.kind === 'blocked' ||
  failure.kind === 'not_applied';

/** The sentence after a successful submit. Always says it was not released or published. */
export function resultText(result: SubmitResult): string {
  const version = result.version?.versionString ? ` (version ${result.version.versionString})` : '';
  const how = result.confirmedByReread ? ' The answer of the store was lost, and reading it back shows the version is in review.' : '';
  const state = result.submission?.state ? ` Review state: ${result.submission.state}.` : '';
  return `Sent to ${result.app.platform === 'android' ? 'Google Play review' : 'App Review'}${version}.${how}${state} Nothing was released or published.`;
}
