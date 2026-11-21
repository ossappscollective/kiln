import { REVENUECAT_APP_TYPES, type RevenueCatAppType } from '@mrm/core';
import type { RevenueCatClient } from './client.ts';
import { RevenueCatError } from './errors.ts';
import type {
  RevenueCatApp,
  RevenueCatConfiguration,
  RevenueCatEntitlement,
  RevenueCatOffering,
  RevenueCatPackage,
  RevenueCatPackageProduct,
  RevenueCatProduct,
  RevenueCatProject,
  RevenueCatState,
} from './types.ts';

/**
 * Reads of the RevenueCat project configuration (docs/adr/0039-revenuecat.md). Every function is a GET through the client: nothing is
 * written. Which endpoint and field is confirmed against RevenueCat's API v2 reference and which is not is in docs/api/revenuecat.md.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;
/** A name or key kept short: it comes from outside and is shown in a table. */
const short = (value: unknown, max = 200): string | null => {
  const v = text(value);
  return v === null ? null : v.slice(0, max);
};

/** `/projects/{id}`, with the id percent-encoded: an id from outside never changes the path. */
const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

const isAppType = (value: string): value is RevenueCatAppType =>
  (REVENUECAT_APP_TYPES as readonly string[]).includes(value);

export function revenueCatStateOf(raw: unknown): RevenueCatState {
  if (raw === 'active') return 'active';
  if (raw === 'inactive' || raw === 'archived') return 'archived';
  return 'unknown';
}

// ---------------------------------------------------------------------------------------------
// Projects and apps

export async function listRevenueCatProjects(
  client: RevenueCatClient,
): Promise<{ projects: RevenueCatProject[]; complete: boolean }> {
  const { items, complete } = await client.list('/projects', {}, { maxPages: 5 });
  const projects: RevenueCatProject[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const id = text(item.id);
    if (id) projects.push({ id, name: short(item.name) ?? id });
  }
  return { projects, complete };
}

/** The identifier of a mapped store app: `app_store.bundle_id`, `mac_app_store.bundle_id` or `play_store.package_name`. */
function identifierOf(app: Record<string, unknown>, type: RevenueCatAppType): string | null {
  const nested = app[type];
  if (!isRecord(nested)) return null;
  return short(type === 'play_store' ? nested.package_name : nested.bundle_id, 256);
}

function parseApp(item: unknown): RevenueCatApp | undefined {
  if (!isRecord(item)) return undefined;
  const id = text(item.id);
  const type = text(item.type);
  if (!id || !type) return undefined;
  const store = isAppType(type) ? type : null;
  return {
    id,
    name: short(item.name) ?? id,
    type,
    store,
    identifier: store ? identifierOf(item, store) : null,
  };
}

/**
 * The apps of a project. An app of a store this tool does not read (Stripe, Web Billing, Amazon, Roku, Paddle, Test Store, ...) is
 * listed with `store: null` so a person can be told it is not mapped; it is never an error. When the list leaves out the bundle id
 * or package name of a mapped app (UNVERIFIED whether it carries them), the app is read on its own for it.
 */
export async function listRevenueCatApps(
  client: RevenueCatClient,
  projectId: string,
): Promise<{ apps: RevenueCatApp[]; complete: boolean }> {
  const { items, complete } = await client.list(`${projectPath(projectId)}/apps`, {}, { maxPages: 5 });
  const apps: RevenueCatApp[] = [];
  for (const item of items) {
    const app = parseApp(item);
    if (app) apps.push(app);
  }
  let extra = 0;
  for (const app of apps) {
    if (app.store === null || app.identifier !== null || extra >= 10 || !client.canRequest()) continue;
    extra += 1;
    try {
      const one = parseApp(await client.get(`${projectPath(projectId)}/apps/${encodeURIComponent(app.id)}`));
      if (one?.identifier) app.identifier = one.identifier;
    } catch (error) {
      // The key may read the list and not one app, or the app is gone: the app stays listed without an identifier.
      if (!(error instanceof RevenueCatError) || error.kind === 'auth' || error.kind === 'rate_limited') throw error;
    }
  }
  return { apps, complete };
}

