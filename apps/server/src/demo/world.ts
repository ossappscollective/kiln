import { readFile, writeFile } from 'node:fs/promises';
import {
  type EditableRelease,
  mapAppStoreState,
  type NotesHistoryRead,
  type PlayCheckRelease,
  type PlayCheckResult,
  type PlayReleaseState,
  type ReleaseApplyInput,
  type ReleaseCandidates,
  type ReleaseResult,
  type RolloutApplyInput,
  type RolloutApplyResult,
  type RolloutState,
  type RolloutTarget,
  type StoreBuild,
  type StoreVersion,
  type SubmitApplyInput,
  type SubmitResult,
} from '@mrm/connectors';
import {
  appleState,
  FakeRolloutStore,
  playState,
} from '../modules/publish/rollout-test-helpers.ts';
import {
  FakeDraftStore,
  FakeReleaseStore,
  FakeSubmitStore,
} from '../modules/publish/test-helpers.ts';
import { FakeReplyStore } from '../modules/reviews/test-helpers.ts';
import {
  APPLE_LOCALES,
  appleTexts,
  DEMO_APPS,
  type DemoApp,
  langOf,
  PLAY_LOCALES,
  type Platform,
  playTexts,
} from './content.ts';
import { makeReviews } from './data.ts';
import { FailureBoard } from './failures.ts';
import { DemoRepo } from './repo.ts';

/**
 * The simulated stores. One `Side` per app record (an iOS, macOS or Android record of an app): the draft, the submit, the
 * release and the rollout of that record's store, plus the reviews. The classes are the test fakes of this repository
 * (staged-test-helpers.ts, rollout-test-helpers.ts, review-test-helpers.ts); the demo adds the connections between them (a submit
 * puts the version in review, "advance" lets the store decide, a release starts a rollout) and the persistence.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const key = (locale: string, field: string) => `${locale}\u0000${field}`;

export type DemoBuild = {
  number: string;
  version: string;
  platform: Platform;
  uploadedAt: number;
  /** The build finishes processing at this time (App Store Connect processing, Play never has this). */
  readyAt: number;
  notes: Record<string, string>;
  runId?: string;
};

type ApplePhase =
  | 'PREPARE_FOR_SUBMISSION'
  | 'WAITING_FOR_REVIEW'
  | 'IN_REVIEW'
  | 'PENDING_DEVELOPER_RELEASE'
  | 'REJECTED'
  | 'PROCESSING_FOR_APP_STORE'
  | 'READY_FOR_DISTRIBUTION';

type Version = { id: string; versionString: string; state: string; releaseType: string | null };

export class DemoDraftStore extends FakeDraftStore {
  side!: Side;
  override async listReleaseCandidates(
    input: { version?: string; track?: string } = {},
  ): Promise<ReleaseCandidates> {
    this.releaseReads++;
    if (this.releaseReadError) throw this.releaseReadError;
    return this.side.candidates(input);
  }
  override async readEditableRelease(input: { track?: string } = {}): Promise<EditableRelease> {
    this.releaseReads++;
    if (this.releaseReadError) throw this.releaseReadError;
    return this.side.editable(input);
  }
  /**
   * The release the demo calls "in internal testing" (the one "Promote to production" offers) has notes in three languages, so
   * the step "What is new" shows them filled in. The Apple records answer as the fake does (nothing).
   */
  override async readNotesHistory(
    input: { locale?: string; maxVersions?: number } = {},
  ): Promise<NotesHistoryRead> {
    if (this.side.apple) return super.readNotesHistory(input);
    const draft = this.side.release.releases.find((r) => r.status === 'draft');
    const want = input.locale?.toLowerCase().replace(/_/g, '-');
    const entries = !draft
      ? []
      : this.side
          .locales()
          .slice(0, 3)
          .filter((locale) => want === undefined || locale.toLowerCase() === want)
          .map((locale) => ({
            source: 'googleplay' as const,
            locale,
            text: appleOrPlayNotes(this.side.app, locale),
            truncated: false,
            version: draft.name,
            track: 'internal',
            versionCodes: [...draft.versionCodes],
            state: 'completed',
            at: null,
          }));
    return { entries, truncated: false, versionsRead: draft ? 1 : 0, failed: 0 };
  }
}

export class DemoSubmitStore extends FakeSubmitStore {
  side!: Side;
  override async submit(input: SubmitApplyInput): Promise<SubmitResult> {
    const result = await super.submit(input);
    this.side.afterSubmit();
    return result;
  }
}

