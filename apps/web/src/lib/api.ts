import type { SyncPlanEntry } from './sync-sources.ts';
import type { EstimateDetail, EstimatesResponse, SuggestionsResponse } from './aso/estimates.ts';
import type {
  AiSuggestionStatus,
  AiSuggestionView,
  AssetDiffView,
  Listing,
  ListingProblem,
  StagedChangesView,
  StagedRolloutMode,
  StoreImagesView,
} from '@kiln/core';
import type {
  AiAcceptBody,
  AiAcceptResult,
  AiAppContextView,
  AiConfig,
  AiModelsBody,
  AiModelsResponse,
  AiPreview,
  AiReviewTagView,
  AiRunBody,
  AiRunResult,
  AiSettingsChanges,
  AiTasksResponse,
  AiTestOutcome,
} from './ai/ai.ts';
import type {
  AlertChannel,
  AlertInboxPage,
  AlertTestResult,
  CatalogEntry,
  Delivery,
  Mute,
  Preference,
  RuleView,
  SettingsPage,
  UserSettings,
} from './alerts/alerts.ts';
import type {
  ImportResult as AnalyticsImportResult,
  AnalyticsOverview,
  AnalyticsStatus,
  AnalyticsSyncResult,
  EnablePreview,
  EnableResult,
  ImportPreview,
  PlayBucketTestResult,
  PlayBucketView,
} from './analytics/analytics.ts';
import type { ProductSalesView } from './analytics/product-sales.ts';
import type { HealthView, RatingsView } from './ratings/ratings.ts';
import type { ReportApi } from './timeline/report.ts';
import type { AssetProposalView, ManualEventKind, ProposalState } from '@kiln/core';
import type { TimelineApi } from './timeline/timeline.ts';
import type { ListingFixesView } from './listing/fixes.ts';
import type { CountriesView as InsightsCountriesView, InsightsView, ListingChecksView } from './insights/insights.ts';
import type {
  AsoAddResult,
  AsoCoachResponse,
  AsoCompetitor,
  AsoCompetitorSearch,
  AsoCompetitorHistory,
  AsoConfig,
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
} from './aso/aso.ts';
import type { CompetitorChangesPage, CompetitorCheckResult } from './aso/competitor-changes.ts';
import type { ReviewScheduleView } from './aso/competitor-review-schedule.ts';
import type { ReviewPayloadPreview, ReviewPrivacyView } from './ai/review-privacy.ts';
import type { RankVsDownloadsResponse } from './aso/rank-downloads.ts';
import type {
  SearchTermsImportResult,
  SearchTermsPreview,
  SearchTermsQuery,
  SearchTermsResponse,
} from './aso/search-terms.ts';
import type {
  InspectedFile,
  PullReport,
  PullSelection,
  ToRepoResult,
  UploadQuery,
} from './assets/sync.ts';
import type {
  AdsAccount,
  AdsCampaignsResponse,
  AdsOverviewResponse,
  AdsState,
  AdsTermsResponse,
  AdsLinkView,
  SetAdsLinkBody,
} from './ads/ads.ts';
import type { ExpoDetection, ExpoLinkView, SetExpoLinkBody } from './eas/eas.ts';
import type { IntegrationLinks, RevenueCatPlan } from './connect/connect.ts';
import type { EasStatusView } from './eas/eas-status.ts';
import type { EasWorkflowDispatchBody, EasWorkflowRunRead } from './eas/eas-workflows.ts';
import type {
  EasRolloutPreview,
  EasRolloutRequest,
  EasRolloutResult,
  EasUpdateInsights,
  EasUpdateState,
} from './eas/eas-update.ts';
import type {
  BuildsList,
  DownloadLink,
  InternalSharingConfig,
  SharePreview,
  ShareResult,
} from './builds.ts';
import type { ApplyBody } from './change-set-apply.ts';
import type { FixupBody, FixupResult, RecomputeResult } from './change-set-fixup.ts';
import type { RefreshResult, Resolution, Staleness } from './change-set-refresh.ts';
import type { CloneReport, PurgeResult, RepositoryClone } from './clone-upkeep.ts';
import { isDemoStatus } from './demo.ts';
import type { ChatDelivery, ChatDestination } from './chat/chat.ts';
import { codedText, type ErrorBody, explicitText, legacyText, waitText } from './error-text.ts';
import { readLocalePref } from './i18n/preference.ts';
import { currentLocale } from './i18n/t.ts';
import type { McpStatus } from './mcp.ts';
import type {
  PendingSummary,
  PendingView,
  PublishConfig,
  PublishPlan,
  PublishResult,
  StepRequest,
} from './pending.ts';
import type { PlayCheckAnswer, PlayCheckBody } from './play-check.ts';
import type { EditableRelease, ReleaseCandidates } from './release-candidates.ts';
import type { NotesHistory } from './release-notes.ts';
import type { TranslateNotesBody, TranslateNotesResult } from './release-notes-translate.ts';
import type { AppPipeline, PipelineSummary } from './release-pipeline.ts';
import type { ReleaseSettingsView } from './release-settings.ts';
import type {
  RevenueCatLinkRead,
  RevenueCatLinkView,
  RevenueCatOptions,
  RevenueCatProductsView,
  SetRevenueCatLinkBody,
} from './revenuecat/revenuecat.ts';
import type { RevenueCatMetricsRead } from './revenuecat/metrics.ts';
import type { ReplyConfig, ReplyDraft, ReplyTemplate, SendReplyResult } from './reviews/reply.ts';
import type {
  InboxPage,
  Review,
  ReviewSyncOutcome,
  ReviewsPage,
  ReviewsSummary,
  TriageBody,
  WorkspaceReviewsSummary,
} from './reviews/reviews.ts';
import type { TranslateReviewsResult } from './reviews/translation.ts';
import type {
  SettingsResponse,
  SettingsUpdateResponse,
  SettingValue,
  TranslationTestOutcome,
} from './settings.ts';
import type { DraftPreview, DraftPushResult, StoreDraftConfig } from './staged.ts';
import {
  type StepUpAction,
  type StepUpStatus,
  type StepUpTarget,
  stepUpMessage,
} from './step-up.ts';
import type {
  ReleaseBody,
  ReleasePreview,
  ReleaseResult,
  StoreReleaseConfig,
  StoreReleaseState,
} from './store-release.ts';
import type {
  RolloutConfig,
  RolloutPreview,
  RolloutRequest,
  RolloutResult,
  RolloutStateView,
} from './store-rollout.ts';
import type {
  StoreSubmitConfig,
  SubmitPreview,
  SubmitResult,
  SubmitState,
} from './store-submit.ts';
import type {
  ExperimentNote,
  ExperimentsSyncResult,
  ExperimentsView,
  NoteInput,
} from './experiments.ts';
import type {
  CrashGroups,
  ScreenshotLink,
  TestflightItem,
  TestflightSyncResult,
  TestflightView,
  TriageInput,
} from './testflight.ts';
import type { VersionPreview, VersionResult } from './store-version.ts';
import { announceCartAdded, type CartDetail, type CartResponse, type CartResultResponse } from './pending-cart.ts';
import type { PendingItemDetail } from './pending-preview.ts';
import { announceStagedChanged, type StagedChangeReason } from './staged-sync.ts';
import type { ProposalSummary } from './asset-proposal-hint.ts';
import type { CartSummary } from './cart-summary.ts';
import {
  type CodeSent,
  type LoginMethod,
  type LoginMode,
  type LoginResult,
  type MailTestResult,
  type SmtpInput,
  type SmtpSettings,
  type TotpBegin,
  type TotpStatus,
  type TwoFactorStatus,
  twoFactorMessage,
} from './two-factor.ts';
import type {
  EasConfigView,
  AcceptedInvitation,
  ActiveRuns,
  ApiToken,
  AppBuild,
  AppBuilds,
  AppDetail,
  AppSummary,
  AssetIndex,
  AuditEvent,
  AuthStatus,
  BuildChanges,
  BuildConventionsView,
  ChangeSetView,
  ChecklistTemplate,
  CiWorkflow,
  CreatedApiToken,
  CreatedInvitation,
  CreatedWebhook,
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
  ConvertedPrice,
  PriceDryRunItem,
  PricePointOption,
  PriceStageRequest,
  StagedPriceChange,
  ProductDetailView,
  ProductLocalizationPreview,
  ProductLocalizationResult,
  ProductSyncResult,
  ProductsView,
  PullRequestBody,
  PullResult,
  RematchedBuilds,
  RepoRefreshResult,
  RepositoryDetail,
  RepositoryListing,
  RepositorySummary,
  RepositoryTags,
  RolloutBody,
  RolloutView,
  RunJobs,
  SavedListingTarget,
  SyncResult,
  TestResult,
  User,
  AppListingSettings,
  WebhookDelivery,
  WebhookEndpoint,
  WorkflowInputs,
  WorkflowRun,
  WorkflowRuns,
  CompetitorReviewsRefresh,
  CompetitorReviewsView,
} from './types.ts';

type Issue = { path: string; message: string };

export class ApiError extends Error {
  status: number;
  code: string;
  retryAfter: number | undefined;
  /** The JSON body of the error response, for screens that need more than the message. */
  body: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    retryAfter?: number,
    body: Record<string, unknown> = {},
  ) {
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
  body: {
    error?: string;
    message?: string;
    issues?: Issue[];
    paths?: string[];
    code?: unknown;
    params?: unknown;
  },
  retryAfter?: number,
): string {
  // The server's stable `code` in the person's language (docs/i18n-server.md). A code the `errors`
  // catalog does not have falls through to the English table below, and at the end to the server's
  // own `message`.
  const coded = explicitText(body as ErrorBody, retryAfter);
  if (coded !== undefined) return coded;
  // Local clones: the server's messages are written to be shown (they name KILN_LOCAL_REPO_ROOTS, the
  // folder rule or the fix), so they are used as they are.
  if (body.error?.startsWith('local_') && body.message) return body.message;
  // Step-up confirmation (docs/api/step-up.md): every code has a fixed sentence.
  const stepUp = stepUpMessage(body.error ?? '', retryAfter);
  if (stepUp) return stepUp;
  // Two-factor authentication and mail (docs/api/two-factor.md): fixed sentences for each code.
  const twoFactor = twoFactorMessage(body.error ?? '', retryAfter);
  if (twoFactor) return twoFactor;
  // The code a response without one has implicitly (`not_found` is `errors:api.notFound`).
  const legacy = legacyText(body as ErrorBody, retryAfter);
  if (legacy !== undefined) return legacy;
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
      return body.message?.startsWith('That folder')
        ? body.message
        : 'That repository is already connected to this workspace.';
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
      return (
        body.message ??
        'The Expo store.config.json cannot be read, so the App Store listing cannot be changed.'
      );
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
      return (
        body.message ??
        'Some files changed in the repository in the same place. Choose for each file.'
      );
    case 'nothing_to_apply':
      return 'Nothing left to apply: the repository already has this change. Discard the change set.';
    case 'branch_created':
      return (
        body.message ??
        'A branch was already created for this change set, so it cannot be refreshed. Use "Fix up this branch" to add a commit to it, or discard it and create a new one.'
      );
    case 'branch_moved':
      return 'The branch changed while the fix up was being made, so nothing was written. Look at the branch and try again.';
    case 'branch_checked_out':
      return (
        body.message ??
        'The branch is checked out (or being rebased) in the local clone, so it cannot be moved. Check out another branch there and try again.'
      );
    case 'branch_missing':
      return (
        body.message ??
        'The branch no longer exists, so there is nothing to add a commit to. Discard the change set and create a new one.'
      );
    case 'pr_closed':
      return (
        body.message ??
        'The pull request is closed or merged, so the branch is not updated. Create a new change set from the current listing.'
      );
    case 'remote_diverged':
      return (
        body.message ??
        'The branch on GitHub has other commits, so the new commit was not pushed. Nothing was forced.'
      );
    case 'fixup_in_progress':
      return 'This change set is being fixed up or pushed right now. Try again in a moment.';
    case 'no_branch':
      return 'This change set has no branch to add a commit to.';
    case 'fixup_conflicts':
      return (
        body.message ??
        'Some files were also changed on the branch, in the same place. Choose for each file.'
      );
    case 'fixup_unsupported':
      return (
        body.message ?? 'This repository connection cannot add a commit to an existing branch.'
      );
    case 'not_recomputable':
      return (
        body.message ??
        'This change set was not made from the live store listing, so it cannot be recomputed.'
      );
    case 'has_branch':
      return (
        body.message ??
        'A branch exists for this change set. Use "Fix up this branch" to bring the store text into it.'
      );
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
      return first
        ? `${first.path ? `${first.path}: ` : ''}${first.message}`
        : 'Check the form and try again.';
    }
  }
  // A code this app does not know yet (a newer server): its English message is better than a bare status.
  if (typeof body.code === 'string' && body.code.includes('.') && body.message) return body.message;
  if (status === 429) {
    return (
      codedText('http.tooManyRequests', { wait: waitText(retryAfter ?? 60) }) ??
      `Too many requests. Try again in ${waitPhrase(retryAfter ?? 60)}.`
    );
  }
  if (status >= 500) return codedText('http.serverError') ?? 'The server had a problem. Try again.';
  return codedText('http.requestFailed', { status }) ?? `The request failed (${status}).`;
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
  if (q.base !== undefined) out.set('base', q.base);
  return out.toString();
}

