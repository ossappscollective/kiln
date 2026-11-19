// Two-factor authentication and mail, for the web (docs/api/two-factor.md, docs/api/mail.md, docs/adr/0021-two-factor-and-smtp.md).
// Pure functions and types: the screens (Login, the Security card, the mail card, StepUpDialog) hold no rules of their own.
// Every sentence for a failure comes from a fixed code the server sends, never from a mail server or a browser.
// The web target is ES2017: no flatMap, fromEntries or newer calls here.

export type TotpState = 'none' | 'pending' | 'active';
export type TotpStatus = { state: TotpState; confirmedAt: number | null };
export type EmailFactor = { address: string; verified: boolean; verifiedAt: number | null; usable: boolean };
export type LoginMode = 'off' | 'optional' | 'admins' | 'all';

export type TwoFactorStatus = {
  totp: TotpStatus;
  email: EmailFactor | null;
  mailConfigured: boolean;
  /** Single-user mode has no account email: the person types the address the codes go to. */
  emailAddressEditable: boolean;
  recovery?: { remaining: number; total: number; generatedAt: number | null };
  login: { supported: boolean; mode: LoginMode; membersWithoutSecondFactor?: number };
};

export type TotpBegin = { secret: string; uri: string; issuer: string; account: string };
export type CodeSent = { expiresAt: number; resendAfterSeconds: number; to: string };

export type SmtpSecure = 'none' | 'starttls' | 'tls';
export type SmtpSource = 'env' | 'settings' | 'none';
export type SmtpSettings = {
  source: SmtpSource;
  configured: boolean;
  locked: boolean;
  host: string | null;
  port: number | null;
  secure: SmtpSecure | null;
  user: string | null;
  from: string | null;
  passwordSet: boolean;
  allowPrivateHosts: boolean;
};
export type SmtpInput = { host: string; port?: number; secure: SmtpSecure; user?: string; password?: string; from: string };
export type MailTestResult = { ok: true; to: string } | { ok: false; code: string; hint?: string; message?: string };

/** What `POST /api/auth/login` answers when a second factor is asked for. */
export type LoginChallenge = { twoFactorRequired: true; enrollmentRequired: boolean; challenge: string; methods: LoginMethod[] };
export type LoginMethod = 'totp' | 'email' | 'recovery';
export type LoginResult = { user: { id: string; email: string; displayName: string } } | LoginChallenge;

export const isLoginChallenge = (r: unknown): r is LoginChallenge =>
  !!r && typeof r === 'object' && (r as { twoFactorRequired?: unknown }).twoFactorRequired === true && typeof (r as { challenge?: unknown }).challenge === 'string';

export const LOGIN_MODES: { value: LoginMode; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'Signing in needs the password only. An authenticator app or email can still confirm hard actions.' },
  { value: 'optional', label: 'Optional', hint: 'People who set up an authenticator app or email must use it after their password.' },
  { value: 'admins', label: 'Required for owners and admins', hint: 'Owners and admins must have a second factor. If they have none, they set one up at their next sign-in.' },
  { value: 'all', label: 'Required for everyone', hint: 'Every member must have a second factor. Anyone without one sets it up at their next sign-in.' },
];

/** Keeps only the digits, at most six: what a code field holds while typing (a pasted `123 456` works). */
export const codeDigits = (text: string): string => text.replace(/\D+/g, '').slice(0, 6);
export const codeComplete = (text: string): boolean => /^\d{6}$/.test(text.replace(/[\s-]+/g, ''));

/** The secret in groups of four, to be typed into an app by hand. */
export const groupSecret = (secret: string): string => (secret.match(/.{1,4}/g) ?? []).join(' ');

export const METHOD_LABELS: Record<LoginMethod, string> = {
  totp: 'Authenticator app',
  email: 'Email me a code',
  recovery: 'Recovery code',
};

