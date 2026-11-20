import type { ReadFile } from '../detect.ts';

/**
 * `eas.json` (and the fields of the Expo app config it relates to) as a typed model. Pure: nothing here touches a network or a disk,
 * and nothing runs code (a dynamic `app.config.js` is never read, only reported). It needs no Expo credential.
 *
 * What was checked against Expo's pages is in docs/api/eas-config.md ("Verified" and "Not verified"); a field that could not be
 * checked is not modelled. The rules of this file:
 * - Tolerant. Unknown keys are kept as names (`unknownKeys`) and never fail the read; a wrong type is a finding and the value is
 *   left out; one bad profile never hides the others. Comments and trailing commas are accepted (and reported), because people
 *   write them even though they are not JSON.
 * - Values of `env` are never part of the model, of a finding or of an error message: only the names. Nor is any value of an
 *   unknown key. A path (`serviceAccountKeyPath`, `ascApiKeyPath`) is kept as written, a reference such as `$FILE` is not expanded.
 * - `extends` is resolved: each profile carries the values it ends up with, and a cycle, a missing profile or a chain that is too
 *   deep is a finding instead of an exception.
 */

export type EasSeverity = 'error' | 'warning' | 'info';
export type EasFindingScope = 'file' | 'cli' | 'build' | 'submit' | 'app';

export type EasFindingCode =
  | 'eas_json_invalid'
  | 'eas_json_not_object'
  | 'eas_json_too_large'
  | 'eas_json_lenient'
  | 'section_invalid'
  | 'profile_invalid'
  | 'invalid_value'
  | 'unknown_keys'
  | 'too_many_profiles'
  | 'extends_missing'
  | 'extends_cycle'
  | 'extends_too_deep'
  | 'extends_invalid'
  | 'distribution_unknown'
  | 'app_version_source_unknown'
  | 'app_version_source_missing'
  | 'app_version_source_remote'
  | 'auto_increment_without_source'
  | 'channel_ignored_dev_client'
  | 'channel_without_updates'
  | 'updates_without_channel'
  | 'updates_without_runtime_version'
  | 'updates_url_project_mismatch'
  | 'updates_disabled_with_channel'
  | 'runtime_version_invalid'
  | 'runtime_policy_unknown'
  | 'runtime_policy_needs_version'
  | 'runtime_policy_native_version'
  | 'release_channel_deprecated'
  | 'env_secret_like'
  | 'submit_track_unknown'
  | 'submit_release_status_unknown'
  | 'submit_rollout_needs_in_progress'
  | 'submit_in_progress_needs_rollout'
  | 'submit_rollout_out_of_range'
  | 'submit_profile_without_build_profile'
  | 'submit_identifier_mismatch'
  | 'app_config_unreadable'
  | 'app_config_dynamic'
  | 'app_config_missing'
  | 'app_config_invalid_value';

export type EasFinding = {
  code: EasFindingCode;
  severity: EasSeverity;
  /** One sentence for a person. It names keys and profiles, never a value of `env` or of an unknown key. */
  message: string;
  scope: EasFindingScope;
  /** The build or submit profile concerned. */
  profile?: string | undefined;
  /** The key concerned (an `env` name, a field name). Never a value. */
  key?: string | undefined;
};

export type EasCli = {
  /** `cli.version`: a semver range of EAS CLI versions. */
  version: string | null;
  requireCommit: boolean | null;
  /** As written: `local`, `remote`, or null when absent or not one of those. */
  appVersionSource: 'local' | 'remote' | null;
  /** What EAS CLI uses: `local` when the field is absent (the documented default). */
  appVersionSourceEffective: 'local' | 'remote';
};

/** The build options that can sit at the root of a profile or in its `ios` or `android` section. */
export type EasBuildTarget = {
  distribution: string | null;
  channel: string | null;
  developmentClient: boolean | null;
  /** `true`, `false`, or a string (`version`, `versionCode`, `buildNumber`) as written. */
  autoIncrement: boolean | string | null;
  resourceClass: string | null;
  image: string | null;
  /** Android. */
  buildType: string | null;
  gradleCommand: string | null;
  /** iOS. */
  simulator: boolean | null;
  buildConfiguration: string | null;
  scheme: string | null;
};

export type EasBuildProfile = EasBuildTarget & {
  name: string;
  /** The `extends` as written. */
  extends: string | null;
  /** This profile, then each profile it extends in turn. Stops at a cycle or a missing profile. */
  extendsChain: string[];
  node: string | null;
  environment: string | null;
  credentialsSource: string | null;
  /** The deprecated Classic Updates `releaseChannel`, kept so it can be reported. */
  releaseChannel: string | null;
  /** Names of `env` variables (root and platform sections, `extends` merged), sorted. Never the values. */
  envNames: string[];
  /** The values this profile ends up with for a platform, `extends` merged; null when no profile in the chain has that section. */
  ios: EasBuildTarget | null;
  android: EasBuildTarget | null;
  /** Keys of the profile that the Expo reference does not list. The values are not kept. */
  unknownKeys: string[];
};

export type EasSubmitIos = {
  ascAppId: string | null;
  appleTeamId: string | null;
  sku: string | null;
  language: string | null;
  companyName: string | null;
  appName: string | null;
  bundleIdentifier: string | null;
  /** A path as written (may be `$VARIABLE`). */
  ascApiKeyPath: string | null;
  ascApiKeyId: string | null;
  ascApiKeyIssuerId: string | null;
  /** The Apple ID itself is personal data and is not kept. */
  hasAppleId: boolean;
  metadataPath: string | null;
  groups: string[];
};

export type EasSubmitAndroid = {
  track: string | null;
  releaseStatus: string | null;
  rollout: number | null;
  changesNotSentForReview: boolean | null;
  /** A path as written (may be `$VARIABLE`), never the key itself. */
  serviceAccountKeyPath: string | null;
  applicationId: string | null;
};

export type EasSubmitProfile = {
  name: string;
  extends: string | null;
  extendsChain: string[];
  ios: EasSubmitIos | null;
  android: EasSubmitAndroid | null;
  unknownKeys: string[];
};

export type EasConfig = {
  cli: EasCli;
  build: EasBuildProfile[];
  submit: EasSubmitProfile[];
  /** Top-level keys other than `cli`, `build` and `submit`. */
  unknownKeys: string[];
  /** More profiles than `EAS_MAX_PROFILES` were present: the rest were not read. */
  truncated: boolean;
};

export type EasRuntimeVersion =
  | { kind: 'string'; value: string }
  | { kind: 'policy'; policy: string };

