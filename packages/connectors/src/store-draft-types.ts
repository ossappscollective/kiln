import type { AssetKind, Platform } from '@mrm/core';
import { StoreError, type StoreName } from './errors.ts';

/**
 * Writing listing text and graphics into a store as a DRAFT (docs/adr/0009-staged-store-drafts.md,
 * docs/api/staged-changes.md): the shapes both store connectors share. Nothing here talks to a
 * store, and nothing here submits, sends for review or publishes anything.
 *
 * The stores keep a draft in different places:
 *
 * - App Store Connect: the version that can still be edited (`PREPARE_FOR_SUBMISSION` and the
 *   rejected states). Its localizations (`appStoreVersionLocalizations`) and its screenshot placements
 *   (App Asset Library: images and placements) are changed directly, one request at a time: there is
 *   no transaction, so a failure part way leaves some of the changes written (a `DraftPartialError`
 *   says which). Nothing is submitted.
 * - Google Play: an edit (`edits`), committed once with `changesNotSentForReview=true` so the
 *   changes are held back from review until somebody sends them from Play Console. Nothing is
 *   applied until the commit: a failure before it changes nothing.
 */

/** A listing text of one locale to write. `field` is a `@mrm/core` listing field id. */
export type DraftTextWrite = { locale: string; field: string; value: string };

/**
 * A set of graphics in one locale. `target` is the store's own name of the set: the App Store
 * `screenshotDisplayType` (`APP_IPHONE_65`) or the Google Play `AppImageType` (`phoneScreenshots`,
 * `icon`, `featureGraphic`): worked out by the server from the slot and the pixel size.
 */
export type DraftSlot = {
  locale: string;
  kind: AssetKind;
  device: string | null;
  target: string;
  /**
   * The pixel size of the files of the set (the first file). The App Store connector finds the asset
   * library placement group of the set from it and from the reference data Apple serves; Google Play
   * ignores it.
   */
  width?: number | null;
  height?: number | null;
};

/** One file to upload. The bytes are in memory: the server read them from the clone and checked them against the staged blob id. */
export type DraftFile = {
  /** The file name the store shows. Never a path. */
  name: string;
  mime: 'image/png' | 'image/jpeg';
  bytes: Uint8Array;
  /** Lower case hexadecimal. Apple's commit needs the MD5 of the whole file. */
  md5: string;
  /** Lower case hexadecimal. Google Play reports the SHA-256 of an uploaded image. */
  sha256: string;
};

/** The whole set a slot should hold afterwards, in order. A write replaces the store's set with it. */
export type DraftAssetWrite = DraftSlot & { files: DraftFile[] };

/** What a read is asked for: the texts and the sets the staged changes are about. */
export type DraftReadRequest = {
  text: { locale: string; field: string }[];
  assets: DraftSlot[];
};

export type DraftTextState = {
  locale: string;
  field: string;
  /** Null: the store has no value (the field, or the whole locale, is not there). */
  value: string | null;
  /** The store's draft has this locale at all. */
  localeExists: boolean;
};

/** One graphic of a set as the store reports it. */
export type DraftImageState = {
  /** App Store: the id of the placement (the asset library keeps the image apart from where it is shown). Google Play: the image id. */
  id: string;
  /** App Store: the file name. Google Play: null. */
  name: string | null;
  /**
   * Lower case hex of the whole file (Google Play SHA-256), or null while unknown. The App Store has no checksum:
   * this server writes the first 32 hex characters of the SHA-256 into the library image's `referenceName`
   * and reads them back from there (an image someone else uploaded has none, so it never counts as the same file).
   * A checksum shorter than the full 64 characters is compared as a prefix.
   */
  checksum: string | null;
  checksumKind: 'md5' | 'sha256';
  /** App Store: the library image's state (`PREPARE_FOR_SUBMISSION` once processed, ...). Google Play: null. */
  state: string | null;
};

export type DraftAssetState = {
  locale: string;
  kind: AssetKind;
  device: string | null;
  target: string;
  /** The set exists in the draft (App Store: the group has at least one placement; Google Play: always true). */
  setExists: boolean;
  /** App Store: the asset library placement group the set maps to (from Apple's reference data). Google Play: absent. */
  placementGroup?: string | null;
  /** In the store's order. */
  images: DraftImageState[];
};

