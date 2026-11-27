import {
  APP_STORE_FIELD_SPECS,
  APP_STORE_FIELDS,
  type ChangeSetStatus,
  can,
  DEFAULT_LOCALE,
  type Listing,
  type ListingFieldSpec,
  type ListingStore,
  measureField,
  PLAY_FIELD_SPECS,
  PLAY_FIELDS,
  type Platform,
  platformMeta,
  type Role,
} from '@kiln/core';
import type { ApiError } from './api.ts';
import { formatList } from './i18n/format.ts';
import { k, t } from './i18n/t.ts';
import type {
  ChangeSetView,
  ListingSelection,
  ListingTargetInput,
  ListingTargetView,
  LocalCheck,
  LocalConfig,
  LocalStatus,
  ProjectDetection,
  ProjectKind,
  RepositoryListing,
  RepositorySummary,
  StoreSource,
} from './types.ts';

// ---------------------------------------------------------------------------------------------
// Connecting a repository

/** The same rule the server applies to the owner and the repository name. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]+$/;

export type ParsedRepository =
  | { ok: true; owner: string; repo: string }
  | { ok: false; message: string };

/**
 * Reads "owner/repo", or a GitHub address that holds one (`https://github.com/owner/repo`,
 * `github.com/owner/repo.git`, `git@github.com:owner/repo.git`), into its two parts.
 */
