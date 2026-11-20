/**
 * Shapes of the AI features that go beyond one text (docs/adr/0024-ai-features.md, docs/ai-features.md): the per-app AI context, the
 * reports ("insights") the review and ASO tasks produce, listing variants, and the review tags. Plain functions and types only, nothing
 * newer than ES2017: the web imports this file.
 *
 * Same rule as the foundation (docs/adr/0016-ai-foundation.md): everything here is DATA a model PROPOSED, validated and post-processed by
 * the server. Numbers that can be counted are counted by the server, never taken from the model; ids a model cites are checked against the
 * ids that were sent; nothing here can push, submit, publish, release or send.
 */

import type { ListingStore } from './listing.ts';
import type { AiFlag } from './ai.ts';

// ---------------------------------------------------------------------------------------------
// The per-app AI context

export const aiContextLimits = {
  aboutChars: 600,
  audienceChars: 300,
  toneChars: 120,
  brandVoiceChars: 600,
  /** Entries of the banned words and brand terms lists. */
  termItems: 30,
  termChars: 40,
  /** Entries of the do and don't lists. */
  ruleItems: 8,
  ruleChars: 160,
} as const;

/** What a person tells the assistant about an app once, and every task then receives (only the parts that are filled in). */
export type AiAppContext = {
  /** What the app is, in a few sentences. */
  about: string;
  /** Who it is for. */
  audience: string;
  /** A few words: "warm, plain, no exclamation marks". */
  tone: string;
  /** How the developer sounds, in a paragraph (replies and rewrites follow it). */
  brandVoice: string;
  /** Words that must not appear in any text the assistant writes. */
  bannedWords: string[];
  /** Names that must be kept exactly as written (the product name, feature names). */
  brandTerms: string[];
  doList: string[];
  dontList: string[];
};

export const emptyAiAppContext = (): AiAppContext => ({
  about: '',
  audience: '',
  tone: '',
  brandVoice: '',
  bannedWords: [],
  brandTerms: [],
  doList: [],
  dontList: [],
});

export const aiContextKeys = [
  'about',
  'audience',
  'tone',
  'brandVoice',
  'bannedWords',
  'brandTerms',
  'doList',
  'dontList',
] as const;

export function isEmptyAiAppContext(context: AiAppContext): boolean {
  return (
    context.about === '' &&
    context.audience === '' &&
    context.tone === '' &&
    context.brandVoice === '' &&
    context.bannedWords.length === 0 &&
    context.brandTerms.length === 0 &&
    context.doList.length === 0 &&
    context.dontList.length === 0
  );
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
const CONTROL =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

function oneLine(value: string): string {
  return value.replace(CONTROL, '').replace(/\s+/g, ' ').trim();
}

function paragraph(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type AiContextIssue = { path: string; message: string };
export type AiContextResult =
  | { ok: true; value: AiAppContext }
  | { ok: false; issues: AiContextIssue[] };

/**
 * Validates what a person typed. Unknown keys are refused; text is cleaned (control characters removed); lists lose empty and repeated
 * entries. Too long is an issue and is never cut silently.
 */
export function normalizeAiAppContext(raw: unknown): AiContextResult {
  const issues: AiContextIssue[] = [];
  const out = emptyAiAppContext();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { ok: false, issues: [{ path: '', message: 'Send an object.' }] };
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if ((aiContextKeys as readonly string[]).indexOf(key) === -1)
      issues.push({ path: key, message: 'Not a field of the AI context.' });
  }
  const text = (
    key: 'about' | 'audience' | 'tone' | 'brandVoice',
    max: number,
    multiline: boolean,
  ) => {
    const value = input[key];
    if (value === undefined || value === null) return;
    if (typeof value !== 'string') {
      issues.push({ path: key, message: 'Use text.' });
      return;
    }
    const cleaned = multiline ? paragraph(value) : oneLine(value);
    if (Array.from(cleaned).length > max)
      issues.push({ path: key, message: `At most ${max} characters.` });
    else out[key] = cleaned;
  };
  text('about', aiContextLimits.aboutChars, true);
  text('audience', aiContextLimits.audienceChars, false);
  text('tone', aiContextLimits.toneChars, false);
  text('brandVoice', aiContextLimits.brandVoiceChars, true);
  const list = (
    key: 'bannedWords' | 'brandTerms' | 'doList' | 'dontList',
    items: number,
    chars: number,
  ) => {
    const value = input[key];
    if (value === undefined || value === null) return;
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      issues.push({ path: key, message: 'Use a list of text.' });
      return;
    }
    const seen: Record<string, boolean> = {};
    const cleaned: string[] = [];
    for (const entry of value as string[]) {
      const one = oneLine(entry);
      if (one === '' || seen[one.toLowerCase()]) continue;
      seen[one.toLowerCase()] = true;
      cleaned.push(one);
    }
    if (cleaned.length > items) issues.push({ path: key, message: `At most ${items} entries.` });
    else if (cleaned.some((c) => Array.from(c).length > chars))
      issues.push({ path: key, message: `Each entry has at most ${chars} characters.` });
    else out[key] = cleaned;
  };
  list('bannedWords', aiContextLimits.termItems, aiContextLimits.termChars);
  list('brandTerms', aiContextLimits.termItems, aiContextLimits.termChars);
  list('doList', aiContextLimits.ruleItems, aiContextLimits.ruleChars);
  list('dontList', aiContextLimits.ruleItems, aiContextLimits.ruleChars);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: out };
}

