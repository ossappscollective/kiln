import { PLATFORMS } from '@kiln/core';
import { z } from 'zod';
import { type Draft, reviewStore, timestamp, W } from '../../operations/shared.ts';
import { metricsStep } from '../revenuecat/operations.ts';

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
    .describe(
      'The price in the currency’s minor units, as a string of digits: `"499"` is 4.99 USD, `"500"` is 500 JPY.',
    ),
  display: z.string().describe('The amount for a person to read, such as `4.99`.'),
});

const summarySchema = z.object({
  productId: z
    .string()
    .describe('The id the developer chose, the same in the store and in the app.'),
  kind: productKind.describe(
    'Google Play does not say consumable or not: a one-time product that allows more than one purchase is `consumable`, every other is `non_consumable` (a guess, said so in the app).',
  ),
  referenceName: z
    .string()
    .describe('The name only the developer sees. Google Play has none: the product id.'),
  state: productState,
  rawState: z.string().nullable().describe('The store’s own state, verbatim.'),
  group: z.string().nullable().describe('App Store subscriptions: the subscription group.'),
  period: z
    .string()
    .nullable()
    .describe('The subscription period (App Store `ONE_MONTH`, Google Play `P1M`).'),
  name: z
    .string()
    .nullable()
    .describe('The display name of one locale (`en-US` when there is one).'),
  locales: z.array(z.string()),
  price: priceSchema
    .nullable()
    .describe('The price in the base territory, else the United States, else the first.'),
  territoryCount: z.number().int().describe('How many territories have a price.'),
  syncedAt: timestamp,
});

const detailSchema = summarySchema.extend({
  baseTerritory: z
    .string()
    .nullable()
    .describe('App Store: the territory the other prices are derived from.'),
  localizations: z.array(
    z.object({ locale: z.string(), name: z.string(), description: z.string() }),
  ),
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
  lastError: z
    .string()
    .nullable()
    .describe('A redacted sentence about the last failure; null after a good sync.'),
  failures: z.number().int().describe('Syncs in a row that failed.'),
  productCount: z.number().int(),
  complete: z
    .boolean()
    .describe(
      'False when the last sync stopped at a cap: the list may not be everything the store has.',
    ),
  warnings: z.array(z.string()),
});

const revenueCatStepSchema = z
  .union([
    z.object({
      ok: z.literal(true),
      products: z.number().int(),
      entitlements: z.number().int(),
      offerings: z.number().int(),
      otherAppProducts: z.number().int(),
      complete: z.boolean(),
      warnings: z.array(z.string()),
      syncedAt: timestamp,
      metrics: metricsStep.describe(
        'The RevenueCat metrics overview read after the configuration, with its own result (ADR 0043).',
      ),
    }),
    z.object({
      ok: z.literal(false),
      code: z.string(),
      message: z.string(),
      retryAfterSeconds: z.number().int().optional(),
    }),
  ])
  .nullable();

export const stagedPriceSchema = z.object({
  id: z.string(),
  productId: z.string(),
  planId: z.string().nullable(),
  store: z.string(),
  kind: productKind,
  effectiveDate: z
    .string()
    .nullable()
    .describe('`YYYY-MM-DD`, or null for as soon as the store allows.'),
  existingSubscribers: z.enum(['preserve', 'apply', 'opt_in', 'opt_out', 'not_applicable']),
  acknowledgements: z.array(z.enum(['large_change', 'large_absolute', 'existing_subscribers'])),
  lines: z.array(
    z.object({
      territory: z.string(),
      currency: z.string(),
      before: z.string().describe('Minor units, as text.'),
      after: z.string().describe('Minor units, as text.'),
      percentBp: z
        .number()
        .int()
        .nullable()
        .describe('Change in basis points of the current price (2004 is +20.04%).'),
      direction: z.enum(['increase', 'decrease', 'same']),
      pricePointId: z.string().nullable(),
    }),
  ),
  currencies: z.array(z.string()).describe('Amounts of different currencies are never added.'),
  largestBp: z.number().int(),
  createdAt: timestamp,
  createdBy: z.string(),
  version: z.string(),
});