export function parseRepositoryInput(input: string): ParsedRepository {
  const text = input.trim();
  if (text === '') return { ok: false, message: t('repositories:connect.enterRepo') };
  const address = /^(?:git@github\.com:|(?:https?:\/\/)?(?:www\.)?github\.com\/)/i;
  const isAddress = address.test(text);
  const path = text.replace(address, '').replace(/[?#].*$/, '');
  const parts = path.split('/').filter((part) => part !== '');
  // A bare name is exactly owner/name; a GitHub address may carry more (…/tree/main).
  if (parts.length < 2 || (!isAddress && parts.length > 2)) {
    return { ok: false, message: t('repositories:connect.useForm') };
  }
  const owner = parts[0] ?? '';
  let repo = parts[1] ?? '';
  if (repo.toLowerCase().endsWith('.git')) repo = repo.slice(0, -4);
  if (!OWNER.test(owner))
    return { ok: false, message: t('repositories:connect.badOwner', { owner }) };
  if (!REPO.test(repo) || repo === '.' || repo === '..') {
    return { ok: false, message: t('repositories:connect.badRepo', { repo }) };
  }
  return { ok: true, owner, repo };
}

export const githubUrl = (owner: string | null, repo: string | null) =>
  `https://github.com/${owner ?? ''}/${repo ?? ''}`;

/** `owner/repo`, or the folder name of a local-only repository (it has no owner). */
export const repositoryName = (repository: {
  owner: string | null;
  repo: string | null;
  name?: string;
}) =>
  repository.owner && repository.repo
    ? `${repository.owner}/${repository.repo}`
    : (repository.name ?? t('repositories:name.local'));

export type ConnectProblem = {
  /** Where to show it: under a field, or above the buttons. */
  field: 'credential' | 'repository' | 'form';
  message: string;
  /** What to check, when the message alone does not say. */
  hint?: string;
};

/** Turns a refusal from the connect call into a message and what to check, near the right field. */
export function connectProblem(
  error: Pick<ApiError, 'status' | 'code' | 'message'>,
  target: { owner: string; repo: string },
): ConnectProblem {
  const name = repositoryName(target);
  switch (error.code) {
    case 'credential_not_found':
      return {
        field: 'credential',
        message: t('repositories:connect.credentialGone'),
      };
    case 'credential_kind':
      return {
        field: 'credential',
        message: t('repositories:connect.credentialKind'),
      };
    case 'already_connected':
      return { field: 'repository', message: t('repositories:connect.alreadyConnected', { name }) };
    case 'github_auth':
      return {
        field: 'credential',
        message: error.message,
        hint: t('repositories:connect.authHint'),
      };
    case 'github_forbidden':
      return {
        field: 'repository',
        message: error.message,
        hint: t('repositories:connect.forbiddenHint', {
          name,
          owner: target.owner,
          repo: target.repo,
        }),
      };
    case 'github_not_found':
      return {
        field: 'repository',
        message: error.message,
        hint: t('repositories:connect.notFoundHint', { name }),
      };
    case 'invalid_request':
      return { field: 'repository', message: error.message };
    default:
      return { field: 'form', message: error.message };
  }
}

// ---------------------------------------------------------------------------------------------
// Labels

export type Tone = 'neutral' | 'ok' | 'bad' | 'warn' | 'info' | 'accent';

const projectKindKeys: Record<ProjectKind, string> = {
  fastlane: k('repositories:kind.fastlane'),
  expo: k('repositories:kind.expo'),
  both: k('repositories:kind.both'),
  unknown: k('repositories:kind.unknown'),
};

/** The name of a project type, in the active language. */
export const projectKindLabel = (kind: ProjectKind): string => t(projectKindKeys[kind]);

/** The badge for a repository's project type. `null` means it was never scanned. */
export function projectKindBadge(kind: ProjectKind | null | undefined): {
  label: string;
  tone: Tone;
} {
  if (!kind) return { label: t('repositories:kind.notScanned'), tone: 'neutral' };
  return { label: projectKindLabel(kind), tone: kind === 'unknown' ? 'warn' : 'accent' };
}

/** One sentence on what the detected type means for this tool. */
export function projectKindSummary(kind: ProjectKind): string {
  switch (kind) {
    case 'fastlane':
      return t('repositories:kind.summaryFastlane');
    case 'expo':
      return t('repositories:kind.summaryExpo');
    case 'both':
      return t('repositories:kind.summaryBoth');
    case 'unknown':
      return t('repositories:kind.summaryUnknown');
  }
}

export const platformLabel = (platform: Platform) => platformMeta(platform).label;

export const storeLabel: Record<ListingStore, string> = {
  app_store: 'App Store',
  google_play: 'Google Play',
};

// ---------------------------------------------------------------------------------------------
// Where the listing comes from

/**
 * Why a role cannot see the listing, or null when it can. Reading the listing sends traffic to
 * GitHub with the stored credential, so the server asks for `repositories.scan` (member and up).
 * A viewer must not call it: the screen says so instead of showing a 403.
 */
export function listingReadNotice(role: Role): string | null {
  if (can(role, 'repositories.scan')) return null;
  return t('repositories:listing.readNotice');
}

/** The badge for where a store's listing is read from. */
export function listingSourceBadge(source: StoreSource['source']): { label: string; tone: Tone } {
  return source === 'expo-store-config'
    ? { label: t('repositories:listing.sourceExpo'), tone: 'accent' }
    : { label: t('repositories:listing.sourceFastlane'), tone: 'info' };
}

/** "file" for an Expo store config, "folder" for fastlane metadata. */
export const sourcePathKind = (source: StoreSource['source']): 'file' | 'folder' =>
  source === 'expo-store-config' ? 'file' : 'folder';

/** What the store's listing is stored as, for a heading's sentence: where the copyright lives. */
export const copyrightLocation = (source: StoreSource['source']): string =>
  source === 'expo-store-config' ? 'apple.copyright' : 'copyright.txt';

/** The sentence for a source that exists but could not be read, or null when it is fine. */
export function sourceProblem(source: Pick<StoreSource, 'error'>): string | null {
  if (source.error === undefined) return null;
  return t('repositories:listing.sourceProblem', { error: source.error });
}

/** True when no store has any listing text and no source is broken (a broken one is shown as such). */
export function listingIsEmpty(data: Pick<RepositoryListing, 'found' | 'sources'>): boolean {
  return (
    !data.found.appStore &&
    !data.found.googlePlay &&
    data.sources.appStore.error === undefined &&
    data.sources.googlePlay.error === undefined
  );
}

/** The sentence for a repository with no listing text: where each store was looked for. */
export function emptyListingDescription(data: Pick<RepositoryListing, 'sources'>): string {
  const { appStore, googlePlay } = data.sources;
  const key =
    appStore.source === 'expo-store-config'
      ? k('repositories:listing.emptyExpo')
      : k('repositories:listing.emptyFastlane');
  return t(key, { appStore: appStore.path, googlePlay: googlePlay.path });
}

export const changeSetStatuses: readonly ChangeSetStatus[] = [
  'draft',
  'approved',
  'applying',
  'applied',
  'failed',
  'discarded',
];

export type StatusInfo = { label: string; tone: Tone; dot: boolean; description: string };

type StatusSpec = { label: string; description: string; tone: Tone; dot: boolean };

const statusSpecs: Record<ChangeSetStatus, StatusSpec> = {
  draft: {
    label: k('repositories:status.draft'),
    tone: 'neutral',
    dot: false,
    description: k('repositories:status.draftHint'),
  },
  approved: {
    label: k('repositories:status.approved'),
    tone: 'info',
    dot: false,
    description: k('repositories:status.approvedHint'),
  },
  applying: {
    label: k('repositories:status.applying'),
    tone: 'accent',
    dot: true,
    description: k('repositories:status.applyingHint'),
  },
  applied: {
    label: k('repositories:status.applied'),
    tone: 'ok',
    dot: false,
    description: k('repositories:status.appliedHint'),
  },
  failed: {
    label: k('repositories:status.failed'),
    tone: 'bad',
    dot: false,
    description: k('repositories:status.failedHint'),
  },
  discarded: {
    label: k('repositories:status.discarded'),
    tone: 'neutral',
    dot: false,
    description: k('repositories:status.discardedHint'),
  },
};

export const changeSetStatusInfo = (status: ChangeSetStatus): StatusInfo => {
  const spec = statusSpecs[status];
  return { label: t(spec.label), tone: spec.tone, dot: spec.dot, description: t(spec.description) };
};

const fileChangeKeys: Record<'added' | 'modified' | 'deleted', string> = {
  added: k('repositories:file.added'),
  modified: k('repositories:file.modified'),
  deleted: k('repositories:file.deleted'),
};

/** "Added", "Modified" or "Deleted", in the active language. */
export const fileChangeLabel = (change: 'added' | 'modified' | 'deleted'): string =>
  t(fileChangeKeys[change]);

export const fileChangeTone: Record<'added' | 'modified' | 'deleted', Tone> = {
  added: 'ok',
  modified: 'info',
  deleted: 'bad',
};

export function filesChangedLabel(count: number): string {
  return t('repositories:file.count', { count });
}

/** "You", a member's name when known, or what kind of actor it was. */
export function actorLabel(
  actor: { type: string; id: string },
  myId: string,
  names: Readonly<Record<string, string>> = {},
): string {
  if (actor.type === 'user')
    return actor.id === myId
      ? t('repositories:actor.you')
      : (names[actor.id] ?? t('repositories:actor.teamMember'));
  if (actor.type === 'token') return t('repositories:actor.apiToken');
  if (actor.type === 'assistant') return t('repositories:actor.assistant');
  return t('repositories:actor.system');
}

/** The person who approved, from the user id the API stores. */
export function approverLabel(
  userId: string,
  myId: string,
  names: Readonly<Record<string, string>> = {},
): string {
  return actorLabel({ type: 'user', id: userId }, myId, names);
}

export type ChangeSetActions = { approve: boolean; apply: boolean; discard: boolean };

/**
 * What this person may do to a change set right now. Mirrors the server: only an admin or owner
 * approves, applies, and discards anyone's; a member discards only their own draft. How it is
 * applied (a pull request or a commit in the local clone) is chosen in the Apply dialog, which says
 * what is not possible and why (lib/change-set-apply.ts).
 */
export function changeSetActions(input: {
  role: Role;
  status: ChangeSetStatus;
  createdBy: { type: string; id: string };
  myId: string;
}): ChangeSetActions {
  const { role, status, createdBy, myId } = input;
  const admin = can(role, 'changesets.approve');
  const ownDraft =
    status === 'draft' &&
    can(role, 'changesets.write') &&
    createdBy.type === 'user' &&
    createdBy.id === myId;
  return {
    approve: admin && status === 'draft',
    apply: admin && status === 'approved',
    discard:
      (admin && (status === 'draft' || status === 'approved' || status === 'failed')) || ownDraft,
  };
}

/** The text of the link to a change set's pull request. */
export const prLabel = (changeSet: Pick<ChangeSetView, 'prNumber'>) =>
  changeSet.prNumber === null
    ? t('repositories:pr.open')
    : t('repositories:pr.openNumber', { number: changeSet.prNumber });

// ---------------------------------------------------------------------------------------------
// Counting characters

const usageCharacters = {
  plain: k('repositories:usage.characters'),
  withMax: k('repositories:usage.charactersMax'),
};
const usageBytes = {
  plain: k('repositories:usage.bytes'),
  withMax: k('repositories:usage.bytesMax'),
};

export type FieldUsage = {
  count: number;
  max?: number;
  min?: number;
  unit: 'characters' | 'bytes';
  over: boolean;
  under: boolean;
  /** "12 / 30 characters", or "12 characters" when the store states no limit. */
  text: string;
};

/** How much of a field's limit a value uses, counted the way the store counts. */
export function fieldUsage(
  spec: Pick<ListingFieldSpec, 'maxLength' | 'minLength' | 'unit'>,
  value: string,
): FieldUsage {
  const count = measureField(spec, value);
  const { maxLength: max, minLength: min, unit } = spec;
  const keys = unit === 'bytes' ? usageBytes : usageCharacters;
  const text = max === undefined ? t(keys.plain, { count }) : t(keys.withMax, { count, max });
  return {
    count,
    ...(max === undefined ? {} : { max }),
    ...(min === undefined ? {} : { min }),
    unit,
    over: max !== undefined && count > max,
    under: min !== undefined && value.trim() !== '' && count < min,
    text,
  };
}

// ---------------------------------------------------------------------------------------------
// The listing as a set of fields

export const listingStores: readonly ListingStore[] = ['app_store', 'google_play'];

/** The per-locale fields of a store, in the order the screen shows them. */
export function localeFieldSpecs(store: ListingStore): ListingFieldSpec[] {
  return store === 'app_store'
    ? APP_STORE_FIELDS.map((f) => APP_STORE_FIELD_SPECS[f])
    : PLAY_FIELDS.map((f) => PLAY_FIELD_SPECS[f]);
}

/** Locale codes of one store, the fastlane `default` folder first, then alphabetical. */
export function storeLocales(listing: Listing, store: ListingStore): string[] {
  const keys = Object.keys(
    (store === 'app_store' ? listing.appStore?.locales : listing.googlePlay?.locales) ?? {},
  );
  if (store === 'google_play') {
    for (const locale of Object.keys(listing.googlePlay?.changelogs ?? {})) {
      if (!keys.includes(locale)) keys.push(locale);
    }
  }
  return keys.sort((a, b) =>
    a === DEFAULT_LOCALE ? -1 : b === DEFAULT_LOCALE ? 1 : a.localeCompare(b),
  );
}

/** Version codes with a release note for one Play locale, newest (highest number) first. */
export function changelogCodes(listing: Listing, locale: string): string[] {
  return Object.keys(listing.googlePlay?.changelogs[locale] ?? {}).sort((a, b) => {
    if (a === DEFAULT_LOCALE) return 1;
    if (b === DEFAULT_LOCALE) return -1;
    return Number(b) - Number(a);
  });
}

export const changelogField = (code: string) => `changelog/${code}`;

/** The text of one field, or undefined when it has no file. `locale` is absent for the copyright. */
export function readField(
  listing: Listing,
  store: ListingStore,
  locale: string | undefined,
  field: string,
): string | undefined {
  if (store === 'app_store') {
    if (field === 'copyright') return listing.appStore?.copyright;
    return locale === undefined
      ? undefined
      : (listing.appStore?.locales[locale] as Record<string, string | undefined> | undefined)?.[
          field
        ];
  }
  if (locale === undefined) return undefined;
  if (field.startsWith('changelog/'))
    return listing.googlePlay?.changelogs[locale]?.[field.slice('changelog/'.length)];
  return (listing.googlePlay?.locales[locale] as Record<string, string | undefined> | undefined)?.[
    field
  ];
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const cloneListing = (listing: Listing): Listing => clone(listing);

/** A copy of the listing with one field set. The original is not changed. */
export function writeField(
  listing: Listing,
  store: ListingStore,
  locale: string | undefined,
  field: string,
  value: string,
): Listing {
  const next = clone(listing);
  if (store === 'app_store') {
    const target = (next.appStore ??= { locales: {} });
    if (field === 'copyright') target.copyright = value;
    else if (locale !== undefined) {
      const text = (target.locales[locale] ??= {}) as Record<string, string | undefined>;
      text[field] = value;
    }
    return next;
  }
  const target = (next.googlePlay ??= { locales: {}, changelogs: {} });
  if (locale === undefined) return next;
  if (field.startsWith('changelog/')) {
    const notes = (target.changelogs[locale] ??= {});
    notes[field.slice('changelog/'.length)] = value;
  } else {
    const text = (target.locales[locale] ??= {}) as Record<string, string | undefined>;
    text[field] = value;
  }
  return next;
}

export type ListingEdit = {
  store: ListingStore;
  locale?: string;
  field: string;
  before: string | undefined;
  after: string | undefined;
};

/** Every field of a listing as [store, locale, field, value]. */
function entries(
  listing: Listing,
): Array<{ store: ListingStore; locale?: string; field: string; value: string }> {
  const out: Array<{ store: ListingStore; locale?: string; field: string; value: string }> = [];
  if (listing.appStore) {
    for (const [locale, text] of Object.entries(listing.appStore.locales)) {
      for (const [field, value] of Object.entries(text)) {
        if (typeof value === 'string') out.push({ store: 'app_store', locale, field, value });
      }
    }
    if (listing.appStore.copyright !== undefined) {
      out.push({ store: 'app_store', field: 'copyright', value: listing.appStore.copyright });
    }
  }
  if (listing.googlePlay) {
    for (const [locale, text] of Object.entries(listing.googlePlay.locales)) {
      for (const [field, value] of Object.entries(text)) {
        if (typeof value === 'string') out.push({ store: 'google_play', locale, field, value });
      }
    }
    for (const [locale, notes] of Object.entries(listing.googlePlay.changelogs)) {
      for (const [code, value] of Object.entries(notes)) {
        out.push({ store: 'google_play', locale, field: changelogField(code), value });
      }
    }
  }
  return out;
}

const editKey = (e: { store: ListingStore; locale?: string; field: string }) =>
  `${e.store}\u0000${e.locale ?? ''}\u0000${e.field}`;

/**
 * The fields whose text differs between two listings. A field that has no file and was left empty
 * is not an edit: an empty box is not a request to create an empty file.
 */
export function listingEdits(base: Listing, edited: Listing): ListingEdit[] {
  const before = new Map(entries(base).map((e) => [editKey(e), e]));
  const after = new Map(entries(edited).map((e) => [editKey(e), e]));
  const out: ListingEdit[] = [];
  for (const [key, e] of after) {
    const was = before.get(key)?.value;
    if (was === e.value) continue;
    if (was === undefined && e.value === '') continue;
    out.push({
      store: e.store,
      ...(e.locale === undefined ? {} : { locale: e.locale }),
      field: e.field,
      before: was,
      after: e.value,
    });
  }
  for (const [key, e] of before) {
    if (!after.has(key)) {
      out.push({
        store: e.store,
        ...(e.locale === undefined ? {} : { locale: e.locale }),
        field: e.field,
        before: e.value,
        after: undefined,
      });
    }
  }
  return out;
}

export const hasEdits = (base: Listing, edited: Listing) => listingEdits(base, edited).length > 0;

/**
 * The listing to send when creating a change set: the whole edited listing of every store that has
 * an edit, and nothing for a store that has none (the server leaves a store that is missing alone).
 * Fields that were empty and are still empty are dropped, so no empty file is created.
 */
export function listingForChangeSet(base: Listing, edited: Listing): Listing {
  const touched = new Set(listingEdits(base, edited).map((e) => e.store));
  const result: Listing = {};
  if (touched.has('app_store') && edited.appStore) {
    const locales: Record<string, Record<string, string>> = {};
    for (const [locale, text] of Object.entries(edited.appStore.locales)) {
      const kept: Record<string, string> = {};
      for (const [field, value] of Object.entries(text)) {
        if (typeof value !== 'string') continue;
        if (value === '' && readField(base, 'app_store', locale, field) === undefined) continue;
        kept[field] = value;
      }
      locales[locale] = kept;
    }
    const copyright = edited.appStore.copyright;
    const keepCopyright =
      copyright !== undefined && !(copyright === '' && base.appStore?.copyright === undefined);
    result.appStore = { locales, ...(keepCopyright ? { copyright } : {}) };
  }
  if (touched.has('google_play') && edited.googlePlay) {
    const locales: Record<string, Record<string, string>> = {};
    for (const [locale, text] of Object.entries(edited.googlePlay.locales)) {
      const kept: Record<string, string> = {};
      for (const [field, value] of Object.entries(text)) {
        if (typeof value !== 'string') continue;
        if (value === '' && readField(base, 'google_play', locale, field) === undefined) continue;
        kept[field] = value;
      }
      locales[locale] = kept;
    }
    result.googlePlay = { locales, changelogs: clone(edited.googlePlay.changelogs) };
  }
  return result;
}

/** "Update 2 fields in en-US and de" style summary the person can accept or change. */
export function suggestSummary(edits: readonly ListingEdit[]): string {
  if (edits.length === 0) return '';
  const locales = [
    ...new Set(edits.map((e) => e.locale).filter((l): l is string => l !== undefined)),
  ].sort();
  const count = edits.length;
  if (locales.length === 0) return t('repositories:summary.update', { count });
  if (locales.length <= 3)
    return t('repositories:summary.updateIn', { count, locales: locales.join(', ') });
  return t('repositories:summary.updateMany', { count, languages: locales.length });
}

// ---------------------------------------------------------------------------------------------
// Diff

export type DiffRow = {
  kind: 'same' | 'add' | 'del';
  text: string;
  oldNo?: number;
  newNo?: number;
};

/** Lines of a file. The newline that ends the last line does not start another one. */
export function splitLines(text: string | undefined): string[] {
  if (text === undefined || text === '') return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Above this many cells the line-by-line comparison is skipped and the middle shows as replaced.
const MAX_CELLS = 400_000;

/** A line diff of two texts. A missing side is an empty file (a new or a deleted file). */
export function diffLines(before: string | undefined, after: string | undefined): DiffRow[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle: Array<{ kind: DiffRow['kind']; text: string }> = [];

  if (midA.length * midB.length > MAX_CELLS) {
    for (const text of midA) middle.push({ kind: 'del', text });
    for (const text of midB) middle.push({ kind: 'add', text });
  } else {
    const n = midA.length;
    const m = midB.length;
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] =
          midA[i] === midB[j]
            ? (table[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        middle.push({ kind: 'same', text: midA[i] as string });
        i++;
        j++;
      } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
        middle.push({ kind: 'del', text: midA[i] as string });
        i++;
      } else {
        middle.push({ kind: 'add', text: midB[j] as string });
        j++;
      }
    }
    while (i < n) middle.push({ kind: 'del', text: midA[i++] as string });
    while (j < m) middle.push({ kind: 'add', text: midB[j++] as string });
  }

  const sequence = [
    ...a.slice(0, start).map((text) => ({ kind: 'same' as const, text })),
    ...middle,
    ...a.slice(endA).map((text) => ({ kind: 'same' as const, text })),
  ];
  let oldNo = 0;
  let newNo = 0;
  return sequence.map((row) => {
    if (row.kind === 'same') return { ...row, oldNo: ++oldNo, newNo: ++newNo };
    if (row.kind === 'del') return { ...row, oldNo: ++oldNo };
    return { ...row, newNo: ++newNo };
  });
}

export function diffStats(rows: readonly DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === 'add') added++;
    else if (row.kind === 'del') removed++;
  }
  return { added, removed };
}

