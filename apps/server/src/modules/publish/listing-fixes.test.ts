import assert from 'node:assert/strict';
import { analyzeFixes } from '@kiln/core';
import { dbTest } from '@kiln/db/testing';
import { iosListing, playListing } from '../listing/test-helpers.ts';
import { hashListingValue } from '../listing/drift.ts';
import { bootStaged } from './test-helpers.ts';

/** One-click fixes of the listing checks: computed and staged by the server (docs/api/listing.md). Fakes only. */

const KEYWORDS = ['journal', 'diary', 'todo', 'checklist', 'memo', 'ideas', 'writing', 'planner', 'tasks', 'reminder', 'agenda', 'organizer', 'schedule', 'calendar', 'project'].join(', ');
const IOS = { name: 'Pocket Notes Pro', subtitle: 'Write, plan and remember', keywords: KEYWORDS, description: 'A long description of the app. '.repeat(10) };
const fixes = (appId: string) => `/apps/${appId}/listing/fixes`;

async function bootIos(db: Parameters<typeof bootStaged>[0], texts: Record<string, string> = IOS) {
  const t = await bootStaged(db);
  const app = await t.addApp('ios');
  t.readStores.ios.listing = iosListing({ 'en-US': texts });
  assert.equal((await t.call(t.owner, 'POST', `/apps/${app}/sync`)).status, 200);
  return { t, app };
}

dbTest('the server computes the fixes and stages exactly the one it computed; the cart view and the checks then agree', async (db) => {
  const { t, app } = await bootIos(db);
  const read = await t.call(t.owner, 'GET', fixes(app));
  assert.equal(read.status, 200, read.text);
  const fit = read.body.locales[0].fixes.find((f: { id: string }) => f.id === 'keywords_fit');
  assert.ok(fit?.after && fit.removed.length > 0);
  assert.equal(read.body.afterPending, null);
  const expected = analyzeFixes({ platform: 'ios', store: 'app_store', locale: 'en-US', fields: IOS }).fixes.find((f) => f.id === 'keywords_fit');
  assert.equal(fit.after, expected?.after);

  const res = await t.call(t.owner, 'POST', `${fixes(app)}/stage`, { locale: 'en-US', field: 'keywords', fixId: 'keywords_fit', beforeHash: hashListingValue(IOS.keywords) });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.staged.text[0].value, fit.after, 'the staged value is the server-computed fix');
  assert.equal(res.body.staged.text[0].source, 'local');
  assert.equal(res.body.staged.valid, true);
  assert.equal(res.body.staged.text[0].problems.length, 0);
  assert.equal(t.built.length, 0, 'nothing reached a store');

  const after = await t.call(t.owner, 'GET', fixes(app));
  assert.ok(after.body.afterPending.resolved.some((id: string) => id.includes(':too_long:keywords')));
  assert.equal(after.body.afterPending.counts.problems, 0);
  assert.equal(after.body.locales[0].staged[0].field, 'keywords');
  assert.equal(after.body.locales[0].fixes.find((f: { id: string }) => f.id === 'keywords_fit'), undefined, 'computed from the staged text: nothing left to fix');

  const audit = await t.audit('listing.fix_staged');
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.detail.fixId, 'keywords_fit');
  assert.ok(!JSON.stringify(audit[0]?.detail).includes('journal'), 'the text is never audited');
});

dbTest('a stale diff, a forged body, a field with no stageable fix and a fix that no longer applies are refused', async (db) => {
  const { t, app } = await bootIos(db, { ...IOS, name: 'A very long name for a small notes app' });
  const stage = (body: Record<string, unknown>) => t.call(t.owner, 'POST', `${fixes(app)}/stage`, body);
  const stale = await stage({ locale: 'en-US', field: 'keywords', fixId: 'keywords_fit', beforeHash: hashListingValue('something else') });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'stale_fix');
  assert.equal((await stage({ locale: 'en-US', field: 'keywords', fixId: 'keywords_fit', value: 'evil' })).status, 400, 'the client sends no text');
  const name = await stage({ locale: 'en-US', field: 'name', fixId: 'shorten_ai' });
  assert.equal(name.status, 409, 'prose is never shortened by the server');
  assert.equal(name.body.error, 'fix_not_available');
  assert.equal((await stage({ locale: 'fr-FR', field: 'keywords', fixId: 'keywords_fit' })).status, 409);
  assert.equal((await stage({ locale: 'en-US', field: 'keywords', fixId: 'nope' })).status, 409);
  assert.equal((await t.rows(app)).length, 0, 'nothing was staged');
  assert.equal((await stage({ locale: 'en-US', field: 'keywords', fixId: 'keywords_fit' })).status, 200);
  const again = await stage({ locale: 'en-US', field: 'keywords', fixId: 'keywords_fit' });
  assert.equal(again.status, 409, 'already fixed');
  assert.equal(again.body.error, 'fix_not_available');
});

dbTest('Google Play: a text over its limit gets no staged fix from the server, only the hand-offs in the list', async (db) => {
  const t = await bootStaged(db);
  const app = await t.addApp('android');
  t.readStores.android.listing = playListing({ 'en-US': { title: 'Pocket Notes', short_description: 'Write, plan and remember everything in one tidy place. '.repeat(2), full_description: 'Long text.' } });
  assert.equal((await t.call(t.owner, 'POST', `/apps/${app}/sync`)).status, 200);
  const read = await t.call(t.owner, 'GET', fixes(app));
  assert.deepEqual(read.body.locales[0].fixes.map((f: { id: string }) => f.id), ['shorten_ai', 'edit_field']);
  const res = await t.call(t.owner, 'POST', `${fixes(app)}/stage`, { locale: 'en-US', field: 'short_description', fixId: 'shorten_ai' });
  assert.equal(res.status, 409);
});

dbTest('rights: reading needs listing.read, staging needs changesets.write; non-members get 404', async (db) => {
  const { t, app } = await bootIos(db);
  const viewer = await t.addMember('viewer');
  const member = await t.addMember('member');
  const body = { locale: 'en-US', field: 'keywords', fixId: 'keywords_fit' };
  assert.equal((await t.call(viewer, 'GET', fixes(app))).status, 200);
  assert.equal((await t.call(viewer, 'POST', `${fixes(app)}/stage`, body)).status, 403);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  assert.equal((await t.call(outsider, 'GET', fixes(app))).status, 404);
  assert.equal((await t.call(outsider, 'POST', `${fixes(app)}/stage`, body)).status, 404);
  assert.equal((await t.call(member, 'POST', `${fixes(app)}/stage`, body)).status, 200);
});
