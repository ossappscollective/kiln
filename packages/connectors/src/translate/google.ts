import { isRecord, postJson, retryAfterSeconds, textAt } from './http.ts';
import { detectedTag, providerSource, providerTarget } from './languages.ts';
import {
  type TranslatedText,
  TranslateError,
  type TranslateInput,
  type TranslateOutput,
  type Translator,
  type TranslatorOptions,
} from './types.ts';

/**
 * Google Cloud Translation, Basic edition (v2), with an API key.
 *
 * - Endpoint `POST https://translation.googleapis.com/language/translate/v2`, body `q` (a list),
 *   `target`, optional `source`, `format` (`text` for plain text; the default is `html`), the key as
 *   the `key` query parameter. Reply `{ data: { translations: [{ translatedText, detectedSourceLanguage? }] } }`;
 *   `detectedSourceLanguage` is present only when `source` was not sent. At most 128 strings per
 *   request and 100 KB. Verified: https://docs.cloud.google.com/translate/docs/reference/rest/v2/translate
 *   and https://docs.cloud.google.com/translate/docs/translate-text (checked 2026-11-18).
 * - The key goes in the query string because that is what this method's page documents. Google
 *   documents the `x-goog-api-key` header for API keys in general
 *   (https://docs.cloud.google.com/docs/authentication/api-keys-use) but not on this method's page:
 *   `keyIn: 'header'` is offered and UNVERIFIED against this API. Nothing here logs or returns a URL.
 * - Quotas: 403 "Daily Limit Exceeded" or "User Rate Limit Exceeded"
 *   (https://docs.cloud.google.com/translate/quotas). Error body shape `{ error: { code, message,
 *   status, errors: [{ reason }] } }` is the usual Google one and UNVERIFIED for this API, so the
 *   classification is by status first and tolerant of the body.
 * - UNVERIFIED: that `format: 'text'` returns text without HTML entities. If a response has entities
 *   the translated text shows them as they are.
 * - A service account (OAuth, Advanced v3) is a later variant: it would be another factory with the
 *   same `Translator` interface and another secret field.
 */

export const GOOGLE_V2_URL = 'https://translation.googleapis.com/language/translate/v2';

export type GoogleOptions = TranslatorOptions & {
  apiKey: string;
  /** Where the key is sent. Default `query` (the documented place for this method). */
  keyIn?: 'query' | 'header';
};

function classify(status: number, json: unknown, retryAfter: string | null): TranslateError {
  const message = textAt(json, 'error', 'message');
  const reason =
    isRecord(json) &&
    isRecord(json.error) &&
    Array.isArray(json.error.errors) &&
    isRecord(json.error.errors[0])
      ? textAt(json.error.errors[0], 'reason')
      : '';
  const lower = `${message} ${reason}`.toLowerCase();
  if (status === 429 || /user rate limit|ratelimitexceeded/.test(lower)) {
    return new TranslateError('rate_limited', {
      retryAfterSeconds: retryAfterSeconds(retryAfter, 30),
    });
  }
  if (/daily limit|dailylimitexceeded|quota/.test(lower)) return new TranslateError('quota');
  if (status === 401 || status === 403) return new TranslateError('auth');
  if (status === 400) {
    if (/api key|api_key_invalid/.test(lower)) return new TranslateError('auth');
    if (/language|invalid value|invalid target|invalid source/.test(lower))
      return new TranslateError('unsupported_language');
    return new TranslateError('unavailable');
  }
  if (status === 413) return new TranslateError('too_large');
  return new TranslateError('unavailable');
}

export function createGoogleTranslator(options: GoogleOptions): Translator {
  if (!options.apiKey.trim()) throw new TranslateError('not_configured');
  return {
    provider: 'google',
    async translate(input: TranslateInput): Promise<TranslateOutput> {
      const target = providerTarget('google', input.target);
      if (!target) throw new TranslateError('unsupported_language');
      const source = providerSource('google', input.source);
      if (
        input.source !== undefined &&
        input.source !== '' &&
        input.source.toLowerCase() !== 'auto' &&
        !source
      ) {
        throw new TranslateError('unsupported_language');
      }
      const base = options.baseUrl ?? GOOGLE_V2_URL;
      const inHeader = options.keyIn === 'header';
      const reply = await postJson(
        {
          url: inHeader ? base : `${base}?key=${encodeURIComponent(options.apiKey.trim())}`,
          headers: inHeader ? { 'x-goog-api-key': options.apiKey.trim() } : {},
          body: { q: input.texts, target, ...(source ? { source } : {}), format: 'text' },
        },
        options,
      );
      if (reply.status < 200 || reply.status > 299)
        throw classify(reply.status, reply.json, reply.retryAfter);
      const list =
        isRecord(reply.json) && isRecord(reply.json.data)
          ? reply.json.data.translations
          : undefined;
      if (!Array.isArray(list) || list.length !== input.texts.length)
        throw new TranslateError('unavailable');
      const results: TranslatedText[] = list.map((item) => {
        if (!isRecord(item) || typeof item.translatedText !== 'string')
          throw new TranslateError('unavailable');
        const detected = detectedTag(
          typeof item.detectedSourceLanguage === 'string' ? item.detectedSourceLanguage : undefined,
        );
        return { text: item.translatedText, ...(detected ? { detectedSource: detected } : {}) };
      });
      return { results };
    },
  };
}
