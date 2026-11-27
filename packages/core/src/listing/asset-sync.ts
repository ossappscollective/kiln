import { PLATFORMS, type Platform, supports } from '../platform.ts';
import {
  APPLE_DISPLAY_TYPES,
  type AssetSlot,
  assetStoreOf,
  slotKey,
} from './staged-changes.ts';
import {
  APPLE_DISPLAYS,
  type AssetKind,
  type AssetProblem,
  type AssetStore,
  deviceLabel,
  PLAY_DEVICES,
  validateAssets,
} from './store-asset-specs.ts';

/**
 * Two way sync of store images (docs/adr/0012-assets-two-way-sync.md, docs/api/assets.md): the shapes the
 * server and the web app share, and the pure logic of comparing the repository's files with the store's
 * and of what can be fixed in a file. Nothing here talks to a store, a repository or a database.
 *
 * ES2017 only: the web app imports this file.
 *
 * PLATFORM KEY. Every image the store holds is addressed by a platform generic key
 * (`platform / locale / slotKey / position`). The platforms are `ios`, `macos` and `android`; macOS is a
 * third App Store platform that Apple files under the same App Store Connect app, with its own version and
 * its own display (`mac`, `APP_DESKTOP`) in `APPLE_DISPLAYS`. A platform decides the store, which slot is
 * writable (see `assetStoreOf` and `assetSlotSupport` in staged-changes.ts) and which Apple version the
 * connector reads.
 */

export const ASSET_PLATFORMS = PLATFORMS;
export type AssetPlatform = Platform;

export const assetPlatformOf = (platform: Platform): AssetPlatform => platform;

/** `ios/en-US/screenshot:iphone_6_9`: the key of one set of one platform. */
export const storeSetKey = (platform: AssetPlatform, locale: string, slot: AssetSlot): string =>
  `${platform}/${locale}/${slotKey(slot)}`;
/** The key of one image: the set and its place (1-based) in it. */
export const storeImageKey = (
  platform: AssetPlatform,
  locale: string,
  slot: AssetSlot,
  position: number,
): string => `${storeSetKey(platform, locale, slot)}#${position}`;

// ---------------------------------------------------------------------------------------------
// Limits of the sync (the server's own; the stores state none for the pull)

export const ASSET_SYNC_LIMITS = {
  /** One image downloaded from a store CDN. */
  maxDownloadBytes: 12 * 1024 * 1024,
  /** All images of one pull. */
  maxPullBytes: 48 * 1024 * 1024,
  maxPullFiles: 120,
  /** One uploaded file (the same cap as a push). */
  maxUploadBytes: 8 * 1024 * 1024,
  /** All uploaded files kept for an app at once. */
  maxStagedUploadBytes: 64 * 1024 * 1024,
  maxStagedUploadFiles: 100,
  /** Seconds one answer of the store listing is reused. */
  storeCacheSeconds: 60,
} as const;

/** Formats that may be uploaded (what a push writes). */
export const UPLOAD_FORMATS: readonly string[] = ['png', 'jpeg'];

// ---------------------------------------------------------------------------------------------
// The store side

/** One image of a set as the store holds it. `ref` is opaque: the server finds the address from it, the client never holds one. */
export type StoreImageFile = {
  ref: string;
  /** 1-based, the store's display order. */
  position: number;
  name: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  /**
   * Where the pixel size comes from: the store's own answer, or the header of the ORIGINAL file that this server read because the
   * store gave none (Google Play). Null: unknown. A size from the header is never the cause of an error (see `checkStoreImages`).
   */
  sizeFrom?: 'store' | 'header' | null;
  /** Lower case hex of the file, when the store (or this server's own mark) supplies it. */
  checksum: string | null;
  checksumKind: 'sha256' | 'md5' | null;
  state: string | null;
  /** A thumbnail or the file can be fetched (the store gave an address on its CDN). */
  downloadable: boolean;
};

export type StoreImageSet = {
  platform: AssetPlatform;
  locale: string;
  kind: AssetKind;
  device: string | null;
  deviceLabel: string;
  /** The store's own name of the set (an Apple placement group, a Play image type). */
  target: string;
  files: StoreImageFile[];
};

