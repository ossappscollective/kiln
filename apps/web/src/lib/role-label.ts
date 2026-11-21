import type { Role } from '@kiln/core';
import { k, t } from './i18n/t.ts';

// A typed map of literal keys: the i18n check sees each key, and no key is built from a role at run time.
const keys: Record<Role, string> = {
  owner: k('common:role.owner'),
  admin: k('common:role.admin'),
  member: k('common:role.member'),
  viewer: k('common:role.viewer'),
};

/** The role's name in the active language: "Owner", "Propriétaire". */
export const roleLabel = (role: Role): string => t(keys[role]);
