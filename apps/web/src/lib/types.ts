import type {
  ChangeSetStatus,
  ChecklistTemplateItem,
  DueFlags,
  InvitableRole,
  Listing,
  ListingProblem,
  ListingStore,
  PlanPlatform,
  Platform,
  Readiness,
  ReleaseState,
  Role,
} from '@mrm/core';

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

export type ProjectKind = 'fastlane' | 'expo' | 'both' | 'unknown';

export type RepositorySummary = {
  id: string;
  credentialId: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  /** Null until the repository is first scanned. */
  projectKind: ProjectKind | null;
  detectedAt: number | null;
  createdAt: number;
};

export type DetectionEvidence = {
  fact: string;
  path: string;
  /** `definite`: a file says so. `inferred`: a reasonable reading, but a guess. */
  strength: 'definite' | 'inferred';
  platform?: Platform;
};

/** The result of scanning a repository (the `ProjectDetection` of `@mrm/connectors`). */
export type ProjectDetection = {
  kind: ProjectKind;
  platforms: Platform[];
  platformsInferred: Platform[];
  locales: { ios: string[]; android: string[] };
  paths: {
    fastlaneDirs: string[];
    fastfiles: string[];
    iosMetadata?: string;
    androidMetadata?: string;
    iosScreenshots?: string;
    androidImages?: string;
    appJson?: string;
    appConfig?: string;
    easJson?: string;
    packageJson?: string;
  };
  /** Every folder that looks like a listing root and the apps they belong to. Absent in old scans. */
  listing?: { candidates: ListingCandidate[]; targets: DetectedTarget[] };
  expo?: {
    configPath?: string;
    dynamicConfig: boolean;
    name?: string;
    slug?: string;
    version?: string;
    iosBundleIdentifier?: string;
    androidPackage?: string;
    buildProfiles: string[];
    submitProfiles: string[];
    storeConfigs: Array<{ path: string; profile?: string; dynamic: boolean }>;
  };
  evidence: DetectionEvidence[];
  warnings: string[];
};

export type RepositoryDetail = { repository: RepositorySummary; detection: ProjectDetection | null };

/** Where a store's listing is read from: the Expo store.config.json, or the fastlane folders. */
export type ListingSourceKind = 'expo-store-config' | 'fastlane';

export type StoreSource = {
  source: ListingSourceKind;
  /** The store config file, or the fastlane metadata folder. */
  path: string;
  found: boolean;
  /** The source exists but cannot be read (for example invalid JSON). */
  error?: string;
  /** What the connector noticed in this source (Expo: uncovered and unknown keys). */
  warnings: string[];
  uncovered: string[];
  unknown: string[];
};

/** A folder that looks like a store listing: one store, one place, one app. */
export type ListingCandidate = {
  store: ListingStore;
  root: string;
  app?: string;
  platform: 'ios' | 'android';
  origin: 'convention' | 'hint';
  locales: string[];
  files: number;
  label: string;
};

/** One app (or folder) with the folders of its two stores. A null root: no folder for that store. */
export type DetectedTarget = {
  key: string;
  label: string;
  app?: string;
  roots: { appStore: string | null; googlePlay: string | null };
};

/** A place the listing can be read from: found by the scan (`auto:<key>`), or saved by a person. */
export type ListingTargetView = {
  id: string;
  origin: 'detected' | 'custom';
  label: string;
  app: string | null;
  roots: { appStore: string | null; googlePlay: string | null };
  createdAt?: number;
  updatedAt?: number;
};

/** A listing target a person saved for a repository. */
export type SavedListingTarget = {
  id: string;
  repositoryId: string;
  name: string;
  appId: string | null;
  appStoreRoot: string | null;
  googlePlayRoot: string | null;
  createdAt: number;
  updatedAt: number;
};

/** What to read: a target (`auto:<key>` or a saved id) and/or folders, which win. '' = not read. */
export type ListingSelection = {
  target?: string;
  roots?: { appStore?: string; googlePlay?: string };
};

/** What to send to create or change a saved target. A null or empty folder: none for that store. */
export type ListingTargetInput = {
  name: string;
  appId?: string | null;
  appStoreRoot?: string | null;
  googlePlayRoot?: string | null;
};

export type UnusedFolder = { path: string; store: ListingStore | null; reason: string };

export type StoreDiagnostic = {
  root: string;
  explicit: boolean;
  state: 'found' | 'missing' | 'no_listing_files' | 'not_used';
  entries: string[];
  message: string;
  searched: string[];
  unused: UnusedFolder[];
};

