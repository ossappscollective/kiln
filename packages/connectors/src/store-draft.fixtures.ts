import { createHash } from 'node:crypto';
import * as fx from './store.fixtures.ts';

/**
 * Stateful fakes of the two stores for the draft writers' tests: they remember what was written,
 * so a test can look at the result and at the exact order of the requests. Not a real store: the
 * shapes follow the docs the writers cite (and so are as UNVERIFIED as those).
 */

export type Seen = { method: string; host: string; path: string; query: string; body: unknown; bytes?: Uint8Array; headers: Headers };

const json = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('hex');
export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
export const md5Of = md5;

export type Hook = (seen: Seen) => Response | Error | undefined;

// ---------------------------------------------------------------------------------------------
// App Store Connect

type AppleShot = { id: string; fileName: string; fileSize: number; checksum: string | null; state: string; polls: number; bytes: Uint8Array[]; setId: string };

export class FakeAppleDraftApi {
  readonly seen: Seen[] = [];
  versions: { id: string; versionString: string; state: string; platform?: string }[] = [
    { id: 'v-live', versionString: '2.0', state: 'READY_FOR_DISTRIBUTION' },
    { id: 'v-next', versionString: '2.1', state: 'PREPARE_FOR_SUBMISSION' },
  ];
  /** localization id -> locale and attributes. */
  locs = new Map<string, { versionId: string; locale: string; attributes: Record<string, unknown> }>();
  sets = new Map<string, { locId: string; type: string; shots: string[] }>();
  shots = new Map<string, AppleShot>();
  /** Polls that answer UPLOAD_COMPLETE before COMPLETE. */
  pollsBeforeComplete = 1;
  /** Files whose processing ends FAILED (by file name). */
  failProcessing = new Set<string>();
  hook: Hook | undefined;
  #n = 0;
  readonly #id = (prefix: string) => `${prefix}-${++this.#n}`;

  constructor() {
    this.locs.set('loc-en', { versionId: 'v-next', locale: 'en-US', attributes: { locale: 'en-US', description: 'Old description', keywords: 'old', whatsNew: 'Old news' } });
  }

  addSet(locId: string, type: string, files: { name: string; bytes: Uint8Array; state?: string }[]): string {
    const id = this.#id('set');
    const ids: string[] = [];
    for (const f of files) {
      const shotId = this.#id('shot');
      this.shots.set(shotId, { id: shotId, fileName: f.name, fileSize: f.bytes.length, checksum: md5(f.bytes), state: f.state ?? 'COMPLETE', polls: 0, bytes: [f.bytes], setId: id });
      ids.push(shotId);
    }
    this.sets.set(id, { locId, type, shots: ids });
    return id;
  }

  /** The requests that changed something, as `METHOD path`. */
  writes(): string[] {
    return this.seen.filter((s) => s.method !== 'GET').map((s) => `${s.method} ${s.host === 'api.appstoreconnect.apple.com' ? s.path : `${s.host}${s.path}`}`);
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const raw = init?.body;
    const bytes = raw instanceof Uint8Array ? raw : undefined;
    const body = typeof raw === 'string' ? JSON.parse(raw) : undefined;
    const seen: Seen = { method, host: url.host, path: url.pathname, query: url.search, body, ...(bytes ? { bytes } : {}), headers: new Headers(init?.headers) };
    this.seen.push(seen);
    const hooked = this.hook?.(seen);
    if (hooked instanceof Error) throw hooked;
    if (hooked) return hooked;
    return this.#route(seen);
  };

