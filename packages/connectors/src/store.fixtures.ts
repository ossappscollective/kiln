import { generateKeyPairSync } from 'node:crypto';

/**
 * Hand-written fixtures for the store connector tests. They follow the response shapes in Apple's
 * and Google's reference pages (see docs/spikes/store-api-conventions.md) and are NOT recordings
 * of live traffic. Error bodies marked "from memory" use wording seen in the wild that the
 * reference pages do not quote.
 */

export const APPLE_BASE = 'https://api.appstoreconnect.apple.com';
export const GOOGLE_BASE = 'https://androidpublisher.googleapis.com';

// ---------------------------------------------------------------------------------------------
// Keys. Generated per test run, so no real key is ever in the repository.

export function appleKeyPem(): { privateKey: string; publicKey: import('node:crypto').KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey };
}

export function googleKeyPem(): { privateKey: string; publicKey: import('node:crypto').KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey };
}

export const KEY_ID = '2X9R4HXF34';
export const ISSUER_ID = '57246542-96fe-1a63-e053-0824d011072a';
export const SA_EMAIL = 'release-bot@my-project-123.iam.gserviceaccount.com';

export const serviceAccountJson = (privateKey: string): string =>
  JSON.stringify({
    type: 'service_account',
    project_id: 'my-project-123',
    private_key_id: 'abcdef0123456789',
    private_key: privateKey,
    client_email: SA_EMAIL,
    client_id: '1234567890',
    token_uri: 'https://oauth2.googleapis.com/token',
  });

// ---------------------------------------------------------------------------------------------
// App Store Connect

const appRel = (id: string) => ({
  appStoreVersions: {
    links: {
      self: `${APPLE_BASE}/v1/apps/${id}/relationships/appStoreVersions`,
      related: `${APPLE_BASE}/v1/apps/${id}/appStoreVersions`,
    },
  },
});

const app = (id: string, name: string, bundleId: string) => ({
  type: 'apps',
  id,
  attributes: {
    name,
    bundleId,
    sku: name.toUpperCase().replace(/\W/g, ''),
    primaryLocale: 'en-US',
    isOrEverWasMadeForKids: false,
    contentRightsDeclaration: 'DOES_NOT_USE_THIRD_PARTY_CONTENT',
  },
  relationships: appRel(id),
  links: { self: `${APPLE_BASE}/v1/apps/${id}` },
});

export const appleAppsPage1 = {
  data: [
    app('10746822401', 'Your Next Cortado', 'com.bdt.ync'),
    app('10746821976', 'A Lot of Latte', 'com.bdt.latte'),
  ],
  links: {
    self: `${APPLE_BASE}/v1/apps?limit=2`,
    next: `${APPLE_BASE}/v1/apps?cursor=AoJ4g7mg6o4DKzEwNzQ2ODIxOTc2.ANrJC88&limit=2`,
  },
  meta: { paging: { total: 3, limit: 2 } },
};

export const appleAppsPage2 = {
  data: [app('10746822555', 'Flat White', 'com.bdt.flat')],
  links: {
    self: `${APPLE_BASE}/v1/apps?cursor=AoJ4g7mg6o4DKzEwNzQ2ODIxOTc2.ANrJC88&limit=2`,
  },
  meta: { paging: { total: 3, limit: 2 } },
};

export const appleAppsEmpty = {
  data: [],
  links: { self: `${APPLE_BASE}/v1/apps?limit=1` },
  meta: { paging: { total: 0, limit: 1 } },
};

export const appleAppsOne = {
  data: [app('10746822401', 'Your Next Cortado', 'com.bdt.ync')],
  links: { self: `${APPLE_BASE}/v1/apps?limit=1`, next: `${APPLE_BASE}/v1/apps?cursor=x&limit=1` },
  meta: { paging: { total: 431, limit: 1 } },
};

const version = (id: string, attributes: Record<string, unknown>) => ({
  type: 'appStoreVersions',
  id,
  attributes: { copyright: '2022 YNC', releaseType: 'MANUAL', downloadable: true, ...attributes },
  links: { self: `${APPLE_BASE}/v1/appStoreVersions/${id}` },
});

