import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createDatabase, migrate } from '@mrm/db';
import { createApp } from '../app.ts';
import { createDemoRuntime, type DemoRuntime } from './boot.ts';
import {
  DEMO_MARKER,
  demoMasterKey,
  demoProblems,
  demoRequested,
  loadDemoConfig,
} from './config.ts';
import { runDemo } from './main.ts';

// Demo mode runs entirely against its own simulated stores: nothing here contacts a store, GitHub or any other service.

const dirs: string[] = [];
const freshDir = () => {
  const root = mkdtempSync(join(tmpdir(), 'mrm-demo-test-'));
  dirs.push(root);
  return join(root, 'data');
};
let shared: Promise<DemoRuntime> | undefined;
after(async () => {
  if (shared) await (await shared).close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const start = (dir = freshDir()) =>
  createDemoRuntime(loadDemoConfig({ MRM_DEMO: 'true', MRM_DEMO_DIR: dir }, ''), { worker: false });

type Json = Record<string, any>;
async function session(rt: DemoRuntime, as = 'owner') {
  const login = await rt.app.request(`/demo/login?as=${as}&json`);
  assert.equal(login.status, 200);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  assert.match(cookie, /^mrm_session=/);
  const status = (await (await rt.app.request('/demo/status')).json()) as Json;
  const W = `/api/workspaces/${status.workspace.id}`;
  const call = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Json }> => {
    const url = path.startsWith('/demo') ? path : `${W}${path}`;
    const res = await rt.app.request(url, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: Json = {};
    try {
      parsed = text ? (JSON.parse(text) as Json) : {};
    } catch {
      /* not json */
    }
    return { status: res.status, body: parsed };
  };
  return { call, cookie, W };
}
const appOf = async (
  call: Awaited<ReturnType<typeof session>>['call'],
  name: string,
  platform: string,
): Promise<string> => {
  const apps = ((await call('GET', '/apps')).body.apps ?? []) as Json[];
  const found = apps.find((a) => a.name === name && a.platform === platform);
  assert.ok(found, `${name} ${platform}`);
  return String(found.id);
};
const count = async (rt: DemoRuntime, sql: string) =>
  Number(((await rt.db.query(sql))[0] as Json)?.n);

// One seeded runtime shared by the read-only checks (seeding takes a few seconds).
const seeded = () => {
  shared ??= start();
  return shared;
};
// ----- off by default, refuses unsafe setups ----------------------------------------------------------------------------

test('demo mode is off unless MRM_DEMO is true or 1', async () => {
  for (const v of [undefined, '', 'false', '0', 'no', 'yes', 'TRUEISH'])
    assert.equal(demoRequested({ MRM_DEMO: v }), false, String(v));
  for (const v of ['true', 'TRUE', ' 1 ']) assert.equal(demoRequested({ MRM_DEMO: v }), true, v);
  await assert.rejects(runDemo({}), /Demo mode is off/);
});

test('it refuses Postgres, production and real-looking setups unless MRM_DEMO_FORCE; never the real folder', () => {
  const dir = freshDir();
  const base = { MRM_DEMO: 'true', MRM_DEMO_DIR: dir };
  assert.doesNotThrow(() => loadDemoConfig(base));
  for (const env of [
    { DATABASE_URL: 'postgres://u:p@db.example.com/mrm' },
    { NODE_ENV: 'production' },
    { MRM_MASTER_KEY: 'abc' },
    { MRM_MODE: 'single_user' },
  ]) {
    assert.throws(
      () => loadDemoConfig({ ...base, ...env }),
      /refuses to start/,
      JSON.stringify(Object.keys(env)),
    );
    assert.doesNotThrow(
      () => loadDemoConfig({ ...base, ...env, MRM_DEMO_FORCE: 'true' }),
      JSON.stringify(env),
    );
  }
  // The hard problems cannot be forced: the real server's folder, and a folder that holds something else.
  assert.throws(
    () => loadDemoConfig({ ...base, MRM_DEMO_DIR: join(dir, '.mrm-data'), MRM_DEMO_FORCE: 'true' }),
    /folder of the real server/,
  );
  assert.throws(
    () => loadDemoConfig({ MRM_DEMO: 'true', MRM_DEMO_DIR: tmpdir(), MRM_DEMO_FORCE: 'true' }),
    /not a demo/,
  );
  assert.deepEqual(demoProblems({}, join(dir, 'nested')).hard, []);
  assert.throws(() => loadDemoConfig({ ...base, MRM_DEMO_PORT: 'abc' }), /MRM_DEMO_PORT/);
});

test('the demo uses its own key, port and folder, and listens on loopback only', () => {
  const config = loadDemoConfig({ MRM_DEMO: 'true', MRM_DEMO_DIR: freshDir() });
  assert.equal(config.port, 8788);
  assert.equal(config.host, '127.0.0.1');
  assert.deepEqual(config.masterKey, demoMasterKey());
  assert.match(config.databaseUrl, /demo\.db$/);
  assert.equal(
    loadDemoConfig({ MRM_DEMO: 'true', MRM_DEMO_DIR: freshDir(), MRM_DEMO_PORT: '9001' }).port,
    9001,
  );
});

test('the normal app has no demo routes: /demo/login signs nobody in', async () => {
  const db = await createDatabase('file::memory:');
  await migrate(db);
  const app = createApp({ db, masterKey: demoMasterKey(), version: 'test' });
  for (const path of [
    '/demo/login',
    '/demo/status',
    '/api/demo/login',
    '/demo/login?as=owner&json',
  ]) {
    const res = await app.request(path);
    assert.notEqual(res.status, 200, path);
    assert.equal(res.headers.get('set-cookie'), null, path);
  }
  assert.notEqual((await app.request('/demo/reset', { method: 'POST' })).status, 200);
  await db.close();
});

// ----- seed ---------------------------------------------------------------------------------------------------------------

test('the seed is complete: no warnings, every kind of data present', async () => {
  const rt = await seeded();
  assert.deepEqual(rt.warnings, []);
  assert.equal(await count(rt, 'SELECT COUNT(*) AS n FROM apps'), 6);
  assert.equal(await count(rt, 'SELECT COUNT(DISTINCT identifier) AS n FROM apps'), 3);
  assert.ok((await count(rt, 'SELECT COUNT(*) AS n FROM app_reviews')) >= 200);
  assert.ok((await count(rt, 'SELECT COUNT(DISTINCT locale) AS n FROM listing_snapshots')) >= 6);
  assert.ok((await count(rt, 'SELECT COUNT(*) AS n FROM aso_keywords')) >= 20);
  assert.ok((await count(rt, 'SELECT COUNT(DISTINCT checked_at) AS n FROM aso_rank_checks')) >= 50);
  assert.ok((await count(rt, 'SELECT COUNT(*) AS n FROM aso_competitors')) >= 6);
  assert.ok((await count(rt, 'SELECT COUNT(DISTINCT day) AS n FROM analytics_daily')) >= 85);
  assert.ok((await count(rt, 'SELECT COUNT(*) AS n FROM play_search_terms')) > 0);
  assert.ok((await count(rt, 'SELECT COUNT(*) AS n FROM workflow_runs')) >= 10);
  assert.ok((await count(rt, 'SELECT COUNT(*) AS n FROM staged_changes')) >= 5);
  assert.ok((await count(rt, 'SELECT COUNT(*) AS n FROM audit_events')) > 100);
  assert.equal(await count(rt, 'SELECT COUNT(*) AS n FROM webhook_endpoints'), 2);
  assert.equal(await count(rt, 'SELECT COUNT(*) AS n FROM users'), 4);
  const states = new Set(
    ((await rt.db.query('SELECT DISTINCT status FROM app_releases')) as Json[]).map((r) =>
      String(r.status),
    ),
  );
  for (const s of ['draft', 'in_review', 'approved', 'rejected', 'rolling_out', 'halted'])
    assert.ok(states.has(s), `release state ${s}: ${[...states]}`);
  const roles = new Set(
    ((await rt.db.query('SELECT DISTINCT role FROM workspace_members')) as Json[]).map((r) =>
      String(r.role),
    ),
  );
  assert.deepEqual([...roles].sort(), ['admin', 'member', 'owner', 'viewer']);
  assert.equal(
    await count(rt, "SELECT COUNT(*) AS n FROM app_builds WHERE build_number = '169'"),
    1,
  );
});

test('the seed leaves a stalled release and an unfinished run for the demo to show', async () => {
  const rt = await seeded();
  const { call } = await session(rt);
  const apps = ((await call('GET', '/apps')).body.apps ?? []) as Json[];
  const stalled: string[] = [];
  for (const a of apps) {
    const pipeline = (await call('GET', `/apps/${a.id}/release/pipeline`)).body.pipeline as Json;
    if (pipeline.stalled) stalled.push(`${a.name} ${a.platform}`);
  }
  assert.ok(stalled.includes('Demo Weather ios'), `stalled: ${stalled}`);
  assert.ok(
    (await count(rt, "SELECT COUNT(*) AS n FROM workflow_runs WHERE status != 'completed'")) >= 1,
  );
});

test('icons are real PNGs and one staged screenshot has an alpha channel that blocks the push', async () => {
  const rt = await seeded();
  const { call, cookie, W } = await session(rt);
  const id = await appOf(call, 'Demo Notes', 'ios');
  const icon = await rt.app.request(`${W}/apps/${id}/icon`, { headers: { cookie } });
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/png');
  assert.match(
    JSON.stringify((await call('GET', `/apps/${id}/pending`)).body),
    /apple\.screenshot\.alpha/,
  );
});

test('seeding is idempotent: starting again on the same data changes nothing', async () => {
  const dir = freshDir();
  const first = await start(dir);
  const snapshot = async (rt: DemoRuntime) => ({
    apps: ((await rt.db.query('SELECT id FROM apps ORDER BY id')) as Json[]).map((r) => r.id),
    reviews: await count(rt, 'SELECT COUNT(*) AS n FROM app_reviews'),
    workspaces: await count(rt, 'SELECT COUNT(*) AS n FROM workspaces'),
  });
  const before = await snapshot(first);
  const seededAt = first.seededAt();
  await first.close();
  const second = await start(dir);
  assert.deepEqual(await snapshot(second), before);
  assert.equal(second.seededAt(), seededAt);
  assert.equal(before.workspaces, 1);
  assert.deepEqual(second.warnings, []);
  await second.close();
});

test('the demo database has exactly the schema the migrations produce', async () => {
  const rt = await seeded();
  const fresh = await createDatabase('file::memory:');
  await migrate(fresh);
  const schema = async (db: { query: (sql: string) => Promise<unknown[]> }) =>
    (
      (await db.query(
        "SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name",
      )) as Json[]
    ).map((r) => `${r.name}: ${r.sql}`);
  assert.deepEqual(await schema(rt.db), await schema(fresh));
  await fresh.close();
});

test('the data folder holds only the demo database, its world file and the marker', async () => {
  const dir = freshDir();
  const rt = await start(dir);
  await rt.save();
  const names = readdirSync(dir).filter((n) => !n.startsWith('demo.db-'));
  assert.deepEqual(names.sort(), [DEMO_MARKER, 'demo.db', 'world.json'].sort());
  assert.ok(existsSync(join(dir, 'world.json')));
  await rt.close();
});

// ----- status, sign in, rights ---------------------------------------------------------------------------------------------

test('GET /demo/status says demo:true; /demo/login signs in each demo user and refuses unknown ones', async () => {
  const rt = await seeded();
  const status = (await (await rt.app.request('/demo/status')).json()) as Json;
  assert.equal(status.demo, true);
  assert.equal(status.resetAvailable, true);
  assert.equal(typeof status.seededAt, 'number');
  for (const as of ['owner', 'admin', 'member', 'viewer']) {
    const { call } = await session(rt, as);
    assert.equal((await call('GET', '/apps')).status, 200, as);
  }
  assert.equal((await rt.app.request('/demo/login?as=nobody')).status, 404);
  const redirect = await rt.app.request('/demo/login?next=/apps');
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/apps');
  assert.equal(
    (await rt.app.request('/demo/login?next=//evil.example.com')).headers.get('location'),
    '/',
  );
});

test('the viewer reads but cannot publish', async () => {
  const rt = await seeded();
  const id = await appOf((await session(rt)).call, 'Demo Weather', 'ios');
  const viewer = await session(rt, 'viewer');
  assert.equal((await viewer.call('GET', `/apps/${id}/pending`)).status, 200);
  assert.equal((await viewer.call('POST', `/apps/${id}/publish/preview`, {})).status, 403);
});

// ----- the scripted end to end run -----------------------------------------------------------------------------------------

test('end to end over HTTP: login, apps, stage text, pending, fix, publish plan, publish, approve, release, rollout', async () => {
  const rt = await start();
  try {
    const { call } = await session(rt);
    assert.equal((((await call('GET', '/apps')).body.apps ?? []) as Json[]).length, 6);
    const id = await appOf(call, 'Demo Notes', 'ios');

    // Stage a listing text change and see it pending; the staged alpha screenshot blocks the push until fixed.
    assert.equal(
      (
        await call('PUT', `/apps/${id}/staged/text`, {
          locale: 'en-US',
          field: 'keywords',
          from: 'local',
          value: 'notes,markdown,checklist,write,folders',
        })
      ).status,
      200,
    );
    const pending = (await call('GET', `/apps/${id}/pending`)).body.pending as Json;
    assert.match(JSON.stringify(pending), /keywords/);
    assert.ok(pending.totals.blocking >= 1);
    const blocked = (
      await call('POST', `/apps/${id}/publish/preview`, { steps: [{ type: 'push_draft' }] })
    ).body.plan as Json;
    assert.equal(blocked.steps[0].availability, 'blocked');
    const fixed = await call('POST', `/apps/${id}/staged/assets/fix`, {
      locale: 'en-US',
      kind: 'screenshot',
      device: 'iphone_6_9',
      position: 3,
      fix: 'remove_alpha',
    });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body).slice(0, 300));

    const publish = async (step: Json) => {
      const preview = (await call('POST', `/apps/${id}/publish/preview`, { steps: [step] })).body
        .plan as Json;
      const row = preview.steps.find((s: Json) => s.type === step.type);
      assert.equal(row.availability, 'available', `${step.type}: ${row.reason}`);
      const done = await call('POST', `/apps/${id}/publish`, {
        planHash: preview.planHash,
        phrase: preview.confirmation?.phrase,
        steps: [step],
      });
      assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 400));
      assert.equal(done.body.result.failed, 0);
      return done.body.result as Json;
    };
    assert.equal((await publish({ type: 'push_draft' })).steps[0].status, 'applied');
    await publish({ type: 'submit' });

    // In the store's queue the version cannot be released yet.
    const early = (
      await call('POST', `/apps/${id}/publish/preview`, { steps: [{ type: 'release' }] })
    ).body.plan as Json;
    assert.notEqual(early.steps.find((s: Json) => s.type === 'release').availability, 'available');

    // Time passes and the store approves.
    const advanced = await call('POST', '/demo/advance', { hours: 30, outcome: 'approve' });
    assert.equal(advanced.status, 200);
    assert.ok(
      (advanced.body.happened as string[]).some((l) => l.includes('3.5.0 approved')),
      JSON.stringify(advanced.body),
    );
    assert.equal((await call('POST', `/apps/${id}/sync`)).status, 200);

    // Release, then change the rollout.
    await publish({ type: 'release' });
    // Apple takes a little while to put the version on sale; then the phased release starts.
    const later = await call('POST', '/demo/advance', { hours: 2, outcome: 'none' });
    assert.ok(
      (later.body.happened as string[]).some((l) => l.includes('3.5.0 is live')),
      JSON.stringify(later.body),
    );
    assert.equal((await call('POST', `/apps/${id}/sync`)).status, 200);
    const preview = await call('POST', `/apps/${id}/rollout/preview`, {
      action: 'pause',
      version: '3.5.0',
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body).slice(0, 400));
    const applied = await call('POST', `/apps/${id}/rollout/apply`, {
      action: 'pause',
      version: '3.5.0',
      confirmHash: preview.body.preview.confirmHash,
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.body).slice(0, 400));
  } finally {
    await rt.close();
  }
});

