import { createHash } from 'node:crypto';
import {
  type ActorType,
  type AppStoreListing,
  byFamily,
  type Listing,
  type ListingProblem,
  type LocaleText,
  listingStoreOf,
  type Platform,
  type PlayListing,
  platformMeta,
  validateListing,
} from '@mrm/core';
import type { Row, Sql } from '@mrm/db';
import { getApp, type ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import {
  type ChangeSetOrigin,
  type ChangeSetView,
  computeListingFiles,
  createChangeSet,
  getChangeSet,
  invalidState,
  type ListingBuilder,
  parseFiles,
  parseOrigin,
  rowOf,
} from '../../services/change-sets.ts';
import {
  type Failure,
  failure,
  getDetection,
  getRepository,
  type ListingTargetView,
  listingTargetViews,
  type Outcome,
  type RepoContext,
  type Repository,
  selectedTarget,
} from '../../services/repositories.ts';
import {
  classifyDrift,
  fieldKey,
  fieldSpec,
  listingFieldsFor,
  normalizeListingValue,
  toListing,
} from './drift.ts';
import { getLiveListing, type LiveChannel } from './live.ts';
import { canonicalLocale, matchRepoLocale, newRepoLocale } from './locales.ts';
import { type ListingSourceKind, listingSources, mergedListing } from './sources.ts';
import { type ListingSelection, type ListingTarget, listListingTargets } from './targets.ts';

/**
 * Pull the live store listing into the repository, as a draft change set.
 *
 * The store side is the snapshot the last sync stored (`getLiveListing`), or one that was just
 * refreshed (`refresh`). The repository side is read now, through the same listing sources every
 * other listing read uses (Expo store config for the App Store when there is one, fastlane
 * otherwise, Google Play fastlane only). The new listing is the repository's own listing with the
 * store's values applied to the selected fields; the files come from `createChangeSet`
 * (`listingChangeSet` / `expoStoreChangeSet`), so the folder protections, the audit event and the
 * review, approve and apply flow are the ones every change set has. Nothing is written to a store
 * and nothing is written to the repository here: the result is a draft.
 */

type Actor = { type: ActorType; id: string };

export type PullChannel = 'live' | 'editable';

/** One field of one locale, as the store names the locale (the drift view's locale). */
export type PullItem = { locale: string; field: string };

/** Why a field is pulled. `new-locale` and `missing-in-repo` are fields the repository does not have yet. */
export type PullStatus = 'store-ahead' | 'diverged' | 'missing-in-repo' | 'new-locale';

export type PullChange = {
  /** The locale as the store has it. */
  locale: string;
  /** The folder (or Expo key) it is written to. */
  repoLocale: string;
  field: string;
  label: string;
  status: PullStatus;
  /** The repository's value now (a `default` folder value counts), or null. */
  before: string | null;
  after: string;
  /** The locale folder does not exist yet and is created. */
  newLocale: boolean;
};

export type SkipReason =
  | 'repo_ahead'
  | 'missing_in_store'
  | 'identical'
  | 'over_limit'
  | 'locale_not_in_repo'
  | 'locale_ambiguous'
  | 'locale_invalid'
  | 'locale_unsupported'
  | 'locale_conflict';

export type PullSkip = {
  locale: string;
  repoLocale?: string;
  /** Absent: the whole locale is skipped. */
  field?: string;
  reason: SkipReason;
  message: string;
};

export type LocaleMapping = {
  locale: string;
  repoLocale: string;
  how: 'exact' | 'normalized' | 'equivalent' | 'new';
};

export type PullSelection = {
  locales?: readonly string[] | undefined;
  fields?: readonly string[] | undefined;
  items?: readonly PullItem[] | undefined;
  addLocales: boolean;
};

export type PullHistory = {
  /** Value hashes of the repository side per locale and field, newest first. */
  repo: ReadonlyMap<string, readonly string[]>;
  /** Value hashes the store has shown per locale and field. */
  store: ReadonlyMap<string, ReadonlySet<string>>;
};

export type PullPlanInput = {
  platform: Platform;
  source: ListingSourceKind;
  /** The store's values: locale (store code) to field to text. */
  store: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** The repository's store listing (locale to field to text, `default` included), or undefined. */
  repo: AppStoreListing | PlayListing | undefined;
  history: PullHistory;
  selection: PullSelection;
};

export type PullPlan = {
  changes: PullChange[];
  skipped: PullSkip[];
  /** Problems of the values that would be written (and of those left out for being too long). */
  problems: ListingProblem[];
  locales: LocaleMapping[];
  /** The repository's listing of this store with the changes applied. Everything else is as it was. */
  desired: Listing;
};

type Texts = Record<string, Record<string, string>>;

const DEFAULT_FOLDER = 'default';

const storeName = (platform: Platform) => platformMeta(platform).storeName;

const itemKey = (locale: string, field: string) => `${canonicalLocale(locale)}\u0000${field}`;

/**
 * The pure part: which store values go where. No database, no network.
 *
 * A field is pulled when the store has a value for it and the repository's value differs in a
 * `store-ahead` or `diverged` sense (the drift classification, from the recorded histories). When
 * the person names fields or items, a field the repository has no value for is pulled as well.
 * Never pulled: a field the store has no (or only a blank) value for (the repository's value is
 * never blanked), a `repo-ahead` field (that would undo a change that has not reached the store),
 * an identical field, and a value over the field's limit (it is reported, never shortened).
 */
export function planPull(input: PullPlanInput): PullPlan {
  const { platform, selection } = input;
  const fields = listingFieldsFor(platform);
  const explicit = selection.items !== undefined || selection.fields !== undefined;
  const wantedItems = selection.items
    ? new Set(selection.items.map((i) => itemKey(i.locale, i.field)))
    : undefined;
  const wantedLocales = selection.locales
    ? new Set(selection.locales.map(canonicalLocale))
    : undefined;
  const wantedFields = selection.fields ? new Set(selection.fields) : undefined;

  const repoLocaleTexts: Texts = {};
  for (const [locale, text] of Object.entries(input.repo?.locales ?? {})) {
    repoLocaleTexts[locale] = { ...(text as Record<string, string>) };
  }
  const repoLocales = Object.keys(repoLocaleTexts).filter((l) => l !== DEFAULT_FOLDER);
  const fallback = repoLocaleTexts[DEFAULT_FOLDER];

  /** Does the selection name this field? `repoLocale` is unknown (undefined) until the locale is mapped. */
  const selected = (locale: string, repoLocale: string | undefined, field: string): boolean => {
    if (wantedFields && !wantedFields.has(field)) return false;
    const names = (set: ReadonlySet<string>) =>
      set.has(canonicalLocale(locale)) ||
      (repoLocale !== undefined && set.has(canonicalLocale(repoLocale)));
    if (wantedLocales && !names(wantedLocales)) return false;
    if (
      wantedItems &&
      !wantedItems.has(itemKey(locale, field)) &&
      !(repoLocale !== undefined && wantedItems.has(itemKey(repoLocale, field)))
    ) {
      return false;
    }
    return true;
  };
  const provided = (locale: string, field: string): string | undefined => {
    const value = input.store[locale]?.[field];
    return typeof value === 'string' && normalizeListingValue(value) !== '' ? value : undefined;
  };

  const changes: PullChange[] = [];
  const skipped: PullSkip[] = [];
  const problems: ListingProblem[] = [];
  const mappings: LocaleMapping[] = [];
  const claimed = new Map<string, string>();

  const storeLocales = Object.keys(input.store).sort((a, b) => a.localeCompare(b));
  type Resolved = { locale: string; repoLocale: string; how: LocaleMapping['how'] };
  const resolved: Resolved[] = [];
  for (const locale of storeLocales) {
    const wantedHere = fields.filter(
      (f) => selected(locale, undefined, f) || selected(locale, locale, f),
    );
    // Whether this locale is in play at all (a field that the store has and the selection names).
    const inPlay = wantedHere.some((f) => provided(locale, f) !== undefined || explicit);
    if (!inPlay) continue;
    const match = matchRepoLocale(locale, repoLocales);
    if (match.kind === 'match') {
      resolved.push({ locale, repoLocale: match.repoLocale, how: match.how });
    } else if (match.kind === 'ambiguous') {
      skipped.push({
        locale,
        reason: 'locale_ambiguous',
        message: `${locale} matches several folders of the repository (${match.candidates.join(', ')}). Rename the ones that are not used, or pull this locale by hand.`,
      });
    } else if (!selection.addLocales) {
      skipped.push({
        locale,
        reason: 'locale_not_in_repo',
        message: `${locale} has no folder in the repository. Choose "add locales" to create it.`,
      });
    } else {
      const created = newRepoLocale(platform, locale, input.source);
      if (!created.ok) {
        skipped.push(
          created.reason === 'unsupported'
            ? {
                locale,
                reason: 'locale_unsupported',
                message: `${locale} is not a locale the EAS Metadata store config supports, so it cannot be added there.`,
              }
            : {
                locale,
                reason: 'locale_invalid',
                message: `${locale} is not written as a locale folder name (such as en-US), so it was not added.`,
              },
        );
      } else {
        const same = repoLocales.find((r) => r === created.repoLocale);
        if (same !== undefined) resolved.push({ locale, repoLocale: same, how: 'exact' });
        else resolved.push({ locale, repoLocale: created.repoLocale, how: 'new' });
      }
    }
  }
  // Two store locales for one folder: the one with the exact code keeps it.
  resolved.sort(
    (a, b) =>
      Number(b.how === 'exact') - Number(a.how === 'exact') || a.locale.localeCompare(b.locale),
  );
  const placed: Resolved[] = [];
  for (const r of resolved) {
    const owner = claimed.get(r.repoLocale);
    if (owner !== undefined) {
      skipped.push({
        locale: r.locale,
        repoLocale: r.repoLocale,
        reason: 'locale_conflict',
        message: `${r.locale} and ${owner} both map to the folder ${r.repoLocale}; only ${owner} was pulled.`,
      });
      continue;
    }
    claimed.set(r.repoLocale, r.locale);
    placed.push(r);
  }
  placed.sort((a, b) => a.locale.localeCompare(b.locale));

  for (const { locale, repoLocale, how } of placed) {
    mappings.push({ locale, repoLocale, how });
    const created = how === 'new';
    const own = repoLocaleTexts[repoLocale] ?? {};
    for (const field of fields) {
      if (!selected(locale, repoLocale, field)) continue;
      const spec = fieldSpec(platform, field);
      const label = spec?.label ?? field;
      const at = { locale, repoLocale, field };
      const after = provided(locale, field);
      const ownValue = own[field];
      const repoValue = ownValue ?? fallback?.[field];
      if (after === undefined) {
        if (explicit && repoValue !== undefined) {
          skipped.push({
            ...at,
            reason: 'missing_in_store',
            message: `${label}: the store has no value, so the repository's value was left as it is.`,
          });
        }
        continue;
      }
      let status: PullStatus;
      if (repoValue === undefined) {
        status = created ? 'new-locale' : 'missing-in-repo';
        if (status === 'missing-in-repo' && !explicit) continue;
      } else {
        const historyLocale = ownValue !== undefined ? repoLocale : DEFAULT_FOLDER;
        const verdict = classifyDrift({
          repo: repoValue,
          live: after,
          repoHistory: input.history.repo.get(fieldKey(historyLocale, field)) ?? [],
          liveHistory: input.history.store.get(fieldKey(locale, field)) ?? new Set<string>(),
        }).status;
        if (verdict === 'identical') {
          if (explicit) {
            skipped.push({
              ...at,
              reason: 'identical',
              message: `${label} is already the same in the repository.`,
            });
          }
          continue;
        }
        if (verdict === 'repo-ahead') {
          skipped.push({
            ...at,
            reason: 'repo_ahead',
            message: `${label}: the repository changed after it matched the store and the store has not caught up. Pulling would undo that change.`,
          });
          continue;
        }
        status = verdict === 'store-ahead' ? 'store-ahead' : 'diverged';
        if (verdict !== 'store-ahead' && verdict !== 'diverged') continue;
      }
      // The store's limits. A value that is over a limit is reported and not pulled, never shortened.
      const found = validateListing(
        toListing(platform, new Map([[fieldKey(repoLocale, field), after]])),
      ).filter((p) => p.locale === repoLocale && p.field === field);
      problems.push(...found);
      const tooLong = found.find((p) => p.code === 'too_long' && p.severity === 'error');
      if (tooLong) {
        skipped.push({
          ...at,
          reason: 'over_limit',
          message: `${tooLong.message} It was not pulled and was not shortened.`,
        });
        continue;
      }
      changes.push({
        locale,
        repoLocale,
        field,
        label,
        status,
        before: repoValue ?? null,
        after,
        newLocale: created,
      });
    }
  }

  const locales: Texts = {};
  for (const [locale, text] of Object.entries(repoLocaleTexts)) locales[locale] = { ...text };
  for (const c of changes) (locales[c.repoLocale] ??= {})[c.field] = c.after;
  const desired: Listing =
    listingStoreOf(platform) === 'app_store'
      ? {
          appStore: {
            locales: locales as Record<string, LocaleText<never>>,
            ...((input.repo as AppStoreListing | undefined)?.copyright === undefined
              ? {}
              : { copyright: (input.repo as AppStoreListing).copyright as string }),
          } as AppStoreListing,
        }
      : {
          googlePlay: {
            locales: locales as PlayListing['locales'],
            changelogs: (input.repo as PlayListing | undefined)?.changelogs ?? {},
          },
        };
  return { changes, skipped, problems, locales: mappings, desired };
}

// ---------------------------------------------------------------------------------------------
// The recorded histories

/** Hashes of what each side has shown per field, the way the drift view reads them. */
export async function loadPullHistory(
  sql: Sql,
  workspaceId: string,
  appId: string,
  channel: PullChannel,
  /**
   * A change set whose own recorded values are left out of the repository side: when it is
   * recomputed or fixed up, what it committed must not make the store look "behind" the repository.
   */
  excludeChangeSet?: string,
): Promise<PullHistory> {
  const rows = await sql.query(
    `SELECT locale, field, channel, source, source_ref, value_hash FROM listing_snapshots
      WHERE workspace_id = ? AND app_id = ? ORDER BY observed_at, id`,
    [workspaceId, appId],
  );
  const repo = new Map<string, string[]>();
  const store = new Map<string, Set<string>>();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i] as Record<string, unknown>;
    const key = fieldKey(String(r.locale), String(r.field));
    const hash = String(r.value_hash);
    const source = String(r.source);
    if (
      source === 'change_set' &&
      excludeChangeSet !== undefined &&
      String(r.source_ref) === excludeChangeSet
    )
      continue;
    if (source === 'repo' || source === 'change_set') {
      const list = repo.get(key) ?? [];
      if (!list.includes(hash)) list.push(hash);
      repo.set(key, list);
    } else if (source === 'store' && String(r.channel) === channel) {
      const set = store.get(key) ?? new Set<string>();
      set.add(hash);
      store.set(key, set);
    }
  }
  return { repo, store };
}

