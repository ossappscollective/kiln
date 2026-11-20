import { PLATFORMS } from '@mrm/core';
import { z } from 'zod';
import { type Draft, reviewStore, timestamp, W } from '../../operations/shared.ts';

/** The operations of in-app products (docs/api/products.md). The registry (operations/registry.ts) lists them. */

const productKind = z.enum(['consumable', 'non_consumable', 'subscription']);
const productState = z.enum([
  'draft',
  'in_review',
  'action_needed',
  'active',
  'inactive',
  'removed',
  'unknown',
]);

const appViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.enum(PLATFORMS),
  store: reviewStore,
});

const priceSchema = z.object({
  planId: z
    .string()
    .nullable()
    .describe('Google Play: the base plan or purchase option the price belongs to. Apple: null.'),
  territory: z
    .string()
    .describe('Apple: the three-letter territory id (`USA`). Google Play: the region code (`US`).'),
  currency: z.string().describe('ISO 4217.'),
  amount: z
    .string()
    .describe('The price in the currency’s minor units, as a string of digits: `"499"` is 4.99 USD, `"500"` is 500 JPY.'),
  display: z.string().describe('The amount for a person to read, such as `4.99`.'),
});

const summarySchema = z.object({
  productId: z.string().describe('The id the developer chose, the same in the store and in the app.'),
  kind: productKind.describe(
    'Google Play does not say consumable or not: a one-time product that allows more than one purchase is `consumable`, every other is `non_consumable` (a guess, said so in the app).',
  ),
  referenceName: z.string().describe('The name only the developer sees. Google Play has none: the product id.'),
  state: productState,
  rawState: z.string().nullable().describe('The store’s own state, verbatim.'),
  group: z.string().nullable().describe('App Store subscriptions: the subscription group.'),
  period: z.string().nullable().describe('The subscription period (App Store `ONE_MONTH`, Google Play `P1M`).'),
  name: z.string().nullable().describe('The display name of one locale (`en-US` when there is one).'),
  locales: z.array(z.string()),
  price: priceSchema.nullable().describe('The price in the base territory, else the United States, else the first.'),
  territoryCount: z.number().int().describe('How many territories have a price.'),
  syncedAt: timestamp,
});

const detailSchema = summarySchema.extend({
  baseTerritory: z.string().nullable().describe('App Store: the territory the other prices are derived from.'),
  localizations: z.array(z.object({ locale: z.string(), name: z.string(), description: z.string() })),
  prices: z.array(priceSchema),
  availability: z
    .object({
      territories: z.array(z.string()),
      availableInNewTerritories: z.boolean().nullable(),
    })
    .nullable(),
  plans: z
    .array(z.object({ id: z.string(), state: z.string(), period: z.string().nullable() }))
    .describe('Google Play: base plans and one-time purchase options.'),
  offers: z
    .array(z.object({ id: z.string(), planId: z.string(), state: z.string() }))
    .describe('Google Play subscription offers.'),
});

const syncStatusSchema = z.object({
  lastAttemptAt: timestamp.nullable(),
  lastSyncedAt: timestamp.nullable(),
  lastError: z.string().nullable().describe('A redacted sentence about the last failure; null after a good sync.'),
  failures: z.number().int().describe('Syncs in a row that failed.'),
  productCount: z.number().int(),
  complete: z
    .boolean()
    .describe('False when the last sync stopped at a cap: the list may not be everything the store has.'),
  warnings: z.array(z.string()),
});

const productsViewSchema = z.object({
  app: appViewSchema,
  supported: z.boolean().describe('False for a platform whose store has no in-app purchases here.'),
  products: z.array(summarySchema),
  sync: syncStatusSchema.nullable().describe('Null before the first sync.'),
  write: z.object({
    enabled: z.boolean().describe('MRM_STORE_PRODUCT_WRITE_ENABLED.'),
    envName: z.string(),
  }),
});

const textsSchema = z.object({ name: z.string(), description: z.string() });
const changesSchema = z.object({ name: z.boolean(), description: z.boolean() });
const productRefSchema = z.object({
  productId: z.string(),
  kind: productKind,
  referenceName: z.string(),
});

const previewSchema = z.object({
  app: appViewSchema,
  product: productRefSchema,
  locale: z.string().describe('The locale as the store writes it.'),
  current: textsSchema.describe('What the store has right now.'),
  proposed: textsSchema,
  changes: changesSchema,
  unchanged: z.boolean().describe('True when the proposed texts are the ones the store has: there is nothing to apply.'),
  previewHash: z.string().describe('Send it back with `apply: true`. Valid only while the store still shows `current`.'),
  warnings: z.array(z.string()),
  readAt: timestamp,
});

