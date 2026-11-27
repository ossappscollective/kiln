import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BlockersView } from './app-state/blockers.ts';
import type { LastPublish, RunStep } from './pending.ts';
import { resultRow } from './pending.ts';
import {
  blockedStep,
  blockerLines,
  blockersSentence,
  cleanText,
  clip,
  failureActions,
  failureReport,
  headlineReason,
  inReviewActions,
  isInReview,
  partlyPublished,
  partlyPublishedNow,
  reasonOf,
  runSummary,
  SAID_SHOWN,
  stepLines,
  submitBlockedOnly,
} from './publish-failure.ts';

const GOOGLE = 'Only releases with status draft may be created on draft app.';
const failedPush: RunStep = {
  type: 'push_draft',
  status: 'failed',
  startedAt: 1_000,
  finishedAt: 2_000,
  error: 'store_rejected',
  httpStatus: 422,
  outcome: 'refused',
  message: 'Google Play treats this app as a draft app.',
  code: 'store.google.draftApp',
  store: {
    kind: 'unexpected',
    httpStatus: 400,
    details: [{ code: 'badRequest', title: 'INVALID_ARGUMENT', detail: GOOGLE }],
  },
};
const run = (steps: RunStep[], over: Partial<LastPublish> = {}): LastPublish => ({
  id: 'run-1',
  platform: 'android',
  startedAt: 1_000,
  finishedAt: 5_000,
  outcome: 'failed',
  completed: false,
  steps: steps.map((s) => s.type),
  results: steps,
  by: { id: 'u1', name: 'Ada' },
  dismissed: false,
  ...over,
});
const skipped = (type: RunStep['type']): RunStep => ({
  type,
  status: 'skipped',
  startedAt: 2_000,
  finishedAt: 2_000,
  reason: 'previous_step_not_applied',
  message: 'Not run: push_draft was not applied.',
});
const lastPublish = run([failedPush, skipped('submit'), skipped('release')]);

test('the reason of a failed step: the title of its code, the advice of the named cause, the words of the store, the technical line', () => {
  const r = reasonOf(failedPush);
  assert.equal(r.title, 'The store rejected this step.');
  assert.match(r.advice, /Google Play treats this app as a draft app/);
  assert.match(r.advice, /Complete the first release in Play Console/);
  assert.equal(r.said, GOOGLE);
  assert.equal(
    r.technical,
    'store_rejected · HTTP 422 · store HTTP 400 · badRequest · INVALID_ARGUMENT',
  );
  assert.match(r.outcome, /./);
});

test("a code this app has no sentence for falls back to the server's English sentence; a step with no store words says only its title", () => {
  const newer = reasonOf({
    ...failedPush,
    code: 'store.google.somethingNew',
    message: 'Brand new problem.',
  });
  assert.equal(newer.advice, 'Brand new problem.');
  const bare = reasonOf({
    type: 'submit',
    status: 'failed',
    startedAt: 1,
    finishedAt: 2,
    error: 'step_brand_new',
    httpStatus: 504,
    outcome: 'unknown',
    message: 'The step did not finish within 8 minutes.',
  });
  assert.equal(bare.said, '');
  assert.equal(bare.technical, 'step_brand_new · HTTP 504');
  assert.match(bare.title, /step_brand_new|did not finish/);
  const odd = reasonOf({ ...failedPush, error: 'weird code!<script>', code: undefined as never });
  assert.doesNotMatch(odd.title + odd.technical, /[<>!]/);
});

test('the lines of a run: done, failed with its reason, not run with its sentence; the summary says where it stopped', () => {
  const lines = stepLines(lastPublish);
  assert.deepEqual(
    lines.map((l) => [l.type, l.status, l.tone, l.reason !== null, l.note !== '']),
    [
      ['push_draft', 'failed', 'bad', true, false],
      ['submit', 'skipped', 'neutral', false, true],
      ['release', 'skipped', 'neutral', false, true],
    ],
  );
  const s = runSummary(lastPublish);
  assert.match(s.title, /Stopped at/);
  assert.match(s.text, /0 done, 1 failed, 2 not run/);
});

