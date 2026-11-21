import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearCatalogs, hasCatalogs, k, registerCatalog, setLocaleSource, setMissingReporter, t, tParts } from './t.ts';
import { loadLocaleFromDisk, useLocale } from './test-setup.ts';

test('the preloaded English catalogs answer', () => {
  useLocale('en');
  assert.equal(t('shell:nav.allApps'), 'All apps');
  assert.equal(t('shell:account.menuLabel', { name: 'Ada' }), 'Account menu for Ada');
  assert.equal(hasCatalogs('en'), true);
});

test('the active language answers, missing languages fall back to English', () => {
  useLocale('fr');
  assert.equal(t('shell:nav.allApps'), 'Toutes les applications');
  assert.equal(t('shell:account.signOut'), 'Se déconnecter');
  useLocale('de');
  assert.equal(t('shell:nav.settings'), 'Einstellungen');
  setLocaleSource(() => 'es');
  loadLocaleFromDisk('es');
  assert.equal(t('shell:nav.members'), 'Miembros');
  useLocale('en');
});

test('plural messages follow the active language', () => {
  const unanswered = (locale: string, count: number) => {
    useLocale(locale);
    return t('shell:badge.unanswered', { count });
  };
  assert.equal(unanswered('en', 1), '1 unanswered review');
  assert.equal(unanswered('en', 3), '3 unanswered reviews');
  assert.equal(unanswered('fr', 0), '0 avis sans réponse');
  assert.equal(unanswered('fr', 1), '1 avis sans réponse');
  assert.equal(unanswered('fr', 2_000_000), '2 000 000 d’avis sans réponse');
  assert.equal(unanswered('es', 1), '1 reseña sin responder');
  assert.equal(unanswered('es', 4), '4 reseñas sin responder');
  assert.equal(unanswered('es', 2_000_000), '2.000.000 de reseñas sin responder');
  assert.equal(unanswered('de', 1), '1 unbeantwortete Rezension');
  assert.equal(unanswered('de', 12), '12 unbeantwortete Rezensionen');
  useLocale('en');
});

test('the minimum-length message counts by the minimum, not by what was typed', () => {
  assert.equal(t('common:validation.passwordTooShort', { count: 1, length: 0 }), 'Use at least 1 character. You have 0.');
  assert.equal(t('common:validation.passwordTooShort', { count: 12, length: 5 }), 'Use at least 12 characters. You have 5.');
});

test('the pseudo-locale reads English and marks it', () => {
  useLocale('pseudo');
  assert.match(t('shell:nav.allApps'), /^\[.+ ~+\]$/);
  assert.ok(!/All apps/.test(t('shell:nav.allApps')));
  assert.match(t('shell:badge.attention', { count: 2 }), /^\[2 /);
  useLocale('en');
});

test('a key that exists nowhere is returned as written and reported once', () => {
  const seen: string[] = [];
  setMissingReporter((key) => seen.push(key));
  assert.equal(t('shell:does.not.exist'), 'shell:does.not.exist');
  assert.equal(t('shell:does.not.exist'), 'shell:does.not.exist');
  assert.equal(t('nonamespace'), 'nonamespace');
  assert.deepEqual(seen, ['shell:does.not.exist', 'nonamespace']);
  setMissingReporter(null);
});

test('messages with tags are split for <T>, and values cannot add tags', () => {
  registerCatalog('en', 'test', { help: 'See <link>the guide</link> for {{what}}.' });
  assert.deepEqual(tParts('test:help', { what: '<link>x</link>' }), [
    { text: 'See ' },
    { tag: 'link', text: 'the guide' },
    { text: ' for <link>x</link>.' },
  ]);
  clearCatalogs();
  assert.equal(t('shell:nav.allApps'), 'shell:nav.allApps');
  loadLocaleFromDisk('en');
  assert.equal(t('shell:nav.allApps'), 'All apps');
});

test('k() returns the key untouched', () => {
  const key = k('shell:nav.allApps');
  assert.equal(key, 'shell:nav.allApps');
  assert.equal(t(key), 'All apps');
});
