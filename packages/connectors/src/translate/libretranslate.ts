import { detectedTag, libreTranslateCode } from './languages.ts';
import { isRecord, postJson, retryAfterSeconds, textAt } from './http.ts';
import { TranslateError, type TranslateInput, type TranslateOutput, type TranslatedText, type Translator, type TranslatorOptions } from './types.ts';

/**
 * LibreTranslate with a CUSTOM base URL (self-hosted or hosted).
 *
 * Verified (checked 2026-11-18) against https://docs.libretranslate.com/guides/api_usage/ and the
 * server source https://github.com/LibreTranslate/LibreTranslate/blob/main/libretranslate/app.py :
 * - `POST <base>/translate` with JSON `{ q, source, target, format, api_key? }`. `source` may be
 *   `auto`; `format` is `text` or `html`. `q` may be a list (a batch): then `translatedText` is a list
 *   and, with `source: auto`, `detectedLanguage` is a list of `{ confidence, language }`. For one
 *   string both are single values. The key is read from the `api_key` field only (JSON or form):
 *   the source does not read a header, so the key is sent in the body.
 * - Errors: 400 for a missing parameter, an unsupported language, an exceeded text limit or a missing
 *   key ("Please contact the server operator to get an API key"), 403 for an invalid key or a banned
 *   address, 429 with a message starting "Slowdown:" (the source sets no Retry-After). Messages are
 *   only used to classify; they are never shown.
 * - `/languages` (GET, `[{ code, name, targets }]`) and `/detect` (POST, `[{ confidence, language }]`)
 *   exist; this adapter does not need them: it uses `source: auto`.
 * - UNVERIFIED: batch `q` on older servers. If the reply to a list is not a list, each text is sent
 *   on its own. The Chinese (traditional) and Portuguese (Brazil) codes in languages.ts are UNVERIFIED.
 *
 * The base URL is a user-entered address, so the caller (the server) passes a `fetch` that enforces the
 * address rules (https, no private or metadata addresses, pinned connection, no redirects, size cap,
 * timeout). This adapter adds nothing to that and does not follow redirects either.
 */

export type LibreTranslateOptions = TranslatorOptions & {
  /** The server address, without a trailing slash. */
  baseUrl: string;
  apiKey?: string | undefined;
};

function classify(status: number, json: unknown, retryAfter: string | null): TranslateError {
  const message = textAt(json, 'error').toLowerCase() || textAt(json, 'message').toLowerCase();
  if (status === 429 || /slowdown|too many request/.test(message)) {
    return new TranslateError('rate_limited', { retryAfterSeconds: retryAfterSeconds(retryAfter, 30) });
  }
  if (status === 403 || /api key/.test(message)) return new TranslateError('auth');
  if (status === 400) {
    if (/exceeds text limit/.test(message)) return new TranslateError('too_large');
    if (/not supported|not available as a target|language/.test(message)) return new TranslateError('unsupported_language');
    return new TranslateError('unavailable', { detail: 'http_400' });
  }
  if (status === 413) return new TranslateError('too_large');
  return new TranslateError('unavailable', { detail: `http_${status}` });
}

export function createLibreTranslateTranslator(options: LibreTranslateOptions): Translator {
  const base = options.baseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new TranslateError('not_configured');
  const key = (options.apiKey ?? '').trim();

  const call = async (q: string | string[], source: string | undefined, target: string) =>
    postJson(
      {
        url: `${base}/translate`,
        headers: {},
        body: { q, source: source ?? 'auto', target, format: 'text', ...(key ? { api_key: key } : {}) },
      },
      options,
    );

  const one = (value: unknown, index: number): unknown => (Array.isArray(value) ? value[index] : value);

  return {
    provider: 'libretranslate',
    async translate(input: TranslateInput): Promise<TranslateOutput> {
      const target = libreTranslateCode(input.target);
      if (!target) throw new TranslateError('unsupported_language');
      let source: string | undefined;
      if (input.source !== undefined && input.source !== '' && input.source.toLowerCase() !== 'auto') {
        source = libreTranslateCode(input.source);
        if (!source) throw new TranslateError('unsupported_language');
      }
      const fromReply = (json: unknown, count: number): TranslatedText[] | undefined => {
        if (!isRecord(json)) return undefined;
        const texts = json.translatedText;
        const out: TranslatedText[] = [];
        for (let i = 0; i < count; i += 1) {
          const text = one(texts, i);
          if (typeof text !== 'string') return undefined;
          const detected = one(json.detectedLanguage, i);
          const tag = detectedTag(isRecord(detected) && typeof detected.language === 'string' ? detected.language : undefined);
          out.push({ text, ...(tag ? { detectedSource: tag } : {}) });
        }
        return out;
      };

      if (input.texts.length === 1) {
        const reply = await call(input.texts[0] as string, source, target);
        if (reply.status < 200 || reply.status > 299) throw classify(reply.status, reply.json, reply.retryAfter);
        const results = fromReply(reply.json, 1);
        if (!results) throw new TranslateError('unavailable', { detail: `reply_unreadable` });
        return { results };
      }

      const batch = await call(input.texts, source, target);
      if (batch.status < 200 || batch.status > 299) throw classify(batch.status, batch.json, batch.retryAfter);
      if (isRecord(batch.json) && Array.isArray(batch.json.translatedText)) {
        const results = fromReply(batch.json, input.texts.length);
        if (!results) throw new TranslateError('unavailable', { detail: `reply_unreadable` });
        return { results };
      }
      // A server that does not know lists answered with one string: ask for each text on its own.
      const results: TranslatedText[] = [];
      for (const text of input.texts) {
        const reply = await call(text, source, target);
        if (reply.status < 200 || reply.status > 299) throw classify(reply.status, reply.json, reply.retryAfter);
        const part = fromReply(reply.json, 1);
        if (!part?.[0]) throw new TranslateError('unavailable', { detail: 'reply_unreadable' });
        results.push(part[0]);
      }
      return { results };
    },
  };
}
