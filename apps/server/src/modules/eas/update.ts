import { createHash } from 'node:crypto';
import {
  checkRuntimeVersions,
  EXPO_UPDATE_GROUP_ID,
  type ExpoClient,
  ExpoError,
  type ExpoStoreBuild,
  type ExpoUpdate,
  type ExpoUpdateChannel,
  type ExpoUpdateInsights,
  expoSetUpdateRolloutPercentage,
  expoStoreBuilds,
  expoUpdateChannels,
  expoUpdateGroupInsights,
  type RuntimeCheck,
} from '@kiln/connectors';
import type { ActorType, Platform } from '@kiln/core';
import { coded } from '../../i18n/problem.ts';
import type { ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { type Failure, failure, type Outcome } from '../../services/repositories.ts';
import { expoClientFor, expoFailure } from './client.ts';
import { type ExpoLinkView, getExpoLink, type LinkContext } from './link.ts';

/**
 * EAS Update of the Expo project an app is linked to (docs/adr/0037-eas-update.md, docs/api/eas-update.md): channels, the branch each
 * channel points to, the newest updates of every branch, per-update rollouts, insights of an update group, and a check that the newest
 * update of a channel has the runtime version of a binary that was shipped. Reads are live (no table). The ONE write is raising the
 * rollout percentage of an update that is mid-rollout: gated by KILN_EAS_UPDATE_ROLLOUT_ENABLED, a preview with a confirmHash, step-up
 * and an audit row. Publishing an update, rolling back and changing the branch of a channel are not implemented (the ADR says why).
 */

type Actor = { type: ActorType; id: string };

export const EXPO_UPDATE_PURPOSE = 'eas.update';
export const EXPO_UPDATE_INSIGHTS_PURPOSE = 'eas.update_insights';
export const EXPO_UPDATE_ROLLOUT_PURPOSE = 'eas.update_rollout';
export const EXPO_UPDATE_ROLLOUT_ENV = 'KILN_EAS_UPDATE_ROLLOUT_ENABLED';

/** The key Expo uses for the platform of an app record; null when EAS does not build or update it. A table, not a check on a name. */
const EXPO_PLATFORM: Record<Platform, 'ios' | 'android' | null> = {
  ios: 'ios',
  macos: null,
  android: 'android',
};
export type ExpoPlatformKey = 'ios' | 'android';

/** The most store builds shown, newest first. */
const SHOWN_BUILDS = 10;
export const INSIGHTS_MAX_DAYS = 30;
export const INSIGHTS_DEFAULT_DAYS = 7;

export type UpdateContext = LinkContext & {
  /** KILN_EAS_UPDATE_ROLLOUT_ENABLED (default false). */
  rolloutEnabled: boolean;
};

export type UpdateView = {
  id: string;
  group: string;
  message: string | null;
  createdAt: number | null;
  platform: string;
  runtimeVersion: string | null;
  gitCommitHash: string | null;
  isRollBackToEmbedded: boolean;
  rolloutPercentage: number | null;
  rolloutControlGroup: string | null;
};

export type BranchView = {
  id: string;
  name: string;
  /** The channel's mapping names this branch. */
  mapped: boolean;
  /** The newest update groups of the branch that hold an update for this platform, newest first. */
  groups: { group: string; updates: UpdateView[] }[];
};

export type ChannelView = {
  id: string;
  name: string;
  isPaused: boolean | null;
  isProtected: boolean | null;
  updatedAt: number | null;
  mapping: {
    kind: 'none' | 'branch' | 'rollout' | 'unreadable';
    entries: {
      branchId: string;
      branchName: string | null;
      logic: 'always' | 'conditional';
      condition: string | null;
    }[];
  };
  branches: BranchView[];
  /** Updates of this channel that are mid-rollout (a share of clients, not all). */
  rollouts: {
    branch: string;
    group: string;
    updateId: string;
    runtimeVersion: string | null;
    percentage: number;
    controlGroup: string | null;
  }[];
  runtimeCheck: RuntimeCheck;
};

export type UpdateStateView = {
  project: { id: string; fullName: string };
  /** Expo's key of the platform of this app record. */
  platform: ExpoPlatformKey;
  channels: ChannelView[];
  /** More channels exist than were read. */
  channelsTruncated: boolean;
  /** The store builds the runtime check compared with: finished, store distribution, this platform, newest first. */
  builds: {
    id: string;
    runtimeVersion: string | null;
    appVersion: string | null;
    appBuildVersion: string | null;
    channel: string | null;
    createdAt: number | null;
  }[];
  /** Raising a rollout is switched on (KILN_EAS_UPDATE_ROLLOUT_ENABLED). */
  rolloutWriteEnabled: boolean;
  readAt: number;
};

const toUpdateView = (u: ExpoUpdate): UpdateView => ({ ...u });

/** Keeps only the updates of one platform, and drops the groups left empty. */
function forPlatform(
  channels: readonly ExpoUpdateChannel[],
  platform: ExpoPlatformKey,
): ExpoUpdateChannel[] {
  return channels.map((channel) => ({
    ...channel,
    branches: channel.branches.map((branch) => ({
      ...branch,
      groups: branch.groups
        .map((g) => ({ group: g.group, updates: g.updates.filter((u) => u.platform === platform) }))
        .filter((g) => g.updates.length > 0),
    })),
  }));
}

function channelView(channel: ExpoUpdateChannel, check: RuntimeCheck): ChannelView {
  const mappedIds = new Set(channel.mapping.entries.map((e) => e.branchId));
  const nameOf = new Map(channel.branches.map((b) => [b.id, b.name]));
  const rollouts: ChannelView['rollouts'] = [];
  for (const branch of channel.branches) {
    for (const g of branch.groups) {
      for (const u of g.updates) {
        if (u.rolloutPercentage !== null) {
          rollouts.push({
            branch: branch.name,
            group: g.group,
            updateId: u.id,
            runtimeVersion: u.runtimeVersion,
            percentage: u.rolloutPercentage,
            controlGroup: u.rolloutControlGroup,
          });
        }
      }
    }
  }
  return {
    id: channel.id,
    name: channel.name,
    isPaused: channel.isPaused,
    isProtected: channel.isProtected,
    updatedAt: channel.updatedAt,
    mapping: {
      kind: channel.mapping.kind,
      entries: channel.mapping.entries.map((e) => ({
        branchId: e.branchId,
        branchName: nameOf.get(e.branchId) ?? null,
        logic: e.logic,
        condition: e.condition,
      })),
    },
    branches: channel.branches.map((b) => ({
      id: b.id,
      name: b.name,
      mapped: mappedIds.has(b.id),
      groups: b.groups.map((g) => ({ group: g.group, updates: g.updates.map(toUpdateView) })),
    })),
    rollouts,
    runtimeCheck: check,
  };
}

type Opened = {
  ok: true;
  link: ExpoLinkView;
  platform: ExpoPlatformKey;
  client: ExpoClient;
};

/** The link of the app, its platform's key and a client for Expo; or the response that says why not. */
async function open(
  ctx: LinkContext,
  input: { workspaceId: string; app: ManagedApp },
  actor: Actor,
  purpose: string,
): Promise<Opened | Failure> {
  const link = await getExpoLink(ctx.db, input.workspaceId, input.app.id);
  if (!link) {
    return failure(
      409,
      'expo_not_linked',
      'This app is not linked to an Expo project. Link it in the app Settings first.',
      coded('eas.notLinked'),
    );
  }
  if (!link.credentialAvailable) {
    return failure(
      422,
      'credential_not_found',
      'The Expo credential of this link was deleted. Choose another in the app Settings.',
      coded('eas.credentialDeleted'),
    );
  }
  const platform = EXPO_PLATFORM[input.app.platform];
  if (platform === null) {
    return failure(
      422,
      'platform_unsupported',
      'EAS Update has no updates for this platform.',
      coded('eas.noUpdates'),
    );
  }
  const opened = await expoClientFor(
    ctx.db,
    ctx.masterKey,
    input.workspaceId,
    link.credentialId,
    ctx.deps,
    {
      actor,
      purpose,
      now: ctx.now(),
    },
  );
  if (!opened.ok) return opened;
  return { ok: true, link, platform, client: opened.client };
}

async function readAll(
  client: ExpoClient,
  projectId: string,
  platform: ExpoPlatformKey,
): Promise<
  { channels: ExpoUpdateChannel[]; truncated: boolean; builds: ExpoStoreBuild[] } | Failure
> {
  try {
    const [read, builds] = await Promise.all([
      expoUpdateChannels(client, projectId),
      expoStoreBuilds(client, projectId, { platform }),
    ]);
    return { channels: forPlatform(read.channels, platform), truncated: read.truncated, builds };
  } catch (error) {
    return expoFailure(error);
  }
}

/** `GET .../apps/{appId}/expo/updates`: live from Expo (two requests), nothing stored. */
export async function readUpdateState(
  ctx: UpdateContext,
  input: { workspaceId: string; app: ManagedApp },
  actor: Actor,
): Promise<Outcome<{ state: UpdateStateView }>> {
  const opened = await open(ctx, input, actor, EXPO_UPDATE_PURPOSE);
  if (!opened.ok) return opened;
  const read = await readAll(opened.client, opened.link.projectId, opened.platform);
  if ('ok' in read) return read;
  const checks = checkRuntimeVersions({ channels: read.channels, builds: read.builds });
  const builds = [...read.builds]
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, SHOWN_BUILDS);
  return {
    ok: true,
    state: {
      project: { id: opened.link.projectId, fullName: opened.link.fullName },
      platform: opened.platform,
      channels: read.channels.map((channel, i) => channelView(channel, checks[i] as RuntimeCheck)),
      channelsTruncated: read.truncated,
      builds: builds.map((b) => ({
        id: b.id,
        runtimeVersion: b.runtimeVersion,
        appVersion: b.appVersion,
        appBuildVersion: b.appBuildVersion,
        channel: b.channel,
        createdAt: b.createdAt,
      })),
      rolloutWriteEnabled: ctx.rolloutEnabled,
      readAt: ctx.now(),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Insights

export type UpdateInsightsView = {
  group: string;
  platform: ExpoPlatformKey;
  days: number;
  /** The span asked for, epoch ms. */
  start: number;
  end: number;
  insights: ExpoUpdateInsights;
};

/** `GET .../apps/{appId}/expo/updates/{group}/insights?days=`: the insights of the update of this platform in a group. */
export async function readUpdateInsights(
  ctx: UpdateContext,
  input: { workspaceId: string; app: ManagedApp; group: string; days: number },
  actor: Actor,
): Promise<Outcome<{ insights: UpdateInsightsView }>> {
  if (!EXPO_UPDATE_GROUP_ID.test(input.group)) {
    return failure(422, 'invalid_group', 'An update group id looks like a UUID.');
  }
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > INSIGHTS_MAX_DAYS) {
    return failure(
      422,
      'invalid_days',
      `Days must be a whole number from 1 to ${INSIGHTS_MAX_DAYS}.`,
    );
  }
  const opened = await open(ctx, input, actor, EXPO_UPDATE_INSIGHTS_PURPOSE);
  if (!opened.ok) return opened;
  const end = ctx.now();
  const start = end - input.days * 24 * 3600_000;
  try {
    const all = await expoUpdateGroupInsights(opened.client, input.group, { start, end });
    const mine = all.find((i) => i.platform === opened.platform);
    if (!mine)
      return failure(
        422,
        'expo_not_found',
        'That update group has no update for this platform.',
        coded('eas.groupNoUpdate'),
      );
    return {
      ok: true,
      insights: {
        group: input.group.toLowerCase(),
        platform: opened.platform,
        days: input.days,
        start,
        end,
        insights: mine,
      },
    };
  } catch (error) {
    return expoFailure(error);
  }
}

// ---------------------------------------------------------------------------------------------
// Raising a rollout (the one write)

export type RolloutRequest = {
  /** The update group (a UUID) whose update of this app's platform is mid-rollout. */
  group: string;
  /** The new share, whole percent, above the current one, at most 100 (100 ends the rollout). */
  percentage: number;
};

export type RolloutPreview = {
  app: { id: string; name: string; platform: Platform };
  project: { id: string; fullName: string };
  channel: string;
  branch: string;
  group: string;
  updateId: string;
  runtimeVersion: string | null;
  from: number;
  to: number;
  summary: string;
  /** True for 100: the rollout ends, and nothing here lowers it again. */
  irreversible: boolean;
  /** Send it back to apply. Valid only while Expo still shows `from`. */
  confirmHash: string;
  warnings: string[];
  readAt: number;
};

export type RolloutResult = {
  app: { id: string; name: string; platform: Platform };
  group: string;
  updateId: string;
  from: number;
  to: number;
  /** True when the write's answer was lost and a read afterwards showed the new share. */
  confirmedByReread: boolean;
};

export function rolloutDisabledFailure(): Failure {
  return failure(
    409,
    'eas_update_write_disabled',
    `Changing an EAS Update rollout is switched off on this server (${EXPO_UPDATE_ROLLOUT_ENV}).`,
    { env: EXPO_UPDATE_ROLLOUT_ENV },
  );
}

export const rolloutConfirmHash = (input: {
  appId: string;
  projectId: string;
  updateId: string;
  group: string;
  from: number;
  to: number;
}): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        'eas.update_rollout.v1',
        input.appId,
        input.projectId,
        input.updateId,
        input.group,
        input.from,
        input.to,
      ]),
    )
    .digest('hex');

