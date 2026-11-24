/**
 * THE ONE PLACE where the look of every HTML email of the server is defined (docs/emails.md). Alert emails, the digest, the
 * sign-in / step-up / address-verification codes and the SMTP test message are all built from the helpers below, so a new look is
 * a change to `emailTokens` (colours, fonts, radii) or to a helper, nowhere else.
 *
 * Mail clients are not browsers: table layout, ALL styles inline (the <style> block only adds the dark scheme where a client
 * honours `prefers-color-scheme`; without it the email is the light version), no web fonts, no images, no SVG (Gmail and Outlook
 * block them), gradients always with a solid colour underneath. The brand mark is therefore text plus table cells.
 * Colour names mirror apps/web/src/styles/theme.css. Every helper takes plain text and escapes it, unless its name ends in `Html`
 * (then the caller has already escaped it, with `escapeHtml`).
 */

import type { Translate } from '../i18n/catalogs.ts';
import { escapeHtml } from '../services/mail-template.ts';

type Tone = { bg: string; ink: string };
type Scheme = {
  /** The page behind the card. */
  ground: string;
  /** The card. */
  surface: string;
  /** Boxes inside the card (code, hint). */
  sunken: string;
  /** Hairlines and the card border. */
  line: string;
  ink: string;
  muted: string;
  /** Links and the text accent. */
  accent: string;
  /** The primary button: gradient ends (the solid fallback is `primaryFrom`) and the text on it. */
  primaryFrom: string;
  primaryTo: string;
  primaryInk: string;
  /** Chips and tinted notes: background and text colour per status. */
  tones: { bad: Tone; warn: Tone; info: Tone; ok: Tone };
};

export const emailTokens = {
  brand: {
    blue: '#7f99ff',
    violet: '#a98bff',
    ember: '#ffb04a',
    blueViolet: '#a98bff',
    violetEmber: '#d49fa4',
  },
  /** The header band is the same deep indigo in both schemes, so the wordmark always sits on the same background. */
  header: { bg: '#0b0d22', ink: '#eceeff' },
  light: {
    ground: '#f5f6fd',
    surface: '#ffffff',
    sunken: '#eceefb',
    line: '#e1e4f5',
    ink: '#14173a',
    muted: '#545a8c',
    accent: '#4552d9',
    primaryFrom: '#4552d9',
    primaryTo: '#6a4fe0',
    primaryInk: '#ffffff',
    tones: {
      bad: { bg: '#fdecea', ink: '#9b1c14' },
      warn: { bg: '#fdf3da', ink: '#8a5200' },
      info: { bg: '#e8f1fd', ink: '#164a8a' },
      ok: { bg: '#e3f5ee', ink: '#0b6e4f' },
    },
  } satisfies Scheme,
  dark: {
    ground: '#0b0d22',
    surface: '#141838',
    sunken: '#0e1130',
    line: '#2a3068',
    ink: '#eceeff',
    muted: '#a3a9d6',
    accent: '#9bb0ff',
    primaryFrom: '#7f99ff',
    primaryTo: '#a98bff',
    primaryInk: '#0b0d22',
    tones: {
      bad: { bg: '#352644', ink: '#ff9aa6' },
      warn: { bg: '#352d3a', ink: '#ffb04a' },
      info: { bg: '#1f3252', ink: '#8fe0f7' },
      ok: { bg: '#1e3449', ink: '#5ee0b0' },
    },
  } satisfies Scheme,
  /** Space Grotesk and Inter are used only when the reader has them installed; nothing is downloaded. */
  font: {
    sans: "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif",
    display:
      "'Space Grotesk',Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif",
    mono: "ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace",
  },
  radius: { card: 18, box: 12, button: 12, chip: 999 },
  width: 600,
} as const;

const T = emailTokens;
const L = T.light;
const D = T.dark;
export type EmailTone = keyof Scheme['tones'];

const gradient = (from: string, to: string): string => `linear-gradient(135deg,${from},${to})`;

/** Languages written right to left get `dir="rtl"`; the catalogs have none today. */
const dirOf = (lang: string): 'ltr' | 'rtl' => (/^(ar|he|fa|ur)(-|$)/i.test(lang) ? 'rtl' : 'ltr');

/** The dark scheme, applied only where the client supports it. `!important` is what lets it beat the inline light styles. */
const darkCss = (): string => {
  const tone = (n: EmailTone) =>
    `.k-chip-${n}{background-color:${D.tones[n].bg} !important;color:${D.tones[n].ink} !important;}`;
  return `
:root{color-scheme:light dark;supported-color-schemes:light dark;}
a{text-decoration:underline;}
@media (prefers-color-scheme: dark){
.k-ground{background-color:${D.ground} !important;}
.k-card{background-color:${D.surface} !important;border-color:${D.line} !important;}
.k-ink{color:${D.ink} !important;}
.k-muted{color:${D.muted} !important;}
.k-link{color:${D.accent} !important;}
.k-sunken{background-color:${D.sunken} !important;color:${D.ink} !important;}
.k-line{border-color:${D.line} !important;}
.k-btn{background-color:${D.primaryFrom} !important;background-image:${gradient(D.primaryFrom, D.primaryTo)} !important;}
.k-btn-text{color:${D.primaryInk} !important;}
${(['bad', 'warn', 'info', 'ok'] as const).map(tone).join('\n')}
}
@media (max-width:620px){
.k-pad{padding-left:20px !important;padding-right:20px !important;}
}`;
};

