import type { ChangeSet, Listing, ListingSections, Platform, ReleaseState } from '@mrm/core';

/**
 * Each store and each repo host sits behind one of these interfaces. Anything that is
 * specific to Apple, Google or GitHub (the Play "edit" model, App Store review items,
 * pull requests) stays inside the implementation.
 */

export type StoreApp = {
  storeId: string;
  platform: Platform;
  name: string;
  bundleId: string;
  /**
   * App Store Connect only, and only when `listApps({ withPlatforms: true })` was asked and Apple
   * answered it: the platforms (iOS, macOS) the app has a version for. Absent: not known.
   */
  platforms?: Platform[];
};

export type ListAppsOptions = {
  /** Also read which platforms each app has versions for (App Store Connect; one request with an `include`). */
  withPlatforms?: boolean;
};

export type StoreVersion = {
  storeId: string;
  appStoreId: string;
  platform: Platform;
  versionString: string;
  /** The store's own state name, kept verbatim. Mapping to the lifecycle happens in the connector. */
  rawState: string;
  /**
   * `rawState` mapped to the normalized lifecycle, or undefined when the store's state is unknown
   * or deliberately not mapped (never guessed). See `mapAppStoreState`, `mapPlayTrackRelease`.
   */
  lifecycleState?: ReleaseState;
  /** Google Play only: the track (`production`, `beta`, ...) this release is on. */
  track?: string;
  /** Google Play only: the version codes in the release. */
  versionCodes?: string[];
  /** Staged rollout share, 0 to 1, when the store reports one. */
  rolloutFraction?: number;
};

export type StoreBuild = {
  storeId: string;
  appStoreId: string;
  platform: Platform;
  buildNumber: string;
  versionString?: string;
  processing: 'processing' | 'processed' | 'invalid';
  /** The store's own processing state, verbatim (Apple `processingState`). */
  rawProcessingState?: string;
  /** Epoch milliseconds. */
  uploadedAt?: number;
  /** True once the store no longer accepts the build (Apple `expired`). */
  expired?: boolean;
};

/**
 * The localized listing as the store holds it, in the shared per-locale model of `@mrm/core`.
 *
 * - App Store Connect has two copies: the version users see (`live`) and the version being
 *   prepared (`editable`). Either can be absent (a new app has no live version; an app without a
 *   draft has no editable one).
 * - Google Play has one listing per language, reported as `live`. The Play model has no
 *   subtitle, keywords, promotional text, marketing, support or privacy URLs; the App Store model has
 *   no short description or promo video. A field the store does not have is absent, never empty.
 */
export type StoreListingChannel = {
  channel: 'live' | 'editable';
  /** App Store only: the marketing version the texts were read from. */
  versionString?: string;
  /** App Store only: the version's state, verbatim (`appVersionState`, else `appStoreState`). */
  versionRawState?: string;
  /** App Store only: the app info's state, verbatim (`state`, else `appStoreState`). */
  infoRawState?: string;
  /** Exactly one of `appStore` and `googlePlay` is set, matching the connector's platform. */
  listing: Listing;
  /**
   * What the store holds beyond the texts: categories, age rating, privacy choices, media counts,
   * app details, release notes (see `ListingSections`). Strictly read-only metadata. A section that
   * is absent was NOT READ (not asked, the store cannot say, or its call failed: `warnings` says
   * which); a section that is present and empty was read and the store has nothing.
   */
  sections?: ListingSections;
};

/** What `readListing` is asked to read. */
export type ReadStoreListingOptions = {
  /**
   * Also read the sections that need requests of their own (App Store Connect: categories, age
   * rating declaration and the screenshot and preview sets of every locale; Google Play: app
   * details, images of every language, track release notes). Default false: the texts, and the
   * sections that come out of the same responses. The server's listing read asks for them.
   */
  extended?: boolean;
};

export type StoreListing = {
  platform: Platform;
  appStoreId: string;
  channels: StoreListingChannel[];
  /** Things a person should know about what was (not) read. Safe to show. */
  warnings: string[];
};

export interface StoreConnector {
  readonly platform: Platform;
  verifyCredentials(): Promise<void>;
  listApps(options?: ListAppsOptions): Promise<StoreApp[]>;
  listVersions(appStoreId: string): Promise<StoreVersion[]>;
  listBuilds(appStoreId: string): Promise<StoreBuild[]>;
  /**
   * Reads the localized listing from the store. Read-only. Optional so that a connector without
   * it (a test double) still works; the listing read is then skipped.
   */
  readListing?(appStoreId: string, options?: ReadStoreListingOptions): Promise<StoreListing>;
}

