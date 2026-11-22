import { byFamily, type Platform } from './platform.ts';
/**
 * Analytics vocabulary shared by the server, the connectors and the web UI (docs/adr/0017-analytics-foundation.md,
 * docs/api/analytics.md, docs/research/analytics-apis.md). Pure: no I/O. Kept to ES2017 library calls because the web imports it.
 *
 * Daily facts are stored per app, source, metric, date and an optional ONE dimension (`territory`, `source_type`,
 * `app_version`, `currency`). A value is stored in micro units (an integer), so counts, rates and money share one column.
 * Nothing here is a claim about a store that the research doc marks UNVERIFIED: those notes keep their mark in the text.
 */

export const analyticsSources = [
  'apple_analytics',
  'apple_sales',
  'play_vitals',
  'play_reports',
  'play_sales',
  'apple_subscriptions',
  'play_earnings',
  'play_subscriptions',
] as const;
export type AnalyticsSource = (typeof analyticsSources)[number];
export const isAnalyticsSource = (v: unknown): v is AnalyticsSource =>
  typeof v === 'string' && (analyticsSources as readonly string[]).includes(v);

export const analyticsDimensions = [
  'territory',
  'source_type',
  'app_version',
  'currency',
  'product',
  'duration',
] as const;
export type AnalyticsDimension = (typeof analyticsDimensions)[number];

export const analyticsMetrics = [
  // Apple, Analytics Reports API
  'impressions',
  'product_page_views',
  'downloads_first_time',
  'downloads_redownload',
  'sessions',
  'crashes',
  // Apple, Sales and Trends
  'sales_units',
  'sales_proceeds',
  // Google, Play Developer Reporting API
  'crash_rate',
  'anr_rate',
  // The same query's user-perceived rates (Google's bad behavior thresholds apply to these) and the users each rate divides by (rounded by Google).
  'crash_rate_perceived',
  'anr_rate_perceived',
  'crash_users',
  'anr_users',
  // Google, Cloud Storage reports
  'installs_user',
  'installs_device',
  'uninstalls_device',
  'active_installs_device',
  'rating_average_daily',
  'rating_average_total',
  'store_listing_visitors',
  'store_listing_acquisitions',
  // Google, Cloud Storage "Estimated sales" reports (docs/adr/0038-sales-analytics.md): what buyers paid, NOT developer proceeds
  'sales_gross',
  'sales_refunds',
  'sales_orders',
  // Google, Cloud Storage "Earnings" report (docs/adr/0042-earnings-and-subscription-metrics.md): monthly, from Google's own lines
  'earnings_net',
  'earnings_charges',
  'earnings_taxes',
  'earnings_fees',
  'earnings_orders',
  // Apple, Sales and Trends "Subscription" and "Subscription Event" reports (same vendor number as the sales summary)
  'subscriptions_active',
  'subscriptions_active_offer',
  'subscriptions_active_trial',
  'subscriptions_new',
  'subscriptions_cancelled',
  'subscriptions_trial_conversions',
  // Google, Cloud Storage "financial-stats/subscriptions" statistics
  'play_subscriptions_active',
  'play_subscriptions_new',
  'play_subscriptions_cancelled',
] as const;
export type AnalyticsMetric = (typeof analyticsMetrics)[number];
export const isAnalyticsMetric = (v: unknown): v is AnalyticsMetric =>
  typeof v === 'string' && (analyticsMetrics as readonly string[]).includes(v);

export type MetricUnit = 'count' | 'ratio' | 'rating' | 'money';
export type MetricAggregation = 'sum' | 'mean';

export type MetricInfo = {
  source: AnalyticsSource;
  /**
   * `monthly`: the store publishes one figure per calendar month (the Play Earnings report). It is stored on the FIRST day of the month,
   * is read at month granularity, and is never drawn as a day. Absent: a daily figure.
   */
  cadence?: 'monthly';
  unit: MetricUnit;
  /** How days combine into a week or a month. Counts add up, rates and ratings are averaged. */
  aggregation: MetricAggregation;
  /** Days after a date a store may still change that date's value (the study's "complete within", an upper bound). */
  delayDays: number;
  label: string;
};