/** The fields of the Expo app config that relate to `eas.json`. Read from JSON only. */
export type ExpoAppSummary = {
  /** `app.config.json` or `app.json` (the first that exists), null when there is no JSON app config. */
  path: string | null;
  /** A dynamic config (`app.config.js`, `.ts`, ...) exists and was not run: its values may override these. */
  dynamicPath: string | null;
  /** The JSON app config could not be parsed. */
  unreadable: boolean;
  version: string | null;
  runtimeVersion: EasRuntimeVersion | null;
  /** `ios.runtimeVersion` / `android.runtimeVersion`: they override the top level one for that platform. */
  iosRuntimeVersion: EasRuntimeVersion | null;
  androidRuntimeVersion: EasRuntimeVersion | null;
  updatesUrl: string | null;
  updatesEnabled: boolean | null;
  /** `expo.extra.eas.projectId`. */
  easProjectId: string | null;
  iosBundleIdentifier: string | null;
  androidPackage: string | null;
  iosBuildNumber: string | null;
  androidVersionCode: number | null;
  /**
   * Whether expo-updates is configured as far as the JSON says: `updates.url` is present (and `updates.enabled` is not false).
   * Null when it cannot be told (no readable JSON config, or a dynamic config that may set it).
   */
  updatesConfigured: boolean | null;
};

export type EasConfigReport = {
  /** Null when `eas.json` could not be parsed (the findings say why). */
  config: EasConfig | null;
  app: ExpoAppSummary;
  findings: EasFinding[];
};

export type EasConfigRead =
  | {
      found: false;
      reason: 'no_eas_json';
      message: string;
      /** `eas.json` files in subfolders, which are not read (only the repository root is). */
      nested: string[];
      app: ExpoAppSummary;
    }
  | ({ found: true; path: string } & EasConfigReport);

export type EasConfigInput = {
  /** The text of `eas.json`. */
  easJson: string;
  /** The JSON app config, when the repository has one. */
  appConfig?: { path: string; text: string } | undefined;
  /** A dynamic app config file that exists (it is not read). */
  dynamicAppConfig?: string | undefined;
};

// ---------------------------------------------------------------------------------------------
// Documented values (docs.expo.dev/build/eas-json, docs.expo.dev/submit/eas-json, docs.expo.dev/eas/json)

export const EAS_DISTRIBUTIONS: readonly string[] = ['store', 'internal'];
export const EAS_APP_VERSION_SOURCES: readonly string[] = ['local', 'remote'];
export const EAS_ANDROID_TRACKS: readonly string[] = ['production', 'beta', 'alpha', 'internal'];
export const EAS_RELEASE_STATUSES: readonly string[] = [
  'completed',
  'draft',
  'halted',
  'inProgress',
];
export const EAS_RUNTIME_POLICIES: readonly string[] = [
  'nativeVersion',
  'sdkVersion',
  'appVersion',
  'fingerprint',
];
/** How many `extends` steps the Expo pages allow. */
export const EAS_MAX_EXTENDS_DEPTH = 5;
export const EAS_MAX_PROFILES = 100;
const MAX_ENV_NAMES = 200;
const MAX_TEXT = 1_000_000;

const COMMON_BUILD_KEYS = [
  'withoutCredentials',
  'extends',
  'credentialsSource',
  'releaseChannel',
  'channel',
  'distribution',
  'developmentClient',
  'resourceClass',
  'prebuildCommand',
  'buildArtifactPaths',
  'uploadSourceMaps',
  'node',
  'corepack',
  'yarn',
  'pnpm',
  'bun',
  'expoCli',
  'env',
  'autoIncrement',
  'cache',
  'config',
  'permissions',
  'environment',
];
const PLATFORM_BUILD_KEYS = [
  'image',
  'ndk',
  'buildType',
  'gradleCommand',
  'applicationArchivePath',
  'simulator',
  'enterpriseProvisioning',
  'bundler',
  'fastlane',
  'cocoapods',
  'scheme',
  'buildConfiguration',
];
const BUILD_KEYS = new Set([...COMMON_BUILD_KEYS, ...PLATFORM_BUILD_KEYS, 'ios', 'android']);
const BUILD_PLATFORM_KEYS = new Set([...COMMON_BUILD_KEYS, ...PLATFORM_BUILD_KEYS]);
const SUBMIT_KEYS = new Set(['extends', 'ios', 'android']);
const SUBMIT_IOS_KEYS = new Set([
  'appleId',
  'ascAppId',
  'appleTeamId',
  'sku',
  'language',
  'companyName',
  'appName',
  'ascApiKeyPath',
  'ascApiKeyIssuerId',
  'ascApiKeyId',
  'bundleIdentifier',
  'metadataPath',
  'groups',
]);
const SUBMIT_ANDROID_KEYS = new Set([
  'serviceAccountKeyPath',
  'track',
  'releaseStatus',
  'rollout',
  'changesNotSentForReview',
  'applicationId',
]);
const CLI_KEYS = new Set([
  'version',
  'requireCommit',
  'appVersionSource',
  'promptToConfigurePushNotifications',
]);
/** Keys whose object values are merged key by key when a profile extends another. The rest are replaced. */
const MERGED_KEYS = new Set(['env', 'ios', 'android', 'cache']);

// ---------------------------------------------------------------------------------------------
// Small helpers

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const clip = (s: string, max = 300) => (s.length > max ? `${s.slice(0, max)}...` : s);
const nonEmpty = (s: string) => s.trim() !== '';

/** A copy with no prototype, so a key named `__proto__` is an ordinary key. */
function plain(o: Obj): Obj {
  const out: Obj = Object.create(null);
  for (const key of Object.keys(o)) out[key] = o[key];
  return out;
}

/** `{...base, ...child}`, except that the objects under `MERGED_KEYS` are merged one level down (`env` of `ios` too). */
function mergeProfiles(base: Obj, child: Obj): Obj {
  const out = plain(base);
  for (const key of Object.keys(child)) {
    if (key === 'extends') continue;
    const was = out[key];
    const now = child[key];
    if (MERGED_KEYS.has(key) && isObj(was) && isObj(now)) {
      const merged = plain(was);
      for (const inner of Object.keys(now)) {
        const a = merged[inner];
        const b = now[inner];
        merged[inner] = inner === 'env' && isObj(a) && isObj(b) ? { ...plain(a), ...plain(b) } : b;
      }
      out[key] = merged;
    } else {
      out[key] = now;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// JSON, tolerantly

export type EasJsonRead =
  | { ok: true; value: unknown; lenient: boolean }
  | { ok: false; line: number | null; column: number | null };

/** Blanks comments and trailing commas, keeping every other character at its position. */
export function relaxJson(text: string): string {
  const out = text.split('');
  const n = text.length;
  let i = 0;
  let inString = false;
  while (i < n) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 2;
      else {
        if (ch === '"') inString = false;
        i++;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      i++;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n' && text[i] !== '\r') out[i++] = ' ';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (; i < stop; i++) if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
    } else {
      i++;
    }
  }
  inString = false;
  for (i = 0; i < n; i++) {
    const ch = out[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(out[j] ?? '')) j++;
      if (out[j] === '}' || out[j] === ']') out[i] = ' ';
    }
  }
  return out.join('');
}

function lineColumn(text: string, position: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < position && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      column = 1;
    } else column++;
  }
  return { line, column };
}

