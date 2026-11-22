import { type ReleaseState, supports } from '@kiln/core';
import { t } from './i18n/t.ts';
import { statusInfo } from './portfolio.ts';
import type { ReleaseSummary } from './types.ts';

/**
 * Google Play cannot tell "live" from "approved, waiting for you to publish" (managed publishing), so a production release that
 * Play reports as `completed` or `inProgress` is shown as "not confirmed" instead of "Live" (docs/api/releases-write.md, "What Google
 * Play does not tell"). A release this server sent for review in the last days already reads "In review" and is not affected.
 * Internal, closed and open testing tracks are not reviewed the same way and keep their word. Pure.
 */
const SERVING: ReleaseState[] = ['live', 'rolling_out'];

export function playLiveUnconfirmed(
  release: Pick<ReleaseSummary, 'platform' | 'track' | 'status'>,
): boolean {
  return (
    supports(release.platform, 'releaseTracks') &&
    (release.track ?? '').toLowerCase() === 'production' &&
    release.status !== null &&
    SERVING.indexOf(release.status) >= 0
  );
}

/** The status as a person reads it: "In review", "Live", or "Live, not confirmed" for a Google Play production release. */
export function releaseStatusText(
  release: Pick<ReleaseSummary, 'platform' | 'track' | 'status' | 'rawState'> & { sentForReviewAt?: number | null },
): string {
  const label = statusInfo(release.status, release.rawState).label;
  return playLiveUnconfirmed(release) && !release.sentForReviewAt
    ? t('portfolio:status.unconfirmed.label', { status: label })
    : label;
}
