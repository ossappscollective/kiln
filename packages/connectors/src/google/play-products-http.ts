import { StoreError, StoreRateLimitError } from '../errors.ts';
import {
  enc,
  isRecord,
  type Json,
  StoreHttp,
  type StoreHttpOptions,
  type StoreReply,
} from '../store-http.ts';
import { GoogleTokenProvider, parseServiceAccount, type ServiceAccount } from './google-auth.ts';
import { googleError, isPlayPackageName } from './googleplay.ts';

/**
 * The Google Play Developer API calls of the product connectors (`monetization.subscriptions`, `monetization.onetimeproducts`): a service
 * account token, redacted errors, and a second `StoreHttp` for writes that never waits out a 429. Shared by the read and the write connector.
 */

export type PlayProductsHttpOptions = Omit<StoreHttpOptions, 'store'> & {
  /** The service account JSON key file (as stored), or its parsed fields. */
  serviceAccount: string | ServiceAccount;
  packageName: string;
  /** Defaults to https://androidpublisher.googleapis.com. */
  apiBase?: string;
};

const DEFAULT_BASE = 'https://androidpublisher.googleapis.com';

export class PlayProductsHttp {
  readonly packageName: string;
  readonly #http: StoreHttp;
  readonly #writeHttp: StoreHttp;
  readonly #tokens: GoogleTokenProvider;
  readonly #account: ServiceAccount;
  readonly #base: string;

  constructor(options: PlayProductsHttpOptions) {
    this.#account =
      typeof options.serviceAccount === 'string'
        ? parseServiceAccount(options.serviceAccount)
        : options.serviceAccount;
    if (!isPlayPackageName(options.packageName)) {
      throw new StoreError(
        'googleplay',
        'invalid_input',
        `Not a valid Android package name: ${JSON.stringify(options.packageName.slice(0, 80))}.`,
      );
    }
    this.packageName = options.packageName;
    this.#http = new StoreHttp({ ...options, store: 'googleplay' });
    this.#writeHttp = new StoreHttp({ ...options, store: 'googleplay', maxRateLimitRetries: 0 });
    this.#base = (options.apiBase ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.#tokens = new GoogleTokenProvider(this.#account, this.#http);
    // The write client holds no key of its own, but its messages must be redacted the same way.
    for (const known of this.#http.known) this.#writeHttp.known.add(known);
  }

  static accountOf(secret: string): ServiceAccount {
    return parseServiceAccount(secret);
  }

  /** `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{package}` plus `suffix`. */
  url(suffix: string): string {
    return `${this.#base}/androidpublisher/v3/applications/${enc(this.packageName)}${suffix}`;
  }

  #fail(reply: StoreReply, what: string): StoreError {
    const error = googleError(reply, what, {
      packageName: this.packageName,
      ...(this.#account.projectId ? { projectId: this.#account.projectId } : {}),
    });
    if (error instanceof StoreRateLimitError) return error;
    return new StoreError('googleplay', error.kind, this.#http.redact(error.message), error.status);
  }

  /**
   * A GET. A 404 is `undefined` when `optional`. With `allowEmpty` a successful answer without a body counts as `{}` (a list with nothing
   * in it: Google Play may answer an empty list that way); an answer that is not JSON is still an error.
   */
  async get(
    url: string,
    what: string,
    optional = false,
    allowEmpty = false,
  ): Promise<Json | undefined> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.#tokens.token();
      this.#writeHttp.known.add(token);
      const reply = await this.#http.send('GET', url, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (reply.status === 401 && attempt === 0) {
        this.#tokens.invalidate();
        continue;
      }
      if (reply.status >= 200 && reply.status < 300) {
        if (allowEmpty && !reply.malformed && reply.json === undefined) return {};
        if (reply.malformed || !isRecord(reply.json)) {
          // The content type is the one detail that says what came back (an HTML page from a proxy, say); the body itself is never quoted.
          const type = reply.headers.get('content-type')?.split(';')[0]?.trim().slice(0, 60);
          throw new StoreError(
            'googleplay',
            'unexpected',
            `Google Play answered ${what} with a response that could not be read${type ? ` (${type})` : ''}.`,
            reply.status,
          );
        }
        return reply.json;
      }
      if (optional && reply.status === 404) return undefined;
      throw this.#fail(reply, what);
    }
  }

  /** A POST that changes nothing (a price conversion). Retried like a read. */
  async postRead(url: string, json: unknown, what: string): Promise<Json> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.#tokens.token();
      this.#writeHttp.known.add(token);
      const reply = await this.#http.send('POST', url, {
        headers: { authorization: `Bearer ${token}` },
        json,
      });
      if (reply.status === 401 && attempt === 0) {
        this.#tokens.invalidate();
        continue;
      }
      if (reply.status >= 200 && reply.status < 300 && isRecord(reply.json)) return reply.json;
      if (reply.status >= 200 && reply.status < 300) {
        throw new StoreError(
          'googleplay',
          'unexpected',
          `Google Play answered ${what} with a response that could not be read.`,
          reply.status,
        );
      }
      throw this.#fail(reply, what);
    }
  }

  /** One write. No retry beyond one fresh token after a 401 (Google rejected the token before it looked at the request). */
  async patch(
    url: string,
    json: unknown,
    what: string,
    method: 'PATCH' | 'POST' = 'PATCH',
  ): Promise<
    { ok: true; json: unknown } | { ok: false; unknown: true; message: string; status?: number }
  > {
    for (let attempt = 0; ; attempt++) {
      const token = await this.#tokens.token();
      this.#writeHttp.known.add(token);
      let reply: StoreReply;
      try {
        reply = await this.#writeHttp.send(method, url, {
          headers: { authorization: `Bearer ${token}` },
          json,
        });
      } catch (error) {
        if (error instanceof StoreError && error.kind === 'network') {
          return {
            ok: false,
            unknown: true,
            message: `The connection to Google Play failed while ${what}, so it is not known whether Google applied it. ${error.message}`,
          };
        }
        throw error;
      }
      if (reply.status === 401 && attempt === 0) {
        this.#tokens.invalidate();
        continue;
      }
      if (reply.status >= 200 && reply.status < 300) return { ok: true, json: reply.json };
      if (reply.status >= 500) {
        return {
          ok: false,
          unknown: true,
          status: reply.status,
          message: `Google Play answered HTTP ${reply.status} while ${what}, so it is not known whether Google applied it.`,
        };
      }
      throw this.#fail(reply, what);
    }
  }
}
