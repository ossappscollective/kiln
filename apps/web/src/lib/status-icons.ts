import type { ReleaseState, Role } from '@kiln/core';
import type { IconName } from './icons.ts';

/**
 * One icon per normalized release status, always shown beside the status text, never alone.
 * Keyed by ReleaseState so a new state fails the type check here until it gets an icon.
 */
export const statusIcons: Record<ReleaseState, IconName> = {
  draft: 'edit',
  build_chosen: 'box',
  ready: 'flag',
  in_review: 'clock',
  rejected: 'x-circle',
  approved: 'check',
  propagating: 'refresh',
  rolling_out: 'trending-up',
  live: 'check-circle',
  halted: 'pause',
};

/** The icon for a status. A store state with no normalized status (`null`) gets the help glyph. */
export function statusIcon(status: ReleaseState | null | undefined): IconName {
  return status ? statusIcons[status] : 'help';
}

export type IconTone = 'neutral' | 'ok' | 'bad' | 'warn' | 'info' | 'accent';

const toneIcons: Record<IconTone, IconName> = {
  ok: 'check-circle',
  bad: 'x-circle',
  warn: 'alert-triangle',
  info: 'info',
  accent: 'check',
  neutral: 'minus',
};

/** The icon that goes with a Badge tone, for chips whose status comes with a tone (tokens, webhooks, deliveries). */
export function toneIcon(tone: IconTone | string | null | undefined): IconName {
  return toneIcons[tone as IconTone] ?? toneIcons.neutral;
}

/** One icon per workspace role, shown beside the role name. */
export const roleIcons: Record<Role, IconName> = {
  owner: 'shield',
  admin: 'settings',
  member: 'user',
  viewer: 'eye',
};
