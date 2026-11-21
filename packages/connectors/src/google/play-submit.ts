import { type AssetKind, PLAY_DEVICES, PLAY_LISTING_MEMBERS } from '@kiln/core';
import { StoreError, StoreRateLimitError } from '../errors.ts';
import type {
  DraftAssetState,
  DraftReadRequest,
  DraftState,
  DraftTextState,
} from '../store-draft-types.ts';
import {
  enc,
  isRecord,
  type Json,
  records,
  StoreHttp,
  type StoreHttpOptions,
  type StoreReply,
  text,
} from '../store-http.ts';
import {
  type StoreSubmitConnector,
  type SubmitApplyInput,
  type SubmitAssetSet,
  SubmitDriftError,
  type SubmitLocale,
  SubmitOutcomeUnknownError,
  type SubmitResult,
  type SubmitState,
  type SubmitTrack,
} from '../store-submit-types.ts';
import { GoogleTokenProvider, parseServiceAccount, type ServiceAccount } from './google-auth.ts';
import { googleError, isPlayPackageName, serializedPlayEdits } from './googleplay.ts';

/**
 * Google Play: send the changes of the app to REVIEW by committing a fresh edit WITHOUT `changesNotSentForReview`.
 * A STORE WRITE that cannot be taken back from here. Only ever called by the server's submit service, after a rights
 * check, a preview, a confirmation hash, a typed confirmation and a re-read (docs/adr/0010-store-submit.md). It never
 * writes a track, a listing or an image: it cannot start a release, raise or complete a rollout.
 *
 * What Google's pages say (read on 2026-11-18, VERIFIED):
 * - `POST .../edits/{editId}:commit`: `changesNotSentForReview` "held back ... until someone explicitly sends them for
 *   review from the Google Play Console UI. They're added to any other unsent changes"; without it the commit submits the
 *   changes for publishing. `changesInReviewBehavior`: `ERROR_IF_IN_REVIEW` "returns an error if changes are in
 *   review. The edit isn't invalidated. If nothing is in review, the new changes are submitted"; the default
 *   `CANCEL_IN_REVIEW_AND_SUBMIT` cancels the review in progress, so this connector sends `ERROR_IF_IN_REVIEW` always. With
 *   it, changes already in review are HTTP 400 `FAILED_PRECONDITION` with the reason `CHANGES_ALREADY_IN_REVIEW`.
 * - https://developers.google.com/android-publisher/edits: "Changes made within an edit are not live until the edit is
 *   committed"; they "can take several hours" to appear.
 *
 * UNVERIFIED (nothing was run): whether an edit with no change of its own commits at all and whether such a commit sends
 * the changes an earlier push held back (Google's page says only that held changes are "added to any other unsent
 * changes"); whether Play shows held back changes in a later edit (the re-read the server does before submitting
 * depends on it: if Play shows the old listing, the server refuses with `draft_differs`, never submits blind); that
 * Google Play has no separate "send for review" call (none was found); and that there is no way to read the review state through
 * the API, so an unknown outcome cannot be settled by reading (the server answers `outcome_unknown`).
 *
 * Everything a submit sends to review is whatever is pending for the app, not only this server's pushes: changes someone made
 * in Play Console go with it. Google lists none of that through the API, so the preview says so. The tracks are READ
 * (`edits.tracks.list`) so the person sees them and the confirmation covers them.
 *
 * The commit is never retried. A lost answer or a 5xx is `SubmitOutcomeUnknownError`. No message carries the key or a token.
 */

export type PlaySubmitConnectorOptions = Omit<StoreHttpOptions, 'store'> & {
  serviceAccount: string | ServiceAccount;
  packageName: string;
  apiBase?: string;
};

