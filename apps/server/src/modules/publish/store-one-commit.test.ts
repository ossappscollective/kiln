import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { StoreError } from '@kiln/connectors';
import { PASSWORD } from '../../testkit.ts';
import { bootStaged, type StagedBoot } from './test-helpers.ts';

/**
 * ONE EDIT, ONE COMMIT on Google Play (docs/adr/0069-one-play-commit.md). A person who promotes a build with staged texts or graphics
 * used to get a plan of `push_and_submit` THEN `release`: two commits that each send for review. Google refused the second one
 * (`changes_in_review`), the texts and graphics stayed in review and the release stayed a draft. Now `push_and_submit` and `release`
 * named together are ONE step with ONE commit; a refusal leaves nothing applied; the person can replace the review in progress with
 * everything together, explicitly. Everything runs against fakes: no store is contacted.
 */

const HASH = 'a'.repeat(64);

async function boot(db: Parameters<typeof bootStaged>[0]) {
  const t = await bootStaged(db, { extra: { storePublish: { enabled: true } } });
  const path = (app: string, rest = '') => `/apps/${app}/publish${rest}`;
  const plan = (app: string, steps?: unknown[], cookie = t.owner) =>
    t.call(cookie, 'POST', path(app, '/preview'), steps === undefined ? {} : { steps });
  const publish = (app: string, body: Record<string, unknown>, cookie = t.owner) =>
    t.call(cookie, 'POST', path(app), body);
  const planAndPublish = async (app: string, steps?: unknown[]) => {
    const p = await plan(app, steps);
    if (p.status !== 200 || !p.body.plan.confirmable) return { plan: p, publish: p };
    return {
      plan: p,
      publish: await publish(app, {
        planHash: p.body.plan.planHash,
        steps: p.body.plan.publishSteps,
        ...(p.body.plan.confirmation ? { phrase: p.body.plan.confirmation.phrase } : {}),
      }),
    };
  };
  const bearer = async (token: string, method: string, rest: string, body?: unknown) => {
    const res = await t.app.request(`/api/workspaces/${t.workspaceId}${rest}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const mint = async (input: Record<string, unknown>) => {
    const res = await t.call(t.owner, 'POST', '/tokens', { name: 'T', role: 'admin', ...input });
    assert.equal(res.status, 201, res.text);
    return res.body.token as string;
  };
  return { ...t, path, plan, publish, planAndPublish, bearer, mint };
}

/** The user's case: a text staged AND a build staged for production (the promotion with texts). */
const stagePromotion = async (t: StagedBoot, name = 'Weather') => {
  const app = await t.addApp('android', name);
  assert.equal(
    (await t.stageText(app, { locale: 'en-US', field: 'title', from: 'local', value: 'Acme' })).status,
    200,
  );
  for (const body of [
    { field: 'track', value: 'production' },
    { field: 'version_codes', value: '241' },
    { field: 'release_notes', locale: 'en-US', value: 'Bug fixes' },
  ])
    assert.equal((await t.stageField(app, body)).status, 200);
  return app;
};
const stepOf = (body: any, type: string) => (body.plan.steps as any[]).find((s) => s.type === type);
const resultOf = (res: { body: any }, type: string) =>
  (res.body.result.steps as any[]).find((s) => s.type === type);
/** What the dialog sends for "texts, graphics and the release together". */
const TOGETHER = [
  { type: 'push_and_submit' },
  { type: 'release', track: 'production', versionCodes: ['241'], userFraction: 1 },
];

dbTest(
  'push_and_submit + release is ONE step: the push carries the whole content, the release runs nothing of its own, one phrase for the two rows',
  async (db) => {
    const t = await boot(db);
    const app = await stagePromotion(t);
    const p = await t.plan(app, TOGETHER);
    assert.equal(p.status, 200, p.text.slice(0, 300));
    const plan = p.body.plan;
    assert.equal(plan.confirmable, true, JSON.stringify(plan.steps.map((s: any) => [s.type, s.reason, s.problems])));
    assert.equal(plan.oneCommit, true);
    assert.equal(plan.replacesReview, false);
    const push = stepOf(p.body, 'push_and_submit');
    assert.match(push.label, /release the staged build in one step, sent to Google for review/);
    assert.equal(push.summary.oneCommit, true);
    assert.equal(push.summary.sendsForReview, true);
    assert.equal(push.summary.textChanged, 1);
    assert.deepEqual(push.summary.release, {
      track: 'production',
      versionCodes: ['241'],
      userFraction: 1,
      audience: 'all',
    });
    assert.ok(push.problems.some((x: any) => x.code === 'one_commit'));
    assert.deepEqual(
      [push.requires.action, push.requires.envName],
      ['store.release', 'KILN_STORE_RELEASE_ENABLED'],
    );
    const release = stepOf(p.body, 'release');
    assert.equal(release.included, true);
    assert.equal(release.summary.sameCommit, true);
    assert.equal(release.confirmHash, null, 'it runs nothing of its own');
    assert.equal(plan.confirmation.phrase, 'publish Weather 2 steps');
    assert.equal(plan.warnings.length, 0);

    const res = await t.publish(app, {
      planHash: plan.planHash,
      phrase: plan.confirmation.phrase,
      steps: plan.publishSteps,
    });
    assert.equal(res.status, 200, res.text.slice(0, 400));
    assert.deepEqual([res.body.result.completed, res.body.result.applied], [true, 2]);
    const done = resultOf(res, 'push_and_submit');
    assert.deepEqual([done.status, done.result.commit, done.result.released], ['applied', 'sent_for_review', true]);
    assert.match(done.result.note, /ONE edit and sent to Google Play in ONE commit/);
    assert.equal(resultOf(res, 'release').status, 'applied');
    // ONE call to the store for everything, and the release connector (a second edit, a second commit) was never reached.
    assert.equal(t.stores.android.pushAndSubmitCalls, 1);
    assert.equal(t.stores.android.applyCalls, 1);
    assert.equal(t.releaseStores.android.releaseCalls, 0);
    assert.equal(t.submitStores.android.submitCalls, 0);
    assert.deepEqual(t.stores.android.lastInput?.start, { userFraction: 1 });
    assert.equal(t.stores.android.lastInput?.replaceReview, undefined);
    assert.deepEqual(t.stores.android.releasesMade, [
      { track: 'production', versionCodes: ['241'], userFraction: 1 },
    ]);
    assert.equal(t.stores.android.texts.get('en-US\u0000title'), 'Acme');
    // Nothing waits any more: texts and release fields are marked pushed, no draft record is left.
    const staged = await db.query('SELECT pushed_hash, value_hash FROM staged_changes WHERE app_id = ?', [app]);
    assert.ok(staged.every((r) => r.pushed_hash === r.value_hash));
    assert.equal((await db.query('SELECT * FROM store_draft_pushes WHERE app_id = ?', [app])).length, 0);
    // It is audited as a push, a submit AND a release, and the batch run is complete.
    const released = (await t.audit('store.released'))[0];
    assert.deepEqual(
      [released?.detail.oneCommit, released?.detail.track, released?.detail.userFraction],
      [true, 'production', 1],
    );
    assert.equal((await t.events('release.started')).length, 1);
    assert.equal((await t.audit('listing.submitted')).length, 1);
    const kept = (await t.call(t.owner, 'GET', `/apps/${app}/pending`)).body;
    assert.ok(kept, 'the pending view still answers');
    assert.doesNotMatch(JSON.stringify([released, await t.audit('listing.draft_pushed')]), /Acme|Bug fixes/, 'never a text');
  },
);

dbTest(
  'the share is part of the commit: a staged rollout is inProgress with that share, in the same edit',
  async (db) => {
    const t = await boot(db);
    const app = await stagePromotion(t);
    const steps = [
      { type: 'push_and_submit' },
      { type: 'release', userFraction: 0.1 },
    ];
    const out = await t.planAndPublish(app, steps);
    assert.equal(out.publish.status, 200, out.publish.text.slice(0, 400));
    assert.equal(out.plan.body.plan.oneCommit, true);
    assert.deepEqual(stepOf(out.plan.body, 'push_and_submit').summary.release.audience, 'percent');
    assert.deepEqual(t.stores.android.lastInput?.start, { userFraction: 0.1 });
    assert.equal(t.stores.android.pushAndSubmitCalls, 1);
  },
);

dbTest(
  'changes in review refuse the ONE commit: nothing is applied (no texts, no graphics, no release), the release step is skipped, the run says so',
  async (db) => {
    const t = await boot(db);
    const app = await stagePromotion(t);
    t.stores.android.inReview = true;
    const out = await t.planAndPublish(app, TOGETHER);
    assert.equal(out.publish.status, 200, out.publish.text.slice(0, 400));
    const r = out.publish.body.result;
    assert.deepEqual([r.completed, r.applied, r.failed, r.skipped, r.stoppedAt], [false, 0, 1, 1, 'push_and_submit']);
    const push = resultOf(out.publish, 'push_and_submit');
    assert.deepEqual(
      [push.status, push.error, push.httpStatus, push.outcome],
      ['failed', 'changes_in_review', 409, 'refused'],
    );
    assert.equal(push.detail.store.httpStatus, 400);
    assert.equal(push.detail.store.kind, 'changes_in_review');
    assert.match(push.detail.store.details[0].detail, /already have changes in review/);
    assert.equal(resultOf(out.publish, 'release').status, 'skipped');
    // NOTHING partial: not the texts, not the release, nothing marked pushed, nothing sent.
    assert.notEqual(t.stores.android.texts.get('en-US\u0000title'), 'Acme');
    assert.deepEqual(t.stores.android.releasesMade, []);
    assert.equal(t.stores.android.sentForReview, 0);
    assert.equal(t.releaseStores.android.releaseCalls, 0);
    const staged = await db.query('SELECT pushed_hash FROM staged_changes WHERE app_id = ?', [app]);
    assert.ok(staged.every((row) => row.pushed_hash === null));
    // The kept run is a plain failure (nothing applied), with the code of the store's cause.
    const run = r.lastPublish;
    assert.equal(run.outcome, 'failed');
    assert.deepEqual(run.results.map((x: any) => [x.type, x.status]), [
      ['push_and_submit', 'failed'],
      ['release', 'skipped'],
    ]);
    assert.equal(run.results[0].error, 'changes_in_review');
    assert.equal(run.results[0].httpStatus, 409);
    assert.equal(run.results[0].store.httpStatus, 400);
    // The default (ERROR_IF_IN_REVIEW) was used: never replaced by itself.
    assert.equal(t.stores.android.lastInput?.replaceReview, undefined);
    assert.equal(t.stores.android.reviewsReplaced, 0);
  },
);

dbTest(
  'replace the review in progress: an explicit option, its own plan hash, the irreversibility phrase; it cancels the review and sends everything together',
  async (db) => {
    const t = await boot(db);
    const app = await stagePromotion(t);
    t.stores.android.inReview = true;
    const plain = (await t.plan(app, TOGETHER)).body.plan;
    const withReplace = [{ type: 'push_and_submit', replaceReview: true }, TOGETHER[1]];
    const p = (await t.plan(app, withReplace)).body.plan;
    assert.equal(p.confirmable, true, JSON.stringify(p.steps.map((s: any) => s.problems)));
    assert.equal(p.replacesReview, true);
    assert.notEqual(p.planHash, plain.planHash, 'a step-up grant for the plain plan never covers the replacement');
    assert.deepEqual(p.publishSteps[0], { type: 'push_and_submit', replaceReview: true });
    assert.equal(p.irreversible, true);
    assert.equal(p.confirmation.phrase, 'publish Weather 2 steps');
    const push = p.steps.find((s: any) => s.type === 'push_and_submit');
    assert.equal(push.summary.replacesReview, true);
    assert.ok(push.problems.some((x: any) => x.code === 'replaces_review' && /loses its place in the review queue/.test(x.message)));
    // Without the phrase nothing is read or written.
    const refused = await t.publish(app, { planHash: p.planHash, steps: p.publishSteps });
    assert.equal(refused.status, 422);
    assert.equal(t.stores.android.pushAndSubmitCalls, 0);
    const res = await t.publish(app, { planHash: p.planHash, phrase: p.confirmation.phrase, steps: p.publishSteps });
    assert.equal(res.status, 200, res.text.slice(0, 400));
    assert.deepEqual([res.body.result.completed, res.body.result.applied], [true, 2]);
    assert.equal(t.stores.android.lastInput?.replaceReview, true);
    assert.equal(t.stores.android.reviewsReplaced, 1);
    assert.equal(t.stores.android.texts.get('en-US\u0000title'), 'Acme');
    assert.equal(t.stores.android.releasesMade.length, 1);
    assert.equal((await t.audit('store.released'))[0]?.detail.replacedReview, true);
  },
);

dbTest(
  'replacing the review needs the person: step-up is required for the plan with it, and a token still types the phrase',
  async (db) => {
    const t = await boot(db);
    const app = await stagePromotion(t);
    t.stores.android.inReview = true;
    assert.equal((await t.call(t.owner, 'PUT', '/step-up/policy', { mode: 'hard_actions' })).status, 200);
    const p = (await t.plan(app, [{ type: 'push_and_submit', replaceReview: true }, TOGETHER[1]])).body.plan;
    const body = { planHash: p.planHash, steps: p.publishSteps };
    const missing = await t.publish(app, body);
    assert.equal(missing.status, 403);
    assert.equal(missing.body.error, 'step_up_required');
    assert.equal(t.stores.android.pushAndSubmitCalls, 0);
    const verified = await t.call(t.owner, 'POST', '/step-up/verify', {
      factor: 'password',
      action: 'store.publish',
      target: { id: app, hash: p.planHash },
      password: PASSWORD,
    });
    assert.equal(verified.status, 200, verified.text);
    // A grant made for the PLAIN plan does not cover the plan that replaces the review.
    const plain = (await t.plan(app, TOGETHER)).body.plan;
    const wrong = await t.call(t.owner, 'POST', '/step-up/verify', {
      factor: 'password',
      action: 'store.publish',
      target: { id: app, hash: plain.planHash },
      password: PASSWORD,
    });
    const raw = (grant: string) =>
      t.app.request(`/api/workspaces/${t.workspaceId}/apps/${app}/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: t.owner, 'x-step-up-grant': grant },
        body: JSON.stringify(body),
      });
    const bad = await raw(wrong.body.grant);
    assert.equal(bad.status, 403);
    assert.equal(t.stores.android.reviewsReplaced, 0);
    const ok = await raw(verified.body.grant);
    assert.equal(ok.status, 200, (await ok.text()).slice(0, 300));
    assert.equal(t.stores.android.reviewsReplaced, 1);
  },
);

