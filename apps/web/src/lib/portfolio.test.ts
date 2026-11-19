import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, createApi } from './api.ts';
import {
  type AppDraft,
  type BatchResult,
  addProblem,
  appErrorMessage,
  appFromError,
  appHref,
  appLabel,
  batchSummary,
  buildImportItems,
  candidateKey,
  chunk,
  classifySyncError,
  compareVersions,
  credentialsFor,
  describeError,
  discoverFailureMessage,
  discoverSummaryText,
  discoverableCredentials,
  formatRollout,
  groupReleases,
  importItemMessage,
  importScopeNote,
  importSummaryText,
  importedApps,
  latestByPlatform,
  latestRelease,
  lifecyclePath,
  liveRelease,
  mergeImports,
  notRunMessage,
  packageListProblem,
  parsePackageList,
  parseRoute,
  platformCount,
  runLimited,
  selectableCandidates,
  sortApps,
  statusInfo,
  syncApp,
  syncApps,
  syncInfo,
  syncSummaryText,
  timeline,
  trackLabel,
  validateDraft,
  withSelection,
} from './portfolio.ts';
import type { AppSummary, DiscoverCandidate, ImportResult, ReleaseSummary } from './types.ts';

const now = Date.UTC(2026, 10, 18, 12, 0, 0);

let counter = 0;
function release(partial: Partial<ReleaseSummary>): ReleaseSummary {
  counter += 1;
  return {
    id: `r${counter}`,
    appId: 'a1',
    platform: 'ios',
    version: '1.0.0',
    track: null,
    build: null,
    status: 'live',
    rawState: 'READY_FOR_SALE',
    rolloutFraction: null,
    versionCodes: null,
    storeUpdatedAt: null,
    syncedAt: now,
    ...partial,
  };
}

function app(partial: Partial<AppSummary>): AppSummary {
  return {
    id: 'a1',
    name: 'Acme',
    platform: 'ios',
    identifier: 'com.acme.app',
    storeAppId: null,
    credentialId: 'c1',
    repositoryId: null,
    createdAt: now,
    lastSyncedAt: null,
    lastSyncAttemptAt: null,
    lastSyncError: null,
    ...partial,
  };
}

test('routes read the app id from the hash and fall back to the list', () => {
  assert.deepEqual(parseRoute('#/portfolio'), { name: 'list' });
  assert.deepEqual(parseRoute('#/portfolio/'), { name: 'list' });
  assert.deepEqual(parseRoute(''), { name: 'list' });
  assert.deepEqual(parseRoute('#/credentials'), { name: 'list' });
  assert.deepEqual(parseRoute('#/portfolio/6f1c'), { name: 'app', id: '6f1c' });
  assert.deepEqual(parseRoute('#/portfolio/6f1c/'), { name: 'app', id: '6f1c' });
  assert.deepEqual(parseRoute('#/portfolio/a%20b'), { name: 'app', id: 'a b' });
  assert.deepEqual(parseRoute('#/portfolio/%E0%A4%A'), { name: 'list' });
  assert.deepEqual(parseRoute(appHref('x/y')), { name: 'app', id: 'x/y' });
});

