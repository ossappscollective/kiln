import type {
  AcceptedInvitation,
  AuditEvent,
  AuthStatus,
  CreatedInvitation,
  CredentialSummary,
  Health,
  Invitation,
  InvitationPreview,
  Me,
  Member,
  TestResult,
  User,
} from './types.ts';

type Issue = { path: string; message: string };

export class ApiError extends Error {
  status: number;
  code: string;
  retryAfter: number | undefined;

  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** "30 seconds", "1 minute", "10 minutes": how long to wait, rounded up. */
function waitPhrase(seconds: number): string {
  if (seconds < 60) {
    const n = Math.max(1, Math.ceil(seconds));
    return `${n} second${n === 1 ? '' : 's'}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** A sentence a person can act on, for each thing the API can say. */
export function messageFor(
  status: number,
  body: { error?: string; message?: string; issues?: Issue[] },
  retryAfter?: number,
): string {
  switch (body.error) {
    case 'invalid_credentials':
      return 'The email or password is wrong.';
    case 'too_many_attempts':
      return `Too many attempts. Try again in ${waitPhrase(retryAfter ?? 60)}.`;
    case 'registration_closed':
      return 'This server already has an account. Sign in instead.';
    case 'unauthenticated':
      return 'Your session has ended. Sign in again.';
    case 'forbidden':
      return 'Your role does not allow that.';
    case 'not_found':
      return 'That no longer exists.';
    case 'bad_origin':
      return 'The request was blocked because it came from another site.';
    case 'last_owner':
      return body.message ?? 'A workspace needs at least one owner.';
    case 'already_member':
      return 'That person is already a member of this workspace.';
    case 'already_invited':
      return 'That address already has a pending invitation. Revoke it to send a new one.';
    case 'email_mismatch':
      return 'This invitation is for a different email address than the one you are signed in with.';
    case 'account_exists':
      return 'An account with this email already exists. Sign in with it, then open the link again.';
    case 'disabled_in_single_user_mode':
      return 'This is not available in single-user mode.';
    case 'invalid_secret':
      return body.message ?? 'That secret is not valid.';
    case 'invalid_request': {
      const first = body.issues?.[0];
      return first ? `${first.path ? `${first.path}: ` : ''}${first.message}` : 'Check the form and try again.';
    }
  }
  if (status === 429) return `Too many requests. Try again in ${waitPhrase(retryAfter ?? 60)}.`;
  return status >= 500 ? 'The server had a problem. Try again.' : `The request failed (${status}).`;
}

export type ApiOptions = {
  fetch?: typeof fetch;
  /** Called when a request other than sign-in answers 401, so the app can show the sign-in page. */
  onUnauthenticated?: () => void;
};

export function createApi(options: ApiOptions = {}) {
  const send = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await send(path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, 'network', 'Cannot reach the server. Check that it is running.');
    }
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }

    if (!response.ok) {
      const parsed = (data && typeof data === 'object' ? data : {}) as {
        error?: string;
        message?: string;
        issues?: Issue[];
      };
      const retryHeader = Number(response.headers.get('retry-after'));
      const retryAfter = Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : undefined;
      if (response.status === 401 && !path.startsWith('/api/auth/')) options.onUnauthenticated?.();
      throw new ApiError(
        response.status,
        parsed.error ?? 'error',
        messageFor(response.status, parsed, retryAfter),
        retryAfter,
      );
    }
    return data as T;
  }

  const workspace = (id: string) => `/api/workspaces/${encodeURIComponent(id)}`;

  return {
    health: () => request<Health>('GET', '/api/health'),
    status: () => request<AuthStatus>('GET', '/api/auth/status'),
    register: (input: { email: string; displayName: string; password: string; workspaceName: string }) =>
      request<{ user: User; workspaceId: string }>('POST', '/api/auth/register', input),
    login: (input: { email: string; password: string }) =>
      request<{ user: User }>('POST', '/api/auth/login', input),
    logout: () => request<void>('POST', '/api/auth/logout'),
    me: () => request<Me>('GET', '/api/me'),
    credentials: (workspaceId: string) =>
      request<{ credentials: CredentialSummary[] }>('GET', `${workspace(workspaceId)}/credentials`),
    addCredential: (workspaceId: string, input: { kind: string; label: string; secret: string }) =>
      request<{ credential: CredentialSummary }>('POST', `${workspace(workspaceId)}/credentials`, input),
    replaceSecret: (workspaceId: string, id: string, secret: string) =>
      request<void>('PUT', `${workspace(workspaceId)}/credentials/${encodeURIComponent(id)}`, { secret }),
    deleteCredential: (workspaceId: string, id: string) =>
      request<void>('DELETE', `${workspace(workspaceId)}/credentials/${encodeURIComponent(id)}`),
    /** Tries a secret against the provider without saving it. */
    testSecret: (workspaceId: string, input: { kind: string; secret: string }) =>
      request<TestResult>('POST', `${workspace(workspaceId)}/credentials/test`, input),
    /** Tries a saved credential and records the outcome on it. */
    testCredential: (workspaceId: string, id: string) =>
      request<TestResult>('POST', `${workspace(workspaceId)}/credentials/${encodeURIComponent(id)}/test`),
    members: (workspaceId: string) =>
      request<{ members: Member[] }>('GET', `${workspace(workspaceId)}/members`),
    changeRole: (workspaceId: string, userId: string, role: string) =>
      request<void>('PATCH', `${workspace(workspaceId)}/members/${encodeURIComponent(userId)}`, { role }),
    removeMember: (workspaceId: string, userId: string) =>
      request<void>('DELETE', `${workspace(workspaceId)}/members/${encodeURIComponent(userId)}`),
    invitations: (workspaceId: string) =>
      request<{ invitations: Invitation[] }>('GET', `${workspace(workspaceId)}/invitations`),
    createInvitation: (workspaceId: string, input: { email: string; role: string }) =>
      request<CreatedInvitation>('POST', `${workspace(workspaceId)}/invitations`, input),
    revokeInvitation: (workspaceId: string, id: string) =>
      request<void>('DELETE', `${workspace(workspaceId)}/invitations/${encodeURIComponent(id)}`),
    invitation: (token: string) =>
      request<InvitationPreview>('GET', `/api/invitations/${encodeURIComponent(token)}`),
    acceptInvitation: (token: string, input: { displayName?: string; password?: string } = {}) =>
      request<AcceptedInvitation>('POST', `/api/invitations/${encodeURIComponent(token)}/accept`, input),
    audit: (workspaceId: string, limit = 100) =>
      request<{ events: AuditEvent[] }>('GET', `${workspace(workspaceId)}/audit?limit=${limit}`),
  };
}

export type Api = ReturnType<typeof createApi>;
