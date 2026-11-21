import type { RevenueCatAppType } from '@kiln/core';

/**
 * What this tool keeps of RevenueCat's configuration (docs/adr/0039-revenuecat.md). Configuration facts only: no money amounts, no
 * customer or subscriber data is read or stored. Unknown values of an enum are kept as text (`type`, `rawState`, `eligibility`) so a
 * value RevenueCat adds later still shows, with a neutral badge.
 */

/** RevenueCat's state of a product, entitlement or offering, in our words: `inactive` and `archived` are `archived`. */
export type RevenueCatState = 'active' | 'archived' | 'unknown';

export type RevenueCatProject = { id: string; name: string };

export type RevenueCatApp = {
  id: string;
  name: string;
  /** RevenueCat's app type, verbatim (`app_store`, `mac_app_store`, `play_store`, `stripe`, `rc_billing`, `amazon`, ...). */
  type: string;
  /** The type when it is one this tool reads (see `REVENUECAT_APP_TYPES`); null for every other store, which is ignored ("not mapped"). */
  store: RevenueCatAppType | null;
  /** The bundle id (App Store, Mac App Store) or package name (Play Store) RevenueCat holds; null when it did not say. */
  identifier: string | null;
};

export type RevenueCatProduct = {
  /** RevenueCat's product id. */
  id: string;
  /** The store product id; on Google Play `subscription_id:base_plan_id` (a one-time product: its product id; a legacy subscription: the bare subscription id). */
  storeIdentifier: string;
  /** RevenueCat's type, verbatim (`subscription`, `one_time`, `consumable`, `non_consumable`, `non_renewing_subscription`). */
  type: string;
  state: RevenueCatState;
  rawState: string | null;
  displayName: string | null;
  appId: string | null;
  /** ISO 8601 durations, or null. */
  duration: string | null;
  gracePeriod: string | null;
  trialDuration: string | null;
};

export type RevenueCatEntitlement = {
  id: string;
  lookupKey: string;
  displayName: string | null;
  state: RevenueCatState;
  rawState: string | null;
  /** The RevenueCat product ids of the linked app attached to it. */
  productIds: string[];
  /** Every product attached in the project, of any app. */
  projectProductCount: number;
};

export type RevenueCatPackageProduct = {
  productId: string;
  /** `all`, `google_sdk_lt_6` or `google_sdk_ge_6` as documented; any other value verbatim; `all` when RevenueCat said nothing. */
  eligibility: string;
};

export type RevenueCatPackage = {
  id: string;
  lookupKey: string;
  displayName: string | null;
  position: number | null;
  /** Only the products of the linked app. */
  products: RevenueCatPackageProduct[];
};

export type RevenueCatOffering = {
  id: string;
  lookupKey: string;
  displayName: string | null;
  isCurrent: boolean;
  state: RevenueCatState;
  rawState: string | null;
  /** Only the packages that hold a product of the linked app. */
  packages: RevenueCatPackage[];
};

export type RevenueCatConfiguration = {
  /** The products of the linked app. */
  products: RevenueCatProduct[];
  /** How many products of the project belong to other apps (left out). */
  otherAppProducts: number;
  entitlements: RevenueCatEntitlement[];
  offerings: RevenueCatOffering[];
  /** False when a cap ended the read early: a list may be missing items, so "not found" claims are not made. */
  complete: boolean;
  /** Fixed sentences, never RevenueCat's text. */
  warnings: string[];
  /** Requests the read used. */
  requests: number;
};
