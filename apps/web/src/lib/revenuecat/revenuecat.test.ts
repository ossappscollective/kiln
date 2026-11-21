import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, createApi } from '../api.ts';
import type { CredentialSummary } from '../types.ts';
import {
  appChoiceLabel,
  appsNote,
  appTypeLabel,
  basePlanCount,
  connectHint,
  durationText,
  entitlementNames,
  identifierNote,
  linkStatus,
  matchedLine,
  matchedTitle,
  type RevenueCatAppChoice,
  type RevenueCatLinkView,
  type RevenueCatMatchedProduct,
  type RevenueCatProductEntry,
  type RevenueCatProductsView,
  type RevenueCatSyncStatus,
  type RevenueCatWarning,
  revenueCatCell,
  revenueCatCredentials,
  revenueCatErrorText,
  revenueCatRead,
  revenueCatSummary,
  showRevenueCatColumn,
  sortedWarnings,
  startingChoice,
  statusBadge,
  stepFromBody,
  stepResult,
  syncLine,
  warningsOf,
  warningsSummary,
} from './revenuecat.ts';

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
const MIN = 60_000;

const link = (overrides: Partial<RevenueCatLinkView> = {}): RevenueCatLinkView => ({
  appId: 'a1',
  credentialId: 'c1',
  credentialLabel: 'RevenueCat read key',
  credentialAvailable: true,
  projectId: 'proj1',
  projectName: 'Trail Notes',
  revenueCatAppId: 'app1',
  revenueCatAppName: 'Trail Notes iOS',
  revenueCatAppType: 'app_store',
  revenueCatIdentifier: 'com.example.trail',
  identifierMatches: true,
  verifiedAt: NOW - 3 * MIN,
  linkedBy: 'u1',
  createdAt: NOW - 10 * MIN,
  updatedAt: NOW - 3 * MIN,
  ...overrides,
});

const sync = (overrides: Partial<RevenueCatSyncStatus> = {}): RevenueCatSyncStatus => ({
  lastAttemptAt: NOW - 5 * MIN,
  lastSyncedAt: NOW - 5 * MIN,
  lastError: null,
  failures: 0,
  productCount: 4,
  otherAppProductCount: 0,
  complete: true,
  warnings: [],
  ...overrides,
});

const matched = (overrides: Partial<RevenueCatMatchedProduct> = {}): RevenueCatMatchedProduct => ({
  rcProductId: 'prod1',
  storeIdentifier: 'pro_monthly',
  planId: null,
  planInStore: null,
  type: 'subscription',
  state: 'active',
  displayName: 'Pro monthly',
  duration: 'P1M',
  gracePeriod: null,
  trialDuration: 'P1W',
  ...overrides,
});

const entry = (overrides: Partial<RevenueCatProductEntry> = {}): RevenueCatProductEntry => ({
  status: 'in_revenuecat',
  products: [matched()],
  entitlements: [
    { id: 'e1', lookupKey: 'pro', displayName: 'Pro', state: 'active' },
    { id: 'e2', lookupKey: 'plus', displayName: null, state: 'active' },
    { id: 'e3', lookupKey: 'old', displayName: 'Old', state: 'archived' },
    { id: 'e4', lookupKey: 'team', displayName: 'Team', state: 'active' },
  ],
  offerings: [],
  ...overrides,
});

const view = (overrides: Partial<RevenueCatProductsView> = {}): RevenueCatProductsView => ({
  supported: true,
  link: link(),
  sync: sync(),
  products: { pro_monthly: entry() },
  unmatched: [],
  warnings: [],
  ...overrides,
});

const warning = (severity: RevenueCatWarning['severity'], extra: Partial<RevenueCatWarning> = {}): RevenueCatWarning => ({
  code: 'store_product_not_in_revenuecat',
  severity,
  message: 'Fix it.',
  storeProductId: 'pro_monthly',
  rcProductId: null,
  entitlementId: null,
  ...extra,
});

const apiError = (code: string, status = 422, body: Record<string, unknown> = {}, retryAfter?: number) =>
  new ApiError(status, code, code, retryAfter, body);

test('the credentials offered are the RevenueCat secret keys only', () => {
  const list = [
    { id: '1', kind: 'expo', label: 'Expo' },
    { id: '2', kind: 'revenuecat', label: 'RC' },
  ] as unknown as CredentialSummary[];
  assert.deepEqual(revenueCatCredentials(list).map((c) => c.id), ['2']);
  assert.deepEqual(revenueCatCredentials(null), []);
});

