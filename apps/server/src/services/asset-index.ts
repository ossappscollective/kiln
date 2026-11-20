import type { BlobHeadItem, BlobReads } from '@mrm/connectors';
import { ASSET_RULES, type AssetFacts, type AssetKind, type AssetProblem, type AssetSet, type AssetStore, assetStoreOf, classifyAppleScreenshot, deviceFitsPlatform, deviceLabel, type ImageFormat, IMESSAGE_PREFIX, type Platform, readImageHeader, sniffImageFormat, SPEC_SOURCES, summarizeAssets, supports, validateAssets } from '@mrm/core';
import {
  type AssetCandidate,
  appHints,
  type DiscoveryFolders,
  discoverProjectIcons,
  discoverStoreAssets,
  expoIconPaths,
  orderWithinSets } from './store-assets.ts';

/**
 * The index of the media of one app's listing target in its repository: which files there are, and
 * for each its size, format and problems against the store specs (core/store-asset-specs.ts).
 *
 * Reading is bounded and nothing is decoded:
 * - only the first `HEAD_BYTES` of an image are looked at (a JPEG whose header is longer is read
 *   once more with `JPEG_RETRY_BYTES`), by the header parsers of core/image-header.ts;
 * - a file over `MAX_READ_FILE_BYTES` is listed and never read;
 * - at most `budget.maxFiles` images are opened and `budget.maxTransferBytes` are pulled from a
 *   remote (a GitHub clone or the API); what is left is listed with `read: 'not_read'` and the index
 *   says it is partial;
 * - app previews (video) are never opened, only listed with their size when the source knows it.
 */

export const HEAD_BYTES = 64 * 1024;
export const JPEG_RETRY_BYTES = 1024 * 1024;
/** Larger files are listed but never read. */
export const MAX_READ_FILE_BYTES = 25 * 1024 * 1024;
/** More media files than this in a target are not listed. */
export const MAX_LISTED_ASSETS = 2000;
const JPEG_RETRY_MAX_FILES = 24;

export type AssetBudget = {
  /** Images opened per index. */
  maxFiles: number;
  /** Bytes pulled over the network per index. */
  maxTransferBytes: number;
};

/** A local clone reads from disk: generous. A GitHub clone or the REST API are slow and are limited. */
export const BUDGETS = {
  local_clone: { maxFiles: 2000, maxTransferBytes: 4 * 1024 * 1024 * 1024 },
  github_clone: { maxFiles: 150, maxTransferBytes: 48 * 1024 * 1024 },
  github_api: { maxFiles: 60, maxTransferBytes: 24 * 1024 * 1024 } } as const satisfies Record<string, AssetBudget>;

export type AssetSourceKind = keyof typeof BUDGETS;

export const SOURCE_LABELS: Record<AssetSourceKind, string> = {
  local_clone: 'Local clone (fast)',
  github_clone: 'Clone of the GitHub repository',
  github_api: 'GitHub (slower)' };

export type IndexedAsset = AssetFacts & {
  /** The git blob id of the file, the identity of its bytes. Null when the file was not found. */
  oid: string | null;
  origin: 'store' | 'project';
};

export type IndexPartial = { partial: boolean; reasons: string[]; skipped: number };

export type IndexResult = {
  assets: IndexedAsset[];
  problems: AssetProblem[];
  sets: AssetSet[];
  folders: DiscoveryFolders;
  notes: string[];
  partial: IndexPartial;
  /** Bytes pulled over the network. */
  transferredBytes: number;
};

export type IndexInput = {
  app: { platform: Platform; name: string; identifier: string };
  files: readonly string[];
  /** Reads a text file at the commit (`app.json`). */
  readText: (path: string) => Promise<string | undefined>;
  blobs: BlobReads | undefined;
  commit: string;
  roots: { appStore: string; googlePlay: string };
  budget: AssetBudget;
  /** Only these kinds (the icon lookup reads `icon` and `app_icon` and nothing else). */
  kinds?: readonly AssetKind[];
  signal?: AbortSignal;
};

const storeOf = (platform: Platform): AssetStore => assetStoreOf(platform);

/**
 * Whether an indexed file belongs to the app record of this platform. A macOS record keeps the Mac display
 * (`APP_DESKTOP`) screenshots and previews and every non screenshot kind (the icon); an iOS record drops the Mac ones,
 * which cannot be pushed to an iOS version. Google Play keeps everything.
 */
