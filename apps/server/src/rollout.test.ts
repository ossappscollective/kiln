import assert from 'node:assert/strict';
import { StoreError, StoreRateLimitError } from '@mrm/connectors';
import { dbTest } from '@mrm/db/testing';
import { bootRepoApp } from './repo-test-helpers.ts';
import {
  ASC_SECRET,
  appleState,
  bootRollout,
  IOS_TARGET,
  PLAY_SECRET,
  PLAY_TARGET,
  playState,
} from './rollout-test-helpers.ts';
import { rolloutConfirmHash } from './services/store-rollout.ts';

const raise = (to: number) => ({ action: 'set_fraction', ...PLAY_TARGET, userFraction: to });
const halt = { action: 'halt', ...PLAY_TARGET };
const pause = { action: 'pause', ...IOS_TARGET };
const releaseAll = { action: 'release_to_all', ...IOS_TARGET };

// ----- the kill switch ---------------------------------------------------------------------------

dbTest(
  'kill switch: off by default; with it off every rollout route answers 409 rollout_disabled and no store is reached',
  async (db) => {
    const t = await bootRollout(db, { enabled: false });
    const appId = await t.addApp('android');
    const config = await t.call(t.owner, 'GET', '/rollout/config');
    assert.equal(config.status, 200);
    assert.deepEqual(
      [config.body.enabled, config.body.envName],
      [false, 'MRM_STORE_ROLLOUT_ENABLED'],
    );
    assert.deepEqual(config.body.actions, {
      android: ['set_fraction', 'halt', 'resume', 'complete'],
      ios: ['pause', 'resume', 'release_to_all'],
    });
    assert.deepEqual(config.body.irreversible, ['complete', 'release_to_all']);
    const calls: [string, string, unknown?][] = [
      ['GET', t.rp(appId, `/state?track=production&versionCodes=240`)],
      ['POST', t.rp(appId, '/preview'), raise(0.2)],
      ['POST', t.rp(appId, '/apply'), { ...raise(0.2), confirmHash: 'a'.repeat(64) }],
    ];
    for (const [method, path, body] of calls) {
      const res = await t.call(t.owner, method, path, body);
      assert.equal(res.status, 409, `${method} ${path}`);
      assert.equal(res.body.error, 'rollout_disabled');
      assert.match(res.body.message, /MRM_STORE_ROLLOUT_ENABLED=true/);
    }
    assert.equal(t.built.length, 0, 'no connector was built');
    assert.equal(t.stores.android.reads + t.stores.android.writes.length, 0);
    assert.equal((await t.audit('%')).filter((a) => a.action.startsWith('release.')).length, 0);
    assert.equal((await db.query('SELECT app_id FROM store_rollout_claims')).length, 0);
  },
);

dbTest(
  'kill switch: an app that is created without the option is off too (the default of createApp)',
  async (db) => {
    const t = await bootRepoApp(db);
    const res = await t.call(t.owner, 'GET', '/rollout/config');
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, false);
    assert.equal(
      (await t.call(t.owner, 'POST', '/apps/x/rollout/preview', raise(0.2))).status,
      409,
    );
  },
);

// ----- rights ----------------------------------------------------------------------------------------

dbTest(
  'rights: only owners and admins preview or change a rollout; anyone who may read apps reads the config; non-members get 404',
  async (db) => {
    const t = await bootRollout(db);
    const appId = await t.addApp('android');
    const viewer = await t.addMember('viewer');
    const member = await t.addMember('member');
    const admin = await t.addMember('admin');
    for (const cookie of [viewer, member]) {
      assert.equal((await t.preview(appId, raise(0.2), cookie)).status, 403);
      assert.equal((await t.apply(appId, raise(0.2), 'a'.repeat(64), cookie)).status, 403);
      assert.equal(
        (await t.call(cookie, 'GET', t.rp(appId, '/state?track=production&versionCodes=240')))
          .status,
        403,
      );
      assert.equal((await t.call(cookie, 'GET', '/rollout/config')).status, 200);
    }
    assert.equal(t.stores.android.reads + t.stores.android.writes.length, 0);
    const hash = await t.previewHash(appId, raise(0.2));
    assert.equal((await t.apply(appId, raise(0.2), hash, admin)).status, 200, 'an admin may');

    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
    const outsider = await t.addMember('owner', 'other');
    for (const [method, path, body] of [
      ['GET', '/rollout/config'],
      ['GET', t.rp(appId, '/state?track=production&versionCodes=240')],
      ['POST', t.rp(appId, '/preview'), raise(0.3)],
      ['POST', t.rp(appId, '/apply'), { ...raise(0.3), confirmHash: hash }],
    ] as const) {
      assert.equal((await t.call(outsider, method, path, body)).status, 404, `${method} ${path}`);
    }
    // The app of one workspace does not exist in another, even for that one's owner.
    assert.equal(
      (await t.call(outsider, 'POST', t.rp(appId, '/preview'), raise(0.3), 'other')).status,
      404,
    );
    assert.equal(
      (
        await t.call(
          outsider,
          'POST',
          t.rp(appId, '/apply'),
          { ...raise(0.3), confirmHash: hash },
          'other',
        )
      ).status,
      404,
    );
    assert.equal(t.stores.android.writes.length, 1, 'only the admin’s change reached the store');
  },
);