test('versions compare by number, not by text', () => {
  assert.ok(compareVersions('2.10.0', '2.9.0') > 0);
  assert.ok(compareVersions('2.4.0', '2.4.1') < 0);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.ok(compareVersions('1.0.0-beta', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-beta') > 0);
  assert.ok(compareVersions('1.0.1', '1.0') > 0);
  assert.ok(compareVersions('1.0.0-beta2', '1.0.0-beta10') < 0);
  assert.ok(compareVersions('240,241', '240') > 0);
  assert.equal(compareVersions('', ''), 0);
});

test('the latest release is the newest version, with ties going to the more public track', () => {
  const releases = [
    release({ platform: 'android', version: '2.4.0', track: 'production', status: 'live' }),
    release({ platform: 'android', version: '2.5.0', track: 'internal', status: 'draft' }),
    release({ platform: 'android', version: '2.5.0', track: 'beta', status: 'in_review' }),
    release({ platform: 'ios', version: '3.0.1', status: 'in_review' }),
    release({ platform: 'ios', version: '3.0.0', status: 'live' }),
  ];
  assert.equal(latestRelease(releases, 'android')?.track, 'beta');
  assert.equal(latestRelease(releases, 'ios')?.version, '3.0.1');
  assert.equal(latestRelease([], 'ios'), null);
  const byPlatform = latestByPlatform(releases);
  assert.equal(byPlatform.android?.version, '2.5.0');
  assert.equal(byPlatform.ios?.version, '3.0.1');
  assert.deepEqual(Object.keys(latestByPlatform([releases[3] as ReleaseSummary])), ['ios']);
  assert.equal(liveRelease(releases, 'ios')?.version, '3.0.0');
  assert.equal(liveRelease([release({ status: 'in_review' })]), null);
});

test('a higher build wins a tie and a missing build loses it', () => {
  const a = release({ version: '1.0.0', build: '9' });
  const b = release({ version: '1.0.0', build: '10' });
  const c = release({ version: '1.0.0', build: null });
  assert.equal(latestRelease([a, c, b])?.id, b.id);
  assert.equal(latestRelease([c, a])?.id, a.id);
});

test('groups are per platform and track, iOS first, production before testing tracks', () => {
  const groups = groupReleases([
    release({ platform: 'android', version: '1.0.0', track: 'internal' }),
    release({ platform: 'android', version: '1.1.0', track: 'production' }),
    release({ platform: 'android', version: '1.0.0', track: 'production' }),
    release({ platform: 'android', version: '1.0.0', track: 'zeta-wear' }),
    release({ platform: 'ios', version: '1.0.0' }),
    release({ platform: 'ios', version: '1.2.0' }),
  ]);
  assert.deepEqual(
    groups.map((g) => g.title),
    ['iOS · App Store', 'Android · Production', 'Android · Internal testing', 'Android · zeta-wear'],
  );
  assert.deepEqual(groups[0]?.releases.map((r) => r.version), ['1.2.0', '1.0.0']);
  assert.equal(groups[1]?.latest.version, '1.1.0');
  assert.deepEqual(groupReleases([]), []);
});

test('track labels', () => {
  assert.equal(trackLabel(null), 'App Store');
  assert.equal(trackLabel('production'), 'Production');
  assert.equal(trackLabel('alpha'), 'Closed testing (alpha)');
  assert.equal(trackLabel('wear:production'), 'wear:production');
});

test('every lifecycle state has a label, and an unmapped one says so', () => {
  assert.equal(statusInfo('in_review').label, 'In review');
  assert.equal(statusInfo('rejected').tone, 'bad');
  assert.equal(statusInfo('live').tone, 'ok');
  assert.equal(statusInfo('halted').tone, 'warn');
  const unmapped = statusInfo(null, 'WEIRD_STATE');
  assert.equal(unmapped.label, 'Unmapped');
  assert.match(unmapped.description, /WEIRD_STATE/);
  assert.equal(statusInfo(undefined).label, 'Unmapped');
});

test('rollout fractions read as percentages', () => {
  assert.equal(formatRollout(0.2), '20%');
  assert.equal(formatRollout(1), '100%');
  assert.equal(formatRollout(0.005), '0.5%');
  assert.equal(formatRollout(0.1234), '12.3%');
  assert.equal(formatRollout(7), '100%');
  assert.equal(formatRollout(-1), '0%');
  assert.equal(formatRollout(null), null);
  assert.equal(formatRollout(Number.NaN), null);
});

test('the lifecycle path follows the state machine of each platform', () => {
  assert.deepEqual(lifecyclePath('ios'), ['draft', 'build_chosen', 'ready', 'in_review', 'approved', 'rolling_out', 'live']);
  assert.deepEqual(lifecyclePath('android'), [
    'draft',
    'build_chosen',
    'ready',
    'in_review',
    'approved',
    'propagating',
    'rolling_out',
    'live',
  ]);
});

test('the timeline marks done, current and upcoming steps', () => {
  const steps = timeline('ios', 'in_review');
  assert.deepEqual(
    steps.map((s) => s.position),
    ['done', 'done', 'done', 'current', 'upcoming', 'upcoming', 'upcoming'],
  );
  assert.equal(steps[3]?.tone, 'info');
  assert.equal(steps[0]?.tone, 'neutral');
  const live = timeline('android', 'live');
  assert.equal(live.at(-1)?.position, 'current');
  assert.equal(live.filter((s) => s.position === 'done').length, live.length - 1);
});

test('a rejected release sits on the review step and a halted one on the rollout step', () => {
  const rejected = timeline('ios', 'rejected');
  const review = rejected.find((s) => s.position === 'current');
  assert.equal(review?.state, 'in_review');
  assert.equal(review?.label, 'Rejected');
  assert.equal(review?.tone, 'bad');
  const halted = timeline('android', 'halted');
  const rollout = halted.find((s) => s.position === 'current');
  assert.equal(rollout?.state, 'rolling_out');
  assert.equal(rollout?.label, 'Halted');
  assert.equal(halted.find((s) => s.state === 'live')?.position, 'upcoming');
});

test('an android release can be propagating, an ios one has no such step', () => {
  assert.equal(timeline('android', 'propagating').find((s) => s.position === 'current')?.state, 'propagating');
  assert.deepEqual(timeline('ios', 'propagating'), []);
  assert.deepEqual(timeline('ios', null), []);
});

test('apps sort by name without regard to case, then platform', () => {
  const sorted = sortApps([
    app({ id: '1', name: 'zeta' }),
    app({ id: '2', name: 'Acme', platform: 'android' }),
    app({ id: '3', name: 'acme', platform: 'ios' }),
    app({ id: '4', name: 'Beta' }),
  ]);
  assert.deepEqual(sorted.map((a) => a.id), ['3', '2', '4', '1']);
});

test('the sync column says never, when, and what went wrong', () => {
  assert.deepEqual(syncInfo(app({}), now), { kind: 'never', label: 'Never synced', error: null, attempt: null });
  assert.deepEqual(syncInfo(app({ lastSyncedAt: now - 5 * 60_000, lastSyncAttemptAt: now - 5 * 60_000 }), now), {
    kind: 'ok',
    label: 'Synced 5 minutes ago',
    error: null,
    attempt: null,
  });
  const failed = syncInfo(
    app({ lastSyncedAt: now - 3 * 3_600_000, lastSyncAttemptAt: now - 60_000, lastSyncError: 'The store rejected the key.' }),
    now,
  );
  assert.equal(failed.kind, 'failed');
  assert.equal(failed.label, 'Synced 3 hours ago');
  assert.equal(failed.error, 'The store rejected the key.');
  assert.equal(failed.attempt, 'Last attempt 1 minute ago');
  const neverFailed = syncInfo(app({ lastSyncAttemptAt: now, lastSyncError: 'Nope' }), now);
  assert.equal(neverFailed.label, 'Never synced');
  assert.equal(neverFailed.kind, 'failed');
  assert.equal(syncInfo(app({ lastSyncError: '   ' }), now).kind, 'never');
});

test('sync results read as one sentence', () => {
  const base = { at: now, found: 3, added: 1, updated: 1, removed: 0, unmapped: 1 };
  assert.equal(
    syncSummaryText('Acme', base),
    'Synced Acme: 3 releases, 1 added, 1 updated. 1 with a state that has no normalized status.',
  );
  assert.equal(syncSummaryText('Acme', { ...base, found: 1, added: 0, updated: 0, unmapped: 0 }), 'Synced Acme: 1 release, no changes.');
  assert.equal(syncSummaryText('Acme', { ...base, found: 0, added: 0, updated: 0, removed: 2 }), 'Synced Acme. The store reported no releases.');
});

function apiError(status: number, code: string, body: Record<string, unknown> = {}, retryAfter?: number) {
  return new ApiError(status, code, 'raw message', retryAfter, { error: code, ...body });
}

test('every documented error code has a human message', () => {
  const codes = [
    'not_found',
    'already_exists',
    'credential_not_found',
    'credential_kind',
    'repository_not_found',
    'sync_in_progress',
    'credential_unreadable',
    'store_auth',
    'store_forbidden',
    'store_not_found',
    'rate_limited',
    'store_unavailable',
    'timeout',
    'sync_failed',
  ];
  const seen = new Set<string>();
  for (const code of codes) {
    const message = appErrorMessage(apiError(422, code));
    assert.notEqual(message, 'raw message', code);
    assert.ok(message.endsWith('.'), `${code}: ${message}`);
    assert.ok(!message.includes('GitHub'), code);
    seen.add(message);
  }
  assert.equal(seen.size, codes.length);
  assert.equal(appErrorMessage(apiError(500, 'weird')), 'raw message');
});

test('the credential message depends on whether you are adding or syncing', () => {
  const error = apiError(422, 'credential_not_found');
  assert.match(appErrorMessage(error, 'add'), /Pick another/);
  assert.match(appErrorMessage(error, 'sync'), /was deleted/);
  assert.equal(appErrorMessage(apiError(422, 'credential_kind', { message: 'iOS needs an App Store Connect credential.' })), 'iOS needs an App Store Connect credential.');
});

test('a rate limit says who limited it and how long to wait', () => {
  const workspace = apiError(429, 'rate_limited', { retryAfterSeconds: 30 }, 30);
  assert.match(appErrorMessage(workspace, 'sync'), /workspace has run too many syncs.*30 seconds/);
  const store = apiError(429, 'rate_limited', { app: { id: 'a1' } }, 90);
  assert.match(appErrorMessage(store, 'sync'), /store asked us to slow down.*2 minutes/);
  assert.match(appErrorMessage(apiError(429, 'rate_limited')), /a minute/);
  assert.match(appErrorMessage(apiError(429, 'rate_limited', { retryAfterSeconds: 1 })), /1 second\./);
});

test('sync failures are classified so a batch knows whether to go on', () => {
  assert.equal(classifySyncError(apiError(409, 'sync_in_progress')).kind, 'busy');
  assert.equal(classifySyncError(apiError(429, 'rate_limited', {}, 20)).kind, 'limited');
  assert.equal(classifySyncError(apiError(429, 'rate_limited', {}, 20)).retryAfterSeconds, 20);
  assert.equal(classifySyncError(apiError(429, 'rate_limited', { app: { id: 'a1' } })).kind, 'failed');
  assert.equal(classifySyncError(apiError(422, 'store_auth', { app: { id: 'a1' } })).kind, 'failed');
  assert.equal(classifySyncError(apiError(504, 'timeout')).kind, 'failed');
  assert.equal(classifySyncError(new ApiError(0, 'network', 'Cannot reach the server.')).kind, 'abort');
  assert.equal(classifySyncError(apiError(401, 'unauthenticated')).kind, 'abort');
  assert.equal(classifySyncError(new TypeError('boom')).kind, 'failed');
});

test('a failed sync hands back the app the server sent', () => {
  const sent = app({ id: 'a9', lastSyncError: 'The store rejected the key.' });
  assert.deepEqual(appFromError(apiError(422, 'store_auth', { app: sent })), sent);
  assert.equal(appFromError(apiError(409, 'sync_in_progress')), null);
  assert.equal(appFromError(apiError(422, 'store_auth', { app: 'nope' })), null);
  assert.equal(appFromError(apiError(422, 'store_auth', { app: { id: 1 } })), null);
});

test('syncApp returns a value for success and for every failure', async () => {
  const sync = { at: now, found: 1, added: 1, updated: 0, removed: 0, unmapped: 0 };
  const good = await syncApp(
    { syncApp: async () => ({ app: app({ id: 'a1', lastSyncedAt: now }), releases: [], sync }) },
    'w1',
    'a1',
  );
  assert.equal(good.ok, true);
  if (good.ok) assert.equal(good.sync.added, 1);

  const sent = app({ id: 'a1', lastSyncError: 'The store rejected the key.' });
  const bad = await syncApp(
    {
      syncApp: async () => {
        throw apiError(422, 'store_auth', { app: sent });
      },
    },
    'w1',
    'a1',
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.failure.code, 'store_auth');
    assert.equal(bad.failure.kind, 'failed');
    assert.equal(bad.app?.lastSyncError, 'The store rejected the key.');
  }

  const odd = await syncApp(
    {
      syncApp: async () => {
        throw new Error('boom');
      },
    },
    'w1',
    'a1',
  );
  assert.equal(odd.ok, false);
  if (!odd.ok) assert.equal(odd.app, null);
});

const draft = (partial: Partial<AppDraft> = {}): AppDraft => ({
  platform: 'ios',
  identifier: 'com.acme.app',
  credentialId: 'c1',
  name: '',
  repositoryId: '',
  ...partial,
});

test('credentials are filtered by the kind the platform needs', () => {
  const all = [
    { id: '1', kind: 'app_store_connect' },
    { id: '2', kind: 'google_play' },
    { id: '3', kind: 'github_token' },
  ];
  assert.deepEqual(credentialsFor('ios', all).map((c) => c.id), ['1']);
  assert.deepEqual(credentialsFor('android', all).map((c) => c.id), ['2']);
});

test('a valid draft becomes the request, leaving out what is empty', () => {
  const result = validateDraft(draft({ identifier: '  com.acme.app ' }));
  assert.deepEqual(result, { ok: true, input: { platform: 'ios', identifier: 'com.acme.app', credentialId: 'c1' } });
  const full = validateDraft(draft({ name: ' Acme Mobile ', repositoryId: 'r1' }));
  assert.deepEqual(full, {
    ok: true,
    input: { platform: 'ios', identifier: 'com.acme.app', credentialId: 'c1', name: 'Acme Mobile', repositoryId: 'r1' },
  });
});

test('a draft with mistakes says which field and why', () => {
  const empty = validateDraft(draft({ identifier: '', credentialId: '' }));
  assert.equal(empty.ok, false);
  if (!empty.ok) {
    assert.match(empty.problems.identifier ?? '', /Enter the bundle id/i);
    assert.match(empty.problems.credentialId ?? '', /Choose/);
  }
  assert.equal(validateDraft(draft({ identifier: 'com acme' })).ok, false);
  assert.equal(validateDraft(draft({ platform: 'android', identifier: 'acme' })).ok, false);
  assert.equal(validateDraft(draft({ platform: 'android', identifier: 'com.acme.app_2' })).ok, true);
  assert.equal(validateDraft(draft({ platform: 'android', identifier: 'com.1acme' })).ok, false);
  assert.equal(validateDraft(draft({ identifier: `a.${'b'.repeat(160)}` })).ok, false);
  const longName = validateDraft(draft({ name: 'x'.repeat(101) }));
  assert.equal(longName.ok, false);
  if (!longName.ok) assert.match(longName.problems.name ?? '', /at most 100/);
  assert.equal(validateDraft(draft({ name: 'a\nb' })).ok, false);
});

test('a refusal from the create call is shown beside its field', () => {
  assert.equal(addProblem(apiError(409, 'already_exists')).field, 'identifier');
  assert.equal(addProblem(apiError(422, 'credential_not_found')).field, 'credentialId');
  assert.equal(addProblem(apiError(422, 'credential_kind', { message: 'Wrong kind.' })).message, 'Wrong kind.');
  assert.equal(addProblem(apiError(422, 'repository_not_found')).field, 'repositoryId');
  assert.deepEqual(
    addProblem(apiError(400, 'invalid_request', { issues: [{ path: 'identifier', message: 'Not a valid package name.' }] })),
    { field: 'identifier', message: 'Not a valid package name.' },
  );
  assert.equal(addProblem(apiError(400, 'invalid_request', { issues: [{ path: 'other', message: 'x' }] })).field, 'form');
  assert.equal(addProblem(apiError(500, 'weird')).field, 'form');
});

test('runLimited runs every item and never more than the limit at once', async () => {
  let active = 0;
  let peak = 0;
  const seen: number[] = [];
  await runLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    seen.push(n);
    active -= 1;
  });
  assert.deepEqual([...seen].sort(), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(peak, 3);
  await runLimited([], 4, async () => {
    throw new Error('never called');
  });
});