export const metricInfo: Record<AnalyticsMetric, MetricInfo> = {
  impressions: {
    source: 'apple_analytics',
    unit: 'count',
    aggregation: 'sum',
    delayDays: 3,
    label: 'Impressions',
  },
  product_page_views: {
    source: 'apple_analytics',
    unit: 'count',
    aggregation: 'sum',
    delayDays: 3,
    label: 'Product page views',
  },
  downloads_first_time: {
    source: 'apple_analytics',
    unit: 'count',
    aggregation: 'sum',
    delayDays: 2,
    label: 'First-time downloads',
  },
  downloads_redownload: {
    source: 'apple_analytics',
    unit: 'count',
    aggregation: 'sum',
    delayDays: 2,
    label: 'Redownloads',
  },
  sessions: {
    source: 'apple_analytics',
    unit: 'count',
    aggregation: 'sum',
    delayDays: 5,
    label: 'Sessions',
  },
  crashes: {
    source: 'apple_analytics',
    unit: 'count',
    aggregation: 'sum',
    delayDays: 5,
    label: 'Crashes',
  },
  sales_units: {
    source: 'apple_sales',
    unit: 'count',
    aggregation: 'sum',
    delayDays: 1,
    label: 'Units',
  },
  sales_proceeds: {
    source: 'apple_sales',
    unit: 'money',
    aggregation: 'sum',
    delayDays: 1,
    label: 'Proceeds',
  },
  crash_rate: {
    source: 'play_vitals',
    unit: 'ratio',
    aggregation: 'mean',
    delayDays: 2,
    label: 'Crash rate',
  },
  anr_rate: {
    source: 'play_vitals',
    unit: 'ratio',
    aggregation: 'mean',
    delayDays: 2,
    label: 'ANR rate',
  },
  crash_rate_perceived: {
    source: 'play_vitals',
    unit: 'ratio',
    aggregation: 'mean',
    delayDays: 2,
    label: 'User-perceived crash rate',
  },
  anr_rate_perceived: {
    source: 'play_vitals',
    unit: 'ratio',
    aggregation: 'mean',
    delayDays: 2,
    label: 'User-perceived ANR rate',
  },
  crash_users: {
    source: 'play_vitals',
    unit: 'count',
    aggregation: 'sum',
    delayDays: 2,
    label: 'Users behind the crash rate',
  },
  anr_users: {
    source: 'play_vitals',
    unit: 'count',
    aggregation: 'sum',
    delayDays: 2,
    label: 'Users behind the ANR rate',
  },
  installs_user: {
    source: 'play_reports',
    unit: 'count',
    aggregation: 'sum',
    delayDays: 7,
    label: 'User installs',
  },
  installs_device: {
    source: 'play_reports',
    unit: 'count',
    aggregation: 'sum',
    delayDays: 7,
    label: 'Device installs',
  },
  uninstalls_device: {
    source: 'play_reports',
    unit: 'count',
    aggregation: 'sum',
    delayDays: 7,
    label: 'Device uninstalls',
  },
  active_installs_device: {
    source: 'play_reports',
    unit: 'count',
    aggregation: 'mean',
    delayDays: 7,
    label: 'Active device installs',
  },
  rating_average_daily: {
    source: 'play_reports',
    unit: 'rating',
    aggregation: 'mean',
    delayDays: 7,
    label: 'Average rating of the day',
  },
  rating_average_total: {
    source: 'play_reports',
    unit: 'rating',
    aggregation: 'mean',
    delayDays: 7,
    label: 'Average rating, all time',
  },
  store_listing_visitors: {
    source: 'play_reports',
    unit: 'count',
    aggregation: 'sum',
    delayDays: 7,
    label: 'Store listing visitors',
  },
  store_listing_acquisitions: {
    source: 'play_reports',
    unit: 'count',
    aggregation: 'sum',
    delayDays: 7,
    label: 'Store listing acquisitions',
  },
  // Estimated sales: buyer-paid amounts (tax included, Google's fee NOT deducted), per currency of sale, UTC days. Posted with a
  // delay of up to a few days (the 3 to 7 days Google gives for its Cloud Storage exports is the upper bound used here).
  sales_gross: {
    source: 'play_sales',
    unit: 'money',
    aggregation: 'sum',
    delayDays: 7,
    label: 'Sales, buyer-paid estimate',
  },
  sales_refunds: {
    source: 'play_sales',
    unit: 'money',
    aggregation: 'sum',
    delayDays: 7,
    label: 'Refunds, buyer-paid estimate',
  },
  sales_orders: {
    source: 'play_sales',
    unit: 'count',
    aggregation: 'sum',
    delayDays: 7,
    label: 'Orders',
  },
  // Play Earnings: one figure per calendar month and currency, from the lines of the monthly report (Pacific Time days). Stored on the
  // first day of the month. `delayDays` is the "posted by about the 5th of the next month" plus the month itself, as an upper bound.
  earnings_net: {
    source: 'play_earnings',
    cadence: 'monthly',
    unit: 'money',
    aggregation: 'sum',
    delayDays: 40,
    label: 'Earnings, net (monthly)',
  },
  earnings_charges: {
    source: 'play_earnings',
    cadence: 'monthly',
    unit: 'money',
    aggregation: 'sum',
    delayDays: 40,
    label: 'Charge lines (monthly)',
  },
  earnings_taxes: {
    source: 'play_earnings',
    cadence: 'monthly',
    unit: 'money',
    aggregation: 'sum',
    delayDays: 40,
    label: 'Tax lines (monthly)',
  },
  earnings_fees: {
    source: 'play_earnings',
    cadence: 'monthly',
    unit: 'money',
    aggregation: 'sum',
    delayDays: 40,
    label: 'Google fee lines (monthly)',
  },
  earnings_orders: {
    source: 'play_earnings',
    cadence: 'monthly',
    unit: 'count',
    aggregation: 'sum',
    delayDays: 40,
    label: 'Charge lines, count (monthly)',
  },
  // Apple subscriptions: the Subscription report is a snapshot of the day (a LEVEL: averaged over a week or month, never added), the
  // Subscription Event report counts events of the day. Counts of subscriptions, not of people.
  subscriptions_active: {
    source: 'apple_subscriptions',
    unit: 'count',
    aggregation: 'mean',
    delayDays: 3,
    label: 'Active subscriptions, standard price',
  },
  subscriptions_active_offer: {
    source: 'apple_subscriptions',
    unit: 'count',
    aggregation: 'mean',
    delayDays: 3,
    label: 'Active subscriptions on a paid offer',
  },
  subscriptions_active_trial: {
    source: 'apple_subscriptions',
    unit: 'count',
    aggregation: 'mean',
    delayDays: 3,
    label: 'Active free trials',
  },
  subscriptions_new: {
    source: 'apple_subscriptions',
    unit: 'count',
    aggregation: 'sum',
    delayDays: 3,
    label: 'New subscriptions',
  },
  subscriptions_cancelled: {
    source: 'apple_subscriptions',
    unit: 'count',
    aggregation: 'sum',
    delayDays: 3,
    label: 'Cancellations',
  },
  subscriptions_trial_conversions: {
    source: 'apple_subscriptions',
    unit: 'count',
    aggregation: 'sum',
    delayDays: 3,
    label: 'Free trials converted to paid',
  },
  // Play subscription statistics (financial-stats/subscriptions): per product and day.
  play_subscriptions_active: {
    source: 'play_subscriptions',
    unit: 'count',
    aggregation: 'mean',
    delayDays: 7,
    label: 'Active subscriptions',
  },
  play_subscriptions_new: {
    source: 'play_subscriptions',
    unit: 'count',
    aggregation: 'sum',
    delayDays: 7,
    label: 'New subscriptions',
  },
  play_subscriptions_cancelled: {
    source: 'play_subscriptions',
    unit: 'count',
    aggregation: 'sum',
    delayDays: 7,
    label: 'Cancelled subscriptions',
  },
};

