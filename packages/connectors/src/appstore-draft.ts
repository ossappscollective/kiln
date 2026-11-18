import { APPLE_VERSION_LOCALIZATION_ATTRIBUTES } from '@mrm/core';
import {
  AppStoreConnectTokenProvider,
  type AppStoreConnectKey,
  parseAppStoreConnectSecret,
} from './apple-auth.ts';
import { appleError } from './appstoreconnect.ts';
import { StoreError, type StoreErrorDetail } from './errors.ts';
import {
  APPLE_DRAFT_VERSION_STATES,
  type DraftApplyInput,
  type DraftApplyResult,
  type DraftAssetState,
  type DraftAssetWrite,
  DraftDriftError,
  type DraftImageState,
  DraftOutcomeUnknownError,
  DraftPartialError,
  type DraftReadRequest,
  type DraftState,
  type DraftStep,
  type DraftTextState,
  setMatches,
  type StoreDraftConnector,
} from './store-draft-types.ts';
import {
  enc,
  isRecord,
  type Json,
  records,
  type StoreHttpOptions,
  StoreHttp,
  type StoreReply,
  text,
} from './store-http.ts';

/**
 * App Store Connect: write listing text and screenshots into the EDITABLE App Store version, as a
 * draft. A STORE WRITE. Only ever called by the server's draft service, after a rights check, a
 * preview, a confirmation hash and a re-read of the draft (docs/adr/0009-staged-store-drafts.md).
 * It never submits the version for review, never creates a version and never releases anything.
 *
 * The version it writes to is the one whose state is in `APPLE_DRAFT_VERSION_STATES`
 * (`PREPARE_FOR_SUBMISSION` and the rejected states; the names are Apple's, that these are the states
 * in which a listing can be edited is not on Apple's pages: UNVERIFIED, as for the read connector). A
 * version waiting for or in review is never written. No such version: `no_editable_version`. More than one:
 * `invalid_input`, never a guess.
 *
 * Endpoints. VERIFIED means read on Apple's pages on 2026-11-18; Apple's field pages are mostly empty,
 * so request bodies are JSON:API as the read side and Apple's articles show them.
 *
 * - `GET /v1/apps/{id}/appStoreVersions`, `GET /v1/appStoreVersions/{id}/appStoreVersionLocalizations`
 *   (used by the read connector). VERIFIED.
 * - `PATCH /v1/appStoreVersionLocalizations/{id}` ("Modify an app store version localization",
 *   VERIFIED title). UNVERIFIED: the body, assumed to be `{ data: { type, id, attributes } }` with the
 *   attributes `description`, `keywords`, `marketingUrl`, `promotionalText`, `supportUrl`, `whatsNew`
 *   (the names the read connector parses).
 * - `POST /v1/appStoreVersionLocalizations` to add a locale: UNVERIFIED body (`attributes.locale`, relationship
 *   `appStoreVersion`).
 * - Screenshots. Apple DEPRECATED the set based resources (`appScreenshotSets`, `appScreenshots`) in App
 *   Store Connect API 4.5.1 in favour of the App Asset Library and placements
 *   (https://developer.apple.com/documentation/appstoreconnectapi/app-store-connect-api-4-5-1-release-notes,
 *   https://developer.apple.com/documentation/appstoreconnectapi/migrating-to-the-app-asset-library).
 *   This connector uses the deprecated set flow because the read side and the display types already
 *   speak it and its documented upload flow is complete; moving to the asset library (an image, then a
 *   placement with a placement group from the reference data) is future work. Whether Apple still
 *   accepts the deprecated resources for writes is UNVERIFIED (nothing was run).
 *   The upload flow, VERIFIED on https://developer.apple.com/documentation/appstoreconnectapi/uploading-assets-to-app-store-connect:
 *   1. `POST /v1/appScreenshots` with `fileName`, `fileSize` and the relationship `appScreenshotSet`:
 *      201, with `uploadOperations` (`method`, `url`, `length`, `offset`, `requestHeaders`) and the delivery
 *      state `AWAITING_UPLOAD`;
 *   2. every operation: the bytes `offset` to `offset + length` to `url` with its method and headers,
 *      no JWT (the URLs are unauthenticated and time limited);
 *   3. `PATCH /v1/appScreenshots/{id}` with `uploaded: true` and `sourceFileChecksum`, the MD5 of the
 *      whole file, then `UPLOAD_COMPLETE`;
 *   4. read the screenshot until `assetDeliveryState.state` is `COMPLETE` (success) or `FAILED` (terminal: delete
 *      it and start again).
 *   `POST /v1/appScreenshotSets` (a display type and the version localization), `DELETE /v1/appScreenshots/{id}`
 *   and the reordering `PATCH /v1/appScreenshotSets/{id}/relationships/appScreenshots` (VERIFIED names and
 *   titles; UNVERIFIED bodies: `{ data: [{ type: 'appScreenshots', id }] }` is assumed). The
 *   `screenshotDisplayType` values are UNVERIFIED (see core `APPLE_DISPLAY_TYPES`).
 *
 * Replacing a set: the new files are uploaded and processed FIRST and the old ones deleted after, when
 * the set has room for both (at most 10); when it does not, the old ones are deleted first (and a failure in
 * between leaves the set short: the step list says so). A set that already holds exactly the new files
 * is left alone, so a repeated push does not duplicate anything.
 *
 * Writes never retry, not even a 429 or a part upload (a half finished reservation is replaced by the next
 * push). Every request changes the draft at once, there is no transaction: a refusal after some steps is a
 * `DraftPartialError` that lists what was written. A timeout, a cut connection or a 5xx on a write is
 * `DraftOutcomeUnknownError`; the caller reads the draft back.
 *
 * No message carries the key, a JWT or an upload URL.
 */

