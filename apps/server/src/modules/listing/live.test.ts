import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  type StoreApp,
  type StoreBuild,
  type StoreConnector,
  StoreError,
  type StoreListing,
  type StoreVersion,
} from '@kiln/connectors';
import type { Platform } from '@kiln/core';
import { dbTest } from '@kiln/db/testing';
import { bootRepoApp, type FakeRepo } from '../../repo-test-helpers.ts';
import type { StoreConnectorFactory } from '../../services/apps.ts';
import { forgetInspectedChangeSets } from './repo.ts';

// Everything runs against fakes: no store and no GitHub is contacted.

const KEY_LINE = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDTOPSECRETKEYBODY';
const PEM = `-----BEGIN PRIVATE KEY-----\n${KEY_LINE}\n-----END PRIVATE KEY-----`;
const ASC_SECRET = JSON.stringify({ keyId: 'ABC123DEFG', issuerId: 'issuer-1', privateKey: PEM });
const PLAY_SECRET = JSON.stringify({
  client_email: 'bot@proj.iam.gserviceaccount.com',
  private_key: PEM,
});
const LEAKS = [KEY_LINE, 'bot@proj.iam.gserviceaccount.com'];

type Texts = Record<string, Record<string, string>>;

const iosListing = (live: Texts, editable?: Texts): StoreListing => ({
  platform: 'ios',
  appStoreId: '1234567890',
  warnings: [],
  channels: [
    { channel: 'live', versionString: '2.0', listing: { appStore: { locales: live } } },
    ...(editable
      ? [
          {
            channel: 'editable' as const,
            versionString: '2.1',
            listing: { appStore: { locales: editable } },
          },
        ]
      : []),
  ],
});

const playListing = (locales: Texts): StoreListing => ({
  platform: 'android',
  appStoreId: 'com.acme.app',
  warnings: [],
  channels: [{ channel: 'live', listing: { googlePlay: { locales, changelogs: {} } } }],
});

