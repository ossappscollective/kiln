import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import {
  asPushPreview,
  asSubmitPreview,
  blockingItems,
  canPublish,
  chipFor,
  classifyPublishFailure,
  combineTotals,
  discardIds,
  editHref,
  groupItems,
  includedTypes,
  isDiscardable,
  itemAnchor,
  lineFor,
  needsReview,
  nextStepText,
  type PendingItem,
  type PendingSummary,
  type PlanStep,
  type PublishConfig,
  type PublishPlan,
  type PublishResult,
  phraseMatches,
  planReady,
  platformGroups,
  platformTotals,
  previewBody,
  promiseText,
  publishAvailability,
  publishBody,
  requestsFor,
  resultRow,
  resultSummary,
  stateBadge,
  stepRows,
  toggled,
  totalsLine,
} from './pending.ts';

const item = (over: Partial<PendingItem> = {}): PendingItem => ({
  kind: 'listing_text',
  platform: 'ios',
  id: 'listing_text',
  label: '2 listing text changes in 2 languages',
  state: 'staged',
  problems: [],
  nextStep: 'push_draft',
  counts: {},
  refs: [{ id: 'a' }, { id: 'b' }],
  truncated: false,
  since: 1,
  ...over,
});

const config = (
  over: Partial<PublishConfig> = {},
  steps: Partial<Record<string, boolean>> = {},
): PublishConfig => ({
  enabled: true,
  envName: 'MRM_STORE_PUBLISH_BATCH_ENABLED',
  action: 'store.publish',
  minimumRole: 'admin',
  steps: {
    push_draft: {
      action: 'store.push_draft',
      envName: 'MRM_STORE_DRAFT_WRITE_ENABLED',
      enabled: steps.push_draft ?? true,
      irreversible: false,
    },
    submit: {
      action: 'store.submit',
      envName: 'MRM_STORE_SUBMIT_ENABLED',
      enabled: steps.submit ?? true,
      irreversible: true,
    },
    release: {
      action: 'store.release',
      envName: 'MRM_STORE_RELEASE_ENABLED',
      enabled: steps.release ?? true,
      irreversible: true,
    },
    rollout: {
      action: 'releases.rollout',
      envName: 'MRM_STORE_ROLLOUT_ENABLED',
      enabled: steps.rollout ?? true,
      irreversible: true,
    },
  },
  phrase: 'publish <app name> <n> steps',
  note: '',
  ...over,
});

const step = (type: PlanStep['type'], over: Partial<PlanStep> = {}): PlanStep => ({
  type,
  platform: 'ios',
  order: ['push_draft', 'submit', 'release', 'rollout'].indexOf(type) + 1,
  label: type,
  requested: false,
  included: true,
  availability: 'available',
  reason: null,
  requires: {
    action: `store.${type}`,
    envName: `MRM_${type.toUpperCase()}`,
    enabled: true,
    allowed: true,
  },
  irreversible: type !== 'push_draft',
  deferred: false,
  summary: null,
  request: { type },
  preview: null,
  confirmHash: null,
  stepPhrase: null,
  problems: [],
  ...over,
});

const plan = (steps: PlanStep[], over: Partial<PublishPlan> = {}): PublishPlan => {
  const included = steps.filter((s) => s.included);
  return {
    app: { id: 'app1', name: 'Weather', platform: 'ios', store: 'appstoreconnect' },
    steps,
    publishSteps: included.map((s) => s.request ?? { type: s.type }),
    included: included.length,
    irreversible: included.some((s) => s.irreversible),
    irreversibleSteps: included.filter((s) => s.irreversible).map((s) => s.type),
    warnings: [],
    confirmable: included.length > 0,
    planHash: included.length > 0 ? 'a'.repeat(64) : null,
    confirmationRequired: included.some((s) => s.irreversible),
    confirmation: included.some((s) => s.irreversible)
      ? {
          phrase: `publish Weather ${included.length} ${included.length === 1 ? 'step' : 'steps'}`,
          instruction: 'Type it.',
        }
      : null,
    readAt: 1,
    ...over,
  };
};

