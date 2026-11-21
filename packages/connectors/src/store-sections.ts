import type {
  ListingAgeRating,
  ListingCategories,
  ListingDetails,
  ListingReleaseNotes,
  MediaSet,
} from '@kiln/core';
import { StoreError, StoreRateLimitError } from './errors.ts';
import { isRecord, type Json, num, records, text } from './store-http.ts';

/**
 * Parsers of the read-only listing sections of both stores: the pure part, so they can be tested
 * against the shapes of the vendors' reference pages without a connector. All of them are tolerant:
 * an unknown member is ignored, a wrong type is skipped, nothing throws. They never read image
 * bytes, image URLs, demo-account credentials, review contact names or phone numbers.
 *
 * Shapes (the pages are cited next to each endpoint in `appstoreconnect.ts` and `googleplay.ts`):
 * App Store Connect answers JSON:API documents (`data`, `included`, `relationships.<name>.data`);
 * the Play Developer API answers plain JSON resources.
 *
 * UNVERIFIED (no live run): that Apple sends `relationships.<name>.data` (a linkage, or null when
 * the relationship is empty) for the relationships named in `include`, and the values of
 * `AppInfo.appStoreAgeRating`. Where a shape is uncertain the parser says "not read" (undefined)
 * rather than guessing "empty".
 */

const CATEGORY_RELATIONSHIPS = [
  ['primary', 'primaryCategory'],
  ['secondary', 'secondaryCategory'],
  ['primarySubcategories', 'primarySubcategoryOne'],
  ['primarySubcategories', 'primarySubcategoryTwo'],
  ['secondarySubcategories', 'secondarySubcategoryOne'],
  ['secondarySubcategories', 'secondarySubcategoryTwo'],
] as const;

/** The `include` values of `GET /v1/apps/{id}/appInfos` that carry categories and the age rating. */
export const APPLE_INFO_INCLUDES = [
  ...CATEGORY_RELATIONSHIPS.map(([, relationship]) => relationship),
  'ageRatingDeclaration',
].join(',');

function linkage(info: Json, relationship: string): { present: boolean; id?: string } {
  const relationships = isRecord(info.relationships) ? info.relationships : {};
  const rel = relationships[relationship];
  if (!isRecord(rel) || !('data' in rel)) return { present: false };
  const data = rel.data;
  const id = isRecord(data) ? text(data.id) : undefined;
  return id === undefined ? { present: true } : { present: true, id };
}

/**
 * The categories of an app info, from the relationship linkage (`relationships.primaryCategory.data.id`
 * and so on, which Apple sends for what `include` named). The category id is the name: `GAMES`,
 * `GAMES_CARD`. Undefined when none of the six relationships carries linkage at all (then it is not
 * known whether the app info has categories).
 */
export function appleCategories(info: Json): ListingCategories | undefined {
  let any = false;
  const out: ListingCategories = {};
  for (const [key, relationship] of CATEGORY_RELATIONSHIPS) {
    const found = linkage(info, relationship);
    if (found.present) any = true;
    if (found.id === undefined) continue;
    if (key === 'primary' || key === 'secondary') out[key] = found.id;
    else (out[key] ??= []).push(found.id);
  }
  return any ? out : undefined;
}

/**
 * The age rating declaration of an app info: the answers are every boolean and string attribute of
 * the `ageRatingDeclarations` resource (names as Apple documents them: `advertising`, `gambling`,
 * `violenceRealistic`, `ageRatingOverrideV2`, ...; unknown ones are kept, so a new Apple question
 * shows up), and the resulting label is the app info's `appStoreAgeRating`. Undefined when the
 * linkage is missing, or points at a resource that was not included.
 */
export function appleAgeRating(
  info: Json,
  included: readonly Json[],
): ListingAgeRating | undefined {
  const attributes = isRecord(info.attributes) ? info.attributes : {};
  const rating = text(attributes.appStoreAgeRating);
  const found = linkage(info, 'ageRatingDeclaration');
  if (!found.present) return undefined;
  if (found.id === undefined)
    return rating !== undefined ? { rating, answers: {} } : { answers: {} };
  const declaration = included.find(
    (item) => text(item.type) === 'ageRatingDeclarations' && text(item.id) === found.id,
  );
  if (!declaration) return undefined;
  const raw = isRecord(declaration.attributes) ? declaration.attributes : {};
  const answers: Record<string, string | boolean> = {};
  for (const key of Object.keys(raw).sort()) {
    const value = raw[key];
    if (typeof value === 'boolean' || typeof value === 'string') answers[key] = value;
  }
  return rating !== undefined ? { rating, answers } : { answers };
}

/**
 * Screenshot sets (`appScreenshotSets`) or preview sets (`appPreviewSets`) of one version
 * localization as metadata: the display type, how many assets, their file names and the count of
 * each asset state (`assetDeliveryState.state`). `included` is the compound document's `included`
 * array (`appScreenshots` / `appPreviews`). The asset URLs and upload operations are never read.
 */
