import type { Database, Sql } from '@mrm/db';
import { decryptSecret, encryptSecret } from '@mrm/vault';
import { z } from 'zod';
import { recordAudit } from './audit.ts';
import { type Mailer, type MailInput, type MailResult } from './mailer.ts';
import { parseMailbox } from './mail-mime.ts';
import {
  type SmtpConfig,
  type SmtpOptions,
  type SmtpSecure,
  checkMailHost,
  defaultPort,
  sendViaSmtp,
  smtpSecureModes,
  validHost,
} from './smtp-client.ts';

/**
 * Where the SMTP settings come from (docs/api/mail.md):
 *
 * 1. The environment (MRM_SMTP_HOST and friends), when MRM_SMTP_HOST is set. The operator's choice: the screen shows it and cannot change it.
 * 2. Otherwise the instance setting an owner or admin saves in Settings, Mail. It is ONE row for the whole server (a mail server is not
 *    per workspace), stored as a single JSON document ENCRYPTED with the master key (AES-GCM, bound to its row), like a credential.
 *    The password is write-only: no route returns it, no log or audit row holds it.
 */

export type SmtpEnv = { config?: SmtpConfig; allowPrivateHosts: boolean };

const blank = (v: string | undefined) => (v === undefined || v.trim() === '' ? undefined : v.trim());

/** Reads MRM_SMTP_*. Throws an Error with a plain sentence when a value is wrong, so the server does not start with a half setting. */
export function parseSmtpEnv(env: Record<string, string | undefined>): SmtpEnv {
  const allow = blank(env.MRM_SMTP_ALLOW_PRIVATE_HOSTS);
  if (allow !== undefined && !['true', 'false', '1', '0'].includes(allow)) throw new Error('MRM_SMTP_ALLOW_PRIVATE_HOSTS must be true or false.');
  const allowPrivateHosts = allow === 'true' || allow === '1';
  const host = blank(env.MRM_SMTP_HOST);
  if (host === undefined) return { allowPrivateHosts };
  if (!validHost(host)) throw new Error('MRM_SMTP_HOST must be a host name or an IP address, without a scheme or a port.');
  const secureRaw = blank(env.MRM_SMTP_SECURE) ?? 'starttls';
  if (!(smtpSecureModes as readonly string[]).includes(secureRaw)) throw new Error('MRM_SMTP_SECURE must be none, starttls or tls.');
  const secure = secureRaw as SmtpSecure;
  const portRaw = blank(env.MRM_SMTP_PORT);
  const port = portRaw === undefined ? defaultPort(secure) : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MRM_SMTP_PORT must be a port number from 1 to 65535.');
  const from = blank(env.MRM_SMTP_FROM);
  if (!from || !parseMailbox(from)) throw new Error('MRM_SMTP_FROM must be set to the sender address, for example mrm@example.com or Release Manager <mrm@example.com>.');
  const user = blank(env.MRM_SMTP_USER);
  const password = env.MRM_SMTP_PASSWORD === undefined || env.MRM_SMTP_PASSWORD === '' ? undefined : env.MRM_SMTP_PASSWORD;
  if (/[\r\n\0]/.test(user ?? '') || /[\r\n\0]/.test(password ?? '')) throw new Error('MRM_SMTP_USER and MRM_SMTP_PASSWORD must not contain line breaks.');
  return { allowPrivateHosts, config: { host, port, secure, from, ...(user ? { user } : {}), ...(password === undefined ? {} : { password }) } };
}

// ---------------------------------------------------------------------------------------------
// The stored setting

const KEY = 'smtp';
const aad = () => `instance-setting:${KEY}`;

const storedSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  secure: z.enum(['none', 'starttls', 'tls']),
  from: z.string(),
  user: z.string().optional(),
  password: z.string().optional(),
});

export async function readStoredSmtp(sql: Sql, masterKey: Buffer): Promise<SmtpConfig | undefined> {
  const [row] = await sql.query('SELECT value_enc FROM instance_settings WHERE key = ?', [KEY]);
  if (!row) return undefined;
  try {
    const parsed = storedSchema.safeParse(JSON.parse(decryptSecret(String(row.value_enc), masterKey, aad())));
    return parsed.success ? stripUndefined(parsed.data) : undefined;
  } catch {
    // A value that cannot be read (another master key) is "not set up", never an error that blocks the app.
    return undefined;
  }
}

const stripUndefined = (c: z.infer<typeof storedSchema>): SmtpConfig => ({
  host: c.host,
  port: c.port,
  secure: c.secure,
  from: c.from,
  ...(c.user ? { user: c.user } : {}),
  ...(c.password === undefined ? {} : { password: c.password }),
});

export type SmtpSource = 'env' | 'settings' | 'none';

/** The settings in force: the environment first, then the stored setting. */
export async function effectiveSmtp(sql: Sql, masterKey: Buffer, env: SmtpEnv): Promise<{ source: SmtpSource; config?: SmtpConfig }> {
  if (env.config) return { source: 'env', config: env.config };
  const stored = await readStoredSmtp(sql, masterKey);
  return stored ? { source: 'settings', config: stored } : { source: 'none' };
}

/** What a screen may see. There is no password here: only whether one is set. */
export type SmtpView = {
  source: SmtpSource;
  configured: boolean;
  /** The environment decides: the screen cannot change it. */
  locked: boolean;
  host: string | null;
  port: number | null;
  secure: SmtpSecure | null;
  user: string | null;
  from: string | null;
  passwordSet: boolean;
  /** MRM_SMTP_ALLOW_PRIVATE_HOSTS: a loopback or private mail host is accepted. */
  allowPrivateHosts: boolean;
};

