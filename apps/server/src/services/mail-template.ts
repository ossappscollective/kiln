/**
 * The frame every HTML email of the server shares (alerts, sign-in codes, the SMTP test): a white card on a grey page, a coloured
 * bar, a footer, inline CSS only (mail clients ignore the rest). Pure apart from the link origin, which `createApp` sets from
 * MRM_PUBLIC_ORIGIN: a background job cannot know the address people reach the server at, so without it an email names the screen
 * ("Credentials") and has no link. Everything that reaches the HTML goes through `escapeHtml`.
 */

let linkOrigin: string | undefined;

/** Installs the origin links are built on (for example https://mrm.example.com), or undefined for no links. */
export function setMailLinkOrigin(origin: string | undefined): void {
  linkOrigin = origin ? origin.replace(/\/+$/, '') : undefined;
}

/** An address inside the app (`#/credentials`) as a link, or undefined when no origin is known. */
export const mailLink = (path: string): string | undefined =>
  linkOrigin ? `${linkOrigin}/${path}` : undefined;

export const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** A card around `rows` (table rows). `preheader` is the preview line some clients show beside the subject. */
export const mailShell = (rows: string, preheader: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#f3f4f6;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden;font-family:${FONT};color:#1f2933;">
${rows}
</table>
<p style="max-width:560px;margin:14px 0 0;font:12px/1.5 ${FONT};color:#7b8794;">Mobile Release Manager</p>
</td></tr></table></body></html>`;

/** The coloured bar at the top of the card. */
export const mailBar = (color: string): string =>
  `<tr><td style="height:5px;background:${color};font-size:0;line-height:0;">&nbsp;</td></tr>`;

/** A button to `href`; without a link, the sentence that says where to go. */
export const mailButton = (a: { label: string; href: string | undefined; where: string }, color: string): string =>
  a.href
    ? `<a href="${escapeHtml(a.href)}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:11px 20px;border-radius:8px;">${escapeHtml(a.label)}</a>`
    : `<span style="font-size:14px;color:#52606d;">Open Mobile Release Manager and go to <strong>${escapeHtml(a.where)}</strong>.</span>`;

/** The quiet last row: why the person gets this email (already HTML, built with `escapeHtml`). */
export const mailFooter = (noteHtml: string): string =>
  `<tr><td style="padding:16px 28px 22px;border-top:1px solid #e4e7eb;font-size:12px;line-height:1.5;color:#7b8794;">${noteHtml}</td></tr>`;