// ---- grouping

test('items are grouped by kind in a fixed order and an empty kind is left out', () => {
  const groups = groupItems([
    item({ kind: 'in_review', id: 'release:1', nextStep: null, state: 'in_review' }),
    item({ kind: 'asset_set', id: 'en-US/icon' }),
    item({ kind: 'listing_text' }),
    item({ kind: 'approved', id: 'release:2', nextStep: 'release', state: 'approved' }),
    item({ kind: 'asset_set', id: 'de/shot' }),
  ]);
  assert.deepEqual(
    groups.map((g) => g.kind),
    ['listing_text', 'asset_set', 'approved', 'in_review'],
  );
  assert.equal(groups[1]?.items.length, 2);
  assert.deepEqual(groupItems([]), []);
});

test('totals, the summary line and the platform groups', () => {
  const items = [
    item(),
    item({ id: 'x', state: 'invalid', problems: [{ code: 'x', severity: 'error', message: 'm' }] }),
    item({ kind: 'in_review', nextStep: null, state: 'in_review' }),
  ];
  const totals = platformTotals({ items });
  assert.deepEqual(totals, { items: 3, actionable: 2, blocking: 1 });
  assert.equal(totalsLine(totals), '2 waiting for you, 1 with an error, 1 waiting for the store');
  assert.equal(totalsLine({ items: 0, actionable: 0, blocking: 0 }), 'Nothing pending');
  const view = {
    app: { id: 'a', name: 'n', platform: 'ios' as const, store: 'appstoreconnect' as const },
    platforms: [{ platform: 'ios' as const, store: 'appstoreconnect' as const, items, totals }],
    totals: { ...totals, platforms: ['ios' as const], nextSteps: [] },
    lastSyncedAt: null,
    generatedAt: 1,
  };
  const empty = { ...view, platforms: [{ ...view.platforms[0]!, items: [] }] };
  assert.equal(platformGroups([view, empty, null, undefined]).length, 1);
  assert.deepEqual(combineTotals([{ totals }, { totals }]), {
    items: 6,
    actionable: 4,
    blocking: 2,
  });
});

test('words of an item: state, next step, discard and edit links', () => {
  assert.deepEqual(stateBadge('invalid'), { label: 'Has an error', tone: 'bad' });
  assert.equal(stateBadge('in_review').tone, 'neutral');
  assert.match(nextStepText(item()), /push it to the store as a draft/);
  assert.match(nextStepText(item({ nextStep: null, state: 'in_review' })), /store is reviewing/);
  assert.match(nextStepText(item({ state: 'invalid' })), /error is fixed/);
  assert.equal(isDiscardable(item()), true);
  assert.equal(isDiscardable(item({ kind: 'pushed_draft', refs: [] })), false);
  assert.equal(isDiscardable(item({ refs: [] })), false);
  assert.deepEqual(discardIds(item()), ['a', 'b']);
  assert.equal(editHref(item(), 'app1', null).href, '#/portfolio/app1/listing?platform=ios');
  assert.equal(
    editHref(item({ kind: 'asset_set' }), 'app1', 'both').href,
    '#/portfolio/app1/assets?platform=both',
  );
  assert.match(
    editHref(item({ kind: 'release_field' }), 'app1', null).href,
    /releases\?platform=ios&step=build/,
  );
  assert.match(editHref(item({ kind: 'approved' }), 'app1', null).href, /\/releases\?platform=ios/);
});

// ---- summary and the chip

