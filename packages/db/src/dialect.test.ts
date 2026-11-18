import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectDialect, sqlitePath } from './dialect.ts';

test('detects postgres urls', () => {
  assert.equal(detectDialect('postgres://u:p@host:5432/db'), 'postgres');
  assert.equal(detectDialect('postgresql://u:p@host/db'), 'postgres');
});

test('detects sqlite urls', () => {
  assert.equal(detectDialect('file:./.mrm-data/mrm.db'), 'sqlite');
  assert.equal(detectDialect(':memory:'), 'sqlite');
});

test('rejects anything else', () => {
  assert.throws(() => detectDialect('mysql://x'), /DATABASE_URL/);
  assert.throws(() => detectDialect(''), /DATABASE_URL/);
});

test('extracts the sqlite path', () => {
  assert.equal(sqlitePath('file:./a/b.db'), './a/b.db');
  assert.equal(sqlitePath(':memory:'), ':memory:');
});
