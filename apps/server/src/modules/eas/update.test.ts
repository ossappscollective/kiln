import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dbTest } from '@kiln/db/testing';
import { graphqlError } from '../../../../../packages/connectors/src/expo/expo.fixtures.ts';
import { build } from '../../../../../packages/connectors/src/expo/updates.fixtures.ts';
import { setPolicy } from '../../services/step-up.ts';
import { seedWorkspace } from '../../testkit.ts';
import { json } from './test-helpers.ts';
import {
  bootUpdates,
  EXPO_TOKEN,
  GROUP_A,
  GROUP_B,
  PROJECT_ID,
  type UpdatesBoot,
} from './update-test-helpers.ts';

const noToken = async (t: UpdatesBoot) => {
  for (const text of t.texts) assert.ok(!text.includes(EXPO_TOKEN), 'the Expo token leaked in a response');
  const rows = await t.db.query('SELECT * FROM audit_events');
  assert.ok(!JSON.stringify(rows).includes(EXPO_TOKEN), 'the Expo token leaked in the audit log');
};

/** The purposes of every use of the Expo credential, in order. */
const purposes = async (t: UpdatesBoot) =>
  (await t.auditActions())
    .filter((a) => a.action === 'credential.use' && a.targetId === t.expoCredentialId)
    .map((a) => JSON.parse(a.detail).purpose as string);

const MEMBER_ROLES = ['viewer', 'member'] as const;

// ---------------------------------------------------------------------------------------------
// Reads

