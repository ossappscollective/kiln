import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { Database } from '@kiln/db';
import {
  ADS_ACCOUNT,
  ADS_ACLS,
  ADS_CAMPAIGN_REPORT,
  ADS_KEYWORD_REPORT,
  ADS_POPULARITY,
  ADS_SEARCHTERM_REPORT,
  ADS_TOKEN,
} from '../../../../../packages/connectors/src/apple/ads.fixtures.ts';
import { bootMonetization } from '../monetization/test-helpers.ts';

/** A fake Apple Ads and a booted server with an Apple Ads credential and store fakes. Not a test file. Nothing here touches a network. */

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
export const ADS_PEM = privateKey.export({ type: 'sec1', format: 'pem' }).toString();
export const ADS_IDS = {
  clientId: 'SEARCHADS.aeb3ef5f-0c5a-4f2a-99c8',
  teamId: 'SEARCHADS.hgw3ef3p-0w7a-8a2n-77c8',
  keyId: 'a273d0d3-4d9e-458c-a173-0db8619ca7d7',
};
export const ADS_SECRET = JSON.stringify({ ...ADS_IDS, privateKey: ADS_PEM });
/** The Apple id the campaign fixtures promote. */
export const ADS_ADAM = '987654321';
export const ADS_ACCOUNT_ID = '123456789';
/** A fixed "now" (the afternoon of 2026-11-23) so the sync range is the same on every machine. */
export const ADS_NOW = Date.UTC(2026, 10, 23, 14, 0, 0);

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export type AdsCall = {
  method: string;
  host: string;
  path: string;
  context: string;
  authorization: string;
  body: unknown;
};

export class FakeAppleAds {
  calls: AdsCall[] = [];
  tokenStatus = 200;
  acls: unknown = ADS_ACLS;
  account: unknown = ADS_ACCOUNT;
  campaigns: unknown = ADS_CAMPAIGN_REPORT;
  terms: unknown = ADS_SEARCHTERM_REPORT;
  keywords: unknown = ADS_KEYWORD_REPORT;
  popularity: unknown = ADS_POPULARITY;
  /** Answers handed out, in order, instead of the normal one: a Response, or an Error to throw. */
  next: (Response | Error)[] = [];

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    this.calls.push({
      method: init?.method ?? 'GET',
      host: url.host,
      path: url.pathname,
      context: headers['x-ap-context'] ?? '',
      authorization: headers.authorization ?? '',
      body:
        init?.body && url.pathname !== '/auth/oauth2/token'
          ? JSON.parse(String(init.body))
          : undefined,
    });
    const queued = this.next.shift();
    if (queued instanceof Error) throw queued;
    if (queued) return queued;
    if (url.pathname === '/auth/oauth2/token') {
      return this.tokenStatus === 200
        ? json(ADS_TOKEN)
        : json({ error: 'invalid_client' }, this.tokenStatus);
    }
    const path = url.pathname.replace(/^\/v1/, '');
    if (path === '/acls') return json(this.acls);
    if (path === `/ad-accounts/${ADS_ACCOUNT_ID}`) return json(this.account);
    if (path === '/reports/apps/campaigns/query') return json(this.campaigns);
    if (path === '/reports/apps/searchterms/query') return json(this.terms);
    if (path === '/reports/apps/keywords/query') return json(this.keywords);
    if (path === '/insights/apps/search-term-popularity/query') return json(this.popularity);
    return json({ error: { code: 'not_found' } }, 404);
  };

  /** Every call that is not the token request. */
  get api() {
    return this.calls.filter((c) => c.path !== '/auth/oauth2/token');
  }
}

export async function bootAds(db: Database, adsDeps: Record<string, unknown> = {}) {
  const ads = new FakeAppleAds();
  const masterKey = randomBytes(32);
  let clock = ADS_NOW;
  const t = await bootMonetization(
    db,
    {},
    {
      masterKey,
      now: () => ++clock,
      credentialTests: { fetch: ads.fetch },
      ads: { fetch: ads.fetch, sleep: async () => undefined, ...adsDeps },
    },
  );
  const adsCredential = await t.addCredential('apple_ads', ADS_SECRET);
  const base = (appId: string, rest = '') => `/apps/${appId}/ads${rest}`;
  const link = (appId: string, body: Record<string, unknown> = {}, cookie = t.owner) =>
    t.call(cookie, 'PUT', base(appId), {
      credentialId: adsCredential,
      adAccountId: ADS_ACCOUNT_ID,
      adamId: ADS_ADAM,
      ...body,
    });
  /** A linked iOS app record. */
  const linked = async () => {
    const appId = await t.addApp('ios');
    const res = await link(appId);
    if (res.status !== 200) throw new Error(`link ${res.status}: ${res.text}`);
    return appId;
  };
  /** Runs the sync the way the worker does: through the queued job's payload and the handler. */
  const runSync = async (appId: string, cookie = t.owner) => {
    const res = await t.call(cookie, 'POST', base(appId, '/sync'));
    if (res.status !== 202) return { res, ran: false as const };
    const [job] = await db.query(
      "SELECT payload FROM jobs WHERE queue = 'ads.sync' AND status = 'queued' ORDER BY created_at DESC",
    );
    const { createAdsSyncHandler } = await import('./sync.ts');
    await createAdsSyncHandler({
      db,
      masterKey,
      now: () => ++clock,
      deps: { fetch: ads.fetch, sleep: async () => undefined, ...adsDeps },
    })(JSON.parse(String(job?.payload)), {} as never);
    await db.execute("UPDATE jobs SET status = 'done' WHERE queue = 'ads.sync'");
    return { res, ran: true as const };
  };
  const get = (appId: string, rest: string, cookie = t.owner) =>
    t.call(cookie, 'GET', base(appId, rest));
  const count = async (table: string) =>
    Number((await db.query(`SELECT COUNT(*) AS n FROM ${table}`))[0]?.n);
  /** Everything that could leak the key: every response text of the test, the credentials and audit rows, and every Apple Ads table. */
  const everything = async () => {
    const parts: string[] = [...t.texts];
    for (const table of [
      'credentials',
      'audit_events',
      'app_ads_links',
      'ads_sync',
      'ads_campaign_daily',
      'ads_term_daily',
      'ads_term_popularity',
    ]) {
      const rows = await db.query(`SELECT * FROM ${table}`);
      parts.push(JSON.stringify(rows.map(({ ciphertext: _c, ...rest }) => rest)));
    }
    return parts.join('\n');
  };
  return {
    ...t,
    ads,
    adsCredential,
    masterKey,
    base,
    link,
    linked,
    runSync,
    get,
    count,
    everything,
  };
}
export type AdsBoot = Awaited<ReturnType<typeof bootAds>>;
