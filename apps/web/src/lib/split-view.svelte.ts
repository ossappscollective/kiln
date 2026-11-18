import { SPLIT_QUERY } from './review-split.ts';

/**
 * Whether the window is wide enough for the list and detail view of reviews (see review-split.ts). One
 * shared query for every screen that asks; it follows the window as it is resized.
 */
let wide = $state(typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(SPLIT_QUERY).matches);

if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  window.matchMedia(SPLIT_QUERY).addEventListener('change', (event) => {
    wide = event.matches;
  });
}

export const splitView = {
  get wide(): boolean {
    return wide;
  },
};
