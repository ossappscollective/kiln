import {
  AppleAdsError,
  type AppleAdsClient,
  createAppleAdsClient,
  parseAppleAdsSecret,
  redactSecrets,
  secretStrings,
} from '@kiln/connectors';
import type { ActorType } from '@kiln/core';
import type { Database } from '@kiln/db';
import { coded } from '../../i18n/problem.ts';
import { useCredentialSecret } from '../../services/credentials.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import type { AdsDeps } from './index.ts';

/**
 * The one way every Apple Ads feature gets a client (docs/adr/0058-apple-ads.md). It reads the Apple Ads credential, decrypts the key
 * for this one client (audited as `credential.use` with the purpose the caller names) and hands back a client whose closure is the only
 * place the key lives. Nothing returned, thrown or logged here carries it. Build a client per operation and drop it.
 *
 * Errors become responses with `adsFailure`, so the codes are the same everywhere: `ads_invalid_key`, `ads_auth`, `ads_forbidden`,
 * `ads_no_account`, `ads_not_found` (422), `rate_limited` (429), `timeout` (504), `ads_unavailable` (502).
 */
type Actor = { type: ActorType; id: string };

export type AdsUse = {
  actor: Actor;
  purpose: string;
  now: number;
  signal?: AbortSignal | undefined;
};
export type AdsClientResult = { ok: true; client: AppleAdsClient; secret: string } | Failure;

export async function adsClientFor(
  db: Database,
  masterKey: Buffer,
  workspaceId: string,
  credentialId: string,
  deps: AdsDeps | undefined,
  use: AdsUse,
): Promise<AdsClientResult> {
  const [row] = await db.query('SELECT kind FROM credentials WHERE id = ? AND workspace_id = ?', [
    credentialId,
    workspaceId,
  ]);
  if (!row) {
    return failure(
      422,
      'credential_not_found',
      'That credential does not exist in this workspace (it may have been deleted).',
      coded('credential.notInWorkspace'),
    );
  }
  if (String(row.kind) !== 'apple_ads') {
    return failure(
      422,
      'credential_kind',
      'Apple Ads needs a credential of the Apple Ads API user key kind.',
      coded('credential.notAppleAdsKind'),
    );
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
    return failure(
      422,
      'credential_unreadable',
      'The credential could not be decrypted. Enter its secret again.',
      coded('credential.undecryptable'),
    );
  }
  if (secret === undefined) {
    return failure(
      422,
      'credential_not_found',
      'That credential does not exist.',
      coded('credential.notFound'),
    );
  }
  try {
    const client = createAppleAdsClient({
      credential: parseAppleAdsSecret(secret),
      fetch: deps?.fetch,
      apiOrigin: deps?.apiOrigin,
      tokenOrigin: deps?.tokenOrigin,
      sleep: deps?.sleep ? (ms) => deps.sleep!(ms) : undefined,
    });
    return { ok: true, client, secret };
  } catch (error) {
    return adsFailure(error, secret);
  }
}

const withCoding = (error: AppleAdsError) => (error.coding ? coded(error.coding.code) : {});

/** A response for whatever a call to Apple Ads threw. Messages are fixed sentences, redacted once more against the secret in use. */
export function adsFailure(error: unknown, secret = ''): Failure {
  if (!(error instanceof AppleAdsError)) {
    return failure(
      502,
      'ads_unavailable',
      'The Apple Ads request could not be completed. Try again in a moment.',
      coded('ads.requestFailed'),
    );
  }
  const message = redactSecrets(error.message, secret ? secretStrings(secret) : []);
  const extra = withCoding(error);
  switch (error.kind) {
    case 'invalid_key':
      return failure(422, 'ads_invalid_key', message, extra);
    case 'auth':
      return failure(422, 'ads_auth', message, extra);
    case 'forbidden':
      return failure(422, 'ads_forbidden', message, extra);
    case 'not_found':
      return failure(422, 'ads_not_found', message, extra);
    case 'no_account':
      return failure(422, 'ads_no_account', message, extra);
    case 'invalid_input':
      return failure(422, 'ads_invalid_input', message, extra);
    case 'rate_limited': {
      const wait = error.retryAfterSeconds ?? 60;
      return {
        ok: false,
        status: 429,
        body: {
          error: 'rate_limited',
          message,
          ...coded('ads.rateLimited'),
          retryAfterSeconds: wait,
        },
        headers: { 'Retry-After': String(wait) },
      };
    }
    case 'network':
      return error.timedOut
        ? failure(504, 'timeout', message, extra)
        : failure(502, 'ads_unavailable', message, extra);
    case 'server':
    case 'unexpected':
      return failure(502, 'ads_unavailable', message, extra);
  }
}