export class DemoReleaseStore extends FakeReleaseStore {
  side!: Side;
  /**
   * "Check with Google Play" in the demo. No Google is asked. A release to everybody at once while another release of the track is
   * rolling out (or halted) gets one EXAMPLE error, so the demo shows what an error looks like; everything else finds no error.
   * The message says it is an example: it is not a rule of Google Play.
   */
  override async checkPlayRelease(input: PlayCheckRelease): Promise<PlayCheckResult> {
    await super.checkPlayRelease(input);
    const running = this.releases.some(
      (r) =>
        (r.status === 'inProgress' || r.status === 'halted') &&
        !r.versionCodes.some((c) => input.versionCodes.includes(c)),
    );
    if (input.status === 'completed' && running)
      return {
        outcome: 'errors',
        findings: [
          {
            stage: 'validate',
            message:
              'Demo example of an error from Google Play: a release cannot go to everybody while another release of this track is rolling out or halted. This message is made up by the demo.',
          },
        ],
      };
    return { outcome: 'no_errors', findings: [] };
  }
  override async release(input: ReleaseApplyInput): Promise<ReleaseResult> {
    const result = await super.release(input);
    this.side.afterRelease(input);
    return result;
  }
}

export class DemoRolloutStore extends FakeRolloutStore {
  side!: Side;
  override async readState(target: RolloutTarget): Promise<RolloutState> {
    this.side.tickRollout();
    return super.readState(target);
  }
  override async applyChange(input: RolloutApplyInput): Promise<RolloutApplyResult> {
    this.side.tickRollout();
    const result = await super.applyChange(input);
    this.side.afterRollout(result.after);
    return result;
  }
}

export class Side {
  readonly world: DemoWorld;
  readonly app: DemoApp;
  readonly platform: Platform;
  readonly key: string;
  readonly draft: DemoDraftStore;
  readonly submit: DemoSubmitStore;
  readonly release: DemoReleaseStore;
  readonly rollout: DemoRolloutStore;
  readonly reply: FakeReplyStore;
  /** Every version of an Apple record (shared with the release fake and the draft's editable version). */
  versions: Version[] = [];
  /** What the store shows as the live listing, by locale and field. */
  liveTexts: Record<string, Record<string, string>> = {};
  /** App level texts (name, subtitle): not part of a draft push. */
  builds: DemoBuild[] = [];
  /** The build number attached to the editable version. */
  attached: string | null = null;
  /** Google Play: the edit was sent for review at this time, with the outcome still open. */
  playInReview: number | null = null;
  rolloutStartedAt: number | null = null;

  constructor(world: DemoWorld, app: DemoApp, platform: Platform) {
    this.world = world;
    this.app = app;
    this.platform = platform;
    this.key = `${platform}:${app.identifier}`;
    // The macOS record uses the Apple fakes (which treat anything that is not Android as Apple).
    const fakePlatform = platform === 'android' ? 'android' : 'ios';
    this.draft = new DemoDraftStore(fakePlatform);
    this.submit = new DemoSubmitStore(this.draft);
    this.release = new DemoReleaseStore(fakePlatform);
    this.rollout = new DemoRolloutStore(fakePlatform);
    this.reply = new FakeReplyStore(fakePlatform);
    this.draft.side = this;
    this.submit.side = this;
    this.release.side = this;
    this.rollout.side = this;
    // A macOS record's connector reports the macOS platform where the services compare it.
    if (platform === 'macos')
      for (const s of [this.draft, this.submit, this.release, this.rollout, this.reply])
        Object.defineProperty(s, 'platform', { value: 'macos' });
  }

  get apple(): boolean {
    return this.platform !== 'android';
  }
  get storeId(): string {
    return this.apple ? this.app.appleId : this.app.identifier;
  }
  get now(): number {
    return this.world.now();
  }
  locales(): readonly string[] {
    return this.apple ? APPLE_LOCALES : PLAY_LOCALES;
  }

  // ---- reading --------------------------------------------------------------------------------------------------------

  buildState(b: DemoBuild): StoreBuild {
    const ready = this.now >= b.readyAt;
    return {
      storeId: `${this.platform}-${b.number}`,
      appStoreId: this.storeId,
      platform: this.platform,
      buildNumber: b.number,
      versionString: b.version,
      processing: ready ? 'processed' : 'processing',
      rawProcessingState: ready ? 'VALID' : 'PROCESSING',
      uploadedAt: b.uploadedAt,
    };
  }

