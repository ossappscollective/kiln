import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useLocale } from './i18n/test-setup.ts';
import {
  oneCommitTypes,
  type PlanStep,
  type PublishPlan,
  type PublishStepType,
  planTypes,
  recommendedRequests,
  recommendedSentence,
  replaceReviewSteps,
  requestsFor,
  summaryParts,
  withReplaceReview,
  withWaiting,
} from './pending.ts';
import { publishSummary } from './publish-summary.ts';

/**
 * ONE EDIT, ONE COMMIT (docs/adr/0069-one-play-commit.md), as the dialog and the summary see it. A push and a release on Google Play
 * are one step with one commit: never two that each send for review (Google refuses the second: `changes_in_review`).
 */
useLocale('en');

const ORDER: PublishStepType[] = ['push_draft', 'push_and_submit', 'submit', 'release', 'rollout'];
const step = (type: PublishStepType, over: Partial<PlanStep> = {}): PlanStep =>
  ({
    type,
    platform: 'android',
    order: ORDER.indexOf(type) + 1,
    label: type,
    requested: false,
    included: true,
    availability: 'available',
    reason: null,
    irreversible: type !== 'push_draft',
    deferred: false,
    summary: null,
    request: { type },
    preview: null,
    problems: [],
    ...over,
  }) as PlanStep;
const off = (type: PublishStepType, over: Partial<PlanStep> = {}): PlanStep =>
  step(type, { included: false, availability: 'not_requested', request: null, ...over });

const plan = (steps: PlanStep[], over: Partial<PublishPlan> = {}): PublishPlan =>
  ({
    app: { id: 'a', name: 'Cards', platform: 'android', store: 'googleplay' },
    steps,
    included: steps.filter((s) => s.included).length,
    direct: { track: 'production', versionCodes: ['90'], stagedFraction: null },
    promotion: { from: 'internal', version: '2.00.1' },
    recommended: null,
    ...over,
  }) as PublishPlan;

const RELEASE_SUMMARY = {
  track: 'production',
  userFraction: 1,
  audience: 'all',
  direct: true,
  creates: true,
  versionCodes: ['90'],
  notesLanguages: [],
  sameCommit: true,
};
/** The plan the server makes for the user's case: texts staged and a build to production, as ONE step. */
const oneCommitPlan = (over: Partial<PublishPlan> = {}) =>
  plan(
    [
      step('push_and_submit', {
        request: { type: 'push_and_submit' },
        summary: {
          textChanged: 2,
          assetSetsChanged: 1,
          sendsForReview: true,
          oneCommit: true,
          release: { track: 'production', versionCodes: ['90'], userFraction: 1, audience: 'all' },
        },
      }),
      step('release', {
        request: { type: 'release', track: 'production', userFraction: 1 },
        summary: RELEASE_SUMMARY,
      }),
    ],
    { oneCommit: true, replacesReview: false, ...over },
  );

test('ticking a release next to a push asks for ONE step: the push that sends for review carries the release', () => {
  const p = plan([step('push_draft'), off('release', { availability: 'needs_input' })]);
  assert.deepEqual(oneCommitTypes(p, ['push_draft', 'release']), ['push_and_submit', 'release']);
  assert.deepEqual(oneCommitTypes(p, ['push_and_submit', 'release']), [
    'push_and_submit',
    'release',
  ]);
  // The requests the dialog sends: the combined push and the release with the share, never push_draft + release.
  const asked = requestsFor(p, ['push_draft', 'release'], {
    release: { type: 'release', track: 'production', userFraction: 0.1 },
  });
  assert.deepEqual(asked, [
    { type: 'push_and_submit' },
    { type: 'release', track: 'production', userFraction: 0.1 },
  ]);
  // The draft alone, a release alone, a separate submit, or a build that is not staged: as before.
  assert.deepEqual(oneCommitTypes(p, ['push_draft']), ['push_draft']);
  assert.deepEqual(oneCommitTypes(p, ['release']), ['release']);
  assert.deepEqual(oneCommitTypes(p, ['push_draft', 'submit', 'release']), [
    'push_draft',
    'submit',
    'release',
  ]);
  assert.deepEqual(
    oneCommitTypes(plan([step('push_draft')], { direct: null }), ['push_draft', 'release']),
    ['push_draft', 'release'],
  );
  // The App Store has no such commit: untouched.
  const ios = plan([step('push_draft')], {
    app: { id: 'a', name: 'Cards', platform: 'ios', store: 'appstoreconnect' } as never,
  });
  assert.deepEqual(oneCommitTypes(ios, ['push_draft', 'release']), ['push_draft', 'release']);
});

test('a release that only waits for its share is kept in the plan, so the push it belongs to is not lost', () => {
  const waiting = plan([
    step('push_and_submit', {
      requested: true,
      included: false,
      availability: 'needs_input',
      request: null,
    }),
    off('release', { requested: true, availability: 'needs_input' }),
  ]);
  assert.deepEqual(planTypes(waiting), ['push_and_submit', 'release']);
  assert.deepEqual(withWaiting(waiting, ['release']), ['push_and_submit', 'release']);
});