const summary = (apps: Partial<PendingSummary['apps'][number]>[]): PendingSummary => ({
  apps: apps.map((a, i) => ({
    appId: `a${i}`,
    id: `a${i}`,
    app: { id: `a${i}`, name: 'n', platform: 'ios', store: 'appstoreconnect' },
    count: 0,
    blocking: 0,
    waiting: 0,
    kinds: [],
    nextSteps: [],
    ...a,
  })),
  totals: { apps: apps.length, count: 0, blocking: 0 },
  generatedAt: 1,
});

test('the chip says "3 pending", warns when an error blocks, and stays quiet for in review only', () => {
  assert.deepEqual(chipFor({ count: 3, blocking: 0, waiting: 0 }), {
    text: '3 pending',
    tone: 'accent',
    label: '3 pending',
  });
  const warn = chipFor({ count: 3, blocking: 1, waiting: 0 });
  assert.equal(warn?.tone, 'warn');
  assert.equal(warn?.label, '3 pending, 1 with an error');
  assert.equal(chipFor({ count: 0, blocking: 0, waiting: 2 }), null);
  assert.equal(chipFor(null), null);
  assert.equal(chipFor({ count: 120, blocking: 0, waiting: 0 })?.text, '99+ pending');
});

test('the line of an app adds up its platform records and tolerates a missing summary', () => {
  const s = summary([{ count: 2, blocking: 1 }, { count: 1, waiting: 1 }, { count: 5 }]);
  assert.deepEqual(lineFor(s, ['a0', 'a1']), { count: 3, blocking: 1, waiting: 1 });
  assert.equal(lineFor(s, ['zzz']), null);
  assert.equal(lineFor(null, ['a0']), null);
  assert.equal(lineFor(undefined, ['a0']), null);
  assert.equal(lineFor({} as PendingSummary, ['a0']), null);
  assert.equal(lineFor(summary([{ count: 0, waiting: 0 }]), ['a0']), null);
});

// ---- readiness of the button

const totals = { items: 2, actionable: 2, blocking: 0 };

test('the publish button: role, switch, nothing to do, step switches and errors, with how to enable it', () => {
  const base = {
    role: 'admin' as const,
    config: config(),
    configFailed: false,
    totals,
    nextSteps: ['push_draft' as const, 'submit' as const],
  };
  assert.equal(publishAvailability(base).state, 'ready');
  assert.equal(publishAvailability({ ...base, role: 'member' }).state, 'role');
  assert.equal(publishAvailability({ ...base, role: 'viewer' }).state, 'role');
  assert.equal(publishAvailability({ ...base, configFailed: true }).state, 'unknown');
  assert.equal(publishAvailability({ ...base, config: null }).state, 'loading');
  const off = publishAvailability({ ...base, config: config({ enabled: false }) });
  assert.equal(off.state, 'off');
  assert.match((off as { message: string }).message, /MRM_STORE_PUBLISH_BATCH_ENABLED=true/);
  assert.equal(
    publishAvailability({ ...base, totals: { items: 1, actionable: 0, blocking: 0 } }).state,
    'nothing',
  );
  assert.equal(publishAvailability({ ...base, totals: null }).state, 'loading');
  const stepsOff = publishAvailability({
    ...base,
    config: config({}, { push_draft: false, submit: false }),
  });
  assert.equal(stepsOff.state, 'steps_off');
  assert.match(
    (stepsOff as { message: string }).message,
    /MRM_STORE_DRAFT_WRITE_ENABLED, MRM_STORE_SUBMIT_ENABLED/,
  );
  // One step off is not enough to disable: the plan shows that step as switched off.
  assert.equal(
    publishAvailability({ ...base, config: config({}, { submit: false }) }).state,
    'ready',
  );
  const blocked = publishAvailability({
    ...base,
    totals: { items: 2, actionable: 2, blocking: 1 },
  });
  assert.equal(blocked.state, 'blocked');
  assert.match((blocked as { message: string }).message, /1 item has an error/);
  // The role is judged before anything else, so a member never reads about a server switch.
  assert.equal(
    publishAvailability({ ...base, role: 'member', config: config({ enabled: false }) }).state,
    'role',
  );
});

