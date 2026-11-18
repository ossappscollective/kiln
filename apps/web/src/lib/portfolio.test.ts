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
  batchSummary,
  classifySyncError,
  compareVersions,
  credentialsFor,
  describeError,
  formatRollout,
  groupReleases,
  latestByPlatform,
  latestRelease,
  lifecyclePath,
  liveRelease,
  notRunMessage,
  parseRoute,
  runLimited,
  sortApps,
  statusInfo,
  syncApp,
  syncInfo,
  syncSummaryText,
  timeline,
  trackLabel,
  validateDraft,
} from './portfolio.ts';
import type { AppSummary, ReleaseSummary } from './types.ts';

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
