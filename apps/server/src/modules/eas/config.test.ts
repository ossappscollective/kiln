import assert from 'node:assert/strict';
import { GithubError, GithubRateLimitError } from '@kiln/connectors';
import { dbTest } from '@kiln/db/testing';
import {
  APP_PLAIN,
  APP_UPDATES,
  DEFAULT_EAS,
  FULL_EAS,
  INVALID_EAS,
  SECRET_TOKEN,
  SENTRY_TOKEN,
} from '../../../../../packages/connectors/src/expo/eas-config.fixtures.ts';
import { operations } from '../../operations/registry.ts';
import { bootRepoApp, FakeRepo } from '../../repo-test-helpers.ts';
import { clearRepoSnapshots } from '../../services/repo-snapshot.ts';
import { EAS_CONFIG_READS_PER_MINUTE } from './config-routes.ts';

// Everything here runs against a fake GitHub: no live GitHub call is ever made, and Expo is never called at all.

const SHA = 'c'.repeat(40);

/** A repository that counts what is read from it and can name its commit. */
class EasRepo extends FakeRepo {
  reads: string[] = [];
  /** Set to name the commit, like the GitHub connector does; a connector without it is read as the branch. */
  resolveCommit?: (() => Promise<string>) | undefined;
  override async readFile(path: string) {
    this.reads.push(path);
    return super.readFile(path);
  }
}

async function boot(db: Parameters<typeof bootRepoApp>[0], files: Record<string, string> = {}) {
  clearRepoSnapshots();
  const repo = new EasRepo();
  repo.files = new Map(Object.entries(files));
  const t = await bootRepoApp(db, repo);
  const { repositoryId, credentialId } = await t.connect();
  const seedApp = async (
    options: {
      platform?: 'ios' | 'android' | 'macos';
      identifier?: string;
      repositoryId?: string | null;
      workspaceId?: string;
    } = {},
  ) => {
    const id = `app-${Math.random().toString(16).slice(2, 8)}`;
    const platform = options.platform ?? 'ios';
    await db.execute(
      `INSERT INTO apps (id, workspace_id, name, platform, identifier, credential_id, repository_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'cred', ?, 1)`,
      [
        id,
        options.workspaceId ?? t.workspaceId,
        `Acme ${platform}`,
        platform,
        options.identifier ?? 'com.example.trailnotes',
        options.repositoryId === undefined ? repositoryId : options.repositoryId,
      ],
    );
    return id;
  };
  const get = (cookie: string, appId: string, workspace?: string) =>
    t.call(cookie, 'GET', `/apps/${appId}/eas-config`, undefined, workspace);
  return { ...t, repo, repositoryId, credentialId, seedApp, get };
}

dbTest('reads eas.json and the app config at the commit and answers the model', async (db) => {
  const t = await boot(db, { 'eas.json': FULL_EAS, 'app.json': APP_UPDATES, 'package.json': '{}' });
  t.repo.resolveCommit = async () => SHA;
  const appId = await t.seedApp();
  const res = await t.get(t.owner, appId);
  assert.equal(res.status, 200, res.text);
  const view = res.body;
  assert.equal(view.found, true);
  assert.equal(view.reason, null);
  assert.equal(view.path, 'eas.json');
  assert.equal(view.commit, SHA);
  assert.equal(view.branch, 'main');
  assert.ok(view.readAt > 0);
  assert.deepEqual(view.repository, {
    id: t.repositoryId,
    owner: 'acme',
    repo: 'app',
    localOnly: false,
  });
  assert.deepEqual(view.app, {
    id: appId,
    name: 'Acme ios',
    platform: 'ios',
    identifier: 'com.example.trailnotes',
  });
  assert.deepEqual(
    view.config.build.map((b: { name: string }) => b.name),
    ['base', 'preview', 'production'],
  );
  const preview = view.config.build.find((b: { name: string }) => b.name === 'preview');
  assert.equal(preview.channel, 'preview');
  assert.deepEqual(preview.extendsChain, ['preview', 'base']);
  assert.deepEqual(preview.envNames, ['ANDROID_ONLY', 'API_URL', 'FLAVOR', 'SENTRY_AUTH_TOKEN']);
  assert.equal(view.config.submit[0].android.track, 'production');
  assert.equal(view.expoApp.path, 'app.json');
  assert.deepEqual(view.expoApp.runtimeVersion, { kind: 'policy', policy: 'appVersion' });
  assert.equal(view.expoApp.updatesConfigured, true);
  const codes = view.findings.map((f: { code: string }) => f.code);
  assert.ok(codes.includes('env_secret_like'));
  assert.ok(codes.includes('submit_rollout_needs_in_progress'));
  // Only the two files were read, never anything else of the repository.
  assert.deepEqual([...t.repo.reads].sort(), ['app.json', 'eas.json']);
});