// ---------------------------------------------------------------------------------------------
// The service

export type PullInput = {
  workspaceId: string;
  app: ManagedApp;
  channel?: PullChannel | undefined;
  locales?: readonly string[] | undefined;
  fields?: readonly string[] | undefined;
  items?: readonly PullItem[] | undefined;
  addLocales?: boolean | undefined;
  summary?: string | undefined;
  /** Which folders to use, exactly as the listing endpoint takes them. */
  selection?: ListingSelection | undefined;
  /** Runs the existing read-only store read first. The caller owns the rate limit. */
  refresh?: (() => Promise<Failure | undefined>) | undefined;
  /** A change set (a recompute of it) whose own recorded values do not count as the repository's. */
  excludeChangeSet?: string | undefined;
};

export type PullTarget = {
  repositoryId: string;
  /** `owner/repo`. */
  repository: string;
  /** The branch the files were read from (and the pull request will target). */
  branch: string;
  /** Where the listing comes from: the Expo store config or the fastlane metadata folder. */
  source: ListingSourceKind;
  /** The file (Expo) or the folder (fastlane). */
  path: string;
  selected: {
    id: string | null;
    origin: 'custom' | 'detected' | 'folders' | 'default';
    label: string;
  };
};

export type PullResult = {
  /** Null when nothing differs in a way that can be pulled. */
  changeSet: ChangeSetView | null;
  channel: PullChannel;
  store: { readAt: number | null; error: string | null; refreshed: boolean };
  target: PullTarget;
  changes: PullChange[];
  skipped: PullSkip[];
  problems: ListingProblem[];
  locales: LocaleMapping[];
  warnings: string[];
  /** Why there is no change set. */
  explanation?: string;
};

