/**
 * Keyword popularity and difficulty ESTIMATES (model v1). Docs: docs/adr/0057-keyword-estimates.md, docs/api/aso.md#estimates.
 *
 * Neither Apple nor Google publishes how often a term is searched. Apple's 0 to 100 "popularity" exists only inside Apple Ads
 * and Google Play has nothing. So everything here is an ESTIMATE worked out from public signals Kiln can read, and from the
 * team's own data where it has some. It is never Apple's or Google's number, and it never shows as one: every result carries the
 * list of inputs it came from (`reasons`), a confidence, and where the signal came from (`origin`).
 *
 * Pure and deterministic: the same signals give the same result, so the stored signals are recomputed on read and a change of
 * the formula needs no migration (bump `KEYWORD_ESTIMATE_MODEL`). ES2017 only (the web imports it).
 *
 * Honest rules: no signal is "no estimate" (`score: null` with a reason), never 0. Google Play has no public signal at all, so
 * a Play keyword is estimated from the team's own search terms file only, else it has no estimate. Public signals alone never
 * give "high" confidence, and the difficulty never does.
 */

export const KEYWORD_ESTIMATE_MODEL = 'v1';

export type EstimateStore = 'app_store' | 'google_play';
export type EstimateConfidence = 'low' | 'medium' | 'high';
/** `own_data`: the team's own numbers took part. `public_signals`: only what the store shows anyone. */
export type EstimateOrigin = 'own_data' | 'ads_data' | 'public_signals';

/** What the App Store search hints (the suggestions under the search box) said for the term. */
export type HintsSignal = {
  /** 1-based position of the term itself in the list; null when it is not in the list. */
  position: number | null;
  /** The suggestions, in the store's order (at most 10 kept), lower case. */
  list: string[];
};
export type ResultApp = { id: string; name?: string; ratingCount?: number | null };
/** The first apps of the store's search for the term. */
export type ResultsSignal = {
  /** How many apps the search returned. */
  total: number;
  /** How many were asked for. */
  limit: number;
  top: ResultApp[];
};
/** The team's own numbers for the term (Google Play search terms file). A lower bound: only people who reached the listing. */
export type OwnSignal = { visitors: number | null; installs: number | null; days: number };

/**
 * What the team's own Apple Ads campaigns showed for the term (docs/adr/0058-apple-ads.md): impressions, taps and installs of the search
 * term over `days` days of data. A lower bound: only searches where an ad ran and won an impression are counted, and Apple may hide
 * low-volume terms. `null` (not 0) when the term never appeared in a report.
 */
export type AdsSignal = { impressions: number; taps: number; installs: number; days: number };

export type KeywordSignals = {
  term: string;
  hints?: HintsSignal | null | undefined;
  results?: ResultsSignal | null | undefined;
  own?: OwnSignal | null | undefined;
  /** Apple Ads campaigns of the team (App Store only). */
  ads?: AdsSignal | null | undefined;
  /** Positions of the own app in checks, oldest first; null: not in the results. */
  ranks?: Array<number | null> | undefined;
  /** The current rank of the own app: a number, null for "not ranked", undefined when never checked. */
  currentRank?: number | null | undefined;
};

/** `code` names the input (translated by the web, `aso:est.reason.<code>`); `params` are scalars for the sentence. */
export type EstimateReason = {
  code: string;
  params: Record<string, string | number>;
  /** What this input alone suggests, 0 to 100; null when it only explains (a limit, a missing input). */
  points: number | null;
  /** Its share in the blend, 0 when it is not part of the score. */
  weight: number;
};

export type EstimateMeasure = {
  /** 0 to 100, or null: no estimate. */
  score: number | null;
  confidence: EstimateConfidence | null;
  origin: EstimateOrigin | null;
  reasons: EstimateReason[];
};

export type KeywordEstimate = {
  model: typeof KEYWORD_ESTIMATE_MODEL;
  popularity: EstimateMeasure;
  difficulty: EstimateMeasure;
  /** High popularity, low difficulty and a poor current rank: where a person may gain. null when either estimate is missing. */
  opportunity: {
    score: number | null;
    confidence: EstimateConfidence | null;
    roomFactor: number | null;
  };
};