/** The metrics that are money: one series per currency, never added across currencies. */
export const moneyMetrics: readonly AnalyticsMetric[] = analyticsMetrics.filter(
  (m) => metricInfo[m].unit === 'money',
);

/**
 * Per-product sales (docs/adr/0038-sales-analytics.md): the daily facts of the sales metrics are also stored under the dimension
 * `product`. The value is the store's product id (Apple SKU, Google Play SKU ID); for a MONEY metric it is `<CUR>:<product id>`, so
 * the currency stays part of the key and two currencies are never mixed. The table is bounded: at most `maxProductsPerApp` distinct
 * products per app and source, and an id longer than `maxProductIdLength` is not stored.
 */
export const productSalesLimits = { maxProductsPerApp: 200, maxProductIdLength: 90 } as const;

export function productDimValue(productId: string, currency: string | null): string | undefined {
  const id = productId.trim();
  if (id === '' || id.length > productSalesLimits.maxProductIdLength) return undefined;
  if (currency === null) return id;
  return /^[A-Z]{3}$/.test(currency) ? `${currency}:${id}` : undefined;
}

/** The inverse of `productDimValue`: the product id and, for a money metric, its currency. */
export function splitProductDimValue(
  value: string,
  money: boolean,
): { productId: string; currency: string | null } {
  if (!money) return { productId: value, currency: null };
  const at = value.indexOf(':');
  return at === 3
    ? { productId: value.slice(4), currency: value.slice(0, 3) }
    : { productId: value, currency: null };
}

