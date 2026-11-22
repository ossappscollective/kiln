import {
  isStorePlayReleaseChecker,
  type PlayCheckFinding,
  type PlayCheckRelease,
  redactSecrets,
  StoreError,
  StoreRateLimitError,
  secretStrings,
} from '@kiln/connectors';
import { normalizeReleaseValue, supports, versionCodesOf } from '@kiln/core';
import type { Database } from '@kiln/db';
import type {
  ReleaseConnectorFactory,
  ReleaseConnectorInput,
} from '../modules/publish/store-release.ts';
import { credentialKindFor, type ManagedApp } from './apps.ts';
import { useCredentialSecret } from './credentials.ts';
import { type Failure, failure } from './repositories.ts';

import { type Coding, coded, codingOf } from '../i18n/problem.ts';
/**
 * "Check with Google Play" (docs/api/releases-write.md, docs/adr/0025-play-release-checks.md): asks Google Play whether a release as
 * a person proposes it would be refused, WITHOUT saving anything. The connector opens an edit, stages the proposed release in the
 * track, calls `edits.validate` and always deletes the edit. It never commits.
 *
 * A READ for this server's rules, like `release/candidates`: the right `listing.read`, no switch, the credential of the app
 * (audited as `credential.use`, purpose `store.release_check`), a per-workspace rate limit (the route), errors as fixed sentences.
 * What Google says about the release is returned as `findings` in Google's words (cut, redacted): the caller treats it as text
 * from a third party. The release notes are never logged and never audited.
 */

export const PLAY_CHECK_PURPOSE = 'store.release_check';
export const DEFAULT_PLAY_CHECK_TIMEOUT_MS = 60_000;

/** The sentence that must travel with every answer: no errors is not "no warnings". */
export const PLAY_CHECK_NO_ERRORS_NOTE =
  'Google Play found no errors in this release. The Play Console may still show warnings: the API reports errors only, so notices such as a missing deobfuscation file or the target API level are not covered by this check. Nothing was saved in Google Play.';
export const PLAY_CHECK_ERRORS_NOTE =
  'Google Play reported errors for this release as proposed. Fix them before releasing. Nothing was saved in Google Play.';

export type PlayCheckContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  /** The connector that can check a release (the release connector; fakes in tests). No switch is read: a check changes nothing. */
  releaseConnectorFactory: ReleaseConnectorFactory;
  releaseTimeoutMs?: number;
};

export type PlayCheckInput = {
  track: string;
  versionCodes: string[];
  releaseName?: string | undefined;
  status?: 'draft' | 'inProgress' | 'completed' | undefined;
  userFraction?: number | undefined;
  notes?: { locale: string; text: string }[] | undefined;
};

export type PlayCheckView = {
  store: 'googleplay';
  track: string;
  versionCodes: string[];
  status: 'draft' | 'inProgress' | 'completed';
  userFraction: number | null;
  /** `no_errors`: Google found no error. NOT "no warnings". `errors`: see `findings`. */
  outcome: 'no_errors' | 'errors';
  findings: PlayCheckFinding[];
  /** Always false: the edit was deleted and nothing was committed. */
  committed: false;
  checkedAt: number;
  /** A fixed sentence that says what the check does and does not cover. */
  note: string;
};

const TRACK = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,99}$/;
const LOCALE = /^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8}){0,2}$/;
const invalid = (code: string, message: string, field: string, coding?: Coding): Failure =>
  failure(422, code, message, { field, ...coding });

