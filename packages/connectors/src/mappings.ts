import type { ReleaseState } from '@mrm/core';

/**
 * Pure mappings from each store's own state names to the normalized lifecycle in
 * `@mrm/core` (`ReleaseState`). A state the table does not know returns `undefined`: it is never
 * guessed. Callers keep the store's raw state next to the mapped one.
 */

/**
 * Apple's version states. Apple has migrated the field: `appStoreState` (type
 * `AppStoreVersionState`, deprecated in API 3.3/3.7) is replaced by `appVersionState` (type
 * `AppVersionState`, since API 3.3). Both are mapped here, so either field can be passed.
 *
 * Where a state could be one of two lifecycle states, the comment says which was chosen and why.
 * `undefined` entries are listed on purpose so the decision is visible.
 */
const APP_STORE_STATES: Record<string, ReleaseState | undefined> = {
  // Editable. Apple does not say whether a build is attached, so this is `draft`; the caller can
  // move it on to `build_chosen` / `ready` from the version's build relationship.
  PREPARE_FOR_SUBMISSION: 'draft',
  // Complete and ready to be submitted (appVersionState only).
  READY_FOR_REVIEW: 'ready',
  // The developer withdrew the submission, so it is editable again.
  DEVELOPER_REJECTED: 'draft',
  WAITING_FOR_REVIEW: 'in_review',
  IN_REVIEW: 'in_review',
  REJECTED: 'rejected',
  METADATA_REJECTED: 'rejected',
  INVALID_BINARY: 'rejected',
  // Approved. Whether it goes out by hand or on a schedule, it has not been released yet.
  PENDING_DEVELOPER_RELEASE: 'approved',
  PENDING_APPLE_RELEASE: 'approved',
  // Released and being processed for the store. Judgment call: there is no iOS equivalent of
  // Android's `propagating`, so this is the start of the rollout.
  PROCESSING_FOR_DISTRIBUTION: 'rolling_out',
  PROCESSING_FOR_APP_STORE: 'rolling_out',
  // Live. A phased release is a separate resource: pass `phasedRelease` to refine this.
  READY_FOR_DISTRIBUTION: 'live',
  READY_FOR_SALE: 'live',
  // Deliberately not mapped. Needs a person (encryption answer), or is not part of an active
  // release (superseded, taken off sale), or its meaning is unclear to us (see the spike doc).
  WAITING_FOR_EXPORT_COMPLIANCE: undefined,
  REPLACED_WITH_NEW_VERSION: undefined,
  REMOVED_FROM_SALE: undefined,
  DEVELOPER_REMOVED_FROM_SALE: undefined,
  PENDING_CONTRACT: undefined,
  ACCEPTED: undefined,
  PREORDER_READY_FOR_SALE: undefined,
  NOT_APPLICABLE: undefined,
};

export type MapAppStoreStateOptions = {
  /**
   * The `phasedReleaseState` of the version's phased release, when it has one and the caller read
   * it. Only `ACTIVE` and `PAUSED` change the result of a live version: `rolling_out` and
   * `halted`. (Apple's `PhasedReleaseState` page lists no values; these two are the documented
   * behaviours of a phased release and the strings are unverified.)
   */
  phasedRelease?: string;
};

/**
 * Maps an App Store version state (`appVersionState` or the older `appStoreState`) to the
 * lifecycle. Returns undefined for a state it does not know or deliberately does not map.
 */
export function mapAppStoreState(
  rawState: string | null | undefined,
  options: MapAppStoreStateOptions = {},
): ReleaseState | undefined {
  if (typeof rawState !== 'string') return undefined;
  const key = rawState.trim().toUpperCase();
  if (!Object.hasOwn(APP_STORE_STATES, key)) return undefined;
  const state = APP_STORE_STATES[key];
  if (state === 'live') {
    const phased = options.phasedRelease?.trim().toUpperCase();
    if (phased === 'ACTIVE') return 'rolling_out';
    if (phased === 'PAUSED') return 'halted';
  }
  return state;
}

/** Every Apple state name the table has an opinion about, for tests and docs. */
export const KNOWN_APP_STORE_STATES: readonly string[] = Object.keys(APP_STORE_STATES);

/** A release on a Google Play track, as `edits.tracks` returns it. */
export type PlayTrackRelease = {
  /** `draft`, `inProgress`, `halted`, `completed` (or `statusUnspecified`). */
  status: string | undefined;
  /** 0 < fraction < 1; documented as set only for `inProgress` and `halted`. */
  userFraction?: number | undefined;
};

export type PlayReleaseMapping = {
  state: ReleaseState;
  /** The share of users eligible for the staged rollout, as Google reports it (0 to 1). */
  fraction?: number;
};

/**
 * Maps a Play track release to the lifecycle.
 *
 * - `draft`: APKs are not served: `draft`.
 * - `inProgress`: served to a fraction of users: `rolling_out`, with the fraction.
 * - `halted`: serving stopped: `halted`, with the fraction it stopped at.
 * - `completed`: served to everyone: `live`.
 *
 * This says nothing about review: the edits API does not expose it (see the spike doc), and the
 * connector never reports `in_review`, `rejected` or `propagating` from a track.
 * A `completed` release on the internal or an alpha/beta track is "live" for that track only; the
 * caller decides from the track name whether that matters.
 * An `inProgress` release without a usable `userFraction` is still `rolling_out`, without one.
 */
export function mapPlayTrackRelease(release: PlayTrackRelease): PlayReleaseMapping | undefined {
  const fraction =
    typeof release.userFraction === 'number' &&
    Number.isFinite(release.userFraction) &&
    release.userFraction > 0 &&
    release.userFraction <= 1
      ? release.userFraction
      : undefined;
  switch (release.status) {
    case 'draft':
      return { state: 'draft' };
    case 'inProgress':
      return fraction === undefined ? { state: 'rolling_out' } : { state: 'rolling_out', fraction };
    case 'halted':
      return fraction === undefined ? { state: 'halted' } : { state: 'halted', fraction };
    case 'completed':
      return { state: 'live' };
    default:
      // `statusUnspecified`, missing, or a value added after this was written.
      return undefined;
  }
}