  listBuilds(): StoreBuild[] {
    return this.builds
      .map((b) => this.buildState(b))
      .sort((a, b) => Number(b.buildNumber) - Number(a.buildNumber));
  }

  listVersions(): StoreVersion[] {
    if (this.apple) {
      return this.versions.map((v) => ({
        storeId: v.id,
        appStoreId: this.storeId,
        platform: this.platform,
        versionString: v.versionString,
        rawState: v.state,
        ...this.#lifecycle(v),
      }));
    }
    const production: StoreVersion[] = this.release.releases.map((r) => {
      const state =
        r.status === 'draft'
          ? 'draft'
          : r.status === 'completed'
            ? 'live'
            : r.status === 'halted'
              ? 'halted'
              : r.status === 'inProgress'
                ? 'rolling_out'
                : undefined;
      return {
        storeId: `production:${r.name ?? r.versionCodes.join(',')}`,
        appStoreId: this.storeId,
        platform: 'android' as const,
        versionString: r.name ?? r.versionCodes.join(','),
        rawState: r.status,
        ...(state ? { lifecycleState: state } : {}),
        track: 'production',
        versionCodes: [...r.versionCodes],
        ...(r.userFraction !== null ? { rolloutFraction: r.userFraction } : {}),
      };
    });
    // A workflow put the newest build in the internal track: the demo shows "Promote to production" for it.
    const draft = this.release.releases.find((r) => r.status === 'draft');
    if (!draft) return production;
    return [
      ...production,
      {
        storeId: `internal:${draft.name ?? draft.versionCodes.join(',')}`,
        appStoreId: this.storeId,
        platform: 'android' as const,
        versionString: draft.name ?? draft.versionCodes.join(','),
        rawState: 'completed',
        lifecycleState: 'live' as const,
        track: 'internal',
        versionCodes: [...draft.versionCodes],
      },
    ];
  }