const clamp = (n: number, lo = 0, hi = 100): number => Math.min(hi, Math.max(lo, n));
const round = (n: number): number => Math.round(n);
const log10 = (n: number): number => Math.log(n) / Math.LN10;
const WEIGHTS = {
  own: 3,
  ads: 3,
  hints: 2,
  demand: 1,
  strength: 5,
  titleMatch: 3,
  crowding: 1,
  volatility: 1,
} as const;
/** An own sample below this many visitors is too small to count as strong evidence. */
export const OWN_MIN_VISITORS = 20;
/** An Apple Ads sample below this many impressions is too small to count as strong evidence. */
export const ADS_MIN_IMPRESSIONS = 100;
export const VOLATILITY_MIN_CHECKS = 5;
export const DIFFICULTY_MIN_APPS = 3;
export const DIFFICULTY_FULL_APPS = 10;

/** The words of a term, lower case, for matching app names. */
export function termWords(term: string): string[] {
  return term
    .toLowerCase()
    .split(/[\s\-_.,:;!?'"()[\]/&+]+/)
    .filter((w) => w !== '');
}

const none = (code: string, params: Record<string, string | number> = {}): EstimateMeasure => ({
  score: null,
  confidence: null,
  origin: null,
  reasons: [{ code, params, points: null, weight: 0 }],
});

function blend(parts: EstimateReason[]): number | null {
  let sum = 0;
  let weights = 0;
  for (const p of parts) {
    if (p.points === null || p.weight <= 0) continue;
    sum += p.points * p.weight;
    weights += p.weight;
  }
  return weights === 0 ? null : round(clamp(sum / weights));
}

export function estimatePopularity(store: EstimateStore, s: KeywordSignals): EstimateMeasure {
  const reasons: EstimateReason[] = [];
  let evidence = 0;
  const own = s.own;
  const hasOwn = !!own && own.visitors !== null;
  if (hasOwn && own) {
    const visitors = own.visitors ?? 0;
    reasons.push({
      code: 'own_visitors',
      params: { visitors, installs: own.installs ?? 0, days: own.days },
      points: round(clamp((log10(visitors + 1) / 4) * 100)),
      weight: WEIGHTS.own,
    });
    evidence += visitors >= OWN_MIN_VISITORS ? 2 : 1;
  }
  if (store === 'google_play') {
    if (!hasOwn) return none('play_needs_own_data');
    const score = blend(reasons);
    return { score, confidence: evidence >= 2 ? 'medium' : 'low', origin: 'own_data', reasons };
  }
  const ads = s.ads;
  const hasAds = !!ads;
  if (ads) {
    reasons.push({
      code: 'ads_impressions',
      params: {
        impressions: ads.impressions,
        taps: ads.taps,
        installs: ads.installs,
        days: ads.days,
      },
      points: round(clamp((log10(ads.impressions + 1) / 5) * 100)),
      weight: WEIGHTS.ads,
    });
    evidence += ads.impressions >= ADS_MIN_IMPRESSIONS ? 2 : 1;
  }
  const hints = s.hints;
  if (hints) {
    const size = hints.list.length;
    if (hints.position !== null) {
      reasons.push({
        code: 'hints_position',
        params: { position: hints.position, size },
        points: round(clamp(100 - (hints.position - 1) * (60 / 9))),
        weight: WEIGHTS.hints,
      });
    } else if (size > 0) {
      reasons.push({ code: 'hints_absent', params: { size }, points: 20, weight: WEIGHTS.hints });
    } else {
      reasons.push({ code: 'hints_empty', params: {}, points: 5, weight: WEIGHTS.hints });
    }
    evidence += 1;
  }
  const rated = (s.results?.top ?? [])
    .slice(0, 10)
    .filter((a) => typeof a.ratingCount === 'number');
  if (s.results && rated.length >= DIFFICULTY_MIN_APPS) {
    let sum = 0;
    for (const a of rated) sum += a.ratingCount ?? 0;
    reasons.push({
      code: 'results_demand',
      params: { apps: rated.length, ratings: sum },
      points: round(clamp((log10(sum + 1) / 7) * 100)),
      weight: WEIGHTS.demand,
    });
    evidence += 1;
  }
  const score = blend(reasons);
  if (score === null) return none('no_signal');
  return {
    score,
    confidence: evidence >= 3 ? 'high' : evidence === 2 ? 'medium' : 'low',
    origin: hasOwn ? 'own_data' : hasAds ? 'ads_data' : 'public_signals',
    reasons,
  };
}

const median = (xs: number[]): number => {
  const a = xs.slice().sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 === 1
    ? (a[mid] as number)
    : ((a[mid - 1] as number) + (a[mid] as number)) / 2;
};

export function estimateDifficulty(store: EstimateStore, s: KeywordSignals): EstimateMeasure {
  if (store === 'google_play') return none('play_no_competition_data');
  const r = s.results;
  if (!r) return none('no_signal');
  if (r.total === 0 || r.top.length === 0) return none('results_empty');
  const top = r.top.slice(0, 10);
  const rated = top.filter((a) => typeof a.ratingCount === 'number');
  if (rated.length < DIFFICULTY_MIN_APPS) return none('too_few_results', { apps: rated.length });
  const reasons: EstimateReason[] = [];
  const med = median(rated.map((a) => log10((a.ratingCount ?? 0) + 1)));
  reasons.push({
    code: 'results_strength',
    params: { apps: rated.length, medianRatings: round(10 ** med - 1) },
    points: round(clamp((med / 6) * 100)),
    weight: WEIGHTS.strength,
  });
  const words = termWords(s.term);
  const named = top.filter((a) => typeof a.name === 'string');
  if (words.length > 0 && named.length > 0) {
    const matching = named.filter((a) => {
      const name = (a.name ?? '').toLowerCase();
      return words.every((w) => name.indexOf(w) !== -1);
    }).length;
    reasons.push({
      code: 'results_title_match',
      params: { matching, apps: named.length },
      points: round((matching / named.length) * 100),
      weight: WEIGHTS.titleMatch,
    });
  }
  if (r.limit > 0) {
    reasons.push({
      code: 'results_crowding',
      params: { total: r.total, limit: r.limit },
      points: round(clamp((r.total / r.limit) * 100)),
      weight: WEIGHTS.crowding,
    });
  }
  const seen = (s.ranks ?? []).filter((x): x is number => typeof x === 'number');
  const checks = (s.ranks ?? []).length;
  if (checks >= VOLATILITY_MIN_CHECKS && seen.length >= 2) {
    let steps = 0;
    for (let i = 1; i < seen.length; i += 1)
      steps += Math.abs((seen[i] as number) - (seen[i - 1] as number));
    const mean = steps / (seen.length - 1);
    reasons.push({
      code: 'rank_volatility',
      params: { checks, meanMove: Math.round(mean * 10) / 10 },
      points: round(clamp((mean / 20) * 100)),
      weight: WEIGHTS.volatility,
    });
  }
  const score = blend(reasons);
  if (score === null) return none('no_signal');
  return {
    score,
    confidence: rated.length >= DIFFICULTY_FULL_APPS ? 'medium' : 'low',
    origin: 'public_signals',
    reasons,
  };
}

/** How much room a current rank leaves: not ranked is all of it, the first three places almost none. */
export function rankRoom(rank: number | null | undefined): number | null {
  if (rank === undefined) return null;
  if (rank === null) return 1;
  if (rank <= 3) return 0.1;
  if (rank <= 10) return 0.4;
  if (rank <= 30) return 0.8;
  return 1;
}

const lower = (a: EstimateConfidence, b: EstimateConfidence): EstimateConfidence =>
  a === 'low' || b === 'low' ? 'low' : a === 'medium' || b === 'medium' ? 'medium' : 'high';

export function estimateKeyword(store: EstimateStore, s: KeywordSignals): KeywordEstimate {
  const popularity = estimatePopularity(store, s);
  const difficulty = estimateDifficulty(store, s);
  let opportunity: KeywordEstimate['opportunity'] = {
    score: null,
    confidence: null,
    roomFactor: null,
  };
  if (
    popularity.score !== null &&
    difficulty.score !== null &&
    popularity.confidence &&
    difficulty.confidence
  ) {
    const room = rankRoom(s.currentRank);
    opportunity = {
      score: round(clamp(((popularity.score * (100 - difficulty.score)) / 100) * (room ?? 1))),
      confidence: lower(popularity.confidence, difficulty.confidence),
      roomFactor: room,
    };
  }
  return { model: KEYWORD_ESTIMATE_MODEL, popularity, difficulty, opportunity };
}

/** The same inputs, in the order a person should read them: the ones that moved the score most first. */
export function reasonsByWeight(m: EstimateMeasure): EstimateReason[] {
  return m.reasons.slice().sort((a, b) => b.weight - a.weight);
}
