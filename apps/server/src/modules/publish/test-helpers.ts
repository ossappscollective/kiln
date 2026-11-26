import { createHash, randomBytes } from 'node:crypto';
import {
  APPLE_RELEASABLE_STATE,
  type BlobHeadItem,
  type BlobHeads,
  type BlobHeadsOptions,
  type BlobListing,
  type BlobReads,
  type DraftApplyInput,
  type DraftApplyResult,
  type DraftAssetState,
  DraftDriftError,
  type DraftFieldFacts,
  type DraftImageState,
  DraftOutcomeUnknownError,
  DraftPartialError,
  type DraftProgress,
  type DraftReadRequest,
  type DraftState,
  type DraftStep,
  type EditableRelease,
  type NotesHistoryRead,
  type PlayCheckRelease,
  type PlayCheckResult,
  type PlayReleaseState,
  type ReleaseApplyInput,
  type ReleaseCandidates,
  ReleaseDriftError,
  ReleaseOutcomeUnknownError,
  type ReleaseRequest,
  type ReleaseResult,
  type ReleaseState,
  type StoreDraftConnector,
  StoreError,
  type StoreImageReader,
  type StoreImageRecord,
  type StoreImagesRead,
  type StoreReleaseConnector,
  type StoreReleaseReader,
  type StoreSubmitConnector,
  type SubmitApplyInput,
  SubmitDriftError,
  SubmitOutcomeUnknownError,
  type SubmitResult,
  type SubmitState,
  type SubmitTrack,
  setMatches,
} from '@kiln/connectors';
import { classifyAppleScreenshot, type Platform, type StagedChangesView } from '@kiln/core';
import type { Database } from '@kiln/db';
import { weatherApp } from '../../../../../packages/connectors/src/fastlane.fixtures.ts';
import { bootRepoApp, FakeRepo } from '../../repo-test-helpers.ts';
import type { StoreConnectorFactory } from '../../services/apps.ts';
import { clearRepoSnapshots } from '../../services/repo-snapshot.ts';
import { clearAssetIndexes } from '../listing/asset-repo.ts';
import { forgetInspectedChangeSets } from '../listing/repo.ts';
import { forgetRunningListingReads } from '../listing/schedule.ts';
import { ASC_SECRET, FakeStore, PLAY_SECRET } from '../listing/test-helpers.ts';
import type { DraftConnectorFactory, DraftConnectorInput } from './store-draft.ts';
import type { ReleaseConnectorFactory, ReleaseConnectorInput } from './store-release.ts';
import type { SubmitConnectorFactory, SubmitConnectorInput } from './store-submit.ts';

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

