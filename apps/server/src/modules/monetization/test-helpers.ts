import { randomBytes } from 'node:crypto';
import {
  type ListProductsResult,
  ProductLocaleMissingError,
  ProductLocalizationDriftError,
  ProductMissingError,
  ProductOutcomeUnknownError,
  type ProductLocalizationResult,
  type ProductLocalizationUpdate,
  type StoreError,
  type StoreProduct,
  type StoreProductLocalization,
  type StoreProductRef,
  type StoreProductsConnector,
  type StoreProductWriteConnector,
  sameLocale,
} from '@mrm/connectors';
import type { Platform } from '@mrm/core';
import type { Database } from '@mrm/db';
import { bootRepoApp } from '../../repo-test-helpers.ts';
import { ASC_SECRET, PLAY_SECRET } from '../reviews/test-helpers.ts';
import type { MonetizationDeps } from './index.ts';
import type { ProductsConnectorInput } from './shared.ts';

/** Shared by the in-app product tests. Everything runs against fakes: no store is ever contacted. */

export { ASC_SECRET, PLAY_SECRET };

export const iapProduct = (over: Partial<StoreProduct> = {}): StoreProduct => ({
  store: 'appstoreconnect',
  productId: 'com.acme.coins100',
  storeRef: '6740000001',
  kind: 'consumable',
  referenceName: '100 coins',
  state: 'active',
  rawState: 'APPROVED',
  localizations: [
    { locale: 'en-US', name: '100 coins', description: 'A pile of coins', ref: 'loc-en' },
    { locale: 'de-DE', name: '100 Münzen', description: 'Ein Haufen Münzen', ref: 'loc-de' },
  ],
  prices: [
    { territory: 'USA', currency: 'USD', amount: '99', planId: null },
    { territory: 'DEU', currency: 'EUR', amount: '99', planId: null },
    { territory: 'JPN', currency: 'JPY', amount: '150', planId: null },
  ],
  availability: { territories: ['DEU', 'JPN', 'USA'], availableInNewTerritories: true },
  group: null,
  period: null,
  baseTerritory: 'USA',
  plans: [],
  offers: [],
  ...over,
});

export const appleSubscription = (over: Partial<StoreProduct> = {}): StoreProduct =>
  iapProduct({
    productId: 'com.acme.pro.monthly',
    storeRef: '6740000002',
    kind: 'subscription',
    referenceName: 'Pro monthly',
    rawState: 'APPROVED',
    group: 'Pro',
    period: 'ONE_MONTH',
    localizations: [
      { locale: 'en-US', name: 'Pro', description: 'Everything unlocked', ref: 'sloc-en' },
    ],
    prices: [{ territory: 'USA', currency: 'USD', amount: '499', planId: null }],
    ...over,
  });

export const playSubscription = (over: Partial<StoreProduct> = {}): StoreProduct => ({
  store: 'googleplay',
  productId: 'pro_monthly',
  storeRef: null,
  kind: 'subscription',
  referenceName: 'pro_monthly',
  state: 'active',
  rawState: 'ACTIVE',
  localizations: [
    { locale: 'en-US', name: 'Pro', description: 'Everything unlocked' },
    { locale: 'fr-FR', name: 'Pro', description: 'Tout est débloqué' },
  ],
  prices: [
    { territory: 'US', currency: 'USD', amount: '499', planId: 'monthly' },
    { territory: 'DE', currency: 'EUR', amount: '499', planId: 'monthly' },
  ],
  availability: { territories: ['DE', 'US'], availableInNewTerritories: null },
  group: null,
  period: 'P1M',
  baseTerritory: null,
  plans: [{ id: 'monthly', state: 'ACTIVE', period: 'P1M' }],
  offers: [{ id: 'intro', planId: 'monthly', state: 'ACTIVE' }],
  ...over,
});

export type WriteBehavior =
  | { kind: 'ok' }
  | { kind: 'refuse'; error: StoreError }
  /** The write is sent and the store does not answer; `applied` says whether it applied it anyway. */
  | { kind: 'unknown'; applied: boolean };

/** A store that lists products, can read and change one localization, remembers every write, and can be told how to fail. */
export class FakeProductsStore implements StoreProductsConnector, StoreProductWriteConnector {
  readonly store: 'appstoreconnect' | 'googleplay';
  products: StoreProduct[];
  complete = true;
  warnings: string[] = [];
  listError: unknown;
  listReads = 0;
  /** When set, a list waits for it: lets a test hold a sync in flight or make it time out. */
  listGate: Promise<void> | undefined;
  behavior: WriteBehavior = { kind: 'ok' };
  readError: unknown;
  /** After a write attempt the store cannot be read (the read back fails). */
  readFailsAfterWrite = false;
  writes: { productId: string; locale: string; name: string; description: string }[] = [];
  localizationReads = 0;
  /** When set, a write waits for it after the guard accepted: lets a test hold a write in flight. */
  gate: Promise<void> | undefined;

  constructor(platform: Platform) {
    this.store = platform === 'android' ? 'googleplay' : 'appstoreconnect';
    this.products =
      platform === 'android'
        ? [playSubscription()]
        : [iapProduct(), appleSubscription()];
  }

  async listProducts(): Promise<ListProductsResult> {
    this.listReads++;
    if (this.listGate) await this.listGate;
    if (this.listError) throw this.listError;
    return {
      products: structuredClone(this.products),
      warnings: [...this.warnings],
      complete: this.complete,
    };
  }

