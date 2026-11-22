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
} from '@kiln/core';
import { formatList, formatMinorUnits, formatNumber, formatPercent } from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';

/**
 * The pure logic of the AI reports (summary, tags, what to fix next, listing audit, ASO health) and of the AI context form of an app
 * (docs/ai-features.md). Everything a model wrote is data: this file only chooses words and numbers to show around it, and the screens
 * show the model's own text as plain text, never as markup. Written for the ES2017 web build.
 */

export const insightTitle = (proposal: AiInsightProposal): string => {
  switch (proposal.insight) {
    case 'review_summary':
      return t('ai:insight.title.reviewSummary', { period: periodText(proposal.period) });
    case 'review_classify':
      return t('ai:insight.title.reviewTags');
    case 'fix_next':
      return t('ai:insight.title.fixNext', { period: periodText(proposal.period) });
    case 'listing_audit':
      return t('ai:insight.title.listingAudit', { locale: proposal.locale });
    case 'aso_health':
      return t('ai:insight.title.asoHealth');
  }
};

export const periodText = (period: Pick<AiPeriod, 'days'>): string =>
  t('ai:insight.period.last', { count: period.days });

// ---------------------------------------------------------------------------------------------
// Words for the fixed vocabularies

const TOPIC_LABELS: Record<string, string> = {
  crash: k('ai:insight.topic.crash'),
  bug: k('ai:insight.topic.bug'),
  performance: k('ai:insight.topic.performance'),
  login: k('ai:insight.topic.login'),
  sync: k('ai:insight.topic.sync'),
  billing: k('ai:insight.topic.billing'),
  price: k('ai:insight.topic.price'),
  ads: k('ai:insight.topic.ads'),
  ui: k('ai:insight.topic.ui'),
  feature_request: k('ai:insight.topic.featureRequest'),
  privacy: k('ai:insight.topic.privacy'),
  notifications: k('ai:insight.topic.notifications'),
  support: k('ai:insight.topic.support'),
  onboarding: k('ai:insight.topic.onboarding'),
  content: k('ai:insight.topic.content'),
  praise: k('ai:insight.topic.praise'),
  other: k('ai:insight.topic.other'),
};
export const topicLabel = (topic: string): string => {
  const key = TOPIC_LABELS[topic];
  return key ? t(key) : topic;
};

const SENTIMENT_LABELS: Record<string, string> = {
  positive: k('ai:insight.sentiment.positive'),
  neutral: k('ai:insight.sentiment.neutral'),
  negative: k('ai:insight.sentiment.negative'),
  mixed: k('ai:insight.sentiment.mixed'),
};
/** The sentiment the model chose, in words ("negative"); a value this app does not know is shown as it came. */
export const sentimentLabel = (sentiment: string): string => {
  const key = SENTIMENT_LABELS[sentiment];
  return key ? t(key) : sentiment;
};

const SEVERITY_LABELS: Record<string, string> = {
  low: k('ai:insight.severity.low'),
  medium: k('ai:insight.severity.medium'),
  high: k('ai:insight.severity.high'),
};
/** "high severity" (a whole phrase per level: the adjective agrees with the noun in some languages). */
export const severityLabel = (severity: string): string => {
  const key = SEVERITY_LABELS[severity];
  return key ? t(key) : t('ai:insight.severity.other', { level: severity });
};
/** Just the level, for a badge ("high"). */
const LEVELS: Record<string, string> = {
  low: k('ai:insight.level.low'),
  medium: k('ai:insight.level.medium'),
  high: k('ai:insight.level.high'),
};
export const levelLabel = (level: string): string => {
  const key = LEVELS[level];
  return key ? t(key) : level;
};

const IMPACT_LABELS: Record<string, string> = {
  low: k('ai:insight.impact.low'),
  medium: k('ai:insight.impact.medium'),
  high: k('ai:insight.impact.high'),
};
/** "high impact". */
export const impactLabel = (impact: string): string => {
  const key = IMPACT_LABELS[impact];
  return key ? t(key) : t('ai:insight.impact.other', { level: impact });
};

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
  keywords: k('ai:insight.area.keywords'),
  listing: k('ai:insight.area.listing'),
  reviews: k('ai:insight.area.reviews'),
  competitors: k('ai:insight.area.competitors'),
  analytics: k('ai:insight.area.analytics'),
  other: k('ai:insight.area.other'),
};
export const healthAreaLabel = (area: string): string => {
  const key = AREA_LABELS[area as AiHealthArea];
  return key ? t(key) : area;
};