type Found = {
  channel: ExpoUpdateChannel;
  branch: string;
  update: ExpoUpdate;
  check: RuntimeCheck;
};

function findRollout(
  channels: readonly ExpoUpdateChannel[],
  checks: readonly RuntimeCheck[],
  group: string,
): Found | undefined {
  const wanted = group.toLowerCase();
  for (const [i, channel] of channels.entries()) {
    for (const branch of channel.branches) {
      for (const g of branch.groups) {
        if (g.group.toLowerCase() !== wanted) continue;
        const update = g.updates.find((u) => u.rolloutPercentage !== null);
        if (update)
          return { channel, branch: branch.name, update, check: checks[i] as RuntimeCheck };
      }
    }
  }
  return undefined;
}

function checkRequest(request: RolloutRequest): Failure | undefined {
  if (!EXPO_UPDATE_GROUP_ID.test(request.group)) {
    return failure(422, 'invalid_group', 'An update group id looks like a UUID.');
  }
  if (!Number.isInteger(request.percentage) || request.percentage < 1 || request.percentage > 100) {
    return failure(422, 'invalid_rollout', 'The share is a whole percent from 1 to 100.');
  }
  return undefined;
}

type Located = { found: Found; opened: Opened; from: number; hash: string; readAt: number };

async function locate(
  ctx: UpdateContext,
  input: { workspaceId: string; app: ManagedApp; request: RolloutRequest },
  actor: Actor,
): Promise<Located | Failure> {
  const bad = checkRequest(input.request);
  if (bad) return bad;
  const opened = await open(ctx, input, actor, EXPO_UPDATE_ROLLOUT_PURPOSE);
  if (!opened.ok) return opened;
  const read = await readAll(opened.client, opened.link.projectId, opened.platform);
  if ('ok' in read) return read;
  const checks = checkRuntimeVersions({ channels: read.channels, builds: read.builds });
  const found = findRollout(read.channels, checks, input.request.group);
  if (!found) {
    return failure(
      409,
      'rollout_not_found',
      'No update of this platform in that group is mid-rollout (it may have finished, been replaced, or be older than the updates read).',
      coded('eas.notMidRollout'),
    );
  }
  const from = found.update.rolloutPercentage as number;
  if (input.request.percentage <= from) {
    return failure(
      422,
      'rollout_not_raised',
      `The rollout is at ${from}%. It can only be raised here; lowering or reverting it needs the Expo CLI.`,
      { current: from, ...coded('eas.rolloutOnlyRaise', { from }) },
    );
  }
  const hash = rolloutConfirmHash({
    appId: input.app.id,
    projectId: opened.link.projectId,
    updateId: found.update.id,
    group: found.update.group,
    from,
    to: input.request.percentage,
  });
  return { found, opened, from, hash, readAt: ctx.now() };
}

