import type { InvitableRole, Role } from '@mrm/core';

export type User = { id: string; email: string; displayName: string };
export type WorkspaceSummary = { id: string; name: string; role: Role };
export type AuthStatus = {
  /** Sent only by a single-user server (the desktop app). Missing means a multi-user server. */
  mode?: 'multi' | 'single_user';
  setupRequired: boolean;
  user: User | null;
};
export type Me = { user: User; workspaces: WorkspaceSummary[] };

export type CredentialSummary = {
  id: string;
  kind: string;
  label: string;
  createdAt: number;
  rotatedAt: number | null;
  /** The most recent connection test of the saved secret. Null when it was never tested. */
  lastTest?: LastTest | null;
};

export type LastTest = { at: number; ok: boolean; message: string };

/** The outcome of trying a credential against its provider. `details` lists what was checked. */
export type TestResult = { ok: boolean; message: string; details?: string[] };

export type AuditEvent = {
  id: string;
  actorType: string;
  actorId: string;
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown> | null;
  at: number;
};

export type Health = {
  status: 'ok' | 'degraded';
  version: string;
  database: { dialect: string; ok: boolean };
};

export type Member = { userId: string; email: string; displayName: string; role: Role };

export type Invitation = {
  id: string;
  email: string;
  role: InvitableRole;
  createdAt: number;
  expiresAt: number;
  createdByName: string | null;
};

/** The token is in the response to creating an invitation and nowhere else. */
export type CreatedInvitation = { invitation: Invitation; token: string };

export type InvitationPreview = {
  workspaceName: string;
  email: string;
  role: InvitableRole;
  valid: boolean;
};

export type AcceptedInvitation = { user: User; workspaceId: string; role: Role };
