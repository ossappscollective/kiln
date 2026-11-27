import { type Role, type StagedChangesView, slotKey, type StoreImagesView } from '@kiln/core';
import type { PlatformScope } from '../app-scope.ts';
import type { CartSummary } from '../cart-summary.ts';
import type {
  LastPublish,
  PendingItem,
  PendingSummary,
  PendingSummaryApp,
  PendingTotals,
  PendingView,
} from '../pending.ts';
import type { Publishing } from '../publishing.ts';
import type { AppPipeline, PipelineSummary, PipelineSummaryApp } from '../release-pipeline.ts';
import type { AppBuild, AppSummary, ReleaseSummary } from '../types.ts';
import type { ReadinessFact } from './blockers.ts';
import type { StoreBuildFact } from './candidates.ts';
import { assembleFacts } from './facts.ts';
import {
  ANDROID,
  blockedRun,
  IOS,
  iosPipeline,
  iosRelease,
  NOW,
  testflight,
} from './fixtures.ts';
import type { AppFacts } from './types.ts';

/**
 * The WORLD of the consistency harness (docs/state-model.md, "Consistency contract"): everything the stores, the server and the screens
 * know about ONE product (an iOS and an Android record), as plain data, for one scenario of the audits. Every surface projects its
 * facts (projections.ts) from the same world; the test compares the facts that two surfaces both show.
 *
 * The server's own answers (`GET /pending/cart-summary`, `/pending/summary`, `GET /apps/:id/pending`, the cart rows, the store images)
 * are DERIVED here from the raw rows with the rules the server uses today (each marked `mirrors:`), so a scenario is written once, as the
 * staged rows and the store's own groups, and every definition of "pending" reads it. No clock: `NOW` is fixed.
 */

export type StagedText = {
  id: string;
  locale: string;
  field: string;
  pushed: boolean;
  status: 'changed' | 'unchanged' | 'invalid';
};
export type StagedAssetSet = {
  id: string;
  locale: string;
  device: string;
  pushed: boolean;
  files: number;
  cleared: boolean;
};
export type StagedReleaseField = {
  id: string;
  field: string;
  locale?: string;
  pushed: boolean;
  localOnly: boolean;
};
export type StagedRows = {
  text: StagedText[];
  assets: StagedAssetSet[];
  release: StagedReleaseField[];
};

/** One placement group of the store holding images of a display (an Apple group, a Play image type). */
export type StoreImageGroup = { locale: string; device: string; target: string; count: number };

export type ListingChannelFact = {
  channel: 'live' | 'editable';
  locales: string[];
  /** Google Play `details.defaultLanguage`; the App Store's primary locale is not read. */
  defaultLanguage: string | null;
};

/** The release notes of one locale in the five places (docs: audit listing F9); null = absent there. */
export type NotesPlaces = {
  store: Record<string, string>;
  staged: Record<string, string>;
  plan: Record<string, string>;
};

export type World = {
  name: string;
  /** What the scenario reproduces (the audit it comes from). */
  about: string;
  workspaceId: string;
  role: Role;
  now: number;
  scope: PlatformScope;
  records: AppSummary[];
  /** The store versions the app page loaded, by record (what the screens hold in their own lists). */
  releases: Record<string, ReleaseSummary[]>;
  /** `GET /apps/:id/builds/artifacts` store rows (TestFlight, version codes). */
  storeBuilds: Record<string, StoreBuildFact[]>;
  /** `GET /apps/:id/builds`: the rows of the database (`app_builds`). */
  appBuilds: Record<string, AppBuild[]>;
  /** `GET /apps/:id/release-pipeline`; absent: not read. */
  pipelines: Record<string, Pick<AppPipeline, 'app' | 'pipeline'>>;
  pipelineSummary: PipelineSummary | null;
  staged: Record<string, StagedRows>;
  /** A push wrote the draft and nothing submitted it yet (a `pushed_draft` pending item). */
  pushedDraft: Record<string, boolean>;
  /** Versions in review (informational pending items, nothing to do). */
  inReview: Record<string, number>;
  publishing: Record<string, Publishing | null>;
  lastRun: Record<string, LastPublish | null>;
  readiness: Record<string, ReadinessFact | null>;
  images: Record<string, StoreImageGroup[]>;
  listing: Record<string, ListingChannelFact[]>;
  notes: Record<string, NotesPlaces>;
};