test('a batch is summarised in one sentence', () => {
  const result = (status: BatchResult['status']): BatchResult => ({ appId: status, name: status, status, message: '' });
  assert.equal(batchSummary([result('ok'), result('ok')]), 'Synced 2 of 2 apps.');
  assert.equal(batchSummary([result('ok')]), 'Synced 1 of 1 app.');
  assert.equal(
    batchSummary([result('ok'), result('failed'), result('busy'), result('skipped'), result('skipped')]),
    'Synced 1 of 5 apps. 1 failed, 1 already syncing, 2 not run.',
  );
  assert.equal(notRunMessage(null), 'Not run: you stopped the sync.');
  assert.match(notRunMessage(classifySyncError(apiError(429, 'rate_limited', {}, 30))), /^Not run: This workspace has run too many syncs/);
});

test('describeError words ApiErrors and hides anything else', () => {
  assert.match(describeError(apiError(409, 'already_exists'), 'add'), /already has an app/);
  assert.equal(describeError(new TypeError('boom')), 'Something went wrong. Try again.');
});

function fakeFetch(status: number, body: unknown, calls: Array<{ url: string; method: string; body?: string }> = []) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body as string | undefined });
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...(status === 429 ? { 'retry-after': '12' } : {}) },
    });
  };
}

test('the apps endpoints use the documented paths', async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const api = createApi({ fetch: fakeFetch(200, { apps: [] }, calls) });
  await api.apps('w 1');
  await api.app('w 1', 'a/1');
  await api.syncApp('w 1', 'a1');
  await api.createApp('w 1', { platform: 'ios', identifier: 'com.acme.app', credentialId: 'c1' });
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    [
      'GET /api/workspaces/w%201/apps',
      'GET /api/workspaces/w%201/apps/a%2F1',
      'POST /api/workspaces/w%201/apps/a1/sync',
      'POST /api/workspaces/w%201/apps',
    ],
  );
  assert.equal(calls[3]?.body, '{"platform":"ios","identifier":"com.acme.app","credentialId":"c1"}');
  const deleting = createApi({ fetch: fakeFetch(204, undefined, calls) });
  assert.equal(await deleting.deleteApp('w1', 'a1'), undefined);
  assert.equal(calls[4]?.method, 'DELETE');
});

