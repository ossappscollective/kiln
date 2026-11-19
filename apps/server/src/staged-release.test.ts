import assert from 'node:assert/strict';
import { StoreError } from '@mrm/connectors';
import { dbTest } from '@mrm/db/testing';
import { bootStaged, type StagedBoot } from './staged-test-helpers.ts';

/**
 * Release fields of a draft (docs/api/releases-write.md, docs/adr/0014-release-management.md): staged like a listing text, written
 * by the same draft push, with the store's facts checked in the preview; and the reads of builds and version codes. Fakes only.
 */

const K = (locale: string, field: string) => `${locale}\u0000${field}`;
const codes = (items: { code: string }[]) => items.map((i) => i.code);
const field = (
  v: { release: { field: string; locale: string; value: string; localOnly?: boolean }[] },
  name: string,
  locale = '',
) => v.release.find((r) => r.field === name && r.locale === locale);

async function stageIos(t: StagedBoot, app: string) {
  for (const body of [
    { field: 'build', value: 'b-2' },
    { field: 'version_string', value: '2.2' },
    { field: 'release_type', value: 'manual' },
    { field: 'copyright', value: '2026 Acme Inc.' },
    { field: 'phased_release', value: true },
  ]) {
    const res = await t.stageField(app, body);
    assert.equal(res.status, 200, res.text.slice(0, 300));
  }
}
async function stageAndroid(t: StagedBoot, app: string) {
  for (const body of [
    { field: 'track', value: 'production' },
    { field: 'release_name', value: '2.1 (241)' },
    { field: 'version_codes', value: '241,240' },
    { field: 'release_notes', locale: 'en-US', value: 'Bug fixes\r\nand more   ' },
    { field: 'user_fraction', value: '10%' },
  ]) {
    const res = await t.stageField(app, body);
    assert.equal(res.status, 200, res.text.slice(0, 300));
  }
}

// ----- staging ---------------------------------------------------------------------------------------------

dbTest(
  'staging: values are normalized and the view shows them with the fields this platform can stage',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    await stageIos(t, app);
    const v = await t.view(app);
    assert.equal(v.totals.release, 5);
    assert.deepEqual(v.pushable.releaseFields, [
      'build',
      'version_string',
      'release_type',
      'earliest_release_date',
      'copyright',
      'phased_release',
    ]);
    assert.equal(field(v as never, 'release_type')?.value, 'MANUAL');
    assert.equal(field(v as never, 'phased_release')?.value, 'on');
    assert.equal(field(v as never, 'version_string')?.value, '2.2');
    assert.equal(v.valid, true);
    assert.equal(v.totals.changed, 5);

    const droid = await t.addApp('android');
    await stageAndroid(t, droid);
    const a = await t.view(droid);
    assert.equal(field(a as never, 'version_codes')?.value, '240,241', 'unique, ascending');
    assert.equal(field(a as never, 'user_fraction')?.value, '0.1');
    assert.equal(field(a as never, 'user_fraction')?.localOnly, true);
    assert.equal(field(a as never, 'release_notes', 'en-US')?.value, 'Bug fixes\nand more');
    assert.equal(a.totals.changed, 4, 'the intended share is not a change to the store');
    assert.equal(a.valid, true);
  },
);

dbTest(
  'staging: a field of another platform, a bad locale, an empty or invalid value are refused with a reason',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const droid = await t.addApp('android');
    const refused = async (
      id: string,
      body: Record<string, unknown>,
      status: number,
      error: string,
    ) => {
      const res = await t.stageField(id, body);
      assert.equal(res.status, status, res.text.slice(0, 200));
      assert.equal(res.body.error, error);
    };
    await refused(app, { field: 'track', value: 'production' }, 422, 'field_not_stageable');
    await refused(app, { field: 'nope', value: 'x' }, 422, 'field_not_stageable');
    await refused(droid, { field: 'build', value: 'b-1' }, 422, 'field_not_stageable');
    await refused(app, { field: 'copyright', locale: 'en-US', value: 'x' }, 422, 'invalid_locale');
    await refused(droid, { field: 'release_notes', value: 'x' }, 422, 'invalid_locale');
    await refused(
      droid,
      { field: 'release_notes', locale: 'not a locale', value: 'x' },
      422,
      'invalid_locale',
    );
    await refused(app, { field: 'copyright', value: '   ' }, 422, 'empty_value');
    await refused(app, { field: 'version_string', value: 'two' }, 422, 'invalid_staged');
    await refused(app, { field: 'release_type', value: 'whenever' }, 422, 'invalid_staged');
    await refused(
      app,
      { field: 'earliest_release_date', value: '2001-01-01T00:00:00Z' },
      422,
      'invalid_staged',
    );
    await refused(app, { field: 'phased_release', value: 'maybe' }, 422, 'invalid_staged');
    await refused(droid, { field: 'version_codes', value: 'abc' }, 422, 'invalid_staged');
    await refused(droid, { field: 'user_fraction', value: 1.5 }, 422, 'invalid_staged');
    await refused(droid, { field: 'user_fraction', value: 0 }, 422, 'invalid_staged');
    await refused(app, { field: 'copyright', value: 'x', extra: 1 }, 400, 'invalid_request');
    assert.equal((await t.rows(app)).length, 0);
    assert.equal((await t.rows(droid)).length, 0);
  },
);

