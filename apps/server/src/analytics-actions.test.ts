import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { AnalyticsError } from '@mrm/connectors';
import { dbTest } from '@mrm/db/testing';
import {
  type AnalyticsBoot,
  bootAnalytics,
  discoveryTsv,
  downloadsTsv,
  gz,
  SEGMENT_SECRET,
} from './analytics-test-helpers.ts';

// Everything here runs against fakes: no store is ever contacted.

const enc = (text: string) => new TextEncoder().encode(text);
const ENABLE = (appId: string) => `/apps/${appId}/analytics/apple/enable`;
const preview = (t: AnalyticsBoot, appId: string, backfill = false, cookie = t.owner) =>
  t.call(cookie, 'GET', `${ENABLE(appId)}${backfill ? '?backfill=true' : ''}`);
const confirm = (t: AnalyticsBoot, appId: string, body: unknown, cookie = t.owner) =>
  t.call(cookie, 'POST', ENABLE(appId), body);
const importPath = (appId: string, name = 'App Store Downloads Standard.tsv', hash?: string) =>
  `/apps/${appId}/analytics/import${hash ? '' : '/preview'}?fileName=${encodeURIComponent(name)}${hash ? `&confirmHash=${hash}` : ''}`;

// ---- Roles and tokens -------------------------------------------------------------------------------------------------

dbTest(
  'every role reads analytics; syncing, enabling and importing need an admin; outsiders see nothing',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const appId = await t.addApp('ios');
    const viewer = await t.addMember('viewer');
    const member = await t.addMember('member');
    const admin = await t.addMember('admin');
    for (const cookie of [viewer, member, admin, t.owner]) {
      assert.equal((await t.call(cookie, 'GET', `/apps/${appId}/analytics/overview`)).status, 200);
      assert.equal((await t.call(cookie, 'GET', `/apps/${appId}/analytics/status`)).status, 200);
    }
    for (const cookie of [viewer, member]) {
      assert.equal((await t.call(cookie, 'POST', `/apps/${appId}/analytics/sync`)).status, 403);
      assert.equal((await t.call(cookie, 'GET', ENABLE(appId))).status, 403);
      assert.equal(
        (await t.call(cookie, 'POST', ENABLE(appId), { confirmHash: 'a'.repeat(64) })).status,
        403,
      );
      assert.equal((await t.upload(cookie, importPath(appId), downloadsTsv(t.day(3)))).status, 403);
      assert.equal(
        (await t.upload(cookie, importPath(appId, 'x', 'a'.repeat(64)), downloadsTsv(t.day(3))))
          .status,
        403,
      );
    }
    assert.equal((await t.call(admin, 'POST', `/apps/${appId}/analytics/sync`)).status, 200);
    assert.equal((await t.call('', 'GET', `/apps/${appId}/analytics/status`)).status, 401);
    assert.equal(t.apple.created.length, 0);
  },
);

dbTest(
  'a token holds analytics.manage only when it names it; an app restricted token is limited to its apps',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const a1 = await t.addApp('android');
    const a2 = await t.addApp('android');

    const plain = await t.makeToken({ role: 'admin' });
    assert.equal(
      (await t.bearer(plain, 'GET', `/apps/${a1}/analytics/overview`)).status,
      200,
      'reading is a default token right',
    );
    assert.equal((await t.bearer(plain, 'GET', `/apps/${a1}/analytics/status`)).status, 200);
    assert.equal(
      (await t.bearer(plain, 'POST', `/apps/${a1}/analytics/sync`)).status,
      403,
      'an admin token without the action named cannot sync',
    );
    assert.equal((await t.bearer(plain, 'GET', ENABLE(a1))).status, 403);
    assert.equal(
      (
        await t.bearer(
          plain,
          'POST',
          `/apps/${a1}/analytics/import?confirmHash=${'a'.repeat(64)}`,
          enc('x'),
        )
      ).status,
      403,
    );
    assert.equal(t.built.length, 0);

    const manage = await t.makeToken({ role: 'admin', actions: ['analytics.manage'] });
    assert.equal((await t.bearer(manage, 'POST', `/apps/${a1}/analytics/sync`)).status, 200);
    assert.equal(
      (await t.bearer(manage, 'GET', `/apps/${a1}/analytics/overview`)).status,
      403,
      'analytics.manage is not analytics.read',
    );

    const weak = await t
      .makeToken({ role: 'member', actions: ['analytics.manage'] })
      .catch(() => undefined);
    assert.ok(
      weak === undefined ||
        (await t.bearer(weak, 'POST', `/apps/${a1}/analytics/sync`)).status === 403,
      'a member ceiling cannot manage',
    );

    const restricted = await t.makeToken({
      role: 'admin',
      actions: ['analytics.read', 'analytics.manage'],
      appIds: [a1],
    });
    assert.equal((await t.bearer(restricted, 'GET', `/apps/${a1}/analytics/overview`)).status, 200);
    assert.equal((await t.bearer(restricted, 'GET', `/apps/${a2}/analytics/overview`)).status, 404);
    assert.equal((await t.bearer(restricted, 'GET', `/apps/${a2}/analytics/status`)).status, 404);
    assert.equal((await t.bearer(restricted, 'POST', `/apps/${a2}/analytics/sync`)).status, 404);
    assert.equal((await t.bearer(restricted, 'POST', `/apps/${a1}/analytics/sync`)).status, 200);
    // The audit trail names the token, not the person behind it.
    const audits = (await t.auditActions()).filter((a) => a.action === 'analytics.sync');
    assert.ok(audits.every((a) => a.actorType === 'token'));
  },
);