/** Which release the asset proposal is for: the version (App Store), the track (Google Play) and the chosen build number. */
export type ReleaseAssetRef = { version?: string | null; track?: string | null; build?: string | null };
const releaseAssetQuery = (r: ReleaseAssetRef): string => {
  const parts: string[] = [];
  if (r.version) parts.push(`version=${encodeURIComponent(r.version)}`);
  if (r.track) parts.push(`track=${encodeURIComponent(r.track)}`);
  if (r.build) parts.push(`build=${encodeURIComponent(r.build)}`);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
};

/** Something was staged or a reply draft saved: the cart button says so. Returns the answer unchanged. */
const addedToCart =
  (appId: string) =>
  <T>(answer: T): T => {
    announceCartAdded();
    announceStagedChanged(appId, 'stage');
    return answer;
  };

/** A staged change was removed, discarded or published: every screen that shows staged state reads it again (lib/staged-sync.ts). */
const stagedChanged =
  (appId: string, reason: StagedChangeReason) =>
  <T>(answer: T): T => {
    announceStagedChanged(appId, reason);
    return answer;
  };

export function createApi(options: ApiOptions = {}) {
  const send =
    options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  const requestHeaders = (
    raw: Blob | undefined,
    body: unknown,
    extra: Record<string, string> | undefined,
  ): Record<string, string> | undefined => {
    const headers: Record<string, string> = { ...(extra || {}) };
    // The language of the person, so the server writes emails and notes in it (docs/i18n-server.md). English
    // without a saved choice is what the server assumes anyway, so nothing is sent then.
    const language = currentLocale();
    if (language !== 'pseudo' && (language !== 'en' || readLocalePref() !== null)) {
      headers['accept-language'] = language;
    }
    if (raw) headers['content-type'] = raw.type || 'application/octet-stream';
    else if (body !== undefined) headers['content-type'] = 'application/json';
    return Object.keys(headers).length > 0 ? headers : undefined;
  };

  /** The header a confirmed hard action carries (docs/api/step-up.md). Never in a URL. */
  const grantHeader = (grant?: string): Record<string, string> | undefined =>
    grant ? { 'x-step-up-grant': grant } : undefined;

  /** `raw`: the body is the bytes of a file (an image upload), sent as they are; otherwise `body` is sent as JSON. */
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    raw?: Blob,
    extraHeaders?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      const headers = requestHeaders(raw, body, extraHeaders);
      response = await send(path, {
        method,
        ...(headers ? { headers } : {}),
        ...(raw !== undefined || body !== undefined ? { body: raw ?? JSON.stringify(body) } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch {
      throw new ApiError(
        0,
        'network',
        codedText('http.network') ?? 'Cannot reach the server. Check that it is running.',
      );
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
        code?: unknown;
        params?: unknown;
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
  const asoPath = (workspaceId: string, appId: string) =>
    `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/aso`;
  const adsPath = (workspaceId: string, appId: string) =>
    `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/ads`;
  const insightsPath = (workspaceId: string, appId: string) =>
    `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/insights`;
  const analyticsPath = (workspaceId: string, appId: string) =>
    `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/analytics`;
  const planPath = (workspaceId: string, appId: string, planId: string) =>
    `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/plans/${encodeURIComponent(planId)}`;

  return {
    health: () => request<Health>('GET', '/api/health'),
    /** True on the demo server only (`GET /demo/status` answers `demo: true`); any failure or other answer is false. Reads nothing else. */
    demoStatus: (): Promise<boolean> =>
      request<unknown>('GET', '/demo/status').then(isDemoStatus, () => false),
    status: () => request<AuthStatus>('GET', '/api/auth/status'),
    register: (input: {
      email: string;
      displayName: string;
      password: string;
      workspaceName: string;
    }) => request<{ user: User; workspaceId: string }>('POST', '/api/auth/register', input),
    login: (input: { email: string; password: string }) =>
      request<LoginResult>('POST', '/api/auth/login', input),
    // The second step of signing in (docs/api/two-factor.md): the `challenge` from `login` is the credential for 5 minutes.
    loginSecondFactor: (input: { challenge: string; method: LoginMethod; code: string }) =>
      request<{ user: User }>('POST', '/api/auth/login/two-factor', input),
    loginEmailCode: (challenge: string) =>
      request<CodeSent>('POST', '/api/auth/login/two-factor/email-code', { challenge }),
    loginEnrollTotp: (challenge: string) =>
      request<TotpBegin>('POST', '/api/auth/login/enroll/totp', { challenge }),
    loginEnrollTotpConfirm: (challenge: string, code: string) =>
      request<{ user: User }>('POST', '/api/auth/login/enroll/totp/confirm', { challenge, code }),
    loginEnrollEmail: (challenge: string) =>
      request<CodeSent>('POST', '/api/auth/login/enroll/email', { challenge }),
    loginEnrollEmailConfirm: (challenge: string, code: string) =>
      request<{ user: User }>('POST', '/api/auth/login/enroll/email/confirm', { challenge, code }),
    logout: () => request<void>('POST', '/api/auth/logout'),
    me: () => request<Me>('GET', '/api/me'),
    /** The language of emails the server sends without a request (alerts, the digest); null clears it. */
    setMyLocale: (locale: string | null) =>
      request<{ user: User }>('PATCH', '/api/me', { locale }),
    credentials: (workspaceId: string) =>
      request<{ credentials: CredentialSummary[] }>('GET', `${workspace(workspaceId)}/credentials`),
    addCredential: (workspaceId: string, input: { kind: string; label: string; secret: string }) =>
      request<{ credential: CredentialSummary }>(
        'POST',
        `${workspace(workspaceId)}/credentials`,
        input,
      ),
    replaceSecret: (workspaceId: string, id: string, secret: string) =>
      request<void>('PUT', `${workspace(workspaceId)}/credentials/${encodeURIComponent(id)}`, {
        secret,
      }),
    deleteCredential: (workspaceId: string, id: string, grant?: string) =>
      request<void>(
        'DELETE',
        `${workspace(workspaceId)}/credentials/${encodeURIComponent(id)}`,
        undefined,
        undefined,
        grantHeader(grant),
      ),
    /** Tries a secret against the provider without saving it. */
    testSecret: (workspaceId: string, input: { kind: string; secret: string }) =>
      request<TestResult>('POST', `${workspace(workspaceId)}/credentials/test`, input),
    /** Tries a saved credential and records the outcome on it. */
    testCredential: (workspaceId: string, id: string) =>
      request<TestResult>(
        'POST',
        `${workspace(workspaceId)}/credentials/${encodeURIComponent(id)}/test`,
      ),
    members: (workspaceId: string) =>
      request<{ members: Member[] }>('GET', `${workspace(workspaceId)}/members`),
    changeRole: (workspaceId: string, userId: string, role: string) =>
      request<void>('PATCH', `${workspace(workspaceId)}/members/${encodeURIComponent(userId)}`, {
        role,
      }),
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
      request<AcceptedInvitation>(
        'POST',
        `/api/invitations/${encodeURIComponent(token)}/accept`,
        input,
      ),
    repositories: (workspaceId: string) =>
      request<{ repositories: RepositorySummary[] }>(
        'GET',
        `${workspace(workspaceId)}/repositories`,
      ),
    repository: (workspaceId: string, id: string) =>
      request<RepositoryDetail>(
        'GET',
        `${workspace(workspaceId)}/repositories/${encodeURIComponent(id)}`,
      ),
    connectRepository: (
      workspaceId: string,
      input: { credentialId: string; owner: string; repo: string },
    ) =>
      request<{ repository: RepositorySummary }>(
        'POST',
        `${workspace(workspaceId)}/repositories`,
        input,
      ),
    disconnectRepository: (workspaceId: string, id: string) =>
      request<void>('DELETE', `${workspace(workspaceId)}/repositories/${encodeURIComponent(id)}`),
    // Local clones (docs/adr/0005-local-clone-reads.md). Admin and owner only, except `localConfig`.
    localConfig: (workspaceId: string) =>
      request<{ local: LocalConfig }>('GET', `${workspace(workspaceId)}/repositories/local/config`),
    checkLocalClone: (workspaceId: string, input: { path: string; branch?: string }) =>
      request<{ check: LocalCheck }>(
        'POST',
        `${workspace(workspaceId)}/repositories/local/check`,
        input,
      ),
    connectLocalRepository: (
      workspaceId: string,
      input: { path: string; branch?: string; name?: string },
    ) =>
      request<{ repository: RepositorySummary }>(
        'POST',
        `${workspace(workspaceId)}/repositories/local`,
        input,
      ),
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
      request<RepositoryDetail>(
        'POST',
        `${workspace(workspaceId)}/repositories/${encodeURIComponent(id)}/scan`,
      ),
    repositoryListing: (workspaceId: string, id: string, selection: ListingSelection = {}) => {
      const query = new URLSearchParams();
      if (selection.target) query.set('target', selection.target);
      if (selection.roots?.appStore !== undefined)
        query.set('appStoreRoot', selection.roots.appStore);
      if (selection.roots?.googlePlay !== undefined)
        query.set('googlePlayRoot', selection.roots.googlePlay);
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
    updateListingTarget: (
      workspaceId: string,
      repositoryId: string,
      id: string,
      input: Partial<ListingTargetInput>,
    ) =>
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
      return request<{ changeSets: ChangeSetView[] }>(
        'GET',
        `${workspace(workspaceId)}/change-sets${suffix}`,
      );
    },
    changeSet: (workspaceId: string, id: string) =>
      request<{ changeSet: ChangeSetView }>(
        'GET',
        `${workspace(workspaceId)}/change-sets/${encodeURIComponent(id)}`,
      ),
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
      request<Staleness>(
        'GET',
        `${workspace(workspaceId)}/change-sets/${encodeURIComponent(id)}/staleness`,
      ),
    /**
     * Re-bases a stale change set onto the repository. A conflict is a 409 `refresh_conflicts` (the
     * ApiError's body has the files and their three texts); send `resolutions` per conflicting path.
     */
    refreshChangeSet: (
      workspaceId: string,
      id: string,
      body?: { resolutions?: Record<string, Resolution> },
    ) =>
      request<RefreshResult>(
        'POST',
        `${workspace(workspaceId)}/change-sets/${encodeURIComponent(id)}/refresh`,
        body,
      ),
    /**
     * Adds ONE commit on top of the branch of an applied (or failed) change set: never a rewrite, never
     * forced. A conflict is a 409 `refresh_conflicts` (with the repository) or `fixup_conflicts` (with
     * the branch); the ApiError's body has the files. `dryRun` writes nothing.
     */
    fixupChangeSet: (workspaceId: string, id: string, body: FixupBody = {}) =>
      request<FixupResult>(
        'POST',
        `${workspace(workspaceId)}/change-sets/${encodeURIComponent(id)}/fixup`,
        body,
      ),
    /** Makes a store pull again from the live store listing and the repository as they are now; `refresh` reads the store first. */
    recomputeChangeSet: (workspaceId: string, id: string, body: { refresh?: boolean } = {}) =>
      request<RecomputeResult>(
        'POST',
        `${workspace(workspaceId)}/change-sets/${encodeURIComponent(id)}/recompute`,
        body,
      ),
    /** The managed clone of one repository: size and last use. */
    repositoryClone: (workspaceId: string, id: string) =>
      request<RepositoryClone>(
        'GET',
        `${workspace(workspaceId)}/repositories/${encodeURIComponent(id)}/clone`,
      ),
    /** Admin and owner: the clones of the workspace. */
    clones: (workspaceId: string) =>
      request<CloneReport>('GET', `${workspace(workspaceId)}/clones`),
    /** Admin and owner: removes the clone now (a cache; the next read fetches it again). */
    purgeRepositoryClone: (workspaceId: string, id: string) =>
      request<PurgeResult>(
        'POST',
        `${workspace(workspaceId)}/repositories/${encodeURIComponent(id)}/clone/purge`,
      ),
    discardChangeSet: (workspaceId: string, id: string) =>
      request<{ changeSet: ChangeSetView }>(
        'POST',
        `${workspace(workspaceId)}/change-sets/${encodeURIComponent(id)}/discard`,
      ),
    apps: (workspaceId: string) =>
      request<{ apps: AppSummary[] }>('GET', `${workspace(workspaceId)}/apps`),
    app: (workspaceId: string, id: string) =>
      request<AppDetail>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(id)}`),
    createApp: (workspaceId: string, input: NewApp) =>
      request<{ app: AppSummary }>('POST', `${workspace(workspaceId)}/apps`, input),
    deleteApp: (workspaceId: string, id: string) =>
      request<void>('DELETE', `${workspace(workspaceId)}/apps/${encodeURIComponent(id)}`),
    /** The feeds being read from the stores right now (this server process), and how many store jobs wait. */
    syncActivity: (workspaceId: string) =>
      request<{ apps: { id: string; feeds: { feed: string; since: number }[] }[]; queued: number }>(
        'GET',
        `${workspace(workspaceId)}/sync/activity`,
      ),
    /** The one "Sync" of an app: queues its jobs (critical first) and answers at once with the plan (docs/api/apps.md). `without: 'app'` when the caller ran the app sync itself; `kinds` (and, for analytics, `sources`) when only those are wanted (the page-scoped Sync). */
    syncAppAll: (workspaceId: string, id: string, opts: { without?: 'app'; kinds?: readonly string[]; sources?: readonly string[] } = {}) => {
      const query = new URLSearchParams();
      if (opts.without) query.set('without', opts.without);
      if (opts.kinds && opts.kinds.length > 0) query.set('kinds', opts.kinds.join(','));
      if (opts.sources && opts.sources.length > 0) query.set('sources', opts.sources.join(','));
      const qs = query.toString();
      return request<{ plan: SyncPlanEntry[] }>('POST', `${workspace(workspaceId)}/apps/${encodeURIComponent(id)}/sync-all${qs ? `?${qs}` : ''}`);
    },
    /** Reads the store with the app's credential and replaces the stored snapshot. Can take seconds. */
    syncApp: (workspaceId: string, id: string) =>
      request<SyncResult>('POST', `${workspace(workspaceId)}/apps/${encodeURIComponent(id)}/sync`),
    // Store listing of an app: values from the last syncs, drift against the repository, history.
    // All reads of our own database; only `refreshAppRepoListing` reads GitHub. Nothing writes to a store.
    appListingLive: (workspaceId: string, appId: string) =>
      request<LiveListing>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/listing/live`,
      ),
    appListingDrift: (workspaceId: string, appId: string) =>
      request<ListingDrift>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/listing/drift`,
      ),
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
    plans: (workspaceId: string) =>
      request<{ plans: PlanSummary[] }>('GET', `${workspace(workspaceId)}/plans`),
    appPlans: (workspaceId: string, appId: string) =>
      request<{ plans: PlanSummary[] }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/plans`,
      ),
    plan: (workspaceId: string, appId: string, planId: string) =>
      request<{ plan: PlanDetail }>('GET', `${planPath(workspaceId, appId, planId)}`),
    createPlan: (workspaceId: string, appId: string, input: NewPlan) =>
      request<{ plan: PlanDetail }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/plans`,
        input,
      ),
    updatePlan: (workspaceId: string, appId: string, planId: string, changes: PlanChanges) =>
      request<{ plan: PlanDetail }>('PATCH', planPath(workspaceId, appId, planId), changes),
    deletePlan: (workspaceId: string, appId: string, planId: string) =>
      request<void>('DELETE', planPath(workspaceId, appId, planId)),
    addChecklistItem: (
      workspaceId: string,
      appId: string,
      planId: string,
      input: { text: string; required: boolean },
    ) =>
      request<{ plan: PlanDetail; itemId: string }>(
        'POST',
        `${planPath(workspaceId, appId, planId)}/items`,
        input,
      ),
    updateChecklistItem: (
      workspaceId: string,
      appId: string,
      planId: string,
      itemId: string,
      changes: { text?: string; required?: boolean; done?: boolean },
    ) =>
      request<{ plan: PlanDetail }>(
        'PATCH',
        `${planPath(workspaceId, appId, planId)}/items/${encodeURIComponent(itemId)}`,
        changes,
      ),
    deleteChecklistItem: (workspaceId: string, appId: string, planId: string, itemId: string) =>
      request<{ plan: PlanDetail }>(
        'DELETE',
        `${planPath(workspaceId, appId, planId)}/items/${encodeURIComponent(itemId)}`,
      ),
    reorderChecklist: (workspaceId: string, appId: string, planId: string, order: string[]) =>
      request<{ plan: PlanDetail }>('PUT', `${planPath(workspaceId, appId, planId)}/items/order`, {
        order,
      }),
    applyChecklistTemplate: (
      workspaceId: string,
      appId: string,
      planId: string,
      templateId: string,
    ) =>
      request<{ plan: PlanDetail; added: number; skipped: number }>(
        'POST',
        `${planPath(workspaceId, appId, planId)}/apply-template`,
        {
          templateId,
        },
      ),
    setReleaseNotes: (
      workspaceId: string,
      appId: string,
      planId: string,
      locale: string,
      text: string,
    ) =>
      request<{ plan: PlanDetail }>(
        'PUT',
        `${planPath(workspaceId, appId, planId)}/notes/${encodeURIComponent(locale)}`,
        { text },
      ),
    deleteReleaseNotes: (workspaceId: string, appId: string, planId: string, locale: string) =>
      request<{ plan: PlanDetail }>(
        'DELETE',
        `${planPath(workspaceId, appId, planId)}/notes/${encodeURIComponent(locale)}`,
      ),
    // Staged rollout steps of a plan: planning data only, nothing reaches a store (docs/api/plans.md).
    rollout: (workspaceId: string, appId: string, planId: string) =>
      request<{ rollout: RolloutView }>('GET', `${planPath(workspaceId, appId, planId)}/rollout`),
    setRollout: (workspaceId: string, appId: string, planId: string, body: RolloutBody) =>
      request<{ rollout: RolloutView }>(
        'PUT',
        `${planPath(workspaceId, appId, planId)}/rollout`,
        body,
      ),
    clearRollout: (workspaceId: string, appId: string, planId: string) =>
      request<{ rollout: RolloutView }>(
        'DELETE',
        `${planPath(workspaceId, appId, planId)}/rollout`,
      ),
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
    // Store rollout writes (docs/api/rollout.md): off unless the server sets KILN_STORE_ROLLOUT_ENABLED. State,
    // preview and apply need `releases.rollout` (admin and up); only `rolloutApply` changes a store, once,
    // with the `confirmHash` of a preview. `query` is `stateQuery(base)` of lib/store-rollout.ts.
    rolloutConfig: (workspaceId: string) =>
      request<RolloutConfig>('GET', `${workspace(workspaceId)}/rollout/config`),
    rolloutState: (workspaceId: string, appId: string, query = '') =>
      request<RolloutStateView>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/rollout/state${query ? `?${query}` : ''}`,
      ),
    rolloutPreview: (workspaceId: string, appId: string, body: RolloutRequest) =>
      request<{ preview: RolloutPreview }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/rollout/preview`,
        body,
      ),
    rolloutApply: (
      workspaceId: string,
      appId: string,
      body: RolloutRequest & { confirmHash: string },
      grant?: string,
    ) =>
      request<{ result: RolloutResult }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/rollout/apply`,
        body,
        undefined,
        grantHeader(grant),
      ),
    checklistTemplates: (workspaceId: string) =>
      request<{ templates: ChecklistTemplate[] }>(
        'GET',
        `${workspace(workspaceId)}/checklist-templates`,
      ),
    createChecklistTemplate: (
      workspaceId: string,
      input: { name: string; items: { text: string; required: boolean }[] },
    ) =>
      request<{ template: ChecklistTemplate }>(
        'POST',
        `${workspace(workspaceId)}/checklist-templates`,
        input,
      ),
    deleteChecklistTemplate: (workspaceId: string, id: string) =>
      request<void>(
        'DELETE',
        `${workspace(workspaceId)}/checklist-templates/${encodeURIComponent(id)}`,
      ),
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
      request<AppBuilds>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/builds`,
      ),
    /** Builds to test: the CI artifacts of the runs of an app and its store builds (docs/api/builds.md). Needs the member role. */
    buildArtifacts: (workspaceId: string, appId: string) =>
      request<BuildsList>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/builds/artifacts`,
      ),
    /** A link a phone can open without signing in: ten minutes, once. Needs `builds.download` and the server switch. */
    createBuildLink: (workspaceId: string, appId: string, artifactId: string) =>
      request<DownloadLink>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/builds/artifacts/${encodeURIComponent(artifactId)}/link`,
      ),
    /** Google Play internal app sharing (docs/api/internal-sharing.md): whether the server offers it, and the limits. Needs `builds.read`. */
    internalSharingConfig: (workspaceId: string) =>
      request<InternalSharingConfig>(
        'GET',
        `${workspace(workspaceId)}/builds/internal-sharing/config`,
      ),
    /** What would be uploaded. Nothing is downloaded and Google is not contacted. Needs `builds.share`. */
    internalSharePreview: (
      workspaceId: string,
      appId: string,
      artifactId: string,
      entry?: string,
    ) =>
      request<{ preview: SharePreview }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/builds/artifacts/${encodeURIComponent(artifactId)}/internal-share/preview`,
        entry ? { entry } : {},
      ),
    /** The upload. A store write: needs the preview's confirmHash, the typed phrase and (policy on) a step-up grant. */
    internalShareApply: (
      workspaceId: string,
      appId: string,
      artifactId: string,
      body: { confirmHash: string; confirmation: string; entry?: string },
      grant?: string,
    ) =>
      request<{ result: ShareResult }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/builds/artifacts/${encodeURIComponent(artifactId)}/internal-share`,
        body,
        undefined,
        grantHeader(grant),
      ),
    /** The commits between a build and the one before it (or `base`). Reads GitHub. */
    buildChanges: (
      workspaceId: string,
      appId: string,
      build: { platform: string; buildNumber: string; base?: string },
    ) => {
      const query = new URLSearchParams({ platform: build.platform, build: build.buildNumber });
      if (build.base) query.set('base', build.base);
      return request<BuildChanges>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/builds/changes?${query.toString()}`,
      );
    },
    linkBuild: (
      workspaceId: string,
      appId: string,
      build: { platform: string; buildNumber: string },
      runId: string,
    ) =>
      request<{ build: AppBuild }>(
        'PUT',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/builds/${encodeURIComponent(build.platform)}/${encodeURIComponent(build.buildNumber)}/link`,
        { runId },
      ),
    /** Reads the runs, tags and releases from GitHub again and matches this app's builds. Needs the right of a scan. */
    rematchBuilds: (workspaceId: string, appId: string) =>
      request<RematchedBuilds>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/builds/rematch`,
      ),
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
      input: {
        appId?: string;
        tagPatterns: string[];
        releasePatterns: string[];
        prefix: string;
        workflow: string | null;
      },
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
    unlinkBuild: (
      workspaceId: string,
      appId: string,
      build: { platform: string; buildNumber: string },
    ) =>
      request<{ build: AppBuild | null }>(
        'DELETE',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/builds/${encodeURIComponent(build.platform)}/${encodeURIComponent(build.buildNumber)}/link`,
      ),
    audit: (workspaceId: string, limit = 100) =>
      request<{ events: AuditEvent[] }>('GET', `${workspace(workspaceId)}/audit?limit=${limit}`),
    // The MCP server for AI assistants: whether it is on and which tools it offers (owners and admins). docs/api/mcp.md
    mcpStatus: (workspaceId: string) =>
      request<McpStatus>('GET', `${workspace(workspaceId)}/mcp/status`),
    // API tokens. The token is in the answer to `createApiToken` and nowhere else.
    apiTokens: (workspaceId: string) =>
      request<{ tokens: ApiToken[] }>('GET', `${workspace(workspaceId)}/tokens`),
    createApiToken: (
      workspaceId: string,
      input: {
        name: string;
        role: string;
        appIds?: string[];
        actions?: string[];
        expiresAt?: number;
      },
    ) => request<CreatedApiToken>('POST', `${workspace(workspaceId)}/tokens`, input),
    revokeApiToken: (workspaceId: string, id: string) =>
      request<void>('DELETE', `${workspace(workspaceId)}/tokens/${encodeURIComponent(id)}`),
    // Alerts (docs/api/alerts.md): the inbox, a person's own choices, the workspace rules, the delivery log.
    alertCatalog: (workspaceId: string) =>
      request<{ catalog: CatalogEntry[] }>('GET', `${workspace(workspaceId)}/alerts/catalog`),
    alertInbox: (
      workspaceId: string,
      query: { unread?: boolean; limit?: number; before?: number } = {},
    ) => {
      const q = [
        query.unread ? 'unread=1' : '',
        query.limit ? `limit=${query.limit}` : '',
        query.before !== undefined ? `before=${query.before}` : '',
      ].filter(Boolean);
      return request<AlertInboxPage>(
        'GET',
        `${workspace(workspaceId)}/alerts/inbox${q.length ? `?${q.join('&')}` : ''}`,
      );
    },
    markAlertsRead: (workspaceId: string, body: { ids: string[] } | { all: true }) =>
      request<{ marked: number; unreadCount: number }>(
        'POST',
        `${workspace(workspaceId)}/alerts/inbox/read`,
        body,
      ),
    alertSettings: (workspaceId: string) =>
      request<SettingsPage>('GET', `${workspace(workspaceId)}/alerts/settings`),
    updateAlertSettings: (workspaceId: string, body: Partial<Omit<UserSettings, 'lastDigestAt'>>) =>
      request<{ settings: UserSettings }>('PUT', `${workspace(workspaceId)}/alerts/settings`, body),
    setAlertPreference: (
      workspaceId: string,
      alertType: string,
      body: { appId?: string | null; channels: AlertChannel[] | null },
    ) =>
      request<{ preference: Preference | null }>(
        'PUT',
        `${workspace(workspaceId)}/alerts/preferences/${encodeURIComponent(alertType)}`,
        body,
      ),
    createAlertMute: (
      workspaceId: string,
      body: { appId?: string | null; alertType?: string | null; hours?: number },
    ) => request<{ mute: Mute }>('POST', `${workspace(workspaceId)}/alerts/mutes`, body),
    deleteAlertMute: (workspaceId: string, id: string) =>
      request<void>('DELETE', `${workspace(workspaceId)}/alerts/mutes/${encodeURIComponent(id)}`),
    setAlertRule: (
      workspaceId: string,
      alertType: string,
      body: {
        enabled?: boolean;
        channels?: AlertChannel[];
        maxPerHour?: number | null;
        params?: Record<string, number>;
      },
    ) =>
      request<{ rule: RuleView }>(
        'PUT',
        `${workspace(workspaceId)}/alerts/rules/${encodeURIComponent(alertType)}`,
        body,
      ),
    resetAlertRule: (workspaceId: string, alertType: string) =>
      request<{ rule: RuleView }>(
        'DELETE',
        `${workspace(workspaceId)}/alerts/rules/${encodeURIComponent(alertType)}`,
      ),
    alertDeliveries: (workspaceId: string, query: { workspace?: boolean; limit?: number } = {}) =>
      request<{ deliveries: Delivery[] }>(
        'GET',
        `${workspace(workspaceId)}/alerts/deliveries?limit=${query.limit ?? 30}${query.workspace ? '&scope=workspace' : ''}`,
      ),
    sendTestAlert: (workspaceId: string, channel: AlertChannel) =>
      request<AlertTestResult>('POST', `${workspace(workspaceId)}/alerts/test`, { channel }),
    // Webhooks. The secret is in the answers to `createWebhook` and `rotateWebhookSecret` only.
    webhooks: (workspaceId: string) =>
      request<{ webhooks: WebhookEndpoint[] }>('GET', `${workspace(workspaceId)}/webhooks`),
    createWebhook: (
      workspaceId: string,
      input: { url: string; description?: string; eventTypes: string[]; enabled?: boolean },
    ) => request<CreatedWebhook>('POST', `${workspace(workspaceId)}/webhooks`, input),
    updateWebhook: (workspaceId: string, id: string, patch: Record<string, unknown>) =>
      request<{ webhook: WebhookEndpoint }>(
        'PATCH',
        `${workspace(workspaceId)}/webhooks/${encodeURIComponent(id)}`,
        patch,
      ),
    deleteWebhook: (workspaceId: string, id: string) =>
      request<void>('DELETE', `${workspace(workspaceId)}/webhooks/${encodeURIComponent(id)}`),
    rotateWebhookSecret: (workspaceId: string, id: string) =>
      request<{ secret: string }>(
        'POST',
        `${workspace(workspaceId)}/webhooks/${encodeURIComponent(id)}/rotate-secret`,
      ),
    testWebhook: (workspaceId: string, id: string) =>
      request<{ deliveryId: string }>(
        'POST',
        `${workspace(workspaceId)}/webhooks/${encodeURIComponent(id)}/test`,
      ),
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
    // Chat destinations (Slack, Teams). The webhook address is sent when saving and never comes back (only its last four characters).
    chatDestinations: (workspaceId: string) =>
      request<{ destinations: ChatDestination[] }>('GET', `${workspace(workspaceId)}/chat/destinations`),
    createChatDestination: (workspaceId: string, input: Record<string, unknown>) =>
      request<{ destination: ChatDestination }>('POST', `${workspace(workspaceId)}/chat/destinations`, input),
    updateChatDestination: (workspaceId: string, id: string, patch: Record<string, unknown>) =>
      request<{ destination: ChatDestination }>(
        'PATCH',
        `${workspace(workspaceId)}/chat/destinations/${encodeURIComponent(id)}`,
        patch,
      ),
    setChatRoutes: (workspaceId: string, id: string, routes: Record<string, unknown>[]) =>
      request<{ destination: ChatDestination }>(
        'PUT',
        `${workspace(workspaceId)}/chat/destinations/${encodeURIComponent(id)}/routes`,
        { routes },
      ),
    deleteChatDestination: (workspaceId: string, id: string) =>
      request<void>('DELETE', `${workspace(workspaceId)}/chat/destinations/${encodeURIComponent(id)}`),
    testChatDestination: (workspaceId: string, id: string) =>
      request<{ deliveryId: string }>(
        'POST',
        `${workspace(workspaceId)}/chat/destinations/${encodeURIComponent(id)}/test`,
      ),
    chatDeliveries: (workspaceId: string, id: string, limit = 30) =>
      request<{ deliveries: ChatDelivery[] }>(
        'GET',
        `${workspace(workspaceId)}/chat/destinations/${encodeURIComponent(id)}/deliveries?limit=${limit}`,
      ),
    // Media files of the app's repository (docs/api/assets.md). Read-only. The images themselves
    // are loaded by the browser from `assetFileUrl` (lib/assets.ts), not through this client.
    appAssets: (workspaceId: string, appId: string) =>
      request<AssetIndex>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/assets`,
      ),
    // Staged listing changes and pushing them to a store as a DRAFT (docs/api/staged-changes.md). Staging,
    // unstaging and clearing change our own database only. `pushStagedDraft` is the one call that writes to a
    // store (the editable draft; it never submits), is sent once with the preview's hash, and is never retried.
    storeDraftConfig: (workspaceId: string) =>
      request<StoreDraftConfig>('GET', `${workspace(workspaceId)}/store-draft/config`),
    appStaged: (workspaceId: string, appId: string) =>
      request<{ staged: StagedChangesView }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged`,
      ),
    stageText: (
      workspaceId: string,
      appId: string,
      body: { locale: string; field: string; from: 'local' | 'repo' | 'store'; value?: string },
    ) =>
      request<{ staged: StagedChangesView }>(
        'PUT',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged/text`,
        body,
      ).then(addedToCart(appId)),
    listingFixes: (workspaceId: string, appId: string) =>
      request<ListingFixesView>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/listing/fixes`),
    stageListingFix: (
      workspaceId: string,
      appId: string,
      body: { locale: string; field: string; fixId: string; beforeHash?: string },
    ) =>
      request<{ staged: StagedChangesView }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/listing/fixes/stage`,
        body,
      ).then(addedToCart(appId)),
    /** The store assets that changed in the repository since the previous release (docs/api/release-asset-proposal.md). Reads; stages nothing. */
    releaseAssetProposal: (workspaceId: string, appId: string, release: ReleaseAssetRef, signal?: AbortSignal) =>
      request<{ proposal: AssetProposalView }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/release/asset-proposal${releaseAssetQuery(release)}`,
        undefined,
        undefined,
        undefined,
        signal,
      ),
    /** The count only, cached on the server (the Releases list): "3 store asset changes proposed". Never the proposal itself. */
    releaseAssetProposalSummary: (workspaceId: string, appId: string) =>
      request<{ summary: ProposalSummary }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/release/asset-proposal/summary`,
      ),
    stageReleaseAssetProposal: (
      workspaceId: string,
      appId: string,
      body: ReleaseAssetRef & { itemIds: string[]; acceptIssues?: boolean },
      signal?: AbortSignal,
    ) =>
      request<{ results: { id: string; status: string; code?: string }[]; proposal?: AssetProposalView }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/release/asset-proposal/stage`,
        body,
        undefined,
        undefined,
        signal,
      ).then(addedToCart(appId)),
    decideReleaseAssetProposal: (workspaceId: string, appId: string, body: { version?: string | null; track?: string | null; mode: 'skip' | 'later' | 'reopen' }, signal?: AbortSignal) =>
      request<{ state: ProposalState }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/release/asset-proposal/dismiss`,
        body,
        undefined,
        undefined,
        signal,
      ),
    stageAssets: (
      workspaceId: string,
      appId: string,
      body: {
        locale: string;
        kind: string;
        device?: string | null;
        from?: 'repo';
        paths?: string[];
        commit?: string;
      },
    ) =>
      request<{ staged: StagedChangesView }>(
        'PUT',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged/assets`,
        body,
      ).then(addedToCart(appId)),
    // Two way sync of the graphics (docs/api/assets.md, docs/api/staged-changes.md). Reading a store and the comparison
    // change nothing in it. A pull and "to repository" make a DRAFT change set; uploads, removals and fixes change only
    // the staged set in our own database. Nothing here writes to a store: that is `pushStagedDraft`.
    appStoreImages: (workspaceId: string, appId: string, fresh = false) =>
      request<{ store: StoreImagesView; cached: boolean }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/assets/store${fresh ? '?fresh=1' : ''}`,
      ),
    appAssetDiff: (workspaceId: string, appId: string, fresh = false, signal?: AbortSignal) =>
      request<{ diff: AssetDiffView; cachedStore: boolean }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/assets/diff${fresh ? '?fresh=1' : ''}`,
        undefined,
        undefined,
        undefined,
        signal,
      ),
    pullStoreImages: (workspaceId: string, appId: string, selection: PullSelection) =>
      request<{ pull: PullReport }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/assets/pull`,
        selection,
      ),
    inspectAssetFile: (workspaceId: string, appId: string, query: UploadQuery, file: Blob) =>
      request<{ inspected: InspectedFile }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/assets/inspect?${uploadQueryText(query)}`,
        undefined,
        file,
      ),
    uploadStagedAsset: (workspaceId: string, appId: string, query: UploadQuery, file: Blob) =>
      request<{ staged: StagedChangesView; position: number }>(
        'PUT',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged/assets/upload?${uploadQueryText(query)}`,
        undefined,
        file,
      ).then(addedToCart(appId)),
    removeStagedAssetFile: (
      workspaceId: string,
      appId: string,
      query: UploadQuery & { position: number },
    ) =>
      request<{ staged: StagedChangesView }>(
        'DELETE',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged/assets/file?${uploadQueryText(query)}`,
      ).then(addedToCart(appId)),
    moveStagedAssetFile: (
      workspaceId: string,
      appId: string,
      body: { locale: string; kind: string; device: string | null; from: number; to: number; base?: 'store' },
    ) =>
      request<{ staged: StagedChangesView }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged/assets/move`,
        body,
      ).then(addedToCart(appId)),
    fixStagedAssetFile: (
      workspaceId: string,
      appId: string,
      body: {
        locale: string;
        kind: string;
        device: string | null;
        position: number;
        fix: string;
        background?: string;
      },
    ) =>
      request<{ staged: StagedChangesView; summary: string }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged/assets/fix`,
        body,
      ),
    stagedAssetsToRepo: (workspaceId: string, appId: string, sets?: string[]) =>
      request<{ result: ToRepoResult }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged/assets/to-repo`,
        sets ? { sets } : {},
      ),
    unstageItem: (workspaceId: string, appId: string, id: string) =>
      request<{ staged: StagedChangesView }>(
        'DELETE',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged/items?id=${encodeURIComponent(id)}`,
      ).then(stagedChanged(appId, 'unstage')),
    clearStaged: (workspaceId: string, appId: string) =>
      request<{ staged: StagedChangesView }>(
        'DELETE',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged`,
      ).then(stagedChanged(appId, 'discard')),
    previewStagedPush: (workspaceId: string, appId: string) =>
      request<{ preview: DraftPreview }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged/push/preview`,
        {},
      ),
    pushStagedDraft: (workspaceId: string, appId: string, confirmHash: string, grant?: string) =>
      request<{ result: DraftPushResult }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged/push`,
        { confirmHash },
        undefined,
        grantHeader(grant),
      ).then(stagedChanged(appId, 'publish')),
    // Submitting the pushed draft for store review (docs/api/submit.md): a SEPARATE, IRREVERSIBLE store write,
    // off by default. `config` and `appStoreSubmit` read our own database; `previewStoreSubmit` reads the store.
    // `storeSubmit` is the only call that writes: sent once with the preview's hash and the typed phrase, and
    // never retried by this app (not on an error, a timeout or a lost answer).
    storeSubmitConfig: (workspaceId: string) =>
      request<StoreSubmitConfig>('GET', `${workspace(workspaceId)}/store-submit/config`),
    appStoreSubmit: (workspaceId: string, appId: string) =>
      request<{ submit: SubmitState }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/store-submit`,
      ),
    previewStoreSubmit: (workspaceId: string, appId: string) =>
      request<{ preview: SubmitPreview }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/store-submit/preview`,
        {},
      ),
    storeSubmit: (
      workspaceId: string,
      appId: string,
      body: { confirmHash: string; confirmation: string },
      grant?: string,
    ) =>
      request<{ result: SubmitResult }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/store-submit`,
        body,
        undefined,
        grantHeader(grant),
      ),
    // Preparing a release (docs/api/releases-write.md): reads of the store for the build picker, the draft and the
    // earlier notes; staging is the existing staged route and writes nothing to a store.
    releaseCandidates: (
      workspaceId: string,
      appId: string,
      query: { track?: string; version?: string } = {},
    ) => {
      const q = new URLSearchParams();
      if (query.track) q.set('track', query.track);
      if (query.version) q.set('version', query.version);
      const text = q.toString();
      return request<{ candidates: ReleaseCandidates }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/release/candidates${text ? `?${text}` : ''}`,
      );
    },
    releaseEditable: (workspaceId: string, appId: string, track?: string) =>
      request<{ editable: EditableRelease }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/release/editable${track ? `?track=${encodeURIComponent(track)}` : ''}`,
      ),
    // "Check with Google Play": asks Google whether a proposed release would be refused. Saves nothing (the server deletes its edit).
    checkPlayRelease: (workspaceId: string, appId: string, body: PlayCheckBody) =>
      request<{ check: PlayCheckAnswer }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/release/play-check`,
        body,
      ),
    releaseNotesHistory: (
      workspaceId: string,
      appId: string,
      query: {
        platform?: string;
        locale?: string;
        limit?: number;
        track?: string;
        codes?: string[];
      } = {},
    ) => {
      const q = new URLSearchParams();
      if (query.platform) q.set('platform', query.platform);
      if (query.locale) q.set('locale', query.locale);
      if (query.limit) q.set('limit', String(query.limit));
      if (query.track) q.set('track', query.track);
      if (query.codes && query.codes.length > 0) q.set('codes', query.codes.join(','));
      const text = q.toString();
      return request<{ history: NotesHistory }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/release/notes-history${text ? `?${text}` : ''}`,
      );
    },
    // Translates one text into other languages (machine or AI) and returns the texts. Nothing is stored, staged or sent to a store.
    translateReleaseNotes: (workspaceId: string, appId: string, body: TranslateNotesBody) =>
      request<TranslateNotesResult>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/release-notes/translate`,
        body,
      ),
    /** Stages one release field (a build, a version, a track, ...). Nothing reaches a store. */
    stageReleaseField: (
      workspaceId: string,
      appId: string,
      body: { field: string; locale?: string; value: string },
    ) =>
      request<{ staged: StagedChangesView }>(
        'PUT',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/staged/release-fields`,
        body,
      ).then(addedToCart(appId)),
    // The release pipeline (docs/api/release-pipeline.md): reads of our own database.
    releasePipeline: (workspaceId: string, appId: string) =>
      request<AppPipeline>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/release/pipeline`,
      ),
    releasePipelineSummary: (workspaceId: string) =>
      request<PipelineSummary>('GET', `${workspace(workspaceId)}/release/pipeline/summary`),
    // Releasing (docs/api/releases-write.md): a SEPARATE, IRREVERSIBLE store write, off by default. Like submit:
    // `storeRelease` is sent once with the preview's hash and the typed phrase, and never retried by this app.
    storeReleaseConfig: (workspaceId: string) =>
      request<StoreReleaseConfig>('GET', `${workspace(workspaceId)}/store-release/config`),
    appStoreRelease: (workspaceId: string, appId: string) =>
      request<{ release: StoreReleaseState }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/store-release`,
      ),
    previewStoreRelease: (workspaceId: string, appId: string, body: ReleaseBody) =>
      request<{ preview: ReleasePreview }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/store-release/preview`,
        body,
      ),
    storeRelease: (
      workspaceId: string,
      appId: string,
      body: ReleaseBody & { confirmHash: string; confirmation: string },
      grant?: string,
    ) =>
      request<{ result: ReleaseResult }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/store-release`,
        body,
        undefined,
        grantHeader(grant),
      ),
    // Creating the next App Store version (docs/api/store-version.md): a reversible draft write behind the draft-write switch.
    // `createStoreVersion` is sent once with the preview's hash and never retried by this app.
    previewStoreVersion: (workspaceId: string, appId: string, body: { versionString: string }) =>
      request<{ preview: VersionPreview }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/store-version/preview`,
        body,
      ),
    createStoreVersion: (
      workspaceId: string,
      appId: string,
      body: { versionString: string; confirmHash: string },
      grant?: string,
    ) =>
      request<{ result: VersionResult }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/store-version`,
        body,
        undefined,
        grantHeader(grant),
      ),
    // Everything pending, and publishing it in one go (docs/api/pending.md, docs/adr/0015-pending-and-batch-publish.md). The two
    // pending reads and the config read our own database only. `previewPublish` reads the stores (a plan, no write).
    // `publishPending` is the only call that writes: sent once with the plan's hash and the typed phrase, never retried by this app.
    // The pending cart (docs/api/pending.md#the-pending-cart): the read is stored state; publish sends only the named items, discard
    // removes Kiln's draft only. Neither is ever retried by this app.
    appPendingCart: (workspaceId: string, appId: string) =>
      request<CartResponse>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/pending/cart`,
      ),
    /** The full before and after of one cart item, for the row preview (docs/api/pending.md, ADR 0067). Stored state only. */
    appPendingCartDetail: (workspaceId: string, appId: string, id: string) =>
      request<{ detail: CartDetail }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/pending/cart/detail?id=${encodeURIComponent(id)}`,
      ),
    /** What one pending item that is not a staged change contains (pushed draft, draft release, version in review or approved, due rollout step). Stored state only. */
    appPendingItemDetail: (workspaceId: string, appId: string, kind: string, id: string) =>
      request<{ detail: PendingItemDetail }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/pending/detail?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`,
      ),
    publishPendingCart: (
      workspaceId: string,
      appId: string,
      items: { id: string; version: string }[],
      grant?: string,
      /** The phrase typed for price items (`CHANGE 3 PRICES MAX 42%`); left out when nothing priced is sent. */
      confirmation?: string,
    ) =>
      request<CartResultResponse>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/pending/publish`,
        confirmation === undefined ? { items } : { items, confirmation },
        undefined,
        grantHeader(grant),
      ).then(stagedChanged(appId, 'publish')),
    discardPendingCart: (workspaceId: string, appId: string, ids: string[]) =>
      request<CartResultResponse>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/pending/discard`,
        { ids },
      ).then(stagedChanged(appId, 'discard')),
    appPending: (workspaceId: string, appId: string) =>
      request<{ pending: PendingView }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/pending`,
      ),
    /** The count behind the "Pending" badge: apps with something in their cart and how many items, no payload (ADR 0064). */
    pendingCartSummary: (workspaceId: string) =>
      request<CartSummary>('GET', `${workspace(workspaceId)}/pending/cart-summary`),
    pendingSummary: (workspaceId: string) =>
      request<PendingSummary>('GET', `${workspace(workspaceId)}/pending/summary`),
    storePublishConfig: (workspaceId: string) =>
      request<PublishConfig>('GET', `${workspace(workspaceId)}/store-publish/config`),
    previewPublish: (workspaceId: string, appId: string, body: { steps?: StepRequest[] } = {}) =>
      request<{ plan: PublishPlan }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/publish/preview`,
        body,
      ),
    publishPending: (
      workspaceId: string,
      appId: string,
      body: { planHash: string; steps: StepRequest[]; phrase?: string },
      grant?: string,
    ) =>
      request<{ result: PublishResult }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/publish`,
        body,
        undefined,
        grantHeader(grant),
      ),
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
      request<ReviewSyncOutcome>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/reviews/sync`,
      ),
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
    workspaceSettings: (workspaceId: string) =>
      request<SettingsResponse>('GET', `${workspace(workspaceId)}/settings`),
    updateWorkspaceSettings: (
      workspaceId: string,
      changes: Record<string, SettingValue>,
      grant?: string,
    ) =>
      request<SettingsUpdateResponse>(
        'PUT',
        `${workspace(workspaceId)}/settings`,
        changes,
        undefined,
        grantHeader(grant),
      ),
    // Step-up confirmation (docs/api/step-up.md). The passkey calls move base64url JSON; `lib/step-up.ts` converts it.
    stepUpStatus: (workspaceId: string) =>
      request<StepUpStatus>('GET', `${workspace(workspaceId)}/step-up/status`),
    stepUpRegisterOptions: (workspaceId: string) =>
      request<{ challengeId: string; publicKey: Record<string, unknown> }>(
        'POST',
        `${workspace(workspaceId)}/step-up/passkeys/register/options`,
        {},
      ),
    stepUpRegisterVerify: (
      workspaceId: string,
      body: {
        challengeId: string;
        name: string;
        credential: {
          id: string;
          clientDataJSON: string;
          attestationObject: string;
          transports?: string[];
        };
      },
      grant?: string,
    ) =>
      request<{ passkey: { id: string; name: string } }>(
        'POST',
        `${workspace(workspaceId)}/step-up/passkeys/register/verify`,
        body,
        undefined,
        grantHeader(grant),
      ),
    stepUpDeletePasskey: (workspaceId: string, id: string, grant?: string) =>
      request<void>(
        'DELETE',
        `${workspace(workspaceId)}/step-up/passkeys/${encodeURIComponent(id)}`,
        undefined,
        undefined,
        grantHeader(grant),
      ),
    stepUpSetPassword: (workspaceId: string, password: string, grant?: string) =>
      request<void>(
        'PUT',
        `${workspace(workspaceId)}/step-up/confirmation-password`,
        { password },
        undefined,
        grantHeader(grant),
      ),
    stepUpAssertionOptions: (
      workspaceId: string,
      body: { action: StepUpAction | 'step_up.manage'; target?: StepUpTarget },
    ) =>
      request<{ challengeId: string; publicKey: Record<string, unknown> }>(
        'POST',
        `${workspace(workspaceId)}/step-up/passkeys/assertion/options`,
        body,
      ),
    stepUpVerify: (
      workspaceId: string,
      body:
        | { factor: 'password'; action: string; target?: StepUpTarget; password: string }
        | { factor: 'recovery'; action: string; target?: StepUpTarget; code: string }
        | { factor: 'totp' | 'email'; action: string; target?: StepUpTarget; code: string }
        | {
            factor: 'passkey';
            action: string;
            target?: StepUpTarget;
            challengeId: string;
            assertion: {
              id: string;
              clientDataJSON: string;
              authenticatorData: string;
              signature: string;
            };
          },
    ) =>
      request<{ grant: string; expiresAt: number }>(
        'POST',
        `${workspace(workspaceId)}/step-up/verify`,
        body,
      ),
    /** Ten new one-time codes; any older ones stop working. The codes are in this answer only. Needs a confirmation (`step_up.manage`). */
    stepUpMakeRecoveryCodes: (workspaceId: string, grant?: string) =>
      request<{ codes: string[]; remaining: number; generatedAt: number }>(
        'POST',
        `${workspace(workspaceId)}/step-up/recovery-codes`,
        {},
        undefined,
        grantHeader(grant),
      ),
    // Authenticator app, emailed codes and mail settings (docs/api/two-factor.md, docs/api/mail.md). Changes carry a step-up grant.
    twoFactorStatus: (workspaceId: string) =>
      request<TwoFactorStatus>('GET', `${workspace(workspaceId)}/two-factor/status`),
    twoFactorTotpBegin: (workspaceId: string, grant?: string) =>
      request<TotpBegin>(
        'POST',
        `${workspace(workspaceId)}/two-factor/totp/begin`,
        {},
        undefined,
        grantHeader(grant),
      ),
    twoFactorTotpConfirm: (workspaceId: string, code: string) =>
      request<{ totp: TotpStatus }>('POST', `${workspace(workspaceId)}/two-factor/totp/confirm`, {
        code,
      }),
    twoFactorTotpRemove: (workspaceId: string, grant?: string) =>
      request<void>(
        'DELETE',
        `${workspace(workspaceId)}/two-factor/totp`,
        undefined,
        undefined,
        grantHeader(grant),
      ),
    twoFactorEmailBegin: (workspaceId: string, email?: string, grant?: string) =>
      request<CodeSent>(
        'POST',
        `${workspace(workspaceId)}/two-factor/email/begin`,
        email ? { email } : {},
        undefined,
        grantHeader(grant),
      ),
    twoFactorEmailConfirm: (workspaceId: string, code: string) =>
      request<unknown>('POST', `${workspace(workspaceId)}/two-factor/email/confirm`, { code }),
    twoFactorEmailRemove: (workspaceId: string, grant?: string) =>
      request<void>(
        'DELETE',
        `${workspace(workspaceId)}/two-factor/email`,
        undefined,
        undefined,
        grantHeader(grant),
      ),
    stepUpEmailCode: (workspaceId: string, body: { action: string; target?: StepUpTarget }) =>
      request<CodeSent>('POST', `${workspace(workspaceId)}/step-up/email-code`, body),
    twoFactorSetPolicy: (workspaceId: string, mode: LoginMode, grant?: string) =>
      request<{ mode: LoginMode; membersWithoutSecondFactor: number }>(
        'PUT',
        `${workspace(workspaceId)}/two-factor/policy`,
        { mode },
        undefined,
        grantHeader(grant),
      ),
    twoFactorResetMember: (workspaceId: string, userId: string, grant?: string) =>
      request<void>(
        'DELETE',
        `${workspace(workspaceId)}/two-factor/members/${encodeURIComponent(userId)}`,
        undefined,
        undefined,
        grantHeader(grant),
      ),
    mailSettings: (workspaceId: string) =>
      request<SmtpSettings>('GET', `${workspace(workspaceId)}/mail/settings`),
    mailSaveSettings: (workspaceId: string, body: SmtpInput, grant?: string) =>
      request<SmtpSettings>(
        'PUT',
        `${workspace(workspaceId)}/mail/settings`,
        body,
        undefined,
        grantHeader(grant),
      ),
    mailClearSettings: (workspaceId: string, grant?: string) =>
      request<SmtpSettings>(
        'DELETE',
        `${workspace(workspaceId)}/mail/settings`,
        undefined,
        undefined,
        grantHeader(grant),
      ),
    mailSendTest: (workspaceId: string, to?: string) =>
      request<MailTestResult>('POST', `${workspace(workspaceId)}/mail/test`, to ? { to } : {}),
    stepUpSetPolicy: (
      workspaceId: string,
      body: { mode: 'off' | 'hard_actions'; actions?: StepUpAction[]; unattended?: StepUpAction[] },
      grant?: string,
    ) =>
      request<{ policy: StepUpStatus['policy']; enrolled: boolean }>(
        'PUT',
        `${workspace(workspaceId)}/step-up/policy`,
        body,
        undefined,
        grantHeader(grant),
      ),
    testTranslation: (workspaceId: string) =>
      request<TranslationTestOutcome>('POST', `${workspace(workspaceId)}/translate/test`),
    translateReviews: (
      workspaceId: string,
      appId: string,
      body: { reviewIds: string[]; target?: string },
    ) =>
      request<TranslateReviewsResult>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/reviews/translate`,
        body,
      ),
    // Replying to reviews (docs/adr/0007-review-replies.md): the only calls here that can publish
    // something in a store are `sendReviewReply`, one review at a time, with the hash of the draft.
    reviewReplyConfig: (workspaceId: string) =>
      request<ReplyConfig>('GET', `${workspace(workspaceId)}/reviews/reply-config`),
    review: (workspaceId: string, appId: string, reviewId: string) =>
      request<{ review: Review }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/reviews/${encodeURIComponent(reviewId)}`,
      ),
    saveReplyDraft: (
      workspaceId: string,
      appId: string,
      reviewId: string,
      body: { text: string } | { templateId: string },
    ) =>
      request<{ draft: ReplyDraft }>(
        'PUT',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/reviews/${encodeURIComponent(reviewId)}/reply-draft`,
        body,
      ).then(addedToCart(appId)),
    deleteReplyDraft: (workspaceId: string, appId: string, reviewId: string) =>
      request<void>(
        'DELETE',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/reviews/${encodeURIComponent(reviewId)}/reply-draft`,
      ).then(stagedChanged(appId, 'discard')),
    translateReplyDraft: (
      workspaceId: string,
      appId: string,
      reviewId: string,
      body: { text: string; target: string; source?: string },
    ) =>
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
      request<{ templates: ReplyTemplate[] }>(
        'GET',
        `${workspace(workspaceId)}/reviews/reply-templates`,
      ),
    createReplyTemplate: (workspaceId: string, body: { name: string; body: string }) =>
      request<{ template: ReplyTemplate }>(
        'POST',
        `${workspace(workspaceId)}/reviews/reply-templates`,
        body,
      ),
    deleteReplyTemplate: (workspaceId: string, id: string) =>
      request<void>(
        'DELETE',
        `${workspace(workspaceId)}/reviews/reply-templates/${encodeURIComponent(id)}`,
      ),
    // Per-app release settings of Google Play (docs/api/releases-write.md): default share, staged rollout mode. Stored values, no store call.
    appReleaseSettings: (workspaceId: string, appId: string) =>
      request<ReleaseSettingsView>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/release-settings`,
      ),
    appListingSettings: (workspaceId: string, appId: string) =>
      request<{ settings: AppListingSettings }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/listing-settings`,
      ),
    updateAppListingSettings: (workspaceId: string, appId: string, changes: Partial<AppListingSettings>) =>
      request<{ settings: AppListingSettings; changed: string[] }>(
        'PUT',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/listing-settings`,
        changes,
      ),
    updateAppReleaseSettings: (
      workspaceId: string,
      appId: string,
      changes: { defaultSharePercent?: number | null; stagedRollout?: StagedRolloutMode },
    ) =>
      request<{ settings: ReleaseSettingsView['settings']; changed: boolean }>(
        'PUT',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/release-settings`,
        changes,
      ),
    // AI assistance (docs/api/ai.md, docs/adr/0016-ai-foundation.md). A run makes a SUGGESTION and changes nothing; accepting calls an
    // existing service (keywords, a staged text, a reply draft). Nothing here pushes, submits, publishes or sends. No key is ever returned.
    aiConfig: (workspaceId: string) =>
      request<AiConfig>('GET', `${workspace(workspaceId)}/ai/config`),
    updateAiConfig: (workspaceId: string, changes: AiSettingsChanges) =>
      request<AiConfig>('PUT', `${workspace(workspaceId)}/ai/config`, changes),
    testAi: (workspaceId: string) =>
      request<AiTestOutcome>('POST', `${workspace(workspaceId)}/ai/test`),
    // The models a provider offers. A typed key is used for this call only (never stored); without one the stored credential is used.
    aiModels: (workspaceId: string, body: AiModelsBody) =>
      request<AiModelsResponse>('POST', `${workspace(workspaceId)}/ai/models`, body),
    aiTasks: (workspaceId: string) =>
      request<AiTasksResponse>('GET', `${workspace(workspaceId)}/ai/tasks`),
    runAiTask: (workspaceId: string, taskId: string, body: AiRunBody) =>
      request<AiRunResult>(
        'POST',
        `${workspace(workspaceId)}/ai/tasks/${encodeURIComponent(taskId)}/run`,
        body,
      ),
    /** What a run would send, exactly, from stored data. Contacts no provider and costs nothing. */
    previewAiTask: (workspaceId: string, taskId: string, body: AiRunBody) =>
      request<{ preview: AiPreview }>(
        'POST',
        `${workspace(workspaceId)}/ai/tasks/${encodeURIComponent(taskId)}/preview`,
        body,
      ),
    /** What the person told the assistant about this app (brand voice, words to avoid). Editing needs the right to edit the app. */
    appAiContext: (workspaceId: string, appId: string) =>
      request<AiAppContextView>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/ai/context`,
      ),
    updateAppAiContext: (workspaceId: string, appId: string, context: Record<string, unknown>) =>
      request<AiAppContextView>(
        'PUT',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/ai/context`,
        context,
      ),
    /** What reviews of this app may be sent to the AI provider, the workspace ceiling and what is in force (docs/adr/0065). */
    appAiReviewPrivacy: (workspaceId: string, appId: string) =>
      request<ReviewPrivacyView>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/ai/review-privacy`),
    updateAppAiReviewPrivacy: (workspaceId: string, appId: string, changes: Record<string, unknown>) =>
      request<ReviewPrivacyView>('PUT', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/ai/review-privacy`, changes),
    /** The first three reviews as they would be sent under the policy in force. Contacts no provider. */
    previewAppAiReviewPrivacy: (workspaceId: string, appId: string) =>
      request<{ preview: ReviewPayloadPreview }>('POST', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/ai/review-privacy/preview`),
    /** Deletes the stored review summaries and what-to-fix reports of the app. */
    deleteAppAiSummaries: (workspaceId: string, appId: string) =>
      request<{ deleted: number }>('DELETE', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/ai/summaries`),
    /** The tags the assistant gave reviews earlier (advisory). Reads our own database: no provider is contacted. */
    reviewAiTags: (workspaceId: string, appId: string, reviewIds: string[]) =>
      request<{ tags: AiReviewTagView[] }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/ai/review-tags?ids=${reviewIds.map(encodeURIComponent).join(',')}`,
      ),
    appAiSuggestions: (
      workspaceId: string,
      appId: string,
      query: { status?: AiSuggestionStatus; limit?: number } = {},
    ) => {
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
      request<AiAcceptResult>(
        'POST',
        `${workspace(workspaceId)}/ai/suggestions/${encodeURIComponent(suggestionId)}/accept`,
        body,
      ),
    dismissAiSuggestion: (workspaceId: string, suggestionId: string) =>
      request<{ suggestion: AiSuggestionView }>(
        'POST',
        `${workspace(workspaceId)}/ai/suggestions/${encodeURIComponent(suggestionId)}/dismiss`,
      ),
    // ASO (docs/api/aso.md). Every read is our own database; only `refreshAso` and `addAsoCompetitor` read a public store, and nothing writes to one.
    asoConfig: (workspaceId: string) =>
      request<AsoConfig>('GET', `${workspace(workspaceId)}/aso/config`),
    asoSummary: (workspaceId: string, appId: string) =>
      request<AsoSummary>('GET', `${asoPath(workspaceId, appId)}/summary`),
    asoKeywords: (workspaceId: string, appId: string) =>
      request<{ keywords: AsoKeyword[]; limits: { maxKeywordsPerApp: number } }>(
        'GET',
        `${asoPath(workspaceId, appId)}/keywords`,
      ),
    addAsoKeywords: (workspaceId: string, appId: string, keywords: AsoKeywordInput[]) =>
      request<AsoAddResult>('POST', `${asoPath(workspaceId, appId)}/keywords`, { keywords }),
    updateAsoKeyword: (
      workspaceId: string,
      appId: string,
      keywordId: string,
      changes: { tag?: string | null; notes?: string | null; priority?: number },
    ) =>
      request<{ keyword: AsoKeyword }>(
        'PATCH',
        `${asoPath(workspaceId, appId)}/keywords/${encodeURIComponent(keywordId)}`,
        changes,
      ),
    deleteAsoKeyword: (workspaceId: string, appId: string, keywordId: string) =>
      request<void>(
        'DELETE',
        `${asoPath(workspaceId, appId)}/keywords/${encodeURIComponent(keywordId)}`,
      ),
    asoKeywordHistory: (workspaceId: string, appId: string, keywordId: string, limit = 30) =>
      request<AsoKeywordHistory>(
        'GET',
        `${asoPath(workspaceId, appId)}/keywords/${encodeURIComponent(keywordId)}/history?limit=${limit}`,
      ),
    /** Keyword popularity and difficulty ESTIMATES (never Apple's or Google's score), from stored signals: our own database (docs/api/aso.md#estimates). */
    asoKeywordEstimates: (workspaceId: string, appId: string) =>
      request<EstimatesResponse>('GET', `${asoPath(workspaceId, appId)}/keyword-estimates`),
    asoKeywordEstimate: (workspaceId: string, appId: string, keywordId: string) =>
      request<EstimateDetail>('GET', `${asoPath(workspaceId, appId)}/keywords/${encodeURIComponent(keywordId)}/estimate`),
    asoKeywordSuggestions: (workspaceId: string, appId: string, limit = 30) =>
      request<SuggestionsResponse>('GET', `${asoPath(workspaceId, appId)}/keyword-suggestions?limit=${limit}`),
    /** Reviews of the followed App Store competitors, from what is stored (no store is called). */
    asoCompetitorReviews: (workspaceId: string, appId: string, days = 28) =>
      request<CompetitorReviewsView>('GET', `${asoPath(workspaceId, appId)}/competitor-reviews?days=${days}`),
    /** Reads Apple's public reviews feed once for a competitor (at most once per 15 minutes). */
    refreshAsoCompetitorReviews: (workspaceId: string, appId: string, competitorId: string) =>
      request<CompetitorReviewsRefresh>(
        'POST',
        `${asoPath(workspaceId, appId)}/competitors/${encodeURIComponent(competitorId)}/reviews/refresh`,
      ),
    /** The schedule of the reads of competitor reviews and the state of each competitor (Apple only; docs/adr/0065). */
    asoCompetitorReviewSchedule: (workspaceId: string, appId: string) =>
      request<ReviewScheduleView>('GET', `${asoPath(workspaceId, appId)}/competitor-review-schedule`),
    updateAsoCompetitorReviewSchedule: (workspaceId: string, appId: string, changes: Record<string, unknown>) =>
      request<ReviewScheduleView>('PUT', `${asoPath(workspaceId, appId)}/competitor-review-schedule`, changes),
    updateAsoCompetitorReviewOverride: (workspaceId: string, appId: string, competitorId: string, body: { mode: 'off' | 'daily' | 'weekly' | null; weekday?: number | null }) =>
      request<ReviewScheduleView>('PUT', `${asoPath(workspaceId, appId)}/competitors/${encodeURIComponent(competitorId)}/review-schedule`, body),
    asoCompetitors: (workspaceId: string, appId: string) =>
      request<{ competitors: AsoCompetitor[]; limits: { maxCompetitorsPerApp: number } }>(
        'GET',
        `${asoPath(workspaceId, appId)}/competitors`,
      ),
    /** Search the App Store by name for an app to follow (reads Apple's public search through the server's cache and limits). Stale calls can be aborted. */
    searchAsoCompetitors: (
      workspaceId: string,
      appId: string,
      q: string,
      country: string,
      signal?: AbortSignal,
    ) =>
      request<AsoCompetitorSearch>(
        'GET',
        `${asoPath(workspaceId, appId)}/competitors/search?q=${encodeURIComponent(q)}&country=${encodeURIComponent(country)}`,
        undefined,
        undefined,
        undefined,
        signal,
      ),
    /** Reads the public store once, so the name is real. Rate limited per workspace. */
    addAsoCompetitor: (
      workspaceId: string,
      appId: string,
      body: { externalId: string; country?: string },
    ) =>
      request<{ competitor: AsoCompetitor }>(
        'POST',
        `${asoPath(workspaceId, appId)}/competitors`,
        body,
      ),
    deleteAsoCompetitor: (workspaceId: string, appId: string, competitorId: string) =>
      request<void>(
        'DELETE',
        `${asoPath(workspaceId, appId)}/competitors/${encodeURIComponent(competitorId)}`,
      ),
    asoCompetitorHistory: (workspaceId: string, appId: string, competitorId: string, limit = 30) =>
      request<AsoCompetitorHistory>(
        'GET',
        `${asoPath(workspaceId, appId)}/competitors/${encodeURIComponent(competitorId)}/history?limit=${limit}`,
      ),
    /** The listing changes Kiln found on an App Store competitor, newest first (reads what is stored). `before` is the `detectedAt` of the last one you have. */
    asoCompetitorChanges: (workspaceId: string, appId: string, competitorId: string, limit = 10, before?: number) =>
      request<CompetitorChangesPage>(
        'GET',
        `${asoPath(workspaceId, appId)}/competitors/${encodeURIComponent(competitorId)}/changes?limit=${limit}${before === undefined ? '' : `&before=${before}`}`,
      ),
    /** "Check now": one read of the public store for one competitor (shared cache and limits; not within 5 minutes of the last read). */
    checkAsoCompetitor: (workspaceId: string, appId: string, competitorId: string) =>
      request<CompetitorCheckResult>(
        'POST',
        `${asoPath(workspaceId, appId)}/competitors/${encodeURIComponent(competitorId)}/check`,
      ),
    /** Ranked next steps, worked out from stored data (no store is read). */
    asoCoach: (workspaceId: string, appId: string) =>
      request<AsoCoachResponse>('GET', `${asoPath(workspaceId, appId)}/coach`),
    asoFit: (workspaceId: string, appId: string) =>
      request<AsoFitResponse>('GET', `${asoPath(workspaceId, appId)}/fit`),
    asoListingKeywords: (workspaceId: string, appId: string) =>
      request<AsoListingKeywordsResponse>('GET', `${asoPath(workspaceId, appId)}/listing-keywords`),
    asoIdeas: (workspaceId: string, appId: string, locale?: string) =>
      request<AsoIdeasResponse>(
        'GET',
        `${asoPath(workspaceId, appId)}/ideas${locale ? `?locale=${encodeURIComponent(locale)}` : ''}`,
      ),
    asoGaps: (workspaceId: string, appId: string, locale?: string) =>
      request<AsoGapsResponse>(
        'GET',
        `${asoPath(workspaceId, appId)}/gaps${locale ? `?locale=${encodeURIComponent(locale)}` : ''}`,
      ),
    asoSuggestions: (workspaceId: string, appId: string) =>
      request<AsoSuggestionsResponse>('GET', `${asoPath(workspaceId, appId)}/suggestions`),
    /** Google Play search terms imported from a Console file (our own database; Google Play apps only). */
    asoSearchTerms: (workspaceId: string, appId: string, query: SearchTermsQuery = {}) => {
      const params: string[] = [];
      for (const key of ['from', 'to', 'country', 'locale', 'sort', 'limit'] as const) {
        const value = query[key];
        if (value !== undefined && value !== '')
          params.push(`${key}=${encodeURIComponent(String(value))}`);
      }
      return request<SearchTermsResponse>(
        'GET',
        `${asoPath(workspaceId, appId)}/search-terms${params.length > 0 ? `?${params.join('&')}` : ''}`,
      );
    },
    /** Rank history of tracked keywords laid on the days of the downloads. Our own database; a correlation view. */
    asoRankVsDownloads: (
      workspaceId: string,
      appId: string,
      query: { country?: string; keywords?: string[]; from?: string; to?: string } = {},
    ) => {
      const params: string[] = [];
      if (query.country) params.push(`country=${encodeURIComponent(query.country)}`);
      if (query.keywords && query.keywords.length > 0)
        params.push(`keywords=${query.keywords.map(encodeURIComponent).join(',')}`);
      if (query.from) params.push(`from=${encodeURIComponent(query.from)}`);
      if (query.to) params.push(`to=${encodeURIComponent(query.to)}`);
      return request<RankVsDownloadsResponse>(
        'GET',
        `${asoPath(workspaceId, appId)}/rank-vs-downloads${params.length > 0 ? `?${params.join('&')}` : ''}`,
      );
    },
    asoMarkets: (workspaceId: string, appId: string) =>
      request<AsoMarketsResponse>('GET', `${asoPath(workspaceId, appId)}/markets`),
    /** Reads the public store (Apple: the iTunes Search API; Google Play only when the operator allows it). Read-only toward the stores. */
    refreshAso: (workspaceId: string, appId: string) =>
      request<AsoRefreshOutcome>('POST', `${asoPath(workspaceId, appId)}/refresh`),
    /** Admins: queues a refresh of every app that has keywords or competitors. */
    refreshAsoAll: (workspaceId: string) =>
      request<{
        queued: number;
        skipped: { alreadyQueued: number; notReady: number; playOff: number; capped: number };
      }>('POST', `${workspace(workspaceId)}/aso/refresh`),
    // Analytics (docs/api/analytics.md). Reads (`analyticsStatus`, `analyticsOverview`) are our own database. `syncAnalytics` reads the stores;
    // `previewAppleEnable` reads Apple and changes nothing; `enableApple` is the one store write (a report request at Apple), with the
    // preview's hash; the import sends a report file to this server only. All but the two reads need `analytics.manage`.
    analyticsStatus: (workspaceId: string, appId: string) =>
      request<AnalyticsStatus>('GET', `${analyticsPath(workspaceId, appId)}/status`),
    analyticsOverview: (
      workspaceId: string,
      appId: string,
      query: {
        platform?: string;
        from?: string;
        to?: string;
        granularity?: string;
        breakdown?: string;
      } = {},
    ) => {
      const params = new URLSearchParams();
      for (const key of ['platform', 'from', 'to', 'granularity', 'breakdown'] as const) {
        const value = query[key];
        if (value !== undefined && value !== '') params.set(key, value);
      }
      const text = params.toString();
      return request<AnalyticsOverview>(
        'GET',
        `${analyticsPath(workspaceId, appId)}/overview${text ? `?${text}` : ''}`,
      );
    },
    // Sales by store product (stored analytics only, no store call). Needs `analytics.read`.
    analyticsProductSales: (
      workspaceId: string,
      appId: string,
      query: { from?: string; to?: string } = {},
    ) => {
      const params = new URLSearchParams();
      if (query.from) params.set('from', query.from);
      if (query.to) params.set('to', query.to);
      const text = params.toString();
      return request<ProductSalesView>(
        'GET',
        `${analyticsPath(workspaceId, appId)}/product-sales${text ? `?${text}` : ''}`,
      );
    },
    syncAnalytics: (workspaceId: string, appId: string, sources?: string[]) =>
      request<AnalyticsSyncResult>(
        'POST',
        `${analyticsPath(workspaceId, appId)}/sync`,
        sources && sources.length > 0 ? { sources } : undefined,
      ),
    // The Google Play reports bucket (one per Play developer account, shared by its Android apps). Needs `analytics.manage` to change or test.
    playBucket: (workspaceId: string, appId: string) =>
      request<{ playBucket: PlayBucketView }>(
        'GET',
        `${analyticsPath(workspaceId, appId)}/play-bucket`,
      ),
    setPlayBucket: (
      workspaceId: string,
      appId: string,
      body: { bucket: string | null; scope?: 'account' | 'app' },
    ) =>
      request<{ playBucket: PlayBucketView }>(
        'PUT',
        `${analyticsPath(workspaceId, appId)}/play-bucket`,
        body,
      ),
    testPlayBucket: (workspaceId: string, appId: string, bucket?: string) =>
      request<{ result: PlayBucketTestResult }>(
        'POST',
        `${analyticsPath(workspaceId, appId)}/play-bucket/test`,
        bucket !== undefined ? { bucket } : undefined,
      ),
    // The Apple vendor number of the app's App Store Connect credential (one Apple team). `null` clears it. Needs `analytics.manage`.
    setAppleVendorNumber: (workspaceId: string, appId: string, vendorNumber: string | null) =>
      request<{ vendorNumber: string | null }>(
        'PUT',
        `${analyticsPath(workspaceId, appId)}/apple-vendor`,
        { vendorNumber },
      ),
    // "Test access": ONE cheap call for one source, answered with a classified code (never the store's text). Needs `analytics.manage`.
    testAnalyticsAccess: (workspaceId: string, appId: string, source: string) =>
      request<{ result: { source: string; ok: boolean; code: string; message: string; serviceAccountEmail?: string } }>(
        'POST',
        `${analyticsPath(workspaceId, appId)}/access-test`,
        { source },
      ),
    previewAppleEnable: (workspaceId: string, appId: string, backfill = false) =>
      request<EnablePreview>(
        'GET',
        `${analyticsPath(workspaceId, appId)}/apple/enable${backfill ? '?backfill=true' : ''}`,
      ),
    enableApple: (
      workspaceId: string,
      appId: string,
      body: { confirmHash: string; backfill?: boolean },
      grant?: string,
    ) =>
      request<EnableResult>(
        'POST',
        `${analyticsPath(workspaceId, appId)}/apple/enable`,
        body,
        undefined,
        grantHeader(grant),
      ),
    previewAnalyticsImport: (workspaceId: string, appId: string, fileName: string, file: Blob) =>
      request<ImportPreview>(
        'POST',
        `${analyticsPath(workspaceId, appId)}/import/preview?fileName=${encodeURIComponent(fileName)}`,
        undefined,
        file,
      ),
    importAnalytics: (
      workspaceId: string,
      appId: string,
      fileName: string,
      confirmHash: string,
      file: Blob,
    ) =>
      request<AnalyticsImportResult>(
        'POST',
        `${analyticsPath(workspaceId, appId)}/import?fileName=${encodeURIComponent(fileName)}&confirmHash=${encodeURIComponent(confirmHash)}`,
        undefined,
        file,
      ),
    /** Sends a Play Console search terms file to this server only and says what it holds. Stores nothing. A file with no dates needs `period`. */
    previewSearchTermsImport: (
      workspaceId: string,
      appId: string,
      fileName: string,
      file: Blob,
      period: string = '',
    ) =>
      request<SearchTermsPreview>(
        'POST',
        `${analyticsPath(workspaceId, appId)}/search-terms/import/preview?fileName=${encodeURIComponent(fileName)}${period === '' ? '' : `&${period}`}`,
        undefined,
        file,
      ),
    importSearchTerms: (
      workspaceId: string,
      appId: string,
      fileName: string,
      confirmHash: string,
      file: Blob,
      period: string = '',
    ) =>
      request<SearchTermsImportResult>(
        'POST',
        `${analyticsPath(workspaceId, appId)}/search-terms/import?fileName=${encodeURIComponent(fileName)}&confirmHash=${encodeURIComponent(confirmHash)}${period === '' ? '' : `&${period}`}`,
        undefined,
        file,
      ),
    // The Expo (EAS) project of an app record (docs/api/eas.md). Reading needs `apps.read`; saving, removing and detecting need `apps.write`.
    expoLink: (workspaceId: string, appId: string) =>
      request<{ link: ExpoLinkView | null }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/expo`,
      ),
    setExpoLink: (workspaceId: string, appId: string, body: SetExpoLinkBody) =>
      request<{ link: ExpoLinkView }>(
        'PUT',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/expo`,
        body,
      ),
    removeExpoLink: (workspaceId: string, appId: string) =>
      request<void>('DELETE', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/expo`),
    detectExpoProject: (workspaceId: string, appId: string) =>
      request<{ detection: ExpoDetection }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/expo/detect`,
      ),
    // Apple Ads, read only (docs/api/apple-ads.md). The state, the views and the sync need `apps.read`, `aso.read` and `apps.sync`; linking needs `apps.write`.
    adsState: (workspaceId: string, appId: string) => request<AdsState>('GET', `${adsPath(workspaceId, appId)}`),
    adsAccounts: (workspaceId: string, appId: string, credentialId: string) =>
      request<{ accounts: AdsAccount[] }>('GET', `${adsPath(workspaceId, appId)}/accounts?credentialId=${encodeURIComponent(credentialId)}`),
    setAdsLink: (workspaceId: string, appId: string, body: SetAdsLinkBody) => request<{ link: AdsLinkView }>('PUT', adsPath(workspaceId, appId), body),
    removeAdsLink: (workspaceId: string, appId: string) => request<void>('DELETE', adsPath(workspaceId, appId)),
    syncAds: (workspaceId: string, appId: string) =>
      request<{ queued: boolean; jobId?: string; reason?: string }>('POST', `${adsPath(workspaceId, appId)}/sync`, {}),
    adsOverview: (workspaceId: string, appId: string, query = '') =>
      request<AdsOverviewResponse>('GET', `${adsPath(workspaceId, appId)}/overview${query === '' ? '' : `?${query}`}`),
    adsCampaigns: (workspaceId: string, appId: string, query = '') =>
      request<AdsCampaignsResponse>('GET', `${adsPath(workspaceId, appId)}/campaigns${query === '' ? '' : `?${query}`}`),
    adsTerms: (workspaceId: string, appId: string, query = '') =>
      request<AdsTermsResponse>('GET', `${adsPath(workspaceId, appId)}/terms${query === '' ? '' : `?${query}`}`),
    // EAS Workflows as a CI provider (docs/api/eas-workflows.md). Starting needs `ci.dispatch`; the runs are read with `apps.read`;
    // `refresh` asks Expo and needs `apps.sync`.
    easWorkflowRuns: (workspaceId: string, appId: string) =>
      request<{ runs: WorkflowRun[] }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/expo/workflows/runs`,
      ),
    easWorkflowRun: (workspaceId: string, appId: string, runId: string, refresh = false) =>
      request<EasWorkflowRunRead>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/expo/workflows/runs/${encodeURIComponent(runId)}${refresh ? '?refresh=true' : ''}`,
      ),
    dispatchEasWorkflow: (workspaceId: string, appId: string, body: EasWorkflowDispatchBody) =>
      request<{ dispatched: boolean; run: WorkflowRun }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/expo/workflows/dispatches`,
        body,
      ),
    /** `eas.json` and the JSON app config of the app's repository, read-only (docs/api/eas-config.md). Needs `repositories.scan`. */
    easConfig: (workspaceId: string, appId: string) =>
      request<EasConfigView>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/eas-config`,
      ),
    // EAS Build and Submit status of the linked Expo project (docs/api/eas-builds.md). The status is the stored snapshot (needs `builds.read`, no
    // call to Expo); the refresh reads Expo again with the credential of the link (needs `apps.sync`). Neither changes anything at Expo.
    easStatus: (workspaceId: string, appId: string) =>
      request<{ status: EasStatusView }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/eas/status`,
      ),
    refreshEasStatus: (workspaceId: string, appId: string) =>
      request<{ status: EasStatusView }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/eas/status/refresh`,
      ),
    // EAS Update of the linked Expo project (docs/api/eas-update.md). The reads need `apps.read` and call Expo; raising a rollout is off
    // unless the server sets KILN_EAS_UPDATE_ROLLOUT_ENABLED, needs `releases.rollout`, and only `easUpdateRolloutApply` changes Expo.
    easUpdates: (workspaceId: string, appId: string) =>
      request<{ state: EasUpdateState }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/expo/updates`,
      ),
    easUpdateInsights: (workspaceId: string, appId: string, group: string, days = 7) =>
      request<{ insights: EasUpdateInsights }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/expo/updates/${encodeURIComponent(group)}/insights?days=${days}`,
      ),
    easUpdateRolloutPreview: (workspaceId: string, appId: string, body: EasRolloutRequest) =>
      request<{ preview: EasRolloutPreview }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/expo/updates/rollout/preview`,
        body,
      ),
    easUpdateRolloutApply: (
      workspaceId: string,
      appId: string,
      body: EasRolloutRequest & { confirmHash: string },
      grant?: string,
    ) =>
      request<{ result: EasRolloutResult }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/expo/updates/rollout/apply`,
        body,
        undefined,
        grantHeader(grant),
      ),
    // In-app purchases and subscriptions (docs/api/products.md). Reads and the sync never change a store. `previewProductLocalization` reads
    // the store and writes nothing; `applyProductLocalization` is the only write: sent once with the preview's hash, never retried by this app.
    appProducts: (workspaceId: string, appId: string) =>
      request<ProductsView>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/products`,
      ),
    appProduct: (workspaceId: string, appId: string, productId: string) =>
      request<ProductDetailView>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/products/${encodeURIComponent(productId)}`,
      ),
    // Price changes (docs/adr/0062-price-writes.md). Price points, the conversion and the dry run READ the store; staging writes only Kiln's own table.
    // Sending is the pending cart's publish, with the typed phrase in `confirmation`.
    productPricePoints: (workspaceId: string, appId: string, productId: string, territory: string) =>
      request<{ pricePoints: PricePointOption[]; currency: string | null; applicable: boolean }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/products/${encodeURIComponent(productId)}/price-points?territory=${encodeURIComponent(territory)}`,
      ),
    convertProductPrices: (workspaceId: string, appId: string, productId: string, body: { planId: string | null; baseTerritory: string; amount: string }) =>
      request<{ prices: ConvertedPrice[]; regionsVersion: string | null }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/products/${encodeURIComponent(productId)}/price-convert`,
        body,
      ),
    stageProductPrice: (workspaceId: string, appId: string, productId: string, body: PriceStageRequest) =>
      request<{ staged: StagedPriceChange }>(
        'PUT',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/products/${encodeURIComponent(productId)}/prices/staged`,
        body,
      ),
    dryRunStagedPrices: (workspaceId: string, appId: string, ids?: string[]) =>
      request<{ dryRun: { items: PriceDryRunItem[]; writesEnabled: boolean } }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/prices/dry-run`,
        ids ? { ids } : {},
      ),
    syncAppProducts: (workspaceId: string, appId: string) =>
      request<ProductSyncResult>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/products/sync`,
      ),
    // TestFlight beta feedback and crashes (docs/api/testflight-feedback.md). Reads and the sync never change App Store Connect; triage is Kiln's own.
    appTestflight: (workspaceId: string, appId: string, query: string) =>
      request<TestflightView>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/testflight${query === '' ? '' : `?${query}`}`,
      ),
    appTestflightItem: (workspaceId: string, appId: string, id: string) =>
      request<{ item: TestflightItem }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/testflight/${encodeURIComponent(id)}`,
      ),
    appTestflightCrashGroups: (workspaceId: string, appId: string) =>
      request<CrashGroups>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/testflight/crash-groups`,
      ),
    appTestflightScreenshots: (workspaceId: string, appId: string, id: string) =>
      request<{ screenshots: ScreenshotLink[] }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/testflight/${encodeURIComponent(id)}/screenshots`,
      ),
    syncAppTestflight: (workspaceId: string, appId: string) =>
      request<TestflightSyncResult>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/testflight/sync`,
      ),
    triageTestflightItem: (workspaceId: string, appId: string, id: string, input: TriageInput) =>
      request<{ item: TestflightItem }>(
        'PATCH',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/testflight/${encodeURIComponent(id)}`,
        input,
      ),
    // Insights of an app (docs/api/insights.md): computed on read from stored data, no store is asked. Reads need `analytics.read` (the store page
    // checks `listing.read`); dismissing and restoring a card are Kiln's own record and need `aso.write`.
    appInsights: (workspaceId: string, appId: string, includeHidden = false) =>
      request<InsightsView>('GET', `${insightsPath(workspaceId, appId)}${includeHidden ? '?includeHidden=1' : ''}`),
    // Timeline and reports (docs/api/timeline.md, docs/api/reports.md): stored data only. `days` is the impact window the server wants (7), the events are what is read.
    appTimeline: (workspaceId: string, appId: string, from: string, to: string) =>
      request<TimelineApi>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/timeline?from=${from}&to=${to}&days=7`),
    createTimelineEvent: (workspaceId: string, appId: string, body: { kind: ManualEventKind; day: string; title: string; note?: string }) =>
      request<{ event: TimelineApi['events'][number] }>('POST', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/timeline/events`, body),
    deleteTimelineEvent: (workspaceId: string, appId: string, eventId: string) =>
      request<{ ok: true }>('DELETE', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/timeline/events/${encodeURIComponent(eventId)}`),
    appReport: (workspaceId: string, appId: string, kind: string, day?: string) =>
      request<ReportApi>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/reports?kind=${kind}${day ? `&day=${day}` : ''}`),
    // Ratings and health (docs/api/ratings.md): stored data only, `reviews.read`. `days` is counted back from today (7 to 730).
    appRatings: (workspaceId: string, appId: string, days: number) =>
      request<RatingsView>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/ratings?days=${days}&granularity=day`),
    appHealth: (workspaceId: string, appId: string, days: number) =>
      request<HealthView>('GET', `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/health?days=${days}`),
    appInsightsCount: (workspaceId: string, appId: string) =>
      request<{ count: number }>('GET', `${insightsPath(workspaceId, appId)}/count`),
    appInsightsCountries: (workspaceId: string, appId: string) =>
      request<InsightsCountriesView>('GET', `${insightsPath(workspaceId, appId)}/countries`),
    appListingChecks: (workspaceId: string, appId: string) =>
      request<ListingChecksView>('GET', `${insightsPath(workspaceId, appId)}/listing-checks`),
    dismissInsight: (workspaceId: string, appId: string, cardId: string) =>
      request<{ ok: true }>('POST', `${insightsPath(workspaceId, appId)}/cards/${encodeURIComponent(cardId)}/dismiss`),
    restoreInsights: (workspaceId: string, appId: string, cardId?: string) =>
      request<{ restored: number }>('POST', `${insightsPath(workspaceId, appId)}/restore`, cardId ? { cardId } : {}),
    // Store experiments and custom product pages (docs/api/experiments.md). Reads and the sync never change a store; notes are the manual tracker.
    appExperiments: (workspaceId: string, appId: string) =>
      request<ExperimentsView>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/experiments`,
      ),
    syncAppExperiments: (workspaceId: string, appId: string) =>
      request<ExperimentsSyncResult>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/experiments/sync`,
      ),
    createExperimentNote: (workspaceId: string, appId: string, input: NoteInput) =>
      request<{ note: ExperimentNote }>(
        'POST',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/experiments/notes`,
        input,
      ),
    updateExperimentNote: (
      workspaceId: string,
      appId: string,
      noteId: string,
      input: Partial<Omit<NoteInput, 'kind'>>,
    ) =>
      request<{ note: ExperimentNote }>(
        'PATCH',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/experiments/notes/${encodeURIComponent(noteId)}`,
        input,
      ),
    deleteExperimentNote: (workspaceId: string, appId: string, noteId: string) =>
      request<{ ok: true }>(
        'DELETE',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/experiments/notes/${encodeURIComponent(noteId)}`,
      ),
    // RevenueCat of an app (docs/api/revenuecat.md): configuration facts only, nothing in RevenueCat is changed. Reading needs `apps.read`;
    // linking, unlinking and detecting need `apps.write`. The read itself is the second step of `syncAppProducts`.
    revenueCatLink: (workspaceId: string, appId: string) =>
      request<RevenueCatLinkRead>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/revenuecat`,
      ),
    revenueCatProducts: (workspaceId: string, appId: string) =>
      request<RevenueCatProductsView>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/revenuecat/products`,
      ),
    // RevenueCat's overview figures of the linked project (docs/adr/0043-revenuecat-metrics.md): the stored copy, no RevenueCat call. `apps.read`.
    revenueCatMetrics: (workspaceId: string, appId: string) =>
      request<RevenueCatMetricsRead>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/revenuecat/metrics`,
      ),
    detectRevenueCat: (
      workspaceId: string,
      appId: string,
      credentialId: string,
      projectId?: string,
    ) =>
      request<{ options: RevenueCatOptions }>(
        'GET',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/revenuecat/detect?credentialId=${encodeURIComponent(credentialId)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`,
      ),
    setRevenueCatLink: (workspaceId: string, appId: string, body: SetRevenueCatLinkBody) =>
      request<{ link: RevenueCatLinkView }>(
        'PUT',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/revenuecat`,
        body,
      ),
    // "Connect your apps" (docs/api/revenuecat.md): which records are linked (database only) and one proposal per record from one read of RevenueCat.
    integrationLinks: (workspaceId: string) =>
      request<IntegrationLinks>('GET', `${workspace(workspaceId)}/integration-links`),
    planRevenueCat: (workspaceId: string, credentialId: string) =>
      request<{ plan: RevenueCatPlan }>(
        'GET',
        `${workspace(workspaceId)}/revenuecat/plan?credentialId=${encodeURIComponent(credentialId)}`,
      ),
    removeRevenueCatLink: (workspaceId: string, appId: string) =>
      request<void>(
        'DELETE',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/revenuecat`,
      ),
    previewProductLocalization: (
      workspaceId: string,
      appId: string,
      productId: string,
      locale: string,
      body: { name: string; description: string },
    ) =>
      request<{ preview: ProductLocalizationPreview }>(
        'PUT',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/products/${encodeURIComponent(productId)}/localizations/${encodeURIComponent(locale)}`,
        { apply: false, ...body },
      ),
    applyProductLocalization: (
      workspaceId: string,
      appId: string,
      productId: string,
      locale: string,
      body: { name: string; description: string; previewHash: string },
      grant?: string,
    ) =>
      request<{ result: ProductLocalizationResult }>(
        'PUT',
        `${workspace(workspaceId)}/apps/${encodeURIComponent(appId)}/products/${encodeURIComponent(productId)}/localizations/${encodeURIComponent(locale)}`,
        { apply: true, ...body },
        undefined,
        grantHeader(grant),
      ),
  };
}

export type Api = ReturnType<typeof createApi>;