/** The draft as the store holds it now, for what was asked. */
export type DraftState = {
  store: StoreName;
  platform: Platform;
  /** App Store: the editable version. Google Play: null (a draft is an edit). */
  version: { id: string; versionString: string | null; state: string } | null;
  text: DraftTextState[];
  assets: DraftAssetState[];
};

export type DraftStep = {
  type: 'text' | 'asset' | 'locale';
  locale: string;
  /** The field id (text), the set's store name (asset) or `locale`. */
  target: string;
  /** `applied`, or `already_same` (the store already held exactly this: nothing was sent). */
  outcome: 'applied' | 'already_same';
  /** Files uploaded and files removed, for a set of graphics. */
  uploaded?: number;
  removed?: number;
};

export type DraftApplyInput = {
  text: DraftTextWrite[];
  assets: DraftAssetWrite[];
  /**
   * Called with the draft read from the store right before the first write. When it says false
   * nothing is written and `DraftDriftError` is thrown: this is how "the store changed since the
   * preview" is decided on the freshest read there is.
   */
  guard: (current: DraftState) => boolean;
};

export type DraftApplyResult = {
  /** The state the guard accepted. */
  before: DraftState;
  steps: DraftStep[];
  /**
   * Google Play: the commit that held the changes back from review. App Store: always `none`
   * (there is no commit; every request changes the draft at once).
   */
  commit: 'not_sent_for_review' | 'none';
};

/** The store's draft is not what the person confirmed: nothing was written. */
export class DraftDriftError extends Error {
  readonly current: DraftState;
  constructor(current: DraftState) {
    super('The store changed since the preview was made.');
    this.name = 'DraftDriftError';
    this.current = current;
  }
}

/**
 * A draft write was sent and the store did not answer in a way that tells whether it was applied.
 * Nothing retries it: the caller reads the draft back. `completed` are the steps that finished
 * before it (App Store; Google Play has none before its single commit).
 */
export class DraftOutcomeUnknownError extends StoreError {
  readonly completed: DraftStep[];
  constructor(store: StoreName, message: string, completed: DraftStep[], status?: number) {
    super(store, 'network', message, status);
    this.name = 'DraftOutcomeUnknownError';
    this.completed = completed;
  }
}

/**
 * The App Store applies a draft one request at a time. A request was refused after others had
 * been applied: `completed` were written and stay written, `failed` is where it stopped, `cause` is the store's refusal.
 */
export class DraftPartialError extends StoreError {
  readonly completed: DraftStep[];
  readonly failed: { type: DraftStep['type']; locale: string; target: string };
  readonly cause: StoreError;
  constructor(
    cause: StoreError,
    completed: DraftStep[],
    failed: { type: DraftStep['type']; locale: string; target: string },
  ) {
    super(cause.store, cause.kind, cause.message, cause.status, cause.details);
    this.name = 'DraftPartialError';
    this.completed = completed;
    this.failed = failed;
    this.cause = cause;
  }
}

/**
 * The write side of a store connector for drafts. Every `applyDraft` changes what is in the store's
 * draft, and never submits it. A refusal is a `StoreError` (nothing changed, except for a
 * `DraftPartialError`); `DraftOutcomeUnknownError` means it may have been applied; `DraftDriftError`
 * means the guard refused and nothing was sent.
 */
export interface StoreDraftConnector {
  readonly store: StoreName;
  readonly platform: Platform;
  /** The draft as the store holds it now. Changes nothing. */
  readDraft(request: DraftReadRequest): Promise<DraftState>;
  applyDraft(input: DraftApplyInput): Promise<DraftApplyResult>;
}

