import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { useLocale } from './i18n/test-setup.ts';
import {
  emptySelectionHint,
  isRecommended,
  type PlanRecommendation,
  type PlanStep,
  type PublishPlan,
  type PublishStepType,
  recommendedRequests,
  recommendedSentence,
  releaseIsDirect,
  shouldAutoRecommend,
  stepRows,
  visibleRows,
} from './pending.ts';
import { publishSummary } from './publish-summary.ts';
import { publishDisabledReason } from './readability.ts';

/**
 * A person is never left with an empty plan while a valid step exists: the plan recommends one (`plan.recommended`), the dialog starts
 * from it and offers it again ("Use the recommended step") when everything is unticked. Pure helpers only; the dialog is wiring.
 */
useLocale('en');

const step = (type: PublishStepType, over: Partial<PlanStep> = {}): PlanStep =>
  ({
    type,
    platform: 'android',
    order: ['push_draft', 'push_and_submit', 'submit', 'release', 'rollout'].indexOf(type) + 1,
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

const RELEASE: PlanRecommendation = {
  types: ['release'],
  steps: [{ type: 'release', direct: true, track: 'production', versionCodes: ['90'] }],
  why: 'promotion',
  needsShare: true,
};

const plan = (steps: PlanStep[], over: Partial<PublishPlan> = {}): PublishPlan =>
  ({
    app: { id: 'a', name: 'Cards', platform: 'android', store: 'googleplay' },
    steps,
    included: steps.filter((s) => s.included).length,
    direct: { track: 'production', versionCodes: ['90'], stagedFraction: null },
    promotion: { from: 'internal', version: '2.00.1' },
    recommended: RELEASE,
    ...over,
  }) as PublishPlan;

/** What the person met: a plan with nothing in it (the share is still to give), a draft row and a rollout row. */
const emptyPlan = () =>
  plan([
    off('push_draft'),
    off('push_and_submit', { availability: 'nothing_to_do' }),
    off('submit'),
    step('release', { included: false, availability: 'needs_input', request: null }),
    off('rollout'),
  ]);

test('the recommended release gets the share the person gave, and never one that was not given', () => {
  const p = emptyPlan();
  assert.deepEqual(recommendedRequests(p, { fraction: 1 }), [
    { type: 'release', direct: true, track: 'production', versionCodes: ['90'], userFraction: 1 },
  ]);
  assert.deepEqual(recommendedRequests(p, { fraction: 0.25 })?.[0]?.userFraction, 0.25);
  assert.equal(
    recommendedRequests(p, { fraction: null }),
    null,
    "a share is the person's, never implied",
  );
  // The plan's own request is not changed by it.
  assert.equal(RELEASE.steps[0]?.userFraction, undefined);
});

test('a recommended step that needs no share is returned as it is; no recommendation gives nothing', () => {
  const draft = plan([step('push_draft')], {
    recommended: {
      types: ['push_draft'],
      steps: [{ type: 'push_draft' }],
      why: 'draft',
      needsShare: false,
    },
  });
  assert.deepEqual(recommendedRequests(draft, { fraction: null }), [{ type: 'push_draft' }]);
  assert.equal(recommendedRequests(plan([], { recommended: null }), { fraction: 1 }), null);
  assert.equal(recommendedRequests(null, { fraction: 1 }), null);
  assert.equal(
    recommendedRequests(plan([], { recommended: undefined }), { fraction: 1 }),
    null,
    'an older server',
  );
});

test('nothing ticked is a hint with the recommended step, never an error; with no recommendation it says nothing applies', () => {
  const p = emptyPlan();
  assert.deepEqual(emptySelectionHint(p, []), {
    kind: 'recommend',
    why: 'promotion',
    needsShare: true,
    types: ['release'],
  });
  assert.equal(emptySelectionHint(p, ['release']), null);
  assert.equal(emptySelectionHint(null, []), null);
  assert.deepEqual(emptySelectionHint(plan([], { recommended: null }), []), { kind: 'nothing' });
  // Unticking the draft of a draft plan offers the draft again.
  const draft = plan([step('push_draft')], {
    recommended: {
      types: ['push_draft'],
      steps: [{ type: 'push_draft' }],
      why: 'draft',
      needsShare: false,
    },
  });
  assert.equal(emptySelectionHint(draft, [])?.kind, 'recommend');
});

test('the dialog starts from the recommended step when the first plan holds nothing; a plan that holds steps is left alone', () => {
  assert.equal(shouldAutoRecommend(emptyPlan()), true);
  assert.equal(shouldAutoRecommend(plan([step('push_draft')])), false);
  assert.equal(shouldAutoRecommend(plan([], { recommended: null })), false);
  assert.equal(isRecommended(plan([step('release')]), ['release']), true);
  assert.equal(isRecommended(plan([step('push_draft')]), ['push_draft']), false);
  assert.equal(isRecommended(emptyPlan(), []), false);
});

test('a release added by the person is direct when a build is staged and no draft push is in the plan', () => {
  const p = emptyPlan();
  assert.equal(
    releaseIsDirect(p, [], false),
    true,
    'the build is released, not rolled out from a draft that is not there',
  );
  assert.equal(
    releaseIsDirect(p, ['push_draft'], false),
    false,
    'with a draft push first, it rolls out that draft',
  );
  assert.equal(releaseIsDirect(p, ['push_and_submit'], false), false);
  assert.equal(
    releaseIsDirect(p, ['push_draft'], true),
    true,
    'a plan that was made direct stays so',
  );
  assert.equal(
    releaseIsDirect(plan([], { direct: null }), [], false),
    false,
    'nothing staged to release',
  );
  assert.equal(releaseIsDirect(null, [], false), false);
});

test('hidden steps say why, and the step the person asked for is never hidden', () => {
  const p = plan([
    off('push_draft'),
    off('push_and_submit', { availability: 'nothing_to_do' }),
    off('submit'),
    step('release', { included: false, availability: 'needs_input', request: null }),
    off('rollout'),
  ]);
  const shown = visibleRows(stepRows(p));
  assert.deepEqual(shown.leftBy.unsupported, ['submit'], 'Google Play has no separate submit');
  assert.equal(shown.leftBy.nothing.length, 1, 'nothing to push: only release fields are staged');
  assert.deepEqual(
    shown.shown.map((r) => r.type),
    ['push_draft', 'release', 'rollout'],
  );
  for (const names of [shown.leftBy.unsupported, shown.leftBy.nothing, shown.leftBy.optional])
    assert.equal(
      names.some((n) => /release/i.test(n) && !/review/i.test(n)),
      false,
      'the release the person needs is not listed as hidden',
    );

  // The person asked for a release and there is nothing to start: it stays on the screen with its reason.
  const asked = plan([
    off('push_draft'),
    off('push_and_submit'),
    off('submit'),
    step('release', {
      included: false,
      requested: true,
      availability: 'nothing_to_do',
      reason: 'Nothing is waiting to be released.',
      request: null,
    }),
    off('rollout'),
  ]);
  const rows = visibleRows(stepRows(asked));
  assert.equal(
    rows.shown.some((r) => r.type === 'release'),
    true,
  );
  assert.equal(rows.leftBy.nothing.length, 0);
});

test('the sentence names the recommended step and why, in plain words', () => {
  const p = emptyPlan();
  assert.equal(
    recommendedSentence(p, { shareMissing: false }),
    'Recommended: promote this build to production and send it for review in one step. A promotion is not kept as a draft: Google Play sends it for review when it is committed.',
  );
  assert.match(recommendedSentence(p, { shareMissing: true }), /Say which share of users gets it/);
  assert.match(
    recommendedSentence(
      plan([], {
        recommended: {
          ...RELEASE,
          why: 'draft_refused',
          types: ['push_and_submit'],
          steps: [{ type: 'push_and_submit' }],
          needsShare: false,
        },
      }),
      { shareMissing: false },
    ),
    /push the changes and send them for review in one step/,
  );
  assert.equal(recommendedSentence(plan([], { recommended: null }), { shareMissing: false }), '');
});

test('the footer names the recommended step when nothing is ticked', () => {
  const base = {
    phase: 'ready',
    stale: false,
    ready: false,
    wanted: 0,
    plan: { confirmable: false, confirmationRequired: false, confirmation: null },
  };
  assert.equal(
    publishDisabledReason({ ...base, recommended: true }),
    'Nothing is ticked. Use the recommended step, or tick one.',
  );
  assert.equal(publishDisabledReason({ ...base }), 'Tick at least one step to publish.');
});

test('a promotion reads as a promotion: the release row and the outcome sentence', () => {
  const p = plan(
    [
      off('push_draft'),
      step('release', {
        order: 4,
        request: { type: 'release', direct: true },
        irreversible: true,
        summary: {
          track: 'production',
          userFraction: 1,
          audience: 'all',
          direct: true,
          versionCodes: ['90'],
          notesLanguages: [],
        },
      }),
    ],
    { defaultedToDirect: true },
  );
  const s = publishSummary({ plan: p, wanted: ['release'], identifier: 'com.akylas.cardwallet' });
  assert.equal(
    s.rows.find((r) => r.id === 'release')?.value,
    'Promote version code 90 (2.00.1) from internal to production',
  );
  assert.equal(
    s.outcome,
    'Pressing Publish promotes this build to production and sends it for review. Review takes the store hours to days; you can follow it in Builds.',
  );
  // A staged share is named.
  const shared = publishSummary({
    plan: {
      ...p,
      steps: [
        off('push_draft'),
        step('release', {
          request: { type: 'release', direct: true },
          summary: {
            track: 'production',
            userFraction: 0.25,
            audience: 'percent',
            direct: true,
            versionCodes: ['90'],
            notesLanguages: [],
          },
        }),
      ],
    } as PublishPlan,
    wanted: ['release'],
    identifier: '',
  });
  assert.match(
    shared.outcome,
    /^Pressing Publish promotes this build to production for 25% of users and sends it for review\./,
  );
  // Without a version the plan does not carry, the row says no more than it knows.
  const bare = publishSummary({
    plan: { ...p, promotion: { from: 'internal', version: null } } as PublishPlan,
    wanted: ['release'],
    identifier: '',
  });
  assert.equal(
    bare.rows.find((r) => r.id === 'release')?.value,
    'Promote version code 90 from internal to production',
  );
  // A build the sync does not show in another track is a release, not a promotion.
  const plain = publishSummary({
    plan: { ...p, promotion: { from: null, version: null } } as PublishPlan,
    wanted: ['release'],
    identifier: '',
  });
  assert.equal(plain.rows.find((r) => r.id === 'release')?.value, 'Version code 90');
  assert.match(plain.outcome, /sends the staged release to Production/);
});

test('the dialog starts from the recommendation, offers it again when nothing is ticked, and never publishes by itself', () => {
  const dialog = readFileSync(
    new URL('../components/publish/PublishDialog.svelte', import.meta.url),
    'utf8',
  );
  // The first default plan that holds nothing is asked again with the recommended step (the default plan only, never a scoped one).
  assert.match(
    dialog,
    /first && !addKnownRelease\(out\.plan\) && steps === null\) useRecommendedAtStart\(out\.plan\)/,
  );
  assert.match(dialog, /recommendedRequests\(made, \{ fraction: knownFraction\(\) \}\)/);
  // An empty selection is a neutral hint with one click, not the red "cannot be published" box.
  assert.match(
    dialog,
    /\{#if emptyHint\}[\s\S]*data-testid="plan-empty-hint"[\s\S]*onclick=\{useRecommended\}[\s\S]*\{:else if !plan\.confirmable\}/,
  );
  assert.doesNotMatch(dialog, /dialog\.tickOne/);
  // A release added next to no draft push is direct, so it cannot come back as "nothing to do".
  assert.match(dialog, /releaseIsDirect\(plan, wanted, direct\)/);
  // The draft pair is under an Advanced disclosure with the warning; the publish call is still in one place.
  assert.match(dialog, /publish:dialog\.advancedDraft'[\s\S]*publish:dialog\.advancedDraftWarning/);
  assert.equal((dialog.match(/api\.publishPending\(/g) ?? []).length, 1);
});