  #find(ref: StoreProductRef): StoreProduct {
    const product = this.products.find((p) => p.productId === ref.productId);
    if (!product) throw new ProductMissingError(this.store);
    return product;
  }

  async readLocalization(
    ref: StoreProductRef,
    locale: string,
  ): Promise<StoreProductLocalization | undefined> {
    this.localizationReads++;
    if (this.readError) throw this.readError;
    const found = this.#find(ref).localizations.find((l) => sameLocale(l.locale, locale));
    return found ? structuredClone(found) : undefined;
  }

  async updateLocalization(input: ProductLocalizationUpdate): Promise<ProductLocalizationResult> {
    const product = this.#find(input.product);
    const found = product.localizations.find((l) => sameLocale(l.locale, input.locale));
    if (!found) throw new ProductLocaleMissingError(this.store, input.locale);
    const before = structuredClone(found);
    if (!input.guard(before)) throw new ProductLocalizationDriftError(this.store, before);
    this.writes.push({
      productId: input.product.productId,
      locale: input.locale,
      name: input.name,
      description: input.description,
    });
    if (this.gate) await this.gate;
    const b = this.behavior;
    if (b.kind === 'refuse') throw b.error;
    if (b.kind === 'unknown') {
      if (b.applied) {
        found.name = input.name;
        found.description = input.description;
      }
      if (this.readFailsAfterWrite) this.readError = new Error('down');
      throw new ProductOutcomeUnknownError(this.store, 'timed out');
    }
    found.name = input.name;
    found.description = input.description;
    return { before, after: structuredClone(found) };
  }
}

export async function bootMonetization(
  db: Database,
  deps: MonetizationDeps = {},
  overrides: NonNullable<Parameters<typeof bootRepoApp>[2]> = {},
) {
  const stores = { ios: new FakeProductsStore('ios'), android: new FakeProductsStore('android') };
  const built: ProductsConnectorInput[] = [];
  const pick = (input: ProductsConnectorInput) => {
    built.push(input);
    return input.kind === 'app_store_connect' ? stores.ios : stores.android;
  };
  const t = await bootRepoApp(db, undefined, {
    masterKey: randomBytes(32),
    ...overrides,
    monetization: {
      ...deps,
      read: { connectorFactory: pick, ...deps.read },
      write: { enabled: true, connectorFactory: pick, ...deps.write },
    },
  });
  const iosCredential = await t.addCredential('app_store_connect', ASC_SECRET);
  const playCredential = await t.addCredential('google_play', PLAY_SECRET);
  let appCount = 0;
  const addApp = async (platform: Platform, name?: string) => {
    appCount++;
    const res = await t.call(t.owner, 'POST', '/apps', {
      platform,
      identifier: `com.acme.app${appCount}`,
      credentialId: platform === 'android' ? playCredential : iosCredential,
      name: name ?? `App ${appCount}`,
    });
    const id = res.body.app.id as string;
    if (platform !== 'android')
      await db.execute('UPDATE apps SET store_app_id = ? WHERE id = ?', ['1234567890', id]);
    return id;
  };
  const pp = (appId: string, rest = '') => `/apps/${appId}/products${rest}`;
  const sync = (appId: string, cookie = t.owner) => t.call(cookie, 'POST', pp(appId, '/sync'));
  const list = (appId: string, cookie = t.owner) => t.call(cookie, 'GET', pp(appId));
  const localization = (productId: string, locale: string) =>
    `/${encodeURIComponent(productId)}/localizations/${locale}`;
  const preview = (
    appId: string,
    productId: string,
    locale: string,
    texts: { name: string; description: string },
    cookie = t.owner,
  ) =>
    t.call(cookie, 'PUT', pp(appId, localization(productId, locale)), { apply: false, ...texts });
  const apply = (
    appId: string,
    productId: string,
    locale: string,
    texts: { name: string; description: string },
    previewHash: string,
    cookie = t.owner,
  ) =>
    t.call(cookie, 'PUT', pp(appId, localization(productId, locale)), {
      apply: true,
      ...texts,
      previewHash,
    });
  /** A preview followed by the hash of what it said, as a person would. */
  const previewHash = async (
    appId: string,
    productId: string,
    locale: string,
    texts: { name: string; description: string },
  ): Promise<string> => {
    const res = await preview(appId, productId, locale, texts);
    if (res.status !== 200) throw new Error(`preview ${res.status}: ${res.text}`);
    return res.body.preview.previewHash as string;
  };
  const audit = async (like = 'monetization.%') =>
    (
      await db.query(
        'SELECT action, actor_type, detail FROM audit_events WHERE action LIKE ? ORDER BY created_at',
        [like],
      )
    ).map((r) => ({
      action: String(r.action),
      actorType: String(r.actor_type),
      detail: JSON.parse(String(r.detail ?? '{}')) as Record<string, unknown>,
    }));
  const claims = async () => db.query('SELECT app_id, product_id, status FROM store_product_claims');
  return {
    ...t,
    stores,
    built,
    addApp,
    pp,
    sync,
    list,
    preview,
    apply,
    previewHash,
    audit,
    claims,
    iosCredential,
    playCredential,
  };
}
export type MonetizationBoot = Awaited<ReturnType<typeof bootMonetization>>;
