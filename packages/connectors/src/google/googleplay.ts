import type { ListingSections, LocaleText, MediaSet, PlayField } from '@mrm/core';
import { StoreError, StoreRateLimitError } from '../errors.ts';
import { GoogleTokenProvider, parseServiceAccount, type ServiceAccount } from './google-auth.ts';
import { mapPlayTrackRelease } from '../mappings.ts';
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
} from '../store-http.ts';
import {
  PLAY_GRAPHIC_TYPES,
  PLAY_SCREENSHOT_TYPES,
  playDetails,
  playImageSet,
  playReleaseNotes,
  sectionWarning,
} from '../store-sections.ts';
import type {
  ReadStoreListingOptions,
  StoreApp,
  StoreBuild,
  StoreConnector,
  StoreListing,
  StoreVersion,
} from '../types.ts';

/**
 * Read-only Google Play Developer API connector.
 *
 * How Play differs from App Store Connect, and what that means here:
 *
 * - Play batches changes in a transactional "edit". Everything this connector reads (tracks,
 *   bundles, APKs, listings, details) is read inside an edit: insert an edit, read, then DELETE
 *   the edit. An edit is never committed here, so nothing is ever changed in the store.
 * - "Each user may have only a single edit open at a time" and "If you create a new edit, any
 *   existing edit you may have open is invalidated" (Play docs, "Edits"). A service account is
 *   one user, so a read here would invalidate an edit that another process is preparing with the
 *   same account. Inside this process every edit of one service account is therefore serialized
 *   (`withEdit`); across processes that is the caller's problem. A future writer must share this
 *   queue, or use a service account of its own.
 * - Anyone committing an edit, or changing the app in Play Console, invalidates all open edits
 *   of the app, including ours. A read that hits this is retried once with a fresh edit.
 * - A commit can take hours to become visible; that never matters for reads, but it is why the
 *   lifecycle has `propagating`, which a track read cannot produce.
 * - There is no API call that lists the apps of a developer account. Apps are configured:
 *   `packages` is the list, and `listApps` reads those.
 *
 * Nothing is logged, and no message carries the service account key or an access token.
 */

export type GooglePlayConnectorOptions = Omit<StoreHttpOptions, 'store'> & {
  /** The service account JSON key file (as a string, as stored), or its parsed fields. */
  serviceAccount: string | ServiceAccount;
  /** The package names (application ids) of the apps to read. The API cannot list them. */
  packages: string[];
  /** Defaults to https://androidpublisher.googleapis.com. */
  apiBase?: string;
};

/** A release on a track, as `edits.tracks` reports it. */
export type PlayRelease = {
  name?: string;
  /** `draft`, `inProgress`, `halted`, `completed`, kept verbatim. */
  status?: string;
  versionCodes: string[];
  /** Staged rollout share, 0 to 1, as sent. */
  userFraction?: number;
};

export type PlayTrack = {
  /** `internal`, `alpha`, `beta`, `production`, or a custom or form-factor track name. */
  track: string;
  releases: PlayRelease[];
};

const DEFAULT_BASE = 'https://androidpublisher.googleapis.com';
/**
 * Most languages whose images are read (eight requests each, one per image type). The default
 * language comes first; the rest are left out and the media section says `truncated`.
 */
const MAX_IMAGE_LANGUAGES = 25;
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** True for an Android application id. Checked before a name goes into a URL. */
export const isPlayPackageName = (value: string): boolean =>
  value.length <= 255 && PACKAGE_NAME.test(value);

/**
 * The queue that keeps one edit per service account at a time, inside this process. The rollout
 * writer (play-rollout.ts) uses it too: a write must not invalidate a read's edit, nor the reverse.
 */
const editQueues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, job: () => Promise<T>): Promise<T> {
  const previous = editQueues.get(key) ?? Promise.resolve();
  const run = previous.then(job, job);
  const tail = run.catch(() => undefined);
  editQueues.set(key, tail);
  tail.finally(() => {
    if (editQueues.get(key) === tail) editQueues.delete(key);
  });
  return run;
}

/** The same queue for the writer of rollouts (play-rollout.ts), which must not interleave with a read's edit. */
export const serializedPlayEdits = serialized;

const DISABLED =
  /has not been used in project|it is disabled|accessNotConfigured|SERVICE_DISABLED/i;
