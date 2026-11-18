import { randomBytes } from 'node:crypto';
import type { ChangeSet } from '@mrm/core';
import type { ProposalResult, ProposeOptions } from '@mrm/connectors';
import { ChangeConflictError } from '@mrm/connectors';
import { type Database, migrate } from '@mrm/db';
import { createApp } from './app.ts';
import type { ConnectorFactory, RepoClient } from './services/repositories.ts';

/** Shared by repositories.test.ts and change-sets.test.ts. Not a test file itself. */

export const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const PASSWORD = 'correct horse battery staple';
const cheap = { N: 1024, r: 8, p: 1 };

export function fastlaneFiles(): Record<string, string> {
  return {
    'fastlane/Fastfile': 'lane :release do\n  upload_to_app_store\nend\n',
    'fastlane/Appfile': 'app_identifier("com.acme.app")\n',
    'fastlane/metadata/en-US/name.txt': 'Acme App\n',
    'fastlane/metadata/en-US/subtitle.txt': 'Old subtitle\n',
    'fastlane/metadata/en-US/description.txt': 'A description that is long enough.\n',
    'fastlane/metadata/de-DE/name.txt': 'Acme App\n',
    'fastlane/metadata/de-DE/subtitle.txt': 'Alter Untertitel\n',
  };
}

/** An in-memory GitHub repository: a file tree, branches made by propose, and programmable failures. */
export class FakeRepo implements RepoClient {
  readonly kind = 'github' as const;
  files = new Map<string, string>(Object.entries(fastlaneFiles()));
  branches = new Map<string, Map<string, string>>();
  proposals: { changeSet: ChangeSet; options: ProposeOptions }[] = [];
  listCalls = 0;
  /** Errors thrown by the next calls, in order. */
  proposeErrors: unknown[] = [];
  defaultBranchError: unknown;
  listError: unknown;
  /** Makes listFiles wait this long (ms), to test the timeout. */
  listDelayMs = 0;
  /** propose waits for this promise first, to hold a request in flight. */
  proposeGate?: Promise<void>;
  /** What propose returns instead of a real result. */
  proposeResult?: Partial<ProposalResult>;
  #pr = 0;

  async defaultBranch(): Promise<string> {
    if (this.defaultBranchError) throw this.defaultBranchError;
    return 'main';
  }
  async listFiles(): Promise<string[]> {
    this.listCalls++;
    if (this.listDelayMs) await new Promise((r) => setTimeout(r, this.listDelayMs));
    if (this.listError) throw this.listError;
    return [...this.files.keys()].sort();
  }
  async readFile(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }
  async propose(changeSet: ChangeSet, options: ProposeOptions): Promise<ProposalResult> {
    this.proposals.push({ changeSet, options });
    if (this.proposeGate) await this.proposeGate;
    const error = this.proposeErrors.shift();
    if (error) throw error;
    const conflicts = changeSet.files
      .filter((f) => this.files.get(f.path) !== f.before)
      .map((f) => f.path);
    if (conflicts.length > 0) throw new ChangeConflictError(conflicts);
    const tree = new Map(this.files);
    for (const f of changeSet.files) {
      if (f.after === undefined) tree.delete(f.path);
      else tree.set(f.path, f.after);
    }
    this.branches.set(options.branch, tree);
    const number = ++this.#pr;
    return {
      branch: options.branch,
      url: `https://github.com/acme/app/pull/${number}`,
      number,
      commitSha: 'a'.repeat(40),
      ...this.proposeResult,
    };
  }
  async dispatchWorkflow(): Promise<never> {
    throw new Error('not used');
  }
  async listWorkflowRuns(): Promise<never> {
    throw new Error('not used');
  }
}

export type Built = { kind: string; secret: string; owner: string; repo: string };

export function fakeFactory(repo: FakeRepo) {
  const built: Built[] = [];
  const factory: ConnectorFactory = (kind, secret, target) => {
    built.push({ kind, secret, ...target });
    return repo;
  };
  return { factory, built };
}

type Options = Partial<Parameters<typeof createApp>[0]>;

export async function bootRepoApp(db: Database, repo = new FakeRepo(), overrides: Options = {}) {
  await migrate(db);
  const { factory, built } = fakeFactory(repo);
  // A clock that never repeats, so audit rows have a stable order.
  let clock = Date.now();
  const app = createApp({
    now: () => ++clock,
    db,
    masterKey: randomBytes(32),
    version: 'test',
    cost: cheap,
    connectorFactory: factory,
    ...overrides,
  });
  const reg = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'ada@example.com',
      displayName: 'Ada',
      password: PASSWORD,
      workspaceName: 'Acme Apps',
    }),
  });
  const owner = reg.headers.get('set-cookie')?.split(';')[0] ?? '';
  const { workspaceId } = (await reg.json()) as { workspaceId: string };
  const texts: string[] = [];

  /** One request; `cookie` is a session cookie. Every response text is kept for leak checks. */
  const call = async (
    cookie: string,
    method: string,
    path: string,
    body?: unknown,
    workspace = workspaceId,
  ) => {
    const res = await app.request(`/api/workspaces/${workspace}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    texts.push(text);
    return {
      status: res.status,
      headers: res.headers,
      text,
      // biome-ignore lint/suspicious/noExplicitAny: test responses are inspected loosely
      body: (text ? JSON.parse(text) : null) as any,
    };
  };

  /** A user with this role in `workspace` (default: the main one), as a session cookie. */
  const addMember = async (role: string, workspace = workspaceId) => {
    const { createSession } = await import('./services/accounts.ts');
    const id = `user-${role}-${workspace}`;
    await db.execute(
      'INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, 0)',
      [id, `${id}@x.io`, role],
    );
    await db.execute('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)', [
      workspace,
      id,
      role,
    ]);
    const { token } = await createSession(db, id, Date.now());
    return `mrm_session=${token}`;
  };

  const addCredential = async (
    kind = 'github_token',
    secret = TOKEN,
    cookie = owner,
    workspace = workspaceId,
  ) => {
    const res = await call(cookie, 'POST', '/credentials', { kind, label: 'GitHub', secret }, workspace);
    return res.body.credential.id as string;
  };

  /** Connects acme/app with a fresh token credential. */
  const connect = async (cookie = owner) => {
    const credentialId = await addCredential();
    const res = await call(cookie, 'POST', '/repositories', {
      credentialId,
      owner: 'acme',
      repo: 'app',
    });
    return { credentialId, repositoryId: res.body.repository?.id as string, res };
  };

  /** Draft that changes the en-US subtitle, built from the listing as the API reads it. */
  const draft = async (repositoryId: string, subtitle = 'New subtitle', cookie = owner) => {
    const read = await call(cookie, 'GET', `/repositories/${repositoryId}/listing`);
    const listing = read.body.listing;
    listing.appStore.locales['en-US'].subtitle = subtitle;
    const res = await call(cookie, 'POST', `/repositories/${repositoryId}/change-sets`, {
      summary: 'Update the subtitle',
      listing,
    });
    return { res, id: res.body.changeSet?.id as string };
  };

  const auditActions = async () =>
    (await db.query('SELECT action, actor_type, actor_id, target_id, detail FROM audit_events ORDER BY created_at, id'))
      .map((r) => ({
        action: String(r.action),
        actorType: String(r.actor_type),
        actorId: String(r.actor_id),
        targetId: r.target_id as string | null,
        detail: String(r.detail ?? ''),
      }));

  return { app, db, repo, built, owner, workspaceId, call, addMember, addCredential, connect, draft, texts, auditActions };
}
