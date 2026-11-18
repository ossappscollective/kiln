import { createHash, randomBytes } from 'node:crypto';
import {
  type BlobHeadItem,
  type BlobHeads,
  type BlobHeadsOptions,
  type BlobListing,
  type BlobReads,
  type DraftApplyInput,
  type DraftApplyResult,
  type DraftAssetState,
  DraftDriftError,
  type DraftImageState,
  DraftOutcomeUnknownError,
  DraftPartialError,
  type DraftReadRequest,
  type DraftState,
  type DraftStep,
  type StoreDraftConnector,
  StoreError,
  type StoreSubmitConnector,
  type SubmitApplyInput,
  SubmitDriftError,
  SubmitOutcomeUnknownError,
  type SubmitResult,
  type SubmitState,
  type SubmitTrack,
  setMatches,
} from '@mrm/connectors';
import { type Platform, type StagedChangesView, classifyAppleScreenshot } from '@mrm/core';
import type { Database } from '@mrm/db';
import { weatherApp } from '../../../packages/connectors/src/fastlane.fixtures.ts';
import { ASC_SECRET, FakeStore, PLAY_SECRET } from './listing-test-helpers.ts';
import { FakeRepo, bootRepoApp } from './repo-test-helpers.ts';
import { clearAssetIndexes } from './services/asset-repo.ts';
import { forgetInspectedChangeSets } from './services/listing-repo.ts';
import { forgetRunningListingReads } from './services/listing-schedule.ts';
import { clearRepoSnapshots } from './services/repo-snapshot.ts';
import type { StoreConnectorFactory } from './services/apps.ts';
import type { DraftConnectorFactory, DraftConnectorInput } from './services/store-draft.ts';
import type { SubmitConnectorFactory, SubmitConnectorInput } from './services/store-submit.ts';

/**
 * Shared by the staged changes and store draft tests. Everything runs against fakes: no store and no
 * GitHub is contacted. The repository is an in-memory GitHub connector that can also read binary
 * files (the API path of the asset index), the stores are `FakeDraftStore`s.
 */

export { ASC_SECRET, PLAY_SECRET };

type Files = Record<string, string | Buffer>;

// ----- images: only the bytes a header parser looks at ------------------------------------------

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));

