import { createHash } from 'node:crypto';
import type { AssetKind, Platform } from '@mrm/core';
import { StoreError, type StoreName } from './errors.ts';
import { type DraftReadRequest, type DraftState, draftKey } from './store-draft-types.ts';

/**
 * Submitting the store's DRAFT for review (docs/adr/0010-store-submit.md, docs/api/submit.md): the
 * shapes both store connectors share. This is a different write from pushing a draft
 * (`store-draft-types.ts`): a push changes what the draft holds, a submit hands the draft to the
 * store's review. Nothing here talks to a store.
 *
 * - App Store Connect: a review submission (`reviewSubmissions`) with the editable App Store version as its
 *   one item, then `submitted: true`. The version's release type is never touched: whether an approval
 *   releases the version by itself is read and shown, and a version that would release by itself is blocked.
 * - Google Play: `edits.commit` of a fresh edit WITHOUT `changesNotSentForReview`, so the changes that are held
 *   back from review (by a draft push, or made in Play Console) are sent. `ERROR_IF_IN_REVIEW`: a review in
 *   progress is never cancelled. No track is read for writing and none is written: a submit cannot raise a
 *   rollout, start a release or complete one.
 *
 * Neither connector retries a write. A write whose answer is lost is `SubmitOutcomeUnknownError`: the caller
 * reads the store back.
 */

/** One image of a set as the store lists it: enough to check sizes and counts, never bytes. */
export type SubmitImageFact = {
  id: string;
  /** App Store: the first 32 hex characters of the SHA-256 this server wrote (or null). Google Play: the SHA-256. */
  checksum: string | null;
  width: number | null;
  height: number | null;
  /** App Store: the library image's state. Google Play: null. */
  state: string | null;
};

export type SubmitAssetSet = {
  kind: AssetKind;
  /** A `@mrm/core` device id (`iphone_6_5`, `phone`) or null. */
  device: string | null;
  /** App Store: the asset library placement group. Google Play: the `AppImageType`. */
  target: string;
  images: SubmitImageFact[];
};

export type SubmitLocale = {
  locale: string;
  /** Listing field id -> the draft's value, null when not set. Only the fields the store's version or listing holds. */
  text: Record<string, string | null>;
  assets: SubmitAssetSet[];
};

export type SubmitTrackRelease = { name: string | null; status: string; userFraction: number | null; versionCodes: string[] };
export type SubmitTrack = { track: string; releases: SubmitTrackRelease[] };

/** Everything a submit is decided on, read from the store at one moment. */
export type SubmitState = {
  store: StoreName;
  platform: Platform;
  /** App Store: the version that would go to review. Google Play: null. */
  version: { id: string; versionString: string | null; state: string; releaseType: string | null } | null;
  /** App Store: the build attached to the version (null: none). Google Play: null. */
  build: { id: string; version: string | null; processingState: string | null; expired: boolean | null } | null;
  /** App Store: the version is already in a review submission or past it. Google Play: always false (Play shows no review state). */
  alreadySubmitted: boolean;
  /** App Store: unsubmitted review submissions found for the app (null: could not tell). Google Play: null. */
  openReviewSubmissions: number | null;
  /** Google Play: the tracks as the edit shows them (read only; a submit never writes one). App Store: empty. */
  tracks: SubmitTrack[];
  locales: SubmitLocale[];
  /** The draft as `readDraft` would show it for the pushed items. Null while `alreadySubmitted` (the draft is no longer editable). */
  draft: DraftState | null;
};

export type SubmitApplyInput = {
  /** What was pushed: the items the draft is read for (and compared with by the caller). */
  request: DraftReadRequest;
  /**
   * Called with the state read from the store right before the first write. When it says false nothing is
   * written and `SubmitDriftError` is thrown: "the store is not what was previewed" on the freshest read there is.
   */
  guard: (current: SubmitState) => boolean;
};

export type SubmitResult = {
  /** The state the guard accepted. */
  before: SubmitState;
  /** App Store: the review submission that was submitted. Google Play: null. */
  submissionId: string | null;
  /** App Store: the state Apple reported for it (`WAITING_FOR_REVIEW`, ...), when it said. Google Play: null. */
  submissionState: string | null;
  /** `review_submission` (App Store) or `edit_commit` (Google Play). */
  via: 'review_submission' | 'edit_commit';
};

/** The store is not what the person confirmed: nothing was written. */
export class SubmitDriftError extends Error {
  readonly current: SubmitState;
  constructor(current: SubmitState) {
    super('The store changed since the preview was made.');
    this.name = 'SubmitDriftError';
    this.current = current;
  }
}

/**
 * The write that hands the draft to review was sent and the store did not answer in a way that tells whether it
 * was applied. Nothing retries it: the caller reads the store back.
 */
export class SubmitOutcomeUnknownError extends StoreError {
  constructor(store: StoreName, message: string, status?: number) {
    super(store, 'network', message, status);
    this.name = 'SubmitOutcomeUnknownError';
  }
}

/**
 * The write side of a store connector for submitting. `submit` hands the draft to review and does nothing else:
 * no version is created, nothing is released, no rollout is changed.
 */
export interface StoreSubmitConnector {
  readonly store: StoreName;
  readonly platform: Platform;
  /** Changes nothing. */
  readSubmitState(request: DraftReadRequest): Promise<SubmitState>;
  submit(input: SubmitApplyInput): Promise<SubmitResult>;
}

const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Stable form of a state for the confirmation hash: everything the confirmation depends on, in a fixed order.
 * The listing is part of it as hashes (a text changed in another locale changes what goes to review), the tracks
 * are part of it (a rollout that moved changes what "submit" means on Google Play), and the pushed draft is.
 */
export function submitKey(state: SubmitState): Record<string, unknown> {
  return {
    store: state.store,
    version: state.version === null ? null : [state.version.id, state.version.state, state.version.releaseType],
    build: state.build === null ? null : [state.build.id, state.build.version, state.build.processingState, state.build.expired],
    alreadySubmitted: state.alreadySubmitted,
    openReviewSubmissions: state.openReviewSubmissions,
    tracks: [...state.tracks]
      .sort((a, b) => a.track.localeCompare(b.track))
      .map((t) => [t.track, t.releases.map((r) => [r.name, r.status, r.userFraction, [...r.versionCodes].sort()])]),
    locales: [...state.locales]
      .sort((a, b) => a.locale.localeCompare(b.locale))
      .map((l) => [
        l.locale,
        Object.keys(l.text)
          .sort()
          .map((f) => [f, l.text[f] === null || l.text[f] === undefined ? null : sha(l.text[f] as string)]),
        [...l.assets]
          .sort((a, b) => a.target.localeCompare(b.target))
          .map((a) => [a.target, a.images.map((i) => [i.id, i.checksum, i.state, i.width, i.height])]),
      ]),
    draft: state.draft === null ? null : draftKey(state.draft),
  };
}

export const sameSubmitState = (a: SubmitState, b: SubmitState): boolean => JSON.stringify(submitKey(a)) === JSON.stringify(submitKey(b));

/** App Store version states that mean the version is in review, or past it (UNVERIFIED list: Apple's page names none). */
export const APPLE_SUBMITTED_VERSION_STATES: readonly string[] = [
  'READY_FOR_REVIEW',
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'PENDING_APPLE_RELEASE',
  'PENDING_DEVELOPER_RELEASE',
  'PROCESSING_FOR_APP_STORE',
  'WAITING_FOR_EXPORT_COMPLIANCE',
  'ACCEPTED',
  'READY_FOR_DISTRIBUTION',
  'READY_FOR_SALE',
];