dbTest(
  'a plan never holds two commits that each send for review: submit + release is blocked with the reason, push_and_submit + submit too',
  async (db) => {
    const t = await boot(db);
    const app = await stagePromotion(t);
    for (const steps of [
      [{ type: 'push_draft' }, { type: 'submit' }, { type: 'release', track: 'production', userFraction: 1 }],
      [{ type: 'submit' }, { type: 'release', track: 'production', userFraction: 1 }],
      [{ type: 'push_and_submit' }, { type: 'submit' }],
    ]) {
      const p = await t.plan(app, steps);
      assert.equal(p.status, 200, p.text.slice(0, 300));
      assert.equal(p.body.plan.confirmable, false, JSON.stringify(steps));
      const codes = (p.body.plan.steps as any[]).flatMap((s) => s.problems.map((x: any) => x.code));
      // A submit with no draft push before it has nothing to submit (not confirmable on its own); the others are named by their reason.
      if (steps.length === 3 || steps.some((x: any) => x.type === 'push_and_submit'))
        assert.ok(codes.includes('two_review_commits') || codes.includes('combined_with_pair'), codes.join());
      const res = await t.publish(app, { planHash: HASH, phrase: `publish Weather ${steps.length} steps`, steps });
      assert.equal(res.status, 409);
      assert.equal(res.body.error, 'plan_blocked');
    }
    assert.equal(t.stores.android.applyCalls + t.stores.android.pushAndSubmitCalls, 0);
    assert.equal(t.submitStores.android.submitCalls + t.releaseStores.android.releaseCalls, 0);
  },
);

