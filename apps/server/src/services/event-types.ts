// A leaf module (no imports), so the webhook and audit code can read the list without a cycle.
import type { Action } from '@kiln/core';

/** Every type an event can have. Adding one here is all a new emitter needs, plus the docs. */
export const eventTypes = [
  'app.synced',
  'app.release.status_changed',
  'changeset.created',
  'changeset.approved',
  'changeset.applied',
  'changeset.failed',
  'credential.test_failed',
  'plan.rollout_step_done',
  'plan.rollout_step_skipped',
  'plan.rollout_step_reopened',
  'plan.deadline_due_soon',
  'plan.deadline_overdue',
  'plan.rollout_step_due',
  'review.new',
  'review.new_low_rating',
  'review.sync_failed',
  'review.reply_sent',
  // TestFlight (docs/adr/0049-testflight-feedback.md): a new beta feedback or crash was stored (ids, build and platform only).
  'testflight.feedback',
  'testflight.crash',
  // App health (docs/adr/0052-ratings-and-health.md): a version crashes clearly more than the one before it (ids, version names and two rates only).
  'health.crash_regression',
  'release.rollout_changed',
  'listing.draft_pushed',
  'listing.submitted',
  'release.started',
  'pending.published',
  'release.stalled',
  'review.unanswered',
  'aso.rank_changed',
  'aso.competitor_changed',
  'ci.run_started',
  'ci.run_finished',
  'assets.pulled',
  'ai.suggestion_created',
  'analytics.synced',
  'stepup.verified',
  'stepup.failed',
  'stepup.recovery_used',
  'auth.second_factor_failed',
  // Alerts (docs/alerts.md): the event an alert becomes for webhooks, and the two audit facts alerts report.
  'alert.raised',
  'token.created',
  'member.added',
] as const;
export type EventType = (typeof eventTypes)[number];

export const isEventType = (value: unknown): value is EventType =>
  typeof value === 'string' && (eventTypes as readonly string[]).includes(value);

/** The action that lets a person read events of each type: an event is visible to who can read what it is about. */
export const eventReadAction: Record<EventType, Action> = {
  'app.synced': 'apps.read',
  'app.release.status_changed': 'apps.read',
  'changeset.created': 'repositories.read',
  'changeset.approved': 'repositories.read',
  'changeset.applied': 'repositories.read',
  'changeset.failed': 'repositories.read',
  'credential.test_failed': 'credentials.read',
  'plan.rollout_step_done': 'plans.read',
  'plan.rollout_step_skipped': 'plans.read',
  'plan.rollout_step_reopened': 'plans.read',
  'plan.deadline_due_soon': 'plans.read',
  'plan.deadline_overdue': 'plans.read',
  'plan.rollout_step_due': 'plans.read',
  // Ids, store, platform and rating only (or a count for a grouped event); never a title, a text or a name.
  'review.new': 'reviews.read',
  'review.new_low_rating': 'reviews.read',
  'review.sync_failed': 'reviews.read',
  'review.reply_sent': 'reviews.read',
  // Ids, build and platform only (or a count for a grouped event); never a comment, a tester or a crash log.
  'testflight.feedback': 'reviews.read',
  'testflight.crash': 'reviews.read',
  'health.crash_regression': 'reviews.read',
  'release.rollout_changed': 'apps.read',
  'listing.draft_pushed': 'listing.read',
  'listing.submitted': 'listing.read',
  'release.started': 'apps.read',
  'pending.published': 'apps.read',
  'release.stalled': 'apps.read',
  'review.unanswered': 'reviews.read',
  'aso.rank_changed': 'aso.read',
  'aso.competitor_changed': 'aso.read',
  'ci.run_started': 'repositories.read',
  'ci.run_finished': 'repositories.read',
  'assets.pulled': 'listing.read',
  // Who may run AI tasks may see that a suggestion exists (ids only; the suggestion itself needs the same right).
  'ai.suggestion_created': 'ai.use',
  // New analytics numbers were stored for an app (ids and counts only).
  'analytics.synced': 'analytics.read',
  // Who confirmed (or failed to confirm) a hard action: admins only (ids and factor type, never a secret).
  'stepup.verified': 'settings.write',
  'stepup.failed': 'settings.write',
  'stepup.recovery_used': 'settings.write',
  // A wrong second factor at sign-in (docs/api/two-factor.md): admins only, ids and a fixed reason, never a code.
  'auth.second_factor_failed': 'settings.write',
  // An alert is visible to who may read alerts; who made a token or who joined: admins only (ids, names and roles, never a secret).
  'alert.raised': 'alerts.read',
  'token.created': 'settings.write',
  'member.added': 'settings.write',
};
