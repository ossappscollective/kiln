import { fullTime, timeAgo } from './format.ts';
import { k, t } from './i18n/t.ts';
import type { WebhookDelivery, WebhookDeliveryStatus, WebhookEndpoint } from './types.ts';

/**
 * The event types a webhook can ask for, with the key of a plain-words description (translate it with `t(choice.labelKey)`). The server owns the list
 * (apps/server/src/services/event-types.ts); a server test checks that this one matches it.
 */
export const webhookEventChoices: { type: string; labelKey: string }[] = [
  { type: 'app.synced', labelKey: k('workspace:webhook.event.appSynced') },
  { type: 'app.release.status_changed', labelKey: k('workspace:webhook.event.appReleaseStatusChanged') },
  { type: 'changeset.created', labelKey: k('workspace:webhook.event.changesetCreated') },
  { type: 'changeset.approved', labelKey: k('workspace:webhook.event.changesetApproved') },
  { type: 'changeset.applied', labelKey: k('workspace:webhook.event.changesetApplied') },
  { type: 'changeset.failed', labelKey: k('workspace:webhook.event.changesetFailed') },
  { type: 'credential.test_failed', labelKey: k('workspace:webhook.event.credentialTestFailed') },
  { type: 'plan.rollout_step_done', labelKey: k('workspace:webhook.event.planRolloutStepDone') },
  { type: 'plan.rollout_step_skipped', labelKey: k('workspace:webhook.event.planRolloutStepSkipped') },
  { type: 'plan.rollout_step_reopened', labelKey: k('workspace:webhook.event.planRolloutStepReopened') },
  { type: 'plan.deadline_due_soon', labelKey: k('workspace:webhook.event.planDeadlineDueSoon') },
  { type: 'plan.deadline_overdue', labelKey: k('workspace:webhook.event.planDeadlineOverdue') },
  { type: 'plan.rollout_step_due', labelKey: k('workspace:webhook.event.planRolloutStepDue') },
  { type: 'review.new', labelKey: k('workspace:webhook.event.reviewNew') },
  { type: 'review.new_low_rating', labelKey: k('workspace:webhook.event.reviewNewLowRating') },
  { type: 'review.sync_failed', labelKey: k('workspace:webhook.event.reviewSyncFailed') },
  { type: 'review.reply_sent', labelKey: k('workspace:webhook.event.reviewReplySent') },
  { type: 'release.rollout_changed', labelKey: k('workspace:webhook.event.releaseRolloutChanged') },
  { type: 'listing.draft_pushed', labelKey: k('workspace:webhook.event.listingDraftPushed') },
  { type: 'listing.submitted', labelKey: k('workspace:webhook.event.listingSubmitted') },
  { type: 'release.started', labelKey: k('workspace:webhook.event.releaseStarted') },
  { type: 'aso.rank_changed', labelKey: k('workspace:webhook.event.asoRankChanged') },
  { type: 'aso.competitor_changed', labelKey: k('workspace:webhook.event.asoCompetitorChanged') },
  { type: 'ci.run_started', labelKey: k('workspace:webhook.event.ciRunStarted') },
  { type: 'release.stalled', labelKey: k('workspace:webhook.event.releaseStalled') },
  { type: 'review.unanswered', labelKey: k('workspace:webhook.event.reviewUnanswered') },
  { type: 'pending.published', labelKey: k('workspace:webhook.event.pendingPublished') },
  { type: 'ai.suggestion_created', labelKey: k('workspace:webhook.event.aiSuggestionCreated') },
  { type: 'analytics.synced', labelKey: k('workspace:webhook.event.analyticsSynced') },
  { type: 'stepup.verified', labelKey: k('workspace:webhook.event.stepupVerified') },
  { type: 'stepup.failed', labelKey: k('workspace:webhook.event.stepupFailed') },
  { type: 'auth.second_factor_failed', labelKey: k('workspace:webhook.event.authSecondFactorFailed') },
  { type: 'stepup.recovery_used', labelKey: k('workspace:webhook.event.stepupRecoveryUsed') },
  { type: 'ci.run_finished', labelKey: k('workspace:webhook.event.ciRunFinished') },
  { type: 'assets.pulled', labelKey: k('workspace:webhook.event.assetsPulled') },
  { type: 'alert.raised', labelKey: k('workspace:webhook.event.alertRaised') },
  { type: 'token.created', labelKey: k('workspace:webhook.event.tokenCreated') },
  { type: 'member.added', labelKey: k('workspace:webhook.event.memberAdded') },
];

export type WebhookForm = {
  url: string;
  description: string;
  /** `*` alone means every event. */
  all: boolean;
  types: string[];
  enabled: boolean;
};

export type WebhookFormProblems = { url?: string; types?: string };

export const emptyWebhookForm = (): WebhookForm => ({
  url: '',
  description: '',
  all: true,
  types: [],
  enabled: true,
});

export function formFromEndpoint(endpoint: WebhookEndpoint): WebhookForm {
  const all = endpoint.eventTypes.includes('*');
  return {
    url: endpoint.url,
    description: endpoint.description ?? '',
    all,
    types: all ? [] : [...endpoint.eventTypes],
    enabled: endpoint.enabled,
  };
}

