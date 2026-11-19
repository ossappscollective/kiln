/**
 * What the ASO connectors (apple-search.ts, play-public.ts) share: the error type, the one GET
 * with its caps, and the identification of this tool.
 *
 * Both connectors read PUBLIC pages and APIs of a store, with no credential, no cookie and no login.
 * Every request goes to a fixed host (the URL is built from constants plus an encoded term or id),
 * with a timeout, a size cap and redirects not followed. The `fetch` is injected: the server passes
 * one that goes through its SSRF-safe GET (host allowlist, resolved addresses checked), tests pass a fake.
 *
 * Nothing here logs. An error never carries a search term, a package name, a header or an address:
 * its message is one of a few fixed sentences.
 */

export type AsoSource = 'apple_search' | 'play_public';

export type AsoErrorKind =
  /** The store said to slow down (HTTP 429, or 403 from the Apple search service). Back off. */
  | 'rate_limited'
  | 'network'
  | 'timeout'
  /** The service answered 5xx. */
  | 'server'
  /** The answer could not be read, or was not the shape documented. */
  | 'unexpected'
  | 'invalid_input'
  /** The answer is bigger than the cap. */
  | 'too_large'
  /**
   * The source gave nothing usable and probably will not until somebody looks: Google Play changed its
   * pages, sent a consent or a robot check, or the unofficial source is switched off. `reason` says which.
   */
  | 'unavailable';

export type AsoUnavailableReason = 'layout_changed' | 'redirect' | 'blocked' | 'disabled';

export class AsoError extends Error {
  readonly source: AsoSource;
  readonly kind: AsoErrorKind;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  readonly reason?: AsoUnavailableReason;
  constructor(
    source: AsoSource,
    kind: AsoErrorKind,
    message: string,
    extra: { status?: number; retryAfterSeconds?: number; reason?: AsoUnavailableReason } = {},
  ) {
    super(message);
    this.name = 'AsoError';
    this.source = source;
    this.kind = kind;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.retryAfterSeconds !== undefined) this.retryAfterSeconds = extra.retryAfterSeconds;
    if (extra.reason !== undefined) this.reason = extra.reason;
  }
}

/** Sent as the User-Agent: says what this is and that it only reads public pages. No version, no address of a person. */
export const ASO_USER_AGENT = 'mobile-release-manager (self-hosted ASO read of public store pages)';

export const ASO_DEFAULT_TIMEOUT_MS = 10_000;

const SOURCE_NAME: Record<AsoSource, string> = {
  apple_search: 'The iTunes Search API',
  play_public: 'Google Play',
};
export const sourceName = (source: AsoSource): string => SOURCE_NAME[source];

export type CappedGet = { status: number; retryAfter: string | null; text: string };

/**
 * One GET. The body is read only for a 200 and only up to `maxBytes`: a longer one is `too_large`,
 * never a cut text. Redirects are not followed (a 3xx is returned as it is, for the caller to judge).
 */
export async function getCapped(options: {
  source: AsoSource;
  fetch?: typeof fetch;
  url: string;
  accept: string;
  maxBytes: number;
  timeoutMs?: number;
}): Promise<CappedGet> {
  const { source } = options;
  const doFetch = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(options.url, {
      method: 'GET',
      headers: { accept: options.accept, 'user-agent': ASO_USER_AGENT },
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? ASO_DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new AsoError(source, 'timeout', `${sourceName(source)} did not answer in time.`);
    }
    if (name === 'TooLargeError') {
      throw new AsoError(
        source,
        'too_large',
        `${sourceName(source)} answered with more data than expected.`,
      );
    }
    throw new AsoError(source, 'network', `Could not reach ${sourceName(source)}.`);
  }
  const retryAfter = response.headers.get('retry-after');
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, retryAfter, text: '' };
  }
  const reader = response.body?.getReader();
  if (!reader) return { status: 200, retryAfter, text: '' };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > options.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AsoError(
          source,
          'too_large',
          `${sourceName(source)} answered with more data than expected.`,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AsoError) throw error;
    const name = error instanceof Error ? error.name : '';
    throw new AsoError(
      source,
      name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
      name === 'TimeoutError' || name === 'AbortError'
        ? `${sourceName(source)} did not answer in time.`
        : `Could not reach ${sourceName(source)}.`,
    );
  }
  return { status: 200, retryAfter, text: Buffer.concat(chunks).toString('utf8') };
}

/** Seconds from a `Retry-After` of delta seconds (an HTTP date is not parsed: the default applies). At most a day. */
export function retryAfterSeconds(value: string | null, fallback = 60): number {
  if (value && /^\d{1,6}$/.test(value.trim())) return Math.min(Number(value.trim()), 86_400);
  return fallback;
}

/** Throws the error for a status that is not a success; returns for a 200. */
export function checkStatus(source: AsoSource, got: CappedGet): void {
  if (got.status === 200) return;
  if (got.status === 429 || got.status === 403) {
    throw new AsoError(source, 'rate_limited', `${sourceName(source)} asked to slow down.`, {
      status: got.status,
      retryAfterSeconds: retryAfterSeconds(got.retryAfter),
    });
  }
  if (got.status >= 500) {
    throw new AsoError(source, 'server', `${sourceName(source)} is not available right now.`, {
      status: got.status,
    });
  }
  throw new AsoError(
    source,
    'unexpected',
    `${sourceName(source)} answered with HTTP ${got.status}.`,
    { status: got.status },
  );
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decodes the HTML entities that matter in a title or a description. Anything unknown is left as it is. */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,6});/g,
    (whole, body: string) => {
      if (body.charAt(0) === '#') {
        const code =
          body.charAt(1).toLowerCase() === 'x'
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        if (
          !Number.isFinite(code) ||
          code < 32 ||
          code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff)
        )
          return whole;
        return String.fromCodePoint(code);
      }
      return ENTITIES[body.toLowerCase()] ?? whole;
    },
  );
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g;

/** Public text from a store, cleaned of control characters and cut to `max`; undefined when empty. */
export function cleanPublicText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(CONTROL, '').trim();
  if (cleaned === '') return undefined;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}