const productsViewSchema = z.object({
  app: appViewSchema,
  supported: z.boolean().describe('False for a platform whose store has no in-app purchases here.'),
  products: z.array(summarySchema),
  sync: syncStatusSchema.nullable().describe('Null before the first sync.'),
  write: z.object({
    enabled: z.boolean().describe('KILN_STORE_PRODUCT_WRITE_ENABLED.'),
    envName: z.string(),
  }),
  priceWrite: z
    .object({
      enabled: z
        .boolean()
        .describe(
          'Both switches are on: the server (`KILN_PRICE_WRITES_ENABLED`) and the workspace setting `prices.writeEnabled`.',
        ),
      envName: z.string(),
      workspaceEnabled: z.boolean(),
      reason: z
        .enum(['server_switch', 'workspace_setting'])
        .nullable()
        .describe('Which switch is off (the server first), null when both are on.'),
      limits: z.object({
        relativeChangePercent: z.number(),
        absoluteChangeMajor: z.number(),
        maxTerritories: z.number().int(),
      }),
      staged: z
        .array(stagedPriceSchema)
        .describe(
          'Price changes staged for this app and not yet sent (they are also in the cart).',
        ),
    })
    .describe(
      'Price changes (ADR 0062). Prices are changed only by staging here and sending from the cart.',
    ),
});

