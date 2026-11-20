/**
 * Pure parts of `ui/PageLead`: the headline of the top of a per-app page (docs/design/readability.md, "Applied globally"). Each says where
 * the page stands in a few words and which action comes first, so the component only draws.
 */

export type LeadTone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info';

/** "5 unanswered (3 stars or fewer), oldest 3 d" becomes "5 reviews need an answer (3 stars or fewer), oldest 3 d". */
export function needsAnswerText(chipText: string): string {
  return chipText.replace(/^(\d+) unanswered/, (_all, n: string) =>
    n === '1' ? '1 review needs an answer' : `${n} reviews need an answer`,
  );
}

export interface ReviewsLead {
  headline: string;
  tone: LeadTone;
  /** What the one primary button does: show the unanswered reviews, read the store again, or none (the empty state has its own). */
  primary: 'show' | 'read' | 'none';
}

export function reviewsLead(input: {
  loaded: boolean;
  stored: number;
  chip: { text: string } | null;
}): ReviewsLead {
  if (!input.loaded) return { headline: 'Customer reviews', tone: 'neutral', primary: 'none' };
  if (input.stored === 0) return { headline: 'No reviews stored yet', tone: 'neutral', primary: 'none' };
  if (input.chip) return { headline: needsAnswerText(input.chip.text), tone: 'warn', primary: 'show' };
  return { headline: 'No review is waiting for an answer', tone: 'ok', primary: 'read' };
}

/** "12 builds, 3 without a CI run" for the Builds page; the tone is info, since an unlinked build is not an error. */
export function buildsLead(total: number, unlinked: number): { headline: string; tone: LeadTone } {
  const builds = `${total} ${total === 1 ? 'build' : 'builds'}`;
  if (total === 0) return { headline: 'No builds yet', tone: 'neutral' };
  if (unlinked === 0) return { headline: `${builds}, each matched to a CI run`, tone: 'ok' };
  return {
    headline: `${builds}, ${unlinked} without a CI run`,
    tone: 'info',
  };
}

/** The top of Keywords: how many words are tracked and how many rank in the top 10; "not checked yet" is the one thing to do. */
export function keywordsLead(
  keywords: readonly { state: string | null; rank: number | null }[],
): { headline: string; hint: string; tone: LeadTone } {
  const n = keywords.length;
  if (n === 0)
    return {
      headline: 'No keywords tracked yet',
      hint: 'Add the words people search for to see where your app ranks in the store.',
      tone: 'neutral',
    };
  const top10 = keywords.filter((k) => k.state === 'ranked' && k.rank !== null && k.rank <= 10).length;
  const unchecked = keywords.filter((k) => k.state === null).length;
  return {
    headline: `${n} ${n === 1 ? 'keyword' : 'keywords'} tracked, ${top10} in the top 10`,
    hint:
      unchecked > 0
        ? `${unchecked} not checked yet. Press Check now to read their rank.`
        : 'Where your app ranks in the store search for the words you follow.',
    tone: unchecked > 0 ? 'info' : 'neutral',
  };
}
