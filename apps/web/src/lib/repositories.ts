import {
  APP_STORE_FIELDS,
  APP_STORE_FIELD_SPECS,
  type ChangeSetStatus,
  DEFAULT_LOCALE,
  type Listing,
  type ListingFieldSpec,
  type ListingStore,
  PLAY_FIELDS,
  PLAY_FIELD_SPECS,
  type Platform,
  type Role,
  can,
  countBytes,
  countCharacters,
} from '@mrm/core';
import type { ApiError } from './api.ts';
import type { ChangeSetView, ProjectDetection, ProjectKind } from './types.ts';

// ---------------------------------------------------------------------------------------------
// Connecting a repository

/** The same rule the server applies to the owner and the repository name. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]+$/;

export type ParsedRepository = { ok: true; owner: string; repo: string } | { ok: false; message: string };

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
  if (!OWNER.test(owner)) return { ok: false, message: `“${owner}” is not a GitHub user or organization name.` };
  if (!REPO.test(repo) || repo === '.' || repo === '..') {
    return { ok: false, message: `“${repo}” is not a GitHub repository name.` };
  }
  return { ok: true, owner, repo };
}

export const githubUrl = (owner: string, repo: string) => `https://github.com/${owner}/${repo}`;

export const repositoryName = (repository: { owner: string; repo: string }) =>
  `${repository.owner}/${repository.repo}`;

export type ConnectProblem = {
  /** Where to show it: under a field, or above the buttons. */
  field: 'credential' | 'repository' | 'form';
  message: string;
  /** What to check, when the message alone does not say. */
  hint?: string;
};

