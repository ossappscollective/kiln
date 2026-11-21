import { createHash } from 'node:crypto';
import * as fx from './store.fixtures.ts';

/**
 * Stateful fakes of the two stores for the draft writers' tests: they remember what was written,
 * so a test can look at the result and at the exact order of the requests. Not a real store: the
 * shapes follow the docs the writers cite (and so are as UNVERIFIED as those).
 */

export type Seen = {
  method: string;
  host: string;
  path: string;
  query: string;
  body: unknown;
  bytes?: Uint8Array;
  headers: Headers;
};

const json = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('hex');
export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
export const md5Of = md5;

export type Hook = (seen: Seen) => Response | Error | undefined;

// ---------------------------------------------------------------------------------------------
// App Store Connect

type AppleImage = {
  id: string;
  fileName: string;
  fileSize: number;
  referenceName: string | null;
  state: string;
  polls: number;
  bytes: Uint8Array[];
  specId: string | null;
  category: string;
  /** Pixel size of a processed image (its `imageAsset`). */
  size?: { width: number; height: number };
};
type ApplePlacement = { id: string; locId: string; group: string; imageId: string };

const refName = (bytes: Uint8Array) => `kiln:sha256:${sha256(bytes).slice(0, 32)}`;
const legacyRefName = (bytes: Uint8Array) => `mrm:sha256:${sha256(bytes).slice(0, 32)}`;

export class FakeAppleDraftApi {
  readonly seen: Seen[] = [];
  versions: {
    id: string;
    versionString: string;
    state: string;
    platform?: string;
    releaseType?: string;
    earliestReleaseDate?: string;
    copyright?: string;
    createdDate?: string;
  }[] = [
    { id: 'v-live', versionString: '2.0', state: 'READY_FOR_DISTRIBUTION' },
    { id: 'v-next', versionString: '2.1', state: 'PREPARE_FOR_SUBMISSION' },
  ];
  /** localization id -> locale and attributes. */
  locs = new Map<
    string,
    { versionId: string; locale: string; attributes: Record<string, unknown> }
  >();
  images = new Map<string, AppleImage>();
  placements = new Map<string, ApplePlacement>();
  /** `locId\u0000group` -> placement ids in display order. */
  order = new Map<string, string[]>();
  library = '10746822401';
  /** version id -> the build attached to it (App Store Connect API: `GET /v1/appStoreVersions/{id}/build`). */
  builds = new Map<
    string,
    { id: string; version: string; processingState: string; expired: boolean }
  >([['v-next', { id: 'b-1', version: '57', processingState: 'VALID', expired: false }]]);
  /** `GET /v1/builds`: every build of the app (a test sets more). */
  buildList: {
    id: string;
    version: string;
    processingState: string;
    expired: boolean;
    uploadedDate: string;
    marketing: string;
    platform?: string;
    usesNonExemptEncryption?: boolean | null;
  }[] = [
    {
      id: 'b-1',
      version: '57',
      processingState: 'VALID',
      expired: false,
      uploadedDate: '2026-11-17T09:00:00-08:00',
      marketing: '2.1',
    },
    {
      id: 'b-2',
      version: '58',
      processingState: 'VALID',
      expired: false,
      uploadedDate: '2026-11-18T09:00:00-08:00',
      marketing: '2.1',
    },
    {
      id: 'b-3',
      version: '59',
      processingState: 'PROCESSING',
      expired: false,
      uploadedDate: '2026-11-18T12:00:00-08:00',
      marketing: '2.1',
    },
    {
      id: 'b-old',
      version: '40',
      processingState: 'VALID',
      expired: true,
      uploadedDate: '2026-08-01T09:00:00-07:00',
      marketing: '2.0',
    },
    {
      id: 'b-mac',
      version: '9',
      processingState: 'VALID',
      expired: false,
      uploadedDate: '2026-11-18T10:00:00-08:00',
      marketing: '2.1',
      platform: 'MAC_OS',
    },
  ];
  /** build id -> the TestFlight notes ("What to Test") per locale: `GET /v1/builds/{id}/betaBuildLocalizations`. */
  testNotes = new Map<string, { locale: string; whatsNew: string }[]>();
  /** build id -> an HTTP status that its notes answer instead. */
  testNotesFail = new Map<string, number>();
  /** True: the fake answers a 400 PARAMETER_ERROR when `fields[builds]` names `usesNonExemptEncryption`. */
  rejectComplianceField = false;
  /** version id -> its phased release. */
  phased = new Map<string, { id: string; state: string }>();
  /** The release requests made: version ids. */
  releaseRequests: string[] = [];
  /** Review submissions: id -> state and the versions added to it. */
  submissions = new Map<string, { state: string; versions: string[] }>();
  /** The reference data: the placement groups of the fake store. */
  refData = defaultRefData();
  /** The specification the fake matches a processed file to, by file name (default: `defaultSpec`). */
  specByFile = new Map<string, string>();
  defaultSpec = 'spec-65';
  /** Polls that answer UPLOAD_COMPLETE before PREPARE_FOR_SUBMISSION. */
  pollsBeforeComplete = 1;
  /** Files whose processing ends FAILED (by file name). */
  failProcessing = new Set<string>();
  hook: Hook | undefined;
  #n = 0;
  readonly #id = (prefix: string) => `${prefix}-${++this.#n}`;

  constructor() {
    this.locs.set('loc-en', {
      versionId: 'v-next',
      locale: 'en-US',
      attributes: {
        locale: 'en-US',
        description: 'Old description',
        keywords: 'old',
        whatsNew: 'Old news',
      },
    });
  }

