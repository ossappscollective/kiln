import {
  byFamily,
  can,
  fractionRefusalNotice,
  type Platform,
  type Role,
  supports,
} from '@kiln/core';
import { ApiError } from './api.ts';
import { formatPercent } from './i18n/format.ts';
import { k, t } from './i18n/t.ts';
import { type Msg, msg, msgText, rawMsg } from './message.ts';
import { confirmationMatches } from './store-submit.ts';

/**
 * Releasing (docs/api/releases-write.md, docs/adr/0014-release-management.md): the one store write that cannot be taken
 * back. It makes an approved App Store version available, or starts a Google Play draft release at a share of users the person
 * NAMES (never implied). The types of the API, the line of the Confirm step, the typed phrase and the errors. The server decides
 * every rule; what is checked here only explains things. Nothing here sends anything, and nothing is retried.
 * Written for the ES2017 web build: no flatMap, no fromEntries.
 */

export const RELEASE_ENV = 'KILN_STORE_RELEASE_ENABLED';
/** A message key: show it with `t(RELEASE_ROLE_REASON)`. */
export const RELEASE_ROLE_REASON = k('release-store:rel.roleReason');

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
  const typed = text.trim().replace(/%$/, '').trim().replace(',', '.');
  if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(typed)) return null;
  const n = Number(typed);
  if (!(n > 0) || n > 100) return null;
  return Math.round(n * 100) / 10000;
}

/** A fraction as a percent for words: 0.1 is "10%", 0.025 is "2.5%", 1 is "100%". */
export const percentText = (fraction: number): string =>
  formatPercent(fraction, { maximumFractionDigits: 2 });