export type ProposalResult = {
  branch: string;
  /** Pull request address, when the connector opened one. */
  url?: string;
  /** Pull request number, when the connector opened one. */
  number?: number;
  /** The commit the branch points to. */
  commitSha?: string;
};

export type ProposeOptions = {
  branch: string;
  title: string;
  /** Pull request description. Defaults to the change set summary and its file list. */
  body?: string;
  draft?: boolean;
  /**
   * Stops the work when aborted: no further request is sent, and the one in flight is cancelled.
   * Once a branch has been created, the pull request step is still finished, so an abort does not
   * strand a branch without one. Optional: a connector that ignores it still works.
   */
  signal?: AbortSignal;
};

export type OpenPullRequestOptions = {
  /** The branch with the changes (the pull request's head). It must already exist on the host. */
  branch: string;
  /** The branch to merge into. */
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
  signal?: AbortSignal;
};

export type OpenPullRequestResult = {
  url?: string;
  number?: number;
};

/** A pull request as the host reports it. `merged` is a closed pull request that was merged. */
export type PullRequestInfo = {
  number: number;
  url?: string;
  state: 'open' | 'closed' | 'merged';
  /** The head branch and the branch it merges into. */
  branch?: string;
  base?: string;
};

/** What a fix-up commit changes: a path and its new text (no `content`: the file is deleted). */
export type BranchFileChange = { path: string; content?: string };

export type CommitOnBranchOptions = {
  branch: string;
  /** The commit the branch must point to now. Anything else is a `BranchMovedError`, and nothing is written. */
  expectedTip: string;
  changes: BranchFileChange[];
  message: string;
  signal?: AbortSignal;
};

export type CommitOnBranchResult = {
  /** The new commit, whose only parent is `parent` (the tip that was read). */
  commit: string;
  parent: string;
  tree: string;
  changed: number;
};

export type DispatchResult = {
  /**
   * The workflow run that was started. GitHub only reports it when asked for run details, so it
   * can be absent; find the run with `listWorkflowRuns` instead.
   */
  runId?: string;
  runUrl?: string;
};

export type WorkflowRun = {
  id: string;
  name?: string;
  /** GitHub's own status (`queued`, `in_progress`, `completed`, ...), kept verbatim. */
  status: string;
  /** Set once the run has completed (`success`, `failure`, `cancelled`, ...). */
  conclusion?: string;
  url: string;
  branch?: string;
  headSha?: string;
  event?: string;
  runNumber?: number;
  /** Epoch milliseconds. */
  createdAt?: number;
  updatedAt?: number;
};

export type ListWorkflowRunsOptions = {
  /** Workflow file name or id. Omit to list runs of every workflow. */
  workflow?: string;
  branch?: string;
  event?: string;
  status?: string;
  headSha?: string;
  /** At most 100 (one page). Default 30. Newest first. */
  limit?: number;
};

export interface RepoConnector {
  readonly kind: 'github' | 'local';
  /** Paths of all files at `ref` (default: the default branch). Folders are not listed. */
  listFiles(ref?: string): Promise<string[]>;
  /** The text of a file, or undefined when there is no such file. */
  readFile(path: string, ref?: string): Promise<string | undefined>;
  /** Apply a change set as a branch, and as a pull request where the host supports it. */
  propose(changeSet: ChangeSet, options: ProposeOptions): Promise<ProposalResult>;
  /**
   * Opens a pull request for a branch that is already on the host (a local commit that was pushed).
   * Optional: a connector without it cannot open one for an existing branch.
   */
  openPullRequest?(options: OpenPullRequestOptions): Promise<OpenPullRequestResult>;
  /** The commit a branch points to, or undefined when there is no such branch. Optional (fix-up). */
  branchTip?(branch: string, signal?: AbortSignal): Promise<string | undefined>;
  /**
   * Adds ONE commit on top of the tip of an existing branch and moves the branch to it with a
   * fast-forward only (never forced). Optional (fix-up): a connector without it cannot fix up.
   */
  commitOnBranch?(options: CommitOnBranchOptions): Promise<CommitOnBranchResult>;
  /** A pull request by number, or the newest one whose head is `branch`; undefined when there is none. Optional (fix-up). */
  findPullRequest?(options: {
    number?: number;
    branch?: string;
    signal?: AbortSignal;
  }): Promise<PullRequestInfo | undefined>;
  dispatchWorkflow(
    workflow: string,
    ref: string,
    inputs?: Record<string, string>,
  ): Promise<DispatchResult>;
  listWorkflowRuns(options?: ListWorkflowRunsOptions): Promise<WorkflowRun[]>;
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}
