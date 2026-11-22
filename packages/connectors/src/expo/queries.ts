import type { ExpoGraphql } from './client.ts';
import { ExpoError } from './errors.ts';
import type { ExpoAccountRef, ExpoActorKind, ExpoProject, ExpoViewer } from './types.ts';
import type {
  ExpoBuildDistribution,
  ExpoBuildStatus,
  ExpoBuildSummary,
  ExpoErrorDetail,
  ExpoPage,
  ExpoPlatformKey,
  ExpoSubmissionStatus,
  ExpoSubmissionSummary,
} from './types.ts';
import { parseBranchMapping } from './updates.ts';
import type {
  ExpoStoreBuild,
  ExpoUpdate,
  ExpoUpdateBranch,
  ExpoUpdateChannel,
  ExpoUpdateChannels,
  ExpoUpdateGroup,
  ExpoUpdateInsights,
  ExpoUpdateRolloutResult,
} from './types.ts';

/**
 * The typed queries. Each one is the query text, the variables and a reader that checks what came back (nothing is trusted to have
 * the shape it should). Later features add theirs here or in their own file next to this one, and a type for each in types.ts.
 *
 * Verified against Expo's open source (expo/eas-cli, packages/eas-cli/src/graphql, checked 2026-11-20):
 * - `meActor` (queries/UserQuery.ts, types/Actor.ts): `__typename`, `id`, `displayName` (Actor interface), `accounts { id name }`,
 *   and `... on UserActor { username }`.
 * - `app { byId(appId: String!) }` and `app { byFullName(fullName: String!) }` (queries/AppQuery.ts) with `id name fullName slug
 *   ownerAccount { id name }` (types/App.ts).
 * NOT verified, so not used: what `meActor` answers for a token Expo does not know (this client treats `null` and an authentication
 * error alike), the exact error codes, and any field of builds, submissions, updates or workflows.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

const unreadable = () => new ExpoError('unexpected');

function accountOf(value: unknown): ExpoAccountRef {
  if (!isRecord(value)) throw unreadable();
  const id = text(value.id);
  const name = text(value.name);
  if (!id || !name) throw unreadable();
  return { id, name };
}

const actorKinds: Record<string, ExpoActorKind> = {
  Robot: 'robot',
  User: 'user',
  UserActor: 'user',
  SSOUser: 'sso_user',
};

export const VIEWER_QUERY = `query KilnViewer {
  meActor {
    __typename
    id
    displayName
    ... on UserActor { username }
    accounts { id name }
  }
}`;

/** Who the token belongs to, or `null` when Expo does not know the token. */
export async function expoViewer(client: ExpoGraphql): Promise<ExpoViewer | null> {
  const data = await client.graphql<{ meActor?: unknown }>({
    query: VIEWER_QUERY,
    operationName: 'KilnViewer',
  });
  const actor = data.meActor;
  if (actor === null || actor === undefined) return null;
  if (!isRecord(actor)) throw unreadable();
  const id = text(actor.id);
  const typename = text(actor.__typename);
  if (!id || !typename) throw unreadable();
  const accounts = Array.isArray(actor.accounts) ? actor.accounts.map(accountOf) : [];
  return {
    id,
    typename,
    kind: actorKinds[typename] ?? 'other',
    displayName: text(actor.displayName) ?? text(actor.username) ?? typename,
    username: text(actor.username) ?? null,
    accounts,
  };
}

const PROJECT_FIELDS = 'id name fullName slug ownerAccount { id name }';

function projectOf(value: unknown): ExpoProject {
  if (!isRecord(value)) throw unreadable();
  const id = text(value.id);
  const slug = text(value.slug);
  const fullName = text(value.fullName);
  if (!id || !slug || !fullName) throw unreadable();
  return {
    id,
    name: text(value.name) ?? slug,
    fullName,
    slug,
    ownerAccount: accountOf(value.ownerAccount),
  };
}

/** A project id is a UUID (`expo.extra.eas.projectId`). */
export const EXPO_PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isExpoProjectId = (value: string): boolean => EXPO_PROJECT_ID.test(value);

