// Adapted from Open Screenshot Generator (MIT), see THIRD_PARTY_NOTICES.md
//
// App health: how often an app crashes and freezes, by version, from each store's own numbers (docs/api/health.md).
//   App Store: App Analytics "App Crashes" over "App Sessions", opted-in people only, crashes per session (shown per 1,000 sessions). Apple sends
//     crash numbers only for days with at least 5 crashing users, so a day without them is NOT a day without crashes: a rate is taken over the
//     days a crash file answered for, and a version with crash numbers for under 75% of its days is not compared. No freeze numbers per day.
//   Google Play: Android vitals, the user-perceived crash and ANR rate (share of the day's users) with the users each divides by (rounded by Google).
// The regression rule (the only place it is written): the newest version with steady numbers against the newest older one that has them, crashes
// before freezes. It is "worse" when the rate is at least 1.5 times the earlier one AND at least MIN_STEP higher (1 crash per 1,000 sessions on the
// App Store, 0.2 percentage points on Google Play), or on Google Play when it crossed Google's line (1.09% crashes, 0.47% freezes). "Steady" means at
// least 200 sessions (App Store) or 200 user-days (Google Play) behind the rate.
import { dayRange } from './days.ts';

export type Store = 'appstoreconnect' | 'googleplay';
export const GOOGLE_CRASH_LINE = 0.0109;
export const GOOGLE_FREEZE_LINE = 0.0047;
export const MIN_VOLUME = 200;
export const MIN_COVERAGE = 0.75;
export const RISE = 1.5;
export const MIN_STEP: Record<Store, number> = { appstoreconnect: 0.001, googleplay: 0.002 };

/** One version on one day; only the fields its store has. */
export type VersionDay = {
  day: string;
  /** The version string (Apple) or the build number (Google). */
  version: string;
  sessions?: number;
  crashes?: number;
  crashRate?: number;
  users?: number;
  anrRate?: number;
  anrUsers?: number;
};

export type Rate = {
  rate: number | null;
  volume: number;
  events?: number;
  days?: number;
  coveredDays?: number;
};

/** Days a crash file answered for: any day with crash numbers of any version. */
export type HealthData = { store: Store; points: VersionDay[]; crashDays: Set<string> };

function rateOver(
  data: HealthData,
  days: string[],
  version: string | null,
  measure: 'crash' | 'freeze',
): Rate | null {
  const set = new Set(days);
  const pts = data.points.filter(
    (p) => set.has(p.day) && (version === null || p.version === version),
  );
  if (data.store === 'appstoreconnect') {
    if (measure === 'freeze') return null;
    let sessions = 0;
    let crashes = 0;
    const used = new Set<string>();
    const covered = new Set<string>();
    for (const p of pts) {
      if ((p.sessions ?? 0) > 0) used.add(p.day);
      if (!data.crashDays.has(p.day)) continue;
      if ((p.sessions ?? 0) > 0) covered.add(p.day);
      sessions += p.sessions ?? 0;
      crashes += p.crashes ?? 0;
    }
    return {
      rate: sessions > 0 ? crashes / sessions : null,
      volume: sessions,
      events: crashes,
      days: used.size,
      coveredDays: covered.size,
    };
  }
  let users = 0;
  let weighted = 0;
  for (const p of pts) {
    const rate = measure === 'crash' ? p.crashRate : p.anrRate;
    const u = measure === 'crash' ? p.users : p.anrUsers;
    if (rate === undefined || !u) continue;
    users += u;
    weighted += rate * u;
  }
  return { rate: users > 0 ? weighted / users : null, volume: users };
}

export const partial = (r: Rate | null): boolean =>
  !!r && r.days !== undefined && r.coveredDays !== undefined && r.coveredDays < r.days;

/** Whether a rate rests on enough sessions or users to compare, and on the App Store on enough of its days. */
export function steady(r: Rate | null): r is Rate & { rate: number } {
  if (!r || r.rate === null || r.volume < MIN_VOLUME) return false;
  return !partial(r) || (r.coveredDays ?? 0) / (r.days ?? 1) >= MIN_COVERAGE;
}

export type VersionHealth = {
  version: string;
  from: string;
  to: string;
  crash: Rate;
  freeze: Rate | null;
};

const numeric = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** Newest first: the highest version number (Apple) or build number (Google), never the first day seen. */
export function versionHealth(data: HealthData): VersionHealth[] {
  const spans = new Map<string, { from: string; to: string }>();
  for (const p of data.points) {
    if (!(p.sessions || p.users || p.anrUsers)) continue;
    const s = spans.get(p.version);
    if (!s) spans.set(p.version, { from: p.day, to: p.day });
    else {
      if (p.day < s.from) s.from = p.day;
      if (p.day > s.to) s.to = p.day;
    }
  }
  return [...spans.entries()]
    .map(([version, s]) => {
      const days = dayRange(s.from, s.to);
      return {
        version,
        from: s.from,
        to: s.to,
        crash: rateOver(data, days, version, 'crash')!,
        freeze: rateOver(data, days, version, 'freeze'),
      };
    })
    .sort((a, b) => numeric(b.version, a.version));
}

export type Finding = {
  kind: 'worse' | 'better';
  measure: 'crash' | 'freeze';
  version: string;
  previous: string;
  before: number;
  after: number;
  overLine: boolean;
  from: string;
  to: string;
};

export function compare(
  store: Store,
  measure: 'crash' | 'freeze',
  v: VersionHealth,
  prev: VersionHealth,
): Finding | null {
  const now = measure === 'crash' ? v.crash : v.freeze;
  const then = measure === 'crash' ? prev.crash : prev.freeze;
  if (!steady(now) || !steady(then)) return null;
  const after = now.rate;
  const before = then.rate;
  const line = measure === 'crash' ? GOOGLE_CRASH_LINE : GOOGLE_FREEZE_LINE;
  const overLine = store === 'googleplay' && after >= line && before < line;
  const base = {
    measure,
    version: v.version,
    previous: prev.version,
    before,
    after,
    from: v.from,
    to: v.to,
  };
  if (overLine || (after >= before * RISE && after - before >= MIN_STEP[store]))
    return { kind: 'worse', ...base, overLine };
  if (before >= after * RISE && before - after >= MIN_STEP[store])
    return { kind: 'better', ...base, overLine: false };
  return null;
}

export function finding(store: Store, versions: VersionHealth[]): Finding | null {
  for (const measure of ['crash', 'freeze'] as const) {
    const list = versions.filter((v) => steady(measure === 'crash' ? v.crash : v.freeze));
    if (list.length < 2) continue;
    const found = compare(store, measure, list[0]!, list[1]!);
    if (found) return found;
  }
  return null;
}

/** One day of the app as a whole, for the chart: crashes per session (App Store) or share of users (Google Play). */
export function dailyRates(
  data: HealthData,
  days: string[],
): { day: string; crash: number | null; freeze: number | null }[] {
  return days.map((day) => ({
    day,
    crash: rateOver(data, [day], null, 'crash')?.rate ?? null,
    freeze: rateOver(data, [day], null, 'freeze')?.rate ?? null,
  }));
}
