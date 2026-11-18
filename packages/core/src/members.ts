import { type Role, can, roles } from './roles.ts';

/**
 * Who may give which role to whom. Pure rules, so the API and the UI ask the same questions.
 *
 * - Only owners and admins manage members at all (the `members.manage` action).
 * - Owners may assign any role to anyone. Admins work only with people below them: they may
 *   invite and change members and viewers, never admins or owners, and may not hand out admin.
 * - Nobody invites an owner. Ownership moves only by an owner changing someone's role.
 * - A workspace always keeps at least one owner: the last owner can be neither demoted nor removed.
 *   Permission is checked first, so someone who may not touch owners at all hears 'forbidden'.
 * - Anyone may leave a workspace themselves, except the last owner.
 */

/** Roles an invitation can carry. Never `owner`. */
export const invitableRoles = ['admin', 'member', 'viewer'] as const;
export type InvitableRole = (typeof invitableRoles)[number];

export function isInvitableRole(value: unknown): value is InvitableRole {
  return typeof value === 'string' && (invitableRoles as readonly string[]).includes(value);
}

/** Roles `actor` may put on a new invitation. */
export function invitableBy(actor: Role): InvitableRole[] {
  if (!can(actor, 'members.manage')) return [];
  return actor === 'owner' ? [...invitableRoles] : ['member', 'viewer'];
}

/** Roles `actor` may assign to an existing member (the UI's role selector). */
export function assignableBy(actor: Role): Role[] {
  if (!can(actor, 'members.manage')) return [];
  return actor === 'owner' ? [...roles] : ['member', 'viewer'];
}

export type MemberDecision =
  | { ok: true }
  | { ok: false; reason: 'forbidden' | 'last_owner' };

export type RoleChange = {
  actorRole: Role;
  targetRole: Role;
  newRole: Role;
  /** How many owners the workspace has right now. */
  ownerCount: number;
};

export function decideRoleChange(change: RoleChange): MemberDecision {
  const { actorRole, targetRole, newRole, ownerCount } = change;
  if (!can(actorRole, 'members.manage')) return { ok: false, reason: 'forbidden' };
  if (actorRole !== 'owner') {
    // Admins: only members and viewers, and only to member or viewer.
    const below = (role: Role) => role === 'member' || role === 'viewer';
    if (!(below(targetRole) && below(newRole))) return { ok: false, reason: 'forbidden' };
  }
  if (targetRole === 'owner' && newRole !== 'owner' && ownerCount <= 1) {
    return { ok: false, reason: 'last_owner' };
  }
  return { ok: true };
}

export type Removal = {
  actorRole: Role;
  /** True when the person removes themselves. */
  self: boolean;
  targetRole: Role;
  ownerCount: number;
};

export function decideRemoval(removal: Removal): MemberDecision {
  const { actorRole, self, targetRole, ownerCount } = removal;
  if (!self) {
    if (!can(actorRole, 'members.manage')) return { ok: false, reason: 'forbidden' };
    if (actorRole !== 'owner' && targetRole !== 'member' && targetRole !== 'viewer') {
      return { ok: false, reason: 'forbidden' };
    }
  }
  if (targetRole === 'owner' && ownerCount <= 1) return { ok: false, reason: 'last_owner' };
  return { ok: true };
}