export type DiffBlock = { type: 'rows' | 'collapsed'; rows: DiffRow[] };

/**
 * Groups rows so that long runs of unchanged lines can be folded. `context` lines stay visible on
 * each side of a change; a run is folded only when that saves at least two lines.
 */
export function collapseDiff(rows: readonly DiffRow[], context = 3): DiffBlock[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((row, index) => {
    if (row.kind === 'same') return;
    for (let k = Math.max(0, index - context); k <= Math.min(rows.length - 1, index + context); k++)
      keep[k] = true;
  });
  const blocks: DiffBlock[] = [];
  let i = 0;
  while (i < rows.length) {
    const folded = !keep[i];
    let j = i;
    while (j < rows.length && !keep[j] === folded) j++;
    const slice = rows.slice(i, j);
    blocks.push({ type: folded && slice.length >= 2 ? 'collapsed' : 'rows', rows: slice });
    i = j;
  }
  return blocks;
}

/** True when two texts differ but no line did (a trailing newline or line endings only). */
export function differsOnlyInLineEnds(
  before: string | undefined,
  after: string | undefined,
): boolean {
  if ((before ?? '') === (after ?? '')) return false;
  const { added, removed } = diffStats(diffLines(before, after));
  return added + removed === 0;
}

// ---------------------------------------------------------------------------------------------
// Scan results

