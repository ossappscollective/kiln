import { StoreError, type StoreErrorDetail } from '../errors.ts';
import {
  enc,
  isRecord,
  type Json,
  records,
  StoreHttp,
  type StoreHttpOptions,
  type StoreReply,
  text,
} from '../store-http.ts';
import {
  type AppStoreConnectKey,
  AppStoreConnectTokenProvider,
  parseAppStoreConnectSecret,
} from './apple-auth.ts';
import { appleError } from './appstoreconnect.ts';

/**
 * The App Store Connect calls of the in-app purchase and subscription connectors: a bearer token, redacted errors, `links.next` paging that
 * never leaves the API host, and a second `StoreHttp` for writes that never waits out a 429. Shared by the read and the write connector.
 */

export type AppleProductsHttpOptions = Omit<StoreHttpOptions, 'store'> & {
  credential: AppStoreConnectKey;
  /** Defaults to https://api.appstoreconnect.apple.com. */
  apiBase?: string;
};

const DEFAULT_BASE = 'https://api.appstoreconnect.apple.com';
const MAX_ERROR_DETAILS = 5;

export class AppleProductsHttp {
  readonly base: string;
  readonly now: () => number;
  readonly #http: StoreHttp;
  readonly #writeHttp: StoreHttp;
  readonly #tokens: AppStoreConnectTokenProvider;

  constructor(options: AppleProductsHttpOptions) {
    this.#http = new StoreHttp({ ...options, store: 'appstoreconnect' });
    this.#writeHttp = new StoreHttp({
      ...options,
      store: 'appstoreconnect',
      maxRateLimitRetries: 0,
    });
    this.now = this.#http.now;
    this.base = (options.apiBase ?? DEFAULT_BASE).replace(/\/+$/, '');
    const pem = options.credential.privateKey;
    for (const http of [this.#http, this.#writeHttp]) {
      http.known.add(pem);
      http.known.add(pem.trim());
      for (const line of pem.split(/\r?\n/)) {
        if (line && !line.startsWith('-----')) http.known.add(line.trim());
      }
    }
    this.#tokens = new AppStoreConnectTokenProvider(options.credential, this.#http.now);
  }

  static credentialOf(secret: string): AppStoreConnectKey {
    return parseAppStoreConnectSecret(secret);
  }

  #details(error: StoreError): StoreErrorDetail[] {
    const redact = (value: string | undefined) =>
      value === undefined ? undefined : this.#http.redact(value);
    return (error.details ?? []).slice(0, MAX_ERROR_DETAILS).map((d) => {
      const fields = {
        code: redact(d.code),
        title: redact(d.title),
        detail: redact(d.detail),
        parameter: redact(d.parameter),
        pointer: redact(d.pointer),
      };
      return Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      ) as StoreErrorDetail;
    });
  }

  #fail(reply: StoreReply, what: string): StoreError {
    if (reply.status === 401) this.#tokens.invalidate();
    const error = appleError(reply, this.#http.now(), what);
    return new StoreError(
      'appstoreconnect',
      error.kind,
      this.#http.redact(error.message),
      error.status,
      this.#details(error),
    );
  }

  /** A GET of a path under the API (or a full paging link of it). A 404 is `undefined` when `optional`. */
  async get(pathOrUrl: string, what: string, optional = false): Promise<Json | undefined> {
    const url = pathOrUrl.startsWith('http')
      ? this.#sameHost(pathOrUrl, what)
      : `${this.base}${pathOrUrl}`;
    const token = this.#tokens.token();
    this.#http.known.add(token);
    this.#writeHttp.known.add(token);
    const reply = await this.#http.send('GET', url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (reply.status >= 200 && reply.status < 300) {
      if (reply.malformed || !isRecord(reply.json)) {
        throw new StoreError(
          'appstoreconnect',
          'unexpected',
          `App Store Connect answered ${what} with a response that could not be read.`,
          reply.status,
        );
      }
      return reply.json;
    }
    if (optional && reply.status === 404) return undefined;
    throw this.#fail(reply, what);
  }

  /**
   * Every resource of a list, following `links.next`, plus everything `included` (all pages merged). Stops after `maxPages`:
   * `truncated` says so.
   */
  async list(
    path: string,
    what: string,
    options: { maxPages: number; optional?: boolean },
  ): Promise<{ data: Json[]; included: Json[]; truncated: boolean; missing: boolean }> {
    const data: Json[] = [];
    const included: Json[] = [];
    let next: string | undefined = path;
    for (let page = 1; next !== undefined; page++) {
      const body = await this.get(next, what, options.optional === true && page === 1);
      if (body === undefined) return { data, included, truncated: false, missing: true };
      data.push(...records(body.data));
      included.push(...records(body.included));
      const links = isRecord(body.links) ? body.links : {};
      const link = text(links.next);
      if (link === undefined) next = undefined;
      else if (page >= options.maxPages) return { data, included, truncated: true, missing: false };
      else next = link;
    }
    return { data, included, truncated: false, missing: false };
  }

  /**
   * One write. No retry: a network failure or a 5xx may mean Apple applied it (`unknown` is true, the caller reads back); a 4xx is a
   * `StoreError` and nothing happened.
   */
  async write(
    method: 'PATCH' | 'POST',
    path: string,
    what: string,
    json: unknown,
  ): Promise<
    { ok: true; json: unknown } | { ok: false; unknown: true; message: string; status?: number }
  > {
    const token = this.#tokens.token();
    this.#http.known.add(token);
    this.#writeHttp.known.add(token);
    let reply: StoreReply;
    try {
      reply = await this.#writeHttp.send(method, `${this.base}${path}`, {
        headers: { authorization: `Bearer ${token}` },
        json,
      });
    } catch (error) {
      if (error instanceof StoreError && error.kind === 'network') {
        return {
          ok: false,
          unknown: true,
          message: `The connection to App Store Connect failed while ${what}, so it is not known whether Apple applied it. ${error.message}`,
        };
      }
      throw error;
    }
    if (reply.status >= 200 && reply.status < 300) return { ok: true, json: reply.json };
    if (reply.status >= 500) {
      return {
        ok: false,
        unknown: true,
        status: reply.status,
        message: `App Store Connect answered HTTP ${reply.status} while ${what}, so it is not known whether Apple applied it.`,
      };
    }
    throw this.#fail(reply, what);
  }

  /** A paging link is followed only when it stays on the API host: the token is sent nowhere else. */
  #sameHost(link: string, what: string): string {
    let target: URL;
    try {
      target = new URL(link, this.base);
    } catch {
      throw new StoreError(
        'appstoreconnect',
        'unexpected',
        `Apple sent a paging link that could not be read while ${what}.`,
      );
    }
    if (target.origin !== new URL(this.base).origin) {
      throw new StoreError(
        'appstoreconnect',
        'unexpected',
        `Apple sent a paging link to another host while ${what}. It was not followed.`,
      );
    }
    return target.toString();
  }
}

/** The path segment of an id, escaped. */
export const seg = enc;
