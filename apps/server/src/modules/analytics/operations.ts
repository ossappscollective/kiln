import {
  analyticsDimensions,
  analyticsMetrics,
  analyticsNextSteps,
  analyticsSetupCodes,
  analyticsSources,
  coverageNoteCodes,
  granularities,
  playBucketSources,
  playBucketTestCodes,
} from '@mrm/core';
import { z } from 'zod';
import { enableBody, playBucketBody, playBucketTestBody, syncBody } from './routes.ts';
import type { Operation } from '../../services/openapi.ts';

/**
 * The operations of analytics (docs/api/analytics.md), kept in their own file and added to the registry in api-operations.ts. Reading
 * needs `analytics.read` (every role); everything that reaches a store, stores a file or changes the setup needs `analytics.manage`
 * (admins and owners), EXPLICIT-ONLY for tokens. All of them are about one app, so a token restricted to apps is limited to its apps.
 */

const W = '/api/workspaces/{workspaceId}';
const timestamp = z.number().int().describe('Epoch milliseconds.');
const day = z
  .string()
  .describe(
    'A day, YYYY-MM-DD (UTC for stored days; Apple sales days and Play vitals follow Pacific Time).',
  );

const noteSchema = z.object({ code: z.enum(coverageNoteCodes), message: z.string() });

const seriesSchema = z.object({
  id: z
    .string()
    .describe(
      'The metric, `sales_proceeds:EUR` for the proceeds of one currency, or `product_page_conversion` / `impression_tap_rate` (derived).',
    ),
  metric: z.enum([...analyticsMetrics, 'product_page_conversion', 'impression_tap_rate']),
  label: z.string(),
  unit: z.enum(['count', 'ratio', 'rating', 'money']),
  aggregation: z.enum(['sum', 'mean']).describe('How days combine into a week or a month.'),
  source: z.enum(analyticsSources),
  derived: z
    .boolean()
    .describe('Computed from two other series; it may not match a store console.'),
  currency: z
    .string()
    .nullable()
    .describe(
      'Only for proceeds: the currency of the payout. Proceeds are never converted or added across currencies.',
    ),
  delayDays: z
    .number()
    .int()
    .describe('Days after a date that the store may still change that date’s value.'),
  total: z
    .number()
    .nullable()
    .describe(
      'The sum (counts, money) or the mean (rates, ratings) over the range; null without data. For a derived series, the ratio of the two totals.',
    ),
  points: z.array(
    z.object({ date: day.describe('The first day of the bucket.'), value: z.number().nullable() }),
  ),
  coverage: z.object({
    state: z.enum(['complete', 'partial', 'none']),
    firstDay: day.nullable(),
    lastDay: day.nullable(),
    days: z.number().int(),
    gapDays: z.number().int(),
    notes: z.array(noteSchema),
  }),
  breakdown: z
    .object({
      dimension: z.enum(analyticsDimensions),
      items: z.array(z.object({ value: z.string(), total: z.number() })),
    })
    .optional()
    .describe(
      'With `?breakdown=`: the top 10 values of that dimension over the range, when the source has them.',
    ),
});

const overviewSchema = z.object({
  appId: z.string(),
  platform: z.enum(['ios', 'macos', 'android']),
  from: day,
  to: day,
  granularity: z.enum(granularities),
  series: z.array(seriesSchema),
  notes: z
    .array(noteSchema)
    .describe('Limits that apply to the whole app, such as "Google offers no impressions".'),
});

const setupSchema = z.object({
  code: z.enum(analyticsSetupCodes),
  nextStep: z.enum(analyticsNextSteps),
  alternatives: z.array(z.enum(analyticsNextSteps)),
  optional: z.boolean().describe('The source is an extra: the app works without it.'),
  message: z.string(),
});

