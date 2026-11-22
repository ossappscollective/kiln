import { byFamily, can, type Platform, platformMeta, type Role, supports } from '@kiln/core';
import { ApiError } from './api.ts';
import { k, t } from './i18n/t.ts';
import { formatRollout, trackLabel } from './portfolio.ts';
import type { AppSummary, ReleaseSummary } from './types.ts';

/**
 * Store rollout controls (docs/api/rollout.md, docs/adr/0008-store-rollout-writes.md): the types of the
 * API and the pure logic of the controls. This changes who receives an update in the LIVE store, so
 * everything here is about being sure: preview first, the exact change shown, a typed confirmation
 * for what cannot be undone, and an unknown outcome is settled by looking, never by sending again.
 *
 * The server decides every rule; the checks here only explain things before a request.
 * Written for the ES2017 web build.
 */

export const ROLLOUT_ENV = 'KILN_STORE_ROLLOUT_ENABLED';

/** The sentence a confirmation must show, word for word (docs/ux-ia.md, section 5). */
/** Message keys: show them with `t(...)`. */
export const LIVE_STORE_WARNING = k('release-store:rollout.liveWarning');

export const IRREVERSIBLE_WARNING = k('release-store:rollout.irreversible');

export type RolloutAction =
  | 'set_fraction'
  | 'halt'
  | 'resume'
  | 'complete'
  | 'pause'
  | 'release_to_all';

export type RolloutConfig = {
  enabled: boolean;
  envName: string;
  actions: { android: string[]; ios: string[] };
  irreversible: string[];
  fraction: { exclusiveMin: number; exclusiveMax: number };
};

export type PlayRolloutState = {
  store: 'googleplay';
  platform: 'android';
  track: string;
  versionCodes: string[];
  name: string | null;
  status: string;
  userFraction: number | null;
  otherReleases: number;
};

export type AppleRolloutState = {
  store: 'appstoreconnect';
  platform: 'ios' | 'macos';
  version: string;
  storeVersionId: string;
  versionState: string | null;
  phasedReleaseId: string | null;
  phasedReleaseState: string | null;
  currentDayNumber: number | null;
  startDate: number | null;
  totalPauseDays: number | null;
};

export type RolloutState = PlayRolloutState | AppleRolloutState;

export type RolloutAppRef = { id: string; name: string; platform: Platform; store: string };

export type AllowedAction = {
  action: string;
  allowed: boolean;
  reason?: string;
  irreversible: boolean;
};

export type RolloutStateView = {
  app: RolloutAppRef;
  current: RolloutState;
  allowedActions: AllowedAction[];
  minUserFraction: number | null;
  readAt: number;
};

/** The change and the release it is about: what preview takes, and apply with a `confirmHash`. */
export type RolloutRequest = {
  action: string;
  track?: string;
  versionCodes?: string[];
  version?: string;
  userFraction?: number;
};

export type RolloutPreview = {
  app: RolloutAppRef;
  action: string;
  target: { track?: string; versionCodes?: string[]; version?: string };
  current: RolloutState;
  proposed: RolloutState;
  summary: string;
  irreversible: boolean;
  confirmHash: string;
  warnings: string[];
  readAt: number;
};

export type RolloutResult = {
  app: RolloutAppRef;
  action: string;
  before: RolloutState;
  after: RolloutState;
  irreversible: boolean;
  confirmedByReread: boolean;
  appliedAt: number;
  note: string;
};

// ---------------------------------------------------------------------------------------------
// Who sees the controls

/** Admin and owner only (`releases.rollout`). Everyone else sees nothing: the controls are not theirs. */
export const canRollout = (role: Role): boolean => can(role, 'releases.rollout');

export type ControlsAvailability =
  | { state: 'hidden' }
  | { state: 'loading' }
  | { state: 'unknown'; message: string }
  | { state: 'off'; message: string }
  | { state: 'ready' };

/** What the section shows: nothing for a role without the right, a note while the feature is off. */
export function controlsAvailability(
  role: Role,
  config: RolloutConfig | null,
  loadFailed: boolean,
): ControlsAvailability {
  if (!canRollout(role)) return { state: 'hidden' };
  if (loadFailed) {
    return {
      state: 'unknown',
      message: t('release-store:rollout.controls.unknown'),
    };
  }
  if (!config) return { state: 'loading' };
  if (!config.enabled) {
    return {
      state: 'off',
      message: t('release-store:rollout.controls.off', { env: config.envName || ROLLOUT_ENV }),
    };
  }
  return { state: 'ready' };
}

