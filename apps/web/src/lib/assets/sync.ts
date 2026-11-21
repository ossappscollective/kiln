import {
  ASSET_SYNC_LIMITS,
  type AssetCompareStatus,
  type AssetDiffSet,
  type AssetDiffView,
  type AssetKind,
  type AssetPlatform,
  can,
  type FixAdvice,
  type FixKind,
  type Platform,
  type Role,
  type StagedAssetView,
  type StagedChangesView,
  slotKey,
  storeSetKey,
  UPLOAD_FORMATS,
} from '@kiln/core';
import { ApiError } from '../api.ts';
import type { IconName } from '../icons.ts';
import type { AssetItem, ChangeSetView } from '../types.ts';
import { formatBytes } from './assets.ts';

/**
 * Two way sync of the graphics, the web side (docs/api/assets.md, docs/api/staged-changes.md,
 * docs/adr/0012-assets-two-way-sync.md): the shapes of the API that the web app owns, the URLs of the store
 * thumbnails and of the staged uploads, and the pure logic of the pull dialog, the comparison and the upload
 * dialog. The server decides every rule; the checks here only explain things before a request.
 * Written for the ES2017 web build: no flatMap, no fromEntries.
 */

// ---------------------------------------------------------------------------------------------
// API shapes

export type PullSelection = { sets?: string[]; files?: string[]; prune?: boolean };

export type PullSkip = {
  key: string;
  reason:
    | 'checksum_mismatch'
    | 'budget'
    | 'format'
    | 'download_failed'
    | 'no_address'
    | 'repo_unreadable'
    | 'layout'
    | 'gap'
    | 'timeout';
  message: string;
};

export type PullReport = {
  changeSet: ChangeSetView | null;
  written: number;
  deleted: number;
  unchanged: number;
  bytes: number;
  skipped: PullSkip[];
  unverified: string[];
  left: string[];
  notes: string[];
};

export type ToRepoResult = {
  changeSet: ChangeSetView | null;
  written: number;
  deleted: number;
  unchanged: number;
  skipped: string[];
  notes: string[];
};

export type FileProblem = { rule: string; severity: 'error' | 'warning' | 'info'; message: string };

/** What a file is and what is wrong with it for a set (POST .../assets/inspect and the `spec_errors` answer). */
export type InspectedFile = {
  format: 'png' | 'jpeg';
  name: string;
  width: number;
  height: number;
  hasAlpha: boolean | null;
  bytes: number;
  problems: FileProblem[];
  advice: FixAdvice;
};

/** The set a file belongs to, plus what to do with it. */
export type UploadQuery = {
  locale: string;
  kind: string;
  device: string | null;
  mode?: 'add' | 'replace';
  /** 1-based. */
  position?: number;
  name?: string;
  fix?: FixKind;
  /** A colour such as `#ffffff`. */
  background?: string;
};

// ---------------------------------------------------------------------------------------------
// URLs (the browser loads the pictures itself; the server finds the address from an opaque ref)

