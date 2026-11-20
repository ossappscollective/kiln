import { createHash } from 'node:crypto';
import type { Platform } from '@mrm/core';
import { StoreError, type StoreName } from './errors.ts';

/**
 * Releasing (docs/adr/0014-release-management.md, docs/api/releases-write.md): the shapes both store connectors share for
 * (1) the READS that let a person edit a draft release (processed builds, uploaded version codes, the draft's release
 * fields) and (2) the one WRITE that cannot be taken back: releasing an approved App Store version, or starting a Google
 * Play draft release at a chosen share of users. Nothing here talks to a store.
 *
 * - App Store Connect: `POST /v1/appStoreVersionReleaseRequests` for a version in `PENDING_DEVELOPER_RELEASE`. Apple: "Send this
 *   request only when you're ready to publish your version. You can't cancel this request." (VERIFIED, Apple's page, 2026-11-19.)
 * - Google Play: an edit that sets the status of a draft release to `inProgress` (with `userFraction`) or `completed`, committed
 *   with `changesInReviewBehavior=ERROR_IF_IN_REVIEW`. The share is always explicit, never implied.
 *
 * Neither connector retries a write. A write whose answer is lost is `ReleaseOutcomeUnknownError`: the caller reads the store back.
 */

// ---------------------------------------------------------------------------------------------
// Reads: what a person can pick, and what the draft holds

/** One App Store Connect build of the app, for the platform of the app record. */
export type BuildCandidate = {
  id: string;
  /** The build number (`CFBundleVersion`), Apple's `builds.version`. */
  buildNumber: string | null;
  /** The marketing version the build belongs to (the pre-release version, `CFBundleShortVersionString`). */
  version: string | null;
  /** ISO 8601, as Apple reports it. */
  uploadedDate: string | null;
  /** `PROCESSING`, `FAILED`, `INVALID`, `VALID` (Apple's names, UNVERIFIED list). */
  processingState: string | null;
  expired: boolean | null;
  /** Processed (`VALID`) and not expired: it can be attached to a version. */
  selectable: boolean;
  /** Why it cannot be selected, in words (null when it can). */
  reason: string | null;
  /** It is the build attached to the editable version now. */
  attached: boolean;
  /** Whether the build can be chosen for the editable version, and why not or what to know (a verdict, see release-eligibility.ts). */
  eligibility: BuildEligibility;
  /**
   * Export compliance as Apple reports it for the build: `answered` (`usesNonExemptEncryption` is set), `missing` (the attribute
   * is empty) or `unknown` (Apple did not return it). UNVERIFIED attribute.
   */
  exportCompliance: 'answered' | 'missing' | 'unknown';
  /** "What to Test" per language (TestFlight), for the newest processed builds only; see `MAX_BUILDS_WITH_NOTES`. */
  testNotes: BuildTestNotes;
};

/** Why a build or a version code can or cannot be chosen: a code for a program and a sentence for a person. */
export type EligibilityCode =
  | 'ok'
  | 'processing'
  | 'failed'
  | 'invalid'
  | 'state_unknown'
  | 'expired'
  | 'wrong_version'
  | 'no_editable_version'
  | 'already_attached'
  | 'export_compliance_missing'
  | 'already_in_draft'
  | 'already_live';
export type EligibilitySeverity = 'ok' | 'warning' | 'blocked';
export type Eligibility = {
  /** It can be chosen for the draft now. */
  eligible: boolean;
  /** `blocked`: cannot be chosen. `warning`: can, but read the message. `ok`: nothing to say (or nothing to do). */
  severity: EligibilitySeverity;
  code: EligibilityCode;
  /** A plain sentence. Built from ids, versions and states only. */
  message: string;
};
export type BuildEligibility = Eligibility;
export type CodeEligibility = Eligibility;

/** The most characters kept of one TestFlight note ("What to Test") and the most languages and builds read. */
export const MAX_NOTE_CHARS = 4000;
export const MAX_NOTE_LOCALES = 40;
export const MAX_BUILDS_WITH_NOTES = 8;