export function fileFitsPlatform(
  platform: Platform,
  f: { kind: AssetKind; device: string | null },
): boolean {
  if (!supports(platform, 'screenshotsByDevice') || (f.kind !== 'screenshot' && f.kind !== 'preview')) return true;
  if (f.device === null) return platform === 'ios';
  return deviceFitsPlatform(platform, f.device);
}

const bySignal = (signal: AbortSignal | undefined) => (signal ? { signal } : {});

/** The facts of one image from what was read of it. */
function factsOf(
  c: AssetCandidate,
  item: BlobHeadItem | undefined,
  retried = false,
): Omit<AssetFacts, 'order'> & { oid: string | null; needsMore: boolean } {
  const base = {
    path: c.path,
    store: c.store,
    locale: c.locale,
    kind: c.kind,
    device: c.device,
    extension: c.extension,
    bytes: null as number | null,
    width: null as number | null,
    height: null as number | null,
    format: null as AssetFacts['format'],
    hasAlpha: null as boolean | null,
    read: 'not_read' as AssetFacts['read'],
    oid: null as string | null,
    needsMore: false };
  if (!item) return base;
  base.oid = item.oid;
  if (!item.ok) {
    if (item.size !== null) base.bytes = item.size;
    base.read =
      item.reason === 'too_large'
        ? 'too_large'
        : item.reason === 'missing'
          ? 'unreadable'
          : 'not_read';
    return base;
  }
  base.bytes = item.size;
  const header = readImageHeader(item.head);
  if (header.ok) {
    return {
      ...base,
      width: header.width,
      height: header.height,
      format: header.format,
      hasAlpha: header.hasAlpha,
      read: 'read' };
  }
  // A JPEG whose first frame header is further in than we looked: ask for more once.
  const sniffed = sniffImageFormat(item.head);
  if (
    header.reason === 'truncated' &&
    sniffed === 'jpeg' &&
    item.size > item.head.length &&
    !retried
  ) {
    return { ...base, needsMore: true, read: 'unreadable' };
  }
  return { ...base, format: sniffed, read: 'unreadable' };
}

