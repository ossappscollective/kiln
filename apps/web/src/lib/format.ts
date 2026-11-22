import { formatDate, formatDateTime, formatTime, formatList } from './i18n/format.ts';
import { k, t } from './i18n/t.ts';
import type { AuditEvent } from './types.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 minutes ago", "yesterday", or a date once it is over a week old. */
export function timeAgo(then: number, now: number = Date.now(), locale?: string): string {
  const diff = now - then;
  if (diff < MINUTE) return t('workspace:time.justNow');
  if (diff < HOUR) return t('workspace:time.minutesAgo', { count: Math.floor(diff / MINUTE) });
  if (diff < DAY) return t('workspace:time.hoursAgo', { count: Math.floor(diff / HOUR) });
  if (diff < 2 * DAY) return t('workspace:time.yesterday');
  if (diff < 7 * DAY) return t('workspace:time.daysAgo', { count: Math.floor(diff / DAY) });
  return formatDate(then, { locale });
}

/** A calendar day in the person's language and zone, e.g. "20 Nov 2026". */
export function dayText(at: number, locale?: string): string {
  return formatDate(at, { locale });
}

export function fullTime(at: number, locale?: string): string {
  return formatDateTime(at, { locale });
}

const str = (v: unknown): string => String(v);

const actions: Record<string, (detail: Record<string, unknown> | null) => string> = {
  'workspace.create': (d) =>
    d?.name
      ? t('workspace:audit.workspaceCreateNamed', { name: str(d.name) })
      : t('workspace:audit.workspaceCreate'),
  'credential.create': (d) =>
    d?.label
      ? t('workspace:audit.credentialCreateLabeled', { label: str(d.label) })
      : t('workspace:audit.credentialCreate'),
  'credential.rotate': () => t('workspace:audit.credentialRotate'),
  'credential.delete': () => t('workspace:audit.credentialDelete'),
  'invitation.create': (d) =>
    d?.email
      ? d?.role
        ? t('workspace:audit.invitationCreate', { email: str(d.email), role: roleWord(d.role) })
        : t('workspace:audit.invitationCreateEmail', { email: str(d.email) })
      : d?.role
        ? t('workspace:audit.invitationCreateRole', { role: roleWord(d.role) })
        : t('workspace:audit.invitationCreateNone'),
  'invitation.accept': (d) =>
    d?.role
      ? t('workspace:audit.invitationAccept', { role: roleWord(d.role) })
      : t('workspace:audit.invitationAcceptNoRole'),
  'invitation.revoke': (d) =>
    d?.email
      ? t('workspace:audit.invitationRevoke', { email: str(d.email) })
      : t('workspace:audit.invitationRevokeNoEmail'),
  'member.role_change': (d) =>
    d?.from && d?.to
      ? t('workspace:audit.memberRoleChange', { from: roleWord(d.from), to: roleWord(d.to) })
      : t('workspace:audit.memberRoleChangeNoDetail'),
  'member.remove': (d) =>
    d?.self ? t('workspace:audit.memberLeave') : t('workspace:audit.memberRemove'),
  'credential.use': (d) =>
    d?.purpose
      ? t('workspace:audit.credentialUse', { purpose: str(d.purpose) })
      : t('workspace:audit.credentialUseNoPurpose'),
  'plan.create': (d) =>
    d?.version
      ? t('workspace:audit.planCreate', { version: str(d.version) })
      : t('workspace:audit.planCreateNoVersion'),
  'plan.update': (d) =>
    d?.version
      ? t('workspace:audit.planUpdate', { version: str(d.version) })
      : t('workspace:audit.planUpdateNoVersion'),
  'plan.delete': (d) =>
    d?.version
      ? t('workspace:audit.planDelete', { version: str(d.version) })
      : t('workspace:audit.planDeleteNoVersion'),
  'plan.apply_template': (d) =>
    d?.template
      ? t('workspace:audit.planApplyTemplate', { template: str(d.template) })
      : t('workspace:audit.planApplyTemplateNone'),
  'plan.notes_set': (d) =>
    d?.locale
      ? t('workspace:audit.planNotesSet', { locale: str(d.locale) })
      : t('workspace:audit.planNotesSetNoLocale'),
  'plan.notes_delete': (d) =>
    d?.locale
      ? t('workspace:audit.planNotesDelete', { locale: str(d.locale) })
      : t('workspace:audit.planNotesDeleteNoLocale'),
  'plan.rollout_set': (d) =>
    d?.version
      ? t('workspace:audit.planRolloutSet', { version: str(d.version) })
      : t('workspace:audit.planRolloutSetNoVersion'),
  'plan.rollout_clear': (d) =>
    d?.version
      ? t('workspace:audit.planRolloutClear', { version: str(d.version) })
      : t('workspace:audit.planRolloutClearNoVersion'),
  'plan.rollout_step_done': (d) =>
    d?.source === 'store'
      ? d?.percent
        ? t('workspace:audit.planStepDoneStorePercent', { percent: str(d.percent) })
        : t('workspace:audit.planStepDoneStore')
      : d?.percent
        ? t('workspace:audit.planStepDonePercent', { percent: str(d.percent) })
        : t('workspace:audit.planStepDone'),
  'plan.rollout_step_skipped': (d) =>
    d?.percent
      ? t('workspace:audit.planStepSkippedPercent', { percent: str(d.percent) })
      : t('workspace:audit.planStepSkipped'),
  'plan.rollout_step_reopened': (d) =>
    d?.percent
      ? t('workspace:audit.planStepReopenedPercent', { percent: str(d.percent) })
      : t('workspace:audit.planStepReopened'),
  'plan.reminder': (d) =>
    d?.kind
      ? d?.version
        ? t('workspace:audit.planReminderKindVersion', {
            kind: str(d.kind).replace(/_/g, ' '),
            version: str(d.version),
          })
        : t('workspace:audit.planReminderKind', { kind: str(d.kind).replace(/_/g, ' ') })
      : d?.version
        ? t('workspace:audit.planReminderVersion', { version: str(d.version) })
        : t('workspace:audit.planReminder'),
  'checklist.item_add': () => t('workspace:audit.checklistItemAdd'),
  'checklist.item_update': () => t('workspace:audit.checklistItemUpdate'),
  'checklist.item_delete': () => t('workspace:audit.checklistItemDelete'),
  'checklist.reorder': () => t('workspace:audit.checklistReorder'),
  'checklist_template.create': (d) =>
    d?.name
      ? t('workspace:audit.templateCreateNamed', { name: str(d.name) })
      : t('workspace:audit.templateCreate'),
  'checklist_template.update': (d) =>
    d?.name
      ? t('workspace:audit.templateUpdateNamed', { name: str(d.name) })
      : t('workspace:audit.templateUpdate'),
  'checklist_template.delete': (d) =>
    d?.name
      ? t('workspace:audit.templateDeleteNamed', { name: str(d.name) })
      : t('workspace:audit.templateDelete'),
  'token.create': (d) =>
    d?.name
      ? d?.role
        ? t('workspace:audit.tokenCreateNameRole', { name: str(d.name), role: roleWord(d.role) })
        : t('workspace:audit.tokenCreateName', { name: str(d.name) })
      : d?.role
        ? t('workspace:audit.tokenCreateRole', { role: roleWord(d.role) })
        : t('workspace:audit.tokenCreate'),
  'token.revoke': (d) =>
    d?.name
      ? t('workspace:audit.tokenRevokeNamed', { name: str(d.name) })
      : t('workspace:audit.tokenRevoke'),
  'webhook.create': (d) =>
    d?.url
      ? t('workspace:audit.webhookCreateUrl', { url: str(d.url) })
      : t('workspace:audit.webhookCreate'),
  'webhook.update': (d) =>
    Array.isArray(d?.changed) && d.changed.length > 0
      ? t('workspace:audit.webhookUpdateFields', {
          fields: formatList(d.changed.map(str), { type: 'unit' }),
        })
      : t('workspace:audit.webhookUpdate'),
  'webhook.delete': (d) =>
    d?.url
      ? t('workspace:audit.webhookDeleteUrl', { url: str(d.url) })
      : t('workspace:audit.webhookDelete'),
  'webhook.rotate_secret': () => t('workspace:audit.webhookRotateSecret'),
  'webhook.test': () => t('workspace:audit.webhookTest'),
  'webhook.redeliver': () => t('workspace:audit.webhookRedeliver'),
};