// ---------------------------------------------------------------------------------------------
// What a control can target

export type RolloutTarget = {
  key: string;
  label: string;
  /** The fields of every request for this release (`track` and `versionCodes`, or `version`). */
  base: { track?: string; versionCodes?: string[]; version?: string };
};

const inFlight = (r: ReleaseSummary): number =>
  r.status === 'rolling_out' || r.status === 'halted' ? 0 : r.status === 'live' ? 1 : 2;

/**
 * The releases of one app that a rollout change can name: Google Play releases with a track and version
 * codes, App Store versions. In-flight releases come first (rolling out, halted), then live ones.
 */
export function rolloutTargets(
  app: Pick<AppSummary, 'platform'>,
  releases: readonly ReleaseSummary[],
): RolloutTarget[] {
  const list: ReleaseSummary[] = [];
  for (const r of releases) {
    if (r.platform !== app.platform) continue;
    if (
      supports(app.platform, 'releaseTracks') &&
      (r.track === null || (r.versionCodes ?? []).length === 0)
    )
      continue;
    list.push(r);
  }
  const ordered = list
    .map((r, index) => ({ r, index }))
    .sort((a, b) => inFlight(a.r) - inFlight(b.r) || a.index - b.index)
    .map((x) => x.r);
  return ordered.map((r) => {
    if (supports(app.platform, 'releaseTracks')) {
      const codes = [...(r.versionCodes ?? [])].sort();
      const share = formatRollout(r.rolloutFraction);
      const params = {
        version: r.version,
        track: trackLabel(r.track),
        codes: codes.join(', '),
        share,
      };
      return {
        key: `${r.track}/${codes.join(',')}`,
        label: share
          ? t('release-store:rollout.target.googleShare', params)
          : t('release-store:rollout.target.google', params),
        base: { track: r.track as string, versionCodes: codes },
      };
    }
    return {
      key: r.version,
      label: t('release-store:rollout.target.apple', {
        version: r.version,
        state: r.rawState || 'App Store',
      }),
      base: { version: r.version },
    };
  });
}

/** The query of `GET .../rollout/state`. */
export function stateQuery(base: RolloutTarget['base']): string {
  const query: string[] = [];
  if (base.track !== undefined) query.push(`track=${encodeURIComponent(base.track)}`);
  if (base.versionCodes !== undefined && base.versionCodes.length > 0) {
    query.push(`versionCodes=${base.versionCodes.map(encodeURIComponent).join(',')}`);
  }
  if (base.version !== undefined) query.push(`version=${encodeURIComponent(base.version)}`);
  return query.join('&');
}

// ---------------------------------------------------------------------------------------------
// Actions

const ACTION_LABELS: Record<string, string> = {
  set_fraction: k('release-store:rollout.action.setFraction'),
  halt: k('release-store:rollout.action.halt'),
  resume: k('release-store:rollout.action.resume'),
  complete: k('release-store:rollout.action.complete'),
  pause: k('release-store:rollout.action.pause'),
  release_to_all: k('release-store:rollout.action.releaseToAll'),
};

export const actionLabel = (action: string, platform: Platform): string => {
  if (action === 'resume' && supports(platform, 'phasedRelease'))
    return t('release-store:rollout.action.resumePhased');
  const key = ACTION_LABELS[action];
  return key === undefined ? action : t(key);
};

/** What the actions of an app are, in the order of the buttons; the server's `config.actions` decides which exist. */
/** Apple's actions (`ios` in the config) apply to iOS and macOS alike. */
export function actionsFor(config: Pick<RolloutConfig, 'actions'>, platform: Platform): string[] {
  const list = byFamily(platform, { apple: config.actions.ios, google: config.actions.android });
  return [...list];
}

export type ActionButton = {
  action: string;
  label: string;
  disabled: boolean;
  reason: string | null;
  irreversible: boolean;
};

