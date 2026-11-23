import { z } from 'zod';
import { type Draft, none, timestamp, W } from '../../operations/shared.ts';
import { adsSyncBody, setAdsLinkBody, termsQuery } from './routes.ts';

/**
 * The operations of Apple Ads (docs/api/apple-ads.md, docs/adr/0058-apple-ads.md). READ ONLY toward Apple: the link calls and the sync read
 * with the chosen credential (audited as `credential.use`) and nothing is ever created or changed in Apple Ads. The views read this
 * server's database only.
 */
const link = z.object({
  appId: z.string(),
  credentialId: z.string(),
  credentialLabel: z.string().nullable().describe('Null when the credential was deleted.'),
  credentialAvailable: z.boolean().describe('False when the credential was deleted or is not an Apple Ads credential: choose another and save again.'),
  adAccountId: z.string(),
  adAccountName: z.string(),
  orgId: z.string().nullable(),
  currency: z.string().nullable().describe('The ad account’s currency: every amount of the app is in it.'),
  timezone: z.string().nullable(),
  adamId: z.string().describe('The Apple id of the promoted app.'),
  verifiedAt: timestamp,
  linkedBy: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

const sync = z.object({
  lastAttemptAt: timestamp.nullable(),
  lastSuccessAt: timestamp.nullable(),
  lastError: z.string().nullable().describe('A fixed sentence, never Apple’s text.'),
  lastErrorCode: z.string().nullable(),
  failureStreak: z.number().int(),
  rangeStart: z.string().nullable().describe('First day of the last read, YYYY-MM-DD.'),
  rangeEnd: z.string().nullable(),
  campaigns: z.number().int(),
  complete: z.boolean().describe('False when a cap ended the read early.'),
  skipped: z.number().int().describe('Rows Apple sent that could not be used.'),
  warnings: z.array(z.string()).describe('cap_campaigns, read_cut, currency_mismatch, no_campaign, popularity_failed, popularity_partial.'),
});

const window = z.object({ from: z.string(), to: z.string() });
const totals = z.object({
  impressions: z.number().int(),
  taps: z.number().int(),
  installs: z.number().int(),
  tapInstalls: z.number().int(),
  spendMicros: z.number().int().describe('Millionths of the currency.'),
  cptMicros: z.number().int().nullable().describe('Spend per tap; null without taps.'),
  cpiMicros: z.number().int().nullable().describe('Spend per install; null without installs.'),
  ttr: z.number().nullable().describe('Taps per impression, 0 to 1.'),
  conversion: z.number().nullable().describe('Installs per tap, 0 to 1.'),
});

const dateQuery = {
  from: z.string().optional().describe('First day, YYYY-MM-DD. Default: 30 days before `to`.'),
  to: z.string().optional().describe('Last day. Default: the end of the last read.'),
};

const appScope = { kind: 'param', name: 'appId' } as const;
const dbNote = 'Reads this server’s database only: Apple Ads is not contacted. Amounts are in the currency of the link. Needs `aso.read`. `422 ads_not_linked` when the app has no link. ';

export const adsOperations: Draft[] = [
  {
    id: 'getAdsLink',
    method: 'get',
    path: `${W}/apps/{appId}/ads`,
    tags: ['ads'],
    summary: 'The Apple Ads account an app is linked to, and the state of the last read',
    description: 'Answers `{ supported, link, sync }`; `link` is null when the app has none and `supported` is false for an app that is not on the App Store. Database only. Needs `apps.read`.',
    risk: 'read',
    access: { action: 'apps.read' },
    appScope,
    responses: { '200': { description: 'The link and the sync state.', schema: z.object({ supported: z.boolean(), link: link.nullable(), sync: sync.nullable() }) } },
  },
  {
    id: 'listAdsAccounts',
    method: 'get',
    path: `${W}/apps/{appId}/ads/accounts`,
    tags: ['ads'],
    summary: 'The Apple Ads accounts a credential may read',
    description: 'READS Apple Ads with the chosen credential (`GET /v1/acls`, audited as `credential.use`, purpose `ads.accounts`) and changes nothing. Needs `apps.write`. Errors: `ads_auth`, `ads_forbidden`, `ads_no_account`, `credential_kind` (422), `rate_limited` (429), `timeout` (504), `ads_unavailable` (502).',
    risk: 'read',
    access: { action: 'apps.write' },
    appScope,
    rateLimited: true,
    query: z.object({ credentialId: z.string().describe('An Apple Ads credential of the workspace.') }),
    responses: { '200': { description: 'The accounts and the roles of the key on each.', schema: z.object({ accounts: z.array(z.object({ id: z.string(), name: z.string(), orgId: z.string().nullable(), roles: z.array(z.string()) })) }) } },
  },
  {
    id: 'setAdsLink',
    method: 'put',
    path: `${W}/apps/{appId}/ads`,
    tags: ['ads'],
    summary: 'Link an app to an Apple Ads account, or change the link',
    description: 'READS Apple Ads with the chosen credential (audited as `credential.use`, purpose `ads.link`) to confirm that the key may read the account; what Apple says (name, currency, time zone) is stored. `adamId` defaults to the app’s store id. Changing the account or the app deletes the rows read for the old one. Nothing is changed at Apple. Needs `apps.write`. Audited as `ads.link_set`.',
    risk: 'write',
    access: { action: 'apps.write' },
    appScope,
    rateLimited: true,
    body: setAdsLinkBody,
    responses: { '200': { description: 'The saved link.', schema: z.object({ link }) } },
  },
  {
    id: 'removeAdsLink',
    method: 'delete',
    path: `${W}/apps/{appId}/ads`,
    tags: ['ads'],
    summary: 'Remove the link of an app to its Apple Ads account',
    description: 'Removes the link and every row read through it; nothing at Apple is changed and the credential stays. `404` when the app has no link. Needs `apps.write`. Audited as `ads.link_remove`.',
    risk: 'destructive',
    access: { action: 'apps.write' },
    appScope,
    responses: { '204': none },
  },
  {
    id: 'syncAds',
    method: 'post',
    path: `${W}/apps/{appId}/ads/sync`,
    tags: ['ads'],
    summary: 'Queue a read of the Apple Ads reports of an app',
    description: 'Queues an `ads.sync` job: the campaign report of the linked account, then the search term and keyword reports of the campaigns that promote the linked app, for the last 14 days (30 on the first read; `days` 1 to 90), ending yesterday. READ ONLY toward Apple. `202 { queued: true, jobId }`, or `200 { queued: false, reason: "already_queued" }`. Needs `apps.sync`.',
    risk: 'write',
    access: { action: 'apps.sync' },
    appScope,
    rateLimited: true,
    body: adsSyncBody,
    bodyOptional: true,
    responses: { '202': { description: 'Queued.', schema: z.object({ queued: z.literal(true), jobId: z.string() }) }, '200': { description: 'Already queued.', schema: z.object({ queued: z.literal(false), reason: z.literal('already_queued') }) } },
  },
  {
    id: 'getAdsOverview',
    method: 'get',
    path: `${W}/apps/{appId}/ads/overview`,
    tags: ['ads'],
    summary: 'Apple Ads totals of an app for a period, against the period before',
    description: dbNote + 'Totals of the window and of the window of the same length just before it, and one point per day with data.',
    risk: 'read',
    access: { action: 'aso.read' },
    appScope,
    query: z.object(dateQuery),
    responses: {
      '200': {
        description: 'The overview.',
        schema: z.object({
          sync: sync.nullable(),
          overview: z.object({
            currency: z.string().nullable(),
            window,
            previousWindow: window,
            totals,
            previous: totals,
            daily: z.array(z.object({ day: z.string(), impressions: z.number().int(), taps: z.number().int(), installs: z.number().int(), spendMicros: z.number().int() })),
            daysWithData: z.number().int(),
            campaigns: z.number().int(),
          }),
        }),
      },
    },
  },
  {
    id: 'listAdsCampaigns',
    method: 'get',
    path: `${W}/apps/{appId}/ads/campaigns`,
    tags: ['ads'],
    summary: 'Apple Ads campaigns of an app for a period',
    description: dbNote + 'Only campaigns that promote the linked app and had activity in the stored range.',
    risk: 'read',
    access: { action: 'aso.read' },
    appScope,
    query: z.object(dateQuery),
    responses: {
      '200': {
        description: 'The campaigns, highest spend first.',
        schema: z.object({
          currency: z.string().nullable(),
          window,
          sync: sync.nullable(),
          campaigns: z.array(totals.extend({ campaignId: z.string(), name: z.string(), status: z.string().nullable(), daysWithData: z.number().int() })),
        }),
      },
    },
  },
  {
    id: 'listAdsTerms',
    method: 'get',
    path: `${W}/apps/{appId}/ads/terms`,
    tags: ['ads'],
    summary: 'Apple Ads search terms or keywords of an app for a period',
    description: dbNote + '`kind=term` (default) is what people searched, `kind=keyword` the bid keywords. One row per term and storefront (`country` is empty when Apple did not say). `tracked` says that a tracked keyword of the app matches. Sort by impressions, taps, installs, spend, cpt, cpi, ttr or term. Apple may hide low-volume terms.',
    risk: 'read',
    access: { action: 'aso.read' },
    appScope,
    query: termsQuery,
    responses: {
      '200': {
        description: 'A page of rows, the total number of rows and the totals of all rows.',
        schema: z.object({
          currency: z.string().nullable(),
          window,
          sync: sync.nullable(),
          kind: z.enum(['term', 'keyword']),
          limit: z.number().int(),
          offset: z.number().int(),
          total: z.number().int(),
          totals,
          rows: z.array(totals.extend({ kind: z.enum(['term', 'keyword']), term: z.string(), termKey: z.string(), country: z.string(), matchType: z.string().nullable(), keywordText: z.string().nullable(), tracked: z.boolean() })),
        }),
      },
    },
  },
];
