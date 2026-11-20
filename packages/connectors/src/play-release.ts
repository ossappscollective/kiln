import { StoreError, StoreRateLimitError } from './errors.ts';
import { GoogleTokenProvider, parseServiceAccount, type ServiceAccount } from './google-auth.ts';
import { googleError, isPlayPackageName, serializedPlayEdits } from './googleplay.ts';
import {
  type PlayCheckFinding,
  type PlayCheckRelease,
  type PlayCheckResult,
  type PlayReleaseBuild,
  type PlayReleaseState,
  type ReleaseApplyInput,
  ReleaseDriftError,
  ReleaseOutcomeUnknownError,
  type ReleaseRequest,
  type ReleaseResult,
  type ReleaseState,
  type StorePlayReleaseChecker,
  type StoreReleaseConnector,
} from './release-types.ts';
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
 *
 * `checkPlayRelease` ("Check with Google Play", docs/adr/0025-play-release-checks.md) is a READ-style call: it opens an edit,
 * stages the proposed release in the track, calls `POST .../edits/{editId}:validate` and ALWAYS deletes the edit. It NEVER commits.
 * VERIFIED on Google's pages (read 2026-11-20): `edits.validate` is `POST /androidpublisher/v3/applications/{packageName}/edits/{editId}:validate`,
 * "Validates an app edit", the request body "must be empty", a success answers an `AppEdit`; the edits guide says "If you try to commit
 * an invalid edit, the operation will throw an exception and have no effect" and that an edit can be abandoned at any time. Play
 * Console help (answer 9859348, 2026-11-20): "Errors block publishing, while warnings don't" and release notes are "up to 500
 * Unicode characters per language".
 * UNVERIFIED (Google's page states neither): WHICH rules `validate` applies (this code assumes the errors Play Console shows as
 * blocking, not its warnings: a missing deobfuscation file or a target API level warning are NOT expected here), the exact shape of
 * its error answer (read as `error.message`, HTTP 400), whether `tracks.update` already refuses some releases (the same 400 is then
 * reported as a `stage` finding), and whether a rule about "a completed release replaces the older completed one" is applied (older
 * completed releases of the track are left out of the staged track when the proposal is `completed`, so no false error is made).
 * So `no_errors` means "Google found no error in this edit", never "no warnings".
 */

export type PlayReleaseConnectorOptions = Omit<StoreHttpOptions, 'store'> & {
  serviceAccount: string | ServiceAccount;
  packageName: string;
  apiBase?: string;
};

const DEFAULT_BASE = 'https://androidpublisher.googleapis.com';

/** Google's own sentence from an error answer (`error.message`), or a fixed one when it said nothing readable. */
const googleMessage = (json: unknown): string => {
  const error = isRecord(json) && isRecord(json.error) ? json.error : {};
  return (
    text(error.message)?.replace(/\s+/g, ' ').trim() ||
    'Google Play refused the release and did not say why.'
  );
};

const sameCodes = (a: readonly string[], b: readonly string[]): boolean => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((value, i) => value === y[i]);
};

export class PlayReleaseConnector implements StoreReleaseConnector, StorePlayReleaseChecker {
  readonly store = 'googleplay' as const;
  readonly platform = 'android' as const;
  readonly packageName: string;
  readonly #http: StoreHttp;
  readonly #writeHttp: StoreHttp;
  readonly #tokens: GoogleTokenProvider;
  readonly #base: string;
  readonly #account: ServiceAccount;

