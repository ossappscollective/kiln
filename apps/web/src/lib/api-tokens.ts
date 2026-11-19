import { type Action, can, type Role, type TokenRole, tokenActions, tokenRoles } from '@mrm/core';
import { fullTime, timeAgo } from './format.ts';
import type { ApiToken } from './types.ts';

const DAY = 24 * 60 * 60 * 1000;

export const tokenRoleLabel: Record<TokenRole, string> = {
  viewer: 'Viewer',
  member: 'Member',
  admin: 'Admin',
};

/** One line per ceiling, for the form: what a token with this role can do at most. */
export const tokenRoleHelp: Record<TokenRole, string> = {
  viewer: 'Reads apps, releases, listings, plans and events. Changes nothing.',
  member:
    'Also drafts change sets, syncs apps, edits plans and starts CI workflows. Cannot approve.',
  admin:
    'Also approves and applies change sets and adds apps. Still cannot manage tokens, people or secrets.',
};

/** The ceilings a person may hand out: never above their own role, never owner. */
export function ceilingsFor(role: Role): TokenRole[] {
  const order: Role[] = ['viewer', 'member', 'admin', 'owner'];
  const mine = order.indexOf(role);
  return tokenRoles.filter((r) => order.indexOf(r) <= mine);
}

export type ExpiryChoice = 'never' | '30d' | '90d' | '1y';

export const expiryChoices: { id: ExpiryChoice; label: string }[] = [
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: '1y', label: '1 year' },
  { id: 'never', label: 'Never expires' },
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

/** "apps.read" as "Read apps": a label for the action picker. */
export function actionLabel(action: string): string {
  const [area = '', verb = ''] = action.split('.');
  const noun = area.replace(/_/g, ' ');
  const verbs: Record<string, string> = {
    read: 'Read',
    write: 'Change',
    sync: 'Sync',
    scan: 'Scan',
    approve: 'Approve and apply',
    dispatch: 'Start',
  };
  const lead = verbs[verb] ?? verb.charAt(0).toUpperCase() + verb.slice(1);
  return `${lead} ${noun}`.trim();
}

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
    problems.name = 'Give the token a name, such as the script or service that will use it.';
  else if (name.length > 100) problems.name = 'Use at most 100 characters.';
  const allowed = new Set<string>(narrowableActions(form.role));
  if (form.actions.some((a) => !allowed.has(a)))
    problems.actions = 'Some chosen actions are not allowed for this role.';
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
      label: 'Revoked',
      tone: 'neutral',
      title: token.revokedAt ? `Revoked ${fullTime(token.revokedAt)}.` : 'Revoked.',
    };
  }
  if (token.status === 'expired') {
    return {
      label: 'Expired',
      tone: 'bad',
      title: token.expiresAt ? `Expired ${fullTime(token.expiresAt)}.` : 'Expired.',
    };
  }
  if (token.expiresAt !== null && token.expiresAt - now < 7 * DAY) {
    return { label: 'Expires soon', tone: 'warn', title: `Expires ${fullTime(token.expiresAt)}.` };
  }
  return { label: 'Active', tone: 'ok', title: 'The token works.' };
}

export function lastUsed(token: ApiToken, now: number = Date.now()): string {
  return token.lastUsedAt === null ? 'Never used' : timeAgo(token.lastUsedAt, now);
}

export function expiryLabel(token: ApiToken, now: number = Date.now()): string {
  if (token.expiresAt === null) return 'Never';
  if (token.expiresAt <= now) return `Expired ${timeAgo(token.expiresAt, now)}`;
  const days = Math.ceil((token.expiresAt - now) / DAY);
  return days <= 1 ? 'In under a day' : `In ${days} days`;
}

/** What the token is limited to, as a short phrase: "all apps · all actions of the role". */
export function scopeSummary(token: Pick<ApiToken, 'appIds' | 'actions'>): string {
  const apps =
    token.appIds === null
      ? 'All apps'
      : `${token.appIds.length} app${token.appIds.length === 1 ? '' : 's'}`;
  const acts =
    token.actions === null
      ? 'all actions of the role'
      : `${token.actions.length} action${token.actions.length === 1 ? '' : 's'}`;
  return `${apps} · ${acts}`;
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
