import {
  type AssetDiffSet,
  type AssetKind,
  type AssetProblem,
  type AssetProposalView,
  type AssetSlot,
  assetSlotSupport,
  checkListing,
  type CheckLocaleText,
  compareDottedVersions,
  graphicsItemId,
  isDottedVersion,
  isStageableTextField,
  listingStoreOf,
  type ProposalFile,
  type ProposalGraphics,
  type ProposalIssue,
  type ProposalItem,
  type ProposalRef,
  type ProposalSeverity,
  type ProposalStaged,
  type ProposalState,
  type ProposalText,
  type ProposalUnavailable,
  orderIssues,
  slotKey,
  STAGED_LIMITS,
  summarizeProposal,
  textItemId,
} from '@kiln/core';
import type { Database, Sql } from '@kiln/db';
import { coded } from '../../i18n/problem.ts';
import { getApp, listAppReleases, type ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import {
  type Failure,
  failure,
  getRepository,
  githubFailure,
  openConnectorForRepository,
  readRepositoryListing,
} from '../../services/repositories.ts';
import { metadataLock, metadataLockedFailure } from '../publish/metadata-lock.ts';
import {
  loadStagedRows,
  type StagedContext,
  type StagedRow,
  stageAssets,
  stageText,
} from '../publish/staged-changes.ts';
import { type AssetSyncContext, buildAssetDiff } from './asset-diff.ts';
import type { AssetView } from './asset-index.ts';
import { isCommitSha, openAssets } from './asset-repo.ts';
import { STAGE_BUDGET_MS } from './compare-deadline.ts';
import {
  fieldKey,
  flattenListing,
  hasStoreListing,
  normalizeListingValue,
  sideProblems,
  splitKey,
} from './drift.ts';
import { getLiveListing } from './live.ts';
import { mergedListing } from './sources.ts';
import { listListingTargets } from './targets.ts';

/**
 * "Store assets changed in the repository" while a release is prepared (docs/adr/0063-release-asset-proposal.md, docs/api/release-asset-proposal.md).
 *
 * The repository is read at TWO commits: the source of the previous release (the commit of the build that was released, as `build_links` records
 * it; else the newest repository read this tool made at or before that release's last store update) and the source of this release (the commit of
 * its build, else the default branch). What changed between them, in the places Kiln already reads for the app (the listing target of the app),
 * and still differs from the store (the editable version's texts where there are any, else the live ones) and from the cart, is proposed.
 * The findings come from the checks that exist: the listing checks and limits (`checkListing`, `sideProblems`) on the repository's texts, and the
 * graphics rules of the asset index (`problems` of the index of the target commit). The server is the author of everything staged: a request
 * names item ids, the proposal is computed again, and nothing a client sends is a text or a path.
 *
 * Reading the repository for this purpose is part of preparing a release: it does NOT need the app's `compareRepo` / `compareMedia` settings
 * (they stay about the warnings of the listing and Graphics pages). It never runs for an app with no repository.
 */

type Actor = { type: 'user' | 'token' | 'system'; id: string };

/** Most items a proposal lists (a repository with hundreds of locales shows the first ones and says so). */
export const MAX_PROPOSAL_ITEMS = 400;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+ -]{0,39}$/;
export const isReleaseLabel = (value: string): boolean => VERSION_PATTERN.test(value);

// ---------------------------------------------------------------------------------------------
// What was decided for a release (workspace_settings, no migration)

export const proposalStateKey = (appId: string, version: string | null, track: string | null): string =>
  `app.${appId}.assetProposal.${version ?? '-'}|${track ?? '-'}`;

export async function readProposalState(
  sql: Sql,
  workspaceId: string,
  appId: string,
  version: string | null,
  track: string | null,
): Promise<ProposalState> {
  const [row] = await sql.query('SELECT value_json FROM workspace_settings WHERE workspace_id = ? AND key = ?', [
    workspaceId,
    proposalStateKey(appId, version, track),
  ]);
  if (!row) return { state: 'open', at: null };
  try {
    const raw = JSON.parse(String(row.value_json)) as { state?: unknown; at?: unknown };
    const state = raw.state === 'skipped' || raw.state === 'later' ? raw.state : 'open';
    return { state, at: typeof raw.at === 'number' ? raw.at : null };
  } catch {
    return { state: 'open', at: null };
  }
}

