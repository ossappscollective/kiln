import { PLATFORMS, type Platform, type StagedProblem, type StoreId, supports } from '@mrm/core';
import { type Database, nullableNumber, oneOf, type Sql } from '@mrm/db';
import { getApp, listApps, type ManagedApp } from '../../services/apps.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { storeFor } from '../reviews/sync.ts';
import { buildStagedView } from './staged-changes.ts';
import { loadPush, type PushRecord } from './store-draft-record.ts';

/**
 * Everything of an app that is waiting for somebody, in ONE place (docs/api/pending.md, docs/adr/0015-pending-and-batch-publish.md):
 * staged listing texts, staged graphics, staged release fields, drafts that were pushed to the store and not submitted yet, Google
 * Play draft releases that wait to be released, versions in review (nothing to do), versions approved and waiting for release, and
 * rollout steps of a release plan that are due.
 *
 * STORED STATE ONLY: this reads this server's own tables (`staged_changes`, `store_draft_pushes`, `app_releases` as of the last
 * store sync, `plan_rollout_steps`). It never contacts a store and never builds a connector, so it is cheap and works with every
 * switch off. What it says about the store is as fresh as the last sync (`lastSyncedAt`). It never carries a staged text.
 */

export const PENDING_KINDS = [
  'listing_text',
  'asset_set',
  'release_field',
  'pushed_draft',
  'draft_release',
  'in_review',
  'approved',
  'rollout_step',
] as const;
export type PendingKind = (typeof PENDING_KINDS)[number];

/** The gated steps a person takes to publish something, in the order they happen. */
export const PUBLISH_STEPS = ['push_draft', 'submit', 'release', 'rollout'] as const;
export type PublishStep = (typeof PUBLISH_STEPS)[number];

export type PendingProblem = {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  item?: string;
};

export type PendingItem = {
  kind: PendingKind;
  platform: Platform;
  /** Stable within the kind: the staged item id, `locale/slotKey`, `listing_text`, `pushed_draft`, `release:<id>`, `rollout:<id>`. */
  id: string;
  /** One sentence for a list. Built from labels, counts and versions: never a staged text. */
  label: string;
  state: 'staged' | 'invalid' | 'pushed' | 'in_review' | 'approved' | 'due';
  /** An `error` blocks the step this item needs; a `warning` does not. */
  problems: PendingProblem[];
  /** The publish step this item waits for. `null`: informational, nothing to do (in review). */
  nextStep: PublishStep | null;
  /** Numbers that describe it (`changes`, `locales`, `files`, `texts`, `assetSets`, `percent`). */
  counts: Record<string, number>;
  /** Ids of what it is made of (staged rows: `{ id, locale, field }`). At most 200; `truncated` says more exist. */
  refs: { id: string; locale?: string; field?: string }[];
  truncated: boolean;
  /** When it started waiting (epoch milliseconds), when known. */
  since: number | null;
};

export type PendingTotals = {
  /** Every item, including informational ones. */
  items: number;
  /** Items that wait for a step (`nextStep` is set). */
  actionable: number;
  /** Items with an `error` problem. */
  blocking: number;
};

export type PendingPlatform = {
  platform: Platform;
  store: StoreId;
  items: PendingItem[];
  totals: PendingTotals;
};

export type PendingView = {
  app: { id: string; name: string; platform: Platform; store: StoreId };
  /** One entry per platform of the app (an app has one platform today). */
  platforms: PendingPlatform[];
  totals: PendingTotals & { platforms: Platform[]; nextSteps: PublishStep[] };
  /** The last store sync: what is said about versions is as of then. */
  lastSyncedAt: number | null;
  generatedAt: number;
};

const MAX_REFS = 200;

const problemsOf = (problems: readonly StagedProblem[], item?: string): PendingProblem[] =>
  problems
    .filter((p) => p.severity === 'error' || p.severity === 'warning')
    .map((p) => ({
      code: p.code,
      severity: p.severity as 'error' | 'warning',
      message: p.message,
      ...(item !== undefined ? { item } : {}),
    }));

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------
// The facts: loaded for one app, or for every app of the workspace (a fixed number of queries)