const statusSchema = z.object({
  appId: z.string(),
  platform: z.enum(['ios', 'macos', 'android']),
  enabled: z
    .boolean()
    .describe(
      'The workspace setting `analytics.enabled`. While false nothing is requested from a store; importing a file and reading still work.',
    ),
  schedule: z.object({
    intervalMinutes: z
      .number()
      .int()
      .describe('MRM_ANALYTICS_INTERVAL_MINUTES; 0 means no scheduled sync.'),
  }),
  apple: z
    .object({
      mode: z.enum(['off', 'ongoing', 'import']),
      requests: z.array(
        z.object({
          accessType: z.string(),
          status: z.string(),
          createdAt: timestamp,
          lastCheckedAt: timestamp.nullable(),
        }),
      ),
      vendorNumberSet: z.boolean(),
    })
    .nullable()
    .describe('Null for an Android app.'),
  google: z
    .object({
      bucketIdSet: z.boolean(),
      bucketSource: z
        .enum(['app', 'account', 'workspace'])
        .nullable()
        .describe(
          'Where the bucket the app reads came from: its own override, its Play developer account, or the workspace setting.',
        ),
    })
    .nullable()
    .describe('Null for an iOS or macOS app.'),
  sources: z.array(
    z.object({
      source: z.enum(analyticsSources),
      label: z.string(),
      state: z.enum(['off', 'needs_setup', 'waiting', 'error', 'ready']),
      setup: setupSchema.nullable(),
      lastAttemptAt: timestamp.nullable(),
      lastOkAt: timestamp.nullable(),
      lastError: z
        .object({ code: z.string(), message: z.string() })
        .nullable()
        .describe('A code of a fixed vocabulary (switch on it) and its sentence.'),
      firstDay: day.nullable(),
      lastDay: day.nullable(),
    }),
  ),
  runs: z.array(
    z.object({
      source: z.enum(analyticsSources),
      trigger: z.enum(['schedule', 'manual', 'enable', 'import']),
      status: z.enum(['ok', 'partial', 'failed']),
      errorCode: z.string().nullable(),
      pointsWritten: z.number().int(),
      reportsRead: z.number().int(),
      startedAt: timestamp,
      finishedAt: timestamp.nullable(),
    }),
  ),
});

const sourceResult = z.object({
  source: z.enum(analyticsSources),
  status: z.enum(['ok', 'partial', 'failed', 'skipped']),
  points: z.number().int().optional(),
  reports: z.number().int().optional(),
  dayFrom: day.nullable().optional(),
  dayTo: day.nullable().optional(),
  errorCode: z.string().optional().describe('A code of the fixed vocabulary of analytics errors.'),
  transient: z.boolean().optional(),
  setup: z
    .string()
    .optional()
    .describe('Why the source was skipped (a setup need, not a failure).'),
});

const enablePlan = z.object({
  appId: z.string(),
  platform: z.string(),
  roleCheck: z.enum(['ok', 'role_required']),
  steps: z.array(
    z.object({
      accessType: z.enum(['ONGOING', 'ONE_TIME_SNAPSHOT']),
      action: z.enum(['create', 'adopt', 'exists']),
    }),
  ),
  willSend: z.array(z.string()),
  notes: z.array(z.string()),
});

const importPlan = z.object({
  source: z.enum(analyticsSources),
  report: z.object({ kind: z.string(), label: z.string() }),
  platform: z.string(),
  stats: z.object({
    rowsRead: z.number().int(),
    rowsUsed: z.number().int(),
    rowsUnreadable: z.number().int(),
    rowsFiltered: z.number().int(),
  }),
  dateFrom: day.nullable(),
  dateTo: day.nullable(),
  days: z.number().int(),
  points: z.number().int(),
  metrics: z.array(
    z.object({
      metric: z.string(),
      label: z.string(),
      days: z.number().int(),
      total: z.number().nullable(),
    }),
  ),
  sample: z.array(
    z.object({
      date: day,
      metric: z.string(),
      value: z.number(),
      dimension: z.object({ type: z.string(), value: z.string() }).optional(),
    }),
  ),
  notes: z.array(z.string()),
});

