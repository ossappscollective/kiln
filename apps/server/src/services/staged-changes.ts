import { createHash, randomUUID } from 'node:crypto';
import { appleDisplayType, ASSET_KIND_LABELS, ASSET_KINDS, type AssetFacts, type AssetKind, type AssetProblem, type AssetSlot, assetSlotSupport, assetStoreOf, checkReleaseField, checkReleaseSet, deviceLabel, isApplePlatform, isReleaseFieldId, isStageableTextField, parseSlotKey, type Platform, PLATFORMS, playImageType, PUSHABLE_IMAGE_FORMATS, RELEASE_FIELD_SPECS, type ReleaseFieldId, type ReleaseFieldItem, releaseItemKey, slotKey, slotMaxFiles, STAGEABLE_RELEASE_FIELDS, STAGEABLE_TEXT_FIELDS, STAGED_LIMITS, type StagedAssetFileView, type StagedAssetView, type StagedChangesView, type StagedProblem, type StagedReleaseFieldView, type StagedSource, type StagedTextView, validateAssets } from '@mrm/core';
import { type Database, nullableNumber, nullableString, oneOf, type Row, type Sql } from '@mrm/db';
import { getApp, type ManagedApp } from './apps.ts';
import { type AssetsContext, isCommitSha, openAssets } from './asset-repo.ts';
import { recordAudit } from './audit.ts';
import {
  ABSENT_HASH,
  fieldKey,
  fieldSpec,
  hashListingValue,
  isListingField,
  normalizeListingValue,
  sideProblems,
} from './listing-drift.ts';
import { getDrift } from './listing-live.ts';
import { type Failure, failure } from './repositories.ts';
import { storeFor } from './review-sync.ts';
import { deleteUnreferencedBlobs } from './staged-asset-blobs.ts';

/**
 * Staged changes (docs/api/staged-changes.md, docs/adr/0009-staged-store-drafts.md): the listing
 * texts and graphics a person has collected for ONE app, to be written into the store as a DRAFT
 * later (services/store-draft.ts). Nothing here reads or writes a store, and nothing here is ever
 * sent anywhere by itself.
 *
 * - A staged text is one row per locale and field. Its value comes from the repository snapshot or
 *   the store snapshot that the listing reads already stored (`from: 'repo' | 'store'`: no new
 *   read), or is typed (`from: 'local'`). It is normalized (line breaks, trailing white space) so
 *   what is previewed is what is pushed.
 * - A staged asset set is the rows of one slot (locale, kind, device). Files are kept BY
 *   REFERENCE: repository path, commit and the git blob id. Bytes are read at push time, from the
 *   same clone and index the Assets tab uses (a staged path must be one the asset index lists, so
 *   nothing outside the listing target's folders is ever read), and checked against the blob id.
 * - Validation reuses the listing limits (`validateListing` via `sideProblems`) and the asset specs
 *   (`validateAssets`), plus what a push needs on top (png or jpeg, size caps, a store set name).
 *   An item with an error problem blocks a push; a warning does not.
 * - Mutations are audited with ids and hashes only: never the text, never a credential.
 */

type Actor = { type: 'user' | 'token' | 'system'; id: string };

export type StagedContext = {
  db: Database;
  now: () => number;
  /** Reads the media files of the app's repository (the same reads as the Assets tab). */
  assets: AssetsContext;
};

// ---------------------------------------------------------------------------------------------
// Rows

export type StagedRow = {
  id: string;
  workspaceId: string;
  appId: string;
  platform: Platform;
  kind: 'listing_text' | 'asset' | 'release_field';
  locale: string;
  /** The listing field (text) or the slot key (asset). */
  target: string;
  ordinal: number;
  source: StagedSource;
  valueText: string | null;
  valueHash: string;
  assetPath: string | null;
  assetCommit: string | null;
  assetBytes: number | null;
  assetWidth: number | null;
  assetHeight: number | null;
  assetFormat: string | null;
  assetAlpha: boolean | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  pushedAt: number | null;
  pushedHash: string | null;
};

function toRow(r: Row): StagedRow {
  const alpha = r.asset_alpha;
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    appId: String(r.app_id),
    platform: oneOf(r.platform, PLATFORMS, 'platform'),
    kind: String(r.kind) as StagedRow['kind'],
    locale: String(r.locale),
    target: String(r.target),
    ordinal: Number(r.ordinal),
    source: String(r.source) as StagedSource,
    valueText: nullableString(r.value_text),
    valueHash: String(r.value_hash),
    assetPath: nullableString(r.asset_path),
    assetCommit: nullableString(r.asset_commit),
    assetBytes: nullableNumber(r.asset_bytes),
    assetWidth: nullableNumber(r.asset_width),
    assetHeight: nullableNumber(r.asset_height),
    assetFormat: nullableString(r.asset_format),
    assetAlpha:
      alpha === null || alpha === undefined ? null : Number(alpha) === 1 || alpha === true,
    createdBy: String(r.created_by),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    pushedAt: nullableNumber(r.pushed_at),
    pushedHash: nullableString(r.pushed_hash),
  };
}

