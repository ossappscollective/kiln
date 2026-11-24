import type {
  ExpoBranchMapping,
  ExpoBranchMappingEntry,
  ExpoStoreBuild,
  ExpoUpdateChannel,
} from './types.ts';

/**
 * The pure parts of EAS Update (docs/adr/0037-eas-update.md): reading a channel's `branchMapping` and telling whether the updates of
 * a channel would reach the binaries that were shipped. No network here; queries.ts feeds it.
 *
 * Verified in eas-cli (packages/eas-cli/src/channel/branch-mapping.ts, checked 2026-11-20): `branchMapping` is a JSON string
 * `{ "version": number, "data": [{ "branchId", "branchMappingLogic" }] }`; the logic is the literal `"true"`, an object
 * `{ clientKey, branchMappingOperator, operand }` or a statement `["and" | "or" | "not", ...nodes]`.
 * UNVERIFIED: the scale of `operand` for `hash_lt` (a fraction or a percentage), so a rollout between branches is reported as
 * "a condition" and never as a percentage.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const MAX_CONDITION = 200;

/** A condition node as short text. Unknown shapes become `?`; the text is capped. */
export function describeCondition(node: unknown, depth = 0): string {
  if (node === 'true') return 'always';
  if (depth > 4) return '...';
  if (Array.isArray(node)) {
    const [head, ...rest] = node;
    const word = typeof head === 'string' ? head : '?';
    return `${word}(${rest.map((n) => describeCondition(n, depth + 1)).join(', ')})`;
  }
  if (isRecord(node)) {
    const key = typeof node.clientKey === 'string' ? node.clientKey : '?';
    const op = typeof node.branchMappingOperator === 'string' ? node.branchMappingOperator : '?';
    const operand = node.operand;
    const shown =
      typeof operand === 'number' || typeof operand === 'string'
        ? String(operand)
        : Array.isArray(operand)
          ? `[${operand.length}]`
          : '?';
    return `${key} ${op} ${shown}`;
  }
  return '?';
}

const unreadable = (): ExpoBranchMapping => ({ kind: 'unreadable', version: null, entries: [] });

/** The branch mapping of a channel, from the JSON string Expo sends. Never throws. */
export function parseBranchMapping(raw: unknown): ExpoBranchMapping {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return unreadable();
    }
  }
  if (!isRecord(value) || !Array.isArray(value.data)) return unreadable();
  const entries: ExpoBranchMappingEntry[] = [];
  for (const item of value.data) {
    if (!isRecord(item) || typeof item.branchId !== 'string' || item.branchId === '') {
      return unreadable();
    }
    const always = item.branchMappingLogic === 'true';
    entries.push({
      branchId: item.branchId,
      logic: always ? 'always' : 'conditional',
      condition: always ? null : describeCondition(item.branchMappingLogic).slice(0, MAX_CONDITION),
    });
  }
  const version =
    typeof value.version === 'number' && Number.isFinite(value.version) ? value.version : null;
  return {
    kind: entries.length === 0 ? 'none' : entries.length === 1 ? 'branch' : 'rollout',
    version,
    entries,
  };
}

// ---------------------------------------------------------------------------------------------
// Runtime version mismatch

export type RuntimeCheckStatus =
  /** The newest update has the runtime version of the newest store build on the channel. */
  | 'ok'
  /** The newest update matches no store build of this channel: it would reach no shipped binary. */
  | 'mismatch'
  /** The newest update matches an older store build, not the newest one: the newest binary gets no updates. */
  | 'newest_build_unreached'
  /** The channel has no update for the platform. Nothing to compare. */
  | 'no_updates'
  /** No finished store build names this channel (for the platform). Nothing to compare. */
  | 'no_builds'
  /** Builds or updates exist but none says its runtime version. */
  | 'unknown';

export type RuntimeCheck = {
  channel: string;
  status: RuntimeCheckStatus;
  /** `error` for a mismatch, `warning` for the newest build not reached, `info` for what cannot be compared, `none` when fine. */
  severity: 'error' | 'warning' | 'info' | 'none';
  latestUpdate: {
    runtimeVersion: string | null;
    group: string;
    branch: string;
    createdAt: number | null;
  } | null;
  latestBuild: {
    id: string;
    runtimeVersion: string | null;
    appVersion: string | null;
    appBuildVersion: string | null;
    createdAt: number | null;
  } | null;
  /** Runtime versions of the store builds on this channel, newest first, without repeats. */
  shippedRuntimeVersions: string[];
  /** One sentence for a screen. */
  message: string;
};

const byNewest = <T extends { createdAt: number | null }>(a: T, b: T) =>
  (b.createdAt ?? 0) - (a.createdAt ?? 0);

/**
 * For each channel: do its newest updates (of one platform) have the runtime version of a binary that was shipped? Builds are the
 * finished store builds of the same platform (the caller filters); a build counts for a channel when the channel baked into it has
 * that name. A binary only receives an update whose runtime version equals its own (docs.expo.dev/eas-update/runtime-versions).
 * "Shipped" is approximated by "finished with store distribution": whether a build was submitted is not read here.
 */
