import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCALES_DIR, localesDir } from './catalogs.ts';

test('localesDir uses the fallback when KILN_LOCALES_DIR is unset or blank', () => {
  assert.equal(localesDir({}, '/repo/apps/server/locales/'), '/repo/apps/server/locales/');
  assert.equal(localesDir({ KILN_LOCALES_DIR: '  ' }, '/repo/locales'), '/repo/locales/');
});

test('localesDir prefers KILN_LOCALES_DIR and always ends in one slash', () => {
  const dir = (KILN_LOCALES_DIR: string) => localesDir({ KILN_LOCALES_DIR }, '/x/');
  assert.equal(dir('/app/server/locales'), '/app/server/locales/');
  assert.equal(dir('/app/server/locales///'), '/app/server/locales/');
  assert.equal(dir('C:\\app\\locales\\'), 'C:\\app\\locales/');
});

test('from a checkout LOCALES_DIR is apps/server/locales', () => {
  if (process.env.KILN_LOCALES_DIR) return;
  assert.match(LOCALES_DIR.replaceAll('\\', '/'), /apps\/server\/locales\/$/);
});
