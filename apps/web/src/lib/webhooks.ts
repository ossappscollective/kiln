import { fullTime, timeAgo } from './format.ts';
import type { WebhookDelivery, WebhookDeliveryStatus, WebhookEndpoint } from './types.ts';

/**
 * The event types a webhook can ask for, with a plain-words description. The server owns the list
 * (apps/server/src/services/event-types.ts); a server test checks that this one matches it.
 */
export const webhookEventChoices: { type: string; label: string }[] = [
  { type: 'app.synced', label: 'An app was synced with its store' },
  { type: 'app.release.status_changed', label: 'A release changed status in the store' },
  { type: 'changeset.created', label: 'A change set was drafted' },
  { type: 'changeset.approved', label: 'A change set was approved' },
  { type: 'changeset.applied', label: 'A change set was applied (pull request opened)' },
  { type: 'changeset.failed', label: 'A change set could not be applied' },
  { type: 'credential.test_failed', label: 'A credential test failed' },
  { type: 'plan.rollout_step_done', label: 'A rollout step of a release plan was marked done' },
  { type: 'plan.rollout_step_skipped', label: 'A rollout step of a release plan was skipped' },
  { type: 'plan.rollout_step_reopened', label: 'A rollout step of a release plan was reopened' },
  { type: 'plan.deadline_due_soon', label: 'A release plan’s deadline is close' },
  { type: 'plan.deadline_overdue', label: 'A release plan’s deadline has passed' },
  { type: 'plan.rollout_step_due', label: 'A planned rollout step’s time has passed' },
  { type: 'review.new_low_rating', label: 'A low-rated customer review arrived (ids and rating only)' },
  { type: 'review.sync_failed', label: 'Reading customer reviews failed' },
  { type: 'review.reply_sent', label: 'A reply to a customer review was published in the store (ids only)' },
  { type: 'release.rollout_changed', label: 'A staged rollout or phased release was changed in the store (ids and values only)' },
  { type: 'listing.draft_pushed', label: 'Staged listing changes were written to the store as a draft (ids and counts only; never submitted)' },
  { type: 'listing.submitted', label: 'A listing version was submitted for review in the store (ids only; never released)' },
  { type: 'release.started', label: 'A release was started in the store: an approved version released or a Play draft rolled out (ids and values only)' },
  { type: 'aso.rank_changed', label: 'A tracked keyword moved a lot in the store search results (ids and places only, never the term)' },
  { type: 'aso.competitor_changed', label: 'A followed competitor changed its listing, price or rating (ids and field names only)' },
  { type: 'ci.run_started', label: 'A GitHub Actions workflow run started (ids only)' },
  { type: 'ci.run_finished', label: 'A GitHub Actions workflow run finished (ids and the conclusion only)' },
  { type: 'assets.pulled', label: 'Store images were pulled into a change set for the repository (ids and counts only)' },
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

export const emptyWebhookForm = (): WebhookForm => ({ url: '', description: '', all: true, types: [], enabled: true });

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
  if (!raw) problems.url = 'Enter the address the events should be sent to.';
  else {
    let parsed: URL | undefined;
    try {
      parsed = new URL(raw);
    } catch {
      problems.url = 'That does not look like a web address. Start with https://.';
    }
    if (parsed) {
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') problems.url = 'Use an https:// address.';
      else if (parsed.username || parsed.password) problems.url = 'Leave the user name and password out of the address.';
      else if (raw.length > 2048) problems.url = 'The address is too long.';
    }
  }
  if (!form.all && form.types.length === 0) problems.types = 'Choose at least one event, or send everything.';
  return problems;
}

export type WebhookInput = { url: string; description?: string; eventTypes: string[]; enabled: boolean };

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
  if ((next.description ?? null) !== endpoint.description) patch.description = next.description ?? null;
  const before = [...endpoint.eventTypes].sort().join(',');
  if ([...next.eventTypes].sort().join(',') !== before) patch.eventTypes = next.eventTypes;
  if (next.enabled !== endpoint.enabled) patch.enabled = next.enabled;
  return patch;
}

export function eventsSummary(endpoint: Pick<WebhookEndpoint, 'eventTypes'>): string {
  if (endpoint.eventTypes.includes('*')) return 'All events';
  const n = endpoint.eventTypes.length;
  return n === 1 ? (endpoint.eventTypes[0] ?? '1 event') : `${n} events`;
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

const deliveryViews: Record<WebhookDeliveryStatus, { label: string; tone: DeliveryTone }> = {
  success: { label: 'Delivered', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  retrying: { label: 'Retrying', tone: 'warn' },
  pending: { label: 'Waiting', tone: 'info' },
};

export function deliveryView(status: string): { label: string; tone: DeliveryTone } {
  return deliveryViews[status as WebhookDeliveryStatus] ?? { label: status, tone: 'info' };
}

/** The line under a delivery: what the receiver said, or what went wrong. */
export function deliveryDetail(delivery: WebhookDelivery): string {
  const parts: string[] = [];
  if (delivery.responseCode !== null) parts.push(`Answered ${delivery.responseCode}`);
  if (delivery.attempts > 1) parts.push(`${delivery.attempts} attempts`);
  if (delivery.error && delivery.status !== 'success') parts.push(delivery.error);
  return parts.join(' · ');
}

export function lastDeliveryLabel(endpoint: Pick<WebhookEndpoint, 'lastDelivery'>, now: number = Date.now()): string {
  const last = endpoint.lastDelivery;
  if (!last) return 'No deliveries yet';
  return `${deliveryView(last.status).label}, ${timeAgo(last.at, now)}`;
}

export const deliveryTime = (delivery: Pick<WebhookDelivery, 'createdAt'>) => fullTime(delivery.createdAt);

/** Only a delivery that has finished, one way or the other, can be sent again. */
export const canRedeliver = (delivery: Pick<WebhookDelivery, 'status'>) =>
  delivery.status === 'success' || delivery.status === 'failed';

/** A short check a receiver can copy: how to verify the signature. Shown beside the secret. */
export const verifySnippet = `// Node.js: verify a delivery
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, headers, rawBody) {
  const timestamp = headers['x-mrm-timestamp'];
  const given = (headers['x-mrm-signature'] ?? '').replace(/^v1=/, '');
  const expected = createHmac('sha256', secret).update(\`\${timestamp}.\${rawBody}\`).digest('hex');
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300; // reject replays
  return fresh && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}`;
