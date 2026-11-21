import { isPlatform } from '@kiln/core';
import { type ReplyState, replyStatusLabel } from './reply.ts';
import {
  type InboxShortcut,
  isAnswered,
  moveIndex,
  type Review,
  type ReviewStatus,
} from './reviews.ts';

/**
 * Pure helpers of the list and detail view of reviews (the per-app Reviews tab and the workspace inbox) on wide
 * screens: which review is selected, how the arrow keys move it, how it is kept in the address
 * (`?review=<id>`), and the one-line summary of a row. Nothing here touches `location` or fetches.
 * Written for the ES2017 web build.
 */

/** The width from which the list and the detail sit side by side. Below it the cards keep their own list. */
export const SPLIT_MIN_WIDTH = 1100;
export const SPLIT_QUERY = `(min-width: ${SPLIT_MIN_WIDTH}px)`;

/** From this width up to the one above, the list takes the whole width and the review opens as a drawer from the right. */
export const COMPACT_MIN_WIDTH = 800;
export const COMPACT_QUERY = `(min-width: ${COMPACT_MIN_WIDTH}px)`;

export type SplitLayout = 'side-by-side' | 'drawer' | 'cards';

/** How reviews are laid out at a window width: list and detail side by side, the list with a drawer, or the cards. */
export const splitLayout = (width: number): SplitLayout =>
  width >= SPLIT_MIN_WIDTH ? 'side-by-side' : width >= COMPACT_MIN_WIDTH ? 'drawer' : 'cards';

/** How many extra pages may be read to find the review an address asks for. */
export const MAX_FIND_PAGES = 8;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

// ---------------------------------------------------------------------------------------------
// The address

/** Whether a hash is a reviews screen: the inbox, or the Reviews section of an app. Only these carry `?review=`. */
export const isReviewsAddress = (hash: string): boolean =>
  /^#\/(reviews|portfolio\/[^/?#]+\/reviews)(\?|$)/.test(hash);

/** The review a location hash asks for (`#/reviews?review=ID`), or null. An invalid id is dropped: addresses are typed by people. */
export function reviewFromHash(hash: string): string | null {
  const at = hash.indexOf('?');
  if (at < 0) return null;
  let id: string | null = null;
  try {
    id = new URLSearchParams(hash.slice(at + 1).split('#')[0] ?? '').get('review');
  } catch {
    return null;
  }
  return id !== null && ID_PATTERN.test(id) ? id : null;
}

/** The same address with the review set (or removed for null). The path and the other parts of the query stay. */
export function withReview(hash: string, id: string | null): string {
  const at = hash.indexOf('?');
  const path = at < 0 ? hash : hash.slice(0, at);
  const params = new URLSearchParams(at < 0 ? '' : hash.slice(at + 1));
  if (id === null || !ID_PATTERN.test(id)) params.delete('review');
  else params.set('review', id);
  const search = params.toString();
  return search === '' ? path : `${path}?${search}`;
}

/** The reviews of one app, with a review selected: the link from the inbox. The platform opens the tab the review is in. */
export function appReviewHref(
  appId: string,
  reviewId: string,
  platform: string | null = null,
): string {
  const params = new URLSearchParams();
  if (isPlatform(platform)) params.set('platform', platform);
  if (ID_PATTERN.test(reviewId)) params.set('review', reviewId);
  const search = params.toString();
  const base = `#/portfolio/${encodeURIComponent(appId)}/reviews`;
  return search === '' ? base : `${base}?${search}`;
}

// ---------------------------------------------------------------------------------------------
// Selection

/** The selected review: the one asked for when it is in the list, else the first, else none. */
export function resolveSelection(ids: readonly string[], wanted: string | null): string | null {
  if (ids.length === 0) return null;
  if (wanted !== null && ids.includes(wanted)) return wanted;
  return ids[0] ?? null;
}

/** The review after a move (next, previous, first, last); the current one for any other key. */
export function moveSelection(
  ids: readonly string[],
  current: string | null,
  move: InboxShortcut,
): string | null {
  if (ids.length === 0) return null;
  const from = current === null ? -1 : ids.indexOf(current);
  const to = moveIndex(from, ids.length, move);
  return ids[to] ?? current;
}

/**
 * Whether one more page should be read to find the wanted review: it is asked for, it is not in the
 * list yet, there is more, and not too many pages were read for it.
 */
export function shouldFindMore(
  ids: readonly string[],
  wanted: string | null,
  hasMore: boolean,
  pagesRead: number,
): boolean {
  return wanted !== null && hasMore && pagesRead < MAX_FIND_PAGES && !ids.includes(wanted);
}

/** Whether the address should be rewritten: the selection is settled and differs from what the address says. */
export function shouldWriteAddress(
  selected: string | null,
  inAddress: string | null,
  settled: boolean,
): boolean {
  return settled && selected !== null && selected !== inAddress;
}

// ---------------------------------------------------------------------------------------------
// A row

const FIRST_LINE_MAX = 90;

/** The title of a review, else the first line of its text, cut to one line. */
export function rowTitle(review: Pick<Review, 'title' | 'body'>): string {
  const title = (review.title ?? '').trim();
  const line =
    title !== '' ? title : (review.body.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
  if (line === '') return 'No text';
  const flat = line.replace(/\s+/g, ' ');
  return flat.length <= FIRST_LINE_MAX
    ? flat
    : `${flat.slice(0, FIRST_LINE_MAX - 1).replace(/\s+$/, '')}…`;
}

/** "Anna · DE", skipping what is missing. */
export function rowByline(review: Pick<Review, 'authorName' | 'territory'>): string {
  const parts: string[] = [];
  const author = (review.authorName ?? '').trim();
  if (author !== '') parts.push(author);
  const territory = (review.territory ?? '').trim();
  if (territory !== '') parts.push(territory.toUpperCase());
  return parts.join(' · ');
}

/** Where the reply stands, in a word or two; empty when there is nothing to say (no response, no draft). */
export function rowReplyText(
  review: Pick<Review, 'developerResponse' | 'reply' | 'replyDraft'>,
): string {
  const state: ReplyState = review.reply ?? { status: 'none', sentAt: null };
  if (state.status !== 'none') return replyStatusLabel(state.status);
  if (review.developerResponse) return 'Answered';
  if (review.replyDraft && review.replyDraft.status !== 'sent')
    return replyStatusLabel(review.replyDraft.status);
  return '';
}

export type DotTone = 'info' | 'neutral' | 'ok' | 'none';

/** The color of the status dot. The row also says the status in words. */
export const statusTone = (status: ReviewStatus): DotTone =>
  status === 'new'
    ? 'info'
    : status === 'ignored'
      ? 'neutral'
      : status === 'replied_in_console'
        ? 'ok'
        : 'none';

/** The dot of a row: blue while new, green once answered (in the store or from here), grey when ignored, none when triaged. */
export const rowDotTone = (
  review: Pick<Review, 'status' | 'developerResponse' | 'reply' | 'replyDraft'>,
): DotTone => (isAnswered(review) ? 'ok' : statusTone(review.status));

const DAY = 24 * 60 * 60 * 1000;

/** A short date for a dense row: "5m", "3h", "4d", then "Mar 4" (with the year when it is not this one). */
export function rowDate(at: number, now: number, locale = 'en'): string {
  const diff = now - at;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < DAY) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d`;
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString(
    locale,
    sameYear
      ? { month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' },
  );
}
