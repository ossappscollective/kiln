import assert from 'node:assert/strict';
import {
  StoreError,
  type StoreVersionRow,
  VersionDriftError,
  type VersionCreateInput,
  type VersionCreateResult,
  type VersionListState,
  VersionOutcomeUnknownError,
} from '@mrm/connectors';
import { dbTest } from '@mrm/db/testing';
import { setPolicy } from './services/step-up.ts';
import type { VersionConnector, VersionConnectorInput } from './services/store-version.ts';
import { bootStaged, type StagedBoot } from './staged-test-helpers.ts';

/**
 * Creating the next App Store version (docs/api/store-version.md, docs/adr/0031-create-app-store-version.md). Everything runs
 * against a fake: no store is contacted.
 */

const HASH = 'a'.repeat(64);
const row = (id: string, versionString: string, state: string): StoreVersionRow => ({
  id,
  versionString,
  state,
  editable: ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'].includes(state),
});

type Behavior =
  | { kind: 'ok' }
  | { kind: 'refuse'; error: StoreError }
  /** The create is sent and no answer comes back; `applied` says whether the store applied it anyway. */
  | { kind: 'unknown'; applied: boolean; unreadable?: boolean };

class FakeVersionStore implements VersionConnector {
  versions: StoreVersionRow[] = [row('v1', '3.1.1', 'READY_FOR_SALE'), row('v0', '3.0', 'REPLACED_WITH_NEW_VERSION')];
  behavior: Behavior = { kind: 'ok' };
  reads = 0;
  creates: VersionCreateInput['request'][] = [];
  /** Runs once, between the preview's read and the write's read. */
  beforeNextRead: (() => void) | undefined;
  #unreadable = false;
  readonly platform: 'ios' | 'macos';
  constructor(platform: 'ios' | 'macos' = 'ios') {
    this.platform = platform;
  }
  async readVersions(): Promise<VersionListState> {
    this.reads++;
    if (this.#unreadable) throw new StoreError('appstoreconnect', 'server', 'down', 503);
    const hook = this.beforeNextRead;
    this.beforeNextRead = undefined;
    hook?.();
    return { store: 'appstoreconnect', platform: this.platform, versions: this.versions.map((v) => ({ ...v })) };
  }
  async createVersion(input: VersionCreateInput): Promise<VersionCreateResult> {
    const before = await this.readVersions();
    if (!input.guard(before)) throw new VersionDriftError(before);
    this.creates.push(input.request);
    const b = this.behavior;
    if (b.kind === 'refuse') throw b.error;
    if (b.kind === 'unknown') {
      if (b.applied) this.versions.push(row('v-new', input.request.versionString, 'PREPARE_FOR_SUBMISSION'));
      this.#unreadable = b.unreadable === true;
      throw new VersionOutcomeUnknownError('lost the answer');
    }
    this.versions.push(row('v-new', input.request.versionString, 'PREPARE_FOR_SUBMISSION'));
    return { before, version: { id: 'v-new', versionString: input.request.versionString, state: 'PREPARE_FOR_SUBMISSION' } };
  }
}

function boot(options: Parameters<typeof bootStaged>[1] = {}) {
  return async (db: Parameters<typeof bootStaged>[0]) => {
    const store = { ios: new FakeVersionStore('ios'), macos: new FakeVersionStore('macos') };
    const built: VersionConnectorInput[] = [];
    const t = await bootStaged(db, {
      ...options,
      extra: {
        storeVersion: {
          connectorFactory: (input: VersionConnectorInput) => {
            built.push(input);
            return input.platform === 'macos' ? store.macos : store.ios;
          },
        },
      },
    });
    const path = (appId: string, rest = '') => `/apps/${appId}/store-version${rest}`;
    const preview = (appId: string, body: Record<string, unknown>, cookie = t.owner) =>
      t.call(cookie, 'POST', path(appId, '/preview'), body);
    const create = (appId: string, body: Record<string, unknown>, cookie = t.owner) =>
      t.call(cookie, 'POST', path(appId), body);
    const previewAndCreate = async (appId: string, versionString: string, cookie = t.owner) => {
      const p = await preview(appId, { versionString }, cookie);
      if (p.status !== 200 || !p.body.preview.confirmHash) return { preview: p, create: p };
      return { preview: p, create: await create(appId, { versionString, confirmHash: p.body.preview.confirmHash }, cookie) };
    };
    return { t, store, built, preview, create, previewAndCreate };
  };
}
type Booted = Awaited<ReturnType<Awaited<ReturnType<typeof boot>>>>;
const withBoot = (name: string, fn: (b: Booted, db: Parameters<typeof bootStaged>[0]) => Promise<void>, options: Parameters<typeof bootStaged>[1] = {}) =>
  dbTest(name, async (db) => fn(await (await boot(options))(db), db));
const codes = (items: { code: string }[]) => items.map((i) => i.code);
const noIo = (b: Booted) => {
  assert.equal(b.store.ios.reads + b.store.macos.reads + b.store.ios.creates.length + b.store.macos.creates.length, 0);
  assert.equal(b.built.length, 0, 'no connector was built');
};
const macApp = async (t: StagedBoot) => {
  const res = await t.call(t.owner, 'POST', '/apps', {
    platform: 'macos',
    identifier: 'com.acme.mac',
    credentialId: t.iosCredential,
    repositoryId: t.repositoryId,
    name: 'Mac',
  });
  assert.equal(res.status, 201, res.text);
  const id = res.body.app.id as string;
  await t.db.execute('UPDATE apps SET store_app_id = ? WHERE id = ?', ['1234567890', id]);
  return id;
};

// ----- the switch and the rights --------------------------------------------------------------------------------------

withBoot('with the draft switch off both routes answer 409 store_draft_disabled and no store is reached', async (b) => {
  const app = await b.t.addApp('ios');
  for (const res of [await b.preview(app, { versionString: '3.1.2' }), await b.create(app, { versionString: '3.1.2', confirmHash: HASH })]) {
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'store_draft_disabled');
    assert.match(res.body.message, /MRM_STORE_DRAFT_WRITE_ENABLED=true/);
  }
  noIo(b);
  assert.equal(await b.t.claim(app), undefined);
}, { draft: { enabled: false } });

