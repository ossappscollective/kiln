import {
  createExpoClient,
  type ExpoClient,
  ExpoError,
  expoErrorMessage,
  redactSecrets,
  secretStrings,
} from '@kiln/connectors';
import type { ActorType } from '@kiln/core';
import type { Database } from '@kiln/db';
import { coded } from '../../i18n/problem.ts';
import { useCredentialSecret } from '../../services/credentials.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import type { EasDeps } from './index.ts';

/**
 * The one way every EAS feature gets a client for Expo (docs/adr/0033-eas-integration.md). It reads the Expo credential, decrypts the
 * token for this one client (audited as `credential.use` with the purpose the caller names), and hands back a client whose closure is
 * the only place the token lives. Nothing returned, thrown or logged here carries it. Build a client per operation and drop it; do not
 * keep one.
 *
 * Every feature turns an `ExpoError` into a response with `expoFailure`, so the codes are the same everywhere:
 * `expo_auth`, `expo_forbidden`, `expo_not_found` (422), `rate_limited` (429), `timeout` (504), `expo_unavailable` (502).
 */

type Actor = { type: ActorType; id: string };

export type ExpoUse = {
  /** Who is acting; the use of the credential is audited under them. */
  actor: Actor;
  /** Why the credential is read, for the audit row (`eas.link`, `eas.builds`, ...). A short constant, never user text. */
  purpose: string;
  now: number;
};

export type ExpoClientResult = { ok: true; client: ExpoClient } | Failure;

export async function expoClientFor(
  db: Database,
  masterKey: Buffer,
  workspaceId: string,
  credentialId: string,
  deps: EasDeps | undefined,
  use: ExpoUse,
): Promise<ExpoClientResult> {
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
  if (String(row.kind) !== 'expo') {
    return failure(
      422,
      'credential_kind',
      'Expo needs a credential of the Expo access token kind.',
      coded('credential.notExpoKind'),
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
    return {
      ok: true,
      client: createExpoClient({
        token: secret,
        fetch: deps?.fetch,
        apiOrigin: deps?.apiOrigin,
      }),
    };
  } catch (error) {
    return expoFailure(error, secret);
  }
}

/** A response for whatever a call to Expo threw. Messages are fixed sentences, redacted once more against the secret in use. */
export function expoFailure(error: unknown, secret = ''): Failure {
  if (!(error instanceof ExpoError)) {
    return failure(
      502,
      'expo_unavailable',
      'The Expo request could not be completed. Try again in a moment.',
      coded('eas.requestFailed'),
    );
  }
  const message = redactSecrets(error.message, secret ? secretStrings(secret) : []);
  switch (error.kind) {
    case 'auth':
      return failure(422, 'expo_auth', message);
    case 'forbidden':
      return failure(422, 'expo_forbidden', message);
    case 'not_found':
      return failure(422, 'expo_not_found', message);
    case 'invalid_input':
      return failure(422, 'invalid_project', message);
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
        : failure(502, 'expo_unavailable', message);
    case 'server':
    case 'unexpected':
      return failure(502, 'expo_unavailable', message || expoErrorMessage(error.kind));
  }
}