export type AppleDraftConnectorOptions = Omit<StoreHttpOptions, 'store'> & {
  credential: AppStoreConnectKey;
  /** Apple's numeric app id (`apps.storeAppId`). */
  appStoreId: string;
  /** Defaults to https://api.appstoreconnect.apple.com. */
  apiBase?: string;
  pageSize?: number;
  maxPages?: number;
  /** Time between two looks at an uploaded file's processing state. Default 2000. */
  pollIntervalMs?: number;
  /** Looks at the processing state before giving up. Default 20. */
  maxPolls?: number;
};

const DEFAULT_BASE = 'https://api.appstoreconnect.apple.com';
const MAX_ERROR_DETAILS = 5;
const MAX_SET_FILES = 10;
/** An upload URL is only used when it is an https address of Apple's. */
const UPLOAD_HOST = /(^|\.)apple\.com$/i;

type LocalizationRef = { id: string; attributes: Json };

const attr = (field: string): string => APPLE_VERSION_LOCALIZATION_ATTRIBUTES[field] ?? '';

export class AppleDraftConnector implements StoreDraftConnector {
  readonly store = 'appstoreconnect' as const;
  readonly platform = 'ios' as const;
  readonly #http: StoreHttp;
  readonly #writeHttp: StoreHttp;
  readonly #tokens: AppStoreConnectTokenProvider;
  readonly #base: string;
  readonly #appId: string;
  readonly #pageSize: number;
  readonly #maxPages: number;
  readonly #pollMs: number;
  readonly #maxPolls: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: AppleDraftConnectorOptions) {
    if (!/^[0-9]{1,20}$/.test(options.appStoreId)) {
      throw new StoreError('appstoreconnect', 'invalid_input', 'The App Store id of the app is missing or not a number. Sync the app first.');
    }
    this.#appId = options.appStoreId;
    this.#http = new StoreHttp({ ...options, store: 'appstoreconnect' });
    this.#writeHttp = new StoreHttp({ ...options, store: 'appstoreconnect', maxRateLimitRetries: 0 });
    this.#base = (options.apiBase ?? DEFAULT_BASE).replace(/\/+$/, '');
    const wanted = options.pageSize ?? 200;
    this.#pageSize = Number.isFinite(wanted) ? Math.min(200, Math.max(1, Math.trunc(wanted))) : 200;
    this.#maxPages = Math.max(1, options.maxPages ?? 10);
    this.#pollMs = options.pollIntervalMs ?? 2000;
    this.#maxPolls = Math.max(1, options.maxPolls ?? 20);
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const pem = options.credential.privateKey;
    for (const http of [this.#http, this.#writeHttp]) {
      http.known.add(pem);
      http.known.add(pem.trim());
      for (const line of pem.split(/\r?\n/)) {
        if (line && !line.startsWith('-----')) http.known.add(line.trim());
      }
    }
    this.#tokens = new AppStoreConnectTokenProvider(options.credential, this.#http.now);
  }