withBoot('only owners and admins preview or create; viewers and members get 403, outsiders 404', async (b) => {
  const app = await b.t.addApp('ios');
  for (const role of ['viewer', 'member'] as const) {
    const cookie = await b.t.addMember(role);
    assert.equal((await b.preview(app, { versionString: '3.1.2' }, cookie)).status, 403);
    assert.equal((await b.create(app, { versionString: '3.1.2', confirmHash: HASH }, cookie)).status, 403);
  }
  noIo(b);
  const admin = await b.t.addMember('admin');
  assert.equal((await b.previewAndCreate(app, '3.1.2', admin)).create.status, 200);
  await b.t.db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await b.t.addMember('owner', 'other');
  assert.equal((await b.preview(app, { versionString: '3.1.3' }, outsider)).status, 404);
});

withBoot('Google Play has no versions to create', async (b) => {
  const app = await b.t.addApp('android');
  const res = await b.preview(app, { versionString: '3.1.2' });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'not_supported');
  assert.equal((await b.create(app, { versionString: '3.1.2', confirmHash: HASH })).body.error, 'not_supported');
  noIo(b);
});

// ----- preview ----------------------------------------------------------------------------------------------------------

withBoot('the preview reads the versions, suggests the next patch and writes nothing', async (b) => {
  const app = await b.t.addApp('ios');
  const res = await b.preview(app, { versionString: '3.1.2' });
  assert.equal(res.status, 200, res.text);
  const p = res.body.preview;
  assert.equal(p.live, '3.1.1');
  assert.equal(p.suggested, '3.1.2');
  assert.equal(p.checks.canCreate, true);
  assert.match(p.confirmHash, /^[0-9a-f]{64}$/);
  assert.equal(p.reversible, true);
  assert.deepEqual(p.request, { versionString: '3.1.2', releaseType: null });
  assert.equal(b.store.ios.creates.length, 0);
  assert.equal(b.built[0]?.platform, 'ios');
});

