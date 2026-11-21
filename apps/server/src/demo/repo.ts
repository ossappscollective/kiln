import type {
  CiArtifact,
  CiArtifactDownload,
  CiArtifactList,
  CiJob,
  CiJobList,
  CiRun,
  CiRunPage,
  CiWorkflow,
  DispatchResult,
  ListWorkflowRunsOptions,
} from '@mrm/connectors';
import { FakeCi } from '../modules/ci/test-helpers.ts';
import { BlobRepo } from '../modules/publish/test-helpers.ts';
import { type ArtifactKind, artifactZip, sha256Hex } from './artifacts.ts';
import {
  APPLE_LOCALES,
  appleTexts,
  DEMO_APPS,
  type DemoApp,
  langOf,
  PLAY_LOCALES,
  playTexts,
} from './content.ts';
import { featureGraphicPng, iconPng, screenshotPng } from './images.ts';
import type { DemoBuild, DemoWorld } from './world.ts';

const DAY = 86_400_000;
const SHA = (n: number) => n.toString(16).padStart(8, '0').repeat(5);

/** The repository of Demo Studio: one monorepo for all three apps, with fastlane metadata, screenshots and three workflows. */
export const REPO = { owner: 'demo-studio', repo: 'apps' } as const;

const WORKFLOWS: { id: string; path: string; name: string }[] = [
  { id: '9001', path: '.github/workflows/release.yml', name: 'Release' },
  { id: '9002', path: '.github/workflows/build-ios.yml', name: 'Build iOS and macOS' },
  { id: '9003', path: '.github/workflows/build-android.yml', name: 'Build Android' },
];

const RELEASE_YML = `name: Release
on:
  workflow_dispatch:
    inputs:
      app:
        description: Which app to release
        required: true
        type: choice
        options: [notes, weather, focus]
        default: notes
      platform:
        description: Platforms to build
        required: true
        type: choice
        options: [all, ios, macos, android]
        default: all
      version:
        description: Marketing version
        required: true
        type: string
      notes:
        description: Upload what's new text
        type: boolean
        default: true
jobs:
  build:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - run: bundle exec fastlane release
`;
const BUILD_IOS_YML = `name: Build iOS and macOS
on:
  workflow_dispatch:
    inputs:
      app:
        description: Which app to build
        required: true
        type: choice
        options: [notes, weather, focus]
        default: notes
      configuration:
        description: Build configuration
        type: choice
        options: [Release, Beta]
        default: Release
jobs:
  build:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - run: bundle exec fastlane ios beta
`;
const BUILD_ANDROID_YML = `name: Build Android
on:
  workflow_dispatch:
    inputs:
      app:
        description: Which app to build
        required: true
        type: choice
        options: [notes, weather]
        default: notes
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bundle exec fastlane android beta
`;

type DemoRun = {
  id: string;
  workflow: (typeof WORKFLOWS)[number];
  createdAt: number;
  /** How long the run takes (simulated clock). */
  durationMs: number;
  conclusion: 'success' | 'failure' | 'cancelled';
  inputs: Record<string, string>;
  sha: string;
  number: number;
  actor: string;
  /** Builds the run uploads when it finishes: `<platform>:<app key>`. */
  produces: string[];
  produced: boolean;
  message: string;
};

type RepoState = { runs: DemoRun[]; nextId: number; nextNumber: number };

const STEPS = [
  'Set up job',
  'Checkout',
  'Install dependencies',
  'Run tests',
  'Build',
  'Upload to the store',
  'Post checkout',
];

export class DemoRepo extends BlobRepo {
  readonly world: DemoWorld;
  #runs: DemoRun[] = [];
  #nextId = 7_001;
  #nextNumber = 130;
  /** Tags, releases, commits and a comparison: the delegate of the FakeCi (static). */
  readonly ci = new FakeCi();

  constructor(world: DemoWorld) {
    super({});
    this.world = world;
    this.files = new Map();
    this.blobs = new Map();
    this.ci.workflows = WORKFLOWS.map((w) => ({
      id: w.id,
      name: w.name,
      path: w.path,
      state: 'active',
    }));
  }

