/**
 * Answers shaped like the RevenueCat REST API v2 reference (https://www.revenuecat.com/docs/api-v2), for tests with an injected fetch.
 * Not recorded from a live project: the fields are the ones the reference's samples show.
 */

export const KEY = 'sk_FAKEkey0123456789abcdefghijklmnop';
export const PROJECT_ID = 'proj1ab2c3d4';
export const IOS_APP_ID = 'appios0001';
export const MAC_APP_ID = 'appmac0001';
export const PLAY_APP_ID = 'appplay0001';
export const STRIPE_APP_ID = 'appstripe01';

export const list = (items: unknown[], nextPage?: string) => ({
  object: 'list',
  items,
  ...(nextPage ? { next_page: nextPage } : {}),
  url: '/v2/projects/proj1ab2c3d4/x',
});

export const project = (id = PROJECT_ID, name = 'MagicWeather') => ({
  object: 'project',
  id,
  name,
  created_at: 1658399423658,
});

export const apps = {
  ios: {
    object: 'app',
    id: IOS_APP_ID,
    name: 'Magic iOS',
    type: 'app_store',
    project_id: PROJECT_ID,
    app_store: { bundle_id: 'com.example.magic' },
  },
  mac: {
    object: 'app',
    id: MAC_APP_ID,
    name: 'Magic Mac',
    type: 'mac_app_store',
    project_id: PROJECT_ID,
    mac_app_store: { bundle_id: 'com.example.magic.mac' },
  },
  play: {
    object: 'app',
    id: PLAY_APP_ID,
    name: 'Magic Android',
    type: 'play_store',
    project_id: PROJECT_ID,
    play_store: { package_name: 'com.example.magic' },
  },
  stripe: {
    object: 'app',
    id: STRIPE_APP_ID,
    name: 'Web',
    type: 'stripe',
    project_id: PROJECT_ID,
    stripe: { stripe_account_id: 'acct_1' },
  },
};

export const product = (
  id: string,
  storeIdentifier: string,
  appId: string,
  extra: Record<string, unknown> = {},
) => ({
  object: 'product',
  id,
  store_identifier: storeIdentifier,
  type: 'subscription',
  state: 'active',
  app_id: appId,
  display_name: `Name of ${id}`,
  subscription: { duration: 'P1M', grace_period_duration: 'P3D', trial_duration: 'P1W' },
  created_at: 1658399423658,
  ...extra,
});

export const entitlement = (
  id: string,
  lookupKey: string,
  products: unknown[] | null,
  extra: Record<string, unknown> = {},
) => ({
  object: 'entitlement',
  id,
  project_id: PROJECT_ID,
  lookup_key: lookupKey,
  display_name: `Entitlement ${lookupKey}`,
  state: 'active',
  products: products === null ? null : list(products),
  ...extra,
});

export const packageOf = (
  id: string,
  lookupKey: string,
  position: number,
  products: unknown[] | null,
) => ({
  object: 'package',
  id,
  lookup_key: lookupKey,
  display_name: lookupKey,
  position,
  products:
    products === null
      ? null
      : list(
          products.map((p) =>
            p && typeof p === 'object' && 'product' in p
              ? p
              : { product: p, eligibility_criteria: 'all' },
          ),
        ),
});

export const offering = (
  id: string,
  lookupKey: string,
  packages: unknown[] | null,
  extra: Record<string, unknown> = {},
) => ({
  object: 'offering',
  id,
  project_id: PROJECT_ID,
  lookup_key: lookupKey,
  display_name: lookupKey,
  is_current: lookupKey === 'default',
  state: 'active',
  packages: packages === null ? null : list(packages),
  ...extra,
});

export const errorBody = (
  type: string,
  message = 'Secret detail: sk_FAKEkey0123456789abcdefghijklmnop for proj1ab2c3d4',
) => ({
  type,
  message,
  param: null,
  retryable: false,
  doc_url: 'https://errors.rev.cat/x',
});

export type Answer = {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
};
export type Call = { url: string; path: string; query: URLSearchParams; init: RequestInit };

/** A fetch that answers by a function of the call and remembers every request. */
export function fakeFetch(answer: (call: Call) => Answer | Error) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const call: Call = {
      url: String(input),
      path: url.pathname,
      query: url.searchParams,
      init: init ?? {},
    };
    calls.push(call);
    const next = answer(call);
    if (next instanceof Error) throw next;
    return new Response(next.text ?? JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    });
  };
  return { fetch: fetchFn, calls };
}
