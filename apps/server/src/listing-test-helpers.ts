import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Platform } from '@mrm/core';
import {
  type ReadStoreListingOptions,
  type StoreApp,
  type StoreBuild,
  type StoreConnector,
  type StoreListing,
  type StoreVersion,
} from '@mrm/connectors';
import { bootRepoApp } from './repo-test-helpers.ts';
import type { StoreConnectorFactory } from './services/apps.ts';
import { forgetInspectedChangeSets } from './services/listing-repo.ts';
import { forgetRunningListingReads } from './services/listing-schedule.ts';

/**
 * Shared by listing-sections.test.ts and listing-schedule.test.ts. Not a test file itself.
 * Everything runs against fakes: no store and no GitHub is contacted.
 */

const KEY_LINE = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDTOPSECRETKEYBODY';
const PEM = `-----BEGIN PRIVATE KEY-----\n${KEY_LINE}\n-----END PRIVATE KEY-----`;
export const ASC_SECRET = JSON.stringify({ keyId: 'ABC123DEFG', issuerId: 'issuer-1', privateKey: PEM });
export const PLAY_SECRET = JSON.stringify({ client_email: 'bot@proj.iam.gserviceaccount.com', private_key: PEM });
export const LEAKS = [KEY_LINE, 'bot@proj.iam.gserviceaccount.com'];

export type Texts = Record<string, Record<string, string>>;
export type Sections = NonNullable<StoreListing['channels'][number]['sections']>;

export const iosListing = (live: Texts, sections?: Sections, extra: StoreListing['warnings'] = []): StoreListing => ({
  platform: 'ios',
  appStoreId: '1234567890',
  warnings: extra,
  channels: [
    {
      channel: 'live',
      versionString: '2.0',
      listing: { appStore: { locales: live } },
      ...(sections ? { sections } : {}),
    },
  ],
});

export const playListing = (locales: Texts, sections?: Sections, extra: StoreListing['warnings'] = []): StoreListing => ({
  platform: 'android',
  appStoreId: 'com.acme.app',
  warnings: extra,
  channels: [
    {
      channel: 'live',
      listing: { googlePlay: { locales, changelogs: {} } },
      ...(sections ? { sections } : {}),
    },
  ],
});

/** A store connector with a programmable listing. */
export class FakeStore implements StoreConnector {
  readonly platform: Platform;
  listing: StoreListing | undefined;
  error: unknown;
  calls: string[] = [];
  options: (ReadStoreListingOptions | undefined)[] = [];
  /** Held until released, to keep a read in flight. */
  gate?: Promise<void>;
  readListing: (id: string, options?: ReadStoreListingOptions) => Promise<StoreListing>;
  constructor(platform: Platform) {
    this.platform = platform;
    this.readListing = async (id, options) => {
      this.calls.push(`readListing:${id}`);
      this.options.push(options);
      if (this.gate) await this.gate;
      if (this.error) throw this.error;
      if (!this.listing) throw new Error('no listing set');
      return this.listing;
    };
  }
  async verifyCredentials() {}
  async listApps(): Promise<StoreApp[]> {
    return [{ storeId: '1234567890', platform: 'ios', name: 'Acme', bundleId: 'com.acme.app' }];
  }
  async listVersions(): Promise<StoreVersion[]> {
    return [];
  }
  async listBuilds(): Promise<StoreBuild[]> {
    return [];
  }
}

export async function bootListing(db: Parameters<typeof bootRepoApp>[0]) {
  const stores = { ios: new FakeStore('ios'), android: new FakeStore('android') };
  const factory: StoreConnectorFactory = (input) =>
    input.kind === 'app_store_connect' ? stores.ios : stores.android;
  const masterKey = randomBytes(32);
  const t = await bootRepoApp(db, undefined, {
    masterKey,
    appSync: { connectorFactory: factory },
    listing: { intervalMs: 60 * 60_000 },
  });
  forgetInspectedChangeSets();
  forgetRunningListingReads();
  const iosCredential = await t.addCredential('app_store_connect', ASC_SECRET);
  const playCredential = await t.addCredential('google_play', PLAY_SECRET);
  const addApp = async (body: Record<string, unknown>) =>
    (await t.call(t.owner, 'POST', '/apps', body)).body.app.id as string;
  const addIos = (extra: Record<string, unknown> = {}) =>
    addApp({ platform: 'ios', identifier: 'com.acme.app', credentialId: iosCredential, ...extra });
  const addAndroid = (extra: Record<string, unknown> = {}) =>
    addApp({ platform: 'android', identifier: 'com.acme.app', credentialId: playCredential, ...extra });
  const sync = (id: string, cookie = t.owner) => t.call(cookie, 'POST', `/apps/${id}/sync`);
  const live = (id: string, cookie = t.owner) => t.call(cookie, 'GET', `/apps/${id}/listing/live`);
  const drift = (id: string, cookie = t.owner) => t.call(cookie, 'GET', `/apps/${id}/listing/drift`);
  const history = (id: string, query = '', cookie = t.owner) =>
    t.call(cookie, 'GET', `/apps/${id}/listing/history${query}`);
  const refresh = (id: string, cookie = t.owner) => t.call(cookie, 'POST', `/apps/${id}/listing/repo-refresh`);
  const noLeaks = () => {
    for (const text of t.texts) for (const leak of LEAKS) assert.ok(!text.includes(leak), `leaked ${leak.slice(0, 10)}`);
  };
  /** The snapshot rows of an app, by stream, to see what was recorded. */
  const rows = (appId: string, where = '') =>
    t.db.query(
      `SELECT source, channel, locale, field, value FROM listing_snapshots WHERE app_id = ? ${where} ORDER BY observed_at, id`,
      [appId],
    );
  return {
    ...t,
    masterKey,
    factory,
    stores,
    iosCredential,
    playCredential,
    addIos,
    addAndroid,
    sync,
    live,
    drift,
    history,
    refresh,
    noLeaks,
    rows,
  };
}

export type ListingBoot = Awaited<ReturnType<typeof bootListing>>;

export const EN_US = { name: 'Acme App', subtitle: 'Old subtitle', description: 'A description that is long enough.' };

/** A set of sections as App Store Connect would give them for a live iOS version. */
export const iosSections = (overrides: Partial<Sections> = {}): Sections => ({
  categories: { primary: 'PRODUCTIVITY', secondary: 'BUSINESS' },
  ageRating: { rating: 'FOUR_PLUS', answers: { violenceCartoonOrFantasy: 'NONE', gambling: false } },
  privacy: { choicesUrls: { 'en-US': 'https://acme.example/choices' } },
  details: { copyright: '2026 Acme' },
  media: {
    screenshots: {
      'en-US': [{ type: 'APP_IPHONE_67', count: 3, names: ['a.png', 'b.png', 'c.png'] }],
    },
    previews: {},
  },
  ...overrides,
});
