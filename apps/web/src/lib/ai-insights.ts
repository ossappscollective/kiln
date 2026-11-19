import {
  type AiAppContext,
  type AiAuditField,
  type AiHealthArea,
  type AiInsightProposal,
  type AiPeriod,
  type AiReviewTags,
  type AiSentiment,
  type AiSeverity,
  aiContextLimits,
  emptyAiAppContext,
  normalizeAiAppContext,
} from '@mrm/core';

/**
 * The pure logic of the AI reports (summary, tags, what to fix next, listing audit, ASO health) and of the AI context form of an app
 * (docs/ai-features.md). Everything a model wrote is data: this file only chooses words and numbers to show around it, and the screens
 * show the model's own text as plain text, never as markup. Written for the ES2017 web build.
 */

export const insightTitle = (proposal: AiInsightProposal): string => {
  switch (proposal.insight) {
    case 'review_summary':
      return `Review summary · ${periodText(proposal.period)}`;
    case 'review_classify':
      return 'Review tags';
    case 'fix_next':
      return `What to fix next · ${periodText(proposal.period)}`;
    case 'listing_audit':
      return `Listing audit · ${proposal.locale}`;
    case 'aso_health':
      return 'ASO health report';
  }
};

export const periodText = (period: Pick<AiPeriod, 'days'>): string =>
  period.days === 1 ? 'last day' : `last ${period.days} days`;

// ---------------------------------------------------------------------------------------------
// Words for the fixed vocabularies

const TOPIC_LABELS: Record<string, string> = {
  crash: 'Crash',
  bug: 'Bug',
  performance: 'Performance',
  login: 'Login',
  sync: 'Sync',
  billing: 'Billing',
  price: 'Price',
  ads: 'Ads',
  ui: 'Design',
  feature_request: 'Feature request',
  privacy: 'Privacy',
  notifications: 'Notifications',
  support: 'Support',
  onboarding: 'Onboarding',
  content: 'Content',
  praise: 'Praise',
  other: 'Other',
};
export const topicLabel = (topic: string): string => TOPIC_LABELS[topic] ?? topic;

export type Tone = 'ok' | 'warn' | 'bad' | 'info';

export const sentimentTone = (sentiment: AiSentiment | string): Tone =>
  sentiment === 'positive'
    ? 'ok'
    : sentiment === 'negative'
      ? 'bad'
      : sentiment === 'mixed'
        ? 'warn'
        : 'info';
export const severityTone = (severity: AiSeverity | string): Tone =>
  severity === 'high' ? 'bad' : severity === 'medium' ? 'warn' : 'info';
export const impactTone = (impact: string): Tone =>
  impact === 'high' ? 'bad' : impact === 'medium' ? 'warn' : 'info';

const AREA_LABELS: Record<AiHealthArea, string> = {
  keywords: 'Keywords',
  listing: 'Store listing',
  reviews: 'Reviews',
  competitors: 'Competitors',
  analytics: 'Analytics',
  other: 'Other',
};
export const healthAreaLabel = (area: string): string => AREA_LABELS[area as AiHealthArea] ?? area;

const THEME_LABELS: Record<string, string> = {
  issue: 'Problem',
  praise: 'Praise',
  request: 'Request',
  other: 'Other',
};
export const themeKindLabel = (kind: string): string => THEME_LABELS[kind] ?? kind;
export const themeKindTone = (kind: string): Tone =>
  kind === 'issue' ? 'bad' : kind === 'praise' ? 'ok' : 'info';

/** "3 reviews" with the right number word. */
export const reviewsText = (n: number): string => `${n} ${n === 1 ? 'review' : 'reviews'}`;

/** Shares of the three star groups as whole percents of the analysed reviews (they can add to 99 or 101: they are rounded). */
export function sentimentShares(sentiment: {
  positive: number;
  neutral: number;
  negative: number;
}): { positive: number; neutral: number; negative: number } {
  const total = sentiment.positive + sentiment.neutral + sentiment.negative;
  if (total <= 0) return { positive: 0, neutral: 0, negative: 0 };
  const pct = (n: number): number => Math.round((n / total) * 100);
  return {
    positive: pct(sentiment.positive),
    neutral: pct(sentiment.neutral),
    negative: pct(sentiment.negative),
  };
}

