import type { Platform } from '@mrm/core';
import { StoreError, type StoreName } from './errors.ts';

/**
 * Store rollout writes (docs/adr/0008-store-rollout-writes.md, docs/api/rollout.md): the shapes
 * both store connectors share, and the PURE rules about which change is allowed from which state.
 * Nothing here talks to a store.
 *
 * The two stores model a staged release differently:
 *
 * - Google Play: a release on a track (`edits.tracks`) with a status (`inProgress`, `halted`,
 *   `completed`, `draft`) and, for `inProgress` and `halted`, `userFraction` (0 < fraction < 1).
 *   A change is an edit: read the track, change the release, `tracks.update`, `edits.commit`.
 * - App Store Connect: a phased release (`appStoreVersionPhasedReleases`) of an App Store version
 *   with a `phasedReleaseState` (`INACTIVE`, `ACTIVE`, `PAUSED`, `COMPLETE`). Apple decides the
 *   share per day (1, 2, 5, 10, 20, 50, 100 percent over seven days): it cannot be set, only
 *   paused, resumed or ended ("release to all users").
 *
 * Rules that hold for both, and are enforced here and again by the server:
 *
 * - A rollout share only ever goes up. Play: `set_fraction` must be strictly higher than the
 *   current one; the only way down is `halt` (which keeps the share). Apple: nothing lowers it.
 * - "Complete" and "release to all" are final: nothing here undoes them (Apple: no way back; Play:
 *   `completed` is final per Google's pages).
 */

export const PLAY_ROLLOUT_ACTIONS = ['set_fraction', 'halt', 'resume', 'complete'] as const;
export type PlayRolloutAction = (typeof PLAY_ROLLOUT_ACTIONS)[number];
export const APPLE_ROLLOUT_ACTIONS = ['pause', 'resume', 'release_to_all'] as const;
export type AppleRolloutAction = (typeof APPLE_ROLLOUT_ACTIONS)[number];

/** A release on a Play track: the track and the exact version codes of the release (a set). */
export type PlayRolloutTarget = { track: string; versionCodes: string[] };
/** An App Store version, by its marketing version string (`1.4.0`). */
export type AppleRolloutTarget = { version: string };
export type RolloutTarget = PlayRolloutTarget | AppleRolloutTarget;

export type PlayRolloutState = {
  store: 'googleplay';
  platform: 'android';
  track: string;
  /** Sorted. */
  versionCodes: string[];
  name: string | null;
  /** `draft`, `inProgress`, `halted`, `completed`, or whatever else Google sent, verbatim. */
  status: string;
  /** 0 < fraction < 1 for `inProgress` and `halted`; null otherwise. */
  userFraction: number | null;
  /** How many other releases the track holds (they are sent back unchanged with a write). */
  otherReleases: number;
};

export type AppleRolloutState = {
  store: 'appstoreconnect';
  /** `ios` or `macos`: Apple's phased release is read and written on the version of that platform. */
  platform: 'ios' | 'macos';
  version: string;
  /** Apple's id of the App Store version. */
  storeVersionId: string;
  /** `appVersionState` (else `appStoreState`), verbatim. */
  versionState: string | null;
  /** Null when the version has no phased release. */
  phasedReleaseId: string | null;
  /** `INACTIVE`, `ACTIVE`, `PAUSED`, `COMPLETE`, verbatim (UNVERIFIED list). Null without a phased release. */
  phasedReleaseState: string | null;
  /** 1 to 7 while a phased release runs. Informational: it advances by itself. */
  currentDayNumber: number | null;
  /** Epoch milliseconds. */
  startDate: number | null;
  /** Days spent paused, of the 30 Apple allows. */
  totalPauseDays: number | null;
};

export type RolloutState = PlayRolloutState | AppleRolloutState;

export type PlayRolloutChange =
  | { action: 'set_fraction'; userFraction: number }
  | { action: 'halt' }
  | { action: 'resume'; userFraction?: number }
  | { action: 'complete' };
export type AppleRolloutChange = { action: AppleRolloutAction };
export type RolloutChange = PlayRolloutChange | AppleRolloutChange;

export type RolloutPlanFailureCode =
  | 'not_allowed'
  | 'not_an_increase'
  | 'invalid_fraction'
  | 'wrong_store';

export type RolloutPlan =
  | {
      ok: true;
      /** What the store should show once the change is applied. */
      proposed: RolloutState;
      /** True when nothing can undo it (complete, release to all). */
      irreversible: boolean;
      /** One sentence for a confirmation dialog. */
      summary: string;
    }
  | { ok: false; code: RolloutPlanFailureCode; message: string };