dbTest(
  'whatever is asked for, a Google Play plan has at most ONE step that sends for review',
  async (db) => {
    const t = await boot(db);
    const app = await stagePromotion(t);
    const share = { track: 'production', userFraction: 1 };
    const all: unknown[][] = [];
    const types = ['push_draft', 'push_and_submit', 'submit', 'release'];
    for (let mask = 1; mask < 16; mask++) {
      const picked = types.filter((_, i) => mask & (1 << i));
      all.push(picked.map((type) => (type === 'release' ? { type, ...share } : { type })));
    }
    for (const steps of all) {
      const p = (await t.plan(app, steps)).body.plan;
      if (!p.confirmable) continue;
      const types = (p.steps as any[]).filter((s) => s.included).map((s) => s.type);
      // A commit that sends for review: submit, a release that is not carried, the combined step (which also carries the release).
      const sending =
        (types.includes('submit') ? 1 : 0) +
        (types.includes('push_and_submit') ? 1 : 0) +
        (types.includes('release') && !p.oneCommit ? 1 : 0);
      assert.ok(sending <= 1, `${JSON.stringify(steps)} -> ${types.join()}`);
    }
  },
);

dbTest(
  'the release of one commit is made from the STAGED release fields: nothing staged, or another track or codes, is blocked with the reason',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('android', 'Weather');
    assert.equal(
      (await t.stageText(app, { locale: 'en-US', field: 'title', from: 'local', value: 'Acme' })).status,
      200,
    );
    const none = (await t.plan(app, TOGETHER)).body;
    assert.equal(none.plan.confirmable, false);
    assert.ok(stepOf(none, 'push_and_submit').problems.some((x: any) => x.code === 'one_commit_release_not_staged'));
    for (const body of [
      { field: 'track', value: 'production' },
      { field: 'version_codes', value: '241' },
    ])
      assert.equal((await t.stageField(app, body)).status, 200);
    for (const other of [
      { type: 'release', track: 'beta', userFraction: 1 },
      { type: 'release', track: 'production', versionCodes: ['999'], userFraction: 1 },
    ]) {
      const bad = (await t.plan(app, [{ type: 'push_and_submit' }, other])).body;
      assert.equal(bad.plan.confirmable, false);
      assert.ok(stepOf(bad, 'push_and_submit').problems.some((x: any) => x.code === 'one_commit_release_mismatch'));
    }
    // The share is never implied: a release with no share needs input.
    const noShare = (await t.plan(app, [{ type: 'push_and_submit' }, { type: 'release', track: 'production' }])).body;
    assert.equal(noShare.plan.confirmable, false);
    assert.equal(stepOf(noShare, 'push_and_submit').availability, 'needs_input');
    assert.equal(t.stores.android.pushAndSubmitCalls, 0);
  },
);

