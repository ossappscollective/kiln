import {
  AppleProductsConnector,
  AppleProductWriteConnector,
  connectorFactory,
  PlayProductsConnector,
  PlayProductWriteConnector,
  redactSecrets,
  secretStrings,
  type StoreConnectorInput,
  StoreError,
  StoreRateLimitError,
  type StoreProductsConnector,
  type StoreProductWriteConnector,
} from '@kiln/connectors';
import { type ActorType, needsStoreAppId } from '@kiln/core';
import type { Database } from '@kiln/db';
import { credentialKindFor, type ManagedApp } from '../../services/apps.ts';
import type { TestLimiter } from '../../services/credential-tests.ts';
import { useCredentialSecret } from '../../services/credentials.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import type { RevenueCatStep } from '../revenuecat/index.ts';

/**
 * What the sync, the reads and the localization write of in-app products share: the context, the connectors that are built from a
 * credential, the credential itself, the timeout, and the way a store refusal becomes an answer (docs/adr/0034-in-app-products.md).
 */

export type Actor = { type: ActorType; id: string };

export const PRODUCT_WRITE_ENV = 'KILN_STORE_PRODUCT_WRITE_ENABLED';
/** The purpose recorded when a credential is used (the audit row `credential.use`). */
export const PRODUCT_SYNC_PURPOSE = 'products.sync';
export const PRODUCT_WRITE_PURPOSE = 'monetization.write';
/** A sync reads a list and, per product, a few resources: it can take a while. */
export const DEFAULT_PRODUCT_SYNC_TIMEOUT_MS = 180_000;
/** Reading one localization, writing it, and reading it back. */
export const DEFAULT_PRODUCT_WRITE_TIMEOUT_MS = 90_000;
/** Longer than the write timeout, so a claim is never trusted less than the write it guards can still run. */
export const DEFAULT_PRODUCT_CLAIM_TTL_MS = 180_000;

export type ProductsConnectorInput = StoreConnectorInput;
export type ProductsConnectorFactory = (input: ProductsConnectorInput) => StoreProductsConnector;
export type ProductWriteConnectorFactory = (
  input: ProductsConnectorInput,
) => StoreProductWriteConnector;

export const defaultProductsConnectorFactory: ProductsConnectorFactory =
  connectorFactory<StoreProductsConnector>({
    app_store_connect: (input) =>
      AppleProductsConnector.fromSecret(input.secret, {
        appStoreId: input.storeAppId ?? '',
        fetch: input.fetch,
      }),
    google_play: (input) =>
      new PlayProductsConnector({
        serviceAccount: input.secret,
        packageName: input.identifier,
        fetch: input.fetch,
      }),
  });

export const defaultProductWriteConnectorFactory: ProductWriteConnectorFactory =
  connectorFactory<StoreProductWriteConnector>({
    app_store_connect: (input) =>
      AppleProductWriteConnector.fromSecret(input.secret, { fetch: input.fetch }),
    google_play: (input) =>
      new PlayProductWriteConnector({
        serviceAccount: input.secret,
        packageName: input.identifier,
        fetch: input.fetch,
      }),
  });

export type MonetizationContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  /** The per workspace budget of syncs: the one of the app sync. */
  limiter: TestLimiter;
  readFactory: ProductsConnectorFactory;
  readTimeoutMs: number;
  /** KILN_STORE_PRODUCT_WRITE_ENABLED. */
  writeEnabled: boolean;
  writeFactory: ProductWriteConnectorFactory;
  writeTimeoutMs: number;
  claimTtlMs: number;
  /**
   * The RevenueCat read that follows the store read of a sync (docs/adr/0039-revenuecat.md): null when the app has no link. It never throws,
   * never touches the store snapshot, and runs whether or not the store step worked.
   */
  revenueCatStep: (input: { workspaceId: string; appId: string; actor: Actor }) => Promise<RevenueCatStep | null>;
};

// ---------------------------------------------------------------------------------------------
// Failures

export const productWriteDisabledFailure = (): Failure =>
  failure(
    409,
    'store_product_write_disabled',
    `Changing in-app product texts in the stores is switched off on this server. Set ${PRODUCT_WRITE_ENV}=true to turn it on (see docs/deployment.md).`,
    { envName: PRODUCT_WRITE_ENV },
  );

export const notSupportedFailure = (): Failure =>
  failure(
    422,
    'products_not_supported',
    'In-app purchases and subscriptions are not available for the store of this app.',
  );