/**
 * Parses JSON; when that fails, once more with comments and trailing commas blanked. The error never repeats the text (V8 quotes a
 * piece of it, which here could be an `env` value): only the line and column, when the engine gives a position.
 */
export function parseJsonLenient(source: string): EasJsonRead {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  try {
    return { ok: true, value: JSON.parse(text), lenient: false };
  } catch {
    // Fall through to the tolerant read.
  }
  const relaxed = relaxJson(text);
  try {
    return { ok: true, value: JSON.parse(relaxed), lenient: relaxed !== text };
  } catch (error) {
    const position = /position (\d+)/.exec(error instanceof Error ? error.message : '');
    if (!position?.[1]) return { ok: false, line: null, column: null };
    const at = lineColumn(text, Number(position[1]));
    return { ok: false, line: at.line, column: at.column };
  }
}

// ---------------------------------------------------------------------------------------------
// Secrets in `env`

const SECRET_WORDS = new Set([
  'secret',
  'secrets',
  'token',
  'tokens',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'credential',
  'credentials',
  'apikey',
  'privatekey',
  'auth',
  'bearer',
]);
const SECRET_PAIRS = new Set([
  'api key',
  'private key',
  'access key',
  'secret key',
  'signing key',
  'client secret',
  'auth key',
]);
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*$/,
  /^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}/,
  /^gh[pousr]_[A-Za-z0-9]{20,}/,
  /^github_pat_[A-Za-z0-9_]{20,}/,
  /^AKIA[0-9A-Z]{16}$/,
  /^AIza[\w-]{30,}$/,
  /^xox[abprs]-[A-Za-z0-9-]{10,}/,
  /^glpat-[\w-]{20,}/,
];
const RANDOM_LOOKING = /^[A-Za-z0-9+/_-]{40,}={0,2}$/;

/** `API_KEY`, `sentryAuthToken`, `x-secret` -> ['api','key'], ['sentry','auth','token'], ['x','secret']. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== '')
    .map((w) => w.toLowerCase());
}

/**
 * Whether an `env` entry looks like a secret, from its name and its value. A heuristic (nothing in Expo's pages defines it): the
 * name says so (token, password, API key, ...) with a value that is not a reference (`$NAME`) or empty, or the value has the shape
 * of a known credential (a private key, a JWT, a GitHub, Stripe, AWS, Google or Slack token, a long random string).
 */
export function looksLikeSecret(name: string, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text === '' || /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(text)) return false;
  const parts = words(name);
  if (parts.some((w) => SECRET_WORDS.has(w))) return true;
  for (let i = 0; i + 1 < parts.length; i++) {
    if (SECRET_PAIRS.has(`${parts[i]} ${parts[i + 1]}`)) return true;
  }
  if (SECRET_VALUE_PATTERNS.some((p) => p.test(text))) return true;
  // A long plain word or a path is not a random string: it needs digits and letters.
  return RANDOM_LOOKING.test(text) && /\d/.test(text) && /[A-Za-z]/.test(text);
}

// ---------------------------------------------------------------------------------------------
// Findings

