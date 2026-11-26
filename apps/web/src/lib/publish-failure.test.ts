import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LastPublish, RunStep } from './pending.ts';
import {
  cleanText,
  clip,
  failureActions,
  failureReport,
  headlineReason,
  inReviewActions,
  isInReview,
  partlyPublished,
  reasonOf,
  runSummary,
  SAID_SHOWN,
  stepLines,
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
    error: 'step_timeout',
    httpStatus: 504,
    outcome: 'unknown',
    message: 'The step did not finish within 8 minutes.',
  });
  assert.equal(bare.said, '');
  assert.equal(bare.technical, 'step_timeout · HTTP 504');
  assert.match(bare.title, /step_timeout|did not finish/);
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
