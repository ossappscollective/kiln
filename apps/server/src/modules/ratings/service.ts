// Adapted in part from Open Screenshot Generator (MIT), see THIRD_PARTY_NOTICES.md
import { supports } from '@kiln/core';
import type { Sql } from '@kiln/db';
import type { ManagedApp } from '../../services/apps.ts';
import { emitEvent } from '../../services/events.ts';
import { getSourceStates, readDaily } from '../analytics/store.ts';
import { crashMention } from './crash-words.ts';
import { alpha2 } from './countries.ts';
import { addDays, dayRange, type Granularity } from './days.ts';
import {
  type Finding,
  type HealthData,
  type Store,
  type VersionDay,
  dailyRates,
  compare,
  finding,
  steady,
  versionHealth,
} from './health.ts';
import {
  type Reading,
  countryRows,
  ratingBuckets,
  reviewBuckets,
  starSum,
  territoriesOf,
} from './history.ts';
import {
  type RatingRow,
  readCountryDays,
  readRatingDays,
  readReviewsLite,
  reviewTerritories,
  writeRatingDay,
} from './store.ts';

export type RatingsApp = {
  id: string;
  workspaceId: string;
  platform: ManagedApp['platform'];
  storeAppId: string | null;
};
export const storeOf = (app: { platform: ManagedApp['platform'] }): Store =>
  app.platform === 'android' ? 'googleplay' : 'appstoreconnect';
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

type Ctx = { db: Sql; now: () => number };

// ---------------------------------------------------------------------------------------------
// Recording (called by the review sync: no scheduler of its own)

export type RatingLookup = (input: {
  appStoreId: string;
  country: string;
  platform?: 'macos';
}) => Promise<{ country: string; averageRating?: number; ratingCount?: number } | undefined>;
/** Countries read per sync: Apple allows about 20 lookups a minute, so the rest wait for the next sync (oldest reading first). */
export const MAX_COUNTRIES_PER_SYNC = 8;

/** Which storefronts to read next: United States first, the countries already read, then the countries of the reviews; the ones read longest ago first. */
export function pickCountries(
  known: { territory: string; last: string }[],
  fromReviews: string[],
  today: string,
  max = MAX_COUNTRIES_PER_SYNC,
): string[] {
  const last = new Map(known.map((k) => [k.territory, k.last]));
  const wanted = [
    'US',
    ...known.map((k) => k.territory),
    ...fromReviews.map((t) => alpha2(t) ?? ''),
  ].filter((c, i, all) => c && all.indexOf(c) === i);
  return wanted
    .filter((c) => last.get(c) !== today)
    .sort((a, b) =>
      a === 'US' ? -1 : b === 'US' ? 1 : (last.get(a) ?? '').localeCompare(last.get(b) ?? ''),
    )
    .slice(0, max);
}

/** Apple: one lookup per chosen storefront, written as today's reading. A failure of one lookup leaves that country for the next sync. */
export async function recordAppleRatings(
  ctx: Ctx,
  app: RatingsApp,
  lookup: RatingLookup,
  known?: { country: string; averageRating?: number; ratingCount?: number },
): Promise<number> {
  if (!supports(app.platform, 'storeWideRating') || !app.storeAppId) return 0;
  const today = dayOf(ctx.now());
  const countries = pickCountries(
    await readCountryDays(ctx.db, app.id, 'appstoreconnect'),
    await reviewTerritories(ctx.db, app.workspaceId, app.id),
    today,
  );
  const rows: RatingRow[] = [];
  const add = (
    s: { country: string; averageRating?: number; ratingCount?: number } | undefined,
  ) => {
    if (s && s.averageRating !== undefined && s.ratingCount !== undefined)
      rows.push({
        territory: s.country.toUpperCase(),
        average: s.averageRating,
        count: s.ratingCount,
      });
  };
  if (known) add(known);
  for (const country of countries) {
    if (known && known.country.toUpperCase() === country) continue;
    try {
      add(
        await lookup({
          appStoreId: app.storeAppId,
          country,
          ...(app.platform === 'macos' ? { platform: 'macos' as const } : {}),
        }),
      );
    } catch {
      break; // rate limited or offline: the rest waits for the next sync
    }
  }
  if (rows.length > 0)
    await writeRatingDay(ctx.db, {
      workspaceId: app.workspaceId,
      appId: app.id,
      store: 'appstoreconnect',
      day: today,
      at: ctx.now(),
      rows,
    });
  return rows.length;
}

// ---------------------------------------------------------------------------------------------
// Reading

const clampDays = (v: number | undefined) => Math.min(730, Math.max(7, Math.round(v ?? 90)));