dbTest('the answer is what the operation says, and nothing more', async (db) => {
  const t = await boot(db, { 'eas.json': FULL_EAS, 'app.json': APP_UPDATES });
  const appId = await t.seedApp();
  const op = operations.find((o) => o.id === 'getEasConfig');
  const schema = op?.responses['200']?.schema;
  assert.ok(schema);
  const body = (await t.get(t.owner, appId)).body;
  assert.deepEqual(schema.parse(body), body);
  // also for the answers without a model
  const none = await t.get(
    t.owner,
    await t.seedApp({ repositoryId: null, identifier: 'com.example.second' }),
  );
  assert.deepEqual(schema.parse(none.body), none.body);
});

dbTest(
  'the commit is null when the connector cannot name it, and the tree is read once per commit',
  async (db) => {
    const t = await boot(db, { 'eas.json': DEFAULT_EAS });
    const appId = await t.seedApp();
    const first = await t.get(t.owner, appId);
    assert.equal(first.body.commit, null);
    assert.equal(first.body.branch, 'main');
    assert.equal(first.body.found, true);

    clearRepoSnapshots();
    t.repo.resolveCommit = async () => SHA;
    const a = await t.get(t.owner, appId);
    const listed = t.repo.listCalls;
    const b = await t.get(t.owner, appId);
    assert.equal(a.body.commit, SHA);
    assert.equal(b.body.commit, SHA);
    assert.equal(t.repo.listCalls, listed, 'the second read of the same commit lists no tree');
  },
);

dbTest(
  'rights: members read, viewers and outsiders do not, and a refused request never reaches GitHub',
  async (db) => {
    const t = await boot(db, { 'eas.json': DEFAULT_EAS });
    const appId = await t.seedApp();
    const viewer = await t.addMember('viewer');
    const member = await t.addMember('member');
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
    const outsider = await t.addMember('owner', 'other');

    const forbidden = await t.get(viewer, appId);
    assert.equal(forbidden.status, 403);
    assert.deepEqual(forbidden.body, { error: 'forbidden' });
    assert.equal((await t.get(outsider, appId)).status, 404, 'not a member: not found');
    assert.equal((await t.get(t.owner, 'no-such-app')).status, 404);
    assert.equal(
      (await t.get(outsider, appId, 'other')).status,
      404,
      'the app of one workspace does not exist in another',
    );
    const anonymous = await t.app.request(
      `/api/workspaces/${t.workspaceId}/apps/${appId}/eas-config`,
    );
    assert.equal(anonymous.status, 401);
    assert.equal(t.repo.reads.length, 0);
    assert.equal(t.repo.listCalls, 0);

    assert.equal((await t.get(member, appId)).status, 200);
    assert.equal((await t.get(t.owner, appId)).status, 200);
  },
);

dbTest('an app without a repository is an answer, and GitHub is not touched', async (db) => {
  const t = await boot(db, { 'eas.json': DEFAULT_EAS });
  const appId = await t.seedApp({ repositoryId: null });
  const res = await t.get(t.owner, appId);
  assert.equal(res.status, 200);
  assert.equal(res.body.found, false);
  assert.equal(res.body.reason.code, 'no_repository');
  assert.equal(res.body.repository, null);
  assert.equal(res.body.config, null);
  assert.deepEqual(res.body.findings, []);
  assert.equal(t.repo.listCalls, 0);
  assert.deepEqual(t.repo.reads, []);
});

dbTest(
  'a repository without eas.json answers found false with the reason, not an error',
  async (db) => {
    const t = await boot(db, {
      'package.json': '{}',
      'app.json': APP_PLAIN,
      'apps/mobile/eas.json': '{}',
      'node_modules/x/eas.json': '{}',
    });
    const appId = await t.seedApp();
    const res = await t.get(t.owner, appId);
    assert.equal(res.status, 200);
    assert.equal(res.body.found, false);
    assert.equal(res.body.reason.code, 'no_eas_json');
    assert.match(res.body.reason.message, /no eas\.json at the repository root/i);
    assert.deepEqual(res.body.nested, ['apps/mobile/eas.json']);
    assert.equal(res.body.config, null);
    assert.equal(res.body.path, null);
    assert.equal(res.body.expoApp.iosBundleIdentifier, 'com.example.trailnotes');
    assert.equal(res.body.commit, null);
    assert.deepEqual(t.repo.reads, ['app.json']);
  },
);

dbTest(
  'an eas.json that is not JSON is found, with an error finding and no secret echoed',
  async (db) => {
    const t = await boot(db, { 'eas.json': INVALID_EAS });
    const appId = await t.seedApp();
    const res = await t.get(t.owner, appId);
    assert.equal(res.status, 200);
    assert.equal(res.body.found, true);
    assert.equal(res.body.config, null);
    assert.deepEqual(
      res.body.findings.map((f: { code: string; severity: string }) => [f.code, f.severity]),
      [['eas_json_invalid', 'error']],
    );
    assert.equal(res.text.includes(SECRET_TOKEN), false);
  },
);

