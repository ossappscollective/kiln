import assert from 'node:assert/strict';
import type { StoreListing } from '@kiln/connectors';
import { dbTest } from '@kiln/db/testing';
import { bootListing, EN_US, playListing } from './test-helpers.ts';

// `GET /apps/:id/listing/store`: the one read of the store side. The scenarios are the audit's: an iOS app with a live 1.0 and a draft 1.1
// that holds a locale (fr-FR) the live copy does not, an App Store primary locale, and the intents (shown, editable, live).

const FR = { name: 'Acme FR', subtitle: 'Sous-titre', description: 'Une description assez longue.' };
const DE = { name: 'Acme DE', subtitle: 'Untertitel', description: 'Eine ausreichend lange Beschreibung.' };

const iosWithDraft = (
  live: Record<string, Record<string, string>>,
  editable: Record<string, Record<string, string>>,
  primary?: string,
): StoreListing => ({
  platform: 'ios',
  appStoreId: '1234567890',
  warnings: [],
  channels: [
    {
      channel: 'live',
      versionString: '1.0',
      listing: { appStore: { locales: live } },
      ...(primary ? { sections: { details: { defaultLanguage: primary } } } : {}),
    },
    {
      channel: 'editable',
      versionString: '1.1',
      listing: { appStore: { locales: editable } },
      ...(primary ? { sections: { details: { defaultLanguage: primary } } } : {}),
    },
  ],
});

dbTest('the store read gives one locale list per intent: a locale only the draft has is shown and editable, not live', async (db) => {
  const t = await bootListing(db);
  const id = await t.addIos();
  t.stores.ios.listing = iosWithDraft({ 'en-US': EN_US }, { 'en-US': EN_US, 'fr-FR': FR });
  await t.sync(id);
  const body = (await t.call(t.owner, 'GET', `/apps/${id}/listing/store?fields=name&drift=0`)).body;
  assert.deepEqual(body.locales, ['en-US', 'fr-FR']);
  assert.deepEqual(body.copies.shown.codes, ['en-US', 'fr-FR']);
  assert.deepEqual(body.copies.editable.codes, ['en-US', 'fr-FR']);
  assert.deepEqual(body.copies.live.codes, ['en-US'], 'what users see has no fr-FR');
  const fr = body.copies.shown.locales.find((l: { locale: string }) => l.locale === 'fr-FR');
  assert.equal(fr.from, 'editable');
  assert.deepEqual(fr.held, ['editable']);
  assert.deepEqual(fr.fields, { name: 'Acme FR' }, 'only the fields asked for carry text');
  const en = body.copies.shown.locales.find((l: { locale: string }) => l.locale === 'en-US');
  assert.equal(en.from, 'live', 'a locale both copies hold is read from the live copy');
  assert.equal(body.drift, null);
  assert.ok(body.readAt > 0);
});

dbTest('the Listing grid (drift), the checks, the fixes and the store read name the same locales', async (db) => {
  const t = await bootListing(db);
  const id = await t.addIos();
  t.stores.ios.listing = iosWithDraft({ 'en-US': EN_US }, { 'en-US': EN_US, 'fr-FR': FR });
  await t.sync(id);
  const store = (await t.call(t.owner, 'GET', `/apps/${id}/listing/store`)).body;
  const grid = store.drift.locales.map((l: { locale: string }) => l.locale);
  assert.deepEqual(grid, store.locales, 'the grid lists the shown locales');
  const checks = (await t.call(t.owner, 'GET', `/apps/${id}/insights/listing-checks`)).body;
  assert.deepEqual(
    checks.locales.map((l: { locale: string }) => l.locale),
    store.locales,
    'the Insights checks no longer read the live copy only',
  );
  const fixes = (await t.call(t.owner, 'GET', `/apps/${id}/listing/fixes`)).body;
  assert.deepEqual(
    fixes.locales.map((l: { locale: string }) => l.locale),
    store.copies.editable.codes,
  );
  assert.equal(checks.baseLocale, store.defaultLocale.locale);
  assert.equal(fixes.baseLocale, store.defaultLocale.locale, 'the fix bar and the checks compare with one base');
});

dbTest('the App Store primary locale is the default locale', async (db) => {
  const t = await bootListing(db);
  const id = await t.addIos();
  t.stores.ios.listing = iosWithDraft({ 'de-DE': DE, 'en-US': EN_US }, { 'de-DE': DE, 'en-US': EN_US }, 'de-DE');
  await t.sync(id);
  const declared = (await t.call(t.owner, 'GET', `/apps/${id}/listing/store?drift=0`)).body.defaultLocale;
  assert.deepEqual(declared, { locale: 'de-DE', declared: 'de-DE', source: 'declared', reason: 'declared' });
});

dbTest('when the store does not say, the default locale is English, then the first, and it says so', async (db) => {
  const t = await bootListing(db);
  const id = await t.addIos();
  t.stores.ios.listing = iosWithDraft({ 'de-DE': DE, 'en-US': EN_US }, { 'de-DE': DE, 'en-US': EN_US });
  await t.sync(id);
  const guess = (await t.call(t.owner, 'GET', `/apps/${id}/listing/store?drift=0`)).body.defaultLocale;
  assert.deepEqual(guess, { locale: 'en-US', declared: null, source: 'english', reason: 'not_declared' });
});

dbTest('with no English and no declaration the first locale is the default, said as such', async (db) => {
  const t = await bootListing(db);
  const id = await t.addIos();
  t.stores.ios.listing = iosWithDraft({ 'fr-FR': FR, 'de-DE': DE }, { 'fr-FR': FR, 'de-DE': DE });
  await t.sync(id);
  const first = (await t.call(t.owner, 'GET', `/apps/${id}/listing/store?drift=0`)).body.defaultLocale;
  assert.deepEqual([first.locale, first.source], ['de-DE', 'first']);
});

dbTest('Google Play declares its default language; the store read says so too', async (db) => {
  const t = await bootListing(db);
  const id = await t.addAndroid();
  t.stores.android.listing = playListing(
    { 'en-US': { title: 'Acme', short_description: 'Short', full_description: 'Full description text.' }, 'zh-CN': { title: '应用' } },
    { details: { defaultLanguage: 'zh-CN' } },
  );
  await t.sync(id);
  const body = (await t.call(t.owner, 'GET', `/apps/${id}/listing/store?drift=0`)).body;
  assert.equal(body.defaultLocale.locale, 'zh-CN');
  assert.equal(body.copies.editable.channels.editable, false);
  assert.deepEqual(body.copies.editable.codes, ['en-US', 'zh-CN'], 'no draft: the live copy stands in');
});

dbTest('the store read refuses an unknown field and needs listing.read', async (db) => {
  const t = await bootListing(db);
  const id = await t.addIos();
  t.stores.ios.listing = iosWithDraft({ 'en-US': EN_US }, { 'en-US': EN_US });
  await t.sync(id);
  assert.equal((await t.call(t.owner, 'GET', `/apps/${id}/listing/store?fields=nope`)).status, 400);
  assert.equal((await t.call(t.owner, 'GET', `/apps/${id}/listing/store?fields=all`)).status, 200);
});