dbTest(
  'staging: a Play field without its track is an error in the view and blocks a push',
  async (db) => {
    const t = await bootStaged(db);
    const droid = await t.addApp('android');
    assert.equal(
      (await t.stageField(droid, { field: 'release_name', value: 'Spring' })).status,
      200,
    );
    const v = await t.view(droid);
    assert.equal(v.valid, false);
    assert.deepEqual(
      codes(
        field(v as never, 'release_name')
          ? (v as never as { release: { problems: { code: string }[] }[] }).release[0]!.problems
          : [],
      ),
      ['track_required'],
    );
    const p = await t.preview(droid);
    assert.equal(p.status, 422);
    assert.equal(p.body.error, 'staged_invalid');
    assert.equal(t.stores.android.reads, 0, 'nothing was read from the store');
  },
);

dbTest(
  'staging: an SCHEDULED release type without a date, or a date without it, is a warning, not an error',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    await t.stageField(app, { field: 'release_type', value: 'SCHEDULED' });
    let v = await t.view(app);
    assert.equal(v.valid, true);
    const problems = (
      v as never as { release: { field: string; problems: { code: string; severity: string }[] }[] }
    ).release[0]!.problems;
    assert.ok(problems.some((p) => p.code === 'scheduled_needs_date' && p.severity === 'warning'));
    assert.ok(problems.some((p) => p.code === 'submit_needs_manual'));
    await t.stageField(app, { field: 'earliest_release_date', value: '2099-01-01T10:00:00+02:00' });
    v = await t.view(app);
    assert.equal(field(v as never, 'earliest_release_date')?.value, '2099-01-01T08:00:00Z');
    assert.equal(
      (v as never as { release: { problems: { code: string }[] }[] }).release
        .flatMap((r) => r.problems)
        .filter((p) => p.code === 'scheduled_needs_date').length,
      0,
    );
  },
);

dbTest(
  'staging: a field is replaced by staging it again, removed by its id or by clearing; the audit holds a hash, never the value',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    await t.stageField(app, { field: 'copyright', value: '2026 Secret Corp.' });
    await t.stageField(app, { field: 'copyright', value: '2027 Secret Corp.' });
    let v = await t.view(app);
    assert.equal(v.totals.release, 1);
    assert.equal(field(v as never, 'copyright')?.value, '2027 Secret Corp.');
    const audits = await t.audit('staged.release_field_set');
    assert.equal(audits.length, 2);
    assert.equal(JSON.stringify(audits).includes('Secret Corp'), false);
    assert.ok(typeof audits[0]?.detail.valueHash === 'string');
    const id = (v as never as { release: { id: string }[] }).release[0]!.id;
    assert.equal((await t.unstage(app, id)).status, 200);
    assert.equal((await t.view(app)).totals.release, 0);
    await t.stageField(app, { field: 'copyright', value: 'x' });
    await t.clear(app);
    v = await t.view(app);
    assert.equal(v.totals.release, 0);
  },
);

dbTest('staging: a viewer cannot stage, a member can; the items limit holds', async (db) => {
  const t = await bootStaged(db);
  const app = await t.addApp('ios');
  const viewer = await t.addMember('viewer');
  const member = await t.addMember('member');
  assert.equal((await t.stageField(app, { field: 'copyright', value: 'x' }, viewer)).status, 403);
  assert.equal((await t.stageField(app, { field: 'copyright', value: 'x' }, member)).status, 200);
  assert.equal(
    (await t.call(viewer, 'GET', t.sp(app))).status,
    200,
    'a viewer can read what is staged',
  );
});