/** Which source reads which metrics, in a stable order. */
export const metricsOfSource = (source: AnalyticsSource): AnalyticsMetric[] =>
  analyticsMetrics.filter((m) => metricInfo[m].source === source);

/** Which sources can ever apply to an app of this platform. */
export const sourcesForPlatform = (platform: Platform): AnalyticsSource[] => [
  ...byFamily(platform, {
    apple: ['apple_analytics', 'apple_sales', 'apple_subscriptions'],
    google: ['play_vitals', 'play_reports', 'play_sales', 'play_earnings', 'play_subscriptions'],
  }),
];

// ---------------------------------------------------------------------------------------------
// Fixed vocabularies: error codes, setup needs, next steps. A client switches on these, never on a message.

/**
 * Why a read or an import of analytics failed. A fixed vocabulary: the message next to it is for people.
 * New codes may be added; a client treats an unknown one as a plain failure.
 */
export const analyticsErrorCodes = [
  // Apple
  'analytics_role_required', // the API key's role may not create (or read) analytics report requests: import a file instead
  'analytics_request_missing', // no report request exists for the app yet
  'analytics_request_stopped', // Apple stopped the ongoing request (inactivity): create it again
  'report_not_ready', // the request exists but Apple has produced no instance yet
  'segment_expired', // a download link ran out before it was used (they last about 5 minutes)
  'segment_too_large', // a segment is over the size cap
  'file_too_large', // an uploaded or downloaded file is over the size cap
  'bad_gzip', // a .gz file could not be decompressed
  'bad_zip', // a .zip file could not be opened (not a zip, damaged, too many entries, or an entry that is too large)
  'period_required', // the file has no date column: send the period it covers (from and to)
  'bad_format', // the table could not be read (encoding, quoting, no header)
  'unknown_report', // the report is not one this server maps
  'missing_columns', // a column the mapping needs is not in the header
  'no_rows', // the file is readable but holds no row this app can use
  'vendor_number_missing',
  'vendor_number_invalid',
  'sales_forbidden', // the key may not read Sales and Trends reports
  // Google
  'play_reporting_not_enabled', // the Play Developer Reporting API is not enabled in the Cloud project
  'play_permission_missing', // the service account may not read vitals or reports
  'play_app_not_found',
  'play_vitals_bad_request', // Google rejected the vitals query (HTTP 400, INVALID_ARGUMENT): a fault of the request, not of the setup
  'play_vitals_no_data', // the Reporting API answered and holds no daily vitals for the app (too few users, or too new)
  'bucket_missing', // no Cloud Storage bucket id is set for the app
  'bucket_invalid',
  'bucket_forbidden', // the service account may not read the bucket
  'bucket_not_found',
  'reports_not_found', // the bucket holds no file for the month
  'package_not_in_bucket', // the bucket can be read but holds no report of this package at all: usually the bucket of another Play account
  'play_sales_forbidden', // the service account may not read the financial reports: estimated sales, earnings, subscription statistics (Play Console "View financial data", Global)
  // Both
  'store_auth', // the credential is unusable
  'store_forbidden',
  'store_not_found',
  'rate_limited',
  'store_unavailable',
  'timeout',
  'credential_unreadable',
  'credential_not_found',
  'app_not_synced', // Apple: the app's store id is not known yet
  'sync_failed',
] as const;
export type AnalyticsErrorCode = (typeof analyticsErrorCodes)[number];
export const isAnalyticsErrorCode = (v: unknown): v is AnalyticsErrorCode =>
  typeof v === 'string' && (analyticsErrorCodes as readonly string[]).includes(v);