// ---- Enable Apple analytics -----------------------------------------------------------------------------------------

dbTest(
  'enable: needs analytics on, an Apple app that was synced; the preview sends nothing',
  async (db) => {
    const t = await bootAnalytics(db);
    const ios = await t.addApp('ios');
    const android = await t.addApp('android');
    assert.equal((await preview(t, ios)).body.error, 'analytics_disabled');
    await t.enable();
    assert.equal((await preview(t, android)).body.error, 'not_apple_app');
    await t.db.execute('UPDATE apps SET store_app_id = NULL WHERE id = ?', [ios]);
    assert.equal((await preview(t, ios)).body.error, 'app_not_synced');
    assert.equal((await preview(t, 'missing')).status, 404);
    assert.equal(t.apple.created.length, 0);
    assert.equal(t.built.length, 0, 'not even a connector was built for the refused ones');
  },
);

dbTest(
  'enable: preview, then confirm with its hash creates the ONGOING request once, audited with ids',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const appId = await t.addApp('ios');
    const p = await preview(t, appId);
    assert.equal(p.status, 200);
    assert.match(p.body.confirmHash, /^[0-9a-f]{64}$/);
    assert.equal(p.body.canCreate, true);
    assert.deepEqual(p.body.plan.steps, [{ accessType: 'ONGOING', action: 'create' }]);
    assert.equal(p.body.plan.roleCheck, 'ok');
    assert.equal(p.body.plan.willSend.length, 1);
    assert.ok(p.body.plan.notes.some((n: string) => n.includes('35 days')));
    assert.equal(t.apple.created.length, 0, 'a preview creates nothing');

    const wrong = await confirm(t, appId, { confirmHash: 'f'.repeat(64) });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.error, 'plan_changed');
    assert.equal(wrong.body.confirmHash, p.body.confirmHash, 'the current plan comes back');
    assert.equal((await confirm(t, appId, { confirmHash: 'nope' })).status, 400);
    assert.equal((await confirm(t, appId, {})).status, 400);
    assert.equal(t.apple.created.length, 0);

    const done = await confirm(t, appId, { confirmHash: p.body.confirmHash });
    assert.equal(done.status, 201);
    assert.deepEqual(
      done.body.enabled.steps.map((s: { accessType: string; action: string }) => [
        s.accessType,
        s.action,
      ]),
      [['ONGOING', 'create']],
    );
    assert.deepEqual(t.apple.created, [{ appStoreId: '1234567890', accessType: 'ONGOING' }]);
    const stored = await t.rows(
      'SELECT access_type, status, apple_request_id FROM analytics_report_requests',
    );
    assert.deepEqual(
      stored.map((r) => [String(r.access_type), String(r.status), String(r.apple_request_id)]),
      [['ONGOING', 'active', 'req-1']],
    );
    const audit = (await t.auditActions()).filter((a) => a.action === 'analytics.enable');
    assert.equal(audit.length, 1);
    assert.deepEqual(JSON.parse(audit[0]?.detail ?? '{}').steps, [
      { accessType: 'ONGOING', action: 'create', appleRequestId: 'req-1' },
    ]);
    const status = (await t.call(t.owner, 'GET', `/apps/${appId}/analytics/status`)).body;
    assert.equal(status.apple.mode, 'ongoing');
    assert.equal(status.sources[0].setup.code, 'waiting_first_data');
    assert.equal(status.sources[0].state, 'waiting');

    // Enabling again finds the request: nothing is created a second time.
    const again = await preview(t, appId);
    assert.deepEqual(again.body.plan.steps, [{ accessType: 'ONGOING', action: 'exists' }]);
    assert.equal((await confirm(t, appId, { confirmHash: again.body.confirmHash })).status, 201);
    assert.equal(t.apple.created.length, 1);
  },
);

