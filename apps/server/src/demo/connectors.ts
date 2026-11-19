import type {
  AnalyticsPoint,
  AppleAccessType,
  AppleAnalyticsPort,
  AppleInstanceRef,
  AppleReportRef,
  AppleReportRequest,
  ListReviewsResult,
  PlayReportsPort,
  PlayVitalsPort,
  ReadStoreListingOptions,
  StoreApp,
  StoreBuild,
  StoreConnector,
  StoreListing,
  StoreReviewConnector,
  StoreVersion,
} from '@mrm/connectors';
import { StoreError, createFakeAiClient } from '@mrm/connectors';
import type { AiAnswerLike } from './ai-answers.ts';
import { aiAnswer } from './ai-answers.ts';
import { COMPETITORS, DEMO_APPS, KEYWORDS, type Platform, REVIEW_LINES, LANGS, langOf } from './content.ts';
import { dailySeries, rng } from './data.ts';
import { failing } from './failures.ts';
import { iconPng } from './images.ts';
import type { AnalyticsConnectorFactory } from '../services/analytics-sync.ts';
import type { AsoSources, LookupInput, PublicApp, SearchInput, SearchOutcome } from '../services/aso-net.ts';
import type { Exchange } from '../services/safe-fetch.ts';
import type { DemoWorld, Side } from './world.ts';

const DAY = 86_400_000;

/** The read-only store connector the app sync uses: versions, builds and the listing, from the demo world. */
class DemoReadStore implements StoreConnector {
  readonly platform: Platform;
  readonly #side: Side;
  readonly #kind: 'app_store_connect' | 'google_play';
  readonly #world: DemoWorld;
  constructor(world: DemoWorld, side: Side, kind: 'app_store_connect' | 'google_play') {
    this.#world = world;
    this.#side = side;
    this.platform = side.platform;
    this.#kind = kind;
  }
  async verifyCredentials() {}
  async listApps(): Promise<StoreApp[]> {
    const out: StoreApp[] = [];
    for (const app of DEMO_APPS) {
      if (this.#kind === 'google_play') {
        if (app.platforms.includes('android')) out.push({ storeId: app.identifier, platform: 'android', name: app.name, bundleId: app.identifier });
      } else {
        const platforms = app.platforms.filter((p) => p !== 'android');
        if (platforms.length > 0) out.push({ storeId: app.appleId, platform: platforms[0] as Platform, name: app.name, bundleId: app.identifier, platforms });
      }
    }
    return out;
  }
  async listVersions(): Promise<StoreVersion[]> {
    this.#world.repo.tick();
    return this.#side.listVersions();
  }
  async listBuilds(): Promise<StoreBuild[]> {
    this.#world.repo.tick();
    return this.#side.listBuilds();
  }
  async readListing(_id: string, _options?: ReadStoreListingOptions): Promise<StoreListing> {
    const side = this.#side;
    if (!side.apple) {
      const locales: Record<string, Record<string, string>> = {};
      for (const [l, fields] of Object.entries(side.liveTexts)) locales[l] = { ...fields };
      return { platform: 'android', appStoreId: side.storeId, warnings: [], channels: [{ channel: 'live', listing: { googlePlay: { locales, changelogs: {} } } }] };
    }
    const live = side.versions.find((v) => v.state === 'READY_FOR_DISTRIBUTION');
    const editable = side.editableVersion();
    const channels: StoreListing['channels'] = [];
    if (live) channels.push({ channel: 'live', versionString: live.versionString, versionRawState: live.state, infoRawState: 'READY_FOR_DISTRIBUTION', listing: { appStore: { locales: structuredClone(side.liveTexts) } } });
    if (editable) channels.push({ channel: 'editable', versionString: editable.versionString, versionRawState: editable.state, infoRawState: 'PREPARE_FOR_SUBMISSION', listing: { appStore: { locales: side.editableTexts() } } });
    return { platform: side.platform === 'macos' ? 'macos' : 'ios', appStoreId: side.storeId, warnings: [], channels };
  }
}

export type DemoSeams = ReturnType<typeof createSeams>;

