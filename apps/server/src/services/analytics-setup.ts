import type { AnalyticsNextStep, AnalyticsSetupCode, AnalyticsSource } from '@mrm/core';
import type { AppleMode, SourceState, StoredRequest } from './analytics-store.ts';

/**
 * What an app still needs before an analytics source can deliver (docs/api/analytics.md). Pure: the status endpoint, the sync and
 * the tests all read the same function, and a client switches on the codes, never on the sentences.
 */

export type SetupInput = {
  source: AnalyticsSource;
  /** The workspace setting `analytics.enabled`. */
  enabled: boolean;
  appleMode: AppleMode;
  requests: StoredRequest[];
  /** The workspace setting `analytics.appleVendorNumber` ('' when none). */
  vendorNumber: string;
  /** The bucket id that applies to the app, or null. */
  bucketId: string | null;
  state: SourceState | undefined;
  /** Whether any day of the source is stored. */
  hasData: boolean;
};

export type Setup = {
  code: AnalyticsSetupCode;
  nextStep: AnalyticsNextStep;
  /** Other ways to get the same data. */
  alternatives: AnalyticsNextStep[];
  /** The source is an extra: the app works without it. */
  optional: boolean;
};

export const setupMessages: Record<AnalyticsSetupCode, string> = {
  turn_on_analytics: 'Analytics is off for this workspace. An admin turns it on in the settings (analytics.enabled).',
  create_report_request: 'No Apple analytics report request exists for this app. An admin enables Apple analytics once, or imports a report file instead.',
  role_required: 'The App Store Connect key may not create analytics report requests. Use an Admin key once, or import a report file downloaded from App Store Connect.',
  waiting_first_data: 'The report request was made. Apple produces the first reports within one to two days.',
  request_stopped: 'Apple stopped the report request because nothing was read for a long time. Enable Apple analytics again.',
  vendor_number_missing: 'Optional: set the Apple vendor number in the settings (analytics.appleVendorNumber) to add daily units and proceeds.',
  sales_forbidden: 'The App Store Connect key may not read Sales and Trends (it needs the Sales and Reports role or higher).',
  bucket_id_missing: 'Optional: set the Cloud Storage bucket id of your Play Console reports (analytics.playBucketId) to add installs, ratings and store listing numbers.',
  bucket_forbidden: 'The service account may not read the Cloud Storage bucket of the Play Console reports.',
  reporting_api_not_enabled: 'The Google Play Developer Reporting API is not enabled in the Cloud project of the service account.',
  play_permission_missing: 'The service account may not read Android vitals or reports for this app.',
  credential_problem: 'The store credential of this app does not work. Check it and enter it again.',
  first_sync_pending: 'Everything is set up. The first sync has not run yet.',
};

const mk = (code: AnalyticsSetupCode, nextStep: AnalyticsNextStep, extra: Partial<Pick<Setup, 'alternatives' | 'optional'>> = {}): Setup => ({
  code,
  nextStep,
  alternatives: extra.alternatives ?? [],
  optional: extra.optional ?? false,
});

/** The first thing that stands between the app and data from this source, or null when nothing does. */
export function deriveSetup(input: SetupInput): Setup | null {
  const { source, state } = input;
  const importOnly = source === 'apple_analytics' && input.appleMode === 'import';
  if (!input.enabled && !importOnly) {
    return mk('turn_on_analytics', 'turn_on_analytics', source === 'apple_analytics' ? { alternatives: ['import_apple_report'] } : {});
  }
  switch (state?.lastErrorCode) {
    case 'analytics_role_required':
      return mk('role_required', 'ask_apple_admin', { alternatives: ['import_apple_report'] });
    case 'sales_forbidden':
      return mk('sales_forbidden', 'ask_apple_admin', { optional: true });
    case 'play_reporting_not_enabled':
      return mk('reporting_api_not_enabled', 'enable_reporting_api');
    case 'play_permission_missing':
      return mk('play_permission_missing', 'grant_play_permission');
    case 'bucket_forbidden':
      return mk('bucket_forbidden', 'grant_play_permission', { optional: true });
    case 'store_auth':
    case 'credential_unreadable':
    case 'credential_not_found':
      return mk('credential_problem', 'fix_credential');
    case 'analytics_request_stopped':
      return mk('request_stopped', 'enable_apple_analytics', { alternatives: ['import_apple_report'] });
    case 'analytics_request_missing':
      return mk('create_report_request', 'enable_apple_analytics', { alternatives: ['import_apple_report'] });
    default:
  }
  if (source === 'apple_analytics' && !importOnly) {
    const active = input.requests.filter((r) => r.status === 'active');
    if (active.length === 0) {
      return input.requests.some((r) => r.status === 'stopped')
        ? mk('request_stopped', 'enable_apple_analytics', { alternatives: ['import_apple_report'] })
        : mk('create_report_request', 'enable_apple_analytics', { alternatives: ['import_apple_report'] });
    }
    if (!input.hasData) return mk('waiting_first_data', 'wait');
  }
  if (source === 'apple_sales' && input.vendorNumber === '') return mk('vendor_number_missing', 'set_vendor_number', { optional: true });
  if (source === 'play_reports' && input.bucketId === null) return mk('bucket_id_missing', 'set_bucket_id', { optional: true });
  if (!importOnly && (state === undefined || state.lastAttemptAt === null)) return mk('first_sync_pending', 'sync_now');
  return null;
}