/** Which of `methods` to show first: the app, then email, then a recovery code. */
export function firstMethod(methods: readonly LoginMethod[]): LoginMethod | undefined {
  const order: LoginMethod[] = ['totp', 'email', 'recovery'];
  for (const m of order) if (methods.indexOf(m) >= 0) return m;
  return undefined;
}

export function twoFactorSummary(status: Pick<TwoFactorStatus, 'totp' | 'email'>): string {
  const parts: string[] = [];
  if (status.totp.state === 'active') parts.push('authenticator app');
  if (status.email?.verified) parts.push('email');
  return parts.length === 0 ? 'Not set up' : `On: ${parts.join(' and ')}`;
}

export const loginModeSummary = (mode: LoginMode): string => LOGIN_MODES.filter((m) => m.value === mode)[0]?.label ?? 'Off';

/** Seconds left until a resend is allowed, counted from when the code was sent. */
export const resendIn = (sentAt: number, resendAfterSeconds: number, now: number): number => Math.max(0, Math.ceil((sentAt + resendAfterSeconds * 1000 - now) / 1000));

const WAIT = (seconds: number) => (seconds < 60 ? `${Math.max(1, Math.ceil(seconds))} seconds` : `${Math.ceil(seconds / 60)} minute${Math.ceil(seconds / 60) === 1 ? '' : 's'}`);

const MAIL_FAILURES: Record<string, string> = {
  smtp_not_configured: 'No mail server is set up. An admin can add one in Settings, Mail.',
  smtp_connection_failed: 'The mail server could not be reached. Check the host name and the port.',
  smtp_auth_failed: 'The mail server refused the user name or password.',
  smtp_tls_failed: 'A secure connection to the mail server could not be made. Check the security setting and the server certificate.',
  smtp_rejected: 'The mail server did not accept the message.',
  smtp_timeout: 'The mail server did not answer in time.',
};

export const mailFailureMessage = (code: string): string => MAIL_FAILURES[code] ?? 'The message could not be sent.';

const HINTS: Record<string, string> = {
  private_address_blocked: 'This server only sends mail to public addresses. For a mail server on this machine or your network, the person who runs this server sets MRM_SMTP_ALLOW_PRIVATE_HOSTS=true and restarts it.',
  host_not_allowed: 'That address cannot be used for mail.',
  host_not_found: 'The host name could not be found.',
  login_needs_tls: 'A password is only sent over an encrypted connection. Choose STARTTLS or TLS, or a mail server on this machine.',
  starttls_not_offered: 'The server does not offer STARTTLS. Choose TLS (usually port 465), or a server that supports STARTTLS.',
  certificate_rejected: 'The server certificate was not accepted (not trusted, expired or for another name).',
  no_auth_mechanism: 'The server offers no login method this app supports (PLAIN or LOGIN).',
  invalid_address: 'One of the addresses is not valid.',
  message_too_large: 'The message is too large.',
};

export const mailHintMessage = (hint: string | undefined): string | undefined => (hint ? HINTS[hint] : undefined);

/** Plain words for the fixed codes of the two-factor and mail routes. Unknown codes get no sentence here (undefined). */
export function twoFactorMessage(code: string, retryAfter?: number): string | undefined {
  switch (code) {
    case 'invalid_code':
      return 'That code is not right. Check it and try again.';
    case 'code_expired':
      return 'That code expired or was never sent. Ask for a new one.';
    case 'invalid_second_factor':
      return 'That code did not work. Try again, or sign in again.';
    case 'challenge_invalid':
      return 'This sign-in expired or was used up. Sign in again.';
    case 'wrong_challenge':
      return 'This step does not apply to your sign-in. Sign in again.';
    case 'rate_limited':
      return `Too many requests. Try again in ${WAIT(retryAfter ?? 60)}.`;
    case 'busy':
      return 'Another request is in progress. Try again in a moment.';
    case 'mail_not_configured':
      return 'No mail server is set up, so codes cannot be emailed. An admin can add one in Settings, Mail.';
    case 'mail_failed':
      return 'The code could not be sent. Check the mail settings.';
    case 'already_enrolled':
      return 'An authenticator app is already set up. Remove it first to set up another.';
    case 'already_verified':
      return 'This address is already verified.';
    case 'not_started':
      return 'Start setting up the authenticator app first.';
    case 'email_required':
      return 'Enter the email address to send the code to.';
    case 'invalid_email':
      return 'That does not look like an email address.';
    case 'two_factor_not_enrolled':
      return 'Set up an authenticator app or verify your email first, so you can still sign in.';
    case 'single_user_mode':
      return 'Signing in with a second factor needs a server with accounts.';
    case 'smtp_locked':
      return 'The mail server is set by the server environment (MRM_SMTP_HOST). Change it there.';
    case 'password_required':
      return 'Type the password again when the host, the port or the user name changes.';
    case 'address_not_allowed':
      return 'That mail server address cannot be used.';
    default:
      return undefined;
  }
}