/** Everything `createApp` takes as a seam, backed by the demo world. */
export function createSeams(world: DemoWorld) {
  const store = <T extends object>(kind: 'app_store_connect' | 'google_play', thing: T): T => failing(thing, world.failures, kind === 'google_play' ? 'googleplay' : 'appstoreconnect');
  type In = { kind: 'app_store_connect' | 'google_play'; identifier: string; platform?: Platform };
  const sideOf = (input: In) => world.sideFor(input.kind, input.identifier, input.platform);

  const repo = failing(world.repo, world.failures, 'github');

  const reviewFactory = (input: In): StoreReviewConnector & { replyLimit: number } & Record<string, unknown> => {
    const side = sideOf(input);
    return store(input.kind, side.reply) as never;
  };

  return {
    store,
    repo,
    connectorFactory: () => repo,
    syncFactory: (input: In): StoreConnector => store(input.kind, new DemoReadStore(world, sideOf(input), input.kind)),
    draftFactory: (input: In) => store(input.kind, sideOf(input).draft),
    submitFactory: (input: In) => store(input.kind, sideOf(input).submit),
    releaseFactory: (input: In) => store(input.kind, sideOf(input).release),
    rolloutFactory: (input: In) => store(input.kind, sideOf(input).rollout),
    reviewFactory,
    ratingFetcher: null,
    analytics: createAnalytics(world),
    aso: createAsoSources(world),
    ai: (): ReturnType<typeof createFakeAiClient> =>
      failing(
        createFakeAiClient({
          provider: 'anthropic',
          model: 'demo-model',
          models: [{ id: 'demo-model', label: 'Demo model (built in, no network)' }],
          answers: (request): AiAnswerLike => {
            world.calls.ai += 1;
            return aiAnswer(request);
          },
        }),
        world.failures,
        'ai',
      ),
    translateFetch: createTranslateFetch(world),
    exchange: createExchange(),
    resolve: async () => [{ address: '93.184.216.34', family: 4 as const }],
    verifiers: () => async () => ({ ok: true, message: 'Demo credential: nothing was sent to any service.', details: ['Stores, GitHub and AI are simulated in demo mode.'] }),
  };
}

// ---- translation -------------------------------------------------------------------------------------------------------