class Findings {
  readonly list: EasFinding[] = [];
  private readonly seen = new Set<string>();
  add(finding: EasFinding): void {
    const id = `${finding.code}|${finding.scope}|${finding.profile ?? ''}|${finding.key ?? ''}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.list.push({ ...finding, message: clip(finding.message, 400) });
  }
}

type Where = { scope: EasFindingScope; profile?: string | undefined };

/** Reads typed values from an object, saying (once) when a documented key has the wrong type. */
class Fields {
  private readonly obj: Obj;
  private readonly findings: Findings | null;
  private readonly where: Where;
  private readonly prefix: string;
  constructor(obj: Obj, findings: Findings | null, where: Where, prefix = '') {
    this.obj = obj;
    this.findings = findings;
    this.where = where;
    this.prefix = prefix;
  }
  private bad(key: string, expected: string): null {
    this.findings?.add({
      code: 'invalid_value',
      severity: 'warning',
      scope: this.where.scope,
      profile: this.where.profile,
      key: `${this.prefix}${key}`,
      message: `${this.label()}"${this.prefix}${key}" should be ${expected}; it was ignored.`,
    });
    return null;
  }
  private label(): string {
    const { scope, profile } = this.where;
    if (scope === 'cli') return 'In "cli", ';
    if (profile === undefined) return '';
    return `${scope === 'build' ? 'Build' : 'Submit'} profile "${clip(profile, 80)}": `;
  }
  str(key: string): string | null {
    const v = this.obj[key];
    if (v === undefined) return null;
    return typeof v === 'string' ? clip(v) : this.bad(key, 'a string');
  }
  bool(key: string): boolean | null {
    const v = this.obj[key];
    if (v === undefined) return null;
    return typeof v === 'boolean' ? v : this.bad(key, 'true or false');
  }
  num(key: string): number | null {
    const v = this.obj[key];
    if (v === undefined) return null;
    return typeof v === 'number' && Number.isFinite(v) ? v : this.bad(key, 'a number');
  }
  boolOrStr(key: string): boolean | string | null {
    const v = this.obj[key];
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v;
    return typeof v === 'string' ? clip(v) : this.bad(key, 'true, false or a string');
  }
  strings(key: string): string[] {
    const v = this.obj[key];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      this.bad(key, 'a list of strings');
      return [];
    }
    return (v as string[]).map((s) => clip(s));
  }
}

// ---------------------------------------------------------------------------------------------
// Profiles

function readTarget(o: Obj, findings: Findings | null, where: Where, prefix = ''): EasBuildTarget {
  const f = new Fields(o, findings, where, prefix);
  return {
    distribution: f.str('distribution'),
    channel: f.str('channel'),
    developmentClient: f.bool('developmentClient'),
    autoIncrement: f.boolOrStr('autoIncrement'),
    resourceClass: f.str('resourceClass'),
    image: f.str('image'),
    buildType: f.str('buildType'),
    gradleCommand: f.str('gradleCommand'),
    simulator: f.bool('simulator'),
    buildConfiguration: f.str('buildConfiguration'),
    scheme: f.str('scheme'),
  };
}

/** The platform's own values over the root's. */
function overlay(root: EasBuildTarget, own: EasBuildTarget): EasBuildTarget {
  const out: EasBuildTarget = { ...root };
  for (const key of Object.keys(own) as (keyof EasBuildTarget)[]) {
    if (own[key] !== null) (out as Record<string, unknown>)[key] = own[key];
  }
  return out;
}

function envNamesOf(o: Obj, into: Set<string>, findings: Findings | null, where: Where): void {
  const env = o.env;
  if (env === undefined) return;
  if (!isObj(env)) {
    findings?.add({
      code: 'invalid_value',
      severity: 'warning',
      scope: where.scope,
      profile: where.profile,
      key: 'env',
      message: `Build profile "${clip(where.profile ?? '', 80)}": "env" should be an object of names and values; it was ignored.`,
    });
    return;
  }
  for (const name of Object.keys(env)) {
    if (into.size < MAX_ENV_NAMES) into.add(clip(name, 120));
    if (findings && looksLikeSecret(name, env[name])) {
      findings.add({
        code: 'env_secret_like',
        severity: 'warning',
        scope: 'build',
        profile: where.profile,
        key: clip(name, 120),
        message: `Build profile "${clip(where.profile ?? '', 80)}" sets env "${clip(name, 120)}", which looks like a secret. eas.json is committed to Git: keep secrets out of it (Expo says env is for non-secret values).`,
      });
    }
  }
}

function unknownKeysOf(o: Obj, known: Set<string>): string[] {
  return Object.keys(o)
    .filter((k) => !known.has(k))
    .map((k) => clip(k, 120))
    .sort();
}

type Resolved = { chain: string[]; merged: Obj };

/**
 * Follows `extends` from a profile. Reports (once per place) a cycle, a profile that does not exist, a chain longer than the Expo
 * pages allow, and an `extends` that is not a string. The merge covers the part of the chain that is sound.
 */
function resolve(
  name: string,
  profiles: Map<string, Obj>,
  scope: 'build' | 'submit',
  findings: Findings,
): Resolved {
  const chain = [name];
  const word = scope === 'build' ? 'Build' : 'Submit';
  let current = name;
  for (;;) {
    const here = profiles.get(current);
    const next = here?.extends;
    if (next === undefined) break;
    if (typeof next !== 'string' || !nonEmpty(next)) {
      findings.add({
        code: 'extends_invalid',
        severity: 'warning',
        scope,
        profile: current,
        key: 'extends',
        message: `${word} profile "${clip(current, 80)}": "extends" should be the name of a profile; it was ignored.`,
      });
      break;
    }
    if (!profiles.has(next)) {
      findings.add({
        code: 'extends_missing',
        severity: 'error',
        scope,
        profile: current,
        key: 'extends',
        message: `${word} profile "${clip(current, 80)}" extends "${clip(next, 80)}", which is not defined in "${scope}".`,
      });
      break;
    }
    const at = chain.indexOf(next);
    if (at !== -1) {
      const cycle = chain.slice(at);
      findings.add({
        code: 'extends_cycle',
        severity: 'error',
        scope,
        profile: [...cycle].sort()[0],
        key: 'extends',
        message: `${word} profiles extend each other in a circle: ${[...cycle, next].map((n) => `"${clip(n, 80)}"`).join(' -> ')}. EAS refuses a circular extends.`,
      });
      break;
    }
    if (chain.length > EAS_MAX_EXTENDS_DEPTH) {
      findings.add({
        code: 'extends_too_deep',
        severity: 'warning',
        scope,
        profile: name,
        key: 'extends',
        message: `${word} profile "${clip(name, 80)}" extends more than ${EAS_MAX_EXTENDS_DEPTH} profiles in a row. The Expo pages allow a depth of ${EAS_MAX_EXTENDS_DEPTH}; the rest of the chain was not followed.`,
      });
      break;
    }
    chain.push(next);
    current = next;
  }
  let merged: Obj = Object.create(null);
  for (const link of [...chain].reverse()) merged = mergeProfiles(merged, profiles.get(link) ?? {});
  return { chain, merged };
}

function readProfiles(
  value: unknown,
  scope: 'build' | 'submit',
  findings: Findings,
): { profiles: Map<string, Obj>; truncated: boolean } {
  const profiles = new Map<string, Obj>();
  let truncated = false;
  if (value === undefined) return { profiles, truncated };
  if (!isObj(value)) {
    findings.add({
      code: 'section_invalid',
      severity: 'warning',
      scope,
      key: scope,
      message: `"${scope}" should be an object of profiles; it was ignored.`,
    });
    return { profiles, truncated };
  }
  for (const name of Object.keys(value)) {
    const profile = value[name];
    if (!isObj(profile)) {
      findings.add({
        code: 'profile_invalid',
        severity: 'warning',
        scope,
        profile: clip(name, 80),
        message: `${scope === 'build' ? 'Build' : 'Submit'} profile "${clip(name, 80)}" should be an object; it was ignored.`,
      });
      continue;
    }
    if (profiles.size >= EAS_MAX_PROFILES) {
      truncated = true;
      continue;
    }
    profiles.set(name, plain(profile));
  }
  if (truncated) {
    findings.add({
      code: 'too_many_profiles',
      severity: 'warning',
      scope,
      message: `More than ${EAS_MAX_PROFILES} ${scope} profiles: the rest were not read.`,
    });
  }
  return { profiles, truncated };
}

function buildProfiles(profiles: Map<string, Obj>, findings: Findings): EasBuildProfile[] {
  const out: EasBuildProfile[] = [];
  for (const [name, own] of profiles) {
    const label = clip(name, 80);
    const where: Where = { scope: 'build', profile: name };
    // Own values are checked once (types, env secrets); the merged ones are only read.
    readTarget(own, findings, where);
    for (const section of ['ios', 'android'] as const) {
      const raw = own[section];
      if (raw === undefined) continue;
      if (!isObj(raw)) {
        findings.add({
          code: 'invalid_value',
          severity: 'warning',
          scope: 'build',
          profile: name,
          key: section,
          message: `Build profile "${label}": "${section}" should be an object; it was ignored.`,
        });
        continue;
      }
      readTarget(raw, findings, where, `${section}.`);
      envNamesOf(raw, new Set(), findings, where);
      const strange = unknownKeysOf(raw, BUILD_PLATFORM_KEYS);
      if (strange.length > 0) {
        findings.add({
          code: 'unknown_keys',
          severity: 'info',
          scope: 'build',
          profile: name,
          key: `${section}.${strange[0]}`,
          message: `Build profile "${label}" has keys in "${section}" that the Expo reference does not list: ${strange.join(', ')}.`,
        });
      }
    }
    envNamesOf(own, new Set(), findings, where);
    const { chain, merged } = resolve(name, profiles, 'build', findings);
    const f = new Fields(merged, null, where);
    const root = readTarget(merged, null, where);
    const target = (section: 'ios' | 'android'): EasBuildTarget | null => {
      const raw = merged[section];
      return isObj(raw) ? overlay(root, readTarget(raw, null, where)) : null;
    };
    const names = new Set<string>();
    envNamesOf(merged, names, null, where);
    for (const section of ['ios', 'android'] as const) {
      const raw = merged[section];
      if (isObj(raw)) envNamesOf(raw, names, null, where);
    }
    const strange = unknownKeysOf(own, BUILD_KEYS);
    if (strange.length > 0) {
      findings.add({
        code: 'unknown_keys',
        severity: 'info',
        scope: 'build',
        profile: name,
        key: strange[0],
        message: `Build profile "${label}" has keys that the Expo reference does not list: ${strange.join(', ')}.`,
      });
    }
    const profile: EasBuildProfile = {
      ...root,
      name: clip(name, 120),
      extends: typeof own.extends === 'string' ? clip(own.extends, 120) : null,
      extendsChain: chain.map((c) => clip(c, 120)),
      node: f.str('node'),
      environment: f.str('environment'),
      credentialsSource: f.str('credentialsSource'),
      releaseChannel: f.str('releaseChannel'),
      envNames: [...names].sort(),
      ios: target('ios'),
      android: target('android'),
      unknownKeys: unknownKeysOf(merged, BUILD_KEYS),
    };
    out.push(profile);
    // Checks on what the profile ends up with.
    const targets: [string, EasBuildTarget | null][] = [
      ['', profile],
      ['ios.', profile.ios],
      ['android.', profile.android],
    ];
    for (const [prefix, t] of targets) {
      // A platform that only inherits the root's values is not reported again.
      const own = (field: keyof EasBuildTarget) => prefix === '' || t?.[field] !== profile[field];
      if (
        t?.distribution != null &&
        own('distribution') &&
        !EAS_DISTRIBUTIONS.includes(t.distribution)
      ) {
        findings.add({
          code: 'distribution_unknown',
          severity: 'warning',
          scope: 'build',
          profile: name,
          key: `${prefix}distribution`,
          message: `Build profile "${label}": distribution "${clip(t.distribution, 60)}" is not one of ${EAS_DISTRIBUTIONS.join(', ')}.`,
        });
      }
      if (
        t &&
        t.channel !== null &&
        t.developmentClient === true &&
        (own('channel') || own('developmentClient'))
      ) {
        findings.add({
          code: 'channel_ignored_dev_client',
          severity: 'info',
          scope: 'build',
          profile: name,
          key: `${prefix}channel`,
          message: `Build profile "${label}" sets a channel and developmentClient: Expo says the channel has no effect on a development client build.`,
        });
      }
    }
    if (profile.releaseChannel !== null) {
      findings.add({
        code: 'release_channel_deprecated',
        severity: 'info',
        scope: 'build',
        profile: name,
        key: 'releaseChannel',
        message: `Build profile "${label}" uses releaseChannel, a Classic Updates field that Expo marks deprecated (SDK 49 and lower). Use channel with Expo Updates.`,
      });
    }
  }
  return out;
}

function submitIos(o: Obj, findings: Findings | null, where: Where): EasSubmitIos {
  const f = new Fields(o, findings, where, 'ios.');
  return {
    ascAppId: f.str('ascAppId'),
    appleTeamId: f.str('appleTeamId'),
    sku: f.str('sku'),
    language: f.str('language'),
    companyName: f.str('companyName'),
    appName: f.str('appName'),
    bundleIdentifier: f.str('bundleIdentifier'),
    ascApiKeyPath: f.str('ascApiKeyPath'),
    ascApiKeyId: f.str('ascApiKeyId'),
    ascApiKeyIssuerId: f.str('ascApiKeyIssuerId'),
    hasAppleId: typeof o.appleId === 'string' && nonEmpty(o.appleId),
    metadataPath: f.str('metadataPath'),
    groups: f.strings('groups'),
  };
}

function submitAndroid(o: Obj, findings: Findings | null, where: Where): EasSubmitAndroid {
  const f = new Fields(o, findings, where, 'android.');
  return {
    track: f.str('track'),
    releaseStatus: f.str('releaseStatus'),
    rollout: f.num('rollout'),
    changesNotSentForReview: f.bool('changesNotSentForReview'),
    serviceAccountKeyPath: f.str('serviceAccountKeyPath'),
    applicationId: f.str('applicationId'),
  };
}

/** The Google Play combinations of `track`, `releaseStatus` and `rollout` that Google or EAS refuse (see docs/api/eas-config.md). */
function androidSubmitFindings(name: string, a: EasSubmitAndroid, findings: Findings): void {
  const label = `Submit profile "${clip(name, 80)}"`;
  const base = { scope: 'submit', profile: name } as const;
  if (a.track !== null && !EAS_ANDROID_TRACKS.includes(a.track)) {
    findings.add({
      ...base,
      code: 'submit_track_unknown',
      severity: 'warning',
      key: 'android.track',
      message: `${label}: track "${clip(a.track, 60)}" is not one of ${EAS_ANDROID_TRACKS.join(', ')}, the values the Expo reference lists.`,
    });
  }
  if (a.releaseStatus !== null && !EAS_RELEASE_STATUSES.includes(a.releaseStatus)) {
    findings.add({
      ...base,
      code: 'submit_release_status_unknown',
      severity: 'warning',
      key: 'android.releaseStatus',
      message: `${label}: releaseStatus "${clip(a.releaseStatus, 60)}" is not one of ${EAS_RELEASE_STATUSES.join(', ')}.`,
    });
  }
  if (a.rollout !== null && a.releaseStatus !== 'inProgress') {
    findings.add({
      ...base,
      code: 'submit_rollout_needs_in_progress',
      severity: a.releaseStatus === null ? 'warning' : 'error',
      key: 'android.rollout',
      message:
        a.releaseStatus === null
          ? `${label} sets a rollout without releaseStatus: Expo says rollout works only with "inProgress".`
          : `${label} sets a rollout with releaseStatus "${clip(a.releaseStatus, 60)}": Expo says rollout works only with "inProgress", and Google Play accepts a user fraction only for inProgress or halted releases.`,
    });
  }
  if (a.releaseStatus === 'inProgress' && a.rollout === null) {
    findings.add({
      ...base,
      code: 'submit_in_progress_needs_rollout',
      severity: 'warning',
      key: 'android.rollout',
      message: `${label} has releaseStatus "inProgress" and no rollout: a staged release serves a fraction of users, and the Expo pages do not say what is used when it is missing.`,
    });
  }
  if (a.rollout !== null && (a.rollout <= 0 || a.rollout >= 1)) {
    findings.add({
      ...base,
      code: 'submit_rollout_out_of_range',
      severity: 'error',
      key: 'android.rollout',
      message: `${label}: rollout ${a.rollout} is outside the open range between 0 and 1 that Google Play accepts for a staged release.`,
    });
  }
}

function submitProfiles(
  profiles: Map<string, Obj>,
  buildNames: Set<string>,
  findings: Findings,
): EasSubmitProfile[] {
  const out: EasSubmitProfile[] = [];
  for (const [name, own] of profiles) {
    const label = clip(name, 80);
    const where: Where = { scope: 'submit', profile: name };
    for (const section of ['ios', 'android'] as const) {
      const raw = own[section];
      if (raw === undefined) continue;
      if (!isObj(raw)) {
        findings.add({
          code: 'invalid_value',
          severity: 'warning',
          scope: 'submit',
          profile: name,
          key: section,
          message: `Submit profile "${label}": "${section}" should be an object; it was ignored.`,
        });
        continue;
      }
      const known = section === 'ios' ? SUBMIT_IOS_KEYS : SUBMIT_ANDROID_KEYS;
      const strange = unknownKeysOf(raw, known);
      if (strange.length > 0) {
        findings.add({
          code: 'unknown_keys',
          severity: 'info',
          scope: 'submit',
          profile: name,
          key: `${section}.${strange[0]}`,
          message: `Submit profile "${label}" has keys in "${section}" that the Expo reference does not list: ${strange.join(', ')}.`,
        });
      }
      if (section === 'ios') submitIos(raw, findings, where);
      else submitAndroid(raw, findings, where);
    }
    const { chain, merged } = resolve(name, profiles, 'submit', findings);
    const ios = isObj(merged.ios) ? submitIos(merged.ios, null, where) : null;
    const android = isObj(merged.android) ? submitAndroid(merged.android, null, where) : null;
    if (android) androidSubmitFindings(name, android, findings);
    const strange = unknownKeysOf(own, SUBMIT_KEYS);
    if (strange.length > 0) {
      findings.add({
        code: 'unknown_keys',
        severity: 'info',
        scope: 'submit',
        profile: name,
        key: strange[0],
        message: `Submit profile "${label}" has keys that the Expo reference does not list: ${strange.join(', ')}.`,
      });
    }
    out.push({
      name: clip(name, 120),
      extends: typeof own.extends === 'string' ? clip(own.extends, 120) : null,
      extendsChain: chain.map((c) => clip(c, 120)),
      ios,
      android,
      unknownKeys: unknownKeysOf(merged, SUBMIT_KEYS),
    });
    // Expo: a build selected for `eas submit` uses the submit profile of its own name, else `production`.
    if (!buildNames.has(name) && buildNames.size > 0) {
      findings.add({
        code: 'submit_profile_without_build_profile',
        severity: 'info',
        scope: 'submit',
        profile: name,
        message: `Submit profile "${label}" has no build profile of the same name. Expo matches a build to the submit profile of its profile name (falling back to "production"), so this one is used only when named with --profile.`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The Expo app config

const NO_APP: ExpoAppSummary = {
  path: null,
  dynamicPath: null,
  unreadable: false,
  version: null,
  runtimeVersion: null,
  iosRuntimeVersion: null,
  androidRuntimeVersion: null,
  updatesUrl: null,
  updatesEnabled: null,
  easProjectId: null,
  iosBundleIdentifier: null,
  androidPackage: null,
  iosBuildNumber: null,
  androidVersionCode: null,
  updatesConfigured: null,
};

export const emptyExpoAppSummary = (): ExpoAppSummary => ({ ...NO_APP });

const RUNTIME_STRING = /^[a-zA-Z\d][a-zA-Z\d._+()-]{0,254}$/;
const RUNTIME_EXPOSDK = /^exposdk:((\d+\.\d+\.\d+)|(UNVERSIONED))$/;

function runtimeOf(value: unknown): EasRuntimeVersion | null {
  if (typeof value === 'string') return { kind: 'string', value: clip(value) };
  if (isObj(value) && typeof value.policy === 'string') {
    return { kind: 'policy', policy: clip(value.policy, 60) };
  }
  return null;
}

/** The fields of `app.json` / `app.config.json` that relate to `eas.json`. JSON only, never run. */
export function readExpoAppConfig(
  input: { path: string; text: string } | undefined,
  dynamicPath?: string | undefined,
  report?: (finding: EasFinding) => void,
): ExpoAppSummary {
  const app: ExpoAppSummary = { ...NO_APP, dynamicPath: dynamicPath ?? null };
  const finish = (): ExpoAppSummary => {
    if (app.updatesUrl !== null) app.updatesConfigured = app.updatesEnabled !== false;
    else if (app.path !== null && !app.unreadable && app.dynamicPath === null) {
      app.updatesConfigured = false;
    }
    return app;
  };
  if (!input) return finish();
  app.path = input.path;
  const read = parseJsonLenient(input.text.length > MAX_TEXT ? '' : input.text);
  if (!read.ok || !isObj(read.value)) {
    app.unreadable = true;
    report?.({
      code: 'app_config_unreadable',
      severity: 'warning',
      scope: 'app',
      key: input.path,
      message: `${input.path} is not valid JSON, so the Expo app config was not read.`,
    });
    return finish();
  }
  const cfg = isObj(read.value.expo) ? read.value.expo : read.value;
  const str = (v: unknown): string | null => (typeof v === 'string' && nonEmpty(v) ? clip(v) : null);
  const ios = isObj(cfg.ios) ? cfg.ios : undefined;
  const android = isObj(cfg.android) ? cfg.android : undefined;
  const updates = isObj(cfg.updates) ? cfg.updates : undefined;
  const extra = isObj(cfg.extra) ? cfg.extra : undefined;
  const eas = isObj(extra?.eas) ? extra.eas : undefined;
  app.version = str(cfg.version);
  app.runtimeVersion = runtimeOf(cfg.runtimeVersion);
  app.iosRuntimeVersion = runtimeOf(ios?.runtimeVersion);
  app.androidRuntimeVersion = runtimeOf(android?.runtimeVersion);
  app.updatesUrl = str(updates?.url);
  app.updatesEnabled = typeof updates?.enabled === 'boolean' ? updates.enabled : null;
  app.easProjectId = str(eas?.projectId);
  app.iosBundleIdentifier = str(ios?.bundleIdentifier);
  app.androidPackage = str(android?.package);
  app.iosBuildNumber = str(ios?.buildNumber);
  app.androidVersionCode =
    typeof android?.versionCode === 'number' && Number.isFinite(android.versionCode)
      ? android.versionCode
      : null;
  if (cfg.runtimeVersion !== undefined && app.runtimeVersion === null) {
    report?.({
      code: 'app_config_invalid_value',
      severity: 'warning',
      scope: 'app',
      key: 'runtimeVersion',
      message: `${input.path}: runtimeVersion should be a string or an object with a "policy"; it was ignored.`,
    });
  }
  return finish();
}

function targetsOf(b: EasBuildProfile): EasBuildTarget[] {
  return [b, ...(b.ios ? [b.ios] : []), ...(b.android ? [b.android] : [])];
}

const hasChannel = (b: EasBuildProfile) => targetsOf(b).some((t) => t.channel !== null);

/** How `eas.json` and the app config fit together: channels, runtime version, expo-updates, identifiers. */
function consistency(config: EasConfig, app: ExpoAppSummary, findings: Findings): void {
  const file = app.path ?? 'the app config';
  if (app.dynamicPath !== null) {
    findings.add({
      code: 'app_config_dynamic',
      severity: 'info',
      scope: 'app',
      key: app.dynamicPath,
      message: `${app.dynamicPath} is code and is never run here: values read from ${app.path ?? 'the JSON config'} may be overridden by it${app.path === null ? ', and there is no JSON config to read' : ''}.`,
    });
  } else if (app.path === null) {
    findings.add({
      code: 'app_config_missing',
      severity: 'info',
      scope: 'app',
      message:
        'There is no app.json or app.config.json at the repository root, so the Expo app config was not read.',
    });
  }
  if (app.unreadable) return;

  const channelProfiles = config.build.filter(hasChannel);
  const forUpdates = config.build.filter((b) => b.developmentClient !== true);
  const names = (list: EasBuildProfile[]) => list.map((b) => `"${clip(b.name, 80)}"`).join(', ');
  if (app.updatesConfigured === false && channelProfiles.length > 0) {
    findings.add({
      code: 'channel_without_updates',
      severity: 'warning',
      scope: 'app',
      key: 'updates.url',
      message: `Build profile${channelProfiles.length > 1 ? 's' : ''} ${names(channelProfiles)} set a channel, but ${file} has no updates.url: expo-updates is not configured, so the channel is never used.`,
    });
  }
  if (app.updatesEnabled === false && channelProfiles.length > 0) {
    findings.add({
      code: 'updates_disabled_with_channel',
      severity: 'warning',
      scope: 'app',
      key: 'updates.enabled',
      message: `${file} sets updates.enabled to false while build profiles set a channel: builds will not check for updates.`,
    });
  }
  if (app.updatesConfigured === true && forUpdates.length > 0 && !forUpdates.some(hasChannel)) {
    findings.add({
      code: 'updates_without_channel',
      severity: 'info',
      scope: 'app',
      key: 'channel',
      message: `${file} configures expo-updates, but no build profile sets a channel. A channel can also come from the request headers in the app config, which this does not read.`,
    });
  }
  const runtimes: [string, EasRuntimeVersion | null][] = [
    ['runtimeVersion', app.runtimeVersion],
    ['ios.runtimeVersion', app.iosRuntimeVersion],
    ['android.runtimeVersion', app.androidRuntimeVersion],
  ];
  if (
    app.updatesConfigured === true &&
    app.dynamicPath === null &&
    runtimes.every(([, r]) => r === null)
  ) {
    findings.add({
      code: 'updates_without_runtime_version',
      severity: 'warning',
      scope: 'app',
      key: 'runtimeVersion',
      message: `${file} has updates.url but no runtimeVersion: Expo lists a missing runtime version as a reason expo-updates is disabled.`,
    });
  }
  const url = app.updatesUrl ? /^https:\/\/u\.expo\.dev\/([^/?#]+)\/?$/.exec(app.updatesUrl) : null;
  if (url?.[1] && app.easProjectId !== null && url[1] !== app.easProjectId) {
    findings.add({
      code: 'updates_url_project_mismatch',
      severity: 'warning',
      scope: 'app',
      key: 'updates.url',
      message: `${file}: updates.url points at a different EAS project than extra.eas.projectId.`,
    });
  }
  for (const [key, runtime] of runtimes) {
    if (!runtime) continue;
    if (runtime.kind === 'string') {
      if (!RUNTIME_STRING.test(runtime.value) && !RUNTIME_EXPOSDK.test(runtime.value)) {
        findings.add({
          code: 'runtime_version_invalid',
          severity: 'warning',
          scope: 'app',
          key,
          message: `${file}: ${key} is not a valid runtime version string (letters, digits and ._+()- , starting with a letter or digit, up to 255 characters, or exposdk:<version>).`,
        });
      }
    } else if (!EAS_RUNTIME_POLICIES.includes(runtime.policy)) {
      findings.add({
        code: 'runtime_policy_unknown',
        severity: 'warning',
        scope: 'app',
        key,
        message: `${file}: ${key} policy "${clip(runtime.policy, 60)}" is not one of ${EAS_RUNTIME_POLICIES.join(', ')}.`,
      });
    } else if (
      (runtime.policy === 'appVersion' || runtime.policy === 'nativeVersion') &&
      app.version === null
    ) {
      findings.add({
        code: 'runtime_policy_needs_version',
        severity: 'warning',
        scope: 'app',
        key,
        message: `${file}: the "${runtime.policy}" policy builds the runtime version from "version", which the app config does not set.`,
      });
    } else if (
      runtime.policy === 'nativeVersion' &&
      config.cli.appVersionSourceEffective === 'remote'
    ) {
      findings.add({
        code: 'runtime_policy_native_version',
        severity: 'info',
        scope: 'app',
        key,
        message:
          'The "nativeVersion" policy uses buildNumber and versionCode, and with appVersionSource "remote" those are kept on Expo servers, not in the app config. How EAS resolves the runtime version then is not checked here.',
      });
    }
  }
  // Identifiers named in a submit profile against the app config.
  for (const s of config.submit) {
    const bundle = s.ios?.bundleIdentifier;
    if (bundle && app.iosBundleIdentifier && bundle !== app.iosBundleIdentifier) {
      findings.add({
        code: 'submit_identifier_mismatch',
        severity: 'warning',
        scope: 'submit',
        profile: s.name,
        key: 'ios.bundleIdentifier',
        message: `Submit profile "${clip(s.name, 80)}" names bundleIdentifier ${bundle}, but ${file} has ios.bundleIdentifier ${app.iosBundleIdentifier}.`,
      });
    }
    const applicationId = s.android?.applicationId;
    if (applicationId && app.androidPackage && applicationId !== app.androidPackage) {
      findings.add({
        code: 'submit_identifier_mismatch',
        severity: 'warning',
        scope: 'submit',
        profile: s.name,
        key: 'android.applicationId',
        message: `Submit profile "${clip(s.name, 80)}" names applicationId ${applicationId}, but ${file} has android.package ${app.androidPackage}.`,
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The whole read

function readCli(value: unknown, findings: Findings): EasCli {
  const cli: EasCli = {
    version: null,
    requireCommit: null,
    appVersionSource: null,
    appVersionSourceEffective: 'local',
  };
  if (value !== undefined && !isObj(value)) {
    findings.add({
      code: 'section_invalid',
      severity: 'warning',
      scope: 'cli',
      key: 'cli',
      message: '"cli" should be an object; it was ignored.',
    });
    return cli;
  }
  const o = value ?? {};
  const f = new Fields(o, findings, { scope: 'cli' });
  cli.version = f.str('version');
  cli.requireCommit = f.bool('requireCommit');
  const source = f.str('appVersionSource');
  if (source !== null) {
    if (source === 'local' || source === 'remote') {
      cli.appVersionSource = source;
      cli.appVersionSourceEffective = source;
    } else {
      findings.add({
        code: 'app_version_source_unknown',
        severity: 'warning',
        scope: 'cli',
        key: 'appVersionSource',
        message: `cli.appVersionSource "${clip(source, 60)}" is not "local" or "remote"; EAS CLI treats it as local.`,
      });
    }
  }
  const strange = unknownKeysOf(o, CLI_KEYS);
  if (strange.length > 0) {
    findings.add({
      code: 'unknown_keys',
      severity: 'info',
      scope: 'cli',
      key: strange[0],
      message: `"cli" has keys that the Expo reference does not list: ${strange.join(', ')}.`,
    });
  }
  return cli;
}

/**
 * Parses the text of `eas.json` and checks it against the app config. Never throws: a file that is not JSON gives `config: null`
 * and an `eas_json_invalid` finding; whatever else is wrong is a finding next to a model of what could be read.
 */
export function analyzeEasConfig(input: EasConfigInput): EasConfigReport {
  const findings = new Findings();
  const app = readExpoAppConfig(input.appConfig, input.dynamicAppConfig, (f) => findings.add(f));
  const fail = (code: EasFindingCode, message: string): EasConfigReport => {
    findings.add({ code, severity: 'error', scope: 'file', message });
    return { config: null, app, findings: findings.list };
  };
  if (input.easJson.length > MAX_TEXT) {
    return fail('eas_json_too_large', 'eas.json is larger than 1 MB, so it was not read.');
  }
  const read = parseJsonLenient(input.easJson);
  if (!read.ok) {
    return fail(
      'eas_json_invalid',
      read.line === null
        ? 'eas.json is not valid JSON.'
        : `eas.json is not valid JSON (line ${read.line}, column ${read.column}).`,
    );
  }
  if (!isObj(read.value)) return fail('eas_json_not_object', 'eas.json should hold a JSON object.');
  if (read.lenient) {
    findings.add({
      code: 'eas_json_lenient',
      severity: 'warning',
      scope: 'file',
      message:
        'eas.json has comments or trailing commas, which are not valid JSON. It was read anyway; whether EAS CLI accepts it was not checked.',
    });
  }
  const root = plain(read.value);
  const cli = readCli(root.cli, findings);
  const build = readProfiles(root.build, 'build', findings);
  const submit = readProfiles(root.submit, 'submit', findings);
  const builds = buildProfiles(build.profiles, findings);
  const submits = submitProfiles(submit.profiles, new Set(build.profiles.keys()), findings);
  const config: EasConfig = {
    cli,
    build: builds,
    submit: submits,
    unknownKeys: unknownKeysOf(root, new Set(['cli', 'build', 'submit'])),
    truncated: build.truncated || submit.truncated,
  };
  if (config.unknownKeys.length > 0) {
    findings.add({
      code: 'unknown_keys',
      severity: 'info',
      scope: 'file',
      key: config.unknownKeys[0],
      message: `eas.json has top-level keys that the Expo reference does not list: ${config.unknownKeys.join(', ')}.`,
    });
  }
  const sourceWrong = findings.list.some((f) => f.code === 'app_version_source_unknown');
  if (cli.appVersionSource === null && !sourceWrong) {
    findings.add({
      code: 'app_version_source_missing',
      severity: 'info',
      scope: 'cli',
      key: 'appVersionSource',
      message:
        'cli.appVersionSource is not set. EAS CLI uses "local" and warns that the field will become required.',
    });
  }
  if (cli.appVersionSource === 'remote') {
    findings.add({
      code: 'app_version_source_remote',
      severity: 'info',
      scope: 'cli',
      key: 'appVersionSource',
      message:
        'cli.appVersionSource is "remote": the build number and version code are kept on Expo servers, so this read cannot show them.',
    });
  }
  if (cli.appVersionSource === null) {
    const incrementing = builds.filter((b) =>
      targetsOf(b).some((t) => t.autoIncrement !== null && t.autoIncrement !== false),
    );
    if (incrementing.length > 0) {
      findings.add({
        code: 'auto_increment_without_source',
        severity: 'warning',
        scope: 'cli',
        key: 'appVersionSource',
        message: `Build profile${incrementing.length > 1 ? 's' : ''} ${incrementing.map((b) => `"${clip(b.name, 80)}"`).join(', ')} set autoIncrement while cli.appVersionSource is not set. Expo says EAS CLI asks for a source when autoIncrement is turned on and saves it there.`,
      });
    }
  }
  consistency(config, app, findings);
  return { config, app, findings: findings.list };
}

const APP_CONFIG_JSON = ['app.config.json', 'app.json'];
const DYNAMIC_APP_CONFIG = /^app\.config\.(js|ts|mjs|cjs|mts|cts)$/;
const NESTED_EAS_JSON = /^(?:[^/]+\/)+eas\.json$/;
const IGNORED = /(^|\/)(node_modules|Pods|vendor|\.git|build|DerivedData)\//;

/**
 * Reads `eas.json` and the Expo app config from the repository root (the only place the scan looks, as for `detectProject`).
 * `files` is the file list; only `eas.json` and the JSON app config are read. `found: false` says there is no `eas.json`
 * at the root and lists the ones in subfolders.
 */
export async function readEasConfig(files: string[], read: ReadFile): Promise<EasConfigRead> {
  const have = new Set(files);
  const appPath = APP_CONFIG_JSON.find((p) => have.has(p));
  const dynamic = files.filter((p) => DYNAMIC_APP_CONFIG.test(p)).sort()[0];
  const appText = appPath ? await read(appPath) : undefined;
  const appConfig = appPath && appText !== undefined ? { path: appPath, text: appText } : undefined;
  const easText = have.has('eas.json') ? await read('eas.json') : undefined;
  if (easText === undefined) {
    const nested = files.filter((p) => NESTED_EAS_JSON.test(p) && !IGNORED.test(p)).sort();
    return {
      found: false,
      reason: 'no_eas_json',
      message:
        nested.length > 0
          ? `There is no eas.json at the repository root. Only the root is read; found in subfolders: ${nested.slice(0, 5).join(', ')}.`
          : 'There is no eas.json at the repository root.',
      nested: nested.slice(0, 20),
      app: readExpoAppConfig(appConfig, dynamic),
    };
  }
  return {
    found: true,
    path: 'eas.json',
    ...analyzeEasConfig({ easJson: easText, appConfig, dynamicAppConfig: dynamic }),
  };
}
