import { timeAgo } from './format.ts';
import { formatBytes, formatDateTime, formatDuration } from './i18n/format.ts';
import { k, t } from './i18n/t.ts';
import { APP_STORE_CONNECT_URL } from './store-links.ts';

/**
 * TestFlight beta feedback and crashes of an app (docs/api/testflight-feedback.md, docs/adr/0049-testflight-feedback.md): the types of the API
 * answers, and the words, tones, queries and addresses of the TestFlight view, as pure functions. The server decides every rule; nothing here
 * sends anything. Written for the ES2017 web build: no flatMap, no fromEntries.
 */

export const TRIAGE_STATUSES = ['new', 'seen', 'in_progress', 'resolved', 'ignored'] as const;
export type TriageStatus = (typeof TRIAGE_STATUSES)[number];
export type TestflightKind = 'feedback' | 'crash';

export type TestflightListItem = {
  id: string;
  kind: TestflightKind;
  createdAt: number;
  buildNumber: string | null;
  version: string | null;
  platform: string | null;
  bundleId: string | null;
  tester: string | null;
  testerEmail: string | null;
  deviceModel: string | null;
  deviceFamily: string | null;
  osVersion: string | null;
  locale: string | null;
  timeZone: string | null;
  architecture: string | null;
  connectionType: string | null;
  pairedWatch: string | null;
  appUptimeMs: number | null;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  batteryPercent: number | null;
  screenWidth: number | null;
  screenHeight: number | null;
  crashLogState: 'none' | 'stored' | 'missing';
  crashLogTruncated: boolean;
  signature: string | null;
  symbolicated: boolean | null;
  status: TriageStatus;
  assigneeUserId: string | null;
  statusChangedAt: number | null;
  statusChangedBy: string | null;
  firstSeenAt: number;
  comment: string;
  commentTruncated: boolean;
  screenshotCount: number;
  hasNote: boolean;
};

export type TestflightItem = Omit<
  TestflightListItem,
  'commentTruncated' | 'screenshotCount' | 'hasNote'
> & {
  screenshots: { width: number | null; height: number | null }[];
  internalNote: string | null;
  crashLog?: string | null;
};

export type TestflightSync = {
  lastAttemptAt: number | null;
  lastSyncedAt: number | null;
  lastError: string | null;
  failures: number;
  complete: boolean;
  warnings: string[];
};

export type BuildFacet = {
  buildNumber: string | null;
  version: string | null;
  feedback: number;
  crashes: number;
  lastAt: number;
};

export type TestflightCounts = {
  feedback: number;
  crashes: number;
  openFeedback: number;
  openCrashes: number;
  byStatus: Record<TriageStatus, number>;
};

export type TestflightView = {
  app: { id: string; name: string; platform: string; store: string };
  api: boolean;
  counts: TestflightCounts;
  builds: BuildFacet[];
  items: TestflightListItem[];
  nextCursor: string | null;
  sync: TestflightSync | null;
};

export type CrashGroups = {
  byBuild: { buildNumber: string | null; version: string | null; count: number; lastAt: number }[];
  bySignature: {
    signature: string | null;
    count: number;
    builds: (string | null)[];
    symbolicated: boolean | null;
    lastAt: number;
    open: number;
  }[];
};

export type TestflightSyncResult = {
  sync: {
    feedback: number;
    crashes: number;
    added: { feedback: number; crashes: number };
    crashLogs: number;
    complete: boolean;
    warnings: string[];
    syncedAt: number;
  };
};

export type ScreenshotLink = {
  url: string;
  width: number | null;
  height: number | null;
  expiresAt: number | null;
};

export type TriageInput = {
  status?: TriageStatus;
  assigneeUserId?: string | null;
  internalNote?: string | null;
};

export const MAX_NOTE_LENGTH = 2000;

const STATUS_KEYS: Record<TriageStatus, string> = {
  new: k('testflight:status.new'),
  seen: k('testflight:status.seen'),
  in_progress: k('testflight:status.inProgress'),
  resolved: k('testflight:status.resolved'),
  ignored: k('testflight:status.ignored'),
};
export const statusLabel = (status: TriageStatus): string => t(STATUS_KEYS[status]);