export function appleMediaSets(body: Json, kind: 'screenshots' | 'previews'): MediaSet[] {
  const setType = kind === 'screenshots' ? 'screenshotDisplayType' : 'previewType';
  const itemRelationship = kind === 'screenshots' ? 'appScreenshots' : 'appPreviews';
  const itemType = itemRelationship;
  const included = new Map<string, Json>();
  for (const item of records(body.included)) {
    const id = text(item.id);
    if (text(item.type) === itemType && id !== undefined) included.set(id, item);
  }
  const sets: MediaSet[] = [];
  for (const item of records(body.data)) {
    const attributes = isRecord(item.attributes) ? item.attributes : {};
    const type = text(attributes[setType]);
    if (type === undefined) continue;
    const relationships = isRecord(item.relationships) ? item.relationships : {};
    const rel = isRecord(relationships[itemRelationship]) ? relationships[itemRelationship] : {};
    const refs = records(isRecord(rel) ? rel.data : undefined);
    const meta = isRecord(rel) && isRecord(rel.meta) ? rel.meta : {};
    const paging = isRecord(meta.paging) ? meta.paging : {};
    const total = num(paging.total);
    const names: string[] = [];
    const states: Record<string, number> = {};
    for (const ref of refs) {
      const asset = included.get(text(ref.id) ?? '');
      const assetAttributes = isRecord(asset?.attributes) ? asset.attributes : {};
      const name = text(assetAttributes.fileName);
      if (name !== undefined) names.push(name);
      const delivery = isRecord(assetAttributes.assetDeliveryState)
        ? assetAttributes.assetDeliveryState
        : {};
      const state = text(delivery.state);
      if (state !== undefined) states[state] = (states[state] ?? 0) + 1;
    }
    const set: MediaSet = { type, count: Math.max(refs.length, total ?? 0) };
    if (names.length > 0) set.names = names;
    if (Object.keys(states).length > 0) set.states = states;
    sets.push(set);
  }
  return sets.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// Google Play

/** Image types of `edits.images`, split into screenshots and graphics (AppImageType, Play docs). */
export const PLAY_SCREENSHOT_TYPES = [
  'phoneScreenshots',
  'sevenInchScreenshots',
  'tenInchScreenshots',
  'tvScreenshots',
  'wearScreenshots',
] as const;
export const PLAY_GRAPHIC_TYPES = ['icon', 'featureGraphic', 'tvBanner'] as const;

/** One `edits.images.list` answer as a set: how many images and their ids (never the URL or a hash). */
export function playImageSet(type: string, body: Json | undefined): MediaSet {
  const ids = records(body?.images).flatMap((image) => {
    const id = text(image.id);
    return id === undefined ? [] : [id];
  });
  const total = records(body?.images).length;
  return { type, count: total, ...(ids.length > 0 ? { ids: ids.slice(0, 20) } : {}) };
}

/**
 * `edits.details`: the default language and the user-visible support email and website. The
 * support phone number (`contactPhone`) is deliberately not read.
 */
export function playDetails(body: Json | undefined): ListingDetails {
  const out: ListingDetails = {};
  const defaultLanguage = text(body?.defaultLanguage);
  const contactEmail = text(body?.contactEmail);
  const contactWebsite = text(body?.contactWebsite);
  if (defaultLanguage !== undefined && defaultLanguage !== '')
    out.defaultLanguage = defaultLanguage;
  if (contactEmail !== undefined && contactEmail !== '') out.contactEmail = contactEmail;
  if (contactWebsite !== undefined && contactWebsite !== '') out.contactWebsite = contactWebsite;
  return out;
}

const MAX_TRACKS = 20;

/**
 * The release notes of the current release of each track, from `edits.tracks` (`releases[].releaseNotes`,
 * LocalizedText: language and text). The current release is the live one (`inProgress`, else `completed`)
 * with the highest version code; a track with no such release uses its first release (a draft, say).
 */
export function playReleaseNotes(tracks: readonly Json[]): ListingReleaseNotes {
  const out: ListingReleaseNotes['tracks'] = {};
  for (const track of tracks.slice(0, MAX_TRACKS)) {
    const name = text(track.track);
    if (!name) continue;
    const releases = records(track.releases);
    const codes = (r: Json) =>
      Array.isArray(r.versionCodes)
        ? r.versionCodes.map((v) => Number(v)).filter(Number.isFinite)
        : [];
    const rank = (r: Json) =>
      text(r.status) === 'inProgress' ? 2 : text(r.status) === 'completed' ? 1 : 0;
    const current = [...releases].sort(
      (a, b) => rank(b) - rank(a) || Math.max(0, ...codes(b)) - Math.max(0, ...codes(a)),
    )[0];
    if (!current) continue;
    const notes: Record<string, string> = {};
    for (const note of records(current.releaseNotes)) {
      const language = text(note.language);
      const value = text(note.text);
      if (language && value !== undefined) notes[language] = value;
    }
    const releaseName = text(current.name);
    const status = text(current.status);
    out[name] = {
      ...(releaseName !== undefined ? { name: releaseName } : {}),
      ...(status !== undefined ? { status } : {}),
      versionCodes: Array.isArray(current.versionCodes)
        ? current.versionCodes.map((v) => String(v))
        : [],
      notes,
    };
  }
  return { tracks: out };
}

// ---------------------------------------------------------------------------------------------
// Optional sections that fail

/** The kinds of `StoreError` that end a listing read even when only an optional section was being read. */
const FATAL_KINDS: ReadonlySet<string> = new Set([
  'rate_limited',
  'auth',
  'clock_skew',
  'network',
  'edit_invalid',
]);

/**
 * What to do with the failure of an optional section (categories, media, details, ...): a rate
 * limit, a bad credential, a clock problem, the network or an invalidated Play edit (anything the texts would also hit, or that the edit retry handles) is
 * rethrown, so the read stops and the existing error handling shows it; any other store error
 * becomes one safe sentence for `StoreListing.warnings`, and the section is left out ("not read").
 * A thing that is not a `StoreError` is a bug and is rethrown too.
 */
export function sectionWarning(error: unknown, what: string): string {
  if (error instanceof StoreRateLimitError) throw error;
  if (error instanceof StoreError && !FATAL_KINDS.has(error.kind)) {
    const status = error.status === undefined ? '' : ` HTTP ${error.status}`;
    return `${what} could not be read (${error.kind}${status}); it is shown as not read. ${error.message}`.slice(
      0,
      400,
    );
  }
  throw error;
}
