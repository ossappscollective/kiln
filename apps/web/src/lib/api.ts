import type { Listing, ListingProblem } from '@mrm/core';
import type { ApplyBody } from './change-set-apply.ts';
import type { RefreshResult, Resolution, Staleness } from './change-set-refresh.ts';
import type { CloneReport, PurgeResult, RepositoryClone } from './clone-upkeep.ts';
import type { Review, ReviewSyncOutcome, ReviewsPage, ReviewsSummary, TriageBody } from './reviews.ts';
import type {
  AcceptedInvitation,
  ApiToken,
  AppBuild,
  AppBuilds,
  AppDetail,
  AppSummary,
  AuditEvent,
  AuthStatus,
  BuildChanges,
  BuildConventionsView,
  ChangeSetView,
  CreatedApiToken,
  CreatedInvitation,
  CreatedWebhook,
  ChecklistTemplate,
  CiWorkflow,
  CredentialSummary,
  DiscoverResult,
  DispatchResult,
  Health,
  ImportItem,
  ImportResult,
  Invitation,
  InvitationPreview,
  ListingDrift,
  ListingHistoryPage,
  ListingSelection,
  ListingTargetInput,
  LiveListing,
  LocalCheck,
  LocalConfig,
  Me,
  Member,
  NewApp,
  NewPlan,
  PlanChanges,
  PlanDetail,
  PlanSummary,
  RematchedBuilds,
  RolloutBody,
  RolloutView,
  PullRequestBody,
  PullResult,
  RepositoryDetail,
  RepositoryListing,
  RepositoryTags,
  RepoRefreshResult,
  RepositorySummary,
  SavedListingTarget,
  SyncResult,
  TestResult,
  User,
  WebhookDelivery,
  WebhookEndpoint,
  WorkflowInputs,
  WorkflowRun,
  WorkflowRuns,
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
  // Local clones: the server's messages are written to be shown (they name MRM_LOCAL_REPO_ROOTS, the
  // folder rule or the fix), so they are used as they are.
  if (body.error?.startsWith('local_') && body.message) return body.message;
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
    case 'role_above_yours':
      return body.message ?? 'A token cannot have a higher role than you.';
    case 'too_many_tokens':
      return body.message ?? 'There are too many active tokens. Revoke some you no longer use.';
    case 'too_many_webhooks':
      return body.message ?? 'There are too many webhooks. Delete some you no longer use.';
    case 'invalid_url':
      return body.message ?? 'That address cannot be used for a webhook.';
    case 'unknown_app':
      return body.message ?? 'One of the apps is not in this workspace.';
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
      // A folder that is already connected says so in the server's words (it names the repository).
      return body.message?.startsWith('That folder') ? body.message : 'That repository is already connected to this workspace.';
    case 'remote_mismatch':
    case 'path_in_use':
    case 'no_local_checkout':
      return body.message ?? 'That local clone cannot be used here.';
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
      return `${body.message ?? 'Files changed in the repository after this draft was made.'}${files} Refresh the change set to re-base it onto the repository. Discard this change set and create a new one if you would rather start over.`;
    }
    case 'base_changed': {
      const files = body.paths?.length ? ` Changed files: ${body.paths.join(', ')}.` : '';
      return `The files changed in the local clone after this change set was made.${files} Nothing was written. Refresh the change set to re-base it, or discard it.`;
    }
    case 'refresh_conflicts':
      return body.message ?? 'Some files changed in the repository in the same place. Choose for each file.';
    case 'nothing_to_apply':
      return 'Nothing left to apply: the repository already has this change. Discard the change set.';
    case 'branch_created':
      return body.message ?? 'A branch was already created for this change set, so it cannot be refreshed. Discard it and create a new one.';
    case 'changed_meanwhile':
      return 'The change set was changed by someone else while it was being refreshed. Reload and try again.';
    case 'unknown_path':
      return 'A choice names a file that is not in this change set. Reload and try again.';
    case 'clone_busy':
      return body.message ?? 'The repository is being read right now. Try again in a moment.';
    case 'pull_request_failed':
      return body.message ?? 'The branch was created but the pull request could not be opened.';
    case 'no_repository':
      return body.message ?? 'This app is not linked to a repository.';
    case 'ci_unsupported':
      return 'This repository connection cannot read CI runs.';
    case 'workflow_not_found':
      return body.message ?? 'GitHub has no such workflow in this repository.';
    case 'app_not_found':
      return 'That app is not in this workspace.';
    case 'app_repository_mismatch':
      return 'That app is not linked to this repository.';
    case 'build_not_found':
      return body.message ?? 'This app has no such build. Sync the app first.';
    case 'build_not_linked':
      return body.message ?? 'This build is not linked to a CI run, so its commit is not known.';
    case 'no_base_build':
      return 'There is no earlier linked build to compare with.';
    case 'run_not_found':
      return body.message ?? 'GitHub has no such workflow run in this repository.';
    case 'run_without_commit':
      return 'That run has no commit, so it cannot explain a build.';
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
  const planPath = (workspaceId: string, appId: string, planId: string) =>
    `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/plans/${encodeURIComponent(planId)}`;

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
    // Local clones (docs/adr/0005-local-clone-reads.md). Admin and owner only, except `localConfig`.
    localConfig: (workspaceId: string) =>
      request<{ local: LocalConfig }>('GET', `${workspace(workspaceId)}/repositories/local/config`),
    checkLocalClone: (workspaceId: string, input: { path: string; branch?: string }) =>
      request<{ check: LocalCheck }>('POST', `${workspace(workspaceId)}/repositories/local/check`, input),
    connectLocalRepository: (workspaceId: string, input: { path: string; branch?: string; name?: string }) =>
      request<{ repository: RepositorySummary }>('POST', `${workspace(workspaceId)}/repositories/local`, input),
    attachLocalClone: (
      workspaceId: string,
      id: string,
      input: { path?: string; branch?: string; allowRemoteMismatch?: boolean },
    ) =>
      request<{ repository: RepositorySummary }>(
        'PUT',
        `${workspace(workspaceId)}/repositories/${encodeURIComponent(id)}/local`,
        input,
      ),
    detachLocalClone: (workspaceId: string, id: string) =>
      request<{ repository: RepositorySummary }>(
        'DELETE',
        `${workspace(workspaceId)}/repositories/${encodeURIComponent(id)}/local`,
      ),
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
    /** No body opens a pull request on GitHub; `{ mode: 'local_branch', … }` commits to a new branch of the local clone. */
    applyChangeSet: (workspaceId: string, id: string, body?: ApplyBody) =>
      request<{ changeSet: ChangeSetView; alreadyApplied?: boolean }>(
        'POST',
        `${workspace(workspaceId)}/change-sets/${encodeURIComponent(id)}/apply`,
        body,
      ),
    /** Pushes the branch of a commit made in the local clone, and with `openPr` opens the pull request. Safe to repeat. */
    pushChangeSet: (workspaceId: string, id: string, body: { openPr?: boolean } = {}) =>
      request<{ changeSet: ChangeSetView; alreadyDone?: boolean }>(
        'POST',
        `${workspace(workspaceId)}/change-sets/${encodeURIComponent(id)}/push`,
        body,
      ),
    /** Cheap and read only: is the change set still what the repository holds? */
    changeSetStaleness: (workspaceId: string, id: string) =>
      request<Staleness>('GET', `${workspace(workspaceId)}/change-sets/${encodeURIComponent(id)}/staleness`),
    /**
     * Re-bases a stale change set onto the repository. A conflict is a 409 `refresh_conflicts` (the
     * ApiError's body has the files and their three texts); send `resolutions` per conflicting path.
     */
    refreshChangeSet: (workspaceId: string, id: string, body?: { resolutions?: Record<string, Resolution> }) =>
      request<RefreshResult>('POST', `${workspace(workspaceId)}/change-sets/${encodeURIComponent(id)}/refresh`, body),
    /** The managed clone of one repository: size and last use. */
    repositoryClone: (workspaceId: string, id: string) =>
      request<RepositoryClone>('GET', `${workspace(workspaceId)}/repositories/${encodeURIComponent(id)}/clone`),
    /** Admin and owner: the clones of the workspace. */
    clones: (workspaceId: string) => request<CloneReport>('GET', `${workspace(workspaceId)}/clones`),
    /** Admin and owner: removes the clone now (a cache; the next read fetches it again). */
    purgeRepositoryClone: (workspaceId: string, id: string) =>
      request<PurgeResult>('POST', `${workspace(workspaceId)}/repositories/${encodeURIComponent(id)}/clone/purge`),
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
    // Store listing of an app: values from the last syncs, drift against the repository, history.
    // All reads of our own database; only `refreshAppRepoListing` reads GitHub. Nothing writes to a store.
    appListingLive: (workspaceId: string, appId: string) =>
      request<LiveListing>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/listing/live`),
    appListingDrift: (workspaceId: string, appId: string) =>
      request<ListingDrift>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/listing/drift`),
    appListingHistory: (
      workspaceId: string,
      appId: string,
      filter: { locale?: string; field?: string; cursor?: string; limit?: number } = {},
    ) => {
      const query = new URLSearchParams();
      if (filter.locale) query.set('locale', filter.locale);
      if (filter.field) query.set('field', filter.field);
      if (filter.cursor) query.set('cursor', filter.cursor);
      if (filter.limit) query.set('limit', String(filter.limit));
      const text = query.toString();
      return request<ListingHistoryPage>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/listing/history${text ? `?${text}` : ''}`,
      );
    },
    /** Reads the linked repository's listing from GitHub and records it. Needs a linked repository. */
    refreshAppRepoListing: (workspaceId: string, appId: string) =>
      request<RepoRefreshResult>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/listing/repo-refresh`,
      ),
    /**
     * Drafts a change set that applies the live store listing to the repository's listing files.
     * Reads the repository (and the store, with `refresh`); writes only a draft. 201 with the draft,
     * or 200 with `changeSet: null` and an explanation when nothing can be pulled.
     */
    pullAppListing: (workspaceId: string, appId: string, input: PullRequestBody = {}) =>
      request<PullResult>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/listing/pull`,
        input,
      ),
    /** Finds the apps behind a credential. Google Play needs `packages`: its API cannot list apps. */
    discoverApps: (workspaceId: string, input: { credentialId: string; packages?: string[] }) =>
      request<DiscoverResult>('POST', `${workspace(workspaceId)}/apps/discover`, input),
    /** Adds the chosen apps in one transaction. Apps that exist are skipped; the answer is per item. */
    importApps: (workspaceId: string, input: { credentialId: string; items: ImportItem[] }) =>
      request<ImportResult>('POST', `${workspace(workspaceId)}/apps/import`, input),
    // Release planning: our own checklists, notes and deadlines (docs/api/plans.md).
    plans: (workspaceId: string) => request<{ plans: PlanSummary[] }>('GET', `${workspace(workspaceId)}/plans`),
    appPlans: (workspaceId: string, appId: string) =>
      request<{ plans: PlanSummary[] }>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/plans`),
    plan: (workspaceId: string, appId: string, planId: string) =>
      request<{ plan: PlanDetail }>('GET', `${planPath(workspaceId, appId, planId)}`),
    createPlan: (workspaceId: string, appId: string, input: NewPlan) =>
      request<{ plan: PlanDetail }>('POST', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/plans`, input),
    updatePlan: (workspaceId: string, appId: string, planId: string, changes: PlanChanges) =>
      request<{ plan: PlanDetail }>('PATCH', planPath(workspaceId, appId, planId), changes),
    deletePlan: (workspaceId: string, appId: string, planId: string) =>
      request<void>('DELETE', planPath(workspaceId, appId, planId)),
    addChecklistItem: (workspaceId: string, appId: string, planId: string, input: { text: string; required: boolean }) =>
      request<{ plan: PlanDetail; itemId: string }>('POST', `${planPath(workspaceId, appId, planId)}/items`, input),
    updateChecklistItem: (
      workspaceId: string,
      appId: string,
      planId: string,
      itemId: string,
      changes: { text?: string; required?: boolean; done?: boolean },
    ) =>
      request<{ plan: PlanDetail }>('PATCH', `${planPath(workspaceId, appId, planId)}/items/${encodeURIComponent(itemId)}`, changes),
    deleteChecklistItem: (workspaceId: string, appId: string, planId: string, itemId: string) =>
      request<{ plan: PlanDetail }>('DELETE', `${planPath(workspaceId, appId, planId)}/items/${encodeURIComponent(itemId)}`),
    reorderChecklist: (workspaceId: string, appId: string, planId: string, order: string[]) =>
      request<{ plan: PlanDetail }>('PUT', `${planPath(workspaceId, appId, planId)}/items/order`, { order }),
    applyChecklistTemplate: (workspaceId: string, appId: string, planId: string, templateId: string) =>
      request<{ plan: PlanDetail; added: number; skipped: number }>('POST', `${planPath(workspaceId, appId, planId)}/apply-template`, {
        templateId,
      }),
    setReleaseNotes: (workspaceId: string, appId: string, planId: string, locale: string, text: string) =>
      request<{ plan: PlanDetail }>('PUT', `${planPath(workspaceId, appId, planId)}/notes/${encodeURIComponent(locale)}`, { text }),
    deleteReleaseNotes: (workspaceId: string, appId: string, planId: string, locale: string) =>
      request<{ plan: PlanDetail }>('DELETE', `${planPath(workspaceId, appId, planId)}/notes/${encodeURIComponent(locale)}`),
    // Staged rollout steps of a plan: planning data only, nothing reaches a store (docs/api/plans.md).
    rollout: (workspaceId: string, appId: string, planId: string) =>
      request<{ rollout: RolloutView }>('GET', `${planPath(workspaceId, appId, planId)}/rollout`),
    setRollout: (workspaceId: string, appId: string, planId: string, body: RolloutBody) =>
      request<{ rollout: RolloutView }>('PUT', `${planPath(workspaceId, appId, planId)}/rollout`, body),
    clearRollout: (workspaceId: string, appId: string, planId: string) =>
      request<{ rollout: RolloutView }>('DELETE', `${planPath(workspaceId, appId, planId)}/rollout`),
    rolloutStep: (
      workspaceId: string,
      appId: string,
      planId: string,
      stepId: string,
      action: 'complete' | 'skip' | 'reopen',
      options: { fromStore?: boolean } = {},
    ) =>
      request<{ rollout: RolloutView }>(
        'POST',
        `${planPath(workspaceId, appId, planId)}/rollout/steps/${encodeURIComponent(stepId)}/${action}`,
        action === 'complete' && options.fromStore ? { fromStore: true } : {},
      ),
    checklistTemplates: (workspaceId: string) =>
      request<{ templates: ChecklistTemplate[] }>('GET', `${workspace(workspaceId)}/checklist-templates`),
    createChecklistTemplate: (workspaceId: string, input: { name: string; items: { text: string; required: boolean }[] }) =>
      request<{ template: ChecklistTemplate }>('POST', `${workspace(workspaceId)}/checklist-templates`, input),
    deleteChecklistTemplate: (workspaceId: string, id: string) =>
      request<void>('DELETE', `${workspace(workspaceId)}/checklist-templates/${encodeURIComponent(id)}`),
    // CI (docs/api/ci.md). Reading stored runs and builds is open to every member; the calls that
    // ask GitHub need the right of a scan, and dispatching a workflow needs `ci.dispatch`.
    workflows: (workspaceId: string, repositoryId: string) =>
      request<{ workflows: CiWorkflow[]; cached: boolean }>(
        'GET',
        `${workspace(workspaceId)}/repositories/${encodeURIComponent(repositoryId)}/workflows`,
      ),
    workflowInputs: (workspaceId: string, repositoryId: string, workflow: string, ref?: string) =>
      request<WorkflowInputs>(
        'GET',
        `${workspace(workspaceId)}/repositories/${encodeURIComponent(repositoryId)}/workflows/${encodeURIComponent(workflow)}/inputs${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`,
      ),
    /** The stored runs; `refresh` reads GitHub first (needs the right of a scan). */
    workflowRuns: (
      workspaceId: string,
      repositoryId: string,
      options: { refresh?: boolean; limit?: number; workflow?: string; appId?: string } = {},
    ) => {
      const query = new URLSearchParams();
      if (options.refresh) query.set('refresh', 'true');
      if (options.limit) query.set('limit', String(options.limit));
      if (options.workflow) query.set('workflow', options.workflow);
      if (options.appId) query.set('appId', options.appId);
      const text = query.toString();
      return request<WorkflowRuns>(
        'GET',
        `${workspace(workspaceId)}/repositories/${encodeURIComponent(repositoryId)}/workflows/runs${text ? `?${text}` : ''}`,
      );
    },
    workflowRun: (workspaceId: string, repositoryId: string, runId: string) =>
      request<{ run: WorkflowRun }>(
        'GET',
        `${workspace(workspaceId)}/repositories/${encodeURIComponent(repositoryId)}/workflows/runs/${encodeURIComponent(runId)}`,
      ),
    /** Starts the workflow on GitHub: this runs the team's CI. */
    dispatchWorkflow: (
      workspaceId: string,
      repositoryId: string,
      workflow: string,
      input: { ref?: string; inputs?: Record<string, string>; appId?: string },
    ) =>
      request<DispatchResult>(
        'POST',
        `${workspace(workspaceId)}/repositories/${encodeURIComponent(repositoryId)}/workflows/${encodeURIComponent(workflow)}/dispatches`,
        input,
      ),
    appBuilds: (workspaceId: string, appId: string) =>
      request<AppBuilds>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/builds`),
    /** The commits between a build and the one before it (or `base`). Reads GitHub. */
    buildChanges: (workspaceId: string, appId: string, build: { platform: string; buildNumber: string; base?: string }) => {
      const query = new URLSearchParams({ platform: build.platform, build: build.buildNumber });
      if (build.base) query.set('base', build.base);
      return request<BuildChanges>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/builds/changes?${query.toString()}`,
      );
    },
    linkBuild: (workspaceId: string, appId: string, build: { platform: string; buildNumber: string }, runId: string) =>
      request<{ build: AppBuild }>(
        'PUT',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/builds/${encodeURIComponent(build.platform)}/${encodeURIComponent(build.buildNumber)}/link`,
        { runId },
      ),
    /** Reads the runs, tags and releases from GitHub again and matches this app's builds. Needs the right of a scan. */
    rematchBuilds: (workspaceId: string, appId: string) =>
      request<RematchedBuilds>('POST', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/builds/rematch`),
    /** How the repository's tags carry build numbers: the stored patterns and the defaults. */
    buildConventions: (workspaceId: string, repositoryId: string, appId?: string) =>
      request<BuildConventionsView>(
        'GET',
        `${workspace(workspaceId)}/repositories/${encodeURIComponent(repositoryId)}/build-conventions${appId ? `?appId=${encodeURIComponent(appId)}` : ''}`,
      ),
    /** Saves the conventions of the repository, or of `appId` as an override. Needs `repositories.write`. */
    setBuildConventions: (
      workspaceId: string,
      repositoryId: string,
      input: { appId?: string; tagPatterns: string[]; releasePatterns: string[]; prefix: string; workflow: string | null },
    ) =>
      request<BuildConventionsView>(
        'PUT',
        `${workspace(workspaceId)}/repositories/${encodeURIComponent(repositoryId)}/build-conventions`,
        input,
      ),
    /** The repository's tag and release names, read from GitHub (cached for a minute). Needs the right of a scan. */
    conventionTags: (workspaceId: string, repositoryId: string) =>
      request<RepositoryTags>(
        'GET',
        `${workspace(workspaceId)}/repositories/${encodeURIComponent(repositoryId)}/build-conventions/tags`,
      ),
    unlinkBuild: (workspaceId: string, appId: string, build: { platform: string; buildNumber: string }) =>
      request<{ build: AppBuild | null }>(
        'DELETE',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/builds/${encodeURIComponent(build.platform)}/${encodeURIComponent(build.buildNumber)}/link`,
      ),
    audit: (workspaceId: string, limit = 100) =>
      request<{ events: AuditEvent[] }>('GET', `${workspace(workspaceId)}/audit?limit=${limit}`),
    // API tokens. The token is in the answer to `createApiToken` and nowhere else.
    apiTokens: (workspaceId: string) =>
      request<{ tokens: ApiToken[] }>('GET', `${workspace(workspaceId)}/tokens`),
    createApiToken: (
      workspaceId: string,
      input: { name: string; role: string; appIds?: string[]; actions?: string[]; expiresAt?: number },
    ) => request<CreatedApiToken>('POST', `${workspace(workspaceId)}/tokens`, input),
    revokeApiToken: (workspaceId: string, id: string) =>
      request<void>('DELETE', `${workspace(workspaceId)}/tokens/${encodeURIComponent(id)}`),
    // Webhooks. The secret is in the answers to `createWebhook` and `rotateWebhookSecret` only.
    webhooks: (workspaceId: string) =>
      request<{ webhooks: WebhookEndpoint[] }>('GET', `${workspace(workspaceId)}/webhooks`),
    createWebhook: (
      workspaceId: string,
      input: { url: string; description?: string; eventTypes: string[]; enabled?: boolean },
    ) => request<CreatedWebhook>('POST', `${workspace(workspaceId)}/webhooks`, input),
    updateWebhook: (workspaceId: string, id: string, patch: Record<string, unknown>) =>
      request<{ webhook: WebhookEndpoint }>('PATCH', `${workspace(workspaceId)}/webhooks/${encodeURIComponent(id)}`, patch),
    deleteWebhook: (workspaceId: string, id: string) =>
      request<void>('DELETE', `${workspace(workspaceId)}/webhooks/${encodeURIComponent(id)}`),
    rotateWebhookSecret: (workspaceId: string, id: string) =>
      request<{ secret: string }>('POST', `${workspace(workspaceId)}/webhooks/${encodeURIComponent(id)}/rotate-secret`),
    testWebhook: (workspaceId: string, id: string) =>
      request<{ deliveryId: string }>('POST', `${workspace(workspaceId)}/webhooks/${encodeURIComponent(id)}/test`),
    webhookDeliveries: (workspaceId: string, id: string, limit = 30) =>
      request<{ deliveries: WebhookDelivery[] }>(
        'GET',
        `${workspace(workspaceId)}/webhooks/${encodeURIComponent(id)}/deliveries?limit=${limit}`,
      ),
    redeliverWebhook: (workspaceId: string, id: string, deliveryId: string) =>
      request<{ deliveryId: string }>(
        'POST',
        `${workspace(workspaceId)}/webhooks/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(deliveryId)}/redeliver`,
      ),
    // Customer reviews (docs/api/reviews.md): reads of our own database, a store read on sync, and
    // internal triage. Nothing here replies to a review or writes to a store.
    appReviews: (workspaceId: string, appId: string, query = '') =>
      request<ReviewsPage>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/reviews${query ? `?${query}` : ''}`,
      ),
    appReviewsSummary: (workspaceId: string, appId: string, weeks?: number) =>
      request<ReviewsSummary>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/reviews/summary${weeks ? `?weeks=${weeks}` : ''}`,
      ),
    syncAppReviews: (workspaceId: string, appId: string) =>
      request<ReviewSyncOutcome>('POST', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/reviews/sync`),
    triageReview: (workspaceId: string, appId: string, reviewId: string, body: TriageBody) =>
      request<{ review: Review }>(
        'PATCH',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/reviews/${encodeURIComponent(reviewId)}`,
        body,
      ),
  };
}

export type Api = ReturnType<typeof createApi>;