const CONNECTION_KEYS: Record<string, string> = {
  WIFI: k('testflight:connection.wifi'),
  MOBILE_DATA: k('testflight:connection.mobileData'),
  WIRE: k('testflight:connection.wire'),
  NONE: k('testflight:connection.none'),
  UNKNOWN: k('testflight:connection.unknown'),
};
/** Apple's `connectionType`, in words; a value this version does not know is shown as Apple wrote it. */
export const connectionLabel = (value: string): string => {
  const key = CONNECTION_KEYS[value];
  return key ? t(key) : value;
};

export function statusBadge(status: TriageStatus): {
  label: string;
  tone: 'neutral' | 'ok' | 'bad' | 'warn' | 'info' | 'accent';
} {
  const tone =
    status === 'new'
      ? 'info'
      : status === 'in_progress'
        ? 'accent'
        : status === 'resolved'
          ? 'ok'
          : 'neutral';
  return { label: statusLabel(status), tone };
}

export const isOpen = (status: TriageStatus): boolean =>
  status === 'new' || status === 'seen' || status === 'in_progress';

/** "2.5.0 (42)", "42", "2.5.0", or "Unknown build". */
export function buildLabel(buildNumber: string | null, version: string | null): string {
  if (buildNumber && version) return t('testflight:build.both', { version, build: buildNumber });
  if (buildNumber) return t('testflight:build.number', { build: buildNumber });
  if (version) return version;
  return t('testflight:build.unknown');
}

/** Who sent it: the email for a person who may see it, else the six character code, else "Anonymous tester". */
export function testerLabel(item: Pick<TestflightListItem, 'tester' | 'testerEmail'>): string {
  if (item.testerEmail) return item.testerEmail;
  if (item.tester) return t('testflight:tester.code', { code: item.tester });
  return t('testflight:tester.anonymous');
}

const PLATFORMS: Record<string, string> = {
  IOS: 'iOS',
  MAC_OS: 'macOS',
  TV_OS: 'tvOS',
  VISION_OS: 'visionOS',
};

/** "iPhone16,2 · iOS 18.1", with whatever is known. Empty when nothing is. */
export function deviceLine(
  item: Pick<TestflightListItem, 'deviceModel' | 'platform' | 'osVersion'>,
): string {
  const os = item.osVersion
    ? `${PLATFORMS[(item.platform ?? '').toUpperCase()] ?? item.platform ?? ''} ${item.osVersion}`.trim()
    : '';
  return [item.deviceModel ?? '', os].filter((p) => p !== '').join(' · ');
}

export type Fact = { label: string; value: string };

/** The device facts of a submission that Apple gave, in reading order. */
export function deviceFacts(item: TestflightListItem | TestflightItem): Fact[] {
  const facts: Fact[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value !== null && value !== undefined && value !== '')
      facts.push({ label: t(label), value });
  };
  add(k('testflight:fact.device'), deviceLine(item));
  add(k('testflight:fact.family'), item.deviceFamily);
  add(k('testflight:fact.locale'), item.locale);
  add(k('testflight:fact.timeZone'), item.timeZone);
  add(k('testflight:fact.architecture'), item.architecture);
  add(
    k('testflight:fact.connection'),
    item.connectionType ? connectionLabel(item.connectionType) : null,
  );
  add(
    k('testflight:fact.battery'),
    item.batteryPercent === null ? null : `${item.batteryPercent}%`,
  );
  add(
    k('testflight:fact.uptime'),
    item.appUptimeMs === null ? null : formatDuration(item.appUptimeMs),
  );
  add(
    k('testflight:fact.disk'),
    item.diskFreeBytes === null || item.diskTotalBytes === null
      ? null
      : t('testflight:fact.diskValue', {
          free: formatBytes(item.diskFreeBytes),
          total: formatBytes(item.diskTotalBytes),
        }),
  );
  add(
    k('testflight:fact.screen'),
    item.screenWidth === null || item.screenHeight === null
      ? null
      : `${item.screenWidth} × ${item.screenHeight}`,
  );
  add(k('testflight:fact.watch'), item.pairedWatch);
  add(k('testflight:fact.bundle'), item.bundleId);
  add(k('testflight:fact.sent'), formatDateTime(item.createdAt));
  return facts;
}

/** The note on a crash log: never claims the log is symbolicated. */
export function symbolicationNote(
  item: Pick<TestflightItem, 'symbolicated' | 'signature'>,
): string {
  if (item.symbolicated === true) return t('testflight:crash.noteSymbols');
  if (item.symbolicated === false) return t('testflight:crash.noteAddresses');
  return t('testflight:crash.noteUnknown');
}