test('app types are said in words, the unmapped ones too, and an unknown one as it is', () => {
  assert.equal(appTypeLabel('app_store'), 'App Store');
  assert.equal(appTypeLabel('mac_app_store'), 'Mac App Store');
  assert.equal(appTypeLabel('play_store'), 'Google Play');
  assert.equal(appTypeLabel('rc_billing'), 'RevenueCat Web Billing');
  assert.equal(appTypeLabel('some_new_store'), 'some new store');
});

test('the badge says where the product stands, and nothing is claimed before the first read', () => {
  assert.deepEqual(statusBadge('in_revenuecat'), { label: 'In RevenueCat', tone: 'ok' });
  assert.equal(statusBadge('not_in_revenuecat').tone, 'warn');
  assert.equal(statusBadge('archived').label, 'Archived there');
  assert.equal(statusBadge('id_not_matched').label, 'Id differs');
  assert.equal(revenueCatCell(view(), 'pro_monthly').label, 'In RevenueCat');
  assert.equal(revenueCatCell(view({ sync: null, products: {} }), 'pro_monthly').label, 'Not read yet');
  assert.equal(revenueCatCell(view({ sync: sync({ lastSyncedAt: null }) }), 'pro_monthly').entry, null);
  assert.equal(revenueCatCell(null, 'x').label, 'Not read yet');
  // A product the server did not join is not claimed to be missing.
  assert.equal(revenueCatCell(view(), 'other').label, 'Not read yet');
  assert.equal(revenueCatRead(view()), true);
  assert.equal(revenueCatRead(view({ sync: null })), false);
});

test('the column is drawn only for a supported, linked app', () => {
  assert.equal(showRevenueCatColumn(view()), true);
  assert.equal(showRevenueCatColumn(view({ link: null })), false);
  assert.equal(showRevenueCatColumn(view({ supported: false })), false);
  assert.equal(showRevenueCatColumn(null), false);
});

test('the first two entitlements are named, archived ones are left out, and the rest is counted', () => {
  assert.deepEqual(entitlementNames(entry()), { shown: ['Pro', 'plus'], more: 1 });
  assert.deepEqual(entitlementNames(entry({ entitlements: [] })), { shown: [], more: 0 });
});

test('a Google Play subscription held as several products says how many base plans', () => {
  const plans = entry({ products: [matched({ planId: 'monthly' }), matched({ rcProductId: 'p2', planId: 'yearly' })] });
  assert.equal(basePlanCount(plans), '2 base plans');
  assert.equal(basePlanCount(entry()), '');
  assert.equal(basePlanCount(entry({ products: [matched({ planId: 'monthly' })] })), '');
  assert.equal(matchedTitle(matched({ storeIdentifier: 'pro:monthly', planId: 'monthly' })), 'pro / monthly');
  assert.equal(matchedTitle(matched()), 'prod1');
});

test('durations are said in words', () => {
  assert.equal(durationText('P1M'), '1 month');
  assert.equal(durationText('P1W'), '1 week');
  assert.equal(durationText('P3D'), '3 days');
  assert.equal(durationText('P1Y'), '1 year');
  assert.equal(durationText('P1Y2M'), '1 year 2 months');
  assert.equal(durationText('weird'), 'weird');
  assert.equal(durationText(null), '');
  assert.equal(matchedLine(matched()), 'subscription, 1 month, 1 week trial');
  assert.equal(matchedLine(matched({ type: 'non_consumable', duration: null, trialDuration: null })), 'non consumable');
});

test('warnings are ordered worst first and keep the server order inside a severity', () => {
  const list = [warning('info', { message: 'a' }), warning('bad', { message: 'b' }), warning('warn', { message: 'c' }), warning('bad', { message: 'd' })];
  assert.deepEqual(sortedWarnings(list).map((w) => w.message), ['b', 'd', 'c', 'a']);
  assert.equal(warningsSummary([]), null);
  assert.deepEqual(warningsSummary(list), { text: '4 things to check in the RevenueCat set-up', tone: 'bad' });
  assert.equal(warningsSummary([warning('info')])?.tone, 'info');
  assert.equal(warningsSummary([warning('warn')])?.text, '1 thing to check in the RevenueCat set-up');
  assert.equal(warningsOf([warning('warn'), warning('warn', { storeProductId: 'x' })], 'x').length, 1);
});

