import { APPLE_BASE } from './store.fixtures.ts';

/**
 * Hand-written fixtures for the store listing reads. Like `store.fixtures.ts` they follow the
 * shapes in Apple's and Google's reference pages (attribute names from the "Attributes" pages of
 * AppInfoLocalization, AppStoreVersionLocalization and the Play `Listing` resource) and are NOT
 * recordings of live traffic. Which `state` an app info has while a new version is prepared (a
 * second app info next to the live one) is community knowledge, not a vendor page.
 */

const link = (path: string) => ({ self: `${APPLE_BASE}${path}` });

const version = (id: string, attributes: Record<string, unknown>) => ({
  type: 'appStoreVersions',
  id,
  attributes: {
    copyright: '2026 Coffee Co',
    releaseType: 'MANUAL',
    downloadable: true,
    ...attributes,
  },
  links: link(`/v1/appStoreVersions/${id}`),
});

/** A live 2.0, an editable 2.1, an older replaced 1.9 and a macOS version that is ignored. */
export const appleListingVersions = {
  data: [
    version('v-live', {
      platform: 'IOS',
      versionString: '2.0',
      appVersionState: 'READY_FOR_DISTRIBUTION',
      createdDate: '2026-09-01T10:00:00-07:00',
    }),
    version('v-next', {
      platform: 'IOS',
      versionString: '2.1',
      appVersionState: 'PREPARE_FOR_SUBMISSION',
      createdDate: '2026-11-01T10:00:00-07:00',
    }),
    version('v-old', {
      platform: 'IOS',
      versionString: '1.9',
      appVersionState: 'REPLACED_WITH_NEW_VERSION',
      createdDate: '2026-06-01T10:00:00-07:00',
    }),
    version('v-mac', {
      platform: 'MAC_OS',
      versionString: '9.9',
      appVersionState: 'PREPARE_FOR_SUBMISSION',
      createdDate: '2026-11-02T10:00:00-07:00',
    }),
  ],
  links: link('/v1/apps/100/appStoreVersions'),
  meta: { paging: { total: 4, limit: 200 } },
};

const info = (id: string, attributes: Record<string, unknown>) => ({
  type: 'appInfos',
  id,
  attributes: { appStoreAgeRating: 'FOUR_PLUS', ...attributes },
  links: link(`/v1/appInfos/${id}`),
});

/** Apple keeps one app info for the live state and one for the next one. */
export const appleAppInfos = {
  data: [
    info('info-live', { state: 'READY_FOR_DISTRIBUTION' }),
    info('info-next', { state: 'PREPARE_FOR_SUBMISSION' }),
  ],
  links: link('/v1/apps/100/appInfos'),
  meta: { paging: { total: 2, limit: 200 } },
};

export const appleAppInfosLiveOnly = {
  data: [info('info-live', { state: 'READY_FOR_DISTRIBUTION' })],
  links: link('/v1/apps/100/appInfos'),
  meta: { paging: { total: 1, limit: 200 } },
};

/** The deprecated `appStoreState` only (older API behaviour). */
export const appleAppInfosOldState = {
  data: [info('info-live', { appStoreState: 'READY_FOR_SALE' })],
  links: link('/v1/apps/100/appInfos'),
  meta: { paging: { total: 1, limit: 200 } },
};

const infoLoc = (id: string, attributes: Record<string, unknown>) => ({
  type: 'appInfoLocalizations',
  id,
  attributes,
  links: link(`/v1/appInfoLocalizations/${id}`),
});

export const appleInfoLocalizationsLive = {
  data: [
    infoLoc('il-en', {
      locale: 'en-US',
      name: 'Coffee',
      subtitle: 'Brew better',
      privacyPolicyUrl: 'https://example.org/privacy',
      privacyChoicesUrl: 'https://example.org/choices',
      privacyPolicyText: null,
    }),
    infoLoc('il-de', {
      locale: 'de-DE',
      name: 'Kaffee',
      subtitle: null,
      privacyPolicyUrl: null,
      privacyPolicyText: null,
    }),
  ],
  links: link('/v1/appInfos/info-live/appInfoLocalizations'),
  meta: { paging: { total: 2, limit: 200 } },
};

export const appleInfoLocalizationsNext = {
  data: [
    infoLoc('il2-en', {
      locale: 'en-US',
      name: 'Coffee Pro',
      subtitle: 'Brew even better',
      privacyPolicyUrl: 'https://example.org/privacy',
    }),
    infoLoc('il2-de', { locale: 'de-DE', name: 'Kaffee Pro', subtitle: 'Besser brühen' }),
  ],
  links: link('/v1/appInfos/info-next/appInfoLocalizations'),
  meta: { paging: { total: 2, limit: 200 } },
};

const versionLoc = (id: string, attributes: Record<string, unknown>) => ({
  type: 'appStoreVersionLocalizations',
  id,
  attributes,
  links: link(`/v1/appStoreVersionLocalizations/${id}`),
});

export const appleVersionLocalizationsLive = {
  data: [
    versionLoc('vl-en', {
      locale: 'en-US',
      description: 'The best coffee app.',
      keywords: 'coffee,brew',
      marketingUrl: 'https://example.org',
      promotionalText: 'Now with timers',
      supportUrl: 'https://example.org/support',
      whatsNew: 'Bug fixes',
    }),
    versionLoc('vl-de', {
      locale: 'de-DE',
      description: 'Die beste Kaffee-App.',
      keywords: 'kaffee',
      marketingUrl: null,
      promotionalText: null,
      supportUrl: 'https://example.org/hilfe',
      whatsNew: null,
    }),
  ],
  links: link('/v1/appStoreVersions/v-live/appStoreVersionLocalizations'),
  meta: { paging: { total: 2, limit: 200 } },
};

export const appleVersionLocalizationsNext = {
  data: [
    versionLoc('vl2-en', {
      locale: 'en-US',
      description: 'The best coffee app. Now with grinders.',
      keywords: 'coffee,brew,grinder',
      supportUrl: 'https://example.org/support',
      whatsNew: 'Grinder support',
    }),
  ],
  links: link('/v1/appStoreVersions/v-next/appStoreVersionLocalizations'),
  meta: { paging: { total: 1, limit: 200 } },
};

/** A Play listing response (the `Listing` resource of `edits.listings`). */
export const googleListingsFull = {
  kind: 'androidpublisher#listingsListResponse',
  listings: [
    {
      language: 'en-US',
      title: 'Coffee',
      shortDescription: 'Brew better',
      fullDescription: 'The best coffee app.',
      video: 'https://www.youtube.com/watch?v=abc',
    },
    {
      language: 'de-DE',
      title: 'Kaffee',
      shortDescription: 'Besser brühen',
      fullDescription: 'Die beste Kaffee-App.',
    },
    { title: 'no language, skipped' },
  ],
};
