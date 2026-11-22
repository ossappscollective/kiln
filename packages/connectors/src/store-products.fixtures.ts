import * as fx from './store.fixtures.ts';

/**
 * Hand-written fixtures for the in-app purchase and subscription connectors. They follow the object and parameter names on Apple's and
 * Google's reference pages (see apple/appstore-products.ts and google/play-products.ts) and are NOT recordings of live traffic: the
 * attribute lists of some Apple objects are not on the pages, so those shapes are the ones the connector expects.
 */

export const APPLE_APP = '10746822401';
export const PACKAGE = 'com.example.coffee';
export const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);

// ---------------------------------------------------------------------------------------------
// Apple

const link = (id: string, type: string) => ({ type, id });
const rel = (type: string, ids: string[]) => ({
  [type]: { data: ids.map((id) => link(id, type)) },
});

export const appleIapLocalization = (
  id: string,
  locale: string,
  name: string,
  description: string,
) => ({
  type: 'inAppPurchaseLocalizations',
  id,
  attributes: { locale, name, description, state: 'APPROVED' },
});

export const appleSubLocalization = (
  id: string,
  locale: string,
  name: string,
  description: string,
) => ({
  type: 'subscriptionLocalizations',
  id,
  attributes: { locale, name, description, state: 'APPROVED' },
});

export const appleIap = (
  id: string,
  productId: string,
  type: string,
  state: string,
  localizationIds: string[],
  name = productId,
) => ({
  type: 'inAppPurchases',
  id,
  attributes: { name, productId, inAppPurchaseType: type, state, familySharable: false },
  relationships: rel('inAppPurchaseLocalizations', localizationIds),
});

export const IAPS_PATH = `/v1/apps/${APPLE_APP}/inAppPurchasesV2`;
export const GROUPS_PATH = `/v1/apps/${APPLE_APP}/subscriptionGroups`;

export const appleIapList = (extra: { links?: unknown } = {}) => ({
  data: [
    appleIap('iap-1', 'coins_100', 'CONSUMABLE', 'APPROVED', ['loc-1', 'loc-2'], '100 coins'),
    appleIap('iap-2', 'pro_unlock', 'NON_CONSUMABLE', 'READY_TO_SUBMIT', ['loc-3'], 'Pro'),
    appleIap('iap-3', 'mystery', 'SOMETHING_NEW', 'APPROVED', []),
  ],
  included: [
    appleIapLocalization('loc-1', 'en-US', '100 coins', 'A small bag of coins'),
    appleIapLocalization('loc-2', 'de-DE', '100 Münzen', 'Ein kleiner Beutel Münzen'),
    appleIapLocalization('loc-3', 'en-US', 'Pro', 'Unlock everything'),
  ],
  ...extra,
});

export const appleSchedule = (id = 'ps-1', baseTerritory = 'USA') => ({
  data: {
    type: 'inAppPurchasePriceSchedules',
    id,
    relationships: { baseTerritory: { data: link(baseTerritory, 'territories') } },
  },
  included: [{ type: 'territories', id: baseTerritory, attributes: { currency: 'USD' } }],
});

const applePrice = (
  id: string,
  territory: string,
  point: string,
  extra: Record<string, unknown> = {},
) => ({
  type: 'inAppPurchasePrices',
  id,
  attributes: { startDate: null, endDate: null, manual: true, ...extra },
  relationships: {
    territory: { data: link(territory, 'territories') },
    inAppPurchasePricePoint: { data: link(point, 'inAppPurchasePricePoints') },
  },
});
const point = (id: string, customerPrice: string) => ({
  type: 'inAppPurchasePricePoints',
  id,
  attributes: { customerPrice, proceeds: '0.70' },
});
const territory = (id: string, currency: string) => ({
  type: 'territories',
  id,
  attributes: { currency },
});

export const appleManualPrices = {
  data: [applePrice('pr-usa', 'USA', 'pp-usa')],
  included: [point('pp-usa', '0.99'), territory('USA', 'USD')],
};

export const appleAutomaticPrices = {
  data: [
    applePrice('pr-deu', 'DEU', 'pp-deu', { manual: false }),
    applePrice('pr-deu-next', 'DEU', 'pp-deu-next', { manual: false, startDate: '2027-03-01' }),
    applePrice('pr-jpn', 'JPN', 'pp-jpn', { manual: false, startDate: '2025-06-01' }),
  ],
  included: [
    point('pp-deu', '1.09'),
    point('pp-deu-next', '1.19'),
    point('pp-jpn', '150'),
    territory('DEU', 'EUR'),
    territory('JPN', 'JPY'),
  ],
};

