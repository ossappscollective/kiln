import type { Platform } from '@mrm/core';
import { listingLocales } from './fastlane.ts';

/**
 * Works out what kind of mobile project a repository is, from its file list and a few small
 * files. Pure: the caller supplies the paths and a reader, so it runs on a GitHub tree or a clone.
 *
 * Rules:
 * - `kind`, `platforms` and `locales` come only from evidence a file states outright.
 * - Anything that is a likely reading but not a statement is `inferred`. It is listed in
 *   `evidence` and `platformsInferred`, and never changes `kind`.
 * - Code is never run. A dynamic Expo config (`app.config.js`) is reported as unreadable
 *   instead of being guessed.
 */

export type ProjectKind = 'fastlane' | 'expo' | 'both' | 'unknown';

export type Evidence = {
  fact: string;
  path: string;
  /** `definite`: the file says so. `inferred`: a reasonable reading, but a guess. */
  strength: 'definite' | 'inferred';
  platform?: Platform;
};

export type StoreConfigFile = {
  path: string;
  /** The eas.json submit profile that points to it, when it is not the default location. */
  profile?: string;
  /** A script (`store.config.js`): its locales cannot be known without running it. */
  dynamic: boolean;
};

export type ExpoDetails = {
  /** `app.json`, or the first dynamic `app.config.*`. */
  configPath?: string;
  /** The config is code, so name, platforms and identifiers could not be read. */
  dynamicConfig: boolean;
  name?: string;
  slug?: string;
  version?: string;
  iosBundleIdentifier?: string;
  androidPackage?: string;
  buildProfiles: string[];
  submitProfiles: string[];
  storeConfigs: StoreConfigFile[];
};

export type DetectedPaths = {
  fastlaneDirs: string[];
  fastfiles: string[];
  /** The folder that holds App Store locale folders, when there are listing files. */
  iosMetadata?: string;
  androidMetadata?: string;
  /** `<fastlane>/screenshots`, when it holds files. */
  iosScreenshots?: string;
  /** The Play metadata folder, when locales hold an `images` folder. */
  androidImages?: string;
  appJson?: string;
  appConfig?: string;
  easJson?: string;
  packageJson?: string;
};

export type ProjectDetection = {
  kind: ProjectKind;
  /** Platforms a file states outright. */
  platforms: Platform[];
  /** Platforms that are only a likely reading. Never includes one that is in `platforms`. */
  platformsInferred: Platform[];
  /** Locale folders and store config entries found, sorted. `default` is not a locale. */
  locales: { ios: string[]; android: string[] };
  paths: DetectedPaths;
  expo?: ExpoDetails;
  evidence: Evidence[];
  warnings: string[];
};

export type ReadFile = (path: string) => Promise<string | undefined>;

const IGNORED = /(^|\/)(node_modules|Pods|vendor|\.git|build|DerivedData)\//;
const APP_CONFIG = /^app\.config\.(js|ts|mjs|cjs|mts|cts)$/;
const NATIVE_IOS = /^ios\/(Podfile|[^/]+\.xcodeproj\/project\.pbxproj)$/;
const NATIVE_ANDROID = /^android\/(build\.gradle(\.kts)?|app\/build\.gradle(\.kts)?)$/;

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

const addUnique = <T>(list: T[], value: T) => {
  if (!list.includes(value)) list.push(value);
};

/** Ruby source with whole-line comments removed, so `# upload_to_app_store` is not evidence. */
const withoutComments = (source: string) =>
  source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