/** "Based on 38 of 112 reviews" or "Based on 112 reviews". */
export const basedOnText = (analysed: number, reviewCount: number): string =>
  analysed < reviewCount
    ? `Based on the newest ${analysed} of ${reviewsText(reviewCount)}.`
    : `Based on ${reviewsText(reviewCount)}.`;

/** The one line of a tag set under a review: "Crash, Login · negative · high severity". */
export function tagLine(
  tags:
    | Pick<AiReviewTags, 'topics' | 'sentiment' | 'severity'>
    | { topics: string[]; sentiment: string; severity: string },
): string {
  const topics = tags.topics.map(topicLabel).join(', ');
  const parts = [topics, tags.sentiment];
  if (tags.severity !== 'none') parts.push(`${tags.severity} severity`);
  return parts.filter((p) => p !== '').join(' · ');
}

/** "Subtitle: 16 of 30 characters (53%)" for the numbers the server counted in an audit. */
export function auditFieldText(f: AiAuditField): string {
  const unit = f.unit === 'bytes' ? 'bytes' : 'characters';
  if (f.empty) return f.limit === null ? 'Empty' : `Empty (0 of ${f.limit} ${unit})`;
  if (f.limit === null) return `${f.length} ${unit}`;
  return `${f.length} of ${f.limit} ${unit}${f.percent === null ? '' : ` (${Math.round(f.percent)}%)`}`;
}

export const rankText = (rank: number | null): string =>
  rank === null ? 'Not ranked' : `Rank ${rank}`;

/** The notes of a report: sentences the server wrote (a sample, a dropped reference). Plain text. */
export const reportNotes = (proposal: AiInsightProposal): string[] =>
  proposal.notes.filter((n) => n.trim() !== '');

/** "Based on 14 keywords (9 with a rank), 3 coach steps, 2 competitors." from the counts the server made. */
export function healthBasis(b: {
  keywords: number;
  ranked: number;
  coachSteps: number;
  competitors: number;
  analyticsSeries: number;
}): string {
  const bits: string[] = [];
  bits.push(`${b.keywords} ${b.keywords === 1 ? 'keyword' : 'keywords'} (${b.ranked} with a rank)`);
  if (b.coachSteps > 0) bits.push(`${b.coachSteps} coach ${b.coachSteps === 1 ? 'step' : 'steps'}`);
  if (b.competitors > 0)
    bits.push(`${b.competitors} ${b.competitors === 1 ? 'competitor' : 'competitors'}`);
  if (b.analyticsSeries > 0) bits.push('store analytics');
  return `Based on ${bits.join(', ')}.`;
}

// ---------------------------------------------------------------------------------------------
// Money and the usage notice

/** Whole cents as a currency amount: "$12.34". Cents are exact integers; the sign and symbol are a display choice. */
export function centsText(cents: number): string {
  const whole = Math.floor(Math.abs(cents) / 100);
  const rest = String(Math.abs(cents) % 100);
  return `${cents < 0 ? '-' : ''}$${whole.toLocaleString('en')}.${rest.length === 1 ? `0${rest}` : rest}`;
}

