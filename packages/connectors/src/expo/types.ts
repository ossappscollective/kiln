/**
 * The shapes the Expo (EAS) client returns, and the one place later features add theirs (builds, submissions, updates, workflow runs).
 * Every field here was checked against Expo's own sources (docs/adr/0033-eas-integration.md lists where); a field that could not be
 * checked is not in this file. Keep each type to what its query selects, so a type never promises more than the query asked for.
 */

/** Who a token belongs to (`meActor`). `Actor` is an interface in Expo's schema; the concrete type is `__typename`. */
export type ExpoActorKind = 'robot' | 'user' | 'sso_user' | 'other';

export type ExpoAccountRef = {
  id: string;
  /** The account name, as it appears in `@name/slug`. */
  name: string;
};

export type ExpoViewer = {
  id: string;
  /** Expo's `__typename`: `Robot`, `User`, `SSOUser`, ... (kept as sent). */
  typename: string;
  kind: ExpoActorKind;
  /** The name Expo shows for the actor (a robot's name, a person's name). */
  displayName: string;
  /** Only a person (`UserActor`) has one; a robot has none. */
  username: string | null;
  /** The accounts the token can act on: the personal account and organizations it was granted. */
  accounts: ExpoAccountRef[];
};

/** An EAS project (Expo calls it an `App`). */
export type ExpoProject = {
  /** The project id (a UUID): `expo.extra.eas.projectId` of app.json. */
  id: string;
  name: string;
  /** `@account/slug`. */
  fullName: string;
  slug: string;
  ownerAccount: ExpoAccountRef;
};

// ---------------------------------------------------------------------------------------------
// EAS Update (docs/adr/0037-eas-update.md). Field names are the ones eas-cli selects (UpdateFragment, UpdateChannelBasicInfoFragment,
// ViewUpdateChannelsOnApp, ViewUpdateGroupInsights); see queries.ts for what was and was not verified.

/** One entry of a channel's branch mapping: a branch and whether it receives every client or only those a condition selects. */
export type ExpoBranchMappingEntry = {
  branchId: string;
  /** `always`: the literal `"true"`. `conditional`: a condition decides, as in a rollout between two branches. */
  logic: 'always' | 'conditional';
  /** The condition as short text (`rolloutToken hash_lt 0.25`), or null for `always`. Its scale is UNVERIFIED, so no percentage is derived. */
  condition: string | null;
};

/**
 * `branchMapping` of a channel (a JSON string at Expo). `none`: no branch (data is empty). `branch`: one branch for everyone.
 * `rollout`: two or more entries. `unreadable`: the string was not a mapping this reader knows.
 */
export type ExpoBranchMapping = {
  kind: 'none' | 'branch' | 'rollout' | 'unreadable';
  version: number | null;
  entries: ExpoBranchMappingEntry[];
};

/** One published update (one platform of an update group). */
export type ExpoUpdate = {
  id: string;
  /** The update group id: the updates published together (one per platform) share it. */
  group: string;
  message: string | null;
  /** Epoch ms. */
  createdAt: number | null;
  /** Expo's platform key as sent, lower case (`ios`, `android`). */
  platform: string;
  runtimeVersion: string | null;
  gitCommitHash: string | null;
  isRollBackToEmbedded: boolean;
  /** A per-update rollout: the share of clients that get it, 1 to 100; null when it is not mid-rollout. */
  rolloutPercentage: number | null;
  /** The group of the update the rollout is measured against, when Expo names one. */
  rolloutControlGroup: string | null;
};

/** Updates published together, one per platform. Newest first within a branch. */
export type ExpoUpdateGroup = { group: string; updates: ExpoUpdate[] };

export type ExpoUpdateBranch = {
  id: string;
  name: string;
  /** The newest groups Expo returned (a few, not the history). */
  groups: ExpoUpdateGroup[];
};

export type ExpoUpdateChannel = {
  id: string;
  name: string;
  isPaused: boolean | null;
  isProtected: boolean | null;
  createdAt: number | null;
  updatedAt: number | null;
  mapping: ExpoBranchMapping;
  /** The branches Expo lists under the channel (at most five). */
  branches: ExpoUpdateBranch[];
};

export type ExpoUpdateChannels = {
  channels: ExpoUpdateChannel[];
  /** The channel page was full: there may be more channels than shown. */
  truncated: boolean;
};

/** A finished build for store distribution: the binary an update has to match. */
export type ExpoStoreBuild = {
  id: string;
  /** Lower case platform key (`ios`, `android`). */
  platform: string;
  /** `runtime.version` of the build; null when Expo has none (expo-updates not configured for it). */
  runtimeVersion: string | null;
  appVersion: string | null;
  appBuildVersion: string | null;
  /** The update channel baked into the binary; null when none. */
  channel: string | null;
  createdAt: number | null;
  completedAt: number | null;
};