/** A row of the card with the page's standard side padding. `top`/`bottom` are pixels. */
export const emailRow = (html: string, top = 0, bottom = 0): string =>
  `<tr><td class="k-pad" style="padding:${top}px 32px ${bottom}px;">${html}</td></tr>`;

/** The three-part brand bar: blue, violet, ember, as one continuous gradient where gradients work and as three solid blocks where not. */
export const emailAccentBar = (): string => {
  const b = T.brand;
  const cell = (w: number, solid: string, from: string, to: string) =>
    `<td width="${w}%" height="4" style="width:${w}%;height:4px;font-size:0;line-height:0;background-color:${solid};background-image:linear-gradient(90deg,${from},${to});">&nbsp;</td>`;
  return `<tr><td style="padding:0;font-size:0;line-height:0;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;"><tr>${cell(40, b.blue, b.blue, b.violet)}${cell(30, b.violet, b.violet, b.violetEmber)}${cell(30, b.ember, b.violetEmber, b.ember)}</tr></table></td></tr>`;
};

/** The wordmark: a small mark of three coloured table cells and the word "Kiln" in the display stack. Text and cells only. */
const emailLogo = (): string => {
  const b = T.brand;
  const dot = (c: string) =>
    `<td width="8" height="8" style="width:8px;height:8px;font-size:0;line-height:0;background-color:${c};border-radius:3px;">&nbsp;</td>`;
  const gap = `<td width="3" style="width:3px;font-size:0;line-height:0;">&nbsp;</td>`;
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:separate;"><tr>
<td valign="middle" style="padding-right:10px;"><table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:separate;"><tr>${dot(b.blue)}${gap}${dot(b.violet)}${gap}${dot(b.ember)}</tr></table></td>
<td valign="middle" style="font-family:${T.font.display};font-size:24px;line-height:28px;font-weight:700;letter-spacing:-0.01em;color:${T.header.ink};">Kiln</td>
</tr></table>`;
};

/**
 * The whole document around `rows` (table rows built with the helpers below). `preheader` is the preview line clients show beside
 * the subject; `title` is the document title (the subject, ideally).
 */
export const emailShell = (
  rows: string,
  preheader: string,
  lang = 'en',
  title = 'Kiln',
): string => {
  const hide =
    'display:none !important;visibility:hidden;mso-hide:all;max-height:0;max-width:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:' +
    L.ground;
  return `<!doctype html>
<html lang="${escapeHtml(lang)}" dir="${dirOf(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escapeHtml(title)}</title>
<style>${darkCss()}</style></head>
<body class="k-ground" bgcolor="${L.ground}" style="margin:0;padding:0;background-color:${L.ground};-webkit-text-size-adjust:100%;">
<span style="${hide}">${escapeHtml(preheader)}</span>
<table role="presentation" class="k-ground" width="100%" cellspacing="0" cellpadding="0" bgcolor="${L.ground}" style="width:100%;background-color:${L.ground};"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" class="k-card k-line" width="${T.width}" cellspacing="0" cellpadding="0" bgcolor="${L.surface}" style="width:100%;max-width:${T.width}px;background-color:${L.surface};border:1px solid ${L.line};border-radius:${T.radius.card}px;border-collapse:separate;overflow:hidden;font-family:${T.font.sans};color:${L.ink};">
${emailAccentBar()}
<tr><td class="k-pad" bgcolor="${T.header.bg}" style="padding:22px 32px;background-color:${T.header.bg};">${emailLogo()}</td></tr>
${rows}
</table>
</td></tr></table>
</body></html>`;
};

/** The title of the message. */
export const emailHeading = (text: string): string =>
  `<h1 class="k-ink" style="margin:0 0 10px;font-family:${T.font.display};font-size:24px;line-height:1.25;font-weight:700;letter-spacing:-0.01em;color:${L.ink};">${escapeHtml(text)}</h1>`;

/** A paragraph; `muted` for the quieter ones. */
export const emailParagraphHtml = (html: string, muted = false): string =>
  `<p class="${muted ? 'k-muted' : 'k-ink'}" style="margin:0;font-family:${T.font.sans};font-size:15px;line-height:1.6;color:${muted ? L.muted : L.ink};">${html}</p>`;
export const emailParagraph = (text: string, muted = false): string =>
  emailParagraphHtml(escapeHtml(text), muted);

/** Quiet inline text (for example "(3 times)") that continues a paragraph. */
export const emailMutedSpan = (text: string): string =>
  `<span class="k-muted" style="color:${L.muted};">${escapeHtml(text)}</span>`;

/** A link in the brand accent, always underlined. `innerHtml` is already escaped. */
export const emailLinkHtml = (href: string, innerHtml: string, bold = false): string =>
  `<a class="k-link" href="${escapeHtml(href)}" style="color:${L.accent};text-decoration:underline;${bold ? 'font-weight:600;' : ''}">${innerHtml}</a>`;

/** A small pill ("Critical", "Needs attention") in the colours of a status. */
export const emailChip = (text: string, tone: EmailTone): string =>
  `<span class="k-chip-${tone}" style="display:inline-block;background-color:${L.tones[tone].bg};color:${L.tones[tone].ink};font-family:${T.font.sans};font-size:12px;line-height:16px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:3px 10px;border-radius:${T.radius.chip}px;">${escapeHtml(text)}</span>`;

/** A tinted box for a hint ("What to do"); `html` is already escaped. */
export const emailCalloutHtml = (html: string): string =>
  `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:separate;"><tr><td class="k-sunken" bgcolor="${L.sunken}" style="background-color:${L.sunken};color:${L.ink};border-radius:${T.radius.box}px;padding:14px 16px;font-family:${T.font.sans};font-size:14px;line-height:1.6;">${html}</td></tr></table>`;

/** The one-time code, big, in a box. */
export const emailCodeBox = (code: string): string =>
  `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:separate;"><tr><td class="k-sunken" align="center" bgcolor="${L.sunken}" style="background-color:${L.sunken};color:${L.ink};border-radius:${T.radius.box}px;padding:20px 16px;font-family:${T.font.mono};font-size:34px;line-height:1;font-weight:700;letter-spacing:.3em;">${escapeHtml(code)}</td></tr></table>`;

/** Label and value pairs as rows of a small table. */
export const emailKeyValueRows = (
  pairs: readonly (readonly [label: string, value: string])[],
): string =>
  `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;">${pairs
    .map(
      ([k, v]) =>
        `<tr><td class="k-muted k-line" valign="top" style="padding:8px 12px 8px 0;border-top:1px solid ${L.line};font-family:${T.font.sans};font-size:13px;line-height:1.5;color:${L.muted};">${escapeHtml(k)}</td><td class="k-ink k-line" valign="top" style="padding:8px 0;border-top:1px solid ${L.line};font-family:${T.font.sans};font-size:14px;line-height:1.5;color:${L.ink};">${escapeHtml(v)}</td></tr>`,
    )
    .join('')}</table>`;

/** A hairline between blocks, as a row. */
export const emailDivider = (): string =>
  `<tr><td class="k-pad" style="padding:0 32px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;"><tr><td class="k-line" height="1" style="height:1px;font-size:0;line-height:0;border-top:1px solid ${L.line};">&nbsp;</td></tr></table></td></tr>`;

/** One entry of a list (the digest): a row with a hairline above it. */
export const emailItemRow = (html: string): string =>
  `<tr><td class="k-pad k-line" style="padding:14px 32px;border-top:1px solid ${L.line};">${html}</td></tr>`;

/** Vertical space, as a row. */
export const emailSpacer = (px: number): string =>
  `<tr><td height="${px}" style="height:${px}px;font-size:0;line-height:0;">&nbsp;</td></tr>`;

/**
 * The primary button to `href`: a table cell with a solid colour (what Outlook shows) and the brand gradient on top where
 * supported; the link inside is 44px high. Without a link, the sentence that says where to go (in the language of `t` when one is
 * given, else English).
 */
export const emailButton = (
  a: { label: string; href: string | undefined; where: string },
  t?: Translate,
): string =>
  a.href
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:separate;"><tr><td class="k-btn" align="center" bgcolor="${L.primaryFrom}" style="background-color:${L.primaryFrom};background-image:${gradient(L.primaryFrom, L.primaryTo)};border-radius:${T.radius.button}px;mso-padding-alt:13px 26px;"><a class="k-btn-text" href="${escapeHtml(a.href)}" style="display:inline-block;padding:13px 26px;font-family:${T.font.sans};font-size:15px;line-height:18px;font-weight:600;color:${L.primaryInk};text-decoration:none;border-radius:${T.radius.button}px;">${escapeHtml(a.label)}</a></td></tr></table>`
    : `<span class="k-muted" style="font-family:${T.font.sans};font-size:14px;line-height:1.6;color:${L.muted};">${
        t
          ? t.html('email:shell.openWhere', { where: a.where })
          : `Open Kiln and go to <strong>${escapeHtml(a.where)}</strong>.`
      }</span>`;

/** The quiet last row: why the person gets this email (`noteHtml` is already escaped). */
export const emailFooter = (noteHtml: string): string =>
  `<tr><td class="k-pad k-line k-muted" style="padding:18px 32px 24px;border-top:1px solid ${L.line};font-family:${T.font.sans};font-size:12px;line-height:1.6;color:${L.muted};">${noteHtml}</td></tr>`;