test('the sync line says what was read, what failed, and what is incomplete', () => {
  assert.match(syncLine(null, NOW).text, /Not read from RevenueCat yet/);
  assert.equal(syncLine(sync(), NOW).text, 'RevenueCat read 5 minutes ago: 4 products of this app.');
  assert.match(syncLine(sync({ otherAppProductCount: 3 }), NOW).text, /3 products of the other apps of the project are left out/);
  assert.equal(syncLine(sync({ complete: false }), NOW).tone, 'warn');
  const failed = syncLine(sync({ lastError: 'RevenueCat did not accept the key.', failures: 2 }), NOW);
  assert.equal(failed.tone, 'bad');
  assert.match(failed.text, /2 reads in a row failed/);
  assert.match(failed.text, /Showing what was read 5 minutes ago/);
  assert.match(syncLine(sync({ lastError: 'x', lastSyncedAt: null }), NOW).text, /Nothing was read yet/);
  assert.equal(syncLine(sync({ productCount: 1 }), NOW).text, 'RevenueCat read 5 minutes ago: 1 product of this app.');
});

test('the RevenueCat step of the sync is said beside the store result, and a failure never blames the store', () => {
  const ok = { ok: true as const, products: 1, entitlements: 2, offerings: 3, otherAppProducts: 0, complete: true, warnings: [], syncedAt: NOW };
  assert.deepEqual(stepResult(ok), { text: 'Read 1 product, 2 entitlements and 3 offerings from RevenueCat.', tone: 'ok' });
  assert.equal(stepResult({ ...ok, complete: false }).tone, 'warn');
  const failed = stepResult({ ok: false, code: 'revenuecat_auth', message: 'RevenueCat did not accept the key.' });
  assert.equal(failed.tone, 'bad');
  assert.match(failed.text, /The products read from the store are not affected/);
  assert.equal(stepFromBody({ revenuecat: { ok: false, code: 'x', message: 'm' } })?.ok, false);
  assert.equal(stepFromBody({ revenuecat: ok })?.ok, true);
  assert.equal(stepFromBody({ revenuecat: null }), null);
  assert.equal(stepFromBody({}), null);
  assert.equal(stepFromBody({ revenuecat: { ok: false } }), null);
});

test('the hint explains how to connect, to whom it is said, and is silent when it cannot apply', () => {
  assert.match(connectHint(view({ link: null }), true), /Link this app to its RevenueCat project in the app settings/);
  assert.match(connectHint(view({ link: null }), false), /Ask an owner or an admin/);
  assert.equal(connectHint(view(), true), '');
  assert.equal(connectHint(view({ link: null, supported: false }), true), '');
  assert.equal(connectHint(null, true), '');
});

test('the card line, the status of the link and the identifier note', () => {
  assert.equal(revenueCatSummary([null, null]), 'Not linked');
  assert.equal(revenueCatSummary([link(), null]), 'Trail Notes');
  assert.equal(revenueCatSummary([link(), link({ appId: 'a2' })]), 'Trail Notes');
  assert.equal(revenueCatSummary([link(), link({ projectName: 'Other' })]), '2 projects');
  assert.deepEqual(linkStatus(link(), NOW), { tone: 'ok', text: 'Confirmed with RevenueCat 3 minutes ago.' });
  assert.equal(linkStatus(link({ credentialAvailable: false }), NOW).tone, 'warn');
  assert.equal(identifierNote(link()), '');
  assert.equal(identifierNote(link({ identifierMatches: null })), '');
  assert.match(identifierNote(link({ identifierMatches: false, revenueCatIdentifier: 'com.example.shared' })), /com\.example\.shared.*universal purchase/);
});

const choice = (overrides: Partial<RevenueCatAppChoice> = {}): RevenueCatAppChoice => ({
  id: 'x',
  name: 'App',
  type: 'app_store',
  mapped: true,
  linkable: true,
  identifier: 'com.example.trail',
  matches: false,
  suggested: false,
  note: null,
  ...overrides,
});

test('the app list starts from the suggested app, else the only linkable one, and says what is ignored', () => {
  assert.equal(startingChoice(null), '');
  assert.equal(startingChoice([choice({ id: 'a' }), choice({ id: 'b', suggested: true })]), 'b');
  assert.equal(startingChoice([choice({ id: 'a' }), choice({ id: 'z', linkable: false, mapped: false })]), 'a');
  assert.equal(startingChoice([choice({ id: 'a' }), choice({ id: 'b' })]), '');
  assert.equal(appsNote([]), 'This RevenueCat project has no apps.');
  assert.equal(appsNote([choice()]), '');
  assert.match(appsNote([choice(), choice({ mapped: false, linkable: false, type: 'stripe' })]), /1 app of other stores .* is not mapped/);
  assert.match(appsNote([choice({ mapped: false }), choice({ mapped: false })]), /2 apps .* are not mapped/);
  assert.match(appChoiceLabel(choice({ suggested: true })), /App \(App Store, com\.example\.trail\) \(suggested\)/);
  assert.match(appChoiceLabel(choice({ mapped: false, type: 'stripe', identifier: null })), /Stripe\) \(not mapped\)/);
  assert.match(appChoiceLabel(choice({ linkable: false })), /\(other store\)/);
});

