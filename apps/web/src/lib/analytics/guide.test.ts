import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceOf, statusOf, NOW } from './fixtures.ts';
import { guideKindOf, guideLinks, isTestable, probablyOtherAccount } from './guide.ts';
import { sourceRows } from './view.ts';

const BUCKET = 'pubsite_prod_rev_01234567890123456789';
const google = (extra: object = {}) => ({
  bucketIdSet: true,
  bucketSource: 'workspace' as const,
  bucketId: BUCKET,
  severalPlayAccounts: true,
  serviceAccountEmail: 'bot@proj.iam.gserviceaccount.com',
  ...extra,
});

test('each cause has its own guide; codes that need no guide have none', () => {
  assert.equal(guideKindOf('bucket_forbidden'), 'play_bucket');
  assert.equal(guideKindOf('play_sales_forbidden'), 'play_finance');
  assert.equal(guideKindOf('sales_forbidden'), 'apple_role');
  assert.equal(guideKindOf('vendor_number_missing'), 'apple_vendor');
  assert.equal(guideKindOf('vendor_number_invalid'), 'apple_vendor');
  assert.equal(guideKindOf('package_not_in_bucket'), 'play_bucket_id');
  assert.equal(guideKindOf('bucket_id_missing'), 'play_bucket_id');
  assert.equal(guideKindOf('store_unavailable'), null);
  assert.equal(guideKindOf(null), null);
});

test('the links carry the real developer account and bucket; without a bucket they fall back to the Play Console home', () => {
  const links = guideLinks(google());
  assert.equal(links.usersAndPermissions, 'https://play.google.com/console/u/0/developers/01234567890123456789/users-and-permissions');
  assert.equal(links.bucket, `https://console.cloud.google.com/storage/browser/${BUCKET};tab=permissions`);
  const none = guideLinks(google({ bucketId: null }));
  assert.equal(none.usersAndPermissions, 'https://play.google.com/console');
  assert.equal(none.bucket, null);
  assert.equal(links.vendor, 'https://appstoreconnect.apple.com/itc/payments_and_financial_reports');
  assert.equal(links.usersAndAccess, 'https://appstoreconnect.apple.com/access/users');
});

test('a workspace-wide bucket read by an app of one of several Play accounts is flagged as probably another account', () => {
  assert.equal(probablyOtherAccount(google()), true);
  assert.equal(probablyOtherAccount(google({ bucketSource: 'account' })), false);
  assert.equal(probablyOtherAccount(google({ severalPlayAccounts: false })), false);
  assert.equal(probablyOtherAccount(null), false);
});

test('a refused Play source shows the guide, no dead "Grant the Play permission" step, and can be tested', () => {
  const status = statusOf({
    platform: 'android',
    apple: null,
    google: google(),
    sources: [
      sourceOf({
        source: 'play_sales',
        state: 'needs_setup',
        lastOkAt: null,
        firstDay: null,
        lastDay: null,
        setup: { code: 'play_sales_forbidden', nextStep: 'grant_play_financial_permission', alternatives: [], optional: false, message: '' },
        lastError: { code: 'play_sales_forbidden', message: '' },
      }),
      sourceOf({ source: 'play_reports' }),
    ],
  });
  const [refused, fine] = sourceRows(status, NOW);
  assert.equal(refused?.guide, 'play_finance');
  assert.equal(refused?.action, null);
  assert.equal(refused?.optional, false);
  assert.equal(refused?.testable, true);
  assert.equal(fine?.guide, null);
  assert.equal(fine?.testable, false, 'a source that works needs no test');
  assert.equal(isTestable('play_vitals'), false);
});
