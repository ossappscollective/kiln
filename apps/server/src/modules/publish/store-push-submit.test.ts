import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { PASSWORD } from '../../testkit.ts';
import { bootStaged, type StagedBoot } from './test-helpers.ts';

/**
 * The combined step of the batch publish: Google Play, push the staged changes AND send them for review in one commit
 * (`push_and_submit`). Google Play may refuse to keep a draft for an app (the commit with `changesNotSentForReview` is answered 400 and
 * the draft push is `draft_not_allowed`); a person who asked for a review is then offered the push and the submit as ONE explicit step.
 * It never runs unless the plan holds it, with the confirmation of an irreversible step and the step-up of the batch. Everything runs
 * against fakes: no store is contacted.
 */

const HASH = 'a'.repeat(64);

async function boot(db: Parameters<typeof bootStaged>[0], options: { submit?: boolean } = {}) {
  const t = await bootStaged(db, {
    ...(options.submit === undefined ? {} : { submit: { enabled: options.submit } }),
    extra: { storePublish: { enabled: true } },
  });
  const path = (app: string, rest = '') => `/apps/${app}/publish${rest}`;
  const plan = (app: string, steps?: unknown[], cookie = t.owner) =>
    t.call(cookie, 'POST', path(app, '/preview'), steps === undefined ? {} : { steps });
  const publish = (app: string, body: Record<string, unknown>, cookie = t.owner) =>
    t.call(cookie, 'POST', path(app), body);
  /** Preview, then publish what it said with its phrase, as a person would. */
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

const stageGoogle = async (t: StagedBoot, name = 'Weather', title = 'Acme') => {
  const app = await t.addApp('android', name);
  assert.equal(
    (await t.stageText(app, { locale: 'en-US', field: 'title', from: 'local', value: title }))
      .status,
    200,
  );
  return app;
};
const stepOf = (body: any, type: string) => (body.plan.steps as any[]).find((s) => s.type === type);
const resultOf = (res: { body: any }, type: string) =>
  (res.body.result.steps as any[]).find((s) => s.type === type);
const PAIR = [{ type: 'push_draft' }, { type: 'submit' }];

dbTest(
  'the plan of a push and a submit offers the combined step as an alternative, and does not include it',
  async (db) => {
    const t = await boot(db);
    const app = await stageGoogle(t);
    const p = await t.plan(app, PAIR);
    assert.equal(p.status, 200, p.text.slice(0, 300));
    const combined = stepOf(p.body, 'push_and_submit');
    assert.deepEqual(
      [combined.availability, combined.included, combined.requested, combined.irreversible],
      ['not_requested', false, false, true],
    );
    assert.equal(stepOf(p.body, 'push_draft').included, true);
    assert.equal(stepOf(p.body, 'submit').included, true);
    assert.deepEqual(p.body.plan.combined, {
      offered: true,
      draftRefused: false,
      defaulted: false,
    });
    assert.deepEqual(
      p.body.plan.publishSteps.map((s: { type: string }) => s.type),
      ['push_draft', 'submit'],
    );
    // The default plan (no steps) is the pair as well, when Google never refused a draft.
    const def = await t.plan(app);
    assert.equal(stepOf(def.body, 'push_and_submit').included, false);
    assert.equal(def.body.plan.combined.defaulted, false);
    assert.equal(t.stores.android.applyCalls + t.stores.android.pushAndSubmitCalls, 0);
  },
);

dbTest(
  'the combined step, asked for: one irreversible step with the batch phrase; nothing is written without it, and then one commit that sends for review',
  async (db) => {
    const t = await boot(db);
    const app = await stageGoogle(t);
    const steps = [{ type: 'push_and_submit' }];
    const p = (await t.plan(app, steps)).body.plan;
    const step = p.steps.find((s: any) => s.type === 'push_and_submit');
    assert.equal(step.included, true, JSON.stringify(step.problems));
    assert.equal(step.deferred, false);
    assert.equal(step.summary.sendsForReview, true);
    assert.equal(step.summary.textChanged, 1);
    assert.deepEqual(
      [step.requires.action, step.requires.envName, step.requires.enabled, step.requires.allowed],
      ['store.submit', 'KILN_STORE_SUBMIT_ENABLED', true, true],
    );
    assert.equal(typeof step.confirmHash, 'string');
    assert.equal(p.irreversible, true);
    assert.deepEqual(p.irreversibleSteps, ['push_and_submit']);
    assert.deepEqual(p.publishSteps, [{ type: 'push_and_submit' }]);
    assert.equal(p.confirmation.phrase, 'publish Weather 1 step');
    assert.ok(
      step.problems.some((x: any) => x.code === 'sends_everything_pending'),
      'it says that everything pending in Play Console goes with it',
    );
    const body = { planHash: p.planHash, steps: p.publishSteps };

    // No phrase, or the wrong one: nothing is read or written.
    for (const phrase of [undefined, '', 'publish Weather 2 steps']) {
      const res = await t.publish(app, { ...body, ...(phrase === undefined ? {} : { phrase }) });
      assert.equal(res.status, 422, `${phrase}`);
      assert.equal(res.body.error, 'confirmation_mismatch');
    }
    assert.equal(t.stores.android.applyCalls, 0);
    assert.equal(t.stores.android.pushAndSubmitCalls, 0);

    const res = await t.publish(app, { ...body, phrase: p.confirmation.phrase });
    assert.equal(res.status, 200, res.text.slice(0, 400));
    assert.deepEqual([res.body.result.completed, res.body.result.applied], [true, 1]);
    const done = resultOf(res, 'push_and_submit');
    assert.equal(done.status, 'applied');
    assert.deepEqual(
      [done.result.commit, done.result.submitted, done.result.draft],
      ['sent_for_review', true, false],
    );
    assert.match(done.result.note, /sent to Google Play review/);
    assert.equal(t.stores.android.pushAndSubmitCalls, 1);
    assert.equal(t.stores.android.sentForReview, 1);
    assert.equal(t.stores.android.texts.get('en-US\u0000title'), 'Acme');
    // It is a push AND a submit in one: the submit connector was never reached, and no draft record is left for a later submit.
    assert.equal(t.submitStores.android.submitCalls, 0);
    assert.equal(
      (await db.query('SELECT * FROM store_draft_pushes WHERE app_id = ?', [app])).length,
      0,
    );
    // What was pushed is marked as pushed: nothing is waiting any more.
    const staged = await db.query(
      'SELECT pushed_hash, value_hash FROM staged_changes WHERE app_id = ?',
      [app],
    );
    assert.ok(staged.every((r) => r.pushed_hash === r.value_hash));
    // The audit and the events say what happened: a push, a submit, and the batch with the step name.
    const pushed = (await t.audit('listing.draft_pushed'))[0];
    assert.deepEqual(
      [pushed?.detail.commit, pushed?.detail.combined, pushed?.detail.submitted],
      ['sent_for_review', true, true],
    );
    const submitted = (await t.audit('listing.submitted'))[0];
    assert.deepEqual([submitted?.detail.via, submitted?.detail.combined], ['edit_commit', true]);
    const batch = (await t.audit('pending.published'))[0];
    assert.deepEqual(batch?.detail.steps, [
      { type: 'push_and_submit', status: 'applied', confirmedByReread: false },
    ]);
    assert.deepEqual(
      (await t.events('listing.submitted')).map((e) => e.payload.via),
      ['edit_commit'],
    );
    assert.doesNotMatch(JSON.stringify([pushed, submitted, batch]), /Acme/, 'never a text');
  },
);

dbTest(
  'the combined step needs step-up like the batch does: no grant, nothing is written; a grant for this plan runs it',
  async (db) => {
    const t = await boot(db);
    const app = await stageGoogle(t);
    const policy = await t.call(t.owner, 'PUT', '/step-up/policy', { mode: 'hard_actions' });
    assert.equal(policy.status, 200, policy.text);
    const p = (await t.plan(app, [{ type: 'push_and_submit' }])).body.plan;
    assert.equal(p.confirmationRequired, false, 'the grant stands in for the phrase');
    assert.equal(p.irreversible, true);
    const body = { planHash: p.planHash, steps: p.publishSteps };
    const missing = await t.publish(app, body);
    assert.equal(missing.status, 403);
    assert.equal(missing.body.error, 'step_up_required');
    assert.equal(t.stores.android.pushAndSubmitCalls + t.stores.android.applyCalls, 0);
    const verified = await t.call(t.owner, 'POST', '/step-up/verify', {
      factor: 'password',
      action: 'store.publish',
      target: { id: app, hash: p.planHash },
      password: PASSWORD,
    });
    assert.equal(verified.status, 200, verified.text);
    const raw = await t.app.request(`/api/workspaces/${t.workspaceId}/apps/${app}/publish`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: t.owner,
        'x-step-up-grant': verified.body.grant,
      },
      body: JSON.stringify(body),
    });
    assert.equal(raw.status, 200, (await raw.text()).slice(0, 300));
    assert.equal(t.stores.android.sentForReview, 1);
  },
);

