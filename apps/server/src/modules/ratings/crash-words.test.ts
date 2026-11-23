import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CRASH_PHRASES, crashMention } from './crash-words.ts';

test('crash words match in English, French, Spanish, German and a few other languages', () => {
  const yes = [
    'The app crashes every time I open it',
    'It keeps freezing on the login screen',
    'Force closes after the update',
    "L'application plante tout le temps — ça plante",
    'Plantage au démarrage',
    'La app se cierra sola',
    'Se congela al abrir la cámara',
    'Seit dem Update ein Absturz nach dem anderen',
    'Die App stürzt ab',
    'App friert ein und reagiert nicht',
    'Travando toda hora',
    '每次打开都闪退',
    'Постоянно вылетает',
  ];
  for (const text of yes) assert.equal(crashMention(null, text), true, text);
});

test('the title counts too, and ordinary praise or a plant do not match', () => {
  assert.equal(crashMention('Crashes!', 'ok'), true);
  for (const text of ['Great app, love it', 'Houseplant care reminders are great', 'Die Pflanze wächst gut', 'Me encanta, muy fácil de usar', '']) {
    assert.equal(crashMention(null, text), false, text);
  }
});

test('the list is lowercase and each phrase is long enough not to hit everything', () => {
  for (const p of CRASH_PHRASES) {
    assert.equal(p, p.toLowerCase(), p);
    assert.equal(p.includes("'"), false, `${p}: no apostrophe`);
    if (/^[a-zà-ÿа-я ]+$/i.test(p)) assert.ok(p.length >= 5, `${p} is under five characters`);
  }
});