dbTest('the state lists channels, the branch each points to, newest updates, rollouts and the runtime check', async (db) => {
  const t = await bootUpdates(db);
  const appId = await t.linkedApp('ios');
  const res = await t.stateOf(appId);
  assert.equal(res.status, 200, res.text);
  const { state } = res.body;
  assert.equal(state.project.id, PROJECT_ID);
  assert.equal(state.project.fullName, '@acme/trail-notes');
  assert.equal(state.platform, 'ios');
  assert.equal(state.rolloutWriteEnabled, false);
  assert.equal(state.channelsTruncated, false);
  assert.deepEqual(state.channels.map((c: { name: string }) => c.name), ['production', 'staging']);

  const production = state.channels[0];
  assert.equal(production.mapping.kind, 'branch');
  assert.equal(production.mapping.entries[0].branchName, 'main');
  assert.equal(production.branches[0].name, 'main');
  assert.equal(production.branches[0].mapped, true);
  const update = production.branches[0].groups[0].updates[0];
  assert.equal(update.platform, 'ios');
  assert.equal(update.runtimeVersion, '1.4.0');
  assert.equal(update.message, 'Fix the login button');
  assert.equal(update.gitCommitHash, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(production.runtimeCheck.status, 'ok');
  assert.deepEqual(production.rollouts, []);

  const staging = state.channels[1];
  assert.equal(staging.mapping.kind, 'rollout');
  assert.equal(staging.mapping.entries[0].condition, 'rolloutToken hash_lt 0.25');
  assert.equal(staging.mapping.entries[0].branchName, 'next');
  assert.equal(staging.rollouts.length, 1);
  assert.equal(staging.rollouts[0].percentage, 25);
  assert.equal(staging.rollouts[0].group, GROUP_B);
  assert.equal(staging.rollouts[0].branch, 'next');
  assert.equal(staging.runtimeCheck.status, 'no_builds', 'no store build names the staging channel');
  assert.equal(state.builds.length, 1);
  assert.equal(state.builds[0].channel, 'production');
  await noToken(t);
});

dbTest('a runtime version that no shipped binary has is reported as a mismatch, and the check is per platform', async (db) => {
  const t = await bootUpdates(db);
  t.fake.builds = [build({ runtime: { version: '1.3.0' } })];
  const ios = await t.linkedApp('ios');
  const found = (await t.stateOf(ios)).body.state.channels[0].runtimeCheck;
  assert.equal(found.status, 'mismatch');
  assert.equal(found.severity, 'error');
  assert.deepEqual(found.shippedRuntimeVersions, ['1.3.0']);
  assert.equal(found.latestUpdate.runtimeVersion, '1.4.0');
  assert.match(found.message, /1\.4\.0/);
  assert.match(found.message, /1\.3\.0/);

  // The Android record sees Android updates and builds only: its build (1.4.0) matches.
  t.fake.builds = [
    build({ runtime: { version: '1.3.0' } }),
    build({ id: 'dd000000-0000-4000-8000-0000000000a1', platform: 'ANDROID', runtime: { version: '1.4.0' } }),
  ];
  const android = await t.linkedApp('android');
  const state = (await t.stateOf(android)).body.state;
  assert.equal(state.platform, 'android');
  assert.equal(state.channels[0].runtimeCheck.status, 'ok');
  assert.equal(state.channels[0].branches[0].groups[0].updates[0].platform, 'android');
  assert.equal(t.fake.calls.find((c) => c.operationName === 'KilnStoreBuildRuntimes')?.variables.appId, PROJECT_ID);
});

dbTest('every use of the credential is audited with its purpose, and the token is sent as a bearer and nowhere else', async (db) => {
  const t = await bootUpdates(db);
  const appId = await t.linkedApp();
  await t.stateOf(appId);
  assert.ok(t.fake.calls.length >= 2);
  for (const call of t.fake.calls) assert.equal(call.authorization, `Bearer ${EXPO_TOKEN}`);
  const uses = (await t.auditActions()).filter((a) => a.action === 'credential.use' && a.targetId === t.expoCredentialId);
  assert.equal(uses.length, 1);
  assert.deepEqual(JSON.parse(uses[0]?.detail ?? '{}'), { purpose: 'eas.update' });
  await noToken(t);
});

dbTest('an app with no link, a deleted credential, an unsupported platform, an unknown app and a stranger are told apart', async (db) => {
  const t = await bootUpdates(db);
  const unlinked = await t.linkedApp('ios', false);
  const none = await t.stateOf(unlinked);
  assert.equal(none.status, 409);
  assert.equal(none.body.error, 'expo_not_linked');

  const mac = await t.linkedApp('macos');
  const unsupported = await t.stateOf(mac);
  assert.equal(unsupported.status, 422);
  assert.equal(unsupported.body.error, 'platform_unsupported');

  assert.equal((await t.stateOf('nope')).status, 404);

  const linked = await t.linkedApp('ios');
  await t.db.execute('DELETE FROM credentials WHERE id = ?', [t.expoCredentialId]);
  const gone = await t.stateOf(linked);
  assert.equal(gone.status, 422);
  assert.equal(gone.body.error, 'credential_not_found');
  assert.equal(t.fake.calls.length, 0, 'none of these reached Expo');
});

dbTest('a viewer can read; someone outside the workspace cannot tell the app exists', async (db) => {
  const t = await bootUpdates(db);
  const appId = await t.linkedApp();
  const viewer = await t.addMember('viewer');
  assert.equal((await t.stateOf(appId, viewer)).status, 200);
  const other = await seedWorkspace(db, 'Other', 'other@example.com', Date.now());
  assert.equal((await t.stateOf(appId, other.cookie)).status, 404);
});

dbTest("Expo's refusals become fixed sentences and codes, never Expo's own text", async (db) => {
  const t = await bootUpdates(db);
  const appId = await t.linkedApp();
  t.fake.next = [json(graphqlError('Entity not authorized: secret detail'), 200)];
  const forbidden = await t.stateOf(appId);
  assert.equal(forbidden.status, 422);
  assert.equal(forbidden.body.error, 'expo_forbidden');
  assert.ok(!forbidden.text.includes('secret detail'));

  t.fake.next = [json({}, 429, { 'retry-after': '7' })];
  const slow = await t.stateOf(appId);
  assert.equal(slow.status, 429);
  assert.equal(slow.body.error, 'rate_limited');
  assert.equal(slow.headers.get('retry-after'), '7');

  t.fake.next = [json({}, 503)];
  assert.equal((await t.stateOf(appId)).status, 502);

  t.fake.next = [json({ data: { app: { byId: null } } })];
  const missing = await t.stateOf(appId);
  assert.equal(missing.status, 422);
  assert.equal(missing.body.error, 'expo_not_found');
  await noToken(t);
});

dbTest('insights: launches, failed launches, crash rate, unique users and payload size of this platform', async (db) => {
  const t = await bootUpdates(db);
  const appId = await t.linkedApp('android');
  const res = await t.call(t.owner, 'GET', `/apps/${appId}/expo/updates/${GROUP_A}/insights?days=14`);
  assert.equal(res.status, 200, res.text);
  const { insights } = res.body;
  assert.equal(insights.platform, 'android');
  assert.equal(insights.days, 14);
  assert.equal(insights.end - insights.start, 14 * 24 * 3600_000);
  assert.equal(insights.insights.platform, 'android');
  assert.equal(insights.insights.launches, 380);
  assert.equal(insights.insights.failedLaunches, 20);
  assert.equal(insights.insights.crashRatePercent, 5);
  assert.equal(insights.insights.uniqueUsers, 121);
  assert.equal(insights.insights.averagePayloadBytes, 482_113);
  const sent = t.fake.calls.find((c) => c.operationName === 'KilnUpdateGroupInsights');
  assert.equal(sent?.variables.groupId, GROUP_A);
  assert.deepEqual(await purposes(t), ['eas.update_insights']);
});

dbTest('insights: bad days and a bad group are refused before Expo is asked; a group without this platform is not found', async (db) => {
  const t = await bootUpdates(db);
  const appId = await t.linkedApp('ios');
  for (const days of ['0', '31', 'x', '1.5', '-1']) {
    const res = await t.call(t.owner, 'GET', `/apps/${appId}/expo/updates/${GROUP_A}/insights?days=${days}`);
    assert.equal(res.status, 422, days);
    assert.equal(res.body.error, 'invalid_days');
  }
  const bad = await t.call(t.owner, 'GET', `/apps/${appId}/expo/updates/not-a-group/insights`);
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error, 'invalid_group');
  assert.equal(t.fake.calls.length, 0);
  const standard = await t.call(t.owner, 'GET', `/apps/${appId}/expo/updates/${GROUP_A}/insights`);
  assert.equal(standard.status, 200);
  assert.equal(standard.body.insights.days, 7);

  t.fake.insights = { data: { updatesByGroup: [{ id: 'u', platform: 'android', insights: {} }] } };
  const other = await t.call(t.owner, 'GET', `/apps/${appId}/expo/updates/${GROUP_B}/insights`);
  assert.equal(other.status, 422);
  assert.equal(other.body.error, 'expo_not_found');
});