dbTest(
  'no value of env, of an unknown key or of a secret reaches the response, the audit log or the stored rows',
  async (db) => {
    const t = await boot(db, { 'eas.json': FULL_EAS, 'app.json': APP_UPDATES });
    const appId = await t.seedApp();
    const res = await t.get(t.owner, appId);
    assert.equal(res.status, 200);
    const everything = [
      res.text,
      JSON.stringify(await t.auditActions()),
      JSON.stringify(await db.query('SELECT * FROM audit_events')),
    ].join('\n');
    for (const value of [
      SECRET_TOKEN,
      SENTRY_TOKEN,
      'do-not-keep-this-value',
      'https://api.example.com',
      'dev@example.com',
    ]) {
      assert.equal(everything.includes(value), false, `${value} leaked`);
    }
    const secrets = res.body.findings.filter((f: { code: string }) => f.code === 'env_secret_like');
    assert.deepEqual(secrets.map((f: { key: string }) => f.key).sort(), [
      'GITHUB',
      'SENTRY_AUTH_TOKEN',
    ]);
  },
);

dbTest(
  'the read is audited as a use of the repository credential, with its purpose',
  async (db) => {
    const t = await boot(db, { 'eas.json': DEFAULT_EAS });
    const appId = await t.seedApp();
    await t.get(t.owner, appId);
    const uses = (await t.auditActions()).filter(
      (a) => a.action === 'credential.use' && /eas\.config/.test(a.detail),
    );
    assert.equal(uses.length, 1);
    assert.equal(uses[0]?.actorType, 'user');
  },
);

dbTest('the app identifier is compared with the app config; a desktop app is not', async (db) => {
  const t = await boot(db, { 'eas.json': '{}', 'app.json': APP_PLAIN });
  const ios = await t.seedApp({ identifier: 'com.other.app' });
  const same = await t.seedApp({ identifier: 'com.example.trailnotes' });
  const android = await t.seedApp({ platform: 'android', identifier: 'com.other.droid' });
  const mac = await t.seedApp({ platform: 'macos', identifier: 'com.other.mac' });
  const codes = async (id: string) =>
    (await t.get(t.owner, id)).body.findings.map((f: { code: string }) => f.code);
  assert.ok((await codes(ios)).includes('app_identifier_mismatch'));
  assert.ok((await codes(android)).includes('app_identifier_mismatch'));
  assert.equal((await codes(same)).includes('app_identifier_mismatch'), false);
  assert.equal((await codes(mac)).includes('app_identifier_mismatch'), false);
});

dbTest(
  'a rate limit of GitHub and an outage are failures like in the other repository reads',
  async (db) => {
    const t = await boot(db, { 'eas.json': DEFAULT_EAS });
    const appId = await t.seedApp();
    t.repo.listError = new GithubRateLimitError(403, 'primary', 42);
    const limited = await t.get(t.owner, appId);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '42');

    t.repo.listError = new GithubError(
      'server',
      `upstream said: token ${SECRET_TOKEN} is odd`,
      500,
    );
    const broken = await t.get(t.owner, appId);
    assert.equal(broken.status, 502);
    assert.equal(broken.text.includes(SECRET_TOKEN), false);
  },
);

dbTest('a file that is too large or not text is an answer, not a failure', async (db) => {
  const t = await boot(db, { 'eas.json': DEFAULT_EAS });
  t.repo.readFile = async () => {
    throw new GithubError('too_large', 'eas.json is 3 MB');
  };
  const appId = await t.seedApp();
  const res = await t.get(t.owner, appId);
  assert.equal(res.status, 200);
  assert.equal(res.body.found, false);
  assert.equal(res.body.reason.code, 'unreadable');
});

dbTest('the read times out instead of hanging', async (db) => {
  clearRepoSnapshots();
  const repo = new EasRepo();
  repo.files = new Map([['eas.json', DEFAULT_EAS]]);
  const t = await bootRepoApp(db, repo, { repositoryTimeoutMs: 30 });
  const { repositoryId } = await t.connect();
  await db.execute(
    `INSERT INTO apps (id, workspace_id, name, platform, identifier, credential_id, repository_id, created_at)
     VALUES ('slow', ?, 'Slow', 'ios', 'com.slow', 'cred', ?, 1)`,
    [t.workspaceId, repositoryId],
  );
  repo.listDelayMs = 300;
  const res = await t.call(t.owner, 'GET', '/apps/slow/eas-config');
  assert.equal(res.status, 504);
  assert.equal(res.body.error, 'timeout');
});

dbTest('reads are limited per workspace and the limit is reported with Retry-After', async (db) => {
  const t = await boot(db, { 'eas.json': DEFAULT_EAS });
  const appId = await t.seedApp();
  for (let i = 0; i < EAS_CONFIG_READS_PER_MINUTE; i++) {
    assert.equal((await t.get(t.owner, appId)).status, 200, `read ${i}`);
  }
  const limited = await t.get(t.owner, appId);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.ok(limited.body.retryAfterSeconds >= 1);
});

dbTest('a repository whose credential was deleted cannot be read and says so', async (db) => {
  const t = await boot(db, { 'eas.json': DEFAULT_EAS });
  const appId = await t.seedApp();
  assert.equal((await t.call(t.owner, 'DELETE', `/credentials/${t.credentialId}`)).status, 204);
  const res = await t.get(t.owner, appId);
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'credential_not_found');
});
