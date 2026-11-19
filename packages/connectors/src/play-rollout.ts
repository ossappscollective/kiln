import { StoreError, StoreRateLimitError } from './errors.ts';
import { GoogleTokenProvider, parseServiceAccount, type ServiceAccount } from './google-auth.ts';
import { googleError, isPlayPackageName, serializedPlayEdits } from './googleplay.ts';
import {
  isPlayTrackName,
  isVersionCode,
  type PlayRolloutChange,
  type PlayRolloutState,
  type PlayRolloutTarget,
  planPlayRollout,
  type RolloutApplyInput,
  type RolloutApplyResult,
  RolloutDriftError,
  RolloutOutcomeUnknownError,
  type RolloutState,
  type RolloutTarget,
  type StoreRolloutConnector,
} from './rollout-types.ts';
import {
  enc,
  isRecord,
  type Json,
  num,
  records,
  StoreHttp,
  type StoreHttpOptions,
  type StoreReply,
  text,
} from './store-http.ts';

/**
 * Google Play: change the staged rollout of a release on a track. A STORE WRITE: it changes what
 * users receive. Only ever called by the server's rollout service, after a rights check, a preview,
 * a confirmation hash and a re-read of the live state (docs/adr/0008-store-rollout-writes.md). It is
 * never retried.
 *
 * Every change is an edit, the transactional unit of the Play Developer API
 * (https://developers.google.com/android-publisher/edits): insert an edit, read the track, change the
 * release, `edits.tracks.update`, `edits.commit`. Until the commit nothing is applied: abandoning
 * the edit (a failed update, a refused guard, a timeout before the commit) changes nothing.
 *
 * Endpoints. VERIFIED on Google's pages on 2026-11-18 unless marked UNVERIFIED:
 *
 * - `POST /androidpublisher/v3/applications/{packageName}/edits` (insert), `DELETE .../edits/{editId}`
 *   (the same calls the read-only connector uses, googleplay.ts).
 * - `GET .../edits/{editId}/tracks/{track}` (`edits.tracks.get`, answer: a `Track`)
 *   https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks/get
 * - `PUT .../edits/{editId}/tracks/{track}` (`edits.tracks.update`, body and answer: a `Track`)
 *   https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks/update
 * - `POST .../edits/{editId}:commit` (`edits.commit`, empty body, answer: an `AppEdit`), with the
 *   query parameter `changesInReviewBehavior`
 *   https://developers.google.com/android-publisher/api-ref/rest/v3/edits/commit
 *   Its default is `CANCEL_IN_REVIEW_AND_SUBMIT`: a commit CANCELS a review that is in progress.
 *   A rollout change must not do that as a side effect, so this connector always sends
 *   `ERROR_IF_IN_REVIEW`: with changes in review the commit fails with HTTP 400, reason
 *   `CHANGES_ALREADY_IN_REVIEW`, "The edit isn't invalidated" (the page's words), and this connector
 *   reports it as a `changes_in_review` error. UNVERIFIED: whether Play treats a rollout change as
 *   "changes in review" at all.
 * - `Track`: `track`, `releases[]`; `Release`: `name`, `versionCodes[]` (int64 as strings),
 *   `releaseNotes[]`, `status` (`draft`, `inProgress`, `halted`, `completed`), `userFraction`
 *   ("0 < fraction < 1", only for `inProgress` and `halted`), `inAppUpdatePriority`,
 *   `countryTargeting` (https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks).
 * - How a staged rollout is changed, from https://developers.google.com/android-publisher/tracks:
 *   raise: the same `versionCodes`, a higher `userFraction`, `status: inProgress`; halt: `status:
 *   halted`; resume: `status: inProgress`; complete: `status: completed`. "Changes can take several
 *   hours to reach users."
 *
 * UNVERIFIED (Google's pages do not say): whether the `releases` array of an update REPLACES all the
 * releases of the track (the page's examples send one release). To be safe against both readings this
 * connector sends back EVERY release it read, unchanged (every field kept as read), except the target,
 * whose `status` and `userFraction` change. Also UNVERIFIED: whether a lower `userFraction` is
 * refused by Google (this server never sends one), whether `halted` keeps `userFraction` in an
 * update (this connector keeps it), and which Play Console permission an update needs (the
 * service account needs to be allowed to release the app; see docs/credentials.md).
 *
 * Writes never retry, not even a 429, and use their own `StoreHttp` with no rate-limit waits. A
 * timeout, a cut connection or a 5xx on the commit is a `RolloutOutcomeUnknownError`: the caller
 * reads the state back. A failure before the commit is a plain error: nothing was applied.
 * Edits of one service account are serialized with the read-only connector's queue.
 *
 * No message carries the service account key or an access token.
 */

