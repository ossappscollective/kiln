import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrations } from './migrations.ts';

test('migration ids are 1..n with no gaps or repeats', () => {
  assert.deepEqual(
    migrations.map((m) => m.id),
    migrations.map((_, i) => i + 1),
  );
});

test('epoch columns use the right integer width per dialect', () => {
  assert.match(migrations[0]?.statements('postgres')[0] ?? '', /created_at BIGINT/);
  assert.match(migrations[0]?.statements('sqlite')[0] ?? '', /created_at INTEGER/);
});

test('table creation is idempotent so databases made by the old bootstrap are adopted', () => {
  for (const statement of migrations[0]?.statements('sqlite') ?? []) {
    assert.match(statement, /IF NOT EXISTS/);
  }
});