type ReleaseFact = {
  id: string;
  version: string;
  track: string;
  status: string;
  since: number | null;
};
/** A Google Play release in `draft` status on a track, as of the last sync. */
type DraftReleaseFact = { id: string; track: string; codes: string[]; since: number | null };
type StepFact = { id: string; planVersion: string; percent: number; plannedAt: number };

export type PendingFacts = {
  /** App ids that have at least one staged row that was not pushed (only they get a staged view). */
  unpushed: Set<string>;
  pushes: Map<string, PushRecord>;
  releases: Map<string, ReleaseFact[]>;
  /** Google Play draft releases of the last sync, by app id. */
  drafts: Map<string, DraftReleaseFact[]>;
  steps: Map<string, StepFact[]>;
};

const append = <T>(map: Map<string, T[]>, key: string, value: T) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

export async function loadPendingFacts(
  sql: Sql,
  input: { workspaceId: string; appId?: string; now: number },
): Promise<PendingFacts> {
  const { workspaceId, appId } = input;
  const only = appId === undefined ? '' : ' AND app_id = ?';
  const args = (...rest: (string | number)[]) => (appId === undefined ? rest : [...rest, appId]);

  const unpushed = new Set<string>();
  for (const r of await sql.query(
    `SELECT DISTINCT app_id FROM staged_changes WHERE workspace_id = ?${only} AND (pushed_hash IS NULL OR pushed_hash <> value_hash)`,
    args(workspaceId),
  )) {
    unpushed.add(String(r.app_id));
  }

  const pushes = new Map<string, PushRecord>();
  for (const r of await sql.query(
    `SELECT app_id, platform FROM store_draft_pushes WHERE workspace_id = ?${only}`,
    args(workspaceId),
  )) {
    const record = await loadPush(sql, String(r.app_id), oneOf(r.platform, PLATFORMS, 'platform'));
    if (record) pushes.set(record.appId, record);
  }

  const releases = new Map<string, ReleaseFact[]>();
  for (const r of await sql.query(
    `SELECT id, app_id, version, track, status, status_since, synced_at FROM app_releases
      WHERE workspace_id = ?${only} AND status IN ('in_review', 'approved') ORDER BY version, track, id`,
    args(workspaceId),
  )) {
    append(releases, String(r.app_id), {
      id: String(r.id),
      version: String(r.version),
      track: String(r.track ?? ''),
      status: String(r.status),
      since: nullableNumber(r.status_since) ?? nullableNumber(r.synced_at),
    });
  }

  const drafts = new Map<string, DraftReleaseFact[]>();
  for (const r of await sql.query(
    `SELECT id, app_id, track, details_json, status_since, synced_at FROM app_releases
      WHERE workspace_id = ?${only} AND platform = 'android' AND status = 'draft' AND track <> '' ORDER BY track, id`,
    args(workspaceId),
  )) {
    let codes: string[] = [];
    try {
      const d = JSON.parse(String(r.details_json ?? '{}')) as { versionCodes?: unknown };
      if (Array.isArray(d.versionCodes)) codes = d.versionCodes.map((c) => String(c));
    } catch {
      // not JSON: a draft with no known codes
    }
    append(drafts, String(r.app_id), {
      id: String(r.id),
      track: String(r.track),
      codes,
      since: nullableNumber(r.status_since) ?? nullableNumber(r.synced_at),
    });
  }

  // Only the next step of a plan counts, and only when its planned time has passed.
  const steps = new Map<string, StepFact[]>();
  for (const r of await sql.query(
    `SELECT s.id, s.percent, s.planned_at, p.app_id, p.version
       FROM plan_rollout_steps s JOIN release_plans p ON p.id = s.plan_id AND p.workspace_id = s.workspace_id
      WHERE s.workspace_id = ? AND s.status = 'planned' AND s.planned_at IS NOT NULL AND s.planned_at <= ?${appId === undefined ? '' : ' AND p.app_id = ?'}
      ORDER BY p.id, s.position`,
    appId === undefined ? [workspaceId, input.now] : [workspaceId, input.now, appId],
  )) {
    const list = steps.get(String(r.app_id)) ?? [];
    // The earliest open step of a plan comes first: keep one per plan.
    if (list.some((x) => x.planVersion === String(r.version))) continue;
    append(steps, String(r.app_id), {
      id: String(r.id),
      planVersion: String(r.version),
      percent: Number(r.percent),
      plannedAt: Number(r.planned_at),
    });
  }
  return { unpushed, pushes, releases, drafts, steps };
}

