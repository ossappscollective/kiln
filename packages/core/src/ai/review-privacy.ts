// What reviews may be sent to an AI provider, per app (docs/adr/0065-ai-review-privacy-and-competitor-schedule.md). Pure; ES2017 (the web imports it).
// The server applies it at the one place that builds an AI payload; the web only shows the result. Written for Kiln.

export const reviewAiDetails = ['full', 'text', 'ratings'] as const;
/**
 * full: stars, title, text, language, app version and day. text (the default): stars, title and text only, no reviewer name and no other
 * detail. ratings: no text at all, only counts and stars (the summary becomes statistical).
 */
export type ReviewAiDetail = (typeof reviewAiDetails)[number];
export const isReviewAiDetail = (value: unknown): value is ReviewAiDetail =>
  typeof value === 'string' && (reviewAiDetails as readonly string[]).includes(value);

/** The choice of an app for one kind of review. null: follow the workspace. */
export type ReviewAiSwitch = 'on' | 'off' | null;

export type ReviewAiPolicyStored = {
  ownReviews: ReviewAiSwitch;
  competitorReviews: ReviewAiSwitch;
  detail: ReviewAiDetail;
  redact: boolean;
};

export const defaultReviewAiPolicy = (): ReviewAiPolicyStored => ({
  ownReviews: null,
  competitorReviews: null,
  detail: 'text',
  redact: true,
});

/** The workspace level: the ceiling. An app cannot turn on what the workspace turned off. */
export type ReviewAiCeiling = { ownReviews: boolean; competitorReviews: boolean };

export type ReviewAiReason = 'workspace_off' | 'app_off';

export type ReviewAiKindState = {
  /** What the app chose (null: follows the workspace). */
  choice: ReviewAiSwitch;
  /** The result: may reviews of this kind go to an AI provider. */
  allowed: boolean;
  /** The workspace turned it off: the app's choice is shown locked and has no effect. */
  locked: boolean;
  reason: ReviewAiReason | null;
};

export type ReviewAiEffective = {
  own: ReviewAiKindState;
  competitor: ReviewAiKindState;
  detail: ReviewAiDetail;
  redact: boolean;
};

function kind(ceiling: boolean, choice: ReviewAiSwitch): ReviewAiKindState {
  if (!ceiling) return { choice, allowed: false, locked: true, reason: 'workspace_off' };
  if (choice === 'off') return { choice, allowed: false, locked: false, reason: 'app_off' };
  return { choice, allowed: true, locked: false, reason: null };
}

export function resolveReviewAiPolicy(ceiling: ReviewAiCeiling, stored: ReviewAiPolicyStored): ReviewAiEffective {
  return {
    own: kind(ceiling.ownReviews, stored.ownReviews),
    competitor: kind(ceiling.competitorReviews, stored.competitorReviews),
    detail: stored.detail,
    redact: stored.redact,
  };
}

export type ReviewAiPolicyIssue = { path: string; message: string };

/** Checks a body from a client. A field left out keeps its value in `base`. */
export function normalizeReviewAiPolicy(
  input: unknown,
  base: ReviewAiPolicyStored,
): { ok: true; value: ReviewAiPolicyStored } | { ok: false; issues: ReviewAiPolicyIssue[] } {
  const issues: ReviewAiPolicyIssue[] = [];
  const raw = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const value = { ...base };
  for (const key of ['ownReviews', 'competitorReviews'] as const) {
    if (raw[key] === undefined) continue;
    if (raw[key] === null || raw[key] === 'on' || raw[key] === 'off') value[key] = raw[key] as ReviewAiSwitch;
    else issues.push({ path: key, message: 'Use on, off or null (follow the workspace).' });
  }
  if (raw.detail !== undefined) {
    if (isReviewAiDetail(raw.detail)) value.detail = raw.detail;
    else issues.push({ path: 'detail', message: `Use one of ${reviewAiDetails.join(', ')}.` });
  }
  if (raw.redact !== undefined) {
    if (typeof raw.redact === 'boolean') value.redact = raw.redact;
    else issues.push({ path: 'redact', message: 'Use true or false.' });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

// ---------------------------------------------------------------------------------------------
// Redaction

const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/g;
const LINK = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
const PHONE = /(?:\+|\b)\d[\d\s().-]{6,}\d/g;
const HANDLE = /(^|[^A-Za-z0-9_@.])@[A-Za-z0-9_][A-Za-z0-9_.]{1,29}/g;

/**
 * Emails, links, phone-like numbers and @handles replaced by a marker ([email], [link], [number], [handle]), then the reviewer's own name
 * when it is known and at least 3 characters ([name]). A heuristic: it cannot find every name or number. Order matters: an email is
 * taken before a handle, a link before a number.
 */
export function redactReviewText(text: string, authorName: string | null): string {
  let out = text.replace(EMAIL, '[email]').replace(LINK, '[link]').replace(PHONE, '[number]').replace(HANDLE, '$1[handle]');
  out = maskName(out, authorName);
  return out;
}

/** Only the reviewer's name (never sent, whatever else is switched off). */
export function maskName(text: string, authorName: string | null): string {
  const name = (authorName === null ? '' : authorName).trim();
  if (name.length < 3) return text;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'gi'), '[name]');
}

export type ReviewForAi = {
  rating: number;
  title: string | null;
  body: string;
  authorName: string | null;
  language: string | null;
  appVersion: string | null;
  createdAt: number;
};

export type ShapedReview = {
  stars: number;
  title?: string;
  text?: string;
  lang?: string;
  version?: string;
  day?: string;
};

const clipText = (value: string, max: number): string => {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
};

/**
 * One review as it may leave the server under a policy. `ratings`: only the stars. `text`: stars, title, text. `full`: also language,
 * version and day. The reviewer's name and every other identifier are never part of it, and the name is also masked inside the text.
 */
export function shapeReviewForAi(
  review: ReviewForAi,
  policy: { detail: ReviewAiDetail; redact: boolean },
  limits: { titleChars: number; textChars: number },
): ShapedReview {
  if (policy.detail === 'ratings') return { stars: review.rating };
  const clean = (value: string) => clipText(policy.redact ? redactReviewText(value, review.authorName) : maskName(value, review.authorName), 100000);
  const title = clipText(clean(review.title === null ? '' : review.title), limits.titleChars);
  const text = clipText(clean(review.body), limits.textChars);
  const out: ShapedReview = { stars: review.rating };
  if (title !== '') out.title = title;
  if (text !== '') out.text = text;
  if (policy.detail === 'full') {
    if (review.language) out.lang = review.language;
    if (review.appVersion) out.version = review.appVersion;
    out.day = new Date(review.createdAt).toISOString().slice(0, 10);
  }
  return out;
}