  #lifecycle(v: Version): Partial<StoreVersion> {
    const phased =
      v.state === 'READY_FOR_DISTRIBUTION' && this.release.phased
        ? (this.release.phased.state ?? undefined)
        : undefined;
    const lifecycleState = mapAppStoreState(v.state, phased ? { phasedRelease: phased } : {});
    return lifecycleState ? { lifecycleState } : {};
  }

  /** The editable listing: what a draft holds now (Apple), or what the store has for the app's languages (Play: one listing). */
  editableTexts(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    for (const locale of this.draft.locales) {
      const base = { ...(this.liveTexts[locale] ?? {}) };
      for (const [k, v] of this.draft.texts) {
        const [l, field] = k.split('\u0000') as [string, string];
        if (l === locale) base[field] = v;
      }
      out[locale] = base;
    }
    return out;
  }

  candidates(input: { version?: string; track?: string }): ReleaseCandidates {
    if (!this.apple) {
      const draft = this.release.releases.find((r) => r.status === 'draft');
      const codes = new Set<string>();
      for (const b of this.builds) codes.add(b.number);
      return {
        store: 'googleplay',
        platform: 'android',
        track: input.track ?? 'production',
        codes: [...codes]
          .sort((a, b) => Number(b) - Number(a))
          .slice(0, 8)
          .map((code) => {
            const inTrack = this.release.releases
              .filter((r) => r.versionCodes.includes(code))
              .map((r) => ({ name: r.name, status: r.status }));
            const live = inTrack.find((r) => r.status === 'completed' || r.status === 'inProgress');
            const inDraft = draft?.versionCodes.includes(code) === true;
            return {
              versionCode: code,
              source: 'bundle' as const,
              sha256: code.padStart(64, 'a').slice(-64),
              inTrack,
              eligibility: live
                ? {
                    eligible: false,
                    severity: 'blocked' as const,
                    code: 'already_live' as const,
                    message: `Version code ${code} is already in a release of this track that is ${live.status === 'completed' ? 'live' : 'rolling out'}.`,
                  }
                : inDraft
                  ? {
                      eligible: false,
                      severity: 'ok' as const,
                      code: 'already_in_draft' as const,
                      message: `Version code ${code} is already in the draft release of this track.`,
                    }
                  : {
                      eligible: true,
                      severity: 'ok' as const,
                      code: 'ok' as const,
                      message: `Version code ${code} was uploaded and is not in a release of this track yet.`,
                    },
            };
          }),
      };
    }
    const version = this.editableVersion();
    return {
      store: 'appstoreconnect',
      platform: this.platform,
      version: version
        ? { id: version.id, versionString: version.versionString, state: version.state }
        : null,
      builds: this.builds
        .filter((b) => !input.version || b.version === input.version || true)
        .sort((a, b) => Number(b.number) - Number(a.number))
        .slice(0, 12)
        .map((b) => {
          const processed = this.now >= b.readyAt;
          const attached = this.attached === b.number;
          return {
            id: `b-${b.number}`,
            buildNumber: b.number,
            version: b.version,
            uploadedDate: new Date(b.uploadedAt).toISOString(),
            processingState: processed ? 'VALID' : 'PROCESSING',
            expired: false,
            selectable: processed && !attached,
            reason: processed ? null : 'Apple is still processing this build.',
            attached,
            eligibility: !processed
              ? {
                  eligible: false,
                  severity: 'blocked' as const,
                  code: 'processing' as never,
                  message: `Build ${b.number} is still processing.`,
                }
              : attached
                ? {
                    eligible: false,
                    severity: 'ok' as const,
                    code: 'already_attached' as const,
                    message: `Build ${b.number} is already attached to version ${version?.versionString ?? 'being prepared'}.`,
                  }
                : {
                    eligible: true,
                    severity: 'ok' as const,
                    code: 'ok' as const,
                    message: `Build ${b.number} is processed and can be attached to version ${version?.versionString ?? 'being prepared'}.`,
                  },
            exportCompliance: 'unknown' as const,
            testNotes: {
              read: true,
              locales: Object.entries(b.notes).map(([locale, text]) => ({
                locale,
                text,
                truncated: false,
              })),
            },
          };
        }),
      attachedBuildId: this.attached ? `b-${this.attached}` : null,
      truncatedAt: null,
    };
  }

  editableVersion(): Version | undefined {
    return this.versions.find(
      (v) => v.state === 'PREPARE_FOR_SUBMISSION' || v.state === 'REJECTED',
    );
  }

  editable(input: { track?: string }): EditableRelease {
    if (!this.apple) {
      const draft = this.release.releases.find((r) => r.status === 'draft') ?? null;
      return {
        store: 'googleplay',
        platform: 'android',
        track: input.track ?? 'production',
        draft: draft
          ? {
              name: draft.name,
              status: draft.status,
              userFraction: draft.userFraction,
              versionCodes: [...draft.versionCodes],
              notes: this.locales().map((locale) => ({
                locale,
                text: appleOrPlayNotes(this.app, locale),
              })),
            }
          : null,
        others: this.release.releases
          .filter((r) => r !== draft)
          .map((r) => ({
            name: r.name,
            status: r.status,
            userFraction: r.userFraction,
            versionCodes: [...r.versionCodes],
            notes: [],
          })),
      };
    }
    const v = this.editableVersion();
    const b = this.attached ? this.builds.find((x) => x.number === this.attached) : undefined;
    return {
      store: 'appstoreconnect',
      platform: this.platform,
      version: {
        id: v?.id ?? 'none',
        versionString: v?.versionString ?? null,
        state: v?.state ?? 'PREPARE_FOR_SUBMISSION',
        editable: true as const,
      },
      releaseType: v?.releaseType ?? 'MANUAL',
      earliestReleaseDate: null,
      copyright: `${new Date(this.now).getUTCFullYear()} Demo Studio`,
      build: b
        ? { id: `b-${b.number}`, buildNumber: b.number, processingState: 'VALID', expired: false }
        : null,
      phasedRelease: null,
      releaseNotes: this.locales().map((locale) => ({
        locale,
        text: this.draft.texts.get(key(locale, 'release_notes')) ?? '',
      })),
    } as EditableRelease;
  }

  // ---- hooks of the fakes ---------------------------------------------------------------------------------------------------

  afterSubmit() {
    if (this.apple) {
      const v = this.editableVersion();
      if (v) v.state = 'WAITING_FOR_REVIEW';
      this.draft.version = null;
    } else {
      this.playInReview = this.now;
    }
  }

  afterRelease(input: ReleaseApplyInput) {
    if (this.apple) return;
    // The Play release was started at a share: the rollout store now reports it.
    const live = this.release.releases.find(
      (r) => r.status === 'inProgress' || (r.status === 'completed' && r.name === this.app.next),
    );
    if (live)
      this.rollout.state = playState({
        name: live.name ?? this.app.next,
        versionCodes: [...live.versionCodes],
        status: live.status,
        userFraction: live.userFraction ?? 1,
        otherReleases: this.release.releases.length - 1,
      });
    void input;
  }

  afterRollout(after: RolloutState) {
    if (after.store === 'googleplay') {
      const r = this.release.releases.find(
        (x) => x.versionCodes.join(',') === after.versionCodes.join(','),
      );
      if (r) {
        r.status = after.status;
        r.userFraction = after.status === 'completed' ? null : after.userFraction;
      }
    } else {
      this.release.phased = after.phasedReleaseId
        ? { id: after.phasedReleaseId, state: after.phasedReleaseState }
        : null;
    }
  }

  /** The phased release moves one day per 24 hours of the (simulated) clock: day 7 is complete. */
  tickRollout() {
    const s = this.rollout.state;
    if (
      s.store !== 'appstoreconnect' ||
      this.rolloutStartedAt === null ||
      s.phasedReleaseState !== 'ACTIVE'
    )
      return;
    const day = Math.min(8, Math.floor((this.now - this.rolloutStartedAt) / DAY) + 1);
    if (day >= 8) {
      this.rollout.state = { ...s, phasedReleaseState: 'COMPLETE', currentDayNumber: 7 };
      this.release.phased = s.phasedReleaseId ? { id: s.phasedReleaseId, state: 'COMPLETE' } : null;
    } else {
      this.rollout.state = { ...s, currentDayNumber: day };
    }
  }

  /** What the store decides after a review, and what happens by itself when time passes. */
  decide(outcome: 'approve' | 'reject'): string[] {
    const notes: string[] = [];
    if (this.apple) {
      for (const v of this.versions) {
        if (v.state === 'WAITING_FOR_REVIEW' || v.state === 'IN_REVIEW') {
          if (outcome === 'approve') {
            v.state =
              v.releaseType === 'AUTOMATIC'
                ? 'PROCESSING_FOR_APP_STORE'
                : 'PENDING_DEVELOPER_RELEASE';
            notes.push(`${this.key}: ${v.versionString} approved`);
          } else {
            v.state = 'REJECTED';
            this.draft.version = v;
            this.submit.submitted = false;
            notes.push(`${this.key}: ${v.versionString} rejected (guideline 4.0 design, demo)`);
          }
        }
      }
      this.submit.submitted = false;
    } else if (this.playInReview !== null) {
      this.playInReview = null;
      if (outcome === 'approve') {
        for (const [k, v] of this.draft.texts) {
          const [locale, field] = k.split('\u0000') as [string, string];
          (this.liveTexts[locale] ??= {})[field] = v;
        }
        notes.push(`${this.key}: store listing changes approved and live`);
      } else {
        this.draft.texts = new Map();
        for (const [locale, fields] of Object.entries(this.liveTexts))
          for (const [f, v] of Object.entries(fields)) this.draft.texts.set(key(locale, f), v);
        notes.push(`${this.key}: listing changes rejected; the draft went back to the live text`);
      }
    }
    return notes;
  }

  /** Time passes: processing versions go live, phased releases start. */
  settle(): string[] {
    const notes: string[] = [];
    if (!this.apple) return notes;
    for (const v of this.versions) {
      if (v.state !== 'PROCESSING_FOR_APP_STORE') continue;
      v.state = 'READY_FOR_DISTRIBUTION';
      for (const [k, val] of this.draft.texts) {
        const [locale, field] = k.split('\u0000') as [string, string];
        (this.liveTexts[locale] ??= {})[field] = val;
      }
      // Earlier live versions are replaced.
      for (const other of this.versions)
        if (other !== v && other.state === 'READY_FOR_DISTRIBUTION')
          other.state = 'REPLACED_WITH_NEW_VERSION';
      const startedAt = this.now;
      this.rolloutStartedAt = startedAt;
      this.release.phased = { id: `pr-${v.id}`, state: 'ACTIVE' };
      this.rollout.state = appleState({
        platform: this.platform === 'macos' ? 'macos' : 'ios',
        version: v.versionString,
        storeVersionId: v.id,
        versionState: 'READY_FOR_DISTRIBUTION',
        phasedReleaseId: `pr-${v.id}`,
        phasedReleaseState: 'ACTIVE',
        currentDayNumber: 1,
        startDate: startedAt,
        totalPauseDays: 0,
      });
      notes.push(`${this.key}: ${v.versionString} is live and the phased release started`);
      // The next version opens for editing.
      if (!this.editableVersion()) {
        const next = bump(v.versionString);
        const nv: Version = {
          id: `v-${this.app.key}-${this.platform}-${next.replace(/\./g, '')}`,
          versionString: next,
          state: 'PREPARE_FOR_SUBMISSION',
          releaseType: 'MANUAL',
        };
        this.versions.push(nv);
        this.draft.version = nv;
        this.attached = null;
        this.release.build = null;
        notes.push(`${this.key}: ${next} opened for editing`);
      }
    }
    return notes;
  }
}

