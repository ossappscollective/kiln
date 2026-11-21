import { rankDownloadsNoteCodes } from '@kiln/core';
import { z } from 'zod';
import type { Operation } from '../../operations/openapi.ts';
import { searchTermNoteCodes } from '../../services/play-search-terms.ts';

/**
 * The operations of Google Play search terms and of rank versus downloads (docs/api/aso.md), in their own file and added to the registry in
 * api-operations.ts. Importing a file needs `analytics.manage` (admins and owners, explicit-only for tokens); reading needs `aso.read`. A
 * search term is never in a log, an audit row, an event or a job: the audit entry has ids and counts.
 */

const W = '/api/workspaces/{workspaceId}';
const day = z.string().describe('A day, YYYY-MM-DD.');
const timestamp = z.number().int().describe('Epoch milliseconds.');
const nullableCount = z
  .number()
  .nullable()
  .describe('null: the file had no such column (null is not zero).');

const stats = z.object({
  rowsRead: z.number().int(),
  rowsUsed: z.number().int(),
  rowsUnreadable: z.number().int(),
  rowsFiltered: z
    .number()
    .int()
    .describe('Left out on purpose: another traffic source, or no term.'),
  rowsOther: z.number().int().describe('Rows of the `Other` line.'),
});

const plan = z.object({
  platform: z.literal('android'),
  report: z.object({ kind: z.literal('play_search_terms'), label: z.string() }),
  stats,
  dateFrom: day.nullable(),
  dateTo: day.nullable(),
  hasDates: z
    .boolean()
    .describe('The file had its own dates. When false, `period` is the one the request gave.'),
  period: z.object({ from: day, to: day }).nullable(),
  days: z.number().int(),
  rows: z.number().int().describe('Rows that would be stored.'),
  terms: z.number().int().describe('Distinct terms, without the `Other` line.'),
  countries: z.array(z.string()).describe('Two letter storefronts seen in the file.'),
  files: z.number().int().describe('Tables read (a zip can hold several).'),
  totals: z.object({ visitors: nullableCount, installs: nullableCount }),
  other: z
    .object({ visitors: nullableCount, installs: nullableCount })
    .nullable()
    .describe('The `Other` line: terms Google grouped because each was too small to report.'),
  top: z
    .array(
      z.object({
        term: z.string(),
        visitors: nullableCount,
        installs: nullableCount,
        conversion: z.number().nullable(),
      }),
    )
    .describe('The ten terms with most installs. This is the one place a preview shows terms.'),
  overlapsStored: z
    .number()
    .int()
    .describe(
      'Stored periods of the same country that overlap the file and are not the same periods.',
    ),
  notes: z.array(z.string()),
});

const fileNote =
  'The request body IS the file: the CSV of "Export report" on a Play Console store listing page, a monthly `store_performance` file, or a .zip or .gz of those (any content type). At most 10 MiB, 64 MiB unpacked, 100,000 stored rows. Columns are matched by name; UTF-8 and UTF-16. A file with no date column needs `from` and `to` (the days it covers, at most 400). Errors (422): `file_too_large`, `bad_gzip`, `bad_zip`, `bad_format`, `missing_columns`, `period_required`, `no_rows`, `import_not_supported` (an iOS or macOS app).';
const periodQuery = z.object({
  from: z
    .string()
    .optional()
    .describe('The first day the file covers. Needed with `to` when the file has no date column.'),
  to: z.string().optional(),
});

const insight = z.object({
  key: z.string().describe('The folded words of the term (the key of a tracked keyword).'),
  term: z.string(),
  visitors: nullableCount,
  installs: nullableCount,
  conversion: z
    .number()
    .nullable()
    .describe(
      'Installs over visitors for the period when every row has both; else the file’s own figure for a single row; else null.',
    ),
  countries: z.array(z.string()),
  rows: z.number().int(),
  trackedKeywordId: z
    .string()
    .nullable()
    .describe(
      'A tracked keyword for this term in the chosen storefront (any storefront when none is chosen).',
    ),
  trackedCountries: z.array(z.string()),
  listing: z
    .enum(['in_listing', 'partly', 'not_in_listing', 'unknown'])
    .describe(
      'Against the stored Google Play listing text of the locale; `unknown` when no text is stored.',
    ),
  inFields: z
    .array(z.string())
    .describe('The listing fields that hold at least one word of the term.'),
  hint: z
    .enum(['add_to_listing'])
    .nullable()
    .describe(
      'The term brought installs and the stored listing text does not hold all of it. A suggestion for a person to weigh, not a finding.',
    ),
});

