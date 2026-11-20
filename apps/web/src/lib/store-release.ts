import { can, fractionRefusalNotice, type Platform, type Role } from '@mrm/core';
import { ApiError } from './api.ts';
import { confirmationMatches } from './store-submit.ts';

/**
 * Releasing (docs/api/releases-write.md, docs/adr/0014-release-management.md): the one store write that cannot be taken
 * back. It makes an approved App Store version available, or starts a Google Play draft release at a share of users the person
 * NAMES (never implied). The types of the API, the line of the Confirm step, the typed phrase and the errors. The server decides
 * every rule; what is checked here only explains things. Nothing here sends anything, and nothing is retried.
 * Written for the ES2017 web build: no flatMap, no fromEntries.
 */

export const RELEASE_ENV = 'MRM_STORE_RELEASE_ENABLED';
export const RELEASE_ROLE_REASON = 'Releasing needs the admin or owner role.';

// ---------------------------------------------------------------------------------------------
// API shapes

export type StoreReleaseConfig = {
  enabled: boolean;
  envName: string;
  action: string;
  minimumRole: string;
  irreversible: boolean;
  note: string;
};

export type StoreReleaseState = {
  enabled: boolean;
  inFlight: { release: boolean; push: boolean; submit: boolean };
  unknownOutcome: { release: boolean; push: boolean; submit: boolean };
};

export type ReleaseCheck = {
  code: string;
  severity: 'blocking' | 'warning';
  message: string;
  item?: string;
};

/** What is asked: App Store, an optional marketing version; Google Play, the track, the share and optionally the codes. */
export type ReleaseBody = {
  version?: string;
  track?: string;
  userFraction?: number;
  versionCodes?: string[];
  /** Google Play: release the staged fields in one step, no draft first (docs/adr/0029-direct-play-release.md). */
  direct?: boolean;
};

/** Google Play, direct release: what is sent, in the server's words, and the facts behind them. Never a note. */
export type ReleaseDirect = {
  creates: boolean;
  versionCodes: string[];
  name: string | null;
  notesLanguages: string[];
  summary: string;
};

export type ReleasePreview = {
  app: { id: string; name: string; platform: Platform; store: string };
  request: ReleaseBody;
  version: {
    id: string;
    versionString: string | null;
    state: string;
    releaseType: string | null;
  } | null;
  build: {
    id: string;
    buildNumber: string | null;
    processingState: string | null;
    expired: boolean | null;
  } | null;
  phasedRelease: { id: string; state: string | null } | null;
  track: string | null;
  release: { name: string | null; status: string; versionCodes: string[]; notes: number } | null;
  others: {
    name: string | null;
    status: string;
    userFraction: number | null;
    versionCodes: string[];
  }[];
  audience: {
    kind: 'all' | 'phased' | 'percent';
    userFraction: number | null;
    description: string;
  };
  /** Google Play, direct release only; null otherwise (an older server sends nothing). */
  direct?: ReleaseDirect | null;
  irreversible: string[];
  releases: true;
  checks: { blocking: ReleaseCheck[]; warnings: ReleaseCheck[]; canRelease: boolean };
  /** Both null while anything blocks. */
  confirmHash: string | null;
  confirmation: { phrase: string; instruction: string } | null;
  /** False when the person's own confirmation (password or passkey) stands in for the typed phrase. Older servers omit it: the phrase is needed. */
  confirmationRequired?: boolean;
  readAt: number;
};

export type ReleaseResult = {
  app: { id: string; name: string; platform: Platform; store: string };
  request: ReleaseBody;
  version: { id: string; versionString: string | null } | null;
  track: string | null;
  releaseRequestId: string | null;
  via: 'release_request' | 'edit_commit' | string;
  audience: ReleasePreview['audience'];
  released: true;
  confirmedByReread: boolean;
  releasedAt: number;
  note: string;
};

// ---------------------------------------------------------------------------------------------
// Who may, and the line

/** Preview and release: admin and up (`store.release`). A token must name the action; a person's role is enough. */
export const canRelease = (role: Role): boolean => can(role, 'store.release');

/** The share as the person types it ("10", "10%", "2.5") to a fraction for the request, or null when it is not one. */
export function parsePercent(text: string): number | null {
  const t = text.trim().replace(/%$/, '').trim().replace(',', '.');
  if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(t)) return null;
  const n = Number(t);
  if (!(n > 0) || n > 100) return null;
  return Math.round(n * 100) / 10000;
}