test('the headline of a failure is the advice (or the title) and a short quotation of the store', () => {
  const line = headlineReason(lastPublish);
  assert.match(line, /^Google Play treats this app as a draft app/);
  assert.match(line, /Only releases with status draft/);
  assert.equal(headlineReason(run([])), '');
});

test('what a store said is cleaned and cut: no token, no control characters, 300 characters with a Show more', () => {
  const dirty = `Nope.\n\n\u0000 Bearer ya29.a0AfH6SMBx1234567890abcdef and ${'x'.repeat(60)} end`;
  const clean = cleanText(dirty);
  assert.doesNotMatch(clean, /ya29|xxxxxx|\n|\u0000/);
  assert.match(clean, /Bearer \[redacted\]/);
  const long = `${'word '.repeat(200)}`.trim();
  const cut = clip(long);
  assert.equal(cut.cut, true);
  assert.ok(cut.text.length <= SAID_SHOWN);
  assert.ok(cut.text.endsWith('…'));
  assert.deepEqual(clip('short'), { text: 'short', cut: false });
  // The reason applies it to what the server sent, too.
  const tainted = reasonOf({
    ...failedPush,
    store: {
      kind: 'unexpected',
      details: [{ detail: 'Failed with ya29.a0AfH6SMBx1234567890abcdef' }],
    },
  });
  assert.doesNotMatch(tainted.said, /ya29/);
});

test('the copied report holds the app, the times, the steps, the codes, the HTTP statuses and the store words, and no name or token', () => {
  const report = failureReport({
    appName: 'OSS Document Scanner',
    platform: 'android',
    run: run([
      {
        ...failedPush,
        store: {
          kind: 'unexpected',
          httpStatus: 400,
          details: [
            { code: 'badRequest', detail: `${GOOGLE} Bearer ya29.a0AfH6SMBx1234567890abcdef` },
          ],
        },
      },
      skipped('submit'),
    ]),
  });
  assert.match(report, /^Kiln publish report\n/);
  assert.match(report, /App: OSS Document Scanner \(Android\)/);
  assert.match(report, /Started: 1970-01-01T00:00:01\.000Z/);
  assert.match(report, /Steps: push_draft, submit/);
  assert.match(
    report,
    /1\. push_draft: failed \(1970-01-01T00:00:01\.000Z to 1970-01-01T00:00:02\.000Z\)/,
  );
  assert.match(report, /Code: store_rejected/);
  assert.match(report, /HTTP status: 422/);
  assert.match(report, /Cause: store\.google\.draftApp/);
  assert.match(report, /Store: unexpected, HTTP 400/);
  assert.match(
    report,
    /Store said: badRequest: Only releases with status draft may be created on draft app\./,
  );
  assert.match(report, /2\. submit: not run/);
  assert.match(report, /Reason: previous_step_not_applied/);
  assert.doesNotMatch(report, /ya29|Ada|u1/);
});

const GOOGLE_AUTO =
  'Changes are sent for review automatically. The query parameter changesNotSentForReview must not be set.';
const draftRefused: RunStep = {
  type: 'push_draft',
  status: 'failed',
  startedAt: 1_000,
  finishedAt: 2_000,
  error: 'draft_not_allowed',
  httpStatus: 409,
  outcome: 'refused',
  message:
    'Google Play sends these changes for review automatically for this app, so it cannot keep them as a draft.',
  code: 'store.google.draftNotAllowed',
  store: { kind: 'draft_not_allowed', httpStatus: 400, details: [{ detail: GOOGLE_AUTO }] },
};

test('a draft Google Play would not keep: the cause in plain words, Google\'s own sentence, and no "make the change in Play Console instead"', () => {
  const r = reasonOf(draftRefused);
  assert.equal(r.title, 'Google Play would not keep these changes as a draft.');
  assert.match(
    r.advice,
    /sends these changes for review automatically for this app, so it cannot keep them as a draft/,
  );
  assert.doesNotMatch(r.advice + r.title, /instead/);
  assert.equal(r.said, GOOGLE_AUTO);
  assert.equal(r.technical, 'draft_not_allowed · HTTP 409 · store HTTP 400');
  // The report a person copies says the same, with the code the server kept.
  const report = failureReport({
    appName: 'OSS PDF Document Scanner, OCR',
    platform: 'android',
    run: run([draftRefused, skipped('submit'), skipped('release')]),
  });
  assert.match(report, /Code: draft_not_allowed/);
  assert.match(report, /Cause: store\.google\.draftNotAllowed/);
  assert.match(report, /Store said: Changes are sent for review automatically/);
});