/** One app of a project, or undefined when RevenueCat does not have it (so a link to an app that was deleted can be told). */
export async function getRevenueCatApp(
  client: RevenueCatClient,
  projectId: string,
  appId: string,
): Promise<RevenueCatApp | undefined> {
  try {
    return parseApp(await client.get(`${projectPath(projectId)}/apps/${encodeURIComponent(appId)}`));
  } catch (error) {
    if (error instanceof RevenueCatError && error.kind === 'not_found') return undefined;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Configuration

export function parseProduct(item: unknown): RevenueCatProduct | undefined {
  if (!isRecord(item)) return undefined;
  const id = text(item.id);
  const storeIdentifier = text(item.store_identifier);
  if (!id || !storeIdentifier) return undefined;
  const subscription = isRecord(item.subscription) ? item.subscription : {};
  const rawState = text(item.state);
  return {
    id,
    storeIdentifier: storeIdentifier.slice(0, 256),
    type: short(item.type, 60) ?? 'unknown',
    state: revenueCatStateOf(item.state),
    rawState: rawState === null ? null : rawState.slice(0, 60),
    displayName: short(item.display_name),
    appId: text(item.app_id),
    duration: short(subscription.duration, 40),
    gracePeriod: short(subscription.grace_period_duration, 40),
    trialDuration: short(subscription.trial_duration, 40),
  };
}

type Ref = { productId: string; eligibility: string };

/** The product a list item names: a product object itself, `{ product: {...} }` (a package's), or an id. UNVERIFIED which shape each endpoint sends. */
function refOf(item: unknown): Ref | undefined {
  if (typeof item === 'string' && item) return { productId: item, eligibility: 'all' };
  if (!isRecord(item)) return undefined;
  const eligibility = short(item.eligibility_criteria, 40) ?? 'all';
  if (isRecord(item.product)) {
    const id = text(item.product.id);
    return id ? { productId: id, eligibility } : undefined;
  }
  if (typeof item.product === 'string' && item.product) return { productId: item.product, eligibility };
  if (typeof item.product_id === 'string' && item.product_id) return { productId: item.product_id, eligibility };
  if (item.object === 'product' || typeof item.store_identifier === 'string') {
    const id = text(item.id);
    return id ? { productId: id, eligibility } : undefined;
  }
  return undefined;
}

/** A nested list object (`{ items, next_page }`): its refs, whether it is there at all, and whether more pages exist. */
function nestedRefs(value: unknown): { refs: Ref[]; present: boolean; more: boolean; unreadable: number } {
  if (!isRecord(value) || !Array.isArray(value.items)) return { refs: [], present: false, more: false, unreadable: 0 };
  const refs: Ref[] = [];
  let unreadable = 0;
  for (const item of value.items) {
    const ref = refOf(item);
    if (ref) refs.push(ref);
    else unreadable += 1;
  }
  return { refs, present: true, more: typeof value.next_page === 'string' && value.next_page !== '', unreadable };
}

type Reader = {
  client: RevenueCatClient;
  projectId: string;
  complete: boolean;
  skipped: boolean;
  unreadable: number;
};

/** All refs of a nested list, following the separate endpoint when the nested list was not sent in full. */
async function refsWithFallback(
  reader: Reader,
  nested: unknown,
  fallbackPath: string,
  query?: Record<string, string>,
  reserve = 0,
): Promise<Ref[]> {
  const first = nestedRefs(nested);
  reader.unreadable += first.unreadable;
  if (first.present && !first.more) return first.refs;
  if (!reader.client.canRequest(reserve)) {
    reader.skipped = true;
    reader.complete = false;
    return first.refs;
  }
  const got = await reader.client.list(`${projectPath(reader.projectId)}${fallbackPath}`, query, { reserve });
  if (!got.complete) reader.complete = false;
  const refs: Ref[] = [];
  for (const item of got.items) {
    const ref = refOf(item);
    if (ref) refs.push(ref);
    else reader.unreadable += 1;
  }
  return refs;
}

function parsePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The configuration of one RevenueCat project as it concerns one app: the products of the app, the entitlements that hold them (or
 * hold nothing), and the offerings with the packages that hold them. Reads, in order: products; entitlements with `expand=items.product`;
 * offerings with `expand=items.package.product`. A nested list that RevenueCat did not send in full is read from its own endpoint
 * while the request budget holds; past it the read is `complete: false` with a sentence. Never throws for a cap, only for a
 * RevenueCat refusal (`RevenueCatError`).
 */
export async function readRevenueCatConfiguration(
  client: RevenueCatClient,
  input: { projectId: string; appId: string },
): Promise<RevenueCatConfiguration> {
  const warnings: string[] = [];
  const reader: Reader = { client, projectId: input.projectId, complete: true, skipped: false, unreadable: 0 };
  const base = projectPath(input.projectId);

  // 1. Products of the whole project, kept for the linked app. (`GET /products` is documented with an `app_id` query whose
  //    description reads like a copy of the entitlement one, UNVERIFIED, so the filter is done here.)
  // `reserve`: the reads still ahead (entitlements, offerings) are never starved by a long list of products.
  const rawProducts = await client.list(`${base}/products`, {}, { reserve: 2 });
  if (!rawProducts.complete) {
    reader.complete = false;
    warnings.push('RevenueCat has more products than one read takes in, so the list of products may be missing some.');
  }
  const products: RevenueCatProduct[] = [];
  let otherAppProducts = 0;
  let unreadableProducts = 0;
  for (const item of rawProducts.items) {
    const product = parseProduct(item);
    if (!product) {
      unreadableProducts += 1;
      continue;
    }
    if (product.appId === input.appId) products.push(product);
    else otherAppProducts += 1;
  }
  if (unreadableProducts > 0) {
    warnings.push(`${unreadableProducts} RevenueCat product${unreadableProducts === 1 ? '' : 's'} could not be read and ${unreadableProducts === 1 ? 'was' : 'were'} left out.`);
  }
  const ids = new Set(products.map((p) => p.id));

  // 2. Entitlements.
  const rawEntitlements = await client.list(`${base}/entitlements`, { expand: 'items.product' }, { reserve: 1 });
  if (!rawEntitlements.complete) {
    reader.complete = false;
    warnings.push('RevenueCat has more entitlements than one read takes in, so the list of entitlements may be missing some.');
  }
  const entitlements: RevenueCatEntitlement[] = [];
  for (const item of rawEntitlements.items) {
    if (!isRecord(item)) continue;
    const id = text(item.id);
    const lookupKey = short(item.lookup_key);
    if (!id || !lookupKey) continue;
    // One read is still ahead (the offerings): the fallback leaves it its request.
    const refs = await refsWithFallback(reader, item.products, `/entitlements/${encodeURIComponent(id)}/products`, undefined, 1);
    const projectProductCount = new Set(refs.map((r) => r.productId)).size;
    const mine = [...new Set(refs.map((r) => r.productId).filter((p) => ids.has(p)))];
    // An entitlement that holds only products of other apps is not this app's; one that holds nothing at all is kept (it is a finding).
    if (mine.length === 0 && projectProductCount > 0) continue;
    entitlements.push({
      id,
      lookupKey,
      displayName: short(item.display_name),
      state: revenueCatStateOf(item.state),
      rawState: short(item.state, 60),
      productIds: mine,
      projectProductCount,
    });
  }

  // 3. Offerings, their packages, and the products of each package.
  const rawOfferings = await client.list(`${base}/offerings`, { expand: 'items.package.product' });
  if (!rawOfferings.complete) {
    reader.complete = false;
    warnings.push('RevenueCat has more offerings than one read takes in, so the list of offerings may be missing some.');
  }
  const offerings: RevenueCatOffering[] = [];
  for (const item of rawOfferings.items) {
    if (!isRecord(item)) continue;
    const id = text(item.id);
    const lookupKey = short(item.lookup_key);
    if (!id || !lookupKey) continue;
    let packageItems: unknown[];
    if (isRecord(item.packages) && Array.isArray(item.packages.items) && !text(item.packages.next_page)) {
      packageItems = item.packages.items;
    } else if (client.canRequest()) {
      const got = await client.list(`${base}/offerings/${encodeURIComponent(id)}/packages`, { expand: 'items.product' });
      if (!got.complete) reader.complete = false;
      packageItems = got.items;
    } else {
      reader.skipped = true;
      reader.complete = false;
      packageItems = isRecord(item.packages) && Array.isArray(item.packages.items) ? item.packages.items : [];
    }
    const packages: RevenueCatPackage[] = [];
    for (const pkg of packageItems) {
      if (!isRecord(pkg)) continue;
      const packageId = text(pkg.id);
      const packageKey = short(pkg.lookup_key);
      if (!packageId || !packageKey) continue;
      const refs = await refsWithFallback(reader, pkg.products, `/packages/${encodeURIComponent(packageId)}/products`);
      const mine: RevenueCatPackageProduct[] = [];
      for (const ref of refs) {
        if (ids.has(ref.productId) && !mine.some((m) => m.productId === ref.productId && m.eligibility === ref.eligibility)) {
          mine.push(ref);
        }
      }
      if (mine.length === 0) continue;
      packages.push({
        id: packageId,
        lookupKey: packageKey,
        displayName: short(pkg.display_name),
        position: parsePositive(pkg.position),
        products: mine,
      });
    }
    if (packages.length === 0) continue;
    packages.sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || a.lookupKey.localeCompare(b.lookupKey));
    offerings.push({
      id,
      lookupKey,
      displayName: short(item.display_name),
      isCurrent: item.is_current === true,
      state: revenueCatStateOf(item.state),
      rawState: short(item.state, 60),
      packages,
    });
  }

  if (reader.skipped) {
    warnings.push(
      'The read stopped before every entitlement and offering was read in full, to stay under RevenueCat\'s rate limit. Sync again in a minute.',
    );
  }
  if (reader.unreadable > 0) {
    // What could not be read may be the very product an entitlement or a package holds: no "not found" claim is made then.
    reader.complete = false;
    warnings.push(
      `${reader.unreadable} product reference${reader.unreadable === 1 ? '' : 's'} in the entitlements or offerings could not be read and ${reader.unreadable === 1 ? 'was' : 'were'} left out.`,
    );
  }
  return {
    products,
    otherAppProducts,
    entitlements,
    offerings,
    complete: reader.complete,
    warnings,
    requests: client.requests,
  };
}