/** Dollars typed by a person ("12.5", "$3") to whole cents, or null when it is not an amount. "" is 0. */
export function centsFromText(text: string): number | null {
  const t = text.trim().replace(/^\$/, '').replace(/,/g, '');
  if (t === '') return 0;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/** Whole cents as the text of an input ("12.5", "0"). */
export function centsInput(cents: number): string {
  if (cents <= 0) return '0';
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0
    ? String(whole)
    : `${whole}.${rest < 10 ? `0${rest}` : String(rest).replace(/0$/, '')}`;
}

/** The line of the settings card that says what the month cost so far, with the caveat that it is an estimate. */
export function costLine(usage: {
  estimatedCostCents?: number;
  costCapCents?: number;
  pricesSet?: boolean;
}): string | null {
  if (!usage.pricesSet) return null;
  const cost = usage.estimatedCostCents ?? 0;
  const cap = usage.costCapCents ?? 0;
  return cap > 0
    ? `About ${centsText(cost)} of ${centsText(cap)} this month (an estimate from the prices you entered).`
    : `About ${centsText(cost)} this month (an estimate from the prices you entered).`;
}

// ---------------------------------------------------------------------------------------------
// The AI context of an app, as a form

/** The lists are typed one entry per line in the form; the text fields as they are. */
export type AiContextForm = {
  about: string;
  audience: string;
  tone: string;
  brandVoice: string;
  bannedWords: string;
  brandTerms: string;
  doList: string;
  dontList: string;
};

const joinLines = (list: readonly string[]): string => list.join('\n');
const splitLines = (text: string): string[] =>
  text
    .split(/\r?\n|,/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
// Rules are sentences and may hold commas, so only a new line separates them.
const splitRules = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');

export const emptyContextForm = (): AiContextForm => contextToForm(emptyAiAppContext());

export function contextToForm(context: AiAppContext): AiContextForm {
  return {
    about: context.about,
    audience: context.audience,
    tone: context.tone,
    brandVoice: context.brandVoice,
    bannedWords: joinLines(context.bannedWords),
    brandTerms: joinLines(context.brandTerms),
    doList: joinLines(context.doList),
    dontList: joinLines(context.dontList),
  };
}

export function formToContext(form: AiContextForm): AiAppContext {
  return {
    about: form.about.trim(),
    audience: form.audience.trim(),
    tone: form.tone.trim(),
    brandVoice: form.brandVoice.trim(),
    bannedWords: splitLines(form.bannedWords),
    brandTerms: splitLines(form.brandTerms),
    doList: splitRules(form.doList),
    dontList: splitRules(form.dontList),
  };
}

export type AiContextErrors = Partial<Record<keyof AiContextForm, string>>;

/** The checks the server makes, so the sentence shows next to the field before a save. Returns the cleaned context when it is fine. */
export function validateContextForm(
  form: AiContextForm,
): { ok: true; value: AiAppContext } | { ok: false; errors: AiContextErrors } {
  const result = normalizeAiAppContext(formToContext(form));
  if (result.ok) return { ok: true, value: result.value };
  const errors: AiContextErrors = {};
  for (const issue of result.issues) {
    const key = issue.path as keyof AiContextForm;
    if (errors[key] === undefined) errors[key] = issue.message;
  }
  return { ok: false, errors };
}

export function isContextDirty(saved: AiAppContext, form: AiContextForm): boolean {
  const a = contextToForm(saved);
  const keys = Object.keys(a) as (keyof AiContextForm)[];
  const b = contextToForm(formToContext(form));
  return keys.some((k) => a[k] !== b[k]);
}

/** The most characters of each context field, for the counters of the form. */
export const contextLimits = aiContextLimits;

// ---------------------------------------------------------------------------------------------
// "What will be sent": the preview of a run

/** The most characters of the data the preview shows; the rest is cut and says so (the model still gets all of it). */
export const PREVIEW_CHARS = 6000;

/** The exact data of a run as text (JSON, indented), cut at `max` characters. `cut` says whether something was left out of the view. */
export function previewText(
  input: unknown,
  max: number = PREVIEW_CHARS,
): { text: string; cut: boolean } {
  let text = '';
  try {
    text = JSON.stringify(input, null, 2) ?? '';
  } catch {
    text = '';
  }
  if (text.length <= max) return { text, cut: false };
  return { text: text.slice(0, max), cut: true };
}

/** One sentence of numbers for a preview: the estimated size and where it would go. */
export function previewFacts(p: {
  estimatedInputTokens: number;
  maxOutputTokens: number;
  includesAppContext: boolean;
  model: string;
}): string {
  const tokens = p.estimatedInputTokens.toLocaleString('en');
  const back = p.maxOutputTokens.toLocaleString('en');
  return `About ${tokens} tokens go out and at most ${back} come back (model ${p.model}). ${p.includesAppContext ? 'What you wrote about this app is included.' : 'What you wrote about this app is not included.'}`;
}
