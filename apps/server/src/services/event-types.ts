// A leaf module (no imports), so the webhook and audit code can read the list without a cycle.
import type { Action } from '@mrm/core';

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
  'review.new_low_rating',
  'review.sync_failed',
  'review.reply_sent',
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
  'review.new_low_rating': 'reviews.read',
  'review.sync_failed': 'reviews.read',
  'review.reply_sent': 'reviews.read',
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
};