/** Every staged row of the app, in a stable order: locale, then text before assets, then target and place. */
export async function loadStagedRows(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<StagedRow[]> {
  const rows = await sql.query(
    'SELECT * FROM staged_changes WHERE workspace_id = ? AND app_id = ? ORDER BY locale, kind, target, ordinal',
    [workspaceId, appId],
  );
  return rows.map(toRow);
}

// ---------------------------------------------------------------------------------------------
// Slots

const LOCALE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/;
export const isStageableLocale = (value: string): boolean =>
  value.length <= STAGED_LIMITS.maxLocaleChars && LOCALE.test(value);

/** The store's own name of a set (App Store display type, Google Play image type), or undefined. */
export function storeTargetOf(
  platform: Platform,
  slot: AssetSlot,
  first: { width: number | null; height: number | null } | undefined,
): string | undefined {
  if (isApplePlatform(platform)) {
    if (slot.device === null) return undefined;
    return appleDisplayType(slot.device, first?.width ?? null, first?.height ?? null);
  }
  return playImageType(slot);
}

export type AssetSet = { locale: string; slot: AssetSlot; key: string; rows: StagedRow[] };

/** The rows of the assets grouped into sets (rows must be ordered as `loadStagedRows` does). */
export function assetSetsOf(rows: readonly StagedRow[]): AssetSet[] {
  const sets = new Map<string, AssetSet>();
  for (const row of rows) {
    if (row.kind !== 'asset') continue;
    const slot = parseSlotKey(row.target);
    if (!slot) continue;
    const key = `${row.locale}/${row.target}`;
    const set = sets.get(key) ?? { locale: row.locale, slot, key, rows: [] };
    set.rows.push(row);
    sets.set(key, set);
  }
  for (const set of sets.values()) set.rows.sort((a, b) => a.ordinal - b.ordinal);
  return [...sets.values()];
}

// ---------------------------------------------------------------------------------------------
// The view

const toProblem = (p: {
  code: string;
  severity: StagedProblem['severity'];
  message: string;
  limit?: number | undefined;
  actual?: number | undefined;
  unit?: 'characters' | 'bytes' | undefined;
}): StagedProblem => ({
  severity: p.severity,
  code: p.code,
  message: p.message,
  ...(p.limit !== undefined ? { limit: p.limit } : {}),
  ...(p.actual !== undefined ? { actual: p.actual } : {}),
  ...(p.unit !== undefined ? { unit: p.unit } : {}),
});

const setLabel = (platform: Platform, _locale: string, slot: AssetSlot): string => {
  const kind = ASSET_KIND_LABELS[slot.kind];
  return slot.device === null
    ? kind
    : `${kind}, ${deviceLabel(assetStoreOf(platform), slot.device)}`;
};

const extensionOf = (path: string): string => {
  const base = path.split('/').pop() ?? '';
  const at = base.lastIndexOf('.');
  return at === -1 ? '' : base.slice(at + 1).toLowerCase();
};

function factsOf(platform: Platform, set: AssetSet): AssetFacts[] {
  return set.rows.map((r) => ({
    path: r.assetPath ?? '',
    store: assetStoreOf(platform),
    locale: set.locale,
    kind: set.slot.kind,
    device: set.slot.device,
    order: r.ordinal + 1,
    bytes: r.assetBytes,
    width: r.assetWidth,
    height: r.assetHeight,
    format: (r.assetFormat as AssetFacts['format']) ?? null,
    extension: extensionOf(r.assetPath ?? ''),
    hasAlpha: r.assetAlpha,
    read: 'read' as const,
  }));
}

/** What a push needs beyond the documented specs. Errors here block a push. */
function pushProblems(platform: Platform, set: AssetSet): StagedProblem[] {
  const out: StagedProblem[] = [];
  const support = assetSlotSupport(platform, set.slot);
  if (!support.ok)
    out.push({ severity: 'error', code: 'slot_not_pushable', message: support.reason });
  const max = slotMaxFiles(platform, set.slot);
  if (set.rows.length > max) {
    out.push({
      severity: 'error',
      code: 'set_too_large',
      message: `A set holds at most ${max} file${max === 1 ? '' : 's'}; ${set.rows.length} are staged. A push replaces the whole set.`,
      limit: max,
      actual: set.rows.length,
    });
  }
  for (const r of set.rows) {
    const name = (r.assetPath ?? '').split('/').pop() ?? '';
    if (r.assetFormat === null || !PUSHABLE_IMAGE_FORMATS.includes(r.assetFormat)) {
      out.push({
        severity: 'error',
        code: 'format_not_pushable',
        message: `${name} is ${r.assetFormat ? r.assetFormat.toUpperCase() : 'not an image this server could read'}: only PNG and JPEG are uploaded.`,
      });
    }
    if (r.assetBytes === null || r.assetBytes > STAGED_LIMITS.maxAssetFileBytes) {
      out.push({
        severity: 'error',
        code: 'file_too_large',
        message: `${name} is larger than the ${STAGED_LIMITS.maxAssetFileBytes / (1024 * 1024)} MB this server uploads.`,
        limit: STAGED_LIMITS.maxAssetFileBytes,
        ...(r.assetBytes !== null ? { actual: r.assetBytes } : {}),
        unit: 'bytes',
      });
    }
  }
  if (isApplePlatform(platform) && support.ok && set.slot.device !== null) {
    const names = new Set(
      set.rows.map(
        (r) =>
          storeTargetOf(platform, set.slot, { width: r.assetWidth, height: r.assetHeight }) ?? '',
      ),
    );
    if (names.has('')) {
      out.push({
        severity: 'error',
        code: 'no_display_type',
        message: 'This server has no App Store display type for the size of a file of this set.',
      });
    } else if (names.size > 1) {
      out.push({
        severity: 'error',
        code: 'mixed_display_types',
        message: `The files of this set belong to different App Store display types (${[...names].sort().join(', ')}). Stage the files of each size as its own set.`,
      });
    }
  }
  return out;
}

/** The problems of a staged set: the documented specs, then what a push needs. */
function assetProblems(platform: Platform, set: AssetSet): StagedProblem[] {
  const paths = new Set(set.rows.map((r) => r.assetPath));
  const found: AssetProblem[] = validateAssets(
    assetStoreOf(platform),
    factsOf(platform, set),
  ).filter((p) =>
    p.path !== undefined
      ? paths.has(p.path)
      : p.kind === set.slot.kind &&
        p.locale === set.locale &&
        (p.device === undefined || p.device === set.slot.device),
  );
  return [
    ...pushProblems(platform, set),
    ...found.map((p) => toProblem({ code: p.rule, severity: p.severity, message: p.message })),
  ];
}

const hasError = (problems: readonly StagedProblem[]) =>
  problems.some((p) => p.severity === 'error');

/** Text problems: the limits of the listing, for the staged values (a field not staged is never "missing"). */
function textProblems(
  platform: Platform,
  rows: readonly StagedRow[],
): Map<string, StagedProblem[]> {
  const values = new Map<string, string>();
  for (const r of rows)
    if (r.kind === 'listing_text' && r.valueText !== null)
      values.set(fieldKey(r.locale, r.target), r.valueText);
  const found = sideProblems(platform, values);
  const out = new Map<string, StagedProblem[]>();
  for (const [key, problems] of found) {
    const kept = problems.filter((p) => p.code !== 'missing_required').map(toProblem);
    if (kept.length > 0) out.set(key, kept);
  }
  for (const r of rows) {
    if (r.kind !== 'listing_text') continue;
    if (!isStageableTextField(platform, r.target)) {
      const key = fieldKey(r.locale, r.target);
      out.set(key, [
        ...(out.get(key) ?? []),
        {
          severity: 'error',
          code: 'field_not_pushable',
          message: 'A push cannot write this field.',
        },
      ]);
    }
  }
  return out;
}

export type StagedAnalysis = {
  view: StagedChangesView;
  /** Whether any item has an error problem. */
  hasErrors: boolean;
};

/** The staged changes of an app as the API shows them. Reads the database only. */
/**
 * The release fields staged for an app (docs/api/releases-write.md) as the API shows them. A value is checked on its own
 * (`checkReleaseField`) and against the other staged fields (`checkReleaseSet`); what the store holds is checked by the push preview.
 */
export function releaseViewsOf(
  platform: Platform,
  rows: readonly StagedRow[],
  now: number,
): StagedReleaseFieldView[] {
  const mine = rows.filter((r) => r.kind === 'release_field' && isReleaseFieldId(r.target));
  const items: ReleaseFieldItem[] = mine.map((r) => ({
    field: r.target as ReleaseFieldId,
    locale: r.locale,
    value: r.valueText ?? '',
  }));
  const set = checkReleaseSet(platform, items);
  return mine.map((r) => {
    const field = r.target as ReleaseFieldId;
    const spec = RELEASE_FIELD_SPECS[field];
    const value = r.valueText ?? '';
    const problems = [
      ...checkReleaseField(platform, field, r.locale, value, now),
      ...(set[releaseItemKey(field, r.locale)] ?? []),
    ];
    return {
      id: r.id,
      kind: 'release_field' as const,
      field,
      label: spec.label,
      locale: r.locale,
      value,
      valueHash: r.valueHash,
      localOnly: field === 'user_fraction',
      maxLength: spec.maxLength,
      status: hasError(problems) ? ('invalid' as const) : ('changed' as const),
      problems,
      pushedAt: r.pushedAt,
      pushed: r.pushedHash !== null && r.pushedHash === r.valueHash,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });
}

export async function buildStagedView(
  ctx: Pick<StagedContext, 'db'> & { now?: () => number },
  workspaceId: string,
  app: ManagedApp,
  rows?: StagedRow[],
): Promise<StagedChangesView> {
  const all = rows ?? (await loadStagedRows(ctx.db, workspaceId, app.id));
  const textRows = all.filter((r) => r.kind === 'listing_text');
  const before = new Map<string, string | null>();
  if (textRows.length > 0) {
    const drift = await getDrift(ctx.db, workspaceId, {
      id: app.id,
      platform: app.platform,
      identifier: app.identifier,
    });
    for (const locale of drift.locales)
      for (const f of locale.fields) before.set(fieldKey(locale.locale, f.field), f.live.value);
  }
  const problems = textProblems(app.platform, all);
  const text: StagedTextView[] = textRows.map((r) => {
    const spec = fieldSpec(app.platform, r.target);
    const mine = problems.get(fieldKey(r.locale, r.target)) ?? [];
    const was = before.get(fieldKey(r.locale, r.target)) ?? null;
    const value = r.valueText ?? '';
    return {
      id: r.id,
      kind: 'listing_text',
      locale: r.locale,
      field: r.target,
      label: spec?.label ?? r.target,
      source: r.source,
      value,
      valueHash: r.valueHash,
      limit: spec?.maxLength ?? null,
      unit: spec?.unit ?? 'characters',
      before: was,
      status: hasError(mine)
        ? 'invalid'
        : was !== null && normalizeListingValue(was) === value
          ? 'unchanged'
          : 'changed',
      problems: mine,
      pushedAt: r.pushedAt,
      pushed: r.pushedHash !== null && r.pushedHash === r.valueHash,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });
  const assets: StagedAssetView[] = assetSetsOf(all).map((set) => {
    const mine = assetProblems(app.platform, set);
    const files: StagedAssetFileView[] = set.rows.map((r) => ({
      id: r.id,
      position: r.ordinal,
      path: r.assetPath ?? '',
      commit: r.assetCommit ?? '',
      oid: r.valueHash,
      bytes: r.assetBytes,
      width: r.assetWidth,
      height: r.assetHeight,
      format: r.assetFormat,
      hasAlpha: r.assetAlpha,
      ...(r.source === 'local' ? { upload: true } : {}),
    }));
    const pushedAt = set.rows.every((r) => r.pushedHash !== null && r.pushedHash === r.valueHash)
      ? Math.max(...set.rows.map((r) => r.pushedAt ?? 0))
      : null;
    return {
      id: set.key,
      kind: 'asset',
      locale: set.locale,
      slot: set.slot,
      slotKey: slotKey(set.slot),
      label: setLabel(app.platform, set.locale, set.slot),
      source: set.rows.some((r) => r.source === 'local')
        ? 'local'
        : (set.rows[0]?.source ?? 'repo'),
      files,
      status: hasError(mine) ? 'invalid' : 'changed',
      problems: mine,
      pushedAt,
      pushed: pushedAt !== null,
      createdAt: Math.min(...set.rows.map((r) => r.createdAt)),
      updatedAt: Math.max(...set.rows.map((r) => r.updatedAt)),
    };
  });
  const release = releaseViewsOf(app.platform, all, ctx.now ? ctx.now() : Date.now());
  const all2 = [
    ...text.flatMap((t) => t.problems),
    ...assets.flatMap((a) => a.problems),
    ...release.flatMap((r) => r.problems),
  ];
  const errors = all2.filter((p) => p.severity === 'error').length;
  return {
    app: { id: app.id, name: app.name, platform: app.platform, store: storeFor(app.platform) },
    text,
    assets,
    release,
    totals: {
      text: text.length,
      assetSets: assets.length,
      assetFiles: assets.reduce((n, a) => n + a.files.length, 0),
      release: release.length,
      errors,
      warnings: all2.filter((p) => p.severity === 'warning').length,
      changed:
        text.filter((t) => t.status === 'changed').length +
        assets.filter((a) => a.status === 'changed').length +
        release.filter((r) => r.status === 'changed' && !r.localOnly).length,
    },
    valid: errors === 0,
    pushable: {
      textFields: [...STAGEABLE_TEXT_FIELDS[app.platform]],
      releaseFields: [...STAGEABLE_RELEASE_FIELDS[app.platform]],
    },
    limits: STAGED_LIMITS,
  };
}

export async function getStagedChanges(
  ctx: StagedContext,
  input: { workspaceId: string; appId: string },
): Promise<{ ok: true; staged: StagedChangesView } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  return { ok: true, staged: await buildStagedView(ctx, input.workspaceId, app) };
}

// ---------------------------------------------------------------------------------------------
// Staging a text

const invalid = (code: string, message: string, extra: Record<string, unknown> = {}): Failure =>
  failure(422, code, message, extra);

export type StageTextInput = {
  workspaceId: string;
  appId: string;
  locale: string;
  field: string;
  from: StagedSource;
  /** Required for `local` and `ai` (a typed text; `ai` is only ever set by accepting an AI proposal, never by a request), refused otherwise. */
  value?: string | undefined;
  actor: Actor;
};

const countItems = async (sql: Sql, workspaceId: string, appId: string): Promise<number> => {
  const [row] = await sql.query(
    'SELECT COUNT(*) AS n FROM staged_changes WHERE workspace_id = ? AND app_id = ?',
    [workspaceId, appId],
  );
  return Number(row?.n ?? 0);
};

export async function stageText(
  ctx: StagedContext,
  input: StageTextInput,
): Promise<{ ok: true; staged: StagedChangesView } | Failure> {
  const { db } = ctx;
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  if (!isStageableLocale(input.locale))
    return invalid('invalid_locale', 'locale must be a store locale code such as en-US.', {
      field: 'locale',
    });
  if (!isStageableTextField(app.platform, input.field)) {
    const known = isListingField(app.platform, input.field);
    return invalid(
      'field_not_pushable',
      known
        ? 'A push cannot write this field: on the App Store the name, subtitle and privacy policy URL belong to the app information and are not part of the version listing this server writes.'
        : 'Not a listing field of this platform.',
      { field: 'field', allowed: STAGEABLE_TEXT_FIELDS[app.platform] },
    );
  }
  let raw: string | undefined;
  if (input.from === 'local' || input.from === 'ai') {
    if (input.value === undefined)
      return invalid('invalid_staged', `value is required when from is ${input.from}.`, {
        field: 'value',
      });
    raw = input.value;
  } else {
    if (input.value !== undefined)
      return invalid(
        'invalid_staged',
        `value is not accepted when from is ${input.from}: it is taken from the stored snapshot.`,
        { field: 'value' },
      );
    const drift = await getDrift(db, input.workspaceId, {
      id: app.id,
      platform: app.platform,
      identifier: app.identifier,
    });
    const field = drift.locales
      .find((l) => l.locale === input.locale)
      ?.fields.find((f) => f.field === input.field);
    const side = input.from === 'repo' ? field?.repo : field?.live;
    if (!side || side.value === null) {
      return invalid(
        'no_source_value',
        input.from === 'repo'
          ? 'The repository snapshot has no value for this locale and field. Refresh the repository listing first.'
          : 'The stored store snapshot has no value for this locale and field. Sync the app first.',
        { field: 'from' },
      );
    }
    raw = side.value;
  }
  const value = normalizeListingValue(raw);
  if (value === '')
    return invalid(
      'empty_text',
      'An empty text is not staged: this server does not clear a store field. Remove the item instead.',
      { field: 'value' },
    );
  if (value.length > STAGED_LIMITS.maxTextChars) {
    return invalid(
      'text_too_long',
      `A staged text is at most ${STAGED_LIMITS.maxTextChars} characters.`,
      { field: 'value', limit: STAGED_LIMITS.maxTextChars, actual: value.length },
    );
  }
  const hash = hashListingValue(value);
  const at = ctx.now();
  const refused = await db.transaction(async (tx) => {
    const [existing] = await tx.query(
      "SELECT id FROM staged_changes WHERE app_id = ? AND kind = 'listing_text' AND locale = ? AND target = ? AND ordinal = 0",
      [app.id, input.locale, input.field],
    );
    if (existing) {
      await tx.execute(
        'UPDATE staged_changes SET source = ?, value_text = ?, value_hash = ?, updated_at = ? WHERE id = ?',
        [input.from, value, hash, at, String(existing.id)],
      );
    } else {
      if ((await countItems(tx, input.workspaceId, app.id)) >= STAGED_LIMITS.maxItems) {
        return invalid(
          'too_many_items',
          `At most ${STAGED_LIMITS.maxItems} items can be staged for an app.`,
          { limit: STAGED_LIMITS.maxItems },
        );
      }
      await tx.execute(
        `INSERT INTO staged_changes (id, workspace_id, app_id, platform, kind, locale, target, ordinal, source, value_text, value_hash, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'listing_text', ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          input.workspaceId,
          app.id,
          app.platform,
          input.locale,
          input.field,
          input.from,
          value,
          hash,
          input.actor.id,
          at,
          at,
        ],
      );
    }
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'staged.text_set',
      target: { type: 'app', id: app.id },
      // Ids and a hash: the text is listing copy, never put in an audit entry.
      detail: {
        appId: app.id,
        platform: app.platform,
        locale: input.locale,
        field: input.field,
        source: input.from,
        valueHash: hash,
        chars: value.length,
      },
      at,
    });
    return undefined;
  });
  if (refused) return refused;
  return { ok: true, staged: await buildStagedView(ctx, input.workspaceId, app) };
}

// ---------------------------------------------------------------------------------------------
// Staging a set of graphics

export type StageAssetsInput = {
  workspaceId: string;
  appId: string;
  locale: string;
  kind: AssetKind;
  device: string | null;
  from: StagedSource;
  /** The files of the set, in order, as the asset index lists them. Default: every file of the slot, in index order. */
  paths?: string[] | undefined;
  /** Read this commit of the repository (a full hash). Default: the branch tip. */
  commit?: string | undefined;
  actor: Actor;
  /** The gate of an index read that misses the cache (the rate limit of the Assets tab). */
  gate?: () => Failure | undefined;
};

export async function stageAssets(
  ctx: StagedContext,
  input: StageAssetsInput,
): Promise<{ ok: true; staged: StagedChangesView } | Failure> {
  const { db } = ctx;
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  if (input.from !== 'repo') {
    return invalid(
      'source_not_supported',
      input.from === 'store'
        ? 'Graphics are not staged straight from the store: pull them into a change set for the repository (POST .../assets/pull), then stage the files from there (see docs/api/staged-changes.md, "Reverse sync").'
        : 'Uploaded images are staged with PUT .../staged/assets/upload; this route stages files of the linked repository (from: repo).',
      { field: 'from' },
    );
  }
  if (!isStageableLocale(input.locale))
    return invalid('invalid_locale', 'locale must be a store locale code such as en-US.', {
      field: 'locale',
    });
  if (!(ASSET_KINDS as readonly string[]).includes(input.kind))
    return invalid('invalid_staged', 'Not a kind of graphic.', { field: 'kind' });
  const slot: AssetSlot = { kind: input.kind, device: input.device };
  if (slot.kind === 'screenshot' && (slot.device === null || slot.device === ''))
    return invalid('invalid_staged', 'device is required for screenshots.', { field: 'device' });
  const support = assetSlotSupport(app.platform, slot);
  if (!support.ok) return invalid('slot_not_pushable', support.reason, { field: 'kind' });
  if (slot.kind !== 'screenshot' && slot.device !== null)
    return invalid('invalid_staged', 'device applies to screenshots only.', { field: 'device' });
  if (input.commit !== undefined && !isCommitSha(input.commit))
    return invalid('invalid_staged', 'commit must be a full commit hash.', { field: 'commit' });

  const opened = await openAssets(
    ctx.assets,
    { workspaceId: input.workspaceId, app, ...(input.commit ? { commit: input.commit } : {}) },
    input.actor,
    {
      ...(input.gate ? { onCompute: input.gate } : {}),
    },
  );
  if (!opened.ok) return opened;
  const view = opened.handle.view;
  if (view.status === 'no_repository' || view.commit === null)
    return invalid('no_repository', 'This app has no linked repository to take graphics from.');
  if (!isCommitSha(view.commit))
    return invalid(
      'no_commit',
      'The repository read did not name a commit, so the files cannot be pinned.',
    );
  const candidates = view.assets
    .filter(
      (a) =>
        a.origin === 'store' &&
        a.locale === input.locale &&
        a.kind === slot.kind &&
        a.device === slot.device,
    )
    .sort((a, b) => a.order - b.order || a.path.localeCompare(b.path));
  let chosen = candidates;
  if (input.paths !== undefined) {
    if (new Set(input.paths).size !== input.paths.length)
      return invalid('invalid_staged', 'A path is listed twice.', { field: 'paths' });
    const byPath = new Map(candidates.map((a) => [a.path, a]));
    const picked = [];
    for (const path of input.paths) {
      const asset = byPath.get(path);
      if (!asset)
        return invalid(
          'not_in_index',
          'A path is not a file of this set in the asset index of the repository.',
          { field: 'paths', path },
        );
      picked.push(asset);
    }
    chosen = picked;
  }
  if (chosen.length === 0)
    return invalid(
      'no_assets',
      'The asset index of the repository lists no file for this locale and slot.',
    );
  for (const a of chosen) {
    const name = a.path.split('/').pop() ?? a.path;
    if (a.oid === null || a.read !== 'read')
      return invalid(
        'asset_not_pushable',
        `${name} was not opened by the asset index (too large, over the read budget or unreadable), so it cannot be staged.`,
        { path: a.path },
      );
    if (a.format !== 'png' && a.format !== 'jpeg')
      return invalid(
        'asset_not_pushable',
        `${name} is not a PNG or JPEG: only those are uploaded.`,
        { path: a.path },
      );
    if (a.bytes === null || a.bytes > STAGED_LIMITS.maxAssetFileBytes) {
      return invalid(
        'asset_not_pushable',
        `${name} is larger than the ${STAGED_LIMITS.maxAssetFileBytes / (1024 * 1024)} MB this server uploads.`,
        { path: a.path, limit: STAGED_LIMITS.maxAssetFileBytes },
      );
    }
  }
  const key = slotKey(slot);
  const at = ctx.now();
  const refused = await db.transaction(async (tx) => {
    // The rest of the staged files of the app, to hold the caps of a push.
    const others = (await loadStagedRows(tx, input.workspaceId, app.id)).filter(
      (r) => r.kind === 'asset' && !(r.locale === input.locale && r.target === key),
    );
    const files = others.length + chosen.length;
    const bytes =
      others.reduce((n, r) => n + (r.assetBytes ?? 0), 0) +
      chosen.reduce((n, a) => n + (a.bytes ?? 0), 0);
    if (files > STAGED_LIMITS.maxAssetFilesPerPush) {
      return invalid(
        'too_many_files',
        `A push uploads at most ${STAGED_LIMITS.maxAssetFilesPerPush} files; this would stage ${files}.`,
        { limit: STAGED_LIMITS.maxAssetFilesPerPush, actual: files },
      );
    }
    if (bytes > STAGED_LIMITS.maxAssetBytesPerPush) {
      return invalid(
        'too_many_bytes',
        `A push uploads at most ${STAGED_LIMITS.maxAssetBytesPerPush / (1024 * 1024)} MB; this would stage ${Math.ceil(bytes / (1024 * 1024))} MB.`,
        { limit: STAGED_LIMITS.maxAssetBytesPerPush, actual: bytes },
      );
    }
    if (
      (await countItems(tx, input.workspaceId, app.id)) -
        (await countSet(tx, app.id, input.locale, key)) +
        chosen.length >
      STAGED_LIMITS.maxItems
    ) {
      return invalid(
        'too_many_items',
        `At most ${STAGED_LIMITS.maxItems} items can be staged for an app.`,
        { limit: STAGED_LIMITS.maxItems },
      );
    }
    const [first] = await tx.query(
      "SELECT created_at, created_by FROM staged_changes WHERE app_id = ? AND kind = 'asset' AND locale = ? AND target = ? ORDER BY ordinal LIMIT 1",
      [app.id, input.locale, key],
    );
    await tx.execute(
      "DELETE FROM staged_changes WHERE app_id = ? AND kind = 'asset' AND locale = ? AND target = ?",
      [app.id, input.locale, key],
    );
    let ordinal = 0;
    for (const a of chosen) {
      await tx.execute(
        `INSERT INTO staged_changes
           (id, workspace_id, app_id, platform, kind, locale, target, ordinal, source, value_hash, asset_path, asset_commit, asset_bytes, asset_width, asset_height, asset_format, asset_alpha, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'asset', ?, ?, ?, 'repo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          input.workspaceId,
          app.id,
          app.platform,
          input.locale,
          key,
          ordinal++,
          a.oid,
          a.path,
          view.commit,
          a.bytes,
          a.width,
          a.height,
          a.format,
          a.hasAlpha === null ? null : a.hasAlpha ? 1 : 0,
          first ? String(first.created_by) : input.actor.id,
          first ? Number(first.created_at) : at,
          at,
        ],
      );
    }
    await deleteUnreferencedBlobs(tx, input.workspaceId, app.id);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'staged.assets_set',
      target: { type: 'app', id: app.id },
      // Ids and blob hashes: paths and bytes are not needed to tell what was staged.
      detail: {
        appId: app.id,
        platform: app.platform,
        locale: input.locale,
        slot: key,
        commit: view.commit,
        files: chosen.length,
        oids: chosen.map((a) => a.oid),
      },
      at,
    });
    return undefined;
  });
  if (refused) return refused;
  return { ok: true, staged: await buildStagedView(ctx, input.workspaceId, app) };
}