/** `@account/slug` from `@account/slug` or `account/slug`; undefined when it is neither. */
export function normalizeExpoFullName(value: string): string | undefined {
  const match = /^@?([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/.exec(
    value.trim(),
  );
  return match ? `@${match[1]}/${match[2]}` : undefined;
}

export const PROJECT_BY_FULL_NAME_QUERY = `query KilnProjectByFullName($fullName: String!) {
  app { byFullName(fullName: $fullName) { ${PROJECT_FIELDS} } }
}`;

export const PROJECT_BY_ID_QUERY = `query KilnProjectById($appId: String!) {
  app { byId(appId: $appId) { ${PROJECT_FIELDS} } }
}`;

/** The project `@account/slug` (or `account/slug`). `not_found` when Expo has none the token can see. */
export async function expoProjectByFullName(
  client: ExpoGraphql,
  fullName: string,
): Promise<ExpoProject> {
  const normalized = normalizeExpoFullName(fullName);
  if (!normalized) throw new ExpoError('invalid_input');
  const data = await client.graphql<{ app?: unknown }>({
    query: PROJECT_BY_FULL_NAME_QUERY,
    variables: { fullName: normalized },
    operationName: 'KilnProjectByFullName',
  });
  if (!isRecord(data.app)) throw unreadable();
  if (data.app.byFullName === null) throw new ExpoError('not_found');
  return projectOf(data.app.byFullName);
}

/** The project with this id (a UUID). `not_found` when Expo has none the token can see. */
export async function expoProjectById(
  client: ExpoGraphql,
  projectId: string,
): Promise<ExpoProject> {
  if (!isExpoProjectId(projectId)) throw new ExpoError('invalid_input');
  const data = await client.graphql<{ app?: unknown }>({
    query: PROJECT_BY_ID_QUERY,
    // Project ids are lower case UUIDs; an id typed in capitals is the same id.
    variables: { appId: projectId.toLowerCase() },
    operationName: 'KilnProjectById',
  });
  if (!isRecord(data.app)) throw unreadable();
  if (data.app.byId === null) throw new ExpoError('not_found');
  return projectOf(data.app.byId);
}

// ---------------------------------------------------------------------------------------------
// EAS Update (docs/adr/0037-eas-update.md)
//
// Verified in eas-cli (packages/eas-cli/src/graphql, checked 2026-11-20):
// - queries/ChannelQuery.ts: `app { byId(appId) { updateChannels(offset, limit) { id isPaused isProtected name updatedAt createdAt
//   branchMapping updateBranches(offset, limit) { id name updateGroups(offset, limit) { ...UpdateFragment } } } } }`.
//   `updateGroups` is a list of groups, a group is a list of updates (one per platform).
// - types/Update.ts, UpdateFragment: `id group message createdAt runtime { id version } platform gitCommitHash isRollBackToEmbedded
//   rolloutPercentage rolloutControlUpdate { id group } branch { id name }`.
// - queries/UpdateInsightsQuery.ts: `updatesByGroup(group: $groupId) { id platform insights { totalUniqueUsers(timespan) cumulativeAverageMetrics
//   { launchAssetCount averageUpdatePayloadBytes } cumulativeMetrics(timespan) { metricsAtLastTimestamp { totalInstalls totalFailedInstalls } } } }`
//   with `$groupId: ID!` and `$timespan: InsightsTimespan!` passed as `{ start, end }`.
// - queries/BuildQuery.ts: `app { byId(appId) { builds(offset, limit, filter: BuildFilter) { ...BuildFragment } } }`; BuildFragment has
//   `status platform distribution appVersion appBuildVersion runtime { id version } updateChannel { id name } createdAt completedAt`;
//   the generated schema lists BuildFilter fields (platform, status, distribution, ...), BuildStatus FINISHED and DistributionType STORE.
// - mutations/PublishMutation.ts: `update { setRolloutPercentage(updateId: ID!, percentage: Int!) { id ...UpdateFragment } }`
//   (`$rolloutPercentage: Int!`), the call eas-cli makes to change a per-update rollout.
// NOT verified, so labelled where it is used: the largest `limit` Expo accepts for each list; the value type of each BuildFilter field
// (enums are assumed); the wire format of `InsightsTimespan` values (ISO 8601 strings assumed); the scale of a branch-rollout operand;
// whether setRolloutPercentage refuses a lower value (this server never sends one); that "crash rate" is failed / (installs + failed)
// (the formula `eas update:insights` documents, read from a third-party copy of Expo's skill, not from eas-cli source); publishing an
// update, rolling back and changing a channel's branch mapping (not implemented).

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    return Number(value);
  return null;
};

const asTime = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

const UPDATE_FIELDS = `id group message createdAt runtime { version } platform gitCommitHash isRollBackToEmbedded
            rolloutPercentage rolloutControlUpdate { group }`;

export const UPDATE_CHANNELS_QUERY = `query KilnUpdateChannels($appId: String!, $channelLimit: Int!, $branchLimit: Int!, $groupLimit: Int!) {
  app {
    byId(appId: $appId) {
      id
      updateChannels(offset: 0, limit: $channelLimit) {
        id
        name
        isPaused
        isProtected
        createdAt
        updatedAt
        branchMapping
        updateBranches(offset: 0, limit: $branchLimit) {
          id
          name
          updateGroups(offset: 0, limit: $groupLimit) {
            ${UPDATE_FIELDS}
          }
        }
      }
    }
  }
}`;

function updateOf(value: unknown): ExpoUpdate | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const group = text(value.group);
  const platform = text(value.platform);
  if (!id || !group || !platform) return null;
  const rollout = asNumber(value.rolloutPercentage);
  return {
    id,
    group,
    message: text(value.message) ?? null,
    createdAt: asTime(value.createdAt),
    platform: platform.toLowerCase(),
    runtimeVersion: isRecord(value.runtime) ? (text(value.runtime.version) ?? null) : null,
    gitCommitHash: text(value.gitCommitHash) ?? null,
    isRollBackToEmbedded: value.isRollBackToEmbedded === true,
    rolloutPercentage: rollout !== null && rollout > 0 && rollout < 100 ? rollout : null,
    rolloutControlGroup: isRecord(value.rolloutControlUpdate)
      ? (text(value.rolloutControlUpdate.group) ?? null)
      : null,
  };
}

