import type { Platform } from '@kiln/core';
import { platformSupports, supports } from '@kiln/core';
import { appAddress } from './app-scope.ts';
import {
  type EasBuildView,
  easBuildDetail,
  easBuildState,
  easBuildTitle,
} from './eas/eas-status.ts';
import { formatBytes, formatList } from './i18n/format.ts';
import { k, t } from './i18n/t.ts';

/**
 * Builds to test (docs/api/builds.md): the rows of the "Test builds" section, their filters and the plain install guidance, as
 * pure functions. The server answers `GET /apps/:id/builds/artifacts`; nothing here touches the network or the window.
 */

export type ArtifactKind = 'ipa' | 'apk' | 'aab' | 'app' | 'dmg' | 'pkg' | 'zip' | 'other';

/** The real build number read from inside a CI artifact (the Android versionCode, the iOS CFBundleVersion). */
export type ArtifactBuild = {
  number: string;
  version: string | null;
  packageId: string | null;
  format: 'apk' | 'aab' | 'ipa';
};

export type ArtifactItem = {
  id: string;
  name: string;
  kind: ArtifactKind;
  guessed: boolean;
  platform: Platform | null;
  sizeBytes: number;
  expired: boolean;
  createdAt: number | null;
  expiresAt: number | null;
  downloadable: boolean;
  tooLarge: boolean;
  /** Read from inside the file by `POST .../inspect`; null until then and when the file held none. */
  build?: ArtifactBuild | null;
  /** `read`, `unreadable` (looked at, nothing found) or null (not looked at yet). */
  buildRead?: 'read' | 'unreadable' | null;
  /** Apps of a multi-app run whose artifact owner the name does not tell: shown under each of them. */
  sharedWith?: string[] | null;
  run: {
    id: string;
    number: number | null;
    workflow: string;
    title: string | null;
    branch: string | null;
    shortSha: string | null;
    status: string;
    conclusion: string | null;
    url: string | null;
  };
};

export type StoreBuildItem = {
  platform: Platform;
  buildNumber: string;
  version: string | null;
  state: 'processing' | 'processed' | 'invalid' | 'unknown';
  rawState: string | null;
  expired: boolean | null;
  uploadedAt: number | null;
  expiresAt: number | null;
  expiresAtEstimated: boolean;
  channel: 'testflight' | 'play';
  tracks: string[];
  releaseStatus: string | null;
  optInUrl: string | null;
  runId: string | null;
  /** TestFlight: ids of the public-link groups the build is in; null when they were not read. */
  testflightGroupIds: string[] | null;
};

export type TestFlightProblemReason = 'no_access' | 'rate_limited' | 'unavailable' | 'not_synced';
export type TestFlightLink = {
  id: string;
  name: string;
  publicLink: string | null;
  enabled: boolean;
  limit: number | null;
};
export type TestFlightInfo = {
  groups: TestFlightLink[];
  withoutLink: number;
  problem: { reason: TestFlightProblemReason; needs: string | null } | null;
  readAt: number | null;
  cached: boolean;
};

export type BuildsProblem = {
  reason: 'no_access' | 'rate_limited' | 'unavailable' | 'unsupported' | 'no_repository';
  needs: string | null;
};

export type BuildsList = {
  app: { id: string; name: string; platform: Platform; identifier: string };
  repository: { id: string; owner: string; repo: string } | null;
  artifacts: ArtifactItem[];
  hiddenArtifacts: number;
  truncated: boolean;
  store: StoreBuildItem[];
  /** TestFlight public links, read only; null for an Android app. */
  testflight: TestFlightInfo | null;
  problem: BuildsProblem | null;
  downloadEnabled: boolean;
  maxDownloadBytes: number;
  canDownload: boolean;
  readAt: number | null;
  cached: boolean;
};

export type DownloadLink = { path: string; expiresAt: number; filename: string };

// ---------------------------------------------------------------------------------------------
// Rows

export type RowSource = 'ci' | 'store' | 'eas';
export type RowKind = ArtifactKind | 'testflight' | 'play' | 'eas';

