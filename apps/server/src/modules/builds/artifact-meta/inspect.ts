import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readManifestAxml } from './axml.ts';
import { type PlistValue, parsePlist } from './plist.ts';
import { readManifestProto } from './proto-manifest.ts';
import {
  openZipBuffer,
  openZipFile,
  openZipSource,
  type ZipArchive,
  type ZipEntry,
} from './zip-file.ts';

/**
 * The real build number of a build file, read from inside it: the Android `versionCode` of an APK
 * or an AAB, the iOS `CFBundleVersion` of an IPA. A CI artifact is a zip that holds the build file
 * (an .apk, .aab or .ipa, possibly one of several), or is itself the app (an APK, an IPA, an
 * unpacked `Payload/` or `.app` folder, an `.xcarchive`). Nothing is installed, run or trusted:
 * only the manifest or `Info.plist` entry is read, with size caps, and the answer is null for
 * anything not recognised (it never throws).
 *
 * NOT TESTED AGAINST REAL APK, AAB OR IPA FILES: the tests build small files by hand from the
 * documented layouts. See `axml.ts`, `proto-manifest.ts` and `plist.ts` for what each one assumes.
 */

export type BuildFormat = 'apk' | 'aab' | 'ipa';

export type BuildMeta = {
  buildNumber: string;
  version: string | null;
  packageId: string | null;
  format: BuildFormat;
};

export type InspectOptions = {
  /**
   * Largest manifest or plist entry read (default 16 MB: a real one is a few KB to a few hundred
   * KB).
   */
  maxManifestBytes?: number;
  /**
   * A build file inside the archive is inflated to memory up to this size (default 64 MB). A stored
   * one is never copied.
   */
  maxMemoryBytes?: number;
  /**
   * Larger build files are inflated to a file in `tempDir` up to this size (default 512 MB). Needs
   * `tempDir`.
   */
  maxFileBytes?: number;
  /**
   * A folder the caller owns, for the inflated build file of a big artifact. The file is deleted
   * before this returns.
   */
  tempDir?: string;
};

const MB = 1024 * 1024;
/** Build files tried in one artifact (an artifact with a hundred .apk files is not a build). */
const MAX_CANDIDATES = 6;

const APK_MANIFEST = 'AndroidManifest.xml';
const AAB_MANIFEST = 'base/manifest/AndroidManifest.xml';
const IPA_PLIST = [
  /^Payload\/[^/]+\.app\/Info\.plist$/,
  /(^|\/)Products\/Applications\/[^/]+\.app\/Info\.plist$/,
  /^[^/]+\.app\/Info\.plist$/,
];

const text = (value: PlistValue | undefined): string | null => {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
};

const clean = (value: string | null): string | null => {
  const v = value?.trim() ?? '';
  return v === '' ? null : v.slice(0, 200);
};

/** What the archive itself is: an APK, an AAB or an app folder. Null when it is none of them. */
async function readAsBuild(zip: ZipArchive, maxBytes: number): Promise<BuildMeta | null> {
  const apk = zip.find((n) => n === APK_MANIFEST);
  if (apk) {
    const info = readManifestAxml(await zip.read(apk, maxBytes));
    const buildNumber = clean(info?.versionCode ?? null);
    if (info && buildNumber)
      return {
        buildNumber,
        version: clean(info.versionName),
        packageId: clean(info.packageName),
        format: 'apk',
      };
  }
  const aab = zip.find((n) => n === AAB_MANIFEST);
  if (aab) {
    const info = readManifestProto(await zip.read(aab, maxBytes));
    const buildNumber = clean(info?.versionCode ?? null);
    if (info && buildNumber)
      return {
        buildNumber,
        version: clean(info.versionName),
        packageId: clean(info.packageName),
        format: 'aab',
      };
  }
  for (const pattern of IPA_PLIST) {
    const plist = zip.find((n) => pattern.test(n));
    if (!plist) continue;
    const root = parsePlist(await zip.read(plist, maxBytes));
    if (root === null || typeof root !== 'object' || Array.isArray(root) || Buffer.isBuffer(root))
      continue;
    if (root instanceof Date) continue;
    const dict = root as { [key: string]: PlistValue };
    const buildNumber = clean(text(dict.CFBundleVersion));
    if (buildNumber)
      return {
        buildNumber,
        version: clean(text(dict.CFBundleShortVersionString)),
        packageId: clean(text(dict.CFBundleIdentifier)),
        format: 'ipa',
      };
  }
  return null;
}

const isBuildFile = (name: string) => /\.(apk|aab|ipa)$/i.test(name);

/**
 * Reads the build number of an artifact: `source` is the artifact zip as a Buffer or the path of a
 * file. Returns null for anything that is not recognised, too large, damaged or hostile. A file
 * path is read by position (the artifact is never loaded whole).
 */
export async function inspectBuildArtifact(
  source: Uint8Array | string,
  options: InspectOptions = {},
): Promise<BuildMeta | null> {
  const maxManifest = options.maxManifestBytes ?? 16 * MB;
  const maxMemory = options.maxMemoryBytes ?? 64 * MB;
  const maxFile = options.maxFileBytes ?? 512 * MB;
  const cleanups: (() => Promise<void>)[] = [];
  try {
    const outer =
      typeof source === 'string' ? await openZipFile(source) : await openZipBuffer(source);
    cleanups.push(() => outer.close());
    // The zip may itself be the app (an artifact that uploaded an unpacked IPA or an APK renamed
    // .zip).
    const direct = await readAsBuild(outer, maxManifest).catch(() => null);
    if (direct) return direct;
    const candidates = outer.entries.filter((e) => isBuildFile(e.name)).slice(0, MAX_CANDIDATES);
    for (const entry of candidates) {
      const limits = { maxMemory, maxFile, tempDir: options.tempDir };
      const inner = await openInner(outer, entry, limits, cleanups);
      if (!inner) continue;
      const found = await readAsBuild(inner, maxManifest).catch(() => null);
      if (found) return found;
    }
    return null;
  } catch {
    return null;
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
  }
}

/**
 * The build file inside the artifact as an archive of its own, or null when it cannot be opened
 * within the caps.
 */
async function openInner(
  outer: ZipArchive,
  entry: ZipEntry,
  limits: { maxMemory: number; maxFile: number; tempDir: string | undefined },
  cleanups: (() => Promise<void>)[],
): Promise<ZipArchive | null> {
  try {
    // Stored: a window on the outer archive, whatever its size, with no copy.
    const window = await outer.window(entry, Number.MAX_SAFE_INTEGER);
    if (window) {
      const inner = await openZipSource(window);
      cleanups.push(() => inner.close());
      return inner;
    }
    if (entry.size <= limits.maxMemory) {
      const inner = await openZipBuffer(await outer.read(entry, limits.maxMemory));
      cleanups.push(() => inner.close());
      return inner;
    }
    if (!limits.tempDir || entry.size > limits.maxFile) return null;
    const path = join(limits.tempDir, `kiln-inspect-${randomUUID()}.tmp`);
    cleanups.push(() => rm(path, { force: true }));
    await outer.extractToFile(entry, path, limits.maxFile);
    const inner = await openZipFile(path);
    cleanups.push(() => inner.close());
    return inner;
  } catch {
    return null;
  }
}
