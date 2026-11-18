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
  ],
  viewer: ['workspace.read', 'repositories.read'],
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (roles as readonly string[]).includes(value);
}

export function can(role: Role, action: Action): boolean {
  return allowed[role].includes(action);
}