withBoot('checks block a bad, equal, lower or existing version and an existing editable version; the hash is withheld', async (b) => {
  const app = await b.t.addApp('ios');
  const ask = async (versionString: string) => (await b.preview(app, { versionString })).body.preview;
  for (const [asked, code] of [
    ['v3.2', 'invalid_version'],
    ['3.2-beta', 'invalid_version'],
    ['3.1.1', 'version_exists'],
    ['3.1.0', 'not_higher'],
    ['2', 'not_higher'],
  ] as const) {
    const p = await ask(asked);
    assert.deepEqual(codes(p.checks.blocking), [code], asked);
    assert.equal(p.confirmHash, null);
  }
  b.store.ios.versions.push(row('v-next', '3.2', 'PREPARE_FOR_SUBMISSION'));
  const p = await ask('3.3');
  assert.deepEqual(codes(p.checks.blocking), ['editable_version_exists']);
  assert.equal(p.confirmHash, null);
  assert.equal(b.store.ios.creates.length, 0);
});

withBoot('a version that is in review is a warning, not a block', async (b) => {
  const app = await b.t.addApp('ios');
  b.store.ios.versions.push(row('v-rev', '3.2', 'IN_REVIEW'));
  const p = (await b.preview(app, { versionString: '3.3' })).body.preview;
  assert.equal(p.checks.canCreate, true);
  assert.deepEqual(codes(p.checks.warnings), ['version_in_progress']);
});

// ----- create -----------------------------------------------------------------------------------------------------------

withBoot('create writes the version once, audits ids only, and releases the claim', async (b, db) => {
  const app = await b.t.addApp('ios');
  const done = await b.previewAndCreate(app, '3.1.2');
  assert.equal(done.create.status, 200, done.create.text);
  const r = done.create.body.result;
  assert.deepEqual(r.version, { id: 'v-new', versionString: '3.1.2', state: 'PREPARE_FOR_SUBMISSION' });
  assert.equal(r.confirmedByReread, false);
  assert.equal(r.reversible, true);
  assert.deepEqual(b.store.ios.creates, [{ versionString: '3.1.2' }]);
  assert.equal(await b.t.claim(app), undefined);
  const audit = await b.t.audit('store.version_%');
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.action, 'store.version_created');
  assert.equal(audit[0]?.detail.versionId, 'v-new');
  assert.equal(audit[0]?.detail.versionString, '3.1.2');
  assert.equal(audit[0]?.detail.hash, done.preview.body.preview.confirmHash);
  assert.ok(!JSON.stringify(audit).includes('PRIVATE KEY'));
  // The same request again is refused by the guard: the version now exists, and the old hash no longer fits.
  const again = await b.create(app, { versionString: '3.1.2', confirmHash: done.preview.body.preview.confirmHash });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'blocked');
  assert.equal(b.store.ios.creates.length, 1);
  void db;
});

withBoot('macOS creates the macOS version of the record', async (b) => {
  const app = await macApp(b.t);
  const done = await b.previewAndCreate(app, '3.1.2');
  assert.equal(done.create.status, 200, done.create.text);
  assert.equal(b.built.at(-1)?.platform, 'macos');
  assert.equal(b.store.macos.creates.length, 1);
  assert.equal(b.store.ios.creates.length, 0);
});