export const emptyStaged = (): StagedRows => ({ text: [], assets: [], release: [] });

/** The id of a staged graphic set (`en-US/screenshot:ipad_13`), as the server names it. */
export const setId = (locale: string, device: string): string => `${locale}/${slotKey({ kind: 'screenshot', device })}`;

/** A quiet product: both records synced, nothing staged, nothing running, nothing left unfinished. */
export function baseWorld(over: Partial<World> = {}): World {
  const records = [IOS, ANDROID];
  const byRecord = <T>(make: () => T): Record<string, T> => ({
    [IOS.id]: make(),
    [ANDROID.id]: make(),
  });
  return {
    name: 'quiet',
    about: 'nothing staged, nothing running: every surface must say the same quiet things',
    workspaceId: 'ws-1',
    role: 'owner',
    now: NOW,
    scope: 'both',
    records,
    releases: {
      [IOS.id]: [iosRelease({ id: 'rel-1.0.0', version: '1.0.0', build: '10', status: 'live' })],
      [ANDROID.id]: [],
    },
    storeBuilds: {},
    appBuilds: {},
    pipelines: {},
    pipelineSummary: null,
    staged: byRecord(emptyStaged),
    pushedDraft: byRecord(() => false),
    inReview: byRecord(() => 0),
    publishing: byRecord(() => null),
    lastRun: byRecord(() => null),
    readiness: byRecord(() => null),
    images: byRecord(() => []),
    listing: byRecord(() => []),
    notes: byRecord(() => ({ store: {}, staged: {}, plan: {} })),
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
// The server's definitions of "pending", derived from the staged rows

const unpushedTexts = (s: StagedRows) => s.text.filter((t) => !t.pushed && t.status !== 'unchanged');
const unpushedAssets = (s: StagedRows) => s.assets.filter((a) => !a.pushed);
const unpushedRelease = (s: StagedRows) => s.release.filter((r) => !r.pushed && !r.localOnly);

/** mirrors: apps/server/src/modules/publish/cart.ts:190-260 (one cart item per staged text, per staged set, per staged release field). */
export function cartItemCount(w: World, appId: string): number {
  const s = w.staged[appId] ?? emptyStaged();
  return unpushedTexts(s).length + unpushedAssets(s).length + unpushedRelease(s).length;
}

/** mirrors: apps/server/src/modules/publish/app-facts.ts `cartSummary` (a line per app that holds something). */
export function cartSummaryOf(w: World): CartSummary {
  const apps = w.records
    .map((r) => ({ r, count: cartItemCount(w, r.id) }))
    .filter((x) => x.count > 0)
    .map(({ r, count }) => ({
      appId: r.id,
      id: r.id,
      app: { id: r.id, name: r.name, platform: r.platform, store: storeOf(r) },
      count,
      kinds: {} as Record<string, number | undefined>,
    }));
  return { apps, totals: { apps: apps.length, count: apps.reduce((n, a) => n + a.count, 0) }, generatedAt: w.now };
}

const storeOf = (r: AppSummary) => (r.platform === 'android' ? 'googleplay' : 'appstoreconnect');

/** mirrors: apps/server/src/modules/publish/pending.ts:236-330 `itemsOf` (ONE listing_text item for every staged text; one item per set / release field). */
export function pendingItemsOf(w: World, appId: string): PendingItem[] {
  const rec = w.records.find((r) => r.id === appId) as AppSummary;
  const s = w.staged[appId] ?? emptyStaged();
  const platform = rec.platform;
  const items: PendingItem[] = [];
  const texts = unpushedTexts(s);
  if (texts.length > 0)
    items.push({
      kind: 'listing_text',
      platform,
      id: 'listing_text',
      label: `${texts.length} listing text changes`,
      state: texts.some((t) => t.status === 'invalid') ? 'invalid' : 'staged',
      problems: texts
        .filter((t) => t.status === 'invalid')
        .map((t) => ({ severity: 'error', message: `${t.locale}/${t.field}`, code: 'invalid' })) as PendingItem['problems'],
      nextStep: 'push_draft',
      counts: { changes: texts.length, locales: new Set(texts.map((t) => t.locale)).size },
      refs: texts.map((t) => ({ id: t.id, locale: t.locale, field: t.field })),
      truncated: false,
      since: NOW - 3600_000,
    });
  for (const a of unpushedAssets(s))
    items.push({
      kind: 'asset_set',
      platform,
      id: a.id,
      label: `${a.id}: ${a.cleared ? 'every file removed' : `${a.files} files`}`,
      state: 'staged',
      problems: [],
      nextStep: 'push_draft',
      counts: { files: a.files },
      refs: [{ id: a.id, locale: a.locale }],
      truncated: false,
      since: NOW - 3600_000,
    });
  for (const r of unpushedRelease(s))
    items.push({
      kind: 'release_field',
      platform,
      id: r.id,
      label: r.field,
      state: 'staged',
      problems: [],
      nextStep: 'push_draft',
      counts: {},
      refs: [{ id: r.id, field: r.field, ...(r.locale !== undefined ? { locale: r.locale } : {}) }],
      truncated: false,
      since: NOW - 3600_000,
    });
  if (w.pushedDraft[appId] === true)
    items.push({
      kind: 'pushed_draft',
      platform,
      id: 'pushed_draft',
      label: 'Draft in the store, not submitted yet',
      state: 'pushed',
      problems: [],
      nextStep: 'submit',
      counts: {},
      refs: [],
      truncated: false,
      since: NOW - 600_000,
    });
  for (let i = 0; i < (w.inReview[appId] ?? 0); i++)
    items.push({
      kind: 'in_review',
      platform,
      id: `review-${i}`,
      label: 'Version in review',
      state: 'in_review',
      problems: [],
      nextStep: null,
      counts: {},
      refs: [],
      truncated: false,
      since: NOW - 86_400_000,
    });
  return items;
}

/** mirrors: apps/server/src/modules/publish/pending.ts:439 `totalsOf` (actionable = items with a next step; blocking = items with an error). */
export function totalsOf(items: readonly PendingItem[]): PendingTotals {
  return {
    items: items.length,
    actionable: items.filter((i) => i.nextStep !== null).length,
    blocking: items.filter((i) => i.problems.some((p) => p.severity === 'error')).length,
  };
}

/** mirrors: apps/server/src/modules/publish/app-facts.ts `pendingSummary` (count = the CART count; a pushed draft is `awaitingSubmit`, apart; waiting = informational rows). */
export function pendingSummaryOf(w: World): PendingSummary {
  const apps: PendingSummaryApp[] = [];
  for (const r of w.records) {
    const items = pendingItemsOf(w, r.id);
    if (items.length === 0) continue;
    const t = totalsOf(items);
    apps.push({
      appId: r.id,
      id: r.id,
      app: { id: r.id, name: r.name, platform: r.platform, store: storeOf(r) } as PendingSummaryApp['app'],
      count: cartItemCount(w, r.id),
      stagedUnpushed: cartItemCount(w, r.id),
      awaitingSubmit: items.filter((i) => i.kind === 'pushed_draft').length,
      awaitingRelease: 0,
      blocking: t.blocking,
      waiting: t.items - t.actionable,
      kinds: [],
      nextSteps: [],
      publishing: w.publishing[r.id] ?? null,
      lastPublish: w.lastRun[r.id] ?? null,
    });
  }
  return {
    apps,
    totals: { apps: apps.length, count: apps.reduce((n, a) => n + a.count, 0), blocking: apps.reduce((n, a) => n + a.blocking, 0) },
    generatedAt: w.now,
  };
}

/** mirrors: apps/server/src/modules/publish/app-facts.ts `getPending` (`GET /apps/:id/pending`: the per-app view the Pending page reads). */
export function pendingViewOf(w: World, appId: string): PendingView {
  const rec = w.records.find((r) => r.id === appId) as AppSummary;
  const items = pendingItemsOf(w, appId);
  const totals = totalsOf(items);
  return {
    app: { id: rec.id, name: rec.name, platform: rec.platform, store: storeOf(rec) } as PendingView['app'],
    platforms: [{ platform: rec.platform, store: storeOf(rec), items, totals }] as PendingView['platforms'],
    totals: {
      ...totals,
      count: cartItemCount(w, appId),
      stagedUnpushed: cartItemCount(w, appId),
      awaitingSubmit: items.filter((i) => i.kind === 'pushed_draft').length,
      awaitingRelease: 0,
      platforms: items.length > 0 ? [rec.platform] : [],
      nextSteps: [],
    },
    lastSyncedAt: rec.lastSyncedAt,
    publishing: w.publishing[appId] ?? null,
    lastPublish: w.lastRun[appId] ?? null,
    generatedAt: w.now,
  };
}

/** What the staged-changes view says (`GET /apps/:id/staged`), the rows the tray, the Graphics tab and the release step read. */
export function stagedViewOf(w: World, appId: string): StagedChangesView {
  const rec = w.records.find((r) => r.id === appId) as AppSummary;
  const s = w.staged[appId] ?? emptyStaged();
  return {
    app: { id: rec.id, name: rec.name, platform: rec.platform, store: storeOf(rec) },
    text: s.text.map((t) => ({
      id: t.id,
      kind: 'listing_text',
      locale: t.locale,
      field: t.field,
      label: t.field,
      source: 'manual',
      value: 'x',
      valueHash: t.id,
      limit: null,
      unit: 'characters',
      before: null,
      status: t.status,
      problems: [],
      pushedAt: t.pushed ? NOW : null,
      pushed: t.pushed,
      createdBy: 'u1',
      createdAt: NOW,
      updatedAt: NOW,
    })),
    assets: s.assets.map((a) => ({
      id: a.id,
      kind: 'asset',
      locale: a.locale,
      slot: { kind: 'screenshot', device: a.device },
      slotKey: slotKey({ kind: 'screenshot', device: a.device }),
      label: a.device,
      source: 'manual',
      files: Array.from({ length: a.files }, (_, i) => ({
        oid: `${a.id}-${i}`,
        name: `${i + 1}.png`,
        position: i + 1,
        upload: true,
        path: '',
        commit: '',
        width: null,
        height: null,
        bytes: null,
      })),
      cleared: a.cleared,
      status: 'changed',
      problems: [],
      pushedAt: a.pushed ? NOW : null,
      pushed: a.pushed,
      createdAt: NOW,
      updatedAt: NOW,
    })),
    totals: { text: s.text.length, assetSets: s.assets.length, assetFiles: 0, errors: 0, warnings: 0, changed: 0, release: s.release.length },
    valid: true,
    release: s.release.map((r) => ({
      id: r.id,
      field: r.field,
      locale: r.locale ?? null,
      label: r.field,
      pushed: r.pushed,
      localOnly: r.localOnly,
      problems: [],
    })),
    pushable: { textFields: [] },
    limits: {} as StagedChangesView['limits'],
  } as unknown as StagedChangesView;
}

/**
 * The store's own images of a record as `GET /apps/:id/assets/store` returns them.
 * mirrors: packages/connectors apple/appstore-draft.ts:395-440 (position = a running counter PER DEVICE across the groups of a locale).
 */
export function storeImagesViewOf(w: World, appId: string): StoreImagesView {
  const rec = w.records.find((r) => r.id === appId) as AppSummary;
  const running: Record<string, number> = {};
  const sets = (w.images[appId] ?? []).map((g) => {
    const key = `${g.locale}/${g.device}`;
    const files = Array.from({ length: g.count }, () => {
      running[key] = (running[key] ?? 0) + 1;
      const position = running[key] as number;
      return {
        ref: `${g.target}:${position}`,
        position,
        name: `${position}.png`,
        width: 2064,
        height: 2752,
        bytes: 1000,
        sizeFrom: 'store' as const,
        checksum: null,
        checksumKind: null,
        state: 'COMPLETE',
        downloadable: true,
      };
    });
    return {
      platform: 'apple' as const,
      locale: g.locale,
      kind: 'screenshot' as const,
      device: g.device,
      deviceLabel: 'iPad 13"',
      target: g.target,
      files,
    };
  });
  return {
    appId,
    platform: (rec.platform === 'android' ? 'google' : 'apple') as StoreImagesView['platform'],
    store: (rec.platform === 'android' ? 'google_play' : 'app_store') as StoreImagesView['store'],
    version: { id: 'v1', versionString: '1.19.0', state: 'PREPARE_FOR_SUBMISSION', editable: true },
    readAt: w.now,
    sets,
    unplaced: 0,
    notes: [],
  } as unknown as StoreImagesView;
}

/** The facts the model derives from, assembled with the model's own `assembleFacts` (the one place that says where each fact comes from). */
export function factsOf(w: World, releases: AppFacts['releases'] = w.releases): AppFacts {
  return assembleFacts(
    { role: w.role, records: w.records, releases, attention: [], now: w.now },
    {
      cart: cartSummaryOf(w),
      pendingSummary: pendingSummaryOf(w),
      publishing: (id) => w.publishing[id] ?? null,
      failure: (id) => w.lastRun[id] ?? null,
      pipeline: (id) => w.pipelines[id] ?? null,
      builds: (id) => w.storeBuilds[id] ?? null,
      readiness: (id) => w.readiness[id] ?? null,
      publishBatchEnabled: true,
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Scenarios (each from an audit; the first is the control)

const stall = (version: string): NonNullable<PipelineSummaryApp['stalled']> => ({
  step: 'prepare' as never,
  label: 'Prepare',
  message: `Version ${version} waits in Prepare for Submission`,
  hours: 700,
  since: NOW - 700 * 3_600_000,
  stale: false,
  evidence: [{ kind: 'version', id: version, at: null }],
});

const summaryOf = (apps: PipelineSummaryApp[]): PipelineSummary => ({
  stalledAfterHours: 48,
  apps,
  totals: { apps: apps.length, stalled: apps.filter((a) => a.stalled !== null).length, byState: {} },
  generatedAt: NOW,
});

const appBuildOf = (b: StoreBuildFact): AppBuild => ({
  platform: 'ios',
  buildNumber: b.buildNumber,
  version: b.version ?? '',
  tracks: [],
  status: null,
  rawState: 'VALID',
  uploadedAt: b.uploadedAt,
  syncedAt: NOW - 60_000,
  linkState: 'unlinked',
  link: null,
  diagnostic: null,
});

/** (i) the user's report: 1.19.0 phased (serving), the obsolete draft 1.11.6, TestFlight 2.00.1 build 95 (audit releases, surfaces). */
function iosPhasedObsolete(): World {
  const builds: StoreBuildFact[] = [
    testflight(),
    testflight({ buildNumber: '92', version: '1.11.6', uploadedAt: NOW - 200 * 86_400_000 }),
    testflight({ buildNumber: '88', version: '1.19.0', uploadedAt: NOW - 30 * 86_400_000 }),
  ];
  const pipeline = iosPipeline(
    'draft',
    { version: '1.11.6', build: null, status: 'draft' },
    { buildNumber: '92', version: '1.11.6' },
  );
  return baseWorld({
    name: 'ios-phased-obsolete-testflight',
    about: 'iOS 1.19.0 phased (rolling out), obsolete draft 1.11.6 in Prepare for Submission, TestFlight 2.00.1 build 95',
    scope: 'ios',
    records: [IOS],
    releases: {
      [IOS.id]: [
        iosRelease({ id: 'rel-1.19.0', version: '1.19.0', build: '88', status: 'rolling_out', rawState: 'READY_FOR_SALE', rolloutFraction: 0.2 }),
        iosRelease({ id: 'rel-1.11.6', version: '1.11.6', build: null, status: 'draft', rawState: 'PREPARE_FOR_SUBMISSION', storeUpdatedAt: null }),
      ],
    },
    storeBuilds: { [IOS.id]: builds },
    appBuilds: { [IOS.id]: builds.map(appBuildOf) },
    pipelines: { [IOS.id]: pipeline },
    pipelineSummary: summaryOf([
      {
        app: { id: IOS.id, name: IOS.name, platform: 'ios', store: 'appstoreconnect' },
        state: 'draft',
        waitingOn: 'you',
        since: NOW - 700 * 3_600_000,
        summary: 'Draft 1.11.6',
        lastSyncedAt: NOW - 60_000,
        stalled: stall('1.11.6'),
      },
    ]),
    staged: { [IOS.id]: emptyStaged() },
    pushedDraft: { [IOS.id]: false },
    inReview: { [IOS.id]: 0 },
    publishing: { [IOS.id]: null },
    lastRun: { [IOS.id]: null },
    readiness: { [IOS.id]: null },
    images: { [IOS.id]: [] },
    listing: { [IOS.id]: [] },
    notes: { [IOS.id]: { store: {}, staged: {}, plan: {} } },
  });
}

/** (ii) the iPad 13" display held by two placement groups: the "12 found" scenario (audit images F2, F4). */
function ipadSiblings(primary: number, legacy: number, removal = false): World {
  const total = primary + legacy;
  return baseWorld({
    name: `ipad-siblings-${primary}-${legacy}${removal ? '-staged-removal' : ''}`,
    about: `iPad 13" and 12.9" are two store groups holding ${primary} and ${legacy} images (a display of ${total})${removal ? `; one image is removed: a staged set of ${total - 1} files (the store seed is the merged display)` : ''}`,
    scope: 'ios',
    records: [IOS],
    releases: { [IOS.id]: [iosRelease()] },
    staged: {
      [IOS.id]: removal
        ? { text: [], assets: [{ id: setId('en-US', 'ipad_13'), locale: 'en-US', device: 'ipad_13', pushed: false, files: total - 1, cleared: false }], release: [] }
        : emptyStaged(),
    },
    images: {
      [IOS.id]: [
        { locale: 'en-US', device: 'ipad_13', target: 'APP_IPAD_PRO_3GEN_129', count: primary },
        { locale: 'en-US', device: 'ipad_13', target: 'APP_IPAD_PRO_129', count: legacy },
      ],
    },
  });
}

/** (iii) a staged removal and a staged text already pushed to the draft (audit images F3, pending). */
function stagedRemovalPushed(): World {
  return baseWorld({
    name: 'staged-removal-already-pushed',
    about: 'a staged removal of an iPad set and one text are already written to the draft (pushed); the draft is not submitted',
    scope: 'ios',
    records: [IOS],
    staged: {
      [IOS.id]: {
        text: [{ id: 't1', locale: 'en-US', field: 'description', pushed: true, status: 'changed' }],
        assets: [{ id: setId('en-US', 'ipad_13'), locale: 'en-US', device: 'ipad_13', pushed: true, files: 0, cleared: true }],
        release: [],
      },
    },
    pushedDraft: { [IOS.id]: true },
    images: { [IOS.id]: [{ locale: 'en-US', device: 'ipad_13', target: 'APP_IPAD_PRO_3GEN_129', count: 10 }] },
  });
}

/** (iv) the user's incident: the push applied, the submit was blocked; the store was fixed since (audit surfaces, blockers). */
function staleBlockersResolved(): World {
  const run = blockedRun('ios');
  return baseWorld({
    name: 'failed-run-stale-blockers-resolved',
    about: 'the last publish pushed the draft and its submit was blocked (2 blockers); a newer reading of the store says nothing blocks it now',
    scope: 'ios',
    records: [IOS],
    pushedDraft: { [IOS.id]: true },
    lastRun: { [IOS.id]: run },
    readiness: {
      [IOS.id]: {
        reading: { ready: true, blockers: [], unknown: [], versionString: '1.19.0', storeReadAt: run.finishedAt + 120_000 },
        checking: false,
        error: null,
      },
    },
  });
}

/** (v) Google Play: production live, a draft, a release in review, and a release in internal testing that can be promoted. */
function playDraftReviewPromotion(): World {
  const play = (over: Partial<ReleaseSummary>): ReleaseSummary => ({
    id: `rel-${over.version}-${over.track}`,
    appId: ANDROID.id,
    platform: 'android',
    version: '2.9.0',
    track: 'production',
    build: null,
    status: 'live',
    rawState: 'completed',
    rolloutFraction: null,
    versionCodes: ['160'],
    storeUpdatedAt: NOW - 20 * 86_400_000,
    syncedAt: NOW - 60_000,
    ...over,
  });
  return baseWorld({
    name: 'play-draft-review-promotion',
    about: 'Play: production 2.8.0 live (code 160), draft 2.10.0 (code 170), 2.9.0 in review (code 168), 2.9.0 in internal testing (code 167, promotable)',
    scope: 'android',
    records: [ANDROID],
    releases: {
      [ANDROID.id]: [
        play({ version: '2.8.0', status: 'live', versionCodes: ['160'] }),
        play({ version: '2.10.0', status: 'draft', rawState: 'draft', versionCodes: ['170'] }),
        play({ version: '2.9.0', status: 'in_review', rawState: 'inProgress', versionCodes: ['168'], sentForReviewAt: NOW - 3_600_000 }),
        play({ version: '2.9.0', track: 'internal', status: 'live', versionCodes: ['167'] }),
      ],
    },
    staged: { [ANDROID.id]: emptyStaged() },
  });
}

/** (vi) the locales of an iOS app: fr-FR only in the draft, empty; zh-Hans on the App Store, zh-CN on Google Play (audit listing F1, F10). */
function localesFrZh(): World {
  return baseWorld({
    name: 'locales-fr-empty-zh',
    about: 'iOS: live en-US + zh-Hans, the draft adds an empty fr-FR; Android: en-US + zh-CN (the same Chinese, two codes)',
    scope: 'both',
    listing: {
      [IOS.id]: [
        { channel: 'live', locales: ['en-US', 'zh-Hans'], defaultLanguage: null },
        { channel: 'editable', locales: ['en-US', 'fr-FR', 'zh-Hans'], defaultLanguage: null },
      ],
      [ANDROID.id]: [{ channel: 'live', locales: ['en-US', 'zh-CN'], defaultLanguage: 'en-GB' }],
    },
  });
}

/** (vii) the pending cart against the per-app view: three texts in two locales, a graphics set, a release field, a pushed draft, a version in review. */
function pendingCartVsView(): World {
  return baseWorld({
    name: 'pending-cart-vs-view',
    about: '3 staged texts (2 locales) + 1 staged set + 1 release field + a pushed draft + a version in review: the cart counts rows, the view counts items',
    scope: 'ios',
    records: [IOS],
    staged: {
      [IOS.id]: {
        text: [
          { id: 't1', locale: 'en-US', field: 'description', pushed: false, status: 'changed' },
          { id: 't2', locale: 'en-US', field: 'keywords', pushed: false, status: 'changed' },
          { id: 't3', locale: 'fr-FR', field: 'description', pushed: false, status: 'changed' },
        ],
        assets: [{ id: setId('en-US', 'iphone_6_9'), locale: 'en-US', device: 'iphone_6_9', pushed: false, files: 5, cleared: false }],
        release: [{ id: 'r1', field: 'whats_new', locale: 'en-US', pushed: false, localOnly: false }],
      },
    },
    pushedDraft: { [IOS.id]: true },
    inReview: { [IOS.id]: 1 },
  });
}

const emojiNote = (units: number): string => 'a'.repeat(units - 60) + '\u{1F600}'.repeat(30); // 30 emoji = 60 UTF-16 units

/** (viii) release notes in five places (audit listing F4, F5, F9): a Play note of 480 characters with 30 emoji (510 UTF-16 units). */
function notesFivePlaces(): World {
  const long = emojiNote(510);
  return baseWorld({
    name: 'release-notes-five-places',
    about: 'Play notes: en-US in the store (480 characters, 510 UTF-16 units), fr-FR staged; the plan has en-US only and an empty fr-FR',
    scope: 'android',
    records: [ANDROID],
    notes: {
      [ANDROID.id]: {
        store: { 'en-US': long },
        staged: { 'fr-FR': 'Corrections' },
        plan: { 'en-US': long, 'fr-FR': '' },
      },
    },
    listing: { [ANDROID.id]: [{ channel: 'editable', locales: ['en-US', 'fr-FR'], defaultLanguage: 'en-US' }] },
  });
}

export const SCENARIOS: Readonly<Record<string, () => World>> = {
  quiet: () => baseWorld(),
  'ios-phased-obsolete-testflight': iosPhasedObsolete,
  'ipad-siblings-10-2': () => ipadSiblings(10, 2),
  'ipad-siblings-8-4': () => ipadSiblings(8, 4),
  'ipad-siblings-10-2-staged-removal': () => ipadSiblings(10, 2, true),
  'staged-removal-already-pushed': stagedRemovalPushed,
  'failed-run-stale-blockers-resolved': staleBlockersResolved,
  'play-draft-review-promotion': playDraftReviewPromotion,
  'locales-fr-empty-zh': localesFrZh,
  'pending-cart-vs-view': pendingCartVsView,
  'release-notes-five-places': notesFivePlaces,
};