  constructor(options: PlayReleaseConnectorOptions) {
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

  async readReleaseState(request: ReleaseRequest): Promise<ReleaseState> {
    const track = PlayReleaseConnector.#trackOf(request);
    return serializedPlayEdits(this.#account.clientEmail, async () => {
      for (let attempt = 0; ; attempt++) {
        const editId = await this.#insertEdit(this.#http);
        try {
          return (await this.#state(this.#http, editId, track, request)).state;
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

  async release(input: ReleaseApplyInput): Promise<ReleaseResult> {
    const track = PlayReleaseConnector.#trackOf(input.request);
    const fraction = input.request.userFraction;
    if (
      typeof fraction !== 'number' ||
      !Number.isFinite(fraction) ||
      fraction <= 0 ||
      fraction > 1
    ) {
      throw new StoreError(
        'googleplay',
        'invalid_input',
        'Name the share of users to release to, more than 0 and at most 1 (1 is everybody).',
      );
    }
    return serializedPlayEdits(this.#account.clientEmail, async () => {
      const http = this.#writeHttp;
      const editId = await this.#insertEdit(http);
      let settled = false;
      try {
        const {
          state: before,
          releases,
          target,
        } = await this.#state(http, editId, track, input.request);
        if (!input.guard(before)) throw new ReleaseDriftError(before);
        const build = input.request.build;
        let all: Json[];
        if (before.store === 'googleplay' && before.creates && build !== undefined) {
          // DIRECT: no draft with these codes. Build the release of the staged fields in this edit, every other release as read
          // (a completed release replaces the older completed one, as `checkPlayRelease` stages it), and send it with the commit.
          const codes = (input.request.versionCodes ?? []).map(String);
          if (
            codes.length === 0 ||
            before.release === null ||
            before.missingCodes.length > 0 ||
            releases.some((r) => sameCodes(PlayReleaseConnector.#read(r).versionCodes, codes))
          ) {
            throw new StoreError(
              'googleplay',
              'invalid_input',
              `The ${track} track cannot take a new release with these version codes, so nothing was released.`,
            );
          }
          const made = PlayReleaseConnector.#built(codes, build, fraction);
          const kept = releases.filter((r) => !(fraction === 1 && text(r.status) === 'completed'));
          all = [...kept, made];
        } else {
          if (
            before.store !== 'googleplay' ||
            before.release === null ||
            target === undefined ||
            before.release.status !== 'draft'
          ) {
            throw new StoreError(
              'googleplay',
              'invalid_input',
              `The ${track} track has no draft release to start, so nothing was released.`,
            );
          }
          const started: Json = { ...target, status: fraction === 1 ? 'completed' : 'inProgress' };
          if (fraction === 1) delete started.userFraction;
          else started.userFraction = fraction;
          all = releases.map((r) => (r === target ? started : r));
        }
        // Staging the new state of the track in the edit is not yet a release: nothing is live until the commit.
        await this.#call(
          http,
          'PUT',
          this.#url(`/${enc(editId)}/tracks/${enc(track)}`),
          `starting the release in the ${track} track`,
          { json: { track, releases: all } },
        );
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

  /**
   * Stages the proposed release in a throw-away edit, validates the edit and deletes it. Never commits, never retries a refusal.
   * A refusal Google gives about the RELEASE (HTTP 400) is a finding; anything else (no access, 5xx, a dead network) is an error.
   */
  async checkPlayRelease(input: PlayCheckRelease): Promise<PlayCheckResult> {
    const track = PlayReleaseConnector.#trackOf({ track: input.track });
    const codes = input.versionCodes.map(String);
    if (codes.length === 0 || codes.length > 20 || codes.some((c) => !/^[0-9]{1,10}$/.test(c))) {
      throw new StoreError(
        'googleplay',
        'invalid_input',
        'Name the version codes of the release (whole numbers, at most 20).',
      );
    }
    const fraction = input.userFraction;
    if (input.status === 'inProgress') {
      if (typeof fraction !== 'number' || !(fraction > 0 && fraction < 1)) {
        throw new StoreError(
          'googleplay',
          'invalid_input',
          'A release that is rolling out needs a share of users above 0 and below 1. Use completed for everybody.',
        );
      }
    } else if (fraction !== undefined) {
      throw new StoreError(
        'googleplay',
        'invalid_input',
        'Google Play keeps a share of users only on a release that is rolling out.',
      );
    }
    return serializedPlayEdits(this.#account.clientEmail, async () => {
      for (let attempt = 0; ; attempt++) {
        const editId = await this.#insertEdit(this.#http);
        try {
          return await this.#validateInEdit(editId, track, { ...input, versionCodes: codes });
        } catch (error) {
          if (error instanceof StoreError && error.kind === 'edit_invalid' && attempt === 0)
            continue;
          throw error;
        } finally {
          // Always, and never a commit: the edit only existed to be validated.
          await this.#deleteEdit(this.#http, editId);
        }
      }
    });
  }

  async #validateInEdit(
    editId: string,
    track: string,
    input: PlayCheckRelease,
  ): Promise<PlayCheckResult> {
    const http = this.#http;
    let existing: Json[] = [];
    try {
      const reply = await this.#call(
        http,
        'GET',
        this.#url(`/${enc(editId)}/tracks/${enc(track)}`),
        `reading the ${track} track`,
      );
      existing = records(isRecord(reply.json) ? reply.json.releases : undefined);
    } catch (error) {
      if (!(error instanceof StoreError) || error.kind !== 'not_found') throw error;
    }
    const release: Json = {
      status: input.status,
      versionCodes: input.versionCodes,
    };
    const name = input.name?.trim();
    if (name) release.name = name;
    if (input.status === 'inProgress') release.userFraction = input.userFraction;
    const notes = input.notes
      .filter((n) => n.text.trim() !== '')
      .map((n) => ({ language: n.locale, text: n.text }));
    if (notes.length > 0) release.releaseNotes = notes;
    // The proposal replaces a release with the same codes; a completed proposal also replaces the older completed release.
    const kept = existing.filter((r) => {
      const codes = Array.isArray(r.versionCodes) ? r.versionCodes.map(String) : [];
      if (sameCodes(codes, input.versionCodes)) return false;
      return !(input.status === 'completed' && text(r.status) === 'completed');
    });
    const staged = await this.#tryCall(
      http,
      'PUT',
      this.#url(`/${enc(editId)}/tracks/${enc(track)}`),
      `staging the release in the ${track} track`,
      { track, releases: [...kept, release] },
    );
    if (staged.kind === 'finding') return { outcome: 'errors', findings: [staged.finding('stage')] };
    const validated = await this.#tryCall(
      http,
      'POST',
      `${this.#url(`/${enc(editId)}`)}:validate`,
      'validating the edit',
    );
    if (validated.kind === 'finding')
      return { outcome: 'errors', findings: [validated.finding('validate')] };
    return { outcome: 'no_errors', findings: [] };
  }

  /** Like `#call`, but a 400 about the release is answered as a finding (Google's words, cut and redacted), not thrown. */
  async #tryCall(
    http: StoreHttp,
    method: string,
    url: string,
    what: string,
    json?: unknown,
  ): Promise<
    { kind: 'ok' } | { kind: 'finding'; finding: (stage: PlayCheckFinding['stage']) => PlayCheckFinding }
  > {
    for (let attempt = 0; ; attempt++) {
      const token = await this.#tokens.token();
      const reply = await http.send(method, url, {
        headers: { authorization: `Bearer ${token}` },
        ...(json !== undefined ? { json } : {}),
      });
      if (reply.status === 401 && attempt === 0) {
        this.#tokens.invalidate();
        continue;
      }
      if (reply.status >= 200 && reply.status < 300) return { kind: 'ok' };
      if (reply.status === 400) {
        const message = http.redact(googleMessage(reply.json)).slice(0, 400);
        return { kind: 'finding', finding: (stage) => ({ stage, message }) };
      }
      throw this.#refusal(reply, what);
    }
  }

  // -------------------------------------------------------------------------------------------

  /** The release a direct release makes: the staged fields, started (`inProgress` with the share, or `completed` for everybody). */
  static #built(codes: string[], build: PlayReleaseBuild, fraction: number): Json {
    const made: Json = { status: fraction === 1 ? 'completed' : 'inProgress', versionCodes: codes };
    if (fraction !== 1) made.userFraction = fraction;
    const name = build.name?.trim();
    if (name) made.name = name;
    const notes = build.notes
      .filter((n) => n.text.trim() !== '')
      .map((n) => ({ language: n.locale, text: n.text }));
    if (notes.length > 0) made.releaseNotes = notes;
    return made;
  }

  static #trackOf(request: ReleaseRequest): string {
    const track = request.track;
    if (track === undefined || !/^[A-Za-z0-9_.:-]{1,64}$/.test(track)) {
      throw new StoreError(
        'googleplay',
        'invalid_input',
        'Name the track of the release (for example production).',
      );
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
      const reply = await this.#call(
        http,
        'GET',
        this.#url(`/${enc(editId)}/tracks/${enc(track)}`),
        `reading the ${track} track`,
      );
      releases = records(isRecord(reply.json) ? reply.json.releases : undefined);
    } catch (error) {
      if (!(error instanceof StoreError) || error.kind !== 'not_found') throw error;
    }
    const wanted = request.versionCodes?.map(String);
    const drafts = releases.filter((r) => text(r.status) === 'draft');
    const matching =
      wanted !== undefined && wanted.length > 0
        ? drafts.filter((r) => sameCodes(PlayReleaseConnector.#read(r).versionCodes, wanted))
        : drafts;
    const target = matching.length === 1 ? matching[0] : undefined;
    const ambiguous = matching.length > 1;
    // DIRECT: no draft with these codes (and none in the track that could be meant): the release would be built from the request.
    const creates =
      request.build !== undefined &&
      wanted !== undefined &&
      wanted.length > 0 &&
      matching.length === 0;
    const uploaded = new Set<string>();
    const bundles = await this.#call(
      http,
      'GET',
      this.#url(`/${enc(editId)}/bundles`),
      'listing the app bundles',
    );
    for (const b of records(isRecord(bundles.json) ? bundles.json.bundles : undefined)) {
      if (typeof b.versionCode === 'number' || typeof b.versionCode === 'string')
        uploaded.add(String(b.versionCode));
    }
    try {
      const apks = await this.#call(
        http,
        'GET',
        this.#url(`/${enc(editId)}/apks`),
        'listing the APKs',
      );
      for (const a of records(isRecord(apks.json) ? apks.json.apks : undefined)) {
        if (typeof a.versionCode === 'number' || typeof a.versionCode === 'string')
          uploaded.add(String(a.versionCode));
      }
    } catch (error) {
      if (!(error instanceof StoreError) || error.kind !== 'not_found') throw error;
    }
    const release = target
      ? PlayReleaseConnector.#read(target)
      : creates && request.build && wanted
        ? {
            name: request.build.name?.trim() || null,
            status: 'draft',
            userFraction: null,
            versionCodes: [...wanted],
            notes: request.build.notes.filter((n) => n.text.trim() !== '').length,
          }
        : null;
    const state: ReleaseState = {
      store: 'googleplay',
      platform: 'android',
      track,
      release,
      ambiguous,
      others: releases.filter((r) => r !== target).map((r) => PlayReleaseConnector.#read(r)),
      missingCodes: release ? release.versionCodes.filter((code) => !uploaded.has(code)) : [],
      creates,
    };
    return { state, releases, target };
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

  /** The commit that sends the release to Google: no `changesNotSentForReview`, `ERROR_IF_IN_REVIEW` so a review in progress is never cancelled. */
  async #commit(editId: string): Promise<void> {
    const what = 'starting the release';
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
          throw new ReleaseOutcomeUnknownError(
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
        throw new ReleaseOutcomeUnknownError(
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