dbTest(
  'tokens: the action must be named (no list never counts), the ceiling still applies, an app limited token reaches only its apps',
  async (db) => {
    const t = await bootRollout(db);
    const appId = await t.addApp('android');
    const other = await t.addApp('android');
    const mint = async (input: Record<string, unknown>) => {
      const res = await t.call(t.owner, 'POST', '/tokens', { name: 'T', role: 'admin', ...input });
      assert.equal(res.status, 201, res.text);
      return res.body.token as string;
    };
    const bearer = async (token: string, method: string, path: string, body?: unknown) => {
      const res = await t.app.request(`/api/workspaces/${t.workspaceId}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: res.status,
        body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
      };
    };
    const hash = await t.previewHash(appId, raise(0.2));
    const everything = await mint({});
    assert.equal(
      (
        await bearer(everything, 'POST', t.rp(appId, '/apply'), {
          ...raise(0.2),
          confirmHash: hash,
        })
      ).status,
      403,
      'no list: never',
    );
    assert.equal(
      (await bearer(everything, 'POST', t.rp(appId, '/preview'), raise(0.2))).status,
      403,
    );
    const planning = await mint({ actions: ['apps.read', 'plans.write'] });
    assert.equal(
      (await bearer(planning, 'POST', t.rp(appId, '/apply'), { ...raise(0.2), confirmHash: hash }))
        .status,
      403,
    );
    const tooLow = await t.call(t.owner, 'POST', '/tokens', {
      name: 'T',
      role: 'member',
      actions: ['releases.rollout'],
    });
    assert.equal(
      tooLow.status,
      400,
      'the ceiling still applies: a member token cannot be given the action',
    );
    assert.equal(tooLow.body.error, 'action_above_role');
    assert.equal(t.stores.android.writes.length, 0);

    const scoped = await mint({ actions: ['releases.rollout', 'apps.read'], appIds: [appId] });
    assert.equal(
      (await bearer(scoped, 'POST', t.rp(other, '/preview'), raise(0.2))).status,
      404,
      'another app',
    );
    assert.equal(
      (await bearer(scoped, 'GET', '/rollout/config')).status,
      403,
      'a workspace wide route is not for an app limited token',
    );
    const done = await bearer(scoped, 'POST', t.rp(appId, '/apply'), {
      ...raise(0.2),
      confirmHash: hash,
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(t.stores.android.writes.length, 1);
    const changed = (await t.audit('release.rollout_changed'))[0];
    assert.equal(changed?.actorType, 'token', 'a change by a token is attributed to the token');
    const unlimited = await mint({ actions: ['releases.rollout', 'apps.read'] });
    assert.equal((await bearer(unlimited, 'GET', '/rollout/config')).status, 200);
  },
);

// ----- validation --------------------------------------------------------------------------------------

dbTest(
  'validation: each platform takes its own fields and actions; shares only between 0 and 1',
  async (db) => {
    const t = await bootRollout(db);
    const android = await t.addApp('android');
    const ios = await t.addApp('ios');
    const cases: [string, Record<string, unknown>, string][] = [
      [android, { action: 'pause', ...PLAY_TARGET }, 'action'],
      [android, { action: 'set_fraction', ...PLAY_TARGET }, 'userFraction'],
      [android, { action: 'set_fraction', ...PLAY_TARGET, userFraction: 1 }, 'userFraction'],
      [android, { action: 'set_fraction', ...PLAY_TARGET, userFraction: 0 }, 'userFraction'],
      [android, { action: 'set_fraction', ...PLAY_TARGET, userFraction: 0.00001 }, 'userFraction'],
      [android, { action: 'halt', ...PLAY_TARGET, userFraction: 0.5 }, 'userFraction'],
      [android, { action: 'complete', ...PLAY_TARGET, userFraction: 0.5 }, 'userFraction'],
      [android, { action: 'halt', track: 'production' }, 'versionCodes'],
      [android, { action: 'halt', versionCodes: ['240'] }, 'track'],
      [android, { action: 'halt', track: '../x', versionCodes: ['240'] }, 'track'],
      [android, { action: 'halt', track: 'production', versionCodes: ['abc'] }, 'versionCodes'],
      [android, { action: 'halt', ...PLAY_TARGET, version: '2.4.0' }, 'version'],
      [ios, { action: 'halt', ...IOS_TARGET }, 'action'],
      [ios, { action: 'set_fraction', ...IOS_TARGET, userFraction: 0.2 }, 'action'],
      [ios, { action: 'pause', ...IOS_TARGET, userFraction: 0.2 }, 'userFraction'],
      [ios, { action: 'pause' }, 'version'],
      [ios, { action: 'pause', version: '../x' }, 'version'],
      [ios, { action: 'pause', ...PLAY_TARGET }, 'track'],
      [ios, { action: 'pause', version: '2.4.0', versionCodes: ['240'] }, 'versionCodes'],
    ];
    for (const [appId, body, field] of cases) {
      for (const res of [
        await t.preview(appId, body),
        await t.apply(appId, body, 'a'.repeat(64)),
      ]) {
        assert.equal(res.status, 422, JSON.stringify(body));
        assert.equal(res.body.error, 'invalid_rollout');
        assert.equal(res.body.field, field, JSON.stringify(body));
      }
    }
    // Shape problems are 400: an unknown field, a share that is not a number, a malformed hash.
    for (const body of [
      { ...raise(0.2), extra: 1 },
      { ...raise(0.2), userFraction: '0.2' },
      { action: 5 },
      { ...halt, versionCodes: [] },
    ]) {
      assert.equal((await t.preview(android, body)).status, 400, JSON.stringify(body));
    }
    for (const hash of ['nope', 'A'.repeat(64), 'a'.repeat(63)]) {
      assert.equal((await t.apply(android, halt, hash)).status, 400, hash);
    }
    assert.equal((await t.apply(android, halt, '')).status, 400);
    assert.equal(
      (await t.call(t.owner, 'POST', t.rp(android, '/apply'), halt)).status,
      400,
      'no hash at all',
    );
    assert.equal((await t.preview('missing', halt)).status, 404);
    assert.equal(t.stores.android.reads + t.stores.ios.reads, 0, 'nothing was sent to a store');
  },
);

// ----- state and preview --------------------------------------------------------------------------------

dbTest(
  'state: the live state and what may be done; preview: current, proposed, hash; neither writes',
  async (db) => {
    const t = await bootRollout(db);
    const appId = await t.addApp('android');
    const state = await t.call(
      t.owner,
      'GET',
      t.rp(appId, '/state?track=production&versionCodes=240'),
    );
    assert.equal(state.status, 200);
    assert.deepEqual(state.body.current, playState());
    assert.equal(state.body.minUserFraction, 0.1);
    assert.equal(state.body.app.store, 'googleplay');
    const allowed = Object.fromEntries(
      (
        state.body.allowedActions as { action: string; allowed: boolean; irreversible: boolean }[]
      ).map((a) => [a.action, a]),
    );
    assert.deepEqual(
      [
        allowed.set_fraction?.allowed,
        allowed.halt?.allowed,
        allowed.resume?.allowed,
        allowed.complete?.allowed,
      ],
      [true, true, false, true],
    );
    assert.equal(allowed.complete?.irreversible, true);
    assert.equal(
      (await t.call(t.owner, 'GET', t.rp(appId, '/state?track=production'))).status,
      422,
      'versionCodes is needed',
    );

    const res = await t.preview(appId, raise(0.25));
    assert.equal(res.status, 200, res.text);
    const p = res.body.preview;
    assert.deepEqual(
      [p.current.userFraction, p.proposed.userFraction, p.proposed.status],
      [0.1, 0.25, 'inProgress'],
    );
    assert.equal(p.irreversible, false);
    assert.match(p.summary, /from 10% to 25%/);
    assert.match(p.confirmHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(p.target, { track: 'production', versionCodes: ['240'] });
    assert.ok(p.warnings.some((w: string) => /several hours/.test(w)));
    assert.equal(
      await t.previewHash(appId, raise(0.25)),
      p.confirmHash,
      'the same request and state: the same hash',
    );
    assert.notEqual(
      await t.previewHash(appId, raise(0.3)),
      p.confirmHash,
      'another change: another hash',
    );
    assert.equal(t.stores.android.writes.length, 0, 'a preview never writes');
    assert.equal((await t.audit()).length, 0, 'and is not a change');
    // The credential was used to read, and that is on the audit log.
    assert.ok(
      (await db.query("SELECT id FROM audit_events WHERE action = 'credential.use'")).length >= 1,
    );
  },
);

dbTest(
  'preview refuses what the state does not allow: a lower share, a halted release, a finished phased release',
  async (db) => {
    const t = await bootRollout(db);
    const android = await t.addApp('android');
    const ios = await t.addApp('ios');
    const lower = await t.preview(android, raise(0.1));
    assert.equal(lower.status, 422);
    assert.equal(lower.body.error, 'rollout_not_allowed');
    assert.equal(lower.body.reason, 'not_an_increase');
    assert.equal(lower.body.current.userFraction, 0.1, 'the answer carries the current state');
    assert.equal((await t.preview(android, raise(0.05))).body.reason, 'not_an_increase');
    assert.equal(
      (await t.preview(android, { action: 'resume', ...PLAY_TARGET })).body.reason,
      'not_allowed',
    );
    t.stores.android.state = playState({ status: 'halted' });
    assert.equal(
      (await t.preview(android, raise(0.5))).status,
      422,
      'a halted rollout is resumed first',
    );
    assert.equal((await t.preview(android, { action: 'complete', ...PLAY_TARGET })).status, 422);
    assert.equal(
      (await t.preview(android, { action: 'resume', ...PLAY_TARGET, userFraction: 0.05 })).body
        .reason,
      'not_an_increase',
    );
    assert.equal((await t.preview(android, { action: 'resume', ...PLAY_TARGET })).status, 200);

    t.stores.ios.state = appleState({ phasedReleaseState: 'COMPLETE' });
    for (const action of ['pause', 'resume', 'release_to_all']) {
      const res = await t.preview(ios, { action, ...IOS_TARGET });
      assert.equal(res.status, 422, action);
      assert.equal(res.body.error, 'rollout_not_allowed', action);
    }
    t.stores.ios.state = appleState({ phasedReleaseId: null, phasedReleaseState: null });
    assert.equal((await t.preview(ios, pause)).body.error, 'rollout_not_allowed');
    assert.equal(t.stores.android.writes.length + t.stores.ios.writes.length, 0);
  },
);

// ----- apply: Google Play ----------------------------------------------------------------------------------

dbTest(
  'apply (Google Play): a confirmed change is written once, audited, emitted as an event, and the claim is given back',
  async (db) => {
    const t = await bootRollout(db);
    const appId = await t.addApp('android');
    const hash = await t.previewHash(appId, raise(0.2));
    const res = await t.apply(appId, raise(0.2), hash);
    assert.equal(res.status, 200, res.text);
    const r = res.body.result;
    assert.deepEqual(
      [
        r.action,
        r.before.userFraction,
        r.after.userFraction,
        r.after.status,
        r.irreversible,
        r.confirmedByReread,
      ],
      ['set_fraction', 0.1, 0.2, 'inProgress', false, false],
    );
    assert.equal(t.stores.android.writes.length, 1);
    assert.equal(
      t.stores.android.state.store === 'googleplay' && t.stores.android.state.userFraction,
      0.2,
    );
    assert.deepEqual(await t.claims(), [], 'nothing stays claimed');

    const [changed] = await t.audit('release.rollout_changed');
    assert.deepEqual(changed?.detail, {
      appId,
      store: 'googleplay',
      platform: 'android',
      action: 'set_fraction',
      track: 'production',
      versionCodes: ['240'],
      from: { status: 'inProgress', userFraction: 0.1 },
      to: { status: 'inProgress', userFraction: 0.2 },
      irreversible: false,
      hash,
      via: 'store',
    });
    const [event] = await t.events('release.rollout_changed');
    assert.deepEqual(Object.keys(event?.payload ?? {}).sort(), [
      'action',
      'actor',
      'appId',
      'confirmedByReread',
      'from',
      'irreversible',
      'platform',
      'store',
      'to',
      'track',
      'versionCodes',
    ]);
    assert.deepEqual(event?.payload.to, { status: 'inProgress', userFraction: 0.2 });

    // The old confirmation is spent: the store is at 20% now, so the same hash fits nothing.
    const again = await t.apply(appId, raise(0.2), hash);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'state_changed');
    assert.equal(t.stores.android.writes.length, 1, 'not written twice');
  },
);

dbTest(
  'apply (Google Play): halt, resume and complete; complete is marked irreversible and cannot be repeated',
  async (db) => {
    const t = await bootRollout(db);
    const appId = await t.addApp('android');
    const step = async (body: Record<string, unknown>) => {
      const res = await t.apply(appId, body, await t.previewHash(appId, body));
      assert.equal(res.status, 200, res.text);
      return res.body.result;
    };
    const halted = await step(halt);
    assert.deepEqual(
      [halted.after.status, halted.after.userFraction],
      ['halted', 0.1],
      'halt keeps the share',
    );
    const resumed = await step({ action: 'resume', ...PLAY_TARGET, userFraction: 0.3 });
    assert.deepEqual([resumed.after.status, resumed.after.userFraction], ['inProgress', 0.3]);
    const done = await step({ action: 'complete', ...PLAY_TARGET });
    assert.deepEqual(
      [done.after.status, done.after.userFraction, done.irreversible],
      ['completed', null, true],
    );
    for (const body of [
      halt,
      raise(0.9),
      { action: 'complete', ...PLAY_TARGET },
      { action: 'resume', ...PLAY_TARGET },
    ]) {
      assert.equal(
        (await t.preview(appId, body)).status,
        422,
        `nothing follows a completed rollout: ${body.action}`,
      );
    }
    assert.equal(t.stores.android.writes.length, 3);
    const complete = (await t.audit('release.rollout_changed')).find(
      (a) => a.detail.action === 'complete',
    );
    assert.equal(complete?.detail.irreversible, true);
  },
);

dbTest(
  'apply never lowers the share, even with a hash that fits: the connector refuses and nothing is written',
  async (db) => {
    const t = await bootRollout(db);
    const appId = await t.addApp('android');
    const app = { id: appId, platform: 'android' as const };
    const hash = rolloutConfirmHash({
      workspaceId: t.workspaceId,
      app,
      target: { track: 'production', versionCodes: ['240'] },
      change: { action: 'set_fraction', userFraction: 0.05 },
      current: playState(),
    });
    const res = await t.apply(appId, raise(0.05), hash);
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'invalid_rollout');
    assert.match(res.body.message, /can only go up/);
    assert.equal(t.stores.android.writes.length, 0);
    assert.deepEqual(await t.claims(), []);
    const [failed] = await t.audit('release.rollout_failed');
    assert.equal(failed?.detail.code, 'invalid_rollout');
    assert.equal(failed?.detail.requestedUserFraction, 0.05);
  },
);

// ----- apply: the App Store ------------------------------------------------------------------------------

dbTest(
  'apply (App Store): pause, resume and release to all; a finished phased release cannot be released again',
  async (db) => {
    const t = await bootRollout(db);
    const appId = await t.addApp('ios');
    const step = async (body: Record<string, unknown>) => {
      const res = await t.apply(appId, body, await t.previewHash(appId, body));
      assert.equal(res.status, 200, res.text);
      return res.body.result;
    };
    assert.equal((await step(pause)).after.phasedReleaseState, 'PAUSED');
    assert.equal(
      (await step({ action: 'resume', ...IOS_TARGET })).after.phasedReleaseState,
      'ACTIVE',
    );
    const done = await step(releaseAll);
    assert.deepEqual([done.after.phasedReleaseState, done.irreversible], ['COMPLETE', true]);
    for (const action of ['pause', 'resume', 'release_to_all'])
      assert.equal(
        (await t.preview(appId, { action, ...IOS_TARGET })).status,
        422,
        `no un-release: ${action}`,
      );
    assert.equal(t.stores.ios.writes.length, 3);
    const [event] = (await t.events('release.rollout_changed')).filter(
      (e) => e.payload.action === 'release_to_all',
    );
    assert.deepEqual(
      [event?.payload.version, event?.payload.platform, event?.payload.irreversible],
      ['2.4.0', 'ios', true],
    );
  },
);

dbTest('the day number of a phased release moving on does not make a preview stale', async (db) => {
  const t = await bootRollout(db);
  const appId = await t.addApp('ios');
  const hash = await t.previewHash(appId, pause);
  t.stores.ios.state = appleState({ currentDayNumber: 4, totalPauseDays: 1 });
  assert.equal((await t.apply(appId, pause, hash)).status, 200);
});

// ----- drift ----------------------------------------------------------------------------------------------

dbTest(
  'drift: the store changed after the preview: nothing is written, the answer carries the new state and a new hash',
  async (db) => {
    const t = await bootRollout(db);
    const appId = await t.addApp('android');
    const hash = await t.previewHash(appId, raise(0.2));
    // Someone raised it in Play Console in the meantime.
    t.stores.android.state = playState({ userFraction: 0.5 });
    const res = await t.apply(appId, raise(0.2), hash);
    assert.equal(res.status, 409, res.text);
    assert.equal(res.body.error, 'state_changed');
    assert.equal(res.body.current.userFraction, 0.5);
    assert.equal(res.body.reason, 'not_an_increase', 'and the change no longer fits');
    assert.equal(t.stores.android.writes.length, 0);
    assert.deepEqual(await t.claims(), []);
    const [failed] = await t.audit('release.rollout_failed');
    assert.equal(failed?.detail.code, 'state_changed');
    assert.equal(failed?.detail.outcome, 'refused');

    // Another change from the new state works with the hash of a new preview.
    t.stores.android.state = playState({ userFraction: 0.15 });
    const second = await t.apply(appId, raise(0.2), hash);
    assert.equal(second.status, 409);
    assert.equal(second.body.proposed.userFraction, 0.2);
    assert.match(second.body.confirmHash, /^[0-9a-f]{64}$/);
    assert.equal(
      (await t.apply(appId, raise(0.2), second.body.confirmHash)).status,
      200,
      'the new hash fits the new state',
    );
    assert.equal(t.stores.android.writes.length, 1);
  },
);

dbTest(
  'the hash covers the request: a hash from one preview cannot confirm another change, another app or a random value',
  async (db) => {
    const t = await bootRollout(db);
    const appId = await t.addApp('android');
    const other = await t.addApp('android');
    const hash = await t.previewHash(appId, raise(0.2));
    for (const [id, body, h] of [
      [appId, raise(0.9), hash],
      [appId, halt, hash],
      [other, raise(0.2), hash],
      [appId, raise(0.2), 'a'.repeat(64)],
    ] as const) {
      const res = await t.apply(id, body, h);
      assert.equal(res.status, 409, JSON.stringify(body));
      assert.equal(res.body.error, 'state_changed');
    }
    assert.equal(t.stores.android.writes.length, 0);
  },
);

// ----- one write in flight ----------------------------------------------------------------------------------

dbTest(
  'one write in flight per app: a second change meanwhile is 409 write_in_progress; another app is not blocked',
  async (db) => {
    const t = await bootRollout(db);
    const appId = await t.addApp('android');
    const hash = await t.previewHash(appId, raise(0.2));
    let open!: () => void;
    t.stores.android.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const first = t.apply(appId, raise(0.2), hash);
    while (t.stores.android.writes.length === 0) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(
      (await t.claims()).map((c) => [c.status, c.action]),
      [['writing', 'set_fraction']],
    );
    const second = await t.apply(appId, halt, 'b'.repeat(64));
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'write_in_progress');
    const ios = await t.addApp('ios');
    const iosHash = await t.previewHash(ios, pause);
    assert.equal((await t.apply(ios, pause, iosHash)).status, 200, 'another app is its own claim');
    open();
    assert.equal((await first).status, 200);
    assert.equal(t.stores.android.writes.length, 1, 'only the first reached the store');
    assert.deepEqual(await t.claims(), []);
  },
);

dbTest(
  'a claim that expired is taken over (the re-read and the hash still decide); one marked unknown blocks until a preview reads the store',
  async (db) => {
    const t = await bootRollout(db, { claimTtlMs: 60_000 });
    const appId = await t.addApp('android');
    const hash = await t.previewHash(appId, raise(0.2));
    const old = Date.now() - 10 * 60_000;
    await db.execute(
      "INSERT INTO store_rollout_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at) VALUES (?, 'android', ?, 'halt', 'writing', 'u', ?)",
      [appId, t.workspaceId, old],
    );
    assert.equal(
      (await t.apply(appId, raise(0.2), hash)).status,
      200,
      'a dead write does not block for ever',
    );

    await db.execute(
      "INSERT INTO store_rollout_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at) VALUES (?, 'android', ?, 'halt', 'unknown', 'u', ?)",
      [appId, t.workspaceId, old],
    );
    const hash2 = await t.previewHash(appId, raise(0.4));
    assert.deepEqual(
      await t.claims(),
      [],
      'a preview read the store, so the unknown outcome is settled',
    );
    await db.execute(
      "INSERT INTO store_rollout_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at) VALUES (?, 'android', ?, 'halt', 'unknown', 'u', ?)",
      [appId, t.workspaceId, old],
    );
    const blocked = await t.apply(appId, raise(0.4), hash2);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'outcome_unknown');
    assert.equal(t.stores.android.writes.length, 1);
    await t.preview(appId, raise(0.4));
    assert.equal((await t.apply(appId, raise(0.4), hash2)).status, 200);
    assert.equal(t.stores.android.writes.length, 2);
  },
);

// ----- an unknown outcome --------------------------------------------------------------------------------------

dbTest(
  'an unknown outcome that was applied: the state is read back and the change is confirmed, never written twice',
  async (db) => {
    const t = await bootRollout(db);
    for (const platform of ['android', 'ios'] as const) {
      const appId = await t.addApp(platform);
      const body = platform === 'android' ? raise(0.2) : pause;
      const hash = await t.previewHash(appId, body);
      const store = t.stores[platform === 'android' ? 'android' : 'ios'];
      store.behavior = { kind: 'unknown', applied: true };
      const res = await t.apply(appId, body, hash);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.result.confirmedByReread, true);
      assert.equal(store.writes.length, 1, 'no retry');
      assert.deepEqual(await t.claims(), []);
      assert.equal((await t.audit('release.rollout_changed'))[0]?.detail.via, 'reread');
      assert.equal((await t.events('release.rollout_changed'))[0]?.payload.confirmedByReread, true);
      await db.execute("DELETE FROM audit_events WHERE action LIKE 'release.%'");
      await db.execute("DELETE FROM events WHERE type LIKE 'release.%'");
    }
  },
);

dbTest(
  'an unknown outcome that was not applied: the App Store says so (502 write_failed, not written again); Google Play cannot be sure, so it asks for a new preview',
  async (db) => {
    const t = await bootRollout(db);
    const ios = await t.addApp('ios');
    const hash = await t.previewHash(ios, pause);
    t.stores.ios.behavior = { kind: 'unknown', applied: false };
    const res = await t.apply(ios, pause, hash);
    assert.equal(res.status, 502);
    assert.equal(res.body.error, 'write_failed');
    assert.equal(res.body.outcome, 'not_applied');
    assert.equal(t.stores.ios.writes.length, 1, 'not retried');
    assert.deepEqual(await t.claims(), []);
    assert.equal((await t.audit('release.rollout_failed'))[0]?.detail.code, 'not_applied');

    const android = await t.addApp('android');
    const hash2 = await t.previewHash(android, raise(0.2));
    t.stores.android.behavior = { kind: 'unknown', applied: false };
    const unknown = await t.apply(android, raise(0.2), hash2);
    assert.equal(unknown.status, 409);
    assert.equal(unknown.body.error, 'outcome_unknown');
    assert.equal(t.stores.android.writes.length, 1);
    assert.deepEqual(
      (await t.claims()).map((c) => c.status),
      ['unknown'],
    );
    // It blocks writing until the store has been looked at again.
    t.stores.android.behavior = { kind: 'ok' };
    const blocked = await t.apply(android, raise(0.2), hash2);
    assert.equal(blocked.body.error, 'outcome_unknown');
    assert.equal(t.stores.android.writes.length, 1, 'no store call while the outcome is unknown');
    const fresh = await t.previewHash(android, raise(0.2));
    assert.equal((await t.apply(android, raise(0.2), fresh)).status, 200);
    assert.equal(t.stores.android.writes.length, 2);
  },
);

dbTest(
  'an unknown outcome that cannot be read back is outcome_unknown and blocks; a state that is neither old nor new is state_changed',
  async (db) => {
    const t = await bootRollout(db);
    const appId = await t.addApp('android');
    const hash = await t.previewHash(appId, raise(0.2));
    t.stores.android.behavior = { kind: 'unknown', applied: true };
    t.stores.android.readFailsAfterWrite = true;
    const res = await t.apply(appId, raise(0.2), hash);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'outcome_unknown');
    assert.deepEqual(
      (await t.claims()).map((c) => c.status),
      ['unknown'],
    );
    assert.equal((await t.audit('release.rollout_failed'))[0]?.detail.outcome, 'unknown');
    assert.equal(
      (await t.events('release.rollout_changed')).length,
      0,
      'no event for a change that is not confirmed',
    );

    const t2 = t;
    const id2 = await t2.addApp('ios');
    const hash2 = await t2.previewHash(id2, pause);
    t2.stores.ios.behavior = { kind: 'unknown', applied: false };
    // Between the lost answer and the read back somebody released it to all.
    const original = t2.stores.ios.applyChange.bind(t2.stores.ios);
    t2.stores.ios.applyChange = async (input) => {
      try {
        return await original(input);
      } finally {
        t2.stores.ios.state = appleState({ phasedReleaseState: 'COMPLETE' });
      }
    };
    const diverged = await t2.apply(id2, pause, hash2);
    assert.equal(diverged.status, 409);
    assert.equal(diverged.body.error, 'state_changed');
    assert.equal(diverged.body.current.phasedReleaseState, 'COMPLETE');
    assert.equal(t2.stores.ios.writes.length, 1);
  },
);

dbTest('a write that outlives the timeout is read back, not repeated', async (db) => {
  const t = await bootRollout(db, { timeoutMs: 40 });
  const appId = await t.addApp('android');
  const hash = await t.previewHash(appId, raise(0.2));
  t.stores.android.gate = new Promise<void>(() => undefined); // never answers
  const res = await t.apply(appId, raise(0.2), hash);
  // The write was sent (the guard accepted) and then did not answer: the state is read back.
  assert.equal(t.stores.android.writes.length, 1);
  assert.equal(res.status, 409, res.text);
  assert.equal(
    res.body.error,
    'outcome_unknown',
    'the old state could be Play being slow to show it',
  );
  assert.equal(t.stores.android.writes.length, 1, 'never repeated');
});

dbTest('a read that outlives the timeout answers 504 and changes nothing', async (db) => {
  const slow = await bootRollout(db, { timeoutMs: 30 });
  const id = await slow.addApp('android');
  slow.stores.android.readState = () => new Promise(() => undefined);
  const read = await slow.preview(id, raise(0.2));
  assert.equal(read.status, 504);
  assert.equal(read.body.error, 'timeout');
  assert.match(read.body.message, /Nothing was changed/);
  assert.equal(slow.stores.android.writes.length, 0);
});

// ----- refusals ------------------------------------------------------------------------------------------------

dbTest(
  'a refusal by the store: nothing changed, a clear code, the claim given back, an audit entry, no secret in the answer',
  async (db) => {
    const t = await bootRollout(db);
    const appId = await t.addApp('android');
    const leak = `${JSON.stringify(PLAY_SECRET)}`.slice(1, 40);
    const cases: [StoreError, number, string][] = [
      [new StoreError('googleplay', 'auth', `bad key ${leak}`, 401), 422, 'store_auth'],
      [new StoreError('googleplay', 'forbidden', 'no', 403), 422, 'store_forbidden'],
      [new StoreError('googleplay', 'not_found', 'no release', 404), 422, 'store_not_found'],
      [
        new StoreError('googleplay', 'changes_in_review', 'changes are in review', 400),
        409,
        'changes_in_review',
      ],
      [new StoreError('googleplay', 'server', 'down', 500), 502, 'store_unavailable'],
      [new StoreError('googleplay', 'unexpected', 'bad', 400), 422, 'store_rejected'],
      [new StoreRateLimitError('googleplay', 120), 429, 'rate_limited'],
    ];
    for (const [error, status, code] of cases) {
      const hash = await t.previewHash(appId, raise(0.2));
      t.stores.android.behavior = { kind: 'refuse', error };
      const res = await t.apply(appId, raise(0.2), hash);
      assert.equal(res.status, status, code);
      assert.equal(res.body.error, code);
      assert.ok(!res.text.includes(leak), 'the answer carries no secret');
      if (code === 'rate_limited') assert.equal(res.headers.get('retry-after'), '120');
      assert.deepEqual(await t.claims(), []);
      assert.equal(
        t.stores.android.state.store === 'googleplay' && t.stores.android.state.userFraction,
        0.1,
        'nothing changed',
      );
    }
    assert.equal(t.stores.android.writes.length, cases.length, 'one attempt each, no retries');
    const failed = await t.audit('release.rollout_failed');
    assert.deepEqual(
      failed.map((f) => f.detail.code),
      cases.map((c) => c[2]),
    );
    assert.equal((await t.events('release.rollout_changed')).length, 0);
  },
);

dbTest('credential problems stop before any store call and give the claim back', async (db) => {
  const t = await bootRollout(db);
  const android = await t.addApp('android');
  const ios = await t.addApp('ios');
  const hash = await t.previewHash(android, raise(0.2));
  const iosHash = await t.previewHash(ios, pause);
  const before = t.built.length;
  await db.execute('UPDATE apps SET store_app_id = NULL WHERE id = ?', [ios]);
  const unsynced = await t.apply(ios, pause, iosHash);
  assert.equal(unsynced.status, 422);
  assert.equal(unsynced.body.error, 'app_not_synced');
  await db.execute("UPDATE credentials SET kind = 'github_token' WHERE id = ?", [t.playCredential]);
  const kind = await t.apply(android, raise(0.2), hash);
  assert.equal(kind.body.error, 'credential_kind');
  await db.execute(
    "UPDATE credentials SET kind = 'google_play', ciphertext = 'garbage' WHERE id = ?",
    [t.playCredential],
  );
  const unreadable = await t.apply(android, raise(0.2), hash);
  assert.equal(unreadable.status, 422);
  assert.equal(unreadable.body.error, 'credential_unreadable');
  await db
    .execute('UPDATE apps SET credential_id = ? WHERE id = ?', ['gone', android])
    .catch(() => undefined);
  assert.equal(t.built.length, before);
  assert.equal(t.stores.android.writes.length + t.stores.ios.writes.length, 0);
  assert.deepEqual(await t.claims(), []);
});

// ----- nothing sensitive is stored -------------------------------------------------------------------------------

dbTest(
  'audit, events, jobs and answers never hold a credential; deleting the app removes its claim',
  async (db) => {
    const t = await bootRollout(db);
    const appId = await t.addApp('android');
    const ios = await t.addApp('ios');
    const hash = await t.previewHash(appId, raise(0.2));
    await t.apply(appId, raise(0.2), hash);
    t.stores.android.behavior = {
      kind: 'refuse',
      error: new StoreError('googleplay', 'forbidden', `no ${PLAY_SECRET}`, 403),
    };
    await t.apply(appId, halt, await t.previewHash(appId, halt));
    const iosHash = await t.previewHash(ios, pause);
    t.stores.ios.behavior = { kind: 'unknown', applied: true };
    await t.apply(ios, pause, iosHash);
    const keyLine = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDTOPSECRETKEYBODY';
    for (const table of [
      'audit_events',
      'events',
      'jobs',
      'webhook_deliveries',
      'store_rollout_claims',
    ]) {
      const text = JSON.stringify(await db.query(`SELECT * FROM ${table}`).catch(() => []));
      assert.ok(!text.includes(keyLine), `${table} has key material`);
      assert.ok(!text.includes('client_email'), `${table} has a credential`);
      assert.ok(!text.includes('keyId'), `${table} has a credential`);
    }
    for (const text of t.texts) {
      assert.ok(!text.includes(keyLine), text.slice(0, 200));
      assert.ok(!text.includes(ASC_SECRET), text.slice(0, 200));
    }
    // Every audit entry of this feature holds ids and values only.
    for (const entry of await t.audit()) {
      for (const value of Object.values(entry.detail))
        assert.ok(['string', 'number', 'boolean', 'object'].includes(typeof value));
      assert.equal(entry.detail.secret, undefined);
    }
    await db.execute(
      "INSERT INTO store_rollout_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at) VALUES (?, 'android', ?, 'halt', 'unknown', 'u', 1)",
      [appId, t.workspaceId],
    );
    assert.equal((await t.call(t.owner, 'DELETE', `/apps/${appId}`)).status, 204);
    assert.deepEqual(await t.claims(), [], 'the claim went with the app');
  },
);

// ----- the registry ---------------------------------------------------------------------------------------------

dbTest(
  'the API description lists the four rollout routes with their action and risk; only the write is destructive',
  async (db) => {
    const t = await bootRollout(db);
    const res = await t.app.request('/api/openapi.json', { headers: { cookie: t.owner } });
    assert.equal(res.status, 200);
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const w = '/api/workspaces/{workspaceId}';
    const at = (path: string, method: string) => doc.paths[`${w}${path}`]?.[method];
    assert.equal(at('/rollout/config', 'get')?.['x-mrm-action'], 'apps.read');
    for (const [path, method, risk] of [
      ['/apps/{id}/rollout/state', 'get', 'read'],
      ['/apps/{id}/rollout/preview', 'post', 'read'],
      ['/apps/{id}/rollout/apply', 'post', 'destructive'],
    ] as const) {
      assert.equal(at(path, method)?.['x-mrm-action'], 'releases.rollout', path);
      assert.equal(at(path, method)?.['x-mrm-risk'], risk, path);
    }
  },
);
