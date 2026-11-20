import { byFamily, can, type Platform, platformMeta, type Role, supports } from '@mrm/core';
import { ApiError } from './api.ts';
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

export const ROLLOUT_ENV = 'MRM_STORE_ROLLOUT_ENABLED';

/** The sentence a confirmation must show, word for word (docs/ux-ia.md, section 5). */
export const LIVE_STORE_WARNING = 'This changes the live store.';

export const IRREVERSIBLE_WARNING =
  'This cannot be undone: nothing in this tool or in the store can take it back.';

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
      message:
        'Could not find out whether rollout changes are switched on. Reload the page to try again.',
    };
  }
  if (!config) return { state: 'loading' };
  if (!config.enabled) {
    return {
      state: 'off',
      message: `Changing a rollout in the store is switched off on this server. Someone who runs it sets ${config.envName || ROLLOUT_ENV}=true and restarts it (see docs/api/rollout.md). Nothing here can reach a store until then.`,
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
      return {
        key: `${r.track}/${codes.join(',')}`,
        label: `${r.version} on ${trackLabel(r.track)} (build ${codes.join(', ')})${share ? `, ${share}` : ''}`,
        base: { track: r.track as string, versionCodes: codes },
      };
    }
    return {
      key: r.version,
      label: `${r.version} (${r.rawState || 'App Store'})`,
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
  set_fraction: 'Increase rollout',
  halt: 'Halt rollout',
  resume: 'Resume rollout',
  complete: 'Release to 100%',
  pause: 'Pause phased release',
  release_to_all: 'Release to all users',
};

export const actionLabel = (action: string, platform: Platform): string => {
  if (action === 'resume' && supports(platform, 'phasedRelease')) return 'Resume phased release';
  return ACTION_LABELS[action] ?? action;
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
    else if (!state) reason = 'Read the state from the store first.';
    else if (!allowed) reason = 'The store state does not offer this change.';
    else if (!allowed.allowed)
      reason = allowed.reason ?? 'The store state does not allow this change.';
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
  if (text === '') return { ok: false, message: 'Enter the new share in percent, for example 25.' };
  if (!/^\d+(\.\d+)?$/.test(text))
    return { ok: false, message: 'Enter a number, for example 25 or 12.5.' };
  const percent = Number(text);
  const fraction = Math.round(percent * 100) / 10000;
  if (!(percent > 0) || !(percent < 100)) {
    return {
      ok: false,
      message:
        'The share must be more than 0% and less than 100%. Use "Release to 100%" to finish a rollout.',
    };
  }
  if (Math.abs(fraction * 100 - percent) > 1e-9) {
    return {
      ok: false,
      message:
        'Use at most two decimals in the percentage (the store takes four decimals of the fraction).',
    };
  }
  if (min !== null && fraction <= min) {
    return {
      ok: false,
      message: `Google Play only raises a rollout: the new share must be above the current ${formatRollout(min)}.`,
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
    const status = STATUS_WORDS[state.status] ?? state.status;
    return `${name} on ${trackLabel(state.track)}: ${status}${share ? ` at ${share}` : ''}`;
  }
  const phase = state.phasedReleaseState;
  let line: string;
  if (phase === null) line = 'no phased release';
  else if (phase === 'ACTIVE')
    line = `phased release active${state.currentDayNumber !== null ? ` (day ${state.currentDayNumber} of 7)` : ''}`;
  else if (phase === 'PAUSED')
    line = `phased release paused${state.totalPauseDays !== null ? ` (${state.totalPauseDays} of 30 pause days used)` : ''}`;
  else if (phase === 'COMPLETE') line = 'phased release complete (released to all users)';
  else line = `phased release ${phase.toLowerCase()}`;
  return `${state.version} on the ${platformMeta(state.platform).storeName}: ${line}`;
}

const STATUS_WORDS: Record<string, string> = {
  inProgress: 'rolling out',
  halted: 'halted',
  completed: 'completed',
  draft: 'draft',
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
    return {
      kind: 'other',
      message: 'The request failed. Check your connection and read the state again.',
    };
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
        message: `${message} Do not try again yet: read the state from the store (Refresh state) and check it before changing anything.`,
      };
    case 'write_failed':
      return body.outcome === 'not_applied'
        ? { kind: 'not_applied', message }
        : {
            kind: 'outcome_unknown',
            message: `${message} Read the state from the store (Refresh state) before changing anything.`,
          };
    case 'timeout':
      return {
        kind: 'outcome_unknown',
        message:
          'The store did not answer in time. Read the state from the store (Refresh state) to see whether the change went through. Do not repeat it before that.',
      };
    case 'rollout_disabled':
      return {
        kind: 'disabled',
        message: `Changing a rollout is switched off on this server (${ROLLOUT_ENV}).`,
      };
    case 'changes_in_review':
      return {
        kind: 'other',
        message:
          'Google Play has changes in review for this app. Wait until they are decided, then try again. This tool never cancels a review.',
      };
    case 'rollout_not_allowed':
    case 'invalid_rollout':
      return { kind: 'other', message };
    case 'rate_limited':
      return {
        kind: 'other',
        message: `The store is limiting requests. ${error.retryAfter ? `Try again in ${error.retryAfter} seconds.` : 'Try again in a minute.'}`,
      };
    case 'forbidden':
      return { kind: 'other', message: 'Only an admin or owner can change a rollout.' };
    default:
      return { kind: 'other', message };
  }
}

/** Whether the person may try the same change again without reading the store first. Never after an unknown outcome. */
export const mayRetry = (failure: RolloutFailure): boolean =>
  failure.kind === 'write_in_progress' || failure.kind === 'not_applied';
