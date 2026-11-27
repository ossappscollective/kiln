import { redactSecrets, StoreError, secretStrings } from '@kiln/connectors';
import { STORE_FAILURE_MESSAGE_MAX_CHARS as MESSAGE_MAX } from '@kiln/core';

export { MESSAGE_MAX };

/**
 * What a store said when it refused a write, in a form that is safe to show, to log and to keep (docs/api/pending.md "Why a publish
 * failed"). The store's own words matter: "Only releases with status draft may be created on draft app" tells a person what to do where
 * "the store refused" does not. They are kept short and clean: secrets and token-shaped strings removed, control characters and runs of
 * white space collapsed, cut to a length. Never a request body, never an upload, never a header.
 */

/** The longest store sentence kept (the web shows the first 300 characters and a "Show more"). */
export const STORE_TEXT_MAX = 600;
/** The longest sentence of the server's own that is kept next to it. */

const LONG_OPAQUE = /\b[A-Za-z0-9+=_-]{40,}\b/g;

/**
 * Text from a store (or from an error) as one clean line: credentials of the app (`secret`, a JSON key, a token, a private key) and
 * any long opaque string removed, control characters turned into spaces, at most `max` characters (an ellipsis marks a cut).
 */
export function sanitiseStoreText(text: string, secret = '', max = STORE_TEXT_MAX): string {
  const redacted = redactSecrets(text, secret ? secretStrings(secret) : [])
    .replace(LONG_OPAQUE, '[redacted]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return redacted.length > max ? `${redacted.slice(0, max - 3)}...` : redacted;
}

export type StoreFactsDetail = {
  code?: string;
  title?: string;
  detail?: string;
  /** Apple `source.pointer` of a rejected field (`/data/attributes/contactEmail`). */
  pointer?: string;
  /** Apple `meta.associatedErrors`: the kind of resource the reason is about (`appStoreReviewDetails`). */
  resource?: string;
};

/** The most reasons of a store kept: Apple's own error and the associated errors that explain it (`MAX_ASSOCIATED_ERRORS`). */
export const STORE_FACTS_MAX_DETAILS = 13;

/** What the store answered, as the person-facing report keeps it. */
export type StoreFacts = {
  /** The connector's kind of error (`unexpected`, `forbidden`, `changes_in_review`, ...). */
  kind: string;
  httpStatus?: number;
  /** At most `STORE_FACTS_MAX_DETAILS` entries of the store's own error body: its reason code, its title or status word, its sentence, and where. */
  details?: StoreFactsDetail[];
};

/** The facts of a store error, or null when the error is not a store's. */
export function storeFactsOf(error: unknown, secret = ''): StoreFacts | null {
  if (!(error instanceof StoreError)) return null;
  const details = (error.details ?? []).slice(0, STORE_FACTS_MAX_DETAILS).flatMap((d): StoreFactsDetail[] => {
    const code = d.code === undefined ? '' : sanitiseStoreText(d.code, secret, 80);
    const title = d.title === undefined ? '' : sanitiseStoreText(d.title, secret, 120);
    const detail = d.detail === undefined ? '' : sanitiseStoreText(d.detail, secret);
    const pointer = d.pointer === undefined ? '' : sanitiseStoreText(d.pointer, secret, 160);
    const resource = d.resource === undefined ? '' : sanitiseStoreText(d.resource, secret, 60);
    if (code === '' && title === '' && detail === '') return [];
    return [
      {
        ...(code !== '' ? { code } : {}),
        ...(title !== '' ? { title } : {}),
        ...(detail !== '' ? { detail } : {}),
        ...(pointer !== '' ? { pointer } : {}),
        ...(resource !== '' ? { resource } : {}),
      },
    ];
  });
  return {
    kind: error.kind,
    ...(error.status !== undefined ? { httpStatus: error.status } : {}),
    ...(details.length > 0 ? { details } : {}),
  };
}

/** `{ store: facts }` for the body of a failure answer, or nothing when the error is not a store's. */
export function storeBody(error: unknown, secret = ''): { store?: StoreFacts } {
  const facts = storeFactsOf(error, secret);
  return facts === null ? {} : { store: facts };
}