  /** Puts files into a placement group of a localization (a test's starting point). `reference: false`: an image someone else uploaded; `'legacy'`: uploaded by a version before the rename to Kiln (old reference prefix). */
  addPlacements(
    locId: string,
    group: string,
    files: {
      name: string;
      bytes: Uint8Array;
      state?: string;
      reference?: boolean | 'legacy';
      size?: { width: number; height: number };
    }[],
  ): string[] {
    const ids: string[] = [];
    for (const f of files) {
      const imageId = this.#id('img');
      this.images.set(imageId, {
        id: imageId,
        fileName: f.name,
        fileSize: f.bytes.length,
        referenceName:
          f.reference === false
            ? 'Somebody else'
            : f.reference === 'legacy'
              ? legacyRefName(f.bytes)
              : refName(f.bytes),
        state: f.state ?? 'PREPARE_FOR_SUBMISSION',
        polls: 0,
        bytes: [f.bytes],
        specId: this.defaultSpec,
        category: 'APP_SCREENSHOTS_AND_PREVIEWS',
        ...(f.size ? { size: f.size } : {}),
      });
      const id = this.#id('pl');
      this.placements.set(id, { id, locId, group, imageId });
      const key = `${locId}\u0000${group}`;
      this.order.set(key, [...(this.order.get(key) ?? []), id]);
      ids.push(id);
    }
    return ids;
  }

  /** The files of a group in display order, by file name. */
  groupFiles(locId: string, group: string): string[] {
    return (this.order.get(`${locId}\u0000${group}`) ?? []).map(
      (id) => this.images.get(this.placements.get(id)?.imageId ?? '')?.fileName ?? '?',
    );
  }

  /** The requests that changed something, as `METHOD path`. */
  writes(): string[] {
    return this.seen
      .filter((s) => s.method !== 'GET')
      .map(
        (s) =>
          `${s.method} ${s.host === 'api.appstoreconnect.apple.com' ? s.path : `${s.host}${s.path}`}`,
      );
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const raw = init?.body;
    const bytes = raw instanceof Uint8Array ? raw : undefined;
    const body = typeof raw === 'string' ? JSON.parse(raw) : undefined;
    const seen: Seen = {
      method,
      host: url.host,
      path: url.pathname,
      query: url.search,
      body,
      ...(bytes ? { bytes } : {}),
      headers: new Headers(init?.headers),
    };
    this.seen.push(seen);
    const hooked = this.hook?.(seen);
    if (hooked instanceof Error) throw hooked;
    if (hooked) return hooked;
    return this.#route(seen, url);
  };

