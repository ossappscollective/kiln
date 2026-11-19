import {
  APP_STORE_FIELD_SPECS,
  APP_STORE_FIELDS,
  type ChangeSetStatus,
  can,
  countBytes,
  countCharacters,
  DEFAULT_LOCALE,
  type Listing,
  type ListingFieldSpec,
  type ListingStore,
  PLAY_FIELD_SPECS,
  PLAY_FIELDS,
  type Platform,
  platformMeta,
  type Role,
} from '@mrm/core';
import type { ApiError } from './api.ts';
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
  if (text === '') return { ok: false, message: 'Enter the repository as owner/name.' };
  const address = /^(?:git@github\.com:|(?:https?:\/\/)?(?:www\.)?github\.com\/)/i;
  const isAddress = address.test(text);
  const path = text.replace(address, '').replace(/[?#].*$/, '');
  const parts = path.split('/').filter((part) => part !== '');
  // A bare name is exactly owner/name; a GitHub address may carry more (…/tree/main).
  if (parts.length < 2 || (!isAddress && parts.length > 2)) {
    return { ok: false, message: 'Use the form owner/name, for example acme/mobile-app.' };
  }
  const owner = parts[0] ?? '';
  let repo = parts[1] ?? '';
  if (repo.toLowerCase().endsWith('.git')) repo = repo.slice(0, -4);
  if (!OWNER.test(owner))
    return { ok: false, message: `“${owner}” is not a GitHub user or organization name.` };
  if (!REPO.test(repo) || repo === '.' || repo === '..') {
    return { ok: false, message: `“${repo}” is not a GitHub repository name.` };
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
    : (repository.name ?? 'Local repository');

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
        message: 'That credential no longer exists. Pick another one.',
      };
    case 'credential_kind':
      return {
        field: 'credential',
        message: 'Only a GitHub App or a GitHub token can connect a repository.',
      };
    case 'already_connected':
      return { field: 'repository', message: `${name} is already connected to this workspace.` };
    case 'github_auth':
      return {
        field: 'credential',
        message: error.message,
        hint: 'GitHub did not accept this credential. Test it on the Credentials screen, or replace its secret.',
      };
    case 'github_forbidden':
      return {
        field: 'repository',
        message: error.message,
        hint: `The credential cannot read ${name}. For a GitHub App, check that it is installed on ${target.owner} and that ${target.repo} is selected under Repository access. For a token, check that it covers this repository and has read access to its contents.`,
      };
    case 'github_not_found':
      return {
        field: 'repository',
        message: error.message,
        hint: `Check the spelling of ${name}. GitHub also answers this way for a private repository that the credential cannot see, so confirm that the App or token has access to it.`,
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

export const projectKindLabel: Record<ProjectKind, string> = {
  fastlane: 'Fastlane',
  expo: 'Expo',
  both: 'Fastlane and Expo',
  unknown: 'Not recognized',
};

/** The badge for a repository's project type. `null` means it was never scanned. */
export function projectKindBadge(kind: ProjectKind | null | undefined): {
  label: string;
  tone: Tone;
} {
  if (!kind) return { label: 'Not scanned', tone: 'neutral' };
  return { label: projectKindLabel[kind], tone: kind === 'unknown' ? 'warn' : 'accent' };
}

/** One sentence on what the detected type means for this tool. */
export function projectKindSummary(kind: ProjectKind): string {
  switch (kind) {
    case 'fastlane':
      return 'A fastlane project. Store listing text is read from the metadata folders and changes are applied as a pull request, or as a commit on a new branch of a local clone.';
    case 'expo':
      return 'An Expo project. Its App Store listing is read from and edited in store.config.json when the repository has one. Google Play listing text lives in fastlane only.';
    case 'both':
      return 'Both fastlane and Expo files were found. The App Store listing comes from store.config.json when there is one (the fastlane App Store files are then ignored); the Google Play listing comes from fastlane.';
    case 'unknown':
      return 'No fastlane or Expo files were found. Check that this is the right repository and that the credential can read all of it.';
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
  return 'The store listing is read from GitHub with the stored credential, which needs the member role or higher. As a viewer you can see the project and the change sets, but not the listing text. Ask an admin if you need access.';
}

/** The badge for where a store's listing is read from. */
export function listingSourceBadge(source: StoreSource['source']): { label: string; tone: Tone } {
  return source === 'expo-store-config'
    ? { label: 'Expo store config', tone: 'accent' }
    : { label: 'Fastlane', tone: 'info' };
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
  return `${source.error} The listing cannot be shown or changed until the file is fixed in the repository.`;
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
  const apple =
    appStore.source === 'expo-store-config'
      ? `${appStore.path} (App Store, no apple.info locales)`
      : `${appStore.path} (App Store)`;
  return `No listing text was found at ${apple} or ${googlePlay.path} (Google Play). Fastlane keeps one folder per locale with a text file per field; Expo keeps the App Store text in store.config.json under apple.info. Run a scan to see what the project contains.`;
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

const statusInfo: Record<ChangeSetStatus, StatusInfo> = {
  draft: {
    label: 'Draft',
    tone: 'neutral',
    dot: false,
    description: 'Waiting for an admin or owner to approve it.',
  },
  approved: {
    label: 'Approved',
    tone: 'info',
    dot: false,
    description:
      'Approved. It can be applied as a pull request or as a commit on a new branch of the local clone.',
  },
  applying: {
    label: 'Applying',
    tone: 'accent',
    dot: true,
    description: 'Creating the branch and the pull request.',
  },
  applied: {
    label: 'Applied',
    tone: 'ok',
    dot: false,
    description: 'The pull request is open. Merge it in GitHub.',
  },
  failed: {
    label: 'Failed',
    tone: 'bad',
    dot: false,
    description: 'The change did not reach the repository.',
  },
  discarded: {
    label: 'Discarded',
    tone: 'neutral',
    dot: false,
    description: 'Closed without changing the repository.',
  },
};

export const changeSetStatusInfo = (status: ChangeSetStatus): StatusInfo => statusInfo[status];

export const fileChangeLabel: Record<'added' | 'modified' | 'deleted', string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
};

export const fileChangeTone: Record<'added' | 'modified' | 'deleted', Tone> = {
  added: 'ok',
  modified: 'info',
  deleted: 'bad',
};

export function filesChangedLabel(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'}`;
}

/** "You", a member's name when known, or what kind of actor it was. */
export function actorLabel(
  actor: { type: string; id: string },
  myId: string,
  names: Readonly<Record<string, string>> = {},
): string {
  if (actor.type === 'user')
    return actor.id === myId ? 'You' : (names[actor.id] ?? 'A team member');
  if (actor.type === 'token') return 'An API token';
  if (actor.type === 'assistant') return 'The assistant';
  return 'The system';
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
    ? 'Open the pull request'
    : `Open pull request #${changeSet.prNumber}`;

// ---------------------------------------------------------------------------------------------
// Counting characters

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
  const count = spec.unit === 'bytes' ? countBytes(value) : countCharacters(value);
  const { maxLength: max, minLength: min, unit } = spec;
  const text = max === undefined ? `${count} ${unit}` : `${count} / ${max} ${unit}`;
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
  const fields = edits.length === 1 ? '1 listing field' : `${edits.length} listing fields`;
  if (locales.length === 0) return `Update ${fields}`;
  if (locales.length <= 3) return `Update ${fields} in ${locales.join(', ')}`;
  return `Update ${fields} in ${locales.length} locales`;
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
    { label: 'Fastlane folders', values: paths.fastlaneDirs },
    { label: 'Fastfiles', values: paths.fastfiles },
    { label: 'App Store listing', values: paths.iosMetadata },
    { label: 'Google Play listing', values: paths.androidMetadata },
    { label: 'iOS screenshots', values: paths.iosScreenshots },
    { label: 'Android images', values: paths.androidImages },
    { label: 'Expo app.json', values: paths.appJson },
    { label: 'Expo app config', values: paths.appConfig },
    { label: 'EAS eas.json', values: paths.easJson },
    { label: 'package.json', values: paths.packageJson },
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
      label: 'Listing targets',
      values: targets.map((t) => `${t.label}: ${targetRootsSummary(t.roots)}`),
    });
  }
  return out;
}

/** "Confirmed" for a fact a file states, "Likely" for a reading that is only a guess. */
export const strengthLabel = (strength: 'definite' | 'inferred') =>
  strength === 'definite' ? 'Confirmed' : 'Likely';

/** "iOS and Android", "iOS (likely)", or "None found". */
export function platformsSummary(
  detection: Pick<ProjectDetection, 'platforms' | 'platformsInferred'>,
): string {
  const parts = [
    ...detection.platforms.map(platformLabel),
    ...detection.platformsInferred.map((p) => `${platformLabel(p)} (likely)`),
  ];
  if (parts.length === 0) return 'None found';
  return parts.length === 1
    ? (parts[0] as string)
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// ---------------------------------------------------------------------------------------------
// Listing targets: which app or folder of the repository the listing is read from

/**
 * Why a path is not a valid listing folder, or undefined when it is. The same rules as the server
 * (checkListingRoot of @mrm/connectors, which follows the repository path rules): relative, no
 * leading slash, no empty, `.` or `..` segment, no `.git`, no backslash. A leading `./` and a
 * trailing slash are tolerated.
 */
export function checkListingRoot(path: string): string | undefined {
  const text = normalizeRoot(path);
  if (text === '') return 'Enter a folder path inside the repository.';
  if (text.length > 300) return 'The path is too long (at most 300 characters).';
  if (text.startsWith('/'))
    return 'The path must be relative to the repository, without a leading slash.';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused on purpose
  if (/[\\\x00-\x1f\x7f]/.test(text))
    return 'The path must not contain backslashes or control characters.';
  for (const segment of text.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      return 'The path must not contain empty, "." or ".." segments.';
    }
    if (segment.toLowerCase() === '.git') return 'The path must not point into .git.';
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
  if (name === '') problems.name = 'Give the target a name.';
  else if (name.length > 60) problems.name = 'Use at most 60 characters.';
  for (const field of ['appStoreRoot', 'googlePlayRoot'] as const) {
    if (form[field].trim() === '') continue;
    const message = checkListingRoot(form[field]);
    if (message) problems[field] = message;
  }
  if (form.appStoreRoot.trim() === '' && form.googlePlayRoot.trim() === '') {
    problems.roots = 'Give an App Store folder, a Google Play folder or both.';
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
    roots.appStore ? `App Store: ${roots.appStore}` : '',
    roots.googlePlay ? `Google Play: ${roots.googlePlay}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'no folders';
}

export const targetOptionLabel = (target: Pick<ListingTargetView, 'label' | 'origin'>): string =>
  target.origin === 'custom' ? `${target.label} (custom)` : target.label;

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
    return { ok: false, message: 'The path must not contain control characters.' };
  if (path === '') return { ok: false, message: 'Enter the path of a folder on the server.' };
  if (path.length > MAX_LOCAL_PATH_LENGTH) return { ok: false, message: 'That path is too long.' };
  if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path)) {
    return {
      ok: false,
      message: 'Use an absolute path, such as /Volumes/dev/my-app. “~” is not expanded.',
    };
  }
  if (path.split(/[\\/]+/).includes('..'))
    return { ok: false, message: 'The path must not contain “..”.' };
  return { ok: true, path };
}

/** The first seven characters of a commit id. */
export const shortSha = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : '');

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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
  const head = input.sha
    ? `Reads commit ${shortSha(input.sha)} on branch ${input.branch}`
    : `Reads the latest commit on branch ${input.branch}`;
  const { dirtyCount, checkedOutBranch } = input;
  if (dirtyCount === undefined) return `${head}. Uncommitted changes in the folder are never read.`;
  if (dirtyCount === null)
    return `${head}. Uncommitted changes are never read (they could not be counted).`;
  if (checkedOutBranch !== undefined && checkedOutBranch !== input.branch) {
    return `${head}. The folder has ${checkedOutBranch ?? 'a detached HEAD'} checked out; only committed work on ${input.branch} is read.`;
  }
  if (dirtyCount === 0) return `${head}. The folder has no uncommitted changes.`;
  return `${head}; ${plural(dirtyCount, 'uncommitted change is', 'uncommitted changes are')} not included.`;
}

/** The notice for a server where local clones are off: what to set, in the words of the setting. */
export function localDisabledNotice(
  config: Pick<LocalConfig, 'enabled' | 'envName' | 'reason' | 'message'>,
): { title: string; body: string; envName: string } {
  const reason = config.reason;
  if (reason === 'reads_api') {
    return {
      title: 'Local clones are off: MRM_READS=api',
      body:
        config.message ?? 'MRM_READS=api means git is never run, so local clones cannot be read.',
      envName: config.envName,
    };
  }
  if (reason === 'git_missing') {
    return {
      title: 'git is not available on the server',
      body: config.message ?? 'Install git or set MRM_GIT_PATH.',
      envName: config.envName,
    };
  }
  return {
    title: 'Local clones are not enabled',
    body: `Set ${config.envName}=/Volumes/dev (a colon-separated list of the folders that may hold your clones) and restart the server.`,
    envName: config.envName,
  };
}

/** The allowed folders as a hint under the path field. */
export function localRootsHint(config: Pick<LocalConfig, 'roots'> | null | undefined): string {
  const roots = config?.roots ?? [];
  if (roots.length === 0) return 'The folder must be inside an allowed folder on the server.';
  return `The folder must be inside ${roots.length === 1 ? 'the allowed folder' : 'one of the allowed folders'}: ${roots.join(', ')}.`;
}

export type LocalStatusInfo = { label: string; tone: Tone; ok: boolean };

/** A badge for whether the stored folder can be read now. */
export function localStatusInfo(status: LocalStatus): LocalStatusInfo {
  switch (status) {
    case 'ok':
      return { label: 'Readable', tone: 'ok', ok: true };
    case 'not_enabled':
      return { label: 'Local clones off', tone: 'warn', ok: false };
    case 'reads_api':
      return { label: 'Reading from GitHub', tone: 'warn', ok: false };
    case 'git_missing':
      return { label: 'git missing', tone: 'bad', ok: false };
    case 'not_found':
      return { label: 'Folder not found', tone: 'bad', ok: false };
    case 'outside_roots':
      return { label: 'Outside allowed folders', tone: 'bad', ok: false };
    case 'not_a_repository':
    case 'bare_repository':
      return { label: 'Not a repository', tone: 'bad', ok: false };
    default:
      return { label: 'Cannot be read', tone: 'bad', ok: false };
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
      label: `Attach to ${repositoryName(r)}`,
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
      label: 'Connect as a local-only repository',
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
  if (!choice) return 'Choose what to do';
  return choice.kind === 'local_only' ? 'Connect as local-only repository' : choice.label;
}

/** A line under a choice: why it is suggested, or what it changes. */
export function choiceNote(choice: ConnectChoice, remote: LocalCheck['remote']): string | null {
  if (choice.kind === 'local_only') {
    return 'No GitHub connection: the folder is the repository. Pull requests are not available for it yet.';
  }
  const replaces = choice.replaces ? ` Replaces its current local clone (${choice.replaces}).` : '';
  if (choice.recommended)
    return `The clone’s origin points at this repository. Applying still opens a pull request on GitHub.${replaces}`;
  if (choice.needsConfirm && remote) {
    return `The clone’s origin is ${remote.owner}/${remote.repo}, a different repository. Attach only if it is a fork or mirror of this one.${replaces}`;
  }
  return replaces ? replaces.trim() : null;
}
