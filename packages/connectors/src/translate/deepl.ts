import { detectedTag, deeplSource, deeplTarget } from './languages.ts';
import { isRecord, postJson, retryAfterSeconds } from './http.ts';
import { TranslateError, type TranslateInput, type TranslateOutput, type TranslatedText, type Translator, type TranslatorOptions } from './types.ts';

/**
 * DeepL API v2 `POST /v2/translate`. Verified (checked 2026-11-18):
 * https://developers.deepl.com/api-reference/translate/request-translation and
 * https://developers.deepl.com/docs/getting-started/auth
 *
 * - Free keys end in `:fx` and use `https://api-free.deepl.com`; Pro keys use `https://api.deepl.com`.
 *   A key on the wrong address fails, so the address is chosen from the key.
 * - `Authorization: DeepL-Auth-Key <key>`, JSON body `{ text: [..], target_lang, source_lang? }`,
 *   reply `{ translations: [{ detected_source_language, text }] }` in the order sent. 128 KiB per request.
 * - Errors: 403 (key), 456 (quota exceeded), 429 and 529 (too many requests), 413 (too large),
 *   400 (invalid request), 500 and 504 (server).
 * - Language codes need DeepL's variants (`EN-GB`, `PT-BR`, ...): see languages.ts. The list of
 *   supported codes could not be read (rendered by script); a refused code is a 400 whose message
 *   names the language parameter, which is reported as `unsupported_language`.
 */

export const DEEPL_FREE_URL = 'https://api-free.deepl.com';
export const DEEPL_PRO_URL = 'https://api.deepl.com';

export type DeeplOptions = TranslatorOptions & { apiKey: string };

/** The Free address for a key ending in `:fx`, else the Pro address. */
export const deeplBaseUrl = (apiKey: string): string => (apiKey.trim().endsWith(':fx') ? DEEPL_FREE_URL : DEEPL_PRO_URL);

function classify(status: number, json: unknown, retryAfter: string | null): TranslateError {
  const message = isRecord(json) && typeof json.message === 'string' ? json.message.toLowerCase() : '';
  if (status === 429 || status === 529) return new TranslateError('rate_limited', { retryAfterSeconds: retryAfterSeconds(retryAfter, 30) });
  if (status === 456) return new TranslateError('quota');
  if (status === 401 || status === 403) return new TranslateError('auth');
  if (status === 413) return new TranslateError('too_large');
  if (status === 400 && /target_lang|source_lang|language/.test(message)) return new TranslateError('unsupported_language');
  return new TranslateError('unavailable');
}

export function createDeeplTranslator(options: DeeplOptions): Translator {
  const key = options.apiKey.trim();
  if (!key) throw new TranslateError('not_configured');
  return {
    provider: 'deepl',
    async translate(input: TranslateInput): Promise<TranslateOutput> {
      const target = deeplTarget(input.target);
      if (!target) throw new TranslateError('unsupported_language');
      const source = input.source === undefined || input.source === '' || input.source.toLowerCase() === 'auto' ? undefined : deeplSource(input.source);
      if (input.source !== undefined && input.source !== '' && input.source.toLowerCase() !== 'auto' && !source) {
        throw new TranslateError('unsupported_language');
      }
      const reply = await postJson(
        {
          url: `${options.baseUrl ?? deeplBaseUrl(key)}/v2/translate`,
          headers: { authorization: `DeepL-Auth-Key ${key}` },
          body: { text: input.texts, target_lang: target, ...(source ? { source_lang: source } : {}) },
        },
        options,
      );
      if (reply.status < 200 || reply.status > 299) throw classify(reply.status, reply.json, reply.retryAfter);
      const list = isRecord(reply.json) ? reply.json.translations : undefined;
      if (!Array.isArray(list) || list.length !== input.texts.length) throw new TranslateError('unavailable');
      const results: TranslatedText[] = list.map((item) => {
        if (!isRecord(item) || typeof item.text !== 'string') throw new TranslateError('unavailable');
        const detected = detectedTag(typeof item.detected_source_language === 'string' ? item.detected_source_language : undefined);
        return { text: item.text, ...(detected ? { detectedSource: detected } : {}) };
      });
      return { results };
    },
  };
}