const appBase = (workspaceId: string, appId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(appId)}`;

export type ThumbSize = 160 | 320 | 640;

/** A thumbnail of an image the store holds, through the server's proxy (an allow list of the stores' CDN hosts). */
export const storeThumbUrl = (
  workspaceId: string,
  appId: string,
  ref: string,
  size: ThumbSize = 320,
): string =>
  `${appBase(workspaceId, appId)}/assets/store/thumb?ref=${encodeURIComponent(ref)}&size=${size}`;

/** The bytes of an uploaded or fixed file of a staged set. */
export const stagedBlobUrl = (workspaceId: string, appId: string, oid: string): string =>
  `${appBase(workspaceId, appId)}/staged/assets/blob?oid=${encodeURIComponent(oid)}`;

// ---------------------------------------------------------------------------------------------
// Ids of sets

/** `en-US/screenshot:iphone_6_9`: the id of a staged set, and of a set to put in the repository. */
export const setIdOf = (locale: string, kind: AssetKind, device: string | null): string =>
  `${locale}/${slotKey({ kind, device })}`;

/** `ios/en-US/screenshot:iphone_6_9`: the key of a set of the store, for a pull. */
export const storeKeyOf = (
  platform: Platform,
  locale: string,
  kind: AssetKind,
  device: string | null,
): string => storeSetKey(platform as AssetPlatform, locale, { kind, device });

/** One action of the menu of a file. A disabled one says why in `reason`. */
export type MenuItem = {
  id: string;
  label: string;
  icon?: IconName;
  disabled?: boolean;
  reason?: string;
  danger?: boolean;
};

// ---------------------------------------------------------------------------------------------
// Who may, and why not

export const SYNC_ROLE_REASON =
  'Changing the graphics needs the right to change change sets (developer and up).';

export function canChangeAssets(role: Role): boolean {
  return can(role, 'changesets.write');
}

// ---------------------------------------------------------------------------------------------
// Files chosen or dropped in the browser

export const UPLOAD_ACCEPT = 'image/png,image/jpeg,.png,.jpg,.jpeg';

const EXTENSION = /\.(png|jpe?g)$/i;

export type PickedFile = { name: string; size: number; type?: string };

/**
 * A sentence for a file that cannot be uploaded, or '' when it can be tried. The server looks at the bytes (not the name
 * or the declared type) and decides; this only spares a request for a file that is clearly wrong.
 */
export function checkPickedFile(file: PickedFile): string {
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > ASSET_SYNC_LIMITS.maxUploadBytes)
    return `${file.name} is ${formatBytes(file.size)}. A file can be at most ${formatBytes(ASSET_SYNC_LIMITS.maxUploadBytes)}.`;
  const typed = file.type === undefined || file.type === '' ? null : file.type.toLowerCase();
  if (
    !EXTENSION.test(file.name) &&
    !(typed !== null && (typed === 'image/png' || typed === 'image/jpeg'))
  ) {
    return `${file.name} is not a PNG or JPEG. The stores take ${UPLOAD_FORMATS.map((f) => f.toUpperCase()).join(' and ')}.`;
  }
  return '';
}

/** The files of a drop or a file picker, in order, without the ones that are not images at all. */
export function imageFilesOf(list: ArrayLike<File> | null | undefined): File[] {
  const out: File[] = [];
  if (!list) return out;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (f) out.push(f);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The comparison

export type StatusTone = 'ok' | 'info' | 'warn' | 'accent' | 'neutral';

export const compareTone = (status: AssetCompareStatus): StatusTone => {
  switch (status) {
    case 'identical':
      return 'ok';
    case 'likely_same':
      return 'info';
    case 'differs':
      return 'warn';
    case 'only_repo':
    case 'only_store':
      return 'accent';
  }
};

/** The first characters of a checksum, for a table cell; the whole value is in the title. */
export const shortChecksum = (sum: string | null): string =>
  sum === null ? 'none' : sum.length > 12 ? `${sum.slice(0, 12)}...` : sum;

export const sizeLine = (
  width: number | null,
  height: number | null,
  bytes: number | null,
): string => {
  const parts: string[] = [];
  if (width !== null && height !== null) parts.push(`${width} x ${height}`);
  if (bytes !== null) parts.push(formatBytes(bytes));
  return parts.length > 0 ? parts.join(', ') : 'unknown size';
};

/** The comparison of one set, found by its id. */
export function diffSetOf(
  diff: AssetDiffView | null,
  locale: string,
  kind: AssetKind,
  device: string | null,
): AssetDiffSet | null {
  if (!diff) return null;
  for (const s of diff.sets)
    if (s.locale === locale && s.kind === kind && s.device === device) return s;
  return null;
}

/** What differs in a set, in a few words for a badge: '' when the set is the same on both sides or not compared. */
export function diffBadge(set: AssetDiffSet | null): { tone: StatusTone; text: string } | null {
  if (!set) return null;
  if (set.inSync) return { tone: 'ok', text: 'Same as the store' };
  const t = set.totals;
  const n = t.differs + t.only_repo + t.only_store;
  if (n === 0) return { tone: 'info', text: 'Probably the same as the store' };
  return { tone: 'warn', text: `${n} ${n === 1 ? 'file differs' : 'files differ'} from the store` };
}

/** The image keys (`ios/en-US/screenshot:iphone_6_9#2`) of the rows that exist in the store and are not identical. */
export function pullableKeys(set: AssetDiffSet, platform: Platform): string[] {
  const out: string[] = [];
  for (const r of set.rows) {
    if (r.store === null || r.status === 'identical') continue;
    out.push(`${storeKeyOf(platform, set.locale, set.kind, set.device)}#${r.position}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Words for the results

export type Summary = { tone: 'ok' | 'warn' | 'info'; headline: string; details: string[] };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function summarizePull(report: PullReport): Summary {
  const details: string[] = [];
  if (report.unverified.length > 0) {
    details.push(
      `${plural(report.unverified.length, 'file was', 'files were')} taken without a checksum from the store to check it against (App Store Connect gives none). Look at them in the change set.`,
    );
  }
  if (report.skipped.length > 0)
    details.push(`${plural(report.skipped.length, 'image was', 'images were')} left out.`);
  if (report.left.length > 0)
    details.push(
      `${plural(report.left.length, 'file of the repository is', 'files of the repository are')} not in the store and ${report.left.length === 1 ? 'was' : 'were'} left alone.`,
    );
  for (const n of report.notes) details.push(n);
  if (report.changeSet === null) {
    return {
      tone: report.skipped.length > 0 ? 'warn' : 'info',
      headline:
        report.unchanged > 0 ? 'The repository already has these images.' : 'Nothing was pulled.',
      details,
    };
  }
  const headline = `Made a draft change set: ${plural(report.written, 'file', 'files')} written${report.deleted > 0 ? `, ${plural(report.deleted, 'file', 'files')} deleted` : ''}${report.unchanged > 0 ? `, ${report.unchanged} already the same` : ''}.`;
  return {
    tone: report.skipped.length > 0 || report.unverified.length > 0 ? 'warn' : 'ok',
    headline,
    details,
  };
}

export function summarizeToRepo(result: ToRepoResult): Summary {
  const details = result.skipped.slice();
  for (const n of result.notes) details.push(n);
  if (result.changeSet === null)
    return { tone: 'info', headline: 'The repository already has these files.', details };
  return {
    tone: result.skipped.length > 0 ? 'warn' : 'ok',
    headline: `Made a draft change set: ${plural(result.written, 'file', 'files')} written${result.deleted > 0 ? `, ${plural(result.deleted, 'file', 'files')} deleted` : ''}${result.unchanged > 0 ? `, ${result.unchanged} already the same` : ''}.`,
    details,
  };
}

/** Why a file of a pull was left out, in words. */
export const skipText = (s: PullSkip): string => s.message;

// ---------------------------------------------------------------------------------------------
// The upload dialog

/** The problems and the fixes of a refused upload (`422 spec_errors`), or null for any other error. */
export function specErrorsOf(
  error: unknown,
): { problems: FileProblem[]; advice: FixAdvice } | null {
  if (!(error instanceof ApiError) || error.code !== 'spec_errors') return null;
  const problems = Array.isArray(error.body.problems) ? (error.body.problems as FileProblem[]) : [];
  const fix = error.body.fix as FixAdvice | undefined;
  return {
    problems,
    advice:
      fix && Array.isArray(fix.options)
        ? { options: fix.options, manual: Array.isArray(fix.manual) ? fix.manual : [] }
        : { options: [], manual: [] },
  };
}

export const FIX_NEEDS_BACKGROUND: readonly FixKind[] = ['remove_alpha'];
export const DEFAULT_BACKGROUND = '#ffffff';
const HEX = /^#[0-9a-f]{6}$/i;
export const isHexColour = (v: string): boolean => HEX.test(v);

/** The fixes that make a new file, one sentence each, for a button. */
export const fixLabel = (kind: FixKind): string =>
  kind === 'remove_alpha'
    ? 'Remove the alpha channel'
    : kind === 'resize'
      ? 'Resize to the required size'
      : 'Fix the file extension';

export type StagedFileRow = {
  position: number;
  name: string;
  oid: string;
  upload: boolean;
  path: string;
  commit: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
  format: string | null;
  hasAlpha: boolean | null;
};

/** The staged set of a slot, or null. */
export function stagedSetOf(
  view: StagedChangesView | null,
  locale: string,
  kind: AssetKind,
  device: string | null,
): StagedAssetView | null {
  if (!view) return null;
  const id = setIdOf(locale, kind, device);
  for (const a of view.assets) if (a.id === id) return a;
  return null;
}

export function stagedFileRows(set: StagedAssetView | null): StagedFileRow[] {
  if (!set) return [];
  return set.files.map((f) => ({
    position: f.position,
    name: f.path.split('/').pop() ?? f.path,
    oid: f.oid,
    upload: f.upload === true,
    path: f.path,
    commit: f.commit,
    width: f.width,
    height: f.height,
    bytes: f.bytes,
    format: f.format,
    hasAlpha: f.hasAlpha,
  }));
}

/** Why removing the last file of a set is not offered, or ''. A push cannot empty a store's set. */
export const EMPTY_SET_REASON =
  'A push cannot empty a set in the store, so the last file of a set cannot be removed here. Delete the set in the store console.';

/** The set the editor shows: its place, a title, and the repository's files of it (shown until a change is staged). */
export type EditorSet = {
  locale: string;
  kind: AssetKind;
  device: string | null;
  title: string;
  files: AssetItem[];
  commit: string | null;
};