type ErrorLike = { code?: unknown; message?: unknown; body?: unknown };

/** The sentence for a failed two-factor call: a mail failure names its code, and a hint adds one more sentence. */
export function twoFactorProblem(error: unknown): string {
  const e = error as ErrorLike | null;
  if (!e || typeof e !== 'object') return 'Something went wrong. Try again.';
  const body = (e.body && typeof e.body === 'object' ? e.body : {}) as { code?: unknown; hint?: unknown; message?: unknown };
  if (e.code === 'mail_failed' && typeof body.code === 'string') {
    const hint = typeof body.hint === 'string' ? mailHintMessage(body.hint) : undefined;
    return hint ? `${mailFailureMessage(body.code)} ${hint}` : mailFailureMessage(body.code);
  }
  if (e.code === 'address_not_allowed') return mailHintMessage(typeof body.hint === 'string' ? body.hint : undefined) ?? 'That mail server address cannot be used.';
  // On these routes `too_many_attempts` means "ask for a new code" (the server's own sentence says so).
  if (e.code === 'too_many_attempts' && typeof body.message === 'string') return body.message;
  return typeof e.message === 'string' && e.message ? e.message : 'Something went wrong. Try again.';
}

export function mailTestSummary(result: MailTestResult): string {
  if (result.ok) return `A test message was sent to ${result.to}. Check that inbox.`;
  const hint = mailHintMessage(result.hint);
  return hint ? `${mailFailureMessage(result.code)} ${hint}` : mailFailureMessage(result.code);
}

export function smtpSourceLabel(source: SmtpSource): string {
  return source === 'env' ? 'Set by the server environment (read only)' : source === 'settings' ? 'Saved here' : 'Not set up';
}

export const SMTP_SECURE_OPTIONS: { value: SmtpSecure; label: string; port: number }[] = [
  { value: 'starttls', label: 'STARTTLS (usually port 587)', port: 587 },
  { value: 'tls', label: 'TLS from the start (usually port 465)', port: 465 },
  { value: 'none', label: 'None (usually port 25; only for a server on this machine)', port: 25 },
];
export const defaultSmtpPort = (secure: SmtpSecure): number => SMTP_SECURE_OPTIONS.filter((o) => o.value === secure)[0]?.port ?? 587;

/** A first look at a form before it is sent (the server decides for real). A sentence, or '' when it looks fine. */
export function smtpProblem(input: { host: string; port: string; from: string }): string {
  const host = input.host.trim();
  if (!host) return 'Enter the mail server host name.';
  if (/[\s/@:]/.test(host) && !/^[0-9a-fA-F:.]+$/.test(host)) return 'The host is a name such as smtp.example.com, without smtp:// or a port.';
  const port = input.port.trim();
  if (port !== '' && !(/^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) return 'The port is a number from 1 to 65535.';
  if (!/^[^\s@<>]+@[^\s@<>]+$|<[^\s@<>]+@[^\s@<>]+>\s*$/.test(input.from.trim())) return 'Enter the sender address, such as mrm@example.com.';
  return '';
}