const clean = (text: string, secret: string) =>
  redactSecrets(text, secret ? secretStrings(secret) : []).slice(0, 500);

export type Mapped = { failure: Failure; code: string };

/**
 * A store refusal as an answer to the person. `secret` is only used to redact. For a read it means nothing was stored; for a write it
 * means NOTHING was changed (an unknown outcome is not an error of this kind: the caller reads the store back).
 */
export function mapStoreError(error: unknown, secret: string): Mapped {
  const make = (
    status: Failure['status'],
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
    headers?: Record<string, string>,
  ): Mapped => ({
    code,
    failure: {
      ...failure(status, code, clean(message, secret), extra),
      ...(headers ? { headers } : {}),
    },
  });
  if (error instanceof StoreRateLimitError) {
    const wait = error.retryAfterSeconds;
    return make(
      429,
      'rate_limited',
      error.message,
      { retryAfterSeconds: wait },
      { 'Retry-After': String(wait) },
    );
  }
  if (error instanceof StoreError) {
    switch (error.kind) {
      case 'auth':
      case 'clock_skew':
        return make(422, 'store_auth', error.message);
      case 'forbidden':
      case 'api_disabled':
      case 'unsupported':
        return make(422, 'store_forbidden', error.message);
      case 'not_found':
        return make(422, 'store_not_found', error.message);
      case 'invalid_input':
        return make(422, 'invalid_product', error.message);
      case 'server':
      case 'network':
      case 'edit_invalid':
        return make(502, 'store_unavailable', error.message);
      default:
        return make(
          error.status !== undefined && error.status >= 400 && error.status < 500 ? 422 : 502,
          'store_rejected',
          error.message,
        );
    }
  }
  return make(502, 'store_failed', 'The store could not be read or changed.');
}

// ---------------------------------------------------------------------------------------------
// The timeout and the credential

export class StoreTimeout extends Error {}

/** Runs `job` with a connector whose requests are aborted after the timeout. */
export async function withConnector<C, T>(
  factory: (input: ProductsConnectorInput) => C,
  input: Omit<ProductsConnectorInput, 'fetch'>,
  timeoutMs: number,
  job: (connector: C) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const baseFetch = globalThis.fetch;
  const guardedFetch: typeof fetch = (target, init) =>
    baseFetch(target, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new StoreTimeout('timeout'));
    }, timeoutMs);
  });
  try {
    const work = job(factory({ ...input, fetch: guardedFetch }));
    work.catch(() => undefined);
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export type Connection = { input: Omit<ProductsConnectorInput, 'fetch'>; secret: string };

/** The credential of the app, decrypted for one use; or the failure to answer with (nothing was asked of the store). */
export async function connect(
  ctx: Pick<MonetizationContext, 'db' | 'masterKey' | 'now'>,
  workspaceId: string,
  app: ManagedApp,
  purpose: string,
  actor: Actor,
): Promise<{ ok: true; connection: Connection } | Failure> {
  const [credential] = await ctx.db.query(
    'SELECT kind FROM credentials WHERE id = ? AND workspace_id = ?',
    [app.credentialId, workspaceId],
  );
  if (!credential)
    return failure(422, 'credential_not_found', 'The credential of this app no longer exists.');
  if (String(credential.kind) !== credentialKindFor[app.platform]) {
    return failure(
      422,
      'credential_kind',
      "This app's credential is not the kind its platform needs.",
    );
  }
  if (needsStoreAppId(app.platform) && !app.storeAppId) {
    return failure(
      422,
      'app_not_synced',
      'The App Store id of this app is not known yet. Sync the app first.',
    );
  }
  let secret: string | undefined;
  try {
    secret = await useCredentialSecret(
      ctx.db,
      ctx.masterKey,
      { workspaceId, id: app.credentialId, purpose },
      actor,
      ctx.now(),
    );
  } catch {
    return failure(
      422,
      'credential_unreadable',
      'The credential could not be decrypted. Enter its secret again.',
    );
  }
  if (secret === undefined)
    return failure(422, 'credential_not_found', 'The credential of this app no longer exists.');
  return {
    ok: true,
    connection: {
      secret,
      input: {
        kind: credentialKindFor[app.platform],
        secret,
        identifier: app.identifier,
        storeAppId: app.storeAppId,
        platform: app.platform,
      },
    },
  };
}

export const timeoutFailure = (): Failure =>
  failure(504, 'timeout', 'The store did not answer in time.');
