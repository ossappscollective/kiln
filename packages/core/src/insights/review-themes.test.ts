import assert from 'node:assert/strict';
import { test } from 'node:test';
import { complaintThemes, foldText, themesOf } from './review-themes.ts';

test('folds case, accents, umlauts and punctuation', () => {
  assert.equal(foldText('Ça PLANTE, Stürzt ab!'), ' ca plante sturzt ab ');
  assert.equal(foldText('Straße'), ' strasse ');
});

test('crash in four languages', () => {
  for (const text of [
    'It crashes every time I open it',
    "L'app plante tout le temps",
    'Se cierra sola cada vez',
    'Die App stürzt ständig ab',
    'Absturz nach dem Start',
  ]) {
    assert.ok(themesOf(text).includes('crash'), text);
  }
});

test('bugs, sign in, lost data, price, ads, speed and updates in the four languages', () => {
  assert.deepEqual(themesOf('Ne fonctionne plus du tout'), ['bug']);
  assert.ok(themesOf('Funktioniert nicht mehr').includes('bug'));
  assert.ok(themesOf('No funciona nada').includes('bug'));
  assert.ok(themesOf("Can't sign in, password reset never arrives").includes('login'));
  assert.ok(themesOf('Mot de passe oublié, impossible').includes('login'));
  assert.ok(themesOf('Perdí todos mis datos al sincronizar').includes('data'));
  assert.ok(themesOf('Alle Daten verloren, Synchronisation kaputt').includes('data'));
  assert.ok(themesOf('Way too expensive for a subscription').includes('price'));
  assert.ok(themesOf("Trop cher l'abonnement").includes('price'));
  assert.ok(themesOf('Zu teuer, reine Abzocke').includes('price'));
  assert.ok(themesOf('Too many ads').includes('ads'));
  assert.ok(themesOf('Muchos anuncios').includes('ads'));
  assert.ok(themesOf('Viel zu viel Werbung').includes('ads'));
  assert.ok(themesOf('So slow and drains my battery').includes('performance'));
  assert.ok(themesOf('Très lent, la batterie fond').includes('performance'));
  assert.ok(themesOf('Seit dem Update geht nichts mehr').includes('update'));
  assert.ok(themesOf('Depuis la mise à jour, tout est cassé').includes('update'));
});

test('exact words do not match inside longer words', () => {
  assert.deepEqual(themesOf('Je cherche une app de notes'), []);
  assert.deepEqual(themesOf('I love the adventure and the added features'), []);
  assert.deepEqual(themesOf(''), []);
});

test('only complaints are counted, biggest theme first', () => {
  const r = (rating: number, text: string) => ({ rating, text });
  const out = complaintThemes([
    r(1, 'crashes constantly'),
    r(2, 'it crashed and lost my data'),
    r(3, 'too many ads'),
    r(5, 'crash? never, love it'),
    r(1, 'ok'),
  ]);
  assert.equal(out.complaints, 4);
  assert.deepEqual(out.themes, [
    { theme: 'crash', count: 2 },
    { theme: 'data', count: 1 },
    { theme: 'ads', count: 1 },
  ]);
  assert.deepEqual(complaintThemes([]), { complaints: 0, themes: [] });
});