/** What an app still needs before a source can deliver, in plain words. */
export const analyticsSetupCodes = [
  'turn_on_analytics', // the workspace setting analytics.enabled is off
  'create_report_request', // Apple: no report request yet
  'role_required', // Apple: the key's role may not create one (import a file, or use an Admin key once)
  'waiting_first_data', // Apple: the request was made; the first reports take one to two days
  'request_stopped', // Apple: stopped for inactivity
  'vendor_number_missing', // Apple Sales and Trends needs the vendor number
  'sales_forbidden',
  'play_sales_forbidden', // Google: the service account lacks "View financial data" (Global): no sales, earnings or subscription reports
  'bucket_id_missing', // Google Cloud Storage reports need the bucket id
  'bucket_forbidden',
  'reporting_api_not_enabled',
  'play_permission_missing',
  'credential_problem',
  'first_sync_pending', // everything is set up and no read has happened yet
] as const;
export type AnalyticsSetupCode = (typeof analyticsSetupCodes)[number];

/** The next step for a setup need. */
export const analyticsNextSteps = [
  'turn_on_analytics',
  'enable_apple_analytics', // GET then POST /apps/:id/analytics/apple/enable (preview, then confirm)
  'import_apple_report', // POST /apps/:id/analytics/import/preview, then /import
  'ask_apple_admin',
  'set_vendor_number', // the workspace setting analytics.appleVendorNumber (PUT /settings)
  'set_bucket_id', // the workspace setting analytics.playBucketId (PUT /settings)
  'grant_play_permission',
  'grant_play_financial_permission', // Play Console: View financial data, set to Global
  'enable_reporting_api',
  'fix_credential',
  'sync_now',
  'wait',
] as const;
export type AnalyticsNextStep = (typeof analyticsNextSteps)[number];

/** The plain sentence for each error code (no secret, no store text). */
export const analyticsErrorMessages: Record<AnalyticsErrorCode, string> = {
  analytics_role_required:
    'The App Store Connect API key may not create analytics report requests (Apple lists the Admin role for it). Use an Admin key once, or import a report file you downloaded from App Store Connect.',
  analytics_request_missing:
    'No analytics report request exists for this app yet. Enable Apple analytics first.',
  analytics_request_stopped:
    'Apple stopped the ongoing analytics report request because nothing was read for a long time. Enable Apple analytics again.',
  report_not_ready:
    'Apple has not produced any report for the request yet. The first reports take one to two days.',
  segment_expired:
    'The download link for an Apple report expired before it was used (they last about 5 minutes). The next sync tries again.',
  segment_too_large: 'A report file from Apple is larger than the limit this server reads.',
  file_too_large: 'The file is larger than the limit this server reads.',
  bad_gzip: 'The file could not be decompressed. Check that it is a complete .gz file.',
  bad_zip:
    'The .zip file could not be opened. Check that it is a complete zip file with the exported .csv inside.',
  period_required:
    'The file has no date column. Say which days it covers (from and to) and preview it again.',
  bad_format: 'The file could not be read as a table of values separated by tabs or commas.',
  unknown_report:
    'This server does not know how to read that report. Supported: App Store Discovery and Engagement, App Store Downloads, App Sessions, App Crashes.',
  missing_columns: 'The file does not have the columns this report needs.',
  no_rows: 'The file holds no rows for this app and platform.',
  vendor_number_missing:
    'Sales and Trends needs the vendor number of the team. Set it in the analytics settings of the app.',
  vendor_number_invalid:
    'The vendor number is not valid. It is a number from App Store Connect, Payments and Financial Reports.',
  sales_forbidden:
    'The App Store Connect API key may not read Sales and Trends reports (it needs the Sales and Reports role or higher).',
  play_reporting_not_enabled:
    'The Google Play Developer Reporting API is not enabled in the Google Cloud project of the service account. In Google Cloud console, open that project, find Google Play Developer Reporting API and click Enable. Wait a few minutes, then sync again.',
  play_permission_missing:
    'Google Play refused the service account for Android vitals. In Play Console open Users and permissions, invite the service account email address (client_email in its JSON key) and give it access to this app with the permission View app quality information (read-only). New permissions can take a while to apply. Then sync again.',
  play_app_not_found:
    'The Play Developer Reporting API knows no app with this package name that the service account can see. Check that the package name is the application id of the app in Play Console, and that the service account was granted access to this app.',
  play_vitals_bad_request:
    'Google rejected the Android vitals request (HTTP 400). This is a fault of this server, not of your setup. Sync again later, and report it if it stays.',
  play_vitals_no_data:
    'Google has no Android vitals for this app yet. Play shows vitals only for apps with enough users and a published version, and they appear a day or two late. Nothing is wrong with the setup.',
  bucket_missing:
    'No Cloud Storage bucket id is set for this app. Copy it from the Reports page of Play Console.',
  bucket_invalid: 'The bucket id is not valid. It looks like pubsite_prod_rev_<number>.',
  bucket_forbidden:
    'The service account may not read the Cloud Storage bucket of the Play Console reports.',
  bucket_not_found: 'Google Cloud Storage has no bucket with this id.',
  reports_not_found: 'The bucket holds no report file for this app and month yet.',
  package_not_in_bucket:
    'This package is not in this bucket. The reports of an app are in the bucket of the Play account that owns it: check the bucket of this app.',
  play_sales_forbidden:
    'Google refused the service account the Play Console financial reports (estimated sales, earnings, subscription statistics). In Play Console, Users and permissions, give the service account the permission View financial data, set to Global (all apps), then sync again. If the whole bucket is refused, it also needs read access to the bucket.',
  store_auth: 'The credential was refused by the store. Check the key and enter it again.',
  store_forbidden: 'The credential is not allowed to read this from the store.',
  store_not_found: 'The store has no such app for this credential.',
  rate_limited: 'The store asked to slow down. The next sync tries again.',
  store_unavailable: 'The store did not answer or failed. The next sync tries again.',
  timeout: 'The store did not answer in time.',
  credential_unreadable: 'The credential could not be decrypted. Enter its secret again.',
  credential_not_found: 'The credential of this app no longer exists.',
  app_not_synced: 'The App Store id of this app is not known yet. Sync the app first.',
  sync_failed: 'The analytics sync could not be completed.',
};

