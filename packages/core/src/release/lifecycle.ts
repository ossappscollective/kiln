/**
 * The normalized release lifecycle shared by iOS, macOS and Android.
 * Platform differences stay inside the store connectors; this module only knows
 * the states, the events that move between them, and how states group on the dashboard.
 */

import { type Platform, type StoreFamily, storeFamilyOf } from '../platform.ts';

export const RELEASE_STATES = [
  'draft',
  'build_chosen',
  'ready',
  'in_review',
  'rejected',
  'approved',
  /** Android only: the edit is committed but not yet visible in the store. */
  'propagating',
  'rolling_out',
  'live',
  'halted',
] as const;

export type ReleaseState = (typeof RELEASE_STATES)[number];

export const RELEASE_EVENTS = [
  'choose_build',
  'mark_ready',
  'submit',
  'reject',
  'approve',
  'release',
  'propagated',
  'complete',
  'halt',
  'resume',
  'fix',
] as const;

export type ReleaseEvent = (typeof RELEASE_EVENTS)[number];

type Rule = {
  from: ReleaseState;
  event: ReleaseEvent;
  to: ReleaseState;
  /** Limit a rule to one store family (Apple: iOS and macOS; Google: Android). */
  only?: StoreFamily;
};

const RULES: readonly Rule[] = [
  { from: 'draft', event: 'choose_build', to: 'build_chosen' },
  { from: 'build_chosen', event: 'mark_ready', to: 'ready' },
  { from: 'ready', event: 'submit', to: 'in_review' },
  { from: 'in_review', event: 'reject', to: 'rejected' },
  { from: 'in_review', event: 'approve', to: 'approved' },
  { from: 'rejected', event: 'fix', to: 'draft' },
  // Releasing on Android commits an edit first, so it passes through `propagating`.
  { from: 'approved', event: 'release', to: 'propagating', only: 'google' },
  { from: 'approved', event: 'release', to: 'rolling_out', only: 'apple' },
  { from: 'propagating', event: 'propagated', to: 'rolling_out', only: 'google' },
  { from: 'rolling_out', event: 'complete', to: 'live' },
  { from: 'rolling_out', event: 'halt', to: 'halted' },
  { from: 'halted', event: 'resume', to: 'rolling_out' },
];

export type TransitionResult = { ok: true; state: ReleaseState } | { ok: false; reason: string };

export function transition(
  platform: Platform,
  state: ReleaseState,
  event: ReleaseEvent,
): TransitionResult {
  const rule = RULES.find(
    (r) =>
      r.from === state &&
      r.event === event &&
      (r.only === undefined || r.only === storeFamilyOf(platform)),
  );
  if (!rule) {
    return {
      ok: false,
      reason: `Cannot apply "${event}" to a ${platform} release that is ${state}`,
    };
  }
  return { ok: true, state: rule.to };
}

export function allowedEvents(platform: Platform, state: ReleaseState): ReleaseEvent[] {
  return RULES.filter(
    (r) => r.from === state && (r.only === undefined || r.only === storeFamilyOf(platform)),
  ).map((r) => r.event);
}

/** Blocked is a flag on any state, not a state of its own. */
export type BlockedKind = 'missing_asset' | 'failed_check' | 'rejection' | 'other';

export type Blocked = {
  kind: BlockedKind;
  reason: string;
};

export type DashboardBucket = 'preparing' | 'in_review' | 'ready_to_release' | 'live';

export const DASHBOARD_BUCKETS: readonly DashboardBucket[] = [
  'preparing',
  'in_review',
  'ready_to_release',
  'live',
];

const BUCKETS: Record<ReleaseState, DashboardBucket> = {
  draft: 'preparing',
  build_chosen: 'preparing',
  ready: 'preparing',
  in_review: 'in_review',
  rejected: 'in_review',
  approved: 'ready_to_release',
  propagating: 'live',
  rolling_out: 'live',
  live: 'live',
  halted: 'live',
};

export function dashboardBucket(state: ReleaseState): DashboardBucket {
  return BUCKETS[state];
}