async function googleReadings(
  db: Sql,
  app: RatingsApp,
  from: string,
  to: string,
): Promise<Reading[]> {
  const rows = await readDaily(db, {
    workspaceId: app.workspaceId,
    appId: app.id,
    platform: app.platform,
    from,
    to,
  });
  const daily = new Map(
    rows.filter((r) => r.metric === 'rating_average_daily').map((r) => [r.day, r.value]),
  );
  return rows
    .filter((r) => r.metric === 'rating_average_total' && r.value > 0)
    .map((r) => ({
      day: r.day,
      territory: 'ALL',
      average: r.value,
      count: null,
      stars: null,
      dayAverage: daily.get(r.day) ?? null,
    }));
}

export type RatingsView = Awaited<ReturnType<typeof ratingsView>>;

export async function ratingsView(
  ctx: Ctx,
  app: RatingsApp,
  o: { country?: string; granularity?: Granularity; days?: number },
) {
  const store = storeOf(app);
  const to = dayOf(ctx.now());
  const from = addDays(to, -(clampDays(o.days) - 1));
  const granularity = o.granularity ?? (clampDays(o.days) > 120 ? 'week' : 'day');
  // History from before the window is needed for the first difference, so it is read whole (a few rows a day at most).
  const readings =
    store === 'googleplay'
      ? await googleReadings(ctx.db, app, addDays(from, -400), to)
      : await readRatingDays(ctx.db, app.workspaceId, app.id, store);
  const countries = territoriesOf(readings);
  const country =
    o.country && o.country !== 'all' && countries.includes(o.country) ? o.country : 'all';
  const reviews = await readReviewsLite(
    ctx.db,
    app.workspaceId,
    app.id,
    Date.parse(`${from}T00:00:00Z`),
  );
  const region = (r: { territory: string | null }) =>
    country === 'all' ? true : alpha2(r.territory) === country;
  const written = reviewBuckets(
    reviews
      .filter(region)
      .map((r) => ({
        day: r.day,
        rating: r.rating,
        territory: country === 'all' ? null : country,
      })),
    { country: 'all', granularity, from, to },
  );
  const buckets = ratingBuckets(readings, { country, granularity, from, to });
  const inWindow = buckets.filter((b) => b.end >= from);
  const newCount = inWindow.reduce((t, b) => t + b.newCount, 0);
  const last = [...buckets].reverse().find((b) => b.average !== null);
  const stars = written.reduce((t, b) => b.stars.map((v, i) => v + t[i]!), [0, 0, 0, 0, 0]);
  return {
    store,
    from,
    to,
    granularity,
    country,
    countries: countryRows(readings, from, to),
    historyStart: readings.length > 0 ? readings.map((r) => r.day).sort()[0]! : null,
    /** The counts and the stars are the store's own only where the store gives them: Apple a count, Google neither. */
    capabilities: { count: store === 'appstoreconnect', stars: false },
    summary: {
      average: last?.average ?? null,
      count: last?.count ?? null,
      newCount,
      // Needs two readings of the country: with fewer there is nothing to subtract.
      newRatingsKnown: readings.length > 0 && new Set(readings.map((r) => r.day)).size > 1,
      written: {
        count: stars.reduce((a, b) => a + b, 0),
        stars,
        average:
          stars.reduce((a, b) => a + b, 0) > 0
            ? starSum(stars as [number, number, number, number, number]) /
              stars.reduce((a, b) => a + b, 0)
            : null,
      },
    },
    buckets,
    written,
  };
}

// ---------------------------------------------------------------------------------------------
// Health

async function healthData(db: Sql, app: RatingsApp, from: string, to: string): Promise<HealthData> {
  const store = storeOf(app);
  const rows = await readDaily(db, {
    workspaceId: app.workspaceId,
    appId: app.id,
    platform: app.platform,
    from,
    to,
    dimension: 'app_version',
  });
  const key = new Map<string, VersionDay>();
  const crashDays = new Set<string>();
  const at = (day: string, version: string) => {
    const k = `${day}|${version}`;
    let v = key.get(k);
    if (!v) key.set(k, (v = { day, version }));
    return v;
  };
  for (const r of rows) {
    const v = at(r.day, r.dimValue);
    if (r.metric === 'sessions') v.sessions = r.value;
    else if (r.metric === 'crashes') {
      v.crashes = r.value;
      crashDays.add(r.day);
    } else if (
      r.metric === 'crash_rate_perceived' ||
      (r.metric === 'crash_rate' && v.crashRate === undefined)
    )
      v.crashRate = r.value;
    else if (r.metric === 'crash_users') v.users = r.value;
    else if (
      r.metric === 'anr_rate_perceived' ||
      (r.metric === 'anr_rate' && v.anrRate === undefined)
    )
      v.anrRate = r.value;
    else if (r.metric === 'anr_users') v.anrUsers = r.value;
  }
  return { store, points: [...key.values()], crashDays };
}