/** `updateGroups` is a list of lists of updates; a list that is not a list of lists is read as one group per update. */
function groupsOf(value: unknown): ExpoUpdateGroup[] {
  if (!Array.isArray(value)) return [];
  const out: ExpoUpdateGroup[] = [];
  for (const item of value) {
    const updates = (Array.isArray(item) ? item : [item])
      .map(updateOf)
      .filter((u): u is ExpoUpdate => u !== null);
    const first = updates[0];
    if (first) out.push({ group: first.group, updates });
  }
  return out;
}

function branchOf(value: unknown): ExpoUpdateBranch | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const name = text(value.name);
  if (!id || !name) return null;
  return { id, name, groups: groupsOf(value.updateGroups) };
}

function channelOf(value: unknown): ExpoUpdateChannel | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const name = text(value.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    isPaused: typeof value.isPaused === 'boolean' ? value.isPaused : null,
    isProtected: typeof value.isProtected === 'boolean' ? value.isProtected : null,
    createdAt: asTime(value.createdAt),
    updatedAt: asTime(value.updatedAt),
    mapping: parseBranchMapping(value.branchMapping),
    branches: (Array.isArray(value.updateBranches) ? value.updateBranches : [])
      .map(branchOf)
      .filter((b): b is ExpoUpdateBranch => b !== null),
  };
}

export const EXPO_UPDATE_CHANNEL_LIMIT = 25;
export const EXPO_UPDATE_BRANCH_LIMIT = 5;
export const EXPO_UPDATE_GROUP_LIMIT = 3;

/**
 * The update channels of a project with the branches each lists and the newest update groups of every branch. One request. The limits
 * (25 channels, 5 branches a channel, 3 groups a branch) keep the answer small; Expo's own maximum for each is UNVERIFIED.
 */