function createTranslateFetch(world: DemoWorld): typeof fetch {
  // Known review lines translate back to English; everything else gets a visible marker.
  const english = new Map<string, string>();
  for (const lang of LANGS) {
    for (const group of ['good', 'mid', 'bad'] as const) {
      const lines = REVIEW_LINES[lang][group];
      lines.forEach((line, i) => {
        const en = REVIEW_LINES.en[group][i % REVIEW_LINES.en[group].length];
        if (en) {
          english.set(line.title, en.title);
          english.set(line.body, en.body);
        }
      });
    }
  }
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const board = world.failures.take('translation');
    if (board) {
      const status = board === 'rate_limit' ? 429 : board === 'auth' || board === 'forbidden' ? 403 : 503;
      return new Response(JSON.stringify({ error: { message: 'demo failure' } }), { status, headers: board === 'rate_limit' ? { 'retry-after': '30' } : {} });
    }
    world.calls.translate += 1;
    const body = JSON.parse(String(init?.body ?? '{}')) as { q?: string[]; target?: string };
    const target = (body.target ?? 'en').toLowerCase();
    const out = (body.q ?? []).map((q) => ({ translatedText: target.startsWith('en') ? (english.get(q) ?? `[en] ${q}`) : `[${target}] ${q}`, detectedSourceLanguage: 'de' }));
    void input;
    return new Response(JSON.stringify({ data: { translations: out } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

// ---- the network: only what the app icon lookup needs ---------------------------------------------------------------

function createExchange(): Exchange {
  return async (request) => {
    const url = request.url;
    if (url.hostname === 'itunes.apple.com') {
      const id = url.searchParams.get('id') ?? '';
      const app = DEMO_APPS.find((a) => a.appleId === id);
      const results = app ? [{ trackId: Number(id), trackName: app.name, artworkUrl512: `https://is1-ssl.mzstatic.com/demo/${app.key}/512x512bb.png` }] : [];
      return { status: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ resultCount: results.length, results })), overflow: false };
    }
    const m = /^\/demo\/([a-z]+)\//.exec(url.pathname);
    const app = DEMO_APPS.find((a) => a.key === m?.[1]);
    if (url.hostname.endsWith('mzstatic.com') && app) return { status: 200, headers: { 'content-type': 'image/png' }, body: iconPng(app, 512), overflow: false };
    return { status: 404, headers: {}, body: new Uint8Array(), overflow: false };
  };
}

// ---- analytics ---------------------------------------------------------------------------------------------------------

const tsv = (rows: (string | number)[][]) => `${rows.map((r) => r.join('\t')).join('\n')}\n`;

class DemoApple implements AppleAnalyticsPort {
  readonly #byRequest = new Map<string, string>();
  #n = 0;
  async listRequests(appStoreId: string): Promise<AppleReportRequest[]> {
    return [...this.#byRequest].filter(([, app]) => app === appStoreId).map(([id]) => ({ id, accessType: 'ONGOING', stoppedDueToInactivity: false }));
  }
  async createRequest(appStoreId: string, accessType: AppleAccessType): Promise<AppleReportRequest> {
    const id = `req-${appStoreId}-${++this.#n}`;
    this.#byRequest.set(id, appStoreId);
    return { id, accessType, stoppedDueToInactivity: false };
  }
  async listReports(requestId: string): Promise<AppleReportRef[]> {
    const app = this.#appOf(requestId);
    return ['App Store Discovery and Engagement Standard', 'App Store Downloads Standard', 'App Sessions Standard', 'App Crashes Standard'].map((name, i) => ({ id: `rep-${app}-${i}`, name, category: i < 2 ? 'APP_STORE_ENGAGEMENT' : 'APP_USAGE' }));
  }
  #appOf(requestId: string): string {
    return this.#byRequest.get(requestId) ?? requestId.split('-')[1] ?? '';
  }
  async listInstances(reportId: string): Promise<AppleInstanceRef[]> {
    return [{ id: `inst-${reportId.slice(4)}`, granularity: 'DAILY', processingDate: new Date(Date.now() - DAY).toISOString().slice(0, 10) }];
  }
  async readInstance(instanceId: string): Promise<{ texts: string[]; segments: number; bytes: number }> {
    const [, appId, index] = instanceId.split('-') as [string, string, string];
    const text = this.#table(appId, Number(index));
    return { texts: [text], segments: 1, bytes: text.length };
  }
  #table(appId: string, kind: number): string {
    const app = DEMO_APPS.find((a) => a.appleId === appId) ?? (DEMO_APPS[0] as (typeof DEMO_APPS)[number]);
    const scale = app.key === 'notes' ? 1 : app.key === 'weather' ? 1.4 : 0.35;
    const days = 90;
    const rows: (string | number)[][] = [];
    const impressions = dailySeries(`${app.key}:imp`, days, 5200 * scale, { trend: 0.35 });
    const views = dailySeries(`${app.key}:views`, days, 1100 * scale, { trend: 0.3 });
    const first = dailySeries(`${app.key}:first`, days, 240 * scale, { trend: 0.3 });
    const redl = dailySeries(`${app.key}:redl`, days, 90 * scale, { trend: 0.1 });
    const sessions = dailySeries(`${app.key}:sessions`, days, 9000 * scale, { trend: 0.25 });
    const versions = [app.live.replace(/\d+$/, '0'), app.live, app.next];
    if (kind === 0) {
      rows.push(['Date', 'Event', 'Page Type', 'Source Type', 'Engagement Type', 'Device', 'Platform Version', 'Territory', 'Counts', 'Unique Counts']);
      for (let i = 0; i < days; i++) {
        const d = (impressions[i] as { date: string; value: number }).date;
        const imp = (impressions[i] as { value: number }).value;
        rows.push([d, 'Impression', 'Search result', 'App Store Search', 'Get', 'iPhone', '18.1', 'US', Math.round(imp * 0.55), Math.round(imp * 0.4)]);
        rows.push([d, 'Impression', 'Today tab', 'App Store Browse', 'Get', 'iPhone', '18.1', 'US', Math.round(imp * 0.3), Math.round(imp * 0.24)]);
        rows.push([d, 'Impression', 'Search result', 'App Store Search', 'Get', 'iPad', '18.1', 'DE', Math.round(imp * 0.15), Math.round(imp * 0.1)]);
        rows.push([d, 'Page view', 'Product page view', 'App Store Search', 'Open', 'iPhone', '18.1', 'US', (views[i] as { value: number }).value, Math.round((views[i] as { value: number }).value * 0.8)]);
      }
    } else if (kind === 1) {
      rows.push(['Date', 'App Name', 'App Apple Identifier', 'Download Type', 'App Version', 'Device', 'Platform Version', 'Source Type', 'Source Info', 'Campaign', 'Page Type', 'Page Title', 'Pre-Order', 'Territory', 'Counts']);
      for (let i = 0; i < days; i++) {
        const d = (first[i] as { date: string }).date;
        rows.push([d, app.name, appId, 'First-time Download', app.live, 'iPhone', '18.1', 'App Store Search', '', '', 'Product page view', '', 'No', 'US', (first[i] as { value: number }).value]);
        rows.push([d, app.name, appId, 'Redownload', app.live, 'iPhone', '18.1', 'App Store Browse', '', '', 'Product page view', '', 'No', 'US', (redl[i] as { value: number }).value]);
      }
    } else if (kind === 2) {
      rows.push(['Date', 'App Name', 'App Apple Identifier', 'App Version', 'Device', 'Platform Version', 'Source Type', 'Territory', 'Sessions', 'Total Session Duration', 'Unique Devices']);
      for (let i = 0; i < days; i++) {
        const d = (sessions[i] as { date: string }).date;
        const total = (sessions[i] as { value: number }).value;
        versions.forEach((v, vi) => rows.push([d, app.name, appId, v, 'iPhone', '18.1', 'App Store Search', 'US', Math.round(total * [0.1, 0.8, 0.1][vi]!), Math.round(total * [0.1, 0.8, 0.1][vi]! * 140), Math.round(total * [0.1, 0.8, 0.1][vi]! * 0.4)]));
      }
    } else {
      rows.push(['Date', 'App Name', 'App Apple Identifier', 'App Version', 'Device', 'Platform Version', 'Crashes', 'Unique Devices']);
      const r = rng(`${app.key}:apple-crashes`);
      for (let i = 0; i < days; i++) {
        const d = (sessions[i] as { date: string }).date;
        const total = (sessions[i] as { value: number }).value;
        // The older version crashes more; the newest one has a bump after the 3.4 release.
        versions.forEach((v, vi) => {
          const rate = [0.012, 0.004, 0.009][vi]! * (1 + (r() - 0.5) * 0.4);
          const c = Math.round(total * [0.1, 0.8, 0.1][vi]! * rate);
          rows.push([d, app.name, appId, v, 'iPhone', '18.1', c, Math.round(c * 0.8)]);
        });
      }
    }
    return tsv(rows);
  }
  async fetchSalesReport(input: { vendorNumber: string; date: string }): Promise<string | null> {
    const header = ['Provider', 'Provider Country', 'SKU', 'Developer', 'Title', 'Version', 'Product Type Identifier', 'Units', 'Developer Proceeds', 'Begin Date', 'End Date', 'Customer Currency', 'Country Code', 'Currency of Proceeds', 'Apple Identifier', 'Customer Price', 'Promo Code', 'Parent Identifier', 'Subscription', 'Period', 'Category', 'CMB', 'Device', 'Supported Platforms'];
    const rows: (string | number)[][] = [header];
    const r = rng(`sales:${input.date}`);
    for (const app of DEMO_APPS.filter((a) => a.platforms.some((p) => p !== 'android'))) {
      const units = Math.round(10 + r() * 30);
      const date = `${input.date.slice(5, 7)}/${input.date.slice(8, 10)}/${input.date.slice(0, 4)}`;
      rows.push(['APPLE', 'US', app.key, 'Demo Studio', app.name, app.live, '1', units, (units * 2.1).toFixed(2), date, date, 'USD', 'US', 'USD', app.appleId, '2.99', '', '', '', '', 'Productivity', '', 'iPhone', 'iOS']);
    }
    return tsv(rows);
  }
}

