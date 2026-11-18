/**
 * "Open this change set in its repository": the one piece of state that carries a draft from the
 * screen that created it (the Listing tab of an app) to the Repositories screen, which reads it
 * when it opens. The shell routes by the first part of the hash (`#/repositories`), and the
 * repository screens keep which repository and tab are open in their own state, so the hash
 * cannot name a draft. This module does, until those screens take a route of their own.
 *
 * Usage: the creator calls `requestChangeSetReview` and then goes to `reviewHref`. The Repositories
 * screen calls `takeChangeSetReview` once its list has loaded: it gets the intent (and clears it),
 * opens that repository on its Change sets tab with that change set under review.
 */

export type ChangeSetReviewIntent = { repositoryId: string; changeSetId: string };

let pending: ChangeSetReviewIntent | null = null;

/** Remembers which change set to open next. A later request replaces an earlier one. */
export function requestChangeSetReview(intent: ChangeSetReviewIntent): void {
  pending = { ...intent };
}

/** The intent that is waiting, without clearing it. */
export const peekChangeSetReview = (): ChangeSetReviewIntent | null => (pending ? { ...pending } : null);

/** The intent that is waiting, cleared. Null when there is none. */
export function takeChangeSetReview(): ChangeSetReviewIntent | null {
  const intent = pending;
  pending = null;
  return intent ? { ...intent } : null;
}

/** Forgets a waiting intent (the draft was discarded, or the person went elsewhere). */
export function clearChangeSetReview(): void {
  pending = null;
}

/** Where to go: the Repositories section. */
export const reviewHref = '#/repositories';