/** Google Play names a build in vitals; its reviews say both the build and the version, so a build is named after its reviews. */
function buildNames(
  reviews: { version: string | null; build: string | null }[],
): Map<string, string> {
  const tally = new Map<string, Map<string, number>>();
  for (const r of reviews) {
    if (!r.build || !r.version) continue;
    const m = tally.get(r.build) ?? new Map<string, number>();
    m.set(r.version, (m.get(r.version) ?? 0) + 1);
    tally.set(r.build, m);
  }
  return new Map([...tally].map(([b, m]) => [b, [...m].sort((x, y) => y[1] - x[1])[0]![0]]));
}

export type HealthView = Awaited<ReturnType<typeof healthView>>;

export async function healthView(ctx: Ctx, app: RatingsApp, o: { days?: number }) {
  const store = storeOf(app);
  const to = dayOf(ctx.now());
  const from = addDays(to, -(clampDays(o.days) - 1));
  const data = await healthData(ctx.db, app, addDays(from, -60), to);
  const reviews = await readReviewsLite(
    ctx.db,
    app.workspaceId,
    app.id,
    Date.parse(`${addDays(from, -60)}T00:00:00Z`),
  );
  const names = store === 'googleplay' ? buildNames(reviews) : new Map<string, string>();
  const versions = versionHealth(data);
  const sources = await getSourceStates(ctx.db, app.workspaceId, app.id, app.platform);
  const source = sources.get(store === 'googleplay' ? 'play_vitals' : 'apple_analytics');
  const reviewsOf = (version: string) =>
    reviews.filter((r) => (store === 'googleplay' ? r.build === version : r.version === version));
  const rows = versions.map((v, i) => {
    const older = versions.slice(i + 1).find((x) => steady(x.crash));
    const change = older ? compare(store, 'crash', v, older) : null;
    const own = reviewsOf(v.version);
    return {
      version: v.version,
      name: store === 'googleplay' ? (names.get(v.version) ?? null) : v.version,
      from: v.from,
      to: v.to,
      crash: { ...v.crash, steady: steady(v.crash) },
      freeze: v.freeze ? { ...v.freeze, steady: steady(v.freeze) } : null,
      change: change
        ? {
            kind: change.kind,
            previous: change.previous,
            before: change.before,
            after: change.after,
            overLine: change.overLine,
          }
        : null,
      reviews: own.length,
      crashReviews: own.filter((r) => crashMention(r.title, r.body)).length,
    };
  });
  const found: Finding | null = finding(store, versions);
  const days = dayRange(from, to);
  const mentionsByDay = new Map<string, number>();
  for (const r of reviews)
    if (crashMention(r.title, r.body))
      mentionsByDay.set(r.day, (mentionsByDay.get(r.day) ?? 0) + 1);
  const mention = found
    ? reviewsOf(found.version).filter((r) => r.day >= found.from && crashMention(r.title, r.body))
        .length
    : 0;
  return {
    store,
    from,
    to,
    /** `perSessions`: the App Store's rate is crashes for every session (draw it per 1,000); `share`: Google's is a share of users. */
    unit: store === 'appstoreconnect' ? 'perSessions' : 'share',
    /** Where the numbers stand: the stored state of the source, so the screen can say what to turn on. */
    setup: source
      ? {
          setupCode: source.setupCode,
          lastErrorCode: source.lastErrorCode,
          lastOkAt: source.lastOkAt,
        }
      : null,
    hasData: data.points.length > 0,
    days: dailyRates(data, days).map((d) => ({
      ...d,
      crashMentions: mentionsByDay.get(d.day) ?? 0,
    })),
    versions: rows,
    finding: found
      ? {
          ...found,
          name: store === 'googleplay' ? (names.get(found.version) ?? null) : found.version,
          mentions: mention,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------------------------
// The alert: one event per version that crashes clearly more than the one before it

/** Emits `health.crash_regression` once per app and version (an earlier event of the same version is looked up). Returns whether one was emitted. */
export async function evaluateHealth(ctx: Ctx, app: RatingsApp): Promise<boolean> {
  try {
    const view = await healthView(ctx, app, { days: 30 });
    const f = view.finding;
    if (!f || f.kind !== 'worse' || f.measure !== 'crash') return false;
    const seen = await ctx.db.query(
      `SELECT 1 AS x FROM events WHERE workspace_id = ? AND type = 'health.crash_regression' AND app_id = ? AND payload LIKE ? LIMIT 1`,
      [app.workspaceId, app.id, `%"version":${JSON.stringify(f.version)}%`],
    );
    if (seen.length > 0) return false;
    await emitEvent(ctx.db, {
      workspaceId: app.workspaceId,
      type: 'health.crash_regression',
      subject: { appId: app.id },
      payload: {
        appId: app.id,
        platform: app.platform,
        version: f.version,
        versionName: f.name,
        previous: f.previous,
        before: f.before,
        after: f.after,
      },
      at: ctx.now(),
    });
    return true;
  } catch {
    return false;
  }
}