  // ---- content ---------------------------------------------------------------------------------------------------------

  populate() {
    const f = (path: string, text: string) => this.files.set(path, text);
    const b = (path: string, bytes: Uint8Array) => this.blobs.set(path, Buffer.from(bytes));
    f('fastlane/Appfile', 'app_identifier(ENV["APP_ID"])\npackage_name(ENV["APP_ID"])\n');
    f(
      'fastlane/Fastfile',
      [
        'platform :ios do',
        '  lane :beta do',
        '    build_app(scheme: ENV["SCHEME"])',
        '    upload_to_testflight',
        '  end',
        'end',
        '',
        'platform :android do',
        '  lane :beta do',
        '    gradle(task: "bundleRelease")',
        '    upload_to_play_store(track: "internal")',
        '  end',
        'end',
        '',
      ].join('\n'),
    );
    f('.github/workflows/release.yml', RELEASE_YML);
    f('.github/workflows/build-ios.yml', BUILD_IOS_YML);
    f('.github/workflows/build-android.yml', BUILD_ANDROID_YML);
    f(
      'README.md',
      '# Demo Studio apps\n\nA made-up monorepo for the kiln demo.\n',
    );
    for (const app of DEMO_APPS) this.#populateApp(app, f, b);
    for (const w of WORKFLOWS) this.ci.files.set(w.path, this.files.get(w.path) as string);
    this.#seedRuns();
    this.#seedGit();
  }

