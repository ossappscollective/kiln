import { can, type Platform, platformMeta, type Role, supports } from '@kiln/core';
import { ApiError } from './api.ts';
import { formatPercent } from './i18n/format.ts';
import { k, t } from './i18n/t.ts';

/**
 * Submitting the pushed draft for the store's review (docs/api/submit.md, docs/adr/0010-store-submit.md): the
 * types of the API that the web app owns, and the pure logic of the "ready to submit" line, the preview
 * dialog and the errors. A submit is a store write that CANNOT be taken back from this tool, and it never
 * releases or publishes anything. The server decides every rule; what is checked here only explains things.
 * Written for the ES2017 web build: no flatMap, no fromEntries.
 */

export const SUBMIT_ENV = 'KILN_STORE_SUBMIT_ENABLED';

/** A message key: show it with `t(SUBMIT_ROLE_REASON)`. */
export const SUBMIT_ROLE_REASON = k('release-store:submit.roleReason');

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
  releases: {
    name: string | null;
    status: string | null;
    userFraction: number | null;
    versionCodes: (number | string)[];
  }[];
};

export type SubmitLocale = {
  locale: string;
  textFields: number;
  screenshotSets: { target: string; device: string | null; images: number }[];
};

export type SubmitPreview = {
  app: { id: string; name: string; platform: Platform; store: string };
  version: {
    id: string;
    versionString: string | null;
    state: string | null;
    releaseType: string | null;
  } | null;
  build: {
    id: string;
    version: string | null;
    processingState: string | null;
    expired: boolean;
  } | null;
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
  /** False when the person's own confirmation (password or passkey) stands in for the typed phrase. Older servers omit it: the phrase is needed. */
  confirmationRequired?: boolean;
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

export const storeLabel = (platform: Platform): string =>
  t('release-store:submit.storeReview', { store: platformMeta(platform).storeName });

/** What a submit never does, for the dialog and the result. */
export const releaseStatement = (platform: Platform): string =>
  !supports(platform, 'releaseTracks')
    ? t('release-store:submit.statementApple')
    : t('release-store:submit.statementGoogle');

export const OFF_NOTE = (envName: string): string =>
  t('release-store:submit.offNote', { env: envName || SUBMIT_ENV });

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
      ? {
          kind: 'note',
          tone: 'bad',
          text: t('release-store:submit.line.checkFailed'),
          retry: true,
        }
      : { kind: 'hidden' };
  }
  const unknown = input.state.unknownOutcome.submit;
  if (!input.state.pushed && !unknown) return { kind: 'hidden' };
  const text = unknown
    ? t('release-store:submit.line.unknown')
    : t('release-store:submit.line.ready');
  if (input.configFailed)
    return {
      kind: 'note',
      tone: 'bad',
      text: t('release-store:submit.line.configFailed', { text }),
      retry: true,
    };
  if (input.config === null)
    return {
      kind: 'ready',
      text,
      button: t('release-store:submit.line.button'),
      disabled: true,
      reason: t('release-store:submit.line.checking'),
    };
  if (!input.config.enabled) {
    return {
      kind: 'off',
      text: unknown ? text : t('release-store:submit.line.off'),
      note: OFF_NOTE(input.config.envName),
    };
  }
  if (input.state.inFlight.submit || input.state.inFlight.push) {
    return {
      kind: 'ready',
      text,
      button: t('release-store:submit.line.button'),
      disabled: true,
      reason: t('release-store:submit.line.running'),
    };
  }
  if (unknown) {
    return {
      kind: 'ready',
      text,
      button: t('release-store:submit.line.checkThenPreview'),
      disabled: false,
      reason: null,
    };
  }
  return {
    kind: 'ready',
    text,
    button: t('release-store:submit.line.button'),
    disabled: false,
    reason: null,
  };
}

/** The muted detail after the line: "2.1 · pushed 3 hours ago by Ana". */
export function pushDetail(push: SubmitPushRecord | null, ago: (at: number) => string): string {
  if (push === null) return '';
  const parts: string[] = [];
  if (push.versionString) parts.push(push.versionString);
  parts.push(
    push.pushedBy
      ? t('release-store:submit.pushedAgoBy', { ago: ago(push.pushedAt), name: push.pushedBy })
      : t('release-store:submit.pushedAgo', { ago: ago(push.pushedAt) }),
  );
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------------------------
// The preview

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
  if (v === null)
    return supports(preview.app.platform, 'releaseTracks')
      ? t('release-store:submit.version.googleHeld')
      : t('release-store:submit.version.none');
  const named = v.versionString !== null && v.versionString !== '';
  const head = v.state
    ? named
      ? t('release-store:submit.version.namedState', { version: v.versionString, state: v.state })
      : t('release-store:submit.version.unnamedState', { state: v.state })
    : named
      ? t('release-store:submit.version.named', { version: v.versionString })
      : t('release-store:submit.version.unnamed');
  const parts: string[] = [head];
  if (v.releaseType)
    parts.push(t('release-store:submit.version.releaseType', { type: v.releaseType }));
  return parts.join(', ');
}