/** Whether `text` contains one of `words` as a whole word (case-insensitive, any language: boundaries are non-letters). Returns the first one found. */
export function findBannedWord(text: string, words: readonly string[]): string | undefined {
  const lower = text.toLowerCase();
  for (const word of words) {
    const needle = word.toLowerCase();
    if (needle === '') continue;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at === -1) break;
      const before = at === 0 ? '' : lower.charAt(at - 1);
      const after = lower.charAt(at + needle.length);
      const letter = /[a-z0-9À-ɏͰ-ϿЀ-ӿ]/;
      if (!(before !== '' && letter.test(before)) && !(after !== '' && letter.test(after)))
        return word;
      from = at + 1;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Review tags

/** The fixed vocabulary of review topics: counting and filtering need a small, stable list. Anything else a model says becomes `other`. */
export const aiReviewTopics = [
  'crash',
  'bug',
  'performance',
  'login',
  'sync',
  'billing',
  'price',
  'ads',
  'ui',
  'feature_request',
  'privacy',
  'notifications',
  'support',
  'onboarding',
  'content',
  'praise',
  'other',
] as const;
export type AiReviewTopic = (typeof aiReviewTopics)[number];

export const aiSentiments = ['positive', 'neutral', 'negative', 'mixed'] as const;
export type AiSentiment = (typeof aiSentiments)[number];

export const aiSeverities = ['none', 'low', 'medium', 'high'] as const;
export type AiSeverity = (typeof aiSeverities)[number];

/** One review as the assistant tagged it. Advisory: it changes nothing about the review itself (its status, assignee, reply). */
export type AiReviewTags = {
  reviewId: string;
  topics: AiReviewTopic[];
  sentiment: AiSentiment;
  severity: AiSeverity;
  /** A language tag the model gave, or the store's own language of the review. */
  language: string | null;
  needsReply: boolean;
};

// ---------------------------------------------------------------------------------------------
// Insights: reports that are read, not accepted. "Accepting" one only marks it reviewed.

export const aiInsightKinds = [
  'review_summary',
  'review_classify',
  'fix_next',
  'listing_audit',
  'aso_health',
] as const;
export type AiInsightKind = (typeof aiInsightKinds)[number];

export type AiPeriod = { days: number; from: number; to: number };

export const aiThemeKinds = ['issue', 'praise', 'request', 'other'] as const;
export type AiThemeKind = (typeof aiThemeKinds)[number];

export type AiReviewTheme = {
  label: string;
  kind: AiThemeKind;
  summary: string;
  /** Distinct reviews cited that were really in the data. Counted by the server. */
  count: number;
  /** The evidence: ids of reviews of this app (their ids in this tool). */
  reviewIds: string[];
  /** Mean star rating of the cited reviews, one decimal, or null. */
  averageRating: number | null;
};

export type AiReviewSummaryInsight = {
  kind: 'insight';
  insight: 'review_summary';
  period: AiPeriod;
  /** Reviews in the period, and how many of them were sent (the newest with text; a larger inbox is sampled, and says so in `notes`). */
  reviewCount: number;
  analysed: number;
  /** From the star ratings (4 and 5, 3, 1 and 2), counted by the server over the analysed reviews. */
  sentiment: { positive: number; neutral: number; negative: number };
  overview: string;
  /** Largest first. `kind` tells issues, praise and requests apart. */
  themes: AiReviewTheme[];
  notes: string[];
};

export type AiReviewClassifyInsight = {
  kind: 'insight';
  insight: 'review_classify';
  /** Tagged by this run, tagged earlier (the cache: no tokens spent), and still to tag. */
  classified: number;
  cached: number;
  remaining: number;
  items: AiReviewTags[];
  notes: string[];
};

export type AiFixItem = {
  title: string;
  why: string;
  /** A short area word from the model ("login", "sync"). */
  area: string;
  severity: AiSeverity;
  reviewIds: string[];
  count: number;
  /** In which app versions the cited reviews were written, counted by the server. */
  versions: { version: string; count: number }[];
};

export type AiFixNextInsight = {
  kind: 'insight';
  insight: 'fix_next';
  period: AiPeriod;
  reviewCount: number;
  analysed: number;
  /** Complaints per app version in the period: the reviews with 3 stars or fewer, and their mean rating. Counted by the server. */
  versionStats: { version: string; reviews: number; complaints: number; averageRating: number }[];
  items: AiFixItem[];
  /** A draft of "What is new" text for the next release. Plain text; its length is counted by the server against the store limit. */
  releaseNotes: string;
  releaseNotesLength: number;
  releaseNotesLimit: number;
  releaseNotesFlags: AiFlag[];
  notes: string[];
};

export type AiAuditField = {
  field: string;
  label: string;
  length: number;
  limit: number | null;
  unit: 'characters' | 'bytes';
  percent: number | null;
  empty: boolean;
};
export type AiAuditCoverage = { term: string; rank: number | null; inFields: string[] };
export type AiAuditFinding = {
  field: string | null;
  problem: string;
  recommendation: string;
  impact: 'high' | 'medium' | 'low';
  /** Why the model expects this to matter. Reasoning, not a measurement: it never has a rank number the data did not hold. */
  reasoning: string;
  /** Tracked keywords the finding is about (only terms the app tracks). */
  keywords: string[];
  flags: AiFlag[];
};
export type AiListingAuditInsight = {
  kind: 'insight';
  insight: 'listing_audit';
  locale: string;
  store: ListingStore;
  /** Counted by the server. */
  fields: AiAuditField[];
  coverage: AiAuditCoverage[];
  findings: AiAuditFinding[];
  notes: string[];
};

export const aiHealthAreas = [
  'keywords',
  'listing',
  'reviews',
  'competitors',
  'analytics',
  'other',
] as const;
export type AiHealthArea = (typeof aiHealthAreas)[number];

export type AiHealthAction = {
  position: number;
  title: string;
  detail: string;
  area: AiHealthArea;
  flags: AiFlag[];
};
export type AiAsoHealthInsight = {
  kind: 'insight';
  insight: 'aso_health';
  summary: string;
  actions: AiHealthAction[];
  /** What the report was worked out from, counted by the server. */
  basedOn: {
    keywords: number;
    ranked: number;
    coachSteps: number;
    competitors: number;
    analyticsSeries: number;
    lastCheckAt: number | null;
  };
  notes: string[];
};

export type AiInsightProposal =
  | AiReviewSummaryInsight
  | AiReviewClassifyInsight
  | AiFixNextInsight
  | AiListingAuditInsight
  | AiAsoHealthInsight;

// ---------------------------------------------------------------------------------------------
// Listing variants

export type AiVariant = {
  text: string;
  reason: string;
  /** In the unit of the field, counted by the server. */
  length: number;
  acceptable: boolean;
  flags: AiFlag[];
};

export type AiVariantField = {
  field: string;
  limit: number | null;
  unit: 'characters' | 'bytes';
  /** Several alternatives for one field. A person picks at most one per field. */
  variants: AiVariant[];
};

export type AiVariantsProposal = {
  kind: 'listing_variants';
  locale: string;
  fields: AiVariantField[];
};