const THEME_LABELS: Record<string, string> = {
  issue: k('ai:insight.theme.issue'),
  praise: k('ai:insight.theme.praise'),
  request: k('ai:insight.theme.request'),
  other: k('ai:insight.theme.other'),
};
export const themeKindLabel = (kind: string): string => {
  const key = THEME_LABELS[kind];
  return key ? t(key) : kind;
};
export const themeKindTone = (kind: string): Tone =>
  kind === 'issue' ? 'bad' : kind === 'praise' ? 'ok' : 'info';

/** "3 reviews" with the right number word. */
export const reviewsText = (n: number): string => t('ai:insight.reviews', { count: n });

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
    ? t('ai:insight.basedOnNewest', { analysed: formatNumber(analysed), reviews: reviewsText(reviewCount) })
    : t('ai:insight.basedOn', { reviews: reviewsText(reviewCount) });

/** The one line of a tag set under a review: "Crash, Login · negative · high severity". */
export function tagLine(
  tags:
    | Pick<AiReviewTags, 'topics' | 'sentiment' | 'severity'>
    | { topics: string[]; sentiment: string; severity: string },
): string {
  const topics = tags.topics.map(topicLabel).join(', ');
  const parts = [topics, sentimentLabel(tags.sentiment)];
  if (tags.severity !== 'none') parts.push(severityLabel(tags.severity));
  return parts.filter((p) => p !== '').join(' · ');
}

/** "Subtitle: 16 of 30 characters (53%)" for the numbers the server counted in an audit. */
export function auditFieldText(f: AiAuditField): string {
  // The unit noun follows the last number the sentence says (the limit, or the length when there is no limit).
  const unitKey = f.unit === 'bytes' ? k('ai:insight.unit.bytes') : k('ai:insight.unit.characters');
  if (f.empty) {
    return f.limit === null
      ? t('ai:insight.audit.empty')
      : t('ai:insight.audit.emptyOf', { limit: formatNumber(f.limit), unit: t(unitKey, { count: f.limit }) });
  }
  if (f.limit === null)
    return t('ai:insight.audit.length', { length: formatNumber(f.length), unit: t(unitKey, { count: f.length }) });
  const values = { length: formatNumber(f.length), limit: formatNumber(f.limit), unit: t(unitKey, { count: f.limit }) };
  return f.percent === null
    ? t('ai:insight.audit.lengthOf', values)
    : t('ai:insight.audit.lengthOfPercent', { ...values, percent: formatPercent(Math.round(f.percent) / 100) });
}

export const rankText = (rank: number | null): string =>
  rank === null ? t('ai:insight.rank.none') : t('ai:insight.rank.value', { rank: formatNumber(rank) });

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
  bits.push(t('ai:insight.health.keywords', { count: b.keywords, ranked: b.ranked }));
  if (b.coachSteps > 0) bits.push(t('ai:insight.health.coachSteps', { count: b.coachSteps }));
  if (b.competitors > 0) bits.push(t('ai:insight.health.competitors', { count: b.competitors }));
  if (b.analyticsSeries > 0) bits.push(t('ai:insight.health.analytics'));
  return t('ai:insight.health.basedOn', { parts: formatList(bits, { type: 'unit' }) });
}

// ---------------------------------------------------------------------------------------------
// Money and the usage notice

/** Whole cents as a currency amount: "$12.34". Cents are exact integers; the sign and symbol are a display choice. */
export function centsText(cents: number): string {
  return formatMinorUnits(String(Math.trunc(cents)), 'USD');
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
    ? t('ai:insight.cost.ofCap', { cost: centsText(cost), cap: centsText(cap) })
    : t('ai:insight.cost.thisMonth', { cost: centsText(cost) });
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
  const values = {
    tokens: formatNumber(p.estimatedInputTokens),
    back: formatNumber(p.maxOutputTokens),
    model: p.model,
  };
  return p.includesAppContext
    ? t('ai:insight.preview.withContext', values)
    : t('ai:insight.preview.withoutContext', values);
}