/** A fraction as a percent for words: 0.1 is "10%", 0.025 is "2.5%", 1 is "100%". */
export const percentText = (fraction: number): string => `${Math.round(fraction * 10000) / 100}%`;

/** The percent of a staged intended share (`0.1`) as the text of the input, or '' when it is not one. */
export function percentFromFraction(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const n = Number(value);
  if (!isFinite(n) || n <= 0 || n > 1) return '';
  return String(Math.round(n * 10000) / 100);
}

export type ReleaseLineInput = {
  role: Role;
  platform: Platform;
  state: StoreReleaseState | null;
  stateFailed: boolean;
  config: StoreReleaseConfig | null;
  configFailed: boolean;
  /** Google Play: the share the person typed; null until it is a valid percent. */
  fraction: number | null;
};

export type ReleaseLine =
  | { kind: 'hidden' }
  | { kind: 'note'; tone: 'neutral' | 'bad'; text: string; retry: boolean }
  | { kind: 'off'; text: string; note: string }
  | { kind: 'ready'; button: string; disabled: boolean; reason: string | null };

export const OFF_NOTE = (envName: string): string =>
  `Releasing from this tool is switched off on this server. Someone who runs it sets ${envName || RELEASE_ENV}=true and restarts it (see docs/api/releases-write.md). Meanwhile, release in ${'App Store Connect or Play Console'}.`;

/** What the release control of the Confirm step shows. Nothing for a role below admin. The button asks for a preview first. */
export function releaseLine(input: ReleaseLineInput): ReleaseLine {
  if (!canRelease(input.role)) return { kind: 'hidden' };
  if (input.stateFailed)
    return {
      kind: 'note',
      tone: 'bad',
      text: 'Could not check whether a release is running for this app.',
      retry: true,
    };
  if (input.configFailed)
    return {
      kind: 'note',
      tone: 'bad',
      text: 'Could not check whether releasing is switched on.',
      retry: true,
    };
  if (input.config === null || input.state === null)
    return {
      kind: 'ready',
      button: 'Release…',
      disabled: true,
      reason: 'Checking whether releasing is switched on.',
    };
  if (!input.config.enabled)
    return { kind: 'off', text: 'Releasing is switched off', note: OFF_NOTE(input.config.envName) };
  const unknown = input.state.unknownOutcome.release;
  const label = unknown
    ? 'Check the store, then preview…'
    : input.platform === 'android'
      ? 'Preview the release…'
      : 'Release…';
  if (input.state.inFlight.release || input.state.inFlight.push || input.state.inFlight.submit) {
    return {
      kind: 'ready',
      button: label,
      disabled: true,
      reason: 'A release, a push or a submit for this app is running.',
    };
  }
  if (input.platform === 'android' && input.fraction === null) {
    return {
      kind: 'ready',
      button: label,
      disabled: true,
      reason:
        'Type the share of users to release to first (for example 10). It is never filled in for you.',
    };
  }
  return { kind: 'ready', button: label, disabled: false, reason: null };
}

/** The request of the preview and the release: the same fields for both, so the hash holds. */
export function releaseBody(
  platform: Platform,
  input: {
    version?: string;
    track?: string;
    fraction: number | null;
    versionCodes?: string[];
    direct?: boolean;
  },
): ReleaseBody {
  if (platform === 'android') {
    return {
      ...(input.track ? { track: input.track } : {}),
      ...(input.fraction !== null ? { userFraction: input.fraction } : {}),
      ...(input.versionCodes && input.versionCodes.length > 0
        ? { versionCodes: input.versionCodes }
        : {}),
      ...(input.direct === true ? { direct: true } : {}),
    };
  }
  return input.version ? { version: input.version } : {};
}

// ---------------------------------------------------------------------------------------------
// The dialog

export function isReleasePreview(value: unknown): value is ReleasePreview {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const checks = v.checks as Record<string, unknown> | undefined;
  return (
    typeof v.app === 'object' &&
    v.app !== null &&
    Array.isArray(v.irreversible) &&
    typeof checks === 'object' &&
    checks !== null &&
    Array.isArray(checks.blocking)
  );
}