function playPoints(app: (typeof DEMO_APPS)[number], metric: 'vitals' | 'reports'): AnalyticsPoint[] {
  const out: AnalyticsPoint[] = [];
  const days = 90;
  const scale = app.key === 'notes' ? 1 : 1.3;
  if (metric === 'vitals') {
    const r = rng(`${app.key}:play-crash`);
    const versions = [`${app.live.replace(/\d+$/, '0')}`, app.live];
    for (const date of dailySeries('x', days, 1).map((p) => p.date)) {
      versions.forEach((v, vi) => {
        const crash = [0.011, 0.0038][vi]! * (1 + (r() - 0.5) * 0.5);
        const anr = [0.004, 0.0015][vi]! * (1 + (r() - 0.5) * 0.5);
        out.push({ date, metric: 'crash_rate', value: crash, dimension: { type: 'app_version', value: v } });
        out.push({ date, metric: 'anr_rate', value: anr, dimension: { type: 'app_version', value: v } });
      });
      out.push({ date, metric: 'crash_rate', value: 0.0045 * (1 + (r() - 0.5) * 0.3) });
      out.push({ date, metric: 'anr_rate', value: 0.0018 * (1 + (r() - 0.5) * 0.3) });
    }
    return out;
  }
  const visitors = dailySeries(`${app.key}:visitors`, days, 1500 * scale, { trend: 0.25 });
  const installs = dailySeries(`${app.key}:installs`, days, 310 * scale, { trend: 0.3 });
  const uninstalls = dailySeries(`${app.key}:uninstalls`, days, 120 * scale, { trend: 0.1 });
  let active = 14_000 * scale;
  visitors.forEach((v, i) => {
    const inst = (installs[i] as { value: number }).value;
    const un = (uninstalls[i] as { value: number }).value;
    active += inst - un;
    const date = v.date;
    out.push({ date, metric: 'store_listing_visitors', value: v.value });
    out.push({ date, metric: 'store_listing_acquisitions', value: Math.round(inst * 1.1) });
    out.push({ date, metric: 'installs_user', value: inst });
    out.push({ date, metric: 'installs_device', value: Math.round(inst * 1.15) });
    out.push({ date, metric: 'uninstalls_device', value: un });
    out.push({ date, metric: 'active_installs_device', value: Math.round(active) });
    out.push({ date, metric: 'rating_average_daily', value: 4.4 + Math.sin(i / 9) * 0.15 });
    out.push({ date, metric: 'rating_average_total', value: 4.45 + (i / days) * 0.05 });
  });
  return out;
}

