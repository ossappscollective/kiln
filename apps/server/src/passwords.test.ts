import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, verifyPassword } from './passwords.ts';

const cheap = { N: 1024, r: 8, p: 1 };

test('a password verifies against its own hash only', async () => {
  const hash = await hashPassword('correct horse battery', cheap);
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('correct horse batterz', hash), false);
});

test('the same password hashes differently each time', async () => {
  assert.notEqual(await hashPassword('same', cheap), await hashPassword('same', cheap));
});

test('the stored hash carries its cost, so it verifies after the default changes', async () => {
  const hash = await hashPassword('pw-pw-pw-pw', { N: 2048, r: 8, p: 1 });
  assert.match(hash, /^scrypt\$2048\$8\$1\$/);
  assert.equal(await verifyPassword('pw-pw-pw-pw', hash), true);
});

test('malformed hashes never verify', async () => {
  for (const bad of ['', 'plain', 'bcrypt$1$2$3$a$b', 'scrypt$x$8$1$a$b', 'scrypt$1024$8$1$a']) {
    assert.equal(await verifyPassword('anything', bad), false, bad);
  }
});
