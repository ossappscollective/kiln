import type { AuditEvent } from './types.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 minutes ago", "yesterday", or a date once it is over a week old. */
export function timeAgo(then: number, now: number = Date.now(), locale?: string): string {
  const diff = now - then;
  if (diff < MINUTE) return 'just now';
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (diff < HOUR) return plural(Math.floor(diff / MINUTE), 'minute');
  if (diff < DAY) return plural(Math.floor(diff / HOUR), 'hour');
  if (diff < 2 * DAY) return 'yesterday';
  if (diff < 7 * DAY) return plural(Math.floor(diff / DAY), 'day');
  return new Date(then).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** A calendar day in the person's language and zone, e.g. "20 Nov 2026". */
export function dayText(at: number, locale?: string): string {
  return new Date(at).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fullTime(at: number, locale?: string): string {
  return new Date(at).toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const actions: Record<string, (detail: Record<string, unknown> | null) => string> = {
  'workspace.create': (d) => `created the workspace${d?.name ? ` “${String(d.name)}”` : ''}`,
  'credential.create': (d) => `added a credential${d?.label ? ` “${String(d.label)}”` : ''}`,
  'credential.rotate': () => 'replaced the secret of a credential',
  'credential.delete': () => 'deleted a credential',
  'invitation.create': (d) =>
    `invited ${d?.email ? String(d.email) : 'someone'}${d?.role ? ` as ${String(d.role)}` : ''}`,
  'invitation.accept': (d) =>
    `joined the workspace${d?.role ? ` as ${String(d.role)}` : ''} from an invitation`,
  'invitation.revoke': (d) => `revoked the invitation${d?.email ? ` for ${String(d.email)}` : ''}`,
  'member.role_change': (d) =>
    `changed a member’s role${d?.from && d?.to ? ` from ${String(d.from)} to ${String(d.to)}` : ''}`,
  'member.remove': (d) => (d?.self ? 'left the workspace' : 'removed a member from the workspace'),
  'credential.use': (d) => `used a credential${d?.purpose ? ` for ${String(d.purpose)}` : ''}`,
  'plan.create': (d) => `started a plan${d?.version ? ` for version ${String(d.version)}` : ''}`,
  'plan.update': (d) => `changed a release plan${d?.version ? ` (${String(d.version)})` : ''}`,
  'plan.delete': (d) => `deleted the plan${d?.version ? ` for version ${String(d.version)}` : ''}`,
  'plan.apply_template': (d) =>
    `added checklist items${d?.template ? ` from “${String(d.template)}”` : ''}`,
  'plan.notes_set': (d) => `edited the release notes${d?.locale ? ` for ${String(d.locale)}` : ''}`,
  'plan.notes_delete': (d) =>
    `removed the release notes${d?.locale ? ` for ${String(d.locale)}` : ''}`,
  'plan.rollout_set': (d) =>
    `planned a staged rollout${d?.version ? ` for version ${String(d.version)}` : ''}`,
  'plan.rollout_clear': (d) =>
    `removed the rollout plan${d?.version ? ` of version ${String(d.version)}` : ''}`,
  'plan.rollout_step_done': (d) =>
    `marked a rollout step${d?.percent ? ` (${String(d.percent)}%)` : ''} done${d?.source === 'store' ? ' after the store reported it' : ''}`,
  'plan.rollout_step_skipped': (d) =>
    `skipped a rollout step${d?.percent ? ` (${String(d.percent)}%)` : ''}`,
  'plan.rollout_step_reopened': (d) =>
    `reopened a rollout step${d?.percent ? ` (${String(d.percent)}%)` : ''}`,
  'plan.reminder': (d) =>
    `sent a reminder${d?.kind ? ` (${String(d.kind).replace(/_/g, ' ')})` : ''}${d?.version ? ` for version ${String(d.version)}` : ''}`,
  'checklist.item_add': () => 'added a checklist item to a release plan',
  'checklist.item_update': () => 'changed a checklist item of a release plan',
  'checklist.item_delete': () => 'removed a checklist item from a release plan',
  'checklist.reorder': () => 'reordered the checklist of a release plan',
  'checklist_template.create': (d) =>
    `saved a checklist template${d?.name ? ` “${String(d.name)}”` : ''}`,
  'checklist_template.update': (d) =>
    `changed a checklist template${d?.name ? ` “${String(d.name)}”` : ''}`,
  'checklist_template.delete': (d) =>
    `deleted a checklist template${d?.name ? ` “${String(d.name)}”` : ''}`,
  'token.create': (d) =>
    `made an API token${d?.name ? ` “${String(d.name)}”` : ''}${d?.role ? ` (${String(d.role)})` : ''}`,
  'token.revoke': (d) => `revoked an API token${d?.name ? ` “${String(d.name)}”` : ''}`,
  'webhook.create': (d) => `added a webhook${d?.url ? ` for ${String(d.url)}` : ''}`,
  'webhook.update': (d) =>
    `changed a webhook${Array.isArray(d?.changed) && d.changed.length > 0 ? ` (${d.changed.join(', ')})` : ''}`,
  'webhook.delete': (d) => `deleted a webhook${d?.url ? ` for ${String(d.url)}` : ''}`,
  'webhook.rotate_secret': () => 'made a new signing secret for a webhook',
  'webhook.test': () => 'sent a test event to a webhook',
  'webhook.redeliver': () => 'sent a webhook delivery again',
};

/** "2:14 PM" in the viewer's locale. */
export function clockTime(at: number, locale?: string): string {
  return new Date(at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

/** The parts of an audit sentence, so the actor can be set in bold: `who` and `what`. */
export function describeEventParts(
  event: Pick<AuditEvent, 'action' | 'actorType' | 'actorName' | 'detail'>,
): { who: string; what: string } {
  const who =
    event.actorType === 'token' && event.actorName
      ? `API token “${event.actorName}”`
      : (event.actorName ?? (event.actorType === 'user' ? 'Someone' : capitalize(event.actorType)));
  const what = actions[event.action]?.(event.detail) ?? event.action;
  return { who, what };
}

/** "Ada added a credential “Acme key”". Unknown actions show their raw name. */
export function describeEvent(
  event: Pick<AuditEvent, 'action' | 'actorType' | 'actorName' | 'detail'>,
): string {
  const { who, what } = describeEventParts(event);
  return `${who} ${what}`;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Up to two initials for an avatar: "Ada Lovelace" is "AL", "ada" is "A", "" is "?". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = [...(words[0] as string)][0] ?? '';
  const last = words.length > 1 ? ([...(words[words.length - 1] as string)][0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** The kind of thing an audit action is about: "credential.create" is "credential". */
export function eventCategory(action: string): string {
  const dot = action.indexOf('.');
  return dot > 0 ? action.slice(0, dot) : 'other';
}

const categoryLabels: Record<string, string> = {
  credential: 'Credentials',
  workspace: 'Workspace',
  member: 'Members',
  invite: 'Invitations',
  invitation: 'Invitations',
  repository: 'Repositories',
  token: 'API tokens',
  webhook: 'Webhooks',
  plan: 'Release plans',
  checklist: 'Checklists',
  checklist_template: 'Checklist templates',
  other: 'Other',
};

export function categoryLabel(category: string): string {
  return categoryLabels[category] ?? `${capitalize(category)}`;
}

/** An icon name (see components/ui/icons.ts) and a tone for an audit action. */
export function eventVisual(action: string): {
  icon: string;
  tone: 'ok' | 'bad' | 'info' | 'neutral';
} {
  const verb = action.slice(action.lastIndexOf('.') + 1);
  const category = eventCategory(action);
  if (verb === 'delete' || verb === 'remove' || verb === 'revoke')
    return { icon: 'trash', tone: 'bad' };
  if (verb === 'rotate') return { icon: 'refresh', tone: 'info' };
  if (verb === 'use') return { icon: 'key', tone: 'neutral' };
  if (category === 'workspace') return { icon: 'layers', tone: 'ok' };
  if (category === 'member' || category === 'invite' || category === 'invitation')
    return { icon: 'users', tone: 'ok' };
  if (category === 'credential') return { icon: 'key', tone: 'ok' };
  if (category === 'token') return { icon: 'shield', tone: 'ok' };
  if (category === 'webhook') return { icon: 'globe', tone: 'ok' };
  if (verb === 'create' || verb === 'add') return { icon: 'plus', tone: 'ok' };
  return { icon: 'history', tone: 'neutral' };
}

function startOfDay(at: number): Date {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** "Today", "Yesterday", or a date such as "Mon, 3 Nov". Uses the viewer's local days. */
export function dayLabel(at: number, now: number = Date.now(), locale?: string): string {
  const days = Math.round((startOfDay(now).getTime() - startOfDay(at).getTime()) / DAY);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Groups items (already sorted by time) into runs that share a local day. */
export function groupByDay<T extends { at: number }>(
  items: readonly T[],
  now: number = Date.now(),
  locale?: string,
): Array<{ key: string; label: string; items: T[] }> {
  const groups: Array<{ key: string; label: string; items: T[] }> = [];
  for (const item of items) {
    const key = String(startOfDay(item.at).getTime());
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, label: dayLabel(item.at, now, locale), items: [item] });
  }
  return groups;
}