/** The folders and files a scan found, with a readable name, omitting what it did not find. */
export function detectionPaths(
  detection: ProjectDetection,
): Array<{ label: string; values: string[] }> {
  const { paths } = detection;
  const rows: Array<{ label: string; values: string[] | string | undefined }> = [
    { label: t('repositories:detect.fastlaneDirs'), values: paths.fastlaneDirs },
    { label: t('repositories:detect.fastfiles'), values: paths.fastfiles },
    { label: t('repositories:detect.iosMetadata'), values: paths.iosMetadata },
    { label: t('repositories:detect.androidMetadata'), values: paths.androidMetadata },
    { label: t('repositories:detect.iosScreenshots'), values: paths.iosScreenshots },
    { label: t('repositories:detect.androidImages'), values: paths.androidImages },
    { label: t('repositories:detect.appJson'), values: paths.appJson },
    { label: t('repositories:detect.appConfig'), values: paths.appConfig },
    { label: t('repositories:detect.easJson'), values: paths.easJson },
    { label: t('repositories:detect.packageJson'), values: paths.packageJson },
  ];
  const out: Array<{ label: string; values: string[] }> = [];
  for (const row of rows) {
    const values = Array.isArray(row.values) ? row.values : row.values ? [row.values] : [];
    if (values.length > 0) out.push({ label: row.label, values });
  }
  // Several apps in one repository: each with its folders, so the person sees what can be chosen.
  const targets = detection.listing?.targets ?? [];
  if (targets.length > 1) {
    out.push({
      label: t('repositories:detect.listingTargets'),
      values: targets.map((t) => `${t.label}: ${targetRootsSummary(t.roots)}`),
    });
  }
  return out;
}