const RATE_REASONS = /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|RATE_LIMIT_EXCEEDED/i;

/** Google's error body as short facts: message, reasons (`errors[].reason`, `details[].reason`). */
function describeGoogle(json: unknown): { message: string; reasons: string } {
  const error = isRecord(json) && isRecord(json.error) ? json.error : {};
  const reasons = [
    ...records(error.errors).map((e) => text(e.reason)),
    ...records(error.details).map((d) => text(d.reason)),
  ]
    .filter((r): r is string => Boolean(r))
    .join(',');
  return { message: text(error.message) ?? '', reasons };
}

/**
 * Turns an unsuccessful Play Developer API reply into a typed error. Exported for the verifier.
 * `packageName` and `projectId` only make the message more useful; neither is a secret.
 */
export function googleError(
  reply: StoreReply,
  what: string,
  context: { packageName?: string; projectId?: string } = {},
): StoreError {
  const { message, reasons } = describeGoogle(reply.json);
  const status = reply.status;
  const app = context.packageName ? ` ${context.packageName}` : ' this app';
  const haystack = `${message} ${reasons}`;
  if (status === 401) {
    return new StoreError(
      'googleplay',
      'auth',
      'Google rejected the access token (401). The service account key may have been disabled or deleted. Download a new JSON key and try again.',
      status,
    );
  }
  if (status === 403 || status === 429) {
    if (RATE_REASONS.test(reasons)) return new StoreRateLimitError('googleplay', 60, status);
    if (DISABLED.test(haystack)) {
      const project = context.projectId ? ` (project ${context.projectId})` : '';
      return new StoreError(
        'googleplay',
        'api_disabled',
        `The Google Play Android Developer API is not enabled in the Google Cloud project of this service account${project}. Open the API in the Google Cloud console, click Enable, wait a few minutes and try again.`,
        status,
      );
    }
    if (/projectNotLinked/i.test(reasons)) {
      return new StoreError(
        'googleplay',
        'forbidden',
        'Google says the Cloud project of this service account is not linked in Play Console (projectNotLinked). Link it under Setup, API access in Play Console, then try again.',
        status,
      );
    }
    return new StoreError(
      'googleplay',
      'forbidden',
      `The service account has no access to${app} (403). In Play Console, open Users and permissions, invite the service account's email address and grant it access to the app. If that was just done, wait and try again.`,
      status,
    );
  }
  if (status === 404) {
    // Unverified wording, see the spike doc: a missing package says "Package not found"; an edit
    // that was invalidated mid-read is expected to mention the edit.
    if (/edit/i.test(message) && !/package/i.test(message)) {
      return new StoreError(
        'googleplay',
        'edit_invalid',
        'The edit was invalidated while it was being read (another edit or a Play Console change).',
        status,
      );
    }
    return new StoreError(
      'googleplay',
      'not_found',
      `Google Play has no app${context.packageName ? ` ${context.packageName}` : ''} that this service account can see (404). Check the package name. An app needs at least one uploaded build before the API can reach it.`,
      status,
    );
  }
  if (status >= 500) {
    return new StoreError(
      'googleplay',
      'server',
      `Google Play failed while ${what} (HTTP ${status}). Try again in a few minutes.`,
      status,
    );
  }
  return new StoreError(
    'googleplay',
    'unexpected',
    `Google Play answered ${what} with HTTP ${status}${message ? ` (${message.slice(0, 200)})` : ''}.`,
    status,
  );
}

export class GooglePlayConnector implements StoreConnector {
  readonly platform = 'android' as const;
  readonly packages: readonly string[];
  readonly #http: StoreHttp;
  readonly #tokens: GoogleTokenProvider;
  readonly #base: string;
  readonly #account: ServiceAccount;

  constructor(options: GooglePlayConnectorOptions) {
    this.#account =
      typeof options.serviceAccount === 'string'
        ? parseServiceAccount(options.serviceAccount)
        : options.serviceAccount;
    for (const name of options.packages) {
      if (!isPlayPackageName(name)) {
        throw new StoreError(
          'googleplay',
          'invalid_input',
          `Not a valid Android package name: ${JSON.stringify(name.slice(0, 80))}.`,
        );
      }
    }
    this.packages = [...options.packages];
    this.#http = new StoreHttp({ ...options, store: 'googleplay' });
    this.#base = (options.apiBase ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.#tokens = new GoogleTokenProvider(this.#account, this.#http);
  }