// ----- the push ----------------------------------------------------------------------------------------------

dbTest(
  'push: an App Store version’s fields are previewed before and after, written once, marked pushed, and nothing is submitted',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    await stageIos(t, app);
    const store = t.stores.ios;
    store.fields.set(K('', 'copyright'), '2025 Old Inc.');
    store.fields.set(K('', 'phased_release'), 'off');
    store.fields.set(K('', 'version_string'), '2.2');

    const p = await t.preview(app);
    assert.equal(p.status, 200, p.text.slice(0, 300));
    const rel = p.body.preview.release as {
      field: string;
      before: string | null;
      after: string;
      status: string;
    }[];
    assert.equal(rel.length, 5);
    const by = (name: string) => rel.find((r) => r.field === name);
    assert.deepEqual(
      [by('copyright')?.before, by('copyright')?.after, by('copyright')?.status],
      ['2025 Old Inc.', '2026 Acme Inc.', 'changed'],
    );
    assert.deepEqual(
      [by('version_string')?.before, by('version_string')?.status],
      ['2.2', 'unchanged'],
    );
    assert.deepEqual([by('phased_release')?.before, by('phased_release')?.after], ['off', 'on']);
    assert.equal(p.body.preview.summary.fieldsChanged, 4);
    assert.equal(p.body.preview.summary.fieldsUnchanged, 1);
    assert.equal(p.body.preview.checks.canPush, true);
    assert.equal(p.body.preview.submits, false);
    assert.match(
      p.body.preview.warnings.join(' '),
      /Releasing the approved version is a separate, gated step/,
    );

    const done = await t.push(app, p.body.preview.confirmHash);
    assert.equal(done.status, 200, done.text.slice(0, 300));
    assert.equal(done.body.result.fields, 5);
    assert.equal(done.body.result.submitted, false);
    assert.deepEqual(
      done.body.result.steps
        .filter((s: { type: string }) => s.type === 'field')
        .map((s: { target: string; outcome: string }) => [s.target, s.outcome])
        .sort(),
      [
        ['build', 'applied'],
        ['copyright', 'applied'],
        ['phased_release', 'applied'],
        ['release_type', 'applied'],
        ['version_string', 'already_same'],
      ],
    );
    assert.equal(store.fields.get(K('', 'copyright')), '2026 Acme Inc.');
    assert.equal(store.fields.get(K('', 'build')), 'b-2');
    assert.equal(store.applyCalls, 1);
    const v = await t.view(app);
    assert.ok(
      (v as never as { release: { pushed: boolean }[] }).release.every((r) => r.pushed),
      'every field is marked pushed',
    );
    assert.equal(t.submitStores.ios.submitCalls, 0);
    assert.ok(await t.pushRecord(app), 'the push is recorded for the submit step');
    const audit = (await t.audit('listing.draft_pushed'))[0];
    assert.equal(audit?.detail.fields, 5);
    assert.equal(
      JSON.stringify(audit).includes('Acme Inc'),
      false,
      'the audit holds counts, never a value',
    );
    assert.equal((await t.events('listing.draft_pushed'))[0]?.payload.fields, 5);
    // The same push again changes nothing.
    const again = await t.preview(app);
    assert.equal(again.body.preview.summary.nothingToDo, true);
  },
);

dbTest(
  'push: the Play draft release is written without the intended share, which stays staged here only',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('android');
    await stageAndroid(t, app);
    const p = await t.preview(app);
    assert.equal(p.status, 200, p.text.slice(0, 300));
    const rel = p.body.preview.release as {
      field: string;
      status: string;
      localOnly: boolean;
      before: string | null;
    }[];
    assert.equal(rel.length, 5);
    assert.deepEqual(
      [
        rel.find((r) => r.field === 'user_fraction')?.status,
        rel.find((r) => r.field === 'user_fraction')?.localOnly,
      ],
      ['local', true],
    );
    assert.match(p.body.preview.warnings.join(' '), /cannot hold a share in a draft/);
    const done = await t.push(app, p.body.preview.confirmHash);
    assert.equal(done.status, 200, done.text.slice(0, 300));
    assert.equal(done.body.result.fields, 4, 'the intended share is not written');
    const written = t.stores.android.writes[0]?.fields ?? [];
    assert.deepEqual(written.map((f) => f.field).sort(), [
      'release_name',
      'release_notes',
      'track',
      'version_codes',
    ]);
    assert.equal(written.find((f) => f.field === 'release_notes')?.locale, 'en-US');
    const v = await t.view(app);
    const fraction = (v as never as { release: { field: string; pushed: boolean }[] }).release.find(
      (r) => r.field === 'user_fraction',
    );
    assert.equal(fraction?.pushed, false, 'a local only field is never pushed');
    assert.equal((await t.stageField(app, { field: 'user_fraction', value: 0.25 })).status, 200);
  },
);

