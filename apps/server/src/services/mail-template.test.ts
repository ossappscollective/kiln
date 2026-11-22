import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { escapeHtml, mailLink, setMailLinkOrigin } from './mail-template.ts';
import { codeMessage } from './two-factor.ts';

afterEach(() => setMailLinkOrigin(undefined));

test('links are built on the public origin, and there are none without it', () => {
  assert.equal(mailLink('#/credentials'), undefined);
  setMailLinkOrigin('https://kiln.example.com/');
  assert.equal(mailLink('#/credentials'), 'https://kiln.example.com/#/credentials');
});

test('escapeHtml escapes the four characters that matter', () => {
  assert.equal(escapeHtml('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;');
});

test('the sign-in code email shows the code big in the HTML and keeps the plain text', () => {
  for (const purpose of ['login', 'verify_email', 'step_up'] as const) {
    const mail = codeMessage(purpose, '042917');
    assert.equal(mail.subject, '042917 is your Kiln code');
    assert.match(mail.text, /Your code to .* is 042917\./);
    assert.match(mail.html, />042917</);
    assert.match(mail.html, /expires in \d+ minutes/);
    assert.doesNotMatch(mail.html, /undefined/);
  }
});
