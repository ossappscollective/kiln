import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GithubError,
  type StoreApp,
  type StoreBuild,
  type StoreConnector,
  type StoreVersion,
} from '@mrm/connectors';
import type { Platform } from '@mrm/core';
import { dbTest } from '@mrm/db/testing';
import { bootRepoApp } from './repo-test-helpers.ts';
import { createEventStreamHub } from './routes/events.ts';
import type { StoreConnectorFactory } from './services/apps.ts';
import {
  emitEvent,
  eventFromAudit,
  listEvents,
  pruneEvents,
  redactPayload,
  releaseStatusChanges,
} from './services/events.ts';
import { seedWorkspace } from './testkit.ts';

type Boot = Awaited<ReturnType<typeof bootRepoApp>>;
type Options = NonNullable<Parameters<typeof bootRepoApp>[2]>;
const boot = (
  db: Parameters<typeof bootRepoApp>[0],
  overrides: Options = {},
  repo?: Parameters<typeof bootRepoApp>[1],
) => bootRepoApp(db, repo, overrides);

// biome-ignore lint/suspicious/noExplicitAny: test responses are inspected loosely
const json = async (res: Response) => (await res.json()) as Record<string, any>;

const bearer = (t: Boot, token: string, path: string, workspace = t.workspaceId) =>
  t.app.request(`/api/workspaces/${workspace}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });

async function makeToken(t: Boot, input: Record<string, unknown> = {}) {
  const res = await t.call(t.owner, 'POST', '/tokens', { name: 'CI', role: 'admin', ...input });
  return res.body.token as string;
}

const types = (events: { type: string }[]) => events.map((e) => e.type);

// ----- emitting and reading ------------------------------------------------------------------

dbTest('emitEvent stores the event with its subject and returns it', async (db) => {
  const t = await boot(db);
  const event = await emitEvent(db, {
    workspaceId: t.workspaceId,
    type: 'app.synced',
    subject: { appId: 'a1' },
    payload: { found: 3 },
    at: 1234,
  });
  assert.equal(typeof event.id, 'number');
  assert.deepEqual(event.subject, { appId: 'a1' });
  assert.equal(event.createdAt, 1234);
  const [row] = await db.query('SELECT * FROM events');
  assert.equal(row?.workspace_id, t.workspaceId);
  assert.equal(row?.app_id, 'a1');
  assert.equal(row?.repository_id, null);
  assert.deepEqual(JSON.parse(String(row?.payload)), { found: 3 });
  const second = await emitEvent(db, { workspaceId: t.workspaceId, type: 'app.synced' });
  assert.ok(second.id > event.id);
});

test('redactPayload drops secret-looking keys, functions and undefined, at any depth', () => {
  const out = redactPayload({
    ok: 1,
    token: 'x',
    nested: { password: 'p', fine: [{ secret: 's', keep: 'k' }], api_key: 'a', undef: undefined },
    fn: () => 1,
    prUrl: 'https://github.com/a/b/pull/1',
    bad: Number.POSITIVE_INFINITY,
  });
  assert.deepEqual(out, {
    ok: 1,
    nested: { fine: [{ keep: 'k' }] },
    prUrl: 'https://github.com/a/b/pull/1',
    bad: null,
  });
});

dbTest(
  'an oversized payload is replaced by a marker, and secrets never reach the table',
  async (db) => {
    const t = await boot(db);
    await emitEvent(db, {
      workspaceId: t.workspaceId,
      type: 'app.synced',
      payload: { blob: 'x'.repeat(40_000) },
    });
    await emitEvent(db, {
      workspaceId: t.workspaceId,
      type: 'app.synced',
      payload: { accessToken: 'sekrit', a: 1 },
    });
    const rows = await db.query('SELECT payload FROM events ORDER BY id');
    assert.deepEqual(JSON.parse(String(rows[0]?.payload)), { truncated: true });
    assert.deepEqual(JSON.parse(String(rows[1]?.payload)), { a: 1 });
  },
);

dbTest(
  'listEvents pages by id, filters by type and app, and keeps workspaces apart',
  async (db) => {
    const t = await boot(db);
    const other = await seedWorkspace(db, 'Other', 'o@x.io', Date.now());
    for (let i = 1; i <= 5; i++) {
      await emitEvent(db, {
        workspaceId: t.workspaceId,
        type: i % 2 ? 'app.synced' : 'changeset.created',
        subject: i % 2 ? { appId: `a${i}` } : {},
        payload: { i },
      });
    }
    await emitEvent(db, { workspaceId: other.workspaceId, type: 'app.synced', payload: { i: 99 } });

    const all = await listEvents(db, t.workspaceId, { since: 0 });
    assert.equal(all.events.length, 5);
    assert.equal(all.hasMore, false);
    assert.ok(all.events.every((e) => e.workspaceId === t.workspaceId));
    const firstPage = await listEvents(db, t.workspaceId, { since: 0, limit: 2 });
    assert.equal(firstPage.hasMore, true);
    const next = await listEvents(db, t.workspaceId, { since: firstPage.events[1]?.id, limit: 2 });
    assert.deepEqual(
      next.events.map((e) => e.payload.i),
      [3, 4],
    );
    // No cursor: the newest, oldest first.
    assert.deepEqual(
      (await listEvents(db, t.workspaceId, { limit: 2 })).events.map((e) => e.payload.i),
      [4, 5],
    );
    assert.deepEqual(
      types(
        (await listEvents(db, t.workspaceId, { since: 0, types: ['changeset.created'] })).events,
      ),
      ['changeset.created', 'changeset.created'],
    );
    assert.deepEqual(
      (await listEvents(db, t.workspaceId, { since: 0, appIds: ['a3', 'a5'] })).events.map(
        (e) => e.payload.i,
      ),
      [3, 5],
    );
    assert.deepEqual((await listEvents(db, t.workspaceId, { since: 0, appIds: [] })).events, []);
    assert.equal(await pruneEvents(db, Date.now() + 91 * 24 * 3600_000), 6);
  },
);

// ----- the endpoint ---------------------------------------------------------------------------

dbTest('GET /events: cursor paging, filters, validation, rights and isolation', async (db) => {
  const t = await boot(db);
  for (let i = 1; i <= 4; i++)
    await emitEvent(db, {
      workspaceId: t.workspaceId,
      type: 'app.synced',
      subject: { appId: 'a' },
      payload: { i },
    });
  await emitEvent(db, { workspaceId: t.workspaceId, type: 'changeset.created', payload: { i: 5 } });

  const page = await t.call(t.owner, 'GET', '/events?since=0&limit=2');
  assert.equal(page.status, 200);
  assert.deepEqual(
    page.body.events.map((e: { payload: { i: number } }) => e.payload.i),
    [1, 2],
  );
  assert.equal(page.body.hasMore, true);
  assert.equal(page.body.nextCursor, page.body.events[1].id);
  const rest = await t.call(t.owner, 'GET', `/events?since=${page.body.nextCursor}&limit=10`);
  assert.deepEqual(
    rest.body.events.map((e: { payload: { i: number } }) => e.payload.i),
    [3, 4, 5],
  );
  assert.equal(rest.body.hasMore, false);
  // Nothing new: the cursor stays where it was.
  const none = await t.call(t.owner, 'GET', `/events?since=${rest.body.nextCursor}`);
  assert.deepEqual(none.body, { events: [], hasMore: false, nextCursor: rest.body.nextCursor });
  assert.deepEqual(
    types((await t.call(t.owner, 'GET', '/events?type=changeset.created')).body.events),
    ['changeset.created'],
  );
  assert.equal((await t.call(t.owner, 'GET', '/events?type=nope')).status, 400);
  for (const bad of ['since=abc', 'since=-1', 'limit=0', 'limit=201', 'limit=x']) {
    assert.equal((await t.call(t.owner, 'GET', `/events?${bad}`)).status, 400, bad);
  }
  assert.equal((await t.app.request(`/api/workspaces/${t.workspaceId}/events`)).status, 401);
  assert.equal((await t.call(t.owner, 'GET', '/events', undefined, 'nope')).status, 404);

  // Another workspace sees none of it, and a non-member gets 404.
  const other = await seedWorkspace(db, 'Other', 'o@x.io', Date.now());
  assert.deepEqual(
    (await t.call(other.cookie, 'GET', '/events?since=0', undefined, other.workspaceId)).body
      .events,
    [],
  );
  assert.equal((await t.call(other.cookie, 'GET', '/events?since=0')).status, 404);
});

dbTest(
  'who sees which events: an event is visible to those who may read what it is about',
  async (db) => {
    const t = await boot(db);
    const viewer = await t.addMember('viewer');
    const member = await t.addMember('member');
    for (const type of ['app.synced', 'changeset.created', 'credential.test_failed'] as const) {
      await emitEvent(db, { workspaceId: t.workspaceId, type });
    }
    assert.deepEqual(types((await t.call(t.owner, 'GET', '/events?since=0')).body.events), [
      'app.synced',
      'changeset.created',
      'credential.test_failed',
    ]);
    assert.deepEqual(types((await t.call(member, 'GET', '/events?since=0')).body.events), [
      'app.synced',
      'changeset.created',
      'credential.test_failed',
    ]);
    // A viewer reads apps and repositories but not credentials.
    assert.deepEqual(types((await t.call(viewer, 'GET', '/events?since=0')).body.events), [
      'app.synced',
      'changeset.created',
    ]);
    assert.deepEqual(
      (await t.call(viewer, 'GET', '/events?since=0&type=credential.test_failed')).body.events,
      [],
    );
    // Same for a token with the viewer ceiling, even though its creator is the owner.
    const viewerToken = await makeToken(t, { role: 'viewer' });
    const viaToken = await json(await bearer(t, viewerToken, '/events?since=0'));
    assert.deepEqual(types(viaToken.events), ['app.synced', 'changeset.created']);
    // A token whose action list leaves out events.read gets nothing at all.
    const noEvents = await makeToken(t, { actions: ['apps.read'] });
    assert.equal((await bearer(t, noEvents, '/events')).status, 403);
  },
);

dbTest('an app restricted token sees only events about its apps', async (db) => {
  const t = await boot(db);
  for (const id of ['a1', 'a2']) {
    await db.execute(
      `INSERT INTO apps (id, workspace_id, name, platform, identifier, credential_id, created_at) VALUES (?, ?, ?, 'ios', ?, 'c', 1)`,
      [id, t.workspaceId, id, `com.x.${id}`],
    );
  }
  await emitEvent(db, {
    workspaceId: t.workspaceId,
    type: 'app.synced',
    subject: { appId: 'a1' },
    payload: { n: 1 },
  });
  await emitEvent(db, {
    workspaceId: t.workspaceId,
    type: 'app.synced',
    subject: { appId: 'a2' },
    payload: { n: 2 },
  });
  await emitEvent(db, { workspaceId: t.workspaceId, type: 'changeset.created', payload: { n: 3 } });
  const token = await makeToken(t, { appIds: ['a1'] });
  const seen = await json(await bearer(t, token, '/events?since=0'));
  assert.deepEqual(
    seen.events.map((e: { payload: { n: number } }) => e.payload.n),
    [1],
  );
  const all = await json(await bearer(t, await makeToken(t), '/events?since=0'));
  // Making the tokens above wrote a token.created event each (alerts need it); the three emitted here are the rest.
  assert.equal(all.events.filter((e: { type: string }) => e.type !== 'token.created').length, 3);
});

// ----- events from the services ---------------------------------------------------------------

const KEY_LINE = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDTOPSECRETKEYBODY';
const ASC_SECRET = JSON.stringify({
  keyId: 'ABC123DEFG',
  issuerId: 'issuer-1',
  privateKey: `-----BEGIN PRIVATE KEY-----\n${KEY_LINE}\n-----END PRIVATE KEY-----`,
});

const version = (
  versionString: string,
  rawState: string,
  lifecycleState?: StoreVersion['lifecycleState'],
): StoreVersion => ({
  storeId: `v-${versionString}`,
  appStoreId: '1234567890',
  platform: 'ios',
  versionString,
  rawState,
  ...(lifecycleState ? { lifecycleState } : {}),
});

class FakeStore implements StoreConnector {
  readonly platform: Platform = 'ios';
  versions: StoreVersion[] = [];
  async verifyCredentials() {}
  async listApps(): Promise<StoreApp[]> {
    return [{ storeId: '1234567890', platform: 'ios', name: 'Acme', bundleId: 'com.acme.app' }];
  }
  async listVersions() {
    return this.versions;
  }
  async listBuilds(): Promise<StoreBuild[]> {
    return [];
  }
}

dbTest(
  'a sync emits app.synced, and app.release.status_changed when a status moved',
  async (db) => {
    const store = new FakeStore();
    const factory: StoreConnectorFactory = () => store;
    const t = await boot(db, { appSync: { connectorFactory: factory } });
    const credentialId = await t.addCredential('app_store_connect', ASC_SECRET);
    const created = await t.call(t.owner, 'POST', '/apps', {
      platform: 'ios',
      identifier: 'com.acme.app',
      credentialId,
    });
    const appId = created.body.app.id as string;
    const events = async () =>
      (await t.call(t.owner, 'GET', '/events?since=0&limit=100')).body.events as {
        type: string;
        subject: { appId?: string; releaseId?: string };
        payload: Record<string, unknown>;
      }[];

    // First sync: a quiet baseline. Only app.synced.
    store.versions = [version('1.0', 'WAITING_FOR_REVIEW', 'in_review')];
    assert.equal((await t.call(t.owner, 'POST', `/apps/${appId}/sync`)).status, 200);
    let seen = await events();
    assert.deepEqual(types(seen), ['app.synced']);
    assert.deepEqual(seen[0]?.subject, { appId });
    assert.equal(seen[0]?.payload.found, 1);
    assert.equal(seen[0]?.payload.added, 1);
    assert.equal(seen[0]?.payload.statusChanges, 0);
    assert.equal(seen[0]?.payload.trigger, 'request');

    // Same data again: synced, nothing changed.
    await t.call(t.owner, 'POST', `/apps/${appId}/sync`);
    seen = await events();
    assert.deepEqual(types(seen), ['app.synced', 'app.synced']);

    // The status moves, and a new version appears.
    store.versions = [
      version('1.0', 'PENDING_DEVELOPER_RELEASE', 'approved'),
      version('1.1', 'PREPARE_FOR_SUBMISSION', 'draft'),
    ];
    await t.call(t.owner, 'POST', `/apps/${appId}/sync`);
    seen = await events();
    assert.deepEqual(types(seen).slice(2), [
      'app.release.status_changed',
      'app.release.status_changed',
      'app.synced',
    ]);
    const changed = seen.filter((e) => e.type === 'app.release.status_changed');
    const moved = changed.find((e) => e.payload.version === '1.0');
    assert.equal(moved?.payload.from, 'in_review');
    assert.equal(moved?.payload.to, 'approved');
    assert.ok(moved?.subject.releaseId, 'an existing release has an id');
    const added = changed.find((e) => e.payload.version === '1.1');
    assert.equal(added?.payload.from, null);
    assert.equal(added?.payload.to, 'draft');
    assert.equal(added?.subject.releaseId, undefined);
    assert.equal(seen.at(-1)?.payload.statusChanges, 2);
    // No event holds anything that looks like a credential.
    assert.equal(JSON.stringify(seen).includes(KEY_LINE), false);
  },
);

test('releaseStatusChanges: baseline, move, new, removed and unchanged', () => {
  const before = new Map<string, Record<string, unknown>>([
    ['t\u00001.0', { id: 'r1', status: 'in_review' }],
    ['t\u00002.0', { id: 'r2', status: null }],
    ['t\u00003.0', { id: 'r3', status: 'live' }],
  ]);
  const release = (v: string, status: string | null) => ({
    version: v,
    track: 't',
    build: null,
    status,
  });
  const after = new Map([
    ['t\u00001.0', release('1.0', 'approved')],
    ['t\u00002.0', release('2.0', 'draft')],
    ['t\u00003.0', release('3.0', 'live')],
    ['t\u00004.0', release('4.0', 'draft')],
    ['t\u00005.0', release('5.0', null)],
  ]);
  const changes = releaseStatusChanges(before, after, true);
  assert.deepEqual(
    changes.map((c) => [c.version, c.from, c.to, c.releaseId]),
    [
      ['1.0', 'in_review', 'approved', 'r1'],
      ['2.0', null, 'draft', 'r2'],
      ['4.0', null, 'draft', null],
    ],
  );
  // Not baselined: existing releases still report moves, new ones stay quiet.
  assert.deepEqual(
    releaseStatusChanges(before, after, false).map((c) => c.version),
    ['1.0', '2.0'],
  );
});

dbTest('change sets emit created, approved, applied and failed, naming who did it', async (db) => {
  const t = await boot(db);
  const { repositoryId } = await t.connect();
  const first = await t.draft(repositoryId, 'One');
  assert.equal((await t.call(t.owner, 'POST', `/change-sets/${first.id}/approve`)).status, 200);
  assert.equal((await t.call(t.owner, 'POST', `/change-sets/${first.id}/apply`)).status, 200);
  const second = await t.draft(repositoryId, 'Two');
  await t.call(t.owner, 'POST', `/change-sets/${second.id}/approve`);
  t.repo.proposeErrors.push(new GithubError('forbidden', 'No write access.', 403));
  const failed = await t.call(t.owner, 'POST', `/change-sets/${second.id}/apply`);
  assert.notEqual(failed.status, 200);

  const events = (await t.call(t.owner, 'GET', '/events?since=0')).body.events as {
    type: string;
    subject: { repositoryId?: string };
    payload: Record<string, any>;
  }[];
  assert.deepEqual(types(events), [
    'changeset.created',
    'changeset.approved',
    'changeset.applied',
    'changeset.created',
    'changeset.approved',
    'changeset.failed',
  ]);
  assert.equal(events[0]?.subject.repositoryId, repositoryId);
  assert.equal(events[0]?.payload.changeSetId, first.id);
  assert.equal(events[0]?.payload.actor.type, 'user');
  assert.match(String(events[2]?.payload.prUrl), /^https:\/\/github\.com\//);
  assert.equal(events[2]?.payload.branch !== undefined, true);
  assert.equal(events[5]?.payload.changeSetId, second.id);
  assert.equal(typeof events[5]?.payload.reason, 'string');
  // The change set content never travels in an event.
  assert.equal(JSON.stringify(events).includes('New subtitle'), false);
  assert.equal(JSON.stringify(events).includes('"files":['), false);
});

dbTest(
  'a failed credential test emits credential.test_failed; a passing one does not',
  async (db) => {
    const verdict = { ok: false };
    const t = await boot(db, {
      credentialTests: {
        verifiers: () => async () => ({
          ok: verdict.ok,
          message: 'Nope: ghp_SECRETTOKEN1234567890abcdef',
        }),
      },
    });
    const credentialId = await t.addCredential();
    assert.equal((await t.call(t.owner, 'POST', `/credentials/${credentialId}/test`)).status, 200);
    verdict.ok = true;
    await t.call(t.owner, 'POST', `/credentials/${credentialId}/test`);
    verdict.ok = false;
    await t.call(t.owner, 'POST', '/credentials/test', {
      kind: 'github_token',
      secret: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    });
    const events = (await t.call(t.owner, 'GET', '/events?since=0')).body.events as {
      type: string;
      payload: Record<string, unknown>;
    }[];
    assert.deepEqual(types(events), ['credential.test_failed', 'credential.test_failed']);
    assert.equal(events[0]?.payload.credentialId, credentialId);
    assert.equal(events[0]?.payload.saved, true);
    assert.equal(events[1]?.payload.credentialId, null);
    assert.equal(events[1]?.payload.kind, 'github_token');
    assert.equal(
      JSON.stringify(events).includes('ghp_'),
      false,
      'the test message is not forwarded',
    );
  },
);

test('eventFromAudit maps only the audited actions it knows', () => {
  const base = { workspaceId: 'w', actor: { type: 'user', id: 'u' }, at: 5 };
  assert.equal(eventFromAudit({ ...base, action: 'app.create' }), undefined);
  assert.equal(
    eventFromAudit({ ...base, action: 'credential.test', detail: { ok: true } }),
    undefined,
  );
  assert.equal(
    eventFromAudit({
      ...base,
      action: 'changeset.discard',
      target: { type: 'change_set', id: 'c' },
    }),
    undefined,
  );
  assert.equal(
    eventFromAudit({
      ...base,
      action: 'changeset.apply_timeout',
      target: { type: 'change_set', id: 'c' },
    })?.type,
    'changeset.failed',
  );
});

// ----- the live stream ------------------------------------------------------------------------

/** Reads a stream into text, so a test can wait for something to arrive without sleeping blindly. */
function reader(res: Response) {
  const body = res.body;
  assert.ok(body, 'the stream has a body');
  const source = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let ended = false;
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await source.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      // cancelled
    }
    ended = true;
  })();
  return {
    get text() {
      return text;
    },
    get ended() {
      return ended;
    },
    async until(predicate: (text: string) => boolean, ms = 3000) {
      const deadline = Date.now() + ms;
      while (!predicate(text)) {
        if (Date.now() > deadline) assert.fail(`timed out waiting; got: ${JSON.stringify(text)}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    async stop() {
      await source.cancel().catch(() => {});
      await pump;
    },
  };
}