/** "Confirmed" for a fact a file states, "Likely" for a reading that is only a guess. */
export const strengthLabel = (strength: 'definite' | 'inferred') =>
  strength === 'definite' ? t('repositories:detect.confirmed') : t('repositories:detect.likely');

/** "iOS and Android", "iOS (likely)", or "None found". */
export function platformsSummary(
  detection: Pick<ProjectDetection, 'platforms' | 'platformsInferred'>,
): string {
  const parts = [
    ...detection.platforms.map(platformLabel),
    ...detection.platformsInferred.map((p) =>
      t('repositories:detect.platformLikely', { platform: platformLabel(p) }),
    ),
  ];
  if (parts.length === 0) return t('repositories:detect.noneFound');
  return formatList(parts);
}

// ---------------------------------------------------------------------------------------------
// Listing targets: which app or folder of the repository the listing is read from

/**
 * Why a path is not a valid listing folder, or undefined when it is. The same rules as the server
 * (checkListingRoot of @kiln/connectors, which follows the repository path rules): relative, no
 * leading slash, no empty, `.` or `..` segment, no `.git`, no backslash. A leading `./` and a
 * trailing slash are tolerated.
 */
export function checkListingRoot(path: string): string | undefined {
  const text = normalizeRoot(path);
  if (text === '') return t('repositories:root.empty');
  if (text.length > 300) return t('repositories:root.tooLong');
  if (text.startsWith('/')) return t('repositories:root.leadingSlash');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused on purpose
  if (/[\\\x00-\x1f\x7f]/.test(text)) return t('repositories:root.badChars');
  for (const segment of text.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      return t('repositories:root.badSegment');
    }
    if (segment.toLowerCase() === '.git') return t('repositories:root.gitFolder');
  }
  return undefined;
}