// ---------------------------------------------------------------------------------------------
// The items of one app

type StagedView = Awaited<ReturnType<typeof buildStagedView>>;

function itemsOf(
  app: ManagedApp,
  facts: PendingFacts,
  staged: StagedView | undefined,
): PendingItem[] {
  const out: PendingItem[] = [];
  const platform = app.platform;

  if (staged) {
    const texts = staged.text.filter((t) => !t.pushed && t.status !== 'unchanged');
    if (texts.length > 0) {
      const locales = new Set(texts.map((t) => t.locale));
      out.push({
        kind: 'listing_text',
        platform,
        id: 'listing_text',
        label: `${plural(texts.length, 'listing text change', 'listing text changes')} in ${plural(locales.size, 'language', 'languages')}`,
        state: texts.some((t) => t.status === 'invalid') ? 'invalid' : 'staged',
        problems: texts.flatMap((t) => problemsOf(t.problems, `${t.locale}/${t.field}`)),
        nextStep: 'push_draft',
        counts: {
          changes: texts.length,
          locales: locales.size,
          invalid: texts.filter((t) => t.status === 'invalid').length,
        },
        refs: texts.slice(0, MAX_REFS).map((t) => ({ id: t.id, locale: t.locale, field: t.field })),
        truncated: texts.length > MAX_REFS,
        since: Math.min(...texts.map((t) => t.createdAt)),
      });
    }
    for (const a of staged.assets.filter((x) => !x.pushed)) {
      out.push({
        kind: 'asset_set',
        platform,
        id: a.id,
        label: `${a.label}: ${plural(a.files.length, 'file', 'files')}`,
        state: a.status === 'invalid' ? 'invalid' : 'staged',
        problems: problemsOf(a.problems, a.id),
        nextStep: 'push_draft',
        counts: { files: a.files.length },
        refs: [{ id: a.id, locale: a.locale }],
        truncated: false,
        since: a.createdAt,
      });
    }
    // The intended Google Play share is kept here only and never written: it is not a pending change.
    for (const r of (staged.release ?? []).filter((x) => !x.pushed && !x.localOnly)) {
      out.push({
        kind: 'release_field',
        platform,
        id: r.id,
        label: r.locale ? `${r.label} (${r.locale})` : r.label,
        state: r.status === 'invalid' ? 'invalid' : 'staged',
        problems: problemsOf(r.problems, r.locale ? `${r.field}/${r.locale}` : r.field),
        nextStep: 'push_draft',
        counts: {},
        refs: [{ id: r.id, ...(r.locale ? { locale: r.locale } : {}), field: r.field }],
        truncated: false,
        since: r.createdAt,
      });
    }
  }

  const record = facts.pushes.get(app.id);
  if (record) {
    const texts = record.manifest.text.length;
    const sets = record.manifest.assets.length;
    // A Google Play push that wrote only the release fields has nothing to submit: its draft release is the item below.
    if (!(supports(platform, 'releaseTracks') && texts + sets === 0)) {
      out.push({
        kind: 'pushed_draft',
        platform,
        id: 'pushed_draft',
        label: `Draft in the store, not submitted yet: ${plural(texts, 'text', 'texts')}, ${plural(sets, 'graphics set', 'graphics sets')}${record.versionString ? ` (version ${record.versionString})` : ''}`,
        state: 'pushed',
        problems: [],
        nextStep: 'submit',
        counts: { texts, assetSets: sets },
        refs: [],
        truncated: false,
        since: record.pushedAt,
      });
    }
  }

  // Google Play: a draft release in a track waits for the release step. Two sources, one rule (`draftReleasesOf`).
  for (const d of draftReleasesOf(app, facts)) {
    out.push({
      kind: 'draft_release',
      platform,
      id: d.id,
      label: `Draft release in ${d.track} with ${plural(d.codes.length, 'version code', 'version codes')}${d.codes.length > 0 ? ` ${d.codes.join(', ')}` : ''}, not released yet`,
      state: 'pushed',
      problems: [],
      nextStep: 'release',
      counts: { versionCodes: d.codes.length },
      refs: [],
      truncated: false,
      since: d.since,
    });
  }

  for (const r of facts.releases.get(app.id) ?? []) {
    const name = r.track ? `${r.version} on ${r.track}` : r.version;
    if (r.status === 'in_review') {
      out.push({
        kind: 'in_review',
        platform,
        id: `release:${r.id}`,
        label: `Version ${name} is in review`,
        state: 'in_review',
        problems: [],
        nextStep: null,
        counts: {},
        refs: [],
        truncated: false,
        since: r.since,
      });
    } else {
      out.push({
        kind: 'approved',
        platform,
        id: `release:${r.id}`,
        label: `Version ${name} is approved and waiting for release`,
        state: 'approved',
        problems: [],
        nextStep: 'release',
        counts: {},
        refs: [],
        truncated: false,
        since: r.since,
      });
    }
  }

  for (const s of facts.steps.get(app.id) ?? []) {
    out.push({
      kind: 'rollout_step',
      platform,
      id: `rollout:${s.id}`,
      label: `Rollout step of the plan for ${s.planVersion} is due: ${s.percent}%`,
      state: 'due',
      problems: [],
      nextStep: 'rollout',
      counts: { percent: s.percent },
      refs: [],
      truncated: false,
      since: s.plannedAt,
    });
  }
  return out;
}

