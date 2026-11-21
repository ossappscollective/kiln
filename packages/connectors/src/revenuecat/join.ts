import type {
  RevenueCatEntitlement,
  RevenueCatOffering,
  RevenueCatProduct,
  RevenueCatState,
} from './types.ts';

/**
 * The join of the stored store products to the stored RevenueCat configuration, and the warnings that follow from it
 * (docs/adr/0039-revenuecat.md). Pure: it reads nothing and is computed on every read, never stored, so a new store sync or RevenueCat
 * sync is reflected at once. Matching is by the store product id, exactly:
 *
 * - Apple and Google Play one-time products: the RevenueCat `store_identifier` IS the product id.
 * - Google Play subscriptions: `subscription_id:base_plan_id` (products set up after February 2023), so ONE store product has
 *   SEVERAL RevenueCat products, one per base plan; a bare `subscription_id` (set up before) is one RevenueCat product for the whole
 *   subscription. Both forms are read from RevenueCat's Android products guide; how a given project's products really look is
 *   UNVERIFIED until it runs on a real project.
 * - A case-only difference is never a match: it is its own warning.
 */

/** What the join needs of a stored store product. */
export type JoinStoreProduct = {
  productId: string;
  kind: string;
  referenceName?: string | undefined;
  /** The normalized state of ADR 0034 (`draft`, `in_review`, `action_needed`, `active`, `inactive`, `removed`, `unknown`). */
  state: string;
  /** Google Play base plans (`id`, `state`); empty for Apple. */
  plans: { id: string; state: string }[];
};

export type RevenueCatStatus =
  /** At least one matched RevenueCat product that is not archived. */
  | 'in_revenuecat'
  /** Matched, but every matched RevenueCat product is archived. */
  | 'archived'
  /** No RevenueCat product has this store product id. */
  | 'not_in_revenuecat'
  /** A RevenueCat product has the id with different letter case: not a match. */
  | 'id_not_matched';

export type MatchedProduct = {
  rcProductId: string;
  storeIdentifier: string;
  /** The Google Play base plan the RevenueCat product is for; null for an exact or legacy bare id, and for Apple. */
  planId: string | null;
  /** For a base plan form: whether the store snapshot lists that plan; null when it does not apply. */
  planInStore: boolean | null;
  type: string;
  state: RevenueCatState;
  displayName: string | null;
  duration: string | null;
  gracePeriod: string | null;
  trialDuration: string | null;
};

export type ProductRevenueCat = {
  status: RevenueCatStatus;
  products: MatchedProduct[];
  entitlements: { id: string; lookupKey: string; displayName: string | null; state: RevenueCatState }[];
  offerings: {
    id: string;
    lookupKey: string;
    isCurrent: boolean;
    state: RevenueCatState;
    packages: { id: string; lookupKey: string; rcProductId: string; eligibility: string }[];
  }[];
};

export type RevenueCatWarningCode =
  | 'store_product_not_in_revenuecat'
  | 'revenuecat_product_not_in_store'
  | 'revenuecat_product_case_differs'
  | 'product_not_sellable'
  | 'entitlement_without_active_product'
  | 'store_removed_but_active_in_revenuecat'
  | 'play_base_plan_not_in_revenuecat'
  | 'revenuecat_read_incomplete';

export type RevenueCatWarning = {
  code: RevenueCatWarningCode;
  severity: 'info' | 'warn' | 'bad';
  /** One sentence with the fix, for a person. */
  message: string;
  storeProductId: string | null;
  rcProductId: string | null;
  entitlementId: string | null;
};

export type JoinInput = {
  storeProducts: readonly JoinStoreProduct[];
  /** False when the store read stopped at a cap (or never ran): "not found in the store" is then not claimed. */
  storeComplete: boolean;
  /** Whether the store snapshot exists at all. Without it nothing can be said about the store side. */
  storeSynced: boolean;
  rcProducts: readonly RevenueCatProduct[];
  entitlements: readonly RevenueCatEntitlement[];
  offerings: readonly RevenueCatOffering[];
  /** False when the RevenueCat read stopped at a cap: "not in RevenueCat" is then not claimed. */
  rcComplete: boolean;
};

export type JoinResult = {
  /** By store product id. */
  byProduct: Map<string, ProductRevenueCat>;
  /** RevenueCat products that match no store product (archived ones too: the view says so). */
  unmatched: MatchedProduct[];
  warnings: RevenueCatWarning[];
};

const asMatched = (p: RevenueCatProduct, planId: string | null, planInStore: boolean | null): MatchedProduct => ({
  rcProductId: p.id,
  storeIdentifier: p.storeIdentifier,
  planId,
  planInStore,
  type: p.type,
  state: p.state,
  displayName: p.displayName,
  duration: p.duration,
  gracePeriod: p.gracePeriod,
  trialDuration: p.trialDuration,
});

