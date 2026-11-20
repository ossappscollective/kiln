import { COMPACT_QUERY, SPLIT_QUERY } from './reviews/split.ts';

/**
 * Whether the window is wide enough for the list and detail view of reviews (see review-split.ts): `wide` from 1100 px (list and detail
 * side by side), `active` from 800 px (below 1100 the list takes the width and the review opens as a drawer). One shared query for every
 * screen that asks; it follows the window as it is resized.
 */
const canMatch = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
let wide = $state(canMatch && window.matchMedia(SPLIT_QUERY).matches);
let active = $state(canMatch && window.matchMedia(COMPACT_QUERY).matches);

if (canMatch) {
  window.matchMedia(SPLIT_QUERY).addEventListener('change', (event) => {
    wide = event.matches;
  });
  window.matchMedia(COMPACT_QUERY).addEventListener('change', (event) => {
    active = event.matches;
  });
}

export const splitView = {
  get wide(): boolean {
    return wide;
  },
  /** The list and detail view is used (side by side or with a drawer). */
  get active(): boolean {
    return active;
  },
  /** Below the side-by-side width: the review opens as a drawer. */
  get drawer(): boolean {
    return active && !wide;
  },
};