export type ListFilters = {
  kind: TestflightKind;
  build: string;
  version: string;
  status: string;
  tester: string;
  signature: string;
};

export const emptyFilters = (kind: TestflightKind = 'feedback'): ListFilters => ({
  kind,
  build: '',
  version: '',
  status: '',
  tester: '',
  signature: '',
});

/** The query string of a list request (without the leading `?`). `status` is a comma separated list or ''. */
export function listQuery(filters: ListFilters, cursor?: string | null): string {
  const parts: string[] = [`kind=${filters.kind}`];
  const add = (name: string, value: string) => {
    if (value !== '') parts.push(`${name}=${encodeURIComponent(value)}`);
  };
  add('build', filters.build);
  add('version', filters.version);
  add('status', filters.status);
  add('tester', filters.tester);
  add('signature', filters.signature);
  if (cursor) add('cursor', cursor);
  return parts.join('&');
}

/** The distinct versions and build numbers of the builds facet, newest first, for the two filters. */
export function filterOptions(
  builds: readonly BuildFacet[],
  kind: TestflightKind,
): { versions: string[]; builds: { value: string; label: string }[] } {
  const versions: string[] = [];
  const list: { value: string; label: string }[] = [];
  for (const b of builds) {
    if ((kind === 'feedback' ? b.feedback : b.crashes) === 0) continue;
    if (b.version && versions.indexOf(b.version) < 0) versions.push(b.version);
    if (b.buildNumber && !list.some((x) => x.value === b.buildNumber))
      list.push({ value: b.buildNumber, label: buildLabel(b.buildNumber, b.version) });
  }
  return { versions, builds: list };
}

/** The testers of the loaded items, as filter options (never an email: the six character code). */
export function testerOptions(
  items: readonly TestflightListItem[],
): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (const i of items) {
    if (i.tester && !out.some((o) => o.value === i.tester))
      out.push({ value: i.tester, label: testerLabel(i) });
  }
  return out;
}

/** What changed between an item and a draft of its triage (only the fields that differ; the server ignores the rest). */
export function triageDiff(
  item: Pick<TestflightItem, 'status' | 'assigneeUserId' | 'internalNote'>,
  draft: { status: TriageStatus; assigneeUserId: string | null; internalNote: string },
): TriageInput {
  const out: TriageInput = {};
  if (draft.status !== item.status) out.status = draft.status;
  if (draft.assigneeUserId !== item.assigneeUserId) out.assigneeUserId = draft.assigneeUserId;
  const note = draft.internalNote.trim() === '' ? null : draft.internalNote;
  if (note !== (item.internalNote ?? null)) out.internalNote = note;
  return out;
}

/** The state of the last sync as one line and a tone. */
export function syncLine(
  sync: TestflightSync | null,
  now: number,
): { text: string; tone: 'neutral' | 'warn' | 'bad' } {
  if (sync === null || (sync.lastSyncedAt === null && sync.lastError === null))
    return { text: t('testflight:sync.never'), tone: 'neutral' };
  if (sync.lastError !== null) {
    const error = sync.lastError;
    if (sync.lastSyncedAt === null)
      return { text: t('testflight:sync.failedNothing', { error }), tone: 'bad' };
    return {
      text: t('testflight:sync.failedKept', { ago: timeAgo(sync.lastSyncedAt, now), error }),
      tone: 'bad',
    };
  }
  const ago = timeAgo(sync.lastSyncedAt ?? now, now);
  if (!sync.complete) return { text: t('testflight:sync.partial', { ago }), tone: 'warn' };
  return { text: t('testflight:sync.read', { ago }), tone: 'neutral' };
}

/**
 * The app's TestFlight page in App Store Connect, or null without the Apple id. The `/apps/<id>/testflight` path is UNVERIFIED (Apple documents
 * no addresses of its console); the app page `/apps/<id>` is the one the other link-outs of Kiln use, and TestFlight is one click from it.
 */
export function testflightConsoleUrl(storeAppId: string | null): string | null {
  const id = (storeAppId ?? '').trim();
  return /^\d+$/.test(id) ? `${APP_STORE_CONNECT_URL}/apps/${id}/testflight` : null;
}

/** Whether a screenshot link has expired (or is about to, within the margin). */
export const linkExpired = (
  link: Pick<ScreenshotLink, 'expiresAt'>,
  now: number,
  marginMs = 30_000,
): boolean => link.expiresAt !== null && link.expiresAt - marginMs <= now;