const searchTermsView = z.object({
  appId: z.string(),
  platform: z.literal('android'),
  from: day.nullable(),
  to: day.nullable(),
  country: z.string().nullable(),
  sort: z.enum(['installs', 'visitors']),
  locale: z.string(),
  listingLocale: z.string().nullable(),
  listingReadAt: timestamp.nullable(),
  imported: z
    .object({
      at: timestamp,
      periodFrom: day.nullable(),
      periodTo: day.nullable(),
      imports: z.number().int(),
    })
    .nullable()
    .describe('The latest import; null when nothing was imported yet.'),
  stored: z
    .object({ from: day, to: day, countries: z.array(z.string()), rows: z.number().int() })
    .nullable(),
  terms: z.array(insight),
  termCount: z.number().int().describe('Terms before the limit.'),
  other: z.object({ visitors: nullableCount, installs: nullableCount }).nullable(),
  totals: z.object({ visitors: nullableCount, installs: nullableCount }),
  notes: z.array(z.object({ code: z.enum(searchTermNoteCodes), message: z.string() })),
});

const comparisonWindow = z.object({
  from: day,
  to: day,
  days: z.number().int().describe('Days of the window that have a number.'),
  total: z.number().nullable(),
  perDay: z.number().nullable(),
});
const marker = z.object({
  keywordId: z.string(),
  day,
  previousDay: day,
  kind: z.enum(['up', 'down', 'entered', 'dropped']),
  from: z.number().int().nullable(),
  to: z.number().int().nullable(),
  delta: z.number().int().nullable(),
});

const rankVsDownloads = z.object({
  appId: z.string(),
  platform: z.enum(['ios', 'macos', 'android']),
  country: z.string().nullable(),
  from: day,
  to: day,
  days: z.array(day),
  keywords: z.array(
    z.object({
      id: z.string(),
      term: z.string(),
      samples: z
        .array(
          z
            .object({
              rank: z
                .number()
                .int()
                .nullable()
                .describe('null: checked, not within the first `total` results.'),
              total: z.number().int(),
            })
            .nullable(),
        )
        .describe('One per day; null is a day with no check (a gap, not "not ranked").'),
      checkDays: z.number().int(),
    }),
  ),
  downloads: z
    .object({
      metric: z.string(),
      label: z.string(),
      source: z.enum(['apple', 'play']),
      delayDays: z.number().int(),
      values: z
        .array(z.number().nullable())
        .describe('One per day; null is a day with no number (never zero).'),
      settledThrough: day.describe('Days after this may still change.'),
      days: z.number().int(),
    })
    .nullable(),
  markers: z
    .array(marker)
    .describe(
      'Rank moves of at least `threshold` places, or entering or leaving the top 10. Empty unless `enough`.',
    ),
  comparisons: z.array(
    z.object({
      marker,
      status: z.enum(['ok', 'waiting', 'too_few_days']),
      before: comparisonWindow,
      after: comparisonWindow,
      changePercent: z
        .number()
        .nullable()
        .describe(
          'Percent change of the daily average, one decimal. A correlation, not proof. Null unless `status` is ok and there was something before.',
        ),
      checkGapDays: z.number().int(),
      overlapsOtherMove: z.boolean(),
      settledNeededThrough: day.nullable(),
    }),
  ),
  coverage: z.object({
    rankDays: z.number().int(),
    downloadDays: z.number().int(),
    minDays: z.number().int(),
  }),
  enough: z
    .boolean()
    .describe(
      'At least 14 days of both series. Without it a client shows no chart and no comparison.',
    ),
  missing: z.enum(['turn_on_analytics', 'no_downloads', 'no_rank_checks']).nullable(),
  threshold: z.number().int(),
  windowDays: z.number().int(),
  notes: z.array(z.object({ code: z.enum(rankDownloadsNoteCodes), message: z.string() })),
  available: z.array(
    z.object({
      id: z.string(),
      term: z.string(),
      locale: z.string(),
      priority: z.number().int(),
      checks: z.number().int(),
      lastCheckedAt: timestamp.nullable(),
    }),
  ),
  selected: z.array(z.string()),
});