const savedView = (t: ListingTarget): ListingTargetView => ({
  id: t.id,
  origin: 'custom',
  label: t.name,
  app: t.appId,
  roots: { appStore: t.appStoreRoot, googlePlay: t.googlePlayRoot },
});

const targetRequired = (candidates: readonly ListingTargetView[]) =>
  failure(
    422,
    'target_required',
    'This repository has more than one place the listing of this app could be. Choose the listing target (or the folders) to pull into.',
    { candidates },
  );

export const DEFAULT_PULL_SUMMARY = (app: ManagedApp): string =>
  `Pull the ${storeName(app.platform)} listing of ${app.name} into the repository`.slice(0, 200);

/**
 * Chooses the folders when the request did not: a saved target that names this app, else a
 * detected target of the app (by its id in the folder layout), else the repository's default. More
 * than one saved target for the app is ambiguous.
 */
async function chooseSelection(
  ctx: RepoContext,
  workspaceId: string,
  repositoryId: string,
  app: ManagedApp,
  given: ListingSelection | undefined,
): Promise<{ ok: true; selection?: ListingSelection } | Failure> {
  if (given && (given.target !== undefined || given.roots !== undefined))
    return { ok: true, selection: given };
  const mine = (await listListingTargets(ctx.db, workspaceId, repositoryId)).filter(
    (t) => t.appId === app.id,
  );
  if (mine.length === 1) return { ok: true, selection: { target: (mine[0] as ListingTarget).id } };
  if (mine.length > 1) return targetRequired(mine.map(savedView));
  const detection = await getDetection(ctx.db, workspaceId, repositoryId);
  const auto = detection?.listing?.targets.find(
    (t) => t.app !== undefined && t.app === app.identifier,
  );
  return auto ? { ok: true, selection: { target: `auto:${auto.key}` } } : { ok: true };
}

