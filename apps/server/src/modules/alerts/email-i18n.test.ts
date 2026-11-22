import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { SERVER_LOCALES } from '../../i18n/runtime.ts';
import { alertCatalog, alertDef } from './catalog.ts';
import { alertGuide, alertTitleIn, renderAlertEmail, renderDigestEmail, setAlertLinkOrigin } from './email.ts';

afterEach(() => setAlertLinkOrigin(undefined));

const data = { appId: 'app 1', appName: 'Lyynk', version: '2.1', count: 3, failures: 3, code: 'smtp_timeout', from: 'in_review', to: 'rejected' };
const def = (id: string) => {
  const d = alertDef(id);
  assert.ok(d, id);
  return d;
};
const clean = (s: string, what: string) => {
  assert.doesNotMatch(s, /\{\{|\}\}/, `${what}: a placeholder is left`);
  assert.doesNotMatch(s, /\balerts:[a-zA-Z]|\bdigest:[a-zA-Z]|\bemail:[a-zA-Z]|\bundefined\b/, `${what}: a key or undefined leaked`);
};

test('every alert type renders as an email in every language, with and without links', () => {
  for (const origin of ['https://kiln.example.com', undefined]) {
    setAlertLinkOrigin(origin);
    for (const lang of SERVER_LOCALES) {
      for (const d of alertCatalog) {
        const mail = renderAlertEmail(d, { title: d.title(data), body: d.body(data), severity: d.severity, data, count: 4, locale: lang });
        for (const part of [mail.subject, mail.text, mail.html]) clean(part, `${d.id} ${lang}`);
        assert.match(mail.html, new RegExp(`<html lang="${lang}"`));
        assert.match(mail.subject, /^\[[^\]]+\] ./);
        assert.ok(mail.subject.length <= 200);
        assert.equal(origin === undefined, !/href=/.test(mail.html), `${d.id} ${lang} links`);
      }
    }
  }
});

