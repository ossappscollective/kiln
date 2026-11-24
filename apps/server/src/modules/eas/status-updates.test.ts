import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import {
  buildsBody,
  easBuild,
  easSubmission,
  submissionsBody,
} from '../../../../../packages/connectors/src/expo/eas-status.fixtures.ts';
import { GROUP_A } from '../../../../../packages/connectors/src/expo/updates.fixtures.ts';
import { bootEas, json, PROJECT_ID } from './test-helpers.ts';
import { defaultChannels } from './update-test-helpers.ts';

type Any = Record<string, any>; // biome-ignore lint/suspicious/noExplicitAny: fixture bodies are shaped loosely

/** A fake Expo for the status read: builds, submissions and the update channels. */
async function boot(db: Parameters<typeof bootEas>[0]) {
  const state = { channels: defaultChannels() as Any[], updatesFail: false, calls: [] as string[] };
  let late: typeof fetch = async () => new Response('{}');
  const t = await bootEas(db, { eas: { fetch: (input, init) => late(input, init) } });
  late = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { operationName?: string };
    state.calls.push(body.operationName ?? '');
    if (body.operationName === 'KilnEasBuilds') return json(buildsBody([easBuild()]));
    if (body.operationName === 'KilnEasSubmissions')
      return json(submissionsBody([easSubmission()]));
    if (body.operationName === 'KilnUpdateChannels') {
      if (state.updatesFail) return json({ errors: [{ message: 'boom SECRET-EXPO-TEXT' }] });
      return json({ data: { app: { byId: { id: PROJECT_ID, updateChannels: state.channels } } } });
    }
    return t.expo.fetch(input, init);
  };
  const appId = await t.seedApp();
  assert.equal(
    (await t.put(appId, { credentialId: t.expoCredentialId, project: PROJECT_ID })).status,
    200,
  );
  const refresh = async () => {
    const res = await t.call(t.owner, 'POST', `/apps/${appId}/eas/status/refresh`);
    assert.equal(res.status, 200, res.text);
    return res.body.status as Any;
  };
  const events = async () =>
    (
      await db.query(
        "SELECT payload FROM events WHERE type = 'eas.update_rollout_stuck' ORDER BY id",
      )
    ).map((r) => JSON.parse(String(r.payload)) as Any);
  return { t, state, appId, refresh, events };
}

dbTest(
  'a read stores the current update per channel and the rollouts; the view reads the database only',
  async (db) => {
    const { t, state, appId, refresh } = await boot(db);
    const empty = await t.call(t.owner, 'GET', `/apps/${appId}/eas/status`);
    assert.deepEqual(empty.body.status.updates, { readAt: null, lastError: null, channels: [] });

    const status = await refresh();
    assert.equal(state.calls.filter((c) => c === 'KilnUpdateChannels').length, 1);
    const byChannel = Object.fromEntries(
      (status.updates.channels as Any[]).map((c) => [c.channel, c]),
    );
    const production = byChannel.production.current;
    assert.equal(production.group, GROUP_A);
    assert.equal(production.platform, 'ios');
    assert.equal(production.runtimeVersion, '1.4.0');
    assert.equal(production.message, 'Fix the login button');
    assert.equal(production.rolloutPercentage, null);
    assert.match(
      production.expoUrl,
      /^https:\/\/expo\.dev\/accounts\/acme\/projects\/trail-notes\/updates\//,
    );
    const staging = byChannel.staging.current;
    assert.equal(staging.branch, 'next');
    assert.equal(staging.rolloutPercentage, 25);
    assert.equal(staging.runtimeVersion, '1.5.0');
    assert.equal(typeof status.updates.readAt, 'number');
    assert.equal(status.updates.lastError, null);

    const calls = state.calls.length;
    const again = await t.call(t.owner, 'GET', `/apps/${appId}/eas/status`);
    assert.equal(state.calls.length, calls, 'listing never calls Expo');
    assert.equal(again.body.status.updates.channels.length, 2);
  },
);

