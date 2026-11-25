import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { translator } from '../i18n/catalogs.ts';
import { SERVER_LOCALES } from '../i18n/runtime.ts';
import { alertCatalog } from '../modules/alerts/catalog.ts';
import { renderAlertEmail, renderDigestEmail } from '../modules/alerts/email.ts';
import { testMessageHtml } from '../routes/mail.ts';
import { setMailLinkOrigin } from '../services/mail-template.ts';
import { codeMessage } from '../services/two-factor.ts';
import {
  emailButton,
  emailChip,
  emailCodeBox,
  emailKeyValueRows,
  emailShell,
  emailTokens,
} from './layout.ts';

afterEach(() => setMailLinkOrigin(undefined));

const EVIL = '<script>alert(1)</script>';
const data = {
  appId: 'app1',
  appName: EVIL,
  version: '2.1',
  count: 3,
  failures: 3,
  code: 'smtp_timeout',
  from: 'in_review',
  to: 'rejected',
};

/** Every email type of the server, in `lang`; `name` is injected where a person-chosen value can reach the HTML. */
function everyEmail(lang: string, name = 'Lyynk'): Record<string, string> {
  const out: Record<string, string> = {};
  const d = alertCatalog.find((x) => x.id === 'release.rejected') ?? alertCatalog[0]!;
  out['alert'] = renderAlertEmail(d, {
    title: name,
    body: `${name} body`,
    severity: 'critical',
    data: { ...data, appName: name },
    count: 3,
    locale: lang,
  }).html;
  out['alert-info'] = renderAlertEmail(alertCatalog.find((x) => x.severity === 'info') ?? d, {
    title: name,
    body: name,
    severity: 'info',
    data: { ...data, appName: name },
    locale: lang,
  }).html;
  out['digest'] = renderDigestEmail(
    [
      {
        title: name,
        severity: 'warning',
        count: 2,
        action: { label: name, path: '#/portfolio', where: name },
      },
      { title: 'B', severity: 'info', count: 1, action: undefined },
    ],
    lang,
  ).html;
  for (const p of ['login', 'verify_email', 'step_up'] as const)
    out[`code-${p}`] = codeMessage(p, '042917', lang).html;
  out['smtp-test'] = testMessageHtml(translator(lang));
  return out;
}

test('every email renders in every language, with and without links, with no leftover placeholder', () => {
  for (const origin of ['https://kiln.example.com', undefined]) {
    setMailLinkOrigin(origin);
    for (const lang of SERVER_LOCALES) {
      for (const [name, html] of Object.entries(everyEmail(lang))) {
        const what = `${name} ${lang}`;
        assert.doesNotMatch(html, /\{\{|\}\}|\bundefined\b|\[object/, what);
        assert.match(html, new RegExp(`<html lang="${lang}" dir="ltr"`), what);
        assert.match(html, /<style>[\s\S]*prefers-color-scheme: dark/, what);
        assert.match(html, /name="color-scheme" content="light dark"/, what);
        assert.match(html, /<table role="presentation"/, what);
        assert.doesNotMatch(
          html,
          /<img|url\(|<svg|@import|<link /i,
          `${what}: external or image resource`,
        );
      }
    }
  }
});

test('dynamic values are escaped in every email', () => {
  setMailLinkOrigin('https://kiln.example.com');
  for (const lang of SERVER_LOCALES) {
    for (const [name, html] of Object.entries(everyEmail(lang, EVIL))) {
      assert.doesNotMatch(html, /<script/i, `${name} ${lang}`);
    }
    assert.match(everyEmail(lang, EVIL)['alert']!, /&lt;script&gt;/);
  }
  assert.doesNotMatch(emailChip(EVIL, 'bad'), /<script/);
  assert.doesNotMatch(emailCodeBox(EVIL), /<script/);
  assert.doesNotMatch(emailKeyValueRows([[EVIL, EVIL]]), /<script/);
  assert.doesNotMatch(
    emailButton({ label: EVIL, href: `https://x.example/?a="${EVIL}`, where: EVIL }),
    /<script|href="[^"]*"[^>]*"<script/,
  );
});

test('the shell has the hidden preheader, lang, dir and title', () => {
  const html = emailShell('<tr><td>x</td></tr>', 'Preview <b>line</b>', 'fr', 'Sujet');
  assert.match(html, /<html lang="fr" dir="ltr">/);
  assert.match(
    html,
    /<span style="display:none !important[^"]*">Preview &lt;b&gt;line&lt;\/b&gt;<\/span>/,
  );
  assert.match(html, /<title>Sujet<\/title>/);
  assert.match(emailShell('', 'p', 'ar'), /dir="rtl"/);
});

test('the button is a bulletproof cell: solid colour, gradient on top, 44px link; without a link it says where to go', () => {
  const b = emailButton({
    label: 'Open',
    href: 'https://x.example/?a=1&b="2"',
    where: 'Credentials',
  });
  assert.match(
    b,
    /bgcolor="#4552d9"[^>]*background-color:#4552d9;background-image:linear-gradient/,
  );
  assert.match(b, /href="https:\/\/x\.example\/\?a=1&amp;b=&quot;2&quot;"/);
  assert.match(b, /padding:13px 26px;[^"]*line-height:18px/);
  const none = emailButton({ label: 'Open', href: undefined, where: 'Credentials' });
  assert.doesNotMatch(none, /href=/);
  assert.match(none, /go to <strong>Credentials<\/strong>/);
});

// WCAG 2.x contrast of the colour pairs the layout uses, in both schemes. Text needs 4.5:1.
const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

test('every text pair of the layout has at least 4.5:1 contrast in both schemes', () => {
  const pairs: [string, string, string][] = [
    ['wordmark on header', emailTokens.header.ink, emailTokens.header.bg],
  ];
  for (const scheme of ['light', 'dark'] as const) {
    const s = emailTokens[scheme];
    pairs.push(
      [`${scheme} ink on surface`, s.ink, s.surface],
      [`${scheme} muted on surface`, s.muted, s.surface],
      [`${scheme} link on surface`, s.accent, s.surface],
      [`${scheme} ink on sunken`, s.ink, s.sunken],
      [`${scheme} link on sunken`, s.accent, s.sunken],
      [`${scheme} button text on gradient start`, s.primaryInk, s.primaryFrom],
      [`${scheme} button text on gradient end`, s.primaryInk, s.primaryTo],
    );
    for (const [n, t] of Object.entries(s.tones)) {
      pairs.push(
        [`${scheme} ${n} chip`, t.ink, t.bg],
        [`${scheme} ${n} ink on surface`, t.ink, s.surface],
      );
    }
  }
  // The light button is also what Outlook shows (solid colour), the dark one only where the dark scheme applies.
  for (const [name, fg, bg] of pairs)
    assert.ok(contrast(fg, bg) >= 4.5, `${name}: ${contrast(fg, bg).toFixed(2)}`);
  assert.ok(contrast('#000000', '#ffffff') > 20.9, 'the formula itself');
});
