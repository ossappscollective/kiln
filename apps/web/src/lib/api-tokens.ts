import { type Action, can, type Role, type TokenRole, tokenActions, tokenRoles } from '@kiln/core';
import { fullTime, timeAgo } from './format.ts';
import { k, t } from './i18n/t.ts';
import type { ApiToken } from './types.ts';

const DAY = 24 * 60 * 60 * 1000;

/** The role names are the shared ones of `common`: translate with `t(tokenRoleLabel[role])`. */
export const tokenRoleLabel: Record<TokenRole, string> = {
  viewer: k('common:role.viewer'),
  member: k('common:role.member'),
  admin: k('common:role.admin'),
};

/** One line per ceiling, for the form: what a token with this role can do at most (message keys: translate with `t`). */
export const tokenRoleHelp: Record<TokenRole, string> = {
  viewer: k('workspace:token.roleHelp.viewer'),
  member: k('workspace:token.roleHelp.member'),
  admin: k('workspace:token.roleHelp.admin'),
};

/** The ceilings a person may hand out: never above their own role, never owner. */
export function ceilingsFor(role: Role): TokenRole[] {
  const order: Role[] = ['viewer', 'member', 'admin', 'owner'];
  const mine = order.indexOf(role);
  return tokenRoles.filter((r) => order.indexOf(r) <= mine);
}

export type ExpiryChoice = 'never' | '30d' | '90d' | '1y';

export const expiryChoices: { id: ExpiryChoice; labelKey: string }[] = [
  { id: '30d', labelKey: k('workspace:token.expiry.days30') },
  { id: '90d', labelKey: k('workspace:token.expiry.days90') },
  { id: '1y', labelKey: k('workspace:token.expiry.year1') },
  { id: 'never', labelKey: k('workspace:token.expiry.never') },
];

export function expiryFor(choice: ExpiryChoice, now: number = Date.now()): number | undefined {
  if (choice === 'never') return undefined;
  const days = choice === '30d' ? 30 : choice === '90d' ? 90 : 365;
  return now + days * DAY;
}

/** The actions a token with this ceiling could be narrowed to: what tokens may hold and the role allows. */
export function narrowableActions(ceiling: TokenRole): Action[] {
  return tokenActions.filter((action) => can(ceiling, action));
}

const actionKeys: Record<string, string> = {
  'workspace.read': k('workspace:token.action.workspaceRead'),
  'audit.read': k('workspace:token.action.auditRead'),
  'credentials.read': k('workspace:token.action.credentialsRead'),
  'members.read': k('workspace:token.action.membersRead'),
  'repositories.read': k('workspace:token.action.repositoriesRead'),
  'repositories.write': k('workspace:token.action.repositoriesWrite'),
  'repositories.scan': k('workspace:token.action.repositoriesScan'),
  'changesets.write': k('workspace:token.action.changesetsWrite'),
  'changesets.approve': k('workspace:token.action.changesetsApprove'),
  'apps.read': k('workspace:token.action.appsRead'),
  'apps.write': k('workspace:token.action.appsWrite'),
  'apps.sync': k('workspace:token.action.appsSync'),
  'listing.read': k('workspace:token.action.listingRead'),
  'ci.dispatch': k('workspace:token.action.ciDispatch'),
  'builds.read': k('workspace:token.action.buildsRead'),
  'builds.download': k('workspace:token.action.buildsDownload'),
  'builds.share': k('workspace:token.action.buildsShare'),
  'plans.read': k('workspace:token.action.plansRead'),
  'plans.write': k('workspace:token.action.plansWrite'),
  'releases.rollout': k('workspace:token.action.releasesRollout'),
  'store.push_draft': k('workspace:token.action.storePushDraft'),
  'store.submit': k('workspace:token.action.storeSubmit'),
  'store.release': k('workspace:token.action.storeRelease'),
  'store.publish': k('workspace:token.action.storePublish'),
  'reviews.read': k('workspace:token.action.reviewsRead'),
  'reviews.sync': k('workspace:token.action.reviewsSync'),
  'reviews.triage': k('workspace:token.action.reviewsTriage'),
  'reviews.reply': k('workspace:token.action.reviewsReply'),
  'reviews.translate': k('workspace:token.action.reviewsTranslate'),
  'settings.read': k('workspace:token.action.settingsRead'),
  'settings.write': k('workspace:token.action.settingsWrite'),
  'events.read': k('workspace:token.action.eventsRead'),
  'aso.read': k('workspace:token.action.asoRead'),
  'aso.write': k('workspace:token.action.asoWrite'),
  'aso.manage': k('workspace:token.action.asoManage'),
  'ai.use': k('workspace:token.action.aiUse'),
  'ai.manage': k('workspace:token.action.aiManage'),
  'analytics.read': k('workspace:token.action.analyticsRead'),
  'analytics.manage': k('workspace:token.action.analyticsManage'),
  'alerts.read': k('workspace:token.action.alertsRead'),
  'alerts.write': k('workspace:token.action.alertsWrite'),
  'alerts.manage': k('workspace:token.action.alertsManage'),
  'monetization.write': k('workspace:token.action.monetizationWrite'),
};