const frames = (text: string) =>
  text
    .split('\n\n')
    .filter((f) => f.trim() !== '')
    .map((f) => {
      const out: Record<string, string> = {};
      for (const line of f.split('\n')) {
        if (line.startsWith(':')) out.comment = line.slice(1).trim();
        else {
          const at = line.indexOf(':');
          if (at > 0) out[line.slice(0, at)] = line.slice(at + 1).trim();
        }
      }
      return out;
    });

const stream = (t: Boot, headers: Record<string, string>, query = '', workspace = t.workspaceId) =>
  t.app.request(`/api/workspaces/${workspace}/events/stream${query}`, { headers });

dbTest('the stream says ready, then delivers new events with their id and type', async (db) => {
  const hub = createEventStreamHub({ pollMs: 20, heartbeatMs: 60_000 });
  const t = await boot(db, { eventStreams: hub });
  await emitEvent(db, {
    workspaceId: t.workspaceId,
    type: 'app.synced',
    payload: { before: true },
  });
  const res = await stream(t, { cookie: t.owner });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.equal(res.headers.get('x-accel-buffering'), 'no');
  const r = reader(res);
  try {
    await r.until((s) => s.includes('event: ready'));
    // Without a cursor the stream starts at "now": the earlier event is not replayed.
    const created = await emitEvent(db, {
      workspaceId: t.workspaceId,
      type: 'changeset.created',
      payload: { n: 1 },
    });
    await r.until((s) => s.includes('event: changeset.created'));
    const got = frames(r.text).find((f) => f.event === 'changeset.created');
    assert.equal(got?.id, String(created.id));
    assert.equal(JSON.parse(got?.data ?? '{}').payload.n, 1);
    assert.equal(r.text.includes('"before":true'), false);
    assert.equal(hub.size, 1);
  } finally {
    await r.stop();
  }
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(hub.size, 0, 'the stream is given back when the client goes');
});

