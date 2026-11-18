import { type TranslationProvider, isTranslationProvider } from '@mrm/core';
import { createAzureTranslator } from './azure.ts';
import { createDeeplTranslator } from './deepl.ts';
import { createGoogleTranslator } from './google.ts';
import { createLibreTranslateTranslator } from './libretranslate.ts';
import { TranslateError, type TranslateErrorKind, type Translator, type TranslatorOptions, translateErrorMessage } from './types.ts';

export * from './types.ts';
export * from './languages.ts';
export { AZURE_TRANSLATOR_URL, createAzureTranslator } from './azure.ts';
export { DEEPL_FREE_URL, DEEPL_PRO_URL, createDeeplTranslator, deeplBaseUrl } from './deepl.ts';
export { GOOGLE_V2_URL, createGoogleTranslator } from './google.ts';
export { createLibreTranslateTranslator } from './libretranslate.ts';

/**
 * What a stored translation credential holds: `{ "apiKey": "...", "region"?: "..." }`. A bare string is
 * accepted as the key too, so a hand-made secret still works. Never log the result.
 */
export function parseTranslateSecret(secret: string | undefined): { apiKey: string; region: string } {
  if (!secret) return { apiKey: '', region: '' };
  try {
    const parsed: unknown = JSON.parse(secret);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return {
        apiKey: typeof record.apiKey === 'string' ? record.apiKey.trim() : '',
        region: typeof record.region === 'string' ? record.region.trim() : '',
      };
    }
  } catch {
    // Not JSON: the secret is the key itself.
  }
  return { apiKey: secret.trim(), region: '' };
}

export type CreateTranslatorInput = {
  provider: TranslationProvider;
  /** The decrypted credential secret, or undefined for LibreTranslate without a key. */
  secret?: string | undefined;
  /** LibreTranslate only: the server address. */
  baseUrl?: string | undefined;
  options?: TranslatorOptions;
};

/** Builds the adapter for a provider. Throws `TranslateError('not_configured')` when a needed part is missing. */
export function createTranslator(input: CreateTranslatorInput): Translator {
  const options = input.options ?? {};
  const { apiKey, region } = parseTranslateSecret(input.secret);
  switch (input.provider) {
    case 'google':
      return createGoogleTranslator({ ...options, apiKey });
    case 'deepl':
      return createDeeplTranslator({ ...options, apiKey });
    case 'azure':
      return createAzureTranslator({ ...options, apiKey, region });
    case 'libretranslate':
      return createLibreTranslateTranslator({ ...options, baseUrl: input.baseUrl ?? '', apiKey });
  }
}

export type TranslateProbe =
  | { ok: true; provider: TranslationProvider }
  | { ok: false; provider: TranslationProvider; kind: TranslateErrorKind; message: string; retryAfterSeconds?: number };

/** The fixed word translated by a connection test. */
export const PROBE_TEXT = 'Hello';

/** Translates one fixed word. Reports ok or a fixed sentence: never provider text, never the key. */
export async function probeTranslator(translator: Translator): Promise<TranslateProbe> {
  try {
    const out = await translator.translate({ texts: [PROBE_TEXT], target: 'fr' });
    if (out.results.length === 1 && out.results[0]?.text.trim()) return { ok: true, provider: translator.provider };
    return { ok: false, provider: translator.provider, kind: 'unavailable', message: translateErrorMessage('unavailable') };
  } catch (error) {
    const kind = error instanceof TranslateError ? error.kind : 'unavailable';
    return {
      ok: false,
      provider: translator.provider,
      kind,
      message: translateErrorMessage(kind),
      ...(error instanceof TranslateError && error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    };
  }
}

export const isTranslateProviderId = isTranslationProvider;

/** Connection test of a stored credential, for the vault's "test connection" (see services/credential-tests.ts). */
const verify =
  (provider: Exclude<TranslationProvider, 'libretranslate'>) =>
  async (secret: string, options: { fetch?: typeof fetch } = {}): Promise<{ ok: boolean; message: string }> => {
    let translator: Translator;
    try {
      translator = createTranslator({ provider, secret, options: { ...(options.fetch ? { fetch: options.fetch } : {}), timeoutMs: 8000 } });
    } catch (error) {
      return { ok: false, message: error instanceof TranslateError ? error.message : translateErrorMessage('not_configured') };
    }
    const probe = await probeTranslator(translator);
    return probe.ok
      ? { ok: true, message: 'The key works: a test word was translated.' }
      : { ok: false, message: probe.message };
  };

export const verifyTranslateGoogleCredential = verify('google');
export const verifyTranslateDeeplCredential = verify('deepl');
export const verifyTranslateAzureCredential = verify('azure');