export type BuildRow = {
  key: string;
  source: RowSource;
  platform: Platform | null;
  kind: RowKind;
  /** The build or version number, or the artifact's name. */
  title: string;
  /** The build number: the store's, or the one read from inside a CI artifact; null when it is not known. */
  buildNumber: string | null;
  /** CI rows: the build number as a chip next to the name, `1.26.2 (167)` like a store row's title; null when not read. */
  buildLabel: string | null;
  /** Run, branch and commit; or the version and tracks. */
  detail: string;
  /** Link to the CI run, when there is one. */
  runUrl: string | null;
  sizeBytes: number | null;
  at: number | null;
  expiresAt: number | null;
  expired: boolean;
  /** A plain word for the state, with a tone for a badge. */
  state: { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' | 'info' };
  artifact: ArtifactItem | null;
  store: StoreBuildItem | null;
  /** An EAS build (docs/adr/0036-eas-build-submit-status.md): the third source, next to CI artifacts and store builds. */
  eas?: EasBuildView | undefined;
};

const runLabel = (a: ArtifactItem): string => {
  const run = a.run.number !== null ? `${a.run.workflow} #${a.run.number}` : a.run.workflow;
  return [run, a.run.branch, a.run.shortSha].filter((x): x is string => !!x).join(' · ');
};

const runConclusionKeys: Record<string, string> = {
  failure: k('builds:row.run.failure'),
  cancelled: k('builds:row.run.cancelled'),
  timed_out: k('builds:row.run.timedOut'),
  startup_failure: k('builds:row.run.startupFailure'),
  action_required: k('builds:row.run.actionRequired'),
  skipped: k('builds:row.run.skipped'),
  neutral: k('builds:row.run.neutral'),
  stale: k('builds:row.run.stale'),
};

const artifactState = (a: ArtifactItem): BuildRow['state'] => {
  if (a.expired) return { label: t('builds:row.expired'), tone: 'bad' };
  if (a.tooLarge) return { label: t('builds:row.tooLarge'), tone: 'warn' };
  if (a.run.conclusion !== null && a.run.conclusion !== 'success') {
    const key = runConclusionKeys[a.run.conclusion];
    return {
      label: key
        ? t(key)
        : t('builds:row.run.other', { conclusion: a.run.conclusion.replace(/_/g, ' ') }),
      tone: 'warn',
    };
  }
  return { label: t('builds:row.available'), tone: 'ok' };
};

const storeState = (b: StoreBuildItem): BuildRow['state'] => {
  if (b.expired === true) return { label: t('builds:row.expired'), tone: 'bad' };
  if (b.state === 'processing') return { label: t('builds:row.processing'), tone: 'info' };
  if (b.state === 'invalid') return { label: t('builds:row.invalid'), tone: 'bad' };
  if (b.state === 'processed')
    return {
      label: b.channel === 'play' ? t('builds:row.onTrack') : t('builds:row.readyToTest'),
      tone: 'ok',
    };
  return { label: t('builds:row.unknownState'), tone: 'neutral' };
};

/** The quiet chip for an artifact of a run shared by several apps when its owner is not known; '' otherwise. */
export const sharedNote = (a: Pick<ArtifactItem, 'sharedWith'>): string =>
  a.sharedWith && a.sharedWith.length > 1
    ? t('builds:row.sharedRun', { apps: formatList(a.sharedWith) })
    : '';

/** `1.26.2 (165)`, or `(165)` without a version: how a store row names its build. */
export const buildTitle = (version: string | null, buildNumber: string): string =>
  `${version ? `${version} ` : ''}(${buildNumber})`.trim();

/** The chip of a CI build whose number was read: like a store row's title with a version, `Build 167` without. */
export const artifactBuildLabel = (build: ArtifactBuild | null | undefined): string | null =>
  build
    ? build.version
      ? buildTitle(build.version, build.number)
      : t('builds:row.buildNumber', { number: build.number })
    : null;

export function artifactRow(a: ArtifactItem): BuildRow {
  return {
    key: `ci:${a.id}`,
    source: 'ci',
    platform: a.platform,
    kind: a.kind,
    title: a.name,
    buildNumber: a.build?.number ?? null,
    buildLabel: artifactBuildLabel(a.build),
    detail: runLabel(a),
    runUrl: a.run.url,
    sizeBytes: a.sizeBytes,
    at: a.createdAt,
    expiresAt: a.expiresAt,
    expired: a.expired,
    state: artifactState(a),
    artifact: a,
    store: null,
  };
}

export function storeRow(b: StoreBuildItem): BuildRow {
  const where =
    b.channel === 'play'
      ? b.tracks.length > 0
        ? t('builds:row.tracks', { count: b.tracks.length, tracks: formatList(b.tracks) })
        : t('builds:row.noTrack')
      : 'TestFlight';
  return {
    key: `store:${b.platform}:${b.buildNumber}`,
    source: 'store',
    platform: b.platform,
    kind: b.channel,
    title: buildTitle(b.version, b.buildNumber),
    buildNumber: b.buildNumber,
    buildLabel: null,
    detail: where,
    runUrl: null,
    sizeBytes: null,
    at: b.uploadedAt,
    expiresAt: b.expiresAt,
    expired: b.expired === true,
    state: storeState(b),
    artifact: null,
    store: b,
  };
}

/** An EAS build as a row. Its files are not downloadable through this server: the Expo page of the build is the way to install it. */
export function easRow(b: EasBuildView, now: number = Date.now()): BuildRow {
  const expired =
    b.status === 'finished' && b.artifactExpiresAt !== null && b.artifactExpiresAt <= now;
  return {
    key: `eas:${b.id}`,
    source: 'eas',
    platform: b.platform,
    kind: 'eas',
    title: easBuildTitle(b),
    buildNumber: null,
    buildLabel: null,
    detail: easBuildDetail(b),
    runUrl: b.expoUrl,
    sizeBytes: null,
    at: b.createdAt,
    expiresAt: b.artifactExpiresAt,
    expired,
    state: expired ? { label: t('builds:row.expired'), tone: 'bad' } : easBuildState(b),
    artifact: null,
    store: null,
    eas: b,
  };
}

/** Every build, newest first (a build with no date goes last). EAS builds are one more source; pass them when the app is linked to Expo. */
export function rowsOf(
  list: Pick<BuildsList, 'artifacts' | 'store'>,
  eas: readonly EasBuildView[] = [],
  now: number = Date.now(),
): BuildRow[] {
  const rows = [
    ...list.artifacts.map(artifactRow),
    ...list.store.map(storeRow),
    ...eas.map((b) => easRow(b, now)),
  ];
  return rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------------------------
// Reading the build number of CI artifacts

/** How many artifacts one page view asks the server to open (each is a download of the zip through the server). */
export const INSPECTIONS_PER_VIEW = 8;

/** Kinds that can hold an APK, an AAB or an IPA: a Mac app, a disk image and a report cannot be read for a build number. */
const READABLE_KINDS: readonly string[] = ['apk', 'aab', 'ipa', 'zip'];

/** May the page ask the server to read this artifact: not yet looked at, downloadable now, downloads on, and the role may download. */
export function canInspect(
  a: ArtifactItem,
  list: Pick<BuildsList, 'downloadEnabled' | 'canDownload'>,
): boolean {
  return (
    list.downloadEnabled &&
    list.canDownload &&
    a.downloadable &&
    !a.expired &&
    !a.tooLarge &&
    (a.buildRead ?? null) === null &&
    a.build == null &&
    READABLE_KINDS.includes(a.kind) &&
    a.platform !== 'macos'
  );
}

/**
 * The artifacts to ask about next, from the rows that are shown (in the order shown), skipping those already tried in this page view,
 * at most `budget` of them in all. The page asks one at a time.
 */
export function nextInspections(
  rows: readonly BuildRow[],
  list: Pick<BuildsList, 'downloadEnabled' | 'canDownload'>,
  tried: ReadonlySet<string>,
  budget: number = INSPECTIONS_PER_VIEW,
): ArtifactItem[] {
  const left = budget - tried.size;
  if (left <= 0) return [];
  const out: ArtifactItem[] = [];
  for (const r of rows) {
    const a = r.artifact;
    if (a && !tried.has(a.id) && canInspect(a, list)) out.push(a);
    if (out.length >= left) break;
  }
  return out;
}

/** The list with one artifact replaced by its answer (a new list; the others are as they were). */
export function withInspected<T extends Pick<BuildsList, 'artifacts'>>(
  list: T,
  item: ArtifactItem,
): T {
  return { ...list, artifacts: list.artifacts.map((a) => (a.id === item.id ? item : a)) };
}

/** The quiet line under a CI row about its build number: being read, or not found in the file. Null when there is nothing to say. */
export function buildNote(
  row: Pick<BuildRow, 'artifact'>,
  reading: boolean,
): { kind: 'reading' | 'unreadable'; text: string } | null {
  const a = row.artifact;
  if (!a || a.build) return null;
  if (a.buildRead === 'unreadable')
    return { kind: 'unreadable', text: t('builds:row.buildUnreadable') };
  if (reading) return { kind: 'reading', text: t('builds:row.buildReading') };
  return null;
}

/** The words behind the chip (its tooltip and screen reader text). */
export const buildHint = (build: ArtifactBuild): string =>
  t('builds:row.buildNumberHint', { number: build.number });

// ---------------------------------------------------------------------------------------------
// Filters

export type BuildFilters = {
  platform: 'all' | Platform;
  source: 'all' | RowSource;
  hideExpired: boolean;
  /** Test reports, logs and other artifacts that do not look like a build. */
  hideOther: boolean;
};

export const defaultFilters: BuildFilters = {
  platform: 'all',
  source: 'all',
  hideExpired: true,
  hideOther: true,
};

export function applyFilters(rows: readonly BuildRow[], f: BuildFilters): BuildRow[] {
  return rows.filter(
    (r) =>
      (f.platform === 'all' || r.platform === f.platform) &&
      (f.source === 'all' || r.source === f.source) &&
      (!f.hideExpired || !r.expired) &&
      (!f.hideOther || r.kind !== 'other'),
  );
}

/** What the filters hide, so a person is told why a list is short. */
export function hiddenBy(rows: readonly BuildRow[], f: BuildFilters): number {
  return rows.length - applyFilters(rows, f).length;
}

// ---------------------------------------------------------------------------------------------
// Words

/** `1.5 MB` in the active language; '' when the size is not known. */
export const humanSize = (bytes: number | null): string =>
  bytes === null ? '' : formatBytes(bytes);

const DAY = 24 * 60 * 60_000;

/** "expires in 12 days", "expires today", "expired 3 days ago", or "" when nothing is known. */
export function expiryText(
  row: Pick<BuildRow, 'expiresAt' | 'expired' | 'store'>,
  now: number,
): string {
  const about = row.store?.expiresAtEstimated === true;
  if (row.expiresAt === null) return row.expired ? t('builds:expiry.expired') : '';
  const days = Math.floor((row.expiresAt - now) / DAY);
  if (row.expired || row.expiresAt <= now) {
    const ago = Math.floor((now - row.expiresAt) / DAY);
    if (row.expired && ago <= 0) return t('builds:expiry.expired');
    return ago <= 0
      ? t('builds:expiry.expiredToday')
      : t('builds:expiry.expiredAgo', { count: ago });
  }
  if (days <= 0)
    return about ? t('builds:expiry.expiresTodayAbout') : t('builds:expiry.expiresToday');
  return about
    ? t('builds:expiry.expiresInAbout', { count: days })
    : t('builds:expiry.expiresIn', { count: days });
}

export const kindLabel = (kind: RowKind): string =>
  kind === 'app'
    ? t('builds:kind.macApp')
    : kind === 'other'
      ? t('builds:kind.other')
      : (
          {
            ipa: 'IPA',
            apk: 'APK',
            aab: 'AAB',
            dmg: 'DMG',
            pkg: 'PKG',
            zip: 'Zip',
            testflight: 'TestFlight',
            play: 'Play',
            eas: 'EAS',
          } as const
        )[kind];

// ---------------------------------------------------------------------------------------------
// Install guidance

export type Guide = {
  title: string;
  steps: string[];
  /** The honest limits: what this cannot do, or what is a guess. */
  caution: string | null;
  /** May a zip be downloaded for this kind (when the server allows it at all)? */
  downloads: boolean;
  /** Is a code for a phone useful (a file the phone itself can install)? */
  qr: boolean;
  /** A link to open instead (TestFlight, Play opt-in). */
  link: { label: string; href: string } | null;
};

/** Installation guidance for an EAS build: this tool holds no file, so it points at the Expo page of the build. */
function easGuide(b: EasBuildView): Guide {
  const link = b.expoUrl ? { label: t('builds:guide.eas.openOnExpo'), href: b.expoUrl } : null;
  if (b.status !== 'finished') {
    return {
      title:
        b.status === 'errored'
          ? t('builds:guide.eas.failedTitle')
          : t('builds:guide.eas.runningTitle'),
      steps: [
        b.status === 'errored'
          ? t('builds:guide.eas.failedStep')
          : t('builds:guide.eas.runningStep'),
      ],
      caution: null,
      downloads: false,
      qr: false,
      link,
    };
  }
  if (b.simulator === true || b.distribution === 'simulator') {
    return {
      title: t('builds:guide.eas.simulatorTitle'),
      steps: [t('builds:guide.eas.simulatorStep1'), t('builds:guide.eas.simulatorStep2')],
      caution: t('builds:guide.eas.simulatorCaution'),
      downloads: false,
      qr: false,
      link,
    };
  }
  if (b.internal) {
    return {
      title: t('builds:guide.eas.internalTitle'),
      steps: [
        t('builds:guide.eas.internalStep1'),
        b.platform === 'android'
          ? t('builds:guide.eas.internalStepAndroid')
          : t('builds:guide.eas.internalStepIos'),
      ],
      caution: t('builds:guide.eas.internalCaution'),
      downloads: false,
      qr: false,
      link,
    };
  }
  return {
    title: t('builds:guide.eas.storeTitle'),
    steps: [t('builds:guide.eas.storeStep1'), t('builds:guide.eas.storeStep2')],
    caution: null,
    downloads: false,
    qr: false,
    link,
  };
}

/** Plain installation guidance for a row. Never promises more than the tool can do. */
export function installGuide(row: BuildRow): Guide {
  if (row.eas) return easGuide(row.eas);
  if (row.store) {
    const b = row.store;
    if (b.channel === 'testflight') {
      return {
        title: t('builds:guide.testflight.title'),
        steps: [
          t('builds:guide.testflight.step1'),
          t('builds:guide.testflight.step2'),
          t('builds:guide.testflight.step3'),
        ],
        caution:
          b.expired === true
            ? t('builds:guide.testflight.expired')
            : b.state === 'processing'
              ? t('builds:guide.testflight.processing')
              : b.expiresAtEstimated
                ? t('builds:guide.testflight.estimate')
                : null,
        downloads: false,
        qr: false,
        link: null,
      };
    }
    return {
      title: t('builds:guide.play.title'),
      steps: [
        t('builds:guide.play.step1'),
        b.optInUrl ? t('builds:guide.play.stepOptIn') : t('builds:guide.play.stepInternal'),
      ],
      caution: b.tracks.length === 0 ? t('builds:guide.play.noTrack') : null,
      downloads: false,
      qr: false,
      link: b.optInUrl ? { label: t('builds:guide.play.openOptIn'), href: b.optInUrl } : null,
    };
  }
  const kind = row.kind as ArtifactKind;
  switch (kind) {
    case 'apk':
      return {
        title: t('builds:guide.apk.title'),
        steps: [
          t('builds:guide.apk.step1'),
          t('builds:guide.apk.step2'),
          t('builds:guide.apk.step3'),
        ],
        caution: t('builds:guide.apk.caution'),
        downloads: true,
        qr: true,
        link: null,
      };
    case 'aab':
      return {
        title: t('builds:guide.aab.title'),
        steps: [
          t('builds:guide.aab.step1'),
          t('builds:guide.aab.step2'),
          t('builds:guide.aab.step3'),
        ],
        caution: t('builds:guide.aab.caution'),
        downloads: true,
        qr: false,
        link: null,
      };
    case 'ipa':
      return {
        title: t('builds:guide.ipa.title'),
        steps: [
          t('builds:guide.ipa.step1'),
          t('builds:guide.ipa.step2'),
          t('builds:guide.ipa.step3'),
        ],
        caution: t('builds:guide.ipa.caution'),
        downloads: true,
        qr: false,
        link: null,
      };
    case 'app':
    case 'dmg':
    case 'pkg':
      return {
        title: t('builds:guide.mac.title'),
        steps: [
          kind === 'dmg'
            ? t('builds:guide.mac.stepDmg')
            : kind === 'pkg'
              ? t('builds:guide.mac.stepPkg')
              : t('builds:guide.mac.stepApp'),
          t('builds:guide.mac.stepGatekeeper'),
        ],
        caution: t('builds:guide.zipNote'),
        downloads: true,
        qr: false,
        link: null,
      };
    case 'zip':
      return {
        title: t('builds:guide.zip.title'),
        steps: [t('builds:guide.zip.step1'), t('builds:guide.zip.step2')],
        caution: t('builds:guide.zipNote'),
        downloads: true,
        qr: platformSupports(row.platform, 'sideloadInstall'),
        link: null,
      };
    default:
      return {
        title: t('builds:guide.other.title'),
        steps: [t('builds:guide.other.step1'), t('builds:guide.other.step2')],
        caution: t('builds:guide.zipNote'),
        downloads: true,
        qr: false,
        link: null,
      };
  }
}

// ---------------------------------------------------------------------------------------------
// States of the page

export type PageNotice = { tone: 'info' | 'warn' | 'error'; title: string; body: string };

/** Why the CI part of the list is empty or partial, in words a person can act on. */
export function problemNotice(
  problem: BuildsProblem | null,
  repo: { owner: string; repo: string } | null,
): PageNotice | null {
  if (!problem) return null;
  switch (problem.reason) {
    case 'no_repository':
      return {
        tone: 'info',
        title: t('builds:notice.noRepository.title'),
        body: t('builds:notice.noRepository.body'),
      };
    case 'no_access':
      return {
        tone: 'warn',
        title: t('builds:notice.noAccess.title'),
        body: t('builds:notice.noAccess.body', {
          repository: repo
            ? `${repo.owner}/${repo.repo}`
            : t('builds:notice.noAccess.theRepository'),
        }),
      };
    case 'rate_limited':
      return {
        tone: 'warn',
        title: t('builds:notice.rateLimited.title'),
        body: t('builds:notice.rateLimited.body'),
      };
    case 'unsupported':
      return {
        tone: 'info',
        title: t('builds:notice.unsupported.title'),
        body: t('builds:notice.unsupported.body'),
      };
    default:
      return {
        tone: 'warn',
        title: t('builds:notice.unreachable.title'),
        body: t('builds:notice.unreachable.body'),
      };
  }
}

/** What the "TestFlight" row of a store build shows. The app only READS these groups: it never creates or turns on a link. */
export type TestFlightView =
  | { kind: 'hidden' }
  | { kind: 'message'; tone: 'info' | 'warn'; text: string }
  | {
      kind: 'links';
      links: (TestFlightLink & { state: 'on' | 'off'; stateText: string; limitText: string })[];
    };

export const testflightNoneText = (): string => t('builds:flight.none.text');

/** The one line for a failed TestFlight read, in the fixed vocabulary of the server (never Apple's text). */
const flightProblemText = (reason: TestFlightProblemReason): string => {
  switch (reason) {
    case 'no_access':
      return t('builds:flight.problem.noAccess');
    case 'rate_limited':
      return t('builds:flight.problem.rateLimited');
    case 'not_synced':
      return t('builds:flight.problem.notSynced');
    default:
      return t('builds:flight.problem.unavailable');
  }
};

/**
 * What to say ONCE for the whole list about TestFlight, instead of on every row: the read failed (with a way to retry), or no group has a
 * public link. Null when there is nothing to say (no TestFlight build, or links to show). `short` is the line; `text` the full words.
 */
export type TestFlightNote = { tone: 'info' | 'warn'; short: string; text: string; retry: boolean };
export function testflightNote(
  list: Pick<BuildsList, 'testflight' | 'store'>,
): TestFlightNote | null {
  const info = list.testflight;
  if (!info || !list.store.some((b) => b.channel === 'testflight')) return null;
  if (info.problem) {
    const warn = info.problem.reason !== 'not_synced';
    return {
      tone: warn ? 'warn' : 'info',
      short:
        info.problem.reason === 'not_synced'
          ? t('builds:flight.short.notSynced')
          : t('builds:flight.short.unreadable'),
      text: flightProblemText(info.problem.reason),
      retry: info.problem.reason !== 'not_synced',
    };
  }
  if (info.groups.length === 0)
    return {
      tone: 'info',
      short: t('builds:flight.none.short'),
      text: testflightNoneText(),
      retry: false,
    };
  return null;
}

/** The TestFlight links of one store build. Whole-list messages (a failed read, no public link, an expired build) are not repeated per row: see `testflightNote`. */
export function testflightView(
  list: Pick<BuildsList, 'testflight'>,
  b: StoreBuildItem,
): TestFlightView {
  const info = list.testflight;
  if (
    !info ||
    b.channel !== 'testflight' ||
    info.problem ||
    b.expired === true ||
    info.groups.length === 0
  )
    return { kind: 'hidden' };
  const ids = new Set(b.testflightGroupIds ?? []);
  const links = info.groups
    .filter((g) => ids.has(g.id))
    .map((g) => ({
      ...g,
      state: g.enabled ? ('on' as const) : ('off' as const),
      stateText: g.enabled ? t('builds:flight.linkOn') : t('builds:flight.linkOff'),
      limitText:
        g.limit === null
          ? t('builds:flight.noLimit')
          : t('builds:flight.limit', { count: g.limit }),
    }));
  if (links.length === 0)
    return {
      kind: 'message',
      tone: 'info',
      text: t('builds:flight.notInGroup'),
    };
  return { kind: 'links', links };
}

/**
 * One compact status line for the page, in place of stacked notices: downloads switched off and a problem reading the CI artifacts become
 * one sentence with their full words behind a "Details" button. Null when all is well.
 */
export type StatusLine = {
  tone: 'info' | 'warn' | 'error';
  text: string;
  details: { title: string; body: string }[];
};
export function statusLine(
  list: Pick<BuildsList, 'downloadEnabled' | 'problem' | 'repository'>,
): StatusLine | null {
  const notice = problemNotice(list.problem, list.repository);
  const parts: string[] = [];
  const details: StatusLine['details'] = [];
  if (!list.downloadEnabled) {
    parts.push(t('builds:status.downloadsOff'));
    details.push({ title: t('builds:status.downloadsOffTitle'), body: downloadsOffText() });
  }
  if (notice) {
    parts.push(notice.title);
    details.push({ title: notice.title, body: notice.body });
  }
  if (parts.length === 0) return null;
  const tone = notice && notice.tone !== 'info' ? notice.tone : 'info';
  return { tone, text: parts.join(' · '), details };
}

/** Shown instead of a download button while the server switch is off. */
export const downloadsOffText = (): string => t('builds:download.off');

export const noRightText = (): string => t('builds:download.noRight');

/** Why a row has no download button, or null when it has one. */
export function downloadBlocker(
  row: BuildRow,
  list: Pick<BuildsList, 'downloadEnabled' | 'canDownload' | 'maxDownloadBytes'>,
): string | null {
  if (!row.artifact) return null;
  if (!list.downloadEnabled) return downloadsOffText();
  if (!list.canDownload) return noRightText();
  if (row.artifact.expired) return t('builds:download.expired');
  if (row.artifact.tooLarge)
    return t('builds:download.tooLarge', { size: humanSize(list.maxDownloadBytes) });
  return null;
}

// ---------------------------------------------------------------------------------------------
// Addresses

export const downloadPath = (workspaceId: string, appId: string, artifactId: string): string =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(appId)}/builds/artifacts/${encodeURIComponent(artifactId)}/download`;

/** The address a phone opens: the server's path on the address this page was reached at. */
export const phoneUrl = (origin: string, path: string): string =>
  `${origin.replace(/\/+$/, '')}${path}`;

/** A phone cannot reach `localhost` or a private address by name; tell the person before they scan. */
export function phoneCannotReach(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '[::1]' ||
      host.endsWith('.localhost')
    );
  } catch {
    return true;
  }
}

/** The address of the Test builds view of Builds for an app, optionally focused on one build (from the release stepper's build picker). */
export const testBuildsHref = (
  appId: string,
  platform: Platform | 'both' | null = null,
  build: string | null = null,
): string => {
  const base = appAddress(appId, 'builds', platform);
  const view = `${base}${base.includes('?') ? '&' : '?'}view=tests`;
  return build ? `${view}&build=${encodeURIComponent(build)}` : view;
};

/** Seconds left of a link, never negative. */
export const secondsLeft = (expiresAt: number, now: number): number =>
  Math.max(0, Math.ceil((expiresAt - now) / 1000));

/** The number in a stepper row title ("Build 240"), or null for "Build (number unknown)". */
export const buildNumberOfTitle = (title: string): string | null =>
  /^Build ([A-Za-z0-9._-]+)$/.exec(title)?.[1] ?? null;

// ---------------------------------------------------------------------------------------------
// Share to device: Google Play internal app sharing (docs/api/internal-sharing.md, docs/adr/0020-play-internal-sharing.md)

export type InternalSharingConfig = {
  enabled: boolean;
  envName?: string;
  linkRetentionHours: number;
  maxBytes: number | null;
  /** Whether the caller's role may share (owner and admin). */
  canShare: boolean;
  note?: string;
};

export type ShareCheck = { code: string; severity: 'blocking' | 'warning'; message: string };

export type SharePreview = {
  app: { id: string; name: string; platform: string; identifier: string };
  artifact: {
    id: string;
    name: string;
    kind: string;
    sizeBytes: number;
    zipSha256: string | null;
    runId: string | null;
    headSha: string | null;
    createdAt: number | null;
    expiresAt: number | null;
  };
  upload: {
    packageName: string;
    kind: 'bundle' | 'apk' | null;
    fileName: string | null;
    entry: string | null;
    versionCode: number | null;
    sha256: string | null;
    maxSizeBytes: number;
  };
  effects: string[];
  linkRetentionHours: number;
  checks: { blocking: ShareCheck[]; warnings: ShareCheck[]; canShare: boolean };
  confirmHash: string | null;
  confirmation: { phrase: string; instruction: string } | null;
  readAt: number;
};

export type ShareResult = {
  share: {
    id: string;
    packageName: string;
    kind: 'bundle' | 'apk';
    fileName: string | null;
    sizeBytes: number;
    sha256: string;
    createdAt: number;
    expiresAt: number;
    hasLink: boolean;
  };
  /** SENSITIVE: whoever holds it and is allowed by Google can install the build. Never log it, never put it in an address. */
  downloadUrl: string;
  checksumMatches: boolean | null;
  note: string;
};

/** The phrase to type, as the server expects it. The preview carries the same text; this is for tests and a fallback. */
export const sharePhrase = (packageName: string): string => `SHARE ${packageName}`;

/** The button shows only for an Android artifact that can be a build, when the server offers sharing and the role may use it. */
export function canOfferShare(
  row: Pick<BuildRow, 'source' | 'platform' | 'artifact'>,
  config: Pick<InternalSharingConfig, 'enabled' | 'canShare'> | null,
): boolean {
  if (!config?.enabled || !config.canShare) return false;
  if (row.source !== 'ci' || !platformSupports(row.platform, 'internalAppSharing') || !row.artifact)
    return false;
  return !row.artifact.expired && !row.artifact.tooLarge;
}

/** A name for the file inside the upload, or the honest "found when you confirm". */
export const uploadFileText = (u: Pick<SharePreview['upload'], 'fileName' | 'kind'>): string => {
  const kind = u.kind === 'bundle' ? 'Android App Bundle (.aab)' : u.kind === 'apk' ? 'APK' : null;
  if (u.fileName) return kind ? `${u.fileName} (${kind})` : u.fileName;
  return kind ?? t('builds:share.fileFoundOnConfirm');
};

/** The version code is known only when the server read the file; today it does not before the upload. */
export const versionCodeText = (v: number | null): string =>
  v === null ? t('builds:share.unknownBeforeUpload') : String(v);

export const shortHash = (sha: string | null): string =>
  sha ? `${sha.slice(0, 12)}…${sha.slice(-6)}` : t('builds:share.unknownBeforeUpload');

/** True when what was typed is the phrase (spaces at the ends do not matter; case does). */
export const phraseMatches = (typed: string, phrase: string | null | undefined): boolean =>
  !!phrase && typed.trim() === phrase;

/** Words for a link's life: "24 hours" for the server's copy; Google's own expiry is not known here. */
export const linkKeptText = (hours: number): string => t('builds:share.linkKept', { count: hours });

export const linkSensitiveText = (): string => t('builds:share.linkSensitive');

/** What this does not do, said once in the preview. */
export const shareCannotUndoText = (): string => t('builds:share.cannotUndo');

/** The entry names a server lists when one artifact holds several builds (at most 20). */
export function entryChoices(body: Record<string, unknown> | undefined): string[] {
  const list = body && Array.isArray(body.entries) ? body.entries : [];
  return list.filter((x): x is string => typeof x === 'string');
}

const shareErrorKeys: Record<string, string> = {
  internal_sharing_disabled: k('builds:shareError.internalSharingDisabled'),
  forbidden: k('builds:shareError.forbidden'),
  not_android: k('builds:shareError.notAndroid'),
  invalid_entry: k('builds:shareError.invalidEntry'),
  entry_required: k('builds:shareError.entryRequired'),
  entry_not_found: k('builds:shareError.entryNotFound'),
  no_android_build: k('builds:shareError.noAndroidBuild'),
  bad_zip: k('builds:shareError.badZip'),
  artifact_expired: k('builds:shareError.artifactExpired'),
  artifact_too_large: k('builds:shareError.artifactTooLarge'),
  confirmation_mismatch: k('builds:shareError.confirmationMismatch'),
  state_changed: k('builds:shareError.stateChanged'),
  blocked: k('builds:shareError.blocked'),
  write_in_progress: k('builds:shareError.writeInProgress'),
  store_auth: k('builds:shareError.storeAuth'),
  store_forbidden: k('builds:shareError.storeForbidden'),
  store_not_found: k('builds:shareError.storeNotFound'),
  artifact_rejected: k('builds:shareError.artifactRejected'),
  upload_failed: k('builds:shareError.uploadFailed'),
  outcome_unknown: k('builds:shareError.outcomeUnknown'),
  link_expired: k('builds:shareError.linkExpired'),
  not_found: k('builds:shareError.notFound'),
};

/**
 * One plain sentence for every fixed code the preview and the apply answer with. Unknown codes give undefined: the caller shows its own
 * fallback. Google's wording is never shown (the server does not pass it on).
 */
export function shareErrorMessage(code: string, retryAfter?: number): string | undefined {
  if (code === 'rate_limited') {
    if (!retryAfter || retryAfter <= 0) return t('builds:shareError.rateLimitedSoon');
    return retryAfter < 60
      ? t('builds:shareError.rateLimitedSeconds', { count: Math.ceil(retryAfter) })
      : t('builds:shareError.rateLimitedMinutes', { count: Math.ceil(retryAfter / 60) });
  }
  const key = Object.hasOwn(shareErrorKeys, code) ? shareErrorKeys[code] : undefined;
  return key ? t(key) : undefined;
}

/** The refusal the dialog shows for an error: a fixed sentence for the code, else the API client's own text. */
export function shareFailure(error: {
  code?: unknown;
  retryAfter?: unknown;
  message?: unknown;
}): string {
  const code = typeof error.code === 'string' ? error.code : '';
  const fixed = shareErrorMessage(
    code,
    typeof error.retryAfter === 'number' ? error.retryAfter : undefined,
  );
  return (
    fixed ??
    (typeof error.message === 'string' && error.message
      ? error.message
      : t('builds:shareError.generic'))
  );
}

/** Blocking and warning lines of a preview as one list, blocking first. The server's messages are fixed text and safe to show. */
export function previewNotes(
  preview: Pick<SharePreview, 'checks'>,
): { tone: 'error' | 'warn'; text: string }[] {
  return [
    ...preview.checks.blocking.map((c) => ({ tone: 'error' as const, text: c.message })),
    ...preview.checks.warnings.map((c) => ({ tone: 'warn' as const, text: c.message })),
  ];
}

/** A preview the apply may use: not blocked, with a hash and a phrase. */
export const previewReady = (
  p: Pick<SharePreview, 'checks' | 'confirmHash' | 'confirmation'>,
): boolean => p.checks.canShare && !!p.confirmHash && !!p.confirmation;

/** The `state_changed` answer carries a new preview; this returns it when it looks like one. */
export function previewFromBody(body: Record<string, unknown> | undefined): SharePreview | null {
  const p = body?.preview as Partial<SharePreview> | undefined;
  return p && typeof p === 'object' && p.artifact && p.upload && p.checks
    ? (p as SharePreview)
    : null;
}