/** The buttons for the state that was read: an action the store state does not allow is disabled with the server's reason. */
export function actionButtons(
  config: Pick<RolloutConfig, 'actions' | 'irreversible'>,
  platform: Platform,
  state: Pick<RolloutStateView, 'allowedActions'> | null,
  blocked: string | null,
): ActionButton[] {
  return actionsFor(config, platform).map((action) => {
    const allowed = state?.allowedActions.filter((a) => a.action === action)[0];
    const irreversible = allowed
      ? allowed.irreversible || config.irreversible.indexOf(action) >= 0
      : config.irreversible.indexOf(action) >= 0;
    let reason: string | null = null;
    if (blocked !== null) reason = blocked;
    else if (!state) reason = t('release-store:rollout.button.readFirst');
    else if (!allowed) reason = t('release-store:rollout.button.notOffered');
    else if (!allowed.allowed)
      reason = allowed.reason ?? t('release-store:rollout.button.notAllowed');
    return {
      action,
      label: actionLabel(action, platform),
      disabled: reason !== null,
      reason,
      irreversible,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// The share to set (Google Play)

export type FractionCheck = { ok: true; fraction: number } | { ok: false; message: string };

/**
 * A percentage typed by a person ("25", "12.5") as the fraction the API wants: more than 0, less than 1,
 * at most 4 decimals, and (Google Play only goes up) above `min` when the store's share is known.
 */
export function parsePercent(input: string, min: number | null): FractionCheck {
  const text = input.trim().replace(/%$/, '').trim().replace(',', '.');
  if (text === '') return { ok: false, message: t('release-store:rollout.percent.enter') };
  if (!/^\d+(\.\d+)?$/.test(text))
    return { ok: false, message: t('release-store:rollout.percent.number') };
  const percent = Number(text);
  const fraction = Math.round(percent * 100) / 10000;
  if (!(percent > 0) || !(percent < 100)) {
    return {
      ok: false,
      message: t('release-store:rollout.percent.range'),
    };
  }
  if (Math.abs(fraction * 100 - percent) > 1e-9) {
    return {
      ok: false,
      message: t('release-store:rollout.percent.decimals'),
    };
  }
  if (min !== null && fraction <= min) {
    return {
      ok: false,
      message: t('release-store:rollout.percent.raiseOnly', { share: formatRollout(min) }),
    };
  }
  return { ok: true, fraction };
}

/** The body of a preview or an apply for one action. `userFraction` only where the action takes it. */
export function buildRequest(
  base: RolloutTarget['base'],
  action: string,
  fraction?: number,
): RolloutRequest {
  const body: RolloutRequest = { action, ...base };
  if (fraction !== undefined && (action === 'set_fraction' || action === 'resume'))
    body.userFraction = fraction;
  return body;
}

// ---------------------------------------------------------------------------------------------
// Describing a state

export function describeState(state: RolloutState): string {
  if (state.store === 'googleplay') {
    const name = state.name ?? state.versionCodes.join(', ');
    const share = formatRollout(state.userFraction);
    const statusKey = STATUS_WORDS[state.status];
    const params = {
      name,
      track: trackLabel(state.track),
      status: statusKey === undefined ? state.status : t(statusKey),
      share,
    };
    return share
      ? t('release-store:rollout.state.googleShare', params)
      : t('release-store:rollout.state.google', params);
  }
  const phase = state.phasedReleaseState;
  let line: string;
  if (phase === null) line = t('release-store:rollout.state.none');
  else if (phase === 'ACTIVE')
    line =
      state.currentDayNumber !== null
        ? t('release-store:rollout.state.activeDay', { day: state.currentDayNumber })
        : t('release-store:rollout.state.active');
  else if (phase === 'PAUSED')
    line =
      state.totalPauseDays !== null
        ? t('release-store:rollout.state.pausedDays', { days: state.totalPauseDays })
        : t('release-store:rollout.state.paused');
  else if (phase === 'COMPLETE') line = t('release-store:rollout.state.complete');
  else line = t('release-store:rollout.state.other', { state: phase.toLowerCase() });
  return t('release-store:rollout.state.apple', {
    version: state.version,
    store: platformMeta(state.platform).storeName,
    line,
  });
}

const STATUS_WORDS: Record<string, string> = {
  inProgress: k('release-store:rollout.status.inProgress'),
  halted: k('release-store:rollout.status.halted'),
  completed: k('release-store:rollout.status.completed'),
  draft: k('release-store:rollout.status.draft'),
};

// ---------------------------------------------------------------------------------------------
// Typed confirmation

/**
 * What a person types before an irreversible change goes out: the version being released, so a
 * click on the wrong row does not pass. Falls back to the app name.
 */
export function confirmPhrase(preview: Pick<RolloutPreview, 'app' | 'current'>): string {
  const c = preview.current;
  if (c.store === 'appstoreconnect') return c.version;
  return c.name && c.name.trim() !== '' ? c.name : preview.app.name;
}

export const confirmationMatches = (typed: string, phrase: string): boolean =>
  typed.trim() !== '' && typed.trim().toLowerCase() === phrase.trim().toLowerCase();

/** An irreversible change needs the phrase; a reversible one needs only the acknowledgement. */
export function canConfirm(
  preview: Pick<RolloutPreview, 'irreversible' | 'app' | 'current'>,
  typed: string,
  acknowledged: boolean,
): boolean {
  if (!acknowledged) return false;
  return preview.irreversible ? confirmationMatches(typed, confirmPhrase(preview)) : true;
}

// ---------------------------------------------------------------------------------------------
// Outcomes of a request

export type RolloutFailure =
  | {
      kind: 'state_changed';
      message: string;
      next: RolloutPreview | null;
      current: RolloutState | null;
    }
  | { kind: 'write_in_progress'; message: string }
  | { kind: 'outcome_unknown'; message: string }
  | { kind: 'not_applied'; message: string }
  | { kind: 'disabled'; message: string }
  | { kind: 'other'; message: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * Sorts an error of preview or apply. `state_changed` carries the new state; when the change still fits
 * the body holds a new proposal and a new `confirmHash`, which becomes the next preview to confirm again.
 * `outcome_unknown` is final for this attempt: the caller must NOT send the request again.
 */
export function classifyFailure(error: unknown, previous: RolloutPreview | null): RolloutFailure {
  if (!(error instanceof ApiError))
    return { kind: 'other', message: t('release-store:rollout.fail.request') };
  const body = error.body;
  const message =
    typeof body.message === 'string' && body.message !== '' ? body.message : error.message;
  switch (error.code) {
    case 'state_changed': {
      const current = isObject(body.current) ? (body.current as RolloutState) : null;
      const proposed = isObject(body.proposed) ? (body.proposed as RolloutState) : null;
      const hash = typeof body.confirmHash === 'string' ? body.confirmHash : null;
      let next: RolloutPreview | null = null;
      if (previous && current && proposed && hash) {
        next = {
          ...previous,
          current,
          proposed,
          summary: typeof body.summary === 'string' ? body.summary : previous.summary,
          irreversible:
            typeof body.irreversible === 'boolean' ? body.irreversible : previous.irreversible,
          confirmHash: hash,
        };
      }
      return { kind: 'state_changed', message, next, current };
    }
    case 'write_in_progress':
      return { kind: 'write_in_progress', message };
    case 'outcome_unknown':
      return {
        kind: 'outcome_unknown',
        message: t('release-store:rollout.fail.outcomeUnknown', { message }),
      };
    case 'write_failed':
      return body.outcome === 'not_applied'
        ? { kind: 'not_applied', message }
        : {
            kind: 'outcome_unknown',
            message: t('release-store:rollout.fail.writeFailedUnknown', { message }),
          };
    case 'timeout':
      return {
        kind: 'outcome_unknown',
        message: t('release-store:rollout.fail.timeout'),
      };
    case 'rollout_disabled':
      return {
        kind: 'disabled',
        message: t('release-store:rollout.fail.disabled', { env: ROLLOUT_ENV }),
      };
    case 'changes_in_review':
      return {
        kind: 'other',
        message: t('release-store:rollout.fail.changesInReview'),
      };
    case 'rollout_not_allowed':
    case 'invalid_rollout':
      return { kind: 'other', message };
    case 'rate_limited':
      return {
        kind: 'other',
        message: error.retryAfter
          ? t('release-store:rollout.fail.rateLimitedSeconds', { count: error.retryAfter })
          : t('release-store:rollout.fail.rateLimited'),
      };
    case 'forbidden':
      return { kind: 'other', message: t('release-store:rollout.fail.forbidden') };
    default:
      return { kind: 'other', message };
  }
}

/** Whether the person may try the same change again without reading the store first. Never after an unknown outcome. */
export const mayRetry = (failure: RolloutFailure): boolean =>
  failure.kind === 'write_in_progress' || failure.kind === 'not_applied';