export const appleIapAvailability = {
  data: {
    type: 'inAppPurchaseAvailabilities',
    id: 'av-1',
    attributes: { availableInNewTerritories: true },
  },
};
export const appleTerritories = (ids: string[]) => ({
  data: ids.map((id) => territory(id, 'USD')),
});

export const appleGroups = {
  data: [{ type: 'subscriptionGroups', id: 'g-1', attributes: { referenceName: 'Premium' } }],
};

export const appleSubscriptions = {
  data: [
    {
      type: 'subscriptions',
      id: 's-1',
      attributes: {
        name: 'Premium monthly',
        productId: 'premium_monthly',
        state: 'APPROVED',
        subscriptionPeriod: 'ONE_MONTH',
      },
      relationships: {
        ...rel('subscriptionLocalizations', ['sl-1', 'sl-2']),
        ...rel('planAvailabilities', ['pa-1']),
      },
    },
  ],
  included: [
    appleSubLocalization('sl-1', 'en-US', 'Premium', 'Everything, monthly'),
    appleSubLocalization('sl-2', 'fr-FR', 'Premium', 'Tout, au mois'),
    {
      type: 'subscriptionPlanAvailabilities',
      id: 'pa-1',
      attributes: { availableInNewTerritories: false, planType: 'UPFRONT' },
    },
  ],
};

export const appleSubPrices = {
  data: [
    {
      type: 'subscriptionPrices',
      id: 'sp-usa',
      attributes: { startDate: '2025-01-01', preserved: false, planType: 'MONTHLY' },
      relationships: {
        territory: { data: link('USA', 'territories') },
        subscriptionPricePoint: { data: link('spp-usa', 'subscriptionPricePoints') },
      },
    },
    {
      type: 'subscriptionPrices',
      id: 'sp-usa-old',
      attributes: { startDate: '2023-01-01', preserved: true, planType: 'MONTHLY' },
      relationships: {
        territory: { data: link('USA', 'territories') },
        subscriptionPricePoint: { data: link('spp-usa-old', 'subscriptionPricePoints') },
      },
    },
  ],
  included: [
    { type: 'subscriptionPricePoints', id: 'spp-usa', attributes: { customerPrice: '4.99' } },
    { type: 'subscriptionPricePoints', id: 'spp-usa-old', attributes: { customerPrice: '2.99' } },
    territory('USA', 'USD'),
  ],
};

/** Every route the Apple read connector uses, with the happy answers above. */
export function appleProductsFake(): fx.FakeFetch {
  const fake = new fx.FakeFetch();
  fake
    .on({ method: 'GET', match: new RegExp(`^${IAPS_PATH}\\?`), json: appleIapList() })
    .on({
      method: 'GET',
      match: /^\/v2\/inAppPurchases\/iap-1\/iapPriceSchedule\?/,
      json: appleSchedule(),
    })
    .on({
      method: 'GET',
      match: /^\/v2\/inAppPurchases\/iap-2\/iapPriceSchedule\?/,
      status: 404,
      json: { errors: [{ status: '404', code: 'NOT_FOUND' }] },
    })
    .on({
      method: 'GET',
      match: /^\/v1\/inAppPurchasePriceSchedules\/ps-1\/manualPrices\?/,
      json: appleManualPrices,
    })
    .on({
      method: 'GET',
      match: /^\/v1\/inAppPurchasePriceSchedules\/ps-1\/automaticPrices\?/,
      json: appleAutomaticPrices,
    })
    .on({
      method: 'GET',
      match: /^\/v2\/inAppPurchases\/iap-1\/inAppPurchaseAvailability\?/,
      json: appleIapAvailability,
    })
    .on({
      method: 'GET',
      match: /^\/v2\/inAppPurchases\/iap-2\/inAppPurchaseAvailability\?/,
      status: 404,
      json: { errors: [] },
    })
    .on({
      method: 'GET',
      match: /^\/v1\/inAppPurchaseAvailabilities\/av-1\/availableTerritories\?/,
      json: appleTerritories(['USA', 'DEU', 'JPN']),
    })
    .on({ method: 'GET', match: new RegExp(`^${GROUPS_PATH}\\?`), json: appleGroups })
    .on({
      method: 'GET',
      match: /^\/v1\/subscriptionGroups\/g-1\/subscriptions\?/,
      json: appleSubscriptions,
    })
    .on({ method: 'GET', match: /^\/v1\/subscriptions\/s-1\/prices\?/, json: appleSubPrices })
    .on({
      method: 'GET',
      match: /^\/v1\/subscriptionPlanAvailabilities\/pa-1\/availableTerritories\?/,
      json: appleTerritories(['USA', 'FRA']),
    });
  return fake;
}

