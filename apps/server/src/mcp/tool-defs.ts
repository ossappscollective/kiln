import { z } from 'zod';
import type { Operation } from '../operations/openapi.ts';
import { operations } from '../operations/registry.ts';
import { FLAG_ENV, type McpFlags } from './flags.ts';
import type { Limits } from './shape.ts';

/**
 * The tool definitions (docs/adr/0023-mcp-server.md). Each tool is a view of ONE operation of the API registry
 * (services/api-operations.ts): it names the operation and how its arguments map onto the operation's path, query and body.
 * tools.ts runs it through the same HTTP routes as any API client, with the caller's own token.
 *
 * Kinds:
 * - `read` (default): the token must hold the action.
 * - `write`: changes the workspace's own data (triage a review, save a reply DRAFT). The token must NAME the action in its `actions`
 *   list and, where a store feature is involved, the server's switch must be on.
 * - `preview`: shows what a store write would do (publish, submit, release, rollout, internal sharing) and returns the confirmHash
 *   and a link to confirm in the web app. There is NO tool that applies one: confirming needs a passkey or password
 *   (docs/adr/0019-step-up-confirmation.md), which a token cannot give.
 */

export type ToolKind = 'read' | 'write' | 'preview' | 'meta';

export type Query = Record<
  string,
  string | number | boolean | readonly (string | number)[] | undefined
>;

// biome-ignore lint/suspicious/noExplicitAny: route answers are shaped loosely, then capped
export type Json = Record<string, any>;

export type ToolDef = {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  /** The registry operation this tool is a view of. Absent only for `whoami`. */
  op?: string;
  /** Registry path parameter -> argument name. Must cover the operation's path parameters (a test pins it). */
  params?: Record<string, string>;
  input: z.ZodObject<z.ZodRawShape>;
  query?: (args: Json) => Query;
  body?: (args: Json) => unknown;
  /** Reduces the route's answer to what an assistant needs. */
  shape?: (json: Json, args: Json) => unknown;
  /** Names (at any depth) whose strings are third party text and get wrapped. */
  untrusted?: readonly string[];
  /** Names dropped at any depth. */
  drop?: readonly string[];
  limits?: Partial<Limits>;
  flag?: keyof McpFlags;
  /** Where the web app confirms what a `preview` tool showed. */
  link?: 'pending' | 'releases' | 'builds';
};

const id = z
  .string()
  .regex(
    /^[A-Za-z0-9._:-]{1,100}$/,
    'An id: letters, digits, dot, underscore, colon or dash, at most 100.',
  )
  .describe('An id returned by another tool.');
const appId = id.describe('The id of the app (from list_apps).');
const locale = z
  .string()
  .regex(/^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8}){0,2}$/, 'A language tag such as en-US.')
  .describe('A language tag such as en-US.');
