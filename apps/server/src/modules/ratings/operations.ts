import { z } from 'zod';
import { type Draft, reviewStore, W } from '../../operations/shared.ts';

/** The operations of the ratings history and app health (docs/api/ratings.md, docs/api/health.md). The registry (operations/registry.ts) lists them. */

const day = z.string().describe('YYYY-MM-DD, UTC.');
const stars = z.array(z.number().int()).length(5).describe('Ratings with 1, 2, 3, 4 and 5 stars.');
const rate = z.object({
  rate: z.number().nullable().describe('App Store: crashes per session. Google Play: share of users. Null with nothing to divide by.'),
  volume: z.number().describe('Sessions (App Store) or user-days (Google Play): the more, the steadier the rate.'),
  events: z.number().optional().describe('App Store: the crashes counted.'),
  days: z.number().int().optional().describe('App Store: days with sessions.'),
  coveredDays: z.number().int().optional().describe('App Store: of those, the days a crash file answered for. Only those are counted.'),
  steady: z.boolean().describe('Enough sessions or users (200), and on the App Store crash numbers for 75% of the days, to compare with another version.'),
});

export const ratingsOperations: Draft[] = [
  {
    id: 'getAppRatings',
    method: 'get',
    path: `${W}/apps/{appId}/ratings`,
    tags: ['ratings'],
    summary: 'The rating of an app over time (Kiln’s own daily record), new ratings, and written reviews by stars',
    description:
      'Reads stored data; asks no store. The stores only say what a rating is now, so Kiln keeps a row per day, store and country from the first day a read saw it (App Store: the iTunes lookup, a few countries per sync; Google Play: the daily and total average of the Cloud Storage reports, no count and no stars). New ratings are the difference between two readings of a country; `newUnknown` is the share whose stars the readings cannot tell. `country` is `all` or a two letter code from `countries`; `granularity` day, week or month; `days` 7 to 730 (default 90). Needs `reviews.read`.',
    risk: 'read',
    access: { action: 'reviews.read' },
    appScope: { kind: 'param', name: 'appId' },
    query: z.object({
      country: z.string().regex(/^(all|[A-Za-z]{2}|ALL)$/).optional(),
      granularity: z.enum(['day', 'week', 'month']).optional(),
      days: z.number().int().min(7).max(730).optional(),
    }),
    responses: {
      '200': {
        description: 'The history in buckets, the countries, the summary and the written reviews by stars.',
        schema: z.object({
          store: reviewStore,
          from: day,
          to: day,
          granularity: z.enum(['day', 'week', 'month']),
          country: z.string(),
          countries: z.array(
            z.object({ territory: z.string(), average: z.number(), count: z.number().nullable(), newCount: z.number().int(), newAverage: z.number().nullable(), change: z.number().nullable(), day }),
          ),
          historyStart: day.nullable(),
          capabilities: z.object({ count: z.boolean(), stars: z.boolean() }),
          summary: z.object({
            average: z.number().nullable(),
            count: z.number().nullable(),
            newCount: z.number().int(),
            newRatingsKnown: z.boolean().describe('False until two days of readings exist: new ratings need a difference.'),
            written: z.object({ count: z.number().int(), stars, average: z.number().nullable() }),
          }),
          buckets: z.array(
            z.object({
              start: day,
              end: day,
              count: z.number().nullable(),
              average: z.number().nullable(),
              newCount: z.number().int(),
              newAverage: z.number().nullable(),
              newStars: stars.nullable(),
              newUnknown: z.number().int(),
              dayAverage: z.number().nullable(),
              reset: z.boolean(),
              spansGap: z.boolean(),
            }),
          ),
          written: z.array(z.object({ start: day, end: day, stars, count: z.number().int(), average: z.number().nullable() })),
        }),
      },
    },
  },
  {
    id: 'getAppHealth',
    method: 'get',
    path: `${W}/apps/{appId}/health`,
    tags: ['ratings'],
    summary: 'Crashes and freezes of an app by day and by version, from the stored analytics, with the reviews that mention crashes',
    description:
      'Reads stored data; asks no store. App Store: crashes per session from App Analytics (opted-in people only; Apple sends crash numbers only for days with at least five crashing users, so a day without them is not a day without crashes); no freeze numbers. Google Play: user-perceived crash and ANR rate from Android vitals (needs the Play Developer Reporting API turned on: see `setup`). `finding` is the one regression rule of docs/api/health.md. Needs `reviews.read`.',
    risk: 'read',
    access: { action: 'reviews.read' },
    appScope: { kind: 'param', name: 'appId' },
    query: z.object({ days: z.number().int().min(7).max(730).optional() }),
    responses: {
      '200': {
        description: 'Daily rates, the versions newest first, and the finding.',
        schema: z.object({
          store: reviewStore,
          from: day,
          to: day,
          unit: z.enum(['perSessions', 'share']),
          setup: z.object({ setupCode: z.string().nullable(), lastErrorCode: z.string().nullable(), lastOkAt: z.number().nullable() }).nullable(),
          hasData: z.boolean(),
          days: z.array(z.object({ day, crash: z.number().nullable(), freeze: z.number().nullable(), crashMentions: z.number().int() })),
          versions: z.array(
            z.object({
              version: z.string().describe('Apple’s version string, or Google’s build number (versionCode).'),
              name: z.string().nullable().describe('Google Play: the version its reviews name for the build; null when nobody reviewed the build.'),
              from: day,
              to: day,
              crash: rate,
              freeze: rate.nullable(),
              change: z.object({ kind: z.enum(['worse', 'better']), previous: z.string(), before: z.number(), after: z.number(), overLine: z.boolean() }).nullable(),
              reviews: z.number().int(),
              crashReviews: z.number().int(),
            }),
          ),
          finding: z
            .object({
              kind: z.enum(['worse', 'better']),
              measure: z.enum(['crash', 'freeze']),
              version: z.string(),
              name: z.string().nullable(),
              previous: z.string(),
              before: z.number(),
              after: z.number(),
              overLine: z.boolean(),
              from: day,
              to: day,
              mentions: z.number().int().describe('Reviews of that version since it appeared that mention crashes: the list opens with the Reviews filter `mentions=crash`.'),
            })
            .nullable(),
        }),
      },
    },
  },
];