/** Why a series has no data, or what limits it. A fixed vocabulary shown with every series. */
export const coverageNoteCodes = [
  'apple_usage_opt_in_only', // sessions and crashes cover only users who share data with developers
  'apple_privacy_thresholds', // small counts are dropped and noised by Apple
  'apple_counts_not_unique', // counts add up rows; unique users cannot be added
  'apple_usage_sample_not_total',
  'apple_estimates', // sales are next-day estimates
  'apple_pacific_time', // Apple sales days run on Pacific Time
  'apple_proceeds_per_currency', // money in the payout currency of each row, never converted
  'apple_in_app_not_included',
  'apple_rating_history_not_available', // no API gives a rating history
  'apple_impressions_only_via_reports',
  'google_unit_unverified', // crash and ANR rate unit is not confirmed
  'google_legacy_store_listing', // store listing metrics in the legacy export; Google changed them in 2026
  'google_no_impressions', // Google offers no impressions in any API or export
  'google_rating_average_only', // the average only, no count or histogram
  'google_monthly_files', // reports are monthly files posted 3 to 7 days late
  'play_estimated_sales_gross', // Google estimated sales are what buyers paid, tax included, no Google fee deducted: not proceeds
  'play_sales_latency', // the sales file is extended daily, up to a few days late; refunds change earlier days
  'play_sales_utc', // Google sales days run on UTC
  'play_sales_per_currency', // amounts in the currency the buyer paid in, never converted
  'apple_product_sales_include_in_app', // by-product Apple numbers include in-app purchases and subscriptions; the total chart does not
  'sales_products_capped', // only the first products of the app are kept
  'play_earnings_monthly', // one figure per calendar month, shown on the first of the month, posted about the 5th of the next month
  'play_earnings_net', // the sum of every line of Google's Earnings report for the app, as Google signs the amounts
  'play_earnings_per_currency', // amounts in the merchant (payout) currency of each line, per currency, never added
  'play_earnings_pacific', // Google's Earnings report days run on Pacific Time; the month is the month of its file
  'apple_subscription_counts', // counts of subscriptions on the day (a snapshot), not of people
  'apple_subscription_events', // new, cancelled and converted are classified from the names of Apple's subscription events
  'play_subscription_stats', // Google's subscription statistics: what Active includes is not stated
  'derived', // computed from other series, not a store number
  'imported', // some days came from an uploaded file, not from the API
  'recent_days_incomplete', // the newest days are still being completed by the store
  'gaps', // some days in the range have no data
  'source_not_connected',
  'no_data_yet',
  'only_since_connected', // history starts when this server first read the source
] as const;
export type CoverageNoteCode = (typeof coverageNoteCodes)[number];

