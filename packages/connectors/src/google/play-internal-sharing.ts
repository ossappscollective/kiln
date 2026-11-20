import { StoreError, StoreRateLimitError } from '../errors.ts';
import {
  enc,
  isRecord,
  StoreHttp,
  type StoreHttpOptions,
  type StoreReply,
  text,
} from '../store-http.ts';
import { GoogleTokenProvider, parseServiceAccount, type ServiceAccount } from './google-auth.ts';
import { googleError, isPlayPackageName } from './googleplay.ts';

/**
 * Google Play INTERNAL APP SHARING: upload an .aab or .apk and get a download link that installs it on a device. A STORE WRITE (it
 * puts a binary on Google's servers under the developer's account), though it publishes nothing to users: the link works for the
 * accounts Google allows (see the docs). Only ever called by the server's internal sharing service after a role check, a preview,
 * a confirmation hash, a typed phrase and a step-up confirmation (docs/adr/0020-play-internal-sharing.md).
 *
 * What Google's pages say (read on 2026-11-19):
 * - VERIFIED (page text): `internalappsharingartifacts.uploadbundle` and `.uploadapk` are `POST` requests to
 *   `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/internalappsharing/{packageName}/artifacts/bundle`
 *   (and `.../artifacts/apk`), scope `https://www.googleapis.com/auth/androidpublisher`, "the request body contains an instance of
 *   Media", and "a timeout of 2 minutes is recommended" for client libraries. The resource `InternalAppSharingArtifact` has
 *   `downloadUrl` ("The link generated for the uploaded artifact. Authorized users can follow it to install the app through the
 *   Play Store"), `certificateFingerprint` (SHA-256 of the signing certificate) and `sha256` (lowercase hex of the artifact).
 * - VERIFIED (help page support.google.com/googleplay/android-developer/answer/9844679, text only): "Download links expire 60 days
 *   after the upload date"; access can be limited to email lists or open to anyone with the link, "a maximum of 100 users" can
 *   download through a link; testers must turn on internal app sharing in their Play Store app.
 * - UNVERIFIED (nothing was run): that `uploadType=media` with `Content-Type: application/octet-stream` is accepted (it is Google's
 *   standard simple media upload; the reference page does not name the parameter); the exact shape of `downloadUrl`; whether Google
 *   checks the package name of the file against the path; the largest file Google accepts (no figure was found); whether an app must
 *   exist in Play Console first; the exact wording of Google's errors (messages here are ours, built from the HTTP status).
 *
 * The upload is NEVER retried. Google has no call to list or read back an uploaded artifact, so a lost answer or a 5xx is an unknown
 * outcome (`InternalSharingOutcomeUnknownError`) that cannot be settled by reading: the caller reports it. The download link is a
 * secret: it is added to the redaction list, never put in a message, and is returned only in the result.
 */

export type InternalSharingKind = 'bundle' | 'apk';

export type InternalSharingUpload = {
  /** The link that installs the build. SENSITIVE: whoever holds it (and is allowed by Google) can install the build. */
  downloadUrl: string;
  /** SHA-256 fingerprint of the certificate that signed the artifact, when Google said. */
  certificateFingerprint: string | null;
  /** Lowercase hex SHA-256 of the artifact as Google computed it, when it said. */
  sha256: string | null;
};

export interface InternalSharingConnector {
  readonly store: 'googleplay';
  readonly packageName: string;
  /** Uploads once. Throws `StoreError` (nothing applied) or `InternalSharingOutcomeUnknownError` (not known; never retry blind). */
  upload(kind: InternalSharingKind, bytes: Uint8Array): Promise<InternalSharingUpload>;
}

/** The answer was lost or came back as a server error: the artifact may or may not exist in Google Play. Nothing retries it. */
export class InternalSharingOutcomeUnknownError extends StoreError {
  constructor(message: string, status?: number) {
    super('googleplay', 'network', message, status);
    this.name = 'InternalSharingOutcomeUnknownError';
  }
}

export type PlayInternalSharingOptions = Omit<StoreHttpOptions, 'store'> & {
  serviceAccount: string | ServiceAccount;
  packageName: string;
  apiBase?: string;
  /** Per upload request. Default 10 minutes (Google advises at least 2 for this call; a bundle can be large). */
  uploadTimeoutMs?: number;
};

const DEFAULT_BASE = 'https://androidpublisher.googleapis.com';
const DEFAULT_UPLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_URL_LENGTH = 2048;

export class PlayInternalSharingConnector implements InternalSharingConnector {
  readonly store = 'googleplay' as const;
  readonly packageName: string;
  readonly #tokenHttp: StoreHttp;
  readonly #uploadHttp: StoreHttp;
  readonly #tokens: GoogleTokenProvider;
  readonly #base: string;
  readonly #account: ServiceAccount;