test('a rejection can be simulated and shows in the pipeline', async () => {
  const rt = await start();
  try {
    const { call } = await session(rt);
    const id = await appOf(call, 'Demo Notes', 'macos');
    const advanced = await call('POST', '/demo/advance', { hours: 30, outcome: 'reject' });
    assert.ok(
      (advanced.body.happened as string[]).some((l) => l.includes('rejected')),
      JSON.stringify(advanced.body),
    );
    await call('POST', `/apps/${id}/sync`);
    assert.equal(
      ((await call('GET', `/apps/${id}/release/pipeline`)).body.pipeline as Json).state,
      'rejected',
    );
  } finally {
    await rt.close();
  }
});

// ----- alerts ----------------------------------------------------------------------------------------------------------------

test('the Alerts inbox is not empty: a mix of read and unread alerts, a delivery log, an owner preference, no email', async () => {
  const rt = await seeded();
  const { call } = await session(rt);
  const inbox = (await call('GET', '/alerts/inbox?limit=100')).body as Json;
  const types = new Set((inbox.alerts as Json[]).map((a) => String(a.type)));
  for (const t of [
    'release.rejected',
    'review.low_rating',
    'review.new',
    'release.halted',
    'store.sync_failed',
    'analytics.sync_failing',
    'credential.invalid',
    'ai.suggestion_ready',
  ]) {
    assert.ok(types.has(t), `${t} in ${[...types]}`);
  }
  assert.ok(
    types.size >= 7 && (inbox.alerts as Json[]).length < 20,
    `a readable inbox: ${(inbox.alerts as Json[]).length}`,
  );
  const alerts = inbox.alerts as Json[];
  assert.ok(
    alerts.some((a) => a.read === true) && alerts.some((a) => a.read === false),
    'some read, some unread',
  );
  assert.equal(inbox.unreadCount, alerts.filter((a) => a.read === false).length);
  assert.ok(
    alerts.some((a) => String(a.title).includes('Demo Focus') && a.type === 'release.rejected'),
  );
  // The delivery log has an entry for the inbox channel of each alert, and nothing waits for an email nobody can send.
  assert.ok(
    (await count(
      rt,
      "SELECT COUNT(*) AS n FROM alert_deliveries WHERE channel = 'in_app' AND status = 'sent'",
    )) >= 7,
  );
  assert.equal(
    await count(rt, "SELECT COUNT(*) AS n FROM alert_deliveries WHERE channel = 'email'"),
    0,
  );
  assert.equal(
    await count(
      rt,
      "SELECT COUNT(*) AS n FROM alert_preferences WHERE alert_type = 'release.rejected'",
    ),
    1,
  );
  // The 60 simulated days of ASO refreshes do not flood the alerts table with competitor changes.
  assert.ok((await count(rt, 'SELECT COUNT(*) AS n FROM alerts')) < 40);
});