export const coverageNoteMessages: Record<CoverageNoteCode, string> = {
  apple_usage_opt_in_only:
    'Apple usage data (sessions, crashes) covers only users who chose to share data with developers.',
  apple_privacy_thresholds:
    'Apple drops rows with very few users and adds small random noise to detailed reports.',
  apple_counts_not_unique:
    'These are counts of events. Unique users cannot be added up across rows.',
  apple_usage_sample_not_total: 'This is a sample of your users, not a total.',
  apple_estimates: 'Sales and Trends figures are next-day estimates.',
  apple_pacific_time: 'Apple sales days run on Pacific Time.',
  apple_proceeds_per_currency:
    'Proceeds are in the payout currency of each row. They are shown per currency and never converted.',
  apple_in_app_not_included:
    'Only the app itself is counted here, not in-app purchases (UNVERIFIED mapping of product types).',
  apple_rating_history_not_available:
    'Apple offers no rating history through its API, so there is no rating chart for the App Store.',
  apple_impressions_only_via_reports:
    'Impressions and product page views exist only in the Analytics Reports, which need a report request or an imported file.',
  google_unit_unverified:
    'Whether Google reports this rate as a fraction or a percentage is not confirmed (UNVERIFIED); the value is shown as the API sent it.',
  google_legacy_store_listing:
    'These come from the legacy Play Console export. Google changed its store listing metrics in 2026 and may no longer fill them (UNVERIFIED).',
  google_no_impressions: 'Google Play offers no impressions in any API or export.',
  google_rating_average_only: 'Only the average rating is available, not the number of ratings.',
  google_monthly_files: 'Google posts these reports as monthly files, usually 3 to 7 days late.',
  play_estimated_sales_gross:
    'Google Play estimated sales are what buyers paid, taxes included and before Google deducts its fee. They are not your proceeds and not meant for accounting (the monthly Earnings report is).',
  play_sales_latency:
    'Google adds charged and refunded orders to the month file every day, up to a few days late. Recent days and refunds can still change.',
  play_sales_utc: 'Google Play sales days run on UTC.',
  play_sales_per_currency:
    'Amounts are in the currency the buyer paid in (Currency of Sale). They are shown per currency and never converted.',
  apple_product_sales_include_in_app:
    'Sales by product include in-app purchases and subscriptions of the app (UNVERIFIED matching by SKU). The total chart counts only the app itself, so products can add up to more than the total.',
  sales_products_capped:
    'Only the first 200 products of the app are kept. Sales of further products are not stored.',
  play_earnings_monthly:
    'Google Play earnings are one figure per calendar month, posted about the 5th of the next month. They are drawn per month, on the first day of it, never per day.',
  play_earnings_net:
    'Net is the sum of every line Google lists for this app in its monthly Earnings report (charges, taxes, Google fees, refunds, adjustments), exactly as Google signs the amounts. It is the report for accounting, not an estimate.',
  play_earnings_per_currency:
    'Amounts are in the merchant currency of each line (the currency you are paid in). They are shown per currency and never converted or added together.',
  play_earnings_pacific:
    'Google assigns the lines of the Earnings report to months on Pacific Time, which can differ from the UTC days of the estimated sales.',
  apple_subscription_counts:
    'These count subscriptions on the day, not people: one person with two subscriptions counts twice. Active figures are the day’s snapshot, so a week or a month shows their average.',
  apple_subscription_events:
    'New, cancelled and trial conversions are classified from the event names in Apple’s Subscription Event report (UNVERIFIED for events Apple adds later); other events are not counted.',
  play_subscription_stats:
    'Google’s subscription statistics: whether Active includes free trials or the grace period is not stated (UNVERIFIED). They need the Play Console permission View financial data.',
  derived: 'Derived from other series; it may not match the number the store console shows.',
  imported: 'Some days come from a file that was imported, not from the store API.',
  recent_days_incomplete: 'The newest days can still change while the store completes them.',
  gaps: 'Some days in this range have no data.',
  source_not_connected: 'This source is not connected yet.',
  no_data_yet: 'No data has been read yet.',
  only_since_connected: 'History starts when this server first read the source.',
};

// ---------------------------------------------------------------------------------------------
// Values and dates

export const MICRO = 1_000_000;
/** The stored integer for a value. */
export const toMicro = (value: number): number => Math.round(value * MICRO);
export const fromMicro = (micro: number): number => micro / MICRO;

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

export const dateToDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const dayToMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
export const addDays = (day: string, n: number): string => dateToDay(dayToMs(day) + n * 86_400_000);
/** Whole days from `a` to `b` (negative when `b` is earlier). */
export const daysBetween = (a: string, b: string): number =>
  Math.round((dayToMs(b) - dayToMs(a)) / 86_400_000);