test('a failed sync keeps the error body, with the app, on the ApiError', async () => {
  const sent = app({ id: 'a1', lastSyncError: 'The store rejected the key.' });
  const api = createApi({
    fetch: fakeFetch(422, { error: 'store_auth', message: 'The store rejected the key.', app: sent }),
  });
  const outcome = await syncApp(api, 'w1', 'a1');
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.failure.code, 'store_auth');
    assert.deepEqual(outcome.app, sent);
  }
});

test('a rate limit from the workspace stops a batch and carries the wait', async () => {
  const api = createApi({
    fetch: fakeFetch(429, { error: 'rate_limited', message: 'Too many syncs.', retryAfterSeconds: 12 }),
  });
  const outcome = await syncApp(api, 'w1', 'a1');
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.failure.kind, 'limited');
    assert.equal(outcome.failure.retryAfterSeconds, 12);
    assert.match(outcome.failure.message, /12 seconds/);
    assert.equal(outcome.app, null);
  }
});

// ---------------------------------------------------------------------------------------------
// Finding and importing apps

function candidate(partial: Partial<DiscoverCandidate>): DiscoverCandidate {
  return {
    platform: 'ios',
    storeId: '111',
    identifier: 'com.acme.app',
    name: 'Acme',
    alreadyAdded: false,
    ...partial,
  };
}