export async function expoUpdateChannels(
  client: ExpoGraphql,
  projectId: string,
  options: { channelLimit?: number | undefined; groupLimit?: number | undefined } = {},
): Promise<ExpoUpdateChannels> {
  if (!isExpoProjectId(projectId)) throw new ExpoError('invalid_input');
  const channelLimit = options.channelLimit ?? EXPO_UPDATE_CHANNEL_LIMIT;
  const data = await client.graphql<{ app?: unknown }>({
    query: UPDATE_CHANNELS_QUERY,
    variables: {
      appId: projectId.toLowerCase(),
      channelLimit,
      branchLimit: EXPO_UPDATE_BRANCH_LIMIT,
      groupLimit: options.groupLimit ?? EXPO_UPDATE_GROUP_LIMIT,
    },
    operationName: 'KilnUpdateChannels',
  });
  if (!isRecord(data.app)) throw unreadable();
  if (data.app.byId === null) throw new ExpoError('not_found');
  if (!isRecord(data.app.byId)) throw unreadable();
  const list = data.app.byId.updateChannels;
  if (!Array.isArray(list)) throw unreadable();
  return {
    channels: list.map(channelOf).filter((c): c is ExpoUpdateChannel => c !== null),
    truncated: list.length >= channelLimit,
  };
}

/** Expo's key for each platform in `BuildFilter.platform` (the `AppPlatform` enum: ANDROID, IOS). */
const BUILD_PLATFORM = { ios: 'IOS', android: 'ANDROID' } as const;

export const STORE_BUILDS_QUERY = `query KilnStoreBuildRuntimes($appId: String!, $limit: Int!, $filter: BuildFilter) {
  app {
    byId(appId: $appId) {
      id
      builds(offset: 0, limit: $limit, filter: $filter) {
        id
        status
        platform
        distribution
        appVersion
        appBuildVersion
        runtime { version }
        updateChannel { name }
        createdAt
        completedAt
      }
    }
  }
}`;

function buildOf(value: unknown, wanted: string): ExpoStoreBuild | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const platform = text(value.platform);
  if (!id || !platform) return null;
  // The filter asks for these three; a build that is not all of them is dropped in case the filter was not applied.
  if (value.status !== 'FINISHED' || value.distribution !== 'STORE') return null;
  if (platform.toLowerCase() !== wanted) return null;
  return {
    id,
    platform: platform.toLowerCase(),
    runtimeVersion: isRecord(value.runtime) ? (text(value.runtime.version) ?? null) : null,
    appVersion: text(value.appVersion) ?? null,
    appBuildVersion: text(value.appBuildVersion) ?? null,
    channel: isRecord(value.updateChannel) ? (text(value.updateChannel.name) ?? null) : null,
    createdAt: asTime(value.createdAt),
    completedAt: asTime(value.completedAt),
  };
}

/**
 * The newest finished builds with store distribution of one platform, with the runtime version and the update channel of each: the
 * binaries an update has to match. Filtered at Expo with `BuildFilter { platform, status: FINISHED, distribution: STORE }` (the value
 * types of those fields are UNVERIFIED) and checked again here.
 */
export async function expoStoreBuilds(
  client: ExpoGraphql,
  projectId: string,
  options: { platform: 'ios' | 'android'; limit?: number | undefined },
): Promise<ExpoStoreBuild[]> {
  if (!isExpoProjectId(projectId)) throw new ExpoError('invalid_input');
  const data = await client.graphql<{ app?: unknown }>({
    query: STORE_BUILDS_QUERY,
    variables: {
      appId: projectId.toLowerCase(),
      limit: options.limit ?? 20,
      filter: {
        platform: BUILD_PLATFORM[options.platform],
        status: 'FINISHED',
        distribution: 'STORE',
      },
    },
    operationName: 'KilnStoreBuildRuntimes',
  });
  if (!isRecord(data.app)) throw unreadable();
  if (data.app.byId === null) throw new ExpoError('not_found');
  if (!isRecord(data.app.byId) || !Array.isArray(data.app.byId.builds)) throw unreadable();
  return data.app.byId.builds
    .map((b: unknown) => buildOf(b, options.platform))
    .filter((b: ExpoStoreBuild | null): b is ExpoStoreBuild => b !== null);
}

export const UPDATE_INSIGHTS_QUERY = `query KilnUpdateGroupInsights($groupId: ID!, $timespan: InsightsTimespan!) {
  updatesByGroup(group: $groupId) {
    id
    platform
    insights {
      totalUniqueUsers(timespan: $timespan)
      cumulativeAverageMetrics {
        launchAssetCount
        averageUpdatePayloadBytes
      }
      cumulativeMetrics(timespan: $timespan) {
        metricsAtLastTimestamp {
          totalInstalls
          totalFailedInstalls
        }
      }
    }
  }
}`;