dbTest(
  'it never replaces a draft push by itself: a refused draft stays a failed step, the combined step is not run, and the next plan defaults to it',
  async (db) => {
    const t = await boot(db);
    const app = await stageGoogle(t);
    t.stores.android.draftRefused = true;
    const first = await t.planAndPublish(app, PAIR);
    assert.equal(first.publish.status, 200, first.publish.text.slice(0, 400));
    const r = first.publish.body.result;
    assert.equal(r.completed, false);
    const push = resultOf(first.publish, 'push_draft');
    assert.deepEqual(
      [push.status, push.error, push.httpStatus, push.outcome],
      ['failed', 'draft_not_allowed', 409, 'refused'],
    );
    assert.equal(push.detail.store.httpStatus, 400);
    assert.match(push.detail.store.details[0].detail, /Changes are sent for review automatically/);
    assert.equal(resultOf(first.publish, 'submit').status, 'skipped');
    // Nothing was sent for review, and no fallback ran.
    assert.equal(t.stores.android.pushAndSubmitCalls, 0);
    assert.equal(t.stores.android.sentForReview, 0);
    assert.equal(t.submitStores.android.submitCalls, 0);
    assert.notEqual(t.stores.android.texts.get('en-US\u0000title'), 'Acme');

    // The run was kept: the next plan says drafts were refused, and with no steps named it is made with the combined step.
    const next = (await t.plan(app)).body;
    assert.deepEqual(next.plan.combined, { offered: true, draftRefused: true, defaulted: true });
    assert.deepEqual(
      next.plan.publishSteps.map((s: { type: string }) => s.type),
      ['push_and_submit'],
    );
    assert.equal(stepOf(next, 'push_draft').included, false);
    assert.equal(stepOf(next, 'submit').included, false);
    assert.equal(stepOf(next, 'push_and_submit').included, true);
    assert.equal(
      next.plan.confirmationRequired,
      true,
      'still the confirmation of an irreversible step',
    );
    // The pair stays selectable.
    const pair = (await t.plan(app, PAIR)).body;
    assert.deepEqual(pair.plan.combined, { offered: true, draftRefused: true, defaulted: false });
    assert.equal(stepOf(pair, 'push_draft').included, true);
    assert.equal(stepOf(pair, 'push_and_submit').included, false);

    // Confirmed, it sends for review.
    const second = await t.planAndPublish(app);
    assert.equal(second.publish.status, 200, second.publish.text.slice(0, 400));
    assert.deepEqual(
      [second.publish.body.result.completed, second.publish.body.result.applied],
      [true, 1],
    );
    assert.equal(t.stores.android.sentForReview, 1);

    // A combined run that went through does not make Google keep drafts: the default stays the combined step.
    assert.equal(
      (await t.stageText(app, { locale: 'en-US', field: 'title', from: 'local', value: 'Acme 2' }))
        .status,
      200,
    );
    assert.equal((await t.plan(app)).body.plan.combined.defaulted, true);

    // A later draft push that Google accepted ends it.
    t.stores.android.draftRefused = false;
    const draft = await t.planAndPublish(app, [{ type: 'push_draft' }]);
    assert.deepEqual(
      [draft.publish.body.result.completed, draft.publish.body.result.applied],
      [true, 1],
    );
    assert.equal(
      (await t.stageText(app, { locale: 'en-US', field: 'title', from: 'local', value: 'Acme 3' }))
        .status,
      200,
    );
    assert.deepEqual((await t.plan(app)).body.plan.combined, {
      offered: true,
      draftRefused: false,
      defaulted: false,
    });
  },
);

