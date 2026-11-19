import type { BuildsList, DownloadLink } from './builds.ts';
import type { AiSuggestionStatus, AiSuggestionView, AssetDiffView, Listing, ListingProblem, StagedChangesView, StoreImagesView } from '@mrm/core';
import type {
  AnalyticsOverview,
  AnalyticsStatus,
  AnalyticsSyncResult,
  EnablePreview,
  EnableResult,
  ImportPreview,
  ImportResult as AnalyticsImportResult,
} from './analytics.ts';
import type { AiAcceptBody, AiAcceptResult, AiConfig, AiModelsBody, AiModelsResponse, AiRunBody, AiSettingsChanges, AiTasksResponse, AiTestOutcome } from './ai.ts';
import type {
  AsoAddResult,
  AsoCompetitor,
  AsoCompetitorHistory,
  AsoConfig,
  AsoCoachResponse,
  AsoFitResponse,
  AsoGapsResponse,
  AsoIdeasResponse,
  AsoKeyword,
  AsoKeywordHistory,
  AsoKeywordInput,
  AsoListingKeywordsResponse,
  AsoMarketsResponse,
  AsoRefreshOutcome,
  AsoSuggestionsResponse,
  AsoSummary,
} from './aso.ts';
import type { RankVsDownloadsResponse } from './rank-downloads.ts';
import type { SearchTermsImportResult, SearchTermsPreview, SearchTermsQuery, SearchTermsResponse } from './search-terms.ts';
import type { ApplyBody } from './change-set-apply.ts';
import type { FixupBody, FixupResult, RecomputeResult } from './change-set-fixup.ts';
import type { RefreshResult, Resolution, Staleness } from './change-set-refresh.ts';
import type { CloneReport, PurgeResult, RepositoryClone } from './clone-upkeep.ts';
import type { ReplyConfig, ReplyDraft, ReplyTemplate, SendReplyResult } from './review-reply.ts';
import type { InspectedFile, PullReport, PullSelection, ToRepoResult, UploadQuery } from './assets-sync.ts';
import type { DraftPreview, DraftPushResult, StoreDraftConfig } from './staged.ts';
import type { StoreSubmitConfig, SubmitPreview, SubmitResult, SubmitState } from './store-submit.ts';
import type { PendingSummary, PendingView, PublishConfig, PublishPlan, PublishResult, StepRequest } from './pending.ts';
import type { EditableRelease, ReleaseCandidates } from './release-candidates.ts';
import type { NotesHistory } from './release-notes.ts';
import type { AppPipeline, PipelineSummary } from './release-pipeline.ts';
import type { ReleaseBody, ReleasePreview, ReleaseResult, StoreReleaseConfig, StoreReleaseState } from './store-release.ts';
import type { SettingValue, SettingsResponse, SettingsUpdateResponse, TranslationTestOutcome } from './settings.ts';
import type { TranslateReviewsResult } from './review-translation.ts';
import { type StepUpAction, type StepUpStatus, type StepUpTarget, stepUpMessage } from './step-up.ts';
import type { RolloutConfig, RolloutPreview, RolloutRequest, RolloutResult, RolloutStateView } from './store-rollout.ts';
import type { InboxPage, Review, ReviewSyncOutcome, ReviewsPage, ReviewsSummary, TriageBody, WorkspaceReviewsSummary } from './reviews.ts';
import type {
  ActiveRuns,
  AcceptedInvitation,
  ApiToken,
  AppBuild,
  AppBuilds,
  AppDetail,
  AssetIndex,
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
  RunJobs,
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
export function waitPhrase(seconds: number): string {
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
  // Step-up confirmation (docs/api/step-up.md): every code has a fixed sentence.
  const stepUp = stepUpMessage(body.error ?? '', retryAfter);
  if (stepUp) return stepUp;
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
      return body.message ?? 'A branch was already created for this change set, so it cannot be refreshed. Use "Fix up this branch" to add a commit to it, or discard it and create a new one.';
    case 'branch_moved':
      return 'The branch changed while the fix up was being made, so nothing was written. Look at the branch and try again.';
    case 'branch_checked_out':
      return body.message ?? 'The branch is checked out (or being rebased) in the local clone, so it cannot be moved. Check out another branch there and try again.';
    case 'branch_missing':
      return body.message ?? 'The branch no longer exists, so there is nothing to add a commit to. Discard the change set and create a new one.';
    case 'pr_closed':
      return body.message ?? 'The pull request is closed or merged, so the branch is not updated. Create a new change set from the current listing.';
    case 'remote_diverged':
      return body.message ?? 'The branch on GitHub has other commits, so the new commit was not pushed. Nothing was forced.';
    case 'fixup_in_progress':
      return 'This change set is being fixed up or pushed right now. Try again in a moment.';
    case 'no_branch':
      return 'This change set has no branch to add a commit to.';
    case 'fixup_conflicts':
      return body.message ?? 'Some files were also changed on the branch, in the same place. Choose for each file.';
    case 'fixup_unsupported':
      return body.message ?? 'This repository connection cannot add a commit to an existing branch.';
    case 'not_recomputable':
      return body.message ?? 'This change set was not made from the live store listing, so it cannot be recomputed.';
    case 'has_branch':
      return body.message ?? 'A branch exists for this change set. Use "Fix up this branch" to bring the store text into it.';
    case 'app_gone':
      return 'The app this change set was pulled for is no longer in the workspace.';
    case 'app_relinked':
      return 'The app is linked to another repository now, so this change set cannot be recomputed.';
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

/** The query of an upload, an inspection, a fix or a removal of one file of a staged set. */
function uploadQueryText(q: UploadQuery): string {
  const out = new URLSearchParams();
  out.set('locale', q.locale);
  out.set('kind', q.kind);
  if (q.device !== null) out.set('device', q.device);
  if (q.mode !== undefined) out.set('mode', q.mode);
  if (q.position !== undefined) out.set('position', String(q.position));
  if (q.name !== undefined) out.set('name', q.name);
  if (q.fix !== undefined) out.set('fix', q.fix);
  if (q.background !== undefined) out.set('background', q.background);
  return out.toString();
}

export function createApi(options: ApiOptions = {}) {
  const send = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  const requestHeaders = (raw: Blob | undefined, body: unknown, extra: Record<string, string> | undefined): Record<string, string> | undefined => {
    const headers: Record<string, string> = { ...(extra || {}) };
    if (raw) headers['content-type'] = raw.type || 'application/octet-stream';
    else if (body !== undefined) headers['content-type'] = 'application/json';
    return Object.keys(headers).length > 0 ? headers : undefined;
  };

  /** The header a confirmed hard action carries (docs/api/step-up.md). Never in a URL. */
  const grantHeader = (grant?: string): Record<string, string> | undefined => (grant ? { 'x-step-up-grant': grant } : undefined);

  /** `raw`: the body is the bytes of a file (an image upload), sent as they are; otherwise `body` is sent as JSON. */
  async function request<T>(method: string, path: string, body?: unknown, raw?: Blob, extraHeaders?: Record<string, string>): Promise<T> {
    let response: Response;
    try {
      response = await send(path, {
        method,
        headers: requestHeaders(raw, body, extraHeaders),
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
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
  const asoPath = (workspaceId: string, appId: string) => `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/aso`;
  const analyticsPath = (workspaceId: string, appId: string) => `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/analytics`;
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
    deleteCredential: (workspaceId: string, id: string, grant?: string) =>
      request<void>('DELETE', `${workspace(workspaceId)}/credentials/${encodeURIComponent(id)}`, undefined, undefined, grantHeader(grant)),
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
    /**
     * Adds ONE commit on top of the branch of an applied (or failed) change set: never a rewrite, never
     * forced. A conflict is a 409 `refresh_conflicts` (with the repository) or `fixup_conflicts` (with
     * the branch); the ApiError's body has the files. `dryRun` writes nothing.
     */
    fixupChangeSet: (workspaceId: string, id: string, body: FixupBody = {}) =>
      request<FixupResult>('POST', `${workspace(workspaceId)}/change-sets/${encodeURIComponent(id)}/fixup`, body),
    /** Makes a store pull again from the live store listing and the repository as they are now; `refresh` reads the store first. */
    recomputeChangeSet: (workspaceId: string, id: string, body: { refresh?: boolean } = {}) =>
      request<RecomputeResult>('POST', `${workspace(workspaceId)}/change-sets/${encodeURIComponent(id)}/recompute`, body),
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
    // Store rollout writes (docs/api/rollout.md): off unless the server sets MRM_STORE_ROLLOUT_ENABLED. State,
    // preview and apply need `releases.rollout` (admin and up); only `rolloutApply` changes a store, once,
    // with the `confirmHash` of a preview. `query` is `stateQuery(base)` of lib/store-rollout.ts.
    rolloutConfig: (workspaceId: string) => request<RolloutConfig>('GET', `${workspace(workspaceId)}/rollout/config`),
    rolloutState: (workspaceId: string, appId: string, query = '') =>
      request<RolloutStateView>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/rollout/state${query ? `?${query}` : ''}`,
      ),
    rolloutPreview: (workspaceId: string, appId: string, body: RolloutRequest) =>
      request<{ preview: RolloutPreview }>('POST', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/rollout/preview`, body),
    rolloutApply: (workspaceId: string, appId: string, body: RolloutRequest & { confirmHash: string }, grant?: string) =>
      request<{ result: RolloutResult }>('POST', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/rollout/apply`, body, undefined, grantHeader(grant)),
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
    /**
     * The runs going now (and those finished in the last 24 hours) across the repositories, or only
     * `repositoryIds`. A member or admin also refreshes them from GitHub, which is why it is cached
     * for seconds and limited per workspace; a viewer reads what is stored.
     */
    activeRuns: (workspaceId: string, repositoryIds?: readonly string[]) =>
      request<ActiveRuns>(
        'GET',
        `${workspace(workspaceId)}/ci/runs/active${repositoryIds && repositoryIds.length > 0 ? `?repositoryId=${encodeURIComponent(repositoryIds.join(','))}` : ''}`,
      ),
    /** The jobs and steps of a run: names, states and times. No logs. */
    workflowRunJobs: (workspaceId: string, repositoryId: string, runId: string) =>
      request<RunJobs>(
        'GET',
        `${workspace(workspaceId)}/repositories/${encodeURIComponent(repositoryId)}/workflows/runs/${encodeURIComponent(runId)}/jobs`,
      ),
    /** Starts the workflow on GitHub: this runs the team's CI. */
    dispatchWorkflow: (
      workspaceId: string,
      repositoryId: string,
      workflow: string,
      input: { ref?: string; inputs?: Record<string, string>; appId?: string; appIds?: string[] },
    ) =>
      request<DispatchResult>(
        'POST',
        `${workspace(workspaceId)}/repositories/${encodeURIComponent(repositoryId)}/workflows/${encodeURIComponent(workflow)}/dispatches`,
        input,
      ),
    appBuilds: (workspaceId: string, appId: string) =>
      request<AppBuilds>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/builds`),
    /** Builds to test: the CI artifacts of the runs of an app and its store builds (docs/api/builds.md). Needs the member role. */
    buildArtifacts: (workspaceId: string, appId: string) =>
      request<BuildsList>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/builds/artifacts`),
    /** A link a phone can open without signing in: ten minutes, once. Needs `builds.download` and the server switch. */
    createBuildLink: (workspaceId: string, appId: string, artifactId: string) =>
      request<DownloadLink>('POST', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/builds/artifacts/${encodeURIComponent(artifactId)}/link`),
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
    // Media files of the app's repository (docs/api/assets.md). Read-only. The images themselves
    // are loaded by the browser from `assetFileUrl` (lib/assets.ts), not through this client.
    appAssets: (workspaceId: string, appId: string) =>
      request<AssetIndex>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/assets`),
    // Staged listing changes and pushing them to a store as a DRAFT (docs/api/staged-changes.md). Staging,
    // unstaging and clearing change our own database only. `pushStagedDraft` is the one call that writes to a
    // store (the editable draft; it never submits), is sent once with the preview's hash, and is never retried.
    storeDraftConfig: (workspaceId: string) => request<StoreDraftConfig>('GET', `${workspace(workspaceId)}/store-draft/config`),
    appStaged: (workspaceId: string, appId: string) =>
      request<{ staged: StagedChangesView }>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged`),
    stageText: (
      workspaceId: string,
      appId: string,
      body: { locale: string; field: string; from: 'local' | 'repo' | 'store'; value?: string },
    ) =>
      request<{ staged: StagedChangesView }>('PUT', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged/text`, body),
    stageAssets: (
      workspaceId: string,
      appId: string,
      body: { locale: string; kind: string; device?: string | null; from?: 'repo'; paths?: string[]; commit?: string },
    ) =>
      request<{ staged: StagedChangesView }>('PUT', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged/assets`, body),
    // Two way sync of the graphics (docs/api/assets.md, docs/api/staged-changes.md). Reading a store and the comparison
    // change nothing in it. A pull and "to repository" make a DRAFT change set; uploads, removals and fixes change only
    // the staged set in our own database. Nothing here writes to a store: that is `pushStagedDraft`.
    appStoreImages: (workspaceId: string, appId: string, fresh = false) =>
      request<{ store: StoreImagesView; cached: boolean }>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/assets/store${fresh ? '?fresh=1' : ''}`),
    appAssetDiff: (workspaceId: string, appId: string, fresh = false) =>
      request<{ diff: AssetDiffView; cachedStore: boolean }>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/assets/diff${fresh ? '?fresh=1' : ''}`),
    pullStoreImages: (workspaceId: string, appId: string, selection: PullSelection) =>
      request<{ pull: PullReport }>('POST', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/assets/pull`, selection),
    inspectAssetFile: (workspaceId: string, appId: string, query: UploadQuery, file: Blob) =>
      request<{ inspected: InspectedFile }>('POST', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/assets/inspect?${uploadQueryText(query)}`, undefined, file),
    uploadStagedAsset: (workspaceId: string, appId: string, query: UploadQuery, file: Blob) =>
      request<{ staged: StagedChangesView; position: number }>('PUT', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged/assets/upload?${uploadQueryText(query)}`, undefined, file),
    removeStagedAssetFile: (workspaceId: string, appId: string, query: UploadQuery & { position: number }) =>
      request<{ staged: StagedChangesView }>('DELETE', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged/assets/file?${uploadQueryText(query)}`),
    fixStagedAssetFile: (
      workspaceId: string,
      appId: string,
      body: { locale: string; kind: string; device: string | null; position: number; fix: string; background?: string },
    ) =>
      request<{ staged: StagedChangesView; summary: string }>('POST', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged/assets/fix`, body),
    stagedAssetsToRepo: (workspaceId: string, appId: string, sets?: string[]) =>
      request<{ result: ToRepoResult }>('POST', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged/assets/to-repo`, sets ? { sets } : {}),
    unstageItem: (workspaceId: string, appId: string, id: string) =>
      request<{ staged: StagedChangesView }>(
        'DELETE',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged/items?id=${encodeURIComponent(id)}`,
      ),
    clearStaged: (workspaceId: string, appId: string) =>
      request<{ staged: StagedChangesView }>('DELETE', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged`),
    previewStagedPush: (workspaceId: string, appId: string) =>
      request<{ preview: DraftPreview }>('POST', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged/push/preview`, {}),
    pushStagedDraft: (workspaceId: string, appId: string, confirmHash: string, grant?: string) =>
      request<{ result: DraftPushResult }>('POST', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged/push`, { confirmHash }, undefined, grantHeader(grant)),
    // Submitting the pushed draft for store review (docs/api/submit.md): a SEPARATE, IRREVERSIBLE store write,
    // off by default. `config` and `appStoreSubmit` read our own database; `previewStoreSubmit` reads the store.
    // `storeSubmit` is the only call that writes: sent once with the preview's hash and the typed phrase, and
    // never retried by this app (not on an error, a timeout or a lost answer).
    storeSubmitConfig: (workspaceId: string) => request<StoreSubmitConfig>('GET', `${workspace(workspaceId)}/store-submit/config`),
    appStoreSubmit: (workspaceId: string, appId: string) =>
      request<{ submit: SubmitState }>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/store-submit`),
    previewStoreSubmit: (workspaceId: string, appId: string) =>
      request<{ preview: SubmitPreview }>('POST', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/store-submit/preview`, {}),
    storeSubmit: (workspaceId: string, appId: string, body: { confirmHash: string; confirmation: string }, grant?: string) =>
      request<{ result: SubmitResult }>('POST', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/store-submit`, body, undefined, grantHeader(grant)),
    // Preparing a release (docs/api/releases-write.md): reads of the store for the build picker, the draft and the
    // earlier notes; staging is the existing staged route and writes nothing to a store.
    releaseCandidates: (workspaceId: string, appId: string, query: { track?: string; version?: string } = {}) => {
      const q = new URLSearchParams();
      if (query.track) q.set('track', query.track);
      if (query.version) q.set('version', query.version);
      const text = q.toString();
      return request<{ candidates: ReleaseCandidates }>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/release/candidates${text ? `?${text}` : ''}`);
    },
    releaseEditable: (workspaceId: string, appId: string, track?: string) =>
      request<{ editable: EditableRelease }>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/release/editable${track ? `?track=${encodeURIComponent(track)}` : ''}`),
    releaseNotesHistory: (workspaceId: string, appId: string, query: { platform?: string; locale?: string; limit?: number } = {}) => {
      const q = new URLSearchParams();
      if (query.platform) q.set('platform', query.platform);
      if (query.locale) q.set('locale', query.locale);
      if (query.limit) q.set('limit', String(query.limit));
      const text = q.toString();
      return request<{ history: NotesHistory }>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/release/notes-history${text ? `?${text}` : ''}`);
    },
    /** Stages one release field (a build, a version, a track, ...). Nothing reaches a store. */
    stageReleaseField: (workspaceId: string, appId: string, body: { field: string; locale?: string; value: string }) =>
      request<{ staged: StagedChangesView }>('PUT', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged/release-fields`, body),
    // The release pipeline (docs/api/release-pipeline.md): reads of our own database.
    releasePipeline: (workspaceId: string, appId: string) =>
      request<AppPipeline>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/release/pipeline`),
    releasePipelineSummary: (workspaceId: string) => request<PipelineSummary>('GET', `${workspace(workspaceId)}/release/pipeline/summary`),
    // Releasing (docs/api/releases-write.md): a SEPARATE, IRREVERSIBLE store write, off by default. Like submit:
    // `storeRelease` is sent once with the preview's hash and the typed phrase, and never retried by this app.
    storeReleaseConfig: (workspaceId: string) => request<StoreReleaseConfig>('GET', `${workspace(workspaceId)}/store-release/config`),
    appStoreRelease: (workspaceId: string, appId: string) =>
      request<{ release: StoreReleaseState }>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/store-release`),
    previewStoreRelease: (workspaceId: string, appId: string, body: ReleaseBody) =>
      request<{ preview: ReleasePreview }>('POST', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/store-release/preview`, body),
    storeRelease: (workspaceId: string, appId: string, body: ReleaseBody & { confirmHash: string; confirmation: string }, grant?: string) =>
      request<{ result: ReleaseResult }>('POST', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/store-release`, body, undefined, grantHeader(grant)),
    // Everything pending, and publishing it in one go (docs/api/pending.md, docs/adr/0015-pending-and-batch-publish.md). The two
    // pending reads and the config read our own database only. `previewPublish` reads the stores (a plan, no write).
    // `publishPending` is the only call that writes: sent once with the plan's hash and the typed phrase, never retried by this app.
    appPending: (workspaceId: string, appId: string) =>
      request<{ pending: PendingView }>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/pending`),
    pendingSummary: (workspaceId: string) => request<PendingSummary>('GET', `${workspace(workspaceId)}/pending/summary`),
    storePublishConfig: (workspaceId: string) => request<PublishConfig>('GET', `${workspace(workspaceId)}/store-publish/config`),
    previewPublish: (workspaceId: string, appId: string, body: { steps?: StepRequest[] } = {}) =>
      request<{ plan: PublishPlan }>('POST', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/publish/preview`, body),
    publishPending: (workspaceId: string, appId: string, body: { planHash: string; steps: StepRequest[]; phrase?: string }, grant?: string) =>
      request<{ result: PublishResult }>('POST', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/publish`, body, undefined, grantHeader(grant)),
    // Customer reviews (docs/api/reviews.md): reads of our own database, a store read on sync, and
    // internal triage. Nothing in this group writes to a store; replying is the group below.
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
    // The workspace-wide reviews inbox and summary (docs/api/reviews.md). Reads of our own database.
    workspaceReviews: (workspaceId: string, query = '') =>
      request<InboxPage>('GET', `${workspace(workspaceId)}/reviews${query ? `?${query}` : ''}`),
    workspaceReviewsSummary: (workspaceId: string) =>
      request<WorkspaceReviewsSummary>('GET', `${workspace(workspaceId)}/reviews/summary`),
    // Workspace settings and the translation of reviews (docs/api/settings.md, docs/api/reviews.md).
    // `translateReviews` sends the stored text of the named reviews to the workspace's translation provider.
    workspaceSettings: (workspaceId: string) => request<SettingsResponse>('GET', `${workspace(workspaceId)}/settings`),
    updateWorkspaceSettings: (workspaceId: string, changes: Record<string, SettingValue>, grant?: string) =>
      request<SettingsUpdateResponse>('PUT', `${workspace(workspaceId)}/settings`, changes, undefined, grantHeader(grant)),
    // Step-up confirmation (docs/api/step-up.md). The passkey calls move base64url JSON; `lib/step-up.ts` converts it.
    stepUpStatus: (workspaceId: string) => request<StepUpStatus>('GET', `${workspace(workspaceId)}/step-up/status`),
    stepUpRegisterOptions: (workspaceId: string) =>
      request<{ challengeId: string; publicKey: Record<string, unknown> }>('POST', `${workspace(workspaceId)}/step-up/passkeys/register/options`, {}),
    stepUpRegisterVerify: (
      workspaceId: string,
      body: { challengeId: string; name: string; credential: { id: string; clientDataJSON: string; attestationObject: string; transports?: string[] } },
      grant?: string,
    ) => request<{ passkey: { id: string; name: string } }>('POST', `${workspace(workspaceId)}/step-up/passkeys/register/verify`, body, undefined, grantHeader(grant)),
    stepUpDeletePasskey: (workspaceId: string, id: string, grant?: string) =>
      request<void>('DELETE', `${workspace(workspaceId)}/step-up/passkeys/${encodeURIComponent(id)}`, undefined, undefined, grantHeader(grant)),
    stepUpSetPassword: (workspaceId: string, password: string, grant?: string) =>
      request<void>('PUT', `${workspace(workspaceId)}/step-up/confirmation-password`, { password }, undefined, grantHeader(grant)),
    stepUpAssertionOptions: (workspaceId: string, body: { action: StepUpAction | 'step_up.manage'; target?: StepUpTarget }) =>
      request<{ challengeId: string; publicKey: Record<string, unknown> }>('POST', `${workspace(workspaceId)}/step-up/passkeys/assertion/options`, body),
    stepUpVerify: (
      workspaceId: string,
      body:
        | { factor: 'password'; action: string; target?: StepUpTarget; password: string }
        | { factor: 'passkey'; action: string; target?: StepUpTarget; challengeId: string; assertion: { id: string; clientDataJSON: string; authenticatorData: string; signature: string } },
    ) => request<{ grant: string; expiresAt: number }>('POST', `${workspace(workspaceId)}/step-up/verify`, body),
    stepUpSetPolicy: (workspaceId: string, body: { mode: 'off' | 'hard_actions'; actions?: StepUpAction[]; unattended?: StepUpAction[] }, grant?: string) =>
      request<{ policy: StepUpStatus['policy']; enrolled: boolean }>('PUT', `${workspace(workspaceId)}/step-up/policy`, body, undefined, grantHeader(grant)),
    testTranslation: (workspaceId: string) =>
      request<TranslationTestOutcome>('POST', `${workspace(workspaceId)}/translate/test`),
    translateReviews: (workspaceId: string, appId: string, body: { reviewIds: string[]; target?: string }) =>
      request<TranslateReviewsResult>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/reviews/translate`,
        body,
      ),
    // Replying to reviews (docs/adr/0007-review-replies.md): the only calls here that can publish
    // something in a store are `sendReviewReply`, one review at a time, with the hash of the draft.
    reviewReplyConfig: (workspaceId: string) => request<ReplyConfig>('GET', `${workspace(workspaceId)}/reviews/reply-config`),
    review: (workspaceId: string, appId: string, reviewId: string) =>
      request<{ review: Review }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/reviews/${encodeURIComponent(reviewId)}`,
      ),
    saveReplyDraft: (workspaceId: string, appId: string, reviewId: string, body: { text: string } | { templateId: string }) =>
      request<{ draft: ReplyDraft }>(
        'PUT',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/reviews/${encodeURIComponent(reviewId)}/reply-draft`,
        body,
      ),
    deleteReplyDraft: (workspaceId: string, appId: string, reviewId: string) =>
      request<void>(
        'DELETE',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/reviews/${encodeURIComponent(reviewId)}/reply-draft`,
      ),
    translateReplyDraft: (workspaceId: string, appId: string, reviewId: string, body: { text: string; target: string; source?: string }) =>
      request<{ text: string }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/reviews/${encodeURIComponent(reviewId)}/reply-draft/translate`,
        body,
      ),
    sendReviewReply: (workspaceId: string, appId: string, reviewId: string, confirmHash: string) =>
      request<SendReplyResult>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/reviews/${encodeURIComponent(reviewId)}/reply`,
        { confirmHash },
      ),
    replyTemplates: (workspaceId: string) =>
      request<{ templates: ReplyTemplate[] }>('GET', `${workspace(workspaceId)}/reviews/reply-templates`),
    createReplyTemplate: (workspaceId: string, body: { name: string; body: string }) =>
      request<{ template: ReplyTemplate }>('POST', `${workspace(workspaceId)}/reviews/reply-templates`, body),
    deleteReplyTemplate: (workspaceId: string, id: string) =>
      request<void>('DELETE', `${workspace(workspaceId)}/reviews/reply-templates/${encodeURIComponent(id)}`),
    // AI assistance (docs/api/ai.md, docs/adr/0016-ai-foundation.md). A run makes a SUGGESTION and changes nothing; accepting calls an
    // existing service (keywords, a staged text, a reply draft). Nothing here pushes, submits, publishes or sends. No key is ever returned.
    aiConfig: (workspaceId: string) => request<AiConfig>('GET', `${workspace(workspaceId)}/ai/config`),
    updateAiConfig: (workspaceId: string, changes: AiSettingsChanges) => request<AiConfig>('PUT', `${workspace(workspaceId)}/ai/config`, changes),
    testAi: (workspaceId: string) => request<AiTestOutcome>('POST', `${workspace(workspaceId)}/ai/test`),
    // The models a provider offers. A typed key is used for this call only (never stored); without one the stored credential is used.
    aiModels: (workspaceId: string, body: AiModelsBody) => request<AiModelsResponse>('POST', `${workspace(workspaceId)}/ai/models`, body),
    aiTasks: (workspaceId: string) => request<AiTasksResponse>('GET', `${workspace(workspaceId)}/ai/tasks`),
    runAiTask: (workspaceId: string, taskId: string, body: AiRunBody) =>
      request<{ suggestion: AiSuggestionView }>('POST', `${workspace(workspaceId)}/ai/tasks/${encodeURIComponent(taskId)}/run`, body),
    appAiSuggestions: (workspaceId: string, appId: string, query: { status?: AiSuggestionStatus; limit?: number } = {}) => {
      const params = new URLSearchParams();
      if (query.status) params.set('status', query.status);
      if (query.limit) params.set('limit', String(query.limit));
      const text = params.toString();
      return request<{ suggestions: AiSuggestionView[] }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/ai/suggestions${text ? `?${text}` : ''}`,
      );
    },
    acceptAiSuggestion: (workspaceId: string, suggestionId: string, body: AiAcceptBody = {}) =>
      request<AiAcceptResult>('POST', `${workspace(workspaceId)}/ai/suggestions/${encodeURIComponent(suggestionId)}/accept`, body),
    dismissAiSuggestion: (workspaceId: string, suggestionId: string) =>
      request<{ suggestion: AiSuggestionView }>('POST', `${workspace(workspaceId)}/ai/suggestions/${encodeURIComponent(suggestionId)}/dismiss`),
    // ASO (docs/api/aso.md). Every read is our own database; only `refreshAso` and `addAsoCompetitor` read a public store, and nothing writes to one.
    asoConfig: (workspaceId: string) => request<AsoConfig>('GET', `${workspace(workspaceId)}/aso/config`),
    asoSummary: (workspaceId: string, appId: string) => request<AsoSummary>('GET', `${asoPath(workspaceId, appId)}/summary`),
    asoKeywords: (workspaceId: string, appId: string) =>
      request<{ keywords: AsoKeyword[]; limits: { maxKeywordsPerApp: number } }>('GET', `${asoPath(workspaceId, appId)}/keywords`),
    addAsoKeywords: (workspaceId: string, appId: string, keywords: AsoKeywordInput[]) =>
      request<AsoAddResult>('POST', `${asoPath(workspaceId, appId)}/keywords`, { keywords }),
    updateAsoKeyword: (workspaceId: string, appId: string, keywordId: string, changes: { tag?: string | null; notes?: string | null; priority?: number }) =>
      request<{ keyword: AsoKeyword }>('PATCH', `${asoPath(workspaceId, appId)}/keywords/${encodeURIComponent(keywordId)}`, changes),
    deleteAsoKeyword: (workspaceId: string, appId: string, keywordId: string) =>
      request<void>('DELETE', `${asoPath(workspaceId, appId)}/keywords/${encodeURIComponent(keywordId)}`),
    asoKeywordHistory: (workspaceId: string, appId: string, keywordId: string, limit = 30) =>
      request<AsoKeywordHistory>('GET', `${asoPath(workspaceId, appId)}/keywords/${encodeURIComponent(keywordId)}/history?limit=${limit}`),
    asoCompetitors: (workspaceId: string, appId: string) =>
      request<{ competitors: AsoCompetitor[]; limits: { maxCompetitorsPerApp: number } }>('GET', `${asoPath(workspaceId, appId)}/competitors`),
    /** Reads the public store once, so the name is real. Rate limited per workspace. */
    addAsoCompetitor: (workspaceId: string, appId: string, body: { externalId: string; country?: string }) =>
      request<{ competitor: AsoCompetitor }>('POST', `${asoPath(workspaceId, appId)}/competitors`, body),
    deleteAsoCompetitor: (workspaceId: string, appId: string, competitorId: string) =>
      request<void>('DELETE', `${asoPath(workspaceId, appId)}/competitors/${encodeURIComponent(competitorId)}`),
    asoCompetitorHistory: (workspaceId: string, appId: string, competitorId: string, limit = 30) =>
      request<AsoCompetitorHistory>('GET', `${asoPath(workspaceId, appId)}/competitors/${encodeURIComponent(competitorId)}/history?limit=${limit}`),
    /** Ranked next steps, worked out from stored data (no store is read). */
    asoCoach: (workspaceId: string, appId: string) => request<AsoCoachResponse>('GET', `${asoPath(workspaceId, appId)}/coach`),
    asoFit: (workspaceId: string, appId: string) => request<AsoFitResponse>('GET', `${asoPath(workspaceId, appId)}/fit`),
    asoListingKeywords: (workspaceId: string, appId: string) => request<AsoListingKeywordsResponse>('GET', `${asoPath(workspaceId, appId)}/listing-keywords`),
    asoIdeas: (workspaceId: string, appId: string, locale?: string) =>
      request<AsoIdeasResponse>('GET', `${asoPath(workspaceId, appId)}/ideas${locale ? `?locale=${encodeURIComponent(locale)}` : ''}`),
    asoGaps: (workspaceId: string, appId: string, locale?: string) =>
      request<AsoGapsResponse>('GET', `${asoPath(workspaceId, appId)}/gaps${locale ? `?locale=${encodeURIComponent(locale)}` : ''}`),
    asoSuggestions: (workspaceId: string, appId: string) => request<AsoSuggestionsResponse>('GET', `${asoPath(workspaceId, appId)}/suggestions`),
    /** Google Play search terms imported from a Console file (our own database; Google Play apps only). */
    asoSearchTerms: (workspaceId: string, appId: string, query: SearchTermsQuery = {}) => {
      const params: string[] = [];
      for (const key of ['from', 'to', 'country', 'locale', 'sort', 'limit'] as const) {
        const value = query[key];
        if (value !== undefined && value !== '') params.push(`${key}=${encodeURIComponent(String(value))}`);
      }
      return request<SearchTermsResponse>('GET', `${asoPath(workspaceId, appId)}/search-terms${params.length > 0 ? `?${params.join('&')}` : ''}`);
    },
    /** Rank history of tracked keywords laid on the days of the downloads. Our own database; a correlation view. */
    asoRankVsDownloads: (workspaceId: string, appId: string, query: { country?: string; keywords?: string[]; from?: string; to?: string } = {}) => {
      const params: string[] = [];
      if (query.country) params.push(`country=${encodeURIComponent(query.country)}`);
      if (query.keywords && query.keywords.length > 0) params.push(`keywords=${query.keywords.map(encodeURIComponent).join(',')}`);
      if (query.from) params.push(`from=${encodeURIComponent(query.from)}`);
      if (query.to) params.push(`to=${encodeURIComponent(query.to)}`);
      return request<RankVsDownloadsResponse>('GET', `${asoPath(workspaceId, appId)}/rank-vs-downloads${params.length > 0 ? `?${params.join('&')}` : ''}`);
    },
    asoMarkets: (workspaceId: string, appId: string) => request<AsoMarketsResponse>('GET', `${asoPath(workspaceId, appId)}/markets`),
    /** Reads the public store (Apple: the iTunes Search API; Google Play only when the operator allows it). Read-only toward the stores. */
    refreshAso: (workspaceId: string, appId: string) => request<AsoRefreshOutcome>('POST', `${asoPath(workspaceId, appId)}/refresh`),
    /** Admins: queues a refresh of every app that has keywords or competitors. */
    refreshAsoAll: (workspaceId: string) =>
      request<{ queued: number; skipped: { alreadyQueued: number; notReady: number; playOff: number; capped: number } }>('POST', `${workspace(workspaceId)}/aso/refresh`),
    // Analytics (docs/api/analytics.md). Reads (`analyticsStatus`, `analyticsOverview`) are our own database. `syncAnalytics` reads the stores;
    // `previewAppleEnable` reads Apple and changes nothing; `enableApple` is the one store write (a report request at Apple), with the
    // preview's hash; the import sends a report file to this server only. All but the two reads need `analytics.manage`.
    analyticsStatus: (workspaceId: string, appId: string) => request<AnalyticsStatus>('GET', `${analyticsPath(workspaceId, appId)}/status`),
    analyticsOverview: (
      workspaceId: string,
      appId: string,
      query: { platform?: string; from?: string; to?: string; granularity?: string; breakdown?: string } = {},
    ) => {
      const params = new URLSearchParams();
      for (const key of ['platform', 'from', 'to', 'granularity', 'breakdown'] as const) {
        const value = query[key];
        if (value !== undefined && value !== '') params.set(key, value);
      }
      const text = params.toString();
      return request<AnalyticsOverview>('GET', `${analyticsPath(workspaceId, appId)}/overview${text ? `?${text}` : ''}`);
    },
    syncAnalytics: (workspaceId: string, appId: string, sources?: string[]) =>
      request<AnalyticsSyncResult>('POST', `${analyticsPath(workspaceId, appId)}/sync`, sources && sources.length > 0 ? { sources } : undefined),
    previewAppleEnable: (workspaceId: string, appId: string, backfill = false) =>
      request<EnablePreview>('GET', `${analyticsPath(workspaceId, appId)}/apple/enable${backfill ? '?backfill=true' : ''}`),
    enableApple: (workspaceId: string, appId: string, body: { confirmHash: string; backfill?: boolean }, grant?: string) =>
      request<EnableResult>('POST', `${analyticsPath(workspaceId, appId)}/apple/enable`, body, undefined, grantHeader(grant)),
    previewAnalyticsImport: (workspaceId: string, appId: string, fileName: string, file: Blob) =>
      request<ImportPreview>('POST', `${analyticsPath(workspaceId, appId)}/import/preview?fileName=${encodeURIComponent(fileName)}`, undefined, file),
    importAnalytics: (workspaceId: string, appId: string, fileName: string, confirmHash: string, file: Blob) =>
      request<AnalyticsImportResult>(
        'POST',
        `${analyticsPath(workspaceId, appId)}/import?fileName=${encodeURIComponent(fileName)}&confirmHash=${encodeURIComponent(confirmHash)}`,
        undefined,
        file,
      ),
    /** Sends a Play Console search terms file to this server only and says what it holds. Stores nothing. A file with no dates needs `period`. */
    previewSearchTermsImport: (workspaceId: string, appId: string, fileName: string, file: Blob, period: string = '') =>
      request<SearchTermsPreview>(
        'POST',
        `${analyticsPath(workspaceId, appId)}/search-terms/import/preview?fileName=${encodeURIComponent(fileName)}${period === '' ? '' : `&${period}`}`,
        undefined,
        file,
      ),
    importSearchTerms: (workspaceId: string, appId: string, fileName: string, confirmHash: string, file: Blob, period: string = '') =>
      request<SearchTermsImportResult>(
        'POST',
        `${analyticsPath(workspaceId, appId)}/search-terms/import?fileName=${encodeURIComponent(fileName)}&confirmHash=${encodeURIComponent(confirmHash)}${period === '' ? '' : `&${period}`}`,
        undefined,
        file,
      ),
  };
}

export type Api = ReturnType<typeof createApi>;
