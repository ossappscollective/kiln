import type {
  ChangeSetStatus,
  InvitableRole,
  Listing,
  ListingProblem,
  ListingStore,
  Platform,
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