/** Deleted with the app (services/apps.ts). */
export const deleteProposalStates = (sql: Sql, workspaceId: string, appId: string) =>
  sql.execute('DELETE FROM workspace_settings WHERE workspace_id = ? AND key LIKE ?', [workspaceId, `app.${appId}.assetProposal.%`]);

export type ProposalQuery = { version: string | null; track: string | null; build: string | null };

export async function setProposalState(
  db: Database,
  input: { workspaceId: string; appId: string; query: ProposalQuery; mode: 'skip' | 'later' | 'reopen'; actor: Actor },
  now: number,
): Promise<{ ok: true; state: ProposalState } | Failure> {
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const state: ProposalState = input.mode === 'reopen' ? { state: 'open', at: null } : { state: input.mode === 'skip' ? 'skipped' : 'later', at: now };
  await db.transaction(async (tx) => {
    const key = proposalStateKey(app.id, input.query.version, input.query.track);
    if (state.state === 'open') await tx.execute('DELETE FROM workspace_settings WHERE workspace_id = ? AND key = ?', [input.workspaceId, key]);
    else
      await tx.execute(
        `INSERT INTO workspace_settings (workspace_id, key, value_json, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, key) DO UPDATE SET
           value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        [input.workspaceId, key, JSON.stringify(state), now, input.actor.id],
      );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'release.asset_proposal_decided',
      target: { type: 'app', id: app.id },
      detail: { appId: app.id, version: input.query.version, track: input.query.track, state: state.state },
      at: now,
    });
  });
  return { ok: true, state };
}

// ---------------------------------------------------------------------------------------------
// The two refs

export const EDITABLE_STATES = ['draft', 'build_chosen', 'ready', 'rejected'];

async function buildCommit(sql: Sql, workspaceId: string, app: ManagedApp, build: string | null): Promise<string | null> {
  if (!build) return null;
  const [row] = await sql.query(
    'SELECT head_sha FROM build_links WHERE workspace_id = ? AND app_id = ? AND platform = ? AND build_number = ?',
    [workspaceId, app.id, app.platform, build],
  );
  const sha = row ? String(row.head_sha) : '';
  return isCommitSha(sha) ? sha : null;
}

type Refs = { base: ProposalRef | null; target: ProposalRef | null };

/**
 * The commits of the previous release and of this one, from what Kiln records. Target: the build chosen for the release (the query, or the build of
 * the stored release of that version), else the default branch (resolved by the caller). Base: the newest earlier version with a build whose
 * commit is known, else the newest repository read at or before the last update of the previous release.
 */
export async function releaseRefs(sql: Sql, workspaceId: string, app: ManagedApp, query: ProposalQuery): Promise<Refs> {
  const releases = await listAppReleases(sql, workspaceId, app.id);
  const mine = query.version ? releases.filter((r) => r.version === query.version) : [];
  let target: ProposalRef | null = null;
  const chosen = await buildCommit(sql, workspaceId, app, query.build);
  if (chosen) target = { sha: chosen, source: 'build' };
  else
    for (const r of mine) {
      const sha = await buildCommit(sql, workspaceId, app, r.build ? r.build.split(',')[0]?.trim() ?? null : null);
      if (sha) {
        target = { sha, source: 'build' };
        break;
      }
    }
  const earlier = releases
    .filter((r) => r.version !== query.version && !(r.status !== null && EDITABLE_STATES.includes(r.status)))
    .filter((r) => query.version === null || !isDottedVersion(r.version) || !isDottedVersion(query.version) || compareDottedVersions(r.version, query.version) < 0)
    .sort((a, b) =>
      isDottedVersion(a.version) && isDottedVersion(b.version)
        ? compareDottedVersions(b.version, a.version)
        : (b.storeUpdatedAt ?? 0) - (a.storeUpdatedAt ?? 0),
    );
  let base: ProposalRef | null = null;
  for (const r of earlier) {
    const sha = await buildCommit(sql, workspaceId, app, r.build ? r.build.split(',')[0]?.trim() ?? null : null);
    if (sha) {
      base = { sha, source: 'previous_build' };
      break;
    }
  }
  if (!base && earlier[0]?.storeUpdatedAt) {
    const [row] = await sql.query(
      `SELECT source_ref FROM listing_snapshots
        WHERE workspace_id = ? AND app_id = ? AND source = 'repo' AND source_ref IS NOT NULL AND observed_at <= ?
        ORDER BY observed_at DESC LIMIT 1`,
      [workspaceId, app.id, earlier[0].storeUpdatedAt],
    );
    const sha = row ? String(row.source_ref) : '';
    if (isCommitSha(sha)) base = { sha, source: 'repo_snapshot' };
  }
  return { base, target };
}

// ---------------------------------------------------------------------------------------------
// Text

/** Control characters other than the line break and the tab are dropped: a repository's text is untrusted. */
const clean = (value: string): string => normalizeListingValue(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''));

type TextRead = { values: Map<string, string>; found: boolean };

/** The listing of the app's store in the repository at one ref: the app's listing target, the same folders as every other read. */
async function readTextsAt(
  ctx: AssetSyncContext,
  input: { workspaceId: string; app: ManagedApp; repository: NonNullable<Awaited<ReturnType<typeof getRepository>>>; connector: Parameters<typeof readRepositoryListing>[3]; ref: string },
): Promise<{ ok: true; read: TextRead } | Failure> {
  const { repo } = ctx.assets;
  const targets = await listListingTargets(repo.db, input.workspaceId, input.repository.id);
  const mine = targets.find((t) => t.appId === input.app.id);
  const read = await readRepositoryListing(
    repo,
    input.workspaceId,
    { ...input.repository, defaultBranch: input.ref },
    input.connector,
    mine ? { target: mine.id } : undefined,
  );
  if (!read.ok) return read;
  const listing = mergedListing(read.listings);
  const found = hasStoreListing(listing, input.app.platform);
  const values = new Map<string, string>();
  if (found)
    for (const v of flattenListing(listing, input.app.platform)) {
      const text = clean(v.value);
      if (text !== '') values.set(fieldKey(v.locale, v.field), text);
    }
  return { ok: true, read: { values, found } };
}

const severityOf = (s: 'problem' | 'warning' | 'tip' | 'error' | 'info'): ProposalSeverity =>
  s === 'problem' || s === 'error' ? 'error' : s === 'warning' ? 'warning' : 'tip';

/** The rules the listing checks already say; the other findings of the limits (URL, short keywords, ...) are added as they are. */
const COVERED_BY_CHECKS = new Set(['too_long', 'missing_required', 'keywords_duplicate']);

type TextPlan = {
  items: ProposalText[];
  staged: ProposalStaged[];
  issues: ProposalIssue[];
  unchangedSinceRelease: number;
  sameAsStore: number;
  notStageable: number;
  truncated: boolean;
};

export function planTexts(input: {
  platform: ManagedApp['platform'];
  base: Map<string, string> | null;
  target: Map<string, string>;
  store: Record<string, Record<string, string>>;
  staged: Map<string, string>;
}): TextPlan {
  const { platform } = input;
  const plan: TextPlan = { items: [], staged: [], issues: [], unchangedSinceRelease: 0, sameAsStore: 0, notStageable: 0, truncated: false };
  const proposed = new Map<string, string>();
  const keys = [...input.target.keys()].sort();
  for (const key of keys) {
    const { locale, field } = splitKey(key);
    const after = input.target.get(key) as string;
    if (input.base !== null && input.base.get(key) === after) {
      plan.unchangedSinceRelease += 1;
      continue;
    }
    if (!isStageableTextField(platform, field) || after.length > STAGED_LIMITS.maxTextChars) {
      plan.notStageable += 1;
      continue;
    }
    const storeValue = input.store[locale]?.[field];
    if (storeValue !== undefined && clean(storeValue) === after) {
      plan.sameAsStore += 1;
      continue;
    }
    const staged = input.staged.get(key);
    const id = textItemId(locale, field);
    if (staged !== undefined) {
      plan.staged.push({ id, kind: 'text', locale, field, state: staged === after ? 'same' : 'edited' });
      if (staged === after) proposed.set(key, after);
      continue;
    }
    if (plan.items.length >= MAX_PROPOSAL_ITEMS) {
      plan.truncated = true;
      continue;
    }
    plan.items.push({ id, kind: 'text', locale, field, before: storeValue === undefined ? null : storeValue, after, hasErrors: false });
    proposed.set(key, after);
  }
  if (plan.items.length === 0) return plan;

  // The findings: the page as it would be with the proposed texts in place (the repository's, over the store's and the cart's).
  const store = listingStoreOf(platform);
  const locales = new Set<string>(Object.keys(input.store));
  for (const key of input.target.keys()) locales.add(splitKey(key).locale);
  const entries: CheckLocaleText[] = [...locales].sort().map((locale) => {
    const fields: Record<string, string | undefined> = { ...(input.store[locale] ?? {}) };
    for (const [key, value] of input.staged) if (splitKey(key).locale === locale) fields[splitKey(key).field] = value;
    for (const [key, value] of proposed) if (splitKey(key).locale === locale) fields[splitKey(key).field] = value;
    return { locale, fields };
  });
  const ids = new Map<string, string>();
  for (const item of plan.items) ids.set(fieldKey(item.locale, item.field), item.id);
  const localeItem = new Map<string, string>();
  for (const item of plan.items) if (!localeItem.has(item.locale)) localeItem.set(item.locale, item.id);
  const seen = new Set<string>();
  const add = (issue: ProposalIssue) => {
    if (seen.has(issue.id)) return;
    seen.add(issue.id);
    plan.issues.push(issue);
  };
  for (const entry of checkListing({ store, locales: entries }).locales) {
    for (const i of entry.issues) {
      const itemId = i.field === null ? (localeItem.get(entry.locale) ?? null) : (ids.get(fieldKey(entry.locale, i.field)) ?? null);
      if (itemId === null) continue;
      add({ id: `${itemId}:listing_check:${i.code}`, itemId, source: 'listing_check', severity: severityOf(i.severity), code: i.code, locale: entry.locale, field: i.field, params: i.params, message: null });
    }
  }
  const sides = new Map<string, string>(proposed);
  for (const [key, problems] of sideProblems(platform, sides)) {
    const { locale, field } = splitKey(key);
    const itemId = ids.get(key);
    if (!itemId) continue;
    for (const p of problems) {
      if (COVERED_BY_CHECKS.has(p.code)) continue;
      add({
        id: `${itemId}:listing_rule:${p.code}`,
        itemId,
        source: 'listing_rule',
        severity: severityOf(p.severity),
        code: p.code,
        locale,
        field,
        params: { ...(p.limit !== undefined ? { limit: p.limit } : {}), ...(p.actual !== undefined ? { actual: p.actual } : {}), ...(p.unit ? { unit: p.unit } : {}) },
        message: p.message,
      });
    }
  }
  const errors = new Set(plan.issues.filter((i) => i.severity === 'error' && i.itemId !== null).map((i) => i.itemId));
  for (const item of plan.items) item.hasErrors = errors.has(item.id);
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Graphics

type Group = { locale: string; slot: AssetSlot; files: AssetView[] };

function groupsOf(assets: readonly AssetView[]): Map<string, Group> {
  const out = new Map<string, Group>();
  for (const a of assets) {
    if (a.origin !== 'store') continue;
    const slot: AssetSlot = { kind: a.kind, device: a.device };
    const key = `${a.locale}\u0000${slotKey(slot)}`;
    const g = out.get(key) ?? { locale: a.locale, slot, files: [] };
    g.files.push(a);
    out.set(key, g);
  }
  for (const g of out.values()) g.files.sort((a, b) => a.order - b.order || a.path.localeCompare(b.path));
  return out;
}

const signature = (g: Group | undefined): string => (g ? g.files.map((f) => `${f.path}\u0000${f.oid ?? ''}`).join('\n') : '');

const fileOf = (a: AssetView): ProposalFile => ({ path: a.path, oid: a.oid, width: a.width, height: a.height, bytes: a.bytes, format: a.format });

type GraphicsPlan = Omit<TextPlan, 'items' | 'staged'> & { items: ProposalGraphics[]; staged: ProposalStaged[] };

export function planGraphics(input: {
  platform: ManagedApp['platform'];
  base: readonly AssetView[] | null;
  target: readonly AssetView[];
  commit: string;
  problems: readonly AssetProblem[];
  storeSets: readonly AssetDiffSet[] | null;
  staged: readonly StagedRow[];
}): GraphicsPlan {
  const plan: GraphicsPlan = { items: [], staged: [], issues: [], unchangedSinceRelease: 0, sameAsStore: 0, notStageable: 0, truncated: false };
  const base = input.base === null ? null : groupsOf(input.base);
  const target = groupsOf(input.target);
  const stagedBy = new Map<string, StagedRow[]>();
  for (const r of input.staged) {
    if (r.kind !== 'asset') continue;
    const k = `${r.locale}\u0000${r.target}`;
    stagedBy.set(k, [...(stagedBy.get(k) ?? []), r]);
  }
  for (const key of [...target.keys()].sort()) {
    const g = target.get(key) as Group;
    if (base !== null && signature(base.get(key)) === signature(g)) {
      plan.unchangedSinceRelease += 1;
      continue;
    }
    const slot = slotKey(g.slot);
    const stageable =
      assetSlotSupport(input.platform, g.slot).ok &&
      g.files.every((f) => f.format !== 'video' && f.format !== null) &&
      (g.slot.kind !== 'screenshot' || g.slot.device !== null);
    if (!stageable) {
      plan.notStageable += 1;
      continue;
    }
    const diff = input.storeSets?.find((s) => s.locale === g.locale && s.kind === g.slot.kind && (s.device ?? null) === g.slot.device);
    if (diff?.inSync) {
      plan.sameAsStore += 1;
      continue;
    }
    const id = graphicsItemId(g.locale, slot);
    const rows = (stagedBy.get(`${g.locale}\u0000${slot}`) ?? []).sort((a, b) => a.ordinal - b.ordinal);
    if (rows.length > 0) {
      const same = rows.length === g.files.length && rows.every((r, i) => r.assetPath === g.files[i]?.path && r.assetCommit === input.commit);
      plan.staged.push({ id, kind: 'graphics', locale: g.locale, field: slot, state: same ? 'same' : 'edited' });
      continue;
    }
    if (plan.items.length >= MAX_PROPOSAL_ITEMS) {
      plan.truncated = true;
      continue;
    }
    const mine = input.problems.filter((p) => (p.locale === undefined || p.locale === g.locale) && p.kind === g.slot.kind && (p.device ?? null) === g.slot.device);
    const issues: ProposalIssue[] = mine.map((p) => ({
      id: `${id}:graphics_rule:${p.rule}${p.path ? `:${p.path}` : ''}`,
      itemId: id,
      source: 'graphics_rule',
      severity: severityOf(p.severity),
      code: p.rule,
      locale: g.locale,
      field: p.path ?? null,
      params: {},
      message: p.message,
    }));
    plan.issues.push(...issues);
    plan.items.push({
      id,
      kind: 'graphics',
      locale: g.locale,
      slot,
      slotKind: g.slot.kind as AssetKind,
      device: g.slot.device,
      deviceLabel: g.files[0]?.deviceLabel ?? '',
      before: diff ? diff.rows.filter((r) => r.store !== null).length : input.storeSets === null ? null : 0,
      after: { count: g.files.length, commit: input.commit, files: g.files.map(fileOf) },
      hasErrors: issues.some((i) => i.severity === 'error'),
    });
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------
// The proposal

export type ProposalContext = { sync: AssetSyncContext; staged: StagedContext };

const empty = (app: ManagedApp, query: ProposalQuery, unavailable: ProposalUnavailable, extra: Partial<AssetProposalView> = {}): AssetProposalView => ({
  appId: app.id,
  platform: app.platform,
  version: query.version,
  unavailable,
  state: { state: 'open', at: null },
  locked: { locked: false, reason: null, liveVersion: null },
  baseRef: null,
  targetRef: null,
  noPreviousRelease: false,
  storeUnread: false,
  changes: [],
  alreadyStaged: [],
  issues: [],
  summary: summarizeProposal([], []),
  skipped: { unchangedSinceRelease: 0, sameAsStore: 0, notStageable: 0 },
  notes: [],
  ...extra,
});

export type ProposalResult = { ok: true; view: AssetProposalView } | Failure;

export async function getAssetProposal(
  ctx: ProposalContext,
  input: { workspaceId: string; appId: string; query: ProposalQuery; actor: Actor; gate?: () => Failure | undefined },
): Promise<ProposalResult> {
  const { workspaceId } = input;
  const db = ctx.staged.db;
  const app = await getApp(db, workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const { query } = input;
  if (!app.repositoryId) return { ok: true, view: empty(app, query, 'no_repository') };
  const repository = await getRepository(db, workspaceId, app.repositoryId);
  if (!repository) return { ok: true, view: empty(app, query, 'no_repository') };

  const state = await readProposalState(db, workspaceId, app.id, query.version, query.track);
  const lock = await metadataLock(db, workspaceId, app);
  const refs = await releaseRefs(db, workspaceId, app, query);
  const notes: string[] = [];

  const opened = await openConnectorForRepository(ctx.sync.assets.repo, workspaceId, repository, input.actor, 'repository.listing');
  if (!opened.ok) return opened;
  let targetSha = refs.target?.sha ?? null;
  let targetRef = refs.target;
  try {
    if (!targetSha) {
      const resolve = opened.connector.resolveCommit;
      if (typeof resolve === 'function') {
        const sha = await resolve.call(opened.connector, repository.defaultBranch);
        if (isCommitSha(sha)) {
          targetSha = sha;
          targetRef = { sha, source: 'default_branch' };
        }
      }
    }
  } catch (error) {
    return githubFailure(error, opened.secret);
  }
  const targetName = targetSha ?? repository.defaultBranch;

  let target: Awaited<ReturnType<typeof readTextsAt>>;
  try {
    target = await readTextsAt(ctx.sync, { workspaceId, app, repository, connector: opened.connector, ref: targetName });
  } catch (error) {
    return githubFailure(error, opened.secret);
  }
  if (!target.ok) return { ok: true, view: empty(app, query, 'target_unreadable', { state, locked: lock, targetRef, notes: [String(target.body.message ?? target.body.error).slice(0, 300)] }) };

  let baseTexts: Map<string, string> | null = null;
  let baseRef = refs.base;
  if (baseRef && baseRef.sha !== targetSha) {
    try {
      const b = await readTextsAt(ctx.sync, { workspaceId, app, repository, connector: opened.connector, ref: baseRef.sha });
      if (b.ok && b.read.found) baseTexts = b.read.values;
      else {
        baseRef = null;
        notes.push('base_unreadable');
      }
    } catch {
      baseRef = null;
      notes.push('base_unreadable');
    }
  } else if (baseRef) {
    baseTexts = target.read.values;
  }

  // The store's texts (the editable version's where there are any) and what the cart holds.
  const live = await getLiveListing(db, workspaceId, { id: app.id, platform: app.platform, identifier: app.identifier });
  const channel = live.channels.find((c) => c.channel === 'editable') ?? live.channels.find((c) => c.channel === 'live');
  const storeTexts: Record<string, Record<string, string>> = channel ? channel.locales : {};
  const rows = await loadStagedRows(db, workspaceId, app.id);
  const stagedTexts = new Map<string, string>();
  for (const r of rows) if (r.kind === 'listing_text' && r.ordinal === 0 && r.valueText !== null) stagedTexts.set(fieldKey(r.locale, r.target), clean(r.valueText));

  // Graphics: the index of both commits (cached per commit), the store's images from the cached store read.
  let graphicsTarget: Awaited<ReturnType<typeof openAssets>> | null = null;
  let graphicsBase: Awaited<ReturnType<typeof openAssets>> | null = null;
  graphicsTarget = await openAssets(ctx.sync.assets, { workspaceId, app, ...(targetSha ? { commit: targetSha } : {}) }, input.actor, { ...(input.gate ? { onCompute: input.gate } : {}) });
  if (!graphicsTarget.ok && graphicsTarget.status === 429) return graphicsTarget;
  if (baseRef && baseRef.sha !== targetSha && graphicsTarget.ok) {
    graphicsBase = await openAssets(ctx.sync.assets, { workspaceId, app, commit: baseRef.sha }, input.actor, { ...(input.gate ? { onCompute: input.gate } : {}) });
    if (!graphicsBase.ok && graphicsBase.status === 429) return graphicsBase;
  }
  const textPlan = planTexts({ platform: app.platform, base: baseTexts, target: target.read.values, store: storeTexts, staged: stagedTexts });

  let graphicsPlan: GraphicsPlan | null = null;
  let storeUnread = false;
  const targetView = graphicsTarget.ok ? graphicsTarget.handle.view : null;
  if (targetView && targetView.status === 'ok' && targetView.commit && isCommitSha(targetView.commit)) {
    const baseView = graphicsBase && graphicsBase.ok && graphicsBase.handle.view.status === 'ok' ? graphicsBase.handle.view : null;
    if (baseRef && baseRef.sha !== targetSha && !baseView) {
      // The text read of the base worked but its media did not: the graphics are judged against the store alone.
      notes.push('base_media_unreadable');
    }
    const diff = await buildAssetDiff(ctx.sync, { workspaceId, app, actor: input.actor, commit: targetView.commit, ...(input.gate ? { gate: input.gate } : {}) });
    if (!diff.ok && diff.status === 429) return diff;
    if (!diff.ok) storeUnread = true;
    graphicsPlan = planGraphics({
      platform: app.platform,
      base: baseRef && baseRef.sha === targetSha ? targetView.assets : baseView ? baseView.assets : null,
      target: targetView.assets,
      commit: targetView.commit,
      problems: targetView.problems,
      storeSets: diff.ok ? diff.diff.sets : null,
      staged: rows,
    });
  } else if (graphicsTarget && !graphicsTarget.ok) notes.push('graphics_unreadable');

  const noMetadata = !target.read.found && (!targetView || targetView.assets.filter((a) => a.origin === 'store').length === 0);
  if (noMetadata) return { ok: true, view: empty(app, query, 'no_repo_metadata', { state, locked: lock, baseRef: null, targetRef }) };

  const changes: ProposalItem[] = [...textPlan.items, ...(graphicsPlan?.items ?? [])];
  const issues = orderIssues([...textPlan.issues, ...(graphicsPlan?.issues ?? [])]);
  if (textPlan.truncated || graphicsPlan?.truncated) notes.push('truncated');
  const view: AssetProposalView = {
    appId: app.id,
    platform: app.platform,
    version: query.version,
    unavailable: null,
    state,
    locked: lock,
    baseRef,
    targetRef,
    noPreviousRelease: baseRef === null,
    storeUnread,
    changes,
    alreadyStaged: [...textPlan.staged, ...(graphicsPlan?.staged ?? [])],
    issues,
    summary: summarizeProposal(changes, issues),
    skipped: {
      unchangedSinceRelease: textPlan.unchangedSinceRelease + (graphicsPlan?.unchangedSinceRelease ?? 0),
      sameAsStore: textPlan.sameAsStore + (graphicsPlan?.sameAsStore ?? 0),
      notStageable: textPlan.notStageable + (graphicsPlan?.notStageable ?? 0),
    },
    notes,
  };
  return { ok: true, view };
}

// ---------------------------------------------------------------------------------------------
// Staging

export type StageResult = { id: string; status: 'staged' | 'already_staged' | 'kept_edited' | 'not_proposed' | 'failed'; code?: string };

const hasIssues = (view: AssetProposalView, id: string): boolean => view.changes.some((c) => c.id === id && c.hasErrors);

export async function stageProposal(
  ctx: ProposalContext,
  input: { workspaceId: string; appId: string; query: ProposalQuery; itemIds: string[]; acceptIssues: boolean; actor: Actor; gate?: () => Failure | undefined; budgetMs?: number },
): Promise<{ ok: true; results: StageResult[] } | Failure> {
  const { workspaceId } = input;
  const db = ctx.staged.db;
  const app = await getApp(db, workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const locked = await metadataLockedFailure(db, workspaceId, app);
  if (locked) return locked;
  const proposal = await getAssetProposal(ctx, { workspaceId, appId: app.id, query: input.query, actor: input.actor, ...(input.gate ? { gate: input.gate } : {}) });
  if (!proposal.ok) return proposal;
  const view = proposal.view;
  if (view.unavailable) return failure(422, 'no_proposal', 'There is nothing to stage for this release.', { reason: view.unavailable, ...coded('assetProposal.unavailable') });
  const ids = [...new Set(input.itemIds)];
  const bad = ids.filter((id) => hasIssues(view, id));
  if (bad.length > 0 && !input.acceptIssues)
    return failure(409, 'has_issues', 'Some of the selected items have errors. Confirm them to stage anyway.', { itemIds: bad, ...coded('assetProposal.hasIssues') });
  const results: StageResult[] = [];
  const staged = view.alreadyStaged;
  const stopAt = Date.now() + (input.budgetMs ?? STAGE_BUDGET_MS);
  for (const id of ids) {
    // Past the budget the rest is answered at once: the person sees which items were not staged and presses the button again for them.
    if (Date.now() > stopAt) {
      results.push({ id, status: 'failed', code: 'stage_timeout' });
      continue;
    }
    const item = view.changes.find((c) => c.id === id);
    if (!item) {
      const already = staged.find((s) => s.id === id);
      results.push({ id, status: already ? (already.state === 'same' ? 'already_staged' : 'kept_edited') : 'not_proposed' });
      continue;
    }
    const done =
      item.kind === 'text'
        ? await stageText(ctx.staged, { workspaceId, appId: app.id, locale: item.locale, field: item.field, from: 'local', value: item.after, actor: input.actor })
        : await stageAssets(ctx.staged, {
            workspaceId,
            appId: app.id,
            locale: item.locale,
            kind: item.slotKind,
            device: item.device,
            from: 'repo',
            commit: item.after.commit,
            actor: input.actor,
            ...(input.gate ? { gate: input.gate } : {}),
          });
    results.push(done.ok ? { id, status: 'staged' } : { id, status: 'failed', code: String(done.body.error) });
  }
  const stagedIds = results.filter((r) => r.status === 'staged').map((r) => r.id);
  if (stagedIds.length > 0)
    await recordAudit(db, {
      workspaceId,
      actor: input.actor,
      action: 'release.asset_proposal_staged',
      target: { type: 'app', id: app.id },
      // Item ids (locale and field or slot) and commits: never a text.
      detail: { appId: app.id, version: input.query.version, itemIds: stagedIds, base: view.baseRef?.sha ?? null, target: view.targetRef?.sha ?? null, acceptedIssues: bad.length > 0 },
      at: ctx.staged.now(),
    });
  return { ok: true, results };
}
