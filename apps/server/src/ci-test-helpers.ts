import { randomBytes } from 'node:crypto';
import type {
  CiRun,
  CiWorkflow,
  CommitComparison,
  DispatchResult,
  ListWorkflowRunsOptions,
} from '@mrm/connectors';
import type { Database } from '@mrm/db';
import { bootRepoApp } from './repo-test-helpers.ts';
import type { AppDeps } from './app.ts';
import { type CiClient, clearCiCaches, createCiContext } from './services/ci.ts';

/** Shared by ci.test.ts and scheduler.test.ts. Not a test file itself. */

export const SHA_1 = '1'.repeat(40);
export const SHA_2 = '2'.repeat(40);
export const SHA_3 = '3'.repeat(40);

export const workflow = (path: string, name: string, id = path.length * 1000): CiWorkflow => ({
  id: String(id),
  name,
  path,
  state: 'active',
});

export const run = (id: string, extra: Partial<CiRun> = {}): CiRun => ({
  id,
  name: 'iOS release',
  path: '.github/workflows/ios.yml',
  status: 'completed',
  conclusion: 'success',
  url: `https://github.com/acme/app/actions/runs/${id}`,
  branch: 'main',
  headSha: SHA_1,
  event: 'workflow_dispatch',
  runNumber: Number(id) % 1000,
  createdAt: 1_800_000_000_000 + Number(id),
  startedAt: 1_800_000_000_000 + Number(id),
  updatedAt: 1_800_000_000_000 + Number(id) + 60_000,
  ...extra,
});

/** An in-memory GitHub for the CI methods, with programmable answers and a log of the calls. */
export class FakeCi implements CiClient {
  readonly kind = 'github' as const;
  workflows: CiWorkflow[] = [
    workflow('.github/workflows/ios.yml', 'iOS release', 1),
    workflow('.github/workflows/android.yml', 'Android release', 2),
  ];
  runs: CiRun[] = [];
  files = new Map<string, string>();
  comparison: CommitComparison = {
    status: 'ahead',
    aheadBy: 2,
    behindBy: 0,
    totalCommits: 2,
    truncated: false,
    url: 'https://github.com/acme/app/compare/a...b',
    commits: [
      { sha: SHA_2, message: 'First change\n\nbody', author: 'Ada', date: 1_800_000_000_000, url: 'https://github.com/acme/app/commit/2' },
      { sha: SHA_3, message: 'Second change', author: 'Grace', url: 'https://github.com/acme/app/commit/3' },
    ],
  };
  dispatchResult: DispatchResult = {};
  /** Errors thrown by the next calls of each kind, in order. */
  errors: { workflows: unknown[]; runs: unknown[]; dispatch: unknown[]; compare: unknown[]; getRun: unknown[] } = {
    workflows: [],
    runs: [],
    dispatch: [],
    compare: [],
    getRun: [],
  };
  calls: { name: string; args: unknown[] }[] = [];
  dispatches: { workflow: string; ref: string; inputs?: Record<string, string> | undefined }[] = [];
  signals: (AbortSignal | undefined)[] = [];

  count(name: string) {
    return this.calls.filter((c) => c.name === name).length;
  }

  async defaultBranch() {
    return 'main';
  }
  async listFiles() {
    return [...this.files.keys()];
  }
  async readFile(path: string) {
    this.calls.push({ name: 'readFile', args: [path] });
    return this.files.get(path);
  }
  async propose(): Promise<never> {
    throw new Error('not used');
  }
  async dispatchWorkflow(workflowName: string, ref: string, inputs?: Record<string, string>) {
    this.calls.push({ name: 'dispatchWorkflow', args: [workflowName, ref, inputs] });
    this.dispatches.push({ workflow: workflowName, ref, inputs });
    const error = this.errors.dispatch.shift();
    if (error) throw error;
    return this.dispatchResult;
  }
  async listWorkflowRuns(): Promise<never> {
    throw new Error('not used: the CI code uses listCiRuns');
  }
  async listWorkflows(signal?: AbortSignal) {
    this.calls.push({ name: 'listWorkflows', args: [] });
    this.signals.push(signal);
    const error = this.errors.workflows.shift();
    if (error) throw error;
    return this.workflows;
  }
  async listCiRuns(options: ListWorkflowRunsOptions & { signal?: AbortSignal } = {}) {
    this.calls.push({ name: 'listCiRuns', args: [options] });
    this.signals.push(options.signal);
    const error = this.errors.runs.shift();
    if (error) throw error;
    return this.runs.slice(0, options.limit ?? 30);
  }
  async getCiRun(runId: string, signal?: AbortSignal) {
    this.calls.push({ name: 'getCiRun', args: [runId] });
    this.signals.push(signal);
    const error = this.errors.getRun.shift();
    if (error) throw error;
    return this.runs.find((r) => r.id === runId);
  }
  async compareCommits(base: string, head: string) {
    this.calls.push({ name: 'compareCommits', args: [base, head] });
    const error = this.errors.compare.shift();
    if (error) throw error;
    return this.comparison;
  }
}

/** The server with a fake GitHub and one connected repository (acme/app, with a token credential). */
export async function bootCi(db: Database, ci: NonNullable<AppDeps['ci']> = {}, overrides: Partial<AppDeps> = {}) {
  clearCiCaches();
  const fake = new FakeCi();
  const masterKey = randomBytes(32);
  const t = await bootRepoApp(db, undefined, { masterKey, connectorFactory: () => fake, ci, ...overrides });
  const { repositoryId, credentialId } = await t.connect();
  const base = `/repositories/${repositoryId}`;

  /** A context for calling the services directly, with its own clock. */
  const context = (clock: { now: number }, extra: Parameters<typeof createCiContext>[1] = {}) =>
    createCiContext(
      { db, masterKey, now: () => clock.now, connectorFactory: () => fake, timeoutMs: 5_000 },
      extra,
    );

  /** An app of this workspace linked to the repository, with its releases (version, build, details). */
  const seedApp = async (
    platform: 'ios' | 'android',
    releases: { version: string; build: string | null; track?: string; codes?: string[]; status?: string; uploadedAt?: number }[],
    options: { repositoryId?: string | null; identifier?: string } = {},
  ) => {
    const id = `app-${platform}-${Math.random().toString(16).slice(2, 8)}`;
    await db.execute(
      `INSERT INTO apps (id, workspace_id, name, platform, identifier, credential_id, repository_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'cred', ?, 1)`,
      [
        id,
        t.workspaceId,
        `Acme ${platform}`,
        platform,
        options.identifier ?? `com.acme.${platform}`,
        options.repositoryId === undefined ? repositoryId : options.repositoryId,
      ],
    );
    let n = 0;
    for (const r of releases) {
      await db.execute(
        `INSERT INTO app_releases
           (id, app_id, workspace_id, platform, version, track, build, status, raw_state, details_json,
            store_updated_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RAW', ?, ?, 5)`,
        [
          `rel-${id}-${n++}`,
          id,
          t.workspaceId,
          platform,
          r.version,
          r.track ?? '',
          r.build,
          r.status ?? 'live',
          JSON.stringify(r.codes ? { versionCodes: r.codes } : {}),
          r.uploadedAt ?? null,
        ],
      );
    }
    return id;
  };

  return { ...t, db, fake, masterKey, repositoryId, credentialId, base, context, seedApp };
}

export type CiBoot = Awaited<ReturnType<typeof bootCi>>;