dbTest(
  'the combined step cannot share a plan with the pair it replaces, and a plan that is not confirmable writes nothing',
  async (db) => {
    const t = await boot(db);
    const app = await stageGoogle(t);
    for (const steps of [
      [{ type: 'push_and_submit' }, { type: 'submit' }],
      [{ type: 'push_draft' }, { type: 'push_and_submit' }],
    ]) {
      const p = await t.plan(app, steps);
      assert.equal(p.status, 200, p.text.slice(0, 300));
      assert.equal(p.body.plan.confirmable, false, JSON.stringify(steps));
      assert.ok(
        (p.body.plan.steps as any[]).some((s) =>
          s.problems.some((x: any) => x.code === 'combined_with_pair'),
        ),
      );
      const res = await t.publish(app, {
        planHash: HASH,
        phrase: 'publish Weather 2 steps',
        steps,
      });
      assert.equal(res.status, 409, res.text.slice(0, 200));
      assert.equal(res.body.error, 'plan_blocked');
    }
    assert.equal(t.stores.android.applyCalls + t.stores.android.pushAndSubmitCalls, 0);
    assert.equal(t.submitStores.android.submitCalls, 0);
  },
);

dbTest(
  'the combined step is Google Play only: on the App Store it is idle in the default plan and blocked when asked for',
  async (db) => {
    const t = await boot(db);
    const app = await t.addApp('ios', 'Weather');
    assert.equal(
      (
        await t.stageText(app, {
          locale: 'en-US',
          field: 'description',
          from: 'local',
          value: 'Hello there',
        })
      ).status,
      200,
    );
    const def = (await t.plan(app)).body;
    assert.equal(stepOf(def, 'push_and_submit').availability, 'nothing_to_do');
    assert.equal(def.plan.combined.offered, false);
    const asked = (await t.plan(app, [{ type: 'push_and_submit' }])).body;
    assert.equal(stepOf(asked, 'push_and_submit').availability, 'blocked');
    assert.equal(asked.plan.confirmable, false);
    assert.equal(t.stores.ios.applyCalls, 0);
  },
);

