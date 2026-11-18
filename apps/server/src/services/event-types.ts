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
};