/** The listing files of a repository, as the API reads them at the default branch. */
export type RepositoryListing = {
  listing: Listing;
  found: { appStore: boolean; googlePlay: boolean };
  roots: { appStore: string; googlePlay: string };
  warnings: string[];
  problems: ListingProblem[];
  sources: { appStore: StoreSource; googlePlay: StoreSource };
  /** Every place the listing can be read from, detected and saved. Absent from an older server. */
  targets?: ListingTargetView[];
  /** Which of them was read. */
  selected?: { id: string | null; origin: 'custom' | 'detected' | 'folders' | 'default'; label: string };
  candidates?: ListingCandidate[];
  diagnostics?: { appStore: StoreDiagnostic; googlePlay: StoreDiagnostic };
};

export type ChangeSetFile = {
  path: string;
  change: 'added' | 'modified' | 'deleted';
  /** Both sides are only in the detail response, not in lists. */
  before?: string;
  after?: string;
};

export type ChangeSetView = {
  id: string;
  repositoryId: string;
  summary: string;
  status: ChangeSetStatus;
  createdBy: { type: string; id: string };
  branch: string | null;
  prUrl: string | null;
  prNumber: number | null;
  commitSha: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  approvedBy: string | null;
  approvedAt: number | null;
  appliedAt: number | null;
  filesChanged: number;
  files: ChangeSetFile[];
};

/** One store listing (an iOS or Android app) bound to a credential. Times are epoch milliseconds. */
export type AppSummary = {
  id: string;
  name: string;
  platform: Platform;
  /** The bundle id (iOS) or the package name (Android). Show this one, not `storeAppId`. */
  identifier: string;
  storeAppId: string | null;
  credentialId: string;
  /** The linked repository, or null (also when that repository was disconnected later). */
  repositoryId: string | null;
  createdAt: number;
  /** The last successful sync. Null means never. */
  lastSyncedAt: number | null;
  lastSyncAttemptAt: number | null;
  /** A short message for a person, set when the last attempt failed and cleared by the next success. */
  lastSyncError: string | null;
};

/** A snapshot of one version (and track, on Android) as the store last reported it. */
export type ReleaseSummary = {
  id: string;
  appId: string;
  platform: Platform;
  version: string;
  /** The Play track. Null on iOS. */
  track: string | null;
  build: string | null;
  /** The normalized lifecycle state, or null when the store's state has no mapping. */
  status: ReleaseState | null;
  /** The store's own state name, verbatim. */
  rawState: string;
  /** The share of users eligible in a staged rollout (0 to 1), or null. */
  rolloutFraction: number | null;
  versionCodes: string[] | null;
  storeUpdatedAt: number | null;
  syncedAt: number;
};

export type AppDetail = { app: AppSummary; releases: ReleaseSummary[] };

export type SyncSummary = {
  at: number;
  found: number;
  added: number;
  updated: number;
  removed: number;
  unmapped: number;
};

export type SyncResult = { app: AppSummary; releases: ReleaseSummary[]; sync: SyncSummary };

export type NewApp = {
  platform: Platform;
  identifier: string;
  credentialId: string;
  name?: string;
  repositoryId?: string;
};

/** An app the store knows, as found by discovery with a credential. */
export type DiscoverCandidate = {
  platform: Platform;
  /** The store's own id: Apple's numeric app id, or the package name. */
  storeId: string;
  /** The bundle id (iOS) or the package name (Android). */
  identifier: string;
  name: string;
  alreadyAdded: boolean;
  /** The app in this workspace, when `alreadyAdded`. */
  appId?: string;
};

/** A Google Play package that could not be verified. `error` is a code of the apps API. */
export type DiscoverFailure = { identifier: string; error: string; message: string };

export type DiscoverResult = {
  credentialId: string;
  kind: 'app_store_connect' | 'google_play';
  candidates: DiscoverCandidate[];
  failures: DiscoverFailure[];
};

export type ImportItem = {
  platform: Platform;
  identifier: string;
  storeAppId?: string;
  name?: string;
  repositoryId?: string;
};

export type ImportItemResult = {
  platform: Platform;
  identifier: string;
  status: 'created' | 'skipped' | 'failed';
  /** The new app, or the one that already exists (skipped). */
  app?: AppSummary;
  error?: string;
  message?: string;
};

export type ImportSummary = { created: number; skipped: number; failed: number };

export type ImportResult = { results: ImportItemResult[]; summary: ImportSummary };

// ---------------------------------------------------------------------------------------------
// Release planning (docs/api/plans.md). Our own data; nothing here comes from a store.