/** What a pull needs besides the app: the request itself (see `PullInput`). */
type Prepared = {
  repository: Repository;
  channel: PullChannel;
  live: Awaited<ReturnType<typeof getLiveListing>>;
  snapshot: LiveChannel;
  /** The folders the request chose (or the ones that were picked for it). */
  selection: ListingSelection | undefined;
  slot: 'appStore' | 'googlePlay';
  history: PullHistory;
  refreshed: boolean;
};

/** What the listing builder works out while the files are being made. */
type PullState = { plan?: PullPlan; target?: PullTarget };

/**
 * Everything before the repository is read: the app's repository, the checks of the request, the
 * optional store read, the stored store snapshot, the folders and the recorded histories. Shared by
 * the pull and the recompute of a pull.
 */
async function preparePull(
  ctx: { repo: RepoContext },
  input: PullInput,
): Promise<Outcome<{ prepared: Prepared }>> {
  const { workspaceId, app } = input;
  const { db } = ctx.repo;
  if (!app.repositoryId) {
    return failure(
      422,
      'no_repository',
      'This app is not linked to a repository. Link one to pull into it.',
    );
  }
  const repository = await getRepository(db, workspaceId, app.repositoryId);
  if (!repository) {
    return failure(422, 'no_repository', 'The repository of this app is not connected any more.');
  }
  const wanted = input.fields ?? [];
  for (const field of [...wanted, ...(input.items ?? []).map((i) => i.field)]) {
    if (!listingFieldsFor(app.platform).includes(field)) {
      return failure(
        422,
        'invalid_field',
        `${field} is not a listing field of an ${app.platform} app.`,
      );
    }
  }

  const refreshed = input.refresh !== undefined;
  if (input.refresh) {
    const refusal = await input.refresh();
    if (refusal) return refusal;
  }

  // The store side: the stored snapshot of the channel.
  const live = await getLiveListing(db, workspaceId, app);
  const byName = new Map<PullChannel, LiveChannel>(live.channels.map((c) => [c.channel, c]));
  const channel: PullChannel = input.channel ?? (byName.has('live') ? 'live' : 'editable');
  const snapshot = byName.get(channel);
  if (!snapshot) {
    return failure(
      422,
      'no_store_listing',
      input.channel
        ? `The store listing has no ${channel} copy read yet. Sync the app, or pull with refresh.`
        : 'No listing has been read from the store for this app yet. Sync the app, or pull with refresh.',
      { channels: [...byName.keys()] },
    );
  }

  const chosen = await chooseSelection(ctx.repo, workspaceId, repository.id, app, input.selection);
  if (!chosen.ok) return chosen;

  const slot = byFamily(app.platform, { apple: 'appStore', google: 'googlePlay' });
  const history = await loadPullHistory(db, workspaceId, app.id, channel, input.excludeChangeSet);
  return {
    ok: true,
    prepared: {
      repository,
      channel,
      live,
      snapshot,
      selection: chosen.selection,
      slot,
      history,
      refreshed,
    },
  };
}

