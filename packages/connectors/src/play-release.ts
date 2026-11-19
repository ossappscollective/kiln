import { StoreError, StoreRateLimitError } from './errors.ts';
import { GoogleTokenProvider, parseServiceAccount, type ServiceAccount } from './google-auth.ts';
import { googleError, isPlayPackageName, serializedPlayEdits } from './googleplay.ts';
import {
  ReleaseDriftError,
  ReleaseOutcomeUnknownError,
  type PlayReleaseState,
  type ReleaseApplyInput,
  type ReleaseRequest,
  type ReleaseResult,
  type ReleaseState,
  type StoreReleaseConnector,
} from './release-types.ts';
import { enc, isRecord, type Json, records, type StoreHttpOptions, StoreHttp, type StoreReply, text } from './store-http.ts';

/**
 * Google Play: START a draft release of a track to an explicit share of users. A STORE WRITE that cannot be taken back from
 * here (a rollout can be halted or completed, not unsent). Only ever called by the server's release service, after a rights
 * check, a preview, a confirmation hash, a typed confirmation and a re-read (docs/adr/0014-release-management.md). It never
 * edits the release's name, codes or notes (the staged changes do), never changes another release and never touches a listing.
 *
 * VERIFIED on Google's pages (read 2026-11-19): `Release.status` has `draft` ("APKs are not served to users"), `inProgress`
 * and `completed`; `userFraction` is "0 < fraction < 1 ... can only be set when status is inProgress or halted"; `edits.tracks.get`
 * and `edits.tracks.update` (`PUT .../tracks/{track}`, body and answer a `Track`); `edits.commit` with
 * `changesInReviewBehavior=ERROR_IF_IN_REVIEW` (an error, not a cancelled review, when changes are in review).
 *
 * How the release starts: one edit that rewrites the track, the draft release with `status: inProgress` and the `userFraction`
 * (or `status: completed` with no fraction for 100%), every other release as read, committed WITHOUT `changesNotSentForReview`
 * so the change goes to Google. UNVERIFIED (nothing was run): whether `tracks.update` replaces the releases of the track
 * (every other release is sent back as read), whether a draft release can be started this way at all or only in Play Console,
 * whether a release in an app that needs review waits in review before users see it (it is "sent", not "live"), and
 * whether a track other than `production` accepts a `userFraction`.
 *
 * A release that is already `inProgress` in the track is not touched: the preview shows it and the server blocks (starting a
 * second rollout beside a running one is a decision for Play Console). The commit is never retried. A lost answer or a 5xx
 * is `ReleaseOutcomeUnknownError` and the caller reads the track back. No message carries the key or a token.
 */

export type PlayReleaseConnectorOptions = Omit<StoreHttpOptions, 'store'> & {
  serviceAccount: string | ServiceAccount;
  packageName: string;
  apiBase?: string;
};

const DEFAULT_BASE = 'https://androidpublisher.googleapis.com';

const sameCodes = (a: readonly string[], b: readonly string[]): boolean => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((value, i) => value === y[i]);
};

export class PlayReleaseConnector implements StoreReleaseConnector {
  readonly store = 'googleplay' as const;
  readonly platform = 'android' as const;
  readonly packageName: string;
  readonly #http: StoreHttp;
  readonly #writeHttp: StoreHttp;
  readonly #tokens: GoogleTokenProvider;
  readonly #base: string;
  readonly #account: ServiceAccount;

