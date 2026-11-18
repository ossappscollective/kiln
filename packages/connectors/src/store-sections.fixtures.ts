import { APPLE_BASE } from './store.fixtures.ts';

/**
 * Hand-written fixtures for the listing SECTIONS (categories, age rating, privacy choices, media,
 * details, release notes). They follow the shapes of the reference pages named next to each
 * endpoint in `appstoreconnect.ts` and `googleplay.ts` (attribute and relationship names from the
 * AppInfo, AgeRatingDeclaration, AppScreenshotSet, AppScreenshot, AppPreviewSet and AppMediaAssetState
 * pages; the Play AppDetails, Image and Track pages) and are NOT recordings of live traffic.
 *
 * UNVERIFIED: that Apple returns `relationships.<name>.data` for what `include` names (and `null` for
 * an empty one), the values of `AppInfo.appStoreAgeRating`, and the `id` of an app category being its
 * name (`GAMES`). The `templateUrl` and `uploadOperations` members are in here on purpose: the
 * connector must never keep them.
 */

const link = (path: string) => ({ self: `${APPLE_BASE}${path}` });

const rel = (type: string, id: string | null) => ({ data: id === null ? null : { type, id } });

/** The age rating declaration of the live app (Apple's attribute names; booleans and frequency words). */
export const ageRatingLive = {
  type: 'ageRatingDeclarations',
  id: 'ard-live',
  attributes: {
    advertising: false,
    alcoholTobaccoOrDrugUseOrReferences: 'NONE',
    contests: 'NONE',
    gambling: false,
    gamblingSimulated: 'NONE',
    gunsOrOtherWeapons: 'NONE',
    healthOrWellnessTopics: false,
    kidsAgeBand: null,
    lootBox: false,
    messagingAndChat: false,
    parentalControls: false,
    profanityOrCrudeHumor: 'INFREQUENT_OR_MILD',
    unrestrictedWebAccess: false,
    userGeneratedContent: true,
    violenceRealistic: 'NONE',
    ageRatingOverrideV2: 'NONE',
    developerAgeRatingInfoUrl: null,
    // A question Apple adds later: kept, not dropped.
    someFutureQuestion: 'FREQUENT',
    // Not a scalar: ignored.
    weird: { nested: true },
  },
  links: link('/v1/ageRatingDeclarations/ard-live'),
};

export const ageRatingNext = {
  type: 'ageRatingDeclarations',
  id: 'ard-next',
  attributes: { advertising: true, gambling: false, contests: 'NONE', userGeneratedContent: true },
};

const infoWith = (id: string, state: string, relationships: Record<string, unknown>) => ({
  type: 'appInfos',
  id,
  attributes: { state, appStoreAgeRating: 'FOUR_PLUS' },
  relationships,
  links: link(`/v1/appInfos/${id}`),
});

/**
 * `GET /v1/apps/100/appInfos?include=<categories and ageRatingDeclaration>`: the live info has a
 * primary and a secondary category with one subcategory; the next info has none (all `data: null`).
 */
export const appleAppInfosExtended = {
  data: [
    infoWith('info-live', 'READY_FOR_DISTRIBUTION', {
      primaryCategory: rel('appCategories', 'GAMES'),
      primarySubcategoryOne: rel('appCategories', 'GAMES_CARD'),
      primarySubcategoryTwo: rel('appCategories', null),
      secondaryCategory: rel('appCategories', 'ENTERTAINMENT'),
      secondarySubcategoryOne: rel('appCategories', null),
      secondarySubcategoryTwo: rel('appCategories', null),
      ageRatingDeclaration: rel('ageRatingDeclarations', 'ard-live'),
    }),
    infoWith('info-next', 'PREPARE_FOR_SUBMISSION', {
      primaryCategory: rel('appCategories', null),
      secondaryCategory: rel('appCategories', null),
      ageRatingDeclaration: rel('ageRatingDeclarations', 'ard-next'),
    }),
  ],
  included: [
    { type: 'appCategories', id: 'GAMES', attributes: { platforms: ['IOS'] } },
    { type: 'appCategories', id: 'GAMES_CARD', attributes: { platforms: ['IOS'] } },
    { type: 'appCategories', id: 'ENTERTAINMENT', attributes: { platforms: ['IOS'] } },
    ageRatingLive,
    ageRatingNext,
  ],
  links: link('/v1/apps/100/appInfos'),
  meta: { paging: { total: 2, limit: 200 } },
};