export type StoreImagesView = {
  appId: string;
  platform: AssetPlatform;
  store: AssetStore;
  /** App Store: the version that was read. Google Play: null. */
  version: { id: string; versionString: string | null; state: string; editable: boolean } | null;
  readAt: number;
  sets: StoreImageSet[];
  /** Images the server could not place in a slot it knows (an unknown display size). Counted, never hidden. */
  unplaced: number;
  notes: string[];
};

/**
 * The ONE of several store sets of a display that Kiln compares with the repository and pushes to. The App Store keeps a display such as
 * iPad 13" / 12.9" in more than one placement group (`APP_IPAD_PRO_3GEN_129`, the legacy `APP_IPAD_PRO_129`), each with its own limit of 10
 * images; a push writes `APPLE_DISPLAY_TYPES[device]`. Every consumer that needs ONE set of a display (the comparison
 * of the release step, the counts next to the repository's) takes it from here, so none of them keeps the last of the siblings by accident.
 * With no set of the pushed group the one holding the most images stands in. Pure.
 */
export function primaryStoreSet<T extends { device: string | null; target: string; files: readonly unknown[] }>(
  sets: readonly T[],
): T | undefined {
  const first = sets[0];
  if (first === undefined || sets.length === 1) return first;
  const device = first.device;
  const pushed =
    device === null
      ? undefined
      : device === 'iphone_6_9'
        ? ['APP_IPHONE_67', 'APP_IPHONE_69']
        : [APPLE_DISPLAY_TYPES[device]];
  const own = sets.filter((s) => pushed !== undefined && pushed.indexOf(s.target) >= 0);
  const pool = own.length > 0 ? own : sets;
  return pool.reduce((best, s) => (s.files.length > best.files.length ? s : best));
}

/**
 * The store's own images judged against the documented specs, with no repository involved (the store-side checks of the graphics: pixel
 * size, byte size, count per set, wrong format). A fact the store did not give (`null` size) is never an error. Pure; the answer is
 * the same list `validateAssets` gives for repository files, with `path` = `locale/kind/device#position` so a message can name its image.
 */
export function checkStoreImages(view: Pick<StoreImagesView, 'platform' | 'sets'>): AssetProblem[] {
  const store = assetStoreOf(view.platform);
  const facts = [];
  const measured = new Set<string>();
  for (const set of view.sets) {
    for (const f of set.files) {
      const ext = (f.name ?? '').split('.').pop()?.toLowerCase() ?? '';
      const path = `${set.locale}/${set.kind}/${set.device ?? 'all'}#${f.position}`;
      if (f.sizeFrom === 'header') measured.add(path);
      facts.push({
        path,
        store,
        locale: set.locale,
        kind: set.kind,
        device: set.device,
        // The store's own group (the one rule of the count: per set, never summed across sibling display types; see `assetFactsOf`).
        set: store === 'app_store' ? set.target : null,
        order: f.position,
        bytes: f.bytes,
        width: f.width,
        height: f.height,
        format: null,
        extension: ext === 'jpg' ? 'jpeg' : ext,
        hasAlpha: null,
        read: f.width !== null && f.height !== null ? ('read' as const) : ('not_read' as const),
      });
    }
  }
  const found = validateAssets(store, facts);
  if (measured.size === 0) return found;
  // A size this server measured itself (the store gave none) is a reading, not a fact of the store: whatever it finds is a note,
  // never an error or a warning, so a wrong reading cannot block anything or frighten anyone.
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return found
    .map((p) =>
      p.path !== undefined && measured.has(p.path) && p.severity !== 'info'
        ? {
            ...p,
            severity: 'info' as const,
            message: `${p.message} (The size was read from the file header, as the store gives none, so this is a note.)`,
          }
        : p,
    )
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ---------------------------------------------------------------------------------------------
// The comparison

export type RepoSideFile = {
  path: string;
  oid: string | null;
  /** SHA-256 of the bytes, when the server read the file for this comparison. */
  sha256: string | null;
  /** MD5 of the bytes (App Store Connect's `sourceFileChecksum` is an MD5), when the server read the file. */
  md5?: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
};

/**
 * - `identical`: the checksums match.
 * - `likely_same`: same pixel size and, where both sides give one, the same byte size, but no checksum to prove it (the App
 *   Store has none: see docs/api/assets.md).
 * - `differs`: another checksum, size or pixel size.
 * - `only_repo` / `only_store`: nothing at that position on the other side.
 */
export type AssetCompareStatus =
  | 'identical'
  | 'likely_same'
  | 'differs'
  | 'only_repo'
  | 'only_store';

export const COMPARE_LABELS: Readonly<Record<AssetCompareStatus, string>> = {
  identical: 'Identical',
  likely_same: 'Probably the same',
  differs: 'Differs',
  only_repo: 'Only in the repository',
  only_store: 'Only in the store',
};

export type AssetCompareRow = {
  position: number;
  status: AssetCompareStatus;
  repo: RepoSideFile | null;
  store: StoreImageFile | null;
  /** Why it differs, in words, or ''. */
  reason: string;
};

const sameChecksum = (a: string, b: string): boolean => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x.length === y.length) return x === y;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return short.length >= 16 && long.startsWith(short);
};

