/**
 * The mailer: the one way the server sends email (docs/api/mail.md, docs/adr/0021-two-factor-and-smtp.md).
 *
 * Other code (alerts, two-factor codes) only does `sendMail({ to, subject, text, html? })` and reads the answer. It never sees
 * SMTP, a host name or a password. The answer is `{ ok: true }` or `{ ok: false, code }` with a code from a FIXED vocabulary
 * (`mailErrorCodes`), so a screen can explain it and nothing a server said ever reaches a log, an audit row or an API answer.
 *
 * Which mailer is behind `sendMail`: `createApp` installs one that reads the SMTP settings (the environment, else the encrypted
 * instance setting) on every send. Until one is installed, and in a process with no SMTP settings, the answer is
 * `smtp_not_configured`. Tests install `createFakeMailer()` and read what was "sent".
 *
 * This file imports nothing from the rest of the server on purpose, so any module can use it without a cycle.
 */

export const mailErrorCodes = [
  'smtp_not_configured',
  'smtp_connection_failed',
  'smtp_auth_failed',
  'smtp_tls_failed',
  'smtp_rejected',
  'smtp_timeout',
] as const;
export type MailErrorCode = (typeof mailErrorCodes)[number];
export const isMailErrorCode = (value: unknown): value is MailErrorCode =>
  typeof value === 'string' && (mailErrorCodes as readonly string[]).includes(value);

/** A more precise, still fixed, reason that can ride along with a code. */
export type MailHint =
  | 'private_address_blocked'
  | 'host_not_allowed'
  | 'host_not_found'
  | 'invalid_address'
  | 'message_too_large'
  | 'login_needs_tls'
  | 'starttls_not_offered'
  | 'certificate_rejected'
  | 'no_auth_mechanism';

export type MailInput = {
  /** One address, or several (at most 20). Plain addresses only: `ada@example.com`. */
  to: string | string[];
  /** One line. Control characters are removed. */
  subject: string;
  text: string;
  html?: string;
};

export type MailResult = { ok: true } | { ok: false; code: MailErrorCode; hint?: MailHint };

/** One plain sentence per code, for the UI and the API. Never includes anything a mail server said. */
export const MAIL_ERROR_MESSAGES: Record<MailErrorCode, string> = {
  smtp_not_configured:
    'No mail server is set up. An admin can add one in Settings, Mail, or the person who runs this server sets MRM_SMTP_HOST.',
  smtp_connection_failed: 'The mail server could not be reached. Check the host name and the port.',
  smtp_auth_failed: 'The mail server refused the user name or password.',
  smtp_tls_failed:
    'A secure connection to the mail server could not be made. Check the security setting and the server certificate.',
  smtp_rejected: 'The mail server did not accept the message.',
  smtp_timeout: 'The mail server did not answer in time.',
};

export type Mailer = {
  send(input: MailInput): Promise<MailResult>;
  /** Whether a mail server is set up (it does not connect to it). */
  configured(): Promise<boolean>;
};

// ---------------------------------------------------------------------------------------------
// The active mailer

const notConfigured: Mailer = {
  send: async () => ({ ok: false, code: 'smtp_not_configured' }),
  configured: async () => false,
};

let active: Mailer = notConfigured;

/** Installs the mailer `sendMail` uses. Pass undefined to go back to "not configured". `createApp` calls this. */
export function setMailer(mailer: Mailer | undefined): void {
  active = mailer ?? notConfigured;
}

export const activeMailer = (): Mailer => active;

/** Sends one message through the active mailer. Never throws for a mail failure: read `ok`. */
export async function sendMail(input: MailInput): Promise<MailResult> {
  try {
    return await active.send(input);
  } catch {
    // A mailer bug must not take the caller down, and must not leak its message.
    return { ok: false, code: 'smtp_connection_failed' };
  }
}

/** Whether `sendMail` could send at all right now (a server is set up). */
export const mailConfigured = (): Promise<boolean> => active.configured().catch(() => false);

// ---------------------------------------------------------------------------------------------
// The fake, for tests (and the demo)

export type SentMail = { to: string[]; subject: string; text: string; html?: string; at: number };

export type FakeMailer = Mailer & {
  /** Everything accepted so far, oldest first. */
  sent: SentMail[];
  /** While set, every send fails with this code (and is not recorded). */
  failWith?: MailErrorCode | undefined;
  /** While false, `configured()` is false and sends answer `smtp_not_configured`. */
  isConfigured: boolean;
  last(): SentMail | undefined;
  /** The first run of six digits in the text of the last message (the code mails of this app have exactly one). */
  lastCode(): string | undefined;
  clear(): void;
};

export function createFakeMailer(options: { now?: () => number } = {}): FakeMailer {
  const now = options.now ?? Date.now;
  const fake: FakeMailer = {
    sent: [],
    isConfigured: true,
    async configured() {
      return fake.isConfigured;
    },
    async send(input) {
      if (!fake.isConfigured) return { ok: false, code: 'smtp_not_configured' };
      if (fake.failWith) return { ok: false, code: fake.failWith };
      const to = (Array.isArray(input.to) ? input.to : [input.to]).map((a) => a.trim());
      if (
        to.length === 0 ||
        to.length > 20 ||
        to.some((a) => !/^[^\s@<>",;\\]+@[^\s@<>",;\\]+$/.test(a))
      ) {
        return { ok: false, code: 'smtp_rejected', hint: 'invalid_address' };
      }
      fake.sent.push({
        to,
        subject: input.subject,
        text: input.text,
        ...(input.html === undefined ? {} : { html: input.html }),
        at: now(),
      });
      return { ok: true };
    },
    last: () => fake.sent[fake.sent.length - 1],
    lastCode: () => /\b(\d{6})\b/.exec(fake.sent[fake.sent.length - 1]?.text ?? '')?.[1],
    clear() {
      fake.sent.length = 0;
    },
  };
  return fake;
}