export function png(
  width: number,
  height: number,
  options: { alpha?: boolean; seed?: number; pad?: number } = {},
): Buffer {
  const colour = options.alpha ? 6 : 2;
  const ihdr = [
    ...be32(13),
    ...text('IHDR'),
    ...be32(width),
    ...be32(height),
    8,
    colour,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
  const idat = [...be32(4), ...text('IDAT'), options.seed ?? 0, 2, 3, 4, 0, 0, 0, 0];
  const head = Buffer.from([0x89, ...text('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...idat]);
  return options.pad ? Buffer.concat([head, Buffer.alloc(options.pad, 7)]) : head;
}
export function jpeg(width: number, height: number): Buffer {
  const app0 = [0xff, 0xe0, ...be16(16), ...text('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const frame = [
    0xff,
    0xc0,
    ...be16(17),
    8,
    ...be16(height),
    ...be16(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ];
  return Buffer.from([0xff, 0xd8, ...app0, ...frame, 0xff, 0xda, 0, 0]);
}

export const IPHONE_65 = [1242, 2688] as const;
export const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex');
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// ----- the repository ----------------------------------------------------------------------------

const blobId = (bytes: Buffer) =>
  createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

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
    return {
      commit: this.commit,
      entries: [...this.blobs].map(([path, bytes]) => ({
        path,
        oid: blobId(bytes),
        mode: '100644',
        size: bytes.length,
      })),
    };
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
      items.set(path, {
        ok: true,
        oid: this.swapped.has(path) ? blobId(bytes) : oid,
        size: bytes.length,
        head: new Uint8Array(bytes.subarray(0, take)),
      });
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
export class FakeDraftStore implements StoreDraftConnector, StoreImageReader, StoreReleaseReader {
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
  /** What `readStoreImages` answers (a test's starting point), and how often it was asked. */
  imageRecords: StoreImageRecord[] = [];
  imageReads = 0;
  imageReadError: unknown;
  applyCalls = 0;
  /** Release fields the draft holds (`locale\0field`, canonical text). */
  fields = new Map<string, string>();
  /** Facts a read of a release field answers with, by field (a test overrides them). */
  fieldFacts = new Map<string, DraftFieldFacts>();
  /** What `listReleaseCandidates` and `readEditableRelease` answer (a test's starting point), and how often they were asked. */
  candidates: ReleaseCandidates | undefined;
  editable: EditableRelease | undefined;
  releaseReads = 0;
  releaseReadError: unknown;
  /** What `readNotesHistory` answers (a test sets it), how often it was asked, and what it throws. */
  notesHistory: NotesHistoryRead = { entries: [], truncated: false, versionsRead: 0, failed: 0 };
  notesHistoryReads = 0;
  notesHistoryLocales: (string | undefined)[] = [];
  notesHistoryError: unknown;
  /** What the store was asked to write (names and checksums, never bytes). */
  writes: {
    text: { locale: string; field: string }[];
    sets: { locale: string; target: string; files: string[] }[];
    fields?: { locale: string; field: string; value: string }[];
  }[] = [];
  /** The most recent `applyDraft` input, with the bytes. */
  lastInput: DraftApplyInput | undefined;
  /** A write waits for this after the guard accepted: lets a test hold a write in flight. */
  gate: Promise<void> | undefined;
  /** The progress lines `applyDraft` reports before it waits on the gate (tests). */
  progressLines: DraftProgress[] = [];
  #n = 0;

  constructor(platform: Platform) {
    this.platform = platform;
    this.store = platform === 'ios' ? 'appstoreconnect' : 'googleplay';
    this.version =
      platform === 'ios'
        ? { id: 'v-next', versionString: '2.1', state: 'PREPARE_FOR_SUBMISSION' }
        : null;
    this.texts.set(key('en-US', platform === 'ios' ? 'description' : 'title'), 'Old text');
  }

  #kind(): 'md5' | 'sha256' {
    return this.platform === 'ios' ? 'md5' : 'sha256';
  }
  /** Puts a set into the draft (a test's starting point). */
  seedSet(locale: string, target: string, files: { name: string; bytes: Uint8Array }[]): void {
    this.sets.set(
      `${locale}\u0000${target}`,
      files.map((f) => this.#image(f.name, f.bytes)),
    );
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

  #facts(field: string): DraftFieldFacts | undefined {
    const set = this.fieldFacts.get(field);
    if (set) return set;
    if (field === 'build')
      return {
        currentNumber: '57',
        wantedFound: true,
        wantedNumber: '58',
        wantedProcessingState: 'VALID',
        wantedExpired: false,
      };
    if (field === 'version_codes') return { missing: '' };
    if (field === 'track') return { draftCount: 1, otherInProgress: 0 };
    return undefined;
  }

  async listReleaseCandidates(): Promise<ReleaseCandidates> {
    this.releaseReads++;
    if (this.releaseReadError) throw this.releaseReadError;
    return structuredClone(
      this.candidates ??
        (this.platform === 'android'
          ? {
              store: 'googleplay' as const,
              platform: 'android' as const,
              track: 'production',
              codes: [
                {
                  versionCode: '241',
                  source: 'bundle' as const,
                  sha256: 'a'.repeat(64),
                  inTrack: [],
                  eligibility: {
                    eligible: true,
                    severity: 'ok' as const,
                    code: 'ok' as const,
                    message:
                      'Version code 241 was uploaded and is not in a release of this track yet.',
                  },
                },
              ],
            }
          : {
              store: 'appstoreconnect' as const,
              platform: this.platform,
              version: this.version
                ? {
                    id: this.version.id,
                    versionString: this.version.versionString,
                    state: this.version.state,
                  }
                : null,
              builds: [
                {
                  id: 'b-2',
                  buildNumber: '58',
                  version: '2.1',
                  uploadedDate: '2026-11-18T09:00:00-08:00',
                  processingState: 'VALID',
                  expired: false,
                  selectable: true,
                  reason: null,
                  attached: false,
                  eligibility: {
                    eligible: true,
                    severity: 'ok' as const,
                    code: 'ok' as const,
                    message: 'Build 58 is processed and can be attached to version 2.1.',
                  },
                  exportCompliance: 'unknown' as const,
                  testNotes: {
                    read: true,
                    locales: [{ locale: 'en-US', text: 'Try the new login', truncated: false }],
                  },
                },
              ],
              attachedBuildId: null,
              truncatedAt: null,
            }),
    );
  }

  async readNotesHistory(
    input: { locale?: string; maxVersions?: number } = {},
  ): Promise<NotesHistoryRead> {
    this.notesHistoryReads++;
    this.notesHistoryLocales.push(input.locale);
    if (this.notesHistoryError) throw this.notesHistoryError;
    return structuredClone(this.notesHistory);
  }

  async readEditableRelease(): Promise<EditableRelease> {
    this.releaseReads++;
    if (this.releaseReadError) throw this.releaseReadError;
    return structuredClone(
      this.editable ??
        (this.platform === 'android'
          ? {
              store: 'googleplay' as const,
              platform: 'android' as const,
              track: 'production',
              draft: null,
              others: [],
            }
          : {
              store: 'appstoreconnect' as const,
              platform: this.platform,
              version: {
                id: 'v-next',
                versionString: '2.1',
                state: 'PREPARE_FOR_SUBMISSION',
                editable: true as const,
              },
              releaseType: 'MANUAL',
              earliestReleaseDate: null,
              copyright: null,
              build: null,
              phasedRelease: null,
              releaseNotes: [],
            }),
    );
  }

  #state(request: DraftReadRequest): DraftState {
    const assets: DraftAssetState[] = request.assets.map((s) => {
      const images = this.sets.get(`${s.locale}\u0000${s.target}`);
      return {
        locale: s.locale,
        kind: s.kind,
        device: s.device,
        target: s.target,
        setExists: this.platform === 'android' || images !== undefined,
        images: structuredClone(images ?? []),
      };
    });
    return {
      store: this.store,
      platform: this.platform,
      version: this.version ? { ...this.version } : null,
      text: request.text.map((t) => ({
        locale: t.locale,
        field: t.field,
        value: this.texts.get(key(t.locale, t.field)) ?? null,
        localeExists: this.locales.has(t.locale),
      })),
      assets,
      ...(request.fields !== undefined
        ? {
            fields: request.fields.map((f) => ({
              field: f.field,
              locale: f.locale,
              value: this.fields.get(key(f.locale, f.field)) ?? null,
              ...(this.#facts(f.field) ? { facts: { ...this.#facts(f.field) } } : {}),
            })),
          }
        : {}),
    };
  }

  async readStoreImages(): Promise<StoreImagesRead> {
    this.imageReads++;
    if (this.imageReadError) throw this.imageReadError;
    return {
      version: this.version
        ? {
            id: this.version.id,
            versionString: this.version.versionString,
            state: this.version.state,
            editable: true,
          }
        : null,
      images: structuredClone(this.imageRecords),
      unplaced: 0,
      notes: [],
    };
  }

  async readDraft(request: DraftReadRequest): Promise<DraftState> {
    this.reads++;
    if (this.readError) throw this.readError;
    return this.#state(request);
  }

  /**
   * Google Play that will not keep this app's changes as a draft: `applyDraft` is refused like Google does (`draft_not_allowed`, nothing
   * written), `pushAndSubmit` commits and sends for review.
   */
  draftRefused = false;
  /** How many times `pushAndSubmit` was called, and how many of them sent changes for review. */
  pushAndSubmitCalls = 0;
  sentForReview = 0;
  /** Google Play has changes in review: a commit that sends for review is refused (`changes_in_review`) unless it replaces the review. */
  inReview = false;
  /** How many commits cancelled a review in progress (`CANCEL_IN_REVIEW_AND_SUBMIT`). */
  reviewsReplaced = 0;
  /** The releases the combined step made in its own commit (track, codes, share). */
  releasesMade: { track: string; versionCodes: string[]; userFraction: number }[] = [];

  async applyDraft(input: DraftApplyInput): Promise<DraftApplyResult> {
    return this.#apply(input, false);
  }

  async pushAndSubmit(input: DraftApplyInput): Promise<DraftApplyResult> {
    this.pushAndSubmitCalls++;
    return this.#apply(input, true);
  }

  async #apply(input: DraftApplyInput, review: boolean): Promise<DraftApplyResult> {
    this.applyCalls++;
    this.lastInput = input;
    const request: DraftReadRequest = {
      text: input.text.map((t) => ({ locale: t.locale, field: t.field })),
      assets: input.assets.map((a) => ({
        locale: a.locale,
        kind: a.kind,
        device: a.device,
        target: a.target,
      })),
      ...(input.fields !== undefined ? { fields: input.fields } : {}),
    };
    const before = this.#state(request);
    if (!input.guard(before)) throw new DraftDriftError(before);
    this.writes.push({
      text: input.text.map((t) => ({ locale: t.locale, field: t.field })),
      sets: input.assets.map((a) => ({
        locale: a.locale,
        target: a.target,
        files: a.files.map((f) => `${f.name}:${f.md5}`),
      })),
      ...(input.fields ? { fields: input.fields.map((f) => ({ ...f })) } : {}),
    });
    // What a long push says about itself (the batch writes it on the claim): the lines a test set, before the step waits.
    for (const line of this.progressLines) input.progress?.({ ...line });
    if (this.gate) await this.gate;
    const b = this.behavior;
    const steps: DraftStep[] = [];
    let applied = 0;
    if (review && this.inReview && input.replaceReview !== true) {
      // Google refuses the ONE commit while changes are in review, and nothing of the edit is applied.
      this.writes.pop();
      throw new StoreError(
        'googleplay',
        'changes_in_review',
        'Google Play has changes in review for this app, and this server does not cancel a review. Wait for the review to finish (or cancel it in Play Console) and try again. Nothing was changed.',
        400,
        [
          {
            code: 'CHANGES_ALREADY_IN_REVIEW',
            detail:
              'You already have changes in review. Cancel this review or wait for it to complete before you try again.',
          },
        ],
      );
    }
    if (this.draftRefused && !review) {
      this.writes.pop();
      throw new StoreError(
        'googleplay',
        'draft_not_allowed',
        'Google Play sends the changes of this app for review automatically, so it cannot keep them as a draft, and nothing was committed.',
        400,
        [
          {
            detail:
              'Changes are sent for review automatically. The query parameter changesNotSentForReview must not be set.',
          },
        ],
        { code: 'store.google.draftNotAllowed' },
      );
    }
    const apply = (
      step: DraftStep,
      change: () => void,
      at: { type: DraftStep['type']; locale: string; target: string },
    ) => {
      if (step.outcome === 'applied') {
        if (b.kind === 'refuse')
          throw applied === 0 ? b.error : new DraftPartialError(b.error, [...steps], at);
        if (b.kind === 'partial' && applied >= b.after)
          throw applied === 0 ? b.error : new DraftPartialError(b.error, [...steps], at);
        if (
          b.kind === 'unknown' &&
          (b.applied === false || (b.applied === 'first' && applied >= 1))
        )
          throw new DraftOutcomeUnknownError(this.store, 'timed out', [...steps]);
        change();
        applied++;
      }
      steps.push(step);
    };
    for (const t of input.text) {
      const same = this.texts.get(key(t.locale, t.field)) === t.value;
      apply(
        {
          type: 'text',
          locale: t.locale,
          target: t.field,
          outcome: same ? 'already_same' : 'applied',
        },
        () => {
          this.locales.add(t.locale);
          this.texts.set(key(t.locale, t.field), t.value);
        },
        { type: 'text', locale: t.locale, target: t.field },
      );
    }
    for (const f of input.fields ?? []) {
      const same = this.fields.get(key(f.locale, f.field)) === f.value;
      apply(
        {
          type: 'field',
          locale: f.locale,
          target: f.field,
          outcome: same ? 'already_same' : 'applied',
        },
        () => this.fields.set(key(f.locale, f.field), f.value),
        { type: 'field', locale: f.locale, target: f.field },
      );
    }
    for (const a of input.assets) {
      const current = this.sets.get(`${a.locale}\u0000${a.target}`) ?? [];
      const same = setMatches(current, a.files);
      apply(
        {
          type: 'asset',
          locale: a.locale,
          target: a.target,
          outcome: same ? 'already_same' : 'applied',
          ...(same ? {} : { uploaded: a.files.length, removed: current.length }),
        },
        () => {
          this.locales.add(a.locale);
          this.sets.set(
            `${a.locale}\u0000${a.target}`,
            a.files.map((f) => this.#image(f.name, f.bytes)),
          );
        },
        { type: 'asset', locale: a.locale, target: a.target },
      );
    }
    if (input.start !== undefined) {
      const track = input.fields?.find((f) => f.field === 'track')?.value ?? '';
      const codes = (input.fields?.find((f) => f.field === 'version_codes')?.value ?? '')
        .split(',')
        .filter(Boolean);
      apply(
        { type: 'field', locale: '', target: 'release_start', outcome: 'applied' },
        () =>
          this.releasesMade.push({
            track,
            versionCodes: codes,
            userFraction: input.start?.userFraction ?? 1,
          }),
        { type: 'field', locale: '', target: 'release_start' },
      );
    }
    if (b.kind === 'unknown') {
      if (this.readFailsAfterWrite) this.readError = new Error('down');
      throw new DraftOutcomeUnknownError(this.store, 'timed out', [...steps]);
    }
    if (review && input.replaceReview === true && this.inReview) {
      this.reviewsReplaced++;
      this.inReview = false;
    }
    if (review && applied > 0) this.sentForReview++;
    return {
      before,
      steps,
      commit:
        this.platform === 'android' && applied > 0
          ? review
            ? 'sent_for_review'
            : 'not_sent_for_review'
          : 'none',
    };
  }
}

// ----- the store's submit side: shares the draft of a FakeDraftStore -------------------------------

export type SubmitBehavior =
  | { kind: 'ok' }
  /** The store refuses the submit (nothing was handed to review). */
  | { kind: 'refuse'; error: StoreError }
  /** The write is sent and the store does not answer; `applied` says whether it applied it anyway. */
  | { kind: 'unknown'; applied: boolean };

const IOS_TEXT_DEFAULTS: Record<string, string | null> = {
  description: 'A description',
  keywords: 'a,b',
  promotional_text: null,
  release_notes: null,
  marketing_url: null,
  support_url: 'https://support.example.com',
};
const PLAY_TEXT_DEFAULTS: Record<string, string | null> = {
  title: 'Acme',
  short_description: 'Short',
  full_description: 'Full',
  video: null,
};

/**
 * What a store shows for a submit: the draft of a `FakeDraftStore` (so a push and a submit see the same store), plus
 * the version's release type, the build, the review state and the tracks. Remembers every submit it was asked for.
 */
export class FakeSubmitStore implements StoreSubmitConnector {
  readonly store: 'appstoreconnect' | 'googleplay';
  readonly platform: Platform;
  readonly draft: FakeDraftStore;
  releaseType: string | null = 'MANUAL';
  build: SubmitState['build'] = {
    id: 'build-1',
    version: '45',
    processingState: 'VALID',
    expired: false,
  };
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
        text[field] = this.textOverrides.has(k)
          ? (this.textOverrides.get(k) as string | null)
          : (this.draft.texts.get(k) ?? fallback);
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
            images: images.map((im) => ({
              id: im.id,
              checksum: im.checksum,
              width,
              height,
              state: this.imageState === undefined ? im.state : this.imageState,
            })),
          };
        });
      return { locale, text, assets };
    });
    const version = this.draft.version
      ? {
          id: this.draft.version.id,
          versionString: this.draft.version.versionString,
          state: alreadySubmitted ? 'WAITING_FOR_REVIEW' : this.draft.version.state,
          releaseType: this.releaseType,
        }
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
    if (before.alreadySubmitted)
      throw new StoreError(
        this.store,
        'invalid_input',
        'The App Store version is already in review.',
      );
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
    return {
      before,
      submissionId: ios ? `sub-${this.submissions.length}` : null,
      submissionState: ios ? 'WAITING_FOR_REVIEW' : null,
      via: ios ? 'review_submission' : 'edit_commit',
    };
  }

  #apply() {
    this.submissions.push(this.platform === 'ios' ? (this.draft.version?.id ?? '') : 'edit');
    if (this.platform === 'ios') this.submitted = true;
  }
}

