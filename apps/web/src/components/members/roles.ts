import type { Role } from '@mrm/core';

export const roleLabel: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

/** One line per role for the invite form, so a person knows what they are handing out. */
export const roleHelp: Record<Role, string> = {
  owner: 'Everything, including who else is an owner.',
  admin: 'Manages credentials and people, except owners and other admins.',
  member: 'Reads credentials and the audit log, and sees who is in the workspace.',
  viewer: 'Sees the workspace only.',
};
