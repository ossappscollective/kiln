import { isRecord, postJson, retryAfterSeconds, textAt } from './http.ts';
import { azureCode, detectedTag, providerSource } from './languages.ts';
import {
  type TranslatedText,
  TranslateError,
  type TranslateInput,
  type TranslateOutput,
  type Translator,
  type TranslatorOptions,
} from './types.ts';

/**
 * Microsoft Translator (Azure AI Translator) text translation v3.0. Verified (checked 2026-11-18):
 * https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/v3/translate and
 * https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/authentication
 *
 * - `POST https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=<code>[&from=<code>]&textType=plain`,
 *   body `[{ "Text": "..." }]`, header `Ocp-Apim-Subscription-Key`. `Ocp-Apim-Subscription-Region`
 *   is needed for a regional or multi-service resource and optional for a global one (the page does
 *   not say `global` is a valid value, so an empty or `global` region sends no region header).
 * - Reply: an array in the order sent, each `{ detectedLanguage?: { language, score }, translations: [{ text, to }] }`;
 *   `detectedLanguage` is present only when `from` is not sent.
 * - Limits: 1000 elements and 50,000 characters per request (https://learn.microsoft.com/en-us/azure/ai-services/translator/service-limits);
 *   the free tier is limited to 2 million characters an hour on that page.
 * - Status codes: 400 (invalid parameter), 401 (authentication failed), 403 ("often means trial free
 *   translations are used up", reported as `quota`), 408, 429 (limit exceeded), 500, 503. The error
 *   body shape `{ error: { code, message } }` is UNVERIFIED (the status-code page could not be read),
 *   so classification is by status and tolerant of the body.
 * - A resource inside a virtual network needs its own address: not supported here (`baseUrl` is for tests).
 */

export const AZURE_TRANSLATOR_URL = 'https://api.cognitive.microsofttranslator.com';

export type AzureOptions = TranslatorOptions & { apiKey: string; region?: string | undefined };

function classify(status: number, json: unknown, retryAfter: string | null): TranslateError {
  const message = textAt(json, 'error', 'message').toLowerCase();
  const code = textAt(json, 'error', 'code');
  if (status === 429)
    return new TranslateError('rate_limited', {
      retryAfterSeconds: retryAfterSeconds(retryAfter, 30),
    });
  if (status === 401) return new TranslateError('auth');
  if (status === 403) return new TranslateError('quota');
  if (status === 400) {
    if (code === '400036' || code === '400035' || /language/.test(message)) {
      return new TranslateError('unsupported_language');
    }
    return new TranslateError('unavailable');
  }
  if (status === 413) return new TranslateError('too_large');
  return new TranslateError('unavailable');
}

export function createAzureTranslator(options: AzureOptions): Translator {
  const key = options.apiKey.trim();
  if (!key) throw new TranslateError('not_configured');
  const region = (options.region ?? '').trim();
  return {
    provider: 'azure',
    async translate(input: TranslateInput): Promise<TranslateOutput> {
      const target = azureCode(input.target);
      if (!target) throw new TranslateError('unsupported_language');
      const source = providerSource('azure', input.source);
      if (
        input.source !== undefined &&
        input.source !== '' &&
        input.source.toLowerCase() !== 'auto' &&
        !source
      ) {
        throw new TranslateError('unsupported_language');
      }
      const query = new URLSearchParams({ 'api-version': '3.0', to: target, textType: 'plain' });
      if (source) query.set('from', source);
      const reply = await postJson(
        {
          url: `${options.baseUrl ?? AZURE_TRANSLATOR_URL}/translate?${query.toString()}`,
          headers: {
            'ocp-apim-subscription-key': key,
            ...(region && region.toLowerCase() !== 'global'
              ? { 'ocp-apim-subscription-region': region }
              : {}),
          },
          body: input.texts.map((Text) => ({ Text })),
        },
        options,
      );
      if (reply.status < 200 || reply.status > 299)
        throw classify(reply.status, reply.json, reply.retryAfter);
      const list = reply.json;
      if (!Array.isArray(list) || list.length !== input.texts.length)
        throw new TranslateError('unavailable');
      const results: TranslatedText[] = list.map((item) => {
        const first =
          isRecord(item) && Array.isArray(item.translations) ? item.translations[0] : undefined;
        if (!isRecord(first) || typeof first.text !== 'string')
          throw new TranslateError('unavailable');
        const detected = detectedTag(
          isRecord(item) &&
            isRecord(item.detectedLanguage) &&
            typeof item.detectedLanguage.language === 'string'
            ? item.detectedLanguage.language
            : undefined,
        );
        return { text: first.text, ...(detected ? { detectedSource: detected } : {}) };
      });
      return { results };
    },
  };
}
