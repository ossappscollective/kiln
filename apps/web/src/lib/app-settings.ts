import { type CredentialKind, credentialKindInfo, isCredentialKind } from '@mrm/core';
import { appAddress } from './app-scope.ts';
import { testStatus } from './credentials.ts';
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
  changeCredential:
    'Changing the credential of an app is not available yet. Delete the record below and add the app again with another credential.',
  changeRepository:
    'Linking or unlinking a repository for an existing app is not available yet. The link is set when the app is added.',
  releaseDefaults:
    'Default track, default checklist template and default release notes per app are not available yet.',
  appNotifications:
    'Choosing which notifications an app sends is not available yet: webhooks and thresholds are set for the whole workspace.',
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
      label: 'Not shown',
      kind: '',
      found: false,
      tone: 'none',
      status: 'Not shown',
      detail: 'Reading credentials needs a member role or higher.',
    };
  }
  const cred = list.filter((c) => c.id === credentialId)[0];
  if (!cred) {
    return {
      label: 'Credential not found',
      kind: '',
      found: false,
      tone: 'bad',
      status: 'Missing',
      detail:
        'The credential of this app no longer exists. Syncing will fail until the app is added again.',
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
      ? 'Set for this app'
      : e.source === 'repository'
        ? 'Set for the repository'
        : 'Defaults of the tool';
  const lines = [source];
  lines.push(`Tag patterns: ${e.tagPatterns.length > 0 ? e.tagPatterns.join(', ') : 'none'}`);
  lines.push(
    `Release patterns: ${e.releasePatterns.length > 0 ? e.releasePatterns.join(', ') : 'none'}`,
  );
  if (e.prefix !== '') lines.push(`Tag prefix: ${e.prefix}`);
  lines.push(`Workflow: ${e.workflow ?? 'not chosen'}`);
  return lines;
}

/** "3 templates (2 built in, 1 yours)". */
export function templatesSummary(list: readonly ChecklistTemplate[]): string {
  const builtin = list.filter((t) => t.builtin).length;
  const custom = list.length - builtin;
  if (list.length === 0) return 'No checklist templates yet';
  return `${list.length} ${list.length === 1 ? 'template' : 'templates'} (${builtin} built in, ${custom} yours)`;
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
      ? 'No webhooks are set up in this workspace.'
      : `${active.length} of ${list.length} ${list.length === 1 ? 'webhook hears' : 'webhooks hear'} about events of this app${failing > 0 ? `; ${failing} had a failed last delivery` : ''}.`;
  return { total: list.length, hearing: active.length, failing, text };
}

/** "2 stars or less" for the low-rating alert threshold, or an explanation when it is 0. */
export function lowRatingText(threshold: number): string {
  if (threshold <= 0) return 'Low-rating alerts are off.';
  return `A review of ${threshold} ${threshold === 1 ? 'star' : 'stars'} or less counts as low and raises an alert.`;
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
    { id: ids.stores, label: 'Stores' },
    { id: ids.repository, label: 'Repository' },
    { id: ids.defaults, label: 'Release defaults' },
    ...(input.android
      ? [
          { id: ids.playReleases, label: 'Google Play releases' },
          { id: ids.playBucket, label: 'Reports bucket' },
        ]
      : []),
    { id: ids.notifications, label: 'Notifications' },
    ...(input.ai ? [{ id: ids.ai, label: 'AI assistant' }] : []),
    ...(input.canDelete ? [{ id: ids.danger, label: 'Danger zone' }] : []),
  ];
}

/** What the save bar of a form says. `saving` reads as a pending save, so the words do not flip while the request runs. */
export function saveBarText(dirty: boolean, saving: boolean): string {
  return dirty || saving ? 'You have unsaved changes.' : 'All changes are saved.';
}

/** The hint under the Google Play staged rollout choice: one sentence, with what is known about earlier releases. */
export function stagedRolloutHint(earlierProductionRelease: boolean): string {
  return earlierProductionRelease
    ? 'Google Play offers it for updates only, and this app has an earlier production release.'
    : 'Google Play offers it for updates only, and this app has no earlier production release stored yet.';
}

/** The one visible line of the Danger zone for a record: what deleting does and what it does not touch. */
export function deleteLine(store: string): string {
  return `Removes its stored releases, reviews and plans from this workspace. Nothing in ${store} is changed, and you can add it again.`;
}