export function png(width: number, height: number, options: { alpha?: boolean; seed?: number; pad?: number } = {}): Buffer {
  const colour = options.alpha ? 6 : 2;
  const ihdr = [...be32(13), ...text('IHDR'), ...be32(width), ...be32(height), 8, colour, 0, 0, 0, 0, 0, 0, 0];
  const idat = [...be32(4), ...text('IDAT'), options.seed ?? 0, 2, 3, 4, 0, 0, 0, 0];
  const head = Buffer.from([0x89, ...text('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...idat]);
  return options.pad ? Buffer.concat([head, Buffer.alloc(options.pad, 7)]) : head;
}
export function jpeg(width: number, height: number): Buffer {
  const app0 = [0xff, 0xe0, ...be16(16), ...text('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const frame = [0xff, 0xc0, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Buffer.from([0xff, 0xd8, ...app0, ...frame, 0xff, 0xda, 0, 0]);
}

export const IPHONE_65 = [1242, 2688] as const;
export const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex');
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// ----- the repository ----------------------------------------------------------------------------

const blobId = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/** An in-memory GitHub connector that can also read binary files. */
export class BlobRepo extends FakeRepo implements BlobReads {
  blobs = new Map<string, Buffer>();
  commit = 'd'.repeat(40);
  /** Paths whose bytes are served as something else than the index saw (the file changed under the commit). */
  swapped = new Map<string, Buffer>();
  readCalls: string[][] = [];
  constructor(files: Files) {
    super();
    this.files = new Map();
    for (const [path, content] of Object.entries(files)) {
      if (typeof content === 'string') this.files.set(path, content);
      else this.blobs.set(path, content);
    }
  }
  override async listFiles(): Promise<string[]> {
    this.listCalls++;
    if (this.listError) throw this.listError;
    return [...this.files.keys(), ...this.blobs.keys()].sort();
  }
  async resolveCommit(): Promise<string> {
    return this.commit;
  }
  async listBlobEntries(): Promise<BlobListing> {
    return { commit: this.commit, entries: [...this.blobs].map(([path, bytes]) => ({ path, oid: blobId(bytes), mode: '100644', size: bytes.length })) };
  }
  async readBlobHeads(paths: readonly string[], options: BlobHeadsOptions): Promise<BlobHeads> {
    this.readCalls.push([...paths]);
    const items = new Map<string, BlobHeadItem>();
    let transferred = 0;
    for (const path of paths) {
      const bytes = this.swapped.get(path) ?? this.blobs.get(path);
      if (!bytes) {
        items.set(path, { ok: false, oid: null, reason: 'missing', size: null });
        continue;
      }
      const oid = blobId(this.blobs.get(path) ?? bytes);
      if (bytes.length > options.maxFileBytes) {
        items.set(path, { ok: false, oid, reason: 'too_large', size: bytes.length });
        continue;
      }
      const take = Math.min(bytes.length, options.headBytes);
      if (transferred + take > options.maxTransferBytes) {
        items.set(path, { ok: false, oid, reason: 'budget', size: bytes.length });
        continue;
      }
      transferred += take;
      items.set(path, { ok: true, oid: this.swapped.has(path) ? blobId(bytes) : oid, size: bytes.length, head: new Uint8Array(bytes.subarray(0, take)) });
    }
    return { items, transferredBytes: transferred };
  }
}

// ----- the stores --------------------------------------------------------------------------------

export type DraftBehavior =
  | { kind: 'ok' }
  /** The store refuses the first change that needs writing. */
  | { kind: 'refuse'; error: StoreError }
  /** The store refuses after `after` changes were applied (App Store). */
  | { kind: 'partial'; after: number; error: StoreError }
  /** The change is sent and the store does not answer; `applied` says whether it applied it anyway. */
  /** `first`: the store applied only the first change before it stopped answering. */
  | { kind: 'unknown'; applied: boolean | 'first' };

const key = (locale: string, field: string) => `${locale}\u0000${field}`;

/** A store's draft that can be read and written, remembers every write, and can be told how to fail. */
export class FakeDraftStore implements StoreDraftConnector {
  readonly store: 'appstoreconnect' | 'googleplay';
  readonly platform: Platform;
  version: DraftState['version'];
  locales = new Set<string>(['en-US']);
  texts = new Map<string, string>();
  sets = new Map<string, DraftImageState[]>();
  behavior: DraftBehavior = { kind: 'ok' };
  readError: unknown;
  /** After a failed write the draft cannot be read back. */
  readFailsAfterWrite = false;
  reads = 0;
  applyCalls = 0;
  /** What the store was asked to write (names and checksums, never bytes). */
  writes: { text: { locale: string; field: string }[]; sets: { locale: string; target: string; files: string[] }[] }[] = [];
  /** The most recent `applyDraft` input, with the bytes. */
  lastInput: DraftApplyInput | undefined;
  /** A write waits for this after the guard accepted: lets a test hold a write in flight. */
  gate: Promise<void> | undefined;
  #n = 0;

  constructor(platform: Platform) {
    this.platform = platform;
    this.store = platform === 'ios' ? 'appstoreconnect' : 'googleplay';
    this.version = platform === 'ios' ? { id: 'v-next', versionString: '2.1', state: 'PREPARE_FOR_SUBMISSION' } : null;
    this.texts.set(key('en-US', platform === 'ios' ? 'description' : 'title'), 'Old text');
  }

  #kind(): 'md5' | 'sha256' {
    return this.platform === 'ios' ? 'md5' : 'sha256';
  }
  /** Puts a set into the draft (a test's starting point). */
  seedSet(locale: string, target: string, files: { name: string; bytes: Uint8Array }[]): void {
    this.sets.set(`${locale}\u0000${target}`, files.map((f) => this.#image(f.name, f.bytes)));
  }
  #image(name: string, bytes: Uint8Array): DraftImageState {
    return {
      id: `img-${++this.#n}`,
      name: this.platform === 'ios' ? name : null,
      checksum: this.#kind() === 'md5' ? md5(bytes) : sha256(bytes),
      checksumKind: this.#kind(),
      state: this.platform === 'ios' ? 'COMPLETE' : null,
    };
  }

  #state(request: DraftReadRequest): DraftState {
    const assets: DraftAssetState[] = request.assets.map((s) => {
      const images = this.sets.get(`${s.locale}\u0000${s.target}`);
      return { locale: s.locale, kind: s.kind, device: s.device, target: s.target, setExists: this.platform === 'android' || images !== undefined, images: structuredClone(images ?? []) };
    });
    return {
      store: this.store,
      platform: this.platform,
      version: this.version ? { ...this.version } : null,
      text: request.text.map((t) => ({ locale: t.locale, field: t.field, value: this.texts.get(key(t.locale, t.field)) ?? null, localeExists: this.locales.has(t.locale) })),
      assets,
    };
  }

  async readDraft(request: DraftReadRequest): Promise<DraftState> {
    this.reads++;
    if (this.readError) throw this.readError;
    return this.#state(request);
  }

  async applyDraft(input: DraftApplyInput): Promise<DraftApplyResult> {
    this.applyCalls++;
    this.lastInput = input;
    const request: DraftReadRequest = {
      text: input.text.map((t) => ({ locale: t.locale, field: t.field })),
      assets: input.assets.map((a) => ({ locale: a.locale, kind: a.kind, device: a.device, target: a.target })),
    };
    const before = this.#state(request);
    if (!input.guard(before)) throw new DraftDriftError(before);
    this.writes.push({ text: input.text.map((t) => ({ locale: t.locale, field: t.field })), sets: input.assets.map((a) => ({ locale: a.locale, target: a.target, files: a.files.map((f) => `${f.name}:${f.md5}`) })) });
    if (this.gate) await this.gate;
    const b = this.behavior;
    const steps: DraftStep[] = [];
    let applied = 0;
    const apply = (step: DraftStep, change: () => void, at: { type: DraftStep['type']; locale: string; target: string }) => {
      if (step.outcome === 'applied') {
        if (b.kind === 'refuse') throw applied === 0 ? b.error : new DraftPartialError(b.error, [...steps], at);
        if (b.kind === 'partial' && applied >= b.after) throw applied === 0 ? b.error : new DraftPartialError(b.error, [...steps], at);
        if (b.kind === 'unknown' && (b.applied === false || (b.applied === 'first' && applied >= 1))) throw new DraftOutcomeUnknownError(this.store, 'timed out', [...steps]);
        change();
        applied++;
      }
      steps.push(step);
    };
    for (const t of input.text) {
      const same = this.texts.get(key(t.locale, t.field)) === t.value;
      apply({ type: 'text', locale: t.locale, target: t.field, outcome: same ? 'already_same' : 'applied' }, () => {
        this.locales.add(t.locale);
        this.texts.set(key(t.locale, t.field), t.value);
      }, { type: 'text', locale: t.locale, target: t.field });
    }
    for (const a of input.assets) {
      const current = this.sets.get(`${a.locale}\u0000${a.target}`) ?? [];
      const same = setMatches(current, a.files);
      apply(
        { type: 'asset', locale: a.locale, target: a.target, outcome: same ? 'already_same' : 'applied', ...(same ? {} : { uploaded: a.files.length, removed: current.length }) },
        () => {
          this.locales.add(a.locale);
          this.sets.set(`${a.locale}\u0000${a.target}`, a.files.map((f) => this.#image(f.name, f.bytes)));
        },
        { type: 'asset', locale: a.locale, target: a.target },
      );
    }
    if (b.kind === 'unknown') {
      if (this.readFailsAfterWrite) this.readError = new Error('down');
      throw new DraftOutcomeUnknownError(this.store, 'timed out', [...steps]);
    }
    return { before, steps, commit: this.platform === 'android' && applied > 0 ? 'not_sent_for_review' : 'none' };
  }
}

// ----- the store's submit side: shares the draft of a FakeDraftStore -------------------------------

export type SubmitBehavior =
  | { kind: 'ok' }
  /** The store refuses the submit (nothing was handed to review). */
  | { kind: 'refuse'; error: StoreError }
  /** The write is sent and the store does not answer; `applied` says whether it applied it anyway. */
  | { kind: 'unknown'; applied: boolean };

const IOS_TEXT_DEFAULTS: Record<string, string | null> = { description: 'A description', keywords: 'a,b', promotional_text: null, release_notes: null, marketing_url: null, support_url: 'https://support.example.com' };
const PLAY_TEXT_DEFAULTS: Record<string, string | null> = { title: 'Acme', short_description: 'Short', full_description: 'Full', video: null };

/**
 * What a store shows for a submit: the draft of a `FakeDraftStore` (so a push and a submit see the same store), plus
 * the version's release type, the build, the review state and the tracks. Remembers every submit it was asked for.
 */
export class FakeSubmitStore implements StoreSubmitConnector {
  readonly store: 'appstoreconnect' | 'googleplay';
  readonly platform: Platform;
  readonly draft: FakeDraftStore;
  releaseType: string | null = 'MANUAL';
  build: SubmitState['build'] = { id: 'build-1', version: '45', processingState: 'VALID', expired: false };
  /** The version is in review (App Store). */
  submitted = false;
  openReviewSubmissions: number | null = 0;
  tracks: SubmitTrack[] = [];
  behavior: SubmitBehavior = { kind: 'ok' };
  readError: unknown;
  /** After a submit whose answer was lost, the store cannot be read back. */
  readFailsAfterWrite = false;
  /** Facts of every image the store lists (a test sets other sizes or states). */
  imageSize: [number, number] | undefined;
  imageState: string | null | undefined;
  /** Text values that override the defaults (`locale\0field`; null: not set). */
  textOverrides = new Map<string, string | null>();
  reads = 0;
  submitCalls = 0;
  submissions: string[] = [];
  /** A submit waits for this after the guard accepted: lets a test hold one in flight. */
  gate: Promise<void> | undefined;

  constructor(draft: FakeDraftStore) {
    this.draft = draft;
    this.platform = draft.platform;
    this.store = draft.store;
  }

  #sizeOf(target: string): [number, number] {
    if (this.imageSize) return this.imageSize;
    if (this.platform === 'ios') return [1242, 2688];
    return target === 'icon' ? [512, 512] : [1080, 1920];
  }

  async #state(request: DraftReadRequest): Promise<SubmitState> {
    const ios = this.platform === 'ios';
    const alreadySubmitted = ios && this.submitted;
    const defaults = ios ? IOS_TEXT_DEFAULTS : PLAY_TEXT_DEFAULTS;
    const locales = [...this.draft.locales].sort().map((locale) => {
      const text: Record<string, string | null> = {};
      for (const [field, fallback] of Object.entries(defaults)) {
        const k = `${locale}\u0000${field}`;
        text[field] = this.textOverrides.has(k) ? (this.textOverrides.get(k) as string | null) : (this.draft.texts.get(k) ?? fallback);
      }
      const assets = [...this.draft.sets]
        .filter(([key]) => key.startsWith(`${locale}\u0000`))
        .map(([key, images]) => {
          const target = key.split('\u0000')[1] as string;
          const [width, height] = this.#sizeOf(target);
          const icon = !ios && target === 'icon';
          return {
            kind: icon ? ('icon' as const) : ('screenshot' as const),
            device: icon ? null : ios ? classifyAppleScreenshot(width, height) : 'phone',
            target,
            images: images.map((im) => ({ id: im.id, checksum: im.checksum, width, height, state: this.imageState === undefined ? im.state : this.imageState })),
          };
        });
      return { locale, text, assets };
    });
    const version = this.draft.version
      ? { id: this.draft.version.id, versionString: this.draft.version.versionString, state: alreadySubmitted ? 'WAITING_FOR_REVIEW' : this.draft.version.state, releaseType: this.releaseType }
      : null;
    return {
      store: this.store,
      platform: this.platform,
      version,
      build: ios ? this.build : null,
      alreadySubmitted,
      openReviewSubmissions: ios ? this.openReviewSubmissions : null,
      tracks: structuredClone(this.tracks),
      locales,
      draft: alreadySubmitted ? null : await this.draft.readDraft(request),
    };
  }

  async readSubmitState(request: DraftReadRequest): Promise<SubmitState> {
    this.reads++;
    if (this.readError) throw this.readError;
    return this.#state(request);
  }

  async submit(input: SubmitApplyInput): Promise<SubmitResult> {
    this.reads++;
    if (this.readError) throw this.readError;
    const before = await this.#state(input.request);
    if (!input.guard(before)) throw new SubmitDriftError(before);
    if (before.alreadySubmitted) throw new StoreError(this.store, 'invalid_input', 'The App Store version is already in review.');
    this.submitCalls++;
    if (this.gate) await this.gate;
    const b = this.behavior;
    if (b.kind === 'refuse') throw b.error;
    if (b.kind === 'unknown') {
      if (b.applied) this.#apply();
      if (this.readFailsAfterWrite) this.readError = new Error('down');
      throw new SubmitOutcomeUnknownError(this.store, 'timed out');
    }
    this.#apply();
    const ios = this.platform === 'ios';
    return { before, submissionId: ios ? `sub-${this.submissions.length}` : null, submissionState: ios ? 'WAITING_FOR_REVIEW' : null, via: ios ? 'review_submission' : 'edit_commit' };
  }

  #apply() {
    this.submissions.push(this.platform === 'ios' ? (this.draft.version?.id ?? '') : 'edit');
    if (this.platform === 'ios') this.submitted = true;
  }
}

// ----- booting -----------------------------------------------------------------------------------

export type StagedBootOptions = {
  files?: Files;
  draft?: { enabled?: boolean; timeoutMs?: number; claimTtlMs?: number };
  /** Submitting for review: on by default in tests (the kill switch has its own test). */
  submit?: { enabled?: boolean; timeoutMs?: number; claimTtlMs?: number };
};

export async function bootStaged(db: Database, options: StagedBootOptions = {}) {
  const files: Files = options.files ?? {
    ...weatherApp(),
    'fastlane/metadata/ios/screenshots/en-US/1_iphone65.png': png(...IPHONE_65, { seed: 1 }),
    'fastlane/metadata/ios/screenshots/en-US/2_iphone65.png': png(...IPHONE_65, { seed: 2 }),
    'fastlane/metadata/android/en-US/images/icon.png': png(512, 512, { alpha: true, seed: 3 }),
    'fastlane/metadata/android/en-US/images/phoneScreenshots/1.png': png(1080, 1920, { seed: 4 }),
    'fastlane/metadata/android/en-US/images/phoneScreenshots/2.png': png(1080, 1920, { seed: 5 }),
  };
  clearRepoSnapshots();
  clearAssetIndexes();
  forgetInspectedChangeSets();
  forgetRunningListingReads();
  const repo = new BlobRepo(files);
  const stores = { ios: new FakeDraftStore('ios'), android: new FakeDraftStore('android') };
  const submitStores = { ios: new FakeSubmitStore(stores.ios), android: new FakeSubmitStore(stores.android) };
  const submitBuilt: SubmitConnectorInput[] = [];
  const submitFactory: SubmitConnectorFactory = (input) => {
    submitBuilt.push(input);
    return input.kind === 'app_store_connect' ? submitStores.ios : submitStores.android;
  };
  const readStores = { ios: new FakeStore('ios'), android: new FakeStore('android') };
  const built: DraftConnectorInput[] = [];
  const connectorFactory: DraftConnectorFactory = (input) => {
    built.push(input);
    return input.kind === 'app_store_connect' ? stores.ios : stores.android;
  };
  const syncFactory: StoreConnectorFactory = (input) => (input.kind === 'app_store_connect' ? readStores.ios : readStores.android);
  const t = await bootRepoApp(db, repo, {
    masterKey: randomBytes(32),
    appSync: { connectorFactory: syncFactory },
    listing: { intervalMs: 60 * 60_000 },
    storeDraft: { enabled: true, connectorFactory, ...options.draft },
    storeSubmit: { enabled: true, connectorFactory: submitFactory, ...options.submit },
  });
  const { repositoryId } = await t.connect();
  const iosCredential = await t.addCredential('app_store_connect', ASC_SECRET);
  const playCredential = await t.addCredential('google_play', PLAY_SECRET);
  let appCount = 0;
  const taken: Record<string, number> = {};
  const addApp = async (platform: Platform, name?: string, extra: Record<string, unknown> = {}) => {
    appCount++;
    const res = await t.call(t.owner, 'POST', '/apps', {
      platform,
      identifier: (taken[platform] = (taken[platform] ?? 0) + 1) === 1 ? 'com.acme.app' : `com.acme.app${taken[platform]}`,
      credentialId: platform === 'ios' ? iosCredential : playCredential,
      repositoryId,
      name: name ?? `App ${appCount}`,
      ...extra,
    });
    if (res.status !== 201) throw new Error(`could not add the app: ${res.text}`);
    const id = res.body.app.id as string;
    if (platform === 'ios') await db.execute('UPDATE apps SET store_app_id = ? WHERE id = ?', ['1234567890', id]);
    return id;
  };
  const sp = (appId: string, rest = '') => `/apps/${appId}/staged${rest}`;
  const view = async (appId: string, cookie = t.owner) => (await t.call(cookie, 'GET', sp(appId))).body.staged as StagedChangesView;
  const stageText = (appId: string, body: Record<string, unknown>, cookie = t.owner) => t.call(cookie, 'PUT', sp(appId, '/text'), body);
  const stageAssets = (appId: string, body: Record<string, unknown>, cookie = t.owner) => t.call(cookie, 'PUT', sp(appId, '/assets'), body);
  const unstage = (appId: string, id: string, cookie = t.owner) => t.call(cookie, 'DELETE', sp(appId, `/items?id=${encodeURIComponent(id)}`));
  const clear = (appId: string, cookie = t.owner) => t.call(cookie, 'DELETE', sp(appId));
  const preview = (appId: string, cookie = t.owner) => t.call(cookie, 'POST', sp(appId, '/push/preview'), {});
  const push = (appId: string, confirmHash: string, cookie = t.owner) => t.call(cookie, 'POST', sp(appId, '/push'), { confirmHash });
  /** Preview, then push with its hash. */
  const previewAndPush = async (appId: string, cookie = t.owner) => {
    const p = await preview(appId, cookie);
    if (p.status !== 200) return { preview: p, push: p };
    return { preview: p, push: await push(appId, p.body.preview.confirmHash, cookie) };
  };
  const events = async (type?: string) =>
    (await t.call(t.owner, 'GET', `/events?since=0&limit=200${type ? `&type=${type}` : ''}`)).body.events as { type: string; payload: Record<string, unknown> }[];
  const audit = async (like = '%') =>
    (await db.query('SELECT action, actor_type, detail FROM audit_events WHERE action LIKE ? ORDER BY created_at, id', [like])).map((r) => ({
      action: String(r.action),
      actorType: String(r.actor_type),
      detail: JSON.parse(String(r.detail ?? '{}')) as Record<string, unknown>,
    }));
  const claim = async (appId: string) => (await db.query('SELECT * FROM store_draft_claims WHERE app_id = ?', [appId]))[0];
  const rows = async (appId: string) => db.query('SELECT * FROM staged_changes WHERE app_id = ? ORDER BY locale, kind, target, ordinal', [appId]);
  const sub = (appId: string, rest = '') => `/apps/${appId}/store-submit${rest}`;
  const submitState = (appId: string, cookie = t.owner) => t.call(cookie, 'GET', sub(appId));
  const submitPreview = (appId: string, cookie = t.owner) => t.call(cookie, 'POST', sub(appId, '/preview'), {});
  const submitApply = (appId: string, body: Record<string, unknown>, cookie = t.owner) => t.call(cookie, 'POST', sub(appId), body);
  /** Preview, then submit with its hash and typed phrase. */
  const previewAndSubmit = async (appId: string, cookie = t.owner) => {
    const p = await submitPreview(appId, cookie);
    if (p.status !== 200 || !p.body.preview.confirmHash) return { preview: p, submit: p };
    return { preview: p, submit: await submitApply(appId, { confirmHash: p.body.preview.confirmHash, confirmation: p.body.preview.confirmation.phrase }, cookie) };
  };
  const submitClaim = async (appId: string) => (await db.query('SELECT * FROM store_submit_claims WHERE app_id = ?', [appId]))[0];
  const pushRecord = async (appId: string) => (await db.query('SELECT * FROM store_draft_pushes WHERE app_id = ?', [appId]))[0];
  return { ...t, repo, files, stores, submitStores, submitBuilt, sub, submitState, submitPreview, submitApply, previewAndSubmit, submitClaim, pushRecord, readStores, built, repositoryId, iosCredential, playCredential, addApp, sp, view, stageText, stageAssets, unstage, clear, preview, push, previewAndPush, events, audit, claim, rows };
}

export type StagedBoot = Awaited<ReturnType<typeof bootStaged>>;