test('POST /demo/advance runs the alert evaluator once and says what it found', async () => {
  const rt = await start();
  try {
    const { call } = await session(rt);
    const before = Number(((await call('GET', '/alerts/inbox')).body as Json).unreadCount);
    // A failing store read for Demo Weather on Google Play, then time passes: the evaluator sees the failed sync.
    const id = await appOf(call, 'Demo Weather', 'android');
    await call('POST', '/demo/fail', { connector: 'googleplay', kind: 'auth', count: 1 });
    await call('POST', `/apps/${id}/sync`);
    const advanced = await call('POST', '/demo/advance', { hours: 1, outcome: 'none' });
    assert.equal(advanced.status, 200);
    assert.ok(
      advanced.body.alerts && typeof (advanced.body.alerts as Json).checked === 'number',
      JSON.stringify(advanced.body),
    );
    assert.ok((advanced.body.alerts as Json).checked > 0);
    const after = (await call('GET', '/alerts/inbox')).body as Json;
    assert.ok(Number(after.unreadCount) >= before);
  } finally {
    await rt.close();
  }
});

// ----- failure injection, reset ----------------------------------------------------------------------------------------------

test('POST /demo/fail makes the next call to a connector fail, then it recovers', async () => {
  const rt = await start();
  try {
    const { call } = await session(rt);
    const id = await appOf(call, 'Demo Weather', 'ios');
    assert.equal((await call('POST', `/apps/${id}/sync`)).status, 200);
    assert.equal(
      (
        await call('POST', '/demo/fail', {
          connector: 'appstoreconnect',
          kind: 'rate_limit',
          count: 1,
        })
      ).status,
      200,
    );
    assert.equal(((await call('GET', '/demo/status')).body.failures as unknown[]).length, 1);
    const failed = await call('POST', `/apps/${id}/sync`);
    assert.notEqual(failed.status, 200, JSON.stringify(failed.body).slice(0, 200));
    assert.equal((await call('POST', `/apps/${id}/sync`)).status, 200);
    assert.equal(
      (await call('POST', '/demo/fail', { connector: 'nope', kind: 'server' })).status,
      400,
    );
    assert.equal(
      (await call('POST', '/demo/fail', { connector: 'github', kind: 'unknown_applied', count: 2 }))
        .status,
      200,
    );
    assert.equal((await call('DELETE', '/demo/fail')).status, 200);
    assert.deepEqual((await call('GET', '/demo/fail')).body.failures, []);
  } finally {
    await rt.close();
  }
});