export const granularities = ['day', 'week', 'month'] as const;
export type Granularity = (typeof granularities)[number];
export const isGranularity = (v: unknown): v is Granularity =>
  typeof v === 'string' && (granularities as readonly string[]).includes(v);

/** The first day of the bucket a day belongs to: itself, its Monday, or the first of its month. */
export function bucketStart(day: string, granularity: Granularity): string {
  if (granularity === 'day') return day;
  if (granularity === 'month') return `${day.slice(0, 8)}01`;
  const weekday = new Date(dayToMs(day)).getUTCDay(); // 0 = Sunday
  return addDays(day, -((weekday + 6) % 7));
}

/** Every bucket start from the bucket of `from` through the bucket of `to`, in order. */
export function bucketStarts(from: string, to: string, granularity: Granularity): string[] {
  const out: string[] = [];
  let current = bucketStart(from, granularity);
  const last = bucketStart(to, granularity);
  while (current <= last && out.length < 2000) {
    out.push(current);
    if (granularity === 'day') current = addDays(current, 1);
    else if (granularity === 'week') current = addDays(current, 7);
    else {
      const y = Number(current.slice(0, 4));
      const m = Number(current.slice(5, 7));
      current = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    }
  }
  return out;
}

/** A ratio, or null when the denominator is missing or zero. Never a division by zero, never NaN. */
export function safeRatio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : null;
}

/** A Google Play Cloud Storage bucket id as Play Console shows it (`pubsite_prod_rev_<digits>`), optionally `gs://` prefixed. */
export function normalizeBucketId(raw: string): string | undefined {
  const trimmed = raw
    .trim()
    .replace(/^gs:\/\//i, '')
    .replace(/\/+$/, '');
  return /^pubsite_prod_rev_[0-9]{6,30}$/.test(trimmed) ? trimmed : undefined;
}

/** Where the bucket an app reads came from: its own override, its Play developer account (credential), or the workspace setting. */
export const playBucketSources = ['app', 'account', 'workspace'] as const;
export type PlayBucketSource = (typeof playBucketSources)[number];

/** What "Test the bucket" can answer. A fixed vocabulary: nothing Google said is passed on. */
export const playBucketTestCodes = [
  'ok', // the bucket was read and holds report files for this app
  'no_reports_yet', // the bucket can be read, but holds no report file for this app in the last two months
  'package_not_found', // the bucket can be read but holds no report of this package at all (the bucket of another Play account?)
  'not_set',
  'bucket_invalid',
  'bucket_forbidden', // the service account may not read it
  'bucket_not_found',
  'credential_problem',
  'unreachable',
] as const;
export type PlayBucketTestCode = (typeof playBucketTestCodes)[number];

export const playBucketTestMessages: Record<PlayBucketTestCode, string> = {
  ok: 'The bucket can be read and holds report files for this app.',
  package_not_found:
    'This package is not in this bucket: the bucket belongs to another Play account, or the app has no reports yet. The reports of an app are in the bucket of the Play account that owns it.',
  no_reports_yet:
    'The bucket can be read, but it holds no report file for this app yet. Google writes the files monthly, so this can be right for a new app or month.',
  not_set: 'No bucket is set for this app.',
  bucket_invalid:
    'That is not a Play reports bucket. It looks like gs://pubsite_prod_rev_ followed by digits.',
  bucket_forbidden:
    'The service account may not read this bucket. Grant it Storage Object Viewer on the bucket (and check the Play Console permission).',
  bucket_not_found:
    'Google Cloud Storage has no bucket with this id. Copy it again from Play Console.',
  credential_problem:
    'The saved Google Play credential could not be used. Check it under Credentials.',
  unreachable: 'Google Cloud Storage could not be reached just now. Try again later.',
};

/** An Apple vendor number (Payments and Financial Reports): digits only. */
export function normalizeVendorNumber(raw: string): string | undefined {
  const trimmed = raw.trim();
  return /^[0-9]{5,12}$/.test(trimmed) ? trimmed : undefined;
}

/** The reports and file limits shared by every reader of a table. */
export const analyticsLimits = {
  /** Largest uploaded file or downloaded segment, as received. */
  maxFileBytes: 10 * 1024 * 1024,
  /** Largest text after decompression. */
  maxTextBytes: 64 * 1024 * 1024,
  maxRows: 400_000,
  maxColumns: 80,
  /** Largest stored dimension value (a version, a territory). */
  maxDimensionLength: 100,
} as const;