export function buildLine(build: SubmitPreview['build']): string | null {
  if (build === null) return null;
  const parts: string[] = [
    build.version
      ? t('release-store:submit.build.named', { version: build.version })
      : t('release-store:submit.build.unnamed'),
  ];
  if (build.processingState) parts.push(build.processingState);
  if (build.expired) parts.push(t('release-store:submit.build.expired'));
  return parts.join(', ');
}

/** "en-US: 5 text fields, 2 screenshot sets (8 images)". */
export function localeLine(locale: SubmitLocale): string {
  const sets = locale.screenshotSets;
  const images = sets.reduce((n, s) => n + s.images, 0);
  const shots =
    sets.length === 0
      ? t('release-store:submit.locale.noShots')
      : t('release-store:submit.locale.sets', {
          count: sets.length,
          images: t('release-store:submit.locale.images', { count: images }),
        });
  return t('release-store:submit.locale.line', {
    locale: locale.locale,
    fields: t('release-store:submit.locale.fields', { count: locale.textFields }),
    shots,
  });
}

export function pushedText(push: SubmitPushRecord | null): string {
  if (push === null) return '';
  return t('release-store:submit.pushed.line', {
    texts: t('release-store:submit.pushed.texts', { count: push.texts }),
    sets: t('release-store:submit.pushed.sets', { count: push.assetSets }),
  });
}

export function trackLine(track: SubmitTrack): string {
  const releases = track.releases.map((r) => {
    const parts: string[] = [r.name ?? t('release-store:submit.track.unnamed')];
    if (r.status) parts.push(r.status);
    if (r.userFraction !== null && r.userFraction !== undefined)
      parts.push(
        t('release-store:submit.track.share', {
          share: formatPercent(r.userFraction, { maximumFractionDigits: 2 }),
        }),
      );
    if (r.versionCodes.length > 0)
      parts.push(
        t('release-store:submit.track.codes', {
          count: r.versionCodes.length,
          codes: r.versionCodes.join(', '),
        }),
      );
    return parts.join(', ');
  });
  return t('release-store:submit.track.line', {
    track: track.track,
    releases: releases.length === 0 ? t('release-store:submit.track.none') : releases.join('; '),
  });
}

/** A check as one sentence: the message, and where (locale, item) when the server names it. */
export function checkText(check: SubmitCheck): string {
  const where = [check.locale, check.item]
    .filter((p): p is string => typeof p === 'string' && p !== '')
    .join(' / ');
  return where === ''
    ? check.message
    : t('release-store:submit.check.where', { message: check.message, where });
}

// ---------------------------------------------------------------------------------------------
// The typed confirmation

/** The server ignores surrounding spaces and compares case-sensitively; so does this. */
export const confirmationMatches = (typed: string, phrase: string | null): boolean =>
  phrase !== null && phrase.trim() !== '' && typed.trim() === phrase.trim();

/** What the confirm button needs: nothing blocks, the preview carries a hash and a phrase, and the phrase was typed. */
export function canConfirmSubmit(
  preview: Pick<SubmitPreview, 'checks' | 'confirmHash' | 'confirmation' | 'confirmationRequired'>,
  typed: string,
): boolean {
  if (preview.checks.blocking.length > 0 || !preview.checks.canSubmit) return false;
  if (preview.confirmHash === null || preview.confirmation === null) return false;
  if (preview.confirmationRequired === false) return true;
  return confirmationMatches(typed, preview.confirmation.phrase);
}