test('the discovery and import endpoints use the documented paths and bodies', async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const api = createApi({ fetch: fakeFetch(200, { candidates: [], failures: [], results: [], summary: {} }, calls) });
  await api.discoverApps('w 1', { credentialId: 'c1', packages: ['com.acme.app'] });
  await api.importApps('w 1', {
    credentialId: 'c1',
    items: [{ platform: 'ios', identifier: 'com.acme.app', storeAppId: '111' }],
  });
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    ['POST /api/workspaces/w%201/apps/discover', 'POST /api/workspaces/w%201/apps/import'],
  );
  assert.equal(calls[0]?.body, '{"credentialId":"c1","packages":["com.acme.app"]}');
  assert.equal(
    calls[1]?.body,
    '{"credentialId":"c1","items":[{"platform":"ios","identifier":"com.acme.app","storeAppId":"111"}]}',
  );
});

test('only App Store Connect and Google Play credentials can find apps', () => {
  const list = [
    { id: '1', kind: 'github_token' },
    { id: '2', kind: 'app_store_connect' },
    { id: '3', kind: 'google_play' },
    { id: '4', kind: 'github_app' },
  ];
  assert.deepEqual(
    discoverableCredentials(list).map((c) => c.id),
    ['2', '3'],
  );
});

test('a pasted package list is split, deduplicated and checked line by line', () => {
  const list = parsePackageList('com.acme.app\n\n  com.acme.other  \r\ncom.acme.app\nnodots\ncom.x.y, com.x.z\n1bad.pkg');
  assert.deepEqual(list.packages, ['com.acme.app', 'com.acme.other', 'com.x.y', 'com.x.z']);
  assert.equal(list.duplicates, 1);
  assert.deepEqual(list.invalid, [
    { line: 5, value: 'nodots' },
    { line: 7, value: '1bad.pkg' },
  ]);
  assert.match(packageListProblem(list), /^Line 5 is not a package name: “nodots” \(and 1 more\)\./);
  assert.equal(packageListProblem(parsePackageList('com.acme.app')), '');
  assert.match(packageListProblem(parsePackageList('  \n')), /at least one package name/);
  const many = Array.from({ length: 51 }, (_, i) => `com.acme.app${i}`).join('\n');
  assert.match(packageListProblem(parsePackageList(many)), /at most 50 packages.*51/);
  assert.equal(packageListProblem(parsePackageList(Array.from({ length: 50 }, (_, i) => `a.b${i}`).join('\n'))), '');
  // Package names are case sensitive.
  assert.deepEqual(parsePackageList('com.Acme.app\ncom.acme.app').packages.length, 2);
  // A very long entry is shortened in the message and never accepted.
  const long = parsePackageList(`com.${'a'.repeat(300)}`);
  assert.equal(long.invalid.length, 1);
  assert.ok(packageListProblem(long).length < 250);
});