/** "apps.read" as "Read apps": a label for the action picker. An action this version does not know is shown as its code. */
export function actionLabel(action: string): string {
  const key = actionKeys[action];
  return key ? t(key) : action;
}

/** True when `actionLabel` knows the action (a test keeps this list equal to the actions tokens may hold). */
export const hasActionLabel = (action: string): boolean => actionKeys[action] !== undefined;

export type TokenForm = {
  name: string;
  role: TokenRole;
  expiry: ExpiryChoice;
  /** Empty: all apps. */
  appIds: string[];
  /** Empty: everything the role allows. */
  actions: string[];
};

export type TokenFormProblems = { name?: string; actions?: string };

export function validateTokenForm(form: TokenForm): TokenFormProblems {
  const problems: TokenFormProblems = {};
  const name = form.name.trim();
  if (!name)
    problems.name = t('workspace:token.form.nameRequired');
  else if (name.length > 100) problems.name = t('workspace:token.form.nameTooLong', { count: 100 });
  const allowed = new Set<string>(narrowableActions(form.role));
  if (form.actions.some((a) => !allowed.has(a)))
    problems.actions = t('workspace:token.form.actionsNotAllowed');
  return problems;
}

export type CreateTokenInput = {
  name: string;
  role: TokenRole;
  appIds?: string[];
  actions?: string[];
  expiresAt?: number;
};

/** The request body: lists that are empty mean "no limit" and are left out. */
export function createInput(form: TokenForm, now: number = Date.now()): CreateTokenInput {
  const expiresAt = expiryFor(form.expiry, now);
  return {
    name: form.name.trim(),
    role: form.role,
    ...(form.appIds.length > 0 ? { appIds: [...new Set(form.appIds)] } : {}),
    ...(form.actions.length > 0 ? { actions: [...new Set(form.actions)] } : {}),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

export type TokenStatusView = {
  label: string;
  tone: 'ok' | 'bad' | 'warn' | 'neutral';
  title: string;
};

export function tokenStatus(token: ApiToken, now: number = Date.now()): TokenStatusView {
  if (token.status === 'revoked') {
    return {
      label: t('workspace:token.status.revoked'),
      tone: 'neutral',
      title: token.revokedAt
        ? t('workspace:token.status.revokedAt', { date: fullTime(token.revokedAt) })
        : t('workspace:token.status.revokedTitle'),
    };
  }
  if (token.status === 'expired') {
    return {
      label: t('workspace:token.status.expired'),
      tone: 'bad',
      title: token.expiresAt
        ? t('workspace:token.status.expiredAt', { date: fullTime(token.expiresAt) })
        : t('workspace:token.status.expiredTitle'),
    };
  }
  if (token.expiresAt !== null && token.expiresAt - now < 7 * DAY) {
    return {
      label: t('workspace:token.status.expiresSoon'),
      tone: 'warn',
      title: t('workspace:token.status.expiresAt', { date: fullTime(token.expiresAt) }),
    };
  }
  return { label: t('workspace:token.status.active'), tone: 'ok', title: t('workspace:token.status.activeTitle') };
}

export function lastUsed(token: ApiToken, now: number = Date.now()): string {
  return token.lastUsedAt === null ? t('workspace:token.neverUsed') : timeAgo(token.lastUsedAt, now);
}

export function expiryLabel(token: ApiToken, now: number = Date.now()): string {
  if (token.expiresAt === null) return t('workspace:token.expiry.neverShort');
  if (token.expiresAt <= now) return t('workspace:token.expiry.expiredAgo', { when: timeAgo(token.expiresAt, now) });
  const days = Math.ceil((token.expiresAt - now) / DAY);
  return days <= 1 ? t('workspace:token.expiry.underDay') : t('workspace:token.expiry.inDays', { count: days });
}

/** What the token is limited to, as a short phrase: "all apps · all actions of the role". */
export function scopeSummary(token: Pick<ApiToken, 'appIds' | 'actions'>): string {
  const apps =
    token.appIds === null
      ? t('workspace:token.scope.allApps')
      : t('workspace:token.scope.apps', { count: token.appIds.length });
  const actions =
    token.actions === null
      ? t('workspace:token.scope.allActions')
      : t('workspace:token.scope.actions', { count: token.actions.length });
  return t('workspace:token.scope.summary', { apps, actions });
}

/** A call a person can paste to check the token works. The token is never put into a URL. */
export function curlExample(origin: string, workspaceId: string, token: string): string {
  const base = origin.replace(/\/+$/, '');
  return `curl -H "Authorization: Bearer ${token}" \\\n  ${base}/api/workspaces/${workspaceId}/apps`;
}

/** Tokens that can still be used, first; then the rest. Newest first inside each. */
export function orderTokens(tokens: ApiToken[]): ApiToken[] {
  const rank = (t: ApiToken) => (t.status === 'active' ? 0 : 1);
  return [...tokens].sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt);
}