dbTest(
  'a failing updates read keeps the stored updates and says so with a short code, never Expo text',
  async (db) => {
    const { state, refresh } = await boot(db);
    const first = await refresh();
    state.updatesFail = true;
    const second = await refresh();
    assert.equal(
      second.updates.channels.length,
      first.updates.channels.length,
      'the old updates stay',
    );
    assert.equal(second.updates.readAt, first.updates.readAt);
    assert.equal(typeof second.updates.lastError, 'string');
    assert.ok(!JSON.stringify(second).includes('SECRET-EXPO-TEXT'));
    assert.equal(second.sync.lastError, null, 'the builds read itself worked');
  },
);

dbTest(
  'a rollout unchanged for longer than the threshold raises one event per update, with ids only',
  async (db) => {
    const { t, appId, refresh, events, state } = await boot(db);
    await refresh();
    assert.deepEqual(await events(), [], 'a first sight starts the clock');
    await db.execute(
      'UPDATE eas_updates SET rollout_since = rollout_since - ? WHERE rollout_percentage IS NOT NULL',
      [47 * 3_600_000],
    );
    await refresh();
    assert.deepEqual(await events(), [], '47 hours is below the default of 48');
    await db.execute(
      'UPDATE eas_updates SET rollout_since = rollout_since - ? WHERE rollout_percentage IS NOT NULL',
      [2 * 3_600_000],
    );
    await refresh();
    const [event, ...rest] = await events();
    assert.equal(rest.length, 0);
    assert.equal(event?.platform, 'ios');
    assert.equal(event?.channel, 'staging');
    assert.equal(event?.percentage, 25);
    assert.equal(typeof event?.group, 'string');
    assert.ok(
      !JSON.stringify(event).includes('Fix the login button'),
      'the update message is never in the event',
    );
    await refresh();
    assert.equal((await events()).length, 1, 'once per update');

    // A changed percentage restarts the clock, and an ended rollout is not stuck.
    const next = (state.channels[1] as Any).updateBranches[0].updateGroups[0] as Any[];
    for (const u of next) u.rolloutPercentage = 50;
    await refresh();
    const row = (
      await db.query(
        'SELECT rollout_percentage, rollout_since FROM eas_updates WHERE rollout_percentage IS NOT NULL',
      )
    )[0];
    assert.equal(Number(row?.rollout_percentage), 50);
    assert.ok(Date.now() - Number(row?.rollout_since) < 60_000, 'a new percentage starts again');
    for (const u of next) u.rolloutPercentage = null;
    await refresh();
    assert.equal(
      (await db.query('SELECT 1 FROM eas_updates WHERE rollout_percentage IS NOT NULL')).length,
      0,
    );
    const view = await t.call(t.owner, 'GET', `/apps/${appId}/eas/status`);
    assert.equal(
      view.body.status.updates.channels.find((c: Any) => c.channel === 'staging').current
        .rolloutPercentage,
      null,
    );
  },
);

dbTest('the threshold follows the alert rule of the workspace', async (db) => {
  const { t, refresh, events } = await boot(db);
  const put = await t.call(t.owner, 'PUT', '/alerts/rules/eas.update_rollout_stuck', {
    params: { hours: 2 },
  });
  assert.equal(put.status, 200, put.text);
  await refresh();
  await db.execute(
    'UPDATE eas_updates SET rollout_since = rollout_since - ? WHERE rollout_percentage IS NOT NULL',
    [3 * 3_600_000],
  );
  await refresh();
  assert.equal((await events()).length, 1);
});

dbTest('removing the link deletes the stored updates', async (db) => {
  const { t, appId, refresh } = await boot(db);
  await refresh();
  assert.ok((await db.query('SELECT 1 FROM eas_updates')).length > 0);
  assert.equal((await t.call(t.owner, 'DELETE', `/apps/${appId}/expo`)).status, 204);
  assert.equal((await db.query('SELECT 1 FROM eas_updates')).length, 0);
});