const countSet = async (sql: Sql, appId: string, locale: string, key: string): Promise<number> => {
  const [row] = await sql.query(
    "SELECT COUNT(*) AS n FROM staged_changes WHERE app_id = ? AND kind = 'asset' AND locale = ? AND target = ?",
    [appId, locale, key],
  );
  return Number(row?.n ?? 0);
};

// ---------------------------------------------------------------------------------------------
// Taking items out

/** Removes one staged text (by its id) or one whole set (`locale/slotKey`, the id of the set). */
export async function unstage(
  ctx: StagedContext,
  input: { workspaceId: string; appId: string; id: string; actor: Actor },
): Promise<{ ok: true; staged: StagedChangesView } | Failure> {
  const { db } = ctx;
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const at = ctx.now();
  const removed = await db.transaction(async (tx) => {
    const slash = input.id.indexOf('/');
    let count: number;
    let detail: Record<string, unknown>;
    if (slash !== -1) {
      const locale = input.id.slice(0, slash);
      const key = input.id.slice(slash + 1);
      count = await tx.execute(
        "DELETE FROM staged_changes WHERE workspace_id = ? AND app_id = ? AND kind = 'asset' AND locale = ? AND target = ?",
        [input.workspaceId, app.id, locale, key],
      );
      detail = { appId: app.id, set: input.id, rows: count };
    } else {
      count = await tx.execute(
        "DELETE FROM staged_changes WHERE workspace_id = ? AND app_id = ? AND kind IN ('listing_text', 'release_field') AND id = ?",
        [input.workspaceId, app.id, input.id],
      );
      detail = { appId: app.id, itemId: input.id, rows: count };
    }
    if (count === 0) return false;
    await deleteUnreferencedBlobs(tx, input.workspaceId, app.id);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'staged.item_removed',
      target: { type: 'app', id: app.id },
      detail,
      at,
    });
    return true;
  });
  if (!removed) return failure(404, 'not_found');
  return { ok: true, staged: await buildStagedView(ctx, input.workspaceId, app) };
}