test('the actions of a refused draft: push and submit in one step, or the Play Console; nothing for any other failure or for the App Store', () => {
  const refusedRun = run([draftRefused, skipped('submit')]);
  assert.deepEqual(failureActions(refusedRun, 'android'), {
    pushAndSubmit: true,
    playConsoleUrl: 'https://play.google.com/console/',
  });
  assert.deepEqual(failureActions(lastPublish, 'android'), {
    pushAndSubmit: false,
    playConsoleUrl: null,
  });
  assert.deepEqual(failureActions(refusedRun, 'ios'), {
    pushAndSubmit: false,
    playConsoleUrl: null,
  });
  // A refusal in another step (a submit) is not a refused draft.
  const submitRefused = run([{ ...draftRefused, type: 'submit' }]);
  assert.equal(failureActions(submitRefused, 'android').pushAndSubmit, false);
});

// ---------------------------------------------------------------------------------------------
// Partly published, and changes in review (the user's case: texts and graphics in review, the release a draft)

const applied = (type: RunStep['type']): RunStep => ({
  type,
  status: 'applied',
  startedAt: 1_000,
  finishedAt: 2_000,
});
const inReviewRelease: RunStep = {
  type: 'release',
  status: 'failed',
  startedAt: 2_000,
  finishedAt: 3_000,
  error: 'changes_in_review',
  httpStatus: 409,
  outcome: 'refused',
  message: 'Google Play has changes in review for this app.',
  store: {
    kind: 'changes_in_review',
    httpStatus: 400,
    details: [
      {
        code: 'CHANGES_ALREADY_IN_REVIEW',
        detail:
          'You already have changes in review. Cancel this review or wait for it to complete before you try again.',
      },
    ],
  },
};
const userRun = run([applied('push_and_submit'), inReviewRelease], { outcome: 'partial' });

test('a run that applied a step and then failed says what is where, in plain words', () => {
  const partly = partlyPublished(userRun, 'android');
  assert.deepEqual(partly?.applied, ['push_and_submit']);
  assert.deepEqual(partly?.notDone, ['release']);
  assert.equal(
    partly?.sentence,
    'Partly published: the texts and graphics were sent to Google Play for review; the release was not. The release is still a draft in Google Play.',
  );
  // A draft pushed and a release refused: held back, not in review.
  const draft = partlyPublished(run([applied('push_draft'), inReviewRelease]), 'android');
  assert.equal(
    draft?.sentence,
    'Partly published: the texts, graphics and release fields were saved in Google Play as a draft, not sent for review; the release was not.',
  );
  // Nothing applied (a plain failure: nothing changed), or everything applied: not "partly".
  assert.equal(partlyPublished(run([failedPush, skipped('submit')]), 'android'), null);
  assert.equal(partlyPublished(run([applied('push_draft'), applied('submit')]), 'android'), null);
  assert.equal(partlyPublished(run([]), 'android'), null);
});

test('changes in review: the title says it plainly, the technical line keeps the codes, the options are replace, wait, Play Console', () => {
  const lines = stepLines(userRun);
  assert.deepEqual(
    lines.map((l) => [l.type, l.status, l.error]),
    [
      ['push_and_submit', 'applied', null],
      ['release', 'failed', 'changes_in_review'],
    ],
  );
  const reason = lines[1]?.reason;
  assert.equal(
    reason?.title,
    'Google Play already has changes of this app in review, so it cannot take another change now. Nothing was applied by this step.',
  );
  assert.equal(
    reason?.technical,
    'changes_in_review · HTTP 409 · store HTTP 400 · CHANGES_ALREADY_IN_REVIEW',
  );
  assert.match(reason?.said ?? '', /already have changes in review/);
  assert.equal(isInReview(userRun), true);
  assert.deepEqual(inReviewActions(userRun, 'android'), {
    replace: true,
    playConsoleUrl: 'https://play.google.com/console/',
  });
  // Not on the App Store, and not for another failure.
  assert.equal(inReviewActions(userRun, 'ios'), null);
  assert.equal(inReviewActions(lastPublish, 'android'), null);
  assert.equal(isInReview(lastPublish), false);
  assert.match(headlineReason(userRun), /already has changes of this app in review/);
});