export type PlanItem = {
  id: string;
  position: number;
  text: string;
  required: boolean;
  done: boolean;
  doneBy: { id: string; name: string | null } | null;
  doneAt: number | null;
};

export type PlanNote = { locale: string; text: string; length: number; updatedAt: number };

export type PlanSummary = {
  id: string;
  appId: string;
  appName: string;
  appPlatform: Platform;
  appIdentifier: string;
  version: string;
  /** Null: the plan covers both platforms. */
  platform: PlanPlatform;
  /** A calendar day, YYYY-MM-DD, compared in UTC. */
  targetDate: string | null;
  blocked: boolean;
  blockedReason: string | null;
  notes: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** The last sync saw this version live. */
  released: boolean;
  due: DueFlags;
  readiness: Readiness;
  checklist: { total: number; done: number };
};

export type PlanDetail = PlanSummary & { items: PlanItem[]; releaseNotes: PlanNote[] };

export type ChecklistTemplate = {
  id: string;
  name: string;
  description: string | null;
  items: ChecklistTemplateItem[];
  /** Ships with the product; cannot be changed or deleted. */
  builtin: boolean;
  createdAt: number | null;
  updatedAt: number | null;
};

export type NewPlan = {
  version: string;
  platform?: PlanPlatform;
  targetDate?: string | null;
  notes?: string;
  templateId?: string;
};

export type PlanChanges = {
  targetDate?: string | null;
  blocked?: boolean;
  blockedReason?: string | null;
  notes?: string;
};

// ---------------------------------------------------------------------------------------------
// Store listing: live values, drift and history (docs/api/listing.md). Read-only toward the stores.

export type DriftStatus = 'identical' | 'repo-ahead' | 'store-ahead' | 'diverged' | 'missing-in-one';

export type ListingValueSource = 'store' | 'repo' | 'change_set';

/** One side of a field: its value now, and when it was first seen. */
export type DriftSide = {
  value: string | null;
  observedAt: number | null;
  /** A store version, a commit sha or a change set id. */
  sourceRef: string | null;
  source: ListingValueSource | null;
};

export type SideProblem = {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  limit?: number;
  actual?: number;
  unit?: 'characters' | 'bytes';
};

export type DriftField = {
  locale: string;
  field: string;
  label: string;
  limit: number | null;
  unit: 'characters' | 'bytes';
  status: DriftStatus;
  missingIn?: 'repo' | 'store';
  repo: DriftSide;
  /** What the tool last knew: the newest store snapshot or applied change set. */
  db: DriftSide;
  live: DriftSide;
  problems: { repo: SideProblem[]; live: SideProblem[] };
};

export type DriftLocale = { locale: string; fields: DriftField[] };

export type ListingDrift = {
  appId: string;
  platform: Platform;
  /** Which store copy the live column shows. Null: nothing was read from the store yet. */
  channel: 'live' | 'editable' | null;
  store: { readAt: number | null; error: string | null };
  repo: { readAt: number | null; ref: string | null; error: string | null };
  summary: Record<DriftStatus, number>;
  locales: DriftLocale[];
};

export type ListingHistoryEntry = {
  id: string;
  locale: string;
  field: string;
  channel: string;
  /** Null: the field was removed (or is absent). */
  value: string | null;
  source: ListingValueSource;
  sourceRef: string | null;
  observedAt: number;
  actor: { type: string; id: string } | null;
};

export type ListingHistoryPage = { items: ListingHistoryEntry[]; nextCursor: string | null };

export type LiveListingChannel = {
  channel: 'live' | 'editable';
  sourceRef: string | null;
  observedAt: number | null;
  locales: Record<string, Record<string, string>>;
};

export type LiveListing = {
  appId: string;
  platform: Platform;
  readAt: number | null;
  error: string | null;
  channels: LiveListingChannel[];
};

export type RepoRefreshResult = {
  ref: string;
  found: boolean;
  changed: number;
  removed: number;
  unchanged: number;
};

// ----- CI: workflows, runs and builds (docs/api/ci.md) ---------------------------------------

export type CiWorkflow = {
  id: string;
  name: string;
  /** The workflow file, for example `.github/workflows/ios.yml`. */
  path: string;
  /** GitHub's word: `active`, `disabled_manually`, ... Only `active` workflows can be dispatched. */
  state: string;
};

export type WorkflowInputSpec = {
  name: string;
  description?: string;
  required: boolean;
  /** Always text, as GitHub sends inputs. */
  default?: string;
  type: 'string' | 'boolean' | 'choice' | 'number' | 'environment';
  options?: string[];
};