  /** Builds a connector from the stored secret (core `buildSecret` JSON for `app_store_connect`). */
  static fromSecret(secret: string, options: Omit<AppleDraftConnectorOptions, 'credential'>): AppleDraftConnector {
    return new AppleDraftConnector({ ...options, credential: parseAppStoreConnectSecret(secret) });
  }

  async readDraft(request: DraftReadRequest): Promise<DraftState> {
    const version = await this.#editableVersion();
    const locs = await this.#localizations(version.id);
    return this.#state(request, version, locs);
  }

  async applyDraft(input: DraftApplyInput): Promise<DraftApplyResult> {
    const request: DraftReadRequest = {
      text: input.text.map((t) => ({ locale: t.locale, field: t.field })),
      assets: input.assets.map((a) => ({ locale: a.locale, kind: a.kind, device: a.device, target: a.target })),
    };
    const version = await this.#editableVersion();
    const locs = await this.#localizations(version.id);
    const before = await this.#state(request, version, locs);
    if (!input.guard(before)) throw new DraftDriftError(before);

    const steps: DraftStep[] = [];
    let at: { type: DraftStep['type']; locale: string; target: string } = { type: 'text', locale: '', target: '' };
    try {
      // Texts, one request per locale (all of its changed fields together), then the sets.
      const byLocale = new Map<string, Map<string, string>>();
      for (const t of input.text) {
        const fields = byLocale.get(t.locale) ?? new Map<string, string>();
        fields.set(t.field, t.value);
        byLocale.set(t.locale, fields);
      }
      const localeIds = new Map<string, string>();
      for (const [locale, ref] of locs) localeIds.set(locale, ref.id);
      for (const [locale, fields] of byLocale) {
        const known = locs.get(locale);
        const wanted: Record<string, string> = {};
        for (const [field, value] of fields) wanted[attr(field)] = value;
        at = { type: 'text', locale, target: [...fields.keys()].join(',') };
        if (known) {
          const changed: Record<string, string> = {};
          for (const [key, value] of Object.entries(wanted)) {
            if (typeof known.attributes[key] !== 'string' || known.attributes[key] !== value) changed[key] = value;
          }
          if (Object.keys(changed).length === 0) {
            for (const field of fields.keys()) steps.push({ type: 'text', locale, target: field, outcome: 'already_same' });
            continue;
          }
          await this.#write('PATCH', `/v1/appStoreVersionLocalizations/${enc(known.id)}`, `changing the ${locale} texts`, {
            data: { type: 'appStoreVersionLocalizations', id: known.id, attributes: changed },
          });
          for (const field of fields.keys()) {
            const changedHere = attr(field) in changed;
            steps.push({ type: 'text', locale, target: field, outcome: changedHere ? 'applied' : 'already_same' });
          }
        } else {
          const created = await this.#write('POST', '/v1/appStoreVersionLocalizations', `adding the ${locale} locale`, {
            data: {
              type: 'appStoreVersionLocalizations',
              attributes: { locale, ...wanted },
              relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } } },
            },
          });
          const id = idOf(created);
          if (!id) throw new StoreError('appstoreconnect', 'unexpected', `App Store Connect created the ${locale} locale but sent no id.`, created.status);
          localeIds.set(locale, id);
          steps.push({ type: 'locale', locale, target: 'locale', outcome: 'applied' });
          for (const field of fields.keys()) steps.push({ type: 'text', locale, target: field, outcome: 'applied' });
        }
      }
      for (const write of input.assets) {
        at = { type: 'asset', locale: write.locale, target: write.target };
        let locId = localeIds.get(write.locale);
        if (!locId) {
          at = { type: 'locale', locale: write.locale, target: 'locale' };
          const created = await this.#write('POST', '/v1/appStoreVersionLocalizations', `adding the ${write.locale} locale`, {
            data: {
              type: 'appStoreVersionLocalizations',
              attributes: { locale: write.locale },
              relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } } },
            },
          });
          locId = idOf(created);
          if (!locId) throw new StoreError('appstoreconnect', 'unexpected', `App Store Connect created the ${write.locale} locale but sent no id.`, created.status);
          localeIds.set(write.locale, locId);
          steps.push({ type: 'locale', locale: write.locale, target: 'locale', outcome: 'applied' });
          at = { type: 'asset', locale: write.locale, target: write.target };
        }
        const state = before.assets.find((a) => a.locale === write.locale && a.target === write.target);
        steps.push(await this.#replaceSet(locId, write, state));
      }
    } catch (error) {
      throw this.#settle(error, steps, at);
    }
    return { before, steps, commit: 'none' };
  }

  /** A failure after some steps is partial, a lost answer is unknown; a failure before any step is just the failure. */
  #settle(error: unknown, steps: DraftStep[], at: { type: DraftStep['type']; locale: string; target: string }): unknown {
    if (error instanceof DraftOutcomeUnknownError) {
      return new DraftOutcomeUnknownError('appstoreconnect', error.message, [...steps], error.status);
    }
    if (error instanceof StoreError && steps.some((s) => s.outcome === 'applied')) {
      return new DraftPartialError(error, [...steps], at);
    }
    return error;
  }

  // -------------------------------------------------------------------------------------------
  // Reading

  async #editableVersion(): Promise<{ id: string; versionString: string | null; state: string }> {
    const what = 'looking for the editable App Store version';
    let url: string | undefined = `${this.#base}/v1/apps/${enc(this.#appId)}/appStoreVersions?limit=${this.#pageSize}`;
    const found: { id: string; versionString: string | null; state: string }[] = [];
    for (let page = 0; url !== undefined && page < this.#maxPages; page++) {
      const body = (await this.#get(url, what)).json;
      for (const item of records(body.data)) {
        const a = isRecord(item.attributes) ? item.attributes : {};
        const id = text(item.id);
        const state = (text(a.appVersionState) ?? text(a.appStoreState) ?? '').toUpperCase();
        if (!id || text(a.platform) !== 'IOS' || !APPLE_DRAFT_VERSION_STATES.includes(state)) continue;
        found.push({ id, versionString: text(a.versionString) ?? null, state });
      }
      const links = isRecord(body.links) ? body.links : {};
      const next = text(links.next);
      url = next === undefined ? undefined : this.#checkNext(next, what);
    }
    if (found.length === 0) {
      throw new StoreError(
        'appstoreconnect',
        'no_editable_version',
        'App Store Connect has no iOS version whose listing can still be edited (a version in "Prepare for Submission"). Create the next version in App Store Connect first: this server does not create versions.',
        404,
      );
    }
    if (found.length > 1) {
      throw new StoreError('appstoreconnect', 'invalid_input', 'App Store Connect has more than one editable iOS version; this server will not guess which one to write to.');
    }
    return found[0] as { id: string; versionString: string | null; state: string };
  }

  async #localizations(versionId: string): Promise<Map<string, LocalizationRef>> {
    const what = 'reading the localizations of the editable version';
    const out = new Map<string, LocalizationRef>();
    let url: string | undefined = `${this.#base}/v1/appStoreVersions/${enc(versionId)}/appStoreVersionLocalizations?limit=${this.#pageSize}`;
    for (let page = 0; url !== undefined && page < this.#maxPages; page++) {
      const body = (await this.#get(url, what)).json;
      for (const item of records(body.data)) {
        const a = isRecord(item.attributes) ? item.attributes : {};
        const id = text(item.id);
        const locale = text(a.locale);
        if (id && locale) out.set(locale, { id, attributes: a });
      }
      const links = isRecord(body.links) ? body.links : {};
      const next = text(links.next);
      url = next === undefined ? undefined : this.#checkNext(next, what);
    }
    return out;
  }

  async #state(
    request: DraftReadRequest,
    version: { id: string; versionString: string | null; state: string },
    locs: Map<string, LocalizationRef>,
  ): Promise<DraftState> {
    const textState: DraftTextState[] = request.text.map((t) => {
      const ref = locs.get(t.locale);
      const value = ref ? text(ref.attributes[attr(t.field)]) : undefined;
      return { locale: t.locale, field: t.field, value: value ?? null, localeExists: ref !== undefined };
    });
    const sets = new Map<string, Map<string, { id: string; images: DraftImageState[] }>>();
    for (const locale of new Set(request.assets.map((a) => a.locale))) {
      const ref = locs.get(locale);
      if (ref) sets.set(locale, await this.#sets(ref.id));
    }
    const assets: DraftAssetState[] = request.assets.map((slot) => {
      const set = sets.get(slot.locale)?.get(slot.target);
      return {
        locale: slot.locale,
        kind: slot.kind,
        device: slot.device,
        target: slot.target,
        setExists: set !== undefined,
        images: set?.images ?? [],
      };
    });
    return { store: 'appstoreconnect', platform: 'ios', version, text: textState, assets };
  }

  /** The screenshot sets of a localization by display type, with their screenshots in the store's order. */
  async #sets(localizationId: string): Promise<Map<string, { id: string; images: DraftImageState[] }>> {
    const what = 'reading the screenshot sets';
    const query =
      'limit=200&limit[appScreenshots]=50&include=appScreenshots&fields[appScreenshotSets]=screenshotDisplayType,appScreenshots&fields[appScreenshots]=fileName,sourceFileChecksum,assetDeliveryState';
    const body = (await this.#get(`${this.#base}/v1/appStoreVersionLocalizations/${enc(localizationId)}/appScreenshotSets?${query}`, what)).json;
    const included = new Map<string, Json>();
    for (const item of records(body.included)) {
      const id = text(item.id);
      if (id && text(item.type) === 'appScreenshots') included.set(id, item);
    }
    const out = new Map<string, { id: string; images: DraftImageState[] }>();
    for (const set of records(body.data)) {
      const a = isRecord(set.attributes) ? set.attributes : {};
      const type = text(a.screenshotDisplayType);
      const id = text(set.id);
      if (!type || !id) continue;
      const rels = isRecord(set.relationships) ? set.relationships : {};
      const rel = isRecord(rels.appScreenshots) ? rels.appScreenshots : {};
      const images: DraftImageState[] = [];
      for (const ref of records(rel.data)) {
        const shotId = text(ref.id);
        if (!shotId) continue;
        const shot = included.get(shotId);
        const sa = shot && isRecord(shot.attributes) ? shot.attributes : {};
        const delivery = isRecord(sa.assetDeliveryState) ? sa.assetDeliveryState : {};
        images.push({
          id: shotId,
          name: text(sa.fileName) ?? null,
          checksum: text(sa.sourceFileChecksum)?.toLowerCase() ?? null,
          checksumKind: 'md5',
          state: text(delivery.state) ?? null,
        });
      }
      out.set(type, { id, images });
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Replacing a set of screenshots

  async #replaceSet(localizationId: string, write: DraftAssetWrite, state: DraftAssetState | undefined): Promise<DraftStep> {
    const existing = state?.images ?? [];
    const base = { type: 'asset' as const, locale: write.locale, target: write.target };
    if (state?.setExists && setMatches(existing, write.files)) return { ...base, outcome: 'already_same' };

    let setId = state?.setExists ? await this.#setId(localizationId, write.target) : undefined;
    if (!setId) {
      const created = await this.#write('POST', '/v1/appScreenshotSets', `creating the ${write.target} set of ${write.locale}`, {
        data: {
          type: 'appScreenshotSets',
          attributes: { screenshotDisplayType: write.target },
          relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: localizationId } } },
        },
      });
      setId = idOf(created);
      if (!setId) throw new StoreError('appstoreconnect', 'unexpected', 'App Store Connect created a screenshot set but sent no id.', created.status);
    }
    const old = existing.map((i) => i.id);
    let removed = 0;
    const removeOld = async () => {
      for (const id of old) {
        await this.#write('DELETE', `/v1/appScreenshots/${enc(id)}`, 'deleting a screenshot of the draft', undefined, [404]);
        removed++;
      }
    };
    // Room for both: the new files first, so a failure never leaves the set empty.
    const roomForBoth = old.length + write.files.length <= MAX_SET_FILES;
    if (!roomForBoth) await removeOld();
    const added: string[] = [];
    for (const file of write.files) added.push(await this.#upload(setId, file));
    if (roomForBoth) await removeOld();
    if (added.length > 1 || old.length > 0) {
      await this.#write('PATCH', `/v1/appScreenshotSets/${enc(setId)}/relationships/appScreenshots`, 'ordering the screenshots', {
        data: added.map((id) => ({ type: 'appScreenshots', id })),
      });
    }
    return { ...base, outcome: 'applied', uploaded: added.length, removed };
  }

  async #setId(localizationId: string, target: string): Promise<string | undefined> {
    return (await this.#sets(localizationId)).get(target)?.id;
  }

  /** Reserve, upload every part, commit, wait until Apple has processed it. Returns the screenshot id. */
  async #upload(setId: string, file: DraftAssetWrite['files'][number]): Promise<string> {
    const what = `uploading ${file.name}`;
    const reserved = await this.#write('POST', '/v1/appScreenshots', `reserving the upload of ${file.name}`, {
      data: {
        type: 'appScreenshots',
        attributes: { fileName: file.name, fileSize: file.bytes.length },
        relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: setId } } },
      },
    });
    const id = idOf(reserved);
    const data = isRecord(reserved.json) && isRecord(reserved.json.data) ? reserved.json.data : {};
    const attributes = isRecord(data.attributes) ? data.attributes : {};
    const operations = records(attributes.uploadOperations);
    if (!id || operations.length === 0) {
      throw new StoreError('appstoreconnect', 'unexpected', `App Store Connect reserved ${file.name} but sent no upload instructions.`, reserved.status);
    }
    for (const op of operations) await this.#putPart(op, file.bytes, what);
    await this.#write('PATCH', `/v1/appScreenshots/${enc(id)}`, `committing ${file.name}`, {
      data: { type: 'appScreenshots', id, attributes: { uploaded: true, sourceFileChecksum: file.md5 } },
    });
    await this.#waitProcessed(id, file.name);
    return id;
  }

  async #putPart(op: Json, bytes: Uint8Array, what: string): Promise<void> {
    const method = (text(op.method) ?? 'PUT').toUpperCase();
    const offset = typeof op.offset === 'number' ? op.offset : 0;
    const length = typeof op.length === 'number' ? op.length : bytes.length;
    const url = text(op.url);
    let target: URL | undefined;
    try {
      target = url ? new URL(url) : undefined;
    } catch {
      target = undefined;
    }
    if (!target || target.protocol !== 'https:' || !UPLOAD_HOST.test(target.hostname)) {
      throw new StoreError('appstoreconnect', 'unexpected', `Apple sent an upload address that is not an https address of apple.com while ${what}. Nothing was sent to it.`);
    }
    if (offset < 0 || length < 0 || offset + length > bytes.length) {
      throw new StoreError('appstoreconnect', 'unexpected', `Apple asked for a byte range outside the file while ${what}.`);
    }
    // The headers are Apple's, to be sent as given; the content type goes in its own field.
    let contentType = 'application/octet-stream';
    const headers: Record<string, string> = {};
    for (const h of records(op.requestHeaders)) {
      const name = text(h.name);
      const value = text(h.value);
      if (!name || value === undefined) continue;
      if (name.toLowerCase() === 'content-type') contentType = value;
      else headers[name.toLowerCase()] = value;
    }
    let reply: StoreReply;
    try {
      reply = await this.#writeHttp.send(method, target.toString(), { headers, raw: { body: bytes.subarray(offset, offset + length), contentType } });
    } catch (error) {
      if (error instanceof StoreError) throw new StoreError('appstoreconnect', error.kind, `The upload of a part failed while ${what}: ${error.message}`, error.status);
      throw error;
    }
    if (reply.status < 200 || reply.status >= 300) {
      throw new StoreError('appstoreconnect', reply.status >= 500 ? 'server' : 'unexpected', `Apple's upload server answered HTTP ${reply.status} while ${what}.`, reply.status);
    }
  }

  async #waitProcessed(id: string, name: string): Promise<void> {
    for (let attempt = 0; attempt < this.#maxPolls; attempt++) {
      const body = (
        await this.#get(`${this.#base}/v1/appScreenshots/${enc(id)}?fields[appScreenshots]=assetDeliveryState,fileName`, `checking ${name}`)
      ).json;
      const data = isRecord(body.data) ? body.data : {};
      const a = isRecord(data.attributes) ? data.attributes : {};
      const delivery = isRecord(a.assetDeliveryState) ? a.assetDeliveryState : {};
      const state = text(delivery.state);
      if (state === 'COMPLETE') return;
      if (state === 'FAILED') {
        const errors = records(delivery.errors)
          .slice(0, 3)
          .map((e) => this.#http.redact(text(e.description) ?? text(e.code) ?? 'unspecified'))
          .join('; ');
        // A failed asset is terminal: remove it so it does not stay in the set.
        try {
          await this.#write('DELETE', `/v1/appScreenshots/${enc(id)}`, `removing the failed ${name}`, undefined, [404]);
        } catch {
          // The next push replaces whatever is left.
        }
        throw new StoreError('appstoreconnect', 'invalid_input', `App Store Connect rejected ${name} while processing it (${errors || 'no reason given'}).`);
      }
      await this.#sleep(this.#pollMs);
    }
    throw new StoreError('appstoreconnect', 'server', `App Store Connect had not finished processing ${name} after ${this.#maxPolls} checks. It stays in the draft; push again to replace it.`);
  }

  // -------------------------------------------------------------------------------------------
  // HTTP

  #fail(reply: StoreReply, what: string): StoreError {
    if (reply.status === 401) this.#tokens.invalidate();
    const error = appleError(reply, this.#http.now(), what);
    const redact = (value: string | undefined) => (value === undefined ? undefined : this.#http.redact(value));
    const details = (error.details ?? []).slice(0, MAX_ERROR_DETAILS).map((d) => {
      const fields = { code: redact(d.code), title: redact(d.title), detail: redact(d.detail), parameter: redact(d.parameter), pointer: redact(d.pointer) };
      return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as StoreErrorDetail;
    });
    return new StoreError('appstoreconnect', error.kind, this.#http.redact(error.message), error.status, details);
  }

  async #get(url: string, what: string): Promise<{ json: Json }> {
    const token = this.#tokens.token();
    this.#http.known.add(token);
    const reply = await this.#http.send('GET', url, { headers: { authorization: `Bearer ${token}` } });
    if (reply.status >= 200 && reply.status < 300) {
      if (reply.malformed || !isRecord(reply.json)) {
        throw new StoreError('appstoreconnect', 'unexpected', `App Store Connect answered ${what} with a response that could not be read.`, reply.status);
      }
      return { json: reply.json };
    }
    throw this.#fail(reply, what);
  }

  /** One write. No retries. A lost answer or a 5xx is `DraftOutcomeUnknownError`; a 4xx is a refusal. `okStatuses` are extra statuses that count as done (a 404 on a delete). */
  async #write(method: string, path: string, what: string, json?: unknown, okStatuses: number[] = []): Promise<StoreReply> {
    const token = this.#tokens.token();
    this.#http.known.add(token);
    this.#writeHttp.known.add(token);
    let reply: StoreReply;
    try {
      reply = await this.#writeHttp.send(method, `${this.#base}${path}`, {
        headers: { authorization: `Bearer ${token}` },
        ...(json !== undefined ? { json } : {}),
      });
    } catch (error) {
      if (error instanceof StoreError && error.kind === 'network') {
        throw new DraftOutcomeUnknownError(
          'appstoreconnect',
          `The connection to App Store Connect failed while ${what}, so it is not known whether Apple applied it. ${error.message}`,
          [],
          error.status,
        );
      }
      throw error;
    }
    if ((reply.status >= 200 && reply.status < 300) || okStatuses.includes(reply.status)) return reply;
    if (reply.status >= 500) {
      throw new DraftOutcomeUnknownError('appstoreconnect', `App Store Connect answered HTTP ${reply.status} while ${what}, so it is not known whether Apple applied it.`, [], reply.status);
    }
    const error = this.#fail(reply, what);
    if (reply.status === 403 && error.kind === 'forbidden') {
      throw new StoreError(
        'appstoreconnect',
        'forbidden',
        'Apple refused the change (403). The key may not be allowed to edit the app listing (an App Manager or Admin key is assumed to be needed, UNVERIFIED). See docs/credentials.md.',
        403,
        error.details,
      );
    }
    throw error;
  }

  /** A paging link is followed only when it stays on the API host: the token is sent nowhere else. */
  #checkNext(next: string, what: string): string {
    let target: URL;
    try {
      target = new URL(next, this.#base);
    } catch {
      throw new StoreError('appstoreconnect', 'unexpected', `Apple sent a paging link that could not be read while ${what}.`);
    }
    if (target.origin !== new URL(this.#base).origin) {
      throw new StoreError('appstoreconnect', 'unexpected', `Apple sent a paging link to another host while ${what}. It was not followed.`);
    }
    return target.toString();
  }
}

function idOf(reply: StoreReply): string | undefined {
  const data = isRecord(reply.json) && isRecord(reply.json.data) ? reply.json.data : {};
  return text(data.id);
}