/** Turns a refusal from the connect call into a message and what to check, near the right field. */
export function connectProblem(error: Pick<ApiError, 'status' | 'code' | 'message'>, target: { owner: string; repo: string }): ConnectProblem {
  const name = repositoryName(target);
  switch (error.code) {
    case 'credential_not_found':
      return { field: 'credential', message: 'That credential no longer exists. Pick another one.' };
    case 'credential_kind':
      return { field: 'credential', message: 'Only a GitHub App or a GitHub token can connect a repository.' };
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
export function projectKindBadge(kind: ProjectKind | null | undefined): { label: string; tone: Tone } {
  if (!kind) return { label: 'Not scanned', tone: 'neutral' };
  return { label: projectKindLabel[kind], tone: kind === 'unknown' ? 'warn' : 'accent' };
}

/** One sentence on what the detected type means for this tool. */
export function projectKindSummary(kind: ProjectKind): string {
  switch (kind) {
    case 'fastlane':
      return 'A fastlane project. Store listing text is read from the metadata folders and changes are proposed as a pull request.';
    case 'expo':
      return 'An Expo project. It is detected and shown here; editing Expo store.config.json is not supported yet.';
    case 'both':
      return 'Both fastlane and Expo files were found. Listing text is read from the fastlane metadata folders.';
    case 'unknown':
      return 'No fastlane or Expo files were found. Check that this is the right repository and that the credential can read all of it.';
  }
}

export const platformLabel = (platform: Platform) => (platform === 'ios' ? 'iOS' : 'Android');

export const storeLabel: Record<ListingStore, string> = {
  app_store: 'App Store',
  google_play: 'Google Play',
};

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
  draft: { label: 'Draft', tone: 'neutral', dot: false, description: 'Waiting for an admin or owner to approve it.' },
  approved: { label: 'Approved', tone: 'info', dot: false, description: 'Approved. It can be applied as a pull request.' },
  applying: { label: 'Applying', tone: 'accent', dot: true, description: 'Creating the branch and the pull request.' },
  applied: { label: 'Applied', tone: 'ok', dot: false, description: 'The pull request is open. Merge it in GitHub.' },
  failed: { label: 'Failed', tone: 'bad', dot: false, description: 'The change did not reach the repository.' },
  discarded: { label: 'Discarded', tone: 'neutral', dot: false, description: 'Closed without changing the repository.' },
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
  if (actor.type === 'user') return actor.id === myId ? 'You' : (names[actor.id] ?? 'A team member');
  if (actor.type === 'token') return 'An API token';
  if (actor.type === 'assistant') return 'The assistant';
  return 'The system';
}

/** The person who approved, from the user id the API stores. */
export function approverLabel(userId: string, myId: string, names: Readonly<Record<string, string>> = {}): string {
  return actorLabel({ type: 'user', id: userId }, myId, names);
}

export type ChangeSetActions = { approve: boolean; apply: boolean; discard: boolean };

/**
 * What this person may do to a change set right now. Mirrors the server: only an admin or owner
 * approves, applies, and discards anyone's; a member discards only their own draft.
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
    status === 'draft' && can(role, 'changesets.write') && createdBy.type === 'user' && createdBy.id === myId;
  return {
    approve: admin && status === 'draft',
    apply: admin && status === 'approved',
    discard: (admin && (status === 'draft' || status === 'approved' || status === 'failed')) || ownDraft,
  };
}

/** The text of the link to a change set's pull request. */
export const prLabel = (changeSet: Pick<ChangeSetView, 'prNumber'>) =>
  changeSet.prNumber === null ? 'Open the pull request' : `Open pull request #${changeSet.prNumber}`;

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
export function fieldUsage(spec: Pick<ListingFieldSpec, 'maxLength' | 'minLength' | 'unit'>, value: string): FieldUsage {
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
  const keys = Object.keys((store === 'app_store' ? listing.appStore?.locales : listing.googlePlay?.locales) ?? {});
  if (store === 'google_play') {
    for (const locale of Object.keys(listing.googlePlay?.changelogs ?? {})) {
      if (!keys.includes(locale)) keys.push(locale);
    }
  }
  return keys.sort((a, b) => (a === DEFAULT_LOCALE ? -1 : b === DEFAULT_LOCALE ? 1 : a.localeCompare(b)));
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
      : (listing.appStore?.locales[locale] as Record<string, string | undefined> | undefined)?.[field];
  }
  if (locale === undefined) return undefined;
  if (field.startsWith('changelog/')) return listing.googlePlay?.changelogs[locale]?.[field.slice('changelog/'.length)];
  return (listing.googlePlay?.locales[locale] as Record<string, string | undefined> | undefined)?.[field];
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
function entries(listing: Listing): Array<{ store: ListingStore; locale?: string; field: string; value: string }> {
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
    out.push({ store: e.store, ...(e.locale === undefined ? {} : { locale: e.locale }), field: e.field, before: was, after: e.value });
  }
  for (const [key, e] of before) {
    if (!after.has(key)) {
      out.push({ store: e.store, ...(e.locale === undefined ? {} : { locale: e.locale }), field: e.field, before: e.value, after: undefined });
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
    const keepCopyright = copyright !== undefined && !(copyright === '' && base.appStore?.copyright === undefined);
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
  const locales = [...new Set(edits.map((e) => e.locale).filter((l): l is string => l !== undefined))].sort();
  const fields = edits.length === 1 ? '1 listing field' : `${edits.length} listing fields`;
  if (locales.length === 0) return `Update ${fields}`;
  if (locales.length <= 3) return `Update ${fields} in ${locales.join(', ')}`;
  return `Update ${fields} in ${locales.length} locales`;
}

// ---------------------------------------------------------------------------------------------
// Diff

export type DiffRow = { kind: 'same' | 'add' | 'del'; text: string; oldNo?: number; newNo?: number };

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
    for (let k = Math.max(0, index - context); k <= Math.min(rows.length - 1, index + context); k++) keep[k] = true;
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
export function differsOnlyInLineEnds(before: string | undefined, after: string | undefined): boolean {
  if ((before ?? '') === (after ?? '')) return false;
  const { added, removed } = diffStats(diffLines(before, after));
  return added + removed === 0;
}

// ---------------------------------------------------------------------------------------------
// Scan results

/** The folders and files a scan found, with a readable name, omitting what it did not find. */
export function detectionPaths(detection: ProjectDetection): Array<{ label: string; values: string[] }> {
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
  return out;
}

/** "Confirmed" for a fact a file states, "Likely" for a reading that is only a guess. */
export const strengthLabel = (strength: 'definite' | 'inferred') => (strength === 'definite' ? 'Confirmed' : 'Likely');

/** "iOS and Android", "iOS (likely)", or "None found". */
export function platformsSummary(detection: Pick<ProjectDetection, 'platforms' | 'platformsInferred'>): string {
  const parts = [
    ...detection.platforms.map(platformLabel),
    ...detection.platformsInferred.map((p) => `${platformLabel(p)} (likely)`),
  ];
  if (parts.length === 0) return 'None found';
  return parts.length === 1 ? (parts[0] as string) : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