/** The listing builder of a pull: plans the pull against the listings that `createChangeSet` just read. */
function pullBuilder(prepared: Prepared, input: PullInput, state: PullState): ListingBuilder {
  const { repository, snapshot, selection, slot, history } = prepared;
  const { app } = input;
  const hasChoice = selection !== undefined;
  return ({ listings, custom }) => {
    const sources = listingSources(listings);
    const source = sources[slot];
    const views = listingTargetViews(listings.fastlane, []);
    state.target = {
      repositoryId: repository.id,
      repository: `${repository.owner}/${repository.repo}`,
      branch: repository.defaultBranch,
      source: source.source,
      path: source.path,
      selected: selectedTarget(views, listings.fastlane, selection, custom),
    };
    // Several places the listing could be, and nothing chose one: ask instead of guessing.
    const usesExpo = slot === 'appStore' && listings.expo !== undefined;
    const relevant = views.filter((v) => v.roots[slot] !== null);
    if (!hasChoice && !usesExpo && relevant.length > 1) return targetRequired(relevant);
    if (source.error !== undefined) {
      return failure(
        422,
        'store_config_invalid',
        `${source.error} The App Store listing cannot be changed until the file is fixed in the repository.`,
        { path: source.path },
      );
    }
    if (source.source === 'fastlane' && listings.fastlane.roots[slot] === '') {
      return failure(
        422,
        'no_target_folder',
        `The selected listing target has no ${storeName(app.platform)} folder to pull into.`,
      );
    }
    state.plan = planPull({
      platform: app.platform,
      source: source.source,
      store: snapshot.locales,
      repo: mergedListing(listings)[slot],
      history,
      selection: {
        locales: input.locales,
        fields: input.fields,
        items: input.items,
        addLocales: input.addLocales === true,
      },
    });
    // Nothing to write: an empty listing leaves every file as it is (and ends as `no_changes`).
    return state.plan.changes.length === 0 ? {} : state.plan.desired;
  };
}

// ---------------------------------------------------------------------------------------------
// What a pull remembers, so that it can be made again

/** A short stable hash of a text: enough to tell that the store's text changed, and no text is kept. */
export const textHash = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 16);

export type PullOriginField = { locale: string; repoLocale: string; field: string; hash: string };

/**
 * The origin of a change set made by a pull (`change_sets.origin_json`): the request, as it was
 * made, and the fields it pulled with a hash of each text. No text, no path of the server.
 */