test('the French, Spanish and German email is in that language, subject, text and HTML', () => {
  setAlertLinkOrigin('https://kiln.example.com');
  const d = def('release.rejected');
  const input = { title: d.title(data), body: d.body(data), severity: d.severity, data, count: 3 };
  const en = renderAlertEmail(d, input);
  assert.match(en.subject, /^\[critical\] Lyynk 2\.1 was rejected in store review$/);
  const fr = renderAlertEmail(d, { ...input, locale: 'fr' });
  assert.match(fr.subject, /^\[critique\] Lyynk 2\.1 a été rejeté à l’examen du store$/);
  assert.match(fr.text, /À faire : Lisez le motif/);
  assert.match(fr.text, /Voir le rejet : https:\/\/kiln\.example\.com\/#\/portfolio\/app%201\/releases/);
  assert.match(fr.text, /Cela s’est produit 3 fois\./);
  assert.match(fr.html, /Voir le rejet/);
  assert.match(fr.html, /Choisir les alertes que vous recevez<\/a>/);
  assert.match(fr.html, />Critique</);
  const es = renderAlertEmail(d, { ...input, locale: 'es' });
  assert.match(es.subject, /^\[crítica\] Lyynk 2\.1 fue rechazada en la revisión de la tienda$/);
  assert.match(es.text, /Qué hacer: Lee el motivo/);
  const de = renderAlertEmail(d, { ...input, locale: 'de' });
  assert.match(de.subject, /^\[kritisch\] Lyynk 2\.1 wurde in der Store-Prüfung abgelehnt$/);
  assert.match(de.html, /Was zu tun ist\./);
  for (const mail of [fr, es, de]) assert.doesNotMatch(mail.text, /What to do|This happened/);
});

test('English is the fallback: an unknown language, no language, or a type the catalog does not know', () => {
  const d = def('store.sync_failed');
  const input = { title: d.title({ appName: 'Lyynk' }), body: d.body({ appName: 'Lyynk' }), severity: d.severity, data: { appName: 'Lyynk' } };
  const en = renderAlertEmail(d, input);
  for (const locale of ['pt', 'zz', '', undefined, 'fr-CA ']) {
    const mail = renderAlertEmail(d, { ...input, ...(locale === undefined ? {} : { locale }) });
    assert.equal(mail.subject, en.subject, String(locale));
    assert.equal(mail.text, en.text, String(locale));
  }
  // A type with no entry keeps the stored text, in the chrome of the language.
  const unknown = { ...d, id: 'future.type' };
  const mail = renderAlertEmail(unknown, { title: 'Stored title', body: 'Stored body', severity: 'info', data: {}, locale: 'fr' });
  assert.match(mail.subject, /^\[info\] Stored title$/);
  assert.match(mail.text, /Stored body/);
  assert.match(mail.text, /Type d’alerte : future\.type\. Gravité : info\./);
});

test('names stay as written and the HTML stays escaped in every language', () => {
  setAlertLinkOrigin('https://kiln.example.com');
  const d = def('release.rejected');
  const hostile = { appId: 'a"><script>', appName: '<img src=x onerror=1>', version: '1' };
  for (const lang of SERVER_LOCALES) {
    const mail = renderAlertEmail(d, { title: 'T', body: 'B', severity: 'warning', data: hostile, locale: lang });
    assert.doesNotMatch(mail.html, /<script>|<img/, lang);
    // English shows the stored title as given; the other languages rebuild it from the data, names untouched.
    if (lang !== 'en') assert.match(mail.html, /&lt;img src=x onerror=1&gt; 1/, lang);
  }
});

test('the guide is in words in the language and keeps the same addresses', () => {
  const en = alertGuide('credential.invalid', {});
  const fr = alertGuide('credential.invalid', {}, 'fr');
  assert.equal(en.primary?.label, 'Fix the credential');
  assert.equal(fr.primary?.label, 'Corriger l’identifiant d’accès');
  assert.equal(fr.primary?.path, en.primary?.path);
  assert.equal(alertGuide('store.sync_failed', { appName: 'Lyynk', appId: 'a' }, 'de').secondary?.[0]?.where, 'Zugangsdaten');
  assert.equal(alertGuide('release.live', { appName: 'Lyynk', appId: 'a' }, 'es').primary?.where, 'Lyynk, lanzamientos');
});

test('the digest renders in every language: plural subject, titles, links, repeats', () => {
  setAlertLinkOrigin('https://kiln.example.com');
  const sync = alertGuide('store.sync_failed', { appId: 'a1' }, 'fr').primary;
  for (const lang of SERVER_LOCALES) {
    for (const n of [1, 2]) {
      const items = Array.from({ length: n }, (_, i) => ({
        title: alertTitleIn('store.sync_failed', { appName: 'Lyynk' }, 'Syncing Lyynk with the store is failing', lang),
        severity: (i === 0 ? 'warning' : 'critical') as 'warning' | 'critical',
        count: i + 1,
        action: sync,
      }));
      const mail = renderDigestEmail(items, lang);
      for (const part of [mail.subject, mail.text, mail.html]) clean(part, `digest ${lang} ${n}`);
      assert.match(mail.html, new RegExp(`<html lang="${lang}"`));
    }
  }
  const one = renderDigestEmail([{ title: 'x', severity: 'info', count: 1, action: undefined }], 'fr');
  assert.equal(one.subject, 'Résumé des alertes : 1 alerte');
  const two = renderDigestEmail([{ title: 'x', severity: 'info', count: 2, action: sync }, { title: 'y', severity: 'info', count: 1, action: undefined }], 'fr');
  assert.equal(two.subject, 'Résumé des alertes : 2 alertes');
  assert.match(two.text, /- \[info\] x \(2 fois\)\n {2}Voir pourquoi la synchronisation échoue : https:/);
  assert.equal(alertTitleIn('store.sync_failed', { appName: 'Lyynk' }, 'stored', 'en'), 'stored');
  assert.equal(alertTitleIn('store.sync_failed', { appName: 'Lyynk' }, 'stored', 'de'), 'Die Synchronisierung von Lyynk mit dem Store schlägt fehl');
});