function createAnalytics(world: DemoWorld): AnalyticsConnectorFactory {
  const apple = failing(new DemoApple(), world.failures, 'analytics');
  const appOf = (packageName: string) => DEMO_APPS.find((a) => a.identifier === packageName) ?? (DEMO_APPS[0] as (typeof DEMO_APPS)[number]);
  return {
    apple: () => apple,
    playVitals: (input) =>
      failing(
        {
          async rates() {
            const points = playPoints(appOf(input.packageName), 'vitals');
            return { points, dataThrough: points[points.length - 1]?.date ?? null, rows: points.length };
          },
        } satisfies PlayVitalsPort,
        world.failures,
        'analytics',
      ),
    playReports: (input) =>
      failing(
        {
          async readMonth(month: string) {
            const all = playPoints(appOf(input.packageName), 'reports');
            const points = all.filter((p) => p.date.slice(0, 4) + p.date.slice(5, 7) === month);
            if (points.length === 0) throw Object.assign(new Error('reports_not_found'), { name: 'AnalyticsError', code: 'reports_not_found' });
            return {
              points,
              files: [{ report: 'installs' as const, name: `stats/installs/installs_${input.packageName}_${month}_overview.csv` }],
              missing: [],
              unmapped: [],
              stats: { rowsRead: points.length, rowsUsed: points.length, rowsUnreadable: 0, rowsFiltered: 0 },
            };
          },
        } satisfies PlayReportsPort,
        world.failures,
        'analytics',
      ),
  };
}

