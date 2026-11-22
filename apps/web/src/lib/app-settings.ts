import { type CredentialKind, credentialKindInfo, isCredentialKind } from '@kiln/core';
import { appAddress } from './app-scope.ts';
import { testStatus } from './credentials.ts';
import { t } from './i18n/t.ts';
import type { SettingsSection } from './settings-views.ts';
import type {
  BuildConventionsView,
  ChecklistTemplate,
  CredentialSummary,
  WebhookEndpoint,
} from './types.ts';

/**
 * Pure helpers of the per-app Settings tab (docs/ux-ia.md, design R7): what each section shows, built only
 * from APIs that exist. Where no API exists the section says "not available yet" with the text below.
 * Written for the ES2017 web build.
 */

// ---------------------------------------------------------------------------------------------
// Where things are managed (the workspace pages and the app's own tabs)

export const links = {
  credentials: '#/credentials',
  repositories: '#/repositories',
  webhooks: '#/webhooks',
  workspaceSettings: '#/settings',
  builds: (appId: string): string => appAddress(appId, 'builds'),
};

/** What has no API today, said in one place so the sections agree. */
export const notAvailable = {
  get changeCredential(): string {
    return t('app:settings.na.changeCredential');
  },
  get changeRepository(): string {
    return t('app:settings.na.changeRepository');
  },
  get releaseDefaults(): string {
    return t('app:settings.na.releaseDefaults');
  },
  get appNotifications(): string {
    return t('app:settings.na.appNotifications');
  },
};

// ---------------------------------------------------------------------------------------------
// Stores and credentials

export type CredentialFacts = {
  /** The credential's label, or a sentence when it cannot be found or read. */
  label: string;
  kind: string;
  found: boolean;
  tone: 'ok' | 'bad' | 'none';
  status: string;
  detail: string;
};

/** The credential an app record is linked to, as the Stores section shows it. `list` is null when the person may not read credentials. */
export function credentialFacts(
  credentialId: string,
  list: readonly CredentialSummary[] | null,
  now: number = Date.now(),
): CredentialFacts {
  if (list === null) {
    return {
      label: t('app:settings.cred.notShown'),
      kind: '',
      found: false,
      tone: 'none',
      status: t('app:settings.cred.notShown'),
      detail: t('app:settings.cred.needsMember'),
    };
  }
  const cred = list.filter((c) => c.id === credentialId)[0];
  if (!cred) {
    return {
      label: t('app:settings.cred.notFound'),
      kind: '',
      found: false,
      tone: 'bad',
      status: t('app:settings.cred.missing'),
      detail: t('app:settings.cred.gone'),
    };
  }
  const status = testStatus(cred.lastTest, now);
  const kind: string = isCredentialKind(cred.kind)
    ? credentialKindInfo[cred.kind as CredentialKind].label
    : cred.kind;
  return {
    label: cred.label,
    kind,
    found: true,
    tone: status.tone,
    status: status.label,
    detail: status.title,
  };
}

// ---------------------------------------------------------------------------------------------
// Repository and release defaults

/** The effective build matching of an app as short lines: where it comes from and what it uses. */
export function conventionLines(view: BuildConventionsView): string[] {
  const e = view.effective;
  const source =
    e.source === 'app'
      ? t('app:settings.conv.app')
      : e.source === 'repository'
        ? t('app:settings.conv.repository')
        : t('app:settings.conv.defaults');
  const lines = [source];
  const none = t('app:settings.conv.none');
  lines.push(
    t('app:settings.conv.tagPatterns', {
      list: e.tagPatterns.length > 0 ? e.tagPatterns.join(', ') : none,
    }),
  );
  lines.push(
    t('app:settings.conv.releasePatterns', {
      list: e.releasePatterns.length > 0 ? e.releasePatterns.join(', ') : none,
    }),
  );
  if (e.prefix !== '') lines.push(t('app:settings.conv.prefix', { prefix: e.prefix }));
  lines.push(
    t('app:settings.conv.workflow', { workflow: e.workflow ?? t('app:settings.conv.notChosen') }),
  );
  return lines;
}

/** "3 templates (2 built in, 1 yours)". */
export function templatesSummary(list: readonly ChecklistTemplate[]): string {
  const builtin = list.filter((t) => t.builtin).length;
  const custom = list.length - builtin;
  if (list.length === 0) return t('app:settings.templates.none');
  return t('app:settings.templates.summary', { count: list.length, builtin, custom });
}

// ---------------------------------------------------------------------------------------------
// Notifications

