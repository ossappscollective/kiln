/**
 * Whether the listing (texts and graphics) of an app can still be changed (docs/api/staged-changes.md, "Locked versions").
 * Apple freezes the metadata of a version once it is released, waiting for review or approved: the next change needs a NEW
 * version. Google Play has no live version to lock: a listing edit is a draft that is always open, so Play never locks.
 * Pure: the server reads the stored releases and calls this; the web app shows the same answer.
 */

import { type Platform, supports } from '../platform.ts';
import { compareDottedVersions, isDottedVersion } from './store-version.ts';

/** The stored release states in which Apple's metadata no longer changes. */
export const LOCKED_RELEASE_STATES = [
  'live',
  'rolling_out',
  'propagating',
  'halted',
  'in_review',
  'approved',
] as const;
export type LockedReleaseState = (typeof LOCKED_RELEASE_STATES)[number];

export type MetadataLock = {
  locked: boolean;
  /** The state that locks the listing (the newest locked version's), null when open. */
  reason: LockedReleaseState | null;
  /** The newest locked version string, null when open. */
  liveVersion: string | null;
};

export const OPEN_METADATA: MetadataLock = { locked: false, reason: null, liveVersion: null };

const isLockedState = (status: string | null): status is LockedReleaseState =>
  status !== null && (LOCKED_RELEASE_STATES as readonly string[]).includes(status);

/**
 * Apple: locked when at least one version is in a locked state and no version is editable. A version whose state is unknown
 * (null: for example replaced by a newer one) counts for neither, so an app that was never synced is never locked.
 * Any other state (draft, build chosen, ready, rejected) is an editable version: the listing is open.
 */
export function computeMetadataLock(
  platform: Platform,
  releases: readonly { version: string; status: string | null }[],
): MetadataLock {
  if (supports(platform, 'transactionalEdits')) return OPEN_METADATA;
  const known = releases.filter((r) => r.status !== null);
  if (known.some((r) => !isLockedState(r.status))) return OPEN_METADATA;
  const locking = known.filter((r) => isLockedState(r.status));
  if (locking.length === 0) return OPEN_METADATA;
  const newest = locking.reduce((a, b) => {
    const order =
      isDottedVersion(a.version) && isDottedVersion(b.version)
        ? compareDottedVersions(a.version, b.version)
        : a.version.localeCompare(b.version);
    return order >= 0 ? a : b;
  });
  return { locked: true, reason: newest.status as LockedReleaseState, liveVersion: newest.version };
}
