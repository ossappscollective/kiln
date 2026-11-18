import { parseAppStoreConnectSecret } from './apple-auth.ts';
import { AppStoreConnectConnector } from './appstoreconnect.ts';
import { redactSecrets, StoreError } from './errors.ts';
import { parseServiceAccount } from './google-auth.ts';
import { GooglePlayConnector, isPlayPackageName } from './googleplay.ts';
import type { VerifyOptions, VerifyResult } from './verify.ts';

/**
 * "Test connection" for the two store credentials. Read-only: the only requests are
 * `GET /v1/apps?limit=1` for Apple, and for Google a token exchange plus, at most, an edit that
 * is inserted and deleted again without being committed.
 *
 * Never throw. Every failure is a VerifyResult with a sentence that says what to fix, and no
 * message or detail carries the key, a token or a JWT (see `redactSecrets`). The messages say
 * what was proven and, where it matters, what was not.
 */

export type StoreVerifyOptions = VerifyOptions & {
  /** Per request. Default 10000. */
  timeoutMs?: number;
};

export type GooglePlayVerifyOptions = StoreVerifyOptions & {
  /**
   * A package name to check access to. The Play Developer API cannot list apps, so without one
   * only the key and the API are proven, not access to any app.
   */
  packageName?: string;
};

/** A package name Play does not allow for real apps (`com.example` is reserved). */
const PROBE_PACKAGE = 'com.example.mrm.credentialcheck';

/**
 * What must never appear in output: the whole secret and the private key with each of its lines.
 * (Not every field: the service account email and the Key ID are safe, useful facts.)
 */
function keyMaterial(secret: string): string[] {
  const found = new Set<string>([secret, secret.trim()]);
  try {
    const parsed: unknown = JSON.parse(secret);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      for (const value of [record.privateKey, record.private_key]) {
        if (typeof value !== 'string') continue;
        found.add(value);
        found.add(value.trim());
        for (const line of value.split(/\r?\n/)) {
          if (line && !line.startsWith('-----')) found.add(line.trim());
        }
      }
    }
  } catch {
    // Not JSON: the whole string is already included.
  }
  return [...found];
}

function safe(secret: string, value: string): string {
  return redactSecrets(value, keyMaterial(secret));
}

function fail(secret: string, message: string, details?: string[]): VerifyResult {
  return {
    ok: false,
    message: safe(secret, message),
    ...(details?.length ? { details: details.map((d) => safe(secret, d)) } : {}),
  };
}

/** Same for an unexpected exception: say that something went wrong, never echo it. */
const unexpected = (secret: string): VerifyResult =>
  fail(secret, 'The check failed in an unexpected way. See the server log.');

export async function verifyAppStoreConnectCredential(
  secret: string,
  options: StoreVerifyOptions = {},
): Promise<VerifyResult> {
  let connector: AppStoreConnectConnector;
  let keyId: string;
  let issuerId: string;
  try {
    const credential = parseAppStoreConnectSecret(secret);
    keyId = credential.keyId;
    issuerId = credential.issuerId;
    connector = new AppStoreConnectConnector({
      credential,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.now ? { now: options.now } : {}),
      timeoutMs: options.timeoutMs ?? 10_000,
      maxRateLimitRetries: 0,
    });
  } catch (error) {
    // Local problems: unreadable secret, or a key that is not a P-256 key.
    return error instanceof StoreError ? fail(secret, error.message) : unexpected(secret);
  }
  // Format hints are only shown when Apple says no: the formats are described by Apple's docs
  // by example, and a rule we guessed wrong must not block a working key.
  const hints: string[] = [];
  if (!/^[A-Z0-9]{10}$/.test(keyId)) {
    hints.push('The Key ID does not look like 10 letters and digits.');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(issuerId)) {
    hints.push('The Issuer ID does not look like a UUID.');
  }
  try {
    const access = await connector.checkAccess();
    const count = access.appCount;
    const details = [
      'Checked: Apple accepted a token signed with this key (GET /v1/apps).',
      'Not checked: the key\'s role. Releases need App Manager or higher.',
    ];
    if (count !== undefined) details.unshift(`Apps visible to this key: ${count}.`);
    return {
      ok: true,
      message:
        count === 0
          ? 'App Store Connect accepted the key, but it can see no apps yet. Add an app in App Store Connect, or check that the key belongs to the right team.'
          : `App Store Connect accepted the key${count === undefined ? '' : ` and it can see ${count} app${count === 1 ? '' : 's'}`}.`,
      details: details.map((d) => safe(secret, d)),
    };
  } catch (error) {
    if (!(error instanceof StoreError)) return unexpected(secret);
    const wrong = error.kind === 'auth' || error.kind === 'clock_skew';
    return fail(secret, error.message, wrong ? hints : []);
  }
}

export async function verifyGooglePlayCredential(
  secret: string,
  options: GooglePlayVerifyOptions = {},
): Promise<VerifyResult> {
  const packageName = options.packageName?.trim() || undefined;
  if (packageName && !isPlayPackageName(packageName)) {
    return fail(secret, `"${packageName.slice(0, 80)}" is not a valid Android package name.`);
  }
  let connector: GooglePlayConnector;
  let email: string;
  let projectId: string | undefined;
  try {
    const account = parseServiceAccount(secret);
    email = account.clientEmail;
    projectId = account.projectId;
    connector = new GooglePlayConnector({
      serviceAccount: account,
      packages: [],
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.now ? { now: options.now } : {}),
      timeoutMs: options.timeoutMs ?? 10_000,
      maxRateLimitRetries: 0,
    });
  } catch (error) {
    return error instanceof StoreError ? fail(secret, error.message) : unexpected(secret);
  }
  const who = [
    `Service account: ${email}`,
    ...(projectId ? [`Cloud project: ${projectId}`] : []),
  ];
  try {
    await connector.checkToken();
  } catch (error) {
    return error instanceof StoreError ? fail(secret, error.message, who) : unexpected(secret);
  }
  if (packageName) {
    try {
      await connector.probeEdit(packageName);
    } catch (error) {
      return error instanceof StoreError ? fail(secret, error.message, who) : unexpected(secret);
    }
    return {
      ok: true,
      message: `Google accepted the key, and the service account can open an edit for ${packageName}. The edit was deleted without any change.`,
      details: [
        ...who,
        'Checked: key and clock, the Play Developer API is enabled, access to this app.',
        'Not checked: which permissions the service account has in Play Console.',
      ].map((d) => safe(secret, d)),
    };
  }
  // No package: the Play Developer API cannot list apps. Probe with a package that cannot exist.
  // With the API enabled and the token accepted, Google answers 403 or 404 for it; a disabled API
  // or a rejected token is a different failure. That proves the API and the key, not access.
  try {
    await connector.probeEdit(PROBE_PACKAGE);
  } catch (error) {
    if (!(error instanceof StoreError)) return unexpected(secret);
    const reachable =
      (error.kind === 'forbidden' || error.kind === 'not_found') &&
      !/not linked/i.test(error.message);
    if (!reachable) return fail(secret, error.message, who);
  }
  return {
    ok: true,
    message:
      'Google accepted the key and the Play Developer API is enabled. Access to your apps is not proven: the API has no call that lists apps. Enter a package name to check access to one app.',
    details: [
      ...who,
      'Checked: key and clock, the Play Developer API is enabled in the Cloud project.',
      'Not checked: that this service account was invited in Play Console, or which apps it can see.',
    ].map((d) => safe(secret, d)),
  };
}