/** The percent of a staged intended share (`0.1`) as the text of the input, or '' when it is not one. */
export function percentFromFraction(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return '';
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
  t('release-store:rel.offNote', {
    env: envName || RELEASE_ENV,
    console: t('release-store:rel.consoles'),
  });

/** What the release control of the Confirm step shows. Nothing for a role below admin. The button asks for a preview first. */
export function releaseLine(input: ReleaseLineInput): ReleaseLine {
  if (!canRelease(input.role)) return { kind: 'hidden' };
  if (input.stateFailed)
    return {
      kind: 'note',
      tone: 'bad',
      text: t('release-store:rel.line.stateFailed'),
      retry: true,
    };
  if (input.configFailed)
    return {
      kind: 'note',
      tone: 'bad',
      text: t('release-store:rel.line.configFailed'),
      retry: true,
    };
  if (input.config === null || input.state === null)
    return {
      kind: 'ready',
      button: t('release-store:rel.line.button'),
      disabled: true,
      reason: t('release-store:rel.line.checking'),
    };
  if (!input.config.enabled)
    return {
      kind: 'off',
      text: t('release-store:rel.line.off'),
      note: OFF_NOTE(input.config.envName),
    };
  const unknown = input.state.unknownOutcome.release;
  const label = unknown
    ? t('release-store:rel.line.checkThenPreview')
    : supports(input.platform, 'releaseTracks')
      ? t('release-store:rel.line.previewButton')
      : t('release-store:rel.line.button');
  if (input.state.inFlight.release || input.state.inFlight.push || input.state.inFlight.submit) {
    return {
      kind: 'ready',
      button: label,
      disabled: true,
      reason: t('release-store:rel.line.running'),
    };
  }
  if (supports(input.platform, 'releaseTracks') && input.fraction === null) {
    return {
      kind: 'ready',
      button: label,
      disabled: true,
      reason: t('release-store:rel.line.typeShare'),
    };
  }
  return { kind: 'ready', button: label, disabled: false, reason: null };
}

/** The request of the preview and the release: the same fields for both, so the hash holds. */
export function releaseBody(
  platform: Platform,
  input: {
    version?: string | undefined;
    track?: string | undefined;
    fraction: number | null;
    versionCodes?: string[] | undefined;
    direct?: boolean | undefined;
  },
): ReleaseBody {
  if (supports(platform, 'releaseTracks')) {
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
  byFamily(platform, { apple: 'App Store Connect', google: 'Play Console' });

/** Who gets the release, in a sentence. */
export const audienceText = (preview: Pick<ReleasePreview, 'audience'>): string =>
  preview.audience.description;

export function releaseTitle(
  preview: Pick<ReleasePreview, 'app' | 'version' | 'track' | 'audience'>,
): string {
  if (supports(preview.app.platform, 'releaseTracks')) {
    const share = preview.audience.userFraction;
    const track = preview.track ?? t('release-store:rel.title.theTrack');
    return share !== null
      ? t('release-store:rel.title.trackAt', { track, share: percentText(share) })
      : track;
  }
  return preview.version?.versionString
    ? t('release-store:rel.title.versionNamed', { version: preview.version.versionString })
    : t('release-store:rel.title.versionWaiting');
}

// ---------------------------------------------------------------------------------------------
// Errors of the preview and the release

export type ReleaseFailure = (
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
  | { kind: 'other'; message: string; code: string }
) & {
  /** The same `message` as a value that is written when it is drawn, so it follows a language change. */
  text: Msg;
};

const bodyMessage = (error: ApiError): string =>
  typeof error.body.message === 'string' && error.body.message !== ''
    ? error.body.message
    : error.message;

/** A message key: show it with `t(UNKNOWN_RELEASE_HINT)`. */
export const UNKNOWN_RELEASE_HINT = k('release-store:rel.unknownHint');

const withHint = (inner: Msg): Msg =>
  msg(k('release-store:rel.fail.withHint'), () => ({
    message: msgText(inner),
    hint: t(UNKNOWN_RELEASE_HINT),
  }));

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
    if (notice !== null) {
      const text = msg(k('core:play.fractionRefused'));
      return { ...failure, message: msgText(text), text };
    }
  }
  return failure;
}

function classifyReleaseFailureBase(error: unknown, phase: 'preview' | 'release'): ReleaseFailure {
  // The message of a failure is written now and kept as a `Msg` too, so a screen can write it again after a language change.
  const fail = (kind: 'other', text: Msg, code: string): ReleaseFailure => ({
    kind,
    code,
    message: msgText(text),
    text,
  });
  const plain = (
    kind: Exclude<ReleaseFailure['kind'], 'other' | 'blocked' | 'state_changed'>,
    text: Msg,
  ): ReleaseFailure => ({ kind, message: msgText(text), text });
  if (!(error instanceof ApiError))
    return fail('other', msg(k('release-store:rel.fail.request')), 'error');
  const message = bodyMessage(error);
  const raw = rawMsg(message);
  const code = error.code;
  const body = error.body;
  switch (code) {
    case 'store_release_disabled':
      return plain(
        'disabled',
        msg(k('release-store:rel.fail.disabled'), () => ({ env: RELEASE_ENV })),
      );
    case 'forbidden':
      return plain('forbidden', msg(RELEASE_ROLE_REASON));
    case 'confirmation_mismatch': {
      const phrase = typeof body.phrase === 'string' ? body.phrase : null;
      return plain(
        'mismatch',
        phrase
          ? msg(k('release-store:rel.fail.mismatchPhrase'), () => ({ phrase }))
          : msg(k('release-store:rel.fail.mismatch')),
      );
    }
    case 'blocked': {
      const text = msg(k('release-store:rel.fail.blocked'));
      return {
        kind: 'blocked',
        checks: Array.isArray(body.checks) ? (body.checks as ReleaseCheck[]) : [],
        message: msgText(text),
        text,
      };
    }
    case 'state_changed': {
      const text = msg(k('release-store:rel.fail.stateChanged'));
      return {
        kind: 'state_changed',
        next: isReleasePreview(body.preview) ? body.preview : null,
        message: msgText(text),
        text,
      };
    }
    case 'write_in_progress':
      return plain(
        'write_in_progress',
        msg(k('release-store:rel.fail.writeInProgress'), () => ({ message })),
      );
    case 'push_outcome_unknown':
    case 'submit_outcome_unknown':
      return plain(
        'other_unknown',
        code === 'push_outcome_unknown'
          ? msg(k('release-store:rel.fail.pushUnknown'), () => ({ message }))
          : msg(k('release-store:rel.fail.submitUnknown'), () => ({ message })),
      );
    case 'outcome_unknown':
      return plain('outcome_unknown', withHint(raw));
    case 'write_failed':
      return body.outcome === 'not_applied'
        ? plain(
            'not_applied',
            msg(k('release-store:rel.fail.notApplied'), () => ({ message })),
          )
        : plain('outcome_unknown', withHint(raw));
    case 'changes_in_review':
      return fail('other', msg(k('release-store:rel.fail.changesInReview')), code);
    case 'track_required':
    case 'user_fraction_required':
    case 'invalid_user_fraction':
    case 'invalid_version_codes':
    case 'not_applicable':
    case 'ambiguous_version':
      return fail('other', raw, code);
    case 'rate_limited': {
      const seconds = error.retryAfter;
      return plain(
        'rate_limited',
        seconds
          ? msg(k('release-store:submit.fail.rateLimitedSeconds'), () => ({ count: seconds }))
          : msg(k('release-store:submit.fail.rateLimited')),
      );
    }
    case 'store_auth':
    case 'store_forbidden':
    case 'store_not_found':
    case 'store_rejected':
      return fail(
        'other',
        msg(k('release-store:submit.fail.refused'), () => ({ message })),
        code,
      );
    case 'store_unavailable':
      return fail(
        'other',
        msg(k('release-store:rel.fail.unavailable'), () => ({ message })),
        code,
      );
    case 'timeout':
      return fail('other', msg(k('release-store:rel.fail.timeout')), code);
    case 'app_not_synced':
      return fail(
        'other',
        msg(k('release-store:submit.fail.syncFirst'), () => ({ message })),
        code,
      );
    default:
  }
  if (code.startsWith('credential_')) return fail('other', raw, code);
  // The release may have reached the server and the answer was lost: a cut connection, or a 5xx without a known code.
  if (phase === 'release' && (error.status === 0 || error.status >= 500)) {
    return plain(
      'outcome_unknown',
      withHint(error.status === 0 ? msg(k('release-store:rel.fail.connectionBroke')) : raw),
    );
  }
  return fail('other', raw, code);
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
  // Each part is a whole sentence (the last one comes from the server), so they are joined with a space.
  const how = result.confirmedByReread ? t('release-store:rel.result.reread') : '';
  let first: string;
  if (supports(result.app.platform, 'releaseTracks')) {
    const share = result.audience.userFraction;
    const track = result.track ?? t('release-store:rel.title.theTrack');
    first =
      share !== null
        ? t('release-store:rel.result.startedAt', { track, share: percentText(share) })
        : t('release-store:rel.result.started', { track });
  } else {
    first = result.version?.versionString
      ? t('release-store:rel.result.versionReleased', { version: result.version.versionString })
      : t('release-store:rel.result.theVersionReleased');
  }
  return [first, how, result.note].filter((part) => part !== '').join(' ');
}