/** The confirm button needs: nothing blocks, a hash and a phrase, and the phrase typed exactly. */
export function canConfirmRelease(
  preview: Pick<ReleasePreview, 'checks' | 'confirmHash' | 'confirmation' | 'confirmationRequired'>,
  typed: string,
): boolean {
  if (preview.checks.blocking.length > 0 || !preview.checks.canRelease) return false;
  if (preview.confirmHash === null || preview.confirmation === null) return false;
  if (preview.confirmationRequired === false) return true;
  return confirmationMatches(typed, preview.confirmation.phrase);
}

/** The sentence that says what a direct release does (the server's own words, else built here for an older server). */
export function directText(preview: Pick<ReleasePreview, 'direct'>): string | null {
  const d = preview.direct;
  if (!d) return null;
  return d.summary.trim() !== '' ? d.summary : null;
}

export const storeConsole = (platform: Platform): string =>
  platform === 'android' ? 'Play Console' : 'App Store Connect';

/** Who gets the release, in a sentence. */
export const audienceText = (preview: Pick<ReleasePreview, 'audience'>): string =>
  preview.audience.description;

export function releaseTitle(
  preview: Pick<ReleasePreview, 'app' | 'version' | 'track' | 'audience'>,
): string {
  if (preview.app.platform === 'android') {
    const share = preview.audience.userFraction;
    return `${preview.track ?? 'the track'}${share !== null ? ` at ${percentText(share)}` : ''}`;
  }
  return preview.version?.versionString
    ? `Version ${preview.version.versionString}`
    : 'The version waiting for release';
}

// ---------------------------------------------------------------------------------------------
// Errors of the preview and the release

export type ReleaseFailure =
  | { kind: 'disabled'; message: string }
  | { kind: 'mismatch'; message: string }
  | { kind: 'blocked'; message: string; checks: ReleaseCheck[] }
  /** Nothing was released; `next` is the new preview that must be confirmed again. */
  | { kind: 'state_changed'; message: string; next: ReleasePreview | null }
  | { kind: 'write_in_progress'; message: string }
  | { kind: 'other_unknown'; message: string }
  /** Not known whether anything was released. The caller must NOT send the release again. */
  | { kind: 'outcome_unknown'; message: string }
  | { kind: 'not_applied'; message: string }
  | { kind: 'rate_limited'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'other'; message: string; code: string };

const bodyMessage = (error: ApiError): string =>
  typeof error.body.message === 'string' && error.body.message !== ''
    ? error.body.message
    : error.message;

export const UNKNOWN_RELEASE_HINT =
  'Do not release again yet. Look at the store console (App Store Connect or Play Console) to see whether the release went out, then preview again here: that only reads the store.';

export function classifyReleaseFailure(
  error: unknown,
  phase: 'preview' | 'release' = 'release',
  askedFraction: number | null = null,
): ReleaseFailure {
  const failure = classifyReleaseFailureBase(error, phase);
  // A refusal of the share itself (a staged rollout Google does not accept for this app): plain words, never retried by itself.
  // Only where the store said it did not apply the release; an unknown outcome keeps its own warning.
  if (
    error instanceof ApiError &&
    (failure.kind === 'other' || failure.kind === 'not_applied') &&
    (error.code === 'store_rejected' || error.code === 'write_failed')
  ) {
    const notice = fractionRefusalNotice(bodyMessage(error), askedFraction);
    if (notice !== null) return { ...failure, message: notice };
  }
  return failure;
}