const codesKey = (codes: readonly string[]) => [...codes].sort().join(',');

/**
 * The Google Play draft releases that wait to be released, for the pending view: (1) the one a push of this app wrote (its record
 * names track and codes, so it shows at once, before any sync), and (2) the draft releases the last store sync saw: in `production`,
 * or in any track when this app pushed something (a draft nobody pushed to a test track is not "pending"). A release that appears in
 * both is one item. A release that was released here is removed from the record and from the stored rows (store-release.ts).
 */
export function draftReleasesOf(
  app: Pick<ManagedApp, 'id' | 'platform'>,
  facts: Pick<PendingFacts, 'pushes' | 'drafts'>,
): { id: string; track: string; codes: string[]; since: number | null }[] {
  if (!supports(app.platform, 'releaseTracks')) return [];
  const out: { id: string; track: string; codes: string[]; since: number | null }[] = [];
  const record = facts.pushes.get(app.id);
  const pushed = record?.manifest.release;
  if (pushed)
    out.push({
      id: `draft_release:${pushed.track}:${codesKey(pushed.codes)}`,
      track: pushed.track,
      codes: [...pushed.codes].sort((a, b) => Number(a) - Number(b)),
      since: record?.pushedAt ?? null,
    });
  for (const d of facts.drafts.get(app.id) ?? []) {
    if (record === undefined && d.track !== 'production') continue;
    if (pushed && pushed.track === d.track && codesKey(pushed.codes) === codesKey(d.codes))
      continue;
    out.push({
      id: `draft_release:${d.track}:${codesKey(d.codes)}`,
      track: d.track,
      codes: [...d.codes].sort((a, b) => Number(a) - Number(b)),
      since: d.since,
    });
  }
  return out;
}

export function totalsOf(items: readonly PendingItem[]): PendingTotals {
  return {
    items: items.length,
    actionable: items.filter((i) => i.nextStep !== null).length,
    blocking: items.filter((i) => i.problems.some((p) => p.severity === 'error')).length,
  };
}

const nextStepsOf = (items: readonly PendingItem[]): PublishStep[] =>
  PUBLISH_STEPS.filter((s) => items.some((i) => i.nextStep === s));

