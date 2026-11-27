/**
 * Google Play track names, in one place (docs/state-model.md, "Single owners (core)"). Before this file the names lived as literals in
 * candidates.ts (`isProduction`, `channelOf`), play-promote.ts (`PRODUCTION`), play-live.ts, the server's opt-in URL rule, the
 * release-candidates `SUGGESTED_TRACKS`, the EAS track list and core metadata/rollout files.
 *
 * Google's own names: `internal` (internal testing), `alpha` (closed testing, the default closed track), `beta` (open testing),
 * `production`. Any other name is a custom closed-testing track. App sharing is not a Play track; some exports list it as
 * `internal-app-sharing`, which `trackKind` calls `sharing`.
 *
 * Pure. ES2017.
 */

export const PLAY_TRACKS = {
  internal: 'internal',
  alpha: 'alpha',
  beta: 'beta',
  production: 'production',
} as const;
export type PlayTrackName = (typeof PLAY_TRACKS)[keyof typeof PLAY_TRACKS];

/** The tracks a person normally picks, from the first stage to the last. */
export const PLAY_TRACK_ORDER: readonly PlayTrackName[] = ['internal', 'alpha', 'beta', 'production'];

export type TrackKind = 'production' | 'open' | 'closed' | 'internal' | 'sharing' | 'none';

const SHARING = /(^|[-_ ])(app[-_ ]?)?sharing$/i;

/** What kind of track this is. `none` for no track (an Apple record). A custom name is `closed`. */
export function trackKind(track: string | null | undefined): TrackKind {
  if (track === null || track === undefined || track.trim() === '') return 'none';
  const name = track.trim().toLowerCase();
  if (name === PLAY_TRACKS.production) return 'production';
  if (name === PLAY_TRACKS.beta) return 'open';
  if (name === PLAY_TRACKS.internal) return 'internal';
  if (SHARING.test(name)) return 'sharing';
  return 'closed';
}

export const isProductionTrack = (track: string | null | undefined): boolean =>
  trackKind(track) === 'production';

export const isInternalTrack = (track: string | null | undefined): boolean =>
  trackKind(track) === 'internal';

/**
 * A track whose testers join through an opt-in link: every track that is neither internal nor production (closed and open
 * testing). The server's opt-in URL rule (`t !== 'internal' && t !== 'production'`).
 */
export const isOptInTrack = (track: string | null | undefined): boolean => {
  const kind = trackKind(track);
  return kind === 'closed' || kind === 'open';
};

export type PlayChannel = 'play_internal' | 'play_closed' | 'play_open' | 'play_other';

/**
 * The channel of a build that sits in these tracks (a candidate's `channel`): internal first, then `alpha` (closed), then `beta`
 * (open); a custom closed track or anything else is `play_other`. (The order is the old `channelOf`.)
 */
export function playChannelOf(tracks: readonly string[]): PlayChannel {
  const names = tracks.map((x) => x.toLowerCase());
  if (names.indexOf(PLAY_TRACKS.internal) >= 0) return 'play_internal';
  if (names.indexOf(PLAY_TRACKS.alpha) >= 0) return 'play_closed';
  if (names.indexOf(PLAY_TRACKS.beta) >= 0) return 'play_open';
  return 'play_other';
}

/** Whether two track names are the same track (case-insensitive; null is no track). */
export const sameTrack = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