/** A folder as the server stores it: space, a leading `./` and trailing slashes removed. */
export const normalizeRoot = (path: string): string =>
  path
    .trim()
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '');

export type TargetForm = {
  name: string;
  appId: string;
  appStoreRoot: string;
  googlePlayRoot: string;
};
export type TargetFormField = 'name' | 'appId' | 'appStoreRoot' | 'googlePlayRoot' | 'roots';

export const emptyTargetForm = (): TargetForm => ({
  name: '',
  appId: '',
  appStoreRoot: '',
  googlePlayRoot: '',
});

export function targetFormFrom(
  target: Pick<ListingTargetView, 'label' | 'app' | 'roots'>,
): TargetForm {
  return {
    name: target.label,
    appId: target.app ?? '',
    appStoreRoot: target.roots.appStore ?? '',
    googlePlayRoot: target.roots.googlePlay ?? '',
  };
}

/** What is wrong with the form, by field. Empty: it can be saved. */
export function targetFormProblems(form: TargetForm): Partial<Record<TargetFormField, string>> {
  const problems: Partial<Record<TargetFormField, string>> = {};
  const name = form.name.trim();
  if (name === '') problems.name = t('repositories:target.nameRequired');
  else if (name.length > 60) problems.name = t('repositories:target.nameTooLong');
  for (const field of ['appStoreRoot', 'googlePlayRoot'] as const) {
    if (form[field].trim() === '') continue;
    const message = checkListingRoot(form[field]);
    if (message) problems[field] = message;
  }
  if (form.appStoreRoot.trim() === '' && form.googlePlayRoot.trim() === '') {
    problems.roots = t('repositories:target.rootsRequired');
  }
  return problems;
}

/** The request body for a form: trimmed, a blank value as null. */
export function targetInput(form: TargetForm): ListingTargetInput {
  const blank = (v: string) => (v.trim() === '' ? null : v.trim());
  return {
    name: form.name.trim(),
    appId: blank(form.appId),
    appStoreRoot: blank(form.appStoreRoot),
    googlePlayRoot: blank(form.googlePlayRoot),
  };
}

/** The problems a refused save came with (`invalid_target`), by field, or the message under the name. */
export function targetServerProblems(
  error: Pick<ApiError, 'code' | 'message' | 'body'>,
): Partial<Record<TargetFormField, string>> {
  if (error.code === 'duplicate_name') return { name: error.message };
  const list = error.body.problems;
  if (error.code === 'invalid_target' && Array.isArray(list)) {
    const out: Partial<Record<TargetFormField, string>> = {};
    for (const item of list) {
      const entry = item as { field?: TargetFormField; message?: string };
      if (entry.field && entry.message && out[entry.field] === undefined)
        out[entry.field] = entry.message;
    }
    if (Object.keys(out).length > 0) return out;
  }
  return {};
}