const limitOf = (max: number, fallback: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(`How many to return, 1 to ${max} (default ${fallback}).`);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as YYYY-MM-DD.')
  .describe('A date as YYYY-MM-DD.');
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const reviewStatus = z.enum(['new', 'triaged', 'replied_in_console', 'ignored']);

const pick = (source: Json | null | undefined, keys: readonly string[]): Json => {
  const out: Json = {};
  if (!source) return out;
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
};

const REVIEW_TEXT = ['title', 'body', 'authorName', 'internalNote', 'text', 'device'] as const;
const reviewView = (r: Json): Json => ({
  ...pick(r, [
    'id',
    'appId',
    'store',
    'platform',
    'rating',
    'title',
    'body',
    'authorName',
    'territory',
    'language',
    'appVersion',
    'buildNumber',
    'createdAt',
    'updatedAt',
    'status',
    'internalNote',
    'app',
  ]),
  developerResponse: r.developerResponse
    ? pick(r.developerResponse, ['body', 'text', 'lastModified', 'updatedAt'])
    : null,
  replyStatus: r.reply?.status ?? 'none',
  replyDraft: r.replyDraft ? pick(r.replyDraft, ['text', 'status', 'updatedAt']) : null,
});

const appView = (a: Json): Json =>
  pick(a, ['id', 'name', 'platform', 'identifier', 'storeAppId', 'lastSyncedAt', 'lastSyncError']);
const releaseView = (r: Json): Json =>
  pick(r, [
    'id',
    'platform',
    'version',
    'track',
    'build',
    'status',
    'rawState',
    'rolloutFraction',
    'versionCodes',
    'storeUpdatedAt',
    'statusSince',
    'syncedAt',
  ]);

const listingRows = (fields: unknown, withText: boolean) =>
  Object.entries((fields ?? {}) as Record<string, string>).map(([field, text]) => ({
    field,
    length: String(text).length,
    ...(withText ? { text } : {}),
  }));

const readTools: ToolDef[] = [
  {
    name: 'list_apps',
    title: 'List apps',
    kind: 'read',
    op: 'listApps',
    params: {},
    input: strict({}),
    description:
      'The apps of this workspace (a token limited to some apps sees only those): id, name, platform, bundle or package identifier, when the store was last read.',
    shape: (j) => ({ apps: (j.apps ?? []).map(appView) }),
  },
  {
    name: 'get_app',
    title: 'App with its store versions',
    kind: 'read',
    op: 'getApp',
    params: { id: 'appId' },
    input: strict({ appId }),
    description:
      'One app and the versions the store reports for it (version, track, build, state, rollout fraction).',
    shape: (j) => ({ app: appView(j.app ?? {}), releases: (j.releases ?? []).map(releaseView) }),
  },
  {
    name: 'list_releases',
    title: 'Releases and versions of an app',
    kind: 'read',
    op: 'getApp',
    params: { id: 'appId' },
    input: strict({ appId, limit: limitOf(50, 20) }),
    description:
      'The versions of an app as the store reports them: version, track, build, normalized state, rollout fraction.',
    shape: (j, a) => ({ releases: (j.releases ?? []).slice(0, a.limit ?? 20).map(releaseView) }),
  },
  {
    name: 'get_app_status',
    title: 'Where an app is in its release and what comes next',
    kind: 'read',
    op: 'getReleasePipeline',
    params: { id: 'appId' },
    input: strict({ appId }),
    description:
      'The release pipeline of an app: state (idle, ci_running, build_ready, draft, in_review, rejected, approved, rolling_out, live ...), who is waiting on whom (ci, store, you), the steps with their status, stalls, and a one sentence summary. This is the "next step".',
    shape: (j) => ({
      app: j.app,
      pipeline: j.pipeline
        ? {
            ...pick(j.pipeline, [
              'state',
              'waitingOn',
              'since',
              'stalledAfterHours',
              'stalled',
              'summary',
              'steps',
            ]),
            stalls: (j.pipeline.stalls ?? []).map((s: Json) =>
              pick(s, ['step', 'hours', 'stale', 'message', 'label']),
            ),
          }
        : null,
      lastSyncedAt: j.lastSyncedAt,
    }),
  },
  {
    name: 'get_release_overview',
    title: 'Release state of every app',
    kind: 'read',
    op: 'getReleasePipelineSummary',
    params: {},
    input: strict({}),
    description:
      'One line per app: release state, who is waiting, stalled or not. Start here to see which app needs attention.',
  },
  {
    name: 'list_release_candidates',
    title: 'Versions that can be released',
    kind: 'read',
    op: 'listReleaseCandidates',
    params: { id: 'appId' },
    input: strict({
      appId,
      track: z.string().min(1).max(60).optional(),
      version: z.string().min(1).max(60).optional(),
    }),
    description:
      'The versions of an app that are ready to be released (approved on the App Store, or a build on a Google Play track).',
    query: (a) => ({ track: a.track, version: a.version }),
  },
  {
    name: 'get_editable_release',
    title: 'The version being prepared',
    kind: 'read',
    op: 'getEditableRelease',
    params: { id: 'appId' },
    input: strict({ appId, track: z.string().min(1).max(60).optional() }),
    description:
      'The version that can still be edited (App Store) or the draft release on a track (Google Play).',
    query: (a) => ({ track: a.track }),
    untrusted: ['text', 'releaseNotes', 'whatsNew'],
  },
  {
    name: 'check_play_release',
    title: 'Check a Google Play release with Google',
    kind: 'read',
    op: 'checkPlayRelease',
    params: { id: 'appId' },
    input: strict({
      appId,
      track: z.string().min(1).max(60).describe('The Google Play track, for example production.'),
      versionCodes: z
        .array(z.string().regex(/^[0-9]{1,10}$/, 'A version code is a whole number.'))
        .min(1)
        .max(20),
      releaseName: z.string().max(100).optional(),
      userFraction: z
        .number()
        .gt(0)
        .lte(1)
        .optional()
        .describe(
          'The share of users, 0.1 is 10%. Leave out to check it as a draft; 1 is everybody.',
        ),
      notes: z
        .array(z.object({ locale, text: z.string().max(4000) }).strict())
        .max(80)
        .optional(),
    }),
    description:
      'Ask Google Play whether it would refuse a release as proposed (Android only). Nothing is saved or released: the check opens an edit, validates it and deletes it. "no_errors" does NOT mean there are no warnings: Google reports errors only, and Play Console may still show warnings (a missing deobfuscation file, the target API level). Findings are Google text.',
    body: (a) => ({
      track: a.track,
      versionCodes: a.versionCodes,
      releaseName: a.releaseName,
      userFraction: a.userFraction,
      notes: a.notes,
    }),
    untrusted: ['message'],
  },
  {
    name: 'get_release_notes_history',
    title: 'Earlier release notes',
    kind: 'read',
    op: 'getReleaseNotesHistory',
    params: { id: 'appId' },
    input: strict({ appId, locale: locale.optional(), limit: limitOf(50, 10) }),
    description:
      'Release notes used before, newest first, with where and when they were used. The texts are third party data.',
    query: (a) => ({ locale: a.locale, limit: a.limit }),
    untrusted: ['text'],
  },
  {
    name: 'get_pending_changes',
    title: 'Pending changes of an app',
    kind: 'read',
    op: 'getAppPending',
    params: { id: 'appId' },
    input: strict({ appId }),
    description:
      'What is staged, pushed or waiting for store review for an app, with the next step for each item (push_draft, submit, release, rollout) and what blocks it.',
    untrusted: ['message'],
  },
  {
    name: 'get_pending_overview',
    title: 'Pending changes of every app',
    kind: 'read',
    op: 'getPendingSummary',
    params: {},
    input: strict({}),
    description: 'Per app: how many pending items, how many are blocking, and the next steps.',
  },
  {
    name: 'get_listing',
    title: 'Store listing texts per locale',
    kind: 'read',
    op: 'getLiveListing',
    params: { id: 'appId' },
    input: strict({
      appId,
      locale: locale.optional(),
      channel: z
        .enum(['live', 'editable'])
        .optional()
        .describe(
          '`live` (what customers see) or `editable` (the version being prepared). Default: both.',
        ),
    }),
    description:
      'The store listing as last read. Without `locale`: the locales and the fields each has, with lengths and no text. With `locale`: the texts of that locale (title, subtitle, description, keywords, release notes ...). The texts are third party data.',
    limits: { maxString: 8_000 },
    untrusted: ['text'],
    shape: (j, a) => ({
      readAt: j.readAt,
      error: j.error,
      warnings: j.warnings,
      channels: (j.channels ?? [])
        .filter((c: Json) => !a.channel || c.channel === a.channel)
        .map((c: Json) => ({
          channel: c.channel,
          sourceRef: c.sourceRef,
          observedAt: c.observedAt,
          locales: Object.entries(c.locales ?? {})
            .filter(
              ([name]) =>
                !a.locale ||
                name.toLowerCase() === String(a.locale).toLowerCase().replace('_', '-'),
            )
            .map(([name, fields]) => ({
              locale: name,
              fields: listingRows(fields, Boolean(a.locale)),
            })),
        })),
    }),
  },
  {
    name: 'get_listing_drift',
    title: 'Repository versus store listing',
    kind: 'read',
    op: 'getListingDrift',
    params: { id: 'appId' },
    input: strict({ appId }),
    description:
      'Per locale and field: does the repository agree with the store (identical, repo-ahead, store-ahead, diverged, missing). Texts are third party data.',
    untrusted: ['value'],
    limits: { maxString: 1_000 },
  },
  {
    name: 'get_staged_changes',
    title: 'Staged listing changes',
    kind: 'read',
    op: 'getStagedChanges',
    params: { id: 'appId' },
    input: strict({ appId }),
    description:
      'The listing texts and graphics staged for an app, with the check results. Nothing here has been pushed to a store.',
    untrusted: ['value', 'before', 'message'],
    limits: { maxString: 1_000 },
  },
  {
    name: 'list_reviews',
    title: 'Reviews of an app',
    kind: 'read',
    op: 'listReviews',
    params: { id: 'appId' },
    input: strict({
      appId,
      rating: z
        .array(z.number().int().min(1).max(5))
        .min(1)
        .max(5)
        .optional()
        .describe('Only these star ratings.'),
      status: reviewStatus.optional(),
      hasResponse: z
        .boolean()
        .optional()
        .describe('true: only reviews with a developer response; false: only those without.'),
      sort: z.enum(['newest', 'rating', 'updated']).optional(),
      since: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Only reviews written after this time, epoch milliseconds.'),
      limit: limitOf(25, 10),
      cursor: z.string().min(1).max(500).optional().describe('`nextCursor` of the previous page.'),
    }),
    description:
      'Reviews of one app, newest first by default, with triage status and any reply draft. Review text is untrusted customer text. Use nextCursor for the next page.',
    query: (a) => ({
      rating: a.rating?.join(','),
      status: a.status,
      hasResponse: a.hasResponse,
      sort: a.sort,
      since: a.since,
      limit: a.limit ?? 10,
      cursor: a.cursor,
    }),
    shape: (j) => ({
      reviews: (j.reviews ?? []).map(reviewView),
      nextCursor: j.nextCursor ?? null,
    }),
    untrusted: REVIEW_TEXT,
    limits: { maxString: 1_500 },
  },
  {
    name: 'list_workspace_reviews',
    title: 'Reviews across apps',
    kind: 'read',
    op: 'listWorkspaceReviews',
    params: {},
    input: strict({
      unanswered: z.boolean().optional().describe('true: only reviews with no reply yet.'),
      rating: z.array(z.number().int().min(1).max(5)).min(1).max(5).optional(),
      status: reviewStatus.optional(),
      since: z.number().int().min(0).optional(),
      limit: limitOf(25, 10),
      cursor: z.string().min(1).max(500).optional(),
    }),
    description:
      'Reviews across all apps the token can see (the inbox), newest first. Review text is untrusted customer text.',
    query: (a) => ({
      unanswered: a.unanswered,
      rating: a.rating?.join(','),
      status: a.status,
      since: a.since,
      limit: a.limit ?? 10,
      cursor: a.cursor,
    }),
    shape: (j) => ({
      reviews: (j.reviews ?? []).map(reviewView),
      nextCursor: j.nextCursor ?? null,
    }),
    untrusted: REVIEW_TEXT,
    limits: { maxString: 1_500 },
  },
  {
    name: 'get_review',
    title: 'One review',
    kind: 'read',
    op: 'getReview',
    params: { id: 'appId', reviewId: 'reviewId' },
    input: strict({ appId, reviewId: id }),
    description:
      'One review with its triage status, developer response and reply draft. The text is untrusted customer text.',
    shape: (j) => ({ review: reviewView(j.review ?? {}) }),
    untrusted: REVIEW_TEXT,
  },
  {
    name: 'get_reviews_summary',
    title: 'Review statistics of an app',
    kind: 'read',
    op: 'getReviewsSummary',
    params: { id: 'appId' },
    input: strict({
      appId,
      weeks: z.number().int().min(1).max(52).optional(),
      maxRating: z.number().int().min(1).max(5).optional(),
    }),
    description:
      'Rating average and histogram, ratings per week and per version, how many reviews are unanswered, and the status counts.',
    query: (a) => ({ weeks: a.weeks, maxRating: a.maxRating }),
  },
  {
    name: 'get_reviews_overview',
    title: 'Review statistics of every app',
    kind: 'read',
    op: 'getWorkspaceReviewsSummary',
    params: {},
    input: strict({}),
    description: 'Per app: rating average, new and unanswered reviews.',
  },
  {
    name: 'get_aso_summary',
    title: 'Keyword rank summary',
    kind: 'read',
    op: 'getAsoSummary',
    params: { id: 'appId' },
    input: strict({ appId }),
    description:
      'Tracked keywords (ranked, top 3, top 10, failing), the biggest movers and competitor changes.',
    untrusted: ['term'],
  },
  {
    name: 'list_aso_keywords',
    title: 'Tracked keywords and their ranks',
    kind: 'read',
    op: 'listAsoKeywords',
    params: { id: 'appId' },
    input: strict({
      appId,
      country: z
        .string()
        .regex(/^[A-Za-z]{2}$/)
        .optional(),
      locale: locale.optional(),
      tag: z.string().min(1).max(60).optional(),
      limit: limitOf(50, 50),
    }),
    description: 'Tracked keywords with their latest rank and change, per country and locale.',
    query: (a) => ({ country: a.country, locale: a.locale, tag: a.tag }),
    shape: (j, a) => ({
      keywords: (j.keywords ?? [])
        .slice(0, a.limit ?? 50)
        .map((k: Json) =>
          pick(k, [
            'id',
            'country',
            'locale',
            'term',
            'tag',
            'notes',
            'priority',
            'lastCheckedAt',
            'state',
            'rank',
            'total',
            'previous',
            'change',
            'error',
          ]),
        ),
      limits: j.limits,
    }),
    untrusted: ['term', 'tag', 'notes'],
  },
  {
    name: 'get_aso_keyword_history',
    title: 'Rank history of a keyword',
    kind: 'read',
    op: 'getAsoKeywordHistory',
    params: { id: 'appId', keywordId: 'keywordId' },
    input: strict({ appId, keywordId: id, limit: limitOf(100, 30) }),
    description: 'The rank of one tracked keyword over time.',
    query: (a) => ({ limit: a.limit }),
    untrusted: ['term'],
  },
  {
    name: 'list_aso_competitors',
    title: 'Tracked competitors',
    kind: 'read',
    op: 'listAsoCompetitors',
    params: { id: 'appId' },
    input: strict({ appId }),
    description:
      'Competitor apps that are tracked, with their latest listing snapshot. Names and texts are third party text.',
    untrusted: ['name', 'title', 'subtitle', 'description', 'latest'],
    limits: { maxString: 600 },
  },
  {
    name: 'get_aso_coach',
    title: 'ASO suggestions',
    kind: 'read',
    op: 'getAsoCoach',
    params: { id: 'appId' },
    input: strict({ appId }),
    description:
      "Ordered, rule based actions for the app's store search listing (rank drops, keywords missing from the listing, wasted keyword characters, untapped locales).",
    untrusted: ['items', 'detail', 'title'],
  },
  {
    name: 'get_aso_gaps',
    title: 'Keywords competitors use that the app does not',
    kind: 'read',
    op: 'getAsoGaps',
    params: { id: 'appId' },
    input: strict({ appId, locale: locale.optional(), limit: limitOf(100, 30) }),
    description:
      "Terms that tracked competitors use in their listings and this app's listing lacks.",
    query: (a) => ({ locale: a.locale, limit: a.limit }),
    untrusted: ['term', 'terms', 'apps'],
  },
  {
    name: 'get_analytics_overview',
    title: 'Analytics series of an app',
    kind: 'read',
    op: 'getAppAnalyticsOverview',
    params: { id: 'appId' },
    input: strict({
      appId,
      from: day.optional(),
      to: day.optional(),
      granularity: z.enum(['day', 'week', 'month']).optional(),
      platform: z.enum(['ios', 'macos', 'android']).optional(),
    }),
    description:
      'Daily, weekly or monthly metrics from the stores (impressions, downloads, sessions, crashes, ratings, Apple proceeds, Google Play estimated sales which are what buyers paid and not proceeds, ...) with totals and data coverage. Money is per currency and never converted. Default granularity: week.',
    query: (a) => ({
      from: a.from,
      to: a.to,
      granularity: a.granularity ?? 'week',
      platform: a.platform,
    }),
  },
  {
    name: 'get_analytics_status',
    title: 'Analytics data sources of an app',
    kind: 'read',
    op: 'getAppAnalyticsStatus',
    params: { id: 'appId' },
    input: strict({ appId }),
    description:
      'Which analytics sources are set up, when they were last read and whether they failed.',
  },
  {
    name: 'get_analytics_product_sales',
    title: 'Sales of an app by store product',
    kind: 'read',
    op: 'getAppAnalyticsProductSales',
    params: { id: 'appId' },
    input: strict({ appId, from: day.optional(), to: day.optional() }),
    description:
      'Sales by product id (SKU) from stored analytics, default the last 28 days: units or orders and amounts per currency, never added across currencies. `measure` says what the amount is: Apple developer proceeds, or a Google Play estimate of what buyers paid (not proceeds). Empty with `hasSalesData: false` until sales are set up.',
    query: (a) => ({ from: a.from, to: a.to }),
  },
  {
    name: 'list_build_artifacts',
    title: 'Test builds of an app (links only)',
    kind: 'read',
    op: 'listBuildArtifacts',
    params: { id: 'appId' },
    input: strict({ appId }),
    description:
      'CI build artifacts and store builds (TestFlight, Google Play tracks) of an app, with the CI run link and the opt-in link. Binaries are never returned and cannot be downloaded through this server.',
    untrusted: ['title', 'branch'],
    limits: { maxString: 300 },
  },
  {
    name: 'list_builds',
    title: 'Builds of an app',
    kind: 'read',
    op: 'listBuilds',
    params: { id: 'appId' },
    input: strict({ appId }),
    description: 'Builds of an app known from the stores and from CI, with their state.',
    untrusted: ['title', 'branch'],
    limits: { maxString: 300 },
  },
  {
    name: 'list_internal_shares',
    title: 'Google Play internal shares',
    kind: 'read',
    op: 'listInternalShares',
    params: { id: 'appId' },
    input: strict({ appId }),
    description:
      'Builds that were handed to Google Play internal app sharing: package, size, when it expires, whether a link exists. The link itself is shown in the web app only.',
    drop: ['downloadUrl'],
  },
  {
    name: 'list_release_plans',
    title: 'Release plans and checklists',
    kind: 'read',
    op: 'listAppPlans',
    params: { id: 'appId' },
    input: strict({ appId }),
    description: 'The release plans of an app with their checklist items and rollout steps.',
    untrusted: ['notes', 'text', 'note'],
    limits: { maxString: 800 },
  },
  {
    name: 'list_events',
    title: 'Recent activity',
    kind: 'read',
    op: 'listEvents',
    params: {},
    input: strict({
      since: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Only events with an id above this (the nextCursor of the previous call).'),
      limit: limitOf(50, 20),
      type: z
        .string()
        .regex(/^[a-z_.,]{1,300}$/)
        .optional()
        .describe('Comma separated event types.'),
    }),
    description:
      'What happened lately: syncs, status changes, new low ratings, change sets, rollouts. Oldest first from `since`; without it the newest events.',
    query: (a) => ({ since: a.since, limit: a.limit ?? 20, type: a.type }),
  },
  // ----- writes: the workspace's own data, never a store ---------------------------------------
  {
    name: 'triage_review',
    title: 'Triage a review',
    kind: 'write',
    op: 'triageReview',
    params: { id: 'appId', reviewId: 'reviewId' },
    input: strict({
      appId,
      reviewId: id,
      status: reviewStatus.optional(),
      internalNote: z
        .string()
        .max(2_000)
        .nullable()
        .optional()
        .describe('An internal note, never sent to the store. null clears it.'),
    }),
    description:
      "Mark a review (new, triaged, replied_in_console, ignored) and/or set an internal note. Only the workspace's own data changes; nothing reaches a store. Needs the token to name reviews.triage.",
    body: (a) => ({
      ...(a.status !== undefined ? { status: a.status } : {}),
      ...(a.internalNote !== undefined ? { internalNote: a.internalNote } : {}),
    }),
    shape: (j) => ({ review: reviewView(j.review ?? {}) }),
    untrusted: REVIEW_TEXT,
  },
  {
    name: 'save_reply_draft',
    title: 'Save a reply draft for a review',
    kind: 'write',
    op: 'saveReviewReplyDraft',
    params: { id: 'appId', reviewId: 'reviewId' },
    flag: 'reviewReply',
    input: strict({
      appId,
      reviewId: id,
      text: z.string().min(1).max(5_000).describe('The proposed reply.'),
    }),
    description:
      'Save a SUGGESTED reply as a draft in the app. It is NOT sent: a person reviews it in the web app and sends it there. Needs the token to name reviews.triage and the server switch MRM_REVIEW_REPLY_ENABLED.',
    body: (a) => ({ text: a.text }),
    shape: (j) => ({
      draft: pick(j.draft ?? {}, [
        'id',
        'reviewId',
        'text',
        'length',
        'limit',
        'status',
        'updatedAt',
      ]),
      sent: false,
    }),
    untrusted: ['text'],
  },
];

// ---------------------------------------------------------------------------------------------
// Preview tools: their arguments are the operation's own body schema, so they cannot drift from the API.

const registry = new Map<string, Operation>(operations.map((o) => [o.id, o]));

const bodyShape = (operation: Operation | undefined): z.ZodRawShape => {
  let schema = operation?.body as z.ZodTypeAny | undefined;
  for (let i = 0; schema && i < 4; i++) {
    if (schema instanceof z.ZodOptional) schema = schema._def.innerType;
    else if (schema instanceof z.ZodEffects) schema = schema._def.schema;
    else break;
  }
  return schema instanceof z.ZodObject ? (schema.shape as z.ZodRawShape) : {};
};

function previewTool(def: {
  name: string;
  title: string;
  description: string;
  op: string;
  params: Record<string, string>;
  flag: keyof McpFlags;
  link: NonNullable<ToolDef['link']>;
}): ToolDef {
  const pathArgs = Object.values(def.params);
  const shape: z.ZodRawShape = {};
  for (const arg of pathArgs) shape[arg] = arg === 'appId' ? appId : id;
  for (const [key, value] of Object.entries(bodyShape(registry.get(def.op)))) shape[key] = value;
  return {
    name: def.name,
    title: def.title,
    kind: 'preview',
    op: def.op,
    params: def.params,
    flag: def.flag,
    link: def.link,
    description: `${def.description} PREVIEW ONLY: nothing is changed. Returns the preview, a confirmHash and a link; a person confirms in the web app (API tokens cannot confirm). Needs the token to name the action explicitly and the server switch ${FLAG_ENV[def.flag]}.`,
    input: z.object(shape).strict(),
    body: (a) => Object.fromEntries(Object.entries(a).filter(([key]) => !pathArgs.includes(key))),
    untrusted: ['message', 'value', 'before', 'after', 'label', 'title'],
    limits: { maxString: 600 },
  };
}

const previewTools: ToolDef[] = [
  previewTool({
    name: 'preview_rollout',
    title: 'Preview a rollout change',
    op: 'previewRollout',
    params: { id: 'appId' },
    flag: 'storeRollout',
    link: 'releases',
    description:
      'Show what changing the staged rollout of the live release (increase, halt, resume, release to everyone) would do.',
  }),
  previewTool({
    name: 'preview_store_release',
    title: 'Preview releasing a version',
    op: 'previewStoreRelease',
    params: { id: 'appId' },
    flag: 'storeRelease',
    link: 'releases',
    description:
      'Show what releasing an approved version to users (App Store) or starting a Google Play release would do.',
  }),
  previewTool({
    name: 'preview_store_submit',
    title: 'Preview submitting for review',
    op: 'previewStoreSubmit',
    params: { id: 'appId' },
    flag: 'storeSubmit',
    link: 'pending',
    description: 'Show what submitting the editable version for store review would do.',
  }),
  previewTool({
    name: 'preview_staged_push',
    title: 'Preview pushing staged listing changes',
    op: 'previewStagedPush',
    params: { id: 'appId' },
    flag: 'storeDraft',
    link: 'pending',
    description:
      'Show what writing the staged listing texts and graphics into the store draft would do.',
  }),
  previewTool({
    name: 'preview_publish_batch',
    title: 'Preview a batch publish',
    op: 'previewStoreBatch',
    params: { id: 'appId' },
    flag: 'storePublish',
    link: 'pending',
    description:
      'Show what running several steps (push the draft, submit, release, rollout) in one confirmed batch would do.',
  }),
  previewTool({
    name: 'preview_internal_share',
    title: 'Preview a Google Play internal share',
    op: 'previewInternalShare',
    params: { id: 'appId', artifactId: 'artifactId' },
    flag: 'internalSharing',
    link: 'builds',
    description: 'Show what uploading a CI build to Google Play internal app sharing would do.',
  }),
];

const whoami: ToolDef = {
  name: 'whoami',
  title: 'What this token may do',
  kind: 'meta',
  input: strict({}),
  description:
    'The name and limits of the token in use, which write and preview tools are available, and which server switches are off. No secret is shown.',
};

export const tools: readonly ToolDef[] = [whoami, ...readTools, ...previewTools];
export const operationById = registry;