dbTest(
  'push: a build that is not processed, expired or unknown blocks the push (409 blocked, nothing written)',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    await t.stageField(app, { field: 'build', value: 'b-3' });
    const store = t.stores.ios;
    for (const [facts, expected] of [
      [
        {
          currentNumber: '57',
          wantedFound: true,
          wantedNumber: '59',
          wantedProcessingState: 'PROCESSING',
          wantedExpired: false,
        },
        'build_not_processed',
      ],
      [
        {
          currentNumber: '57',
          wantedFound: true,
          wantedNumber: '40',
          wantedProcessingState: 'VALID',
          wantedExpired: true,
        },
        'build_expired',
      ],
      [{ currentNumber: '57', wantedFound: false }, 'build_not_found'],
    ] as const) {
      store.fieldFacts.set('build', { ...facts });
      const p = await t.preview(app);
      assert.equal(p.status, 200);
      assert.equal(p.body.preview.checks.canPush, false);
      assert.deepEqual(codes(p.body.preview.checks.blocking), [expected]);
      const res = await t.push(app, p.body.preview.confirmHash);
      assert.equal(res.status, 409, res.text.slice(0, 300));
      assert.equal(res.body.error, 'blocked');
      assert.deepEqual(codes(res.body.checks.blocking), [expected]);
    }
    assert.equal(store.writes.length, 0, 'nothing was written');
    assert.equal(await t.pushRecord(app), undefined);
    assert.equal(
      (await t.audit('listing.draft_push_failed')).filter((a) => a.detail.code === 'blocked')
        .length,
      3,
    );
    assert.equal(await t.claim(app), undefined, 'the claim was released');
  },
);

dbTest(
  'push: version codes Play does not list, or a track without a draft release, block; a new draft release and a running rollout warn',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('android');
    await t.stageField(app, { field: 'track', value: 'production' });
    await t.stageField(app, { field: 'version_codes', value: '241,999' });
    const store = t.stores.android;
    store.fieldFacts.set('version_codes', { missing: '999' });
    let p = await t.preview(app);
    assert.deepEqual(codes(p.body.preview.checks.blocking), ['version_codes_not_uploaded']);
    assert.match(p.body.preview.checks.blocking[0].message, /999/);
    store.fieldFacts.set('version_codes', { missing: '' });
    store.fieldFacts.set('track', { draftCount: 0, otherInProgress: 1 });
    p = await t.preview(app);
    assert.equal(p.body.preview.checks.canPush, true);
    assert.deepEqual(codes(p.body.preview.checks.warnings).sort(), [
      'new_draft_release',
      'rollout_in_progress',
    ]);
    // No codes staged and no draft release: nothing to build one from.
    await t.unstage(
      app,
      ((await t.view(app)) as never as { release: { id: string; field: string }[] }).release.find(
        (r) => r.field === 'version_codes',
      )!.id,
    );
    p = await t.preview(app);
    assert.deepEqual(codes(p.body.preview.checks.blocking), ['no_draft_release']);
    assert.equal(store.writes.length, 0);
  },
);

dbTest(
  'push: release fields travel with text; a store that changed since the preview is state_changed with a new preview',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    await t.stageText(app, {
      locale: 'en-US',
      field: 'release_notes',
      from: 'local',
      value: 'What is new',
    });
    await t.stageField(app, { field: 'copyright', value: '2026 Acme' });
    const p = await t.preview(app);
    assert.equal(p.status, 200, p.text.slice(0, 300));
    assert.equal(p.body.preview.summary.textChanged, 1);
    assert.equal(p.body.preview.summary.fieldsChanged, 1);
    t.stores.ios.fields.set(K('', 'copyright'), 'someone else was here');
    const res = await t.push(app, p.body.preview.confirmHash);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'state_changed');
    assert.equal(res.body.preview.release[0].before, 'someone else was here');
    assert.equal(t.stores.ios.writes.length, 0);
    const second = await t.push(app, res.body.preview.confirmHash);
    assert.equal(second.status, 200, second.text.slice(0, 300));
    assert.equal(t.stores.ios.texts.get(K('en-US', 'release_notes')), 'What is new');
    assert.equal(t.stores.ios.fields.get(K('', 'copyright')), '2026 Acme');
  },
);

