import { type CredentialKind, isCredentialKind } from '@mrm/core';
import * as connectors from '@mrm/connectors';
import { redactSecrets, secretStrings } from '@mrm/connectors';

/**
 * "Test connection": checks a credential against the service it belongs to, without changing
 * anything there. The secret is used for the length of one call. It is never stored or logged
 * here, and everything that comes back is redacted against it before it leaves this module.
 */

export type TestOutcome = { ok: boolean; message: string; details?: string[] };

export type VerifierOptions = { fetch: typeof fetch; now: () => number };
export type Verifier = (secret: string, options: VerifierOptions) => Promise<TestOutcome>;
/** Finds the verifier for a kind, or undefined when this build has none. Looked up per call. */
export type VerifierLookup = (kind: CredentialKind) => Verifier | undefined;

/** The name each kind's verifier has in @mrm/connectors. */
const verifierNames: Record<CredentialKind, string> = {
  app_store_connect: 'verifyAppStoreConnectCredential',
  google_play: 'verifyGooglePlayCredential',
  github_app: 'verifyGithubAppCredential',
  github_token: 'verifyGithubTokenCredential',
  translate_google: 'verifyTranslateGoogleCredential',
  translate_deepl: 'verifyTranslateDeeplCredential',
  translate_azure: 'verifyTranslateAzureCredential',
  // Checked together with the workspace's server address by services/translation.ts (the route
  // calls it): a key alone cannot be tested.
  translate_libretranslate: 'verifyTranslateLibretranslateCredential',
};

/**
 * Looks the function up on the module namespace when asked, so a connector that has not been
 * written yet is "not available" instead of a failed import.
 */
export const connectorVerifiers: VerifierLookup = (kind) => {
  const candidate = (connectors as unknown as Record<string, unknown>)[verifierNames[kind]];
  return typeof candidate === 'function' ? (candidate as Verifier) : undefined;
};

export const TEST_TIMEOUT_MS = 10_000;
const MAX_DETAILS = 20;
const MAX_DETAIL_LENGTH = 300;
const MAX_MESSAGE_LENGTH = 500;

export const notAvailable: TestOutcome = {
  ok: false,
  message: 'Testing this kind of credential is not available yet.',
};

export type CredentialTesterOptions = {
  verifiers?: VerifierLookup;
  /** What the verifiers call the network with. Defaults to the global fetch. */
  fetch?: typeof fetch;
  now?: () => number;
  /** Hard limit for one test. Default 10 seconds. */
  timeoutMs?: number;
};

export type CredentialTester = (kind: string, secret: string) => Promise<TestOutcome>;

export function createCredentialTester(options: CredentialTesterOptions = {}): CredentialTester {
  const lookup = options.verifiers ?? connectorVerifiers;
  const baseFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? TEST_TIMEOUT_MS;

  return async (kind, secret) => {
    if (!isCredentialKind(kind)) return notAvailable;
    const verifier = lookup(kind);
    if (!verifier) return notAvailable;

    const known = secretStrings(secret);
    const clean = (value: string, max: number) => redactSecrets(value, known).slice(0, max);

    // Aborting the controller also cancels a request the verifier has in flight.
    const controller = new AbortController();
    const guardedFetch: typeof fetch = (input, init) =>
      baseFetch(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<TestOutcome>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({
          ok: false,
          message: `The test took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped. Check the connection and try again.`,
        });
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([verifier(secret, { fetch: guardedFetch, now }), timedOut]);
      const details = (Array.isArray(result.details) ? result.details : [])
        .filter((d): d is string => typeof d === 'string')
        .slice(0, MAX_DETAILS)
        .map((d) => clean(d, MAX_DETAIL_LENGTH));
      return {
        ok: result.ok === true,
        message: clean(String(result.message ?? ''), MAX_MESSAGE_LENGTH),
        ...(details.length ? { details } : {}),
      };
    } catch {
      // The error text is dropped on purpose: it may echo what was sent.
      return {
        ok: false,
        message: 'The test could not be completed. Try again in a moment.',
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * At most `limit` tests per key (the workspace) in any `windowMs`. In memory, so per process and
 * reset on restart, like the login limiter.
 */
export type TestLimiter = {
  /** 0 when the test may go ahead (and is counted), else the seconds to wait. */
  take(key: string): number;
};

export function createTestLimiter(
  options: { limit?: number; windowMs?: number; maxKeys?: number; now?: () => number } = {},
): TestLimiter {
  const limit = options.limit ?? 10;
  const windowMs = options.windowMs ?? 60_000;
  const maxKeys = options.maxKeys ?? 10_000;
  const now = options.now ?? Date.now;
  const taken = new Map<string, number[]>();
  return {
    take(key) {
      const at = now();
      const recent = (taken.get(key) ?? []).filter((t) => at - t < windowMs);
      if (recent.length >= limit) {
        taken.set(key, recent);
        return Math.max(1, Math.ceil(((recent[0] ?? at) + windowMs - at) / 1000));
      }
      if (taken.size >= maxKeys) {
        // Never wipe the whole map (that would hand every workspace a fresh allowance): drop
        // keys with nothing in the window first, then the oldest key.
        for (const [k, times] of taken) {
          if (times.every((t) => at - t >= windowMs)) taken.delete(k);
        }
        while (taken.size >= maxKeys) {
          const oldest = taken.keys().next().value;
          if (oldest === undefined) break;
          taken.delete(oldest);
        }
      }
      recent.push(at);
      taken.set(key, recent);
      return 0;
    },
  };
}
