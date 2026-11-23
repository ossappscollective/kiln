import { accessTestSources, appleLinks, playBucketPermissionsUrl, playConsoleUsersUrl } from '@kiln/core';
import type { AnalyticsStatus } from './analytics.ts';

/**
 * The setup guides of the data sources panel (docs/ux-ia.md): which guide explains a code, and the real links in it. Pure, so the
 * choice is tested without drawing anything. A guide names ONE cause and the steps that fix it; the words are in the `analytics:guide`
 * messages, never the store's text.
 */

export type GuideKind =
  | 'play_bucket' // the bucket is refused: another account's bucket, or the Play Console invitation
  | 'play_finance' // the bucket is readable, the financial folders are not: View financial data (Global)
  | 'play_bucket_id' // no bucket, a wrong one, or one without this app
  | 'apple_role' // Sales and Trends 403: the key's role or another team's vendor number
  | 'apple_vendor'; // no vendor number, or one Apple does not accept

/** The guide for a setup code or an error code of a source, or null when the sentence of the row says it all. */
export function guideKindOf(code: string | null): GuideKind | null {
  switch (code) {
    case 'bucket_forbidden':
      return 'play_bucket';
    case 'play_sales_forbidden':
      return 'play_finance';
    case 'bucket_id_missing':
    case 'bucket_missing':
    case 'bucket_invalid':
    case 'bucket_not_found':
    case 'package_not_in_bucket':
      return 'play_bucket_id';
    case 'sales_forbidden':
      return 'apple_role';
    case 'vendor_number_missing':
    case 'vendor_number_invalid':
      return 'apple_vendor';
    default:
      return null;
  }
}

export const isTestable = (source: string): boolean =>
  (accessTestSources as readonly string[]).includes(source);

type Google = NonNullable<AnalyticsStatus['google']>;

/** The app reads the one bucket of the whole workspace although the workspace has several Play accounts: it is probably another account's. */
export const probablyOtherAccount = (google: Google | null): boolean =>
  google !== null && google.severalPlayAccounts === true && google.bucketSource === 'workspace';

export type GuideLinks = {
  usersAndPermissions: string;
  /** Null when the bucket is not known. */
  bucket: string | null;
  usersAndAccess: string;
  vendor: string;
};

export function guideLinks(google: Google | null): GuideLinks {
  const bucketId = google?.bucketId ?? null;
  return {
    usersAndPermissions: playConsoleUsersUrl(bucketId),
    bucket: playBucketPermissionsUrl(bucketId),
    usersAndAccess: appleLinks.usersAndAccess,
    vendor: appleLinks.vendorNumber,
  };
}