test('candidates are selected by platform and identifier, bundle ids without case', () => {
  assert.equal(candidateKey({ platform: 'ios', identifier: 'COM.Acme.App' }), 'ios:com.acme.app');
  assert.equal(candidateKey({ platform: 'android', identifier: 'com.Acme.app' }), 'android:com.Acme.app');
  const added = candidate({ identifier: 'com.acme.old', alreadyAdded: true, appId: 'a9' });
  const fresh = candidate({});
  assert.deepEqual(selectableCandidates([added, fresh]), [fresh]);
  const one = withSelection(new Set(), 'a', true);
  const two = withSelection(one, 'b', true);
  assert.deepEqual([...one], ['a']);
  assert.deepEqual([...two], ['a', 'b']);
  assert.deepEqual([...withSelection(two, 'a', false)], ['b']);
});

test('the discovery summary counts what was found, verified and already added', () => {
  const ios = [candidate({}), candidate({ identifier: 'com.acme.b', alreadyAdded: true })];
  assert.equal(discoverSummaryText({ kind: 'app_store_connect', candidates: ios, failures: [] }), 'Found 2 apps. 1 already added.');
  assert.equal(
    discoverSummaryText({ kind: 'app_store_connect', candidates: [candidate({})], failures: [] }),
    'Found 1 app.',
  );
  assert.equal(discoverSummaryText({ kind: 'app_store_connect', candidates: [], failures: [] }), 'This key can see no apps.');
  assert.equal(
    discoverSummaryText({
      kind: 'google_play',
      candidates: [candidate({ platform: 'android' })],
      failures: [{ identifier: 'com.x.y', error: 'store_not_found', message: '' }],
    }),
    'Checked 2 packages: 1 verified, 1 could not be verified.',
  );
});

test('every per-package error code of discovery has advice a person can act on', () => {
  for (const code of ['store_not_found', 'store_forbidden', 'store_auth', 'rate_limited', 'timeout', 'store_unavailable', 'discover_failed']) {
    const text = discoverFailureMessage({ error: code, message: 'raw server text' });
    assert.ok(text.length > 30, code);
    assert.ok(!text.includes('raw server text'), code);
  }
  assert.match(discoverFailureMessage({ error: 'store_forbidden', message: '' }), /Play Console/);
  // An unknown code shows what the server said, or a plain fallback.
  assert.equal(discoverFailureMessage({ error: 'new_code', message: ' Something specific. ' }), 'Something specific.');
  assert.equal(discoverFailureMessage({ error: 'new_code', message: '' }), 'This package could not be verified.');
});

test('the discovery and import error codes read well in the add dialog', () => {
  const error = (code: string, body: Record<string, unknown> = {}, status = 422) =>
    ({ status, code, message: 'raw', body }) as const;
  assert.match(appErrorMessage(error('packages_required'), 'discover'), /package names/);
  assert.match(appErrorMessage(error('discover_failed', {}, 502), 'discover'), /could not be read/);
  assert.match(appErrorMessage(error('credential_not_found'), 'discover'), /no longer exists\. Pick another/);
  assert.match(appErrorMessage(error('credential_not_found'), 'import'), /no longer exists\. Pick another/);
  assert.equal(appErrorMessage(error('credential_kind', { message: 'Server says so.' }), 'discover'), 'Server says so.');
  assert.match(appErrorMessage(error('rate_limited', { retryAfterSeconds: 30 }, 429), 'discover'), /too often.*30 seconds/);
  // A sync keeps its own wording.
  assert.match(appErrorMessage(error('rate_limited', { retryAfterSeconds: 30 }, 429), 'sync'), /too many syncs/);
  assert.match(appErrorMessage(error('store_forbidden'), 'discover'), /no access/);
  assert.equal(appErrorMessage(error('timeout', {}, 504), 'discover'), 'The store did not answer in time. Try again.');
});