/** Stable form of a state for the confirmation hash: only what the confirmation depends on, in a fixed order. */
export function draftKey(state: DraftState): Record<string, unknown> {
  return {
    store: state.store,
    version: state.version === null ? null : { id: state.version.id, state: state.version.state },
    text: [...state.text]
      .sort((a, b) => (a.locale + '\u0000' + a.field).localeCompare(b.locale + '\u0000' + b.field))
      .map((t) => [t.locale, t.field, t.localeExists, t.value]),
    assets: [...state.assets]
      .sort((a, b) => (a.locale + '\u0000' + a.target).localeCompare(b.locale + '\u0000' + b.target))
      .map((a) => [a.locale, a.target, a.setExists, a.images.map((i) => [i.id, i.checksum, i.state])]),
  };
}

export const sameDraftState = (a: DraftState, b: DraftState): boolean =>
  JSON.stringify(draftKey(a)) === JSON.stringify(draftKey(b));

/**
 * Image states in which an image is processed and can be used: App Store Connect's `COMPLETE` (the
 * deprecated screenshots) and the asset library's states from `PREPARE_FOR_SUBMISSION` on. Anything else
 * (`AWAITING_UPLOAD`, `UPLOAD_COMPLETE`, `FAILED`, `REJECTED`, `ARCHIVED`) is not a finished file.
 */
export const DRAFT_IMAGE_READY_STATES: readonly string[] = [
  'COMPLETE',
  'PREPARE_FOR_SUBMISSION',
  'READY_FOR_REVIEW',
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'ACCEPTED',
  'APPROVED',
];

/** Whether a set holds exactly these files, in this order (by checksum). */
export function setMatches(image: readonly DraftImageState[], files: readonly Pick<DraftFile, 'md5' | 'sha256'>[]): boolean {
  if (image.length !== files.length) return false;
  for (let i = 0; i < files.length; i++) {
    const have = image[i] as DraftImageState;
    const want = files[i] as Pick<DraftFile, 'md5' | 'sha256'>;
    const wanted = have.checksumKind === 'md5' ? want.md5 : want.sha256;
    if (have.checksum === null) return false;
    const got = have.checksum.toLowerCase();
    if (got.length < wanted.length ? !wanted.startsWith(got) || got.length < 16 : got !== wanted) return false;
    if (have.state !== null && !DRAFT_IMAGE_READY_STATES.includes(have.state)) return false;
  }
  return true;
}

/** An App Store version state in which the listing can still be edited without touching a review. */
export const APPLE_DRAFT_VERSION_STATES: readonly string[] = [
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
];

export const MAX_DRAFT_TEXTS = 600;
export const MAX_DRAFT_SLOTS = 100;

// ---------------------------------------------------------------------------------------------
// Reading the store's images (docs/adr/0012-assets-two-way-sync.md). Read only: nothing here writes to a store.

/** One image a store holds, in one set, with where its bytes can be fetched (never the credential). */
export type StoreImageRecord = {
  locale: string;
  kind: AssetKind;
  device: string | null;
  /** The store's own name of the set: an Apple placement group, a Google Play image type. */
  target: string;
  /** 1-based, the store's display order within (locale, kind, device). */
  position: number;
  /** App Store: the library image id. Google Play: the image id. */
  id: string;
  name: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  /** Lower case hex of the whole file, or of its first characters (`mrm:sha256:` of this server's own uploads), or null. */
  checksum: string | null;
  checksumKind: 'sha256' | 'md5' | null;
  state: string | null;
  /**
   * Where the bytes are: Apple's `imageAsset.templateUrl` (a template with `{w}`, `{h}` and `{f}`) or Google Play's image
   * `url`. Null when the store gave none. The server downloads only from an allowlist of the stores' CDN hosts.
   */
  url: string | null;
  urlKind: 'apple_template' | 'play_url' | null;
};

export type StoreImagesRead = {
  version: { id: string; versionString: string | null; state: string; editable: boolean } | null;
  images: StoreImageRecord[];
  /** Images in a slot this server has no name for (an unknown display size). */
  unplaced: number;
  notes: string[];
};

/** The read side that both draft connectors have besides `StoreDraftConnector`. Changes nothing in the store. */
export interface StoreImageReader {
  readStoreImages(): Promise<StoreImagesRead>;
}

export const isStoreImageReader = (value: unknown): value is StoreImageReader =>
  typeof value === 'object' && value !== null && typeof (value as { readStoreImages?: unknown }).readStoreImages === 'function';