const appRef = (app: ManagedApp) => ({ id: app.id, name: app.name, platform: app.platform });

/** `POST .../expo/updates/rollout/preview`: reads Expo, changes nothing, and returns the `confirmHash` apply needs. */
export async function previewUpdateRollout(
  ctx: UpdateContext,
  input: { workspaceId: string; app: ManagedApp; request: RolloutRequest },
  actor: Actor,
): Promise<Outcome<{ preview: RolloutPreview }>> {
  const located = await locate(ctx, input, actor);
  if ('ok' in located) return located;
  const { found, opened, from, hash, readAt } = located;
  const to = input.request.percentage;
  const warnings: string[] = [];
  if (found.check.status === 'mismatch') warnings.push(found.check.message);
  if (to === 100)
    warnings.push(
      'At 100% the rollout ends and every matching client gets the update. This server cannot lower it again.',
    );
  return {
    ok: true,
    preview: {
      app: appRef(input.app),
      project: { id: opened.link.projectId, fullName: opened.link.fullName },
      channel: found.channel.name,
      branch: found.branch,
      group: found.update.group,
      updateId: found.update.id,
      runtimeVersion: found.update.runtimeVersion,
      from,
      to,
      summary: `Raise the rollout of update group ${found.update.group} on branch ${found.branch} (channel ${found.channel.name}) from ${from}% to ${to}%.`,
      irreversible: to === 100,
      confirmHash: hash,
      warnings,
      readAt,
    },
  };
}