// ----- the store's release side --------------------------------------------------------------------

export type ReleaseBehavior =
  | { kind: 'ok' }
  /** The store refuses the release (nothing was released). */
  | { kind: 'refuse'; error: StoreError }
  /** The write is sent and the store does not answer; `applied` says whether it applied it anyway. */
  | { kind: 'unknown'; applied: boolean };

type FakeVersion = { id: string; versionString: string; state: string; releaseType: string | null };

/**
 * What a store shows for a release: App Store versions (one waits for release), or the releases of a Google Play track (one
 * draft). Remembers every release it was asked for and can be told how to fail.
 */
export class FakeReleaseStore implements StoreReleaseConnector {
  readonly store: 'appstoreconnect' | 'googleplay';
  readonly platform: Platform;
  versions: FakeVersion[];
  build: {
    id: string;
    buildNumber: string | null;
    processingState: string | null;
    expired: boolean | null;
  } | null = { id: 'b-1', buildNumber: '57', processingState: 'VALID', expired: false };
  phased: { id: string; state: string | null } | null = null;
  track = 'production';
  releases: PlayReleaseState[];
  /** Version codes Google Play lists as uploaded. */
  uploaded = new Set<string>(['200', '240', '241']);
  behavior: ReleaseBehavior = { kind: 'ok' };
  readError: unknown;
  /** After a release whose answer was lost, the store cannot be read back. */
  readFailsAfterWrite = false;
  reads = 0;
  releaseCalls = 0;
  /** What was released: version ids (App Store) or `track:codes:fraction` (Google Play). */
  released: string[] = [];
  /** The builds the direct releases were made from (Google Play). */
  builds: { name: string | null; notes: { locale: string; text: string }[] }[] = [];
  gate: Promise<void> | undefined;