test('replace the review: only on the push that sends for review, only when asked, and it can be taken off again', () => {
  const asked = withReplaceReview(
    [{ type: 'push_and_submit' }, { type: 'release', track: 'production', userFraction: 1 }],
    true,
  );
  assert.deepEqual(asked[0], { type: 'push_and_submit', replaceReview: true });
  assert.deepEqual(asked[1], { type: 'release', track: 'production', userFraction: 1 });
  assert.deepEqual(withReplaceReview(asked, false)[0], { type: 'push_and_submit' });
  assert.deepEqual(withReplaceReview([{ type: 'push_draft' }], true), [{ type: 'push_draft' }]);
  // What the failure block opens: the replacing push and the release (the share comes from the person, never implied).
  assert.deepEqual(replaceReviewSteps(), [
    { type: 'push_and_submit', replaceReview: true },
    { type: 'release' },
  ]);
  // A plan that has it keeps it when the person ticks something else: the step's own request is sent back.
  const p = oneCommitPlan({ replacesReview: true });
  const push = p.steps.find((s) => s.type === 'push_and_submit') as PlanStep;
  push.request = { type: 'push_and_submit', replaceReview: true };
  assert.deepEqual(requestsFor(p, ['push_and_submit', 'release'])[0], {
    type: 'push_and_submit',
    replaceReview: true,
  });
});

test('the recommendation says it is one commit, or that it replaces the review (and that nothing is sent before the person confirms)', () => {
  const rec = {
    types: ['push_and_submit', 'release'] as PublishStepType[],
    steps: [
      { type: 'push_and_submit' as const },
      { type: 'release' as const, track: 'production', versionCodes: ['90'] },
    ],
    why: 'one_commit' as const,
    needsShare: true,
    replacesReview: false,
  };
  const p = plan([step('push_and_submit'), step('release')], { recommended: rec });
  assert.match(
    recommendedSentence(p, { shareMissing: false }),
    /push the texts and graphics and release the staged build in one step/,
  );
  assert.match(recommendedSentence(p, { shareMissing: false }), /nothing is sent twice/);
  // It asks for the share: with it, the requests to send.
  assert.deepEqual(recommendedRequests(p, { fraction: 1 }), [
    { type: 'push_and_submit' },
    { type: 'release', track: 'production', versionCodes: ['90'], userFraction: 1 },
  ]);
  assert.equal(recommendedRequests(p, { fraction: null }), null);
  const replacing = plan([step('push_and_submit'), step('release')], {
    recommended: {
      ...rec,
      replacesReview: true,
      steps: [{ type: 'push_and_submit', replaceReview: true }, rec.steps[1] as never],
    },
  });
  assert.match(
    recommendedSentence(replacing, { shareMissing: false }),
    /Google Play has changes of this app in review/,
  );
  assert.match(
    recommendedSentence(replacing, { shareMissing: false }),
    /You confirm it first; nothing is sent until you do/,
  );
  assert.deepEqual(recommendedRequests(replacing, { fraction: 1 })?.[0], {
    type: 'push_and_submit',
    replaceReview: true,
  });
});

test('the summary of one commit lists the content honestly: texts, graphics, release codes, track and share, in ONE action', () => {
  const s = publishSummary({
    plan: oneCommitPlan(),
    wanted: ['push_and_submit', 'release'],
    identifier: 'com.example.cards',
  });
  const row = (id: string) => s.rows.filter((r) => r.id === id)[0];
  assert.equal(row('track')?.value, 'Production · 100% of users');
  assert.equal(
    row('release')?.value,
    'Promote version code 90 (2.00.1) from internal to production',
  );
  assert.equal(
    row('review')?.value,
    'The texts, the graphics and the release go to Google Play review together, in one commit',
  );
  assert.equal(
    s.outcome,
    'Pressing Publish pushes these texts and graphics and releases the staged build to Production for 100% of users, all in one step. Review takes the store hours to days; you can follow it in Builds.',
  );
  assert.doesNotMatch(s.outcome, /then|draft/);
  // The step's own numbers say it too (the plan list).
  const parts = summaryParts(oneCommitPlan().steps[0] as PlanStep);
  assert.ok(
    parts.some((x) => /2 text changes/.test(x)),
    parts.join('|'),
  );
  assert.ok(
    parts.some((x) => /production/.test(x)),
    parts.join('|'),
  );
});

test('replacing the review is said in the summary before anything is confirmed', () => {
  const s = publishSummary({
    plan: oneCommitPlan({ replacesReview: true }),
    wanted: ['push_and_submit', 'release'],
    identifier: '',
  });
  assert.match(
    s.outcome,
    /It replaces the review Google Play has in progress; the app loses its place in the review queue\.$/,
  );
  const plain = publishSummary({
    plan: oneCommitPlan(),
    wanted: ['push_and_submit', 'release'],
    identifier: '',
  });
  assert.doesNotMatch(plain.outcome, /replaces the review/);
});

test('French wording for the same sentences', () => {
  useLocale('fr');
  try {
    const s = publishSummary({
      plan: oneCommitPlan({ replacesReview: true }),
      wanted: ['push_and_submit', 'release'],
      identifier: '',
    });
    assert.match(s.outcome, /le tout en une seule étape/);
    assert.match(s.outcome, /perd sa place dans la file d’examen/);
  } finally {
    useLocale('en');
  }
});