test('POST /demo/reset starts again from the seed', async () => {
  const rt = await start();
  try {
    const { call } = await session(rt);
    const id = await appOf(call, 'Demo Notes', 'ios');
    await call('POST', '/demo/advance', { hours: 48, outcome: 'approve' });
    assert.equal((await call('POST', '/demo/reset')).status, 200);
    const again = await session(rt);
    assert.equal((((await again.call('GET', '/apps')).body.apps ?? []) as Json[]).length, 6);
    assert.equal((await again.call('GET', '/demo/status')).body.clock.skewHours, 0);
    assert.notEqual(await appOf(again.call, 'Demo Notes', 'ios'), id, 'a new workspace was seeded');
  } finally {
    await rt.close();
  }
});

// ----- test builds: TestFlight links, workflow artifacts, Google Play internal app sharing --------------------------------

test('Test builds: Demo Notes iOS has a public TestFlight link, Demo Weather iOS one that is off, Demo Focus none; no read fails', async () => {
  const rt = await seeded();
  const { call } = await session(rt);
  const read = async (name: string, platform: string) =>
    (await call('GET', `/apps/${await appOf(call, name, platform)}/builds/artifacts`)).body;

  const notes = await read('Demo Notes', 'ios');
  assert.equal(notes.testflight.problem, null);
  assert.deepEqual(
    notes.testflight.groups.map((g: Json) => [g.name, g.enabled, g.limit]),
    [['Public beta', true, 100]],
  );
  assert.match(notes.testflight.groups[0].publicLink, /^https:\/\/testflight\.apple\.com\/join\//);
  const linked = (notes.store as Json[]).filter(
    (b) => (b.testflightGroupIds as string[]).length > 0,
  );
  assert.ok(linked.length >= 2, 'the public group holds the newer builds');
  assert.equal(notes.downloadEnabled, true);

  const weather = await read('Demo Weather', 'ios');
  assert.equal(weather.testflight.problem, null);
  assert.deepEqual(
    weather.testflight.groups.map((g: Json) => [g.enabled, g.limit]),
    [[false, null]],
  );

  const focus = await read('Demo Focus', 'macos');
  assert.equal(focus.testflight.problem, null);
  assert.deepEqual(focus.testflight.groups, []);

  // An App Store Connect failure is one fixed problem for the whole list, not an error of it (this app was not read yet, so no cache).
  await call('POST', '/demo/fail', { connector: 'appstoreconnect', kind: 'server', count: 1 });
  try {
    const macNotes = await read('Demo Notes', 'macos');
    assert.equal(macNotes.testflight.problem.reason, 'unavailable');
    assert.deepEqual(macNotes.testflight.groups, []);
  } finally {
    await call('DELETE', '/demo/fail');
  }
});

test('Test builds: the demo repository lists small artifacts named like the builds, and they download', async () => {
  const rt = await seeded();
  const { call, cookie, W } = await session(rt);
  const notes = await appOf(call, 'Demo Notes', 'ios');
  const list = (await call('GET', `/apps/${notes}/builds/artifacts`)).body;
  assert.equal(list.problem, null, 'artifacts can be listed');
  const ipa = (list.artifacts as Json[]).find((a) => a.kind === 'ipa');
  assert.ok(ipa, 'an .ipa artifact');
  assert.match(ipa.name, /^demo-notes-.*\.ipa$/);
  assert.ok(ipa.sizeBytes < 2000 && ipa.downloadable);

  const android = await appOf(call, 'Demo Notes', 'android');
  const apk = (
    (await call('GET', `/apps/${android}/builds/artifacts`)).body.artifacts as Json[]
  ).find((a) => a.kind === 'apk');
  assert.ok(apk, 'an .apk artifact');

  const res = await rt.app.request(`${W}/apps/${notes}/builds/artifacts/${ipa.id}/download`, {
    headers: { cookie },
  });
  assert.equal(res.status, 200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.equal(bytes.length, ipa.sizeBytes);
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
});

test('Test builds: Share to device works end to end in the demo (no passkey, nothing leaves the machine)', async () => {
  const rt = await start();
  try {
    const { call } = await session(rt);
    const android = await appOf(call, 'Demo Notes', 'android');
    assert.equal((await call('GET', '/builds/internal-sharing/config')).body.enabled, true);
    const apk = (
      (await call('GET', `/apps/${android}/builds/artifacts`)).body.artifacts as Json[]
    ).find((a) => a.kind === 'apk');
    assert.ok(apk);
    const base = `/apps/${android}/builds/artifacts/${apk.id}/internal-share`;
    const preview = (await call('POST', `${base}/preview`, {})).body.preview as Json;
    assert.equal(preview.checks.canShare, true);
    assert.equal(preview.upload.kind, 'apk');
    const done = await call('POST', base, {
      confirmHash: preview.confirmHash,
      confirmation: preview.confirmation.phrase,
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.match(
      done.body.result.downloadUrl,
      /^https:\/\/play\.google\.com\/apps\/test\/com\.demostudio\.notes\//,
    );
    assert.equal(done.body.result.checksumMatches, true);
    const shares = (await call('GET', `/apps/${android}/builds/internal-shares`)).body;
    assert.equal(shares.shares.length, 1);
  } finally {
    await rt.close();
  }
});