/** A store connector with a programmable listing. `withListing: false` is a connector without readListing. */
class FakeStore implements StoreConnector {
  readonly platform: Platform;
  listing: StoreListing | undefined;
  error: unknown;
  calls: string[] = [];
  readListing?: (id: string) => Promise<StoreListing>;
  constructor(platform: Platform, withListing = true) {
    this.platform = platform;
    if (withListing) {
      this.readListing = async (id) => {
        this.calls.push(`readListing:${id}`);
        if (this.error) throw this.error;
        if (!this.listing) throw new Error('no listing set');
        return this.listing;
      };
    }
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

async function boot(
  db: Parameters<typeof bootRepoApp>[0],
  options: { withListing?: boolean } = {},
) {
  const stores = {
    ios: new FakeStore('ios', options.withListing ?? true),
    android: new FakeStore('android', options.withListing ?? true),
  };
  const factory: StoreConnectorFactory = (input) =>
    input.kind === 'app_store_connect' ? stores.ios : stores.android;
  const t = await bootRepoApp(db, undefined, {
    masterKey: randomBytes(32),
    appSync: { connectorFactory: factory },
  });
  forgetInspectedChangeSets();
  const iosCredential = await t.addCredential('app_store_connect', ASC_SECRET);
  const playCredential = await t.addCredential('google_play', PLAY_SECRET);
  const addApp = async (body: Record<string, unknown>) =>
    (await t.call(t.owner, 'POST', '/apps', body)).body.app.id as string;
  const addIos = (extra: Record<string, unknown> = {}) =>
    addApp({ platform: 'ios', identifier: 'com.acme.app', credentialId: iosCredential, ...extra });
  const addAndroid = (extra: Record<string, unknown> = {}) =>
    addApp({
      platform: 'android',
      identifier: 'com.acme.app',
      credentialId: playCredential,
      ...extra,
    });
  const sync = (id: string, cookie = t.owner) => t.call(cookie, 'POST', `/apps/${id}/sync`);
  const live = (id: string, cookie = t.owner) => t.call(cookie, 'GET', `/apps/${id}/listing/live`);
  // The repository comparison is opt-in per app (listing settings): the tests below that look at it switch it on first.
  const plainDrift = (id: string, cookie = t.owner) =>
    t.call(cookie, 'GET', `/apps/${id}/listing/drift`);
  const drift = async (id: string, cookie = t.owner) => {
    await t.call(t.owner, 'PUT', `/apps/${id}/listing-settings`, {
      compareRepo: true,
      compareMedia: true,
    });
    return plainDrift(id, cookie);
  };
  const history = (id: string, query = '', cookie = t.owner) =>
    t.call(cookie, 'GET', `/apps/${id}/listing/history${query}`);
  const refresh = (id: string, cookie = t.owner) =>
    t.call(cookie, 'POST', `/apps/${id}/listing/repo-refresh`);
  const noLeaks = () => {
    for (const text of t.texts)
      for (const leak of LEAKS) assert.ok(!text.includes(leak), `leaked ${leak.slice(0, 10)}`);
  };
  return {
    ...t,
    stores,
    iosCredential,
    playCredential,
    addIos,
    addAndroid,
    sync,
    live,
    drift,
    plainDrift,
    history,
    refresh,
    noLeaks,
  };
}

type Field = {
  locale: string;
  field: string;
  limit: number | null;
  status: string;
  missingIn?: string;
  repo: { value: string | null };
  db: { value: string | null; source: string | null };
  live: { value: string | null };
  problems: { repo: { code: string }[]; live: { code: string; limit?: number }[] };
};
const fieldsOf = (body: { locales: { locale: string; fields: Field[] }[] }) =>
  Object.fromEntries(
    body.locales.flatMap((l) => l.fields.map((f) => [`${l.locale}/${f.field}`, f])),
  );

const REPO_EN = {
  name: 'Acme App',
  subtitle: 'Old subtitle',
  description: 'A description that is long enough.',
};

const setRepoSubtitle = (repo: FakeRepo, text: string) => {
  repo.files.set('fastlane/metadata/en-US/subtitle.txt', `${text}\n`);
};

// ---------------------------------------------------------------------------------------------
// Sync records the live listing

dbTest(
  'a sync reads the live listing and records snapshots only when a value changes',
  async (db) => {
    const t = await boot(db);
    const id = await t.addIos();
    t.stores.ios.listing = iosListing({
      'en-US': { ...REPO_EN, keywords: 'a,b' },
      'de-DE': { name: 'Acme' },
    });

    const first = await t.sync(id);
    assert.equal(first.status, 200);
    assert.ok(!('listing' in first.body), 'the sync response is unchanged');
    assert.deepEqual(t.stores.ios.calls, ['readListing:1234567890']);

    const live = await t.live(id);
    assert.equal(live.status, 200);
    assert.equal(live.body.platform, 'ios');
    assert.equal(live.body.error, null);
    assert.equal(typeof live.body.readAt, 'number');
    assert.equal(live.body.channels.length, 1);
    assert.equal(live.body.channels[0].channel, 'live');
    assert.equal(live.body.channels[0].sourceRef, '2.0');
    assert.deepEqual(live.body.channels[0].locales, {
      'de-DE': { name: 'Acme' },
      'en-US': { ...REPO_EN, keywords: 'a,b' },
    });
    const rows = async () =>
      (await db.query('SELECT field FROM listing_snapshots WHERE app_id = ?', [id])).length;
    assert.equal(await rows(), 5);

    // Nothing changed: nothing recorded.
    assert.equal((await t.sync(id)).status, 200);
    assert.equal(await rows(), 5);

    // One value changed, one field was removed, one locale appears.
    t.stores.ios.listing = iosListing({
      'en-US': { ...REPO_EN, subtitle: 'New subtitle' },
      'de-DE': { name: 'Acme' },
      'fr-FR': { name: 'Acme FR' },
    });
    await t.sync(id);
    assert.equal(await rows(), 5 + 1 + 1 + 1);
    const hist = await t.history(id, '?locale=en-US&field=subtitle');
    assert.deepEqual(
      hist.body.items.map((i: { value: string; source: string; sourceRef: string }) => [
        i.value,
        i.source,
        i.sourceRef,
      ]),
      [
        ['New subtitle', 'store', '2.0'],
        ['Old subtitle', 'store', '2.0'],
      ],
    );
    const removed = await t.history(id, '?locale=en-US&field=keywords');
    assert.deepEqual(
      removed.body.items.map((i: { value: string | null }) => i.value),
      [null, 'a,b'],
    );
    const after = await t.live(id);
    assert.equal(
      after.body.channels[0].locales['en-US'].keywords,
      undefined,
      'a removed field is gone from the live values',
    );
    t.noLeaks();
  },
);

dbTest(
  'the editable version is its own channel, and a channel that disappears is recorded as removed',
  async (db) => {
    const t = await boot(db);
    const id = await t.addIos();
    t.stores.ios.listing = iosListing(
      { 'en-US': { name: 'Coffee' } },
      { 'en-US': { name: 'Coffee Pro' } },
    );
    await t.sync(id);
    const both = await t.live(id);
    assert.deepEqual(
      both.body.channels.map((c: { channel: string; sourceRef: string }) => [
        c.channel,
        c.sourceRef,
      ]),
      [
        ['live', '2.0'],
        ['editable', '2.1'],
      ],
    );
    assert.equal(both.body.channels[1].locales['en-US'].name, 'Coffee Pro');
    // The drift view compares the live copy.
    assert.equal((await t.drift(id)).body.channel, 'live');
    // The editable version was released: the live copy now says Pro and there is no editable one.
    t.stores.ios.listing = iosListing({ 'en-US': { name: 'Coffee Pro' } });
    await t.sync(id);
    const after = await t.live(id);
    assert.deepEqual(
      after.body.channels.map((c: { channel: string }) => c.channel),
      ['live'],
    );
    const names = await t.history(id, '?locale=en-US&field=name');
    assert.ok(
      names.body.items.some(
        (i: { channel: string; value: string | null }) =>
          i.channel === 'editable' && i.value === null,
      ),
    );
  },
);

dbTest('an app with no live version is compared against its editable copy', async (db) => {
  const t = await boot(db);
  const id = await t.addIos();
  t.stores.ios.listing = {
    platform: 'ios',
    appStoreId: '1234567890',
    warnings: [],
    channels: [
      {
        channel: 'editable',
        versionString: '1.0',
        listing: { appStore: { locales: { 'en-US': { name: 'Acme App' } } } },
      },
    ],
  };
  await t.sync(id);
  const d = (await t.drift(id)).body;
  assert.equal(d.channel, 'editable');
  assert.equal(fieldsOf(d)['en-US/name']?.live.value, 'Acme App');
});

dbTest('Google Play listings are recorded with the Play fields only', async (db) => {
  const t = await boot(db);
  const id = await t.addAndroid();
  t.stores.android.listing = playListing({
    'en-US': { title: 'Coffee', short_description: 'Brew', full_description: 'The best.' },
  });
  assert.equal((await t.sync(id)).status, 200);
  assert.deepEqual(t.stores.android.calls, ['readListing:com.acme.app']);
  const live = await t.live(id);
  assert.deepEqual(live.body.channels[0].locales, {
    'en-US': { title: 'Coffee', short_description: 'Brew', full_description: 'The best.' },
  });
  assert.equal(live.body.channels[0].sourceRef, null);
  // A field of the other store is not a field of this app.
  assert.equal((await t.history(id, '?field=subtitle')).status, 400);
  assert.equal((await t.history(id, '?field=short_description')).status, 200);
});

// ---------------------------------------------------------------------------------------------
// Best effort

dbTest(
  'a listing read that fails does not fail the sync, and is remembered as listing_error',
  async (db) => {
    const t = await boot(db);
    const id = await t.addIos();
    t.stores.ios.listing = iosListing({ 'en-US': { name: 'Coffee' } });
    await t.sync(id);
    const readAt = (await t.live(id)).body.readAt;

    t.stores.ios.error = new StoreError(
      'appstoreconnect',
      'unexpected',
      `App Store Connect answered reading the listing of app 1 with HTTP 400 (PARAMETER_ERROR.ILLEGAL: A given parameter is not allowed for this request (parameter: limit)) ${KEY_LINE}`,
      400,
    );
    const failed = await t.sync(id);
    assert.equal(failed.status, 200, 'the release sync succeeded');
    assert.equal(failed.body.app.lastSyncError, null, 'and says so');
    const live = await t.live(id);
    assert.match(live.body.error, /parameter: limit/);
    assert.ok(!live.text.includes(KEY_LINE), 'redacted');
    assert.equal(live.body.readAt, readAt, 'the last good read is kept');
    assert.equal(live.body.channels[0].locales['en-US'].name, 'Coffee');

    // A plain exception is not explained.
    t.stores.ios.error = new Error(`boom ${KEY_LINE}`);
    await t.sync(id);
    assert.equal(
      (await t.live(id)).body.error,
      'The listing could not be read. Try again in a moment.',
    );

    t.stores.ios.error = undefined;
    await t.sync(id);
    assert.equal((await t.live(id)).body.error, null, 'the next success clears it');
    t.noLeaks();
  },
);

dbTest('a connector without readListing is skipped without a trace', async (db) => {
  const t = await boot(db, { withListing: false });
  const id = await t.addIos();
  assert.equal((await t.sync(id)).status, 200);
  const live = await t.live(id);
  assert.deepEqual(live.body, {
    appId: id,
    platform: 'ios',
    readAt: null,
    error: null,
    warnings: [],
    schedule: {
      enabled: false,
      intervalMinutes: 0,
      lastAttemptAt: null,
      failures: 0,
      nextReadAt: null,
    },
    channels: [],
  });
  assert.equal((await db.query('SELECT id FROM listing_snapshots')).length, 0);
});

// ---------------------------------------------------------------------------------------------
// Drift

dbTest(
  'drift: identical, repo-ahead, diverged, store-ahead and missing-in-one, with the history behind each',
  async (db) => {
    const t = await boot(db);
    const { repositoryId } = await t.connect();
    const id = await t.addIos({ repositoryId });
    const store = (subtitle: string, extra: Texts = {}) => {
      t.stores.ios.listing = iosListing({
        'en-US': { ...REPO_EN, subtitle },
        'de-DE': { name: 'Acme App', subtitle: 'Alter Untertitel' },
        ...extra,
      });
    };

    // Before anything is read the view is empty and says so.
    const empty = (await t.drift(id)).body;
    assert.deepEqual(
      [empty.channel, empty.repo.readAt, empty.store.readAt, empty.locales],
      [null, null, null, []],
    );

    // Store and repository say the same.
    store('Old subtitle');
    await t.sync(id);
    const refreshed = await t.refresh(id);
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.found, true);
    assert.equal(refreshed.body.ref, 'main');
    let d = (await t.drift(id)).body;
    assert.equal(d.channel, 'live');
    assert.equal(d.summary.identical, 5);
    assert.equal(
      d.summary.diverged +
        d.summary['repo-ahead'] +
        d.summary['store-ahead'] +
        d.summary['missing-in-one'],
      0,
    );
    assert.ok(typeof d.repo.readAt === 'number' && d.repo.ref === 'main' && d.repo.error === null);

    // The repository changes (a merged pull request): the repository is ahead.
    setRepoSubtitle(t.repo, 'Brand new subtitle');
    await t.refresh(id);
    d = (await t.drift(id)).body;
    let f = fieldsOf(d);
    assert.equal(f['en-US/subtitle']?.status, 'repo-ahead');
    assert.equal(f['en-US/subtitle']?.repo.value, 'Brand new subtitle');
    assert.equal(f['en-US/subtitle']?.live.value, 'Old subtitle');
    assert.equal(f['en-US/name']?.status, 'identical');
    assert.deepEqual(d.summary, {
      identical: 4,
      'repo-ahead': 1,
      'store-ahead': 0,
      diverged: 0,
      'missing-in-one': 0,
    });

    // Somebody edits the subtitle in the store console too: diverged.
    store('Console subtitle');
    await t.sync(id);
    f = fieldsOf((await t.drift(id)).body);
    assert.equal(f['en-US/subtitle']?.status, 'diverged');
    assert.equal(f['en-US/subtitle']?.db.value, 'Console subtitle');
    assert.equal(f['en-US/subtitle']?.db.source, 'store');

    // The repository takes the console's text: identical again.
    setRepoSubtitle(t.repo, 'Console subtitle');
    await t.refresh(id);
    assert.equal(fieldsOf((await t.drift(id)).body)['en-US/subtitle']?.status, 'identical');

    // The store changes and the repository does not: the store is ahead.
    store('Changed in the store');
    await t.sync(id);
    assert.equal(fieldsOf((await t.drift(id)).body)['en-US/subtitle']?.status, 'store-ahead');

    // A field only the store has, and a field only the repository has.
    store('Changed in the store', { 'fr-FR': { name: 'Acme FR' } });
    t.repo.files.set('fastlane/metadata/en-US/keywords.txt', 'coffee,brew\n');
    await t.sync(id);
    await t.refresh(id);
    f = fieldsOf((await t.drift(id)).body);
    assert.deepEqual(
      [f['fr-FR/name']?.status, f['fr-FR/name']?.missingIn],
      ['missing-in-one', 'repo'],
    );
    assert.deepEqual(
      [f['en-US/keywords']?.status, f['en-US/keywords']?.missingIn],
      ['missing-in-one', 'store'],
    );

    // Per-field history: the sequence of changes of one field, from every source, newest first.
    const hist = await t.history(id, '?locale=en-US&field=subtitle');
    assert.deepEqual(
      hist.body.items.map((i: { source: string; value: string }) => `${i.source}:${i.value}`),
      [
        'store:Changed in the store',
        'repo:Console subtitle',
        'store:Console subtitle',
        'repo:Brand new subtitle',
        'repo:Old subtitle',
        'store:Old subtitle',
      ],
    );
    const repoRow = hist.body.items[1];
    assert.equal(repoRow.sourceRef, 'main');
    assert.equal(repoRow.actor.type, 'user');
    t.noLeaks();
  },
);

dbTest(
  'drift reports the character-limit problems of each side with the shared validator',
  async (db) => {
    const t = await boot(db);
    const { repositoryId } = await t.connect();
    const id = await t.addIos({ repositoryId });
    t.stores.ios.listing = iosListing({ 'en-US': { ...REPO_EN, name: 'N'.repeat(31) } });
    t.repo.files.set('fastlane/metadata/en-US/subtitle.txt', `${'S'.repeat(40)}\n`);
    await t.sync(id);
    await t.refresh(id);
    const f = fieldsOf((await t.drift(id)).body);
    assert.deepEqual(
      f['en-US/name']?.problems.live.map((p) => [p.code, p.limit]),
      [['too_long', 30]],
    );
    assert.deepEqual(f['en-US/name']?.problems.repo, []);
    assert.deepEqual(
      f['en-US/subtitle']?.problems.repo.map((p) => p.code),
      ['too_long'],
    );
    assert.equal(f['en-US/name']?.limit, 30);
  },
);

dbTest("the repository's default locale fills the fields a locale does not set", async (db) => {
  const t = await boot(db);
  const { repositoryId } = await t.connect();
  const id = await t.addIos({ repositoryId });
  t.repo.files.set('fastlane/metadata/default/keywords.txt', 'coffee\n');
  t.stores.ios.listing = iosListing({ 'en-US': { ...REPO_EN, keywords: 'coffee' } });
  await t.sync(id);
  await t.refresh(id);
  const d = (await t.drift(id)).body;
  assert.equal(fieldsOf(d)['en-US/keywords']?.status, 'identical');
  assert.ok(
    !d.locales.some((l: { locale: string }) => l.locale === 'default'),
    'default is not a locale of its own',
  );
});

dbTest(
  'an applied change set is recorded once, as the database value, with its own place in the history',
  async (db) => {
    const t = await boot(db);
    const { repositoryId } = await t.connect();
    const id = await t.addIos({ repositoryId });
    t.stores.ios.listing = iosListing({ 'en-US': REPO_EN });
    await t.sync(id);
    await t.refresh(id);

    const draft = await t.draft(repositoryId, 'Subtitle from a change set');
    assert.equal(draft.res.status, 201);
    assert.equal((await t.call(t.owner, 'POST', `/change-sets/${draft.id}/approve`)).status, 200);
    // A draft that was not applied is nothing yet.
    const unapplied = (await t.history(id, '?field=subtitle')).body.items as { source: string }[];
    assert.equal(unapplied.filter((i) => i.source === 'change_set').length, 0);
    assert.equal((await t.call(t.owner, 'POST', `/change-sets/${draft.id}/apply`)).status, 200);

    const d = (await t.drift(id)).body;
    const sub = fieldsOf(d)['en-US/subtitle'];
    assert.equal(sub?.db.value, 'Subtitle from a change set');
    assert.equal(sub?.db.source, 'change_set');
    assert.equal(sub?.live.value, 'Old subtitle');
    assert.equal(
      sub?.status,
      'identical',
      'the repository file itself did not change (the pull request is not merged)',
    );
    // Only the field the change set changed.
    const rows = await db.query(
      "SELECT field, locale, source_ref, actor_type FROM listing_snapshots WHERE source = 'change_set'",
    );
    assert.deepEqual(
      rows.map((r) => [r.locale, r.field, r.source_ref === draft.id, r.actor_type]),
      [['en-US', 'subtitle', true, 'user']],
    );
    // Reading again records nothing twice.
    await t.drift(id);
    await t.history(id);
    forgetInspectedChangeSets();
    await t.drift(id);
    assert.equal(
      (await db.query("SELECT id FROM listing_snapshots WHERE source = 'change_set'")).length,
      1,
    );
    // Once the pull request is merged and the repository read again, the repository is ahead of the store.
    setRepoSubtitle(t.repo, 'Subtitle from a change set');
    await t.refresh(id);
    assert.equal(fieldsOf((await t.drift(id)).body)['en-US/subtitle']?.status, 'repo-ahead');
  },
);

dbTest(
  'repo-refresh needs a linked repository and reports a missing listing without erasing history',
  async (db) => {
    const t = await boot(db);
    const unlinked = await t.addIos();
    const none = await t.refresh(unlinked);
    assert.equal(none.status, 422);
    assert.equal(none.body.error, 'no_repository');

    const { repositoryId } = await t.connect();
    const id = await t.addAndroid({ repositoryId });
    // The fixture repository has App Store files only: no Google Play listing for an Android app.
    const noPlay = await t.refresh(id);
    assert.equal(noPlay.status, 200);
    assert.equal(noPlay.body.found, false);
    assert.match((await t.drift(id)).body.repo.error, /No Google Play listing files/);
    assert.equal(
      (await db.query('SELECT id FROM listing_snapshots WHERE source = ?', ['repo'])).length,
      0,
    );
  },
);

dbTest('repo-refresh passes a GitHub failure on and keeps the reason on the app', async (db) => {
  const t = await boot(db);
  const { repositoryId } = await t.connect();
  const id = await t.addIos({ repositoryId });
  await t.refresh(id);
  const { GithubError } = await import('@kiln/connectors');
  t.repo.listError = new GithubError('forbidden', 'GitHub refused the read (403).', 403);
  const failed = await t.refresh(id);
  assert.equal(failed.status, 422);
  assert.equal(failed.body.error, 'github_forbidden');
  assert.match((await t.drift(id)).body.repo.error, /GitHub refused/);
});

dbTest('repo snapshots keep the history when the repository stops having a field', async (db) => {
  const t = await boot(db);
  const { repositoryId } = await t.connect();
  const id = await t.addIos({ repositoryId });
  await t.refresh(id);
  t.repo.files.delete('fastlane/metadata/de-DE/subtitle.txt');
  await t.refresh(id);
  const hist = await t.history(id, '?locale=de-DE&field=subtitle');
  assert.deepEqual(
    hist.body.items.map((i: { value: string | null }) => i.value),
    [null, 'Alter Untertitel'],
  );
});

// ---------------------------------------------------------------------------------------------
// History paging

dbTest('history pages newest first with a cursor, and rejects bad filters', async (db) => {
  const t = await boot(db);
  const id = await t.addIos();
  for (const name of ['One', 'Two', 'Three', 'Four', 'Five']) {
    t.stores.ios.listing = iosListing({ 'en-US': { name } });
    await t.sync(id);
  }
  const first = await t.history(id, '?locale=en-US&field=name&limit=2');
  assert.deepEqual(
    first.body.items.map((i: { value: string }) => i.value),
    ['Five', 'Four'],
  );
  assert.ok(first.body.nextCursor);
  const second = await t.history(
    id,
    `?locale=en-US&field=name&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
  );
  assert.deepEqual(
    second.body.items.map((i: { value: string }) => i.value),
    ['Three', 'Two'],
  );
  const third = await t.history(
    id,
    `?locale=en-US&field=name&limit=2&cursor=${encodeURIComponent(second.body.nextCursor)}`,
  );
  assert.deepEqual(
    third.body.items.map((i: { value: string }) => i.value),
    ['One'],
  );
  assert.equal(third.body.nextCursor, null);
  // Without filters: every field of the app.
  assert.equal((await t.history(id)).body.items.length, 5);

  for (const query of [
    '?limit=0',
    '?limit=201',
    '?limit=abc',
    '?cursor=nope',
    '?field=title',
    '?locale=en US',
    '?locale=../x',
  ]) {
    const bad = await t.history(id, query);
    assert.equal(bad.status, 400, query);
    assert.equal(bad.body.error, 'invalid_request');
    assert.ok(bad.body.issues.length >= 1);
  }
});

// ---------------------------------------------------------------------------------------------
// Rights, isolation, secrets and audit

dbTest(
  'rights: every role reads the listing views, only members and up read the repository',
  async (db) => {
    const t = await boot(db);
    const { repositoryId } = await t.connect();
    const id = await t.addIos({ repositoryId });
    t.stores.ios.listing = iosListing({ 'en-US': REPO_EN });
    await t.sync(id);
    const viewer = await t.addMember('viewer');
    const member = await t.addMember('member');
    for (const cookie of [viewer, member, t.owner]) {
      assert.equal((await t.live(id, cookie)).status, 200);
      assert.equal((await t.drift(id, cookie)).status, 200);
      assert.equal((await t.history(id, '', cookie)).status, 200);
    }
    assert.equal((await t.refresh(id, viewer)).status, 403);
    assert.equal((await t.refresh(id, member)).status, 200);
    // The stores are never written: there is no route that changes anything but our own database.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const part of ['live', 'drift', 'history']) {
        const res = await t.call(t.owner, method, `/apps/${id}/listing/${part}`);
        assert.ok([404, 405].includes(res.status), `${method} ${part} is ${res.status}`);
      }
    }
  },
);

dbTest('a non-member and another workspace see 404 and nothing of the listing', async (db) => {
  const t = await boot(db);
  const id = await t.addIos();
  t.stores.ios.listing = iosListing({ 'en-US': { name: 'Secret Name' } });
  await t.sync(id);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  for (const path of ['live', 'drift', 'history']) {
    const mine = await t.call(outsider, 'GET', `/apps/${id}/listing/${path}`, undefined, 'other');
    assert.equal(mine.status, 404, `${path} with another workspace's app id`);
    assert.deepEqual(mine.body, { error: 'not_found' });
    const foreign = await t.call(outsider, 'GET', `/apps/${id}/listing/${path}`);
    assert.equal(foreign.status, 404, `${path} in a workspace the person is not in`);
    assert.ok(!foreign.text.includes('Secret Name'));
    assert.equal((await t.call(t.owner, 'GET', `/apps/nope/listing/${path}`)).status, 404);
  }
  assert.equal(
    (await t.call(outsider, 'POST', `/apps/${id}/listing/repo-refresh`, undefined, 'other')).status,
    404,
  );
  assert.equal((await t.call(outsider, 'POST', `/apps/${id}/listing/repo-refresh`)).status, 404);
  assert.equal(
    (await t.call(t.owner, 'GET', `/apps/${id}/listing/live`, undefined, 'no-such-workspace'))
      .status,
    404,
  );
});

dbTest(
  'reads are not audited; the credential use of the sync and of the repository read is',
  async (db) => {
    const t = await boot(db);
    const { repositoryId } = await t.connect();
    const id = await t.addIos({ repositoryId });
    t.stores.ios.listing = iosListing({ 'en-US': REPO_EN });
    await t.sync(id);
    await t.refresh(id);
    const before = (await t.auditActions()).length;
    await t.live(id);
    await t.plainDrift(id);
    await t.history(id);
    assert.equal(
      (await t.auditActions()).length,
      before,
      'viewing the listing writes no audit event',
    );
    const uses = (await t.auditActions()).filter((a) => a.action === 'credential.use');
    assert.ok(uses.length >= 2);
    t.noLeaks();
  },
);

dbTest('repository reads are rate limited per workspace like syncs', async (db) => {
  const t = await boot(db);
  const { repositoryId } = await t.connect();
  const id = await t.addIos({ repositoryId });
  for (let i = 0; i < 10; i++) assert.equal((await t.refresh(id)).status, 200, `read ${i + 1}`);
  const limited = await t.refresh(id);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  // The views that only read the database are not limited.
  assert.equal((await t.drift(id)).status, 200);
});

dbTest('deleting an app deletes its listing history and status', async (db) => {
  const t = await boot(db);
  const id = await t.addIos();
  t.stores.ios.listing = iosListing({ 'en-US': REPO_EN });
  await t.sync(id);
  assert.ok((await db.query('SELECT id FROM listing_snapshots WHERE app_id = ?', [id])).length > 0);
  assert.equal((await t.call(t.owner, 'DELETE', `/apps/${id}`)).status, 204);
  assert.equal(
    (await db.query('SELECT id FROM listing_snapshots WHERE app_id = ?', [id])).length,
    0,
  );
  assert.equal(
    (await db.query('SELECT app_id FROM app_listing_status WHERE app_id = ?', [id])).length,
    0,
  );
});

// ---------------------------------------------------------------------------------------------
// Listing settings: the repository comparison is opt-in

dbTest(
  'the repository comparison is off by default and judges the store on its own; switched on it shows the differences',
  async (db) => {
    const t = await boot(db);
    const { repositoryId } = await t.connect();
    const id = await t.addIos({ repositoryId });
    t.stores.ios.listing = iosListing({ 'en-US': { ...REPO_EN, keywords: 'a'.repeat(101) } });
    t.repo.files.set('fastlane/metadata/en-US/subtitle.txt', 'Another subtitle\n');
    await t.sync(id);
    await t.refresh(id);

    const settings = await t.call(t.owner, 'GET', `/apps/${id}/listing-settings`);
    assert.deepEqual(settings.body.settings, { compareRepo: false, compareMedia: false });

    const off = await t.plainDrift(id);
    assert.deepEqual(off.body.compare, { repo: false, media: false });
    const offFields = fieldsOf(off.body);
    assert.ok(
      Object.values(offFields).every(
        (f) => f.status === 'identical' && f.repo.value === null && f.problems.repo.length === 0,
      ),
    );
    assert.equal(
      offFields['en-US/keywords']?.problems.live[0]?.code,
      'too_long',
      'the store side is still checked on its own',
    );
    assert.ok(
      off.body.sections.every(
        (s: { compare: { status: string } }) =>
          s.compare.status !== 'identical' && s.compare.status !== 'differs',
      ),
    );

    const put = await t.call(t.owner, 'PUT', `/apps/${id}/listing-settings`, { compareRepo: true });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.changed, ['compareRepo']);
    const on = await t.plainDrift(id);
    assert.deepEqual(on.body.compare, { repo: true, media: false });
    assert.notEqual(fieldsOf(on.body)['en-US/subtitle']?.status, 'identical');

    assert.equal(
      (await t.auditActions()).filter((a) => a.action === 'app.listing_settings_update').length,
      1,
    );
    assert.equal(
      (await t.call(t.owner, 'PUT', `/apps/${id}/listing-settings`, { compareRepo: 'yes' })).status,
      400,
    );
    assert.equal((await t.call(t.owner, 'GET', '/apps/nope/listing-settings')).status, 404);
  },
);