// ---------------------------------------------------------------------------------------------
// The write: raising a rollout

const pct = (appId: string, group: string, percentage: number) => ({ group, percentage });

dbTest('off by default: preview and apply answer 409 and Expo is never asked', async (db) => {
  const t = await bootUpdates(db);
  const appId = await t.linkedApp();
  const preview = await t.preview(appId, pct(appId, GROUP_B, 50));
  assert.equal(preview.status, 409);
  assert.equal(preview.body.error, 'eas_update_write_disabled');
  const apply = await t.apply(appId, { ...pct(appId, GROUP_B, 50), confirmHash: 'a'.repeat(64) });
  assert.equal(apply.status, 409);
  assert.equal(apply.body.error, 'eas_update_write_disabled');
  assert.equal(t.fake.calls.length, 0);
  // Reading does not depend on the switch and says it is off.
  assert.equal((await t.stateOf(appId)).body.state.rolloutWriteEnabled, false);
});

dbTest('preview then apply raises the share once, is audited with ids and values, and the next read shows it', async (db) => {
  const t = await bootUpdates(db, { rolloutEnabled: true });
  const appId = await t.linkedApp('ios');
  const preview = await t.preview(appId, pct(appId, GROUP_B, 60));
  assert.equal(preview.status, 200, preview.text);
  const p = preview.body.preview;
  assert.equal(p.from, 25);
  assert.equal(p.to, 60);
  assert.equal(p.channel, 'staging');
  assert.equal(p.branch, 'next');
  assert.equal(p.irreversible, false);
  assert.match(p.confirmHash, /^[0-9a-f]{64}$/);
  assert.equal(t.fake.count('KilnSetUpdateRollout'), 0, 'a preview writes nothing');

  const done = await t.apply(appId, { ...pct(appId, GROUP_B, 60), confirmHash: p.confirmHash });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual({ ...done.body.result, app: undefined }, {
    app: undefined,
    group: GROUP_B,
    updateId: p.updateId,
    from: 25,
    to: 60,
    confirmedByReread: false,
  });
  assert.equal(t.fake.count('KilnSetUpdateRollout'), 1);
  const sent = t.fake.calls.find((c) => c.operationName === 'KilnSetUpdateRollout');
  assert.deepEqual(sent?.variables, { updateId: p.updateId, rolloutPercentage: 60 });

  const changed = (await t.auditActions()).filter((a) => a.action === 'eas.update_rollout_changed');
  assert.equal(changed.length, 1);
  assert.equal(changed[0]?.targetId, appId);
  const detail = JSON.parse(changed[0]?.detail ?? '{}');
  assert.equal(detail.from, 25);
  assert.equal(detail.to, 60);
  assert.equal(detail.updateId, p.updateId);
  assert.equal(detail.hash, p.confirmHash);
  assert.equal(detail.projectId, PROJECT_ID);
  assert.deepEqual(await purposes(t), ['eas.update_rollout', 'eas.update_rollout'], 'the preview and the apply each read with the credential');
  assert.equal((await t.stateOf(appId)).body.state.channels[1].rollouts[0].percentage, 60);
  await noToken(t);
});