const bump = (v: string) => {
  const [a, b] = v.split('.');
  return `${a}.${Number(b) + 1}.0`;
};

export const appleOrPlayNotes = (app: DemoApp, locale: string) => app.copy[langOf(locale)].notes;

// ---- the world ---------------------------------------------------------------------------------------------------------

type Persisted = {
  v: 1;
  seededAt: number;
  skewMs: number;
  sides: Record<string, unknown>;
  repo: unknown;
};

const dump = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_k, v) =>
      v instanceof Map ? { __map: [...v] } : v instanceof Set ? { __set: [...v] } : v,
    ),
  );
const revive = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if ('__map' in o)
      return new Map((o.__map as [unknown, unknown][]).map(([k, v]) => [k, revive(v)]));
    if ('__set' in o) return new Set((o.__set as unknown[]).map(revive));
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, revive(v)]));
  }
  return value;
};

export class DemoWorld {
  skewMs = 0;
  seededAt: number;
  /** While seeding, the clock is set by the seed script. */
  virtualNow: number | null = null;
  sides = new Map<string, Side>();
  repo: DemoRepo;
  failures = new FailureBoard();
  /** The reply, AI and translation seams count their calls here (the status endpoint shows them). */
  calls = { ai: 0, translate: 0 };

  constructor(seededAt: number) {
    this.seededAt = seededAt;
    this.repo = new DemoRepo(this);
    for (const app of DEMO_APPS) for (const platform of app.platforms) this.#build(app, platform);
    this.repo.populate();
  }