export async function clearStaged(
  ctx: StagedContext,
  input: { workspaceId: string; appId: string; actor: Actor },
): Promise<{ ok: true; staged: StagedChangesView } | Failure> {
  const { db } = ctx;
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const at = ctx.now();
  await db.transaction(async (tx) => {
    const rows = await tx.execute(
      'DELETE FROM staged_changes WHERE workspace_id = ? AND app_id = ?',
      [input.workspaceId, app.id],
    );
    if (rows > 0) {
      await deleteUnreferencedBlobs(tx, input.workspaceId, app.id);
      await recordAudit(tx, {
        workspaceId: input.workspaceId,
        actor: input.actor,
        action: 'staged.cleared',
        target: { type: 'app', id: app.id },
        detail: { appId: app.id, rows },
        at,
      });
    }
  });
  return { ok: true, staged: await buildStagedView(ctx, input.workspaceId, app) };
}

// ---------------------------------------------------------------------------------------------
// Hashes shared with the push

/** SHA-256 of a string, hex. */
export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/** What a push confirmation holds of the staged side: the hash of every text and the blob ids of every set, in a fixed order. */
export function stagedKey(rows: readonly StagedRow[]): {
  text: string[][];
  assets: (string | string[])[][];
  release?: string[][];
} {
  const text = rows
    .filter((r) => r.kind === 'listing_text')
    .map((r) => [r.locale, r.target, r.valueHash])
    .sort((a, b) => (a.join('\u0000') < b.join('\u0000') ? -1 : 1));
  const assets = assetSetsOf(rows)
    .map(
      (s) => [s.locale, slotKey(s.slot), s.rows.map((r) => r.valueHash)] as (string | string[])[],
    )
    .sort((a, b) =>
      (a[0] as string) + (a[1] as string) < (b[0] as string) + (b[1] as string) ? -1 : 1,
    );
  // Release fields count only when there are some, so the confirmation of a push without them is what it always was.
  const release = rows
    .filter((r) => r.kind === 'release_field')
    .map((r) => [r.locale, r.target, r.valueHash])
    .sort((a, b) => (a.join('\u0000') < b.join('\u0000') ? -1 : 1));
  return release.length > 0 ? { text, assets, release } : { text, assets };
}

export { ABSENT_HASH };