test('every error code of the RevenueCat routes has a sentence of its own (not the GitHub wording)', () => {
  assert.match(revenueCatErrorText(apiError('forbidden', 403)), /owner or an admin/);
  assert.match(revenueCatErrorText(apiError('credential_kind')), /RevenueCat secret key kind/);
  assert.match(revenueCatErrorText(apiError('credential_not_found')), /no longer exists/);
  assert.match(revenueCatErrorText(apiError('credential_unreadable')), /Enter its key again/);
  assert.equal(revenueCatErrorText(apiError('revenuecat_auth', 422, { message: 'RevenueCat did not accept the key.' })), 'RevenueCat did not accept the key.');
  assert.match(revenueCatErrorText(apiError('revenuecat_unavailable', 502)), /RevenueCat could not be asked/);
  assert.match(revenueCatErrorText(apiError('revenuecat_app_not_mapped', 422, { message: 'Not mapped: this app is ignored.' })), /Not mapped/);
  assert.equal(revenueCatErrorText(apiError('timeout', 504)), 'RevenueCat took too long to answer. Try again.');
  assert.equal(revenueCatErrorText(apiError('rate_limited', 429, {}, 90)), 'Too many requests. Try again in 2 minutes.');
  assert.match(revenueCatErrorText(apiError('invalid_reference')), /Choose a credential/);
  assert.match(revenueCatErrorText(apiError('boom', 500)), /server had a problem/);
  assert.match(revenueCatErrorText(new Error('x')), /Something went wrong/);
  for (const code of ['forbidden', 'credential_kind', 'timeout', 'revenuecat_unavailable']) {
    assert.doesNotMatch(revenueCatErrorText(apiError(code)), /GitHub/);
  }
});

test('the API methods: paths, verbs and bodies', async () => {
  const calls: { path: string; method: string; body: string | undefined }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: String(input), method: String(init?.method), body: init?.body === undefined ? undefined : String(init.body) });
    return init?.method === 'DELETE'
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify({ link: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const api = createApi({ fetch: fetchImpl });
  await api.revenueCatLink('w 1', 'a/1');
  await api.revenueCatProducts('w1', 'a1');
  await api.detectRevenueCat('w1', 'a1', 'c 1');
  await api.detectRevenueCat('w1', 'a1', 'c1', 'proj 1');
  await api.setRevenueCatLink('w1', 'a1', { credentialId: 'c1', projectId: 'p1', revenueCatAppId: 'app1' });
  assert.equal(await api.removeRevenueCatLink('w1', 'a1'), undefined);
  assert.deepEqual(calls, [
    { path: '/api/workspaces/w%201/apps/a%2F1/revenuecat', method: 'GET', body: undefined },
    { path: '/api/workspaces/w1/apps/a1/revenuecat/products', method: 'GET', body: undefined },
    { path: '/api/workspaces/w1/apps/a1/revenuecat/detect?credentialId=c%201', method: 'GET', body: undefined },
    { path: '/api/workspaces/w1/apps/a1/revenuecat/detect?credentialId=c1&projectId=proj%201', method: 'GET', body: undefined },
    { path: '/api/workspaces/w1/apps/a1/revenuecat', method: 'PUT', body: JSON.stringify({ credentialId: 'c1', projectId: 'p1', revenueCatAppId: 'app1' }) },
    { path: '/api/workspaces/w1/apps/a1/revenuecat', method: 'DELETE', body: undefined },
  ]);
});

test('no money or customer word exists in what the RevenueCat helpers say', () => {
  const said = [
    stepResult({ ok: true, products: 1, entitlements: 1, offerings: 1, otherAppProducts: 0, complete: true, warnings: [], syncedAt: NOW }).text,
    syncLine(sync(), NOW).text,
    connectHint(view({ link: null }), true),
    matchedLine(matched()),
    warningsSummary([warning('warn')])?.text ?? '',
  ].join(' ');
  assert.doesNotMatch(said, /revenue(?!cat)|subscriber|customer|\$|€|MRR/i);
});
