import {
  createRevenueCatClient,
  type RevenueCatClient,
  RevenueCatError,
  redactSecrets,
  revenueCatErrorMessage,
  secretStrings,
} from '@kiln/connectors';
import type { ActorType } from '@kiln/core';
import type { Database } from '@kiln/db';
import { useCredentialSecret } from '../../services/credentials.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import type { RevenueCatDeps } from './index.ts';

/**
 * The one way the RevenueCat features get a client (docs/adr/0039-revenuecat.md), the model of `expoClientFor`: it checks that the
 * credential is a RevenueCat credential of this workspace, decrypts the key for this one client (audited as `credential.use` with the
 * caller's purpose), and hands back a client whose closure is the only place the key lives. Nothing returned, thrown or logged here
 * carries it. Build a client per operation and drop it.
 *
 * Every feature turns a `RevenueCatError` into a response with `revenueCatFailure`, so the codes are the same everywhere:
 * `revenuecat_auth`, `revenuecat_forbidden`, `revenuecat_not_found`, `invalid_reference` (422), `rate_limited` (429), `timeout` (504),
 * `revenuecat_unavailable` (502).
 */

type Actor = { type: ActorType; id: string };

export const REVENUECAT_LINK_PURPOSE = 'revenuecat.link';
export const REVENUECAT_DETECT_PURPOSE = 'revenuecat.detect';
export const REVENUECAT_SYNC_PURPOSE = 'revenuecat.sync';

export type RevenueCatUse = {
  /** Who is acting; the use of the credential is audited under them. */
  actor: Actor;
  /** Why the credential is read, for the audit row. A short constant, never user text. */
  purpose: string;
  now: number;
  /** Aborts every request of the client (an overall deadline). */
  signal?: AbortSignal | undefined;
};

export type RevenueCatClientResult = { ok: true; client: RevenueCatClient; secret: string } | Failure;

export async function revenueCatClientFor(
  db: Database,
  masterKey: Buffer,
  workspaceId: string,
  credentialId: string,
  deps: RevenueCatDeps | undefined,
  use: RevenueCatUse,
): Promise<RevenueCatClientResult> {
  const [row] = await db.query('SELECT kind FROM credentials WHERE id = ? AND workspace_id = ?', [
    credentialId,
    workspaceId,
  ]);
  if (!row) {
    return failure(
      422,
      'credential_not_found',
      'That credential does not exist in this workspace (it may have been deleted).',
    );
  }
  if (String(row.kind) !== 'revenuecat') {
    return failure(422, 'credential_kind', 'RevenueCat needs a credential of the RevenueCat secret API key kind.');
  }
  let secret: string | undefined;
  try {
    secret = await useCredentialSecret(
      db,
      masterKey,
      { workspaceId, id: credentialId, purpose: use.purpose },
      use.actor,
      use.now,
    );
  } catch {
    return failure(422, 'credential_unreadable', 'The credential could not be decrypted. Enter its secret again.');
  }
  if (secret === undefined) {
    return failure(422, 'credential_not_found', 'That credential does not exist.');
  }
  return revenueCatClientFromSecret(secret, deps, use.signal);
}

/**
 * A client for a key that is already open, with the same network seam and deadline. The metrics read uses its own client: its limit
 * (25 requests a minute for Charts & Metrics) is a different domain from the configuration reads, so the request budget and the usage
 * headers a configuration read left behind must not stop it.
 */
export function revenueCatClientFromSecret(
  secret: string,
  deps: RevenueCatDeps | undefined,
  signal?: AbortSignal | undefined,
): RevenueCatClientResult {
  const base = deps?.fetch ?? globalThis.fetch;
  const send: typeof fetch = signal
    ? (target, init) =>
        base(target, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal })
    : base;
  try {
    return {
      ok: true,
      secret,
      client: createRevenueCatClient({
        apiKey: secret,
        fetch: send,
        apiOrigin: deps?.apiOrigin,
        timeoutMs: deps?.requestTimeoutMs,
        maxRequests: deps?.maxRequests,
      }),
    };
  } catch (error) {
    return revenueCatFailure(error, secret);
  }
}

/** A response for whatever a call to RevenueCat threw. Messages are fixed sentences, redacted once more against the key in use. */
export function revenueCatFailure(error: unknown, secret = ''): Failure {
  if (!(error instanceof RevenueCatError)) {
    return failure(502, 'revenuecat_unavailable', 'The RevenueCat request could not be completed. Try again in a moment.');
  }
  const message = redactSecrets(error.message, secret ? secretStrings(secret) : []);
  switch (error.kind) {
    case 'auth':
      return failure(422, 'revenuecat_auth', message);
    case 'forbidden':
      return failure(422, 'revenuecat_forbidden', message);
    case 'not_found':
      return failure(422, 'revenuecat_not_found', message);
    case 'invalid_input':
      return failure(422, 'invalid_reference', message);
    case 'rate_limited': {
      const wait = error.retryAfterSeconds ?? 60;
      return {
        ok: false,
        status: 429,
        body: { error: 'rate_limited', message, retryAfterSeconds: wait },
        headers: { 'Retry-After': String(wait) },
      };
    }
    case 'network':
      return error.timedOut
        ? failure(504, 'timeout', message)
        : failure(502, 'revenuecat_unavailable', message);
    case 'server':
    case 'unexpected':
      return failure(502, 'revenuecat_unavailable', message || revenueCatErrorMessage(error.kind));
  }
}