withBoot('an explicit release type is part of the request and the hash', async (b) => {
  const app = await b.t.addApp('ios');
  const p = await b.preview(app, { versionString: '3.1.2', releaseType: 'MANUAL' });
  const other = await b.preview(app, { versionString: '3.1.2' });
  assert.notEqual(p.body.preview.confirmHash, other.body.preview.confirmHash);
  const wrong = await b.create(app, { versionString: '3.1.2', confirmHash: other.body.preview.confirmHash, releaseType: 'MANUAL' });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.error, 'state_changed');
  const ok = await b.create(app, { versionString: '3.1.2', releaseType: 'MANUAL', confirmHash: p.body.preview.confirmHash });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(b.store.ios.creates, [{ versionString: '3.1.2', releaseType: 'MANUAL' }]);
  assert.equal((await b.preview(app, { versionString: '3.9', releaseType: 'SCHEDULED' })).status, 400);
});

withBoot('drift: versions that changed after the preview write nothing and come back as a new preview', async (b) => {
  const app = await b.t.addApp('ios');
  const p = await b.preview(app, { versionString: '3.1.2' });
  b.store.ios.versions.push(row('v-gone', '2.0', 'REMOVED_FROM_SALE'));
  const res = await b.create(app, { versionString: '3.1.2', confirmHash: p.body.preview.confirmHash });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'state_changed');
  assert.equal(res.body.preview.versions.length, 3);
  assert.equal(b.store.ios.creates.length, 0);
  assert.equal(await b.t.claim(app), undefined);
  assert.equal((await b.t.audit('store.version_create_failed'))[0]?.detail.code, 'state_changed');
});

withBoot('a hash of another request is refused; a malformed one is a 400', async (b) => {
  const app = await b.t.addApp('ios');
  assert.equal((await b.create(app, { versionString: '3.1.2', confirmHash: HASH })).body.error, 'state_changed');
  assert.equal((await b.create(app, { versionString: '3.1.2', confirmHash: 'nope' })).status, 400);
  assert.equal((await b.create(app, { versionString: '3.1.2', confirmHash: HASH, confirmation: 'x' })).status, 400);
  assert.equal(b.store.ios.creates.length, 0);
});

withBoot('Apple refuses: the reasons are shown, nothing is retried, the claim is released', async (b) => {
  const app = await b.t.addApp('ios');
  b.store.ios.behavior = {
    kind: 'refuse',
    error: new StoreError('appstoreconnect', 'invalid_input', 'Apple refused creating the version (409) (ENTITY_ERROR: duplicate)', 409, [
      { code: 'ENTITY_ERROR.ATTRIBUTE.INVALID', detail: 'The version string is not valid.', pointer: '/data/attributes/versionString' },
    ]),
  };
  const done = await b.previewAndCreate(app, '3.1.2');
  assert.equal(done.create.status, 422);
  assert.equal(done.create.body.error, 'store_rejected');
  assert.equal(done.create.body.details[0].pointer, '/data/attributes/versionString');
  assert.equal(b.store.ios.creates.length, 1);
  assert.equal(await b.t.claim(app), undefined);
  assert.equal((await b.t.audit('store.version_create_failed'))[0]?.detail.outcome, 'failed');
});

withBoot('a lost answer: the versions are read back (applied), never sent again', async (b) => {
  const app = await b.t.addApp('ios');
  b.store.ios.behavior = { kind: 'unknown', applied: true };
  const done = await b.previewAndCreate(app, '3.1.2');
  assert.equal(done.create.status, 200, done.create.text);
  assert.equal(done.create.body.result.confirmedByReread, true);
  assert.equal(done.create.body.result.version.id, 'v-new');
  assert.equal(b.store.ios.creates.length, 1);
  assert.equal(await b.t.claim(app), undefined);
});

