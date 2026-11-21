import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { defaultDataDir, sqliteUrlInUse } from './legacy-data.ts';

const only =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

test('the default data folder is ./.kiln-data, or ./.mrm-data when only that one exists', () => {
  assert.equal(defaultDataDir(only()), './.kiln-data');
  assert.equal(defaultDataDir(only('./.mrm-data')), './.mrm-data');
  assert.equal(defaultDataDir(only('./.kiln-data')), './.kiln-data');
  assert.equal(defaultDataDir(only('./.mrm-data', './.kiln-data')), './.kiln-data');
});

test('a kiln.db URL falls back to mrm.db beside it only when kiln.db is missing and mrm.db exists', () => {
  const url = 'file:./.kiln-data/kiln.db';
  assert.equal(sqliteUrlInUse(url, only()), url);
  assert.equal(sqliteUrlInUse(url, only('./.kiln-data/mrm.db')), 'file:./.kiln-data/mrm.db');
  assert.equal(sqliteUrlInUse(url, only('./.kiln-data/mrm.db', './.kiln-data/kiln.db')), url);
});

test('other URLs are returned untouched', () => {
  for (const url of [
    'postgres://u:p@db.example.com/kiln',
    'file:/data/other.db',
    'file:/data/kiln.db?mode=ro',
    ':memory:',
  ])
    assert.equal(sqliteUrlInUse(url, () => true), url);
});

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

test('against the real file system nothing is created, moved or deleted', () => {
  const root = mkdtempSync(join(tmpdir(), 'kiln-legacy-'));
  roots.push(root);
  mkdirSync(join(root, 'old'));
  writeFileSync(join(root, 'old', 'mrm.db'), 'data');
  const url = `file:${join(root, 'old', 'kiln.db')}`;
  assert.equal(sqliteUrlInUse(url), `file:${join(root, 'old', 'mrm.db')}`);
  assert.equal(sqliteUrlInUse(`file:${join(root, 'new', 'kiln.db')}`), `file:${join(root, 'new', 'kiln.db')}`);
});
