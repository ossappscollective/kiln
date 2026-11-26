import {
  analyzeFixes,
  type CheckLocaleText,
  checkListing,
  type Fix,
  type ListingStore,
  listingStoreOf,
  type UnfixableIssue,
} from '@kiln/core';
import { coded } from '../../i18n/problem.ts';
import { getApp, type ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { hashListingValue } from '../listing/drift.ts';
import { getLiveListing } from '../listing/live.ts';
import { metadataLockedFailure } from './metadata-lock.ts';
import { type StagedContext, type StageTextInput, stageText } from './staged-changes.ts';

/**
 * One-click FIXES for the findings of the listing checks that are mechanical and safe (docs/api/listing.md, docs/adr/0059-listing-fixes-via-cart.md).
 * The server is the only author of a fix: `GET .../listing/fixes` computes them from the stored values (the text staged for the field when there
 * is one, else the store's), and `POST .../listing/fixes/stage` computes them AGAIN and stages the one named by `{ locale, field, fixId }`, so a stale or forged
 * client diff cannot stage arbitrary text. Staging goes through `stageText` (same gates, limits and audit); nothing is written to a store.
 */

export type LocaleFixes = {
  locale: string;
  fixes: Fix[];
  cannot: UnfixableIssue[];
  /** Fields with a staged text (the fixes are computed from it): `{ field, id }`, `id` is the staged item to discard. */
  staged: { field: string; id: string }[];
};

export type ListingFixesView = {
  appId: string;
  store: ListingStore;
  /** The checks of the values AFTER the staged texts: what the page would be if the cart were published as it is. Null when nothing is staged. */
  afterPending: {
    score: number;
    issueCount: number;
    counts: { problems: number; warnings: number; tips: number };
    /** Ids of the findings (`<locale>:<code>:<field>`) of the live values that the staged texts settle. */
    resolved: string[];
  } | null;
  locales: LocaleFixes[];
};

type Base = {
  app: ManagedApp;
  store: ListingStore;
  locales: CheckLocaleText[];
  staged: Map<string, { id: string; value: string }>;
};

const stagedKey = (locale: string, field: string) => `${locale}\u0000${field}`;

async function readBase(
  ctx: StagedContext,
  workspaceId: string,
  appId: string,
): Promise<Base | undefined> {
  const app = await getApp(ctx.db, workspaceId, appId);
  if (!app) return undefined;
  const live = await getLiveListing(ctx.db, workspaceId, {
    id: app.id,
    platform: app.platform,
    identifier: app.identifier,
  });
  // The live copy first; a language only the draft holds (App Store Connect adds one to the draft) is
  // taken from the draft, so its empty texts can be fixed too.
  const locales: CheckLocaleText[] = [];
  const seen = new Set<string>();
  for (const name of ['live', 'editable'] as const) {
    const channel = live.channels.find((c) => c.channel === name);
    if (!channel) continue;
    for (const locale of Object.keys(channel.locales)) {
      if (seen.has(locale)) continue;
      seen.add(locale);
      locales.push({ locale, fields: { ...(channel.locales[locale] ?? {}) } });
    }
  }
  const rows = await ctx.db.query(
    "SELECT id, locale, target, value_text FROM staged_changes WHERE app_id = ? AND kind = 'listing_text' AND ordinal = 0",
    [app.id],
  );
  const staged = new Map<string, { id: string; value: string }>();
  for (const r of rows)
    staged.set(stagedKey(String(r.locale), String(r.target)), {
      id: String(r.id),
      value: String(r.value_text ?? ''),
    });
  return { app, store: listingStoreOf(app.platform), locales, staged };
}

/** The values the fixes work on: the staged text of a field where there is one, else the store's. */
const effective = (base: Base, entry: CheckLocaleText): Record<string, string | undefined> => {
  const fields: Record<string, string | undefined> = { ...entry.fields };
  for (const [key, row] of base.staged) {
    const [locale, field] = key.split('\u0000');
    if (locale === entry.locale && field !== undefined) fields[field] = row.value;
  }
  return fields;
};

export async function getListingFixes(
  ctx: StagedContext,
  input: { workspaceId: string; appId: string },
): Promise<{ ok: true; view: ListingFixesView } | Failure> {
  const base = await readBase(ctx, input.workspaceId, input.appId);
  if (!base) return failure(404, 'not_found');
  const anyStaged = Array.from(base.staged.keys()).some((k) =>
    base.locales.some((l) => k.startsWith(`${l.locale}\u0000`)),
  );
  const locales: LocaleFixes[] = base.locales.map((entry) => {
    const { fixes, cannot } = analyzeFixes({
      platform: base.app.platform,
      store: base.store,
      locale: entry.locale,
      fields: effective(base, entry),
    });
    const staged: LocaleFixes['staged'] = [];
    for (const [key, row] of base.staged) {
      const [locale, field] = key.split('\u0000');
      if (locale === entry.locale && field !== undefined) staged.push({ field, id: row.id });
    }
    return { locale: entry.locale, fixes, cannot, staged };
  });
  let afterPending: ListingFixesView['afterPending'] = null;
  if (anyStaged) {
    const before = checkListing({ store: base.store, locales: base.locales });
    const after = checkListing({
      store: base.store,
      locales: base.locales.map((l) => ({ ...l, fields: effective(base, l) })),
    });
    const left = new Set(after.locales.flatMap((l) => l.issues.map((i) => i.id)));
    const resolved = before.locales
      .flatMap((l) => l.issues.map((i) => i.id))
      .filter((id) => !left.has(id));
    afterPending = {
      score: after.score,
      issueCount: after.issueCount,
      counts: after.counts,
      resolved,
    };
  }
  return { ok: true, view: { appId: base.app.id, store: base.store, afterPending, locales } };
}

export type StageFixInput = {
  workspaceId: string;
  appId: string;
  locale: string;
  field: string;
  fixId: string;
  /** The hash of the `before` the person reviewed: a different current text is `409 stale_fix`. */
  beforeHash?: string | undefined;
  actor: StageTextInput['actor'];
};

export async function stageListingFix(ctx: StagedContext, input: StageFixInput) {
  const base = await readBase(ctx, input.workspaceId, input.appId);
  if (!base) return failure(404, 'not_found');
  const locked = await metadataLockedFailure(ctx.db, input.workspaceId, base.app);
  if (locked) return locked;
  const entry = base.locales.find((l) => l.locale === input.locale);
  const gone = failure(
    409,
    'fix_not_available',
    'This fix no longer applies: the text changed or it is already fixed. Reload and look again.',
    {
      ...coded('listing.fixNotAvailable'),
    },
  );
  if (!entry) return gone;
  const fix = analyzeFixes({
    platform: base.app.platform,
    store: base.store,
    locale: entry.locale,
    fields: effective(base, entry),
  }).fixes.find((f) => f.id === input.fixId && f.field === input.field);
  if (!fix || fix.kind !== 'stage' || fix.after === null) return gone;
  if (input.beforeHash !== undefined && input.beforeHash !== hashListingValue(fix.before)) {
    return failure(
      409,
      'stale_fix',
      'The text changed since you looked at this fix. Reload and review it again.',
      { ...coded('listing.staleFix') },
    );
  }
  const done = await stageText(ctx, {
    workspaceId: input.workspaceId,
    appId: input.appId,
    locale: input.locale,
    field: input.field,
    from: 'local',
    value: fix.after,
    actor: input.actor,
  });
  if (!done.ok) return done;
  await recordAudit(ctx.db, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: 'listing.fix_staged',
    target: { type: 'app', id: base.app.id },
    // Ids, the fix id and counts: the listing text itself is never put in an audit entry.
    detail: {
      appId: base.app.id,
      platform: base.app.platform,
      locale: input.locale,
      field: input.field,
      fixId: fix.id,
      removed: fix.removed.length,
      beforeHash: hashListingValue(fix.before),
      afterHash: hashListingValue(fix.after),
    },
    at: ctx.now(),
  });
  return { ok: true as const, staged: done.staged, fix };
}