dbTest(
  'Last-Event-ID and ?since= resume without gaps or repeats; type filters apply',
  async (db) => {
    const hub = createEventStreamHub({ pollMs: 20, heartbeatMs: 60_000 });
    const t = await boot(db, { eventStreams: hub });
    const a = await emitEvent(db, {
      workspaceId: t.workspaceId,
      type: 'app.synced',
      payload: { n: 1 },
    });
    await emitEvent(db, {
      workspaceId: t.workspaceId,
      type: 'changeset.created',
      payload: { n: 2 },
    });
    await emitEvent(db, { workspaceId: t.workspaceId, type: 'app.synced', payload: { n: 3 } });

    const viaHeader = reader(await stream(t, { cookie: t.owner, 'last-event-id': String(a.id) }));
    const viaQuery = reader(await stream(t, { cookie: t.owner }, `?since=${a.id}&type=app.synced`));
    try {
      await viaHeader.until((s) => s.includes('"n":3'));
      assert.deepEqual(
        frames(viaHeader.text)
          .filter((f) => f.id)
          .map((f) => JSON.parse(f.data ?? '{}').payload.n),
        [2, 3],
      );
      await viaQuery.until((s) => s.includes('"n":3'));
      assert.deepEqual(
        frames(viaQuery.text)
          .filter((f) => f.id)
          .map((f) => JSON.parse(f.data ?? '{}').payload.n),
        [3],
      );
    } finally {
      await viaHeader.stop();
      await viaQuery.stop();
    }
  },
);