/** The release the connector validates, or why the request is not one. */
export function playCheckRequestOf(
  app: Pick<ManagedApp, 'platform'>,
  input: PlayCheckInput,
): { ok: true; release: PlayCheckRelease } | Failure {
  if (!supports(app.platform, 'releaseCheck'))
    return invalid(
      'not_applicable',
      'Check with Google Play is for Android apps. An App Store release has its own checks in the preview.',
      'track',
      coded('playCheck.androidOnly'),
    );
  if (!TRACK.test(input.track))
    return invalid(
      'track_required',
      'Name the track of the release (for example production).',
      'track',
      coded('publish.trackRequired'),
    );
  const codes = versionCodesOf(normalizeReleaseValue('version_codes', input.versionCodes));
  if (codes.length === 0 || codes.length > 20 || codes.some((c) => !/^[0-9]{1,10}$/.test(c)))
    return invalid(
      'invalid_version_codes',
      'versionCodes are whole numbers (at most 20).',
      'versionCodes',
    );
  const fraction = input.userFraction;
  if (
    fraction !== undefined &&
    (!Number.isFinite(fraction) ||
      !(fraction > 0 && fraction <= 1) ||
      Math.round(fraction * 10000) / 10000 !== fraction)
  )
    return invalid(
      'invalid_user_fraction',
      'userFraction must be more than 0 and at most 1, with at most 4 decimals (for example 0.1 for 10%).',
      'userFraction',
    );
  const status =
    input.status ??
    (fraction === undefined ? 'draft' : fraction === 1 ? 'completed' : 'inProgress');
  if (status === 'draft' && fraction !== undefined)
    return invalid(
      'invalid_user_fraction',
      'A draft release has no share of users. Leave userFraction out, or check it as inProgress or completed.',
      'userFraction',
    );
  if (status === 'inProgress' && (fraction === undefined || fraction >= 1))
    return invalid(
      'invalid_user_fraction',
      'A release that is rolling out needs a share above 0 and below 1. Use completed for everybody.',
      'userFraction',
    );
  if (status === 'completed' && fraction !== undefined && fraction !== 1)
    return invalid(
      'invalid_user_fraction',
      'A completed release goes to everybody. Leave userFraction out or use 1.',
      'userFraction',
    );
  const notes: { locale: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const note of input.notes ?? []) {
    if (!LOCALE.test(note.locale))
      return invalid('invalid_locale', 'A language code looks like en-US.', 'notes');
    const key = note.locale.replace(/_/g, '-').toLowerCase();
    if (seen.has(key))
      return invalid('invalid_request', 'Each language may appear once in notes.', 'notes');
    seen.add(key);
    notes.push({ locale: note.locale.replace(/_/g, '-'), text: note.text });
  }
  const name = input.releaseName?.trim();
  return {
    ok: true,
    release: {
      track: input.track,
      versionCodes: codes,
      status,
      ...(status === 'inProgress' && fraction !== undefined ? { userFraction: fraction } : {}),
      ...(name ? { name } : {}),
      notes,
    },
  };
}

class CheckTimeout extends Error {}

const mapFailure = (error: unknown, secret: string): Failure => {
  const clean = (text: string) =>
    redactSecrets(text, secret ? secretStrings(secret) : []).slice(0, 500);
  if (error instanceof StoreRateLimitError) {
    const wait = error.retryAfterSeconds;
    return {
      ...failure(429, 'rate_limited', clean(error.message), {
        retryAfterSeconds: wait,
        ...codingOf(error),
      }),
      headers: { 'Retry-After': String(wait) },
    };
  }
  if (error instanceof StoreError) {
    switch (error.kind) {
      case 'auth':
      case 'clock_skew':
        return failure(422, 'store_auth', clean(error.message), codingOf(error));
      case 'forbidden':
      case 'api_disabled':
      case 'unsupported':
        return failure(422, 'store_forbidden', clean(error.message), codingOf(error));
      case 'not_found':
        return failure(422, 'store_not_found', clean(error.message), codingOf(error));
      case 'invalid_input':
        return failure(422, 'store_rejected', clean(error.message), codingOf(error));
      case 'server':
      case 'network':
      case 'edit_invalid':
        return failure(
          502,
          'store_unavailable',
          `${clean(error.message)} Nothing was saved in Google Play.`,
        );
      default:
        return failure(
          error.status !== undefined && error.status >= 400 && error.status < 500 ? 422 : 502,
          'store_rejected',
          clean(error.message),
          codingOf(error),
        );
    }
  }
  return failure(
    502,
    'check_failed',
    'The check could not be made. Nothing was saved in Google Play.',
    coded('playCheck.failed'),
  );
};