  /**
   * Exchanges the service account key for an access token. Proves the key is valid and the clock
   * is right. Proves nothing about Play: any service account of any project can get this token.
   */
  async checkToken(): Promise<void> {
    await this.#tokens.token();
  }

  /**
   * Inserts an edit for `packageName` and deletes it again. Proves that the Play Developer API is
   * enabled in the service account's project and that the account may open an edit for that app
   * (so it has been invited in Play Console). Reads nothing and commits nothing.
   */
  async probeEdit(packageName: string): Promise<void> {
    await this.withEdit(packageName, async () => undefined);
  }

  async verifyCredentials(): Promise<void> {
    await this.checkToken();
    for (const name of this.packages) await this.probeEdit(name);
  }

  async listApps(): Promise<StoreApp[]> {
    const apps: StoreApp[] = [];
    for (const name of this.packages) {
      apps.push(
        await this.withEdit(name, async (edit) => {
          const details = await this.#editGet(name, edit, '/details', 'reading the app details');
          const listed = await this.#editGet(name, edit, '/listings', 'reading the listings');
          const listings = records(listed?.listings);
          const language = text(details?.defaultLanguage);
          // The title is in the localized listings, not in the details. Prefer the default
          // language; otherwise the first listing there is.
          const listing = listings.find((l) => text(l.language) === language) ?? listings[0];
          return {
            storeId: name,
            platform: 'android' as const,
            name: text(listing?.title) ?? name,
            bundleId: name,
          };
        }),
      );
    }
    return apps;
  }

  /** The tracks of an app with their releases, status and staged rollout fraction. */
  async listTracks(packageName: string): Promise<PlayTrack[]> {
    return this.withEdit(packageName, async (edit) => {
      const body = await this.#editGet(packageName, edit, '/tracks', 'reading the tracks');
      return records(body?.tracks).flatMap((t): PlayTrack[] => {
        const track = text(t.track);
        if (!track) return [];
        return [
          {
            track,
            releases: records(t.releases).map((r) => {
              const name = text(r.name);
              const status = text(r.status);
              const fraction = num(r.userFraction);
              return {
                ...(name !== undefined ? { name } : {}),
                ...(status !== undefined ? { status } : {}),
                versionCodes: Array.isArray(r.versionCodes)
                  ? r.versionCodes.map((v) => String(v))
                  : [],
                ...(fraction !== undefined ? { userFraction: fraction } : {}),
              };
            }),
          },
        ];
      });
    });
  }

  /** One `StoreVersion` per release on every track. See `mapPlayTrackRelease` for the states. */
  async listVersions(appStoreId: string): Promise<StoreVersion[]> {
    const versions: StoreVersion[] = [];
    for (const { track, releases } of await this.listTracks(appStoreId)) {
      for (const release of releases) {
        const mapped = mapPlayTrackRelease({
          status: release.status,
          userFraction: release.userFraction,
        });
        const codes = release.versionCodes.join(',');
        versions.push({
          storeId: `${track}:${codes}`,
          appStoreId,
          platform: 'android',
          // Play has no marketing version in the tracks API; the release name is derived from the
          // APK's versionName when unset, so use it, and the version codes when there is none.
          versionString: release.name ?? codes,
          rawState: release.status ?? 'statusUnspecified',
          ...(mapped ? { lifecycleState: mapped.state } : {}),
          ...(mapped?.fraction !== undefined ? { rolloutFraction: mapped.fraction } : {}),
          track,
          versionCodes: release.versionCodes,
        });
      }
    }
    return versions;
  }

  /** App bundles and APKs in the app's edit, one `StoreBuild` each, newest version code first. */
  async listBuilds(appStoreId: string): Promise<StoreBuild[]> {
    return this.withEdit(appStoreId, async (edit) => {
      const builds: StoreBuild[] = [];
      const bundles = await this.#editGet(appStoreId, edit, '/bundles', 'reading the app bundles');
      const apks = await this.#editGet(appStoreId, edit, '/apks', 'reading the APKs');
      for (const [kind, list] of [
        ['aab', records(bundles?.bundles)],
        ['apk', records(apks?.apks)],
      ] as const) {
        for (const item of list) {
          const code = num(item.versionCode) ?? Number(text(item.versionCode));
          if (!Number.isFinite(code)) continue;
          builds.push({
            storeId: `${kind}:${code}`,
            appStoreId,
            platform: 'android',
            buildNumber: String(code),
            // Anything in an edit's list has been uploaded and processed by Play.
            processing: 'processed',
          });
        }
      }
      return builds.sort((a, b) => Number(b.buildNumber) - Number(a.buildNumber));
    });
  }