  #shotView(s: AppleShot) {
    return { type: 'appScreenshots', id: s.id, attributes: { fileName: s.fileName, sourceFileChecksum: s.checksum, assetDeliveryState: { state: s.state, errors: s.state === 'FAILED' ? [{ code: 'IMAGE_BAD', description: 'The image is not acceptable.' }] : [] } } };
  }

  #route(s: Seen): Response {
    const { method, path } = s;
    if (s.host !== 'api.appstoreconnect.apple.com') {
      // The pre-signed upload server: no JWT is ever sent there.
      const id = path.split('/').pop() ?? '';
      const shot = this.shots.get(id);
      if (method === 'PUT' && shot) {
        shot.bytes.push(s.bytes ?? new Uint8Array());
        return json(200);
      }
      return json(404);
    }
    let m: RegExpMatchArray | null;
    if (method === 'GET' && /^\/v1\/apps\/\d+\/appStoreVersions$/.test(path)) {
      return json(200, { data: this.versions.map((v) => ({ type: 'appStoreVersions', id: v.id, attributes: { platform: v.platform ?? 'IOS', versionString: v.versionString, appVersionState: v.state } })), links: {} });
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/appStoreVersions\/([^/]+)\/appStoreVersionLocalizations$/))) {
      return json(200, { data: [...this.locs].filter(([, l]) => l.versionId === m?.[1]).map(([id, l]) => ({ type: 'appStoreVersionLocalizations', id, attributes: l.attributes })), links: {} });
    }
    if (method === 'PATCH' && (m = path.match(/^\/v1\/appStoreVersionLocalizations\/([^/]+)$/))) {
      const loc = this.locs.get(m[1] ?? '');
      if (!loc) return json(404, { errors: [{ status: '404', code: 'NOT_FOUND', title: 'Not found' }] });
      Object.assign(loc.attributes, ((s.body as { data: { attributes: Record<string, unknown> } }).data).attributes);
      return json(200, { data: { type: 'appStoreVersionLocalizations', id: m[1], attributes: loc.attributes } });
    }
    if (method === 'POST' && path === '/v1/appStoreVersionLocalizations') {
      const data = (s.body as { data: { attributes: Record<string, unknown>; relationships: { appStoreVersion: { data: { id: string } } } } }).data;
      const id = this.#id('loc');
      this.locs.set(id, { versionId: data.relationships.appStoreVersion.data.id, locale: String(data.attributes.locale), attributes: data.attributes });
      return json(201, { data: { type: 'appStoreVersionLocalizations', id, attributes: data.attributes } });
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/appStoreVersionLocalizations\/([^/]+)\/appScreenshotSets$/))) {
      const mine = [...this.sets].filter(([, set]) => set.locId === m?.[1]);
      return json(200, {
        data: mine.map(([id, set]) => ({
          type: 'appScreenshotSets',
          id,
          attributes: { screenshotDisplayType: set.type },
          relationships: { appScreenshots: { data: set.shots.map((x) => ({ type: 'appScreenshots', id: x })) } },
        })),
        included: mine.flatMap(([, set]) => set.shots.map((x) => this.#shotView(this.shots.get(x) as AppleShot))),
      });
    }
    if (method === 'POST' && path === '/v1/appScreenshotSets') {
      const data = (s.body as { data: { attributes: { screenshotDisplayType: string }; relationships: { appStoreVersionLocalization: { data: { id: string } } } } }).data;
      const id = this.#id('set');
      this.sets.set(id, { locId: data.relationships.appStoreVersionLocalization.data.id, type: data.attributes.screenshotDisplayType, shots: [] });
      return json(201, { data: { type: 'appScreenshotSets', id } });
    }
    if (method === 'POST' && path === '/v1/appScreenshots') {
      const data = (s.body as { data: { attributes: { fileName: string; fileSize: number }; relationships: { appScreenshotSet: { data: { id: string } } } } }).data;
      const id = this.#id('shot');
      const setId = data.relationships.appScreenshotSet.data.id;
      this.shots.set(id, { id, fileName: data.attributes.fileName, fileSize: data.attributes.fileSize, checksum: null, state: 'AWAITING_UPLOAD', polls: 0, bytes: [], setId });
      this.sets.get(setId)?.shots.push(id);
      const half = Math.floor(data.attributes.fileSize / 2);
      return json(201, {
        data: {
          type: 'appScreenshots',
          id,
          attributes: {
            fileName: data.attributes.fileName,
            fileSize: data.attributes.fileSize,
            assetDeliveryState: { state: 'AWAITING_UPLOAD' },
            // Two parts, to prove that offset and length are honoured.
            uploadOperations: [
              { method: 'PUT', url: `https://store-030.blobstore.apple.com/up/${id}`, offset: 0, length: half, requestHeaders: [{ name: 'Content-Type', value: 'image/png' }, { name: 'X-Apple-Part', value: '1' }] },
              { method: 'PUT', url: `https://store-030.blobstore.apple.com/up/${id}`, offset: half, length: data.attributes.fileSize - half, requestHeaders: [{ name: 'Content-Type', value: 'image/png' }, { name: 'X-Apple-Part', value: '2' }] },
            ],
          },
        },
      });
    }
    if (method === 'PATCH' && (m = path.match(/^\/v1\/appScreenshots\/([^/]+)$/))) {
      const shot = this.shots.get(m[1] ?? '');
      if (!shot) return json(404, { errors: [{ status: '404', code: 'NOT_FOUND', title: 'Not found' }] });
      const attrs = (s.body as { data: { attributes: { uploaded?: boolean; sourceFileChecksum?: string } } }).data.attributes;
      const got = Buffer.concat(shot.bytes);
      if (attrs.uploaded && got.length !== shot.fileSize) return json(409, { errors: [{ status: '409', code: 'ENTITY_STATE_INVALID', title: 'size mismatch' }] });
      shot.checksum = attrs.sourceFileChecksum ?? null;
      shot.state = 'UPLOAD_COMPLETE';
      return json(200, { data: this.#shotView(shot) });
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/appScreenshots\/([^/]+)$/))) {
      const shot = this.shots.get(m[1] ?? '');
      if (!shot) return json(404, { errors: [{ status: '404', code: 'NOT_FOUND', title: 'Not found' }] });
      if (shot.state === 'UPLOAD_COMPLETE') {
        shot.polls++;
        if (shot.polls > this.pollsBeforeComplete) shot.state = this.failProcessing.has(shot.fileName) ? 'FAILED' : 'COMPLETE';
      }
      return json(200, { data: this.#shotView(shot) });
    }
    if (method === 'DELETE' && (m = path.match(/^\/v1\/appScreenshots\/([^/]+)$/))) {
      const shot = this.shots.get(m[1] ?? '');
      if (!shot) return json(404, { errors: [{ status: '404', code: 'NOT_FOUND', title: 'Not found' }] });
      this.shots.delete(shot.id);
      const set = this.sets.get(shot.setId);
      if (set) set.shots = set.shots.filter((x) => x !== shot.id);
      return json(204);
    }
    if (method === 'PATCH' && (m = path.match(/^\/v1\/appScreenshotSets\/([^/]+)\/relationships\/appScreenshots$/))) {
      const set = this.sets.get(m[1] ?? '');
      if (!set) return json(404);
      set.shots = (s.body as { data: { id: string }[] }).data.map((d) => d.id);
      return json(204);
    }
    return json(599, { error: `no route ${method} ${path}` });
  }
}

// ---------------------------------------------------------------------------------------------
// Google Play

export type PlayListing = { language: string; title?: string; shortDescription?: string; fullDescription?: string; video?: string };
type PlayImage = { id: string; sha256: string; sha1: string };

export class FakePlayDraftApi {
  readonly seen: Seen[] = [];
  /** What is committed. */
  listings = new Map<string, PlayListing>([['en-US', { language: 'en-US', title: 'Old title', shortDescription: 'Old short', fullDescription: 'Old full' }]]);
  images = new Map<string, PlayImage[]>();
  commits: { query: string }[] = [];
  /** How the commit is answered. */
  commitAnswer: 'ok' | 'in_review' | 'not_sent_refused' | 'server_error' | 'cut' = 'ok';
  /** Make an upload store different bytes than were sent (a bad answer from the store). */
  corruptUploads = false;
  hook: Hook | undefined;
  #edit: { listings: Map<string, PlayListing>; images: Map<string, PlayImage[]> } | undefined;
  #n = 0;

  setImages(language: string, type: string, files: Uint8Array[]): void {
    this.images.set(`${language}/${type}`, files.map((b) => ({ id: `img-${++this.#n}`, sha256: sha256(b), sha1: 'x' })));
  }

  writes(): string[] {
    return this.seen.filter((s) => s.method !== 'GET' && !s.path.endsWith('/token')).map((s) => `${s.method} ${s.path.replace(/^\/upload\/androidpublisher\/v3\/applications\/[^/]+/, 'upload').replace(/^\/androidpublisher\/v3\/applications\/[^/]+/, '')}${s.query}`);
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const raw = init?.body;
    const bytes = raw instanceof Uint8Array ? raw : undefined;
    const body = typeof raw === 'string' && raw.startsWith('{') ? JSON.parse(raw) : undefined;
    const seen: Seen = { method, host: url.host, path: url.pathname, query: url.search, body, ...(bytes ? { bytes } : {}), headers: new Headers(init?.headers) };
    this.seen.push(seen);
    if (url.host === 'oauth2.googleapis.com') return json(200, fx.googleToken);
    const hooked = this.hook?.(seen);
    if (hooked instanceof Error) throw hooked;
    if (hooked) return hooked;
    return this.#route(seen);
  };

  #route(s: Seen): Response {
    const { method } = s;
    const path = s.path.replace(/^\/(upload\/)?androidpublisher\/v3\/applications\/[^/]+\/edits/, '');
    if (method === 'POST' && path === '') {
      this.#edit = { listings: new Map([...this.listings].map(([k, v]) => [k, { ...v }])), images: new Map([...this.images].map(([k, v]) => [k, [...v]])) };
      return json(200, fx.googleEdit);
    }
    if (!this.#edit) return json(404, { error: { code: 404, message: 'Edit not found' } });
    const edit = this.#edit;
    const id = `/${fx.googleEdit.id}`;
    if (method === 'DELETE' && path === id) {
      this.#edit = undefined;
      return json(200);
    }
    if (method === 'GET' && path === `${id}/listings`) return json(200, { listings: [...edit.listings.values()] });
    let m: RegExpMatchArray | null;
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
    if (method === 'POST' && path === `${id}:commit`) {
      this.commits.push({ query: s.query });
      switch (this.commitAnswer) {
        case 'in_review':
          return json(400, { error: { code: 400, status: 'FAILED_PRECONDITION', message: 'The edit isn’t invalidated', details: [{ reason: 'CHANGES_ALREADY_IN_REVIEW' }] } });
        case 'not_sent_refused':
          return json(400, { error: { code: 400, message: 'Changes cannot be sent for review automatically. Please set the query parameter changesNotSentForReview to true.' } });
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
  }
}