dbTest('a preview is bound to the state that was read: a rollout that moved since is refused and nothing is written', async (db) => {
  const t = await bootUpdates(db, { rolloutEnabled: true });
  const appId = await t.linkedApp();
  const p = (await t.preview(appId, pct(appId, GROUP_B, 60))).body.preview;
  // Somebody raised it at Expo meanwhile.
  for (const u of t.fake.nextGroup()) u.rolloutPercentage = 40;
  const stale = await t.apply(appId, { ...pct(appId, GROUP_B, 60), confirmHash: p.confirmHash });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'state_changed');
  assert.deepEqual(stale.body.current, { from: 40, to: 60 });
  assert.notEqual(stale.body.confirmHash, p.confirmHash);
  assert.equal(t.fake.count('KilnSetUpdateRollout'), 0);

  // A different target with the same hash does not pass either.
  const other = await t.apply(appId, { ...pct(appId, GROUP_B, 70), confirmHash: stale.body.confirmHash });
  assert.equal(other.status, 409);
  assert.equal(t.fake.count('KilnSetUpdateRollout'), 0);

  // The rollout finished meanwhile: not what was previewed either.
  for (const u of t.fake.nextGroup()) u.rolloutPercentage = null;
  const gone = await t.apply(appId, { ...pct(appId, GROUP_B, 60), confirmHash: p.confirmHash });
  assert.equal(gone.status, 409);
  assert.equal(gone.body.error, 'state_changed');
  assert.equal(t.fake.count('KilnSetUpdateRollout'), 0);
});

dbTest('the share only goes up, only a rollout that exists can be raised, and the request is checked', async (db) => {
  const t = await bootUpdates(db, { rolloutEnabled: true });
  const appId = await t.linkedApp();
  for (const to of [25, 10]) {
    const res = await t.preview(appId, pct(appId, GROUP_B, to));
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'rollout_not_raised');
    assert.equal(res.body.current, 25);
  }
  const notRollout = await t.preview(appId, pct(appId, GROUP_A, 50));
  assert.equal(notRollout.status, 409);
  assert.equal(notRollout.body.error, 'rollout_not_found');
  const unknown = await t.preview(appId, pct(appId, '11111111-2222-4333-8444-555555555555', 50));
  assert.equal(unknown.body.error, 'rollout_not_found');
  for (const body of [
    { group: GROUP_B, percentage: 0 },
    { group: GROUP_B, percentage: 101 },
    { group: GROUP_B, percentage: 50.5 },
    { group: 'nope', percentage: 50 },
    { group: GROUP_B },
    { group: GROUP_B, percentage: 50, extra: true },
  ]) {
    assert.equal((await t.preview(appId, body)).status, 400, JSON.stringify(body));
  }
  assert.equal(t.fake.count('KilnSetUpdateRollout'), 0);
});

