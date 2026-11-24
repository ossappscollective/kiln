import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoreError } from '../errors.ts';
import * as ex from '../store-experiments.fixtures.ts';
import {
  appleExperimentState,
  currentCustomPageVersion,
  type StoreCustomPageVersion,
} from '../store-experiments-types.ts';
import * as fx from '../store.fixtures.ts';
import { AppleExperimentsConnector, assetCounts, linkedIds } from './appstore-experiments.ts';

const key = fx.appleKeyPem();

function connector(fake: fx.FakeFetch, extra: Record<string, unknown> = {}) {
  return new AppleExperimentsConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
    appStoreId: ex.APP,
    fetch: fake.fetch,
    now: () => ex.T0,
    sleep: async () => undefined,
    ...extra,
  });
}

test('states are mapped; an unknown one is kept as unknown', () => {
  assert.equal(appleExperimentState('PREPARE_FOR_SUBMISSION'), 'draft');
  assert.equal(appleExperimentState('READY_FOR_REVIEW'), 'in_review');
  assert.equal(appleExperimentState('WAITING_FOR_REVIEW'), 'in_review');
  assert.equal(appleExperimentState('IN_REVIEW'), 'in_review');
  assert.equal(appleExperimentState('ACCEPTED'), 'approved');
  assert.equal(appleExperimentState('APPROVED'), 'approved');
  assert.equal(appleExperimentState('REJECTED'), 'rejected');
  assert.equal(appleExperimentState('COMPLETED'), 'completed');
  assert.equal(appleExperimentState('STOPPED'), 'stopped');
  assert.equal(appleExperimentState('REPLACED_WITH_NEW_VERSION'), 'replaced');
  assert.equal(appleExperimentState('RUNNING'), 'unknown');
  assert.equal(appleExperimentState(undefined), 'unknown');
});

test('the version that counts: work in progress, then approved, never a replaced one first', () => {
  const v = (id: string, state: StoreCustomPageVersion['state']): StoreCustomPageVersion => ({
    id,
    version: null,
    state,
    rawState: null,
    deepLink: null,
  });
  assert.equal(currentCustomPageVersion([]), null);
  assert.equal(currentCustomPageVersion([v('a', 'replaced'), v('b', 'approved')])?.id, 'b');
  assert.equal(currentCustomPageVersion([v('a', 'approved'), v('b', 'in_review')])?.id, 'b');
  assert.equal(currentCustomPageVersion([v('a', 'replaced'), v('b', 'unknown')])?.id, 'b');
});

test('linkedIds reads a to-many and a to-one linkage and says when there is none', () => {
  assert.deepEqual(linkedIds({ relationships: { x: { data: [{ id: 'a' }, { id: 'b' }] } } }, 'x'), [
    'a',
    'b',
  ]);
  assert.deepEqual(linkedIds({ relationships: { x: { data: { id: 'a' } } } }, 'x'), ['a']);
  assert.deepEqual(linkedIds({ relationships: { x: { data: null } } }, 'x'), []);
  assert.equal(linkedIds({ relationships: { x: { links: {} } } }, 'x'), undefined);
  assert.equal(linkedIds({}, 'x'), undefined);
});

test('assetCounts sorts placements by type and tolerates unknown ones', () => {
  const byId = new Map<string, Record<string, unknown>>([
    ['a', ex.placement('a', 'APP_SCREENSHOT')],
    ['b', ex.placement('b', 'app_preview')],
    ['c', { id: 'c', attributes: { placementType: 'SOMETHING_NEW', extra: 1 } }],
  ]);
  const loc = ex.localization('l', 'l', 'en-US', ['a', 'b', 'c', 'missing'], {}, ['s1', 's2']);
  assert.deepEqual(assetCounts(loc, byId), {
    screenshots: 1,
    previews: 1,
    other: 2,
    screenshotSets: 2,
  });
});

test('listExperiments reads tests with treatments and media, and custom pages with versions and locales', async () => {
  const fake = ex.experimentsFake();
  const result = await connector(fake).listExperiments();
  assert.deepEqual(fake.unexpected, []);
  assert.equal(result.complete, true);
  assert.equal(result.experimentsRead && result.customPagesRead, true);
  // The Mac experiment is not an iOS record's.
  assert.deepEqual(
    result.experiments.map((e) => e.id),
    ['e1'],
  );
  const [e] = result.experiments;
  assert.equal(e?.state, 'approved');
  assert.equal(e?.rawState, 'APPROVED');
  assert.equal(e?.trafficProportion, 30);
  assert.equal(e?.reviewRequired, true);
  assert.equal(e?.startedAt, Date.UTC(2026, 9, 1, 8));
  assert.equal(e?.endedAt, null);
  assert.deepEqual(
    e?.treatments.map((t) => t.name),
    ['Blue icon', 'Screenshots v2'],
  );
  assert.equal(e?.treatments[0]?.iconName, 'blue');
  assert.equal(e?.treatments[1]?.promotedAt, Date.UTC(2026, 9, 20));
  assert.deepEqual(e?.treatments[0]?.locales[0]?.assets, {
    screenshots: 2,
    previews: 1,
    other: 0,
    screenshotSets: 0,
  });
  assert.deepEqual(
    e?.treatments[1]?.locales.map((l) => l.locale),
    ['de-DE', 'fr-FR'],
  );
  assert.equal(e?.treatments[1]?.locales[1]?.assets.screenshotSets, 1);
  assert.equal(e?.treatments[0]?.locales[0]?.hasPromotionalText, null);

  assert.deepEqual(
    result.customPages.map((p) => p.id),
    ['c1', 'c2'],
  );
  const [c1, c2] = result.customPages;
  assert.equal(c1?.state, 'approved');
  assert.equal(c1?.deepLink, 'myapp://spring');
  assert.equal(c1?.visible, true);
  assert.match(c1?.url ?? '', /ppid=c1$/);
  assert.equal(c1?.versions.length, 2);
  assert.deepEqual(
    c1?.locales.map((l) => [l.locale, l.assets.screenshots, l.hasPromotionalText]),
    [
      ['en-US', 2, true],
      ['fr-FR', 1, false],
    ],
  );
  assert.equal(c2?.state, 'unknown');
  assert.deepEqual(c2?.locales, []);
  assert.equal(c2?.visible, false);
});

