import { randomBytes } from 'node:crypto';
import { AsoError } from '@mrm/connectors';
import type { Database } from '@mrm/db';
import { bootRepoApp } from '../../repo-test-helpers.ts';
import { ASC_SECRET, PLAY_SECRET } from '../../review-test-helpers.ts';
import { createTestLimiter } from '../../services/credential-tests.ts';
import type { AsoSources, LookupInput, PublicApp, SearchInput, SearchOutcome } from './net.ts';
import { type AsoContext, type AsoLimits, DEFAULT_ASO_LIMITS } from './service.ts';

/** Shared by the ASO tests. Everything runs against a fake store: nothing is ever contacted. */

export const OWN_IOS_ID = '1234567890';
export const OWN_PLAY_ID = 'com.acme.android';

/** A store that answers from tables and remembers every call. */
export class FakeAsoSources implements AsoSources {
  playEnabled: boolean;
  searches: SearchInput[] = [];
  lookups: LookupInput[] = [];
  /** `platform|country|term` (term lower case) -> app ids in result order. */
  results = new Map<string, string[]>();
  /** `platform|country|id` -> the app. */
  apps = new Map<string, PublicApp>();
  /** Thrown by the next `search` (or `lookup`) calls while set. */
  searchError: unknown;
  lookupError: unknown;
  /** A call waits for this before it answers (to hold a refresh in flight). */
  gate: Promise<void> | undefined;
  /** Names shown in the results (id -> name), as Apple gives them. */
  names = new Map<string, string>();

  constructor(playEnabled = false) {
    this.playEnabled = playEnabled;
  }

  setResults(platform: 'ios' | 'android', country: string, term: string, ids: string[]) {
    this.results.set(`${platform}|${country}|${term.toLowerCase()}`, ids);
  }
  setApp(platform: 'ios' | 'android', country: string, app: PublicApp) {
    this.apps.set(`${platform}|${country}|${app.id}`, app);
  }

  async search(input: SearchInput): Promise<SearchOutcome> {
    this.searches.push(input);
    if (this.gate) await this.gate;
    if (this.searchError) throw this.searchError;
    const ids = (
      this.results.get(`${input.platform}|${input.country}|${input.term.toLowerCase()}`) ?? []
    ).slice(0, input.limit);
    return {
      hits: ids.map((id) =>
        input.platform === 'ios' ? { id, name: this.names.get(id) ?? `App ${id}` } : { id },
      ),
      total: ids.length,
      cached: false,
    };
  }

  async lookup(input: LookupInput): Promise<PublicApp | undefined> {
    this.lookups.push(input);
    if (this.gate) await this.gate;
    if (this.lookupError) throw this.lookupError;
    return this.apps.get(`${input.platform}|${input.country}|${input.id}`);
  }
}

export const publicApp = (id: string, over: Partial<PublicApp> = {}): PublicApp => ({
  id,
  name: `Rival ${id}`,
  version: '1.0.0',
  price: 'Free',
  currency: 'USD',
  ratingMilli: 4500,
  ratingCount: 1000,
  description: `A description of ${id}`,
  iconUrl: `https://example.invalid/icon/${id}.png`,
  screenshotCount: 3,
  screenshotUrls: ['a', 'b', 'c'].map((x) => `https://example.invalid/${id}/${x}.png`),
  ...over,
});

export const unavailable = (
  reason: 'layout_changed' | 'blocked' | 'redirect' | 'disabled' = 'layout_changed',
) => new AsoError('play_public', 'unavailable', 'The page changed.', { reason });
export const slowDown = (retryAfterSeconds = 60, withStatus = true) =>
  new AsoError('apple_search', 'rate_limited', 'Slow down.', {
    ...(withStatus ? { status: 429 } : {}),
    retryAfterSeconds,
  });

type Deps = Partial<Parameters<typeof import('../../app.ts').createApp>[0]>;

export async function bootAso(
  db: Database,
  options: {
    limits?: Partial<AsoLimits>;
    playEnabled?: boolean;
    app?: Deps;
    maxRunMs?: number;
    limiterLimit?: number;
  } = {},
) {
  const sources = new FakeAsoSources(options.playEnabled ?? false);
  const limits: AsoLimits = { ...DEFAULT_ASO_LIMITS, ...(options.limits ?? {}) };
  let clock = Date.UTC(2026, 5, 10, 12, 0, 0);
  const clockState = { now: () => ++clock, advance: (ms: number) => void (clock += ms) };
  const t = await bootRepoApp(db, undefined, {
    masterKey: randomBytes(32),
    now: clockState.now,
    aso: {
      sources,
      limits,
      limiter: createTestLimiter({ limit: options.limiterLimit ?? 1000, now: clockState.now }),
      ...(options.maxRunMs !== undefined ? { maxRunMs: options.maxRunMs } : {}),
    },
    ...options.app,
  });
  const ios = await t.addCredential('app_store_connect', ASC_SECRET);
  const play = await t.addCredential('google_play', PLAY_SECRET);
  let count = 0;
  const addApp = async (platform: 'ios' | 'android' = 'ios', name?: string) => {
    count += 1;
    const identifier =
      platform === 'ios'
        ? count === 1
          ? 'com.acme.app'
          : `com.acme.app${count}`
        : count === 1
          ? OWN_PLAY_ID
          : `com.acme.android${count}`;
    const res = await t.call(t.owner, 'POST', '/apps', {
      platform,
      identifier,
      credentialId: platform === 'ios' ? ios : play,
      name: name ?? `App ${count}`,
    });
    const id = res.body.app.id as string;
    if (platform === 'ios')
      await db.execute('UPDATE apps SET store_app_id = ? WHERE id = ?', [
        count === 1 ? OWN_IOS_ID : String(1000 + count),
        id,
      ]);
    return id;
  };
  const ctx = (): AsoContext => ({
    db,
    now: clockState.now,
    sources,
    limits,
    ...(options.maxRunMs !== undefined ? { maxRunMs: options.maxRunMs } : {}),
  });
  const events = async (type?: string) =>
    (await t.call(t.owner, 'GET', `/events?since=0&limit=200${type ? `&type=${type}` : ''}`)).body
      .events as { type: string; subject: { appId?: string }; payload: Record<string, unknown> }[];
  const addKeywords = async (
    appId: string,
    keywords: {
      term: string;
      country?: string;
      locale?: string;
      tag?: string;
      notes?: string;
      priority?: number;
    }[],
    cookie = t.owner,
  ) => t.call(cookie, 'POST', `/apps/${appId}/aso/keywords`, { keywords });
  const refresh = async (appId: string, query = '', cookie = t.owner) =>
    t.call(cookie, 'POST', `/apps/${appId}/aso/refresh${query}`);
  /** Everything the database holds that a person did not type as a keyword: audit rows, events, jobs. */
  const trail = async () => {
    const audit = await db.query('SELECT action, target_type, target_id, detail FROM audit_events');
    const evts = await db.query('SELECT type, payload FROM events');
    const jobs = await db.query('SELECT queue, payload FROM jobs');
    return JSON.stringify({ audit, evts, jobs });
  };
  return {
    ...t,
    sources,
    limits,
    clock: clockState,
    addApp,
    ctx,
    events,
    addKeywords,
    refresh,
    trail,
    iosCredential: ios,
    playCredential: play,
  };
}
export type AsoBoot = Awaited<ReturnType<typeof bootAso>>;