  constructor(platform: Platform) {
    this.platform = platform;
    this.store = platform === 'android' ? 'googleplay' : 'appstoreconnect';
    this.versions =
      platform === 'android'
        ? []
        : [
            {
              id: 'v-live',
              versionString: '2.0',
              state: 'READY_FOR_DISTRIBUTION',
              releaseType: 'MANUAL',
            },
            {
              id: 'v-next',
              versionString: '2.1',
              state: APPLE_RELEASABLE_STATE,
              releaseType: 'MANUAL',
            },
          ];
    this.releases =
      platform === 'android'
        ? [
            {
              name: '2.0',
              status: 'completed',
              userFraction: null,
              versionCodes: ['200'],
              notes: 1,
            },
            { name: '2.1', status: 'draft', userFraction: null, versionCodes: ['241'], notes: 1 },
          ]
        : [];
  }

  #state(request: ReleaseRequest): ReleaseState {
    if (this.platform === 'android') {
      const codes = request.versionCodes?.map(String);
      const same = (a: string[], b: string[]) =>
        [...a].sort().join(',') === [...b].sort().join(',');
      const drafts = this.releases.filter((r) => r.status === 'draft');
      const matching =
        codes && codes.length > 0 ? drafts.filter((r) => same(r.versionCodes, codes)) : drafts;
      const target = matching.length === 1 ? matching[0] : undefined;
      // A direct release (request.build): no draft with the codes means the release is made from the build.
      const creates =
        request.build !== undefined &&
        codes !== undefined &&
        codes.length > 0 &&
        matching.length === 0;
      const made: PlayReleaseState | null =
        creates && request.build
          ? {
              name: request.build.name,
              status: 'draft',
              userFraction: null,
              versionCodes: [...(codes ?? [])],
              notes: request.build.notes.filter((n) => n.text.trim() !== '').length,
            }
          : null;
      const release = target ? { ...target, versionCodes: [...target.versionCodes] } : made;
      return {
        store: 'googleplay',
        platform: 'android',
        track: request.track ?? this.track,
        release,
        ambiguous: matching.length > 1,
        creates,
        others: this.releases
          .filter((r) => r !== target)
          .map((r) => ({ ...r, versionCodes: [...r.versionCodes] })),
        missingCodes: release ? release.versionCodes.filter((c) => !this.uploaded.has(c)) : [],
      };
    }
    const named = request.version;
    const pool =
      named === undefined
        ? this.versions.filter((v) => v.state === APPLE_RELEASABLE_STATE)
        : this.versions.filter((v) => v.versionString === named);
    const waiting = pool.filter((v) => v.state === APPLE_RELEASABLE_STATE);
    const chosen =
      waiting.length === 1
        ? waiting[0]
        : named !== undefined && pool.length === 1 && waiting.length === 0
          ? pool[0]
          : undefined;
    return {
      store: 'appstoreconnect',
      platform: this.platform,
      version: chosen
        ? {
            id: chosen.id,
            versionString: chosen.versionString,
            state: chosen.state,
            releaseType: chosen.releaseType,
          }
        : null,
      releasable: chosen !== undefined && chosen.state === APPLE_RELEASABLE_STATE,
      ambiguous: waiting.length > 1,
      build: chosen ? (this.build ? { ...this.build } : null) : null,
      phasedRelease: chosen ? (this.phased ? { ...this.phased } : null) : null,
      versions: this.versions.map((v) => ({ versionString: v.versionString, state: v.state })),
    };
  }

  async readReleaseState(request: ReleaseRequest): Promise<ReleaseState> {
    this.reads++;
    if (this.readError) throw this.readError;
    return this.#state(request);
  }

  /** "Check with Google Play": what was asked, what the fake store answers, and how it can fail. */
  checks: PlayCheckRelease[] = [];
  checkResult: PlayCheckResult = { outcome: 'no_errors', findings: [] };
  checkError: unknown;
  async checkPlayRelease(input: PlayCheckRelease): Promise<PlayCheckResult> {
    this.checks.push(structuredClone(input));
    if (this.checkError) throw this.checkError;
    return structuredClone(this.checkResult);
  }

  async release(input: ReleaseApplyInput): Promise<ReleaseResult> {
    this.reads++;
    if (this.readError) throw this.readError;
    const before = this.#state(input.request);
    if (!input.guard(before)) throw new ReleaseDriftError(before);
    this.releaseCalls++;
    if (this.gate) await this.gate;
    const b = this.behavior;
    if (b.kind === 'refuse') throw b.error;
    if (b.kind === 'unknown') {
      if (b.applied) this.#apply(input.request, before);
      if (this.readFailsAfterWrite) this.readError = new Error('down');
      throw new ReleaseOutcomeUnknownError(this.store, 'timed out');
    }
    this.#apply(input.request, before);
    return {
      before,
      releaseRequestId: this.platform === 'android' ? null : `rel-${this.released.length}`,
      via: this.platform === 'android' ? 'edit_commit' : 'release_request',
    };
  }

  #apply(request: ReleaseRequest, before: ReleaseState) {
    if (before.store === 'appstoreconnect') {
      const v = this.versions.find((x) => x.id === before.version?.id);
      if (v) v.state = 'PROCESSING_FOR_APP_STORE';
      this.released.push(before.version?.id ?? '');
      return;
    }
    const target = this.releases.find(
      (r) =>
        r.status === 'draft' &&
        before.release !== null &&
        r.versionCodes.join(',') === before.release.versionCodes.join(','),
    );
    const fraction = request.userFraction ?? 0;
    if (before.creates && before.release && request.build) {
      this.builds.push(structuredClone(request.build));
      this.releases.push({
        name: request.build.name,
        status: fraction === 1 ? 'completed' : 'inProgress',
        userFraction: fraction === 1 ? null : fraction,
        versionCodes: [...before.release.versionCodes],
        notes: before.release.notes,
      });
    } else if (target) {
      target.status = fraction === 1 ? 'completed' : 'inProgress';
      target.userFraction = fraction === 1 ? null : fraction;
    }
    this.released.push(
      `${before.track}:${before.release?.versionCodes.join(',') ?? ''}:${fraction}`,
    );
  }
}

