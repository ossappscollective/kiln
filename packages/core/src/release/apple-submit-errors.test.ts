import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type AppleReason,
  appleComplianceBlockers,
  appleSubmitFixKind,
  explainAppleSubmitErrors,
} from './apple-submit-errors.ts';

const GENERIC: AppleReason = {
  code: 'STATE_ERROR.ENTITY_STATE_INVALID',
  title: 'The request cannot be fulfilled because of the state of another resource.',
  detail: 'This resource cannot be reviewed, please check associated errors to see why.',
};
const REQUIRED = 'ENTITY_ERROR.ATTRIBUTE.REQUIRED';
const required = (resource: string, attr: string): AppleReason => ({
  code: REQUIRED,
  detail: `You must provide a value for the attribute '${attr}' with this request`,
  pointer: `/data/attributes/${attr}`,
  resource,
});

const explain = (...reasons: AppleReason[]) => explainAppleSubmitErrors([GENERIC, ...reasons]);

test('review contact fields of Apple become one blocker that lists them and is fixed in Kiln (review information)', () => {
  const out = explain(
    required('appStoreReviewDetails', 'contactEmail'),
    required('appStoreReviewDetails', 'contactPhone'),
    required('appStoreReviewDetails', 'contactFirstName'),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]?.code, 'no_review_contact');
  assert.equal(out[0]?.fix.kind, 'review');
  assert.match(out[0]?.message ?? '', /contactEmail, contactPhone, contactFirstName/);
});

test('a demo account is its own blocker, not a contact one', () => {
  const out = explain(
    required('appStoreReviewDetails', 'demoAccountName'),
    required('appStoreReviewDetails', 'demoAccountPassword'),
  );
  assert.deepEqual(
    out.map((b) => b.code),
    ['no_review_demo_account'],
  );
  assert.match(out[0]?.message ?? '', /demoAccountName, demoAccountPassword/);
});

test('age rating, content rights, export compliance and privacy policy are named with the page where they are fixed', () => {
  const out = explain(
    required('ageRatingDeclarations', 'gambling'),
    required('ageRatingDeclarations', 'socialMedia'),
    {
      resource: 'apps',
      code: REQUIRED,
      detail: "You must provide a value for the attribute 'contentRightsDeclaration'",
    },
    {
      resource: 'builds',
      code: REQUIRED,
      detail: "You must provide a value for the attribute 'usesNonExemptEncryption'",
    },
    { resource: 'appInfoLocalizations', code: REQUIRED, title: 'Privacy Policy URL is required' },
  );
  assert.deepEqual(
    out.map((b) => b.code),
    ['apple_age_rating', 'apple_content_rights', 'apple_export_compliance', 'apple_privacy_policy'],
  );
  assert.match(out[0]?.message ?? '', /gambling, socialMedia/);
  for (const b of out) {
    assert.equal(b.fix.kind, 'store');
    assert.equal(typeof b.params?.page, 'string');
  }
  assert.equal(out[1]?.params?.page, 'App Information > Content Rights');
});

test('a version without a build, and a build that is not processed, are told apart', () => {
  const none = explain({
    resource: 'build',
    code: REQUIRED,
    detail: 'The version must have a build',
  });
  assert.equal(none[0]?.code, 'no_build');
  assert.equal(none[0]?.fix.kind, 'build');
  const processing = explain({
    resource: 'builds',
    code: 'ENTITY_ERROR',
    detail: 'The build is still processing',
  });
  assert.equal(processing[0]?.code, 'build_not_valid');
});

test('screenshots, copyright, pricing, category, privacy labels and a version already in review', () => {
  const out = explain(
    {
      resource: 'appScreenshotSets',
      code: 'X',
      title: 'Screenshots are required for the display type APP_IPHONE_67',
    },
    required('appStoreVersions', 'copyright'),
    { resource: 'appPriceSchedules', code: 'X', detail: 'The app has no price set' },
    { resource: 'appInfos', code: 'X', detail: 'A primary category is required' },
    { resource: 'appDataUsages', code: 'X', detail: 'App Privacy details have not been published' },
    {
      resource: 'appStoreVersions',
      code: 'X',
      detail: 'The version is already in a review submission',
    },
  );
  assert.deepEqual(
    out.map((b) => b.code),
    [
      'no_screenshots',
      'apple_copyright',
      'apple_pricing',
      'apple_category',
      'apple_privacy_labels',
      'already_submitted',
    ],
  );
  assert.equal(out[0]?.fix.kind, 'screenshots');
});

test('an unknown reason is shown as Apple said it, with its resource, and is never dropped', () => {
  const out = explain({
    resource: 'gameCenterThings',
    code: 'WEIRD.CODE',
    detail: 'Something Apple added next year',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.code, 'apple_reason');
  assert.match(out[0]?.message ?? '', /Something Apple added next year \(gameCenterThings\)/);
});

test('a refusal with no associated reason explains nothing (the caller reads the usual suspects)', () => {
  assert.deepEqual(explainAppleSubmitErrors([GENERIC]), []);
  assert.deepEqual(explainAppleSubmitErrors([]), []);
});

test('the compliance read: only what is missing is blocked, what was not read is not judged', () => {
  assert.deepEqual(appleComplianceBlockers({}), []);
  const out = appleComplianceBlockers({
    contentRightsDeclaration: null,
    ageRatingMissing: ['gambling'],
    build: { processingState: 'VALID', expired: false, usesNonExemptEncryption: null },
    privacyPolicyMissing: ['en-US'],
    primaryCategorySet: false,
  });
  assert.deepEqual(out.map((b) => b.code).sort(), [
    'apple_age_rating',
    'apple_category',
    'apple_content_rights',
    'apple_export_compliance',
    'apple_privacy_policy',
  ]);
  const ok = appleComplianceBlockers({
    contentRightsDeclaration: 'DOES_NOT_USE_THIRD_PARTY_CONTENT',
    ageRatingMissing: [],
    build: { processingState: 'VALID', expired: false, usesNonExemptEncryption: false },
    privacyPolicyMissing: [],
    primaryCategorySet: true,
  });
  assert.deepEqual(ok, []);
  const expired = appleComplianceBlockers({
    build: { processingState: 'VALID', expired: true, usesNonExemptEncryption: null },
  });
  assert.equal(expired[0]?.code, 'build_expired');
});

test('fix kinds: the readiness codes keep their kind (review, build, screenshots), the codes of this mapper are fixed in App Store Connect', () => {
  assert.equal(explain(required('appStoreReviewDetails', 'contactEmail'))[0]?.fix.kind, 'review');
  assert.equal(explain(required('ageRatingDeclarations', 'gambling'))[0]?.fix.kind, 'store');
  assert.equal(appleSubmitFixKind('apple_content_rights'), 'store');
  assert.equal(appleSubmitFixKind('missing_text'), undefined);
});