/** Compares one pair. Pure. */
export function compareFile(
  repo: RepoSideFile | null,
  store: StoreImageFile | null,
): { status: AssetCompareStatus; reason: string } {
  if (repo !== null && store === null) return { status: 'only_repo', reason: '' };
  if (repo === null && store !== null) return { status: 'only_store', reason: '' };
  if (repo === null || store === null) return { status: 'differs', reason: 'Nothing to compare.' };
  const mine = store.checksumKind === 'md5' ? (repo.md5 ?? null) : repo.sha256;
  if (store.checksum !== null && mine !== null) {
    return sameChecksum(store.checksum, mine)
      ? { status: 'identical', reason: '' }
      : { status: 'differs', reason: 'The checksums differ.' };
  }
  if (
    repo.width !== null &&
    repo.height !== null &&
    store.width !== null &&
    store.height !== null &&
    (repo.width !== store.width || repo.height !== store.height)
  ) {
    return {
      status: 'differs',
      reason: `The size differs: ${repo.width} x ${repo.height} in the repository, ${store.width} x ${store.height} in the store.`,
    };
  }
  if (repo.bytes !== null && store.bytes !== null && repo.bytes !== store.bytes) {
    return { status: 'differs', reason: 'The file sizes differ.' };
  }
  const known = repo.width !== null && store.width !== null;
  return known
    ? {
        status: 'likely_same',
        reason: 'The store gives no checksum, so the files are only compared by size.',
      }
    : { status: 'likely_same', reason: 'Too little is known about one side to say more.' };
}

/** Pairs the files of a set by position and compares each pair. A set with files on one side only is all `only_*`. */
export function compareSet(
  repo: readonly RepoSideFile[],
  store: readonly StoreImageFile[],
): AssetCompareRow[] {
  const rows: AssetCompareRow[] = [];
  const n = Math.max(repo.length, store.length);
  for (let i = 0; i < n; i++) {
    const r = repo[i] ?? null;
    const s = store[i] ?? null;
    const c = compareFile(r, s);
    rows.push({ position: i + 1, status: c.status, repo: r, store: s, reason: c.reason });
  }
  return rows;
}

export type AssetCompareTotals = Record<AssetCompareStatus, number>;

export function compareTotals(rows: readonly { status: AssetCompareStatus }[]): AssetCompareTotals {
  const out: AssetCompareTotals = {
    identical: 0,
    likely_same: 0,
    differs: 0,
    only_repo: 0,
    only_store: 0,
  };
  for (const r of rows) out[r.status] += 1;
  return out;
}

/** One line for a set: "3 identical, 1 differs". Empty when there is nothing. */
export function compareText(totals: AssetCompareTotals): string {
  const parts: string[] = [];
  if (totals.identical > 0) parts.push(`${totals.identical} identical`);
  if (totals.likely_same > 0) parts.push(`${totals.likely_same} probably the same`);
  if (totals.differs > 0)
    parts.push(`${totals.differs} ${totals.differs === 1 ? 'differs' : 'differ'}`);
  if (totals.only_repo > 0) parts.push(`${totals.only_repo} only in the repository`);
  if (totals.only_store > 0) parts.push(`${totals.only_store} only in the store`);
  return parts.join(', ');
}