test('blocking items: only items with an error, in page order, with a safe anchor for "Show it"', () => {
  const bad = item({
    id: 'x y',
    label: 'Screenshots',
    state: 'invalid',
    problems: [
      { code: 'x', severity: 'error', message: 'Too small' },
      { code: 'w', severity: 'warning', message: 'Soft' },
    ],
  });
  const groups = [
    {
      appId: 'app/1',
      platform: {
        platform: 'ios' as const,
        store: 'appstoreconnect' as const,
        items: [item(), bad],
        totals: platformTotals({ items: [item(), bad] }),
      },
    },
    {
      appId: 'app2',
      platform: {
        platform: 'android' as const,
        store: 'googleplay' as const,
        items: [item({ problems: [{ code: 'w', severity: 'warning', message: 'Soft' }] })],
        totals: { items: 1, actionable: 1, blocking: 0 },
      },
    },
  ];
  const found = blockingItems(groups);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0]?.messages, ['Too small']);
  assert.equal(found[0]?.platform, 'ios');
  assert.equal(found[0]?.anchor, itemAnchor('app/1', 'x y'));
  assert.match(itemAnchor('app/1', 'x y'), /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(blockingItems([]), []);
});

// ---- the plan as UI state

test('step rows: available steps are ticked, unavailable ones disabled with a reason, the rollout stays a single step', () => {
  const p = plan([
    step('push_draft'),
    step('submit', { deferred: true }),
    step('release', {
      included: false,
      availability: 'feature_disabled',
      reason: 'MRM_RELEASE is off on this server.',
      request: null,
    }),
    step('rollout', {
      included: false,
      availability: 'needs_input',
      reason: 'Name the change.',
      request: null,
    }),
  ]);
  const rows = stepRows(p);
  assert.deepEqual(
    rows.map((r) => [r.type, r.checked, r.toggleable]),
    [
      ['push_draft', true, true],
      ['submit', true, true],
      ['release', false, false],
      ['rollout', false, false],
    ],
  );
  assert.equal(rows[1]!.reason, null);
  assert.equal(rows[1]!.deferred, true);
  assert.match(rows[2]!.reason ?? '', /Switched off on this server \(MRM_RELEASE\)/);
  assert.match(rows[3]!.reason ?? '', /Advanced: do one step/);
  assert.equal(rows[2]!.word, 'Switched off');
  assert.equal(rows[0]!.reason, null);
});

test('step rows: forbidden, blocked, not requested and the Google Play release that needs a track and a share', () => {
  const rows = stepRows(
    plan(
      [
        step('push_draft', { included: false, availability: 'forbidden', request: null }),
        step('submit', {
          included: false,
          availability: 'not_requested',
          reason: 'Not part of this batch.',
          request: null,
        }),
        step('release', {
          included: false,
          availability: 'needs_input',
          reason: 'track_required',
          request: null,
        }),
      ],
      { app: { id: 'a', name: 'Weather', platform: 'android', store: 'googleplay' } },
    ),
  );
  assert.equal(rows[0]!.toggleable, false);
  assert.match(rows[0]!.reason ?? '', /does not allow store\.push_draft/);
  assert.equal(rows[1]!.toggleable, true);
  assert.equal(rows[1]!.checked, false);
  assert.equal(rows[2]!.needsInput, true);
  assert.equal(rows[2]!.toggleable, true);
  const blocked = stepRows(
    plan([
      step('push_draft', {
        included: false,
        availability: 'blocked',
        reason: 'Something stands in the way.',
        request: null,
      }),
    ]),
  );
  assert.equal(blocked[0]!.toggleable, false);
  assert.equal(blocked[0]!.tone, 'bad');
  // An App Store release that needs input is not offered here.
  const apple = stepRows(
    plan([step('release', { included: false, availability: 'needs_input', request: null })]),
  );
  assert.equal(apple[0]!.needsInput, false);
  assert.equal(apple[0]!.toggleable, false);
});

