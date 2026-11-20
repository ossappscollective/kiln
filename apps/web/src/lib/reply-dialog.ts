import { type Review, reviewFacts } from './reviews.ts';

/**
 * Pure parts of the reply dialog (docs/design/readability.md, "Second pass: forms and dialogs"): the line under the stars of the review
 * and the one-line hint under the reply box. Nothing here sends or saves anything.
 */

/** "by Ana", "iPhone", "Version 3.2.0 (412)", ...: who wrote the review and what it was written on, skipping what is missing. */
export function reviewByline(
  review: Pick<
    Review,
    'authorName' | 'device' | 'appVersion' | 'buildNumber' | 'territory' | 'language'
  >,
): string[] {
  const author = review.authorName?.trim();
  return [...(author ? [`by ${author}`] : []), ...reviewFacts(review)];
}

/** The one line under the reply box: plain text, the store's limit, and that it stays a draft until an admin sends it. */
export function replyHint(storeName: string, limit: number): string {
  return `Plain text only, up to ${limit} characters in ${storeName}. It stays a draft until an admin sends it.`;
}

/** The note above the box when the review already has a reply: one line. */
export const REPLACING_NOTE =
  'This review already has a reply, shown below. The store keeps one per review, so sending replaces it.';