dbTest(
  'push: a lost answer is read back, fields included: applied is confirmedByReread, not applied is a 502',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    await t.stageField(app, { field: 'copyright', value: '2026 Acme' });
    t.stores.ios.behavior = { kind: 'unknown', applied: true };
    const ok = await t.previewAndPush(app);
    assert.equal(ok.push.status, 200, ok.push.text.slice(0, 300));
    assert.equal(ok.push.body.result.confirmedByReread, true);
    assert.equal(t.stores.ios.applyCalls, 1, 'never sent again');

    const droid = await t.addApp('ios');
    await t.stageField(droid, { field: 'copyright', value: '2027 Acme' });
    t.stores.ios.fields.delete(K('', 'copyright'));
    t.stores.ios.behavior = { kind: 'unknown', applied: false };
    const lost = await t.previewAndPush(droid);
    assert.equal(lost.push.status, 502);
    assert.equal(lost.push.body.outcome, 'not_applied');
    assert.equal(t.stores.ios.fields.has(K('', 'copyright')), false);
  },
);

// ----- reading what a draft is made of ---------------------------------------------------------------------

dbTest(
  'reads: builds and version codes are listed with no switch on; Google Play needs a track; the read is audited as a credential use',
  async (db) => {
    const t = await bootStaged(db, { draft: { enabled: false }, release: { enabled: false } });
    const app = await t.addApp('ios');
    const droid = await t.addApp('android');
    const res = await t.call(t.owner, 'GET', `/apps/${app}/release/candidates`);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body.candidates.store, 'appstoreconnect');
    assert.equal(res.body.candidates.builds[0].selectable, true);
    const noTrack = await t.call(t.owner, 'GET', `/apps/${droid}/release/candidates`);
    assert.equal(noTrack.status, 422);
    assert.equal(noTrack.body.error, 'track_required');
    const codesRead = await t.call(
      t.owner,
      'GET',
      `/apps/${droid}/release/candidates?track=production`,
    );
    assert.equal(codesRead.status, 200);
    assert.equal(codesRead.body.candidates.codes[0].versionCode, '241');
    const editable = await t.call(t.owner, 'GET', `/apps/${app}/release/editable`);
    assert.equal(editable.status, 200);
    assert.equal(editable.body.editable.version.editable, true);
    assert.equal((await t.call(t.owner, 'GET', `/apps/${droid}/release/editable`)).status, 422);
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${droid}/release/editable?track=production`)).status,
      200,
    );
    assert.equal(t.stores.ios.applyCalls + t.stores.android.applyCalls, 0, 'reads write nothing');
    const uses = (await t.audit('credential.use')).filter(
      (a) => a.detail.purpose === 'store.release_read',
    );
    assert.ok(uses.length >= 4, 'each read is a credential use');
    const viewer = await t.addMember('viewer');
    assert.equal((await t.call(viewer, 'GET', `/apps/${app}/release/candidates`)).status, 200);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
    const outsider = await t.addMember('owner', 'other');
    assert.equal((await t.call(outsider, 'GET', `/apps/${app}/release/candidates`)).status, 404);
    assert.equal(
      (await t.call(t.owner, 'GET', '/apps/no-such-app/release/candidates')).status,
      404,
    );
  },
);

dbTest('reads: a store refusal is an answer, not a crash, and carries no secret', async (db) => {
  const t = await bootStaged(db);
  const app = await t.addApp('ios');
  t.stores.ios.releaseReadError = new StoreError(
    'appstoreconnect',
    'no_editable_version',
    'There is no editable App Store version.',
  );
  const res = await t.call(t.owner, 'GET', `/apps/${app}/release/editable`);
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'no_editable_version');
  t.stores.ios.releaseReadError = new StoreError(
    'appstoreconnect',
    'forbidden',
    'Apple refused (403)',
    403,
  );
  assert.equal((await t.call(t.owner, 'GET', `/apps/${app}/release/candidates`)).status, 422);
});