test('the report of a partly published run keeps both steps with their codes', () => {
  const report = failureReport({ appName: 'OSS Card Wallet', platform: 'android', run: userRun });
  assert.match(report, /1\. push_and_submit: applied/);
  assert.match(report, /2\. release: failed/);
  assert.match(report, /Code: changes_in_review/);
  assert.match(report, /Store: changes_in_review, HTTP 400/);
  assert.match(report, /CHANGES_ALREADY_IN_REVIEW/);
});

test('an interrupted publish (the server restarted or lost the request) says so, keeps what ended applied, and tells the person to look at the store', () => {
  const interrupted: RunStep = {
    type: 'submit',
    status: 'failed',
    startedAt: 1_000,
    finishedAt: 5_000,
    error: 'interrupted',
    httpStatus: 504,
    outcome: 'unknown',
    message:
      'The publish was interrupted: the server restarted or lost the request. Check the store, then review again.',
    code: 'publish.interrupted',
  };
  const pushed: RunStep = {
    type: 'push_draft',
    status: 'applied',
    startedAt: 1_000,
    finishedAt: 2_000,
  };
  const reason = reasonOf(interrupted);
  assert.equal(
    reason.title,
    'The publish was interrupted: the server restarted or lost the request. Check the store, then review again.',
  );
  assert.equal(reason.advice, '', 'the title already says it');
  assert.match(reason.outcome, /not known/i);
  assert.equal(reason.technical, 'interrupted · HTTP 504');
  const lines = stepLines(run([pushed, interrupted], { outcome: 'partial', platform: 'ios' }));
  assert.deepEqual(
    lines.map((l) => [l.type, l.status]),
    [
      ['push_draft', 'applied'],
      ['submit', 'failed'],
    ],
  );
  assert.ok(
    partlyPublished(run([pushed, interrupted], { outcome: 'partial', platform: 'ios' }), 'ios'),
  );
});

test('a step that took too long has its own sentence, not "did not finish (step_timeout)"', () => {
  const slow: RunStep = {
    type: 'push_draft',
    status: 'failed',
    startedAt: 1,
    finishedAt: 2,
    error: 'step_timeout',
    httpStatus: 504,
    outcome: 'unknown',
  };
  assert.match(reasonOf(slow).title, /took too long/);
  assert.doesNotMatch(reasonOf(slow).title, /step_timeout/);
});

const pushed: RunStep = {
  type: 'push_draft',
  status: 'applied',
  startedAt: 1_000,
  finishedAt: 196_000,
};
const blockedSubmit = (blockers: NonNullable<RunStep['blockers']>): RunStep => ({
  type: 'submit',
  status: 'skipped',
  reason: 'blocked',
  startedAt: 196_000,
  finishedAt: 197_000,
  blockers,
});
const TWO = [
  { code: 'no_build', message: 'No build is attached to the App Store version.' },
  { code: 'missing_text', message: 'Description is empty in fr-FR.', locale: 'fr-FR' },
];

test('a submit that did not run because of blockers: each blocker has its sentence, how to fix it, and where (App Store Connect) when it is fixed there', () => {
  const r = run([pushed, blockedSubmit(TWO)], { platform: 'ios', steps: ['push_draft', 'submit'] });
  const lines = stepLines(r);
  const submit = lines[1]!;
  assert.equal(submit.word, 'Not run');
  assert.equal(submit.note, 'Not run: 2 things stand in the way.');
  assert.deepEqual(
    submit.blockers.map((b) => [b.code, b.message]),
    [
      ['no_build', 'No build is attached to the App Store version.'],
      ['missing_text', 'Description is empty in fr-FR.'],
    ],
  );
  assert.match(submit.blockers[0]!.fix, /Attach a processed build/);
  assert.equal(submit.blockers[0]!.url, 'https://appstoreconnect.apple.com/apps');
  assert.match(submit.blockers[1]!.fix, /Listing page/);
  assert.equal(submit.blockers[1]!.url, null);
  assert.equal(lines[0]!.blockers.length, 0);
  // An older run has no blockers: the plain sentence stands.
  const old = stepLines(run([pushed, { ...blockedSubmit([]), blockers: undefined }]))[1]!;
  assert.equal(old.blockers.length, 0);
  assert.match(old.note, /something now stands in the way/);
});