dbTest(
  'enable: someone else created the request between preview and confirm: nothing is sent, the new plan is returned',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const appId = await t.addApp('ios');
    const p = await preview(t, appId);
    t.apple.requests.push({
      id: 'req-theirs',
      accessType: 'ONGOING',
      stoppedDueToInactivity: false,
    });
    const done = await confirm(t, appId, { confirmHash: p.body.confirmHash });
    assert.equal(done.status, 409);
    assert.deepEqual(done.body.plan.steps, [{ accessType: 'ONGOING', action: 'adopt' }]);
    assert.equal(t.apple.created.length, 0);
    assert.equal((await confirm(t, appId, { confirmHash: done.body.confirmHash })).status, 201);
    assert.equal(t.apple.created.length, 0, 'an existing request is adopted, not duplicated');
    assert.equal(
      String(
        (await t.rows('SELECT apple_request_id FROM analytics_report_requests'))[0]
          ?.apple_request_id,
      ),
      'req-theirs',
    );
  },
);

dbTest(
  'enable with backfill adds one snapshot request, and not a second one within the month',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const appId = await t.addApp('ios');
    const p = await preview(t, appId, true);
    assert.deepEqual(
      p.body.plan.steps.map((s: { accessType: string }) => s.accessType),
      ['ONGOING', 'ONE_TIME_SNAPSHOT'],
    );
    assert.ok(p.body.plan.notes.some((n: string) => n.includes('2024-01-01')));
    assert.notEqual(
      p.body.confirmHash,
      (await preview(t, appId)).body.confirmHash,
      'the hash covers the backfill choice',
    );
    assert.equal(
      (await confirm(t, appId, { confirmHash: p.body.confirmHash })).status,
      409,
      'the hash of a backfill plan is not valid without the backfill',
    );
    assert.equal(
      (await confirm(t, appId, { confirmHash: p.body.confirmHash, backfill: true })).status,
      201,
    );
    assert.deepEqual(
      t.apple.created.map((c) => c.accessType),
      ['ONGOING', 'ONE_TIME_SNAPSHOT'],
    );
    const again = await preview(t, appId, true);
    assert.deepEqual(
      again.body.plan.steps.map((s: { action: string }) => s.action),
      ['exists', 'exists'],
    );
  },
);

dbTest(
  'enable: a key that may not create requests is analytics_role_required, and importing a file is the way on',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const appId = await t.addApp('ios');
    t.apple.listError = new AnalyticsError('analytics_role_required');
    const p = await preview(t, appId);
    assert.equal(p.status, 200);
    assert.equal(p.body.canCreate, false);
    assert.equal(p.body.plan.roleCheck, 'role_required');
    assert.ok(p.body.plan.notes.some((n: string) => n.includes('Admin')));
    const done = await confirm(t, appId, { confirmHash: p.body.confirmHash });
    assert.equal(done.status, 422);
    assert.equal(done.body.error, 'analytics_role_required');
    assert.equal(done.body.nextStep, 'import_apple_report');
    assert.equal(t.apple.created.length, 0);
    const status = (await t.call(t.owner, 'GET', `/apps/${appId}/analytics/status`)).body;
    assert.deepEqual(
      [
        status.sources[0].setup.code,
        status.sources[0].setup.nextStep,
        status.sources[0].setup.alternatives,
      ],
      ['role_required', 'ask_apple_admin', ['import_apple_report']],
    );

    // The fallback: the same report, downloaded by hand.
    const file = enc(downloadsTsv(t.day(3)));
    const shown = await t.upload(t.owner, importPath(appId), file);
    assert.equal(shown.status, 200);
    const stored = await t.upload(
      t.owner,
      importPath(appId, 'App Store Downloads Standard.tsv', shown.body.confirmHash),
      file,
    );
    assert.equal(stored.status, 201);
    const after = (await t.call(t.owner, 'GET', `/apps/${appId}/analytics/status`)).body;
    assert.equal(after.sources[0].lastError, null, 'a good import clears the failure');
    assert.equal(after.sources[0].state, 'ready');
    assert.equal(after.apple.mode, 'import');
  },
);

