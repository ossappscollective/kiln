/**
 * The order of Google Play tracks wherever tracks are listed (release page, overview, portfolio, tables): production, open testing
 * (`beta`), closed testing (`alpha`, then custom closed tracks by name), internal testing, app sharing. A record with no track
 * (iOS, macOS) comes before all of them. One helper, so no list sorts tracks by its own rule. Pure; written for the ES2017 web build.
 */

import { PLAY_TRACKS } from '@kiln/core';

/** Closed-testing tracks that Google names itself; every other name is a custom closed track. */
const FIXED: string[] = [PLAY_TRACKS.production, PLAY_TRACKS.beta, PLAY_TRACKS.alpha];
const CUSTOM_RANK = FIXED.length;
const INTERNAL_RANK = CUSTOM_RANK + 1;
const SHARING_RANK = INTERNAL_RANK + 1;

const isSharing = (track: string) => /(^|[-_ ])(app[-_ ]?)?sharing$/i.test(track);

/** Where a track sits in the order: smaller first. `null` (no track) is first of all. */
export function trackRank(track: string | null): number {
  if (track === null) return -1;
  const name = track.toLowerCase();
  const i = FIXED.indexOf(name);
  if (i >= 0) return i;
  if (name === PLAY_TRACKS.internal) return INTERNAL_RANK;
  if (isSharing(name)) return SHARING_RANK;
  return CUSTOM_RANK;
}

/** Compares two tracks: by rank, then by name so custom tracks keep a stable order. */
export function compareTracks(a: string | null, b: string | null): number {
  const diff = trackRank(a) - trackRank(b);
  if (diff !== 0) return diff;
  const x = (a ?? '').toLowerCase();
  const y = (b ?? '').toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The items sorted by track (a copy). `trackOf` reads the track of an item. */
export function sortByTrack<T>(items: readonly T[], trackOf: (item: T) => string | null): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => compareTracks(trackOf(a.item), trackOf(b.item)) || a.index - b.index)
    .map((x) => x.item);
}