  #populateApp(
    app: DemoApp,
    f: (p: string, t: string) => void,
    b: (p: string, x: Uint8Array) => void,
  ) {
    const apple = app.platforms.some((p) => p !== 'android');
    const play = app.platforms.includes('android');
    const root = `fastlane/metadata/${app.identifier}`;
    if (apple) {
      for (const locale of APPLE_LOCALES) {
        for (const [field, value] of Object.entries(appleTexts(app, langOf(locale))))
          f(`${root}/ios/${locale}/${field}.txt`, `${value}\n`);
      }
      f(`${root}/ios/copyright.txt`, '2026 Demo Studio\n');
      f(`${root}/ios/primary_category.txt`, app.key === 'weather' ? 'WEATHER\n' : 'PRODUCTIVITY\n');
      f(`${root}/ios/review_information/notes.txt`, 'No account is needed to review this app.\n');
      const iphone: [number, number] = [1290, 2796];
      app.platforms.includes('ios') &&
        [1, 2, 3].forEach((i) =>
          b(
            `${root}/ios/screenshots/en-US/${i}_iphone_67.png`,
            screenshotPng(app, iphone[0], iphone[1], i, { alpha: app.key === 'notes' && i === 3 }),
          ),
        );
      app.platforms.includes('ios') &&
        [1, 2].forEach((i) =>
          b(
            `${root}/ios/screenshots/de-DE/${i}_iphone_67.png`,
            screenshotPng(app, iphone[0], iphone[1], i + 10),
          ),
        );
      app.key === 'notes' &&
        [1, 2].forEach((i) =>
          b(`${root}/ios/screenshots/en-US/${i}_ipad_13.png`, screenshotPng(app, 2064, 2752, i)),
        );
      app.platforms.includes('macos') &&
        [1, 2, 3].forEach((i) =>
          b(`${root}/ios/screenshots/en-US/${i}_mac.png`, screenshotPng(app, 2880, 1800, i)),
        );
      b(`${root}/ios/icon-1024.png`, iconPng(app, 1024));
    }
    if (play) {
      for (const locale of PLAY_LOCALES) {
        for (const [field, value] of Object.entries(playTexts(app, langOf(locale))))
          f(`${root}/android/${locale}/${field}.txt`, `${value}\n`);
        f(
          `${root}/android/${locale}/changelogs/${app.key === 'notes' ? 240 : 280}.txt`,
          `${app.copy[langOf(locale)].notes}\n`,
        );
      }
      b(`${root}/android/en-US/images/icon.png`, iconPng(app, 512));
      b(`${root}/android/en-US/images/featureGraphic.png`, featureGraphicPng(app));
      [1, 2, 3, 4].forEach((i) =>
        b(
          `${root}/android/en-US/images/phoneScreenshots/${i}.png`,
          screenshotPng(app, 1080, 1920, i),
        ),
      );
      [1, 2].forEach((i) =>
        b(
          `${root}/android/de-DE/images/phoneScreenshots/${i}.png`,
          screenshotPng(app, 1080, 1920, i + 10),
        ),
      );
    }
  }

  #seedGit() {
    const t0 = this.world.seededAt;
    this.ci.tags = [
      { name: 'notes-ios-3.4.0-166', sha: SHA(1) },
      { name: 'notes-android-3.4.0-238', sha: SHA(2) },
      { name: 'weather-ios-2.9.0-413', sha: SHA(3) },
    ];
    this.ci.releases = [
      {
        id: '1',
        name: 'Notes 3.4.0',
        tagName: 'notes-ios-3.4.0-166',
        draft: false,
        prerelease: false,
        publishedAt: t0 - 20 * DAY,
        url: 'https://github.com/demo-studio/apps/releases/tag/notes-ios-3.4.0-166',
      },
    ];
    this.ci.comparison = {
      status: 'ahead',
      aheadBy: 3,
      behindBy: 0,
      totalCommits: 3,
      truncated: false,
      url: 'https://github.com/demo-studio/apps/compare/a...b',
      commits: [
        {
          sha: SHA(11),
          message: 'Notes: shared folders\n\nAdds invitation links.',
          author: 'Ada Demo',
          date: t0 - 4 * DAY,
          url: 'https://github.com/demo-studio/apps/commit/1',
        },
        {
          sha: SHA(12),
          message: 'Fix crash when pasting long text',
          author: 'Grace Demo',
          date: t0 - 3 * DAY,
          url: 'https://github.com/demo-studio/apps/commit/2',
        },
        {
          sha: SHA(13),
          message: 'Bump build to 168',
          author: 'CI',
          date: t0 - 3 * DAY,
          url: 'https://github.com/demo-studio/apps/commit/3',
        },
      ],
    };
  }

  /** Run history: a month of builds, one failure, one run in progress, and a succeeded release run nobody finished. */
  #seedRuns() {
    const t0 = this.world.seededAt;
    const mk = (
      daysAgo: number,
      hoursOffset: number,
      wf: number,
      inputs: Record<string, string>,
      over: Partial<DemoRun> = {},
    ): void => {
      const w = WORKFLOWS[wf] as (typeof WORKFLOWS)[number];
      const createdAt = t0 - daysAgo * DAY - hoursOffset * 3_600_000;
      this.#runs.push({
        id: String(this.#nextId++),
        workflow: w,
        createdAt,
        durationMs: (4 + (this.#nextId % 5)) * 60_000,
        conclusion: 'success',
        inputs,
        sha: SHA(100 + this.#nextId),
        number: this.#nextNumber++,
        actor: 'ada-demo',
        produces: [],
        produced: true,
        message: `Run of ${w.name}`,
        ...over,
      });
    };
    mk(28, 2, 0, { app: 'notes', platform: 'all', version: '3.3.0' });
    mk(22, 1, 1, { app: 'weather', configuration: 'Release' });
    mk(20, 3, 0, { app: 'notes', platform: 'all', version: '3.4.0' });
    mk(19, 4, 2, { app: 'notes' });
    mk(
      16,
      0,
      2,
      { app: 'weather' },
      { conclusion: 'failure', message: 'Gradle build failed: signing config missing' },
    );
    mk(15, 1, 2, { app: 'weather' });
    mk(12, 2, 1, { app: 'focus', configuration: 'Release' });
    mk(9, 0, 1, { app: 'notes', configuration: 'Beta' }, { conclusion: 'cancelled' });
    mk(6, 5, 0, { app: 'focus', platform: 'macos', version: '1.7.0' });
    // The release run that succeeded three days ago; its version was approved and nobody released it.
    mk(
      3,
      1,
      0,
      { app: 'weather', platform: 'ios', version: '2.9.0' },
      { message: 'Release Demo Weather 2.9.0 (ios)' },
    );
    mk(3, 0, 1, { app: 'notes', configuration: 'Release' }, { message: 'Build Demo Notes 3.5.0' });
    mk(1, 2, 2, { app: 'notes' }, { message: 'Build Demo Notes Android 3.5.0' });
    // In progress: started now, takes 9 minutes of the simulated clock.
    this.#runs.push({
      id: String(this.#nextId++),
      workflow: WORKFLOWS[1] as (typeof WORKFLOWS)[number],
      createdAt: t0 - 40_000,
      durationMs: 9 * 60_000,
      conclusion: 'success',
      inputs: { app: 'notes', configuration: 'Release' },
      sha: SHA(555),
      number: this.#nextNumber++,
      actor: 'ada-demo',
      produces: [],
      produced: true,
      message: 'Build Demo Notes 3.5.0 (build 170)',
    });
  }

  // ---- runs over time ------------------------------------------------------------------------------------------------------

  #view(run: DemoRun, now: number): CiRun {
    const age = now - run.createdAt;
    const queued = age < 6_000;
    const done = age >= run.durationMs;
    return {
      id: run.id,
      name: run.workflow.name,
      displayTitle: run.message,
      path: run.workflow.path,
      workflowId: run.workflow.id,
      status: queued ? 'queued' : done ? 'completed' : 'in_progress',
      ...(done ? { conclusion: run.conclusion } : {}),
      url: `https://github.com/${REPO.owner}/${REPO.repo}/actions/runs/${run.id}`,
      branch: 'main',
      headSha: run.sha,
      event: 'workflow_dispatch',
      runNumber: run.number,
      createdAt: run.createdAt,
      startedAt: run.createdAt + 6_000,
      updatedAt: Math.min(now, run.createdAt + run.durationMs),
      actor: run.actor,
      commitMessage: run.message,
    };
  }

  #jobs(run: DemoRun, now: number): CiJob[] {
    const t = run.createdAt + 6_000;
    const total = run.durationMs - 6_000;
    const names = run.workflow.path.includes('android')
      ? ['test', 'bundle']
      : ['test', 'archive', 'upload'];
    const per = total / names.length;
    return names.map((name, ji) => {
      const start = t + ji * per;
      const end = start + per;
      const status = now < start ? 'queued' : now >= end ? 'completed' : 'in_progress';
      const failedHere = run.conclusion === 'failure' && ji === names.length - 1;
      const cancelledHere = run.conclusion === 'cancelled' && ji === 0;
      const stepPer = per / STEPS.length;
      return {
        id: `${run.id}${ji}`,
        name,
        status,
        conclusion:
          status === 'completed'
            ? failedHere
              ? 'failure'
              : cancelledHere
                ? 'cancelled'
                : run.conclusion === 'cancelled'
                  ? 'skipped'
                  : 'success'
            : null,
        startedAt: status === 'queued' ? null : start,
        completedAt: status === 'completed' ? end : null,
        url: `https://github.com/${REPO.owner}/${REPO.repo}/actions/runs/${run.id}/job/${run.id}${ji}`,
        steps: STEPS.map((step, si) => {
          const s0 = start + si * stepPer;
          const s1 = s0 + stepPer;
          const stStatus = now < s0 ? 'queued' : now >= s1 ? 'completed' : 'in_progress';
          return {
            number: si + 1,
            name: step,
            status: stStatus,
            conclusion:
              stStatus === 'completed' ? (failedHere && si === 4 ? 'failure' : 'success') : null,
            startedAt: stStatus === 'queued' ? null : s0,
            completedAt: stStatus === 'completed' ? s1 : null,
          };
        }),
      };
    });
  }

  /** Called whenever the clock moves or a run is read: a finished run uploads its builds. */
  tick() {
    const now = this.world.now();
    for (const run of this.#runs) {
      if (run.produced || now - run.createdAt < run.durationMs) continue;
      run.produced = true;
      if (run.conclusion !== 'success') continue;
      for (const target of run.produces) {
        const [platform, appKey] = target.split(':') as ['ios' | 'macos' | 'android', string];
        const side = [...this.world.sides.values()].find(
          (s) => s.platform === platform && s.app.key === appKey,
        );
        if (!side) continue;
        const last = Math.max(...side.builds.map((x) => Number(x.number)));
        const build: DemoBuild = {
          number: String(last + 1),
          version: run.inputs.version ?? side.app.next,
          platform,
          uploadedAt: run.createdAt + run.durationMs,
          readyAt: run.createdAt + run.durationMs + (platform === 'android' ? 0 : 45_000),
          notes: { 'en-US': 'Built by the demo workflow.' },
          runId: run.id,
        };
        side.builds.push(build);
        if (platform === 'android') side.release.uploaded.add(build.number);
      }
    }
  }

  // ---- the connector ---------------------------------------------------------------------------------------------------

  override async defaultBranch(): Promise<string> {
    return 'main';
  }

  override async dispatchWorkflow(
    workflow: string,
    _ref: string,
    inputs: Record<string, string> = {},
  ): Promise<DispatchResult> {
    const w = WORKFLOWS.find(
      (x) =>
        x.path === workflow ||
        x.path.endsWith(`/${workflow}`) ||
        x.id === workflow ||
        x.name === workflow,
    );
    if (!w)
      throw Object.assign(new Error(`No workflow ${workflow}`), {
        name: 'GithubError',
        kind: 'not_found',
        status: 404,
      });
    const app = inputs.app ?? 'notes';
    const platform = inputs.platform ?? 'all';
    const produces: string[] = [];
    const sides = [...this.world.sides.values()].filter((s) => s.app.key === app);
    for (const s of sides) {
      const buildsIos =
        w.path.includes('build-ios') ||
        (w.path.includes('release') && (platform === 'all' || platform === s.platform));
      const buildsAndroid =
        w.path.includes('build-android') ||
        (w.path.includes('release') && (platform === 'all' || platform === 'android'));
      if (s.platform === 'android' ? buildsAndroid : buildsIos)
        produces.push(`${s.platform}:${app}`);
    }
    const run: DemoRun = {
      id: String(this.#nextId++),
      workflow: w,
      createdAt: this.world.now(),
      durationMs: 60_000,
      conclusion: 'success',
      inputs,
      sha: SHA(200 + this.#nextId),
      number: this.#nextNumber++,
      actor: 'demo-owner',
      produces,
      produced: false,
      message: `${w.name}: ${app}${inputs.version ? ` ${inputs.version}` : ''}`,
    };
    this.#runs.push(run);
    return {
      runId: run.id,
      runUrl: `https://github.com/${REPO.owner}/${REPO.repo}/actions/runs/${run.id}`,
    };
  }

  async listWorkflows(): Promise<CiWorkflow[]> {
    return this.ci.workflows;
  }
  async listCiRuns(
    options: ListWorkflowRunsOptions & { signal?: AbortSignal } = {},
  ): Promise<CiRun[]> {
    this.tick();
    const now = this.world.now();
    return [...this.#runs]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => this.#view(r, now))
      .filter(
        (r) =>
          (options.workflow
            ? r.path === options.workflow || r.path?.endsWith(`/${options.workflow}`) === true
            : true) &&
          (options.status ? r.status === options.status : true) &&
          (options.headSha ? r.headSha === options.headSha : true),
      )
      .slice(0, options.limit ?? 30);
  }
  async listCiRunsPage(
    options: ListWorkflowRunsOptions & { signal?: AbortSignal; etag?: string | undefined } = {},
  ): Promise<CiRunPage> {
    return { runs: await this.listCiRuns(options), notModified: false };
  }
  async getCiRun(runId: string): Promise<CiRun | undefined> {
    this.tick();
    const run = this.#runs.find((r) => r.id === runId);
    return run ? this.#view(run, this.world.now()) : undefined;
  }
  async listRunJobs(runId: string): Promise<CiJobList> {
    const run = this.#runs.find((r) => r.id === runId);
    if (!run) return { jobs: [], notModified: false, truncated: false, missing: true };
    return { jobs: this.#jobs(run, this.world.now()), notModified: false, truncated: false };
  }
  override async listWorkflowRuns(): Promise<never> {
    throw new Error('not used: the CI code uses listCiRuns');
  }
  // ---- workflow artifacts ------------------------------------------------------------------------------------------------
  // A finished, successful build run uploads one tiny zip (an .ipa, .dmg, .apk or .aab named like the build). Derived from the
  // runs, so a run the person starts in the demo gets its artifact when it finishes. Downloads stream the same bytes.

  #artifacts(): { artifact: CiArtifact; zip: Uint8Array }[] {
    this.tick();
    const now = this.world.now();
    const out: { artifact: CiArtifact; zip: Uint8Array }[] = [];
    for (const run of this.#runs) {
      const isIos = run.workflow.id === '9002';
      if (
        (!isIos && run.workflow.id !== '9003') ||
        run.conclusion !== 'success' ||
        now - run.createdAt < run.durationMs
      )
        continue;
      const app = DEMO_APPS.find((a) => a.key === run.inputs.app);
      if (!app) continue;
      const platform = isIos ? (app.platforms.includes('ios') ? 'ios' : 'macos') : 'android';
      const side = [...this.world.sides.values()].find(
        (s) => s.app.key === app.key && s.platform === platform,
      );
      if (!side) continue;
      const finished = run.createdAt + run.durationMs;
      const build =
        side.builds.find((b) => b.runId === run.id) ??
        [...side.builds].sort(
          (a, b) => Math.abs(a.uploadedAt - finished) - Math.abs(b.uploadedAt - finished),
        )[0];
      if (!build) continue;
      const kind: ArtifactKind =
        platform === 'ios'
          ? 'ipa'
          : platform === 'macos'
            ? 'dmg'
            : app.key === 'weather'
              ? 'aab'
              : 'apk';
      const name = `${app.name.toLowerCase().replace(/\s+/g, '-')}-${run.inputs.version ?? build.version}-${build.number}.${kind}`;
      const zip = artifactZip({
        name,
        kind,
        appName: app.name,
        version: run.inputs.version ?? build.version,
        build: build.number,
      });
      out.push({
        zip,
        artifact: {
          id: String(880_000 + Number(run.id)),
          name,
          sizeInBytes: zip.length,
          expired: false,
          createdAt: finished,
          expiresAt: finished + 90 * DAY,
          runId: run.id,
          headBranch: 'main',
          headSha: run.sha,
          digest: `sha256:${sha256Hex(zip)}`,
        },
      });
    }
    return out.sort((a, b) => (b.artifact.createdAt ?? 0) - (a.artifact.createdAt ?? 0));
  }
  async listArtifacts(
    options: {
      runId?: string;
      maxPages?: number;
      signal?: AbortSignal;
      etag?: string | undefined;
    } = {},
  ): Promise<CiArtifactList> {
    const artifacts = this.#artifacts()
      .map((x) => x.artifact)
      .filter((a) => options.runId === undefined || a.runId === options.runId);
    return { artifacts, truncated: false, notModified: false };
  }
  async openArtifactDownload(
    artifactId: string,
    _options: { signal?: AbortSignal; allowHttp?: boolean } = {},
  ): Promise<CiArtifactDownload> {
    const found = this.#artifacts().find((x) => x.artifact.id === artifactId);
    if (!found) return { status: 'missing' };
    const bytes = found.zip;
    return {
      status: 'ok',
      contentLength: bytes.length,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  }

  listTags = (options?: { maxPages?: number; signal?: AbortSignal }) => this.ci.listTags(options);
  listMatchingTags = (prefix: string, options?: { signal?: AbortSignal }) =>
    this.ci.listMatchingTags(prefix, options);
  getCommit = (ref: string, signal?: AbortSignal) => this.ci.getCommit(ref, signal);
  listReleases = (options?: { maxPages?: number; signal?: AbortSignal }) =>
    this.ci.listReleases(options);
  compareCommits = (base: string, head: string) => this.ci.compareCommits(base, head);

  // ---- persistence -------------------------------------------------------------------------------------------------------

  snapshot(): RepoState {
    return { runs: this.#runs, nextId: this.#nextId, nextNumber: this.#nextNumber };
  }
  restore(state: RepoState) {
    this.#runs = state.runs;
    this.#nextId = state.nextId;
    this.#nextNumber = state.nextNumber;
  }
}
