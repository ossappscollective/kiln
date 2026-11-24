import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dbTest } from '@kiln/db/testing';
import { operations } from './operations/registry.ts';
import { sendDueDigests } from './modules/alerts/digest.ts';
import { bootAlerts } from './modules/alerts/test-helpers.ts';
import { recipientLocale, parseUserLocale } from './i18n/user-locale.ts';
import { boot, registerOwner, send } from './testkit.ts';

type MeBody = { user: { id: string; email: string; locale: string | null }; workspaces: unknown[] };

dbTest('a person reads and sets the language they read: GET and PATCH /api/me', async (db) => {
  const { app } = await boot(db);
  const { cookie } = await registerOwner(app);
  const me = async () =>
    (await (await app.request('/api/me', { headers: { cookie } })).json()) as MeBody;
  assert.equal((await me()).user.locale, null, 'no choice yet');

  const patch = (body: unknown, who = cookie) => app.request('/api/me', send('PATCH', body, who));
  const ok = await patch({ locale: 'fr' });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as MeBody).user.locale, 'fr');
  assert.equal((await me()).user.locale, 'fr');
  // A region is dropped, the case is forgiven.
  assert.equal(((await (await patch({ locale: 'DE-at' })).json()) as MeBody).user.locale, 'de');
  assert.equal(((await (await patch({ locale: 'es_MX' })).json()) as MeBody).user.locale, 'es');
  // null goes back to no choice.
  assert.equal(((await (await patch({ locale: null })).json()) as MeBody).user.locale, null);
  assert.equal((await me()).user.locale, null);
});

dbTest('the language is validated: only en, fr, es and de, nothing else', async (db) => {
  const { app } = await boot(db);
  const { cookie } = await registerOwner(app);
  await app.request('/api/me', send('PATCH', { locale: 'fr' }, cookie));
  for (const bad of [
    { locale: 'pt' },
    { locale: 'xx-YY' },
    { locale: '' },
    { locale: 'fr!' },
    { locale: 5 },
    { locale: 'x'.repeat(40) },
    {},
    { locale: ['fr'] },
  ]) {
    const res = await app.request('/api/me', send('PATCH', bad, cookie));
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(((await res.json()) as { error: string }).error, 'invalid_request');
  }
  const me = (await (await app.request('/api/me', { headers: { cookie } })).json()) as MeBody;
  assert.equal(me.user.locale, 'fr', 'a refused value changes nothing');
  assert.equal(
    (await app.request('/api/me', send('PATCH', { locale: 'fr' }))).status,
    401,
    'signed-in people only',
  );
});

dbTest('sign-in returns the saved language so the web app can adopt it', async (db) => {
  const { app } = await boot(db);
  const { cookie } = await registerOwner(app, 'ada@example.com');
  await app.request('/api/me', send('PATCH', { locale: 'es' }, cookie));
  const res = await app.request(
    '/api/auth/login',
    send('POST', { email: 'ada@example.com', password: 'correct horse battery staple' }),
  );
  assert.equal(((await res.json()) as MeBody).user.locale, 'es');
});

test('the language tag rules (no database)', () => {
  assert.equal(parseUserLocale('fr'), 'fr');
  assert.equal(parseUserLocale(' FR-ca '), 'fr');
  assert.equal(parseUserLocale('de_CH'), 'de');
  for (const bad of ['pt', 'eng', '', 'f', 'fr!', 12, null, undefined, 'x'.repeat(50)])
    assert.equal(parseUserLocale(bad), undefined, String(bad));
});

dbTest('the operation is documented: registry entry, session only, no token', async () => {
  const op = operations.find((o) => o.id === 'updateMe');
  assert.ok(op);
  assert.equal(op.method, 'patch');
  assert.equal(op.path, '/api/me');
  assert.equal(op.access, 'user');
  assert.equal(op.risk, 'write');
  const get = operations.find((o) => o.id === 'getMe');
  assert.ok(get);
});

dbTest('a background email uses the recipient language: their choice, else English', async (db) => {
  const t = await bootAlerts(db, { publicOrigin: 'https://kiln.example.com' });
  const app = await t.addApp();
  assert.equal(await recipientLocale(db, t.ownerId), 'en', 'no choice: English');
  assert.equal(await recipientLocale(db, undefined), 'en');
  assert.equal(await recipientLocale(db, 'nobody'), 'en');

  await t.rejected(app, '2.0', Date.now());
  assert.equal(await t.runMail(), 1);
  assert.match(
    String(t.mail.sent[0]?.subject),
    /^\[critical\] Moon Diary 2\.0 was rejected in store review$/,
  );

  const set = await t.app.request('/api/me', send('PATCH', { locale: 'fr' }, t.owner));
  assert.equal(set.status, 200);
  assert.equal(await recipientLocale(db, t.ownerId), 'fr');
  await t.rejected(app, '3.0', Date.now() + 10);
  assert.equal(await t.runMail(Date.now() + 5000), 1);
  const mail = t.mail.sent[1];
  assert.match(
    String(mail?.subject),
    /^\[critique\] Moon Diary 3\.0 a été rejeté à l’examen du store$/,
  );
  assert.match(String(mail?.text), /À faire :/);
  assert.match(String(mail?.html), /<html lang="fr"/);
  assert.match(String(mail?.html), /https:\/\/kiln\.example\.com\/#\/portfolio\/app1\/releases/);

  // A value written by hand that the server does not know is English, not an error.
  await db.execute('UPDATE users SET locale = ? WHERE id = ?', ['klingon', t.ownerId]);
  assert.equal(await recipientLocale(db, t.ownerId), 'en');
});

dbTest('the digest and the inbox follow the recipient language', async (db) => {
  const t = await bootAlerts(db);
  const app = await t.addApp();
  await t.app.request('/api/me', send('PATCH', { locale: 'de' }, t.owner));
  await t.call(t.owner, 'PUT', '/alerts/settings', {
    digest: 'daily',
    digestHour: 8,
    timezone: 'UTC',
  });
  await t.call(t.owner, 'PUT', '/alerts/preferences/review.low_rating', {
    channels: ['in_app', 'email'],
  });
  const now = Date.now();
  await t.emit('review.new_low_rating', { reviewId: 'r1', rating: 1, store: 'appstore' }, app, now);
  await t.emit(
    'review.new_low_rating',
    { reviewId: 'r2', rating: 2, store: 'appstore' },
    app,
    now + 1000,
  );
  const tomorrow =
    Math.floor(now / 86_400_000) * 86_400_000 + 86_400_000 + 8 * 3_600_000 + 5 * 60_000;
  assert.deepEqual(await sendDueDigests(db, tomorrow), { due: 1, sent: 1 });
  assert.equal(await t.runMail(tomorrow + 1000), 1);
  const digest = t.mail.sent.at(-1);
  assert.equal(digest?.subject, 'Warnungs-Zusammenfassung: 2 Warnungen');
  assert.match(String(digest?.text), /Rezension für/);
  assert.match(String(digest?.html), /<html lang="de"/);

  // The inbox (and so the bell and the desktop notification) shows the stored English until the person chooses a language.
  const inbox = async () =>
    (await t.call(t.owner, 'GET', '/alerts/inbox')).body as { alerts: { title: string }[] };
  assert.match(String((await inbox()).alerts[0]?.title), /^Neue \d-Sterne-Rezension für /);
  await t.app.request('/api/me', send('PATCH', { locale: null }, t.owner));
  assert.match(String((await inbox()).alerts[0]?.title), /^New \d-star review for /);
});