test('a Mac record keeps the Mac experiments and reads no custom pages', async () => {
  const fake = ex.experimentsFake();
  const result = await connector(fake, { scope: 'macos' }).listExperiments();
  assert.deepEqual(
    result.experiments.map((e) => e.id),
    ['e2'],
  );
  assert.equal(result.experiments[0]?.state, 'stopped');
  assert.deepEqual(result.customPages, []);
  assert.ok(!fake.calls.some((c) => c.url.pathname.includes('appCustomProductPages')));
});

test('without linkage in the list the treatments and versions are read from their own endpoints', async () => {
  const fake = new fx.FakeFetch()
    .on({
      method: 'GET',
      match: ex.EXPERIMENTS,
      json: { data: [ex.experiment('e1', {}, undefined)] },
    })
    .on({
      method: 'GET',
      match: '/v2/appStoreVersionExperiments/e1/appStoreVersionExperimentTreatments?limit=50',
      json: { data: [ex.treatment('t1', 'Only one'), { type: 'x' }] },
    })
    .on({
      method: 'GET',
      match:
        /^\/v1\/appStoreVersionExperimentTreatments\/t1\/appStoreVersionExperimentTreatmentLocalizations\?/,
      status: 404,
      json: { errors: [{ status: '404', code: 'NOT_FOUND', title: 'Not found' }] },
    })
    .on({ method: 'GET', match: ex.PAGES, json: { data: [ex.page('c1', {}, undefined)] } })
    .on({
      method: 'GET',
      match: '/v1/appCustomProductPages/c1/appCustomProductPageVersions?limit=50',
      json: { data: [ex.pageVersion('v1', 'IN_REVIEW')] },
    })
    .on({
      method: 'GET',
      match: /^\/v1\/appCustomProductPageVersions\/v1\/appCustomProductPageLocalizations\?/,
      json: { data: [], meta: { paging: { total: 0 } }, someNewField: true },
    });
  const result = await connector(fake).listExperiments();
  assert.deepEqual(fake.unexpected, []);
  assert.deepEqual(
    result.experiments[0]?.treatments.map((t) => [t.name, t.locales.length]),
    [['Only one', 0]],
  );
  assert.equal(result.customPages[0]?.state, 'in_review');
});

test('a part Apple refuses is a warning; both refused is an error', async () => {
  const denied = {
    status: 403,
    json: {
      errors: [{ status: '403', code: 'FORBIDDEN_ERROR', title: 'Forbidden', detail: 'No access' }],
    },
  };
  const one = ex.experimentsFake();
  one.clear('GET', ex.EXPERIMENTS);
  one.on({ method: 'GET', match: ex.EXPERIMENTS, ...denied });
  const result = await connector(one).listExperiments();
  assert.equal(result.experimentsRead, false);
  assert.equal(result.customPagesRead, true);
  assert.equal(result.customPages.length, 2);
  assert.equal(result.warnings.length, 1);

  const both = new fx.FakeFetch()
    .on({ method: 'GET', match: ex.EXPERIMENTS, ...denied })
    .on({ method: 'GET', match: ex.PAGES, ...denied });
  await assert.rejects(connector(both).listExperiments(), (error) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.kind, 'forbidden');
    assert.ok(!`${error.message}`.includes('PRIVATE KEY'));
    return true;
  });
  // A server error is never a warning: the whole read fails and nothing is replaced.
  const broken = ex.experimentsFake();
  broken.clear('GET', ex.PAGES);
  broken.on({ method: 'GET', match: ex.PAGES, status: 500, json: {} });
  await assert.rejects(connector(broken).listExperiments(), StoreError);
});

test('the read is capped and says so', async () => {
  const result = await connector(ex.experimentsFake(), { maxItems: 1 }).listExperiments();
  assert.equal(result.complete, false);
  assert.equal(result.customPages.length, 1);
  assert.ok(result.warnings.some((w) => /cut at its limit/.test(w)));
});

test('a missing or non-numeric app id is refused before any call', () => {
  const fake = new fx.FakeFetch();
  assert.throws(() => connector(fake, { appStoreId: '' }), StoreError);
  assert.equal(fake.calls.length, 0);
});
