import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inviteHash, inviteLink, tokenFromHash } from './links.ts';

test('an invitation link is origin plus #/invite/token', () => {
  assert.equal(
    inviteLink('https://mrm.example.com', 'abc-DEF_123'),
    'https://mrm.example.com/#/invite/abc-DEF_123',
  );
  assert.equal(inviteHash('a b'), '#/invite/a%20b');
});

test('the token comes back out of the hash', () => {
  assert.equal(tokenFromHash('#/invite/abc-DEF_123'), 'abc-DEF_123');
  assert.equal(tokenFromHash(inviteHash('a/b c')), 'a/b c');
  assert.equal(tokenFromHash('#/invite/abc/'), 'abc');
});

test('other hashes are not invitations', () => {
  for (const hash of [
    '',
    '#',
    '#/',
    '#/members',
    '#/invite',
    '#/invite/',
    '#/invite/a/b',
    '#/invite/%E0%A4%A',
    '#/invitex/abc',
  ]) {
    assert.equal(tokenFromHash(hash), null, hash);
  }
});