test('import items carry the store id and name of the selected, addable candidates only', () => {
  const a = candidate({ storeId: '1', identifier: 'com.acme.a', name: ' Alpha ' });
  const b = candidate({ storeId: '2', identifier: 'com.acme.b', name: 'Beta' });
  const old = candidate({ storeId: '3', identifier: 'com.acme.old', alreadyAdded: true });
  const droid = candidate({ platform: 'android', storeId: 'com.acme.d', identifier: 'com.acme.d', name: '' });
  const selected = new Set([candidateKey(a), candidateKey(old), candidateKey(droid)]);
  assert.deepEqual(
    buildImportItems([a, b, old, droid], selected, { [candidateKey(a)]: 'r1', [candidateKey(droid)]: '' }),
    [
      { platform: 'ios', identifier: 'com.acme.a', storeAppId: '1', name: 'Alpha', repositoryId: 'r1' },
      { platform: 'android', identifier: 'com.acme.d', storeAppId: 'com.acme.d' },
    ],
  );
  assert.deepEqual(buildImportItems([a], new Set()), []);
});

test('long lists are split into requests the server accepts, and the answers are joined', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 50), []);
  const part = (identifier: string, status: 'created' | 'skipped' | 'failed'): ImportResult => ({
    results: [{ platform: 'ios', identifier, status, ...(status === 'created' ? { app: app({ id: identifier }) } : {}) }],
    summary: { created: status === 'created' ? 1 : 0, skipped: status === 'skipped' ? 1 : 0, failed: status === 'failed' ? 1 : 0 },
  });
  const merged = mergeImports([part('a', 'created'), part('b', 'skipped'), part('c', 'failed'), part('d', 'created')]);
  assert.deepEqual(merged.summary, { created: 2, skipped: 1, failed: 1 });
  assert.deepEqual(merged.results.map((r) => r.identifier), ['a', 'b', 'c', 'd']);
  assert.deepEqual(importedApps(merged).map((a) => a.id), ['a', 'd']);
});

test('the import summary and the per-item messages are plain sentences', () => {
  assert.equal(importSummaryText({ created: 3, skipped: 0, failed: 0 }), 'Added 3 apps.');
  assert.equal(importSummaryText({ created: 1, skipped: 1, failed: 2 }), 'Added 1 app. 1 was already added, 2 could not be added.');
  assert.equal(importSummaryText({ created: 0, skipped: 2, failed: 0 }), 'No app was added. 2 were already added.');
  assert.equal(importItemMessage({ status: 'skipped', error: 'already_exists' }), 'Already in this workspace.');
  assert.match(importItemMessage({ status: 'failed', error: 'repository_not_found' }), /repository is not connected/);
  assert.equal(importItemMessage({ status: 'failed', error: 'credential_kind', message: 'Wrong kind.' }), 'Wrong kind.');
  assert.equal(importItemMessage({ status: 'created' }), '');
});

test('syncing the imported apps goes one by one, reports progress, and stops on the workspace limit', async () => {
  const seen: string[] = [];
  const fine = {
    async syncApp(_w: string, id: string) {
      seen.push(id);
      return { app: app({ id }), releases: [], sync: { at: now, found: 1, added: 1, updated: 0, removed: 0, unmapped: 0 } };
    },
  };
  const progress: string[] = [];
  const done = await syncApps(fine, 'w1', [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], (results, current) =>
    progress.push(`${current}|${results.map((r) => r.status).join(',')}`),
  );
  assert.deepEqual(seen, ['a', 'b']);
  assert.deepEqual(done.map((r) => r.status), ['ok', 'ok']);
  assert.deepEqual(progress, ['A|running,pending', '|ok,pending', 'B|ok,running', '|ok,ok']);
  assert.equal(batchSummary(done), 'Synced 2 of 2 apps.');

  const calls: string[] = [];
  const limited = {
    async syncApp(_w: string, id: string): Promise<never> {
      calls.push(id);
      if (id === 'a') throw new ApiError(422, 'store_auth', 'raw');
      if (id === 'b') throw new ApiError(409, 'sync_in_progress', 'raw');
      throw new ApiError(429, 'rate_limited', 'raw', 20, { retryAfterSeconds: 20 });
    },
  };
  const stopped = await syncApps(limited, 'w1', [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
    { id: 'd', name: 'D' },
  ]);
  assert.deepEqual(stopped.map((r) => r.status), ['failed', 'busy', 'failed', 'skipped']);
  assert.deepEqual(calls, ['a', 'b', 'c'], 'nothing is sent after the limit');
  assert.match(stopped[3]?.message ?? '', /^Not run: .*20 seconds/);
});

// ---------------------------------------------------------------------------------------------
// The same identifier on iOS and Android (a bundle id equal to a package name) is two apps.

const sameIos = candidate({ platform: 'ios', storeId: '1499117252', identifier: 'com.acme.same', name: 'Same' });
const sameDroid = candidate({ platform: 'android', storeId: 'com.acme.same', identifier: 'com.acme.same', name: 'Same' });

