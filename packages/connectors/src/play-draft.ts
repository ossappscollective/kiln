import {
  type AssetKind,
  normalizeReleaseValue,
  PLAY_DEVICES,
  PLAY_LISTING_MEMBERS,
  versionCodesOf,
} from '@mrm/core';
import { StoreError, StoreRateLimitError } from './errors.ts';
import { GoogleTokenProvider, parseServiceAccount, type ServiceAccount } from './google-auth.ts';
import { googleError, isPlayPackageName, serializedPlayEdits } from './googleplay.ts';
import { playCodeEligibility } from './release-eligibility.ts';
import {
  type CodeCandidate,
  type EditableRelease,
  MAX_NOTE_CHARS,
  MAX_NOTES_HISTORY_VERSIONS,
  type NotesHistoryEntry,
  type NotesHistoryRead,
  type PlayReleaseRead,
  type ReleaseCandidates,
  type StoreNotesHistoryReader,
  type StoreReleaseReader,
} from './release-types.ts';
import {
  type DraftApplyInput,
  type DraftApplyResult,
  type DraftAssetState,
  DraftDriftError,
  type DraftFieldFacts,
  type DraftFieldState,
  type DraftFieldWrite,
  type DraftImageState,
  DraftOutcomeUnknownError,
  type DraftReadRequest,
  type DraftState,
  type DraftStep,
  type DraftTextState,
  type StoreDraftConnector,
  type StoreImageReader,
  type StoreImageRecord,
  type StoreImagesRead,
  setMatches,
} from './store-draft-types.ts';
import {
  enc,
  isRecord,
  type Json,
  records,
  StoreHttp,
  type StoreHttpOptions,
  type StoreReply,
  text,
} from './store-http.ts';

/**
 * Google Play: write listing text and images into an EDIT and commit it WITHOUT sending it for
 * review. A STORE WRITE. Only ever called by the server's draft service, after a rights check, a
 * preview, a confirmation hash and a re-read (docs/adr/0009-staged-store-drafts.md). It is never
 * retried and never publishes or submits anything on purpose.
 *
 * An edit is the transactional unit of the Play Developer API
 * (https://developers.google.com/android-publisher/edits): nothing changes until `edits.commit`, so a
 * failure before the commit (a refused upload, a drift refusal, a timeout) changes nothing and the edit
 * is deleted. The commit is the one request that changes the store.
 *
 * Endpoints. VERIFIED on Google's pages on 2026-11-18 unless marked UNVERIFIED:
 *
 * - `POST .../edits` (insert), `DELETE .../edits/{editId}` (as the read-only connector).
 * - `GET .../edits/{editId}/listings` (`edits.listings.list`), `PUT .../edits/{editId}/listings/{language}`
 *   (`edits.listings.update`: "Creates or updates a localized store listing"; the body is a `Listing`:
 *   `language`, `title`, `fullDescription`, `shortDescription`, `video`). UNVERIFIED: whether `update`
 *   REPLACES the listing, so this connector sends every member it read, with the changed ones replaced.
 * - `GET .../edits/{editId}/listings/{language}/{imageType}` (`edits.images.list`: `images[]` with `id`,
 *   `url`, `sha1`, `sha256`), `DELETE` of the same path (`edits.images.deleteall`: "Removes all images for a
 *   given language and image type"), and the upload
 *   `POST https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/{packageName}/edits/{editId}/listings/{language}/{imageType}`
 *   ("Upload URI, for media upload requests"; the answer has one `image`). `imageType` is an `AppImageType`:
 *   `phoneScreenshots`, `sevenInchScreenshots`, `tenInchScreenshots`, `tvScreenshots`, `wearScreenshots`,
 *   `icon`, `featureGraphic`, `tvBanner` (no promo graphic). UNVERIFIED: the query parameter
 *   `uploadType=media` (Google's usual simple upload) and the accepted types and sizes (the page states
 *   none; this server only sends png and jpeg within its own caps), and that the upload order is the
 *   display order of screenshots.
 * - `POST .../edits/{editId}:commit` with `changesNotSentForReview=true`: "the edit's changes are held
 *   back from review until someone explicitly sends them for review in the Google Play Console UI"
 *   (https://developers.google.com/android-publisher/api-ref/rest/v3/edits/commit; the page describes it
 *   as applying "when a rejection happens" and says nothing more about when it is required or allowed).
 *   `changesInReviewBehavior=ERROR_IF_IN_REVIEW` is sent too, so a review in progress is never cancelled
 *   (its default `CANCEL_IN_REVIEW_AND_SUBMIT` would cancel it and submit everything). If Play refuses
 *   `changesNotSentForReview` the answer is a `draft_not_allowed` error and NOTHING is committed: the connector
 *   never retries without it, because a commit without it may send the changes for review (UNVERIFIED how Play
 *   behaves per app, e.g. with managed publishing off).
 * - UNVERIFIED: whether a changed listing or image that was committed but not sent for review shows in
 *   a later edit, so the state read after a commit may not show the draft: a lost commit answer is
 *   `DraftOutcomeUnknownError` and the server does not claim to know (it asks the person to look in Play Console).
 *
 * Before the commit the connector lists the images of every replaced set again and compares the SHA-256
 * Google reports with the files it sent: a mismatch deletes the edit (nothing applied). Writes use their
 * own `StoreHttp` with no rate-limit waits. A timeout, a cut connection or a 5xx on the commit is a
 * `DraftOutcomeUnknownError`. Edits of one service account are serialized with the read-only connector's queue.
 *
 * No message carries the service account key or an access token.
 */