test('toggling keeps the order, and the requests keep the fields of a step that is already in the plan', () => {
  assert.deepEqual(toggled(['push_draft', 'submit'], 'submit', false), ['push_draft']);
  assert.deepEqual(toggled(['submit'], 'push_draft', true), ['push_draft', 'submit']);
  const p = plan([
    step('push_draft'),
    step('submit'),
    step('release', { request: { type: 'release', track: 'production', userFraction: 0.1 } }),
  ]);
  assert.deepEqual(requestsFor(p, ['release', 'push_draft']), [
    { type: 'push_draft' },
    { type: 'release', track: 'production', userFraction: 0.1 },
  ]);
  assert.deepEqual(requestsFor(p, ['push_draft'], {}), [{ type: 'push_draft' }]);
  const without = plan([
    step('push_draft'),
    step('submit', { included: false, availability: 'not_requested', request: null }),
  ]);
  assert.deepEqual(requestsFor(without, ['push_draft', 'submit']), [
    { type: 'push_draft' },
    { type: 'submit' },
  ]);
  assert.deepEqual(
    requestsFor(without, ['release'], {
      release: { type: 'release', track: 'beta', userFraction: 0.05 },
    }),
    [{ type: 'release', track: 'beta', userFraction: 0.05 }],
  );
  assert.deepEqual(includedTypes(p), ['push_draft', 'submit', 'release']);
});

test('a plan is ready only when it is confirmable and the ticks are its own steps', () => {
  const p = plan([step('push_draft'), step('submit')]);
  assert.equal(planReady(p, ['push_draft', 'submit']), true);
  assert.equal(planReady(p, ['push_draft']), false);
  assert.equal(planReady(p, []), false);
  assert.equal(planReady(null, ['push_draft']), false);
  assert.equal(
    planReady(
      plan(
        [
          step('push_draft'),
          step('submit', { included: false, availability: 'blocked', request: null }),
        ],
        { confirmable: false, planHash: null },
      ),
      ['push_draft'],
    ),
    false,
  );
});

test('the preview body names the steps only when the person chose them', () => {
  assert.deepEqual(previewBody(null), {});
  assert.deepEqual(previewBody([{ type: 'push_draft' }]), { steps: [{ type: 'push_draft' }] });
});

// ---- the typed phrase

test('the phrase must equal the server text exactly, case included, ignoring only surrounding spaces', () => {
  assert.equal(phraseMatches('publish Weather 2 steps', 'publish Weather 2 steps'), true);
  assert.equal(phraseMatches('  publish Weather 2 steps  ', 'publish Weather 2 steps'), true);
  assert.equal(phraseMatches('Publish Weather 2 steps', 'publish Weather 2 steps'), false);
  assert.equal(phraseMatches('publish Weather 2  steps', 'publish Weather 2 steps'), false);
  assert.equal(phraseMatches('', ''), false);
  assert.equal(phraseMatches('publish Weather 1 step', 'publish Weather 2 steps'), false);
});

test('publishing needs the phrase of an irreversible plan, and an acknowledgement for a push alone', () => {
  const both = plan([step('push_draft'), step('submit')]);
  const wanted = ['push_draft', 'submit'] as const;
  assert.equal(both.confirmation?.phrase, 'publish Weather 2 steps');
  assert.equal(canPublish(both, wanted, '', true), false);
  assert.equal(canPublish(both, wanted, 'publish Weather 2 steps', false), true);
  assert.equal(canPublish(both, wanted, 'publish Weather 1 step', true), false);
  // The ticks must be the plan's own: an unticked step means the plan is stale until it is previewed again.
  assert.equal(canPublish(both, ['push_draft'], 'publish Weather 2 steps', true), false);
  const push = plan([step('push_draft')]);
  assert.equal(push.confirmation, null);
  assert.equal(canPublish(push, ['push_draft'], '', false), false);
  assert.equal(canPublish(push, ['push_draft'], '', true), true);
  assert.equal(canPublish(null, wanted, 'x', true), false);
});