  constructor(options: PlayReleaseConnectorOptions) {
    this.#account = typeof options.serviceAccount === 'string' ? parseServiceAccount(options.serviceAccount) : options.serviceAccount;
    if (!isPlayPackageName(options.packageName)) {
      throw new StoreError('googleplay', 'invalid_input', `Not a valid Android package name: ${JSON.stringify(options.packageName.slice(0, 80))}.`);
    }
    this.packageName = options.packageName;
    this.#http = new StoreHttp({ ...options, store: 'googleplay' });
    this.#writeHttp = new StoreHttp({ ...options, store: 'googleplay', maxRateLimitRetries: 0 });
    this.#base = (options.apiBase ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.#tokens = new GoogleTokenProvider(this.#account, this.#http);
    for (const known of this.#http.known) this.#writeHttp.known.add(known);
  }

  async readReleaseState(request: ReleaseRequest): Promise<ReleaseState> {
    const track = PlayReleaseConnector.#trackOf(request);
    return serializedPlayEdits(this.#account.clientEmail, async () => {
      for (let attempt = 0; ; attempt++) {
        const editId = await this.#insertEdit(this.#http);
        try {
          return (await this.#state(this.#http, editId, track, request)).state;
        } catch (error) {
          if (error instanceof StoreError && error.kind === 'edit_invalid' && attempt === 0) continue;
          throw error;
        } finally {
          await this.#deleteEdit(this.#http, editId);
        }
      }
    });
  }

  async release(input: ReleaseApplyInput): Promise<ReleaseResult> {
    const track = PlayReleaseConnector.#trackOf(input.request);
    const fraction = input.request.userFraction;
    if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
      throw new StoreError('googleplay', 'invalid_input', 'Name the share of users to release to, more than 0 and at most 1 (1 is everybody).');
    }
    return serializedPlayEdits(this.#account.clientEmail, async () => {
      const http = this.#writeHttp;
      const editId = await this.#insertEdit(http);
      let settled = false;
      try {
        const { state: before, releases, target } = await this.#state(http, editId, track, input.request);
        if (!input.guard(before)) throw new ReleaseDriftError(before);
        if (before.store !== 'googleplay' || before.release === null || target === undefined || before.release.status !== 'draft') {
          throw new StoreError('googleplay', 'invalid_input', `The ${track} track has no draft release to start, so nothing was released.`);
        }
        const started: Json = { ...target, status: fraction === 1 ? 'completed' : 'inProgress' };
        if (fraction === 1) delete started.userFraction;
        else started.userFraction = fraction;
        const all = releases.map((r) => (r === target ? started : r));
        // Staging the new state of the track in the edit is not yet a release: nothing is live until the commit.
        await this.#call(http, 'PUT', this.#url(`/${enc(editId)}/tracks/${enc(track)}`), `starting the release in the ${track} track`, { json: { track, releases: all } });
        // From here on the release may be applied even if the answer is lost.
        settled = true;
        try {
          await this.#commit(editId);
        } catch (error) {
          // A refused commit (4xx) applied nothing: the edit is deleted below. An unknown one is left alone.
          if (!(error instanceof ReleaseOutcomeUnknownError)) settled = false;
          throw error;
        }
        return { before, releaseRequestId: null, via: 'edit_commit' as const };
      } finally {
        if (!settled) await this.#deleteEdit(http, editId);
      }
    });
  }

  // -------------------------------------------------------------------------------------------

  static #trackOf(request: ReleaseRequest): string {
    const track = request.track;
    if (track === undefined || !/^[A-Za-z0-9_.:-]{1,64}$/.test(track)) {
      throw new StoreError('googleplay', 'invalid_input', 'Name the track of the release (for example production).');
    }
    return track;
  }

  static #read(r: Json): PlayReleaseState {
    return {
      name: text(r.name) ?? null,
      status: text(r.status) ?? 'statusUnspecified',
      userFraction: typeof r.userFraction === 'number' ? r.userFraction : null,
      versionCodes: Array.isArray(r.versionCodes) ? r.versionCodes.map(String) : [],
      notes: records(r.releaseNotes).length,
    };
  }

  async #state(
    http: StoreHttp,
    editId: string,
    track: string,
    request: ReleaseRequest,
  ): Promise<{ state: ReleaseState; releases: Json[]; target: Json | undefined }> {
    let releases: Json[] = [];
    try {
      const reply = await this.#call(http, 'GET', this.#url(`/${enc(editId)}/tracks/${enc(track)}`), `reading the ${track} track`);
      releases = records(isRecord(reply.json) ? reply.json.releases : undefined);
    } catch (error) {
      if (!(error instanceof StoreError) || error.kind !== 'not_found') throw error;
    }
    const wanted = request.versionCodes?.map(String);
    const drafts = releases.filter((r) => text(r.status) === 'draft');
    const matching = wanted !== undefined && wanted.length > 0 ? drafts.filter((r) => sameCodes(PlayReleaseConnector.#read(r).versionCodes, wanted)) : drafts;
    const target = matching.length === 1 ? matching[0] : undefined;
    const ambiguous = matching.length > 1;
    const uploaded = new Set<string>();
    const bundles = await this.#call(http, 'GET', this.#url(`/${enc(editId)}/bundles`), 'listing the app bundles');
    for (const b of records(isRecord(bundles.json) ? bundles.json.bundles : undefined)) {
      if (typeof b.versionCode === 'number' || typeof b.versionCode === 'string') uploaded.add(String(b.versionCode));
    }
    try {
      const apks = await this.#call(http, 'GET', this.#url(`/${enc(editId)}/apks`), 'listing the APKs');
      for (const a of records(isRecord(apks.json) ? apks.json.apks : undefined)) {
        if (typeof a.versionCode === 'number' || typeof a.versionCode === 'string') uploaded.add(String(a.versionCode));
      }
    } catch (error) {
      if (!(error instanceof StoreError) || error.kind !== 'not_found') throw error;
    }
    const release = target ? PlayReleaseConnector.#read(target) : null;
    const state: ReleaseState = {
      store: 'googleplay',
      platform: 'android',
      track,
      release,
      ambiguous,
      others: releases.filter((r) => r !== target).map((r) => PlayReleaseConnector.#read(r)),
      missingCodes: release ? release.versionCodes.filter((code) => !uploaded.has(code)) : [],
    };
    return { state, releases, target };
  }

  #url(suffix: string): string {
    return `${this.#base}/androidpublisher/v3/applications/${enc(this.packageName)}/edits${suffix}`;
  }

  async #insertEdit(http: StoreHttp): Promise<string> {
    const reply = await this.#call(http, 'POST', this.#url(''), 'opening an edit', { json: {} });
    const id = isRecord(reply.json) ? text(reply.json.id) : undefined;
    if (!id) throw new StoreError('googleplay', 'unexpected', 'Google Play opened an edit but sent no edit id.', reply.status);
    return id;
  }

  async #deleteEdit(http: StoreHttp, editId: string): Promise<void> {
    try {
      await this.#call(http, 'DELETE', this.#url(`/${enc(editId)}`), 'deleting the edit');
    } catch {
      // Nothing was committed, so there is nothing to undo.
    }
  }

  /** The commit that sends the release to Google: no `changesNotSentForReview`, `ERROR_IF_IN_REVIEW` so a review in progress is never cancelled. */
  async #commit(editId: string): Promise<void> {
    const what = 'starting the release';
    const url = `${this.#url(`/${enc(editId)}`)}:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW`;
    for (let attempt = 0; ; attempt++) {
      const token = await this.#tokens.token();
      let reply: StoreReply;
      try {
        reply = await this.#writeHttp.send('POST', url, { headers: { authorization: `Bearer ${token}` } });
      } catch (error) {
        if (error instanceof StoreError && error.kind === 'network') {
          throw new ReleaseOutcomeUnknownError('googleplay', `The connection to Google Play failed while ${what}, so it is not known whether Google applied it. ${error.message}`, error.status);
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
        throw new ReleaseOutcomeUnknownError('googleplay', `Google Play answered HTTP ${reply.status} while ${what}, so it is not known whether Google applied it.`, reply.status);
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
        'Google Play has changes in review for this app, and this server does not cancel a review. Wait for the review to finish (or cancel it in Play Console) and try again. Nothing was released.',
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
        'Google Play refused (403). The service account must be allowed to release apps in Play Console (Users and permissions). See docs/credentials.md.',
        403,
      );
    }
    return new StoreError('googleplay', error.kind, this.#http.redact(error.message), error.status);
  }

  async #call(http: StoreHttp, method: string, url: string, what: string, body: { json?: unknown } = {}): Promise<StoreReply> {
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
          throw new StoreError('googleplay', 'unexpected', `Google Play answered ${what} with a response that could not be read.`, reply.status);
        }
        return reply;
      }
      throw this.#refusal(reply, what);
    }
  }
}