dbTest(
  'rights and switches: the combined step needs the push and the submit, and both switches',
  async (db) => {
    const t = await boot(db);
    const app = await stageGoogle(t);
    const steps = [{ type: 'push_and_submit' }];
    // A token with the batch right and only the submit right (or only the push right) is refused, naming both rights.
    for (const actions of [
      ['store.publish', 'store.submit', 'apps.read'],
      ['store.publish', 'store.push_draft', 'apps.read'],
    ]) {
      const token = await t.mint({ actions });
      const plan = await t.bearer(token, 'POST', t.path(app, '/preview'), { steps });
      assert.equal(plan.status, 200, JSON.stringify(plan.body));
      const step = (plan.body.plan.steps as any[]).find((s) => s.type === 'push_and_submit');
      assert.deepEqual([step.availability, step.requires.allowed], ['forbidden', false]);
      const refused = await t.bearer(token, 'POST', t.path(app), {
        planHash: HASH,
        phrase: 'publish Weather 1 step',
        steps,
      });
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error, 'forbidden');
      assert.deepEqual(refused.body.missing, [
        { step: 'push_and_submit', action: 'store.push_draft and store.submit' },
      ]);
    }
    const both = await t.mint({
      actions: ['store.publish', 'store.push_draft', 'store.submit', 'apps.read'],
    });
    const ok = await t.bearer(both, 'POST', t.path(app, '/preview'), { steps });
    assert.equal(ok.body.plan.confirmable, true, JSON.stringify(ok.body.plan.steps));
    // A token still types the phrase: step-up is for people.
    assert.equal(ok.body.plan.confirmationRequired, true);
    assert.equal(t.stores.android.pushAndSubmitCalls, 0);
  },
);