/** An update group id (and an update id) is a UUID; anything else is refused before it is sent. The UUID shape is assumed from eas-cli's use of `ID`: UNVERIFIED. */
export const EXPO_UPDATE_GROUP_ID = EXPO_PROJECT_ID;

function insightsOf(value: unknown): ExpoUpdateInsights | null {
  if (!isRecord(value)) return null;
  const updateId = text(value.id);
  const platform = text(value.platform);
  if (!updateId || !platform) return null;
  const insights = isRecord(value.insights) ? value.insights : {};
  const average = isRecord(insights.cumulativeAverageMetrics)
    ? insights.cumulativeAverageMetrics
    : {};
  const cumulative = isRecord(insights.cumulativeMetrics) ? insights.cumulativeMetrics : {};
  const last = isRecord(cumulative.metricsAtLastTimestamp) ? cumulative.metricsAtLastTimestamp : {};
  const launches = asNumber(last.totalInstalls);
  const failed = asNumber(last.totalFailedInstalls);
  const attempts = (launches ?? 0) + (failed ?? 0);
  return {
    updateId,
    platform: platform.toLowerCase(),
    launches,
    failedLaunches: failed,
    // failed / (installs + failed): the formula `eas update:insights` documents. Null when there was no launch at all.
    crashRatePercent:
      failed !== null && attempts > 0 ? Math.round((failed / attempts) * 10_000) / 100 : null,
    uniqueUsers: asNumber(insights.totalUniqueUsers),
    launchAssetCount: asNumber(average.launchAssetCount),
    averagePayloadBytes: asNumber(average.averageUpdatePayloadBytes),
  };
}

/** Insights of every update of a group (one per platform) over `{ start, end }` (epoch ms). `not_found` when Expo has no such group. */
export async function expoUpdateGroupInsights(
  client: ExpoGraphql,
  groupId: string,
  span: { start: number; end: number },
): Promise<ExpoUpdateInsights[]> {
  if (!EXPO_UPDATE_GROUP_ID.test(groupId)) throw new ExpoError('invalid_input');
  if (!Number.isFinite(span.start) || !Number.isFinite(span.end) || span.start >= span.end) {
    throw new ExpoError('invalid_input');
  }
  const data = await client.graphql<{ updatesByGroup?: unknown }>({
    query: UPDATE_INSIGHTS_QUERY,
    variables: {
      groupId: groupId.toLowerCase(),
      timespan: {
        start: new Date(span.start).toISOString(),
        end: new Date(span.end).toISOString(),
      },
    },
    operationName: 'KilnUpdateGroupInsights',
  });
  if (!Array.isArray(data.updatesByGroup)) throw unreadable();
  const found = data.updatesByGroup
    .map(insightsOf)
    .filter((i): i is ExpoUpdateInsights => i !== null);
  if (found.length === 0) throw new ExpoError('not_found');
  return found;
}

export const SET_UPDATE_ROLLOUT_MUTATION = `mutation KilnSetUpdateRollout($updateId: ID!, $rolloutPercentage: Int!) {
  update {
    setRolloutPercentage(updateId: $updateId, percentage: $rolloutPercentage) {
      id
      group
      rolloutPercentage
    }
  }
}`;

/**
 * Sets the rollout percentage of one update (what `eas update:edit` does for a rollout; 100 ends it). A WRITE at Expo: callers gate
 * it (docs/adr/0037-eas-update.md). Never retried. The answer is read back from the mutation's own result.
 */