/** Play accepts 0 < fraction < 1. Four decimals are enough (0.0001 is 0.01 percent); returns undefined when invalid. */
export function normalizeFraction(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value * 10_000) / 10_000;
  return rounded > 0 && rounded < 1 ? rounded : undefined;
}

export const percent = (fraction: number | null): string =>
  fraction === null ? 'unknown' : `${Number((fraction * 100).toFixed(2))}%`;

const refuse = (code: RolloutPlanFailureCode, message: string): RolloutPlan => ({
  ok: false,
  code,
  message,
});

const playLabel = (s: PlayRolloutState) =>
  `version code${s.versionCodes.length === 1 ? '' : 's'} ${s.versionCodes.join(', ')} on ${s.track}`;

/** What changing a Play release to `change` would give, or why it is refused. Pure. */
export function planPlayRollout(current: PlayRolloutState, change: PlayRolloutChange): RolloutPlan {
  const label = playLabel(current);
  switch (change.action) {
    case 'set_fraction': {
      const next = normalizeFraction(change.userFraction);
      if (next === undefined) {
        return refuse(
          'invalid_fraction',
          'The share must be more than 0 and less than 1 (for example 0.2 for 20 percent). To reach everyone, complete the rollout.',
        );
      }
      if (current.status !== 'inProgress') {
        return refuse(
          'not_allowed',
          `The share can only be raised while the rollout is in progress; this release is ${current.status}.`,
        );
      }
      if (current.userFraction === null) {
        return refuse(
          'not_allowed',
          'Google Play reports no current share for this release, so a higher one cannot be checked.',
        );
      }
      if (next <= current.userFraction) {
        return refuse(
          'not_an_increase',
          `The share can only go up: it is ${percent(current.userFraction)} now and ${percent(next)} was asked. To stop a rollout, halt it.`,
        );
      }
      return {
        ok: true,
        proposed: { ...current, status: 'inProgress', userFraction: next },
        irreversible: false,
        summary: `Raise the staged rollout of ${label} from ${percent(current.userFraction)} to ${percent(next)} of users.`,
      };
    }
    case 'halt':
      if (current.status !== 'inProgress') {
        return refuse(
          'not_allowed',
          `Only a rollout in progress can be halted; this release is ${current.status}.`,
        );
      }
      return {
        ok: true,
        proposed: { ...current, status: 'halted' },
        irreversible: false,
        summary: `Halt the rollout of ${label} at ${percent(current.userFraction)}: it is no longer offered to new users (people who already have it keep it).`,
      };
    case 'resume': {
      if (current.status !== 'halted') {
        return refuse(
          'not_allowed',
          `Only a halted rollout can be resumed; this release is ${current.status}.`,
        );
      }
      const asked =
        change.userFraction === undefined ? undefined : normalizeFraction(change.userFraction);
      if (change.userFraction !== undefined && asked === undefined) {
        return refuse('invalid_fraction', 'The share must be more than 0 and less than 1.');
      }
      const next = asked ?? current.userFraction;
      if (next === null) {
        return refuse(
          'invalid_fraction',
          'The halted release has no share recorded: say which share to resume at.',
        );
      }
      if (current.userFraction !== null && next < current.userFraction) {
        return refuse(
          'not_an_increase',
          `The share can only go up: it was halted at ${percent(current.userFraction)} and ${percent(next)} was asked.`,
        );
      }
      return {
        ok: true,
        proposed: { ...current, status: 'inProgress', userFraction: next },
        irreversible: false,
        summary: `Resume the rollout of ${label} at ${percent(next)} of users.`,
      };
    }
    case 'complete':
      if (current.status !== 'inProgress') {
        return refuse(
          'not_allowed',
          `Only a rollout in progress can be completed (resume a halted one first); this release is ${current.status}.`,
        );
      }
      return {
        ok: true,
        proposed: { ...current, status: 'completed', userFraction: null },
        irreversible: true,
        summary: `Release ${label} to 100% of users. This ends the staged rollout and cannot be undone from here.`,
      };
  }
}