export function smtpView(state: { source: SmtpSource; config?: SmtpConfig }, env: SmtpEnv): SmtpView {
  const c = state.config;
  return {
    source: state.source,
    configured: c !== undefined,
    locked: state.source === 'env',
    host: c?.host ?? null,
    port: c?.port ?? null,
    secure: c?.secure ?? null,
    user: c?.user ?? null,
    from: c?.from ?? null,
    passwordSet: c?.password !== undefined && c.password !== '',
    allowPrivateHosts: env.allowPrivateHosts,
  };
}

export const smtpInputSchema = z
  .object({
    host: z.string().trim().min(1).max(253).refine(validHost, 'Use a host name or an IP address, without a scheme or a port.'),
    port: z.number().int().min(1).max(65535).optional(),
    secure: z.enum(['none', 'starttls', 'tls']),
    from: z.string().trim().min(3).max(300).refine((v) => parseMailbox(v) !== undefined, 'Use an address such as mrm@example.com.'),
    user: z.string().max(255).refine((v) => !/[\r\n\0]/.test(v), 'No line breaks.').optional(),
    /** Omitted: keep the saved password (only while host, port and user are unchanged). Empty: remove it. */
    password: z.string().max(512).refine((v) => !/[\r\n\0]/.test(v), 'No line breaks.').optional(),
  })
  .strict();
export type SmtpInput = z.infer<typeof smtpInputSchema>;

export type SaveSmtpResult =
  | { ok: true; view: SmtpView }
  | { ok: false; error: 'smtp_locked' | 'password_required' | 'address_blocked'; hint?: string };

/**
 * Saves the instance SMTP setting (encrypted). Refuses when the environment decides, when the host is not an allowed address, and when
 * the host, port or user changed without the password being typed again (so a stolen admin session cannot point the saved password at
 * a server of its own). Audit rows carry the host, the port and the mode, never the user or the password.
 */
export async function saveSmtp(
  db: Database,
  input: { masterKey: Buffer; env: SmtpEnv; value: SmtpInput; workspaceId: string; userId: string; now: number; resolve?: SmtpOptions['resolve'] },
): Promise<SaveSmtpResult> {
  if (input.env.config) return { ok: false, error: 'smtp_locked' };
  const checked = await checkMailHost(input.value.host, { allowPrivateHosts: input.env.allowPrivateHosts, ...(input.resolve ? { resolve: input.resolve } : {}) });
  if (!checked.ok && checked.hint !== 'host_not_found') return { ok: false, error: 'address_blocked', hint: checked.hint };
  const before = await readStoredSmtp(db, input.masterKey);
  const v = input.value;
  const port = v.port ?? defaultPort(v.secure);
  const user = v.user === undefined || v.user === '' ? undefined : v.user;
  const sameTarget = before !== undefined && before.host.toLowerCase() === v.host.toLowerCase() && before.port === port && (before.user ?? undefined) === user;
  let password: string | undefined;
  if (v.password === undefined) {
    if (user !== undefined && !sameTarget) return { ok: false, error: 'password_required' };
    password = sameTarget ? before?.password : undefined;
  } else password = v.password === '' ? undefined : v.password;
  const next: SmtpConfig = { host: v.host, port, secure: v.secure, from: v.from, ...(user ? { user } : {}), ...(password === undefined ? {} : { password }) };
  await db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO instance_settings (key, value_enc, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [KEY, encryptSecret(JSON.stringify(next), input.masterKey, aad()), input.now, input.userId],
    );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: { type: 'user', id: input.userId },
      action: 'mail.settings_changed',
      detail: { host: next.host, port: next.port, secure: next.secure, authenticated: user !== undefined, passwordChanged: v.password !== undefined },
      at: input.now,
    });
  });
  return { ok: true, view: smtpView({ source: 'settings', config: next }, input.env) };
}

export async function clearSmtp(db: Database, input: { env: SmtpEnv; workspaceId: string; userId: string; now: number }): Promise<'cleared' | 'smtp_locked'> {
  if (input.env.config) return 'smtp_locked';
  await db.transaction(async (tx) => {
    await tx.execute('DELETE FROM instance_settings WHERE key = ?', [KEY]);
    await recordAudit(tx, { workspaceId: input.workspaceId, actor: { type: 'user', id: input.userId }, action: 'mail.settings_cleared', at: input.now });
  });
  return 'cleared';
}

// ---------------------------------------------------------------------------------------------
// The mailer the app installs

export type MailerDeps = {
  db: Sql;
  masterKey: Buffer;
  env: SmtpEnv;
  now?: () => number;
  /** DNS (tests). */
  resolve?: SmtpOptions['resolve'];
  /** Tests: TLS trust for a fake server, and short time limits. */
  tls?: SmtpOptions['tls'];
  timeoutMs?: number;
  totalTimeoutMs?: number;
};

/** Reads the settings on every send (a saved change applies at once) and sends over SMTP. */
export function createConfiguredMailer(deps: MailerDeps): Mailer {
  const options = (): SmtpOptions => ({
    allowPrivateHosts: deps.env.allowPrivateHosts,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
    ...(deps.tls ? { tls: deps.tls } : {}),
    ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
    ...(deps.totalTimeoutMs ? { totalTimeoutMs: deps.totalTimeoutMs } : {}),
  });
  return {
    async configured() {
      return (await effectiveSmtp(deps.db, deps.masterKey, deps.env)).config !== undefined;
    },
    async send(input: MailInput): Promise<MailResult> {
      const { config } = await effectiveSmtp(deps.db, deps.masterKey, deps.env);
      if (!config) return { ok: false, code: 'smtp_not_configured' };
      return sendViaSmtp(config, input, options());
    },
  };
}