  #imageView(i: AppleImage) {
    return {
      type: 'appAssetLibraryImages',
      id: i.id,
      attributes: {
        fileName: i.fileName,
        fileSize: i.fileSize,
        referenceName: i.referenceName,
        state: i.state,
        stateDetails: i.state === 'FAILED' ? { description: 'The image is not acceptable.' } : null,
        specId: i.specId,
        category: i.category,
        ...(i.size
          ? {
              imageAsset: {
                templateUrl: `https://is1.mzstatic.com/image/thumb/${i.id}/{w}x{h}bb.{f}`,
                width: i.size.width,
                height: i.size.height,
              },
            }
          : {}),
      },
    };
  }

  #route(s: Seen, url: URL): Response {
    const { method, path } = s;
    if (s.host !== 'api.appstoreconnect.apple.com') {
      // The pre-signed upload server: no JWT is ever sent there.
      const id = path.split('/').pop() ?? '';
      const image = this.images.get(id);
      if (method === 'PUT' && image) {
        image.bytes.push(s.bytes ?? new Uint8Array());
        return json(200);
      }
      return json(404);
    }
    const notFound = () =>
      json(404, { errors: [{ status: '404', code: 'NOT_FOUND', title: 'Not found' }] });
    let m: RegExpMatchArray | null;
    if (method === 'GET' && /^\/v1\/apps\/\d+\/appStoreVersions$/.test(path)) {
      return json(200, {
        data: this.versions.map((v) => ({
          type: 'appStoreVersions',
          id: v.id,
          attributes: {
            platform: v.platform ?? 'IOS',
            versionString: v.versionString,
            appVersionState: v.state,
            ...(v.createdDate ? { createdDate: v.createdDate } : {}),
            ...(v.releaseType ? { releaseType: v.releaseType } : {}),
            ...(v.earliestReleaseDate ? { earliestReleaseDate: v.earliestReleaseDate } : {}),
            ...(v.copyright ? { copyright: v.copyright } : {}),
          },
        })),
        links: {},
      });
    }
    // ----- release fields of a version, builds, phased release, release requests
    if (method === 'PATCH' && (m = path.match(/^\/v1\/appStoreVersions\/([^/]+)$/))) {
      const version = this.versions.find((v) => v.id === m?.[1]);
      if (!version) return notFound();
      if (version.state !== 'PREPARE_FOR_SUBMISSION')
        return json(409, {
          errors: [
            {
              status: '409',
              code: 'STATE_ERROR.INVALID_STATE',
              title: 'The version cannot be changed in this state',
            },
          ],
        });
      const data = (
        s.body as {
          data: {
            attributes?: Record<string, string>;
            relationships?: { build?: { data: { id: string } } };
          };
        }
      ).data;
      for (const [k, v] of Object.entries(data.attributes ?? {})) {
        if (k === 'releaseType' && !['MANUAL', 'AFTER_APPROVAL', 'SCHEDULED'].includes(v))
          return json(409, {
            errors: [
              {
                status: '409',
                code: 'ENTITY_ERROR.ATTRIBUTE.INVALID.ENUM',
                title: 'Invalid release type',
              },
            ],
          });
        if (k === 'versionString') version.versionString = v;
        else if (k === 'releaseType') version.releaseType = v;
        else if (k === 'earliestReleaseDate') version.earliestReleaseDate = v;
        else if (k === 'copyright') version.copyright = v;
        else
          return json(409, {
            errors: [
              {
                status: '409',
                code: 'ENTITY_ERROR.ATTRIBUTE.UNKNOWN',
                title: `Unknown attribute ${k}`,
              },
            ],
          });
      }
      const wanted = data.relationships?.build?.data.id;
      if (wanted !== undefined) {
        const b = this.buildList.find((x) => x.id === wanted);
        if (!b)
          return json(409, {
            errors: [
              { status: '409', code: 'ENTITY_ERROR.RELATIONSHIP.INVALID', title: 'Unknown build' },
            ],
          });
        if (b.processingState !== 'VALID' || b.expired)
          return json(409, {
            errors: [{ status: '409', code: 'STATE_ERROR', title: 'The build cannot be used' }],
          });
        this.builds.set(version.id, {
          id: b.id,
          version: b.version,
          processingState: b.processingState,
          expired: b.expired,
        });
      }
      return json(200, {
        data: {
          type: 'appStoreVersions',
          id: version.id,
          attributes: { versionString: version.versionString },
        },
      });
    }
    if (method === 'GET' && path === '/v1/builds') {
      const fieldsOfBuilds = url.searchParams.get('fields[builds]') ?? '';
      if (this.rejectComplianceField && fieldsOfBuilds.includes('usesNonExemptEncryption')) {
        return json(400, {
          errors: [
            {
              status: '400',
              code: 'PARAMETER_ERROR.INVALID',
              title: 'A parameter has an invalid value',
              detail: 'usesNonExemptEncryption is not a valid field name',
              source: { parameter: 'fields[builds]' },
            },
          ],
        });
      }
      const want = url.searchParams.get('filter[preReleaseVersion.version]');
      const platform = url.searchParams.get('filter[preReleaseVersion.platform]');
      const list = this.buildList.filter(
        (b) =>
          (want === null || b.marketing === want) &&
          (platform === null || (b.platform ?? 'IOS') === platform),
      );
      return json(200, {
        data: list.map((b) => ({
          type: 'builds',
          id: b.id,
          attributes: {
            version: b.version,
            uploadedDate: b.uploadedDate,
            processingState: b.processingState,
            expired: b.expired,
            ...('usesNonExemptEncryption' in b && fieldsOfBuilds.includes('usesNonExemptEncryption')
              ? { usesNonExemptEncryption: b.usesNonExemptEncryption }
              : {}),
          },
          relationships: {
            preReleaseVersion: {
              data: { type: 'preReleaseVersions', id: `pre-${b.marketing}-${b.platform ?? 'IOS'}` },
            },
          },
        })),
        included: list.map((b) => ({
          type: 'preReleaseVersions',
          id: `pre-${b.marketing}-${b.platform ?? 'IOS'}`,
          attributes: { version: b.marketing, platform: b.platform ?? 'IOS' },
        })),
        links: {},
      });
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/builds\/([^/]+)\/betaBuildLocalizations$/))) {
      const failing = this.testNotesFail.get(m[1] ?? '');
      if (failing !== undefined)
        return json(failing, {
          errors: [
            {
              status: String(failing),
              code: failing === 403 ? 'FORBIDDEN_ERROR' : 'UNEXPECTED_ERROR',
              title: 'No',
            },
          ],
        });
      return json(200, {
        data: (this.testNotes.get(m[1] ?? '') ?? []).map((n, i) => ({
          type: 'betaBuildLocalizations',
          id: `bbl-${m?.[1]}-${i}`,
          attributes: { locale: n.locale, whatsNew: n.whatsNew },
        })),
        links: {},
      });
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/builds\/([^/]+)$/))) {
      const b = this.buildList.find((x) => x.id === m?.[1]);
      return b
        ? json(200, {
            data: {
              type: 'builds',
              id: b.id,
              attributes: {
                version: b.version,
                uploadedDate: b.uploadedDate,
                processingState: b.processingState,
                expired: b.expired,
              },
            },
          })
        : notFound();
    }
    if (
      method === 'GET' &&
      (m = path.match(/^\/v1\/appStoreVersions\/([^/]+)\/appStoreVersionPhasedRelease$/))
    ) {
      const p = this.phased.get(m[1] ?? '');
      return p
        ? json(200, {
            data: {
              type: 'appStoreVersionPhasedReleases',
              id: p.id,
              attributes: { phasedReleaseState: p.state },
            },
          })
        : notFound();
    }
    if (method === 'POST' && path === '/v1/appStoreVersionPhasedReleases') {
      const data = (
        s.body as {
          data: {
            attributes?: { phasedReleaseState?: string };
            relationships: { appStoreVersion: { data: { id: string } } };
          };
        }
      ).data;
      const versionId = data.relationships.appStoreVersion.data.id;
      if (this.phased.has(versionId))
        return json(409, {
          errors: [
            {
              status: '409',
              code: 'ENTITY_ERROR.RELATIONSHIP.INVALID',
              title: 'The version already has a phased release',
            },
          ],
        });
      const id = this.#id('phased');
      this.phased.set(versionId, { id, state: data.attributes?.phasedReleaseState ?? 'INACTIVE' });
      return json(201, {
        data: {
          type: 'appStoreVersionPhasedReleases',
          id,
          attributes: { phasedReleaseState: 'INACTIVE' },
        },
      });
    }
    if (method === 'DELETE' && (m = path.match(/^\/v1\/appStoreVersionPhasedReleases\/([^/]+)$/))) {
      const entry = [...this.phased].find(([, p]) => p.id === m?.[1]);
      if (!entry) return notFound();
      this.phased.delete(entry[0]);
      return json(204);
    }
    if (method === 'POST' && path === '/v1/appStoreVersionReleaseRequests') {
      const versionId = (
        s.body as { data: { relationships: { appStoreVersion: { data: { id: string } } } } }
      ).data.relationships.appStoreVersion.data.id;
      const version = this.versions.find((v) => v.id === versionId);
      if (!version)
        return json(409, {
          errors: [
            { status: '409', code: 'ENTITY_ERROR.RELATIONSHIP.INVALID', title: 'Unknown version' },
          ],
        });
      if (version.state !== 'PENDING_DEVELOPER_RELEASE')
        return json(409, {
          errors: [
            {
              status: '409',
              code: 'STATE_ERROR.INVALID_STATE',
              title: 'The version is not waiting for release',
            },
          ],
        });
      version.state = 'PROCESSING_FOR_APP_STORE';
      this.releaseRequests.push(versionId);
      return json(201, { data: { type: 'appStoreVersionReleaseRequests', id: this.#id('rel') } });
    }
    if (
      method === 'GET' &&
      (m = path.match(/^\/v1\/appStoreVersions\/([^/]+)\/appStoreVersionLocalizations$/))
    ) {
      return json(200, {
        data: [...this.locs]
          .filter(([, l]) => l.versionId === m?.[1])
          .map(([id, l]) => ({
            type: 'appStoreVersionLocalizations',
            id,
            attributes: l.attributes,
          })),
        links: {},
      });
    }
    if (method === 'PATCH' && (m = path.match(/^\/v1\/appStoreVersionLocalizations\/([^/]+)$/))) {
      const loc = this.locs.get(m[1] ?? '');
      if (!loc) return notFound();
      Object.assign(
        loc.attributes,
        (s.body as { data: { attributes: Record<string, unknown> } }).data.attributes,
      );
      return json(200, {
        data: { type: 'appStoreVersionLocalizations', id: m[1], attributes: loc.attributes },
      });
    }
    if (method === 'POST' && path === '/v1/appStoreVersionLocalizations') {
      const data = (
        s.body as {
          data: {
            attributes: Record<string, unknown>;
            relationships: { appStoreVersion: { data: { id: string } } };
          };
        }
      ).data;
      const id = this.#id('loc');
      this.locs.set(id, {
        versionId: data.relationships.appStoreVersion.data.id,
        locale: String(data.attributes.locale),
        attributes: data.attributes,
      });
      return json(201, {
        data: { type: 'appStoreVersionLocalizations', id, attributes: data.attributes },
      });
    }
    // ----- review submissions
    if (method === 'GET' && (m = path.match(/^\/v1\/appStoreVersions\/([^/]+)\/build$/))) {
      const b = this.builds.get(m[1] ?? '');
      return json(200, {
        data: b
          ? {
              type: 'builds',
              id: b.id,
              attributes: {
                version: b.version,
                processingState: b.processingState,
                expired: b.expired,
              },
            }
          : null,
      });
    }
    if (method === 'GET' && /^\/v1\/apps\/\d+\/reviewSubmissions$/.test(path)) {
      const want = url.searchParams.get('filter[state]');
      return json(200, {
        data: [...this.submissions]
          .filter(([, x]) => want === null || x.state === want)
          .map(([id, x]) => ({ type: 'reviewSubmissions', id, attributes: { state: x.state } })),
      });
    }
    if (method === 'POST' && path === '/v1/reviewSubmissions') {
      const id = this.#id('sub');
      this.submissions.set(id, { state: 'READY_FOR_REVIEW', versions: [] });
      return json(201, {
        data: { type: 'reviewSubmissions', id, attributes: { state: 'READY_FOR_REVIEW' } },
      });
    }
    if (method === 'POST' && path === '/v1/reviewSubmissionItems') {
      const rel = (
        s.body as {
          data: {
            relationships: {
              reviewSubmission: { data: { id: string } };
              appStoreVersion: { data: { id: string } };
            };
          };
        }
      ).data.relationships;
      const sub = this.submissions.get(rel.reviewSubmission.data.id);
      if (!sub)
        return json(409, {
          errors: [
            {
              status: '409',
              code: 'ENTITY_ERROR.RELATIONSHIP.INVALID',
              title: 'Unknown submission',
            },
          ],
        });
      sub.versions.push(rel.appStoreVersion.data.id);
      return json(201, { data: { type: 'reviewSubmissionItems', id: this.#id('item') } });
    }
    if (method === 'PATCH' && (m = path.match(/^\/v1\/reviewSubmissions\/([^/]+)$/))) {
      const sub = this.submissions.get(m[1] ?? '');
      if (!sub) return notFound();
      const attrs = (s.body as { data: { attributes: { submitted?: boolean } } }).data.attributes;
      if (attrs.submitted) {
        if (sub.versions.length === 0)
          return json(409, {
            errors: [{ status: '409', code: 'STATE_ERROR', title: 'The submission has no items' }],
          });
        sub.state = 'WAITING_FOR_REVIEW';
        for (const v of this.versions)
          if (sub.versions.includes(v.id)) v.state = 'WAITING_FOR_REVIEW';
      }
      return json(200, {
        data: { type: 'reviewSubmissions', id: m[1], attributes: { state: sub.state } },
      });
    }
    // ----- the asset library
    if (method === 'GET' && /^\/v1\/apps\/\d+\/assetLibrary$/.test(path)) {
      return json(200, { data: { type: 'appAssetLibraries', id: this.library } });
    }
    if (method === 'GET' && path === '/v1/appAssetLibraryRefData') {
      return json(200, {
        data: [{ type: 'appAssetLibraryRefData', id: '1', attributes: this.refData }],
      });
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/appAssetLibraries\/([^/]+)\/images$/))) {
      const wanted = url.searchParams.get('filter[referenceName]');
      const data = [...this.images.values()]
        .filter((i) => wanted === null || i.referenceName === wanted)
        .map((i) => this.#imageView(i));
      return json(200, { data, links: {} });
    }
    if (method === 'POST' && path === '/v1/appAssetLibraryImages') {
      const data = (
        s.body as {
          data: {
            attributes: {
              fileName: string;
              fileSize: number;
              category: string;
              referenceName?: string;
            };
            relationships: { assetLibrary: { data: { id: string } } };
          };
        }
      ).data;
      if (data.relationships.assetLibrary.data.id !== this.library)
        return json(409, {
          errors: [
            { status: '409', code: 'ENTITY_ERROR.RELATIONSHIP.INVALID', title: 'Wrong library' },
          ],
        });
      const id = this.#id('img');
      this.images.set(id, {
        id,
        fileName: data.attributes.fileName,
        fileSize: data.attributes.fileSize,
        referenceName: data.attributes.referenceName ?? null,
        state: 'AWAITING_UPLOAD',
        polls: 0,
        bytes: [],
        specId: null,
        category: data.attributes.category,
      });
      const half = Math.floor(data.attributes.fileSize / 2);
      return json(201, {
        data: {
          ...this.#imageView(this.images.get(id) as AppleImage),
          attributes: {
            ...this.#imageView(this.images.get(id) as AppleImage).attributes,
            // Two parts, to prove that offset and length are honoured.
            uploadOperations: [
              {
                method: 'PUT',
                url: `https://store-030.blobstore.apple.com/up/${id}`,
                offset: 0,
                length: half,
                requestHeaders: [
                  { name: 'Content-Type', value: 'image/png' },
                  { name: 'X-Apple-Part', value: '1' },
                ],
              },
              {
                method: 'PUT',
                url: `https://store-030.blobstore.apple.com/up/${id}`,
                offset: half,
                length: data.attributes.fileSize - half,
                requestHeaders: [
                  { name: 'Content-Type', value: 'image/png' },
                  { name: 'X-Apple-Part', value: '2' },
                ],
              },
            ],
          },
        },
      });
    }
    if (method === 'PATCH' && (m = path.match(/^\/v1\/appAssetLibraryImages\/([^/]+)$/))) {
      const image = this.images.get(m[1] ?? '');
      if (!image) return notFound();
      const attrs = (s.body as { data: { attributes: Record<string, unknown> } }).data.attributes;
      if (attrs.uploaded) {
        // Asset library commits take `uploaded` alone: no checksum.
        if (Object.keys(attrs).some((k) => k !== 'uploaded'))
          return json(409, {
            errors: [
              {
                status: '409',
                code: 'ENTITY_ERROR.ATTRIBUTE.UNKNOWN',
                title: 'Unexpected attribute',
              },
            ],
          });
        if (Buffer.concat(image.bytes).length !== image.fileSize)
          return json(409, {
            errors: [{ status: '409', code: 'ENTITY_STATE_INVALID', title: 'size mismatch' }],
          });
        image.state = 'UPLOAD_COMPLETE';
      }
      return json(200, { data: this.#imageView(image) });
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/appAssetLibraryImages\/([^/]+)$/))) {
      const image = this.images.get(m[1] ?? '');
      if (!image) return notFound();
      if (image.state === 'UPLOAD_COMPLETE') {
        image.polls++;
        if (image.polls > this.pollsBeforeComplete) {
          image.state = this.failProcessing.has(image.fileName)
            ? 'FAILED'
            : 'PREPARE_FOR_SUBMISSION';
          image.specId =
            image.state === 'FAILED'
              ? null
              : (this.specByFile.get(image.fileName) ?? this.defaultSpec);
        }
      }
      return json(200, { data: this.#imageView(image) });
    }
    if (method === 'DELETE' && (m = path.match(/^\/v1\/appAssetLibraryImages\/([^/]+)$/))) {
      const image = this.images.get(m[1] ?? '');
      if (!image) return notFound();
      if ([...this.placements.values()].some((p) => p.imageId === image.id)) {
        return json(409, {
          errors: [
            {
              status: '409',
              code: 'STATE_ERROR.ASSET_HAS_PLACEMENTS',
              title: 'x',
              detail:
                'The asset cannot be deleted while placements still use it. Delete those placements first.',
            },
          ],
        });
      }
      this.images.delete(image.id);
      return json(204);
    }
    if (
      method === 'GET' &&
      (m = path.match(/^\/v1\/appStoreVersionLocalizations\/([^/]+)\/placements$/))
    ) {
      const locId = m[1] ?? '';
      const type = url.searchParams.get('filter[placementType]');
      if (type !== null && type !== 'APP_SCREENSHOT') return json(200, { data: [] });
      const mine: ApplePlacement[] = [];
      for (const [key, ids] of this.order) {
        if (key.startsWith(`${locId}\u0000`))
          for (const id of ids) mine.push(this.placements.get(id) as ApplePlacement);
      }
      return json(200, {
        data: mine.map((p) => ({
          type: 'appAssetLibraryPlacements',
          id: p.id,
          attributes: {
            mediaType: 'IMAGE',
            placementType: 'APP_SCREENSHOT',
            placementGroup: p.group,
            state: 'PARENT_PREPARE_FOR_SUBMISSION',
          },
          relationships: { image: { data: { type: 'appAssetLibraryImages', id: p.imageId } } },
        })),
        included:
          url.searchParams.get('include') === 'image'
            ? mine.map((p) => this.#imageView(this.images.get(p.imageId) as AppleImage))
            : [],
        links: {},
      });
    }
    if (method === 'POST' && path === '/v1/appAssetLibraryPlacements') {
      const data = (
        s.body as {
          data: {
            attributes: { placementType: string; placementGroup: string };
            relationships: {
              image: { data: { id: string } };
              appStoreVersionLocalization: { data: { id: string } };
            };
          };
        }
      ).data;
      const loc = this.locs.get(data.relationships.appStoreVersionLocalization.data.id);
      const image = this.images.get(data.relationships.image.data.id);
      if (!loc || !image)
        return json(409, {
          errors: [
            { status: '409', code: 'ENTITY_ERROR.RELATIONSHIP.INVALID', title: 'Unknown parent' },
          ],
        });
      const version = this.versions.find((v) => v.id === loc.versionId);
      if (version?.state !== 'PREPARE_FOR_SUBMISSION')
        return json(409, {
          errors: [
            {
              status: '409',
              code: 'STATE_ERROR.INVALID_STATE',
              title: 'Creating a placement is not permitted in this state',
            },
          ],
        });
      const key = `${data.relationships.appStoreVersionLocalization.data.id}\u0000${data.attributes.placementGroup}`;
      if ((this.order.get(key) ?? []).length >= 10)
        return json(409, {
          errors: [{ status: '409', code: 'ENTITY_ERROR.TOO_MANY', title: 'Too many placements' }],
        });
      const id = this.#id('pl');
      this.placements.set(id, {
        id,
        locId: data.relationships.appStoreVersionLocalization.data.id,
        group: data.attributes.placementGroup,
        imageId: image.id,
      });
      this.order.set(key, [...(this.order.get(key) ?? []), id]);
      return json(201, {
        data: {
          type: 'appAssetLibraryPlacements',
          id,
          attributes: {
            mediaType: 'IMAGE',
            placementType: data.attributes.placementType,
            placementGroup: data.attributes.placementGroup,
            state: 'PARENT_PREPARE_FOR_SUBMISSION',
          },
        },
      });
    }
    if (method === 'DELETE' && (m = path.match(/^\/v1\/appAssetLibraryPlacements\/([^/]+)$/))) {
      const placement = this.placements.get(m[1] ?? '');
      if (!placement) return notFound();
      this.placements.delete(placement.id);
      const key = `${placement.locId}\u0000${placement.group}`;
      this.order.set(
        key,
        (this.order.get(key) ?? []).filter((x) => x !== placement.id),
      );
      return json(204);
    }
    if (method === 'POST' && path === '/v1/appAssetLibraryPlacementOrderingRequests') {
      const data = (
        s.body as {
          data: {
            attributes: { placementGroup: string };
            relationships: {
              orderedPlacements: { data: { id: string }[] };
              appStoreVersionLocalization: { data: { id: string } };
            };
          };
        }
      ).data;
      const key = `${data.relationships.appStoreVersionLocalization.data.id}\u0000${data.attributes.placementGroup}`;
      const ids = data.relationships.orderedPlacements.data.map((d) => d.id);
      const have = [...(this.order.get(key) ?? [])].sort().join(',');
      if (have !== [...ids].sort().join(','))
        return json(409, {
          errors: [
            {
              status: '409',
              code: 'ENTITY_ERROR.RELATIONSHIP.INVALID',
              title: 'The ordering must name every placement of the group',
            },
          ],
        });
      this.order.set(key, ids);
      return json(201, {
        data: { type: 'appAssetLibraryPlacementOrderingRequests', id: this.#id('ord') },
      });
    }
    return json(599, { error: `no route ${method} ${path}` });
  }
}

/** The reference data of the fake: shapes as Apple's example shows them. */
export function defaultRefData() {
  const spec = (specId: string, w: number, h: number) => ({
    specId,
    shortName: `i${w}x${h}a0`,
    dimensions: { minWidth: w, maxWidth: w, minHeight: h, maxHeight: h },
    compatiblePlacementTypes: ['APP_SCREENSHOT'],
    alphaAllowed: false,
    fileExtensions: ['.jpg', '.jpeg', '.png'],
    mimeTypes: ['image/jpeg', 'image/png'],
    maxFileSize: 524288000,
    universalAsset: false,
  });
  return {
    features: [
      {
        featureId: 'APP_STORE_VERSIONS',
        placementPolicies: [
          {
            placementType: 'APP_SCREENSHOT',
            groupLimits: [
              {
                groupIds: [
                  'IPHONE_65_PROFILE',
                  'IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE',
                  'IPAD_13_PROFILE',
                  'IPAD_M4_PROFILE',
                ],
                maxCount: 10,
              },
            ],
          },
        ],
      },
    ],
    placementProfileGroups: [
      {
        placementProfileGroupId: 'IPHONE_65_PROFILE',
        platform: 'IPHONE_APP_STORE',
        displayClassId: 'IPHONE_65_DISPLAY',
      },
      {
        placementProfileGroupId: 'IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE',
        platform: 'IPHONE_APP_STORE',
        displayClassId: 'IPHONE_DYNAMIC_ISLAND_LARGE_DISPLAY',
      },
      {
        placementProfileGroupId: 'IPAD_13_PROFILE',
        platform: 'IPAD_APP_STORE',
        displayClassId: 'IPAD_13_DISPLAY',
      },
      {
        placementProfileGroupId: 'IPAD_M4_PROFILE',
        platform: 'IPAD_APP_STORE',
        displayClassId: 'IPAD_M4_DISPLAY',
      },
    ],
    imageSpecs: [
      spec('spec-65', 1242, 2688),
      spec('spec-67', 1290, 2796),
      spec('spec-ipad13', 2064, 2752),
    ],
    placementTypes: [
      {
        placementTypeId: 'APP_SCREENSHOT',
        acceptsAssetCategories: ['APP_SCREENSHOTS_AND_PREVIEWS'],
        specMappings: [
          { placementGroupId: 'IPHONE_65_PROFILE', specs: ['spec-65'] },
          { placementGroupId: 'IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE', specs: ['spec-67'] },
          { placementGroupId: 'IPAD_13_PROFILE', specs: ['spec-ipad13'] },
          { placementGroupId: 'IPAD_M4_PROFILE', specs: ['spec-ipad13'] },
        ],
      },
    ],
    displayClasses: [
      { displayClassId: 'IPHONE_65_DISPLAY', deviceFamily: 'IPHONE', screenDimensions: ['6.5'] },
      {
        displayClassId: 'IPHONE_DYNAMIC_ISLAND_LARGE_DISPLAY',
        deviceFamily: 'IPHONE',
        screenDimensions: ['6.9'],
      },
      { displayClassId: 'IPAD_13_DISPLAY', deviceFamily: 'IPAD', screenDimensions: ['13'] },
      { displayClassId: 'IPAD_M4_DISPLAY', deviceFamily: 'IPAD', screenDimensions: ['13.0'] },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Google Play

export type PlayListing = {
  language: string;
  title?: string;
  shortDescription?: string;
  fullDescription?: string;
  video?: string;
};
type PlayImage = { id: string; sha256: string; sha1: string; url?: string };

export class FakePlayDraftApi {
  readonly seen: Seen[] = [];
  /** What is committed. */
  listings = new Map<string, PlayListing>([
    [
      'en-US',
      {
        language: 'en-US',
        title: 'Old title',
        shortDescription: 'Old short',
        fullDescription: 'Old full',
      },
    ],
  ]);
  images = new Map<string, PlayImage[]>();
  commits: { query: string }[] = [];
  /** `edits.tracks.list`. */
  tracks: {
    track: string;
    releases: {
      name?: string;
      status: string;
      userFraction?: number;
      versionCodes: string[];
      releaseNotes?: { language: string; text: string }[];
    }[];
  }[] = [
    {
      track: 'production',
      releases: [{ name: '2.0', status: 'completed', versionCodes: ['200'] }],
    },
  ];
  /** `edits.bundles.list` and `edits.apks.list`. */
  bundles: { versionCode: number; sha256: string }[] = [
    { versionCode: 200, sha256: 'a'.repeat(64) },
    { versionCode: 240, sha256: 'b'.repeat(64) },
    { versionCode: 241, sha256: 'c'.repeat(64) },
  ];
  apks: { versionCode: number; binary: { sha256: string } }[] = [];
  /** How the commit is answered. */
  commitAnswer: 'ok' | 'in_review' | 'not_sent_refused' | 'server_error' | 'cut' = 'ok';
  /** How `edits.validate` is answered: fine, Google refuses the edit (400), or fails (503). */
  validateAnswer: 'ok' | 'invalid' | 'server_error' = 'ok';
  /** Google refuses `tracks.update` with a 400 (a release it will not stage) with this message. */
  trackUpdateRefusal: string | undefined;
  /** How often `edits.validate` was called. */
  validations = 0;
  /** Make an upload store different bytes than were sent (a bad answer from the store). */
  corruptUploads = false;
  hook: Hook | undefined;
  #edit:
    | {
        listings: Map<string, PlayListing>;
        images: Map<string, PlayImage[]>;
        tracks: FakePlayDraftApi['tracks'];
      }
    | undefined;
  #n = 0;

  setImages(language: string, type: string, files: Uint8Array[]): void {
    this.images.set(
      `${language}/${type}`,
      files.map((b) => {
        const id = `img-${++this.#n}`;
        return {
          id,
          sha256: sha256(b),
          sha1: 'x',
          url: `https://play-lh.googleusercontent.com/${id}`,
        };
      }),
    );
  }

  writes(): string[] {
    return this.seen
      .filter((s) => s.method !== 'GET' && !s.path.endsWith('/token'))
      .map(
        (s) =>
          `${s.method} ${s.path.replace(/^\/upload\/androidpublisher\/v3\/applications\/[^/]+/, 'upload').replace(/^\/androidpublisher\/v3\/applications\/[^/]+/, '')}${s.query}`,
      );
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const raw = init?.body;
    const bytes = raw instanceof Uint8Array ? raw : undefined;
    const body = typeof raw === 'string' && raw.startsWith('{') ? JSON.parse(raw) : undefined;
    const seen: Seen = {
      method,
      host: url.host,
      path: url.pathname,
      query: url.search,
      body,
      ...(bytes ? { bytes } : {}),
      headers: new Headers(init?.headers),
    };
    this.seen.push(seen);
    if (url.host === 'oauth2.googleapis.com') return json(200, fx.googleToken);
    const hooked = this.hook?.(seen);
    if (hooked instanceof Error) throw hooked;
    if (hooked) return hooked;
    return this.#route(seen);
  };

  #route(s: Seen): Response {
    const { method } = s;
    const path = s.path.replace(
      /^\/(upload\/)?androidpublisher\/v3\/applications\/[^/]+\/edits/,
      '',
    );
    if (method === 'POST' && path === '') {
      this.#edit = {
        listings: new Map([...this.listings].map(([k, v]) => [k, { ...v }])),
        images: new Map([...this.images].map(([k, v]) => [k, [...v]])),
        tracks: structuredClone(this.tracks),
      };
      return json(200, fx.googleEdit);
    }
    if (!this.#edit) return json(404, { error: { code: 404, message: 'Edit not found' } });
    const edit = this.#edit;
    const id = `/${fx.googleEdit.id}`;
    if (method === 'DELETE' && path === id) {
      this.#edit = undefined;
      return json(200);
    }
    if (method === 'GET' && path === `${id}/listings`)
      return json(200, { listings: [...edit.listings.values()] });
    if (method === 'GET' && path === `${id}/tracks`) return json(200, { tracks: this.tracks });
    if (method === 'GET' && path === `${id}/bundles`)
      return json(200, { kind: 'androidpublisher#bundlesListResponse', bundles: this.bundles });
    if (method === 'GET' && path === `${id}/apks`)
      return json(200, { kind: 'androidpublisher#apksListResponse', apks: this.apks });
    let m: RegExpMatchArray | null;
    if ((m = path.match(new RegExp(`^${id}/tracks/([^/]+)$`)))) {
      const name = decodeURIComponent(m[1] ?? '');
      if (method === 'GET') {
        const found = edit.tracks.find((t) => t.track === name);
        return found
          ? json(200, found)
          : json(404, { error: { code: 404, message: 'Track not found' } });
      }
      if (method === 'PUT') {
        if (this.trackUpdateRefusal !== undefined)
          return json(400, {
            error: { code: 400, status: 'INVALID_ARGUMENT', message: this.trackUpdateRefusal },
          });
        const body = s.body as FakePlayDraftApi['tracks'][number];
        const at = edit.tracks.findIndex((t) => t.track === name);
        if (at === -1) edit.tracks.push(body);
        else edit.tracks[at] = body;
        return json(200, body);
      }
    }
    if (method === 'PUT' && (m = path.match(new RegExp(`^${id}/listings/([^/]+)$`)))) {
      const listing = s.body as PlayListing;
      edit.listings.set(decodeURIComponent(m[1] ?? ''), listing);
      return json(200, listing);
    }
    if ((m = path.match(new RegExp(`^${id}/listings/([^/]+)/([^/]+)$`)))) {
      const key = `${decodeURIComponent(m[1] ?? '')}/${m[2]}`;
      if (method === 'GET') return json(200, { images: edit.images.get(key) ?? [] });
      if (method === 'DELETE') {
        const deleted = edit.images.get(key) ?? [];
        edit.images.set(key, []);
        return json(200, { deleted });
      }
      if (method === 'POST') {
        const sent = s.bytes ?? new Uint8Array();
        const stored = this.corruptUploads ? new Uint8Array([...sent, 0]) : sent;
        const image = { id: `img-${++this.#n}`, sha256: sha256(stored), sha1: 'x' };
        edit.images.set(key, [...(edit.images.get(key) ?? []), image]);
        return json(200, { image });
      }
    }
    if (method === 'POST' && path === `${id}:validate`) {
      this.validations++;
      if (this.validateAnswer === 'invalid')
        return json(400, {
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            message: 'Version code 241 has been used in a release that is already live.',
          },
        });
      if (this.validateAnswer === 'server_error')
        return json(503, { error: { code: 503, message: 'Backend error' } });
      return json(200, fx.googleEdit);
    }
    if (method === 'POST' && path === `${id}:commit`) {
      this.commits.push({ query: s.query });
      switch (this.commitAnswer) {
        case 'in_review':
          return json(400, {
            error: {
              code: 400,
              status: 'FAILED_PRECONDITION',
              message: 'The edit isn’t invalidated',
              details: [{ reason: 'CHANGES_ALREADY_IN_REVIEW' }],
            },
          });
        case 'not_sent_refused':
          // Google refuses only the hold-back; the same commit without it is accepted.
          if (!/changesNotSentForReview=true/.test(s.query)) {
            this.#apply();
            return json(200, fx.googleEdit);
          }
          return json(400, {
            error: {
              code: 400,
              message:
                'Changes cannot be sent for review automatically. Please set the query parameter changesNotSentForReview to true.',
            },
          });
        case 'server_error':
          this.#apply();
          return json(503, { error: { code: 503, message: 'Backend error' } });
        case 'cut':
          this.#apply();
          throw new TypeError('socket hang up');
        default:
          this.#apply();
          return json(200, fx.googleEdit);
      }
    }
    return json(599, { error: `no route ${method} ${s.path}` });
  }

  #apply(): void {
    if (!this.#edit) return;
    this.listings = this.#edit.listings;
    this.images = this.#edit.images;
    this.tracks = this.#edit.tracks;
  }
}