  now = (): number => this.virtualNow ?? Date.now() + this.skewMs;

  side(platform: Platform, identifier: string): Side | undefined {
    return this.sides.get(`${platform}:${identifier}`);
  }
  sideFor(
    kind: 'app_store_connect' | 'google_play',
    identifier: string,
    platform?: Platform,
  ): Side {
    // Some seams do not say which Apple platform they mean: take the iOS record, else the macOS one that owns the identifier.
    const p: Platform =
      kind === 'google_play'
        ? 'android'
        : platform === 'macos'
          ? 'macos'
          : platform === 'ios' || this.side('ios', identifier)
            ? 'ios'
            : 'macos';
    const side = this.side(p, identifier);
    if (!side) throw new Error(`The demo store has no ${p} app "${identifier}".`);
    return side;
  }

  #build(app: DemoApp, platform: Platform) {
    const t0 = this.seededAt;
    const side = new Side(this, app, platform);
    this.sides.set(side.key, side);
    const idPart = `${app.key}-${platform}`;
    const noteLocales = {
      'en-US': 'Try the new shared folders and tell us what breaks.',
      de: 'Bitte die neuen geteilten Ordner ausprobieren.',
    } as Record<string, string>;
    const mkBuild = (n: number, version: string, daysAgo: number, processed = true): DemoBuild => ({
      number: String(n),
      version,
      platform,
      uploadedAt: t0 - daysAgo * DAY,
      readyAt: processed ? t0 - daysAgo * DAY + 20 * 60_000 : t0 + 4 * 60_000,
      notes: noteLocales,
    });
    const live = app.live;
    const next = app.next;
    if (platform === 'android') {
      side.draft.locales = new Set(PLAY_LOCALES);
      side.draft.texts = new Map();
      for (const l of PLAY_LOCALES) {
        const texts = playTexts(app, langOf(l));
        side.liveTexts[l] = { ...texts };
        for (const [f, v] of Object.entries(texts)) side.draft.texts.set(key(l, f), v);
      }
      const base = app.key === 'notes' ? 236 : 276;
      side.builds = [
        mkBuild(base, '3.3.0', 70),
        mkBuild(base + 2, live, 20),
        mkBuild(base + 4, next, 2),
      ].map((b, i) => ({ ...b, version: i === 0 ? prev(live) : b.version }));
      side.release.uploaded = new Set(side.builds.map((b) => b.number));
      const liveCode = String(base + 2);
      const draftCode = String(base + 4);
      side.release.releases =
        app.key === 'notes'
          ? [
              {
                name: prev(live),
                status: 'halted',
                userFraction: 0.35,
                versionCodes: [String(base)],
                notes: 1,
              },
              {
                name: live,
                status: 'completed',
                userFraction: null,
                versionCodes: [liveCode],
                notes: 1,
              },
              {
                name: next,
                status: 'draft',
                userFraction: null,
                versionCodes: [draftCode],
                notes: 1,
              },
            ]
          : [
              {
                name: live,
                status: 'inProgress',
                userFraction: 0.2,
                versionCodes: [liveCode],
                notes: 1,
              },
              {
                name: next,
                status: 'draft',
                userFraction: null,
                versionCodes: [draftCode],
                notes: 1,
              },
            ];
      side.rollout.state =
        app.key === 'notes'
          ? playState({
              name: prev(live),
              versionCodes: [String(base)],
              status: 'halted',
              userFraction: 0.35,
              otherReleases: 2,
            })
          : playState({
              name: live,
              versionCodes: [liveCode],
              status: 'inProgress',
              userFraction: 0.2,
              otherReleases: 1,
            });
    } else {
      side.draft.locales = new Set(APPLE_LOCALES);
      side.draft.texts = new Map();
      for (const l of APPLE_LOCALES) {
        const texts = appleTexts(app, langOf(l));
        side.liveTexts[l] = { ...texts };
        for (const [f, v] of Object.entries(texts))
          if (f !== 'name' && f !== 'subtitle') side.draft.texts.set(key(l, f), v);
      }
      const vLive: Version = {
        id: `v-${idPart}-${live.replace(/\./g, '')}`,
        versionString: live,
        state: 'READY_FOR_DISTRIBUTION',
        releaseType: 'MANUAL',
      };
      const nextState: ApplePhase =
        app.key === 'notes' && platform === 'ios'
          ? 'PREPARE_FOR_SUBMISSION'
          : app.key === 'notes'
            ? 'IN_REVIEW'
            : app.key === 'weather'
              ? 'PENDING_DEVELOPER_RELEASE'
              : 'REJECTED';
      const vNext: Version = {
        id: `v-${idPart}-${next.replace(/\./g, '')}`,
        versionString: next,
        state: nextState,
        releaseType: 'MANUAL',
      };
      side.versions = [vLive, vNext];
      side.release.versions = side.versions;
      side.draft.version =
        nextState === 'PREPARE_FOR_SUBMISSION' || nextState === 'REJECTED' ? vNext : null;
      if (nextState === 'IN_REVIEW') side.submit.submitted = false;
      const b = platform === 'macos' ? 900 : app.key === 'weather' ? 410 : 165;
      side.builds = [
        mkBuild(b, prev(live), 60),
        mkBuild(b + 2, live, 20),
        mkBuild(b + 3, next, 3),
        ...(app.key === 'notes' && platform === 'ios'
          ? [mkBuild(b + 4, next, 1), mkBuild(b + 5, next, 0, false)]
          : []),
      ];
      side.attached = String(b + 3);
      side.release.build = {
        id: `b-${b + 3}`,
        buildNumber: String(b + 3),
        processingState: 'VALID',
        expired: false,
      };
      side.submit.build = {
        id: `b-${b + 3}`,
        version: String(b + 3),
        processingState: 'VALID',
        expired: false,
      };
      const phasedActive = app.key === 'weather';
      side.release.phased =
        platform === 'macos'
          ? null
          : { id: `pr-${idPart}`, state: phasedActive ? 'ACTIVE' : 'COMPLETE' };
      side.rolloutStartedAt = phasedActive ? t0 - 2 * DAY : null;
      side.rollout.state = appleState({
        platform: platform === 'macos' ? 'macos' : 'ios',
        version: live,
        storeVersionId: vLive.id,
        versionState: 'READY_FOR_DISTRIBUTION',
        phasedReleaseId: platform === 'macos' ? null : `pr-${idPart}`,
        phasedReleaseState: platform === 'macos' ? null : phasedActive ? 'ACTIVE' : 'COMPLETE',
        currentDayNumber: phasedActive ? 3 : 7,
        startDate: t0 - (phasedActive ? 2 : 14) * DAY,
        totalPauseDays: 0,
      });
      side.draft.fieldFacts.set('build', {
        currentNumber: String(b + 3),
        wantedFound: true,
        wantedNumber: String(b + 4),
        wantedProcessingState: 'VALID',
        wantedExpired: false,
      });
    }
    // Reviews are only read from the record that owns them (a macOS record that shares the App Store id owns none).
    const count =
      platform === 'macos'
        ? app.key === 'focus'
          ? 24
          : 0
        : app.key === 'notes'
          ? platform === 'ios'
            ? 70
            : 58
          : 44;
    side.reply.reviews = makeReviews({ app, platform, count, now: t0 });
  }

  /** Moves the simulated clock forward and lets the stores act. */
  advance(hours: number, outcome: 'approve' | 'reject' | 'none' = 'approve'): string[] {
    const notes: string[] = [];
    if (outcome !== 'none')
      for (const side of this.sides.values()) notes.push(...side.decide(outcome));
    this.skewMs += hours * HOUR;
    for (const side of this.sides.values()) notes.push(...side.settle());
    this.repo.tick();
    return notes;
  }

  // ---- persistence -------------------------------------------------------------------------------------------------------

  snapshot(): Persisted {
    const sides: Record<string, unknown> = {};
    for (const [k, s] of this.sides) {
      sides[k] = dump({
        versions: s.versions,
        liveTexts: s.liveTexts,
        builds: s.builds,
        attached: s.attached,
        playInReview: s.playInReview,
        rolloutStartedAt: s.rolloutStartedAt,
        draft: {
          version: s.draft.version?.id ?? null,
          locales: s.draft.locales,
          texts: s.draft.texts,
          sets: s.draft.sets,
          fields: s.draft.fields,
        },
        submit: { submitted: s.submit.submitted, build: s.submit.build },
        release: {
          build: s.release.build,
          phased: s.release.phased,
          releases: s.release.releases,
          uploaded: s.release.uploaded,
        },
        rollout: { state: s.rollout.state },
        replies: s.reply.reviews
          .filter((r) => r.developerResponse)
          .map((r) => [r.storeReviewId, r.developerResponse]),
      });
    }
    return {
      v: 1,
      seededAt: this.seededAt,
      skewMs: this.skewMs,
      sides,
      repo: dump(this.repo.snapshot()),
    };
  }

  restore(data: Persisted) {
    this.skewMs = data.skewMs;
    for (const [k, raw] of Object.entries(data.sides)) {
      const s = this.sides.get(k);
      if (!s) continue;
      const d = revive(raw) as any;
      s.versions = d.versions;
      s.release.versions = s.versions;
      s.liveTexts = d.liveTexts;
      s.builds = d.builds;
      s.attached = d.attached;
      s.playInReview = d.playInReview;
      s.rolloutStartedAt = d.rolloutStartedAt;
      s.draft.version = d.draft.version
        ? (s.versions.find((v) => v.id === d.draft.version) ?? null)
        : null;
      s.draft.locales = d.draft.locales;
      s.draft.texts = d.draft.texts;
      s.draft.sets = d.draft.sets;
      s.draft.fields = d.draft.fields;
      s.submit.submitted = d.submit.submitted;
      s.submit.build = d.submit.build;
      s.release.build = d.release.build;
      s.release.phased = d.release.phased;
      s.release.releases = d.release.releases as PlayReleaseState[];
      s.release.uploaded = d.release.uploaded;
      s.rollout.state = d.rollout.state;
      for (const [id, response] of d.replies as [string, never][]) {
        const r = s.reply.reviews.find((x) => x.storeReviewId === id);
        if (r) r.developerResponse = response;
      }
    }
    this.repo.restore(revive(data.repo) as never);
  }

  async save(file: string): Promise<void> {
    await writeFile(file, JSON.stringify(this.snapshot()));
  }

  static async load(file: string): Promise<Persisted | undefined> {
    try {
      const data = JSON.parse(await readFile(file, 'utf8')) as Persisted;
      return data.v === 1 ? data : undefined;
    } catch {
      return undefined;
    }
  }
}

const prev = (v: string) => {
  const [a, b, c] = v.split('.');
  return Number(c) > 0 ? `${a}.${b}.${Number(c) - 1}` : `${a}.${Number(b) - 1}.0`;
};