const pricePointSchema = z.object({
  id: z.string(),
  territory: z.string(),
  currency: z.string(),
  amount: z.string().describe('Minor units, as text.'),
});
const priceIssueSchema = z.object({
  code: z.string(),
  territory: z.string().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
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
  unchanged: z
    .boolean()
    .describe(
      'True when the proposed texts are the ones the store has: there is nothing to apply.',
    ),
  previewHash: z
    .string()
    .describe('Send it back with `apply: true`. Valid only while the store still shows `current`.'),
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
    .describe(
      'True when the write’s outcome was unknown and reading the store back showed the change.',
    ),
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
      'Reads the stored copy; asks no store. `sync` says when the last sync ran and whether it failed. `write.enabled` is whether changing a text is switched on (`KILN_STORE_PRODUCT_WRITE_ENABLED`). Prices are in minor units, read only.',
    risk: 'read',
    access: { action: 'apps.read' },
    appScope: { kind: 'param', name: 'appId' },
    responses: {
      '200': { description: 'The products and the state of the sync.', schema: productsViewSchema },
    },
  },
  {
    id: 'getAppProduct',
    method: 'get',
    path: `${W}/apps/{appId}/products/{productId}`,
    tags: ['products'],
    summary: 'One in-app purchase or subscription with its texts, prices and availability',
    description:
      'Reads the stored copy; asks no store. `404 product_not_found` when the last sync did not list it.',
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
      'Read-only toward the store, and then toward RevenueCat when the app is linked to a RevenueCat project (ADR 0039; the second step, reported in `revenuecat`). Lists in-app purchases (App Store: in-app purchases v2, subscription groups and subscriptions, price schedules; Google Play: subscriptions and one-time products) and changes nothing there. If any part of the read fails the whole sync fails and the last good copy stays (`lastError` on the list). Rate limited per workspace, with the budget of the app sync. `422 products_not_supported` for a platform without in-app purchases, `422 app_not_synced` before an App Store app has its store id.',
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
          revenuecat: revenueCatStepSchema.describe(
            'The RevenueCat read that follows the store read when the app is linked to a RevenueCat project (null when it is not). It has its own result: `ok: false` here never changes the store copy or the store answer. A store failure is a 4xx/5xx with this same field in the body.',
          ),
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
      'The ONLY write of in-app products: the localized display name and description of a locale the product already has. Prices, availability, state and the products themselves are never written. Needs `monetization.write` (owner and admin; a token only when its actions name it) and `KILN_STORE_PRODUCT_WRITE_ENABLED=true` (`409 store_product_write_disabled` otherwise). `apply: false` READS THE STORE and returns a preview with `previewHash`; writes nothing. `apply: true` needs the `previewHash` of a preview of exactly these texts, and a step-up confirmation where the workspace policy covers `store.push_draft`. The store is READ AGAIN right before the write: other texts than the previewed ones are not overwritten (`409 state_changed`, with the new `previewHash`). One write per app at a time (`409 write_in_progress`). Never retried: after a lost answer the store is read back (`200` with `confirmedByReread: true`, or `409 outcome_unknown`, cleared by a new preview). A locale the product does not have is `422 locale_not_found`. Audited as `monetization.localization_changed` / `monetization.localization_failed` (ids and hashes, never the texts).',
    risk: 'write',
    access: { action: 'monetization.write' },
    appScope: { kind: 'param', name: 'appId' },
    body: z.object({
      apply: z.boolean().describe('False: preview. True: write, with `previewHash`.'),
      name: z
        .string()
        .max(400)
        .describe(
          'The display name, one line. The store’s own length limit applies and is not checked here.',
        ),
      description: z
        .string()
        .max(4000)
        .describe('The description. May be empty; the store may refuse an empty one.'),
      previewHash: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional()
        .describe(
          'Required with `apply: true`: the `previewHash` of a preview of exactly these texts.',
        ),
    }),
    responses: {
      '200': {
        description: 'A preview (`apply: false`) or the result of the change (`apply: true`).',
        schema: z.object({ preview: previewSchema.optional(), result: resultSchema.optional() }),
      },
    },
  },
  {
    id: 'listProductPricePoints',
    method: 'get',
    path: `${W}/apps/{appId}/products/{productId}/price-points`,
    tags: ['products'],
    summary: 'Apple price points of one territory (a store READ)',
    description:
      'Apple sells only at its price points: this lists those of one territory (`?territory=USA`), lowest first, read from App Store Connect. Google Play has none: `applicable` is false and the list empty. Changes nothing. Needs `monetization.price` (owner and admin; a token only when its actions name it).',
    risk: 'read',
    access: { action: 'monetization.price' },
    appScope: { kind: 'param', name: 'appId' },
    responses: {
      '200': {
        description: 'The price points.',
        schema: z.object({
          pricePoints: z.array(pricePointSchema),
          currency: z.string().nullable(),
          applicable: z.boolean(),
        }),
      },
    },
  },
  {
    id: 'convertProductPrices',
    method: 'post',
    path: `${W}/apps/{appId}/products/{productId}/price-convert`,
    tags: ['products'],
    summary: 'Google Play: derive regional prices from one base price (a store READ)',
    description:
      'Calls Google Play `pricing:convertRegionPrices` with the base territory\u2019s new amount (minor units, tax exclusive as Google defines it) and returns the converted price of each region the plan already has, in the currency it already has. Changes nothing and stages nothing: the person reviews the numbers and stages them. `422 not_applicable` for the App Store. Needs `monetization.price`.',
    risk: 'read',
    access: { action: 'monetization.price' },
    appScope: { kind: 'param', name: 'appId' },
    body: z.object({
      planId: z.string().nullable(),
      baseTerritory: z.string().length(2),
      amount: z.string().regex(/^\d{1,15}$/),
    }),
    responses: {
      '200': {
        description: 'Converted prices.',
        schema: z.object({
          prices: z.array(
            z.object({
              territory: z.string(),
              currency: z.string(),
              amount: z.string(),
              current: z.string().nullable(),
            }),
          ),
          regionsVersion: z.string().nullable(),
        }),
      },
    },
  },
  {
    id: 'stageProductPrice',
    method: 'put',
    path: `${W}/apps/{appId}/products/{productId}/prices/staged`,
    tags: ['products'],
    summary: 'Stage a price change of a product (Kiln only; nothing is sent to a store)',
    description:
      'Stages (replaces) the price change of one product and plan; it then appears in the pending cart as a `price` item with risk `financial`. Writes Kiln\u2019s own table and the audit log only. The SERVER decides: the current price and currency come from the stored snapshot, never from the request, and every rule is checked again (positive whole minor units, currency of the territory, Apple amounts must be an Apple price point (the nearest points are returned, never rounded silently), Play Money precision, a change over the relative or absolute limit needs its acknowledgement, a date not in the past and only where the store can schedule, at most the configured number of territories). `409 price_writes_disabled` while `KILN_PRICE_WRITES_ENABLED` or the workspace setting `prices.writeEnabled` is off; `409 stale_snapshot` when `seenSyncedAt` is not the product\u2019s `syncedAt`; `422` with an `issues` list otherwise. Existing subscribers default to `preserve`. Needs `monetization.price` (explicit-only for tokens). Audited as `price.staged` with the before and after amounts.',
    risk: 'write',
    access: { action: 'monetization.price' },
    appScope: { kind: 'param', name: 'appId' },
    body: z.object({
      planId: z
        .string()
        .nullable()
        .describe(
          'Google Play: the base plan or purchase option. Apple subscription: the plan type of the price row (`MONTHLY`, `UPFRONT`) or null. Apple in-app purchase: null.',
        ),
      lines: z
        .array(
          z.object({
            territory: z.string(),
            newAmount: z
              .string()
              .regex(/^\d{1,15}$/)
              .describe('Minor units, digits only.'),
            pricePointId: z
              .string()
              .optional()
              .describe('Apple only: the price point that carries the amount.'),
          }),
        )
        .min(1)
        .max(250),
      effectiveDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .describe('Apple only; null means as soon as the store allows.'),
      existingSubscribers: z
        .enum(['preserve', 'apply', 'opt_in', 'opt_out', 'not_applicable'])
        .describe('`preserve` is the default and the safe choice.'),
      acknowledgements: z.array(z.enum(['large_change', 'large_absolute', 'existing_subscribers'])),
      seenSyncedAt: z
        .number()
        .int()
        .min(0)
        .describe('The `syncedAt` of the product as the screen showed it.'),
    }),
    responses: {
      '200': { description: 'The staged change.', schema: z.object({ staged: stagedPriceSchema }) },
    },
  },
  {
    id: 'dryRunStagedPrices',
    method: 'post',
    path: `${W}/apps/{appId}/prices/dry-run`,
    tags: ['products'],
    summary: 'Dry run of the staged price changes (a store READ; nothing is sent)',
    description:
      'Reads the LIVE prices of each staged change (and Apple\u2019s price points), runs every rule again against them, and shows what a send would do: Apple subscriptions go through `subscriptionPriceChangePreviews` (the store\u2019s own validation, which saves nothing); for the other stores `preview.requests` lists exactly what would be sent. Writes nothing, takes no claim, needs no typed phrase or step-up. Works while the switches are off (`writesEnabled` says whether a send would be allowed). Needs `monetization.price`. Audited as `price.dry_run`.',
    risk: 'read',
    access: { action: 'monetization.price' },
    appScope: { kind: 'param', name: 'appId' },
    body: z.object({
      ids: z
        .array(z.string())
        .max(200)
        .optional()
        .describe('Cart item ids (`price:\u2026`); all staged changes when omitted.'),
    }),
    responses: {
      '200': {
        description: 'Per item: issues against the live prices and the preview.',
        schema: z.object({
          dryRun: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                productId: z.string(),
                summary: z.object({
                  lines: z.array(z.record(z.string(), z.unknown())),
                  currencies: z.array(z.string()),
                  largestBp: z.number().int(),
                  largestSignedBp: z.number().int(),
                  increases: z.number().int(),
                  decreases: z.number().int(),
                }),
                issues: z.array(priceIssueSchema),
                preview: z
                  .object({
                    mode: z.enum(['store', 'local']),
                    lines: z.array(
                      z.object({
                        territory: z.string(),
                        changeType: z.string().optional(),
                        note: z.string().optional(),
                      }),
                    ),
                    requests: z.array(
                      z.object({ method: z.string(), path: z.string(), summary: z.string() }),
                    ),
                  })
                  .nullable(),
                error: z.object({ code: z.string(), message: z.string() }).nullable(),
              }),
            ),
            writesEnabled: z.boolean(),
          }),
        }),
      },
    },
  },
];