/** The text a build carries for testers, in one language. Never logged and never audited. */
export type BuildTestNote = { locale: string; text: string; truncated: boolean };
export type BuildTestNotes = {
  /** False: not asked for this build (not processed, or beyond the newest ones) or the read failed (`error`). */
  read: boolean;
  locales: BuildTestNote[];
  /** Set when the read failed: `forbidden`, `rate_limited`, `not_found`, `unavailable`. The other builds are not affected. */
  error?: 'forbidden' | 'rate_limited' | 'not_found' | 'unavailable';
};

/** One Google Play version code that was uploaded (to the app, through an edit). */
export type CodeCandidate = {
  versionCode: string;
  /** `bundle` (edits.bundles) or `apk` (edits.apks). */
  source: 'bundle' | 'apk';
  sha256: string | null;
  /** The releases of the asked track that hold this code. */
  inTrack: { name: string | null; status: string }[];
  eligibility: CodeEligibility;
};

export type ReleaseCandidates =
  | {
      store: 'appstoreconnect';
      platform: Platform;
      /** The editable version the build would be attached to (null: there is none). */
      version: { id: string; versionString: string | null; state: string } | null;
      builds: BuildCandidate[];
      attachedBuildId: string | null;
      /** The listing was cut at this many builds (null: complete). */
      truncatedAt: number | null;
    }
  | {
      store: 'googleplay';
      platform: 'android';
      track: string;
      codes: CodeCandidate[];
    };

export type ReleaseNoteRead = { locale: string; text: string };

export type PlayReleaseRead = {
  name: string | null;
  status: string;
  userFraction: number | null;
  versionCodes: string[];
  notes: ReleaseNoteRead[];
};

export type EditableRelease =
  | {
      store: 'appstoreconnect';
      platform: Platform;
      version: { id: string; versionString: string | null; state: string; editable: true };
      releaseType: string | null;
      /** ISO 8601 as Apple reports it, or null. */
      earliestReleaseDate: string | null;
      copyright: string | null;
      build: {
        id: string;
        buildNumber: string | null;
        processingState: string | null;
        expired: boolean | null;
      } | null;
      /** The phased release of the version: null means the version has none (off). */
      phasedRelease: { id: string; state: string | null } | null;
      /** The "what's new" of each locale (a listing field: stage it with the listing texts). */
      releaseNotes: ReleaseNoteRead[];
    }
  | {
      store: 'googleplay';
      platform: 'android';
      track: string;
      /** The draft release of the track (status `draft`), or null. */
      draft: PlayReleaseRead | null;
      /** The other releases of the track, as the store shows them (read only here). */
      others: PlayReleaseRead[];
    };

/** The read side of the release feature. Changes nothing in a store. */
export interface StoreReleaseReader {
  readonly store: StoreName;
  readonly platform: Platform;
  /** App Store: the builds of the app for this platform. Google Play: the uploaded version codes (and where a track uses them). */
  listReleaseCandidates(input: {
    version?: string;
    track?: string;
    limit?: number;
  }): Promise<ReleaseCandidates>;
  /** The release fields of the editable App Store version, or of the draft release of a Google Play track. */
  readEditableRelease(input: { track?: string }): Promise<EditableRelease>;
}

export const isStoreReleaseReader = (value: unknown): value is StoreReleaseReader =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { listReleaseCandidates?: unknown }).listReleaseCandidates === 'function' &&
  typeof (value as { readEditableRelease?: unknown }).readEditableRelease === 'function';

// ---------------------------------------------------------------------------------------------
// The texts earlier releases used ("what is new")

export const MAX_NOTES_HISTORY_VERSIONS = 12;

/** What an earlier version of the store listing said was new, in one language. */
export type NotesHistoryEntry = {
  source: 'appstoreconnect' | 'googleplay';
  locale: string;
  /** At most MAX_NOTE_CHARS characters. */
  text: string;
  truncated: boolean;
  /** The marketing version (App Store) or the release name (Google Play), or null. */
  version: string | null;
  /** Google Play: the track. App Store: null. */
  track: string | null;
  /** The store's state of the version or release (`READY_FOR_DISTRIBUTION`, `completed`, ...). */
  state: string | null;
  /** When the version was created in the store (epoch ms), or null when the store does not say (Google Play never does). */
  at: number | null;
};

