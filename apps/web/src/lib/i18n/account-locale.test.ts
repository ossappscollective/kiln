import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adoptAccountLocale, saveAccountLocale } from './account-locale.ts';

test('a person with an account language and no choice in this browser gets that language', async () => {
  const activated: string[] = [];
  const deps = (stored: string | null) => ({
    stored: () => stored,
    activate: async (code: string) => {
      activated.push(code);
      return true;
    },
  });
  assert.equal(await adoptAccountLocale('fr', deps(null)), true);
  assert.deepEqual(activated, ['fr']);
  // This browser already has a choice: it wins.
  assert.equal(await adoptAccountLocale('de', deps('es')), false);
  // Nothing saved on the server, or a language this build does not have, or the pseudo-locale: nothing changes.
  for (const code of [null, undefined, '', 'pt', 'pseudo', 'FR'])
    assert.equal(await adoptAccountLocale(code, deps(null)), false, String(code));
  assert.deepEqual(activated, ['fr']);
});

test('the chosen language is sent to the server; a failure is ignored', async () => {
  const sent: string[] = [];
  assert.equal(await saveAccountLocale('es', async (c) => void sent.push(c)), true);
  assert.deepEqual(sent, ['es']);
  assert.equal(
    await saveAccountLocale('de', async () => {
      throw new Error('offline');
    }),
    false,
  );
  assert.equal(await saveAccountLocale('pseudo', async (c) => void sent.push(c)), false);
  assert.deepEqual(sent, ['es']);
});