/** Both state fields exist while Apple migrates: the new one wins, the old one is the fallback. */
export const appleVersions = {
  data: [
    version('v-new', { platform: 'IOS', versionString: '2.1', appVersionState: 'WAITING_FOR_REVIEW', appStoreState: 'WAITING_FOR_REVIEW' }),
    version('v-new-only', { platform: 'IOS', versionString: '2.0', appVersionState: 'READY_FOR_DISTRIBUTION' }),
    version('v-old-only', { platform: 'IOS', versionString: '1.9', appStoreState: 'READY_FOR_SALE' }),
    version('v-unknown', { platform: 'IOS', versionString: '1.8', appVersionState: 'SOMETHING_NEW' }),
    version('v-mac', { platform: 'MAC_OS', versionString: '2.1', appVersionState: 'PREPARE_FOR_SUBMISSION' }),
  ],
  links: { self: `${APPLE_BASE}/v1/apps/10746822401/appStoreVersions` },
  meta: { paging: { total: 5, limit: 50 } },
};

const build = (id: string, preId: string | null, attributes: Record<string, unknown>) => ({
  type: 'builds',
  id,
  attributes: {
    version: '1',
    uploadedDate: '2022-09-07T10:42:15-07:00',
    expirationDate: '2022-12-06T10:42:15-08:00',
    expired: false,
    minOsVersion: '15.5',
    processingState: 'VALID',
    buildAudienceType: 'APP_STORE_ELIGIBLE',
    usesNonExemptEncryption: false,
    ...attributes,
  },
  relationships: {
    preReleaseVersion: {
      links: { related: `${APPLE_BASE}/v1/builds/${id}/preReleaseVersion` },
      ...(preId ? { data: { type: 'preReleaseVersions', id: preId } } : {}),
    },
  },
  links: { self: `${APPLE_BASE}/v1/builds/${id}` },
});

export const appleBuilds = {
  data: [
    build('b-valid', 'pre-21', { version: '210' }),
    build('b-processing', 'pre-21', { version: '211', processingState: 'PROCESSING', uploadedDate: '2022-09-08T10:00:00-07:00' }),
    build('b-failed', 'pre-20', { version: '200', processingState: 'FAILED', expired: true }),
    build('b-invalid', 'pre-20', { version: '201', processingState: 'INVALID' }),
    build('b-future', 'pre-20', { version: '202', processingState: 'SOMETHING_NEW' }),
    build('b-mac', 'pre-mac', { version: '5' }),
    build('b-nopre', null, { version: '7' }),
  ],
  included: [
    { type: 'preReleaseVersions', id: 'pre-21', attributes: { version: '2.1', platform: 'IOS' } },
    { type: 'preReleaseVersions', id: 'pre-20', attributes: { version: '2.0', platform: 'IOS' } },
    { type: 'preReleaseVersions', id: 'pre-mac', attributes: { version: '9.0', platform: 'MAC_OS' } },
  ],
  links: { self: `${APPLE_BASE}/v1/builds?filter[app]=10746822401` },
  meta: { paging: { total: 7, limit: 50 } },
};

/**
 * What `GET /v1/apps/{id}/builds?limit=...` answers: the same builds, but `preReleaseVersion` is a
 * link only (as on Apple's example for that endpoint), so the marketing version is not in the answer.
 */
export const appleBuildsMinimal = {
  data: appleBuilds.data.map((b) => ({
    ...b,
    relationships: { preReleaseVersion: { links: b.relationships.preReleaseVersion.links } },
  })),
  links: { self: `${APPLE_BASE}/v1/apps/10746822401/builds` },
  meta: { paging: { total: 7, limit: 50 } },
};

const preReleaseVersion = (id: string, versionString: string, platform: string, buildIds: string[]) => ({
  type: 'preReleaseVersions',
  id,
  attributes: { version: versionString, platform },
  relationships: {
    builds: { data: buildIds.map((buildId) => ({ type: 'builds', id: buildId })) },
  },
  links: { self: `${APPLE_BASE}/v1/preReleaseVersions/${id}` },
});

/** `GET /v1/preReleaseVersions?filter[app]=...&include=builds`: versions with the ids of their builds. */
export const applePreReleaseVersions = {
  data: [
    preReleaseVersion('pre-21', '2.1', 'IOS', ['b-valid', 'b-processing']),
    preReleaseVersion('pre-20', '2.0', 'IOS', ['b-failed', 'b-invalid', 'b-future']),
    preReleaseVersion('pre-mac', '9.0', 'MAC_OS', ['b-mac']),
  ],
  included: [{ type: 'builds', id: 'b-valid', attributes: { version: '210' } }],
  links: { self: `${APPLE_BASE}/v1/preReleaseVersions?filter[app]=10746822401` },
  meta: { paging: { total: 3, limit: 50 } },
};