// ---------------------------------------------------------------------------------------------
// Google Play

export const money = (currencyCode: string, units: string, nanos = 0) => ({
  currencyCode,
  units,
  nanos,
});

export const playSubscription = {
  packageName: PACKAGE,
  productId: 'premium_monthly',
  listings: [
    {
      languageCode: 'en-US',
      title: 'Premium',
      description: 'Everything, monthly',
      benefits: ['No ads', 'Cloud sync'],
    },
    { languageCode: 'de-DE', title: 'Premium', description: 'Alles, monatlich', benefits: [] },
  ],
  basePlans: [
    {
      basePlanId: 'monthly',
      state: 'ACTIVE',
      autoRenewingBasePlanType: { billingPeriodDuration: 'P1M' },
      regionalConfigs: [
        {
          regionCode: 'US',
          newSubscriberAvailability: true,
          price: money('USD', '4', 990_000_000),
        },
        {
          regionCode: 'DE',
          newSubscriberAvailability: true,
          price: money('EUR', '4', 990_000_000),
        },
        { regionCode: 'JP', newSubscriberAvailability: false, price: money('JPY', '600') },
      ],
      otherRegionsConfig: {
        usdPrice: money('USD', '4', 990_000_000),
        eurPrice: money('EUR', '4', 990_000_000),
        newSubscriberAvailability: true,
      },
    },
    {
      basePlanId: 'old-yearly',
      state: 'INACTIVE',
      autoRenewingBasePlanType: { billingPeriodDuration: 'P1Y' },
      regionalConfigs: [
        {
          regionCode: 'US',
          newSubscriberAvailability: false,
          price: money('USD', '39', 990_000_000),
        },
      ],
    },
  ],
};

export const playOneTime = {
  packageName: PACKAGE,
  productId: 'coins_100',
  listings: [{ languageCode: 'en-US', title: '100 coins', description: 'A small bag of coins' }],
  purchaseOptions: [
    {
      purchaseOptionId: 'buy',
      state: 'ACTIVE',
      buyOption: { multiQuantityEnabled: true },
      regionalPricingAndAvailabilityConfigs: [
        { regionCode: 'US', availability: 'AVAILABLE', price: money('USD', '0', 990_000_000) },
        {
          regionCode: 'FR',
          availability: 'NO_LONGER_AVAILABLE',
          price: money('EUR', '0', 990_000_000),
        },
      ],
      newRegionsConfig: {
        usdPrice: money('USD', '0', 990_000_000),
        eurPrice: money('EUR', '0', 990_000_000),
        availability: 'AVAILABLE',
      },
    },
  ],
  regionsVersion: { version: '2022/02' },
};

export const playOneTimeSecond = {
  packageName: PACKAGE,
  productId: 'remove_ads',
  listings: [{ languageCode: 'en-US', title: 'Remove ads', description: 'No more ads' }],
  purchaseOptions: [
    {
      purchaseOptionId: 'buy',
      state: 'DRAFT',
      buyOption: {},
      regionalPricingAndAvailabilityConfigs: [],
    },
  ],
  regionsVersion: { version: '2022/02' },
};

export const playOffers = {
  subscriptionOffers: [
    {
      packageName: PACKAGE,
      productId: 'premium_monthly',
      basePlanId: 'monthly',
      offerId: 'trial',
      state: 'ACTIVE',
    },
  ],
};

export const SUBS = `/androidpublisher/v3/applications/${PACKAGE}/subscriptions`;
export const ONE_TIME = `/androidpublisher/v3/applications/${PACKAGE}/oneTimeProducts`;
export const OFFERS = `${SUBS}/-/basePlans/-/offers`;

/** Every route the Google read connector uses. */
export function playProductsFake(): fx.FakeFetch {
  const fake = new fx.FakeFetch();
  fake
    .on({ method: 'POST', match: '/token', json: fx.googleToken })
    .on({
      method: 'GET',
      match: `${SUBS}?pageSize=100`,
      json: { subscriptions: [playSubscription] },
    })
    .on({
      method: 'GET',
      match: `${ONE_TIME}?pageSize=100`,
      json: { oneTimeProducts: [playOneTime, playOneTimeSecond] },
    })
    .on({ method: 'GET', match: `${OFFERS}?pageSize=100`, json: playOffers });
  return fake;
}
