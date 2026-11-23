import { type CredentialKind, credentialKindInfo, isCredentialKind } from '@kiln/core';
import type { AnalyticsStatus } from './analytics/analytics.ts';
import { appAddress, parseViewPath } from './app-scope.ts';
import { testStatus } from './credentials.ts';
import { k, t } from './i18n/t.ts';
import { type RailGroup, nonEmptyGroups, railEntries } from './section-rail.ts';
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
  'testflight.feedback',
  'testflight.crash',
  'eas.build_failed',
  'eas.submission_failed',
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
  'aso.competitor_listing_changed',
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
        ? t('app:settings.webhooks.hearingFailing', {
            active: active.length,
            count: list.length,
            failing,
          })
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

/**
 * The sections of App settings, in the rail (`?section=`, components/ui/SectionRail.svelte): one at a time, every card open. The ids are
 * the addresses: the old element ids (`app-settings-stores`, ...) still resolve through `resolveAppSettingsSection`.
 */
export const appSettingsPartIds = {
  stores: 'stores',
  repository: 'repository',
  listing: 'listing',
  integrations: 'integrations',
  defaults: 'defaults',
  playReleases: 'play-releases',
  playBucket: 'play-bucket',
  notifications: 'notifications',
  ai: 'ai',
  danger: 'danger',
} as const;

export type AppSettingsInput = {
  /** Some record in scope is an Android app (Google Play releases and reports exist only there). */
  android: boolean;
  /** The AI assistant is on for this workspace and the role may use it. */
  ai: boolean;
  /** The role may delete an app. */
  canDelete: boolean;
};

/** The rail of App settings: groups of the sections that exist for this app and role. */
export function appSettingsGroups(input: AppSettingsInput): RailGroup[] {
  const ids = appSettingsPartIds;
  const entry = (id: string, label: string) => ({ id, label });
  return nonEmptyGroups([
    {
      id: 'connections',
      label: t(k('app:settings.group.connections')),
      entries: [
        entry(ids.stores, t(k('app:settings.part.stores'))),
        entry(ids.repository, t(k('app:settings.part.repository'))),
        entry(ids.listing, t(k('app:settings.part.listing'))),
        entry(ids.integrations, t(k('app:settings.part.integrations'))),
      ],
    },
    {
      id: 'releases',
      label: t(k('app:settings.group.releases')),
      entries: [
        entry(ids.defaults, t(k('app:settings.part.defaults'))),
        ...(input.android ? [entry(ids.playReleases, t(k('app:settings.part.playReleases')))] : []),
      ],
    },
    {
      id: 'data',
      label: t(k('app:settings.group.data')),
      entries: [
        ...(input.android ? [entry(ids.playBucket, t(k('app:settings.part.playBucket')))] : []),
        entry(ids.notifications, t(k('app:settings.part.notifications'))),
        ...(input.ai ? [entry(ids.ai, t(k('app:settings.part.ai')))] : []),
      ],
    },
    {
      id: 'danger',
      label: t(k('app:settings.group.danger')),
      entries: input.canDelete ? [entry(ids.danger, t(k('app:settings.part.danger')))] : [],
    },
  ]);
}

/** The flat list of the sections (the rail without its groups). */
export const appSettingsSections = (input: AppSettingsInput): SettingsSection[] =>
  railEntries(appSettingsGroups(input)).map((e) => ({ id: e.id, label: e.label }));

/**
 * The section the address opens: `?section=`, or the old element id of a part (`app-settings-stores`, also in `?view=`); an unknown one or
 * one this app does not have opens the first section.
 */
export function resolveAppSettingsSection(hash: string, ids: readonly string[]): string {
  const query = parseViewPath(hash).query;
  for (const asked of [query.get('section'), query.get('view')]) {
    const id = asked?.replace(/^app-settings-/, '');
    if (id && ids.includes(id)) return id;
  }
  return ids[0] ?? '';
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

// ---------------------------------------------------------------------------------------------
// Effective values: what an app really uses, and where it comes from

/** A value an app uses (not a secret), with where it comes from. */
export type EffectiveValue = { key: string; label: string; value: string; origin: string };

/**
 * The Apple vendor number or the Google Play reports bucket an app reads, from the analytics status, with where the value comes
 * from (this credential, this app, the Play account, the workspace default). Nothing for a value that is not set. Lets a person see
 * that an app is not silently using another account's value.
 */
export function effectiveAnalyticsValues(
  status: Pick<AnalyticsStatus, 'apple' | 'google'> | null,
): EffectiveValue[] {
  if (!status) return [];
  const out: EffectiveValue[] = [];
  const apple = status.apple;
  if (apple?.vendorNumberSet && apple.vendorNumber) {
    out.push({
      key: 'vendorNumber',
      label: t('app:stores.effective.vendorNumber'),
      value: apple.vendorNumber,
      origin: apple.vendorNumberSource === 'credential' ? t('app:stores.effective.fromCredential') : t('app:stores.effective.fromWorkspace'),
    });
  }
  const google = status.google;
  if (google?.bucketIdSet && google.bucketId) {
    out.push({
      key: 'bucket',
      label: t('app:stores.effective.bucket'),
      value: google.bucketId,
      origin:
        google.bucketSource === 'app'
          ? t('app:stores.effective.fromApp')
          : google.bucketSource === 'account'
            ? t('app:stores.effective.fromAccount')
            : t('app:stores.effective.fromWorkspace'),
    });
  }
  return out;
}