export async function expoSetUpdateRolloutPercentage(
  client: ExpoGraphql,
  updateId: string,
  percentage: number,
): Promise<ExpoUpdateRolloutResult> {
  if (
    !EXPO_UPDATE_GROUP_ID.test(updateId) ||
    !Number.isInteger(percentage) ||
    percentage < 1 ||
    percentage > 100
  ) {
    throw new ExpoError('invalid_input');
  }
  const data = await client.graphql<{ update?: unknown }>({
    query: SET_UPDATE_ROLLOUT_MUTATION,
    variables: { updateId: updateId.toLowerCase(), rolloutPercentage: percentage },
    operationName: 'KilnSetUpdateRollout',
  });
  if (!isRecord(data.update) || !isRecord(data.update.setRolloutPercentage)) throw unreadable();
  const done = data.update.setRolloutPercentage;
  const id = text(done.id);
  if (!id) throw unreadable();
  return {
    updateId: id,
    group: text(done.group) ?? null,
    rolloutPercentage: asNumber(done.rolloutPercentage),
  };
}

// ---------------------------------------------------------------------------------------------
// EAS Build and Submit status (docs/adr/0036-eas-build-submit-status.md)
//
// Verified in eas-cli (packages/eas-cli/src/graphql and src/build/utils/url.ts, checked 2026-11-20):
// - queries/BuildQuery.ts `viewBuildsOnAppAsync`: `app { byId(appId: String!) { id builds(offset: Int!, limit: Int!, filter: BuildFilter) { ...BuildFragment } } }`.
// - types/Build.ts BuildFragment fields used here: id status platform error { errorCode message } artifacts { buildUrl applicationArchiveUrl }
//   updateChannel { name } distribution buildProfile appIdentifier sdkVersion appVersion appBuildVersion runtime { version } gitCommitHash
//   gitCommitMessage createdAt updatedAt completedAt expirationDate isForIosSimulator.
// - commands/build/list.ts: the keys of BuildFilter (platform, status, distribution, channel, appVersion, appBuildVersion, sdkVersion,
//   runtimeVersion, appIdentifier, buildProfile, gitCommitHash, fingerprintHash, simulator); only `platform` is used here.
// - queries/SubmissionQuery.ts `GetProjectStatusSubmissions` / `GetAllSubmissionsForApp`: `app { byId(appId) { id submissions(filter: {platform: $platform},
//   offset, limit) { id status platform createdAt completedAt submittedBuild { id } androidConfig { applicationIdentifier track releaseStatus }
//   iosConfig { ascAppIdentifier } error { errorCode message } } } }` with `$platform: AppPlatform`.
// - The enums, read from the generated client of the published eas-cli package: BuildStatus NEW IN_QUEUE IN_PROGRESS PENDING_CANCEL
//   FINISHED ERRORED CANCELED; SubmissionStatus AWAITING_BUILD IN_QUEUE IN_PROGRESS FINISHED ERRORED CANCELED; AppPlatform IOS ANDROID;
//   DistributionType STORE INTERNAL SIMULATOR.
// - src/build/utils/url.ts (web pages): builds `/accounts/{account}/projects/{slug}/builds/{id}`, submissions `/accounts/{account}/projects/
//   {slug}/submissions/{id}`; for an internal-distribution Android build the install link is `artifacts.buildUrl`, for iOS it is an
//   `itms-services://` link to the API manifest (neither is stored here).
// NOT verified, so labelled where it is used: the largest `limit` Expo accepts (30 is used, below the 50 that `eas build:list` documents as
// its own maximum); the serialisation of DateTime fields (ISO 8601 strings are assumed; anything else becomes null); whether
// `appBuildVersion` holds the Android version code as well as the iOS build number (it is read as one field and shown as is); whether Expo orders `builds` and `submissions` newest first (this reader sorts by `createdAt` itself); the exact
// wording and codes of errors (shown, never interpreted); the rate limits of the API; whether `submissions` accepts a missing filter.

export const EXPO_STATUS_PAGE_LIMIT = 30;

/** Expo's `AppPlatform` wire values (verified in the generated client of eas-cli). */
const EXPO_PLATFORM_WIRE: Record<ExpoPlatformKey, string> = { ios: 'IOS', android: 'ANDROID' };
const EXPO_PLATFORM_FROM_WIRE: Record<string, ExpoPlatformKey> = { IOS: 'ios', ANDROID: 'android' };