const stagedViewFor = async (
  db: Database,
  workspaceId: string,
  app: ManagedApp,
  facts: PendingFacts,
  now: number,
): Promise<StagedView | undefined> =>
  facts.unpushed.has(app.id)
    ? buildStagedView({ db, now: () => now }, workspaceId, app)
    : undefined;

/** The pending items of an app. Stored state only. */
export async function pendingItemsOf(
  db: Database,
  input: { workspaceId: string; app: ManagedApp; now: number },
): Promise<PendingItem[]> {
  const facts = await loadPendingFacts(db, {
    workspaceId: input.workspaceId,
    appId: input.app.id,
    now: input.now,
  });
  return itemsOf(
    input.app,
    facts,
    await stagedViewFor(db, input.workspaceId, input.app, facts, input.now),
  );
}

/** `GET /apps/{id}/pending`: the stored state only, no store is contacted. */
export async function getPending(
  db: Database,
  input: { workspaceId: string; appId: string; now: number },
): Promise<{ ok: true; pending: PendingView } | Failure> {
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const items = await pendingItemsOf(db, { workspaceId: input.workspaceId, app, now: input.now });
  const totals = totalsOf(items);
  return {
    ok: true,
    pending: {
      app: { id: app.id, name: app.name, platform: app.platform, store: storeFor(app.platform) },
      platforms: [{ platform: app.platform, store: storeFor(app.platform), items, totals }],
      totals: {
        ...totals,
        platforms: items.length > 0 ? [app.platform] : [],
        nextSteps: nextStepsOf(items),
      },
      lastSyncedAt: app.lastSyncedAt,
      generatedAt: input.now,
    },
  };
}

export type PendingSummaryApp = {
  /** Both `appId` and `id`, so a token limited to some apps is filtered by the usual rule. */
  appId: string;
  id: string;
  app: { id: string; name: string; platform: Platform; store: StoreId };
  /** Items that wait for a step. */
  count: number;
  /** Items with an error. */
  blocking: number;
  /** Informational items (in review): nothing to do. */
  waiting: number;
  kinds: PendingKind[];
  nextSteps: PublishStep[];
};

export type PendingSummary = {
  /** Only apps with something pending or in review; an app that is not listed has nothing. */
  apps: PendingSummaryApp[];
  totals: { apps: number; count: number; blocking: number };
  generatedAt: number;
};

/** `GET /pending/summary`: one line per app that has something, from stored state, a fixed number of queries plus one staged view per app with unpushed items. */
export async function pendingSummary(
  db: Database,
  input: { workspaceId: string; appIds?: readonly string[] | undefined; now: number },
): Promise<PendingSummary> {
  const wanted = input.appIds === undefined ? undefined : new Set(input.appIds);
  const apps = (await listApps(db, input.workspaceId)).filter(
    (a) => wanted === undefined || wanted.has(a.id),
  );
  const facts = await loadPendingFacts(db, { workspaceId: input.workspaceId, now: input.now });
  const lines: PendingSummaryApp[] = [];
  for (const app of apps) {
    const items = itemsOf(
      app,
      facts,
      await stagedViewFor(db, input.workspaceId, app, facts, input.now),
    );
    if (items.length === 0) continue;
    const totals = totalsOf(items);
    const actionable = items.filter((i) => i.nextStep !== null);
    lines.push({
      appId: app.id,
      id: app.id,
      app: { id: app.id, name: app.name, platform: app.platform, store: storeFor(app.platform) },
      count: totals.actionable,
      blocking: totals.blocking,
      waiting: totals.items - totals.actionable,
      kinds: PENDING_KINDS.filter((k) => actionable.some((i) => i.kind === k)),
      nextSteps: nextStepsOf(items),
    });
  }
  lines.sort(
    (a, b) =>
      b.blocking - a.blocking ||
      b.count - a.count ||
      a.app.name.localeCompare(b.app.name) ||
      a.appId.localeCompare(b.appId),
  );
  return {
    apps: lines,
    totals: {
      apps: lines.filter((l) => l.count > 0).length,
      count: lines.reduce((n, l) => n + l.count, 0),
      blocking: lines.reduce((n, l) => n + l.blocking, 0),
    },
    generatedAt: input.now,
  };
}