const resultSchema = z.object({
  app: appViewSchema,
  product: productRefSchema,
  locale: z.string(),
  before: textsSchema,
  after: textsSchema,
  changes: changesSchema,
  confirmedByReread: z
    .boolean()
    .describe('True when the write’s outcome was unknown and reading the store back showed the change.'),
  appliedAt: timestamp,
  note: z.string(),
});

export const monetizationOperations: Draft[] = [
  {
    id: 'listAppProducts',
    method: 'get',
    path: `${W}/apps/{appId}/products`,
    tags: ['products'],
    summary: 'List the in-app purchases and subscriptions of an app, as of the last sync',
    description:
      'Reads the stored copy; asks no store. `sync` says when the last sync ran and whether it failed. `write.enabled` is whether changing a text is switched on (`MRM_STORE_PRODUCT_WRITE_ENABLED`). Prices are in minor units, read only.',
    risk: 'read',
    access: { action: 'apps.read' },
    appScope: { kind: 'param', name: 'appId' },
    responses: { '200': { description: 'The products and the state of the sync.', schema: productsViewSchema } },
  },
  {
    id: 'getAppProduct',
    method: 'get',
    path: `${W}/apps/{appId}/products/{productId}`,
    tags: ['products'],
    summary: 'One in-app purchase or subscription with its texts, prices and availability',
    description: 'Reads the stored copy; asks no store. `404 product_not_found` when the last sync did not list it.',
    risk: 'read',
    access: { action: 'apps.read' },
    appScope: { kind: 'param', name: 'appId' },
    responses: {
      '200': {
        description: 'The product.',
        schema: z.object({
          app: appViewSchema,
          product: detailSchema,
          sync: syncStatusSchema.nullable(),
        }),
      },
    },
  },
  {
    id: 'syncAppProducts',
    method: 'post',
    path: `${W}/apps/{appId}/products/sync`,
    tags: ['products'],
    summary: 'Read the products from the store and replace the stored copy',
    description:
      'Read-only toward the store: lists in-app purchases (App Store: in-app purchases v2, subscription groups and subscriptions, price schedules; Google Play: subscriptions and one-time products) and changes nothing there. If any part of the read fails the whole sync fails and the last good copy stays (`lastError` on the list). Rate limited per workspace, with the budget of the app sync. `422 products_not_supported` for a platform without in-app purchases, `422 app_not_synced` before an App Store app has its store id.',
    risk: 'write',
    access: { action: 'apps.sync' },
    appScope: { kind: 'param', name: 'appId' },
    rateLimited: true,
    responses: {
      '200': {
        description: 'What the sync read.',
        schema: z.object({
          sync: z.object({
            app: appViewSchema,
            products: z.number().int(),
            complete: z.boolean(),
            warnings: z.array(z.string()),
            syncedAt: timestamp,
          }),
        }),
      },
    },
  },
  {
    id: 'updateProductLocalization',
    method: 'put',
    path: `${W}/apps/{appId}/products/{productId}/localizations/{locale}`,
    tags: ['products'],
    summary: 'Preview or change the display name and description of a product in one locale',
    description:
      'The ONLY write of in-app products: the localized display name and description of a locale the product already has. Prices, availability, state and the products themselves are never written. Needs `monetization.write` (owner and admin; a token only when its actions name it) and `MRM_STORE_PRODUCT_WRITE_ENABLED=true` (`409 store_product_write_disabled` otherwise). `apply: false` READS THE STORE and returns a preview with `previewHash`; writes nothing. `apply: true` needs the `previewHash` of a preview of exactly these texts, and a step-up confirmation where the workspace policy covers `store.push_draft`. The store is READ AGAIN right before the write: other texts than the previewed ones are not overwritten (`409 state_changed`, with the new `previewHash`). One write per app at a time (`409 write_in_progress`). Never retried: after a lost answer the store is read back (`200` with `confirmedByReread: true`, or `409 outcome_unknown`, cleared by a new preview). A locale the product does not have is `422 locale_not_found`. Audited as `monetization.localization_changed` / `monetization.localization_failed` (ids and hashes, never the texts).',
    risk: 'write',
    access: { action: 'monetization.write' },
    appScope: { kind: 'param', name: 'appId' },
    body: z.object({
      apply: z.boolean().describe('False: preview. True: write, with `previewHash`.'),
      name: z.string().max(400).describe('The display name, one line. The store’s own length limit applies and is not checked here.'),
      description: z.string().max(4000).describe('The description. May be empty; the store may refuse an empty one.'),
      previewHash: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional()
        .describe('Required with `apply: true`: the `previewHash` of a preview of exactly these texts.'),
    }),
    responses: {
      '200': {
        description: 'A preview (`apply: false`) or the result of the change (`apply: true`).',
        schema: z.object({ preview: previewSchema.optional(), result: resultSchema.optional() }),
      },
    },
  },
];