function classifyReleaseFailureBase(error: unknown, phase: 'preview' | 'release'): ReleaseFailure {
  if (!(error instanceof ApiError))
    return {
      kind: 'other',
      code: 'error',
      message: 'The request failed. Check your connection, then read the state again.',
    };
  const message = bodyMessage(error);
  const body = error.body;
  switch (error.code) {
    case 'store_release_disabled':
      return {
        kind: 'disabled',
        message: `Releasing is switched off on this server (${RELEASE_ENV}). Nothing was released. Someone who runs the server sets ${RELEASE_ENV}=true and restarts it.`,
      };
    case 'forbidden':
      return { kind: 'forbidden', message: RELEASE_ROLE_REASON };
    case 'confirmation_mismatch': {
      const phrase = typeof body.phrase === 'string' ? body.phrase : null;
      return {
        kind: 'mismatch',
        message: `The text you typed is not the phrase.${phrase ? ` Type exactly: ${phrase}.` : ''} Nothing was read or released.`,
      };
    }
    case 'blocked':
      return {
        kind: 'blocked',
        checks: Array.isArray(body.checks) ? (body.checks as ReleaseCheck[]) : [],
        message:
          'Something blocks the release on the store as it is now. Nothing was released. Fix it, then preview again.',
      };
    case 'state_changed':
      return {
        kind: 'state_changed',
        next: isReleasePreview(body.preview) ? body.preview : null,
        message:
          'The store is not what you previewed (the version, the build, the draft release or the other releases of the track changed), so nothing was released. Read the new preview and confirm again.',
      };
    case 'write_in_progress':
      return {
        kind: 'write_in_progress',
        message: `${message} Nothing was released by this request. Wait a moment, then confirm again.`,
      };
    case 'push_outcome_unknown':
    case 'submit_outcome_unknown':
      return {
        kind: 'other_unknown',
        message: `${message} The last ${error.code === 'push_outcome_unknown' ? 'draft push' : 'submit'} has an unknown outcome, so nothing was released. Preview that one again first (that only reads the store), then come back.`,
      };
    case 'outcome_unknown':
      return { kind: 'outcome_unknown', message: `${message} ${UNKNOWN_RELEASE_HINT}` };
    case 'write_failed':
      return body.outcome === 'not_applied'
        ? {
            kind: 'not_applied',
            message: `${message} The store did not release the version. You can preview and confirm again.`,
          }
        : { kind: 'outcome_unknown', message: `${message} ${UNKNOWN_RELEASE_HINT}` };
    case 'changes_in_review':
      return {
        kind: 'other',
        code: error.code,
        message:
          'Google Play already has changes in review for this app. Nothing was released. Wait until they are decided. This tool never cancels a review.',
      };
    case 'track_required':
    case 'user_fraction_required':
    case 'invalid_user_fraction':
    case 'invalid_version_codes':
    case 'not_applicable':
    case 'ambiguous_version':
      return { kind: 'other', code: error.code, message };
    case 'rate_limited':
      return {
        kind: 'rate_limited',
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
        message: `${message} The store could not be reached before anything was sent; nothing was released.`,
      };
    case 'timeout':
      return {
        kind: 'other',
        code: error.code,
        message:
          'A read of the store did not answer in time. If you are unsure whether the release went out, preview again (that reads the store) and check the store console.',
      };
    case 'app_not_synced':
      return { kind: 'other', code: error.code, message: `${message} Sync the app first.` };
    default:
  }
  if (error.code.startsWith('credential_')) return { kind: 'other', code: error.code, message };
  // The release may have reached the server and the answer was lost: a cut connection, or a 5xx without a known code.
  if (phase === 'release' && (error.status === 0 || error.status >= 500)) {
    return {
      kind: 'outcome_unknown',
      message: `${error.status === 0 ? 'The connection broke while the release was running, so it is not known whether the server received it.' : message} ${UNKNOWN_RELEASE_HINT}`,
    };
  }
  return { kind: 'other', code: error.code, message };
}

/** The person may confirm the same preview again without a new read: nothing was sent, or the store did not apply it. Never after an unknown outcome. */
export const mayConfirmAgain = (failure: ReleaseFailure): boolean =>
  failure.kind === 'mismatch' ||
  failure.kind === 'write_in_progress' ||
  failure.kind === 'not_applied';

export const shouldReloadState = (failure: ReleaseFailure): boolean =>
  failure.kind === 'outcome_unknown' ||
  failure.kind === 'other_unknown' ||
  failure.kind === 'disabled' ||
  failure.kind === 'state_changed' ||
  failure.kind === 'blocked' ||
  failure.kind === 'not_applied';

/** The sentence after a successful release. */
export function resultText(result: ReleaseResult): string {
  const how = result.confirmedByReread
    ? ' The answer of the store was lost, and reading it back shows the release went out.'
    : '';
  if (result.app.platform === 'android') {
    const share = result.audience.userFraction;
    return `Release started on ${result.track ?? 'the track'}${share !== null ? ` at ${percentText(share)} of users` : ''}.${how} ${result.note}`.trim();
  }
  return `${result.version?.versionString ? `Version ${result.version.versionString}` : 'The version'} was released.${how} ${result.note}`.trim();
}