// ---- ASO ----------------------------------------------------------------------------------------------------------------

/** Public store data for the keyword and competitor tracking. Ranks drift deterministically with the (simulated) day. */
function createAsoSources(world: DemoWorld): AsoSources {
  const failingGuard = <T>(method: string, fn: () => T): T => {
    world.failures.before('aso', method);
    return fn();
  };
  const termIndex = new Map<string, { app: (typeof DEMO_APPS)[number]; i: number }>();
  for (const app of DEMO_APPS) KEYWORDS[app.key].forEach((k, i) => termIndex.set(`${k.country}|${k.term.toLowerCase()}`, { app, i }));
  const dayNumber = () => Math.floor(world.now() / DAY);
  const known = new Map<string, { name: string; kind: 'own' | 'rival'; key: string }>();
  for (const app of DEMO_APPS) {
    known.set(app.appleId, { name: app.name, kind: 'own', key: app.key });
    known.set(app.identifier, { name: app.name, kind: 'own', key: app.key });
    for (const c of COMPETITORS[app.key]) {
      known.set(c.id, { name: c.name, kind: 'rival', key: app.key });
      known.set(`com.rival.${c.name.toLowerCase().replace(/\s+/g, '')}`, { name: c.name, kind: 'rival', key: app.key });
    }
  }
  return {
    playEnabled: true,
    async search(input: SearchInput): Promise<SearchOutcome> {
      return failingGuard('search', () => {
        const hit = termIndex.get(`${input.country.toLowerCase()}|${input.term.toLowerCase()}`);
        const ids: string[] = [];
        const r = rng(`serp:${input.platform}:${input.country}:${input.term}`);
        const filler = (n: number) => (input.platform === 'ios' ? `1900${String(n).padStart(6, '0')}` : `com.filler.app${n}`);
        for (let i = 0; i < 24; i++) ids.push(filler(Math.floor(r() * 90_000)));
        if (hit) {
          const base = 3 + hit.i * 4;
          const drift = Math.round(Math.sin((dayNumber() + hit.i * 5) / 7) * 3 + ((dayNumber() % 60) - 30) / -15);
          const pos = Math.max(1, Math.min(30, base + drift));
          const own = input.platform === 'ios' ? hit.app.appleId : hit.app.identifier;
          const rivals = COMPETITORS[hit.app.key].map((c) => c.id);
          ids.splice(Math.min(ids.length, pos - 1), 0, own);
          if (input.platform === 'ios') rivals.forEach((id, i) => ids.splice(Math.min(ids.length, 1 + i * 6), 0, id));
        }
        const sliced = ids.slice(0, input.limit);
        return {
          hits: sliced.map((id) => (input.platform === 'ios' ? { id, name: known.get(id)?.name ?? `App ${id.slice(-4)}` } : { id })),
          total: ids.length,
          cached: false,
        };
      });
    },
    async lookup(input: LookupInput): Promise<PublicApp | undefined> {
      return failingGuard('lookup', () => {
        const entry = known.get(input.id);
        if (!entry) return undefined;
        const d = dayNumber();
        const stage = Math.floor(d / 17);
        const rival = entry.kind === 'rival';
        return {
          id: input.id,
          name: entry.name,
          version: `${1 + (stage % 4)}.${stage % 9}.${d % 3}`,
          price: 'Free',
          currency: 'USD',
          ratingMilli: 4300 + ((stage * 37) % 500),
          ratingCount: 8000 + (rival ? 400 : 150) * (d % 120),
          description: `${entry.name}: ${rival ? 'a popular alternative' : 'your own app'}. Edition ${stage}.`,
          iconUrl: `https://is1-ssl.mzstatic.com/demo/${entry.key}/512x512bb.png`,
          screenshotCount: 4 + (stage % 3),
          screenshotUrls: [1, 2, 3].map((n) => `https://is1-ssl.mzstatic.com/demo/${entry.key}/${stage}-${n}.png`),
        };
      });
    },
  };
}