  /**
   * The per-language store listings (title, short description, full description, promo video),
   * read with `GET .../edits/{editId}/listings` inside a read-only edit that is deleted, never
   * committed. The listings of an edit are a copy of the deployed state ("Edits" guide). The
   * Play model has no subtitle, keywords, promotional text or URLs, so those are never present;
   * release notes belong to track releases and are not in `changelogs` (it is empty): with
   * `options.extended` they are read into the `releaseNotes` section instead.
   *
   * With `options.extended` the same read-only edit also reads, all GET:
   * - `GET .../edits/{editId}/details` (default language, support email and website; the phone number
   *   is NOT read): https://developers.google.com/android-publisher/api-ref/rest/v3/edits.details/get
   * - `GET .../edits/{editId}/listings/{language}/{imageType}` for each of the eight image types
   *   (https://developers.google.com/android-publisher/api-ref/rest/v3/edits.images/list and
   *   https://developers.google.com/android-publisher/api-ref/rest/v3/AppImageType), as ids and counts
   *   only: neither the image URL nor the image is requested (the read has no `deleteall`, no
   *   `upload`). An image type with no images answers an empty body;
   * - `GET .../edits/{editId}/tracks` (release notes of the current release of each track:
   *   https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks).
   * Google Play has no app category in the Play Developer API (none of its resources has one), so
   * there is no `categories` section for Android. A failing optional part is a warning and the
   * section is left out ("not read"); only a rate limit, a bad credential or the network stop the read.
   */
  async readListing(
    appStoreId: string,
    options: ReadStoreListingOptions = {},
  ): Promise<StoreListing> {
    return this.withEdit(appStoreId, async (edit) => {
      const body = await this.#editGet(appStoreId, edit, '/listings', 'reading the listings');
      const warnings: string[] = [];
      const locales: Record<string, LocaleText<PlayField>> = {};
      for (const item of records(body?.listings)) {
        const language = text(item.language);
        if (!language) continue;
        const texts: LocaleText<PlayField> = {};
        const title = text(item.title);
        const shortDescription = text(item.shortDescription);
        const fullDescription = text(item.fullDescription);
        const video = text(item.video);
        if (title !== undefined) texts.title = title;
        if (shortDescription !== undefined) texts.short_description = shortDescription;
        if (fullDescription !== undefined) texts.full_description = fullDescription;
        if (video !== undefined) texts.video = video;
        locales[language] = texts;
      }
      const sections: ListingSections = {};
      if (options.extended === true) {
        let defaultLanguage: string | undefined;
        try {
          const details = await this.#editGet(
            appStoreId,
            edit,
            '/details',
            'reading the app details',
          );
          sections.details = playDetails(details);
          defaultLanguage = sections.details.defaultLanguage;
        } catch (error) {
          warnings.push(sectionWarning(error, 'The app details'));
        }
        try {
          const tracks = await this.#editGet(appStoreId, edit, '/tracks', 'reading the tracks');
          sections.releaseNotes = playReleaseNotes(records(tracks?.tracks));
        } catch (error) {
          warnings.push(sectionWarning(error, 'The release notes of the tracks'));
        }
        const languages = Object.keys(locales).sort((a, b) =>
          a === defaultLanguage ? -1 : b === defaultLanguage ? 1 : a < b ? -1 : a > b ? 1 : 0,
        );
        const media = await this.#readImages(
          appStoreId,
          edit,
          languages.slice(0, MAX_IMAGE_LANGUAGES),
          warnings,
        );
        if (media) {
          if (languages.length > MAX_IMAGE_LANGUAGES) {
            media.truncated = true;
            warnings.push(
              `Images were read for ${MAX_IMAGE_LANGUAGES} of ${languages.length} languages.`,
            );
          }
          sections.media = media;
        }
      }
      return {
        platform: 'android' as const,
        appStoreId,
        channels: [
          {
            channel: 'live' as const,
            listing: { googlePlay: { locales, changelogs: {} } },
            ...(Object.keys(sections).length > 0 ? { sections } : {}),
          },
        ],
        warnings,
      };
    });
  }

  /**
   * The images of each language as ids and counts (`edits.images.list`), eight requests per
   * language, one language after the other. Undefined (and a warning) when an image call fails.
   */
  async #readImages(
    packageName: string,
    editId: string,
    languages: readonly string[],
    warnings: string[],
  ): Promise<NonNullable<ListingSections['media']> | undefined> {
    const screenshots: Record<string, MediaSet[]> = {};
    const graphics: Record<string, MediaSet[]> = {};
    try {
      for (const language of languages) {
        const read = async (type: string) =>
          playImageSet(
            type,
            await this.#editGet(
              packageName,
              editId,
              `/listings/${enc(language)}/${enc(type)}`,
              `reading the ${type} of ${language}`,
            ),
          );
        screenshots[language] = [];
        graphics[language] = [];
        for (const type of PLAY_SCREENSHOT_TYPES)
          (screenshots[language] as MediaSet[]).push(await read(type));
        for (const type of PLAY_GRAPHIC_TYPES)
          (graphics[language] as MediaSet[]).push(await read(type));
      }
    } catch (error) {
      warnings.push(sectionWarning(error, 'The store listing images'));
      return undefined;
    }
    return { screenshots, graphics };
  }

  /**
   * Runs `read` inside an edit for `packageName`, then deletes the edit. Serialized per service
   * account (see the class comment). Retried once, with a new edit, if the edit was invalidated
   * while reading. The edit is never committed.
   */
  async withEdit<T>(packageName: string, read: (editId: string) => Promise<T>): Promise<T> {
    if (!isPlayPackageName(packageName)) {
      throw new StoreError(
        'googleplay',
        'invalid_input',
        `Not a valid Android package name: ${JSON.stringify(packageName.slice(0, 80))}.`,
      );
    }
    return serialized(this.#account.clientEmail, async () => {
      for (let attempt = 0; ; attempt++) {
        const editId = await this.#insertEdit(packageName);
        try {
          return await read(editId);
        } catch (error) {
          if (error instanceof StoreError && error.kind === 'edit_invalid' && attempt === 0) {
            continue;
          }
          throw error;
        } finally {
          await this.#deleteEdit(packageName, editId);
        }
      }
    });
  }

  // -------------------------------------------------------------------------------------------

  #url(packageName: string, suffix: string): string {
    return `${this.#base}/androidpublisher/v3/applications/${enc(packageName)}/edits${suffix}`;
  }

  async #call(
    method: string,
    url: string,
    what: string,
    packageName: string,
    json?: unknown,
  ): Promise<StoreReply> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.#tokens.token();
      const reply = await this.#http.send(method, url, {
        headers: { authorization: `Bearer ${token}` },
        ...(json !== undefined ? { json } : {}),
      });
      if (reply.status === 401 && attempt === 0) {
        // A cached token can be revoked early. Mint a new one once.
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
      const error = googleError(reply, what, {
        packageName,
        ...(this.#account.projectId ? { projectId: this.#account.projectId } : {}),
      });
      if (error instanceof StoreRateLimitError) throw error;
      // Google's own error text can be part of the message: make sure it cannot carry a secret.
      throw new StoreError(
        'googleplay',
        error.kind,
        this.#http.redact(error.message),
        error.status,
      );
    }
  }

  async #insertEdit(packageName: string): Promise<string> {
    const reply = await this.#call(
      'POST',
      this.#url(packageName, ''),
      'opening an edit',
      packageName,
      {},
    );
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
  async #deleteEdit(packageName: string, editId: string): Promise<void> {
    try {
      await this.#call(
        'DELETE',
        this.#url(packageName, `/${enc(editId)}`),
        'deleting the edit',
        packageName,
      );
    } catch {
      // Nothing was changed by the read, so there is nothing to undo.
    }
  }

  async #editGet(
    packageName: string,
    editId: string,
    suffix: string,
    what: string,
  ): Promise<Json | undefined> {
    const reply = await this.#call(
      'GET',
      this.#url(packageName, `/${enc(editId)}${suffix}`),
      what,
      packageName,
    );
    return isRecord(reply.json) ? reply.json : undefined;
  }
}
