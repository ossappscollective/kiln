import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { alertCatalog, alertDef } from './catalog.ts';
import { alertGuide, renderAlertEmail, renderDigestEmail, setAlertLinkOrigin } from './email.ts';

afterEach(() => setAlertLinkOrigin(undefined));

const def = (id: string) => {
  const d = alertDef(id);
  assert.ok(d, id);
  return d;
};

test('a failing sync says how to fix it and links to the app and to the credentials', () => {
  setAlertLinkOrigin('https://kiln.example.com/');
  const data = { appId: 'app 1', appName: 'Lyynk' };
  const d = def('store.sync_failed');
  const mail = renderAlertEmail(d, {
    title: d.title(data),
    body: d.body(data),
    severity: d.severity,
    data,
  });
  assert.equal(mail.subject, '[warning] Syncing Lyynk with the store is failing');
  assert.match(mail.text, /What to do: .*Credentials screen/);
  assert.match(
    mail.text,
    /See why the sync fails: https:\/\/kiln\.example\.com\/#\/portfolio\/app%201/,
  );
  assert.match(mail.text, /Check the credentials: https:\/\/kiln\.example\.com\/#\/credentials/);
  assert.match(mail.html, /href="https:\/\/kiln\.example\.com\/#\/portfolio\/app%201"/);
  assert.match(mail.html, /href="https:\/\/kiln\.example\.com\/#\/credentials"/);
  assert.match(mail.html, /href="https:\/\/kiln\.example\.com\/#\/alerts"/);
});

test('without an origin the email names the screen and has no link', () => {
  const data = { appId: 'a1', appName: 'Lyynk' };
  const d = def('credential.invalid');
  const mail = renderAlertEmail(d, { title: 'T', body: 'B', severity: 'critical', data });
  assert.doesNotMatch(mail.html, /href=/);
  assert.match(mail.html, /go to <strong>Credentials<\/strong>/);
  assert.match(mail.text, /Fix the credential: open Kiln, Credentials\./);
  assert.doesNotMatch(mail.text, /https?:\/\//);
});

test('names and text are escaped in the HTML and never become markup', () => {
  setAlertLinkOrigin('https://kiln.example.com');
  const d = def('release.rejected');
  const data = { appId: 'a"><script>', appName: '<img src=x onerror=1>' };
  const mail = renderAlertEmail(d, {
    title: '<b>Rejected</b>',
    body: 'a & b "quoted"',
    severity: 'warning',
    data,
  });
  assert.doesNotMatch(mail.html, /<script>|<img|<b>/);
  assert.match(mail.html, /&lt;b&gt;Rejected&lt;\/b&gt;/);
  assert.match(mail.html, /a &amp; b &quot;quoted&quot;/);
  assert.match(mail.html, /portfolio\/a%22%3E%3Cscript%3E\/releases/);
});

test('every alert type renders, and the app ones link to a screen of their app', () => {
  setAlertLinkOrigin('https://kiln.example.com');
  const data = { appId: 'a1', appName: 'Lyynk', version: '1.0', count: 3, from: 4, to: 3 };
  for (const d of alertCatalog) {
    const mail = renderAlertEmail(d, {
      title: d.title(data),
      body: d.body(data),
      severity: d.severity,
      data,
    });
    assert.ok(mail.subject.length > 0 && mail.text.length > 0 && mail.html.includes('<html'), d.id);
    for (const a of [alertGuide(d.id, data).primary, ...(alertGuide(d.id, data).secondary ?? [])])
      if (a) assert.match(a.path, /^#\//, `${d.id}: ${a.path} is an address inside the app`);
  }
});

test('a repeated alert says how many times, and the digest links each alert', () => {
  setAlertLinkOrigin('https://kiln.example.com');
  const d = def('store.sync_failed');
  const mail = renderAlertEmail(d, {
    title: 't',
    body: 'b',
    severity: 'warning',
    data: { appId: 'a1' },
    count: 4,
  });
  assert.match(mail.text, /This happened 4 times\./);
  const digest = renderDigestEmail([
    {
      title: 'One',
      severity: 'warning',
      count: 1,
      action: alertGuide(d.id, { appId: 'a1' }).primary,
    },
    { title: 'Two', severity: 'info', count: 2, action: undefined },
  ]);
  assert.equal(digest.subject, 'Alert digest: 2 alerts');
  assert.match(
    digest.text,
    /- \[warning\] One\n {2}See why the sync fails: https:\/\/kiln\.example\.com\/#\/portfolio\/a1/,
  );
  assert.match(digest.text, /- \[info\] Two \(2 times\)/);
  assert.match(digest.html, /href="https:\/\/kiln\.example\.com\/#\/portfolio\/a1"/);
});