export type StorePullOrigin = ChangeSetOrigin & {
  source: 'store_pull';
  appId: string;
  channel: PullChannel;
  request: {
    channel?: PullChannel;
    locales?: string[];
    fields?: string[];
    items?: PullItem[];
    addLocales: boolean;
    selection?: ListingSelection;
  };
  fields: PullOriginField[];
  /** When the store text was read that the pull used (the snapshot's time), or null. */
  storeReadAt: number | null;
};

function originOf(
  prepared: Prepared,
  input: PullInput,
  plan: PullPlan | undefined,
): StorePullOrigin {
  return {
    v: 1,
    source: 'store_pull',
    appId: input.app.id,
    channel: prepared.channel,
    request: {
      ...(input.channel ? { channel: input.channel } : {}),
      ...(input.locales ? { locales: [...input.locales] } : {}),
      ...(input.fields ? { fields: [...input.fields] } : {}),
      ...(input.items
        ? { items: input.items.map((i) => ({ locale: i.locale, field: i.field })) }
        : {}),
      addLocales: input.addLocales === true,
      ...(prepared.selection ? { selection: prepared.selection } : {}),
    },
    fields: (plan?.changes ?? []).map((c) => ({
      locale: c.locale,
      repoLocale: c.repoLocale,
      field: c.field,
      hash: textHash(c.after),
    })),
    storeReadAt: prepared.live.readAt,
  };
}

const isStorePullOrigin = (origin: ChangeSetOrigin | null): origin is StorePullOrigin =>
  origin !== null &&
  origin.source === 'store_pull' &&
  typeof origin.appId === 'string' &&
  typeof (origin as { request?: unknown }).request === 'object' &&
  (origin as { request?: unknown }).request !== null &&
  Array.isArray((origin as { fields?: unknown }).fields);