export async function indexAssets(input: IndexInput): Promise<IndexResult> {
  const { app, blobs, budget } = input;
  const store = storeOf(app.platform);
  const wanted = (kind: AssetKind) => input.kinds === undefined || input.kinds.includes(kind);
  const notes: string[] = [];
  const reasons: string[] = [];

  const discovery = discoverStoreAssets(input.files, input.roots, store);
  notes.push(...discovery.notes);
  let candidates = discovery.candidates.filter((c) => wanted(c.kind));

  // The icon of the project: Expo `icon`, an Xcode icon set, an Android launcher icon.
  if (wanted('app_icon')) {
    let appJson: string | undefined;
    if (input.files.includes('app.json'))
      appJson = await input.readText('app.json').catch(() => undefined);
    const project = discoverProjectIcons(input.files, {
      platform: app.platform,
      store,
      expoPaths: expoIconPaths(appJson, app.platform),
      hints: appHints(app.identifier, app.name) });
    notes.push(...project.notes);
    candidates = [...candidates, ...project.candidates];
  }
  if (candidates.length > MAX_LISTED_ASSETS) {
    notes.push(
      `The target has ${candidates.length} media files; the first ${MAX_LISTED_ASSETS} are listed.`,
    );
    candidates = candidates.slice(0, MAX_LISTED_ASSETS);
  }

  const images = candidates.filter((c) => c.kind !== 'preview');
  const previews = candidates.filter((c) => c.kind === 'preview');
  const toRead = images.slice(0, budget.maxFiles);
  const skipped = images.length - toRead.length;
  if (skipped > 0)
    reasons.push(
      `Only the first ${budget.maxFiles} images were opened; ${skipped} more are listed without their size.`,
    );

  const items = new Map<string, BlobHeadItem>();
  let transferred = 0;
  if (blobs && toRead.length > 0) {
    const read = await blobs.readBlobHeads(
      toRead.map((c) => c.path),
      {
        ref: input.commit,
        headBytes: HEAD_BYTES,
        maxFileBytes: MAX_READ_FILE_BYTES,
        maxTransferBytes: budget.maxTransferBytes,
        ...bySignal(input.signal) },
    );
    for (const [path, item] of read.items) items.set(path, item);
    transferred += read.transferredBytes;
  } else if (!blobs && toRead.length > 0) {
    notes.push(
      'This repository connection cannot read binary files, so the files are listed without their size.',
    );
  }

  let facts = toRead.map((c) => factsOf(c, items.get(c.path)));
  const retry = facts.filter((f) => f.needsMore).slice(0, JPEG_RETRY_MAX_FILES);
  if (blobs && retry.length > 0) {
    const remaining = Math.max(0, budget.maxTransferBytes - transferred);
    const read = await blobs.readBlobHeads(
      retry.map((f) => f.path),
      {
        ref: input.commit,
        headBytes: JPEG_RETRY_BYTES,
        maxFileBytes: MAX_READ_FILE_BYTES,
        maxTransferBytes: remaining,
        ...bySignal(input.signal) },
    );
    transferred += read.transferredBytes;
    const second = new Map(
      retry.map((f) => [
        f.path,
        factsOf(
          toRead.find((c) => c.path === f.path) as AssetCandidate,
          read.items.get(f.path),
          true,
        ),
      ]),
    );
    facts = facts.map((f) => second.get(f.path) ?? f);
  }
  if ([...items.values()].some((i) => !i.ok && i.reason === 'budget')) {
    reasons.push(
      `The transfer budget of ${Math.round(budget.maxTransferBytes / (1024 * 1024))} MB was used up; the remaining images are listed without their size.`,
    );
  }

  // Previews are never opened: their size, when the source has it for free.
  const previewFacts: typeof facts = [];
  if (previews.length > 0) {
    const read = blobs
      ? await blobs.readBlobHeads(
          previews.map((c) => c.path),
          {
            ref: input.commit,
            headBytes: 0,
            maxFileBytes: Number.MAX_SAFE_INTEGER,
            maxTransferBytes: 0,
            ...bySignal(input.signal) },
        )
      : undefined;
    for (const c of previews) {
      const item = read?.items.get(c.path);
      previewFacts.push({
        ...factsOf(c, undefined),
        oid: item?.oid ?? null,
        bytes: item?.ok ? item.size : null,
        format: 'video',
        read: 'not_read' });
    }
  }

  // The device of an App Store screenshot comes from its pixel size, as fastlane deliver does it.
  const classified = [...facts, ...previewFacts].map((f) => {
    const c = candidates.find((x) => x.path === f.path) as AssetCandidate;
    let device = f.device;
    if (store === 'app_store' && f.kind === 'screenshot' && f.width !== null && f.height !== null) {
      const id = classifyAppleScreenshot(f.width, f.height, f.path);
      device = id === null ? null : c.imessage ? `${IMESSAGE_PREFIX}${id}` : id;
    }
    return { ...f, device, origin: c.origin };
  });
  const order = orderWithinSets(classified);
  let assets: IndexedAsset[] = classified
    .filter((f) => fileFitsPlatform(app.platform, f))
    .map(({ needsMore: _needsMore, ...f }) => ({ ...f, order: order.get(f.path) ?? 1 }))
    .sort(
      (a, b) =>
        a.locale.localeCompare(b.locale) ||
        a.kind.localeCompare(b.kind) ||
        (a.device ?? '').localeCompare(b.device ?? '') ||
        a.order - b.order,
    );

  // Candidates that were over the file limit: listed, never opened.
  const opened = new Set(toRead.map((c) => c.path));
  for (const c of images) {
    if (opened.has(c.path)) continue;
    const { needsMore: _needsMore, ...unopened } = factsOf(c, undefined);
    assets.push({ ...unopened, order: 0, origin: c.origin });
  }
  assets = assets.filter((a) => fileFitsPlatform(app.platform, a));
  const rest = orderWithinSets(assets);
  for (const a of assets) a.order = rest.get(a.path) ?? a.order;

  const facts2 = assets.map((a) => a as AssetFacts);
  const problems = validateAssets(store, validatedFacts(facts2));
  return {
    assets,
    problems,
    sets: summarizeAssets(store, facts2),
    folders: discovery.folders,
    notes,
    partial: { partial: reasons.length > 0, reasons, skipped },
    transferredBytes: transferred };
}

/**
 * The facts that are held against the specs. An Xcode `AppIcon.appiconset` holds many icon sizes
 * (20 to 1024 px) and only the one the App Store shows (1024 x 1024) has a size rule: holding every
 * slot to it would report an error for each. So of the project icons of one folder only the 1024 px
 * one is checked, or, when there is none, the largest. Every other file is checked as before.
 */