/** The comparison of the sets of an app, as the server answers it. */
export type AssetDiffSet = {
  platform: AssetPlatform;
  locale: string;
  kind: AssetKind;
  device: string | null;
  deviceLabel: string;
  target: string | null;
  rows: AssetCompareRow[];
  totals: AssetCompareTotals;
  /** The whole set is the same on both sides. */
  inSync: boolean;
};

export type AssetDiffView = {
  appId: string;
  platform: AssetPlatform;
  readAt: number;
  commit: string | null;
  version: StoreImagesView['version'];
  /** `no_repository`: the app has no linked repository, so there is nothing local to compare (every store image is `only_store`). */
  repoStatus: 'ok' | 'no_repository';
  sets: AssetDiffSet[];
  totals: AssetCompareTotals;
  unplaced: number;
  notes: string[];
};

// ---------------------------------------------------------------------------------------------
// What can be fixed in a file

/** The rules that complain about an alpha channel (Google's `*.format` rules say it in their message). */
export const ALPHA_RULES: readonly string[] = [
  'apple.screenshot.alpha',
  'apple.icon.alpha',
  'play.feature_graphic.format',
  'play.tv_banner.format',
  'play.screenshot.format',
];

export const REQUIRED_SIZE_RULES = [
  'apple.screenshot.size',
  'play.icon.size',
  'play.feature_graphic.size',
  'play.tv_banner.size',
] as const;

export type Size = { width: number; height: number };

/** The exact pixel sizes a store takes for a slot, or [] when it states ranges only. */
export function requiredSizes(platform: Platform, slot: AssetSlot): Size[] {
  if (supports(platform, 'screenshotsByDevice')) {
    if (slot.kind !== 'screenshot' || slot.device === null) return [];
    const base = slot.device.startsWith('imessage:')
      ? slot.device.slice('imessage:'.length)
      : slot.device;
    const display = APPLE_DISPLAYS.find((d) => d.id === base);
    return display ? display.sizes.map(([width, height]) => ({ width, height })) : [];
  }
  if (slot.kind === 'icon') return [{ width: 512, height: 512 }];
  if (slot.kind === 'feature_graphic') return [{ width: 1024, height: 500 }];
  if (slot.kind === 'tv_banner') return [{ width: 1280, height: 720 }];
  return [];
}

export const sizeText = (s: Size): string => `${s.width} x ${s.height}`;

/** "1320 x 2868, 2064 x 2752 or ...": the exact sizes of a slot in words. Portrait first, no duplicates. */
export function requiredSizesText(platform: Platform, slot: AssetSlot): string {
  const sizes = requiredSizes(platform, slot);
  if (sizes.length === 0) {
    if (!supports(platform, 'screenshotsByDevice') && slot.kind === 'screenshot')
      return 'Google Play takes 320 to 3840 px on each side, the longer side at most twice the shorter';
    return 'The store states no exact size for this graphic';
  }
  return sizes.map(sizeText).join(', ');
}

/** The size to resize to: the required one with the closest aspect ratio, in the file's own orientation. */
export function nearestRequiredSize(
  platform: Platform,
  slot: AssetSlot,
  width: number,
  height: number,
): Size | null {
  const sizes = requiredSizes(platform, slot);
  if (sizes.length === 0 || width < 1 || height < 1) return null;
  const portrait = height >= width;
  let best: Size | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const s of sizes) {
    if (s.width !== s.height && s.height >= s.width !== portrait) continue;
    const score = Math.abs(Math.log(s.width / s.height / (width / height)));
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

export type FixKind = 'remove_alpha' | 'rename_extension' | 'resize';
export const FIX_KINDS: readonly FixKind[] = ['remove_alpha', 'rename_extension', 'resize'];
export const isFixKind = (v: unknown): v is FixKind =>
  typeof v === 'string' && (FIX_KINDS as readonly string[]).indexOf(v) !== -1;

export type FixOption = {
  kind: FixKind;
  label: string;
  /** The file this fix produces is a PNG, whatever it was. */
  detail: string;
};

export type FixAdvice = {
  options: FixOption[];
  /** Problems that cannot be fixed here, each with what to do, never empty text. */
  manual: string[];
};

export type FixFacts = {
  format: string | null;
  width: number | null;
  height: number | null;
  hasAlpha: boolean | null;
  extension: string;
  kind: AssetKind;
  device: string | null;
};

const EXTENSION_FOR: Readonly<Record<string, string>> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
  gif: 'gif',
};
export const extensionForFormat = (format: string): string | undefined => EXTENSION_FOR[format];