/** One write per update at a time in this process; two identical writes are harmless at Expo, so no table is needed. */
const writing = new Set<string>();

/**
 * `POST .../expo/updates/rollout/apply`. Expo is READ AGAIN right before the write: if the rollout is not what `confirmHash` was made
 * from, nothing is written (409 `state_changed`). The write is never retried: after a timeout or a 5xx the update is read back.
 */
export async function applyUpdateRollout(
  ctx: UpdateContext,
  input: { workspaceId: string; app: ManagedApp; request: RolloutRequest; confirmHash: string },
  actor: Actor,
): Promise<Outcome<{ result: RolloutResult }>> {
  const located = await locate(ctx, input, actor);
  if ('ok' in located) {
    // The rollout is gone or already at or above the request: say it is not what was previewed.
    if (located.status === 409 && located.body.error === 'rollout_not_found') {
      return failure(409, 'state_changed', located.body.message as string, { preview: 'again' });
    }
    return located;
  }
  const { found, opened, from, hash } = located;
  if (hash !== input.confirmHash) {
    return failure(
      409,
      'state_changed',
      `Expo shows this rollout at ${from}%, which is not what was previewed. Nothing was changed. Preview again.`,
      {
        current: { from, to: input.request.percentage },
        confirmHash: hash,
        ...coded('eas.rolloutChanged', { from }),
      },
    );
  }
  const key = `${input.app.id}:${found.update.id}`;
  if (writing.has(key)) {
    return failure(
      409,
      'write_in_progress',
      'A change of this rollout is already in progress. Wait for it to finish.',
      coded('eas.rolloutBusy'),
    );
  }
  writing.add(key);
  try {
    const detail = {
      appId: input.app.id,
      projectId: opened.link.projectId,
      channel: found.channel.name,
      branch: found.branch,
      group: found.update.group,
      updateId: found.update.id,
      runtimeVersion: found.update.runtimeVersion,
      from,
      to: input.request.percentage,
      irreversible: input.request.percentage === 100,
      hash,
    };
    const done = (confirmedByReread: boolean): { ok: true; result: RolloutResult } => ({
      ok: true,
      result: {
        app: appRef(input.app),
        group: found.update.group,
        updateId: found.update.id,
        from,
        to: input.request.percentage,
        confirmedByReread,
      },
    });
    const record = (
      action: 'eas.update_rollout_changed' | 'eas.update_rollout_failed',
      extra: Record<string, unknown>,
    ) =>
      recordAudit(ctx.db, {
        workspaceId: input.workspaceId,
        actor,
        action,
        target: { type: 'app', id: input.app.id },
        // Ids and values: never a token or an answer of Expo.
        detail: { ...detail, ...extra },
        at: ctx.now(),
      });
    try {
      const wrote = await expoSetUpdateRolloutPercentage(
        opened.client,
        found.update.id,
        input.request.percentage,
      );
      await record('eas.update_rollout_changed', {
        via: 'expo',
        answered: wrote.rolloutPercentage,
      });
      return done(false);
    } catch (error) {
      const unknown =
        error instanceof ExpoError &&
        (error.kind === 'network' || error.kind === 'server' || error.kind === 'unexpected');
      if (!unknown) {
        await record('eas.update_rollout_failed', {
          outcome: 'not_applied',
          kind: error instanceof ExpoError ? error.kind : 'other',
        });
        return expoFailure(error);
      }
      // The answer was lost: read the update back instead of trying again.
      const after = await readAll(opened.client, opened.link.projectId, opened.platform);
      if ('ok' in after) {
        await record('eas.update_rollout_failed', { outcome: 'unknown' });
        return failure(
          409,
          'outcome_unknown',
          'Expo did not answer and the state could not be read back. Check the rollout in Expo, then preview again.',
          coded('eas.rolloutUnknown'),
        );
      }
      const now = findRollout(
        after.channels,
        checkRuntimeVersions({ channels: after.channels, builds: after.builds }),
        found.update.group,
      );
      const share = now?.update.rolloutPercentage ?? null;
      // A rollout that reached 100 is no longer listed as mid-rollout: it is then not found, and not found after a request for 100 is done.
      if (
        share === input.request.percentage ||
        (now === undefined && input.request.percentage === 100)
      ) {
        await record('eas.update_rollout_changed', { via: 'reread' });
        return done(true);
      }
      await record('eas.update_rollout_failed', { outcome: 'not_applied' });
      return failure(
        502,
        'write_failed',
        'Expo did not apply the change. The rollout is as before. Nothing was changed.',
        {
          outcome: 'not_applied',
          ...coded('eas.rolloutNotApplied'),
        },
      );
    }
  } finally {
    writing.delete(key);
  }
}