/**
 * Light checks before asking the server, which decides for real (it also resolves the host name and
 * refuses private addresses). Here: something that parses as an http(s) URL without a password.
 */
export function validateWebhookForm(form: WebhookForm): WebhookFormProblems {
  const problems: WebhookFormProblems = {};
  const raw = form.url.trim();
  if (!raw) problems.url = t('workspace:webhook.form.urlRequired');
  else {
    let parsed: URL | undefined;
    try {
      parsed = new URL(raw);
    } catch {
      problems.url = t('workspace:webhook.form.urlInvalid');
    }
    if (parsed) {
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
        problems.url = t('workspace:webhook.form.urlProtocol');
      else if (parsed.username || parsed.password)
        problems.url = t('workspace:webhook.form.urlCredentials');
      else if (raw.length > 2048) problems.url = t('workspace:webhook.form.urlTooLong');
    }
  }
  if (!form.all && form.types.length === 0)
    problems.types = t('workspace:webhook.form.typesRequired');
  return problems;
}

export type WebhookInput = {
  url: string;
  description?: string;
  eventTypes: string[];
  enabled: boolean;
};

export function createWebhookInput(form: WebhookForm): WebhookInput {
  const description = form.description.trim();
  return {
    url: form.url.trim(),
    ...(description ? { description } : {}),
    eventTypes: form.all ? ['*'] : [...new Set(form.types)],
    enabled: form.enabled,
  };
}

/** What changed, for PATCH: only the fields that differ, so an unchanged URL is not checked again. */
export function patchFor(endpoint: WebhookEndpoint, form: WebhookForm): Record<string, unknown> {
  const next = createWebhookInput(form);
  const patch: Record<string, unknown> = {};
  if (next.url !== endpoint.url) patch.url = next.url;
  if ((next.description ?? null) !== endpoint.description)
    patch.description = next.description ?? null;
  const before = [...endpoint.eventTypes].sort().join(',');
  if ([...next.eventTypes].sort().join(',') !== before) patch.eventTypes = next.eventTypes;
  if (next.enabled !== endpoint.enabled) patch.enabled = next.enabled;
  return patch;
}

export function eventsSummary(endpoint: Pick<WebhookEndpoint, 'eventTypes'>): string {
  if (endpoint.eventTypes.includes('*')) return t('workspace:webhook.eventsAll');
  const n = endpoint.eventTypes.length;
  return n === 1 ? (endpoint.eventTypes[0] ?? t('workspace:webhook.eventsCount', { count: 1 })) : t('workspace:webhook.eventsCount', { count: n });
}

/** "example.com" from a URL, for tight places. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export type DeliveryTone = 'ok' | 'bad' | 'warn' | 'info';

const deliveryViews: Record<WebhookDeliveryStatus, { labelKey: string; tone: DeliveryTone }> = {
  success: { labelKey: k('workspace:webhook.delivery.success'), tone: 'ok' },
  failed: { labelKey: k('workspace:webhook.delivery.failed'), tone: 'bad' },
  retrying: { labelKey: k('workspace:webhook.delivery.retrying'), tone: 'warn' },
  pending: { labelKey: k('workspace:webhook.delivery.pending'), tone: 'info' },
};

export function deliveryView(status: string): { label: string; tone: DeliveryTone } {
  const view = deliveryViews[status as WebhookDeliveryStatus];
  return view ? { label: t(view.labelKey), tone: view.tone } : { label: status, tone: 'info' };
}

/** The line under a delivery: what the receiver said, or what went wrong. */
export function deliveryDetail(delivery: WebhookDelivery): string {
  const parts: string[] = [];
  if (delivery.responseCode !== null) parts.push(t('workspace:webhook.delivery.answered', { code: delivery.responseCode }));
  if (delivery.attempts > 1) parts.push(t('workspace:webhook.delivery.attempts', { count: delivery.attempts }));
  if (delivery.error && delivery.status !== 'success') parts.push(delivery.error);
  return parts.join(' · ');
}

export function lastDeliveryLabel(
  endpoint: Pick<WebhookEndpoint, 'lastDelivery'>,
  now: number = Date.now(),
): string {
  const last = endpoint.lastDelivery;
  if (!last) return t('workspace:webhook.noDeliveries');
  return t('workspace:webhook.lastDelivery', { status: deliveryView(last.status).label, when: timeAgo(last.at, now) });
}

export const deliveryTime = (delivery: Pick<WebhookDelivery, 'createdAt'>) =>
  fullTime(delivery.createdAt);

/** Only a delivery that has finished, one way or the other, can be sent again. */
export const canRedeliver = (delivery: Pick<WebhookDelivery, 'status'>) =>
  delivery.status === 'success' || delivery.status === 'failed';

/** A short check a receiver can copy: how to verify the signature. Shown beside the secret. */
export const verifySnippet = `// Node.js: verify a delivery
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, headers, rawBody) {
  const timestamp = headers['x-kiln-timestamp'];
  const given = (headers['x-kiln-signature'] ?? '').replace(/^v1=/, '');
  const expected = createHmac('sha256', secret).update(\`\${timestamp}.\${rawBody}\`).digest('hex');
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300; // reject replays
  return fresh && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}`;