/** Insights of one update (one platform of a group) over a time span. */
export type ExpoUpdateInsights = {
  updateId: string;
  platform: string;
  /** Installs (launches of the update) in the span. */
  launches: number | null;
  /** Failed installs in the span. */
  failedLaunches: number | null;
  /** failed / (installs + failed) as a percentage (a crash rate by the formula eas-cli documents); null when both are zero or unknown. */
  crashRatePercent: number | null;
  uniqueUsers: number | null;
  /** Average number of assets launched, and the average size of the update payload in bytes. */
  launchAssetCount: number | null;
  averagePayloadBytes: number | null;
};

/** The state Expo reports after a rollout percentage was set. */
export type ExpoUpdateRolloutResult = {
  updateId: string;
  group: string | null;
  rolloutPercentage: number | null;
};

// ---------------------------------------------------------------------------------------------
// EAS Build and Submit status (docs/adr/0036-eas-build-submit-status.md). Field names are the ones eas-cli selects (BuildFragment in
// graphql/types/Build.ts, GetProjectStatusSubmissions in graphql/queries/SubmissionQuery.ts); see queries.ts for what was verified.

/** Expo's `AppPlatform` (`IOS`, `ANDROID`) in lower case. EAS builds and submits for these two only. */
export type ExpoPlatformKey = 'ios' | 'android';

/** Expo's `BuildStatus`; `unknown` for a value this reader does not know (the raw text is kept in `rawStatus`). */
export type ExpoBuildStatus =
  | 'new'
  | 'in_queue'
  | 'in_progress'
  | 'pending_cancel'
  | 'finished'
  | 'errored'
  | 'canceled'
  | 'unknown';

/** Expo's `SubmissionStatus`; `unknown` for a value this reader does not know. */
export type ExpoSubmissionStatus =
  | 'awaiting_build'
  | 'in_queue'
  | 'in_progress'
  | 'finished'
  | 'errored'
  | 'canceled'
  | 'unknown';

/** Expo's `DistributionType` (`STORE`, `INTERNAL`, `SIMULATOR`) in lower case; `unknown` for anything else. */
export type ExpoBuildDistribution = 'store' | 'internal' | 'simulator' | 'unknown';

export type ExpoErrorDetail = {
  /** Expo's error code (`errorCode`), when it sent one that looks like a code. */
  code: string | null;
  /** Expo's text, at most 500 characters. Shown to people; never logged. */
  message: string | null;
};

/** One EAS build, as much of it as a status view needs. The address of the build file is read only to say whether one exists. */
export type ExpoBuildSummary = {
  id: string;
  status: ExpoBuildStatus;
  rawStatus: string;
  /** Null when the platform is not iOS or Android (this reader knows only those two). */
  platform: ExpoPlatformKey | null;
  buildProfile: string | null;
  /** The update channel baked into the binary (`updateChannel.name`). */
  channel: string | null;
  /** The marketing version (`appVersion`). */
  appVersion: string | null;
  /** The build number on iOS and the version code on Android (`appBuildVersion`: UNVERIFIED which of them Expo puts there per platform). */
  appBuildVersion: string | null;
  sdkVersion: string | null;
  /** `runtime.version`. */
  runtimeVersion: string | null;
  distribution: ExpoBuildDistribution;
  /** `isForIosSimulator`. */
  simulator: boolean | null;
  appIdentifier: string | null;
  gitCommitHash: string | null;
  /** The first line of the commit message, at most 200 characters. */
  gitCommitMessage: string | null;
  error: ExpoErrorDetail | null;
  /** Expo holds a build file for it (`artifacts.buildUrl` or `applicationArchiveUrl` is set). The address itself is not kept. */
  hasArtifact: boolean;
  /** Epoch ms. */
  createdAt: number | null;
  updatedAt: number | null;
  completedAt: number | null;
  /** When Expo deletes the build file (`expirationDate`). */
  expiresAt: number | null;
};

/** One EAS submission: a build sent to App Store Connect or Google Play. */
export type ExpoSubmissionSummary = {
  id: string;
  status: ExpoSubmissionStatus;
  rawStatus: string;
  platform: ExpoPlatformKey | null;
  /** The EAS build that was submitted (`submittedBuild.id`); null when Expo names none. */
  buildId: string | null;
  /** `androidConfig.applicationIdentifier` or `iosConfig.ascAppIdentifier`, as Expo reports it. */
  targetIdentifier: string | null;
  /** Google Play: `androidConfig.track` and `releaseStatus`, as sent. */
  track: string | null;
  releaseStatus: string | null;
  error: ExpoErrorDetail | null;
  createdAt: number | null;
  completedAt: number | null;
};

/** A page of a list read at Expo: `full` means the page was full, so older items may exist. */
export type ExpoPage<T> = { items: T[]; full: boolean };