dbTest('the stream refuses bad input, outsiders and anonymous callers', async (db) => {
  const t = await boot(db);
  assert.equal((await stream(t, {})).status, 401);
  assert.equal((await stream(t, { cookie: t.owner }, '?type=bogus')).status, 400);
  assert.equal((await stream(t, { cookie: t.owner }, '?since=abc')).status, 400);
  assert.equal((await stream(t, { cookie: t.owner, 'last-event-id': '-1' })).status, 400);
  const other = await seedWorkspace(db, 'Other', 'o@x.io', Date.now());
  assert.equal((await stream(t, { cookie: other.cookie })).status, 404);
});

dbTest(
  'another workspace never reaches the stream, and a viewer never sees credential events',
  async (db) => {
    const hub = createEventStreamHub({ pollMs: 20, heartbeatMs: 60_000 });
    const t = await boot(db, { eventStreams: hub });
    const viewer = await t.addMember('viewer');
    const other = await seedWorkspace(db, 'Other', 'o@x.io', Date.now());
    const r = reader(await stream(t, { cookie: viewer }));
    try {
      await r.until((s) => s.includes('event: ready'));
      await emitEvent(db, {
        workspaceId: other.workspaceId,
        type: 'app.synced',
        payload: { leak: true },
      });
      await emitEvent(db, {
        workspaceId: t.workspaceId,
        type: 'credential.test_failed',
        payload: { leak: 'credential' },
      });
      await emitEvent(db, {
        workspaceId: t.workspaceId,
        type: 'app.synced',
        payload: { mine: true },
      });
      await r.until((s) => s.includes('"mine":true'));
      assert.equal(r.text.includes('leak'), false);
    } finally {
      await r.stop();
    }
  },
);