/** One entry per offering, with the packages of every matched product (a Play subscription has several RevenueCat products). */
function mergeOfferings(list: ProductRevenueCat['offerings']): ProductRevenueCat['offerings'] {
  const merged: ProductRevenueCat['offerings'] = [];
  for (const o of list) {
    const have = merged.find((m) => m.id === o.id);
    if (!have) {
      merged.push({ ...o, packages: [...o.packages] });
      continue;
    }
    for (const p of o.packages) {
      if (!have.packages.some((x) => x.id === p.id && x.rcProductId === p.rcProductId)) have.packages.push(p);
    }
  }
  return merged;
}

const SOLD_STATES = new Set(['active', 'in_review']);
const GONE_STATES = new Set(['removed', 'inactive']);

export function joinRevenueCat(input: JoinInput): JoinResult {
  const byId = new Map(input.storeProducts.map((p) => [p.productId, p]));
  const lower = new Map<string, string>();
  for (const p of input.storeProducts) lower.set(p.productId.toLowerCase(), p.productId);
  const matches = new Map<string, MatchedProduct[]>();
  const caseOnly = new Map<string, MatchedProduct[]>();
  const unmatched: MatchedProduct[] = [];

  for (const rc of input.rcProducts) {
    const id = rc.storeIdentifier;
    const colon = id.indexOf(':');
    const head = colon > 0 ? id.slice(0, colon) : id;
    const tail = colon > 0 ? id.slice(colon + 1) : null;
    let store = byId.get(id);
    let planId: string | null = null;
    if (store) {
      // The whole identifier is the product id: Apple, a Play one-time product, a legacy Play subscription.
    } else if (tail !== null && tail !== '' && byId.has(head)) {
      // `subscription_id:base_plan_id`.
      store = byId.get(head);
      planId = tail;
    }
    if (store) {
      const planInStore = planId === null ? null : store.plans.some((plan) => plan.id === planId);
      const list = matches.get(store.productId) ?? [];
      list.push(asMatched(rc, planId, planInStore));
      matches.set(store.productId, list);
      continue;
    }
    const near = lower.get(head.toLowerCase());
    if (near !== undefined) {
      const list = caseOnly.get(near) ?? [];
      list.push(asMatched(rc, tail, null));
      caseOnly.set(near, list);
    }
    unmatched.push(asMatched(rc, null, null));
  }

  // Inversions: product -> entitlements, product -> offerings and packages.
  const entitlementsOf = new Map<string, ProductRevenueCat['entitlements']>();
  for (const e of input.entitlements) {
    for (const productId of e.productIds) {
      const list = entitlementsOf.get(productId) ?? [];
      list.push({ id: e.id, lookupKey: e.lookupKey, displayName: e.displayName, state: e.state });
      entitlementsOf.set(productId, list);
    }
  }
  const offeringsOf = new Map<string, Map<string, ProductRevenueCat['offerings'][number]>>();
  for (const offering of input.offerings) {
    for (const pkg of offering.packages) {
      for (const item of pkg.products) {
        const perProduct = offeringsOf.get(item.productId) ?? new Map();
        const entry =
          perProduct.get(offering.id) ??
          ({
            id: offering.id,
            lookupKey: offering.lookupKey,
            isCurrent: offering.isCurrent,
            state: offering.state,
            packages: [],
          } satisfies ProductRevenueCat['offerings'][number]);
        entry.packages.push({ id: pkg.id, lookupKey: pkg.lookupKey, rcProductId: item.productId, eligibility: item.eligibility });
        perProduct.set(offering.id, entry);
        offeringsOf.set(item.productId, perProduct);
      }
    }
  }
  const unique = <T extends { id: string }>(items: T[]): T[] => [...new Map(items.map((i) => [i.id, i])).values()];

  const byProduct = new Map<string, ProductRevenueCat>();
  for (const store of input.storeProducts) {
    const matched = matches.get(store.productId) ?? [];
    const status: RevenueCatStatus =
      matched.length === 0
        ? caseOnly.has(store.productId)
          ? 'id_not_matched'
          : 'not_in_revenuecat'
        : matched.some((m) => m.state !== 'archived')
          ? 'in_revenuecat'
          : 'archived';
    byProduct.set(store.productId, {
      status,
      products: matched,
      entitlements: unique(matched.flatMap((m) => entitlementsOf.get(m.rcProductId) ?? [])),
      offerings: mergeOfferings(matched.flatMap((m) => [...(offeringsOf.get(m.rcProductId)?.values() ?? [])])),
    });
  }

  // ---- Warnings --------------------------------------------------------------------------------
  const warnings: RevenueCatWarning[] = [];
  const warn = (w: Omit<RevenueCatWarning, 'storeProductId' | 'rcProductId' | 'entitlementId'> & Partial<RevenueCatWarning>) =>
    warnings.push({ storeProductId: null, rcProductId: null, entitlementId: null, ...w });

  const rcById = new Map(input.rcProducts.map((p) => [p.id, p]));
  const matchedStoreOf = new Map<string, JoinStoreProduct>();
  for (const [storeId, list] of matches) {
    const store = byId.get(storeId);
    if (store) for (const m of list) matchedStoreOf.set(m.rcProductId, store);
  }
  const sellableOffering = (state: RevenueCatState) => state !== 'archived';
  const inActiveOffering = new Set<string>();
  for (const o of input.offerings) {
    if (!sellableOffering(o.state)) continue;
    for (const pkg of o.packages) for (const item of pkg.products) inActiveOffering.add(item.productId);
  }

  if (input.storeSynced && input.rcComplete) {
    for (const store of input.storeProducts) {
      const view = byProduct.get(store.productId);
      if (!view) continue;
      if (view.status === 'not_in_revenuecat' && SOLD_STATES.has(store.state)) {
        warn({
          code: 'store_product_not_in_revenuecat',
          severity: 'warn',
          message: `${store.productId} is in the store but not in RevenueCat. Add it in RevenueCat under Products with this store product id, or ignore this if it is not sold through RevenueCat.`,
          storeProductId: store.productId,
        });
      }
      if (view.status === 'id_not_matched') {
        const near = caseOnly.get(store.productId)?.[0];
        warn({
          code: 'revenuecat_product_case_differs',
          severity: 'warn',
          message: `RevenueCat has ${near?.storeIdentifier ?? 'a product'} and the store has ${store.productId}: only the letter case differs, so they are not the same product. Fix the identifier in RevenueCat.`,
          storeProductId: store.productId,
          rcProductId: near?.rcProductId ?? null,
        });
      }
      // A Play subscription whose base plan has no RevenueCat product (only when RevenueCat uses the base plan form).
      if (view.status !== 'not_in_revenuecat' && view.products.some((m) => m.planId !== null) && !view.products.some((m) => m.planId === null)) {
        const have = new Set(view.products.map((m) => m.planId));
        for (const plan of store.plans) {
          if (plan.state.toUpperCase() === 'ACTIVE' && !have.has(plan.id)) {
            warn({
              code: 'play_base_plan_not_in_revenuecat',
              severity: 'info',
              message: `The base plan ${plan.id} of ${store.productId} is active in Google Play but has no product in RevenueCat. Add ${store.productId}:${plan.id} in RevenueCat if you sell it.`,
              storeProductId: store.productId,
            });
          }
        }
      }
    }
  }

  if (input.storeSynced && input.storeComplete) {
    for (const rc of unmatched) {
      if (rc.state !== 'active') continue;
      const id = rc.storeIdentifier;
      const head = id.includes(':') ? id.slice(0, id.indexOf(':')) : id;
      if (lower.has(head.toLowerCase())) continue; // reported as a case difference
      warn({
        code: 'revenuecat_product_not_in_store',
        severity: 'warn',
        message: `RevenueCat has the product ${id} but the store has none with that id. Check the identifier in RevenueCat, or archive the product there.`,
        rcProductId: rc.rcProductId,
      });
    }
  }

  for (const store of input.storeProducts) {
    const view = byProduct.get(store.productId);
    if (!view) continue;
    for (const m of view.products) {
      if (m.state !== 'active') continue;
      const sold = inActiveOffering.has(m.rcProductId);
      if (GONE_STATES.has(store.state) && sold) {
        warn({
          code: 'store_removed_but_active_in_revenuecat',
          severity: 'bad',
          message: `${store.productId} is ${store.state} in the store but RevenueCat still offers it. Remove it from the offering in RevenueCat, or put the product back on sale in the store.`,
          storeProductId: store.productId,
          rcProductId: m.rcProductId,
        });
      } else if (input.rcComplete && !sold && !GONE_STATES.has(store.state)) {
        warn({
          code: 'product_not_sellable',
          severity: 'info',
          message: `${m.storeIdentifier} is in RevenueCat but in no package of an active offering, so the app cannot sell it through RevenueCat. Add it to a package, or archive it.`,
          storeProductId: store.productId,
          rcProductId: m.rcProductId,
        });
      }
    }
  }
  // RevenueCat products with no store match that are in no offering are reported once, as "not in the store" above.

  if (input.rcComplete) {
    for (const e of input.entitlements) {
      if (e.state === 'archived') continue;
      const usable = e.productIds.some((pid) => {
        const rc = rcById.get(pid);
        if (!rc || rc.state !== 'active') return false;
        const store = matchedStoreOf.get(pid);
        return !(store && GONE_STATES.has(store.state));
      });
      if (!usable) {
        warn({
          code: 'entitlement_without_active_product',
          severity: 'warn',
          message:
            e.projectProductCount === 0
              ? `The entitlement ${e.lookupKey} has no product in RevenueCat, so nothing unlocks it. Attach a product to it, or archive it.`
              : `The entitlement ${e.lookupKey} has no active product of this app. Attach an active product to it, or archive it.`,
          entitlementId: e.id,
        });
      }
    }
  } else {
    warn({
      code: 'revenuecat_read_incomplete',
      severity: 'info',
      message:
        'The last RevenueCat read did not finish, so some warnings about missing products and entitlements are not shown. Sync again in a minute.',
    });
  }
  return { byProduct, unmatched, warnings };
}
