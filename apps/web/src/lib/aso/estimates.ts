import { k } from '../i18n/t.ts';

/**
 * Keyword popularity and difficulty ESTIMATES in the web (docs/adr/0057-keyword-estimates.md, docs/api/aso.md#estimates). The numbers
 * come from the server (core `estimateKeyword`); nothing here recomputes a score. This file only orders, filters, labels and draws.
 * They are never Apple's popularity score and never a Google Play number: every label says "estimate".
 */

export type Confidence = 'low' | 'medium' | 'high';
export type EstimateReason = { code: string; params: Record<string, string | number>; points: number | null; weight: number };
export type EstimateMeasure = {
  score: number | null;
  confidence: Confidence | null;
  origin: 'own_data' | 'public_signals' | null;
  reasons: EstimateReason[];
};
export type EstimateView = {
  model: string;
  popularity: EstimateMeasure;
  difficulty: EstimateMeasure;
  opportunity: { score: number | null; confidence: Confidence | null; roomFactor: number | null };
  signalsAt: number | null;
  hints: string[];
  top: Array<{ id: string; name: string | null; ratingCount: number | null }>;
};
export type EstimateRow = {
  keywordId: string;
  term: string;
  country: string;
  locale: string;
  platform: string;
  estimate: EstimateView;
  /** The app the keyword belongs to (added by the screen: one request per app). */
  appId: string;
};
export type EstimatesResponse = {
  appId: string;
  model: string;
  store: 'app_store' | 'google_play';
  estimates: Omit<EstimateRow, 'appId'>[];
};
export type EstimateDetail = {
  model: string;
  keyword: { id: string; term: string; country: string; locale: string; platform: string };
  estimate: EstimateView;
  trend: Array<{ day: string; popularity: number | null; difficulty: number | null }>;
  retentionDays: number;
};
export type KeywordSuggestion = { term: string; country: string; locale: string; from: string[] };
export type SuggestionsResponse = { appId: string; store: 'app_store' | 'google_play'; suggestions: KeywordSuggestion[] };

export type EstimateSort = 'opportunity' | 'popularity' | 'difficulty' | 'term';
export const estimateSorts: { id: EstimateSort; labelKey: string }[] = [
  { id: 'opportunity', labelKey: k('aso:est.sort.opportunity') },
  { id: 'popularity', labelKey: k('aso:est.sort.popularity') },
  { id: 'difficulty', labelKey: k('aso:est.sort.difficulty') },
  { id: 'term', labelKey: k('aso:est.sort.term') },
];

export type EstimateFilter = 'all' | 'estimated' | 'own' | 'none';
export const estimateFilters: { id: EstimateFilter; labelKey: string }[] = [
  { id: 'all', labelKey: k('aso:est.filter.all') },
  { id: 'estimated', labelKey: k('aso:est.filter.estimated') },
  { id: 'own', labelKey: k('aso:est.filter.own') },
  { id: 'none', labelKey: k('aso:est.filter.none') },
];

const hasEstimate = (r: EstimateRow): boolean => r.estimate.popularity.score !== null || r.estimate.difficulty.score !== null;

export function filterEstimates(rows: readonly EstimateRow[], query: string, filter: EstimateFilter): EstimateRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (q !== '' && r.term.toLowerCase().indexOf(q) === -1) return false;
    if (filter === 'estimated') return hasEstimate(r);
    if (filter === 'none') return !hasEstimate(r);
    if (filter === 'own') return r.estimate.popularity.origin === 'own_data';
    return true;
  });
}

/** Numbers descending (or ascending); "no estimate" always last, so it never looks like the best or the worst. */
export function sortEstimates<T extends EstimateRow>(rows: readonly T[], sort: EstimateSort): T[] {
  const value = (r: T): number | null =>
    sort === 'opportunity' ? r.estimate.opportunity.score : sort === 'popularity' ? r.estimate.popularity.score : sort === 'difficulty' ? r.estimate.difficulty.score : null;
  const byTerm = (a: T, b: T) => a.term.localeCompare(b.term) || a.country.localeCompare(b.country);
  return rows.slice().sort((a, b) => {
    if (sort === 'term') return byTerm(a, b);
    const x = value(a);
    const y = value(b);
    if (x === null && y === null) return byTerm(a, b);
    if (x === null) return 1;
    if (y === null) return -1;
    return (sort === 'difficulty' ? x - y : y - x) || byTerm(a, b);
  });
}

/** How many of three dots are filled: the confidence without colour. 0 when there is no estimate. */
export const confidenceDots = (c: Confidence | null): number => (c === 'high' ? 3 : c === 'medium' ? 2 : c === 'low' ? 1 : 0);

export const confidenceKeys: Record<Confidence, string> = {
  low: k('aso:est.confidence.low'),
  medium: k('aso:est.confidence.medium'),
  high: k('aso:est.confidence.high'),
};

export const unknownReasonKey = k('aso:est.reason.unknown');
export const reasonKeys: Record<string, string> = {
  hints_position: k('aso:est.reason.hintsPosition'),
  hints_absent: k('aso:est.reason.hintsAbsent'),
  hints_empty: k('aso:est.reason.hintsEmpty'),
  results_demand: k('aso:est.reason.resultsDemand'),
  own_visitors: k('aso:est.reason.ownVisitors'),
  results_strength: k('aso:est.reason.resultsStrength'),
  results_title_match: k('aso:est.reason.resultsTitleMatch'),
  results_crowding: k('aso:est.reason.resultsCrowding'),
  rank_volatility: k('aso:est.reason.rankVolatility'),
  no_signal: k('aso:est.reason.noSignal'),
  play_needs_own_data: k('aso:est.reason.playNeedsOwnData'),
  play_no_competition_data: k('aso:est.reason.playNoCompetitionData'),
  results_empty: k('aso:est.reason.resultsEmpty'),
  too_few_results: k('aso:est.reason.tooFewResults'),
};
/** The message key of a reason code; an unknown code (a newer server) falls back to the generic line. */
export const reasonKey = (code: string): string => reasonKeys[code] ?? unknownReasonKey;

/** The share of each input in the blend, in whole percent (inputs with no weight are 0). */
export function reasonShares(m: EstimateMeasure): number[] {
  let total = 0;
  for (const r of m.reasons) total += r.points === null ? 0 : r.weight;
  return m.reasons.map((r) => (total > 0 && r.points !== null ? Math.round((r.weight / total) * 100) : 0));
}

/** The line of a trend as an SVG path in a width x height box, 0 at the bottom and 100 at the top; breaks at a missing day. */
export function trendPath(values: ReadonlyArray<number | null>, width: number, height: number): { path: string; samples: number } {
  const n = values.length;
  let path = '';
  let samples = 0;
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    samples += 1;
    const x = n === 1 ? width / 2 : (i / (n - 1)) * width;
    const y = height - (Math.min(100, Math.max(0, v)) / 100) * height;
    path += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    pen = true;
  });
  return { path, samples };
}
