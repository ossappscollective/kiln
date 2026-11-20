import type { LeadTone } from '../page-lead.ts';

/**
 * The headlines at the top of the ASO views behind "More" (docs/design/readability.md, "Second pass: forms and dialogs"): each says what
 * matters now in a few words and gives one sentence of why or what to do. The components only draw them (`ui/PageLead`).
 */

export type AsoLead = { headline: string; hint: string; tone: LeadTone };

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const RECENT_CHANGE_MS = 7 * 24 * 60 * 60_000;

/** The facts of one followed competitor that the lead needs (a subset of `AsoCompetitor`). */
export type CompetitorFacts = {
  state: 'ok' | 'not_found' | 'unavailable' | null;
  latest: { kind: 'first' | 'change' | 'heartbeat'; checkedAt: number } | null;
};

/** Counts the competitors that changed in the last 7 days (the same window as the Overview of Insights) and the ones gone from the store. */
export function competitorCounts(
  list: readonly CompetitorFacts[],
  now: number,
): { total: number; changed: number; notFound: number } {
  return {
    total: list.length,
    changed: list.filter(
      (c) => c.latest?.kind === 'change' && now - c.latest.checkedAt < RECENT_CHANGE_MS,
    ).length,
    notFound: list.filter((c) => c.state === 'not_found').length,
  };
}

/** "3 competitors changed recently", else the ones missing from the store, else how many are followed. */
export function competitorsLead(input: {
  total: number;
  changed: number;
  notFound: number;
  suggestions: number;
}): AsoLead {
  const { total, changed, notFound, suggestions } = input;
  const more =
    suggestions > 0
      ? ` ${plural(suggestions, 'suggestion')} from your keywords ${suggestions === 1 ? 'is' : 'are'} below.`
      : '';
  if (total === 0)
    return {
      headline: 'No competitors followed yet',
      hint: `Follow the apps you compete with to see when their version, rating or listing changes.${more}`,
      tone: 'neutral',
    };
  if (changed > 0)
    return {
      headline: `${plural(changed, 'competitor')} changed recently`,
      hint: `In the last 7 days. The Last change line on each card says what.${more}`,
      tone: 'info',
    };
  if (notFound > 0)
    return {
      headline: `${plural(notFound, 'competitor')} ${notFound === 1 ? 'is' : 'are'} no longer in the store`,
      hint: `Stop following ${notFound === 1 ? 'it' : 'them'} if the app is gone for good.${more}`,
      tone: 'warn',
    };
  return {
    headline: `Following ${plural(total, 'competitor')}, none changed this week`,
    hint: `Each card shows the version, rating and price from the last look.${more}`,
    tone: 'neutral',
  };
}

/** Ideas not tracked yet, over every app in scope. */
export function ideasLead(
  parts: readonly { ideas: number; competitors: number; ownListing: boolean }[],
): AsoLead {
  const ideas = parts.reduce((n, p) => n + p.ideas, 0);
  if (ideas > 0)
    return {
      headline: `${plural(ideas, 'keyword idea')} not tracked yet`,
      hint: 'Phrases your listing and your competitors repeat. The score counts how often a phrase occurs; it is not a search volume.',
      tone: 'info',
    };
  const needsListing = parts.some((p) => !p.ownListing);
  const needsCompetitors = parts.some((p) => p.competitors === 0);
  return {
    headline: 'No new keyword ideas',
    hint: needsListing
      ? 'Sync the app to read its listing, or follow a competitor to give it more text to read.'
      : needsCompetitors
        ? 'Follow a competitor to give it more text to read.'
        : 'Every phrase your listing and your competitors repeat is already tracked.',
    tone: 'neutral',
  };
}

/** Terms that competitors use and the listing does not. */
export function gapsLead(parts: readonly { gaps: number; competitors: number }[]): AsoLead {
  const competitors = parts.reduce((n, p) => n + p.competitors, 0);
  const gaps = parts.reduce((n, p) => n + p.gaps, 0);
  if (competitors === 0)
    return {
      headline: 'No competitors to compare with',
      hint: 'Follow a competitor to see which terms it uses that your listing does not.',
      tone: 'neutral',
    };
  if (gaps === 0)
    return {
      headline: 'No gaps found',
      hint: 'Your listing has the terms the competitors use.',
      tone: 'ok',
    };
  return {
    headline: `${plural(gaps, 'term')} competitors use that you do not`,
    hint: 'Taken from their names, subtitles and descriptions. It compares stored text; it does not know what people search for.',
    tone: 'info',
  };
}