test('the publish body carries the hash and the plan steps, and the phrase only when the plan asks for it', () => {
  const both = plan([step('push_draft'), step('submit')]);
  assert.deepEqual(publishBody(both, '  publish Weather 2 steps '), {
    planHash: 'a'.repeat(64),
    steps: [{ type: 'push_draft' }, { type: 'submit' }],
    phrase: 'publish Weather 2 steps',
  });
  const push = plan([step('push_draft')]);
  assert.deepEqual(publishBody(push, 'ignored'), {
    planHash: 'a'.repeat(64),
    steps: [{ type: 'push_draft' }],
  });
});

// ---- the previews carried by the plan

test('the preview of a step is only used when it has the shape of that step', () => {
  assert.equal(asPushPreview(null), null);
  assert.equal(asPushPreview({ text: [], assets: [], summary: {}, app: {} }) !== null, true);
  assert.equal(asPushPreview({ contents: {} }), null);
  assert.equal(asSubmitPreview({ text: [] }), null);
  assert.equal(
    asSubmitPreview({ contents: {}, checks: {}, irreversible: [], app: {} }) !== null,
    true,
  );
});

test('the promise of a deferred step is worded from counts and names only', () => {
  assert.equal(
    promiseText({ type: 'submit', summary: { versionString: '2.1', texts: 3, assetSets: 1 } }),
    'Promised: version 2.1, 3 texts, 1 graphics set.',
  );
  assert.equal(
    promiseText({
      type: 'release',
      summary: { track: 'production', userFraction: 0.1, audience: 'percent' },
    }),
    'Promised: track production, 10% of users, a share of users.',
  );
  assert.equal(
    promiseText({
      type: 'push_draft',
      summary: { textChanged: 1, assetSetsChanged: 2, fieldsChanged: 0 },
    }),
    'Promised: 1 text change, 2 graphics sets.',
  );
  assert.match(promiseText({ type: 'submit', summary: null }), /checked again/);
});

// ---- results

const result = (
  steps: PublishResult['steps'],
  over: Partial<PublishResult> = {},
): PublishResult => ({
  app: { id: 'a', name: 'Weather', platform: 'ios', store: 'appstoreconnect' },
  planHash: 'h',
  completed: false,
  applied: steps.filter((s) => s.status === 'applied').length,
  skipped: steps.filter((s) => s.status === 'skipped').length,
  failed: steps.filter((s) => s.status === 'failed').length,
  stoppedAt: null,
  steps,
  pending: { items: 0, actionable: 0, blocking: 0 },
  publishedAt: 1,
  ...over,
});

test('a completed publish says so; a stopped one names the step and offers a new review', () => {
  const ok = resultSummary(
    result(
      [
        { type: 'push_draft', status: 'applied', confirmedByReread: false },
        { type: 'submit', status: 'applied', confirmedByReread: true },
      ],
      { completed: true },
    ),
  );
  assert.equal(ok.tone, 'ok');
  assert.equal(ok.text, '2 steps done.');
  assert.equal(ok.review, false);
  assert.equal(ok.rows[1]?.text, 'Done, confirmed by reading the store back.');

  const stopped = resultSummary(
    result(
      [
        { type: 'push_draft', status: 'applied', confirmedByReread: false },
        {
          type: 'submit',
          status: 'failed',
          error: 'state_changed',
          httpStatus: 409,
          outcome: 'refused',
          message: 'Apple said: secret detail',
        },
        { type: 'release', status: 'skipped', reason: 'previous_step_not_applied', message: 'x' },
      ],
      { stoppedAt: 'submit' },
    ),
  );
  assert.equal(stopped.tone, 'error');
  assert.equal(stopped.title, 'Stopped at: Submit for review');
  assert.equal(stopped.text, '1 done, 1 failed, 1 not run.');
  assert.equal(stopped.review, true);
  assert.equal(stopped.rows[2]?.review, false);
});