/** "App Store: a/ios · Google Play: a/android", leaving out a store the target has no folder for. */
export function targetRootsSummary(roots: {
  appStore: string | null;
  googlePlay: string | null;
}): string {
  const parts = [
    roots.appStore ? t('repositories:target.rootAppStore', { path: roots.appStore }) : '',
    roots.googlePlay ? t('repositories:target.rootGooglePlay', { path: roots.googlePlay }) : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : t('repositories:target.noFolders');
}

export const targetOptionLabel = (target: Pick<ListingTargetView, 'label' | 'origin'>): string =>
  target.origin === 'custom'
    ? t('repositories:target.optionCustom', { label: target.label })
    : target.label;

/**
 * Whether the listing panel shows the target bar: several places to read from, a saved one, folders
 * chosen one by one, or a person who may add one.
 */
export function showTargetBar(
  data: Pick<RepositoryListing, 'targets' | 'selected'>,
  canManage: boolean,
): boolean {
  const targets = data.targets ?? [];
  return (
    targets.length > 1 ||
    targets.some((t) => t.origin === 'custom') ||
    data.selected?.origin === 'folders' ||
    canManage
  );
}

/**
 * What to send with a change set so it is made in the folders the person was looking at: the
 * target that was read (an id never changes meaning), or the folders when none was.
 */
export function selectionForRequest(
  data: Pick<RepositoryListing, 'selected' | 'roots'>,
): ListingSelection {
  const id = data.selected?.id;
  if (id && data.selected?.origin !== 'folders') return { target: id };
  return { roots: { appStore: data.roots.appStore, googlePlay: data.roots.googlePlay } };
}

// ---------------------------------------------------------------------------------------------
// Local clones (docs/adr/0005-local-clone-reads.md)

export const MAX_LOCAL_PATH_LENGTH = 4096;

/**
 * The text rules for a folder path, checked before asking the server (which checks again and also
 * resolves links and the allowed folders): not empty, no control characters, absolute, no `..`.
 */
export function checkLocalPathInput(
  input: string,
): { ok: true; path: string } | { ok: false; message: string } {
  const path = input.trim();
  if (/[\u0000-\u001f\u007f]/.test(path))
    return { ok: false, message: t('repositories:local.controlChars') };
  if (path === '') return { ok: false, message: t('repositories:local.pathEmpty') };
  if (path.length > MAX_LOCAL_PATH_LENGTH)
    return { ok: false, message: t('repositories:local.pathTooLong') };
  if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path)) {
    return {
      ok: false,
      message: t('repositories:local.pathAbsolute'),
    };
  }
  if (path.split(/[\\/]+/).includes('..'))
    return { ok: false, message: t('repositories:local.pathDotDot') };
  return { ok: true, path };
}

/** The first seven characters of a commit id. */
export const shortSha = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : '');

type ReadKeys = {
  unknown: string;
  uncountable: string;
  other: string;
  detached: string;
  clean: string;
  dirty: string;
};

const readWithCommit: ReadKeys = {
  unknown: k('repositories:local.shaBranchUnknown'),
  uncountable: k('repositories:local.shaBranchUncountable'),
  other: k('repositories:local.shaBranchOther'),
  detached: k('repositories:local.shaBranchDetached'),
  clean: k('repositories:local.shaBranchClean'),
  dirty: k('repositories:local.shaBranchDirty'),
};

const readLatest: ReadKeys = {
  unknown: k('repositories:local.latestBranchUnknown'),
  uncountable: k('repositories:local.latestBranchUncountable'),
  other: k('repositories:local.latestBranchOther'),
  detached: k('repositories:local.latestBranchDetached'),
  clean: k('repositories:local.latestBranchClean'),
  dirty: k('repositories:local.latestBranchDirty'),
};

/**
 * One sentence on what a local folder is read as: the committed tip of a branch, never the
 * working files. With the result of a check it says how many uncommitted changes are left out,
 * for the branch the folder has checked out.
 */
export function localReadSummary(input: {
  branch: string;
  /** The commit the branch is at, or the last one that was read. */
  sha?: string | null | undefined;
  checkedOutBranch?: string | null | undefined;
  dirtyCount?: number | null | undefined;
}): string {
  const keys = input.sha ? readWithCommit : readLatest;
  const { dirtyCount, checkedOutBranch } = input;
  const params = { sha: shortSha(input.sha), branch: input.branch };
  if (dirtyCount === undefined) return t(keys.unknown, params);
  if (dirtyCount === null) return t(keys.uncountable, params);
  if (checkedOutBranch !== undefined && checkedOutBranch !== input.branch) {
    return checkedOutBranch === null
      ? t(keys.detached, params)
      : t(keys.other, { ...params, checkedOut: checkedOutBranch });
  }
  if (dirtyCount === 0) return t(keys.clean, params);
  return t(keys.dirty, { ...params, count: dirtyCount });
}

/** The notice for a server where local clones are off: what to set, in the words of the setting. */
export function localDisabledNotice(
  config: Pick<LocalConfig, 'enabled' | 'envName' | 'reason' | 'message'>,
): { title: string; body: string; envName: string } {
  const reason = config.reason;
  if (reason === 'reads_api') {
    return {
      title: t('repositories:local.offReadsApiTitle'),
      body: config.message ?? t('repositories:local.offReadsApiBody'),
      envName: config.envName,
    };
  }
  if (reason === 'git_missing') {
    return {
      title: t('repositories:local.gitMissingTitle'),
      body: config.message ?? t('repositories:local.gitMissingBody'),
      envName: config.envName,
    };
  }
  return {
    title: t('repositories:local.disabledTitle'),
    body: t('repositories:local.disabledBody', { envName: config.envName }),
    envName: config.envName,
  };
}

