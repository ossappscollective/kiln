import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppStoreConnectConnector } from './appstoreconnect.ts';
import { StoreError } from './errors.ts';
import * as fx from './store.fixtures.ts';

const key = fx.appleKeyPem();

function setup() {
  const fake = new fx.FakeFetch();
  const connector = new AppStoreConnectConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
    fetch: fake.fetch,
    now: () => Date.UTC(2026, 10, 18, 12, 0, 0),
    sleep: async () => undefined,
  });
  return { fake, connector };
}

const group = (id: string, attributes: Record<string, unknown>) => ({ type: 'betaGroups', id, attributes });

test('listTestFlightGroups: public link, limit and builds are read with GET only; internal groups and groups without a link read no builds', async () => {
  const { fake, connector } = setup();
  fake.on({
    method: 'GET',
    match: /^\/v1\/betaGroups\?filter\[app\]=77&filter\[isInternalGroup\]=false/,
    json: {
      data: [
        group('g1', { name: 'Beta', isInternalGroup: false, publicLinkEnabled: true, publicLink: 'https://testflight.apple.com/join/AbC', publicLinkLimitEnabled: true, publicLinkLimit: 250 }),
        group('g2', { name: 'Off', isInternalGroup: false, publicLinkEnabled: false, publicLink: 'https://testflight.apple.com/join/Off', publicLinkLimitEnabled: false, publicLinkLimit: 10000 }),
        group('g3', { name: 'Invite', isInternalGroup: false, publicLinkEnabled: false, publicLink: null }),
        group('g4', { name: 'Staff', isInternalGroup: true, publicLinkEnabled: false }),
      ],
    },
  });
  fake.on({ method: 'GET', match: /^\/v1\/betaGroups\/g1\/builds\?fields\[builds\]=version/, json: { data: [{ type: 'builds', id: 'b1', attributes: { version: '240' } }, { type: 'builds', id: 'b0', attributes: { version: '239' } }] } });
  fake.on({ method: 'GET', match: /^\/v1\/betaGroups\/g2\/builds\?/, json: { data: [] } });
  const groups = await connector.listTestFlightGroups('77');
  assert.deepEqual(groups.map((g) => [g.id, g.publicLink, g.publicLinkEnabled, g.publicLinkLimit, g.buildNumbers]), [
    ['g1', 'https://testflight.apple.com/join/AbC', true, 250, ['240', '239']],
    ['g2', 'https://testflight.apple.com/join/Off', false, null, []],
    ['g3', null, false, null, []],
  ]);
  assert.deepEqual(fake.unexpected, []);
  assert.ok(fake.calls.every((c) => c.method === 'GET'), 'read only');
  assert.equal(fake.calls.length, 3, 'no builds read for the group without a link');
});

test('listTestFlightGroups: a parameter error on the filter falls back to the app list and drops internal groups; 403 stays a forbidden error', async () => {
  const { fake, connector } = setup();
  fake.on({ method: 'GET', match: /^\/v1\/betaGroups\?filter/, status: 400, json: { errors: [{ status: '400', code: 'PARAMETER_ERROR.INVALID', title: 'bad', detail: 'x', source: { parameter: 'filter[isInternalGroup]' } }] } });
  fake.on({ method: 'GET', match: /^\/v1\/apps\/77\/betaGroups\?/, json: { data: [group('a', { name: 'In', isInternalGroup: true }), group('b', { name: 'Ext', isInternalGroup: false })] } });
  assert.deepEqual((await connector.listTestFlightGroups('77')).map((g) => g.id), ['b']);

  const denied = setup();
  denied.fake.on({ method: 'GET', match: /^\/v1\/betaGroups\?/, status: 403, json: { errors: [{ status: '403', code: 'FORBIDDEN_ERROR', title: 'x', detail: 'y' }] } });
  await assert.rejects(denied.connector.listTestFlightGroups('77'), (e: unknown) => e instanceof StoreError && e.kind === 'forbidden' && e.status === 403);
});