dbTest(
  'rights and switches: one commit needs the push and the RELEASE (not the submit), and both switches',
  async (db) => {
    const t = await boot(db);
    const app = await stagePromotion(t);
    const refusedFor = async (actions: string[]) => {
      const token = await t.mint({ actions });
      const plan = await t.bearer(token, 'POST', t.path(app, '/preview'), { steps: TOGETHER });
      assert.equal(plan.status, 200, JSON.stringify(plan.body));
      return plan.body.plan;
    };
    for (const actions of [
      ['store.publish', 'store.push_draft', 'store.submit', 'apps.read'],
      ['store.publish', 'store.release', 'apps.read'],
    ]) {
      const plan = await refusedFor(actions);
      assert.equal(plan.confirmable, false, actions.join());
      assert.equal(stepOf({ plan }, 'push_and_submit').availability, 'forbidden');
    }
    const ok = await refusedFor(['store.publish', 'store.push_draft', 'store.release', 'apps.read']);
    assert.equal(ok.confirmable, true, JSON.stringify(ok.steps.map((s: any) => [s.type, s.availability, s.reason])));
    assert.equal(ok.confirmationRequired, true, 'a token types the phrase');
    const token = await t.mint({ actions: ['store.publish', 'store.push_draft', 'store.submit', 'apps.read'] });
    const refused = await t.bearer(token, 'POST', t.path(app), {
      planHash: HASH,
      phrase: 'publish Weather 2 steps',
      steps: TOGETHER,
    });
    assert.equal(refused.status, 403);
    assert.ok(refused.body.missing.some((m: any) => m.step === 'push_and_submit' && /store\.release/.test(m.action)));
    assert.equal(t.stores.android.pushAndSubmitCalls, 0);
  },
);

