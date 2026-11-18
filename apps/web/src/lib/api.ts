import type { Listing, ListingProblem } from '@mrm/core';
import type {
  AcceptedInvitation,
  AppDetail,
  AppSummary,
  AuditEvent,
  AuthStatus,
  ChangeSetView,
  CreatedInvitation,
  CredentialSummary,
  DiscoverResult,
  Health,
  ImportItem,
  ImportResult,
  Invitation,
  InvitationPreview,
  ListingSelection,
  ListingTargetInput,
  Me,
  Member,
  NewApp,
  RepositoryDetail,
  RepositoryListing,
  RepositorySummary,
  SavedListingTarget,
  SyncResult,
  TestResult,
  User,
} from './types.ts';

type Issue = { path: string; message: string };

export class ApiError extends Error {
  status: number;
  code: string;
  retryAfter: number | undefined;
  /** The JSON body of the error response, for screens that need more than the message. */
  body: Record<string, unknown>;

  constructor(status: number, code: string, message: string, retryAfter?: number, body: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.body = body;
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
  body: { error?: string; message?: string; issues?: Issue[]; paths?: string[] },
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
    case 'credential_not_found':
      return 'That credential no longer exists. Pick another one.';
    case 'credential_kind':
      return 'Only a GitHub App or a GitHub token can be used for a repository.';
    case 'github_auth':
      return body.message ?? 'GitHub did not accept the credential.';
    case 'github_forbidden':
      return body.message ?? 'The credential does not have access to that repository.';
    case 'github_not_found':
      return body.message ?? 'GitHub cannot find that repository with this credential.';
    case 'github_invalid':
      return body.message ?? 'GitHub refused the change.';
    case 'github_unavailable':
      return body.message ?? 'GitHub could not be reached. Try again in a moment.';
    case 'timeout':
      return 'GitHub took too long to answer. Try again.';
    case 'already_connected':
      return 'That repository is already connected to this workspace.';
    case 'open_change_sets':
      return 'This repository has open change sets. Apply or discard them first.';
    case 'invalid_state':
      return 'That change set is no longer in a state that allows this. Reload and check its status.';
    case 'no_changes':
      return 'Nothing differs from what is already in the repository.';
    case 'store_config_invalid':
      return body.message ?? 'The Expo store.config.json cannot be read, so the App Store listing cannot be changed.';
    case 'apply_in_progress':
      return 'This change set is being applied right now. Check back in a moment.';
    case 'branch_exists':
    case 'default_branch':
      return body.message ?? 'The branch for this change set could not be used.';
    case 'change_conflict': {
      const files = body.paths?.length ? ` Changed files: ${body.paths.join(', ')}.` : '';
      return `${body.message ?? 'Files changed in the repository after this draft was made.'}${files} Discard this change set and create a new one.`;
    }
    case 'pull_request_failed':
      return body.message ?? 'The branch was created but the pull request could not be opened.';
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
        paths?: string[];
      };
      const retryHeader = Number(response.headers.get('retry-after'));
      const retryAfter = Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : undefined;
      if (response.status === 401 && !path.startsWith('/api/auth/')) options.onUnauthenticated?.();
      throw new ApiError(
        response.status,
        parsed.error ?? 'error',
        messageFor(response.status, parsed, retryAfter),
        retryAfter,
        parsed,
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
    repositories: (workspaceId: string) =>
      request<{ repositories: RepositorySummary[] }>('GET', `${workspace(workspaceId)}/repositories`),
    repository: (workspaceId: string, id: string) =>
      request<RepositoryDetail>('GET', `${workspace(workspaceId)}/repositories/${encodeURIComponent(id)}`),
    connectRepository: (workspaceId: string, input: { credentialId: string; owner: string; repo: string }) =>
      request<{ repository: RepositorySummary }>('POST', `${workspace(workspaceId)}/repositories`, input),
    disconnectRepository: (workspaceId: string, id: string) =>
      request<void>('DELETE', `${workspace(workspaceId)}/repositories/${encodeURIComponent(id)}`),
    /** Lists the repository's files, detects the project type and stores the result. */
    scanRepository: (workspaceId: string, id: string) =>
      request<RepositoryDetail>('POST', `${workspace(workspaceId)}/repositories/${encodeURIComponent(id)}/scan`),
    repositoryListing: (workspaceId: string, id: string, selection: ListingSelection = {}) => {
      const query = new URLSearchParams();
      if (selection.target) query.set('target', selection.target);
      if (selection.roots?.appStore !== undefined) query.set('appStoreRoot', selection.roots.appStore);
      if (selection.roots?.googlePlay !== undefined) query.set('googlePlayRoot', selection.roots.googlePlay);
      const text = query.toString();
      return request<RepositoryListing>(
        'GET',
        `${workspace(workspaceId)}/repositories/${encodeURIComponent(id)}/listing${text ? `?${text}` : ''}`,
      );
    },
    listingTargets: (workspaceId: string, repositoryId: string) =>
      request<{ targets: SavedListingTarget[] }>(
        'GET',
        `${workspace(workspaceId)}/repositories/${encodeURIComponent(repositoryId)}/listing-targets`,
      ),
    createListingTarget: (workspaceId: string, repositoryId: string, input: ListingTargetInput) =>
      request<{ target: SavedListingTarget }>(
        'POST',
        `${workspace(workspaceId)}/repositories/${encodeURIComponent(repositoryId)}/listing-targets`,
        input,
      ),
    updateListingTarget: (workspaceId: string, repositoryId: string, id: string, input: Partial<ListingTargetInput>) =>
      request<{ target: SavedListingTarget }>(
        'PATCH',
        `${workspace(workspaceId)}/repositories/${encodeURIComponent(repositoryId)}/listing-targets/${encodeURIComponent(id)}`,
        input,
      ),
    deleteListingTarget: (workspaceId: string, repositoryId: string, id: string) =>
      request<void>(
        'DELETE',
        `${workspace(workspaceId)}/repositories/${encodeURIComponent(repositoryId)}/listing-targets/${encodeURIComponent(id)}`,
      ),
    createChangeSet: (
      workspaceId: string,
      repositoryId: string,
      input: { summary: string; listing: Listing } & ListingSelection,
    ) =>
      request<{ changeSet: ChangeSetView; problems: ListingProblem[]; warnings?: string[] }>(
        'POST',
        `${workspace(workspaceId)}/repositories/${encodeURIComponent(repositoryId)}/change-sets`,
        input,
      ),
    changeSets: (workspaceId: string, filter: { repositoryId?: string; status?: string } = {}) => {
      const query = new URLSearchParams();
      if (filter.repositoryId) query.set('repositoryId', filter.repositoryId);
      if (filter.status) query.set('status', filter.status);
      const text = query.toString();
      const suffix = text ? `?${text}` : '';
      return request<{ changeSets: ChangeSetView[] }>('GET', `${workspace(workspaceId)}/change-sets${suffix}`);
    },
    changeSet: (workspaceId: string, id: string) =>
      request<{ changeSet: ChangeSetView }>('GET', `${workspace(workspaceId)}/change-sets/${encodeURIComponent(id)}`),
    approveChangeSet: (workspaceId: string, id: string) =>
      request<{ changeSet: ChangeSetView }>(
        'POST',
        `${workspace(workspaceId)}/change-sets/${encodeURIComponent(id)}/approve`,
      ),
    applyChangeSet: (workspaceId: string, id: string) =>
      request<{ changeSet: ChangeSetView; alreadyApplied?: boolean }>(
        'POST',
        `${workspace(workspaceId)}/change-sets/${encodeURIComponent(id)}/apply`,
      ),
    discardChangeSet: (workspaceId: string, id: string) =>
      request<{ changeSet: ChangeSetView }>(
        'POST',
        `${workspace(workspaceId)}/change-sets/${encodeURIComponent(id)}/discard`,
      ),
    apps: (workspaceId: string) => request<{ apps: AppSummary[] }>('GET', `${workspace(workspaceId)}/apps`),
    app: (workspaceId: string, id: string) =>
      request<AppDetail>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(id)}`),
    createApp: (workspaceId: string, input: NewApp) =>
      request<{ app: AppSummary }>('POST', `${workspace(workspaceId)}/apps`, input),
    deleteApp: (workspaceId: string, id: string) =>
      request<void>('DELETE', `${workspace(workspaceId)}/apps/${encodeURIComponent(id)}`),
    /** Reads the store with the app's credential and replaces the stored snapshot. Can take seconds. */
    syncApp: (workspaceId: string, id: string) =>
      request<SyncResult>('POST', `${workspace(workspaceId)}/apps/${encodeURIComponent(id)}/sync`),
    /** Finds the apps behind a credential. Google Play needs `packages`: its API cannot list apps. */
    discoverApps: (workspaceId: string, input: { credentialId: string; packages?: string[] }) =>
      request<DiscoverResult>('POST', `${workspace(workspaceId)}/apps/discover`, input),
    /** Adds the chosen apps in one transaction. Apps that exist are skipped; the answer is per item. */
    importApps: (workspaceId: string, input: { credentialId: string; items: ImportItem[] }) =>
      request<ImportResult>('POST', `${workspace(workspaceId)}/apps/import`, input),
    audit: (workspaceId: string, limit = 100) =>
      request<{ events: AuditEvent[] }>('GET', `${workspace(workspaceId)}/audit?limit=${limit}`),
  };
}

export type Api = ReturnType<typeof createApi>;