export type PlayRolloutConnectorOptions = Omit<StoreHttpOptions, 'store'> & {
  /** The service account JSON key file (as stored), or its parsed fields. */
  serviceAccount: string | ServiceAccount;
  /** The package name (application id) of the app. */
  packageName: string;
  /** Defaults to https://androidpublisher.googleapis.com. */
  apiBase?: string;
};

const DEFAULT_BASE = 'https://androidpublisher.googleapis.com';

const sortedCodes = (codes: readonly string[]): string[] => [...codes].sort();
const sameCodes = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && sortedCodes(a).every((code, i) => code === sortedCodes(b)[i]);

const codesOf = (release: Json): string[] =>
  Array.isArray(release.versionCodes) ? release.versionCodes.map((v) => String(v)) : [];

/** The release of `track` whose version codes are exactly `codes`, as a state; undefined when there is none. */
export function playRolloutState(
  track: unknown,
  target: PlayRolloutTarget,
): PlayRolloutState | undefined {
  const body = isRecord(track) ? track : {};
  const releases = records(body.releases);
  const found = releases.find((r) => sameCodes(codesOf(r), target.versionCodes));
  if (!found) return undefined;
  const fraction = num(found.userFraction);
  const name = text(found.name);
  return {
    store: 'googleplay',
    platform: 'android',
    track: target.track,
    versionCodes: sortedCodes(codesOf(found)),
    name: name ?? null,
    status: text(found.status) ?? 'statusUnspecified',
    userFraction: fraction ?? null,
    otherReleases: releases.length - 1,
  };
}

export class PlayRolloutConnector implements StoreRolloutConnector {
  readonly store = 'googleplay' as const;
  readonly platform = 'android' as const;
  readonly packageName: string;
  readonly #http: StoreHttp;
  /** For writes: the same settings, but a 429 is never waited out and retried. */
  readonly #writeHttp: StoreHttp;
  readonly #tokens: GoogleTokenProvider;
  readonly #base: string;
  readonly #account: ServiceAccount;

  constructor(options: PlayRolloutConnectorOptions) {
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
    // The write client signs nothing itself, but must never print the key either.
    for (const known of this.#http.known) this.#writeHttp.known.add(known);
  }

  #target(target: RolloutTarget): PlayRolloutTarget {
    if (!('track' in target) || !isPlayTrackName(target.track)) {
      throw new StoreError('googleplay', 'invalid_input', 'Not a valid Google Play track.');
    }
    if (
      !Array.isArray(target.versionCodes) ||
      target.versionCodes.length === 0 ||
      target.versionCodes.length > 50 ||
      !target.versionCodes.every(isVersionCode)
    ) {
      throw new StoreError(
        'googleplay',
        'invalid_input',
        'Not valid version codes (digits only, one to fifty).',
      );
    }
    return { track: target.track, versionCodes: sortedCodes([...new Set(target.versionCodes)]) };
  }

