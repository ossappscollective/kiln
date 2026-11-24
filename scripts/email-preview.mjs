#!/usr/bin/env node
/**
 * Renders every HTML email of the server with sample data into a folder of .html files you can open in a browser
 * (docs/emails.md). Plain Node: it imports the server's TypeScript modules, which Node strips the types of.
 *
 *   node scripts/email-preview.mjs [--lang en|fr|es|de] [--out ./.email-preview] [--origin https://kiln.example.com] [--no-links]
 *
 * `pnpm email:preview`. A browser is not a mail client: see "Client caveats" in docs/emails.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { translator } from '../apps/server/src/i18n/catalogs.ts';
import { SERVER_LOCALES } from '../apps/server/src/i18n/runtime.ts';
import { alertCatalog } from '../apps/server/src/modules/alerts/catalog.ts';
import {
  alertGuide,
  renderAlertEmail,
  renderDigestEmail,
} from '../apps/server/src/modules/alerts/email.ts';
import { testMessageHtml } from '../apps/server/src/routes/mail.ts';
import { setMailLinkOrigin } from '../apps/server/src/services/mail-template.ts';
import { codeMessage } from '../apps/server/src/services/two-factor.ts';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const lang = opt('lang', 'en');
if (!SERVER_LOCALES.includes(lang)) {
  console.error(`Unknown language "${lang}". Available: ${SERVER_LOCALES.join(', ')}`);
  process.exit(1);
}
const out = resolve(opt('out', '.email-preview'));
setMailLinkOrigin(
  args.includes('--no-links') ? undefined : opt('origin', 'https://kiln.example.com'),
);
mkdirSync(out, { recursive: true });

const data = {
  appId: 'app-1',
  appName: 'Lyynk',
  version: '2.4.0',
  count: 3,
  failures: 3,
  code: 'smtp_timeout',
  from: 'in_review',
  to: 'rejected',
};
const files = {};
for (const id of ['release.rejected', 'credential.invalid', 'review.new']) {
  const def = alertCatalog.find((d) => d.id === id);
  if (!def) continue;
  files[`alert-${def.severity}-${id}`] = renderAlertEmail(def, {
    title: def.title(data),
    body: def.body(data),
    severity: def.severity,
    data,
    count: 3,
    locale: lang,
  }).html;
}
const digestItems = ['release.rejected', 'review.new', 'store.sync_failed'].flatMap((id) => {
  const def = alertCatalog.find((d) => d.id === id);
  return def
    ? [
        {
          title: def.title(data),
          severity: def.severity,
          count: id === 'review.new' ? 4 : 1,
          action: alertGuide(id, data, lang).primary,
        },
      ]
    : [];
});
files['digest'] = renderDigestEmail(digestItems, lang).html;
files['code-login'] = codeMessage('login', '042917', lang).html;
files['code-step-up'] = codeMessage('step_up', '318506', lang).html;
files['code-verify-email'] = codeMessage('verify_email', '771203', lang).html;
files['smtp-test'] = testMessageHtml(translator(lang));

const names = Object.keys(files).sort();
for (const name of names) writeFileSync(join(out, `${name}.html`), files[name]);
writeFileSync(
  join(out, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Kiln emails (${lang})</title><body style="font:15px system-ui;margin:2rem"><h1>Kiln emails (${lang})</h1><ul>${names.map((n) => `<li><a href="${n}.html">${n}</a></li>`).join('')}</ul></body>`,
);
console.log(`${names.length} emails (${lang}) written to ${out}`);