export const searchTermsOperations: Operation[] = [
  {
    id: 'previewPlaySearchTermsImport',
    method: 'post',
    path: `${W}/apps/{id}/analytics/search-terms/import/preview`,
    tags: ['analytics'],
    summary: 'Preview a Google Play search terms export: what would be stored (nothing is stored)',
    description: `${fileNote} Answers counts, the dates, the ten terms with most installs and a \`confirmHash\`. Works whether or not \`analytics.enabled\` is on: no store is contacted.`,
    risk: 'read',
    access: { action: 'analytics.manage' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    query: periodQuery,
    bodyLimit: 10 * 1024 * 1024 + 1024,
    responses: {
      '200': { description: 'The plan.', schema: z.object({ plan, confirmHash: z.string() }) },
    },
  },
  {
    id: 'importPlaySearchTerms',
    method: 'post',
    path: `${W}/apps/{id}/analytics/search-terms/import`,
    tags: ['analytics'],
    summary: 'Import a Google Play search terms export',
    description: `${fileNote} Send the same file (and period) with \`?confirmHash=\` of the preview (\`409 confirm_mismatch\` otherwise). Idempotent: the same file twice stores nothing new (\`written: 0\`); a corrected file replaces the rows with the same country, period and term. Audited as \`analytics.search_terms_import\` with ids and counts: never a term, a row or the file name.`,
    risk: 'write',
    access: { action: 'analytics.manage' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    query: periodQuery.extend({
      confirmHash: z.string().describe('The `confirmHash` of the preview (64 hex characters).'),
    }),
    bodyLimit: 10 * 1024 * 1024 + 1024,
    responses: {
      '201': {
        description: 'What was stored.',
        schema: z.object({
          imported: z.object({
            rows: z.number().int(),
            written: z.number().int().describe('Rows inserted or changed.'),
            unchanged: z.number().int(),
            dateFrom: day.nullable(),
            dateTo: day.nullable(),
          }),
        }),
      },
    },
  },
  {
    id: 'getAsoSearchTerms',
    method: 'get',
    path: `${W}/apps/{id}/aso/search-terms`,
    tags: ['aso'],
    summary: 'The top Google Play search terms of a period, with tracked and in-the-listing marks',
    description: `Reads this server’s database only (the imported file and the stored listing text); no store is contacted. Google Play apps only (\`422 not_google_play_app\`). Terms people searched and then opened the listing from: NOT a search volume. \`from\` and \`to\` default to everything stored (at most the newest 400 days); a row counts only when its whole period is inside. \`country\` limits to one storefront (rows of a file with no country are left out then). \`locale\` picks the language of the listing text the terms are checked against (default: the locale most tracked keywords use). \`hint: add_to_listing\` marks a term that brought installs and is not fully in the stored listing: a suggestion, no prediction. Terms are in the answer of this route and in the table, nowhere else.`,
    risk: 'read',
    access: { action: 'aso.read' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      country: z.string().optional(),
      locale: z.string().optional(),
      sort: z.enum(['installs', 'visitors']).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    responses: { '200': { description: 'The terms.', schema: searchTermsView } },
  },
  {
    id: 'getAsoRankVsDownloads',
    method: 'get',
    path: `${W}/apps/{id}/aso/rank-vs-downloads`,
    tags: ['aso'],
    summary: 'Rank history of tracked keywords next to the app’s downloads on the same days',
    description: `Reads this server’s database only (rank checks and stored analytics); works with whatever analytics source is on. One storefront (\`country\`, default: the one with most tracked keywords), at most 5 \`keywords\` (comma separated ids; default: the 3 with most checks in the range), \`from\` and \`to\` (default: the 90 days up to yesterday; at most 400). Downloads: first-time downloads of the Apple Analytics Reports, else Sales and Trends units; Android user installs of the Play reports, else device installs. Markers use the setting \`aso.rankMoveThreshold\`. For each marker \`comparisons\` give the downloads per day in the 7 days before the earlier check and the 7 days after the later one, the number of days counted, and the percent change: a CORRELATION, NOT PROOF (other things move downloads too). A comparison waits (\`waiting\`) until the store has settled the days after the move (Apple about 2 days, Play files 3 to 7). With fewer than 14 days of either series \`enough\` is false and markers and comparisons are empty; \`missing\` says what to turn on.`,
    risk: 'read',
    access: { action: 'aso.read' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({
      platform: z.enum(['ios', 'macos', 'android']).optional(),
      country: z.string().optional(),
      keywords: z.string().optional().describe('Keyword ids, comma separated, at most 5.'),
      from: z.string().optional(),
      to: z.string().optional(),
    }),
    responses: {
      '200': {
        description: 'The aligned series, markers and comparisons.',
        schema: rankVsDownloads,
      },
    },
  },
];