dbTest(
  'enable: a 403 when creating is the same code, and a failure after the first step keeps what was created',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const appId = await t.addApp('ios');
    const p = await preview(t, appId);
    t.apple.createError = new AnalyticsError('analytics_role_required');
    const done = await confirm(t, appId, { confirmHash: p.body.confirmHash });
    assert.deepEqual(
      [done.status, done.body.error, done.body.nextStep],
      [422, 'analytics_role_required', 'import_apple_report'],
    );
    assert.equal(
      Number((await t.rows('SELECT COUNT(*) AS n FROM analytics_report_requests'))[0]?.n),
      0,
    );
    const audit = (await t.auditActions()).filter((a) => a.action === 'analytics.enable');
    assert.equal(JSON.parse(audit[0]?.detail ?? '{}').ok, false);
    assert.ok(t.texts.every((text) => !text.includes('PRIVATE KEY')));
  },
);

// ---- Import a report file ---------------------------------------------------------------------------------------------

dbTest(
  'import: preview shows what would be stored and stores nothing; the confirmed file is stored once',
  async (db) => {
    const t = await bootAnalytics(db);
    const appId = await t.addApp('ios');
    const file = enc(downloadsTsv(t.day(3)));
    const shown = await t.upload(t.owner, importPath(appId), file);
    assert.equal(shown.status, 200);
    const plan = shown.body.plan;
    assert.deepEqual(
      [plan.source, plan.report.kind, plan.platform],
      ['apple_analytics', 'downloads', 'ios'],
    );
    assert.deepEqual([plan.dateFrom, plan.dateTo, plan.days], [t.day(3), t.day(3), 1]);
    assert.deepEqual(
      plan.metrics.map((m: { metric: string; total: number }) => [m.metric, m.total]),
      [
        ['downloads_first_time', 40],
        ['downloads_redownload', 12],
      ],
    );
    assert.equal(plan.stats.rowsRead, 3);
    assert.equal(plan.stats.rowsFiltered, 1, 'the update row');
    assert.ok(plan.sample.length > 0 && plan.sample.length <= 10);
    assert.equal(Number((await t.rows())[0]?.n), 0, 'a preview stores nothing');

    const hash = shown.body.confirmHash as string;
    const done = await t.upload(
      t.owner,
      importPath(appId, 'App Store Downloads Standard.tsv', hash),
      file,
    );
    assert.equal(done.status, 201);
    assert.equal(done.body.imported.source, 'apple_analytics');
    assert.ok(done.body.imported.written > 0 && done.body.imported.unchanged === 0);
    const stored = Number((await t.rows())[0]?.n);
    const again = await t.upload(
      t.owner,
      importPath(appId, 'App Store Downloads Standard.tsv', hash),
      file,
    );
    assert.equal(again.status, 201);
    assert.deepEqual(
      [again.body.imported.written, again.body.imported.unchanged],
      [0, done.body.imported.points],
      'idempotent',
    );
    assert.equal(Number((await t.rows())[0]?.n), stored);
    assert.equal(t.built.length, 0, 'an import contacts no store and needs no connector');

    const audit = (await t.auditActions()).filter((a) => a.action === 'analytics.import');
    assert.equal(audit.length, 2);
    assert.ok(
      !audit[0]?.detail.includes('Coffee') && !audit[0]?.detail.includes('Downloads Standard'),
      'no row and no file name in the audit',
    );
    assert.equal(
      (await t.events()).length,
      1,
      'the event is raised once, for the import that stored something',
    );
    assert.equal((await t.rows('SELECT origin FROM analytics_daily LIMIT 1'))[0]?.origin, 'import');
  },
);

dbTest(
  'import: another file than the previewed one is refused, and the app does not need analytics turned on',
  async (db) => {
    const t = await bootAnalytics(db);
    const appId = await t.addApp('ios');
    const shown = await t.upload(t.owner, importPath(appId), enc(downloadsTsv(t.day(3))));
    const other = await t.upload(
      t.owner,
      importPath(appId, 'x.tsv', shown.body.confirmHash),
      enc(downloadsTsv(t.day(3), '41')),
    );
    assert.equal(other.status, 409);
    assert.equal(other.body.error, 'confirm_mismatch');
    assert.equal(Number((await t.rows())[0]?.n), 0);
    assert.equal(
      (await t.upload(t.owner, `/apps/${appId}/analytics/import?confirmHash=nope`, enc('x')))
        .status,
      400,
    );
    assert.equal(
      (await t.upload(t.owner, `/apps/${appId}/analytics/import/preview`, '')).status,
      400,
      'an empty body',
    );
    assert.equal(
      (await t.upload(t.owner, `/apps/missing/analytics/import/preview`, 'x')).status,
      404,
    );
  },
);

