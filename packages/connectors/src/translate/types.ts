import type { TranslationProvider } from '@mrm/core';

/**
 * Translation providers behind one interface. A provider adapter turns a list of texts into a list
 * of translations and nothing else: it knows its own request shape, authentication and language
 * codes. The server decides who may translate what, counts the characters, caches and audits.
 *
 * Rules every adapter follows:
 * - It never throws anything but `TranslateError`, whose message is a FIXED sentence for its kind.
 *   A provider's own error text is read to classify the failure and then dropped: it can echo the
 *   text that was sent (review text is personal data) or a key.
 * - It never logs and keeps no text.
 * - Parsing is tolerant: a missing optional field is not an error; a reply that does not have one
 *   translation per text is `unavailable`.
 */

export type TranslateProviderId = TranslationProvider;

export type TranslateErrorKind =
  /** No usable credential or address was given. */
  | 'not_configured'
  /** The provider refused the key (or the key is for another plan or region). */
  | 'auth'
  /** The plan or quota is used up. Waiting a minute will not help. */
  | 'quota'
  /** Too many requests. `retryAfterSeconds` says how long to wait. */
  | 'rate_limited'
  /** The provider does not support the source or target language. */
  | 'unsupported_language'
  /** The provider says the request is too large. */
  | 'too_large'
  /** The provider could not be reached, answered an error, or answered something unreadable. */
  | 'unavailable'
  /** No answer within the time limit. */
  | 'timeout';

const messages: Record<TranslateErrorKind, string> = {
  not_configured: 'Translation is not set up for this provider.',
  auth: 'The translation provider refused the key. Check the credential.',
  quota: 'The translation quota of the provider is used up.',
  rate_limited: 'The translation provider is limiting requests. Try again later.',
  unsupported_language: 'The translation provider does not support this language.',
  too_large: 'The translation provider says the text is too large.',
  unavailable: 'The translation provider could not be reached or answered with an error.',
  timeout: 'The translation provider did not answer in time.',
};

/** The fixed sentence for an error kind. Safe to show and to store: it never contains provider text. */
export const translateErrorMessage = (kind: TranslateErrorKind): string => messages[kind];

export class TranslateError extends Error {
  readonly kind: TranslateErrorKind;
  /** For `rate_limited`: seconds to wait. */
  readonly retryAfterSeconds: number | undefined;
  /** A short fixed-vocabulary hint for the person debugging a setup (`http_404`, `connection`, `blocked`); never provider text. */
  readonly detail: string | undefined;
  constructor(
    kind: TranslateErrorKind,
    options: { retryAfterSeconds?: number; detail?: string } = {},
  ) {
    super(messages[kind]);
    this.name = 'TranslateError';
    this.kind = kind;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.detail =
      options.detail !== undefined && /^[a-z0-9_]{1,24}$/.test(options.detail)
        ? options.detail
        : undefined;
  }
}

export type TranslateInput = {
  /** At least one, no empty strings (the server filters them). */
  texts: string[];
  /** A BCP-47 tag such as `en` or `pt-BR`. The adapter maps it to its own code. */
  target: string;
  /** A BCP-47 tag, or undefined to let the provider detect the language. */
  source?: string | undefined;
};

export type TranslatedText = {
  text: string;
  /** BCP-47 tag of the language the provider found, when it says. */
  detectedSource?: string;
};

export type TranslateOutput = { results: TranslatedText[] };

export interface Translator {
  readonly provider: TranslateProviderId;
  translate(input: TranslateInput): Promise<TranslateOutput>;
}

export type TranslatorOptions = {
  /** Injected for tests, and for LibreTranslate the address-pinning fetch of the server. Default: the global fetch. */
  fetch?: typeof fetch;
  /** For the whole call. Default 15 seconds. */
  timeoutMs?: number;
  /** The reply is read up to this many bytes; more is `unavailable`. Default 2 MiB. */
  maxResponseBytes?: number;
  /** Replaces the provider's address (tests). Not offered in the UI. */
  baseUrl?: string;
};

export const DEFAULT_TRANSLATE_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