dbTest('a person may hold only a few streams; the cap frees up when one closes', async (db) => {
  const hub = createEventStreamHub({ pollMs: 20, heartbeatMs: 60_000, maxPerUser: 2 });
  const t = await boot(db, { eventStreams: hub });
  const other = await t.addMember('member');
  const one = reader(await stream(t, { cookie: t.owner }));
  const two = reader(await stream(t, { cookie: t.owner }));
  try {
    await one.until((s) => s.includes('event: ready'));
    await two.until((s) => s.includes('event: ready'));
    const refused = await stream(t, { cookie: t.owner });
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('retry-after'), '5');
    assert.equal((await json(refused)).error, 'too_many_streams');
    // Someone else is not affected by it.
    const theirs = reader(await stream(t, { cookie: other }));
    await theirs.until((s) => s.includes('event: ready'));
    await theirs.stop();
    await one.stop();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const again = await stream(t, { cookie: t.owner });
    assert.equal(again.status, 200);
    await again.body?.cancel();
  } finally {
    await one.stop();
    await two.stop();
  }
});

dbTest('a quiet stream sends heartbeats', async (db) => {
  const hub = createEventStreamHub({ pollMs: 10, heartbeatMs: 30 });
  const t = await boot(db, { eventStreams: hub });
  const r = reader(await stream(t, { cookie: t.owner }));
  try {
    await r.until((s) => s.includes(': heartbeat'));
  } finally {
    await r.stop();
  }
});