dbTest(
  'import: a gzip file as downloaded, and a discovery report recognised by its header alone',
  async (db) => {
    const t = await bootAnalytics(db);
    const appId = await t.addApp('ios');
    const zipped = gz(discoveryTsv(t.day(3), t.day(2)));
    const shown = await t.upload(t.owner, `/apps/${appId}/analytics/import/preview`, zipped);
    assert.equal(shown.status, 200, shown.text);
    assert.equal(
      shown.body.plan.report.kind,
      'discovery_engagement',
      'no file name needed: the header says it',
    );
    assert.equal(
      shown.body.plan.metrics.find((m: { metric: string }) => m.metric === 'impressions').total,
      8700,
    );
    assert.equal(shown.body.plan.stats.rowsFiltered, 0);
  },
);

dbTest(
  'import: unknown report, missing columns, bad gzip, decompression bomb and an oversize body are fixed codes',
  async (db) => {
    const t = await bootAnalytics(db);
    const appId = await t.addApp('ios');
    const expectCode = async (
      body: Uint8Array | string,
      code: string,
      status = 422,
      name = 'x.tsv',
    ) => {
      const res = await t.upload(t.owner, importPath(appId, name), body);
      assert.deepEqual([res.status, res.body.error], [status, code], res.text);
      return res;
    };
    await expectCode('Name\tValue\nsomething\t1\n', 'unknown_report');
    await expectCode(
      'Date\tApp Name\nx\ty\n',
      'missing_columns',
      422,
      'App Store Downloads Standard.tsv',
    );
    await expectCode(new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 'bad_gzip');
    await expectCode('', 'invalid_request', 400);
    await expectCode(
      'Date\tEvent\tCounts\nnot a date\tImpression\t12\n',
      'no_rows',
      422,
      'App Store Discovery and Engagement.tsv',
    );
    // 70 MiB of text that compresses to almost nothing: refused while it is decompressed, never held whole.
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(70 * 1024 * 1024, 0x41)));
    assert.ok(bomb.length < 1024 * 1024);
    await expectCode(bomb, 'file_too_large');
    // Over the size cap as received: stopped by the route's own limit.
    const big = new Uint8Array(10 * 1024 * 1024 + 4096);
    await expectCode(big, 'payload_too_large', 413);
    assert.equal(Number((await t.rows())[0]?.n), 0);
    assert.ok(t.texts.every((text) => !text.includes(SEGMENT_SECRET)));
  },
);

dbTest(
  'import: an Android app takes a Play Console statistics file only, and an imported number never replaces one the API read',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const android = await t.addApp('android');
    const refused = await t.upload(t.owner, `/apps/${android}/analytics/import/preview`, 'x');
    assert.equal(
      refused.status,
      422,
      'a file that is not a Play Console statistics report is refused',
    );
    assert.notEqual(refused.body.error, 'import_not_supported');

    const appId = await t.addApp('ios');
    await t.db.execute(
      `INSERT INTO analytics_report_requests (id, workspace_id, app_id, apple_request_id, access_type, status, created_by, created_at)
     VALUES ('r1', ?, ?, 'req-ongoing', 'ONGOING', 'active', 'u', 1)`,
      [t.workspaceId, appId],
    );
    t.apple.setUp(
      'App Store Downloads Standard',
      'inst-w1',
      t.day(1),
      downloadsTsv(t.day(3), '40'),
    );
    await t.call(t.owner, 'POST', `/apps/${appId}/analytics/sync`);
    const file = enc(downloadsTsv(t.day(3), '99'));
    const shown = await t.upload(t.owner, importPath(appId), file);
    const done = await t.upload(
      t.owner,
      importPath(appId, 'App Store Downloads Standard.tsv', shown.body.confirmHash),
      file,
    );
    assert.equal(
      done.body.imported.written,
      0,
      'the API reading has a processing date, the file has none',
    );
    const value = await t.rows(
      "SELECT value_micro, origin FROM analytics_daily WHERE metric = 'downloads_first_time' AND dim_type = ''",
    );
    assert.deepEqual(
      [Number(value[0]?.value_micro), String(value[0]?.origin)],
      [40_000_000, 'sync'],
    );
  },
);