const EXPO_BUILD_STATUS_FROM_WIRE: Record<string, ExpoBuildStatus> = {
  NEW: 'new',
  IN_QUEUE: 'in_queue',
  IN_PROGRESS: 'in_progress',
  PENDING_CANCEL: 'pending_cancel',
  FINISHED: 'finished',
  ERRORED: 'errored',
  CANCELED: 'canceled',
};
const EXPO_SUBMISSION_STATUS_FROM_WIRE: Record<string, ExpoSubmissionStatus> = {
  AWAITING_BUILD: 'awaiting_build',
  IN_QUEUE: 'in_queue',
  IN_PROGRESS: 'in_progress',
  FINISHED: 'finished',
  ERRORED: 'errored',
  CANCELED: 'canceled',
};
const EXPO_DISTRIBUTION_FROM_WIRE: Record<string, ExpoBuildDistribution> = {
  STORE: 'store',
  INTERNAL: 'internal',
  SIMULATOR: 'simulator',
};

const easTime = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/** A string cut to `max` characters, or null when it is empty or not a string. */
const easText = (value: unknown, max: number): string | null => {
  const found = text(value);
  return found === undefined ? null : found.length > max ? `${found.slice(0, max - 1)}…` : found;
};

const easErrorOf = (value: unknown): ExpoErrorDetail | null => {
  if (!isRecord(value)) return null;
  const rawCode = text(value.errorCode);
  const code =
    rawCode !== undefined && /^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(rawCode) ? rawCode : null;
  const message = easText(value.message, 500);
  return code === null && message === null ? null : { code, message };
};

/** The key a status is kept under: Expo's own upper case wording, so a lower case or mixed case spelling still reads. */
const wire = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toUpperCase() : '';

const BUILD_FIELDS = `id status platform error { errorCode message } artifacts { buildUrl applicationArchiveUrl }
        updateChannel { name } distribution buildProfile appIdentifier sdkVersion appVersion appBuildVersion runtime { version }
        gitCommitHash gitCommitMessage createdAt updatedAt completedAt expirationDate isForIosSimulator`;

export const EAS_BUILDS_QUERY = `query KilnEasBuilds($appId: String!, $offset: Int!, $limit: Int!, $filter: BuildFilter) {
  app {
    byId(appId: $appId) {
      id
      builds(offset: $offset, limit: $limit, filter: $filter) {
        ${BUILD_FIELDS}
      }
    }
  }
}`;

function easBuildOf(value: unknown): ExpoBuildSummary | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  if (!id) return null;
  const rawStatus = text(value.status) ?? '';
  const artifacts = isRecord(value.artifacts) ? value.artifacts : {};
  const firstLine = easText(
    typeof value.gitCommitMessage === 'string'
      ? value.gitCommitMessage.split('\n')[0]?.trim()
      : null,
    200,
  );
  return {
    id,
    status: EXPO_BUILD_STATUS_FROM_WIRE[wire(value.status)] ?? 'unknown',
    rawStatus,
    platform: EXPO_PLATFORM_FROM_WIRE[wire(value.platform)] ?? null,
    buildProfile: easText(value.buildProfile, 100),
    channel: isRecord(value.updateChannel) ? easText(value.updateChannel.name, 100) : null,
    appVersion: easText(value.appVersion, 100),
    appBuildVersion: easText(value.appBuildVersion, 100),
    sdkVersion: easText(value.sdkVersion, 50),
    runtimeVersion: isRecord(value.runtime) ? easText(value.runtime.version, 100) : null,
    distribution: EXPO_DISTRIBUTION_FROM_WIRE[wire(value.distribution)] ?? 'unknown',
    simulator: typeof value.isForIosSimulator === 'boolean' ? value.isForIosSimulator : null,
    appIdentifier: easText(value.appIdentifier, 200),
    gitCommitHash: easText(value.gitCommitHash, 64),
    gitCommitMessage: firstLine,
    error: easErrorOf(value.error),
    hasArtifact:
      text(artifacts.buildUrl) !== undefined || text(artifacts.applicationArchiveUrl) !== undefined,
    createdAt: easTime(value.createdAt),
    updatedAt: easTime(value.updatedAt),
    completedAt: easTime(value.completedAt),
    expiresAt: easTime(value.expirationDate),
  };
}

const newestFirst = <T extends { createdAt: number | null; id: string }>(items: T[]): T[] =>
  items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.id.localeCompare(b.id));

