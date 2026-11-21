import { z } from 'zod';
import { type Draft, none, timestamp, W } from '../../operations/shared.ts';
import { detectQuery, setLinkBody } from './routes.ts';

/**
 * The operations of the RevenueCat link and read (docs/api/revenuecat.md). Reading the link and the joined view needs `apps.read`;
 * saving, removing and detecting need `apps.write`; the sync needs `apps.sync`. Nothing changes anything in RevenueCat.
 */

const link = z.object({
  appId: z.string(),
  credentialId: z.string(),
  credentialLabel: z.string().nullable().describe('Null when the credential was deleted.'),
  credentialAvailable: z
    .boolean()
    .describe('False when the credential was deleted or is not a RevenueCat credential: choose another and save again.'),
  projectId: z.string(),
  projectName: z.string(),
  revenueCatAppId: z.string(),
  revenueCatAppName: z.string(),
  revenueCatAppType: z
    .string()
    .describe('`app_store`, `mac_app_store` or `play_store`. A macOS app record uses `mac_app_store` (a legacy Mac app) or the shared `app_store` app (a universal purchase).'),
  revenueCatIdentifier: z.string().nullable().describe('The bundle id or package name RevenueCat holds for the app.'),
  identifierMatches: z
    .boolean()
    .nullable()
    .describe('Whether that identifier is this app’s own; null when unknown. A mismatch is not an error (a universal purchase may use another bundle id).'),
  verifiedAt: timestamp.describe('When RevenueCat last confirmed the project and app with the credential.'),
  linkedBy: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

const syncStatus = z.object({
  lastAttemptAt: timestamp.nullable(),
  lastSyncedAt: timestamp.nullable(),
  lastError: z.string().nullable().describe('A fixed sentence about the last failure (never RevenueCat’s text); null after a good sync.'),
  failures: z.number().int().describe('Syncs in a row that failed.'),
  productCount: z.number().int(),
  otherAppProductCount: z.number().int().describe('Products of the RevenueCat project that belong to its other apps, left out.'),
  complete: z.boolean().describe('False when the last sync stopped at a cap: a list may be missing items, and "not found" warnings are not raised from it.'),
  warnings: z.array(z.string()),
});

const matchedProduct = z.object({
  rcProductId: z.string(),
  storeIdentifier: z.string().describe('RevenueCat’s store identifier: the product id, or `subscription_id:base_plan_id` on Google Play.'),
  planId: z.string().nullable().describe('Google Play: the base plan this RevenueCat product is for. Null for an exact or legacy bare id, and for Apple.'),
  planInStore: z.boolean().nullable().describe('Whether the store snapshot lists that base plan; null when it does not apply.'),
  type: z.string().describe('RevenueCat’s type, verbatim (`subscription`, `one_time`, `consumable`, `non_consumable`, `non_renewing_subscription`, or a new one).'),
  state: z.enum(['active', 'archived', 'unknown']),
  displayName: z.string().nullable(),
  duration: z.string().nullable().describe('ISO 8601.'),
  gracePeriod: z.string().nullable().describe('ISO 8601.'),
  trialDuration: z.string().nullable().describe('ISO 8601.'),
});

const productRevenueCat = z.object({
  status: z
    .enum(['in_revenuecat', 'archived', 'not_in_revenuecat', 'id_not_matched'])
    .describe('`id_not_matched`: a RevenueCat product has the id with another letter case, which is not a match.'),
  products: z.array(matchedProduct).describe('Google Play subscriptions have one per base plan.'),
  entitlements: z.array(
    z.object({ id: z.string(), lookupKey: z.string(), displayName: z.string().nullable(), state: z.enum(['active', 'archived', 'unknown']) }),
  ),
  offerings: z.array(
    z.object({
      id: z.string(),
      lookupKey: z.string(),
      isCurrent: z.boolean(),
      state: z.enum(['active', 'archived', 'unknown']),
      packages: z.array(
        z.object({
          id: z.string(),
          lookupKey: z.string(),
          rcProductId: z.string(),
          eligibility: z.string().describe('`all`, `google_sdk_lt_6` or `google_sdk_ge_6`; another value verbatim.'),
        }),
      ),
    }),
  ),
});

const metric = z.object({
  id: z.string().describe('RevenueCat’s metric id, verbatim.'),
  name: z.string(),
  kind: z.enum(['count', 'money']).describe('A `count` is a plain number of things; `money` is an amount in `currency`.'),
  value: z.number(),
  currency: z
    .string()
    .nullable()
    .describe('ISO 4217 code RevenueCat reported for its money figures. Null for a count, and for money when RevenueCat named none (then the amount is not a known currency). Never converted.'),
  period: z.string().nullable().describe('RevenueCat’s period verbatim: `P0D` is the current value, `P28D` the last 28 days.'),
  windowDays: z.number().int().nullable().describe('The period in days: 0 for the current value, 28 for `P28D`; null when it is not a number of days.'),
  lastUpdatedAt: timestamp.nullable().describe('When RevenueCat last updated the figure.'),
});

export const metricsStep = z.union([
  z.object({ ok: z.literal(true), metrics: z.number().int().describe('How many figures were read.'), fetchedAt: timestamp }),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string(), retryAfterSeconds: z.number().int().optional() }),
]);