const DEFAULT_BASE = 'https://androidpublisher.googleapis.com';
/** The image types read for the checks (screenshots of phones and tablets, icon, feature graphic); more when the push touched them. */
const CHECKED_IMAGE_TYPES = [
  'phoneScreenshots',
  'sevenInchScreenshots',
  'tenInchScreenshots',
  'icon',
  'featureGraphic',
] as const;

const kindOf = (type: string): { kind: AssetKind; device: string | null } | undefined => {
  const device = PLAY_DEVICES.find((d) => d.dir === type);
  if (device) return { kind: 'screenshot', device: device.id };
  if (type === 'icon') return { kind: 'icon', device: null };
  if (type === 'featureGraphic') return { kind: 'feature_graphic', device: null };
  if (type === 'tvBanner') return { kind: 'tv_banner', device: null };
  return undefined;
};

export class PlaySubmitConnector implements StoreSubmitConnector {
  readonly store = 'googleplay' as const;
  readonly platform = 'android' as const;
  readonly packageName: string;
  readonly #http: StoreHttp;
  readonly #writeHttp: StoreHttp;
  readonly #tokens: GoogleTokenProvider;
  readonly #base: string;
  readonly #account: ServiceAccount;

  constructor(options: PlaySubmitConnectorOptions) {
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

  async readSubmitState(request: DraftReadRequest): Promise<SubmitState> {
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

  async submit(input: SubmitApplyInput): Promise<SubmitResult> {
    return serializedPlayEdits(this.#account.clientEmail, async () => {
      const http = this.#writeHttp;
      const editId = await this.#insertEdit(http);
      let settled = false;
      try {
        const before = await this.#state(http, editId, input.request);
        if (!input.guard(before)) throw new SubmitDriftError(before);
        // From here on the request may be applied even if the answer is lost.
        settled = true;
        try {
          await this.#commit(editId);
        } catch (error) {
          // A refused commit (4xx) applied nothing: the edit is deleted below. An unknown one is left alone.
          if (!(error instanceof SubmitOutcomeUnknownError)) settled = false;
          throw error;
        }
        return { before, submissionId: null, submissionState: null, via: 'edit_commit' as const };
      } finally {
        if (!settled) await this.#deleteEdit(http, editId);
      }
    });
  }

  // -------------------------------------------------------------------------------------------

  async #state(http: StoreHttp, editId: string, request: DraftReadRequest): Promise<SubmitState> {
    const listingsReply = await this.#call(
      http,
      'GET',
      this.#url(`/${enc(editId)}/listings`),
      'reading the listings',
    );
    const listings = new Map<string, Json>();
    for (const item of records(
      isRecord(listingsReply.json) ? listingsReply.json.listings : undefined,
    )) {
      const language = text(item.language);
      if (language) listings.set(language, item);
    }
    const types = [
      ...new Set<string>([...CHECKED_IMAGE_TYPES, ...request.assets.map((a) => a.target)]),
    ];
    const images = new Map<string, Json[]>();
    const locales: SubmitLocale[] = [];
    for (const [language, listing] of listings) {
      const textOf: Record<string, string | null> = {};
      for (const [field, member] of Object.entries(PLAY_LISTING_MEMBERS))
        textOf[field] = text(listing[member]) ?? null;
      const assets: SubmitAssetSet[] = [];
      for (const type of types) {
        const list = await this.#images(http, editId, language, type);
        images.set(`${language}\u0000${type}`, list);
        const kind = kindOf(type);
        if (!kind) continue;
        assets.push({
          kind: kind.kind,
          device: kind.device,
          target: type,
          images: list.flatMap((i) => {
            const id = text(i.id);
            return id
              ? [
                  {
                    id,
                    checksum: text(i.sha256)?.toLowerCase() ?? null,
                    width: null,
                    height: null,
                    state: null,
                  },
                ]
              : [];
          }),
        });
      }
      locales.push({ locale: language, text: textOf, assets });
    }
    const tracksReply = await this.#call(
      http,
      'GET',
      this.#url(`/${enc(editId)}/tracks`),
      'reading the tracks',
    );
    const tracks: SubmitTrack[] = records(
      isRecord(tracksReply.json) ? tracksReply.json.tracks : undefined,
    ).flatMap((t) => {
      const track = text(t.track);
      if (!track) return [];
      return [
        {
          track,
          releases: records(t.releases).map((r) => ({
            name: text(r.name) ?? null,
            status: text(r.status) ?? 'unknown',
            userFraction: typeof r.userFraction === 'number' ? r.userFraction : null,
            versionCodes: Array.isArray(r.versionCodes) ? r.versionCodes.map(String) : [],
          })),
        },
      ];
    });
    // The draft as `readDraft` shows it, for the items that were pushed.
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
    const assetState: DraftAssetState[] = request.assets.map((slot) => ({
      locale: slot.locale,
      kind: slot.kind,
      device: slot.device,
      target: slot.target,
      setExists: true,
      images: (images.get(`${slot.locale}\u0000${slot.target}`) ?? []).flatMap((i) => {
        const id = text(i.id);
        return id
          ? [
              {
                id,
                name: null,
                checksum: text(i.sha256)?.toLowerCase() ?? null,
                checksumKind: 'sha256' as const,
                state: null,
              },
            ]
          : [];
      }),
    }));
    const draft: DraftState = {
      store: 'googleplay',
      platform: 'android',
      version: null,
      text: textState,
      assets: assetState,
    };
    return {
      store: 'googleplay',
      platform: 'android',
      version: null,
      build: null,
      alreadySubmitted: false,
      openReviewSubmissions: null,
      tracks,
      locales,
      draft,
    };
  }

  async #images(http: StoreHttp, editId: string, language: string, type: string): Promise<Json[]> {
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

  async #deleteEdit(http: StoreHttp, editId: string): Promise<void> {
    try {
      await this.#call(http, 'DELETE', this.#url(`/${enc(editId)}`), 'deleting the edit');
    } catch {
      // Nothing was committed, so there is nothing to undo.
    }
  }

  /**
   * The commit that sends the changes to review: no `changesNotSentForReview`, and `changesInReviewBehavior=ERROR_IF_IN_REVIEW`
   * so a review in progress is never cancelled. A lost answer or a 5xx is `SubmitOutcomeUnknownError`.
   */
  async #commit(editId: string): Promise<void> {
    const what = 'sending the changes for review';
    const url = `${this.#url(`/${enc(editId)}`)}:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW`;
    for (let attempt = 0; ; attempt++) {
      const token = await this.#tokens.token();
      let reply: StoreReply;
      try {
        reply = await this.#writeHttp.send('POST', url, {
          headers: { authorization: `Bearer ${token}` },
        });
      } catch (error) {
        if (error instanceof StoreError && error.kind === 'network') {
          throw new SubmitOutcomeUnknownError(
            'googleplay',
            `The connection to Google Play failed while ${what}, so it is not known whether Google applied it. ${error.message}`,
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
        throw new SubmitOutcomeUnknownError(
          'googleplay',
          `Google Play answered HTTP ${reply.status} while ${what}, so it is not known whether Google applied it.`,
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
    const error = googleError(reply, what, {
      packageName: this.packageName,
      ...(this.#account.projectId ? { projectId: this.#account.projectId } : {}),
    });
    if (error instanceof StoreRateLimitError) return error;
    if (reply.status === 403 && error.kind === 'forbidden') {
      return new StoreError(
        'googleplay',
        'forbidden',
        'Google Play refused (403). The service account must be allowed to release or manage the app in Play Console (Users and permissions). See docs/credentials.md.',
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
    body: { json?: unknown } = {},
  ): Promise<StoreReply> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.#tokens.token();
      const reply = await http.send(method, url, {
        headers: { authorization: `Bearer ${token}` },
        ...(body.json !== undefined ? { json: body.json } : {}),
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
