import type { Platform } from '@kiln/core';
import { latestRelease, liveRelease } from '../portfolio.ts';
import type { ReleaseSummary } from '../types.ts';

/**
 * What a screen says about the releases of ONE record, from the one owner (docs/state-model.md, "Single owners (core)"):
 *  - `live`: the release that is live (`liveOf` of @kiln/core: live, rolling out or halted, newest by version; Google Play: production),
 *    never "the newest whose status is live" (a phased 1.19.0 is live, 1.18.0 is not what is on the store now);
 *  - `latest`: the newest release that is not left behind by it (an old draft is never the latest release);
 *  - `inFlight`: `latest` when it is something else than a settled live release (a draft, in review, rolling out...), else null.
 * The Overview tiles, the Portfolio rows, the details list and the competitor group all read it; none of them compares a version.
 */
export type ReleaseFacts = {
  live: ReleaseSummary | null;
  latest: ReleaseSummary | null;
  inFlight: ReleaseSummary | null;
};

export function releaseFactsOf(
  releases: readonly ReleaseSummary[],
  platform: Platform,
): ReleaseFacts {
  const live = liveRelease(releases, platform);
  const latest = latestRelease(releases, platform);
  const inFlight =
    latest !== null &&
    (live === null || latest.version !== live.version || latest.status !== 'live')
      ? latest
      : null;
  return { live, latest, inFlight };
}