test('a blocker code this app has no sentence for gets the generic advice, and its message is cleaned', () => {
  const [b] = blockerLines({
    blockers: [{ code: 'brand_new', message: `Needs\u0007 a thing ${'x'.repeat(60)}` }],
  });
  assert.match(b!.fix, /Fix what the message says/);
  assert.equal(b!.url, null);
  assert.doesNotMatch(b!.message, /\u0007/);
  // A token-shaped string is redacted again here, as in every text of a store.
  assert.equal(b!.message, 'Needs a thing [redacted]');
});

test('partly published, submit blocked: "the draft was pushed. Submit for review did not run because: ..." with the blockers, three at most and the rest counted', () => {
  const r = run([pushed, blockedSubmit(TWO)], { platform: 'ios' });
  const partly = partlyPublished(r, 'ios');
  assert.equal(
    partly?.sentence,
    'Partly published: the draft was pushed to App Store. Submit for review did not run because: No build is attached to the App Store version; Description is empty in fr-FR.',
  );
  assert.equal(partly?.blocked?.type, 'submit');
  assert.equal(submitBlockedOnly(r), true);
  const many = Array.from({ length: 5 }, (_, i) => ({
    code: 'missing_text',
    message: `Field ${i} is empty.`,
  }));
  assert.equal(
    blockersSentence(blockerLines({ blockers: many })),
    'Field 0 is empty; Field 1 is empty; Field 2 is empty; and 2 more',
  );
  // Not "only blocked" when a step failed, or when no push was applied.
  assert.equal(submitBlockedOnly(run([failedPush, blockedSubmit(TWO)])), false);
  assert.equal(submitBlockedOnly(run([blockedSubmit(TWO)])), false);
  assert.equal(blockedStep(run([pushed])), null);
});

test('the copied report of a blocked submit says why: reason blocked, each blocker with how to fix it', () => {
  const text = failureReport({
    appName: 'OSS Document Scanner',
    platform: 'ios',
    run: run([pushed, blockedSubmit(TWO)], { platform: 'ios', steps: ['push_draft', 'submit'] }),
  });
  assert.match(text, /2\. submit: not run/);
  assert.match(
    text,
    /Reason: blocked - No build is attached to the App Store version; Description is empty in fr-FR/,
  );
  assert.match(text, /Blocker: no_build: No build is attached to the App Store version\./);
  assert.match(
    text,
    /Fix: Attach a processed build to the version in App Store Connect, then submit\. \(https:\/\/appstoreconnect\.apple\.com\/apps\)/,
  );
  assert.match(text, /Blocker: missing_text: Description is empty in fr-FR\./);
});

test('the result row of the publish dialog names the blockers of a skipped step, not only "blocked"', () => {
  const row = resultRow({ type: 'submit', status: 'skipped', reason: 'blocked', blockers: TWO });
  assert.equal(
    row.text,
    'Not run, because: No build is attached to the App Store version; Description is empty in fr-FR.',
  );
  assert.equal(row.review, true);
  const bare = resultRow({ type: 'submit', status: 'skipped', reason: 'blocked' });
  assert.match(bare.text, /something now stands in the way/);
});