withBoot('a lost answer that the store does not show is an unknown outcome until a preview reads the store', async (b) => {
  const app = await b.t.addApp('ios');
  b.store.ios.behavior = { kind: 'unknown', applied: false };
  const done = await b.previewAndCreate(app, '3.1.2');
  assert.equal(done.create.status, 409);
  assert.equal(done.create.body.error, 'outcome_unknown');
  assert.match(done.create.body.message, /App Store Connect/);
  assert.equal((await b.t.claim(app))?.status, 'unknown');
  // Blocked until a preview (a successful read) settles it.
  b.store.ios.behavior = { kind: 'ok' };
  const blocked = await b.create(app, { versionString: '3.1.2', confirmHash: done.preview.body.preview.confirmHash });
  assert.equal(blocked.body.error, 'outcome_unknown');
  assert.equal(b.store.ios.creates.length, 1);
  assert.equal((await b.preview(app, { versionString: '3.1.2' })).status, 200);
  assert.equal(await b.t.claim(app), undefined);
  assert.equal((await b.previewAndCreate(app, '3.1.2')).create.status, 200);
});

withBoot('a lost answer and an unreadable store is an unknown outcome too', async (b) => {
  const app = await b.t.addApp('ios');
  b.store.ios.behavior = { kind: 'unknown', applied: true, unreadable: true };
  const done = await b.previewAndCreate(app, '3.1.2');
  assert.equal(done.create.status, 409);
  assert.equal(done.create.body.error, 'outcome_unknown');
  assert.equal((await b.t.audit('store.version_create_failed'))[0]?.detail.readBack, 'failed');
});

withBoot('one write at a time, shared with the draft push', async (b, db) => {
  const app = await b.t.addApp('ios');
  const p = await b.preview(app, { versionString: '3.1.2' });
  await db.execute(
    "INSERT INTO store_draft_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at) VALUES (?, 'ios', ?, 'push_draft', 'writing', 'u', ?)",
    [app, b.t.workspaceId, Date.now()],
  );
  const res = await b.create(app, { versionString: '3.1.2', confirmHash: p.body.preview.confirmHash });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'write_in_progress');
  assert.equal(b.store.ios.creates.length, 0);
  // An unknown draft push is not settled by this preview, and blocks the create with its own words.
  await db.execute("UPDATE store_draft_claims SET status = 'unknown' WHERE app_id = ?", [app]);
  assert.equal((await b.preview(app, { versionString: '3.1.2' })).status, 200);
  const blocked = await b.create(app, { versionString: '3.1.2', confirmHash: p.body.preview.confirmHash });
  assert.equal(blocked.body.error, 'outcome_unknown');
  assert.match(blocked.body.message, /draft push/);
});

// ----- step-up ----------------------------------------------------------------------------------------------------------

withBoot('when the workspace covers store.push_draft with a step-up, the create needs the confirmation; the preview stays free', async (b, db) => {
  const app = await b.t.addApp('ios');
  await setPolicy(db, { workspaceId: b.t.workspaceId, policy: { mode: 'hard_actions', actions: ['store.push_draft'], unattended: [] }, userId: 'u' }, Date.now());
  const p = await b.preview(app, { versionString: '3.1.2' });
  assert.equal(p.status, 200);
  const res = await b.create(app, { versionString: '3.1.2', confirmHash: p.body.preview.confirmHash });
  assert.equal(res.status, 403);
  assert.match(String(res.body.error), /^step_up/);
  assert.equal(b.store.ios.creates.length, 0);
});

// ----- the registry -----------------------------------------------------------------------------------------------------

withBoot('the API description lists both routes with the draft push action; the create is destructive', async (b) => {
  const res = await b.t.app.request('/api/openapi.json', { headers: { cookie: b.t.owner } });
  const doc = (await res.json()) as { paths: Record<string, Record<string, Record<string, unknown>>> };
  const at = (path: string, method: string) => doc.paths[`/api/workspaces/{workspaceId}${path}`]?.[method];
  assert.equal(at('/apps/{id}/store-version/preview', 'post')?.['x-mrm-action'], 'store.push_draft');
  assert.equal(at('/apps/{id}/store-version/preview', 'post')?.['x-mrm-risk'], 'read');
  assert.equal(at('/apps/{id}/store-version', 'post')?.['x-mrm-action'], 'store.push_draft');
  assert.equal(at('/apps/{id}/store-version', 'post')?.['x-mrm-risk'], 'destructive');
});