/** An answer that has no linkage at all (the include was ignored): not read, never guessed as empty. */
export const appleAppInfosNoLinkage = {
  data: [
    { type: 'appInfos', id: 'info-live', attributes: { state: 'READY_FOR_DISTRIBUTION' }, relationships: { primaryCategory: { links: { self: 'x' } } } },
  ],
  links: link('/v1/apps/100/appInfos'),
};

const set = (id: string, kind: 'screenshotDisplayType' | 'previewType', type: string, rel: 'appScreenshots' | 'appPreviews', items: string[]) => ({
  type: kind === 'screenshotDisplayType' ? 'appScreenshotSets' : 'appPreviewSets',
  id,
  attributes: { [kind]: type },
  relationships: { [rel]: { data: items.map((i) => ({ type: rel, id: i })) } },
});

const shot = (id: string, fileName: string, state: string) => ({
  type: 'appScreenshots',
  id,
  attributes: {
    fileName,
    assetDeliveryState: { state, errors: [], warnings: [] },
    // Never kept: a template URL of the image and upload instructions.
    imageAsset: { templateUrl: 'https://is1-ssl.mzstatic.com/image/{w}x{h}bb.{f}', width: 1290, height: 2796 },
    uploadOperations: [{ method: 'PUT', url: 'https://upload.example.invalid/secret' }],
  },
});

/** Screenshot sets of the live en-US localization: six iPhone screenshots (one still uploading), two iPad. */
export const screenshotSetsEn = {
  data: [
    set('ss-1', 'screenshotDisplayType', 'APP_IPHONE_67', 'appScreenshots', ['sh-1', 'sh-2', 'sh-3']),
    set('ss-2', 'screenshotDisplayType', 'APP_IPAD_PRO_3GEN_129', 'appScreenshots', ['sh-4']),
  ],
  included: [
    shot('sh-1', '1_home.png', 'COMPLETE'),
    shot('sh-2', '2_brew.png', 'COMPLETE'),
    shot('sh-3', '3_timer.png', 'AWAITING_UPLOAD'),
    shot('sh-4', 'ipad_1.png', 'COMPLETE'),
  ],
  links: link('/v1/appStoreVersionLocalizations/vl-en/appScreenshotSets'),
};

export const screenshotSetsDe = { data: [], links: link('/v1/appStoreVersionLocalizations/vl-de/appScreenshotSets') };

export const previewSetsEn = {
  data: [set('ps-1', 'previewType', 'IPHONE_67', 'appPreviews', ['pv-1'])],
  included: [{ type: 'appPreviews', id: 'pv-1', attributes: { fileName: 'demo.mp4', assetDeliveryState: { state: 'COMPLETE' }, videoUrl: 'https://v.example.invalid/x.mp4' } }],
};

export const previewSetsEmpty = { data: [] };

/** Play: `edits.details` with a phone number that must never be kept. */
export const googleDetails = {
  defaultLanguage: 'en-US',
  contactEmail: 'support@example.org',
  contactWebsite: 'https://example.org',
  contactPhone: '+33 1 23 45 67 89',
};

/** Play: `edits.tracks` with a production release in progress (with notes), a beta draft and an empty track. */
export const googleTracks = {
  kind: 'androidpublisher#tracksListResponse',
  tracks: [
    {
      track: 'production',
      releases: [
        { name: '1.9', status: 'completed', versionCodes: ['190'], releaseNotes: [{ language: 'en-US', text: 'Old notes' }] },
        {
          name: '2.0',
          status: 'inProgress',
          userFraction: 0.2,
          versionCodes: ['200', '201'],
          releaseNotes: [
            { language: 'en-US', text: 'Timers and bug fixes' },
            { language: 'de-DE', text: 'Timer und Fehlerbehebungen' },
          ],
        },
      ],
    },
    { track: 'beta', releases: [{ status: 'draft', versionCodes: ['210'] }] },
    { track: 'internal', releases: [] },
  ],
};

/** Play: `edits.images.list` for one type: two ids with URLs and hashes that must never be kept. */
export const googleImages = (ids: string[]) => ({
  images: ids.map((id) => ({ id, url: `https://play-lh.example.invalid/${id}`, sha1: 'a'.repeat(40), sha256: 'b'.repeat(64) })),
});
