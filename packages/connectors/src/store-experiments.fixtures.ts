import * as fx from './store.fixtures.ts';

/**
 * Hand-written fixtures for the experiments and custom product page connector. They follow the object, attribute and parameter names on
 * Apple's reference pages (see apple/appstore-experiments.ts) and are NOT recordings of live traffic: no response was seen from a real
 * account, so the JSON:API `type` strings and the linkage are the ones the connector expects.
 */

export const APP = '6740123456';
export const T0 = Date.UTC(2026, 10, 22, 12, 0, 0);

const linkage = (type: string, ids: string[]) => ({ data: ids.map((i) => ({ type, id: i })) });

export const experiment = (
  idValue: string,
  over: Record<string, unknown> = {},
  treatmentIds: string[] | undefined = ['t1', 't2'],
) => ({
  type: 'appStoreVersionExperiments',
  id: idValue,
  attributes: {
    name: 'Icon test',
    platform: 'IOS',
    trafficProportion: 30,
    state: 'APPROVED',
    reviewRequired: true,
    startDate: '2026-10-01T08:00:00Z',
    endDate: null,
    ...over,
  },
  relationships:
    treatmentIds === undefined
      ? {}
      : { appStoreVersionExperimentTreatments: linkage('appStoreVersionExperimentTreatments', treatmentIds) },
});

export const treatment = (idValue: string, name: string, extra: Record<string, unknown> = {}) => ({
  type: 'appStoreVersionExperimentTreatments',
  id: idValue,
  attributes: { name, appIconName: null, promotedDate: null, ...extra },
});

export const localization = (
  type: string,
  idValue: string,
  locale: string,
  placementIds: string[],
  extra: Record<string, unknown> = {},
  setIds: string[] = [],
) => ({
  type,
  id: idValue,
  attributes: { locale, ...extra },
  relationships: {
    placements: linkage('appAssetLibraryPlacements', placementIds),
    appScreenshotSets: linkage('appScreenshotSets', setIds),
  },
});

export const placement = (idValue: string, placementType: string) => ({
  type: 'appAssetLibraryPlacements',
  id: idValue,
  attributes: { placementType, mediaType: 'IMAGE', state: 'PARENT_APPROVED' },
});

export const page = (idValue: string, over: Record<string, unknown> = {}, versionIds: string[] | undefined = ['v1']) => ({
  type: 'appCustomProductPages',
  id: idValue,
  attributes: { name: 'Spring campaign', url: `https://apps.apple.com/app/id${APP}?ppid=${idValue}`, visible: true, ...over },
  relationships:
    versionIds === undefined
      ? {}
      : { appCustomProductPageVersions: linkage('appCustomProductPageVersions', versionIds) },
});

export const pageVersion = (idValue: string, state: string, extra: Record<string, unknown> = {}) => ({
  type: 'appCustomProductPageVersions',
  id: idValue,
  attributes: { version: '1', state, deepLink: null, ...extra },
});

const EXPERIMENTS = new RegExp(`^/v1/apps/${APP}/appStoreVersionExperimentsV2\\?`);
const PAGES = new RegExp(`^/v1/apps/${APP}/appCustomProductPages\\?`);

/** A fake with one live test (two treatments, two locales) and two custom pages (one with an old replaced version). */
export function experimentsFake(): fx.FakeFetch {
  return new fx.FakeFetch()
    .on({
      method: 'GET',
      match: EXPERIMENTS,
      json: {
        data: [
          experiment('e1'),
          experiment('e2', { name: 'Mac test', platform: 'MAC_OS', state: 'STOPPED' }, []),
        ],
        included: [
          treatment('t1', 'Blue icon', { appIconName: 'blue' }),
          treatment('t2', 'Screenshots v2', { promotedDate: '2026-10-20T00:00:00Z' }),
        ],
      },
    })
    .on({
      method: 'GET',
      match: /^\/v1\/appStoreVersionExperimentTreatments\/t1\/appStoreVersionExperimentTreatmentLocalizations\?/,
      json: {
        data: [localization('appStoreVersionExperimentTreatmentLocalizations', 'l1', 'en-US', ['p1', 'p2', 'p3'])],
        included: [placement('p1', 'APP_SCREENSHOT'), placement('p2', 'APP_SCREENSHOT'), placement('p3', 'APP_PREVIEW')],
      },
    })
    .on({
      method: 'GET',
      match: /^\/v1\/appStoreVersionExperimentTreatments\/t2\/appStoreVersionExperimentTreatmentLocalizations\?/,
      json: {
        data: [
          localization('appStoreVersionExperimentTreatmentLocalizations', 'l3', 'fr-FR', [], {}, ['s1']),
          localization('appStoreVersionExperimentTreatmentLocalizations', 'l2', 'de-DE', ['p4']),
        ],
        included: [placement('p4', 'PRODUCT_PAGE_HEADER_ASSET')],
      },
    })
    .on({
      method: 'GET',
      match: PAGES,
      json: {
        data: [page('c1', {}, ['v1', 'v0']), page('c2', { name: 'No versions', visible: false }, [])],
        included: [
          pageVersion('v0', 'REPLACED_WITH_NEW_VERSION'),
          pageVersion('v1', 'APPROVED', { deepLink: 'myapp://spring', version: '2' }),
        ],
      },
    })
    .on({
      method: 'GET',
      match: /^\/v1\/appCustomProductPageVersions\/v1\/appCustomProductPageLocalizations\?/,
      json: {
        data: [
          localization('appCustomProductPageLocalizations', 'cl1', 'en-US', ['q1', 'q2'], { promotionalText: 'Spring!' }),
          localization('appCustomProductPageLocalizations', 'cl2', 'fr-FR', ['q3'], { promotionalText: '' }),
        ],
        included: [placement('q1', 'APP_SCREENSHOT'), placement('q2', 'APP_SCREENSHOT'), placement('q3', 'APP_SCREENSHOT')],
      },
    });
}

export { EXPERIMENTS, PAGES };
