import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoreError } from '../errors.ts';
import { googleError } from './googleplay.ts';
import { googleFacts, playCauseOf } from './play-causes.ts';

/** A fake Google error body: `{ error: { code, message, errors: [{ reason }], status } }`. */
const body = (status: number, message: string, reason = '', googleStatus = '') => ({
  status,
  headers: new Headers(),
  malformed: false,
  json: {
    error: {
      code: status,
      message,
      ...(reason ? { errors: [{ message, domain: 'androidpublisher', reason }] } : {}),
      ...(googleStatus ? { status: googleStatus } : {}),
    },
  },
});

const causeOf = (status: number, message: string, reason = '', googleStatus = '') =>
  playCauseOf(googleFacts(body(status, message, reason, googleStatus)))?.cause ?? null;

test('googleFacts reads the message, the reasons and the status of Google, and survives other bodies', () => {
  const facts = googleFacts(body(403, 'The  caller\n does not have permission', 'forbidden', 'PERMISSION_DENIED'));
  assert.deepEqual(facts, {
    status: 403,
    message: 'The caller does not have permission',
    reasons: 'forbidden',
    googleStatus: 'PERMISSION_DENIED',
  });
  assert.deepEqual(googleFacts({ status: 500, json: '<html>' }), {
    status: 500,
    message: '',
    reasons: '',
    googleStatus: '',
  });
  assert.equal(googleFacts({ status: 400 }).message, '');
});

test('a draft app, a used version code, a lower one, long notes, an incomplete listing, an edit conflict, a missing permission, a refusal to send for review', () => {
  assert.equal(causeOf(400, 'Only releases with status draft may be created on draft app.'), 'draftApp');
  assert.equal(
    causeOf(403, 'Version code 92 has already been used. Try a different version code.', 'apkUpgradeVersionConflict'),
    'versionCodeUsed',
  );
  assert.equal(causeOf(400, 'Version code 3 is too low: it is lower than the version code 90 of an existing build.'), 'versionCodeLow');
  assert.equal(causeOf(400, 'APK specifies a version code that is not an upgrade', 'apkNoUpgradePath'), 'versionCodeLow');
  assert.equal(
    causeOf(400, 'Release notes for language en-US are too long (maximum 500 characters).'),
    'notesTooLong',
  );
  assert.equal(
    causeOf(400, 'You must provide a feature graphic before this release can be published.'),
    'listingIncomplete',
  );
  assert.equal(causeOf(409, 'The edit has already been committed.', 'editAlreadyCommitted'), 'editConflict');
  assert.equal(
    causeOf(403, 'The caller does not have permission to release to the production track.', 'forbidden', 'PERMISSION_DENIED'),
    'releasePermission',
  );
  assert.equal(
    causeOf(400, 'Changes cannot be sent for review because your app has not completed the content rating questionnaire.'),
    'sendForReview',
  );
});

test('parameters name what Google named: the version code, the language, the missing item, the reason after "because"', () => {
  const used = playCauseOf(googleFacts(body(403, 'Version code 92 has already been used.')));
  assert.deepEqual(used?.params, { versionCode: '92' });
  const notes = playCauseOf(googleFacts(body(400, 'Release notes for language de-DE are too long.')));
  assert.deepEqual(notes?.params, { language: 'de-DE' });
  const listing = playCauseOf(googleFacts(body(400, 'A feature graphic is required.')));
  assert.deepEqual(listing?.params, { item: 'feature graphic' });
  const review = playCauseOf(
    googleFacts(body(400, 'Changes cannot be sent for review because the privacy policy is missing.')),
  );
  assert.deepEqual(review?.params, { reason: 'the privacy policy is missing.' });
});

test('what is not a known cause stays unnamed: server errors, 401, 404, 429 and unknown wording', () => {
  assert.equal(causeOf(500, 'Only releases with status draft may be created on draft app.'), null);
  assert.equal(causeOf(401, 'Invalid Credentials'), null);
  assert.equal(causeOf(404, 'Package not found: com.acme.app'), null);
  assert.equal(causeOf(429, 'Rate limit exceeded', 'rateLimitExceeded'), null);
  assert.equal(causeOf(400, 'Something else entirely went wrong.'), null);
  assert.equal(causeOf(403, 'The caller does not have permission'), null);
});

test('googleError with causes names the cause, keeps what Google said, and never changes other callers', () => {
  const reply = body(400, 'Only releases with status draft may be created on draft app.', 'badRequest', 'INVALID_ARGUMENT');
  const named = googleError(reply, 'updating the track', { packageName: 'com.acme.app', causes: true });
  assert.ok(named instanceof StoreError);
  assert.equal(named.code, 'store.google.draftApp');
  assert.equal(named.status, 400);
  assert.equal(named.details?.[0]?.detail, 'Only releases with status draft may be created on draft app.');
  assert.equal(named.details?.[0]?.code, 'badRequest');
  assert.equal(named.details?.[0]?.title, 'INVALID_ARGUMENT');

  // Without `causes` (reviews, analytics, products) the error is what it always was.
  const plain = googleError(reply, 'updating the track', { packageName: 'com.acme.app' });
  assert.equal(plain.code, undefined);
  assert.equal(plain.details, undefined);
  assert.match(plain.message, /HTTP 400/);

  // A missing permission is a `forbidden` error that carries Google's sentence.
  const denied = googleError(
    body(403, 'The caller does not have permission to release to the production track.', 'forbidden'),
    'committing the edit',
    { causes: true },
  );
  assert.equal(denied.kind, 'forbidden');
  assert.equal(denied.code, 'store.google.releasePermission');

  // A refusal with no known cause keeps Google's message in the details, and the old sentence.
  const unknown = googleError(body(400, 'Strange new wording.', 'invalid'), 'updating the track', {
    causes: true,
  });
  assert.equal(unknown.kind, 'unexpected');
  assert.match(unknown.message, /Strange new wording/);
  assert.equal(unknown.details?.[0]?.detail, 'Strange new wording.');

  // A plain 403 without a cause keeps the access message and still shows Google's words.
  const generic = googleError(body(403, 'The caller does not have permission', 'forbidden'), 'reading', {
    packageName: 'com.acme.app',
    causes: true,
  });
  assert.equal(generic.code, 'store.google.noAccessPackage');
  assert.equal(generic.details?.[0]?.detail, 'The caller does not have permission');
});
