import { randomBytes } from 'node:crypto';

/**
 * Builds the text of one email (RFC 5322 and MIME) for the SMTP client. Pure: no network, no clock unless given.
 *
 * Header injection is closed in two ways: an address is checked against a strict pattern (no space, comma, quote, angle bracket,
 * backslash or control character can be in it), and every other header value (the subject, a display name) has control characters
 * removed and non-ASCII text encoded as RFC 2047 words, so a line break can never end a header early.
 */

export const MAX_RECIPIENTS = 20;
export const MAX_SUBJECT_CHARS = 300;
export const MAX_BODY_CHARS = 200_000;
export const MAX_MESSAGE_BYTES = 1024 * 1024;

const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** `ada@example.com`: the plain form only. Undefined when it is not one. */
export function plainAddress(raw: string): string | undefined {
  const text = raw.trim();
  if (text.length > 254) return undefined;
  const at = text.lastIndexOf('@');
  if (at < 1) return undefined;
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  if (local.length > 64 || !LOCAL.test(local)) return undefined;
  if (domain.length < 1 || domain.length > 253 || !domain.split('.').every((l) => LABEL.test(l))) return undefined;
  return text;
}

export type Mailbox = { address: string; name?: string };

/** `ada@example.com` or `Release Manager <ada@example.com>`. Undefined when it is neither. */
export function parseMailbox(raw: string): Mailbox | undefined {
  const text = raw.trim();
  const bracket = /^(.*)<([^<>]*)>$/.exec(text);
  if (!bracket) {
    const address = plainAddress(text);
    return address ? { address } : undefined;
  }
  const address = plainAddress(bracket[2] ?? '');
  if (!address) return undefined;
  const name = cleanText(bracket[1] ?? '').replace(/["\\<>]/g, '').trim();
  return name ? { address, name } : { address };
}

/** Removes every control character (so no CR or LF), and collapses runs of spaces. */
export function cleanText(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
  return text.replace(/[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

const isPrintableAscii = (text: string) => /^[\x20-\x7e]*$/.test(text);

/** RFC 2047 encoded words (UTF-8, base64), each at most 75 characters, split between code points. */
export function encodeWords(text: string): string {
  const words: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > 42) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
      chunk = '';
      bytes = 0;
    }
    chunk += ch;
    bytes += n;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
  return words.join('\r\n ');
}

/** Folds a long ASCII header value at spaces so no line is over 76 characters (a word longer than that stays whole). */
export function foldHeader(name: string, value: string): string {
  const out: string[] = [];
  let line = `${name}:`;
  for (const word of value.split(' ')) {
    if (line.length + 1 + word.length > 76 && line.length > name.length + 1) {
      out.push(line);
      line = ` ${word}`;
    } else line += ` ${word}`;
  }
  out.push(line);
  return out.join('\r\n');
}

/** A header whose value is free text: control characters out, non-ASCII encoded, long lines folded. */
export function textHeader(name: string, raw: string): string {
  const value = cleanText(raw);
  if (isPrintableAscii(value)) return foldHeader(name, value);
  return `${name}: ${encodeWords(value)}`;
}

/** A mailbox as it is written in From or To. */
export function formatMailbox(box: Mailbox): string {
  if (!box.name) return box.address;
  if (isPrintableAscii(box.name)) return /^[A-Za-z0-9 ]+$/.test(box.name) ? `${box.name} <${box.address}>` : `"${box.name}" <${box.address}>`;
  return `${encodeWords(box.name)} <${box.address}>`;
}

/** Quoted-printable (RFC 2045) of text with CRLF line breaks: lines of at most 76 characters, `=` and non-ASCII escaped. */
export function quotedPrintable(text: string): string {
  const lines = text.split('\r\n');
  const out: string[] = [];
  for (const line of lines) {
    let encoded = '';
    for (const byte of Buffer.from(line, 'utf8')) {
      const ch = String.fromCharCode(byte);
      encoded += (byte >= 33 && byte <= 126 && ch !== '=') || byte === 32 ? ch : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    // A space at the end of a line would be lost in transit.
    if (encoded.endsWith(' ')) encoded = `${encoded.slice(0, -1)}=20`;
    // Soft breaks. Never split an =XX escape.
    while (encoded.length > 76) {
      let cut = 75;
      if (encoded[cut - 1] === '=') cut -= 1;
      else if (encoded[cut - 2] === '=') cut -= 2;
      out.push(`${encoded.slice(0, cut)}=`);
      encoded = encoded.slice(cut);
    }
    out.push(encoded);
  }
  return out.join('\r\n');
}

export const toCrlf = (text: string) => text.replace(/\r\n|\r|\n/g, '\r\n');

export type BuildInput = {
  from: Mailbox;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  now: number;
  /** Tests only: a fixed boundary and message id. */
  boundary?: string;
  messageId?: string;
};

export type Built = { ok: true; data: string; envelopeFrom: string; envelopeTo: string[] } | { ok: false; hint: 'invalid_address' | 'message_too_large' };

/** The whole message, with CRLF line ends, no trailing dot and no dot-stuffing (the client does that). */
export function buildMessage(input: BuildInput): Built {
  if (input.to.length === 0 || input.to.length > MAX_RECIPIENTS) return { ok: false, hint: 'invalid_address' };
  const to: string[] = [];
  for (const raw of input.to) {
    const address = plainAddress(raw);
    if (!address) return { ok: false, hint: 'invalid_address' };
    if (!to.includes(address)) to.push(address);
  }
  if (input.text.length > MAX_BODY_CHARS || (input.html?.length ?? 0) > MAX_BODY_CHARS) return { ok: false, hint: 'message_too_large' };
  const domain = input.from.address.slice(input.from.address.lastIndexOf('@') + 1);
  const messageId = input.messageId ?? `<${randomBytes(16).toString('hex')}@${domain}>`;
  const headers = [
    `From: ${formatMailbox(input.from)}`,
    `To: ${to.join(', ')}`,
    textHeader('Subject', cleanText(input.subject).slice(0, MAX_SUBJECT_CHARS)),
    `Date: ${new Date(input.now).toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
  ];
  const text = quotedPrintable(toCrlf(input.text)).replace(/(\r\n)+$/, '');
  let body: string;
  if (input.html === undefined) {
    headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable');
    body = text;
  } else {
    const html = quotedPrintable(toCrlf(input.html)).replace(/(\r\n)+$/, '');
    let boundary = input.boundary ?? `=_mrm_${randomBytes(18).toString('hex')}`;
    while (text.includes(boundary) || html.includes(boundary)) boundary = `=_mrm_${randomBytes(18).toString('hex')}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      text,
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      html,
      `--${boundary}--`,
    ].join('\r\n');
  }
  const data = `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
  if (Buffer.byteLength(data) > MAX_MESSAGE_BYTES) return { ok: false, hint: 'message_too_large' };
  return { ok: true, data, envelopeFrom: input.from.address, envelopeTo: to };
}

/** The DATA payload: a leading dot on a line is doubled, and the end marker is added. */
export function dataPayload(message: string): string {
  const stuffed = message.replace(/^\./gm, '..');
  return `${stuffed}${stuffed.endsWith('\r\n') ? '' : '\r\n'}.\r\n`;
}