test('results use fixed words and never print the text of a store or an unknown code verbatim', () => {
  const failed = resultRow({
    type: 'submit',
    status: 'failed',
    error: 'store_rejected',
    httpStatus: 422,
    outcome: 'refused',
    message: 'Apple says <b>bad</b> token abc123',
  });
  assert.ok(!failed.text.includes('abc123'));
  assert.ok(!failed.text.includes('Apple says'));
  assert.match(failed.text, /The store rejected this step\. Nothing was changed\./);
  const unknown = resultRow({
    type: 'release',
    status: 'failed',
    error: 'Weird Code!<script>',
    httpStatus: 500,
    outcome: 'unknown',
    message: 'raw provider text',
  });
  assert.ok(!unknown.text.includes('raw provider text'));
  assert.ok(!unknown.text.includes('<'));
  assert.match(unknown.text, /did not finish \(eirdodescript\)/);
  assert.match(unknown.text, /outcome is not known/);
  const drifted = resultRow({
    type: 'submit',
    status: 'skipped',
    reason: 'plan_drifted',
    message: 'server text',
  });
  assert.equal(drifted.text, 'Not run: it no longer matched what you reviewed. Review again.');
  assert.equal(drifted.review, true);
  assert.equal(
    resultRow({ type: 'submit', status: 'skipped', reason: 'previous_step_not_applied' }).review,
    false,
  );
  const lost = resultRow({
    type: 'submit',
    status: 'failed',
    error: 'outcome_unknown',
    httpStatus: 409,
    outcome: 'unknown',
  });
  assert.match(lost.text, /Look at the app in the store console/);
});

// ---- failures of the call

const apiError = (status: number, code: string) =>
  new ApiError(status, code, 'raw server text', undefined, {
    error: code,
    message: 'raw server text',
  });

test('failures of preview and publish are worded from fixed text, and drift asks for a new review', () => {
  assert.equal(classifyPublishFailure(apiError(409, 'publish_batch_disabled')).kind, 'disabled');
  assert.match(
    classifyPublishFailure(apiError(409, 'publish_batch_disabled')).message,
    /MRM_STORE_PUBLISH_BATCH_ENABLED=true/,
  );
  const changed = classifyPublishFailure(apiError(409, 'plan_changed'));
  assert.equal(changed.kind, 'plan_changed');
  assert.equal(needsReview(changed), true);
  assert.equal(classifyPublishFailure(apiError(409, 'plan_blocked')).kind, 'plan_changed');
  assert.equal(classifyPublishFailure(apiError(422, 'confirmation_mismatch')).kind, 'mismatch');
  assert.equal(needsReview(classifyPublishFailure(apiError(422, 'confirmation_mismatch'))), false);
  assert.equal(classifyPublishFailure(apiError(409, 'publish_in_progress')).kind, 'in_progress');
  assert.equal(classifyPublishFailure(apiError(409, 'step_disabled')).kind, 'step_disabled');
  assert.equal(classifyPublishFailure(apiError(403, 'forbidden')).kind, 'forbidden');
  assert.equal(classifyPublishFailure(apiError(422, 'invalid_steps')).kind, 'invalid');
  assert.equal(classifyPublishFailure(apiError(404, 'not_found')).kind, 'not_found');
  assert.equal(classifyPublishFailure(new Error('network')).kind, 'other');
  for (const code of ['publish_batch_disabled', 'plan_changed', 'forbidden', 'weird']) {
    assert.ok(
      !classifyPublishFailure(apiError(409, code)).message.includes('raw server text'),
      code,
    );
  }
  assert.match(classifyPublishFailure(apiError(502, 'weird')).message, /Nothing was retried/);
});
