import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { escapeHtml, mailButton, mailLink, setMailLinkOrigin } from './mail-template.ts';
import { codeMessage } from './two-factor.ts';

afterEach(() => setMailLinkOrigin(undefined));

test('links are built on the public origin, and there are none without it', () => {
  assert.equal(mailLink('#/credentials'), undefined);
  setMailLinkOrigin('https://mrm.example.com/');
  assert.equal(mailLink('#/credentials'), 'https://mrm.example.com/#/credentials');
});

test('a button without a link says where to go; one with a link escapes it', () => {
  const where = { label: 'Fix it', href: undefined, where: 'Credentials' };
  assert.doesNotMatch(mailButton(where, '#000'), /href=/);
  assert.match(mailButton(where, '#000'), /go to <strong>Credentials<\/strong>/);
  const link = mailButton({ ...where, href: 'https://x.example/?a=1&b="2"' }, '#000');
  assert.match(link, /href="https:\/\/x\.example\/\?a=1&amp;b=&quot;2&quot;"/);
  assert.equal(escapeHtml('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;');
});

test('the sign-in code email shows the code big in the HTML and keeps the plain text', () => {
  for (const purpose of ['login', 'verify_email', 'step_up'] as const) {
    const mail = codeMessage(purpose, '042917');
    assert.equal(mail.subject, '042917 is your Mobile Release Manager code');
    assert.match(mail.text, /Your code to .* is 042917\./);
    assert.match(mail.html, />042917</);
    assert.match(mail.html, /expires in \d+ minutes/);
    assert.doesNotMatch(mail.html, /undefined/);
  }
});