dbTest('closeAll ends every open stream and refuses new ones (clean shutdown)', async (db) => {
  const hub = createEventStreamHub({ pollMs: 20, heartbeatMs: 60_000 });
  const t = await boot(db, { eventStreams: hub });
  const r = reader(await stream(t, { cookie: t.owner }));
  await r.until((s) => s.includes('event: ready'));
  hub.closeAll();
  await r.until(() => r.ended);
  assert.equal(hub.size, 0);
  assert.equal((await stream(t, { cookie: t.owner })).status, 429);
});

dbTest('a bearer token can stream, and revoking it ends the stream', async (db) => {
  const hub = createEventStreamHub({ pollMs: 10, heartbeatMs: 40 });
  const t = await boot(db, { eventStreams: hub });
  const created = await t.call(t.owner, 'POST', '/tokens', { name: 'Stream', role: 'viewer' });
  const token = created.body.token as string;
  const id = created.body.summary?.id ?? created.body.apiToken?.id ?? (created.body.id as string);
  const res = await bearer(t, token, '/events/stream');
  assert.equal(res.status, 200);
  const r = reader(res);
  try {
    await r.until((s) => s.includes('event: ready'));
    await emitEvent(db, { workspaceId: t.workspaceId, type: 'app.synced', payload: { n: 1 } });
    await r.until((s) => s.includes('event: app.synced'));
    assert.equal((await t.call(t.owner, 'DELETE', `/tokens/${id}`)).status, 204);
    await r.until(() => r.ended, 3000);
  } finally {
    await r.stop();
  }
});

dbTest('removing a member ends their stream at the next heartbeat', async (db) => {
  const hub = createEventStreamHub({ pollMs: 10, heartbeatMs: 40 });
  const t = await boot(db, { eventStreams: hub });
  const member = await t.addMember('member');
  const r = reader(await stream(t, { cookie: member }));
  try {
    await r.until((s) => s.includes('event: ready'));
    await db.query("DELETE FROM workspace_members WHERE role = 'member'");
    await r.until(() => r.ended, 3000);
  } finally {
    await r.stop();
  }
});

test('the web screen offers exactly the event types the server emits', async () => {
  const { readFile } = await import('node:fs/promises');
  const { eventTypes } = await import('./services/event-types.ts');
  const source = await readFile(new URL('../../web/src/lib/webhooks.ts', import.meta.url), 'utf8');
  const offered = [...source.matchAll(/type: '([a-z._]+)',\s*label:/g)].map((m) => m[1]);
  assert.deepEqual(
    [...offered].sort(),
    [...eventTypes].sort(),
    'update webhookEventChoices in apps/web/src/lib/webhooks.ts',
  );
});
