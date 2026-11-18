/**
 * Workspace roles and what each may do. One table, so the API, the UI and the V2 assistant's
 * scoped tokens all ask the same question.
 */
export const roles = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof roles)[number];

export const actions = [
  'workspace.read',
  'audit.read',
  'credentials.read',
  'credentials.write',
  'members.read',
  'members.manage',
  'repositories.read',
  'repositories.write',
  'repositories.scan',
  'changesets.write',
  'changesets.approve',
  'apps.read',
  'apps.write',
  'apps.sync',
  'listing.read',
  'ci.dispatch',
  'plans.read',
  'plans.write',
  'releases.rollout',
  'reviews.read',
  'reviews.sync',
  'reviews.triage',
  'reviews.reply',
  'reviews.translate',
  'settings.read',
  'settings.write',
  'tokens.read',
  'tokens.manage',
  'webhooks.read',
  'webhooks.manage',
  'events.read',
] as const;
export type Action = (typeof actions)[number];

const allowed: Record<Role, readonly Action[]> = {
  owner: actions,
  admin: actions,
  member: [
    'workspace.read',
    'audit.read',
    'credentials.read',
    'members.read',
    'repositories.read',
    'repositories.scan',
    'changesets.write',
    'apps.read',
    'apps.sync',
    'listing.read',
    'ci.dispatch',
    'plans.read',
    'plans.write',
    'reviews.read',
    'reviews.sync',
    'reviews.triage',
    'reviews.translate',
    'settings.read',
    'events.read',
  ],
  viewer: [
    'workspace.read',
    'repositories.read',
    'apps.read',
    'listing.read',
    'plans.read',
    'reviews.read',
    'events.read',
  ],
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (roles as readonly string[]).includes(value);
}

export function can(role: Role, action: Action): boolean {
  return allowed[role].includes(action);
}

// ---------------------------------------------------------------------------------------------
// API tokens
//
// A token acts for the person who made it, so it can never do more than they can. On top of the
// role it adds three limits: a role ceiling that is never `owner`, an optional list of actions,
// and a list of things tokens may not do at all however they are made.

/** The ceilings a token can have, lowest first. Never `owner`. */
export const tokenRoles = ['viewer', 'member', 'admin'] as const;
export type TokenRole = (typeof tokenRoles)[number];

/** What no token can do: manage tokens, people or credential values, or read or change webhooks. */
export const tokenForbiddenActions: readonly Action[] = [
  'tokens.read',
  'tokens.manage',
  'members.manage',
  'credentials.write',
  'webhooks.read',
  'webhooks.manage',
];

/** The actions a token may be given, in the order of `actions`. */
export const tokenActions: readonly Action[] = actions.filter((a) => !tokenForbiddenActions.includes(a));

/**
 * Actions that change what a store shows to customers, in the organisation's name: publish a reply
 * (`reviews.reply`) or change a live rollout (`releases.rollout`: staged rollout share, halt, resume,
 * release to everyone). A token gets one only when its list of actions names it: a token with no list
 * ("everything the ceiling allows") never does, so widening an old token's role cannot start
 * answering customers or moving a rollout.
 */
export const tokenExplicitOnlyActions: readonly Action[] = ['reviews.reply', 'releases.rollout'];

export function isTokenRole(value: unknown): value is TokenRole {
  return typeof value === 'string' && (tokenRoles as readonly string[]).includes(value);
}

const rank: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** The lower of two roles: what a token with ceiling `a` held by a person with role `b` may do. */
export function lowerRole(a: Role, b: Role): Role {
  return rank[a] <= rank[b] ? a : b;
}

/**
 * Whether a token may do `action`: the role ceiling allows it (`can`), no token may ever do it
 * (`tokenForbiddenActions`), and when the token has a list of actions, it is on the list.
 * `allowlist` null means "everything the ceiling allows".
 */
export function canToken(ceiling: Role, allowlist: readonly Action[] | null, action: Action): boolean {
  if (tokenForbiddenActions.includes(action)) return false;
  if (!can(ceiling, action)) return false;
  if (allowlist === null) return !tokenExplicitOnlyActions.includes(action);
  return allowlist.includes(action);
}