dbTest(
  'what stays as before: the draft push alone never sends for review and never starts a release; the plan recommends ONE commit for texts + a build',
  async (db) => {
    const t = await boot(db);
    const app = await stagePromotion(t);
    const def = (await t.plan(app)).body.plan;
    assert.equal(def.oneCommit, false);
    assert.deepEqual(def.recommended, {
      types: ['push_and_submit', 'release'],
      steps: [
        { type: 'push_and_submit' },
        { type: 'release', track: 'production', versionCodes: ['241'] },
      ],
      why: 'one_commit',
      needsShare: true,
      replacesReview: false,
    });
    assert.equal(def.changesInReview, false);
    // The recommendation is accepted as it is once the person gave the share.
    const rec = (await t.plan(app, [def.recommended.steps[0], { ...def.recommended.steps[1], userFraction: 1 }])).body.plan;
    assert.equal(rec.confirmable, true);
    assert.equal(rec.oneCommit, true);
    // Draft only: one commit held back, no release, no review.
    const draft = await t.planAndPublish(app, [{ type: 'push_draft' }]);
    assert.equal(draft.publish.status, 200, draft.publish.text.slice(0, 300));
    assert.equal(draft.plan.body.plan.oneCommit, false);
    assert.equal(t.stores.android.applyCalls, 1);
    assert.equal(t.stores.android.pushAndSubmitCalls, 0);
    assert.equal(t.stores.android.lastInput?.start, undefined);
    assert.deepEqual(t.stores.android.releasesMade, []);
    assert.equal(t.stores.android.sentForReview, 0);
  },
);

