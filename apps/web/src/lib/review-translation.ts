import { type Role, type TranslationProvider, can, sameLanguage, translationLimits, translationProviderInfo } from '@mrm/core';
import { ApiError } from './api.ts';
import { languageName } from './settings.ts';

/** Translating reviews (docs/api/reviews.md, "Translation"): shapes and the logic of the review translation UI. */

export type ReviewTranslation = {
  reviewId: string;
  title?: string;
  body?: string;
  detectedSource?: string;
  provider: TranslationProvider;
  cached: boolean;
  sameLanguage?: boolean;
  truncated?: boolean;
};

export type TranslateReviewsResult = {
  provider: TranslationProvider;
  target: string;
  translations: ReviewTranslation[];
  notFound: string[];
  cached: boolean;
};

export const MAX_REVIEW_IDS = translationLimits.maxReviewIds;

/** Whether this role may ask for translations (the server decides too). */
export const canTranslate = (role: Role): boolean => can(role, 'reviews.translate');

/** The part of a review the button needs. */
export type Translatable = { id: string; title: string | null; body: string; language: string | null };

const hasText = (r: Translatable): boolean => r.body.trim() !== '' || (r.title ?? '').trim() !== '';

/**
 * Whether to offer "Translate": the review has text and is not already in the target language. A
 * review with no stored language (the App Store does not send one) is offered, as the provider detects it.
 */
export function needsTranslation(review: Translatable, target: string): boolean {
  if (!hasText(review)) return false;
  if (review.language && sameLanguage(review.language, target)) return false;
  return true;
}

/** The ids to translate for "Translate all visible": those that need it, at most one request's worth, in order. */
export function translatableIds(reviews: Translatable[], target: string, limit: number = MAX_REVIEW_IDS): string[] {
  const out: string[] = [];
  for (const review of reviews) {
    if (out.length >= limit) break;
    if (needsTranslation(review, target)) out.push(review.id);
  }
  return out;
}

/** Splits ids into requests of at most 25. */
export function chunkIds(ids: string[], size: number = MAX_REVIEW_IDS): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** "Translated from German by Google Cloud Translation", with a note when it was kept from before. */
export function translationCaption(t: ReviewTranslation, reviewLanguage: string | null): string {
  const from = t.detectedSource ?? reviewLanguage;
  const provider = translationProviderInfo[t.provider]?.label ?? t.provider;
  return `Machine translation${from ? ` from ${languageName(from)}` : ''} by ${provider}${t.cached ? ' (kept from an earlier request)' : ''}.`;
}

/** Said under a translation: the text left this server. */
export function privacyNote(provider: TranslationProvider): string {
  return translationProviderInfo[provider]?.privacy ?? 'Review text was sent to the translation provider.';
}

export function translationErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  const reason = typeof error.body.reason === 'string' ? error.body.reason : '';
  switch (error.code) {
    case 'translation_not_configured':
      return reason === 'disabled'
        ? 'Translation is turned off. An admin can turn it on under Settings.'
        : 'Translation is not fully set up. An admin can finish it under Settings.';
    case 'translation_budget': {
      const used = Number(error.body.used);
      const budget = Number(error.body.budget);
      return Number.isFinite(used) && Number.isFinite(budget)
        ? `The daily translation budget is used up (${used.toLocaleString('en-US')} of ${budget.toLocaleString('en-US')} characters). It resets at 00:00 UTC; an admin can raise it under Settings.`
        : 'The daily translation budget is used up. It resets at 00:00 UTC.';
    }
    case 'translation_rate_limited':
    case 'rate_limited':
      return error.message;
    case 'forbidden':
      return 'Only a member or admin can translate reviews.';
    case 'not_found':
      return 'This app or review no longer exists.';
    case 'translation_unavailable':
      return reason ? `${error.message} (${reason})` : error.message;
    case 'translation_auth':
    case 'translation_quota':
    case 'translation_unsupported_language':
    case 'translation_too_large':
      return error.message;
    default:
      return error.message || 'Something went wrong. Try again.';
  }
}

/** Whether a failure is worth showing a "Try again" for. */
export const isRetryable = (error: unknown): boolean =>
  error instanceof ApiError && (error.code === 'translation_unavailable' || error.code === 'translation_rate_limited' || error.code === 'rate_limited');