/** The request of the submit: the typed text is sent as the person typed it (the server trims it). */
export function submitBody(
  preview: Pick<SubmitPreview, 'confirmHash'>,
  typed: string,
): { confirmHash: string; confirmation: string } | null {
  return preview.confirmHash === null
    ? null
    : { confirmHash: preview.confirmHash, confirmation: typed };
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

const bodyMessage = (error: ApiError): string =>
  typeof error.body.message === 'string' && error.body.message !== ''
    ? error.body.message
    : error.message;

/** A message key: show it with `t(UNKNOWN_SUBMIT_HINT)`. */
export const UNKNOWN_SUBMIT_HINT = k('release-store:submit.unknownHint');

const withHint = (message: string): string =>
  t('release-store:submit.fail.withHint', { message, hint: t(UNKNOWN_SUBMIT_HINT) });

/**
 * Sorts an error of the preview or the submit. Nothing here retries. `outcome_unknown`, and a cut connection or
 * a 5xx during the submit, are final for that attempt: this app never sends the submit again by itself.
 */
export function classifySubmitFailure(
  error: unknown,
  phase: 'preview' | 'submit' = 'submit',
): SubmitFailure {
  if (!(error instanceof ApiError))
    return {
      kind: 'other',
      code: 'error',
      message: t('release-store:submit.fail.request'),
    };
  const message = bodyMessage(error);
  const body = error.body;
  switch (error.code) {
    case 'store_submit_disabled':
      return {
        kind: 'disabled',
        message: t('release-store:submit.fail.disabled', { env: SUBMIT_ENV }),
      };
    case 'forbidden':
      return { kind: 'forbidden', message: t(SUBMIT_ROLE_REASON) };
    case 'nothing_pushed':
      return {
        kind: 'nothing_pushed',
        message: t('release-store:submit.fail.nothingPushed'),
      };
    case 'confirmation_mismatch': {
      const phrase = typeof body.phrase === 'string' ? body.phrase : null;
      return {
        kind: 'mismatch',
        message: phrase
          ? t('release-store:submit.fail.mismatchPhrase', { phrase })
          : t('release-store:submit.fail.mismatch'),
      };
    }
    case 'blocked': {
      const checks = Array.isArray(body.checks) ? (body.checks as SubmitCheck[]) : [];
      return {
        kind: 'blocked',
        checks,
        message: t('release-store:submit.fail.blocked'),
      };
    }
    case 'state_changed':
      return {
        kind: 'state_changed',
        next: isSubmitPreview(body.preview) ? body.preview : null,
        message: t('release-store:submit.fail.stateChanged'),
      };
    case 'write_in_progress':
      return {
        kind: 'write_in_progress',
        message: t('release-store:submit.fail.writeInProgress', { message }),
      };
    case 'push_outcome_unknown':
      return {
        kind: 'push_unknown',
        message: t('release-store:submit.fail.pushUnknown'),
      };
    case 'outcome_unknown':
      return { kind: 'outcome_unknown', message: withHint(message) };
    case 'write_failed':
      return body.outcome === 'not_applied'
        ? {
            kind: 'not_applied',
            message: t('release-store:submit.fail.notApplied', { message }),
          }
        : { kind: 'outcome_unknown', message: withHint(message) };
    case 'changes_in_review':
      return {
        kind: 'other',
        code: error.code,
        message: t('release-store:submit.fail.changesInReview'),
      };
    case 'no_editable_version':
      return {
        kind: 'other',
        code: error.code,
        message: t('release-store:submit.fail.noEditable', { message }),
      };
    case 'rate_limited':
      return {
        kind: 'rate_limited',
        retryAfter: error.retryAfter ?? null,
        message: error.retryAfter
          ? t('release-store:submit.fail.rateLimitedSeconds', { count: error.retryAfter })
          : t('release-store:submit.fail.rateLimited'),
      };
    case 'store_auth':
    case 'store_forbidden':
    case 'store_not_found':
    case 'store_rejected':
      return {
        kind: 'other',
        code: error.code,
        message: t('release-store:submit.fail.refused', { message }),
      };
    case 'store_unavailable':
      return {
        kind: 'other',
        code: error.code,
        message: t('release-store:submit.fail.unavailable', { message }),
      };
    case 'timeout':
      return {
        kind: 'other',
        code: error.code,
        message: t('release-store:submit.fail.timeout'),
      };
    case 'app_not_synced':
      return {
        kind: 'other',
        code: error.code,
        message: t('release-store:submit.fail.syncFirst', { message }),
      };
    default:
  }
  if (error.code.startsWith('credential_')) return { kind: 'other', code: error.code, message };
  // The submit may have reached the server and the answer was lost: a cut connection, or a 5xx without a known code.
  if (phase === 'submit' && (error.status === 0 || error.status >= 500)) {
    return {
      kind: 'outcome_unknown',
      message: withHint(
        error.status === 0 ? t('release-store:submit.fail.connectionBroke') : message,
      ),
    };
  }
  return { kind: 'other', code: error.code, message };
}

/** The person may confirm the same preview again without a new read: nothing was sent, or the store did not apply it. Never after an unknown outcome. */
export const mayConfirmAgain = (failure: SubmitFailure): boolean =>
  failure.kind === 'mismatch' ||
  failure.kind === 'write_in_progress' ||
  failure.kind === 'not_applied';

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
  const version = result.version?.versionString ?? '';
  const google = supports(result.app.platform, 'releaseTracks');
  const sent = google
    ? version
      ? t('release-store:submit.result.sentGoogleVersion', { version })
      : t('release-store:submit.result.sentGoogle')
    : version
      ? t('release-store:submit.result.sentAppleVersion', { version })
      : t('release-store:submit.result.sentApple');
  // Each part is a whole sentence of its own, so they are joined with a space.
  const parts = [sent];
  if (result.confirmedByReread) parts.push(t('release-store:submit.result.reread'));
  if (result.submission?.state)
    parts.push(t('release-store:submit.result.state', { state: result.submission.state }));
  parts.push(t('release-store:submit.result.nothingReleased'));
  return parts.join(' ');
}