dbTest(
  'the user\'s case, recovered: texts in review and a draft release; the person replaces the review and everything goes together, in one commit',
  async (db) => {
    const t = await boot(db);
    const app = await stagePromotion(t);
    // The old plan: the texts went to review, the release did not (here: the store is in review and refuses the one commit).
    t.stores.android.inReview = true;
    const failed = await t.planAndPublish(app, TOGETHER);
    assert.equal(resultOf(failed.publish, 'push_and_submit').error, 'changes_in_review');
    // The kept run says changes were in review: the NEXT plan recommends the replacing variant (a recommendation, not a default).
    const hint = (await t.plan(app)).body.plan;
    assert.equal(hint.changesInReview, true);
    assert.deepEqual(hint.recommended.steps[0], { type: 'push_and_submit', replaceReview: true });
    assert.equal(hint.recommended.replacesReview, true);
    assert.equal(hint.replacesReview, false, 'the default plan never replaces a review by itself');
    assert.equal(hint.publishSteps.some((x: any) => x.replaceReview === true), false);
    // The next plan, asked for the same way, is refused the same way (nothing is replaced by itself).
    const again = await t.planAndPublish(app, TOGETHER);
    assert.equal(resultOf(again.publish, 'push_and_submit').error, 'changes_in_review');
    assert.equal(t.stores.android.reviewsReplaced, 0);
    // The person chooses to replace the review: ONE commit with everything.
    const replaced = await t.planAndPublish(app, [{ type: 'push_and_submit', replaceReview: true }, TOGETHER[1]]);
    assert.equal(replaced.publish.status, 200, replaced.publish.text.slice(0, 300));
    assert.equal(replaced.publish.body.result.completed, true);
    assert.equal(t.stores.android.reviewsReplaced, 1);
    assert.equal(t.stores.android.pushAndSubmitCalls, 3, 'two refused attempts and the one that replaced the review');
    assert.equal(t.stores.android.releasesMade.length, 1, 'the release was made once, by the last commit only');
  },
);

dbTest(
  'partial progress is kept: the draft was pushed (applied) and the release refused (changes in review): the run is partial, with both steps',
  async (db) => {
    const t = await boot(db);
    const app = await stagePromotion(t);
    t.releaseStores.android.behavior = {
      kind: 'refuse',
      error: new StoreError(
        'googleplay',
        'changes_in_review',
        'Google Play has changes in review for this app.',
        400,
        [{ code: 'CHANGES_ALREADY_IN_REVIEW', detail: 'You already have changes in review.' }],
      ),
    };
    // The draft pair: the push is held back (not sent for review), the release is the second commit.
    const out = await t.planAndPublish(app, [
      { type: 'push_draft' },
      { type: 'release', track: 'production', versionCodes: ['241'], userFraction: 1 },
    ]);
    assert.equal(out.publish.status, 200, out.publish.text.slice(0, 500));
    const run = out.publish.body.result.lastPublish;
    assert.equal(run.outcome, 'partial');
    assert.deepEqual(
      run.results.map((x: any) => [x.type, x.status, x.error ?? null]),
      [
        ['push_draft', 'applied', null],
        ['release', 'failed', 'changes_in_review'],
      ],
    );
    assert.equal(run.results[1].store.kind, 'changes_in_review');
    assert.equal(t.stores.android.sentForReview, 0, 'the push was held back, never sent for review');
    assert.equal((await t.audit('pending.published'))[0]?.detail.outcome, 'partial');
    // The next read of the app keeps the run, so a reload still says what is where.
    const pending = (await t.call(t.owner, 'GET', `/apps/${app}/pending`)).body.pending;
    assert.equal(pending.lastPublish.outcome, 'partial');
  },
);