test('the selection key includes the platform, so one identifier on two platforms is two entries', () => {
  assert.notEqual(candidateKey(sameIos), candidateKey(sameDroid));
  assert.equal(candidateKey(sameIos), 'ios:com.acme.same');
  assert.equal(candidateKey(sameDroid), 'android:com.acme.same');
  // Ticking one does not tick the other, and unticking one keeps the other.
  const one = withSelection(new Set(), candidateKey(sameIos), true);
  assert.equal(one.has(candidateKey(sameDroid)), false);
  const both = withSelection(one, candidateKey(sameDroid), true);
  assert.equal(both.size, 2);
  assert.deepEqual([...withSelection(both, candidateKey(sameIos), false)], [candidateKey(sameDroid)]);
  // A list that holds both keeps both items, in order, each with its own store id.
  assert.deepEqual(buildImportItems([sameIos, sameDroid], both), [
    { platform: 'ios', identifier: 'com.acme.same', storeAppId: '1499117252', name: 'Same' },
    { platform: 'android', identifier: 'com.acme.same', storeAppId: 'com.acme.same', name: 'Same' },
  ]);
  assert.deepEqual(
    buildImportItems([sameIos, sameDroid], one).map((i) => i.platform),
    ['ios'],
  );
});

test('already added is decided per candidate: the other platform stays selectable', () => {
  const droidAdded = { ...sameDroid, alreadyAdded: true, appId: 'a2' };
  assert.deepEqual(selectableCandidates([sameIos, droidAdded]), [sameIos]);
  assert.equal(
    discoverSummaryText({ kind: 'app_store_connect', candidates: [sameIos], failures: [] }),
    'Found 1 app.',
  );
  assert.equal(
    discoverSummaryText({ kind: 'google_play', candidates: [droidAdded], failures: [] }),
    'Checked 1 package: 1 verified. 1 already added.',
  );
  // Chunking never merges or drops items: both land in some piece.
  const pieces = chunk(buildImportItems([sameIos, sameDroid], new Set([candidateKey(sameIos), candidateKey(sameDroid)])), 1);
  assert.deepEqual(pieces.map((p) => p.map((i) => i.platform)), [['ios'], ['android']]);
});

test('merged imports and the summary keep both apps and name the platform', () => {
  const part = (platform: 'ios' | 'android', id: string): ImportResult => ({
    results: [{ platform, identifier: 'com.acme.same', status: 'created', app: app({ id, platform, identifier: 'com.acme.same' }) }],
    summary: { created: 1, skipped: 0, failed: 0 },
  });
  const merged = mergeImports([part('ios', 'a1'), part('android', 'a2')]);
  assert.deepEqual(merged.summary, { created: 2, skipped: 0, failed: 0 });
  assert.deepEqual(importedApps(merged).map((a) => [a.id, a.platform]), [['a1', 'ios'], ['a2', 'android']]);
  assert.equal(importSummaryText(merged.summary, merged.results), 'Added 1 Android app and 1 iOS app.');
  const iosOnly = mergeImports([part('ios', 'a1')]);
  assert.equal(importSummaryText(iosOnly.summary, iosOnly.results), 'Added 1 iOS app.');
  assert.equal(
    importSummaryText({ created: 2, skipped: 1, failed: 0 }, [
      { platform: 'android', status: 'created' },
      { platform: 'android', status: 'created' },
      { platform: 'android', status: 'skipped' },
    ]),
    'Added 2 Android apps. 1 was already added.',
  );
  // Without the items the plain text is unchanged.
  assert.equal(importSummaryText({ created: 2, skipped: 0, failed: 0 }), 'Added 2 apps.');
});

test('labels and notes tell the platforms apart', () => {
  assert.equal(appLabel({ name: 'Same', platform: 'ios' }), 'Same (iOS)');
  assert.equal(appLabel({ name: 'Same', platform: 'android' }), 'Same (Android)');
  assert.equal(platformCount('ios', 1), '1 iOS app');
  assert.equal(platformCount('android', 2), '2 Android apps');
  assert.match(importScopeNote('ios'), /iOS and macOS apps only.*Android app with the same identifier.*Google Play credential/);
  assert.equal(importScopeNote('macos'), importScopeNote('ios'));
  assert.match(importScopeNote('android'), /Android apps only.*iOS or macOS app with the same identifier.*App Store Connect credential/);
});

test('sync results name the platform, so two apps with one name are not confused', async () => {
  const api = {
    async syncApp(_w: string, id: string) {
      if (id === 'a2') throw new ApiError(422, 'store_auth', 'raw');
      return { app: app({ id }), releases: [], sync: { at: now, found: 1, added: 1, updated: 0, removed: 0, unmapped: 0 } };
    },
  };
  const seen: string[] = [];
  const results = await syncApps(
    api,
    'w1',
    [app({ id: 'a1', name: 'Same', platform: 'ios' }), app({ id: 'a2', name: 'Same', platform: 'android' })],
    (_r, current) => {
      if (current) seen.push(current);
    },
  );
  assert.deepEqual(results.map((r) => [r.appId, r.name, r.status]), [
    ['a1', 'Same (iOS)', 'ok'],
    ['a2', 'Same (Android)', 'failed'],
  ]);
  assert.deepEqual(seen, ['Same (iOS)', 'Same (Android)']);
  assert.deepEqual(sortApps([app({ id: 'a2', name: 'Same', platform: 'android' }), app({ id: 'a1', name: 'Same', platform: 'ios' })]).map((a) => a.platform), ['ios', 'android']);
});