export function checkRuntimeVersions(input: {
  /** Channels whose branches hold only the updates of the platform being checked. */
  channels: readonly ExpoUpdateChannel[];
  builds: readonly ExpoStoreBuild[];
}): RuntimeCheck[] {
  return input.channels.map((channel) => {
    const updates = channel.branches.flatMap((branch) =>
      branch.groups.flatMap((g) => g.updates.map((u) => ({ update: u, branch: branch.name }))),
    );
    updates.sort((a, b) => byNewest(a.update, b.update));
    const newest = updates[0];
    const builds = input.builds.filter((b) => b.channel === channel.name).sort(byNewest);
    const newestBuild = builds[0];
    const shipped: string[] = [];
    for (const b of builds) {
      if (b.runtimeVersion !== null && !shipped.includes(b.runtimeVersion))
        shipped.push(b.runtimeVersion);
    }
    const latestUpdate = newest
      ? {
          runtimeVersion: newest.update.runtimeVersion,
          group: newest.update.group,
          branch: newest.branch,
          createdAt: newest.update.createdAt,
        }
      : null;
    const latestBuild = newestBuild
      ? {
          id: newestBuild.id,
          runtimeVersion: newestBuild.runtimeVersion,
          appVersion: newestBuild.appVersion,
          appBuildVersion: newestBuild.appBuildVersion,
          createdAt: newestBuild.createdAt,
        }
      : null;
    const base = {
      channel: channel.name,
      latestUpdate,
      latestBuild,
      shippedRuntimeVersions: shipped,
    };
    if (!newest) {
      return {
        ...base,
        status: 'no_updates',
        severity: 'info',
        message: 'No update is published on this channel for this platform.',
      };
    }
    if (builds.length === 0) {
      return {
        ...base,
        status: 'no_builds',
        severity: 'info',
        message:
          'No finished store build uses this channel, so the updates cannot be compared with a shipped binary.',
      };
    }
    const updateRuntime = newest.update.runtimeVersion;
    if (updateRuntime === null || shipped.length === 0) {
      return {
        ...base,
        status: 'unknown',
        severity: 'info',
        message:
          'The runtime version of the newest update or of the builds is not known, so they cannot be compared.',
      };
    }
    if (!shipped.includes(updateRuntime)) {
      return {
        ...base,
        status: 'mismatch',
        severity: 'error',
        message: `The newest update has runtime version ${updateRuntime}, but the store builds on this channel have ${shipped.join(', ')}. It would reach no shipped binary.`,
      };
    }
    if (newestBuild && newestBuild.runtimeVersion !== updateRuntime) {
      return {
        ...base,
        status: 'newest_build_unreached',
        severity: 'warning',
        message: `The newest update (runtime version ${updateRuntime}) reaches an older store build only. The newest build has ${newestBuild.runtimeVersion ?? 'no runtime version'} and gets no update yet.`,
      };
    }
    return {
      ...base,
      status: 'ok',
      severity: 'none',
      message: `The newest update (runtime version ${updateRuntime}) matches the newest store build.`,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// What the status sync stores (docs/adr/0060-eas-update-state.md)

export type StoredUpdate = {
  channel: string;
  branch: string;
  group: string;
  updateId: string;
  platform: string;
  runtimeVersion: string | null;
  /** The publisher's text, first line, 200 characters. Shown to people; never put in an alert or an event. */
  message: string | null;
  createdAt: number | null;
  /** Per-update rollout, 1 to 99; null when the update is not mid-rollout (Expo sends null, or 100 once it ended). */
  rolloutPercentage: number | null;
  /** The newest update of the branches the channel serves. */
  isCurrent: boolean;
};

/** A rollout that is still going: 1 to 99. 0 and 100 are never "mid-rollout" (see the ADR: what Expo sends at 100 is unverified). */
export const isMidRollout = (percentage: number | null): percentage is number =>
  percentage !== null && Number.isInteger(percentage) && percentage >= 1 && percentage <= 99;

const MAX_MESSAGE = 200;
const firstLine = (value: string | null): string | null => {
  if (value === null) return null;
  const line = (value.split('\n')[0] ?? '').trim();
  return line === '' ? null : line.slice(0, MAX_MESSAGE);
};

/**
 * The updates worth keeping for one platform: for each channel its CURRENT update (the newest update of the branches the channel serves,
 * by its branch mapping; every branch when the mapping lists none of them or could not be read) and any update that is mid-rollout, wherever
 * it is. Each update once per channel. Pure; `channels` come from `expoUpdateChannels`.
 */
export function storedUpdatesOf(
  channels: readonly ExpoUpdateChannel[],
  platform: string,
): StoredUpdate[] {
  const out = new Map<string, StoredUpdate>();
  for (const channel of channels) {
    const served = new Set(channel.mapping.entries.map((e) => e.branchId));
    const useServed = channel.branches.some((b) => served.has(b.id));
    let current: StoredUpdate | null = null;
    for (const branch of channel.branches) {
      for (const g of branch.groups) {
        for (const u of g.updates) {
          if (u.platform !== platform) continue;
          const row: StoredUpdate = {
            channel: channel.name,
            branch: branch.name,
            group: u.group,
            updateId: u.id,
            platform,
            runtimeVersion: u.runtimeVersion,
            message: firstLine(u.message),
            createdAt: u.createdAt,
            rolloutPercentage: isMidRollout(u.rolloutPercentage) ? u.rolloutPercentage : null,
            isCurrent: false,
          };
          if (row.rolloutPercentage !== null) out.set(`${channel.name}\u0000${u.id}`, row);
          if (
            (!useServed || served.has(branch.id)) &&
            (current === null || (row.createdAt ?? 0) > (current.createdAt ?? 0))
          ) {
            current = row;
          }
        }
      }
    }
    if (current !== null)
      out.set(`${channel.name}\u0000${current.updateId}`, { ...current, isCurrent: true });
  }
  return [...out.values()];
}