export type PlayDraftConnectorOptions = Omit<StoreHttpOptions, 'store'> & {
  /** The service account JSON key file (as stored), or its parsed fields. */
  serviceAccount: string | ServiceAccount;
  /** The package name (application id) of the app. */
  packageName: string;
  /** Defaults to https://androidpublisher.googleapis.com. */
  apiBase?: string;
};

const DEFAULT_BASE = 'https://androidpublisher.googleapis.com';
/** Listing languages whose images one read looks at (each costs one request per image type). */
const MAX_READ_LANGUAGES = 60;

export class PlayDraftConnector
  implements StoreDraftConnector, StoreImageReader, StoreReleaseReader, StoreNotesHistoryReader
{
  readonly store = 'googleplay' as const;
  readonly platform = 'android' as const;
  readonly packageName: string;
  readonly #http: StoreHttp;
  readonly #writeHttp: StoreHttp;
  readonly #tokens: GoogleTokenProvider;
  readonly #base: string;
  readonly #account: ServiceAccount;

  constructor(options: PlayDraftConnectorOptions) {
    this.#account =
      typeof options.serviceAccount === 'string'
        ? parseServiceAccount(options.serviceAccount)
        : options.serviceAccount;
    if (!isPlayPackageName(options.packageName)) {
      throw new StoreError(
        'googleplay',
        'invalid_input',
        `Not a valid Android package name: ${JSON.stringify(options.packageName.slice(0, 80))}.`,
      );
    }
    this.packageName = options.packageName;
    this.#http = new StoreHttp({ ...options, store: 'googleplay' });
    this.#writeHttp = new StoreHttp({ ...options, store: 'googleplay', maxRateLimitRetries: 0 });
    this.#base = (options.apiBase ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.#tokens = new GoogleTokenProvider(this.#account, this.#http);
    for (const known of this.#http.known) this.#writeHttp.known.add(known);
  }

  async readDraft(request: DraftReadRequest): Promise<DraftState> {
    return serializedPlayEdits(this.#account.clientEmail, async () => {
      for (let attempt = 0; ; attempt++) {
        const editId = await this.#insertEdit(this.#http);
        try {
          return await this.#state(this.#http, editId, request);
        } catch (error) {
          if (error instanceof StoreError && error.kind === 'edit_invalid' && attempt === 0)
            continue;
          throw error;
        } finally {
          await this.#deleteEdit(this.#http, editId);
        }
      }
    });
  }

  /**
   * READ ONLY: the images of every listing language in a throw away edit (`edits.insert`, `edits.listings.list`,
   * `edits.images.list` per language and image type, `edits.delete`; nothing is committed). VERIFIED on Google's pages (read
   * 2026-11-18): `Image` has `id`, `url` ("A URL that will serve a preview of the image"), `sha1` and `sha256`. That the
   * `url` serves the full size file, and which host it is on, is UNVERIFIED: the server downloads from an allowlist
   * of Google's image hosts and checks the SHA-256 of what came against the one listed; a file that does not match is
   * reported, never silently taken as the store's file. The pixel size is not in the answer (null until the file is read).
   */
  async readStoreImages(): Promise<StoreImagesRead> {
    const kinds: { target: string; kind: AssetKind; device: string | null }[] = [
      { target: 'icon', kind: 'icon', device: null },
      { target: 'featureGraphic', kind: 'feature_graphic', device: null },
      { target: 'tvBanner', kind: 'tv_banner', device: null },
      ...PLAY_DEVICES.map((d) => ({
        target: d.dir,
        kind: 'screenshot' as AssetKind,
        device: d.id as string | null,
      })),
    ];
    return serializedPlayEdits(this.#account.clientEmail, async () => {
      const editId = await this.#insertEdit(this.#http);
      try {
        const out: StoreImageRecord[] = [];
        const notes: string[] = [];
        const languages = [...(await this.#listings(this.#http, editId)).keys()].sort();
        if (languages.length > MAX_READ_LANGUAGES)
          notes.push(
            `Only the first ${MAX_READ_LANGUAGES} of ${languages.length} listing languages were read.`,
          );
        for (const locale of languages.slice(0, MAX_READ_LANGUAGES)) {
          for (const k of kinds) {
            const reply = await this.#imagesRaw(this.#http, editId, locale, k.target);
            reply.forEach((image, i) => {
              const id = text(image.id);
              if (!id) return;
              const url = text(image.url) ?? null;
              const checksum = text(image.sha256)?.toLowerCase() ?? null;
              out.push({
                locale,
                kind: k.kind,
                device: k.device,
                target: k.target,
                position: i + 1,
                id,
                name: null,
                width: null,
                height: null,
                bytes: null,
                checksum,
                checksumKind: checksum === null ? null : 'sha256',
                state: null,
                url,
                urlKind: url === null ? null : 'play_url',
              });
            });
          }
        }
        return { version: null, images: out, unplaced: 0, notes };
      } finally {
        await this.#deleteEdit(this.#http, editId);
      }
    });
  }

  async #imagesRaw(
    http: StoreHttp,
    editId: string,
    language: string,
    type: string,
  ): Promise<Json[]> {
    try {
      const reply = await this.#call(
        http,
        'GET',
        this.#url(`/${enc(editId)}/listings/${enc(language)}/${enc(type)}`),
        `reading the ${type} of ${language}`,
      );
      return records(isRecord(reply.json) ? reply.json.images : undefined);
    } catch (error) {
      if (error instanceof StoreError && error.kind === 'not_found') return [];
      throw error;
    }
  }

  async applyDraft(input: DraftApplyInput): Promise<DraftApplyResult> {
    const request: DraftReadRequest = {
      text: input.text.map((t) => ({ locale: t.locale, field: t.field })),
      assets: input.assets.map((a) => ({
        locale: a.locale,
        kind: a.kind,
        device: a.device,
        target: a.target,
      })),
      ...(input.fields !== undefined && input.fields.length > 0 ? { fields: input.fields } : {}),
    };
    return serializedPlayEdits(this.#account.clientEmail, async () => {
      const http = this.#writeHttp;
      const editId = await this.#insertEdit(http);
      let settled = false;
      try {
        const listings = await this.#listings(http, editId);
        const before = await this.#state(http, editId, request, listings);
        if (!input.guard(before)) throw new DraftDriftError(before);
        const steps: DraftStep[] = [];

        // Texts: one listing per language, every member as read with the changed ones replaced.
        const byLocale = new Map<string, Map<string, string>>();
        for (const t of input.text) {
          const fields = byLocale.get(t.locale) ?? new Map<string, string>();
          fields.set(t.field, t.value);
          byLocale.set(t.locale, fields);
        }
        for (const [locale, fields] of byLocale) {
          const current = listings.get(locale);
          const body: Json = { ...(current ?? {}), language: locale };
          const changedFields = new Set<string>();
          for (const [field, value] of fields) {
            const member = PLAY_LISTING_MEMBERS[field] ?? '';
            if (!current || current[member] !== value) changedFields.add(field);
            body[member] = value;
          }
          if (changedFields.size > 0) {
            await this.#call(
              http,
              'PUT',
              this.#url(`/${enc(editId)}/listings/${enc(locale)}`),
              `changing the ${locale} listing`,
              { json: body },
            );
          }
          for (const field of fields.keys())
            steps.push({
              type: 'text',
              locale,
              target: field,
              outcome: changedFields.has(field) ? 'applied' : 'already_same',
            });
        }

        // The draft release of a track (name, version codes, release notes per language): one `tracks.update`.
        if (input.fields !== undefined && input.fields.length > 0) {
          steps.push(...(await this.#applyFields(http, editId, input.fields, before.fields ?? [])));
        }

        // Graphics: a set is replaced as a whole (delete all, upload in order), then checked against Google's SHA-256.
        for (const write of input.assets) {
          const state = before.assets.find(
            (a) => a.locale === write.locale && a.target === write.target,
          );
          if (state && setMatches(state.images, write.files)) {
            steps.push({
              type: 'asset',
              locale: write.locale,
              target: write.target,
              outcome: 'already_same',
            });
            continue;
          }
          const path = `/${enc(editId)}/listings/${enc(write.locale)}/${enc(write.target)}`;
          await this.#call(
            http,
            'DELETE',
            this.#url(path),
            `removing the ${write.target} of ${write.locale}`,
          );
          for (const file of write.files) {
            await this.#call(
              http,
              'POST',
              `${this.#base}/upload/androidpublisher/v3/applications/${enc(this.packageName)}/edits${path}?uploadType=media`,
              `uploading ${file.name}`,
              {
                raw: { body: file.bytes, contentType: file.mime },
              },
            );
          }
          const now = await this.#images(http, editId, write.locale, write.target);
          if (!setMatches(now, write.files)) {
            throw new StoreError(
              'googleplay',
              'unexpected',
              `Google Play does not list the ${write.target} of ${write.locale} as it was uploaded (the checksums differ), so nothing was committed.`,
            );
          }
          steps.push({
            type: 'asset',
            locale: write.locale,
            target: write.target,
            outcome: 'applied',
            uploaded: write.files.length,
            removed: state?.images.length ?? 0,
          });
        }

        if (!steps.some((s) => s.outcome === 'applied')) {
          // Nothing differs: no commit, so nothing is sent anywhere.
          return { before, steps, commit: 'none' as const };
        }
        // From here on the request may be applied even if the answer is lost.
        settled = true;
        try {
          await this.#commit(editId);
        } catch (error) {
          // A refused commit (4xx) applied nothing: the edit is deleted below. An unknown one is left alone.
          if (!(error instanceof DraftOutcomeUnknownError)) settled = false;
          throw error;
        }
        return { before, steps, commit: 'not_sent_for_review' as const };
      } finally {
        if (!settled) await this.#deleteEdit(http, editId);
      }
    });
  }

  // -------------------------------------------------------------------------------------------
  // The draft release of a track (docs/api/releases-write.md)
  //
  // VERIFIED on Google's pages (read 2026-11-19): `Release` has `name`, `versionCodes[]`, `releaseNotes[]` (`LocalizedText`:
  // `language`, `text`), `status` (`draft`: "APKs are not served to users") and `userFraction` ("0 < fraction < 1 ... can only be set
  // when status is inProgress or halted", so a draft cannot hold a share); `edits.tracks.get` and `edits.tracks.update`
  // (`PUT .../tracks/{track}`, body and answer a `Track`); `edits.bundles.list` (`bundles[]`: `versionCode`, `sha1`, `sha256`) and
  // `edits.apks.list` (`apks[]`: the `Apk` fields are not on the page: `versionCode` is UNVERIFIED). Google's tracks page: "Draft
  // releases allow you to automatically upload APKs and create a release via the API ... can now be inspected and rolled out via the
  // Google Play Console or the API". UNVERIFIED: whether `tracks.update` REPLACES all the releases of the track (this connector sends
  // every other release back as read), whether a track may hold more than one draft release (this connector refuses to guess), and
  // whether a commit with `changesNotSentForReview` is accepted for a track change.

  async #readTrack(http: StoreHttp, editId: string, track: string): Promise<Json[]> {
    try {
      const reply = await this.#call(
        http,
        'GET',
        this.#url(`/${enc(editId)}/tracks/${enc(track)}`),
        `reading the ${track} track`,
      );
      return records(isRecord(reply.json) ? reply.json.releases : undefined);
    } catch (error) {
      if (error instanceof StoreError && error.kind === 'not_found') return [];
      throw error;
    }
  }

  /** The version codes Play lists as uploaded: app bundles and APKs of the app. */
  async #uploaded(
    http: StoreHttp,
    editId: string,
  ): Promise<Map<string, { source: 'bundle' | 'apk'; sha256: string | null }>> {
    const out = new Map<string, { source: 'bundle' | 'apk'; sha256: string | null }>();
    const bundles = await this.#call(
      http,
      'GET',
      this.#url(`/${enc(editId)}/bundles`),
      'listing the app bundles',
    );
    for (const b of records(isRecord(bundles.json) ? bundles.json.bundles : undefined)) {
      const code =
        typeof b.versionCode === 'number' || typeof b.versionCode === 'string'
          ? String(b.versionCode)
          : undefined;
      if (code) out.set(code, { source: 'bundle', sha256: text(b.sha256)?.toLowerCase() ?? null });
    }
    try {
      const apks = await this.#call(
        http,
        'GET',
        this.#url(`/${enc(editId)}/apks`),
        'listing the APKs',
      );
      for (const a of records(isRecord(apks.json) ? apks.json.apks : undefined)) {
        const code =
          typeof a.versionCode === 'number' || typeof a.versionCode === 'string'
            ? String(a.versionCode)
            : undefined;
        const binary = isRecord(a.binary) ? a.binary : {};
        if (code && !out.has(code))
          out.set(code, { source: 'apk', sha256: text(binary.sha256)?.toLowerCase() ?? null });
      }
    } catch (error) {
      if (!(error instanceof StoreError) || error.kind !== 'not_found') throw error;
    }
    return out;
  }

  static #releaseRead(r: Json): PlayReleaseRead {
    return {
      name: text(r.name) ?? null,
      status: text(r.status) ?? 'statusUnspecified',
      userFraction: typeof r.userFraction === 'number' ? r.userFraction : null,
      versionCodes: Array.isArray(r.versionCodes) ? r.versionCodes.map(String) : [],
      notes: records(r.releaseNotes).flatMap((n) => {
        const language = text(n.language);
        const body = text(n.text);
        return language && body !== undefined ? [{ locale: language, text: body }] : [];
      }),
    };
  }

  static #draftOf(track: string, releases: Json[]): Json | undefined {
    const drafts = releases.filter((r) => text(r.status) === 'draft');
    if (drafts.length > 1) {
      throw new StoreError(
        'googleplay',
        'invalid_input',
        `The ${track} track has more than one draft release; this server will not guess which one to change. Remove one in Play Console.`,
      );
    }
    return drafts[0];
  }

  async #readFields(
    http: StoreHttp,
    editId: string,
    wanted: readonly DraftFieldWrite[],
  ): Promise<DraftFieldState[]> {
    const track = wanted.find((w) => w.field === 'track')?.value;
    if (track === undefined) return [];
    const releases = await this.#readTrack(http, editId, track);
    const draft = PlayDraftConnector.#draftOf(track, releases);
    const read = draft ? PlayDraftConnector.#releaseRead(draft) : undefined;
    const uploaded = wanted.some((w) => w.field === 'version_codes')
      ? await this.#uploaded(http, editId)
      : undefined;
    const out: DraftFieldState[] = [];
    for (const w of wanted) {
      if (w.field === 'track') {
        out.push({
          field: 'track',
          locale: '',
          value: track,
          facts: {
            draftCount: draft ? 1 : 0,
            otherInProgress: releases.filter((r) => text(r.status) === 'inProgress').length,
          },
        });
      } else if (w.field === 'release_name') {
        out.push({ field: w.field, locale: '', value: read?.name ?? null });
      } else if (w.field === 'version_codes') {
        const missing = versionCodesOf(w.value).filter(
          (code) => !(uploaded as Map<string, unknown>).has(code),
        );
        const facts: DraftFieldFacts = { missing: missing.join(',') };
        out.push({
          field: w.field,
          locale: '',
          value: read ? normalizeReleaseValue('version_codes', read.versionCodes) : null,
          facts,
        });
      } else if (w.field === 'release_notes') {
        out.push({
          field: w.field,
          locale: w.locale,
          value: read?.notes.find((n) => n.locale === w.locale)?.text ?? null,
        });
      } else {
        out.push({ field: w.field, locale: w.locale, value: null });
      }
    }
    return out;
  }

  /** Rewrites the draft release of the track with the wanted fields, every other release as read. One `tracks.update`, committed later. */
  async #applyFields(
    http: StoreHttp,
    editId: string,
    wanted: readonly DraftFieldWrite[],
    current: readonly DraftFieldState[],
  ): Promise<DraftStep[]> {
    const track = wanted.find((w) => w.field === 'track')?.value;
    if (track === undefined)
      throw new StoreError('googleplay', 'invalid_input', 'Stage the track of the draft release.');
    const releases = await this.#readTrack(http, editId, track);
    const draft = PlayDraftConnector.#draftOf(track, releases);
    const now = (field: string, locale: string) =>
      current.find((c) => c.field === field && c.locale === locale)?.value ?? null;
    const writes = wanted.filter((w) => w.field !== 'track' && w.field !== 'user_fraction');
    const differs = (w: DraftFieldWrite) => now(w.field, w.locale) !== w.value;
    const steps: DraftStep[] = [
      { type: 'field', locale: '', target: 'track', outcome: 'already_same' },
    ];
    if (writes.some(differs)) {
      const codes = writes.find((w) => w.field === 'version_codes');
      if (!draft && !codes) {
        throw new StoreError(
          'googleplay',
          'invalid_input',
          `The ${track} track has no draft release and no version codes were staged, so there is nothing to build a draft release from.`,
        );
      }
      const next: Json = { ...(draft ?? {}), status: 'draft' };
      for (const w of writes) {
        if (w.field === 'release_name') next.name = w.value;
        else if (w.field === 'version_codes') next.versionCodes = versionCodesOf(w.value);
      }
      const notes = new Map<string, string>(
        records(next.releaseNotes).flatMap((n) =>
          text(n.language) !== undefined
            ? [[text(n.language) as string, text(n.text) ?? ''] as [string, string]]
            : [],
        ),
      );
      let notesChanged = false;
      for (const w of writes) {
        if (w.field === 'release_notes') {
          notes.set(w.locale, w.value);
          notesChanged = true;
        }
      }
      if (notesChanged)
        next.releaseNotes = [...notes].map(([language, body]) => ({ language, text: body }));
      const index = draft ? releases.indexOf(draft) : -1;
      const all =
        index === -1 ? [...releases, next] : releases.map((r, i) => (i === index ? next : r));
      await this.#call(
        http,
        'PUT',
        this.#url(`/${enc(editId)}/tracks/${enc(track)}`),
        `changing the draft release of the ${track} track`,
        { json: { track, releases: all } },
      );
    }
    for (const w of writes) {
      steps.push({
        type: 'field',
        locale: w.field === 'release_notes' ? w.locale : '',
        target: w.field,
        outcome: differs(w) ? 'applied' : 'already_same',
      });
    }
    return steps;
  }

  // -------------------------------------------------------------------------------------------
  // Release reads (StoreReleaseReader): a throw away edit, nothing is committed

  async listReleaseCandidates(input: {
    version?: string;
    track?: string;
  }): Promise<ReleaseCandidates> {
    const track = input.track;
    if (track === undefined || track === '')
      throw new StoreError(
        'googleplay',
        'invalid_input',
        'Name the track (for example production).',
      );
    return serializedPlayEdits(this.#account.clientEmail, async () => {
      const editId = await this.#insertEdit(this.#http);
      try {
        const uploaded = await this.#uploaded(this.#http, editId);
        const releases = (await this.#readTrack(this.#http, editId, track)).map((r) =>
          PlayDraftConnector.#releaseRead(r),
        );
        const codes: CodeCandidate[] = [...uploaded]
          .map(([versionCode, u]) => {
            const inTrack = releases
              .filter((r) => r.versionCodes.includes(versionCode))
              .map((r) => ({ name: r.name, status: r.status }));
            return {
              versionCode,
              source: u.source,
              sha256: u.sha256,
              inTrack,
              eligibility: playCodeEligibility({ versionCode, inTrack }),
            };
          })
          .sort((a, b) => Number(b.versionCode) - Number(a.versionCode));
        return { store: 'googleplay' as const, platform: 'android' as const, track, codes };
      } finally {
        await this.#deleteEdit(this.#http, editId);
      }
    });
  }

  /**
   * The notes of the releases the tracks hold now (`StoreNotesHistoryReader`): `edits.tracks.list` in a throw away edit. VERIFIED
   * on Google's page (read 2026-11-19): a `Track` holds `releases[]`, each with `name`, `versionCodes[]`, `status` and
   * `releaseNotes[]` (`language`, `text`); the track list shows the active releases only, so releases that were replaced are NOT
   * here and this is a short history, not the whole one. Google gives no date for a release: `at` is null and the order is the
   * highest version code of the release, newest first. Texts are cut at MAX_NOTE_CHARS and never logged.
   */
  async readNotesHistory(
    input: { locale?: string; maxVersions?: number } = {},
  ): Promise<NotesHistoryRead> {
    const limit = Math.min(
      Math.max(Math.trunc(input.maxVersions ?? MAX_NOTES_HISTORY_VERSIONS), 1),
      MAX_NOTES_HISTORY_VERSIONS,
    );
    const wantedLocale =
      input.locale === undefined || input.locale === ''
        ? undefined
        : input.locale.toLowerCase().replace(/_/g, '-');
    return serializedPlayEdits(this.#account.clientEmail, async () => {
      const editId = await this.#insertEdit(this.#http);
      try {
        const reply = await this.#call(
          this.#http,
          'GET',
          this.#url(`/${enc(editId)}/tracks`),
          'listing the tracks',
        );
        const releases: { track: string; read: PlayReleaseRead; top: number }[] = [];
        for (const t of records(isRecord(reply.json) ? reply.json.tracks : undefined)) {
          const track = text(t.track);
          if (!track) continue;
          for (const r of records(t.releases)) {
            const read = PlayDraftConnector.#releaseRead(r);
            releases.push({
              track,
              read,
              top: Math.max(0, ...read.versionCodes.map(Number).filter(Number.isFinite)),
            });
          }
        }
        releases.sort((a, b) => b.top - a.top || a.track.localeCompare(b.track));
        const chosen = releases.slice(0, limit);
        const entries: NotesHistoryEntry[] = [];
        for (const { track, read } of chosen) {
          for (const n of read.notes) {
            if (
              wantedLocale !== undefined &&
              n.locale.toLowerCase().replace(/_/g, '-') !== wantedLocale
            )
              continue;
            if (n.text.trim() === '') continue;
            const truncated = n.text.length > MAX_NOTE_CHARS;
            let end = Math.min(n.text.length, MAX_NOTE_CHARS);
            const last = n.text.charCodeAt(end - 1);
            if (truncated && last >= 0xd800 && last <= 0xdbff) end--;
            entries.push({
              source: 'googleplay',
              locale: n.locale,
              text: n.text.slice(0, end),
              truncated,
              version: read.name,
              track,
              versionCodes: [...read.versionCodes],
              state: read.status,
              at: null,
            });
          }
        }
        return {
          entries,
          truncated: releases.length > chosen.length,
          versionsRead: chosen.length,
          failed: 0,
        };
      } finally {
        await this.#deleteEdit(this.#http, editId);
      }
    });
  }

  async readEditableRelease(input: { track?: string }): Promise<EditableRelease> {
    const track = input.track;
    if (track === undefined || track === '')
      throw new StoreError(
        'googleplay',
        'invalid_input',
        'Name the track (for example production).',
      );
    return serializedPlayEdits(this.#account.clientEmail, async () => {
      const editId = await this.#insertEdit(this.#http);
      try {
        const releases = await this.#readTrack(this.#http, editId, track);
        const draft = PlayDraftConnector.#draftOf(track, releases);
        return {
          store: 'googleplay' as const,
          platform: 'android' as const,
          track,
          draft: draft ? PlayDraftConnector.#releaseRead(draft) : null,
          others: releases
            .filter((r) => r !== draft)
            .map((r) => PlayDraftConnector.#releaseRead(r)),
        };
      } finally {
        await this.#deleteEdit(this.#http, editId);
      }
    });
  }

  // -------------------------------------------------------------------------------------------

  async #listings(http: StoreHttp, editId: string): Promise<Map<string, Json>> {
    const reply = await this.#call(
      http,
      'GET',
      this.#url(`/${enc(editId)}/listings`),
      'reading the listings',
    );
    const out = new Map<string, Json>();
    for (const item of records(isRecord(reply.json) ? reply.json.listings : undefined)) {
      const language = text(item.language);
      if (language) out.set(language, item);
    }
    return out;
  }

  async #images(
    http: StoreHttp,
    editId: string,
    language: string,
    type: string,
  ): Promise<DraftImageState[]> {
    try {
      const reply = await this.#call(
        http,
        'GET',
        this.#url(`/${enc(editId)}/listings/${enc(language)}/${enc(type)}`),
        `reading the ${type} of ${language}`,
      );
      return records(isRecord(reply.json) ? reply.json.images : undefined).flatMap((image) => {
        const id = text(image.id);
        return id
          ? [
              {
                id,
                name: null,
                checksum: text(image.sha256)?.toLowerCase() ?? null,
                checksumKind: 'sha256' as const,
                state: null,
              },
            ]
          : [];
      });
    } catch (error) {
      // A language that has no listing yet has no images either.
      if (error instanceof StoreError && error.kind === 'not_found') return [];
      throw error;
    }
  }

  async #state(
    http: StoreHttp,
    editId: string,
    request: DraftReadRequest,
    known?: Map<string, Json>,
  ): Promise<DraftState> {
    const listings = known ?? (await this.#listings(http, editId));
    const textState: DraftTextState[] = request.text.map((t) => {
      const listing = listings.get(t.locale);
      const value = listing ? text(listing[PLAY_LISTING_MEMBERS[t.field] ?? '']) : undefined;
      return {
        locale: t.locale,
        field: t.field,
        value: value ?? null,
        localeExists: listing !== undefined,
      };
    });
    const assets: DraftAssetState[] = [];
    for (const slot of request.assets) {
      assets.push({
        locale: slot.locale,
        kind: slot.kind,
        device: slot.device,
        target: slot.target,
        setExists: true,
        images: await this.#images(http, editId, slot.locale, slot.target),
      });
    }
    const fields =
      request.fields !== undefined && request.fields.length > 0
        ? await this.#readFields(http, editId, request.fields)
        : undefined;
    return {
      store: 'googleplay',
      platform: 'android',
      version: null,
      text: textState,
      assets,
      ...(fields !== undefined ? { fields } : {}),
    };
  }

  #url(suffix: string): string {
    return `${this.#base}/androidpublisher/v3/applications/${enc(this.packageName)}/edits${suffix}`;
  }

  async #insertEdit(http: StoreHttp): Promise<string> {
    const reply = await this.#call(http, 'POST', this.#url(''), 'opening an edit', { json: {} });
    const id = isRecord(reply.json) ? text(reply.json.id) : undefined;
    if (!id)
      throw new StoreError(
        'googleplay',
        'unexpected',
        'Google Play opened an edit but sent no edit id.',
        reply.status,
      );
    return id;
  }

  /** Best effort. An undeleted edit is harmless: the next insert invalidates it, and it expires. */
  async #deleteEdit(http: StoreHttp, editId: string): Promise<void> {
    try {
      await this.#call(http, 'DELETE', this.#url(`/${enc(editId)}`), 'deleting the edit');
    } catch {
      // Nothing was committed, so there is nothing to undo.
    }
  }

  /**
   * The commit, held back from review (`changesNotSentForReview=true`) and never cancelling a review
   * in progress (`changesInReviewBehavior=ERROR_IF_IN_REVIEW`). A lost answer or a 5xx is `DraftOutcomeUnknownError`.
   */
  async #commit(editId: string): Promise<void> {
    const what = 'committing the draft';
    const url = `${this.#url(`/${enc(editId)}`)}:commit?changesNotSentForReview=true&changesInReviewBehavior=ERROR_IF_IN_REVIEW`;
    for (let attempt = 0; ; attempt++) {
      const token = await this.#tokens.token();
      let reply: StoreReply;
      try {
        reply = await this.#writeHttp.send('POST', url, {
          headers: { authorization: `Bearer ${token}` },
        });
      } catch (error) {
        if (error instanceof StoreError && error.kind === 'network') {
          throw new DraftOutcomeUnknownError(
            'googleplay',
            `The connection to Google Play failed while ${what}, so it is not known whether Google applied it. ${error.message}`,
            [],
            error.status,
          );
        }
        throw error;
      }
      if (reply.status === 401 && attempt === 0) {
        // Google rejected the token before it looked at the request: a new token is safe to try once.
        this.#tokens.invalidate();
        continue;
      }
      if (reply.status >= 200 && reply.status < 300) return;
      if (reply.status >= 500) {
        throw new DraftOutcomeUnknownError(
          'googleplay',
          `Google Play answered HTTP ${reply.status} while ${what}, so it is not known whether Google applied it.`,
          [],
          reply.status,
        );
      }
      throw this.#refusal(reply, what);
    }
  }

  #refusal(reply: StoreReply, what: string): StoreError {
    const raw = JSON.stringify(reply.json ?? '');
    if (reply.status === 400 && /CHANGES_ALREADY_IN_REVIEW/.test(raw)) {
      return new StoreError(
        'googleplay',
        'changes_in_review',
        'Google Play has changes in review for this app, and this server does not cancel a review. Wait for the review to finish (or cancel it in Play Console) and try again. Nothing was changed.',
        400,
      );
    }
    if (reply.status === 400 && /changesNotSentForReview/i.test(raw)) {
      return new StoreError(
        'googleplay',
        'draft_not_allowed',
        'Google Play would not keep these changes apart from review for this app, so nothing was committed (a commit without that setting might send them for review, and this server never does that). Make the change in Play Console instead.',
        400,
      );
    }
    const error = googleError(reply, what, {
      packageName: this.packageName,
      ...(this.#account.projectId ? { projectId: this.#account.projectId } : {}),
    });
    if (error instanceof StoreRateLimitError) return error;
    if (reply.status === 403 && error.kind === 'forbidden') {
      return new StoreError(
        'googleplay',
        'forbidden',
        'Google Play refused the change (403). The service account must be allowed to edit the store listing of this app in Play Console (Users and permissions). See docs/credentials.md.',
        403,
      );
    }
    return new StoreError('googleplay', error.kind, this.#http.redact(error.message), error.status);
  }

  async #call(
    http: StoreHttp,
    method: string,
    url: string,
    what: string,
    body: { json?: unknown; raw?: { body: Uint8Array; contentType: string } } = {},
  ): Promise<StoreReply> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.#tokens.token();
      const reply = await http.send(method, url, {
        headers: { authorization: `Bearer ${token}` },
        ...(body.json !== undefined ? { json: body.json } : {}),
        ...(body.raw ? { raw: body.raw } : {}),
      });
      if (reply.status === 401 && attempt === 0) {
        this.#tokens.invalidate();
        continue;
      }
      if (reply.status >= 200 && reply.status < 300) {
        if (reply.malformed) {
          throw new StoreError(
            'googleplay',
            'unexpected',
            `Google Play answered ${what} with a response that could not be read.`,
            reply.status,
          );
        }
        return reply;
      }
      throw this.#refusal(reply, what);
    }
  }
}
