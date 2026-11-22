import {
  can,
  type Role,
  sameLanguage,
  type TranslationProvider,
  translationLimits,
  translationProviderInfo,
} from '@kiln/core';
import { ApiError } from '../api.ts';
import { formatNumber } from '../i18n/format.ts';
import { t } from '../i18n/t.ts';
import { languageName, providerPrivacy } from '../settings.ts';

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
export type Translatable = {
  id: string;
  title: string | null;
  body: string;
  language: string | null;
};

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
export function translatableIds(
  reviews: Translatable[],
  target: string,
  limit: number = MAX_REVIEW_IDS,
): string[] {
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
export function translationCaption(item: ReviewTranslation, reviewLanguage: string | null): string {
  const from = item.detectedSource ?? reviewLanguage;
  const provider = translationProviderInfo[item.provider]?.label ?? item.provider;
  const params = { provider, from: from ? languageName(from) : '' };
  return from
    ? item.cached
      ? t('reviews:translation.captionFromCached', params)
      : t('reviews:translation.captionFrom', params)
    : item.cached
      ? t('reviews:translation.captionCached', params)
      : t('reviews:translation.caption', params);
}

/** Said under a translation: the text left this server. */
export function privacyNote(provider: TranslationProvider): string {
  return translationProviderInfo[provider]
    ? providerPrivacy(provider)
    : t('reviews:translation.privacyDefault');
}

export function translationErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return t('reviews:error.generic');
  const reason = typeof error.body.reason === 'string' ? error.body.reason : '';
  switch (error.code) {
    case 'translation_not_configured':
      return reason === 'disabled'
        ? t('reviews:translation.off')
        : t('reviews:translation.notSetUp');
    case 'translation_budget': {
      const used = Number(error.body.used);
      const budget = Number(error.body.budget);
      return Number.isFinite(used) && Number.isFinite(budget)
        ? t('reviews:translation.budgetUsed', {
            used: formatNumber(used),
            budget: formatNumber(budget),
          })
        : t('reviews:translation.budgetUsedShort');
    }
    case 'translation_rate_limited':
    case 'rate_limited':
      return error.message;
    case 'forbidden':
      return t('reviews:translation.forbidden');
    case 'not_found':
      return t('reviews:error.appOrReviewGone');
    case 'translation_unavailable':
    case 'translation_unsupported_language':
      return reason
        ? t('reviews:translation.withHint', {
            message: error.message,
            hint: unsupportedHint(reason),
          })
        : error.message;
    case 'translation_auth':
    case 'translation_quota':
    case 'translation_too_large':
      return error.message;
    default:
      return error.message || t('reviews:error.generic');
  }
}

/** Whether a failure is worth showing a "Try again" for. */
export const isRetryable = (error: unknown): boolean =>
  error instanceof ApiError &&
  (error.code === 'translation_unavailable' ||
    error.code === 'translation_rate_limited' ||
    error.code === 'rate_limited');

/** The fixed hints of an unsupported language, in words. Anything else is shown as it is. */
export function unsupportedHint(reason: string): string {
  const pair = /^pair_([a-z-]+)_to_([a-z-]+)$/.exec(reason);
  if (pair) return t('reviews:translation.hint.pair', { from: pair[1] ?? '', to: pair[2] ?? '' });
  if (reason === 'lang_target') return t('reviews:translation.hint.target');
  if (reason === 'lang_source') return t('reviews:translation.hint.source');
  return reason;
}