// ----- booting -----------------------------------------------------------------------------------

export type StagedBootOptions = {
  files?: Files;
  draft?: { enabled?: boolean; timeoutMs?: number; claimTtlMs?: number };
  /** Submitting for review: on by default in tests (the kill switch has its own test). */
  submit?: { enabled?: boolean; timeoutMs?: number; claimTtlMs?: number };
  /** Releasing: on by default in tests (the kill switch has its own test). */
  release?: { enabled?: boolean; timeoutMs?: number; claimTtlMs?: number };
  /** More options of the app (the exchange of the image downloads, limiters). */
  extra?: Record<string, unknown>;
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
  // A Google Play listing the store would accept for review: two phone screenshots (the plan judges the draft a push leaves, and a draft
  // with no screenshot at all cannot be submitted). A test about a bare listing empties it (`stores.android.sets.clear()`).
  stores.android.seedSet('en-US', 'phoneScreenshots', [
    { name: 'a.png', bytes: new Uint8Array([1, 2, 3]) },
    { name: 'b.png', bytes: new Uint8Array([4, 5, 6]) },
  ]);
  const submitStores = {
    ios: new FakeSubmitStore(stores.ios),
    android: new FakeSubmitStore(stores.android),
  };
  const submitBuilt: SubmitConnectorInput[] = [];
  const submitFactory: SubmitConnectorFactory = (input) => {
    submitBuilt.push(input);
    return input.kind === 'app_store_connect' ? submitStores.ios : submitStores.android;
  };
  const releaseStores = {
    ios: new FakeReleaseStore('ios'),
    android: new FakeReleaseStore('android'),
    macos: new FakeReleaseStore('macos'),
  };
  const releaseBuilt: ReleaseConnectorInput[] = [];
  const releaseFactory: ReleaseConnectorFactory = (input) => {
    releaseBuilt.push(input);
    return input.kind === 'app_store_connect'
      ? input.platform === 'macos'
        ? releaseStores.macos
        : releaseStores.ios
      : releaseStores.android;
  };
  const readStores = { ios: new FakeStore('ios'), android: new FakeStore('android') };
  const built: DraftConnectorInput[] = [];
  const connectorFactory: DraftConnectorFactory = (input) => {
    built.push(input);
    return input.kind === 'app_store_connect' ? stores.ios : stores.android;
  };
  const syncFactory: StoreConnectorFactory = (input) =>
    input.kind === 'app_store_connect' ? readStores.ios : readStores.android;
  const t = await bootRepoApp(db, repo, {
    masterKey: randomBytes(32),
    appSync: { connectorFactory: syncFactory },
    listing: { intervalMs: 60 * 60_000 },
    storeDraft: { enabled: true, connectorFactory, ...options.draft },
    storeSubmit: { enabled: true, connectorFactory: submitFactory, ...options.submit },
    storeRelease: { enabled: true, connectorFactory: releaseFactory, ...options.release },
    ...(options.extra ?? {}),
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
      identifier:
        (taken[platform] = (taken[platform] ?? 0) + 1) === 1
          ? 'com.acme.app'
          : `com.acme.app${taken[platform]}`,
      credentialId: platform === 'ios' ? iosCredential : playCredential,
      repositoryId,
      name: name ?? `App ${appCount}`,
      ...extra,
    });
    if (res.status !== 201) throw new Error(`could not add the app: ${res.text}`);
    const id = res.body.app.id as string;
    if (platform === 'ios')
      await db.execute('UPDATE apps SET store_app_id = ? WHERE id = ?', ['1234567890', id]);
    return id;
  };
  const sp = (appId: string, rest = '') => `/apps/${appId}/staged${rest}`;
  const view = async (appId: string, cookie = t.owner) =>
    (await t.call(cookie, 'GET', sp(appId))).body.staged as StagedChangesView;
  const stageText = (appId: string, body: Record<string, unknown>, cookie = t.owner) =>
    t.call(cookie, 'PUT', sp(appId, '/text'), body);
  const stageAssets = (appId: string, body: Record<string, unknown>, cookie = t.owner) =>
    t.call(cookie, 'PUT', sp(appId, '/assets'), body);
  const unstage = (appId: string, id: string, cookie = t.owner) =>
    t.call(cookie, 'DELETE', sp(appId, `/items?id=${encodeURIComponent(id)}`));
  const clear = (appId: string, cookie = t.owner) => t.call(cookie, 'DELETE', sp(appId));
  const preview = (appId: string, cookie = t.owner) =>
    t.call(cookie, 'POST', sp(appId, '/push/preview'), {});
  const push = (appId: string, confirmHash: string, cookie = t.owner) =>
    t.call(cookie, 'POST', sp(appId, '/push'), { confirmHash });
  /** Preview, then push with its hash. */
  const previewAndPush = async (appId: string, cookie = t.owner) => {
    const p = await preview(appId, cookie);
    if (p.status !== 200) return { preview: p, push: p };
    return { preview: p, push: await push(appId, p.body.preview.confirmHash, cookie) };
  };
  const events = async (type?: string) =>
    (await t.call(t.owner, 'GET', `/events?since=0&limit=200${type ? `&type=${type}` : ''}`)).body
      .events as { type: string; payload: Record<string, unknown> }[];
  const audit = async (like = '%') =>
    (
      await db.query(
        'SELECT action, actor_type, detail FROM audit_events WHERE action LIKE ? ORDER BY created_at, id',
        [like],
      )
    ).map((r) => ({
      action: String(r.action),
      actorType: String(r.actor_type),
      detail: JSON.parse(String(r.detail ?? '{}')) as Record<string, unknown>,
    }));
  const claim = async (appId: string) =>
    (await db.query('SELECT * FROM store_draft_claims WHERE app_id = ?', [appId]))[0];
  const rows = async (appId: string) =>
    db.query(
      'SELECT * FROM staged_changes WHERE app_id = ? ORDER BY locale, kind, target, ordinal',
      [appId],
    );
  const sub = (appId: string, rest = '') => `/apps/${appId}/store-submit${rest}`;
  const submitState = (appId: string, cookie = t.owner) => t.call(cookie, 'GET', sub(appId));
  const submitPreview = (appId: string, cookie = t.owner) =>
    t.call(cookie, 'POST', sub(appId, '/preview'), {});
  const submitApply = (appId: string, body: Record<string, unknown>, cookie = t.owner) =>
    t.call(cookie, 'POST', sub(appId), body);
  /** Preview, then submit with its hash and typed phrase. */
  const previewAndSubmit = async (appId: string, cookie = t.owner) => {
    const p = await submitPreview(appId, cookie);
    if (p.status !== 200 || !p.body.preview.confirmHash) return { preview: p, submit: p };
    return {
      preview: p,
      submit: await submitApply(
        appId,
        {
          confirmHash: p.body.preview.confirmHash,
          confirmation: p.body.preview.confirmation.phrase,
        },
        cookie,
      ),
    };
  };
  const submitClaim = async (appId: string) =>
    (await db.query('SELECT * FROM store_submit_claims WHERE app_id = ?', [appId]))[0];
  const stageField = (appId: string, body: Record<string, unknown>, cookie = t.owner) =>
    t.call(cookie, 'PUT', sp(appId, '/release-fields'), body);
  const rel = (appId: string, rest = '') => `/apps/${appId}/store-release${rest}`;
  const releaseState = (appId: string, cookie = t.owner) => t.call(cookie, 'GET', rel(appId));
  const releasePreview = (appId: string, body: Record<string, unknown> = {}, cookie = t.owner) =>
    t.call(cookie, 'POST', rel(appId, '/preview'), body);
  const releaseApply = (appId: string, body: Record<string, unknown>, cookie = t.owner) =>
    t.call(cookie, 'POST', rel(appId), body);
  /** Preview, then release with its hash and typed phrase. */
  const previewAndRelease = async (
    appId: string,
    what: Record<string, unknown> = {},
    cookie = t.owner,
  ) => {
    const p = await releasePreview(appId, what, cookie);
    if (p.status !== 200 || !p.body.preview.confirmHash) return { preview: p, release: p };
    return {
      preview: p,
      release: await releaseApply(
        appId,
        {
          ...what,
          confirmHash: p.body.preview.confirmHash,
          confirmation: p.body.preview.confirmation.phrase,
        },
        cookie,
      ),
    };
  };
  const releaseClaim = async (appId: string) =>
    (await db.query('SELECT * FROM store_release_claims WHERE app_id = ?', [appId]))[0];
  const pushRecord = async (appId: string) =>
    (await db.query('SELECT * FROM store_draft_pushes WHERE app_id = ?', [appId]))[0];
  return {
    ...t,
    repo,
    files,
    stores,
    releaseStores,
    releaseBuilt,
    stageField,
    rel,
    releaseState,
    releasePreview,
    releaseApply,
    previewAndRelease,
    releaseClaim,
    submitStores,
    submitBuilt,
    sub,
    submitState,
    submitPreview,
    submitApply,
    previewAndSubmit,
    submitClaim,
    pushRecord,
    readStores,
    built,
    repositoryId,
    iosCredential,
    playCredential,
    addApp,
    sp,
    view,
    stageText,
    stageAssets,
    unstage,
    clear,
    preview,
    push,
    previewAndPush,
    events,
    audit,
    claim,
    rows,
  };
}

export type StagedBoot = Awaited<ReturnType<typeof bootStaged>>;