export async function pullStoreListing(
  ctx: { repo: RepoContext },
  input: PullInput,
  actor: Actor,
): Promise<Outcome<{ result: PullResult }>> {
  const { workspaceId, app } = input;
  const prepared = await preparePull(ctx, input);
  if (!prepared.ok) return prepared;
  const { repository, channel, live, selection, refreshed } = prepared.prepared;
  const state: PullState = {};
  const build = pullBuilder(prepared.prepared, input, state);

  const done = await createChangeSet(
    ctx.repo,
    {
      workspaceId,
      repositoryId: repository.id,
      summary: input.summary ?? DEFAULT_PULL_SUMMARY(app),
      listing: build,
      ...(selection ? { selection } : {}),
      auditDetail: { source: 'store_pull', appId: app.id, channel, refreshed },
      origin: () => originOf(prepared.prepared, input, state.plan),
    },
    actor,
  );

  const { plan, target } = state;
  const store = { readAt: live.readAt, error: live.error, refreshed };
  const baseWarnings: string[] = [];
  if (live.error) {
    baseWarnings.push(
      `The last attempt to read the store failed (${live.error}); the values of the last successful read were used.`,
    );
  }
  const common = (): Omit<PullResult, 'changeSet' | 'changes' | 'warnings'> | undefined =>
    plan && target
      ? {
          channel,
          store,
          target,
          skipped: plan.skipped,
          problems: plan.problems,
          locales: plan.locales,
        }
      : undefined;

  if (!done.ok) {
    const base = common();
    if (done.body.error !== 'no_changes' || !base || !plan) return done;
    const warnings = [
      ...baseWarnings,
      ...(Array.isArray(done.body.warnings) ? (done.body.warnings as string[]) : []),
    ];
    const lost = plan.changes.length > 0;
    return {
      ok: true,
      result: {
        ...base,
        changeSet: null,
        changes: [],
        warnings,
        explanation: lost
          ? 'The values to pull are the same as the repository files once formatting is ignored, so there is nothing to change.'
          : `Nothing to pull: no field of the ${storeName(app.platform)} listing differs from the repository in a way that can be pulled.${plan.skipped.length > 0 ? ' See the skipped fields for why some were left out.' : ''}`,
      },
    };
  }
  const base = common();
  if (!base || !plan) return failure(422, 'no_changes', 'Nothing to pull.');
  return {
    ok: true,
    result: {
      ...base,
      changeSet: done.changeSet,
      changes: plan.changes,
      warnings: [...baseWarnings, ...done.warnings],
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Recompute: the same pull, made again from the current store snapshot and the current repository

/** What happened to one pulled field since the draft was made. */
export type FieldDiff = {
  locale: string;
  repoLocale: string;
  field: string;
  /**
   * `store_changed`: the store's text is not the one the draft had. `unchanged`: the same text.
   * `added`: a field the draft did not have. `dropped`: a field the draft had that is not pulled
   * any more (`reason`: `identical` when the repository and the store agree now, which is what a
   * store that went back to the repository's text looks like, else the skip reason).
   */
  change: 'store_changed' | 'unchanged' | 'added' | 'dropped';
  reason?: string;
};

const fieldId = (repoLocale: string, field: string) => `${repoLocale}\u0000${field}`;

/** Per field, what changed between the draft's origin and a new plan. Pure. */
export function diffFromPrevious(
  previous: readonly PullOriginField[],
  plan: PullPlan,
): FieldDiff[] {
  const before = new Map(previous.map((f) => [fieldId(f.repoLocale, f.field), f]));
  const out: FieldDiff[] = [];
  const seen = new Set<string>();
  for (const change of plan.changes) {
    const key = fieldId(change.repoLocale, change.field);
    seen.add(key);
    const old = before.get(key);
    out.push({
      locale: change.locale,
      repoLocale: change.repoLocale,
      field: change.field,
      change:
        old === undefined
          ? 'added'
          : old.hash === textHash(change.after)
            ? 'unchanged'
            : 'store_changed',
    });
  }
  for (const old of previous) {
    const key = fieldId(old.repoLocale, old.field);
    if (seen.has(key)) continue;
    const skip = plan.skipped.find(
      (s) =>
        (s.repoLocale ?? s.locale) === old.repoLocale &&
        (s.field === undefined || s.field === old.field),
    );
    out.push({
      locale: old.locale,
      repoLocale: old.repoLocale,
      field: old.field,
      change: 'dropped',
      reason: skip?.reason ?? 'identical',
    });
  }
  return out;
}

export type RecomputeInput = {
  workspaceId: string;
  id: string;
  /** Runs the existing read-only store read first. The caller owns the rate limit. */
  refresh?: (() => Promise<Failure | undefined>) | undefined;
};

/** The new content of a recompute, before anything is written. */
export type RecomputePlan = {
  files: ReturnType<typeof parseFiles>;
  origin: StorePullOrigin;
  result: Omit<PullResult, 'changeSet'>;
  diffFromPrevious: FieldDiff[];
  summary: string;
};

/**
 * Works out the pull again from the stored request, the latest stored store snapshot (or one just
 * read) and the repository now. Writes nothing. `row` is the change set row: its origin must be a
 * store pull. Used by `recomputeStorePull` (replaces a draft's files) and by the fix-up of a set
 * that has a branch (the new files are the content to put on the branch).
 */
export async function planRecompute(
  ctx: { repo: RepoContext },
  input: RecomputeInput & { row: Row },
  actor: Actor,
): Promise<Outcome<{ plan: RecomputePlan }>> {
  const { workspaceId, row } = input;
  const origin = parseOrigin(row);
  if (!isStorePullOrigin(origin)) {
    return failure(
      409,
      'not_recomputable',
      'This change set was not made from a store pull (or was made before pulls could be recomputed), so it cannot be recomputed. Pull again from the Listing tab.',
    );
  }
  const app = await getApp(ctx.repo.db, workspaceId, origin.appId);
  if (!app)
    return failure(
      409,
      'app_gone',
      'The app this change set was pulled for is not there any more.',
    );
  if (app.repositoryId !== String(row.repository_id)) {
    return failure(
      409,
      'app_relinked',
      'The app is linked to another repository now, so this change set cannot be recomputed.',
    );
  }
  const request = origin.request;
  const pull: PullInput = {
    workspaceId,
    app,
    ...(request.channel ? { channel: request.channel } : {}),
    ...(request.locales ? { locales: request.locales } : {}),
    ...(request.fields ? { fields: request.fields } : {}),
    ...(request.items ? { items: request.items } : {}),
    addLocales: request.addLocales === true,
    ...(request.selection ? { selection: request.selection } : {}),
    ...(input.refresh ? { refresh: input.refresh } : {}),
    excludeChangeSet: String(row.id),
  };
  const prepared = await preparePull(ctx, pull);
  if (!prepared.ok) return prepared;
  const state: PullState = {};
  const computed = await computeListingFiles(
    ctx.repo,
    {
      workspaceId,
      repositoryId: String(row.repository_id),
      listing: pullBuilder(prepared.prepared, pull, state),
      ...(prepared.prepared.selection ? { selection: prepared.prepared.selection } : {}),
      purpose: 'changeset.recompute',
    },
    actor,
  );
  if (!computed.ok) return computed;
  const { plan, target } = state;
  if (!plan || !target) return failure(422, 'no_changes', 'Nothing to pull.');
  const { live, channel, refreshed } = prepared.prepared;
  const warnings: string[] = [...computed.warnings];
  if (live.error) {
    warnings.unshift(
      `The last attempt to read the store failed (${live.error}); the values of the last successful read were used.`,
    );
  }
  return {
    ok: true,
    plan: {
      files: computed.files,
      origin: originOf(prepared.prepared, pull, plan),
      summary: String(row.summary),
      diffFromPrevious: diffFromPrevious(origin.fields, plan),
      result: {
        channel,
        store: { readAt: live.readAt, error: live.error, refreshed },
        target,
        changes: plan.changes,
        skipped: plan.skipped,
        problems: plan.problems,
        locales: plan.locales,
        warnings,
      },
    },
  };
}

export type RecomputeResult = Omit<PullResult, 'changeSet'> & {
  changeSet: ChangeSetView;
  /** What changed since the draft was made, per field. */
  diffFromPrevious: FieldDiff[];
  /** No file is left: the store and the repository agree now. Discard the change set. */
  nothingLeft: boolean;
  /** The files did not change. Nothing was written, and an approval stays. */
  unchanged: boolean;
  /** The change set had been approved and is a draft again. */
  approvalCleared: boolean;
};

const RECOMPUTABLE = ['draft', 'approved', 'failed'];

/**
 * Recomputes a change set that came from a store pull (`POST /change-sets/:id/recompute`): the
 * pull is planned again from its stored request, the latest stored store snapshot (or a fresh
 * read, with `refresh`) and the repository now, and the files of the same change set are
 * replaced. Same id and creator; the status is `draft` and the approval is cleared when the files
 * change (the approver approved other text). A set with a branch is not replaced here: it is fixed
 * up with the recomputed content (`fixupChangeSet` with `desired`).
 */
export async function recomputeStorePull(
  ctx: { repo: RepoContext },
  input: RecomputeInput,
  actor: Actor,
): Promise<Outcome<{ result: RecomputeResult }>> {
  const { workspaceId, id } = input;
  const { db } = ctx.repo;
  const row = await rowOf(db, workspaceId, id);
  if (!row) return failure(404, 'not_found');
  const status = String(row.status);
  if (!RECOMPUTABLE.includes(status)) return invalidState(status, 'a draft, approved or failed');
  if (row.branch) {
    return failure(
      409,
      'has_branch',
      'A branch was created for this change set, so it cannot be replaced. Fix it up (it adds one commit to the branch) with the recomputed content, or discard it and pull again.',
    );
  }
  const origin = parseOrigin(row);
  if (!isStorePullOrigin(origin)) {
    return failure(
      409,
      'not_recomputable',
      'This change set was not made from a store pull (or was made before pulls could be recomputed), so it cannot be recomputed. Pull again from the Listing tab.',
    );
  }
  const planned = await planRecompute(ctx, { ...input, row }, actor);
  if (!planned.ok) return planned;
  const { plan } = planned;

  const before = parseFiles(row);
  const unchanged = JSON.stringify(before) === JSON.stringify(plan.files);
  const nothingLeft = plan.files.length === 0;
  const view = async () => (await getChangeSet(db, workspaceId, id)) as ChangeSetView;
  const base = { ...plan.result, diffFromPrevious: plan.diffFromPrevious, nothingLeft, unchanged };
  // A failed set always goes back to draft (it cannot be approved otherwise); the others only when their files changed.
  if (unchanged && status !== 'failed') {
    return { ok: true, result: { ...base, changeSet: await view(), approvalCleared: false } };
  }
  const approvalCleared = status === 'approved' || row.approved_by !== null;
  const written = await db.transaction(async (tx): Promise<Failure | undefined> => {
    const at = ctx.repo.now();
    const changed = await tx.execute(
      `UPDATE change_sets
          SET files_json = ?, origin_json = ?, status = 'draft', approved_by = NULL, approved_at = NULL,
              error = NULL, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status = ? AND updated_at = ?`,
      [
        JSON.stringify(plan.files),
        JSON.stringify(plan.origin),
        at,
        id,
        workspaceId,
        status,
        Number(row.updated_at),
      ],
    );
    if (changed === 0) {
      return failure(
        409,
        'changed_meanwhile',
        'This change set was changed while it was being recomputed (approved, applied, refreshed or recomputed by someone else). Look again and retry.',
      );
    }
    await recordAudit(tx, {
      workspaceId,
      actor,
      action: 'changeset.recompute',
      target: { type: 'change_set', id },
      // Counts only: never a text.
      detail: {
        repositoryId: String(row.repository_id),
        appId: plan.origin.appId,
        was: status,
        refreshed: plan.result.store.refreshed,
        files: { before: before.length, after: plan.files.length },
        changes: plan.result.changes.length,
        skipped: plan.result.skipped.length,
        storeChanged: plan.diffFromPrevious.filter((d) => d.change === 'store_changed').length,
        added: plan.diffFromPrevious.filter((d) => d.change === 'added').length,
        dropped: plan.diffFromPrevious.filter((d) => d.change === 'dropped').length,
        approvalCleared,
        nothingLeft,
      },
      at,
    });
    return undefined;
  });
  if (written) return written;
  return { ok: true, result: { ...base, changeSet: await view(), approvalCleared } };
}