export type WorkflowInputs = {
  workflow: CiWorkflow;
  ref: string;
  /** True when the file has a `workflow_dispatch` trigger, false when not, null when unknown. */
  dispatchable: boolean | null;
  /** False when the file could not be read: `inputs` is then empty and means nothing. */
  parsed: boolean;
  inputs: WorkflowInputSpec[];
  cached: boolean;
};

export type WorkflowRun = {
  /** GitHub's run id; `pending-...` for a dispatch whose run GitHub has not named yet. */
  id: string;
  repositoryId: string;
  appId: string | null;
  workflow: string;
  workflowPath: string | null;
  title: string | null;
  /** GitHub's status verbatim (`queued`, `in_progress`, `completed`, ...) or `pending`. */
  status: string;
  conclusion: string | null;
  /** True while the run is not finished. */
  active: boolean;
  headSha: string | null;
  /** First line of the commit message. */
  commitMessage: string | null;
  branch: string | null;
  event: string | null;
  runNumber: number | null;
  url: string | null;
  inputs: Record<string, string> | null;
  dispatchedBy: string | null;
  startedAt: number;
  updatedAt: number;
  syncedAt: number;
};

export type WorkflowRuns = {
  runs: WorkflowRun[];
  /** How many runs of this repository are not finished. */
  active: number;
  refreshed: boolean;
  refreshedAt: number | null;
};

export type DispatchResult = { dispatched: boolean; runKnown: boolean; run: WorkflowRun };

export type BuildLink = {
  state: 'linked';
  /** `manual`, or the matcher: `dispatch_input`, `run_title`, ... */
  source: string;
  manual: boolean;
  reason: string;
  candidates: number;
  linkedAt: number | null;
  linkedBy: string | null;
  run: {
    id: string;
    workflow: string;
    title: string | null;
    status: string;
    conclusion: string | null;
    active: boolean;
    url: string | null;
    branch: string | null;
    startedAt: number;
    updatedAt: number;
  } | null;
  commit: { sha: string; shortSha: string; message: string | null; url: string | null } | null;
};

export type AppBuild = {
  platform: Platform;
  buildNumber: string;
  version: string;
  /** Play tracks that carry the build; empty on iOS. */
  tracks: string[];
  status: ReleaseState | null;
  rawState: string;
  uploadedAt: number | null;
  syncedAt: number;
  linkState: 'linked' | 'unlinked';
  link: BuildLink | null;
};

export type AppBuilds = {
  repository: { id: string; owner: string; repo: string } | null;
  matchers: { id: string; description: string }[];
  builds: AppBuild[];
};

export type ChangedCommit = {
  sha: string;
  shortSha: string;
  title: string;
  message: string;
  author: string | null;
  date: number | null;
  url: string | null;
};

export type BuildChanges = {
  platform: Platform;
  base: { buildNumber: string; version: string; sha: string; shortSha: string };
  head: { buildNumber: string; version: string; sha: string; shortSha: string };
  status: string;
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
  /** More commits than `commits` holds: the oldest were left out. */
  truncated: boolean;
  url: string | null;
  /** Newest first. */
  commits: ChangedCommit[];
};

// ----- API tokens, events and webhooks -------------------------------------------------------------

export type ApiTokenStatus = 'active' | 'revoked' | 'expired';

/** A token as listed. The token itself is shown once, when it is made, and never again. */
export type ApiToken = {
  id: string;
  name: string;
  /** `mrm_` and six more characters, to recognise it. */
  prefix: string;
  role: 'viewer' | 'member' | 'admin';
  /** Null: all apps. */
  appIds: string[] | null;
  /** Null: everything the role allows. */
  actions: string[] | null;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
  createdBy: { id: string; name: string | null };
  status: ApiTokenStatus;
};

export type CreatedApiToken = { token: string; summary: ApiToken };

export type WebhookEndpoint = {
  id: string;
  url: string;
  description: string | null;
  /** Event types, or `*` for all of them. */
  eventTypes: string[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastDelivery: { status: string; at: number; responseCode: number | null } | null;
};

/** The secret is in the response to creating a webhook or rotating its secret, and nowhere else. */
export type CreatedWebhook = { webhook: WebhookEndpoint; secret: string };

export type WebhookDeliveryStatus = 'pending' | 'retrying' | 'success' | 'failed';

export type WebhookDelivery = {
  id: string;
  endpointId: string;
  /** Null for a test. */
  eventId: number | null;
  eventType: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  responseCode: number | null;
  responseBody: string | null;
  error: string | null;
  /** The first delivery this one sends again. */
  redeliveryOf: string | null;
  createdAt: number;
  deliveredAt: number | null;
};