dbTest('100 ends the rollout and is marked irreversible, in the preview and in the audit', async (db) => {
  const t = await bootUpdates(db, { rolloutEnabled: true });
  t.fake.builds = [build({ runtime: { version: '1.5.0' }, updateChannel: { name: 'staging' } })];
  const appId = await t.linkedApp();
  const p = (await t.preview(appId, pct(appId, GROUP_B, 100))).body.preview;
  assert.equal(p.irreversible, true);
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /100%/);
  const done = await t.apply(appId, { ...pct(appId, GROUP_B, 100), confirmHash: p.confirmHash });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.result.to, 100);
  const detail = JSON.parse((await t.auditActions()).find((a) => a.action === 'eas.update_rollout_changed')?.detail ?? '{}');
  assert.equal(detail.irreversible, true);

});

dbTest('a rollout whose runtime version no shipped binary has carries the mismatch as a warning', async (db) => {
  const t = await bootUpdates(db, { rolloutEnabled: true });
  t.fake.builds = [build({ runtime: { version: '1.3.0' }, updateChannel: { name: 'staging' } })];
  const appId = await t.linkedApp();
  const p = (await t.preview(appId, pct(appId, GROUP_B, 50))).body.preview;
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /reach no shipped binary/);
});

dbTest('only owners and admins may preview or apply; a viewer and a member get 403 and Expo is not asked', async (db) => {
  const t = await bootUpdates(db, { rolloutEnabled: true });
  const appId = await t.linkedApp();
  for (const role of MEMBER_ROLES) {
    const cookie = await t.addMember(role);
    assert.equal((await t.preview(appId, pct(appId, GROUP_B, 50), cookie)).status, 403, role);
    assert.equal((await t.apply(appId, { ...pct(appId, GROUP_B, 50), confirmHash: 'a'.repeat(64) }, cookie)).status, 403, role);
  }
  const admin = await t.addMember('admin');
  assert.equal((await t.preview(appId, pct(appId, GROUP_B, 50), admin)).status, 200);
  assert.equal(t.fake.count('KilnSetUpdateRollout'), 0);
});

dbTest('when the workspace policy covers rollout, apply needs a step-up grant bound to the app and the hash; preview stays free', async (db) => {
  const t = await bootUpdates(db, { rolloutEnabled: true });
  const appId = await t.linkedApp();
  await setPolicy(
    db,
    { workspaceId: t.workspaceId, policy: { mode: 'hard_actions', actions: ['rollout'], unattended: [] }, userId: 'u' },
    Date.now(),
  );
  const p = (await t.preview(appId, pct(appId, GROUP_B, 60))).body.preview;
  const body = { ...pct(appId, GROUP_B, 60), confirmHash: p.confirmHash };
  const missing = await t.apply(appId, body);
  assert.equal(missing.status, 403);
  assert.equal(missing.body.error, 'step_up_required');
  assert.equal(t.fake.count('KilnSetUpdateRollout'), 0);

  const wrongHash = await t.grantFor(appId, 'b'.repeat(64));
  const refused = await t.apply(appId, body, t.owner, { 'x-step-up-grant': wrongHash });
  assert.equal(refused.status, 403);
  assert.equal(t.fake.count('KilnSetUpdateRollout'), 0);

  const grant = await t.grantFor(appId, p.confirmHash);
  const done = await t.apply(appId, body, t.owner, { 'x-step-up-grant': grant });
  assert.equal(done.status, 200, done.text);
  assert.equal(t.fake.count('KilnSetUpdateRollout'), 1);
  // A grant is spent by its first use.
  const again = await t.apply(appId, body, t.owner, { 'x-step-up-grant': grant });
  assert.equal(again.status, 403);
  assert.equal(t.fake.count('KilnSetUpdateRollout'), 1);
});

dbTest('a refusal by Expo before the write is audited as not applied and never retried', async (db) => {
  const t = await bootUpdates(db, { rolloutEnabled: true });
  const appId = await t.linkedApp();
  const p = (await t.preview(appId, pct(appId, GROUP_B, 60))).body.preview;
  t.fake.intercept = (call) =>
    call.operationName === 'KilnSetUpdateRollout' ? json(graphqlError('Entity not authorized: nope')) : undefined;
  // The reads of the apply are answered normally; the write is refused.
  const res = await t.apply(appId, { ...pct(appId, GROUP_B, 60), confirmHash: p.confirmHash });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'expo_forbidden');
  assert.ok(!res.text.includes('nope'));
  assert.equal(t.fake.count('KilnSetUpdateRollout'), 1);
  const failed = (await t.auditActions()).filter((a) => a.action === 'eas.update_rollout_failed');
  assert.equal(failed.length, 1);
  assert.equal(JSON.parse(failed[0]?.detail ?? '{}').outcome, 'not_applied');
  assert.equal((await t.auditActions()).filter((a) => a.action === 'eas.update_rollout_changed').length, 0);
});

