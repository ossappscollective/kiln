import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { listRuns } from './publish-runs.ts';
import { bootStaged, type StagedBoot } from './test-helpers.ts';

/**
 * A submit that does not run after the push says WHY: the blocking checks of the deferred preview are kept with the skipped step, and the plan
 * says before the push what is already known to stand in the way (docs/api/pending.md "Why a publish failed").
 */

const TEXT = 'A freshly written description that nobody else would ever write';

async function boot(
  db: Parameters<typeof bootStaged>[0],
  options: { heartbeatMs?: number; stepTimeoutMs?: number; log?: (line: string) => void } = {},
) {
  const t = await bootStaged(db, {
    extra: {
      storePublish: {
        enabled: true,
        ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
        ...(options.stepTimeoutMs === undefined ? {} : { stepTimeoutMs: options.stepTimeoutMs }),
        ...(options.log === undefined ? {} : { log: options.log }),
      },
    },
  });
  const publish = (app: string, body: Record<string, unknown>) =>
    t.call(t.owner, 'POST', `/apps/${app}/publish`, body);
  const plan = (app: string, steps?: unknown[]) =>
    t.call(t.owner, 'POST', `/apps/${app}/publish/preview`, steps === undefined ? {} : { steps });
  const claim = async (app: string) =>
    (await db.query('SELECT * FROM store_publish_claims WHERE app_id = ?', [app]))[0];
  const poll = async () => (await t.call(t.owner, 'GET', '/pending/publishing')).body;
  return { ...t, publish, plan, claim, poll };
}
type Boot = Awaited<ReturnType<typeof boot>>;

const stageIos = async (t: StagedBoot, name = 'Weather') => {
  const app = await t.addApp('ios', name);
  assert.equal(
    (await t.stageText(app, { locale: 'en-US', field: 'description', from: 'local', value: TEXT }))
      .status,
    200,
  );
  assert.equal(
    (await t.stageAssets(app, { locale: 'en-US', kind: 'screenshot', device: 'iphone_6_5' }))
      .status,
    200,
  );
  return app;
};


const publishPlan = async (t: Boot, app: string) => {
  const p = (await t.plan(app)).body.plan;
  assert.equal(p.confirmable, true, JSON.stringify(p.steps).slice(0, 400));
  return p;
};

dbTest(
  'submit blocked after the push: the skipped step carries the blocking checks, the kept run too, and the log names them',
  async (db) => {
    const lines: string[] = [];
    const t = await boot(db, { log: (l) => lines.push(l) });
    const app = await stageIos(t);
    const p = await publishPlan(t, app);
    // The build is gone from the version once the draft was pushed (what the person saw: "blocked", nothing else).
    const store = t.stores.ios;
    const original = store.applyDraft.bind(store);
    store.applyDraft = async (input) => {
      const result = await original(input);
      t.submitStores.ios.build = null;
      return result;
    };
    const done = await t.publish(app, {
      planHash: p.planHash,
      phrase: p.confirmation.phrase,
      steps: p.publishSteps,
    });
    assert.equal(done.status, 200, done.text.slice(0, 300));
    const r = done.body.result;
    assert.deepEqual([r.completed, r.applied, r.skipped, r.stoppedAt], [false, 1, 1, 'submit']);
    const submit = r.steps.find((s: any) => s.type === 'submit');
    assert.equal(submit.reason, 'blocked');
    assert.deepEqual(submit.checks, ['no_build']);
    assert.equal(submit.blockers[0].code, 'no_build');
    assert.match(submit.blockers[0].message, /No build is attached to the version/);
    // Kept with the run, so a reload and another browser say the same.
    const [run] = await listRuns(db, { workspaceId: t.workspaceId, appId: app });
    const kept = run?.results.find((x) => x.type === 'submit');
    assert.equal(kept?.reason, 'blocked');
    assert.deepEqual(
      kept?.blockers?.map((b) => b.code),
      ['no_build'],
    );
    assert.equal(run?.outcome, 'partial');
    const poll = (await t.call(t.owner, 'GET', '/pending/publishing')).body;
    assert.equal(poll.lastPublish[0].lastPublish.results[1].blockers[0].code, 'no_build');
    assert.ok(
      lines.some((l) => /step 2\/2 submit skipped \(blocked: no_build\)/.test(l)),
      lines.join('\n'),
    );
    assert.equal(t.submitStores.ios.submitCalls, 0, 'nothing was submitted');
  },
);

