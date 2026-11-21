import { randomBytes } from 'node:crypto';
import type { Database } from '@kiln/db';
import {
  apps as rcApps,
  entitlement,
  errorBody,
  KEY,
  list,
  offering,
  packageOf,
  PROJECT_ID,
  product,
  project,
} from '../../../../../packages/connectors/src/revenuecat/revenuecat.fixtures.ts';
import { bootMonetization } from '../monetization/test-helpers.ts';

/** A fake RevenueCat and a booted server with a RevenueCat credential and store fakes. Not a test file. Nothing here touches a network. */

export { errorBody, KEY as REVENUECAT_KEY, PROJECT_ID };

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export type RcCall = { method: string; path: string; query: URLSearchParams; authorization: string };

/** Answers like RevenueCat REST v2: projects, apps, and the three configuration lists. `next` makes the following calls answer something else. */
export class FakeRevenueCat {
  calls: RcCall[] = [];
  projects: unknown[] = [project()];
  apps: unknown[] = [];
  products: unknown[] = [];
  entitlements: unknown[] = [];
  offerings: unknown[] = [];
  /** Answers handed out, in order, instead of the normal one: a Response, or an Error to throw. */
  next: (Response | Error)[] = [];

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    this.calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      authorization: headers.authorization ?? '',
    });
    const queued = this.next.shift();
    if (queued instanceof Error) throw queued;
    if (queued) return queued;
    return json(this.answer(url.pathname.replace('/v2', '')));
  };

  private answer(path: string): unknown {
    const base = `/projects/${PROJECT_ID}`;
    if (path === '/projects') return list(this.projects);
    if (path === `${base}/apps`) return list(this.apps);
    const one = path.match(new RegExp(`^${base}/apps/([^/]+)$`));
    if (one) {
      const found = this.apps.find((a) => (a as { id: string }).id === one[1]);
      return found ?? errorBody('resource_missing');
    }
    if (path === `${base}/products`) return list(this.products);
    if (path === `${base}/entitlements`) return list(this.entitlements);
    if (path === `${base}/offerings`) return list(this.offerings);
    return errorBody('resource_missing');
  }

  /** RevenueCat apps of every kind, with the identifiers of an app record. */
  seedApps(identifier: string) {
    this.apps = [
      { ...rcApps.ios, app_store: { bundle_id: identifier } },
      { ...rcApps.mac, mac_app_store: { bundle_id: `${identifier}.mac` } },
      { ...rcApps.play, play_store: { package_name: identifier } },
      rcApps.stripe,
    ];
  }

  /** A project that sells the fake store's products: iOS coins and Pro monthly, Play Pro monthly, one RevenueCat product the store lacks. */
  seedConfiguration() {
    const ios = rcApps.ios.id;
    const play = rcApps.play.id;
    const coins = product('rc_coins', 'com.acme.coins100', ios, { type: 'consumable', subscription: null });
    const pro = product('rc_pro', 'com.acme.pro.monthly', ios);
    const ghost = product('rc_ghost', 'com.acme.ghost', ios);
    const playPro = product('rc_play_pro', 'pro_monthly:monthly', play);
    const playYear = product('rc_play_year', 'pro_monthly:yearly', play);
    this.products = [coins, pro, ghost, playPro, playYear];
    this.entitlements = [entitlement('ent_pro', 'pro', [pro, playPro]), entitlement('ent_empty', 'unused', [])];
    this.offerings = [
      offering('ofr_default', 'default', [
        packageOf('pk_m', '$rc_monthly', 1, [pro, { product: playPro, eligibility_criteria: 'google_sdk_ge_6' }]),
        packageOf('pk_c', 'coins', 2, [coins]),
      ]),
    ];
  }
}

export async function bootRevenueCat(
  db: Database,
  overrides: NonNullable<Parameters<typeof bootMonetization>[2]> = {},
  revenuecatDeps: NonNullable<NonNullable<Parameters<typeof bootMonetization>[2]>['revenuecat']> = {},
) {
  const rc = new FakeRevenueCat();
  const t = await bootMonetization(db, {}, {
    masterKey: randomBytes(32),
    // The generic credential test calls the verifier with the network it was given.
    credentialTests: { fetch: rc.fetch },
    revenuecat: { fetch: rc.fetch, ...revenuecatDeps },
    ...overrides,
  });
  const rcCredential = await t.addCredential('revenuecat', KEY);
  const identifierOf = async (appId: string) =>
    String((await db.query('SELECT identifier FROM apps WHERE id = ?', [appId]))[0]?.identifier);
  const base = (appId: string, rest = '') => `/apps/${appId}/revenuecat${rest}`;
  const put = (appId: string, body: unknown, cookie = t.owner) => t.call(cookie, 'PUT', base(appId), body);
  const detect = (appId: string, query: string, cookie = t.owner) => t.call(cookie, 'GET', base(appId, `/detect?${query}`));
  const rcSync = (appId: string, cookie = t.owner) => t.call(cookie, 'POST', base(appId, '/sync'));
  const view = (appId: string, cookie = t.owner) => t.call(cookie, 'GET', base(appId, '/products'));
  /** Seeds RevenueCat for an app record, links it, and returns the app id. */
  const linked = async (platform: 'ios' | 'android' | 'macos', rcAppId?: string) => {
    const appId = await t.addApp(platform);
    rc.seedApps(await identifierOf(appId));
    rc.seedConfiguration();
    const res = await put(appId, {
      credentialId: rcCredential,
      projectId: PROJECT_ID,
      revenueCatAppId: rcAppId ?? (platform === 'android' ? rcApps.play.id : platform === 'macos' ? rcApps.mac.id : rcApps.ios.id),
    });
    if (res.status !== 200) throw new Error(`link ${res.status}: ${res.text}`);
    return appId;
  };
  /** Everything that could leak the key: every response text of the test, the credentials and audit rows, and every other table. */
  const everything = async () => {
    const parts: string[] = [...t.texts];
    for (const table of [
      'credentials',
      'audit_events',
      'app_revenuecat_links',
      'revenuecat_products',
      'revenuecat_entitlements',
      'revenuecat_offerings',
      'revenuecat_sync',
      'store_product_sync',
    ]) {
      const rows = await db.query(`SELECT * FROM ${table}`);
      parts.push(JSON.stringify(rows.map(({ ciphertext: _c, ...rest }) => rest)));
    }
    return parts.join('\n');
  };
  const rcAudit = async () =>
    (await t.auditActions()).filter((a) => a.action.startsWith('revenuecat.') || a.action === 'credential.use');
  return { ...t, rc, rcCredential, identifierOf, base, put, detect, rcSync, view, linked, everything, rcAudit };
}
export type RevenueCatBoot = Awaited<ReturnType<typeof bootRevenueCat>>;
