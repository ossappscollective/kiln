import { randomBytes } from 'node:crypto';
import type {
  CiJob,
  CiJobList,
  CiRun,
  CiRunPage,
  CiWorkflow,
  CommitComparison,
  CommitDetail,
  DispatchResult,
  GitRelease,
  GitTag,
  ListWorkflowRunsOptions,
} from '@mrm/connectors';
import type { Database } from '@mrm/db';
import type { AppDeps } from '../../app.ts';
import { bootRepoApp } from '../../repo-test-helpers.ts';
import { clearActiveCaches } from './active.ts';
import { type CiClient, clearCiCaches, createCiContext } from './service.ts';

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

export const job = (
  id: string,
  name: string,
  status: string,
  steps: [string, string][] = [],
  extra: Partial<CiJob> = {},
): CiJob => ({
  id,
  name,
  status,
  conclusion: status === 'completed' ? 'success' : null,
  startedAt: status === 'queued' ? null : 1_800_000_000_000,
  completedAt: status === 'completed' ? 1_800_000_060_000 : null,
  url: `https://github.com/acme/app/actions/runs/1/job/${id}`,
  steps: steps.map(([stepName, stepStatus], i) => ({
    number: i + 1,
    name: stepName,
    status: stepStatus,
    conclusion: stepStatus === 'completed' ? 'success' : null,
    startedAt: stepStatus === 'queued' ? null : 1_800_000_000_000,
    completedAt: stepStatus === 'completed' ? 1_800_000_010_000 : null,
  })),
  ...extra,
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
  /** The jobs of each run id, for `listRunJobs`. */
  jobs = new Map<string, CiJob[]>();
  /** When true the fake answers with ETags (a hash of what it would send) and 304s, like GitHub. Off by default so a test may change `runs` freely. */
  etagging = false;
  files = new Map<string, string>();
  comparison: CommitComparison = {
    status: 'ahead',
    aheadBy: 2,
    behindBy: 0,
    totalCommits: 2,
    truncated: false,
    url: 'https://github.com/acme/app/compare/a...b',
    commits: [
      {
        sha: SHA_2,
        message: 'First change\n\nbody',
        author: 'Ada',
        date: 1_800_000_000_000,
        url: 'https://github.com/acme/app/commit/2',
      },
      {
        sha: SHA_3,
        message: 'Second change',
        author: 'Grace',
        url: 'https://github.com/acme/app/commit/3',
      },
    ],
  };
  dispatchResult: DispatchResult = {};
  /** Tags, releases and commits, for linking a build number through its tag. */
  tags: GitTag[] = [];
  releases: GitRelease[] = [];
  commits = new Map<string, CommitDetail>();
  /** Errors thrown by the next calls of each kind, in order. */
  errors: {
    workflows: unknown[];
    runs: unknown[];
    dispatch: unknown[];
    compare: unknown[];
    getRun: unknown[];
    tags: unknown[];
    releases: unknown[];
    commits: unknown[];
    jobs: unknown[];
  } = {
    workflows: [],
    runs: [],
    dispatch: [],
    compare: [],
    getRun: [],
    tags: [],
    releases: [],
    commits: [],
    jobs: [],
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
  async listCiRunsPage(
    options: ListWorkflowRunsOptions & { signal?: AbortSignal; etag?: string | undefined } = {},
  ): Promise<CiRunPage> {
    const runs = await this.listCiRuns(options);
    if (!this.etagging) return { runs, notModified: false };
    const etag = `W/"${Buffer.from(JSON.stringify(runs)).toString('base64').slice(-24)}${runs.length}"`;
    if (options.etag === etag) return { runs: [], notModified: true, etag };
    return { runs, notModified: false, etag };
  }
  async listRunJobs(
    runId: string,
    options: { signal?: AbortSignal; etag?: string | undefined } = {},
  ): Promise<CiJobList> {
    this.calls.push({ name: 'listRunJobs', args: [runId, options.etag] });
    this.signals.push(options.signal);
    const error = this.errors.jobs.shift();
    if (error) throw error;
    const jobs = this.jobs.get(runId);
    if (!jobs) return { jobs: [], notModified: false, truncated: false, missing: true };
    if (!this.etagging) return { jobs, notModified: false, truncated: false };
    const etag = `W/"${JSON.stringify(jobs).length}-${jobs.map((j) => j.status + j.steps.map((x) => x.status).join('')).join('')}"`;
    if (options.etag === etag) return { jobs: [], notModified: true, truncated: false, etag };
    return { jobs, notModified: false, truncated: false, etag };
  }
  async getCiRun(runId: string, signal?: AbortSignal) {
    this.calls.push({ name: 'getCiRun', args: [runId] });
    this.signals.push(signal);
    const error = this.errors.getRun.shift();
    if (error) throw error;
    return this.runs.find((r) => r.id === runId);
  }
  async listTags(options: { maxPages?: number; signal?: AbortSignal } = {}) {
    this.calls.push({ name: 'listTags', args: [options.maxPages] });
    this.signals.push(options.signal);
    const error = this.errors.tags.shift();
    if (error) throw error;
    return { tags: this.tags, truncated: false, pages: 1 };
  }
  async listMatchingTags(prefix: string, options: { signal?: AbortSignal } = {}) {
    this.calls.push({ name: 'listMatchingTags', args: [prefix] });
    this.signals.push(options.signal);
    return {
      tags: this.tags.filter((t) => t.name.startsWith(prefix)),
      truncated: false,
      pages: 1,
      unresolved: 0,
    };
  }
  async getCommit(ref: string, signal?: AbortSignal) {
    this.calls.push({ name: 'getCommit', args: [ref] });
    this.signals.push(signal);
    const error = this.errors.commits.shift();
    if (error) throw error;
    return this.commits.get(ref);
  }
  async listReleases(options: { maxPages?: number; signal?: AbortSignal } = {}) {
    this.calls.push({ name: 'listReleases', args: [options.maxPages] });
    this.signals.push(options.signal);
    const error = this.errors.releases.shift();
    if (error) throw error;
    return { releases: this.releases, truncated: false, pages: 1 };
  }
  async compareCommits(base: string, head: string) {
    this.calls.push({ name: 'compareCommits', args: [base, head] });
    const error = this.errors.compare.shift();
    if (error) throw error;
    return this.comparison;
  }
}

/** The server with a fake GitHub and one connected repository (acme/app, with a token credential). */
export async function bootCi(
  db: Database,
  ci: NonNullable<AppDeps['ci']> = {},
  overrides: Partial<AppDeps> = {},
) {
  clearCiCaches();
  clearActiveCaches();
  const fake = new FakeCi();
  const masterKey = randomBytes(32);
  const t = await bootRepoApp(db, undefined, {
    masterKey,
    connectorFactory: () => fake,
    ci,
    ...overrides,
  });
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
    releases: {
      version: string;
      build: string | null;
      track?: string;
      codes?: string[];
      status?: string;
      uploadedAt?: number;
    }[],
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