/**
 * Which fixes apply to a file given the rule codes of its problems (`AssetProblem.rule`, or the staged problem codes),
 * and what has to be done by hand. The fix itself is made by the server (a PNG codec in pure TypeScript); only 8 bit,
 * non interlaced PNG files can be changed: the server says so when a file is something else.
 */
export function fixAdvice(
  platform: Platform,
  facts: FixFacts,
  rules: readonly string[],
): FixAdvice {
  const options: FixOption[] = [];
  const manual: string[] = [];
  const slot: AssetSlot = { kind: facts.kind, device: facts.device };
  const has = (rule: string) => rules.indexOf(rule) !== -1;
  const alphaRule = rules.some((r) => ALPHA_RULES.indexOf(r) !== -1);
  if (alphaRule && facts.hasAlpha === true) {
    if (facts.format === 'png') {
      options.push({
        kind: 'remove_alpha',
        label: 'Remove the alpha channel',
        detail:
          'Flattens the transparency onto a background colour (white by default) and writes a PNG without alpha.',
      });
    } else {
      manual.push(
        `The alpha channel can only be removed from a PNG, and this is ${facts.format ? facts.format.toUpperCase() : 'not a PNG'}. Export it again without transparency.`,
      );
    }
  }
  if (has('inspect.extension') && facts.format !== null) {
    const right = extensionForFormat(facts.format);
    if (right !== undefined && right !== facts.extension) {
      options.push({
        kind: 'rename_extension',
        label: `Rename to .${right}`,
        detail: `The content is ${facts.format.toUpperCase()}; the name says .${facts.extension}. The bytes do not change.`,
      });
    }
  }
  const sizeRule =
    REQUIRED_SIZE_RULES.some((r) => has(r)) ||
    (supports(platform, 'screenshotsByDevice') &&
      facts.kind === 'screenshot' &&
      facts.device === null);
  if (sizeRule) {
    const need = requiredSizesText(platform, slot);
    if (
      facts.format === 'png' &&
      facts.width !== null &&
      facts.height !== null &&
      nearestRequiredSize(platform, slot, facts.width, facts.height) !== null
    ) {
      options.push({
        kind: 'resize',
        label: 'Resize to the required size',
        detail: `Scales to the nearest required size (${need}). Only PNG files are resized; a different aspect ratio is cropped to fill.`,
      });
    } else {
      manual.push(
        `The size is wrong${facts.width !== null && facts.height !== null ? ` (${facts.width} x ${facts.height})` : ''}. Required: ${need}.${facts.format === 'png' ? '' : ' Only PNG files can be resized here.'}`,
      );
    }
  }
  if (
    supports(platform, 'screenshotsByDevice') &&
    facts.format !== null &&
    facts.format !== 'png' &&
    facts.format !== 'jpeg'
  ) {
    manual.push(
      `${facts.format.toUpperCase()} is not accepted by the App Store. Export a PNG or JPEG.`,
    );
  }
  return { options, manual };
}

/** The label of a set, for a message: "Screenshots, iPhone 6.9"". */
export function setTitleOf(platform: Platform, kindLabel: string, device: string | null): string {
  return device === null
    ? kindLabel
    : `${kindLabel}, ${deviceLabel(assetStoreOf(platform), device)}`;
}

export const playDeviceOfTarget = (target: string): string | null => {
  for (const d of PLAY_DEVICES) if (d.dir === target) return d.id;
  return null;
};