const appleError = (status: string, code: string, title: string, detail: string) => ({
  errors: [{ id: 'f6c8e7a0-0000-4000-8000-000000000000', status, code, title, detail }],
});

// From memory (wording seen in the wild; Apple's page lists the codes, not these strings).
export const apple401 = appleError(
  '401',
  'NOT_AUTHORIZED',
  'Authentication credentials are missing or invalid.',
  'Provide a properly configured and signed bearer token, and make sure that it has not expired.',
);
export const apple403 = appleError(
  '403',
  'FORBIDDEN_ERROR',
  'This request is forbidden for security reasons',
  'The API key in use does not allow this request',
);
export const apple404 = appleError('404', 'NOT_FOUND', 'The specified resource does not exist', 'There is no resource of type apps with id 1');
export const apple429 = appleError('429', 'RATE_LIMIT_EXCEEDED', 'Rate limit exceeded', 'Too many requests.');

/**
 * A 400 that names the rejected query parameter. The structure (`errors[].code`, `title`, `detail`,
 * `source.parameter`) is Apple's `ErrorResponse`; the code and title are the ones in the
 * maintainer's real failure (`PARAMETER_ERROR.ILLEGAL`, "A given parameter is not allowed for this
 * request"). The `detail` wording is reconstructed, not recorded.
 */
export const appleParameterError = (parameter: string) => ({
  errors: [
    {
      id: 'a1b2c3d4-0000-4000-8000-000000000001',
      status: '400',
      code: 'PARAMETER_ERROR.ILLEGAL',
      title: 'A given parameter is not allowed for this request',
      detail: `The parameter '${parameter}' can not be used with this request`,
      source: { parameter },
    },
  ],
});
export const apple400Sort = appleParameterError('sort');
/** A 400 that is not about a parameter (a body or state problem): never retried. */
export const apple400Entity = appleError('400', 'ENTITY_ERROR.ATTRIBUTE.INVALID', 'An attribute value is invalid', 'The value is not allowed.');

// ---------------------------------------------------------------------------------------------
// Google

export const ACCESS_TOKEN = 'ya29.a0AfH6SMBfake-access-token-1234567890abcdef';

export const googleToken = { access_token: ACCESS_TOKEN, expires_in: 3599, token_type: 'Bearer' };

export const googleEdit = { id: '17744839219283', expiryTimeSeconds: '1735689600' };

export const googleDetails = { defaultLanguage: 'en-US', contactEmail: 'support@example.org' };

export const googleListings = {
  kind: 'androidpublisher#listingsListResponse',
  listings: [
    { language: 'de-DE', title: 'Kaffee', shortDescription: 'k', fullDescription: 'kk' },
    { language: 'en-US', title: 'Coffee', shortDescription: 's', fullDescription: 'ss' },
  ],
};

export const googleTracks = {
  kind: 'androidpublisher#tracksListResponse',
  tracks: [
    { track: 'internal', releases: [{ name: '2.1.0 (211)', versionCodes: ['211'], status: 'completed' }] },
    { track: 'beta', releases: [{ name: '2.1.0 (211)', versionCodes: ['211'], status: 'draft' }] },
    {
      track: 'production',
      releases: [
        { name: '2.1.0', versionCodes: ['211'], status: 'inProgress', userFraction: 0.2 },
        { name: '2.0.0', versionCodes: ['200', '201'], status: 'completed' },
      ],
    },
    { track: 'alpha', releases: [{ name: 'halted one', versionCodes: ['150'], status: 'halted', userFraction: 0.5 }] },
    { track: 'wear:production', releases: [] },
    { track: 'qa', releases: [{ versionCodes: ['9'], status: 'statusUnspecified' }] },
  ],
};

export const googleBundles = {
  kind: 'androidpublisher#bundlesListResponse',
  bundles: [
    { versionCode: 200, sha1: 'a'.repeat(40), sha256: 'b'.repeat(64) },
    { versionCode: 211, sha1: 'c'.repeat(40), sha256: 'd'.repeat(64) },
  ],
};