test('a submit blocked because the App Review contact is missing: its sentence, how to fix it (copy it or App Store Connect) and the link', () => {
  const r = run(
    [
      pushed,
      blockedSubmit([
        {
          code: 'no_review_contact',
          message: 'The App Review contact information is incomplete: phone number is missing.',
        },
        {
          code: 'no_review_demo_account',
          message:
            'App Review information says a demo account is required, but its user name or password is empty.',
        },
      ]),
    ],
    { platform: 'ios', steps: ['push_draft', 'submit'] },
  );
  const submit = stepLines(r)[1]!;
  assert.deepEqual(
    submit.blockers.map((b) => b.code),
    ['no_review_contact', 'no_review_demo_account'],
  );
  assert.match(
    submit.blockers[0]!.fix,
    /Copy the review information from the previous version in the submit checklist/,
  );
  assert.match(submit.blockers[1]!.fix, /demo account/);
  assert.equal(submit.blockers[0]!.url, 'https://appstoreconnect.apple.com/apps');
  assert.equal(submit.blockers[1]!.url, 'https://appstoreconnect.apple.com/apps');
  assert.notEqual(submit.blockers[0]!.fix, submit.blockers[1]!.fix);
  assert.match(blockersSentence(submit.blockers), /contact information is incomplete/);
});

const COUNT = {
  code: 'asset_spec',
  message:
    'At most 10 screenshots per device size. en-US iPad 13" / 12.9" (APP_IPAD_PRO_3GEN_129): 12 found.',
  locale: 'en-US',
};
const viewOf = (state: BlockersView['state'], current: BlockersView['current']): BlockersView => ({
  state,
  current,
  run: [],
  resolved: [],
  runAt: 197_000,
  readAt: state === 'unverified' ? null : 300_000,
  runLabel: '',
  readLabel: '',
  summary: '',
  checking: false,
  error: null,
  versionString: '2.0.1',
});

test('too many screenshots in one set: the advice is to remove screenshots, not to replace an image', () => {
  const [b] = blockerLines({ blockers: [COUNT] });
  assert.match(b!.fix, /Remove the extra screenshots/);
  // Another asset_spec problem keeps the generic asset advice.
  const [other] = blockerLines({
    blockers: [{ code: 'asset_spec', message: 'Screenshot is 100x100.' }],
  });
  assert.doesNotMatch(other!.fix, /Remove the extra screenshots/);
});

test("partlyPublishedNow: fixed blockers say so, standing ones are named instead of the run's, no reading keeps the run's sentence", () => {
  const r = run([pushed, blockedSubmit(TWO)], { platform: 'ios' });
  const own = partlyPublished(r, 'ios')!.sentence;
  assert.equal(partlyPublishedNow(r, 'ios', null)!.sentence, own);
  assert.equal(partlyPublishedNow(r, 'ios', viewOf('unverified', []))!.sentence, own);
  assert.match(
    partlyPublishedNow(r, 'ios', viewOf('ready', []))!.sentence,
    /everything that blocked the submit is fixed now/,
  );
  const now = partlyPublishedNow(
    r,
    'ios',
    viewOf('blocked', blockerLines({ blockers: [TWO[1]!] })),
  )!.sentence;
  assert.match(now, /Description is empty in fr-FR/);
  assert.doesNotMatch(now, /No build is attached/);
});

test("failureReport with a current reading keeps the run's list as history and adds what blocks now", () => {
  const r = run([pushed, blockedSubmit([COUNT])], {
    platform: 'ios',
    steps: ['push_draft', 'submit'],
  });
  const plain = failureReport({ appName: 'OSS Document Scanner', platform: 'ios', run: r });
  assert.doesNotMatch(plain, /Blockers now/);
  const ready = failureReport({
    appName: 'OSS Document Scanner',
    platform: 'ios',
    run: r,
    blockers: viewOf('ready', []),
  });
  assert.match(ready, /history, not necessarily true now/);
  assert.match(
    ready,
    /Blockers now \(store read .*\): none, everything that blocked the submit is fixed/,
  );
  const still = failureReport({
    appName: 'OSS Document Scanner',
    platform: 'ios',
    run: r,
    blockers: viewOf('blocked', blockerLines({ blockers: [COUNT] })),
  });
  assert.match(still, /Blockers now \(store read .*\): 1\n {3}Blocker: asset_spec/);
  assert.match(
    failureReport({ appName: 'A', platform: 'ios', run: r, blockers: viewOf('unverified', []) }),
    /not checked since this run/,
  );
});