/**
 * The newest builds of a project for one platform (a page of `limit`, default 30; no paging: older builds are not read). `full` says the
 * page was full, so older builds may exist. An entry Expo sent without an id is dropped. `not_found` when the token cannot see the project.
 */
export async function expoBuilds(
  client: ExpoGraphql,
  projectId: string,
  options: { platform: ExpoPlatformKey; limit?: number },
): Promise<ExpoPage<ExpoBuildSummary>> {
  if (!isExpoProjectId(projectId)) throw new ExpoError('invalid_input');
  const limit = options.limit ?? EXPO_STATUS_PAGE_LIMIT;
  const data = await client.graphql<{ app?: unknown }>({
    query: EAS_BUILDS_QUERY,
    variables: {
      appId: projectId.toLowerCase(),
      offset: 0,
      limit,
      filter: { platform: EXPO_PLATFORM_WIRE[options.platform] },
    },
    operationName: 'KilnEasBuilds',
  });
  if (!isRecord(data.app)) throw unreadable();
  if (data.app.byId === null) throw new ExpoError('not_found');
  if (!isRecord(data.app.byId) || !Array.isArray(data.app.byId.builds)) throw unreadable();
  const raw = data.app.byId.builds;
  const items = newestFirst(raw.flatMap((entry) => easBuildOf(entry) ?? []));
  return { items, full: raw.length >= limit };
}

const SUBMISSION_FIELDS = `id status platform createdAt completedAt submittedBuild { id }
        androidConfig { applicationIdentifier track releaseStatus } iosConfig { ascAppIdentifier } error { errorCode message }`;

export const EAS_SUBMISSIONS_QUERY = `query KilnEasSubmissions($appId: String!, $offset: Int!, $limit: Int!, $platform: AppPlatform) {
  app {
    byId(appId: $appId) {
      id
      submissions(filter: { platform: $platform }, offset: $offset, limit: $limit) {
        ${SUBMISSION_FIELDS}
      }
    }
  }
}`;

function easSubmissionOf(value: unknown): ExpoSubmissionSummary | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  if (!id) return null;
  const android = isRecord(value.androidConfig) ? value.androidConfig : {};
  const ios = isRecord(value.iosConfig) ? value.iosConfig : {};
  return {
    id,
    status: EXPO_SUBMISSION_STATUS_FROM_WIRE[wire(value.status)] ?? 'unknown',
    rawStatus: text(value.status) ?? '',
    platform: EXPO_PLATFORM_FROM_WIRE[wire(value.platform)] ?? null,
    buildId: isRecord(value.submittedBuild) ? (text(value.submittedBuild.id) ?? null) : null,
    targetIdentifier:
      easText(android.applicationIdentifier, 200) ?? easText(ios.ascAppIdentifier, 200),
    track: easText(android.track, 100),
    releaseStatus: easText(android.releaseStatus, 100),
    error: easErrorOf(value.error),
    createdAt: easTime(value.createdAt),
    completedAt: easTime(value.completedAt),
  };
}

/** The newest submissions of a project for one platform; same rules as `expoBuilds`. */
export async function expoSubmissions(
  client: ExpoGraphql,
  projectId: string,
  options: { platform: ExpoPlatformKey; limit?: number },
): Promise<ExpoPage<ExpoSubmissionSummary>> {
  if (!isExpoProjectId(projectId)) throw new ExpoError('invalid_input');
  const limit = options.limit ?? EXPO_STATUS_PAGE_LIMIT;
  const data = await client.graphql<{ app?: unknown }>({
    query: EAS_SUBMISSIONS_QUERY,
    variables: {
      appId: projectId.toLowerCase(),
      offset: 0,
      limit,
      platform: EXPO_PLATFORM_WIRE[options.platform],
    },
    operationName: 'KilnEasSubmissions',
  });
  if (!isRecord(data.app)) throw unreadable();
  if (data.app.byId === null) throw new ExpoError('not_found');
  if (!isRecord(data.app.byId) || !Array.isArray(data.app.byId.submissions)) throw unreadable();
  const raw = data.app.byId.submissions;
  const items = newestFirst(raw.flatMap((entry) => easSubmissionOf(entry) ?? []));
  return { items, full: raw.length >= limit };
}