dbTest('the combined step is off when the submit switch is off', async (db) => {
  const t = await boot(db, { submit: false });
  const app = await stageGoogle(t);
  const p = (await t.plan(app, [{ type: 'push_and_submit' }])).body;
  const step = stepOf(p, 'push_and_submit');
  assert.equal(step.availability, 'feature_disabled');
  assert.equal(step.requires.envName, 'KILN_STORE_SUBMIT_ENABLED');
  assert.equal(p.plan.confirmable, false);
  const res = await t.publish(app, {
    planHash: HASH,
    phrase: 'publish Weather 1 step',
    steps: [{ type: 'push_and_submit' }],
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'step_disabled');
  assert.deepEqual(res.body.disabled, [
    { step: 'push_and_submit', envName: 'KILN_STORE_SUBMIT_ENABLED' },
  ]);
  assert.equal(t.stores.android.pushAndSubmitCalls, 0);
});

dbTest(
  'the store changed after the plan: the combined step is refused (state_changed) and sends nothing',
  async (db) => {
    const t = await boot(db);
    const app = await stageGoogle(t);
    const p = (await t.plan(app, [{ type: 'push_and_submit' }])).body.plan;
    // Somebody changes the store's title in Play Console after the preview.
    t.stores.android.texts.set('en-US\u0000title', 'Changed in Play Console');
    const res = await t.publish(app, {
      planHash: p.planHash,
      phrase: p.confirmation.phrase,
      steps: p.publishSteps,
    });
    // The plan is rebuilt first and no longer matches, or the guard of the connector refuses: either way nothing is sent.
    assert.ok([200, 409].includes(res.status), res.text.slice(0, 200));
    assert.equal(t.stores.android.sentForReview, 0);
    if (res.status === 200) assert.equal(resultOf(res, 'push_and_submit').status, 'failed');
  },
);

dbTest(
  'a lost answer to the combined commit is an unknown outcome, never retried, and nothing is marked pushed',
  async (db) => {
    const t = await boot(db);
    const app = await stageGoogle(t);
    t.stores.android.behavior = { kind: 'unknown', applied: false };
    t.stores.android.readFailsAfterWrite = true;
    const out = await t.planAndPublish(app, [{ type: 'push_and_submit' }]);
    assert.equal(out.publish.status, 200, out.publish.text.slice(0, 300));
    const step = resultOf(out.publish, 'push_and_submit');
    assert.deepEqual(
      [step.status, step.error, step.outcome],
      ['failed', 'outcome_unknown', 'unknown'],
    );
    assert.match(step.message, /sent for review|review/);
    assert.equal(t.stores.android.pushAndSubmitCalls, 1, 'never repeated');
    assert.equal(t.stores.android.sentForReview, 0);
    const staged = await db.query('SELECT pushed_hash FROM staged_changes WHERE app_id = ?', [app]);
    assert.ok(staged.every((r) => r.pushed_hash === null));
  },
);