/** How well the listing covers the tracked keywords of one locale per app. `partial` counts the description-only ones too. */
export function fitLead(
  parts: readonly { keywords: number; missing: number; partial: number }[],
): AsoLead {
  const keywords = parts.reduce((n, p) => n + p.keywords, 0);
  const missing = parts.reduce((n, p) => n + p.missing, 0);
  const partial = parts.reduce((n, p) => n + p.partial, 0);
  if (keywords === 0)
    return {
      headline: 'No keywords to check yet',
      hint: 'Add keywords to see how the listing covers them.',
      tone: 'neutral',
    };
  if (missing > 0)
    return {
      headline: `${missing} of ${plural(keywords, 'keyword')} ${missing === 1 ? 'is' : 'are'} missing from the listing`,
      hint:
        partial > 0
          ? `${partial} more ${partial === 1 ? 'is' : 'are'} only partly covered. The table says where each one appears.`
          : 'The table says where each keyword appears.',
      tone: 'warn',
    };
  if (partial > 0)
    return {
      headline: `${partial} of ${plural(keywords, 'keyword')} ${partial === 1 ? 'is' : 'are'} only partly covered`,
      hint: 'Every word is in the listing, but not always as a phrase in the name or subtitle.',
      tone: 'info',
    };
  return {
    headline: `The listing covers all ${plural(keywords, 'keyword')}`,
    hint: 'Each keyword is in the searched fields of the listing.',
    tone: 'ok',
  };
}

/** One term across countries: how many keywords and countries, and the ones that rank nowhere. */
export function marketsLead(input: {
  terms: number;
  countries: number;
  unranked: number;
}): AsoLead {
  const { terms, countries, unranked } = input;
  if (terms === 0)
    return {
      headline: 'No keywords tracked yet',
      hint: 'Add keywords on the Keywords view, in more than one country to compare.',
      tone: 'neutral',
    };
  const head = `${plural(terms, 'keyword')} in ${plural(countries, 'country', 'countries')}`;
  const hint =
    countries < 2
      ? 'Track a keyword in a second country to compare. Each cell is the best position in that storefront.'
      : 'Each cell is the best position of the app in that storefront. An empty cell means the term is not tracked there.';
  return unranked > 0
    ? { headline: `${head}, ${unranked} not ranked anywhere`, hint, tone: 'info' }
    : { headline: head, hint, tone: 'neutral' };
}

/** Terms the listing sets that no keyword tracks yet. `loaded` is false while the listing text is being read. */
export function listingLead(input: {
  loaded: boolean;
  localeRows: number;
  untracked: number;
}): AsoLead {
  if (!input.loaded)
    return {
      headline: 'Keywords in your listing',
      hint: 'Reading the stored listing text.',
      tone: 'neutral',
    };
  if (input.localeRows === 0)
    return {
      headline: 'No listing text is stored yet',
      hint: 'Read it from the store in the Store listing page, then come back.',
      tone: 'neutral',
    };
  if (input.untracked > 0)
    return {
      headline: `${plural(input.untracked, 'term')} in your listing ${input.untracked === 1 ? 'is' : 'are'} not tracked`,
      hint: 'Track them to see where they rank. Nothing is read from a store until you press Check now.',
      tone: 'info',
    };
  return {
    headline: 'Every term in your listing is tracked',
    hint: 'What your synced store listing sets, per locale, and the rank of each term today.',
    tone: 'ok',
  };
}

/** The Google Play search terms: nothing imported yet, or how many terms the last file holds. */
export function searchTermsLead(
  parts: readonly { stored: boolean; terms: number; period: string | null }[],
): AsoLead {
  const stored = parts.filter((p) => p.stored);
  if (stored.length === 0)
    return {
      headline: 'No search terms imported yet',
      hint: 'Import the search terms file from Google Play Console to see what people typed before they installed.',
      tone: 'neutral',
    };
  const terms = stored.reduce((n, p) => n + p.terms, 0);
  const period = stored.length === 1 ? stored[0]?.period : null;
  return {
    headline:
      terms === 0
        ? 'No search terms in this period'
        : `${plural(terms, 'search term')} from Google Play`,
    hint: period
      ? `${period}. Terms you do not track yet have a Track button.`
      : 'Terms you do not track yet have a Track button.',
    tone: 'neutral',
  };
}