const warning = z.object({
  code: z.enum([
    'store_product_not_in_revenuecat',
    'revenuecat_product_not_in_store',
    'revenuecat_product_case_differs',
    'product_not_sellable',
    'entitlement_without_active_product',
    'store_removed_but_active_in_revenuecat',
    'play_base_plan_not_in_revenuecat',
    'revenuecat_read_incomplete',
  ]),
  severity: z.enum(['info', 'warn', 'bad']),
  message: z.string().describe('One sentence with the fix.'),
  storeProductId: z.string().nullable(),
  rcProductId: z.string().nullable(),
  entitlementId: z.string().nullable(),
});

const choice = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().describe('RevenueCat’s own app type, verbatim.'),
  mapped: z.boolean().describe('False for every store this tool does not read (Stripe, Web Billing, Amazon, Roku, Paddle, Test Store, ...): ignored, never an error.'),
  linkable: z.boolean().describe('Mapped, and a type this app record’s platform may use.'),
  identifier: z.string().nullable(),
  matches: z.boolean().describe('The identifier is this app’s own.'),
  suggested: z.boolean(),
  note: z.string().nullable().describe('A sentence when the app cannot be linked ("Not mapped: ..."), else null.'),
});

export const revenueCatOperations: Draft[] = [
  {
    id: 'getRevenueCatLink',
    method: 'get',
    path: `${W}/apps/{appId}/revenuecat`,
    tags: ['revenuecat'],
    summary: 'The RevenueCat project and app an app is linked to, and how the last RevenueCat sync went',
    description:
      'Answers `{ supported, link, sync }`: `link` is null when the app has none, `sync` is null before the first RevenueCat sync. Database only: RevenueCat is not called. `supported` is false for a platform without RevenueCat support. Needs `apps.read`.',
    risk: 'read',
    access: { action: 'apps.read' },
    appScope: { kind: 'param', name: 'appId' },
    responses: {
      '200': {
        description: 'The link, or null, and the sync state.',
        schema: z.object({ supported: z.boolean(), link: link.nullable(), sync: syncStatus.nullable() }),
      },
    },
  },
  {
    id: 'setRevenueCatLink',
    method: 'put',
    path: `${W}/apps/{appId}/revenuecat`,
    tags: ['revenuecat'],
    summary: 'Link an app to a RevenueCat project and app, or change the link',
    description:
      'READS RevenueCat with the chosen RevenueCat credential (audited as `credential.use`, purpose `revenuecat.link`) to confirm that the project and the app exist and the key can see them; what RevenueCat says (names, app type, bundle id or package name) is stored, not what was typed. The RevenueCat app must be an App Store, Mac App Store or Play Store app that fits the platform of this app (iOS: App Store; Android: Play Store; macOS: Mac App Store for a legacy Mac app, or the shared App Store app of a universal purchase): any other store is `422 revenuecat_app_not_mapped`. A changed project or app clears the stored copy. Nothing at RevenueCat is changed. `422` `credential_not_found` / `credential_kind` / `revenuecat_auth` / `revenuecat_forbidden` / `revenuecat_not_found` / `revenuecat_app_not_mapped` / `revenuecat_not_supported`; `429` (20 a minute per workspace, or RevenueCat said to slow down); `502` `revenuecat_unavailable`; `504` `timeout`. Needs `apps.write`. Audited as `revenuecat.link_set`.',
    risk: 'write',
    access: { action: 'apps.write' },
    appScope: { kind: 'param', name: 'appId' },
    rateLimited: true,
    body: setLinkBody,
    responses: { '200': { description: 'The saved link.', schema: z.object({ link }) } },
  },
  {
    id: 'removeRevenueCatLink',
    method: 'delete',
    path: `${W}/apps/{appId}/revenuecat`,
    tags: ['revenuecat'],
    summary: 'Remove the link of an app to its RevenueCat project, and the stored copy',
    description:
      'Removes the stored link and the stored RevenueCat copy of the app; nothing at RevenueCat is changed and the credential stays. `404` when the app has no link. Needs `apps.write`. Audited as `revenuecat.link_remove`.',
    risk: 'destructive',
    access: { action: 'apps.write' },
    appScope: { kind: 'param', name: 'appId' },
    responses: { '204': none },
  },
  {
    id: 'detectRevenueCat',
    method: 'get',
    path: `${W}/apps/{appId}/revenuecat/detect`,
    tags: ['revenuecat'],
    summary: 'List the RevenueCat projects and apps a credential sees, to pick the link from',
    description:
      'READS RevenueCat with the given RevenueCat credential (audited as `credential.use`, purpose `revenuecat.detect`); nothing is saved. Answers the projects and, for `projectId` (or the only project the key sees), the apps with `linkable`, `suggested` (the bundle id or package name is this app’s own) and a `note` for the ones that cannot be linked ("Not mapped": every store other than App Store, Mac App Store and Play Store). Needs `apps.write`.',
    risk: 'read',
    access: { action: 'apps.write' },
    appScope: { kind: 'param', name: 'appId' },
    query: detectQuery,
    responses: {
      '200': {
        description: 'What the credential sees.',
        schema: z.object({
          options: z.object({
            projects: z.array(z.object({ id: z.string(), name: z.string() })),
            projectId: z.string().nullable().describe('The project the apps are of; null when the key sees several and none was chosen.'),
            apps: z.array(choice).nullable(),
            complete: z.boolean(),
          }),
        }),
      },
    },
  },
  {
    id: 'getAppRevenueCatProducts',
    method: 'get',
    path: `${W}/apps/{appId}/revenuecat/products`,
    tags: ['revenuecat'],
    summary: 'The stored store products joined to the stored RevenueCat configuration, with warnings',
    description:
      'Computed from the two stored copies on every read; asks neither the store nor RevenueCat. `products` is keyed by store product id (empty before the first RevenueCat sync: nothing is claimed). `unmatched` are RevenueCat products of the linked app with no store product. `warnings` are the mismatches, each with a fix: `store_product_not_in_revenuecat`, `revenuecat_product_not_in_store`, `revenuecat_product_case_differs`, `product_not_sellable`, `entitlement_without_active_product`, `store_removed_but_active_in_revenuecat`, `play_base_plan_not_in_revenuecat`, `revenuecat_read_incomplete`. Configuration facts only: no money amounts, no customer data. Needs `apps.read`.',
    risk: 'read',
    access: { action: 'apps.read' },
    appScope: { kind: 'param', name: 'appId' },
    responses: {
      '200': {
        description: 'The joined view.',
        schema: z.object({
          supported: z.boolean(),
          link: link.nullable(),
          sync: syncStatus.nullable(),
          products: z.record(productRevenueCat),
          unmatched: z.array(matchedProduct),
          warnings: z.array(warning),
        }),
      },
    },
  },
  {
    id: 'getAppRevenueCatMetrics',
    method: 'get',
    path: `${W}/apps/{appId}/revenuecat/metrics`,
    tags: ['revenuecat'],
    summary: 'RevenueCat’s own overview figures for the linked project: active subscriptions, active trials, MRR and revenue',
    description:
      'The stored copy of RevenueCat’s metrics overview (`GET /v2/projects/{id}/metrics/overview`), read by the RevenueCat sync; asks neither RevenueCat nor a store. These are RevenueCat’s figures for the WHOLE project (`scope: "project"`: every app and every store it knows), not this app alone and not the store consoles’ numbers. `figures` has the four of the Products page strip, each null when RevenueCat reported none (never zero). Money (`mrr`, `revenue`) carries `currency`, the code RevenueCat reported; it is never converted or summed. `revenue` is RevenueCat’s gross of the window (`windowDays`, 28), before store fees and taxes. `metrics` is null before the first good read, and for an app without a link; `status` says how the last attempt went (a failed one keeps the old figures and a fixed `lastError`). Viewers can read it (`apps.read`): revenue is visible to every member of the workspace (ADR 0043). The metric ids other than `active_trials` are unverified guesses with a display-name fallback (docs/api/revenuecat.md).',
    risk: 'read',
    access: { action: 'apps.read' },
    appScope: { kind: 'param', name: 'appId' },
    responses: {
      '200': {
        description: 'The stored figures and the state of the last read.',
        schema: z.object({
          supported: z.boolean(),
          linked: z.boolean(),
          metrics: z
            .object({
              scope: z.literal('project').describe('The figures cover every app and store of the RevenueCat project.'),
              projectId: z.string(),
              projectName: z.string(),
              currency: z.string().nullable().describe('The currency RevenueCat reported for its money figures.'),
              fetchedAt: timestamp.describe('When the figures were read from RevenueCat.'),
              figures: z.object({
                activeSubscriptions: metric.nullable(),
                activeTrials: metric.nullable(),
                mrr: metric.nullable(),
                revenue: metric.nullable(),
              }),
              others: z.array(metric).describe('The other metrics RevenueCat reported (customers, for one), in its order.'),
            })
            .nullable(),
          status: z
            .object({
              lastAttemptAt: timestamp.nullable(),
              lastError: z.string().nullable().describe('A fixed sentence about the last failure (never RevenueCat’s text); null after a good read.'),
              failures: z.number().int().describe('Reads in a row that failed.'),
            })
            .nullable(),
        }),
      },
    },
  },
  {
    id: 'syncAppRevenueCat',
    method: 'post',
    path: `${W}/apps/{appId}/revenuecat/sync`,
    tags: ['revenuecat'],
    summary: 'Read the RevenueCat configuration of the linked app and replace the stored copy',
    description:
      'Read-only toward RevenueCat: lists products, entitlements (with their products) and offerings (with packages) of the project and keeps those of the linked app (about 3 to 8 requests, under the 60 a minute of the project configuration; a cap or the rate limit ends the read early and `complete` is false), then reads the metrics overview of the project (one request; `GET .../revenuecat/metrics`), whose result is in `sync.metrics` and never changes this answer. A failed sync keeps the last good copy (`lastError` on the link read). `POST .../products/sync` runs this as its second step when the app is linked; this route retries only this half. Rate limited per workspace, with the budget of the app sync. `422 revenuecat_not_linked`, `422 revenuecat_app_missing` (RevenueCat no longer has the linked app), `429` (RevenueCat said to slow down), `504 timeout`. Needs `apps.sync`. Audited as `revenuecat.synced` (counts only).',
    risk: 'write',
    access: { action: 'apps.sync' },
    appScope: { kind: 'param', name: 'appId' },
    rateLimited: true,
    responses: {
      '200': {
        description: 'What the sync read.',
        schema: z.object({
          sync: z.object({
            products: z.number().int(),
            entitlements: z.number().int(),
            offerings: z.number().int(),
            otherAppProducts: z.number().int(),
            complete: z.boolean(),
            warnings: z.array(z.string()),
            syncedAt: timestamp,
            metrics: metricsStep.describe(
              'The metrics overview read after the configuration, with its own result: `ok: false` (for example a key without the Charts & Metrics permission) never changes the configuration copy or this answer’s status.',
            ),
          }),
        }),
      },
    },
  },
];
