import { t } from '../i18n/t.ts';
import type { LeadTone } from '../page-lead.ts';

/**
 * The headlines at the top of the ASO views behind "More" (docs/design/readability.md, "Second pass: forms and dialogs"): each says what
 * matters now in a few words and gives one sentence of why or what to do. The components only draw them (`ui/PageLead`).
 */

export type AsoLead = { headline: string; hint: string; tone: LeadTone };

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
  const more = suggestions > 0 ? t('aso:lead.suggestionsBelow', { count: suggestions }) : '';
  if (total === 0)
    return {
      headline: t('aso:lead.competitors.none.headline'),
      hint: t('aso:lead.competitors.none.hint', { more }).trim(),
      tone: 'neutral',
    };
  if (changed > 0)
    return {
      headline: t('aso:lead.competitors.changed.headline', { count: changed }),
      hint: t('aso:lead.competitors.changed.hint', { more }).trim(),
      tone: 'info',
    };
  if (notFound > 0)
    return {
      headline: t('aso:lead.competitors.gone.headline', { count: notFound }),
      hint: t('aso:lead.competitors.gone.hint', { count: notFound, more }).trim(),
      tone: 'warn',
    };
  return {
    headline: t('aso:lead.competitors.steady.headline', { count: total }),
    hint: t('aso:lead.competitors.steady.hint', { more }).trim(),
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
      headline: t('aso:lead.ideas.some.headline', { count: ideas }),
      hint: t('aso:lead.ideas.some.hint'),
      tone: 'info',
    };
  const needsListing = parts.some((p) => !p.ownListing);
  const needsCompetitors = parts.some((p) => p.competitors === 0);
  return {
    headline: t('aso:lead.ideas.none.headline'),
    hint: needsListing
      ? t('aso:lead.ideas.none.needsListing')
      : needsCompetitors
        ? t('aso:lead.ideas.none.needsCompetitors')
        : t('aso:lead.ideas.none.allTracked'),
    tone: 'neutral',
  };
}

/** Terms that competitors use and the listing does not. */
export function gapsLead(parts: readonly { gaps: number; competitors: number }[]): AsoLead {
  const competitors = parts.reduce((n, p) => n + p.competitors, 0);
  const gaps = parts.reduce((n, p) => n + p.gaps, 0);
  if (competitors === 0)
    return {
      headline: t('aso:lead.gaps.noCompetitors.headline'),
      hint: t('aso:lead.gaps.noCompetitors.hint'),
      tone: 'neutral',
    };
  if (gaps === 0)
    return {
      headline: t('aso:lead.gaps.none.headline'),
      hint: t('aso:lead.gaps.none.hint'),
      tone: 'ok',
    };
  return {
    headline: t('aso:lead.gaps.some.headline', { count: gaps }),
    hint: t('aso:lead.gaps.some.hint'),
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
      headline: t('aso:lead.fit.noKeywords.headline'),
      hint: t('aso:lead.fit.noKeywords.hint'),
      tone: 'neutral',
    };
  const phrase = t('aso:lead.keywordsCount', { count: keywords });
  if (missing > 0)
    return {
      headline: t('aso:lead.fit.missing.headline', { count: missing, keywords: phrase }),
      hint:
        partial > 0
          ? t('aso:lead.fit.missing.partialHint', { count: partial })
          : t('aso:lead.fit.missing.hint'),
      tone: 'warn',
    };
  if (partial > 0)
    return {
      headline: t('aso:lead.fit.partial.headline', { count: partial, keywords: phrase }),
      hint: t('aso:lead.fit.partial.hint'),
      tone: 'info',
    };
  return {
    headline: t('aso:lead.fit.all.headline', { count: keywords }),
    hint: t('aso:lead.fit.all.hint'),
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
      headline: t('aso:lead.markets.none.headline'),
      hint: t('aso:lead.markets.none.hint'),
      tone: 'neutral',
    };
  const head = t('aso:lead.markets.head', {
    terms: t('aso:lead.keywordsCount', { count: terms }),
    countries: t('aso:lead.markets.countries', { count: countries }),
  });
  const hint =
    countries < 2 ? t('aso:lead.markets.hintOne') : t('aso:lead.markets.hintMany');
  return unranked > 0
    ? { headline: t('aso:lead.markets.unranked', { head, count: unranked }), hint, tone: 'info' }
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
      headline: t('aso:lead.listing.loading.headline'),
      hint: t('aso:lead.listing.loading.hint'),
      tone: 'neutral',
    };
  if (input.localeRows === 0)
    return {
      headline: t('aso:lead.listing.empty.headline'),
      hint: t('aso:lead.listing.empty.hint'),
      tone: 'neutral',
    };
  if (input.untracked > 0)
    return {
      headline: t('aso:lead.listing.untracked.headline', { count: input.untracked }),
      hint: t('aso:lead.listing.untracked.hint'),
      tone: 'info',
    };
  return {
    headline: t('aso:lead.listing.allTracked.headline'),
    hint: t('aso:lead.listing.allTracked.hint'),
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
      headline: t('aso:lead.searchTerms.none.headline'),
      hint: t('aso:lead.searchTerms.none.hint'),
      tone: 'neutral',
    };
  const terms = stored.reduce((n, p) => n + p.terms, 0);
  const period = stored.length === 1 ? stored[0]?.period : null;
  return {
    headline:
      terms === 0
        ? t('aso:lead.searchTerms.empty.headline')
        : t('aso:lead.searchTerms.some.headline', { count: terms }),
    hint: period
      ? t('aso:lead.searchTerms.hintPeriod', { period })
      : t('aso:lead.searchTerms.hint'),
    tone: 'neutral',
  };
}
