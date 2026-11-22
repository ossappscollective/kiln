/**
 * What every HTML email needs besides its look (which lives in ../mail/layout.ts): the origin links are built on and the HTML
 * escaper. Pure apart from the link origin, which `createApp` sets from KILN_PUBLIC_ORIGIN: a background job cannot know the
 * address people reach the server at, so without it an email names the screen ("Credentials") and has no link. Everything that
 * reaches the HTML goes through `escapeHtml`.
 */

let linkOrigin: string | undefined;

/** Installs the origin links are built on (for example https://kiln.example.com), or undefined for no links. */
export function setMailLinkOrigin(origin: string | undefined): void {
  linkOrigin = origin ? origin.replace(/\/+$/, '') : undefined;
}

/** An address inside the app (`#/credentials`) as a link, or undefined when no origin is known. */
export const mailLink = (path: string): string | undefined =>
  linkOrigin ? `${linkOrigin}/${path}` : undefined;

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