/** A role as a lower-case word in the middle of a sentence; a role this version does not know is shown as it is. */
const roleWords: Record<string, string> = {
  owner: k('workspace:audit.role.owner'),
  admin: k('workspace:audit.role.admin'),
  member: k('workspace:audit.role.member'),
  viewer: k('workspace:audit.role.viewer'),
};
const roleWord = (role: unknown): string => {
  const key = roleWords[str(role)];
  return key ? t(key) : str(role);
};

/** "2:14 PM" in the viewer's locale. */
export function clockTime(at: number, locale?: string): string {
  return formatTime(at, { locale });
}

/** The parts of an audit sentence, so the actor can be set in bold: `who` and `what`. */
export function describeEventParts(
  event: Pick<AuditEvent, 'action' | 'actorType' | 'actorName' | 'detail'>,
): { who: string; what: string } {
  const who =
    event.actorType === 'token' && event.actorName
      ? t('workspace:audit.actorToken', { name: event.actorName })
      : (event.actorName ?? actorFallback(event.actorType));
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

/** Who did it when the event has no name: "Someone" for a person, "System" and "Assistant" for the others. */
export const actorFallback = (actorType: string): string =>
  actorType === 'user'
    ? t('workspace:audit.actorSomeone')
    : actorType === 'system'
      ? t('workspace:audit.actorSystem')
      : actorType === 'assistant'
        ? t('workspace:audit.actorAssistant')
        : capitalize(actorType);

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
  credential: k('workspace:audit.category.credential'),
  workspace: k('workspace:audit.category.workspace'),
  member: k('workspace:audit.category.member'),
  invite: k('workspace:audit.category.invitation'),
  invitation: k('workspace:audit.category.invitation'),
  repository: k('workspace:audit.category.repository'),
  token: k('workspace:audit.category.token'),
  webhook: k('workspace:audit.category.webhook'),
  plan: k('workspace:audit.category.plan'),
  checklist: k('workspace:audit.category.checklist'),
  checklist_template: k('workspace:audit.category.checklistTemplate'),
  other: k('workspace:audit.category.other'),
};

export function categoryLabel(category: string): string {
  const key = categoryLabels[category];
  return key ? t(key) : capitalize(category);
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
  if (days === 0) return t('workspace:time.today');
  if (days === 1) return t('workspace:time.yesterdayDay');
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return formatDate(at, {
    locale,
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