  constructor(options: PlayInternalSharingOptions) {
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
    const {
      uploadTimeoutMs,
      serviceAccount: _account,
      packageName: _name,
      apiBase: _base,
      ...shared
    } = options;
    this.#tokenHttp = new StoreHttp({ ...shared, store: 'googleplay' });
    // No wait-and-retry on 429 for the write, and a long timeout for the bytes.
    this.#uploadHttp = new StoreHttp({
      ...shared,
      store: 'googleplay',
      maxRateLimitRetries: 0,
      timeoutMs: uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS,
    });
    this.#base = (options.apiBase ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.#tokens = new GoogleTokenProvider(this.#account, this.#tokenHttp);
    for (const known of this.#tokenHttp.known) this.#uploadHttp.known.add(known);
  }

  async upload(kind: InternalSharingKind, bytes: Uint8Array): Promise<InternalSharingUpload> {
    if (bytes.byteLength === 0)
      throw new StoreError(
        'googleplay',
        'invalid_input',
        'The file is empty, so nothing was uploaded.',
      );
    const what =
      kind === 'bundle'
        ? 'uploading the app bundle for internal app sharing'
        : 'uploading the APK for internal app sharing';
    const url = `${this.#base}/upload/androidpublisher/v3/applications/internalappsharing/${enc(this.packageName)}/artifacts/${kind}?uploadType=media`;
    for (let attempt = 0; ; attempt++) {
      const token = await this.#tokens.token();
      let reply: StoreReply;
      try {
        reply = await this.#uploadHttp.send('POST', url, {
          headers: { authorization: `Bearer ${token}` },
          raw: { body: bytes, contentType: 'application/octet-stream' },
        });
      } catch (error) {
        if (error instanceof StoreRateLimitError) throw error;
        if (error instanceof StoreError && error.kind === 'network') {
          throw new InternalSharingOutcomeUnknownError(
            `The connection to Google Play failed while ${what}, so it is not known whether Google stored the file. ${error.message}`,
            error.status,
          );
        }
        throw error;
      }
      if (reply.status === 401 && attempt === 0) {
        // Google rejected the token before it looked at the file: a new token is safe to try once.
        this.#tokens.invalidate();
        continue;
      }
      if (reply.status >= 200 && reply.status < 300) return this.#result(reply, what);
      if (reply.status >= 500) {
        throw new InternalSharingOutcomeUnknownError(
          `Google Play answered HTTP ${reply.status} while ${what}, so it is not known whether Google stored the file.`,
          reply.status,
        );
      }
      throw this.#refusal(reply, what);
    }
  }

  #result(reply: StoreReply, what: string): InternalSharingUpload {
    const body = isRecord(reply.json) ? reply.json : {};
    const downloadUrl = text(body.downloadUrl);
    // Google said yes but the link cannot be used: the file may be stored, so this is not a plain failure.
    if (
      reply.malformed ||
      !downloadUrl ||
      downloadUrl.length > MAX_URL_LENGTH ||
      !/^https:\/\/[^\s]+$/.test(downloadUrl)
    ) {
      throw new InternalSharingOutcomeUnknownError(
        `Google Play answered while ${what} but sent no usable download link, so the file may be stored without a link this server can show.`,
        reply.status,
      );
    }
    this.#uploadHttp.known.add(downloadUrl);
    const fingerprint = text(body.certificateFingerprint);
    const digest = text(body.sha256)?.toLowerCase();
    return {
      downloadUrl,
      certificateFingerprint: fingerprint && fingerprint.length <= 200 ? fingerprint : null,
      sha256: digest && /^[0-9a-f]{64}$/.test(digest) ? digest : null,
    };
  }

  #refusal(reply: StoreReply, what: string): StoreError {
    if (reply.status === 413) {
      return new StoreError(
        'googleplay',
        'too_large',
        'Google Play refused the file because it is too large (413). Nothing was uploaded.',
        413,
      );
    }
    if (reply.status === 400) {
      return new StoreError(
        'googleplay',
        'invalid_input',
        'Google Play did not accept the file (400): it may not be a valid, signed app bundle or APK, or not for this package. Nothing was uploaded.',
        400,
      );
    }
    const error = googleError(reply, what, {
      packageName: this.packageName,
      ...(this.#account.projectId ? { projectId: this.#account.projectId } : {}),
    });
    return error instanceof StoreRateLimitError
      ? error
      : new StoreError(
          'googleplay',
          error.kind,
          this.#uploadHttp.redact(error.message),
          error.status,
        );
  }
}