dbTest('blockers are cut, sanitised and never carry a token-shaped string', async (db) => {
  const t = await boot(db);
  const app = await stageIos(t);
  const p = await publishPlan(t, app);
  const store = t.stores.ios;
  const original = store.applyDraft.bind(store);
  store.applyDraft = async (input) => {
    const result = await original(input);
    t.submitStores.ios.build = {
      id: 'b',
      version: `95 ${'x'.repeat(60)}ghp_abcdefghijklmnopqrstuvwxyz0123456789`,
      processingState: 'INVALID',
      expired: false,
    };
    return result;
  };
  const done = await t.publish(app, {
    planHash: p.planHash,
    phrase: p.confirmation.phrase,
    steps: p.publishSteps,
  });
  const submit = done.body.result.steps.find((s: any) => s.type === 'submit');
  assert.equal(submit.blockers[0].code, 'build_not_valid');
  const [run] = await listRuns(db, { workspaceId: t.workspaceId, appId: app });
  const text = JSON.stringify(run?.results);
  assert.doesNotMatch(text, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
});

dbTest(
  'the plan says before the push that the submit cannot run: the submit step is blocked with the reason, the push alone stays confirmable',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t);
    t.submitStores.ios.build = null;
    const res = await t.plan(app, [{ type: 'push_draft' }, { type: 'submit' }]);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    const submit = res.body.plan.steps.find((s: any) => s.type === 'submit');
    assert.equal(submit.included, false);
    assert.equal(submit.availability, 'blocked');
    const error = submit.problems.find((x: any) => x.code === 'submit_blocked_no_build');
    assert.ok(error, JSON.stringify(submit.problems));
    assert.equal(error.severity, 'error');
    assert.match(error.message, /No build is attached to the version/);
    assert.match(submit.reason, /^Blocked: /);
    assert.equal(res.body.plan.confirmable, false, 'a push and a submit are not let through');
    assert.equal(res.body.plan.readiness.submit.blockers[0].code, 'no_build');
    // The default plan and the push alone are still worth making.
    const standard = await t.plan(app);
    assert.equal(standard.body.plan.confirmable, true);
    assert.deepEqual(
      standard.body.plan.publishSteps.map((s: any) => s.type),
      ['push_draft'],
    );
  },
);

dbTest('the plan says nothing extra when nothing stands in the way, or the store cannot be read', async (db) => {
  const t = await boot(db);
  const app = await stageIos(t);
  const clean = await t.plan(app);
  const submit = clean.body.plan.steps.find((s: any) => s.type === 'submit');
  assert.deepEqual(
    submit.problems.map((x: any) => x.code),
    ['previewed_after_push'],
  );
  t.submitStores.ios.readError = new Error('down');
  const unreadable = await t.plan(app);
  assert.equal(unreadable.status, 200);
  assert.deepEqual(
    unreadable.body.plan.steps
      .find((s: any) => s.type === 'submit')
      .problems.map((x: any) => x.code),
    ['previewed_after_push'],
  );
});

// ----- App Review Information ---------------------------------------------------------------------------------------

const noContact = {
  exists: false,
  contactFirstName: false,
  contactLastName: false,
  contactPhone: false,
  contactEmail: false,
  demoAccountRequired: null,
  demoAccountName: false,
  demoAccountPassword: false,
};

dbTest(
  'the plan says before the push that the version has no App Review contact: a blocker fixed in the review information, with the version it can be copied from',
  async (db) => {
    const t = await boot(db);
    const app = await stageIos(t);
    t.submitStores.ios.reviewDetail = noContact;
    t.submitStores.ios.reviewSource = { id: 'v-live', versionString: '1.19.0' };
    const res = await t.plan(app, [{ type: 'push_draft' }, { type: 'submit' }]);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    const blockers = res.body.plan.readiness.submit.blockers;
    assert.deepEqual(
      blockers.map((b: any) => b.code),
      ['no_review_contact'],
    );
    assert.deepEqual(blockers[0].fix, { kind: 'review', href: null });
    assert.deepEqual(blockers[0].params, {
      missing: 'contactFirstName,contactLastName,contactPhone,contactEmail',
      from: '1.19.0',
    });
    const submit = res.body.plan.steps.find((s: any) => s.type === 'submit');
    assert.equal(submit.availability, 'blocked');
    assert.ok(submit.problems.some((x: any) => x.code === 'submit_blocked_no_review_contact'));
    assert.equal(res.body.plan.confirmable, false);
    // The push alone stays allowed, and a complete detail is no blocker.
    assert.equal((await t.plan(app)).body.plan.confirmable, true);
    t.submitStores.ios.reviewDetail = { ...noContact, exists: true, contactFirstName: true, contactLastName: true, contactPhone: true, contactEmail: true };
    assert.deepEqual((await t.plan(app)).body.plan.readiness.submit.blockers, []);
  },
);

dbTest(
  'a submit blocked after the push because the review contact is blank: the skipped step carries the blocker, the log names the code and nothing personal',
  async (db) => {
    const lines: string[] = [];
    const t = await boot(db, { log: (l) => lines.push(l) });
    const app = await stageIos(t);
    const p = await publishPlan(t, app);
    const store = t.stores.ios;
    const original = store.applyDraft.bind(store);
    store.applyDraft = async (input) => {
      const result = await original(input);
      t.submitStores.ios.reviewDetail = { ...noContact, exists: true, contactFirstName: true };
      return result;
    };
    const done = await t.publish(app, {
      planHash: p.planHash,
      phrase: p.confirmation.phrase,
      steps: p.publishSteps,
    });
    const submit = done.body.result.steps.find((s: any) => s.type === 'submit');
    assert.equal(submit.reason, 'blocked');
    assert.deepEqual(submit.checks, ['no_review_contact']);
    assert.match(submit.blockers[0].message, /last name, phone number, email address are missing/);
    const [run] = await listRuns(db, { workspaceId: t.workspaceId, appId: app });
    assert.deepEqual(
      run?.results.find((x) => x.type === 'submit')?.blockers?.map((b) => b.code),
      ['no_review_contact'],
    );
    assert.ok(lines.some((l) => /skipped \(blocked: no_review_contact/.test(l)), lines.join('\n'));
    assert.doesNotMatch(`${lines.join('\n')}${JSON.stringify(run?.results)}`, /@|\+\d{4}/);
    assert.equal(t.submitStores.ios.submitCalls, 0);
  },
);