/** The allowed folders as a hint under the path field. */
export function localRootsHint(config: Pick<LocalConfig, 'roots'> | null | undefined): string {
  const roots = config?.roots ?? [];
  if (roots.length === 0) return t('repositories:local.rootsNone');
  const key =
    roots.length === 1 ? k('repositories:local.rootsOne') : k('repositories:local.rootsMany');
  return t(key, { roots: roots.join(', ') });
}

export type LocalStatusInfo = { label: string; tone: Tone; ok: boolean };

/** A badge for whether the stored folder can be read now. */
export function localStatusInfo(status: LocalStatus): LocalStatusInfo {
  switch (status) {
    case 'ok':
      return { label: t('repositories:local.statusOk'), tone: 'ok', ok: true };
    case 'not_enabled':
      return { label: t('repositories:local.statusNotEnabled'), tone: 'warn', ok: false };
    case 'reads_api':
      return { label: t('repositories:local.statusReadsApi'), tone: 'warn', ok: false };
    case 'git_missing':
      return { label: t('repositories:local.statusGitMissing'), tone: 'bad', ok: false };
    case 'not_found':
      return { label: t('repositories:local.statusNotFound'), tone: 'bad', ok: false };
    case 'outside_roots':
      return { label: t('repositories:local.statusOutside'), tone: 'bad', ok: false };
    case 'not_a_repository':
    case 'bare_repository':
      return { label: t('repositories:local.statusNotRepo'), tone: 'bad', ok: false };
    default:
      return { label: t('repositories:local.statusUnreadable'), tone: 'bad', ok: false };
  }
}

export type ConnectChoice =
  | { kind: 'local_only'; id: 'local-only'; label: string; recommended: false; needsConfirm: false }
  | {
      kind: 'attach';
      id: string;
      repositoryId: string;
      label: string;
      /** The clone's origin is this repository. */
      recommended: boolean;
      /** The clone's origin is another GitHub repository: the server needs a confirmation. */
      needsConfirm: boolean;
      /** The repository already has a local clone, which this replaces. */
      replaces: string | null;
    };

const sameRepo = (
  a: { owner: string; repo: string },
  b: { owner: string | null; repo: string | null },
) =>
  a.owner.toLowerCase() === (b.owner ?? '').toLowerCase() &&
  a.repo.toLowerCase() === (b.repo ?? '').toLowerCase();

/**
 * What a checked folder can be used for: attached to a connected GitHub repository (the one its
 * origin names first), or connected as a local-only repository. Only when `fixed` is given is the
 * choice that repository alone (the card of a repository's own page).
 */
export function connectChoices(
  check: Pick<LocalCheck, 'remote' | 'existing' | 'realPath'>,
  repositories: readonly RepositorySummary[],
  fixed?: RepositorySummary,
): ConnectChoice[] {
  if (check.existing && !(fixed && check.existing.id === fixed.id)) return [];
  const github = (fixed ? [fixed] : repositories).filter((r) => !r.localOnly);
  const origin = check.remote?.github ? check.remote : null;
  const attach = github.map(
    (r): ConnectChoice => ({
      kind: 'attach',
      id: `attach:${r.id}`,
      repositoryId: r.id,
      label: t('repositories:choice.attach', { name: repositoryName(r) }),
      recommended: origin !== null && sameRepo(origin, r),
      needsConfirm: origin !== null && !sameRepo(origin, r),
      replaces: r.local && r.local.path !== check.realPath ? r.local.path : null,
    }),
  );
  attach.sort(
    (a, b) =>
      Number(b.kind === 'attach' && b.recommended) - Number(a.kind === 'attach' && a.recommended),
  );
  if (fixed) return attach;
  return [
    ...attach,
    {
      kind: 'local_only',
      id: 'local-only',
      label: t('repositories:choice.localOnly'),
      recommended: false,
      needsConfirm: false,
    },
  ];
}

/** The choice to preselect: the repository the origin names, else local-only. */
export function defaultChoice(choices: readonly ConnectChoice[]): ConnectChoice | undefined {
  return (
    choices.find((c) => c.kind === 'attach' && c.recommended) ??
    choices.find((c) => c.kind === 'local_only') ??
    choices[0]
  );
}

/** What the primary button says for a choice. */
export function choiceButtonLabel(choice: ConnectChoice | undefined): string {
  if (!choice) return t('repositories:choice.pick');
  return choice.kind === 'local_only' ? t('repositories:choice.localOnlyButton') : choice.label;
}

/** A line under a choice: why it is suggested, or what it changes. */
export function choiceNote(choice: ConnectChoice, remote: LocalCheck['remote']): string | null {
  if (choice.kind === 'local_only') return t('repositories:choice.noteLocalOnly');
  const path = choice.replaces ?? '';
  if (choice.recommended) {
    return choice.replaces
      ? t('repositories:choice.noteRecommendedReplaces', { path })
      : t('repositories:choice.noteRecommended');
  }
  if (choice.needsConfirm && remote) {
    const origin = `${remote.owner}/${remote.repo}`;
    return choice.replaces
      ? t('repositories:choice.noteConfirmReplaces', { origin, path })
      : t('repositories:choice.noteConfirm', { origin });
  }
  return choice.replaces ? t('repositories:choice.noteReplaces', { path }) : null;
}