export function validatedFacts(facts: readonly AssetFacts[]): AssetFacts[] {
  const icons = facts.filter((f) => f.kind === 'app_icon' && f.store === 'app_store');
  if (icons.length < 2) return facts.slice();
  const area = (f: AssetFacts) => (f.width ?? 0) * (f.height ?? 0);
  const full = icons.filter((f) => f.width === 1024 && f.height === 1024);
  const keep = new Set(
    full.length > 0 ? full : [icons.slice().sort((a, b) => area(b) - area(a))[0] as AssetFacts],
  );
  return facts.filter((f) => !icons.includes(f) || keep.has(f));
}

// ---------------------------------------------------------------------------------------------
// The answer of the API

export type AssetView = {
  path: string;
  locale: string;
  kind: AssetKind;
  device: string | null;
  deviceLabel: string;
  order: number;
  bytes: number | null;
  width: number | null;
  height: number | null;
  format: ImageFormat | 'video' | null;
  hasAlpha: boolean | null;
  /** The git blob id: the identity of the bytes, and the ETag of the file route. */
  oid: string | null;
  read: AssetFacts['read'];
  origin: 'store' | 'project';
};

export type AssetIndexView = {
  appId: string;
  platform: Platform;
  store: AssetStore;
  repository: { id: string; name: string } | null;
  /** `no_repository`: nothing is linked. `ok`: the repository was read (it may hold no media). */
  status: 'ok' | 'no_repository';
  source: { kind: AssetSourceKind; label: string; fast: boolean } | null;
  /** The commit that was read. Send it back as `commit` to the file route. */
  commit: string | null;
  readAt: number | null;
  /** The listing target that was used. `roots` are the folders of the locale folders. */
  target: {
    id: string | null;
    label: string;
    roots: { appStore: string | null; googlePlay: string | null };
  } | null;
  folders: DiscoveryFolders;
  limits: {
    maxFiles: number;
    maxTransferBytes: number;
    headBytes: number;
    maxFileBytes: number;
    maxServedBytes: number;
  };
  partial: IndexPartial;
  totals: {
    assets: number;
    read: number;
    bytes: number;
    errors: number;
    warnings: number;
    infos: number;
    locales: number;
  };
  locales: string[];
  devices: { id: string; label: string }[];
  sets: AssetSet[];
  assets: AssetView[];
  problems: AssetProblem[];
  notes: string[];
  specs: {
    /** What the checks are: the documented specs, never a store. */
    basis: string;
    sources: Record<string, string>;
    unverified: { id: string; text: string }[];
  };
  /**
   * The store's own counts per locale, kind and device, from the last store read that is still cached
   * (`GET .../assets/store`), or null. The index itself never reads a store, so it is null in the cached index and is added
   * by the route (docs/api/assets.md).
   */
  storeSide: {
    observedAt: number;
    counts: { locale: string; kind: AssetKind; device: string | null; count: number }[];
  } | null;
};

export const SPECS_BASIS =
  'The checks hold the files against the sizes and counts the stores document. Nothing was sent to or read from a store, and a store may still refuse an upload.';

export function specsView(): AssetIndexView['specs'] {
  return {
    basis: SPECS_BASIS,
    sources: { ...SPEC_SOURCES },
    unverified: Object.values(ASSET_RULES)
      .filter((r) => !r.verified)
      .map((r) => ({ id: r.id, text: r.text })) };
}

export function viewOfAsset(a: IndexedAsset): AssetView {
  return {
    path: a.path,
    locale: a.locale,
    kind: a.kind,
    device: a.device,
    deviceLabel: deviceLabel(a.store, a.device),
    order: a.order,
    bytes: a.bytes,
    width: a.width,
    height: a.height,
    format: a.format,
    hasAlpha: a.hasAlpha,
    oid: a.oid,
    read: a.read,
    origin: a.origin };
}

export function totalsOf(result: IndexResult): AssetIndexView['totals'] {
  const count = (s: AssetProblem['severity']) =>
    result.problems.filter((p) => p.severity === s).length;
  return {
    assets: result.assets.length,
    read: result.assets.filter((a) => a.read === 'read').length,
    bytes: result.assets.reduce((sum, a) => sum + (a.bytes ?? 0), 0),
    errors: count('error'),
    warnings: count('warning'),
    infos: count('info'),
    locales: new Set(result.assets.filter((a) => a.origin === 'store').map((a) => a.locale)).size };
}