/** Raises the share of the staging rollout while the answer of the write is lost; `readBack` says whether the read afterwards works. */
async function lostWrite(t: UpdatesBoot, mode: 'apply' | 'ignore', readBack: boolean) {
  const appId = await t.linkedApp();
  const p = (await t.preview(appId, pct(appId, GROUP_B, 60))).body.preview;
  t.fake.mutation = mode;
  let seenWrite = false;
  t.fake.intercept = (call) => {
    if (call.operationName === 'KilnSetUpdateRollout') {
      seenWrite = true;
      return new Error('socket closed');
    }
    return seenWrite && !readBack ? new Error('socket closed') : undefined;
  };
  return t.apply(appId, { ...pct(appId, GROUP_B, 60), confirmHash: p.confirmHash });
}

dbTest('when the answer of the write is lost and the read back shows the new share, it is a success, and the write is not retried', async (db) => {
  const t = await bootUpdates(db, { rolloutEnabled: true });
  const res = await lostWrite(t, 'apply', true);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.result.confirmedByReread, true);
  assert.equal(t.fake.count('KilnSetUpdateRollout'), 1, 'never retried');
  const changed = (await t.auditActions()).filter((a) => a.action === 'eas.update_rollout_changed');
  assert.equal(JSON.parse(changed[0]?.detail ?? '{}').via, 'reread');
});

dbTest('when the answer of the write is lost and the read back shows the old share, the write failed and nothing changed', async (db) => {
  const t = await bootUpdates(db, { rolloutEnabled: true });
  const res = await lostWrite(t, 'ignore', true);
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'write_failed');
  assert.equal(res.body.outcome, 'not_applied');
  assert.equal(t.fake.count('KilnSetUpdateRollout'), 1);
  assert.equal((await t.auditActions()).filter((a) => a.action === 'eas.update_rollout_failed').length, 1);
});

dbTest('when the answer is lost and the read back fails too, the outcome is unknown and the audit says so', async (db) => {
  const t = await bootUpdates(db, { rolloutEnabled: true });
  const res = await lostWrite(t, 'apply', false);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'outcome_unknown');
  const failed = (await t.auditActions()).filter((a) => a.action === 'eas.update_rollout_failed');
  assert.equal(JSON.parse(failed[0]?.detail ?? '{}').outcome, 'unknown');
});

dbTest('there is no route that publishes, rolls back or changes the branch of a channel', async (db) => {
  const t = await bootUpdates(db, { rolloutEnabled: true });
  const appId = await t.linkedApp();
  for (const [method, path] of [
    ['POST', `/apps/${appId}/expo/updates`],
    ['POST', `/apps/${appId}/expo/updates/rollback`],
    ['PUT', `/apps/${appId}/expo/channels/production`],
    ['DELETE', `/apps/${appId}/expo/updates/${GROUP_A}`],
  ] as const) {
    const res = await t.call(t.owner, method, path, {});
    assert.ok(res.status === 404 || res.status === 405, `${method} ${path} -> ${res.status}`);
  }
  assert.equal(t.fake.calls.length, 0);
});

test('the API description lists the four operations with the right risk, action and switch', async () => {
  const { operations } = await import('../../operations/registry.ts');
  const byId = new Map(operations.map((o) => [o.id, o]));
  const read = byId.get('getExpoUpdates');
  assert.equal(read?.risk, 'read');
  assert.deepEqual(read?.access, { action: 'apps.read' });
  assert.equal(byId.get('getExpoUpdateInsights')?.risk, 'read');
  assert.equal(byId.get('previewExpoUpdateRollout')?.risk, 'read');
  const apply = byId.get('applyExpoUpdateRollout');
  assert.equal(apply?.risk, 'destructive');
  assert.deepEqual(apply?.access, { action: 'releases.rollout' });
  assert.match(apply?.description ?? '', /KILN_EAS_UPDATE_ROLLOUT_ENABLED/);
});