const fileQuery = z.object({
  fileName: z
    .string()
    .optional()
    .describe(
      'The name of the file (at most 200 characters): Apple’s report name in it picks the mapping.',
    ),
});
const importNote =
  'The request body IS the file (.tsv, .csv, or the .gz as downloaded; any content type). At most 10 MiB, and 64 MiB after decompression. Columns are matched by name. Errors (422): `file_too_large`, `bad_gzip`, `bad_format`, `unknown_report`, `missing_columns`, `no_rows`, `import_not_supported`, `app_not_synced`.';

export const analyticsOperations: Operation[] = [
  {
    id: 'getAppAnalyticsOverview',
    method: 'get',
    path: `${W}/apps/{id}/analytics/overview`,
    tags: ['analytics'],
    summary: 'Daily metrics of an app as series, each with its source, delay and coverage',
    description:
      'Read-only, from what is stored (no store is contacted). `platform` may be left out; if given it must be the app’s platform. `from` and `to` are days (default: the last 28 days up to yesterday; at most 400 days). `granularity` is `day`, `week` (Monday) or `month`. `breakdown` adds the top 10 values of one dimension to the series that have it. Every series says where it comes from (`source`), how late the store may still change a day (`delayDays`), and what limits it (`coverage.notes`, a fixed vocabulary). Apple counts are not unique users; Apple usage data is a sample; proceeds are per currency and never converted; Google offers no impressions.',
    risk: 'read',
    access: { action: 'analytics.read' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({
      platform: z.enum(['ios', 'macos', 'android']).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      granularity: z.enum(granularities).optional(),
      breakdown: z.enum(analyticsDimensions).optional(),
    }),
    responses: { '200': { description: 'The series.', schema: overviewSchema } },
  },
  {
    id: 'getAppAnalyticsStatus',
    method: 'get',
    path: `${W}/apps/{id}/analytics/status`,
    tags: ['analytics'],
    summary: 'Which analytics sources an app has, their last sync, and what is still needed',
    description:
      'Read-only. `sources[].setup` holds a `code` and a `nextStep` from fixed vocabularies; switch on those, show `message`. A source can be `optional` (vendor number, bucket id).',
    risk: 'read',
    access: { action: 'analytics.read' },
    appScope: { kind: 'param', name: 'id' },
    responses: { '200': { description: 'The status.', schema: statusSchema } },
  },
  {
    id: 'syncAppAnalytics',
    method: 'post',
    path: `${W}/apps/{id}/analytics/sync`,
    tags: ['analytics'],
    summary: 'Read the analytics of an app from its stores now',
    description:
      'Read-only toward the stores. Needs the workspace setting `analytics.enabled` (`409 analytics_disabled`). Optional body `{ sources }` limits it. A source that cannot run yet is `skipped` with its setup need; a failure is a code in `sources[]`, not an HTTP error. Idempotent. Audited as `analytics.sync` with ids, counts and codes; raises the event `analytics.synced` when new numbers were stored. Rate limited per workspace.',
    risk: 'write',
    access: { action: 'analytics.manage' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    body: syncBody,
    bodyOptional: true,
    bodyLimit: 4 * 1024,
    responses: {
      '200': {
        description: 'What each source did, and the new status.',
        schema: z.object({
          sync: z.object({
            at: timestamp,
            pointsWritten: z.number().int(),
            sources: z.array(sourceResult),
          }),
          status: statusSchema,
        }),
      },
    },
  },
  {
    id: 'getAppPlayBucket',
    method: 'get',
    path: `${W}/apps/{id}/analytics/play-bucket`,
    tags: ['analytics'],
    summary:
      'The Google Play reports bucket an Android app reads (its override, its Play developer account, or the workspace setting)',
    description:
      'Google keeps ONE private Cloud Storage bucket per Play developer account and organises the reports by package name, and one workspace can hold apps of several accounts, so a workspace default (`analytics.playBucketId`) is overridden per app (or, optionally, per Play credential). Installs and ratings come only from monthly CSV reports in that bucket (the Reporting API has crash and ANR data only). `422 not_an_android_app` for iOS and macOS apps.',
    risk: 'read',
    access: { action: 'analytics.read' },
    appScope: { kind: 'param', name: 'id' },
    responses: {
      '200': {
        description: 'Where the bucket is set.',
        schema: z.object({
          playBucket: z.object({
            bucketId: z
              .string()
              .nullable()
              .describe('The bucket the app reads now (no `gs://`), or null.'),
            source: z.enum(playBucketSources).nullable(),
            app: z.string().nullable().describe('The override of this app, if any.'),
            account: z
              .string()
              .nullable()
              .describe(
                'The bucket of the Play developer account (the credential), shared by its Android apps.',
              ),
            workspace: z
              .string()
              .nullable()
              .describe('The workspace default, the setting `analytics.playBucketId`.'),
            inherited: z
              .object({
                bucketId: z.string().nullable(),
                source: z.enum(playBucketSources).nullable(),
              })
              .describe(
                'What the app reads without its own override: the Play credential’s bucket, else the workspace default.',
              ),
            credentialId: z.string(),
            sharedWith: z
              .number()
              .int()
              .describe('Android apps of the workspace that use the same Play credential.'),
          }),
        }),
      },
    },
  },
  {
    id: 'setAppPlayBucket',
    method: 'put',
    path: `${W}/apps/{id}/analytics/play-bucket`,
    tags: ['analytics'],
    summary:
      'Set or clear the Google Play reports bucket (of the Play developer account, or only of this app)',
    description:
      'Body `{ bucket, scope? }`: `bucket` is `gs://pubsite_prod_rev_<digits>/` or the bare id (`400`/`422 bucket_invalid` otherwise), `null` clears it; `scope` is `app` (default: an override for this app only; `null` goes back to the inherited bucket) or `account` (every Android app that uses the same Play credential; optional). Contacts no store. Audited as `analytics.play_bucket_set` with ids only (the bucket id is not written to the log).',
    risk: 'write',
    access: { action: 'analytics.manage' },
    appScope: { kind: 'param', name: 'id' },
    body: playBucketBody,
    bodyLimit: 1024,
    responses: {
      '200': {
        description: 'Where the bucket is set now.',
        schema: z.object({
          playBucket: z.object({
            bucketId: z
              .string()
              .nullable()
              .describe('The bucket the app reads now (no `gs://`), or null.'),
            source: z.enum(playBucketSources).nullable(),
            app: z.string().nullable().describe('The override of this app, if any.'),
            account: z
              .string()
              .nullable()
              .describe(
                'The bucket of the Play developer account (the credential), shared by its Android apps.',
              ),
            workspace: z
              .string()
              .nullable()
              .describe('The workspace setting `analytics.playBucketId`.'),
            credentialId: z.string(),
            sharedWith: z
              .number()
              .int()
              .describe('Android apps of the workspace that use the same Play credential.'),
          }),
        }),
      },
    },
  },
  {
    id: 'testAppPlayBucket',
    method: 'post',
    path: `${W}/apps/{id}/analytics/play-bucket/test`,
    tags: ['analytics'],
    summary:
      'Test the Google Play reports bucket: can the service account list this app’s report files?',
    description:
      'Lists the report files of this app for the current and the previous month (nothing is stored). The optional body `{ bucket }` tests a value before it is saved; without it the saved one is tested. The answer is always `200` with a code of a fixed vocabulary, never Google’s text. Needs `analytics.manage`. Rate limited per workspace.',
    risk: 'read',
    access: { action: 'analytics.manage' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    body: playBucketTestBody,
    bodyOptional: true,
    bodyLimit: 1024,
    responses: {
      '200': {
        description: 'The result.',
        schema: z.object({
          result: z.object({
            ok: z.boolean(),
            code: z.enum(playBucketTestCodes),
            message: z.string(),
            months: z.array(z.string()),
          }),
        }),
      },
    },
  },
  {
    id: 'previewAppleAnalyticsEnable',
    method: 'get',
    path: `${W}/apps/{id}/analytics/apple/enable`,
    tags: ['analytics'],
    summary: 'Preview "enable Apple analytics": what would be requested at App Store Connect',
    description:
      'Reads what Apple already has (no change) and answers the plan with a `confirmHash`. `roleCheck: role_required` means the key may not create report requests (Apple lists the Admin role): use the import instead. `?backfill=true` adds one ONE_TIME_SNAPSHOT for history from 2024-01-01 (Apple allows one a month). Needs `analytics.enabled`.',
    risk: 'read',
    access: { action: 'analytics.manage' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    query: z.object({ backfill: z.enum(['true']).optional() }),
    responses: {
      '200': {
        description: 'The plan.',
        schema: z.object({ plan: enablePlan, confirmHash: z.string(), canCreate: z.boolean() }),
      },
    },
  },
  {
    id: 'enableAppleAnalytics',
    method: 'post',
    path: `${W}/apps/{id}/analytics/apple/enable`,
    tags: ['analytics'],
    summary:
      'Enable Apple analytics: create the report request at App Store Connect (a store write)',
    description:
      'The ONE store write of analytics, explicit and confirmed with the `confirmHash` of the preview. If what Apple has changed since, nothing is sent: `409 plan_changed` with the new plan. A 403 from Apple is `422 analytics_role_required` with `nextStep: import_apple_report`. Audited as `analytics.enable` with ids. Needs `analytics.enabled`.',
    risk: 'write',
    access: { action: 'analytics.manage' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    body: enableBody,
    bodyLimit: 4 * 1024,
    responses: {
      '201': {
        description: 'What was created or adopted.',
        schema: z.object({
          enabled: z.object({
            appleMode: z.literal('ongoing'),
            steps: z.array(
              z.object({
                accessType: z.enum(['ONGOING', 'ONE_TIME_SNAPSHOT']),
                action: z.enum(['create', 'adopt', 'exists']),
                appleRequestId: z.string(),
              }),
            ),
          }),
        }),
      },
    },
  },
  {
    id: 'previewAppleAnalyticsImport',
    method: 'post',
    path: `${W}/apps/{id}/analytics/import/preview`,
    tags: ['analytics'],
    summary: 'Preview an Apple report file: what would be stored (nothing is stored)',
    description:
      importNote +
      ' Answers counts per metric, the days, a few normalised rows and a `confirmHash`.',
    risk: 'read',
    access: { action: 'analytics.manage' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    query: fileQuery,
    bodyLimit: 10 * 1024 * 1024 + 1024,
    responses: {
      '200': {
        description: 'The plan.',
        schema: z.object({ plan: importPlan, confirmHash: z.string() }),
      },
    },
  },
  {
    id: 'importAppleAnalytics',
    method: 'post',
    path: `${W}/apps/{id}/analytics/import`,
    tags: ['analytics'],
    summary: 'Import an Apple report file (the way in when the key may not create report requests)',
    description:
      importNote +
      ' Send the same file with `?confirmHash=` of the preview (`409 confirm_mismatch` otherwise). Idempotent: the same file twice stores nothing new; an imported number never replaces one the API read. Works whether or not `analytics.enabled` is on. Audited as `analytics.import` (ids and counts, never the rows or the file name).',
    risk: 'write',
    access: { action: 'analytics.manage' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    query: fileQuery.extend({
      confirmHash: z.string().describe('The `confirmHash` of the preview (64 hex characters).'),
    }),
    bodyLimit: 10 * 1024 * 1024 + 1024,
    responses: {
      '201': {
        description: 'What was stored.',
        schema: z.object({
          imported: z.object({
            source: z.enum(analyticsSources),
            points: z.number().int(),
            written: z.number().int().describe('Rows inserted or changed.'),
            unchanged: z
              .number()
              .int()
              .describe('Rows that already held this number, or a newer one from the API.'),
            dateFrom: day.nullable(),
            dateTo: day.nullable(),
          }),
        }),
      },
    },
  },
];