export async function checkPlayReleaseOf(
  ctx: PlayCheckContext,
  input: {
    workspaceId: string;
    app: ManagedApp;
    actor: { type: 'user' | 'token' | 'system'; id: string };
  } & {
    body: PlayCheckInput;
  },
): Promise<{ ok: true; check: PlayCheckView } | Failure> {
  const { app } = input;
  const asked = playCheckRequestOf(app, input.body);
  if (!asked.ok) return asked;
  const [credential] = await ctx.db.query(
    'SELECT kind FROM credentials WHERE id = ? AND workspace_id = ?',
    [app.credentialId, input.workspaceId],
  );
  if (!credential)
    return failure(
      422,
      'credential_not_found',
      'The credential of this app no longer exists.',
      coded('credential.gone'),
    );
  if (String(credential.kind) !== credentialKindFor[app.platform])
    return failure(
      422,
      'credential_kind',
      "This app's credential is not the kind its platform needs.",
      coded('credential.wrongKind'),
    );
  let secret: string | undefined;
  try {
    secret = await useCredentialSecret(
      ctx.db,
      ctx.masterKey,
      { workspaceId: input.workspaceId, id: app.credentialId, purpose: PLAY_CHECK_PURPOSE },
      input.actor,
      ctx.now(),
    );
  } catch {
    return failure(
      422,
      'credential_unreadable',
      'The credential could not be decrypted. Enter its secret again.',
      coded('credential.undecryptable'),
    );
  }
  if (secret === undefined)
    return failure(
      422,
      'credential_not_found',
      'The credential of this app no longer exists.',
      coded('credential.gone'),
    );

  const connectorInput: Omit<ReleaseConnectorInput, 'fetch'> = {
    kind: credentialKindFor[app.platform],
    secret,
    identifier: app.identifier,
    storeAppId: app.storeAppId,
    platform: app.platform,
  };
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
      reject(new CheckTimeout('timeout'));
    }, ctx.releaseTimeoutMs ?? DEFAULT_PLAY_CHECK_TIMEOUT_MS);
  });
  try {
    const connector = ctx.releaseConnectorFactory({ ...connectorInput, fetch: guardedFetch });
    if (!isStorePlayReleaseChecker(connector))
      throw new StoreError(
        'googleplay',
        'unsupported',
        'This store connection cannot check a release with Google Play.',
      );
    const work = connector.checkPlayRelease(asked.release);
    work.catch(() => undefined);
    const result = await Promise.race([work, timedOut]);
    const release = asked.release;
    const clean = (text: string) => redactSecrets(text, secretStrings(secret ?? '')).slice(0, 400);
    return {
      ok: true,
      check: {
        store: 'googleplay',
        track: release.track,
        versionCodes: release.versionCodes,
        status: release.status,
        userFraction: release.userFraction ?? null,
        outcome: result.outcome,
        findings: result.findings
          .slice(0, 20)
          .map((f) => ({ stage: f.stage, message: clean(f.message) })),
        committed: false,
        checkedAt: ctx.now(),
        note: result.outcome === 'no_errors' ? PLAY_CHECK_NO_ERRORS_NOTE : PLAY_CHECK_ERRORS_NOTE,
      },
    };
  } catch (error) {
    if (error instanceof CheckTimeout)
      return failure(
        504,
        'timeout',
        'Google Play did not answer in time. Nothing was saved in Google Play.',
        coded('playCheck.timeout'),
      );
    return mapFailure(error, secret);
  } finally {
    clearTimeout(timer);
  }
}