export type NotesHistoryRead = {
  entries: NotesHistoryEntry[];
  /** More versions exist than were read. */
  truncated: boolean;
  /** How many versions (App Store) or releases (Google Play) were read. */
  versionsRead: number;
  /** Versions that were listed but whose notes could not be read (App Store). */
  failed: number;
};

/** The read side of the "what is new" history. Changes nothing in a store. */
export interface StoreNotesHistoryReader {
  readonly store: StoreName;
  readonly platform: Platform;
  /** The newest versions' notes, newest first. `locale` narrows to one language. */
  readNotesHistory(input: { locale?: string; maxVersions?: number }): Promise<NotesHistoryRead>;
}

export const isStoreNotesHistoryReader = (value: unknown): value is StoreNotesHistoryReader =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { readNotesHistory?: unknown }).readNotesHistory === 'function';

// ---------------------------------------------------------------------------------------------
// The release itself

/** What the person asks to release. App Store: nothing (or the marketing version, to be sure). Google Play: the track, the codes and the share. */
export type ReleaseRequest = {
  /** App Store: the marketing version the person means (optional, checked). */
  version?: string;
  /** Google Play: the track of the draft release. */
  track?: string;
  /** Google Play: the version codes that identify the draft release (optional when the track has exactly one draft release). */
  versionCodes?: string[];
  /** Google Play: the share of users, `0 < x <= 1`. `1` completes the release (100%). Always explicit. */
  userFraction?: number;
};

export type PlayReleaseState = {
  name: string | null;
  status: string;
  userFraction: number | null;
  versionCodes: string[];
  notes: number;
};

/** Everything a release is decided on, read from the store at one moment. */
export type ReleaseState =
  | {
      store: 'appstoreconnect';
      platform: Platform;
      /** The version that would be released (null: none is in a state that can be released and none matched). */
      version: {
        id: string;
        versionString: string | null;
        state: string;
        releaseType: string | null;
      } | null;
      /** The version is in `PENDING_DEVELOPER_RELEASE`: Apple approved it and it waits for the release. */
      releasable: boolean;
      /** More than one version waits: the person must name the marketing version. */
      ambiguous: boolean;
      build: {
        id: string;
        buildNumber: string | null;
        processingState: string | null;
        expired: boolean | null;
      } | null;
      /** The phased release of the version (null: none, so everybody gets it at once). */
      phasedRelease: { id: string; state: string | null } | null;
      /** The states of this platform's other versions, so a refusal can say what the store holds. */
      versions: { versionString: string | null; state: string }[];
    }
  | {
      store: 'googleplay';
      platform: 'android';
      track: string;
      /** The draft release that would be started (null: none matched). */
      release: PlayReleaseState | null;
      /** More than one draft release in the track and no version codes were named. */
      ambiguous: boolean;
      /** The other releases of the track. A release that is rolling out is a blocking check. */
      others: PlayReleaseState[];
      /** The version codes of the release that Play does not list as uploaded (empty: all are). */
      missingCodes: string[];
    };

export type ReleaseApplyInput = {
  request: ReleaseRequest;
  /**
   * Called with the state read from the store right before the write. When it says false nothing is written and
   * `ReleaseDriftError` is thrown: "the store is not what was previewed" on the freshest read there is.
   */
  guard: (current: ReleaseState) => boolean;
};

export type ReleaseResult = {
  /** The state the guard accepted. */
  before: ReleaseState;
  /** App Store: the release request Apple created (id), when it said. Google Play: null. */
  releaseRequestId: string | null;
  via: 'release_request' | 'edit_commit';
};

/** The store is not what the person confirmed: nothing was written. */
export class ReleaseDriftError extends Error {
  readonly current: ReleaseState;
  constructor(current: ReleaseState) {
    super('The store changed since the preview was made.');
    this.name = 'ReleaseDriftError';
    this.current = current;
  }
}

/**
 * The release was sent and the store did not answer in a way that tells whether it was applied. Nothing retries it: the
 * caller reads the store back.
 */
export class ReleaseOutcomeUnknownError extends StoreError {
  constructor(store: StoreName, message: string, status?: number) {
    super(store, 'network', message, status);
    this.name = 'ReleaseOutcomeUnknownError';
  }
}