/** The event types that are about one app (a webhook that asks for any of these, or for everything, hears about it). */
export const appEventTypes: readonly string[] = [
  'app.synced',
  'app.release.status_changed',
  'review.new',
  'review.new_low_rating',
  'review.sync_failed',
  'review.reply_sent',
  'release.rollout_changed',
  'listing.draft_pushed',
  'listing.submitted',
  'release.started',
  'release.stalled',
  'pending.published',
  'ai.suggestion_created',
  'analytics.synced',
  'review.unanswered',
  'assets.pulled',
  'aso.rank_changed',
  'aso.competitor_changed',
  'plan.deadline_due_soon',
  'plan.deadline_overdue',
];

export function listensToApp(endpoint: Pick<WebhookEndpoint, 'eventTypes'>): boolean {
  return (
    endpoint.eventTypes.indexOf('*') >= 0 ||
    endpoint.eventTypes.some((t) => appEventTypes.indexOf(t) >= 0)
  );
}

export type WebhookSummary = { total: number; hearing: number; failing: number; text: string };

export function webhookSummary(list: readonly WebhookEndpoint[]): WebhookSummary {
  const active = list.filter((w) => w.enabled && listensToApp(w));
  const failing = active.filter(
    (w) => w.lastDelivery !== null && w.lastDelivery.status === 'failed',
  ).length;
  const text =
    list.length === 0
      ? t('app:settings.webhooks.none')
      : failing > 0
        ? t('app:settings.webhooks.hearingFailing', { active: active.length, count: list.length, failing })
        : t('app:settings.webhooks.hearing', { active: active.length, count: list.length });
  return { total: list.length, hearing: active.length, failing, text };
}

/** "2 stars or less" for the low-rating alert threshold, or an explanation when it is 0. */
export function lowRatingText(threshold: number): string {
  if (threshold <= 0) return t('app:settings.lowRating.off');
  return t('app:settings.lowRating.on', { count: threshold });
}

// ---------------------------------------------------------------------------------------------
// The page as a whole: the "Jump to" row, the save bar, the one-line hints, the Danger zone

/** The element ids of the parts of App settings (the wrappers in AppSettings.svelte), in the order they are drawn. */
export const appSettingsPartIds = {
  stores: 'app-settings-stores',
  repository: 'app-settings-repository',
  defaults: 'app-settings-defaults',
  playReleases: 'app-settings-play-releases',
  playBucket: 'app-settings-play-bucket',
  notifications: 'app-settings-notifications',
  ai: 'app-settings-ai',
  danger: 'app-settings-danger',
} as const;

/**
 * The parts of App settings the person can jump to. The Google Play parts exist only for an Android record, the AI part only when
 * the assistant is on for this workspace (`ai`), and the Danger zone only for a role that can delete (`canDelete`).
 */
export function appSettingsSections(input: {
  android: boolean;
  ai: boolean;
  canDelete: boolean;
}): SettingsSection[] {
  const ids = appSettingsPartIds;
  return [
    { id: ids.stores, label: t('app:settings.part.stores') },
    { id: ids.repository, label: t('app:settings.part.repository') },
    { id: ids.defaults, label: t('app:settings.part.defaults') },
    ...(input.android
      ? [
          { id: ids.playReleases, label: t('app:settings.part.playReleases') },
          { id: ids.playBucket, label: t('app:settings.part.playBucket') },
        ]
      : []),
    { id: ids.notifications, label: t('app:settings.part.notifications') },
    ...(input.ai ? [{ id: ids.ai, label: t('app:settings.part.ai') }] : []),
    ...(input.canDelete ? [{ id: ids.danger, label: t('app:settings.part.danger') }] : []),
  ];
}

/** What the save bar of a form says. `saving` reads as a pending save, so the words do not flip while the request runs. */
export function saveBarText(dirty: boolean, saving: boolean): string {
  return dirty || saving ? t('app:settings.saveBar.dirty') : t('app:settings.saveBar.saved');
}

/** The hint under the Google Play staged rollout choice: one sentence, with what is known about earlier releases. */
export function stagedRolloutHint(earlierProductionRelease: boolean): string {
  return earlierProductionRelease
    ? t('app:settings.stagedRollout.withEarlier')
    : t('app:settings.stagedRollout.withoutEarlier');
}

/** The one visible line of the Danger zone for a record: what deleting does and what it does not touch. */
export function deleteLine(store: string): string {
  return t('app:settings.deleteLine', { store });
}