export const googleApks = {
  kind: 'androidpublisher#apksListResponse',
  apks: [{ versionCode: 150, binary: { sha1: 'e'.repeat(40), sha256: 'f'.repeat(64) } }],
};

const googleErr = (code: number, status: string, message: string, reason: string) => ({
  error: { code, message, status, errors: [{ message, domain: 'global', reason }] },
});

// From memory: wording and reasons seen in the wild, see the spike doc.
export const google403Disabled = {
  error: {
    code: 403,
    message:
      'Google Play Android Developer API has not been used in project 400719706081 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/androidpublisher.googleapis.com/overview?project=400719706081 then retry.',
    status: 'PERMISSION_DENIED',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', domain: 'googleapis.com' }],
  },
};
export const google403Forbidden = googleErr(403, 'PERMISSION_DENIED', 'The caller does not have permission', 'forbidden');
export const google403NotLinked = googleErr(
  403,
  'PERMISSION_DENIED',
  'The project id used to call the Google Play Developer API has not been linked in the Google Play Developer Console.',
  'projectNotLinked',
);
export const google404Package = googleErr(404, 'NOT_FOUND', 'Package not found: com.example.coffee.', 'notFound');
export const google404Edit = googleErr(404, 'NOT_FOUND', 'Edit not found.', 'editNotFound');
export const google401 = googleErr(401, 'UNAUTHENTICATED', 'Invalid Credentials', 'authError');
export const google429Quota = googleErr(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded.', 'rateLimitExceeded');

export const googleTokenErrors = {
  clock: { error: 'invalid_grant', error_description: 'Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe. Check your iat and exp values in the JWT claim.' },
  signature: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' },
  email: { error: 'invalid_grant', error_description: 'Invalid email or User ID' },
  generic: { error: 'invalid_grant', error_description: 'Something else.' },
  scope: { error: 'invalid_scope', error_description: 'Bad scope.' },
};

// ---------------------------------------------------------------------------------------------
// A fake `fetch`

export type Call = {
  method: string;
  url: URL;
  headers: Headers;
  body: string | undefined;
};

export type Route = {
  method: string;
  /** Matched against `url.pathname + url.search` by equality, or by regex. */
  match: string | RegExp;
  status?: number;
  json?: unknown;
  /** A raw body, for malformed JSON. */
  raw?: string;
  headers?: Record<string, string>;
  /** Answer this many requests, then fall through to the next matching route. */
  times?: number;
  /** Throw this instead of answering (network failure). */
  throws?: Error;
};

export class FakeFetch {
  readonly calls: Call[] = [];
  readonly unexpected: string[] = [];
  readonly #routes: (Route & { used: number })[] = [];

  on(route: Route): this {
    this.#routes.push({ ...route, used: 0 });
    return this;
  }

  /** Removes the routes for a method and match, so a test can override a default. */
  clear(method: string, match: string | RegExp): this {
    for (let i = this.#routes.length - 1; i >= 0; i--) {
      const r = this.#routes[i];
      if (r && r.method === method && String(r.match) === String(match)) this.#routes.splice(i, 1);
    }
    return this;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    this.calls.push({
      method,
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const key = url.pathname + url.search;
    const route = this.#routes.find(
      (r) =>
        r.method === method &&
        (typeof r.match === 'string' ? r.match === key : r.match.test(key)) &&
        (r.times === undefined || r.used < r.times),
    );
    if (!route) {
      this.unexpected.push(`${method} ${url.host}${key}`);
      return new Response('{"error":"no route"}', { status: 599 });
    }
    route.used++;
    if (route.throws) throw route.throws;
    const body = route.raw ?? (route.json === undefined ? '' : JSON.stringify(route.json));
    return new Response(body, {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json', ...route.headers },
    });
  };

  called(method: string, match: string | RegExp): Call[] {
    return this.calls.filter(
      (c) =>
        c.method === method &&
        (typeof match === 'string' ? c.url.pathname + c.url.search === match : match.test(c.url.pathname + c.url.search)),
    );
  }
}

/** Decodes a JWT into its parts, without checking anything. */
export function decodeJwt(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
} {
  const [h, p, s] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(h ?? '', 'base64url').toString()),
    payload: JSON.parse(Buffer.from(p ?? '', 'base64url').toString()),
    signingInput: `${h}.${p}`,
    signature: Buffer.from(s ?? '', 'base64url'),
  };
}