/**
 * The write side. `release` makes the approved version, or the draft release, available to users and does nothing else: no
 * version is created, no draft is edited, no review is submitted or cancelled.
 */
export interface StoreReleaseConnector {
  readonly store: StoreName;
  readonly platform: Platform;
  /** Changes nothing. */
  readReleaseState(request: ReleaseRequest): Promise<ReleaseState>;
  release(input: ReleaseApplyInput): Promise<ReleaseResult>;
}

// ---------------------------------------------------------------------------------------------
// "Check with Google Play": validate a proposed release in an edit that is never committed

/**
 * A release as the person proposes it, to be staged in a throw-away edit of one Google Play track and validated
 * (docs/adr/0025-play-release-checks.md). Nothing here is written to the store for good: the edit is deleted afterwards.
 */
export type PlayCheckRelease = {
  track: string;
  /** The release name (only shown in Play Console). Optional. */
  name?: string;
  versionCodes: string[];
  /** `draft`, `inProgress` (with `userFraction`) or `completed` (everybody, no fraction). */
  status: 'draft' | 'inProgress' | 'completed';
  /** Only with `inProgress`: more than 0 and less than 1. */
  userFraction?: number;
  /** The release notes per language. Empty texts are not sent. */
  notes: { locale: string; text: string }[];
};

/** One thing Google refused, in Google's own words (cut, redacted). `stage`: when the release was put in the edit; `validate`: `edits.validate`. */
export type PlayCheckFinding = { stage: 'stage' | 'validate'; message: string };

export type PlayCheckResult = {
  /** `no_errors`: Google found no error. That is NOT "no warnings": the API reports errors only (UNVERIFIED, see play-release.ts). */
  outcome: 'no_errors' | 'errors';
  findings: PlayCheckFinding[];
};

/** Validates a proposed release against Google Play. Never commits, always deletes its edit. */
export interface StorePlayReleaseChecker {
  readonly store: StoreName;
  readonly platform: Platform;
  checkPlayRelease(input: PlayCheckRelease): Promise<PlayCheckResult>;
}

export const isStorePlayReleaseChecker = (value: unknown): value is StorePlayReleaseChecker =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { checkPlayRelease?: unknown }).checkPlayRelease === 'function';

const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** The App Store version states in which a version can be released. Apple: "Pending Developer Release" (VERIFIED), the API name is UNVERIFIED. */
export const APPLE_RELEASABLE_STATE = 'PENDING_DEVELOPER_RELEASE';

/** Stable form of a state for the confirmation hash: everything the confirmation depends on, in a fixed order. */
export function releaseKey(state: ReleaseState): Record<string, unknown> {
  if (state.store === 'appstoreconnect') {
    return {
      store: state.store,
      version:
        state.version === null
          ? null
          : [
              state.version.id,
              state.version.versionString,
              state.version.state,
              state.version.releaseType,
            ],
      releasable: state.releasable,
      ambiguous: state.ambiguous,
      build:
        state.build === null
          ? null
          : [
              state.build.id,
              state.build.buildNumber,
              state.build.processingState,
              state.build.expired,
            ],
      phased:
        state.phasedRelease === null ? null : [state.phasedRelease.id, state.phasedRelease.state],
      versions: [...state.versions]
        .map((v) => [v.versionString, v.state])
        .sort((a, b) => (`${a[0]}\u0000${a[1]}` < `${b[0]}\u0000${b[1]}` ? -1 : 1)),
    };
  }
  const one = (r: PlayReleaseState) => [
    r.name,
    r.status,
    r.userFraction,
    [...r.versionCodes].sort(),
    r.notes,
  ];
  return {
    store: state.store,
    track: state.track,
    release: state.release === null ? null : one(state.release),
    ambiguous: state.ambiguous,
    others: [...state.others]
      .map(one)
      .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
    missing: [...state.missingCodes].sort(),
  };
}

export const sameReleaseState = (a: ReleaseState, b: ReleaseState): boolean =>
  JSON.stringify(releaseKey(a)) === JSON.stringify(releaseKey(b));

/** Hash of the part of a state a person confirms. */
export const releaseStateHash = (state: ReleaseState): string =>
  sha(JSON.stringify(releaseKey(state)));