/** What changing an App Store phased release to `change` would give, or why it is refused. Pure. */
export function planAppleRollout(
  current: AppleRolloutState,
  change: AppleRolloutChange,
): RolloutPlan {
  const label = `version ${current.version}`;
  const state = current.phasedReleaseState;
  if (current.phasedReleaseId === null || state === null || state === 'INACTIVE') {
    return refuse(
      'not_allowed',
      current.phasedReleaseId === null
        ? `${label} has no phased release.`
        : `The phased release of ${label} has not started: it starts when the version is released. Nothing to change yet.`,
    );
  }
  if (state === 'COMPLETE') {
    return refuse(
      'not_allowed',
      `The phased release of ${label} is finished: it is already available to everyone.`,
    );
  }
  if (state !== 'ACTIVE' && state !== 'PAUSED') {
    return refuse(
      'not_allowed',
      `The phased release of ${label} is in a state this server does not change (${state}).`,
    );
  }
  switch (change.action) {
    case 'pause':
      if (state !== 'ACTIVE')
        return refuse(
          'not_allowed',
          `Only a running phased release can be paused; this one is ${state}.`,
        );
      return {
        ok: true,
        proposed: { ...current, phasedReleaseState: 'PAUSED' },
        irreversible: false,
        summary: `Pause the phased release of ${label}. Apple allows 30 days of pause in total.`,
      };
    case 'resume':
      if (state !== 'PAUSED')
        return refuse(
          'not_allowed',
          `Only a paused phased release can be resumed; this one is ${state}.`,
        );
      return {
        ok: true,
        proposed: { ...current, phasedReleaseState: 'ACTIVE' },
        irreversible: false,
        summary: `Resume the phased release of ${label}.`,
      };
    case 'release_to_all':
      return {
        ok: true,
        proposed: { ...current, phasedReleaseState: 'COMPLETE' },
        irreversible: true,
        summary: `Release ${label} to all users now. This ends the phased release and cannot be undone from here.`,
      };
  }
}

/**
 * What a confirmation is about: the parts of a state that the change depends on, in a fixed order.
 * Two states with the same key are "the same state" for the drift check. Informational fields that
 * move by themselves (Apple's day number) are left out, so a preview does not go stale at midnight.
 */
export function rolloutKey(state: RolloutState): Record<string, unknown> {
  if (state.store === 'googleplay') {
    return {
      store: state.store,
      track: state.track,
      versionCodes: [...state.versionCodes].sort(),
      status: state.status,
      userFraction: state.userFraction,
    };
  }
  return {
    store: state.store,
    version: state.version,
    storeVersionId: state.storeVersionId,
    versionState: state.versionState,
    phasedReleaseId: state.phasedReleaseId,
    phasedReleaseState: state.phasedReleaseState,
  };
}

export const sameRolloutState = (a: RolloutState, b: RolloutState): boolean =>
  JSON.stringify(rolloutKey(a)) === JSON.stringify(rolloutKey(b));

/** The store's state is not what the person confirmed: nothing was written. `current` is what it is now. */
export class RolloutDriftError extends Error {
  readonly current: RolloutState;
  constructor(current: RolloutState) {
    super('The store changed since the preview was made.');
    this.name = 'RolloutDriftError';
    this.current = current;
  }
}

/**
 * A rollout write was sent and the store did not answer in a way that tells whether it was applied
 * (a timeout, a cut connection, a 5xx on the commit or the update). Nothing retries it: the caller
 * reads the state back to find out.
 */
export class RolloutOutcomeUnknownError extends StoreError {
  constructor(store: StoreName, message: string, status?: number) {
    super(store, 'network', message, status);
    this.name = 'RolloutOutcomeUnknownError';
  }
}

export type RolloutApplyInput = {
  target: RolloutTarget;
  change: RolloutChange;
  /**
   * Called with the state read from the store right before the write. When it says false the write
   * is not made and `RolloutDriftError` is thrown: this is how "the store changed since the
   * preview" is decided on the freshest read there is.
   */
  guard: (current: RolloutState) => boolean;
};

export type RolloutApplyResult = {
  /** The state the guard accepted. */
  before: RolloutState;
  /** The state the store should show now: what was asked, merged with what the store answered. */
  after: RolloutState;
};

/**
 * The write side of a store connector for rollouts. Every `applyChange` can change what customers
 * receive. A refusal is a `StoreError` (nothing changed); `RolloutOutcomeUnknownError` means it may
 * have been applied; `RolloutDriftError` means the guard refused and nothing was sent.
 */
export interface StoreRolloutConnector {
  readonly store: StoreName;
  readonly platform: Platform;
  /** The current state of the release or version, read from the store. `StoreError` `not_found` when there is none. */
  readState(target: RolloutTarget): Promise<RolloutState>;
  applyChange(input: RolloutApplyInput): Promise<RolloutApplyResult>;
}

/** A Play track id: `production`, `beta`, `wear:production`, a custom track name. */
export const isPlayTrackName = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,99}$/.test(value);
/** A Play version code: digits, at most 10 (Google caps it at 2.1 billion). */
export const isVersionCode = (value: string): boolean => /^[0-9]{1,10}$/.test(value);
/** A marketing version as Apple allows it: digits and dots, plus the dashes and letters some teams use. */
export const isMarketingVersion = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