export async function detectProject(files: string[], read: ReadFile): Promise<ProjectDetection> {
  const paths = files.filter((p) => !IGNORED.test(p));
  const have = new Set(paths);
  const evidence: Evidence[] = [];
  const warnings: string[] = [];
  const platforms: Platform[] = [];
  const inferred: Platform[] = [];
  const detected: DetectedPaths = { fastlaneDirs: [], fastfiles: [] };
  const note = (e: Evidence) => {
    evidence.push(e);
    if (e.platform) addUnique(e.strength === 'definite' ? platforms : inferred, e.platform);
  };

  // ---- fastlane ---------------------------------------------------------------------------
  let fastlane = false;
  const fastlaneDirs = new Set<string>();
  for (const path of paths) {
    const m = /^((?:[^/]+\/){0,2})fastlane\//.exec(path);
    if (m) fastlaneDirs.add(`${m[1] ?? ''}fastlane`);
  }
  for (const dir of [...fastlaneDirs].sort()) {
    const fastfile = `${dir}/Fastfile`;
    const appfile = `${dir}/Appfile`;
    if (have.has(fastfile)) {
      fastlane = true;
      detected.fastfiles.push(fastfile);
      evidence.push({ fact: 'Fastfile', path: fastfile, strength: 'definite' });
    }
    if (have.has(appfile)) {
      fastlane = true;
      evidence.push({ fact: 'Appfile', path: appfile, strength: 'definite' });
    }
    if (
      have.has(fastfile) ||
      have.has(appfile) ||
      paths.some((p) => p.startsWith(`${dir}/metadata/`))
    ) {
      detected.fastlaneDirs.push(dir);
    }
  }
  if (have.has('Fastfile')) {
    fastlane = true;
    detected.fastfiles.push('Fastfile');
    evidence.push({
      fact: 'Fastfile at the repository root',
      path: 'Fastfile',
      strength: 'definite',
    });
  }

  const listing = listingLocales(paths);
  const underFastlane = (root: string) => /(^|\/)fastlane\/metadata(\/|$)/.test(root);
  const iosFiles = listing.ios.length > 0 || listing.hasDefaultFolder;
  if (iosFiles) {
    detected.iosMetadata = listing.roots.appStore;
    const sample =
      paths.find((p) => p.startsWith(`${listing.roots.appStore}/`)) ?? listing.roots.appStore;
    if (underFastlane(listing.roots.appStore)) {
      fastlane = true;
      note({
        fact: 'deliver metadata folder',
        path: listing.roots.appStore,
        strength: 'definite',
        platform: 'ios',
      });
    } else {
      note({
        fact: 'App Store metadata files outside a fastlane folder',
        path: sample,
        strength: 'inferred',
        platform: 'ios',
      });
    }
  }
  if (listing.android.length > 0) {
    detected.androidMetadata = listing.roots.googlePlay;
    if (underFastlane(listing.roots.googlePlay)) {
      fastlane = true;
      note({
        fact: 'supply metadata folder',
        path: listing.roots.googlePlay,
        strength: 'definite',
        platform: 'android',
      });
    } else {
      note({
        fact: 'Google Play metadata files outside a fastlane folder',
        path: listing.roots.googlePlay,
        strength: 'inferred',
        platform: 'android',
      });
    }
    const images = `${listing.roots.googlePlay}/`;
    if (
      paths.some((p) => p.startsWith(images) && /^[^/]+\/images\//.test(p.slice(images.length)))
    ) {
      detected.androidImages = listing.roots.googlePlay;
    }
  }
  const shots = detected.fastlaneDirs
    .map((d) => `${d}/screenshots`)
    .find((d) => paths.some((p) => p.startsWith(`${d}/`)));
  if (shots) detected.iosScreenshots = shots;

  for (const fastfile of detected.fastfiles.slice(0, 5)) {
    const source = await read(fastfile);
    if (source === undefined) continue;
    const code = withoutComments(source);
    const hint = (re: RegExp, fact: string, platform: Platform) => {
      if (re.test(code)) note({ fact, path: fastfile, strength: 'inferred', platform });
    };
    hint(/^\s*platform\s+:ios\b/m, 'Fastfile declares an ios platform', 'ios');
    hint(/^\s*platform\s+:android\b/m, 'Fastfile declares an android platform', 'android');
    hint(/\b(upload_to_app_store|deliver)\b/, 'Fastfile uploads to the App Store', 'ios');
    hint(/\b(upload_to_play_store|supply)\b/, 'Fastfile uploads to Google Play', 'android');
  }
  for (const dir of detected.fastlaneDirs) {
    const appfile = `${dir}/Appfile`;
    if (!have.has(appfile)) continue;
    const code = withoutComments((await read(appfile)) ?? '');
    if (/^\s*(app_identifier|apple_id)\b/m.test(code)) {
      note({
        fact: 'Appfile names an iOS app',
        path: appfile,
        strength: 'inferred',
        platform: 'ios',
      });
    }
    if (/^\s*(package_name|json_key_file)\b/m.test(code)) {
      note({
        fact: 'Appfile names an Android app',
        path: appfile,
        strength: 'inferred',
        platform: 'android',
      });
    }
  }
  if (have.has('Gemfile')) {
    if (/\bfastlane\b/.test(withoutComments((await read('Gemfile')) ?? ''))) {
      evidence.push({ fact: 'Gemfile lists fastlane', path: 'Gemfile', strength: 'inferred' });
    }
  }

  // ---- Expo / EAS -------------------------------------------------------------------------
  let expo = false;
  const expoDetails: ExpoDetails = {
    dynamicConfig: false,
    buildProfiles: [],
    submitProfiles: [],
    storeConfigs: [],
  };
  const storeLocales: string[] = [];

  const pkg = have.has('package.json') ? parseJson(await read('package.json')) : undefined;
  if (have.has('package.json')) detected.packageJson = 'package.json';
  if (have.has('package.json') && pkg === undefined)
    warnings.push('package.json is not valid JSON.');
  if (isObject(pkg)) {
    const deps = { ...(isObject(pkg.dependencies) ? pkg.dependencies : {}) };
    const dev = isObject(pkg.devDependencies) ? pkg.devDependencies : {};
    if ('expo' in deps || 'expo' in dev) {
      expo = true;
      evidence.push({
        fact: 'package.json depends on expo',
        path: 'package.json',
        strength: 'definite',
      });
    }
  }

  if (have.has('app.json')) {
    detected.appJson = 'app.json';
    expoDetails.configPath = 'app.json';
    const parsed = parseJson(await read('app.json'));
    if (parsed === undefined) {
      warnings.push('app.json is not valid JSON, so the Expo config was not read.');
    } else if (isObject(parsed)) {
      const wrapped = isObject(parsed.expo);
      const cfg = wrapped ? (parsed.expo as Record<string, unknown>) : parsed;
      if (wrapped) {
        expo = true;
        evidence.push({ fact: 'app.json has an expo key', path: 'app.json', strength: 'definite' });
      } else if (str(cfg.slug)) {
        evidence.push({
          fact: 'app.json has a slug but no expo key (Expo allows this, bare React Native does not use slug)',
          path: 'app.json',
          strength: 'inferred',
        });
      }
      if (wrapped || str(cfg.slug)) {
        expoDetails.name = str(cfg.name);
        expoDetails.slug = str(cfg.slug);
        expoDetails.version = str(cfg.version);
        const ios = isObject(cfg.ios) ? cfg.ios : undefined;
        const android = isObject(cfg.android) ? cfg.android : undefined;
        expoDetails.iosBundleIdentifier = str(ios?.bundleIdentifier);
        expoDetails.androidPackage = str(android?.package);
        const declared = Array.isArray(cfg.platforms) ? cfg.platforms : undefined;
        const says = (p: Platform) =>
          declared?.includes(p) === true ||
          (declared === undefined && (p === 'ios' ? ios : android) !== undefined);
        for (const p of ['ios', 'android'] as const) {
          if (wrapped && says(p)) {
            note({
              fact: declared ? `app.json lists ${p} in platforms` : `app.json has an ${p} section`,
              path: 'app.json',
              strength: 'definite',
              platform: p,
            });
          }
        }
        if (wrapped && !declared && !ios && !android) {
          warnings.push('app.json does not say which platforms the app targets.');
        }
      }
    }
  }

  const appConfigs = paths.filter((p) => APP_CONFIG.test(p)).sort();
  if (appConfigs.length > 0) {
    expo = true;
    detected.appConfig = appConfigs[0];
    expoDetails.dynamicConfig = true;
    expoDetails.configPath ??= appConfigs[0];
    for (const path of appConfigs) {
      evidence.push({ fact: 'dynamic Expo config', path, strength: 'definite' });
    }
    warnings.push(
      `${appConfigs[0]} is code and was not run: name, platforms and identifiers are unknown.` +
        (have.has('app.json') ? ' Values read from app.json may be overridden by it.' : ''),
    );
  }

  const profile = (v: unknown, into: string[]) => {
    if (isObject(v)) for (const name of Object.keys(v)) addUnique(into, name);
  };
  const storeConfigPaths: StoreConfigFile[] = [];
  if (have.has('eas.json')) {
    detected.easJson = 'eas.json';
    const eas = parseJson(await read('eas.json'));
    if (!isObject(eas)) {
      warnings.push('eas.json is not valid JSON, so EAS profiles were not read.');
    } else {
      evidence.push({ fact: 'eas.json', path: 'eas.json', strength: 'definite' });
      profile(eas.build, expoDetails.buildProfiles);
      profile(eas.submit, expoDetails.submitProfiles);
      if (isObject(eas.submit)) {
        for (const [name, entry] of Object.entries(eas.submit)) {
          const target =
            isObject(entry) && isObject(entry.ios) ? str(entry.ios.metadataPath) : undefined;
          if (target) {
            storeConfigPaths.push({
              path: target.replace(/^\.\//, ''),
              profile: name,
              dynamic: !/\.json$/i.test(target),
            });
          }
        }
      }
    }
    if (!expo) {
      warnings.push(
        'eas.json is present but nothing else says this is an Expo project (no expo dependency, no app config). Not treated as Expo.',
      );
    }
  }
  if (have.has('store.config.json')) {
    storeConfigPaths.unshift({ path: 'store.config.json', dynamic: false });
  }
  for (const entry of storeConfigPaths) {
    if (expoDetails.storeConfigs.some((c) => c.path === entry.path)) continue;
    if (!have.has(entry.path)) {
      warnings.push(
        `eas.json points to ${entry.path} (submit profile ${entry.profile}), which is not in the repository.`,
      );
      continue;
    }
    expoDetails.storeConfigs.push(entry);
    if (entry.dynamic) {
      warnings.push(`${entry.path} is code and was not run: its locales are unknown.`);
      continue;
    }
    const parsed = parseJson(await read(entry.path));
    const apple = isObject(parsed) && isObject(parsed.apple) ? parsed.apple : undefined;
    if (!apple) {
      warnings.push(`${entry.path} has no apple section, or is not valid JSON.`);
      continue;
    }
    if (isObject(parsed) && parsed.configVersion !== 0) {
      warnings.push(
        `${entry.path} has configVersion ${String(parsed.configVersion)}; only 0 is documented.`,
      );
    }
    note({
      fact: 'EAS Metadata store config',
      path: entry.path,
      strength: 'definite',
      platform: 'ios',
    });
    if (isObject(apple.info))
      for (const locale of Object.keys(apple.info)) addUnique(storeLocales, locale);
  }

  // Native projects that exist in the repository (a prebuilt or bare Expo app).
  const nativeIos = paths.find((p) => NATIVE_IOS.test(p));
  const nativeAndroid = paths.find((p) => NATIVE_ANDROID.test(p));
  if (nativeIos)
    note({ fact: 'native iOS project', path: nativeIos, strength: 'inferred', platform: 'ios' });
  if (nativeAndroid) {
    note({
      fact: 'native Android project',
      path: nativeAndroid,
      strength: 'inferred',
      platform: 'android',
    });
  }

  // Expo files in subfolders: reported, not inspected.
  const nested = paths.filter(
    (p) => /\/(app\.json|eas\.json|app\.config\.[a-z]+)$/.test(p) && !/^(ios|android)\//.test(p),
  );
  if (nested.length > 0) {
    warnings.push(
      `Expo-style config in subfolders was not inspected (only the repository root is): ${nested.slice(0, 5).join(', ')}.`,
    );
  }

  // ---- result -----------------------------------------------------------------------------
  if (!fastlane && (iosFiles || listing.android.length > 0)) {
    warnings.push(
      'Store metadata files exist but no fastlane folder or Fastfile does, so this is not treated as a fastlane project.',
    );
  }
  if (fastlane && !iosFiles && listing.android.length === 0) {
    warnings.push(
      'fastlane is set up but no metadata folder was found: the store listing is not in Git yet.',
    );
  }
  if (expo && expoDetails.storeConfigs.length === 0 && !fastlane) {
    warnings.push(
      'No EAS Metadata store config was found: the App Store listing is not in Git yet.',
    );
  }
  if (expo && !fastlane && platforms.includes('android')) {
    warnings.push(
      'EAS Metadata does not manage Google Play listings, so there is no listing file for Android.',
    );
  }

  const kind: ProjectKind =
    fastlane && expo ? 'both' : fastlane ? 'fastlane' : expo ? 'expo' : 'unknown';
  const iosLocales = new Set([...listing.ios, ...storeLocales]);
  return {
    kind,
    platforms: platforms.sort(),
    platformsInferred: inferred.filter((p) => !platforms.includes(p)).sort(),
    locales: { ios: [...iosLocales].sort(), android: listing.android },
    paths: detected,
    ...(expo ? { expo: expoDetails } : {}),
    evidence,
    warnings,
  };
}