  /**
   * The release as the store has it now: opens an edit, reads the track, deletes the edit. Changes
   * nothing. `not_found` when the track or a release with exactly these version codes is not there.
   */
  async readState(target: RolloutTarget): Promise<RolloutState> {
    const wanted = this.#target(target);
    return serializedPlayEdits(this.#account.clientEmail, async () => {
      for (let attempt = 0; ; attempt++) {
        const editId = await this.#insertEdit(this.#http);
        try {
          return this.#stateOf(await this.#getTrack(this.#http, editId, wanted), wanted);
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
   * Changes the release: insert an edit, read the track, `guard` the state read, update the track,
   * commit. `RolloutDriftError` (nothing sent) when the guard refuses. See the file comment.
   */
  async applyChange(input: RolloutApplyInput): Promise<RolloutApplyResult> {
    const wanted = this.#target(input.target);
    const change = input.change as PlayRolloutChange;
    if (
      !('action' in change) ||
      !['set_fraction', 'halt', 'resume', 'complete'].includes(change.action)
    ) {
      throw new StoreError(
        'googleplay',
        'invalid_input',
        'Not a rollout change Google Play knows.',
      );
    }
    return serializedPlayEdits(this.#account.clientEmail, async () => {
      const http = this.#writeHttp;
      const editId = await this.#insertEdit(http);
      let settled = false;
      try {
        const track = await this.#getTrack(http, editId, wanted);
        const before = this.#stateOf(track, wanted);
        if (!input.guard(before)) throw new RolloutDriftError(before);
        const plan = planPlayRollout(before, change);
        if (!plan.ok) throw new StoreError('googleplay', 'invalid_input', plan.message);
        const proposed = plan.proposed as PlayRolloutState;

        const releases = records(track.releases).map((release) =>
          sameCodes(codesOf(release), wanted.versionCodes)
            ? this.#patched(release, proposed)
            : release,
        );
        const trackId = text(track.track) ?? wanted.track;
        await this.#call(
          http,
          'PUT',
          this.#url(`/${enc(editId)}/tracks/${enc(wanted.track)}`),
          'changing the release',
          { track: trackId, releases },
          true,
        );

        // From here on the request may be applied even if the answer is lost.
        settled = true;
        try {
          await this.#commit(editId);
        } catch (error) {
          // A refused commit (4xx) applied nothing: the edit is deleted below. An unknown one is left alone.
          if (!(error instanceof RolloutOutcomeUnknownError)) settled = false;
          throw error;
        }
        return { before, after: proposed };
      } finally {
        if (!settled) await this.#deleteEdit(http, editId);
      }
    });
  }

  /** The release as sent back: every field as read, with the new status and share. */
  #patched(release: Json, proposed: PlayRolloutState): Json {
    const next: Json = { ...release, status: proposed.status };
    if (proposed.userFraction === null) delete next.userFraction;
    else next.userFraction = proposed.userFraction;
    return next;
  }

  #stateOf(track: Json, wanted: PlayRolloutTarget): PlayRolloutState {
    const state = playRolloutState(track, wanted);
    if (!state) {
      throw new StoreError(
        'googleplay',
        'not_found',
        `Google Play has no release with version code${wanted.versionCodes.length === 1 ? '' : 's'} ${wanted.versionCodes.join(', ')} on the ${wanted.track} track. It may have been replaced by a newer release.`,
        404,
      );
    }
    return state;
  }

  // -------------------------------------------------------------------------------------------

  #url(suffix: string): string {
    return `${this.#base}/androidpublisher/v3/applications/${enc(this.packageName)}/edits${suffix}`;
  }

  async #insertEdit(http: StoreHttp): Promise<string> {
    const reply = await this.#call(http, 'POST', this.#url(''), 'opening an edit', {});
    const id = isRecord(reply.json) ? text(reply.json.id) : undefined;
    if (!id) {
      throw new StoreError(
        'googleplay',
        'unexpected',
        'Google Play opened an edit but sent no edit id.',
        reply.status,
      );
    }
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

  async #getTrack(http: StoreHttp, editId: string, wanted: PlayRolloutTarget): Promise<Json> {
    try {
      const reply = await this.#call(
        http,
        'GET',
        this.#url(`/${enc(editId)}/tracks/${enc(wanted.track)}`),
        'reading the track',
      );
      return isRecord(reply.json) ? reply.json : {};
    } catch (error) {
      if (error instanceof StoreError && error.kind === 'not_found') {
        throw new StoreError(
          'googleplay',
          'not_found',
          `Google Play has no ${wanted.track} track for ${this.packageName} that this service account can see.`,
          404,
        );
      }
      throw error;
    }
  }

  /**
   * The commit. `changesInReviewBehavior=ERROR_IF_IN_REVIEW` so that a review in progress is never
   * cancelled by a rollout change. A lost answer or a 5xx is `RolloutOutcomeUnknownError`.
   */
  async #commit(editId: string): Promise<void> {
    const what = 'committing the change';
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
          throw new RolloutOutcomeUnknownError(
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
        throw new RolloutOutcomeUnknownError(
          'googleplay',
          `Google Play answered HTTP ${reply.status} while ${what}, so it is not known whether Google applied it.`,
          reply.status,
        );
      }
      throw this.#refusal(reply, what, true);
    }
  }

  /** The error for a non-2xx answer. A 403 on a write names the permission a release change needs. */
  #refusal(reply: StoreReply, what: string, write: boolean): StoreError {
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
    if (write && reply.status === 403 && error.kind === 'forbidden') {
      return new StoreError(
        'googleplay',
        'forbidden',
        'Google Play refused the change (403). The service account must be allowed to release this app in Play Console (Users and permissions). See docs/credentials.md.',
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
    json?: unknown,
    write = false,
  ): Promise<StoreReply> {
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
      throw this.#refusal(reply, what, write);
    }
  }
}
