import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Database, Sql } from '@mrm/db';
import { decryptSecret, encryptSecret } from '@mrm/vault';
import { recordAudit } from './audit.ts';
import type { MailErrorCode, MailHint, Mailer } from './mailer.ts';
import { plainAddress } from './mail-mime.ts';
import { base32Decode, base32Encode, checkTotp, newTotpSecret, normalizeTotpCode, otpauthUri } from './totp.ts';

/**
 * Two-factor authentication (docs/adr/0021-two-factor-and-smtp.md): an authenticator app (TOTP) and a code by email, as ways to
 * confirm a hard action (step-up) and, in multi-user mode, as the second step of signing in. This file is the store and the rules;
 * routes/two-factor.ts and routes/auth.ts call it. It does not import step-up.ts (step-up.ts imports it).
 *
 * Secrets: a TOTP secret is encrypted with the master key (bound to the person); an email code is stored only as an HMAC under the
 * master key (six digits are too few for a plain hash to protect). Neither, nor a code, is ever logged, audited or returned after the
 * moment it is made. Every guess is counted; a code is spent by ONE conditional UPDATE.
 */

// ---------------------------------------------------------------------------------------------
// Limits

export const EMAIL_CODE_TTL_MS = 10 * 60_000;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
export const MAIL_RESEND_COOLDOWN_MS = 60_000;
export const MAIL_USER_PER_HOUR = 6;
export const MAIL_WORKSPACE_PER_HOUR = 30;
/** Codes with no workspace (signing in) share this cap across the whole server. */
export const MAIL_INSTANCE_PER_HOUR = 60;
export const LOGIN_CHALLENGE_TTL_MS = 5 * 60_000;
export const LOGIN_CHALLENGE_MAX_ATTEMPTS = 5;
const HOUR = 3_600_000;

const sha256hex = (v: string) => createHash('sha256').update(v).digest('hex');
const nullIfUndefined = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

// ---------------------------------------------------------------------------------------------
// TOTP

export type TotpState = 'none' | 'pending' | 'active';
export type TotpStatus = { state: TotpState; confirmedAt: number | null };

const totpAad = (userId: string) => `totp:${userId}`;

export async function totpStatus(sql: Sql, userId: string): Promise<TotpStatus> {
  const [row] = await sql.query('SELECT confirmed_at FROM user_totp WHERE user_id = ?', [userId]);
  if (!row) return { state: 'none', confirmedAt: null };
  return row.confirmed_at === null ? { state: 'pending', confirmedAt: null } : { state: 'active', confirmedAt: Number(row.confirmed_at) };
}

export const hasActiveTotp = async (sql: Sql, userId: string) => (await totpStatus(sql, userId)).state === 'active';

/** Starts enrolling: a fresh secret replaces any unconfirmed one. Refused (undefined) while one is active: remove it first. */
export async function beginTotp(
  db: Database,
  input: { masterKey: Buffer; userId: string; account: string; issuer?: string },
  now: number,
): Promise<{ secret: string; uri: string } | undefined> {
  const secret = newTotpSecret();
  const stored = await db.transaction(async (tx) => {
    const [row] = await tx.query('SELECT confirmed_at FROM user_totp WHERE user_id = ?', [input.userId]);
    if (row && row.confirmed_at !== null) return false;
    await tx.execute('DELETE FROM user_totp WHERE user_id = ?', [input.userId]);
    await tx.execute('INSERT INTO user_totp (user_id, secret_enc, confirmed_at, last_step, created_at) VALUES (?, ?, NULL, NULL, ?)', [
      input.userId,
      encryptSecret(base32Encode(secret), input.masterKey, totpAad(input.userId)),
      now,
    ]);
    return true;
  });
  if (!stored) return undefined;
  return { secret: base32Encode(secret), uri: otpauthUri({ issuer: input.issuer ?? 'Mobile Release Manager', account: input.account, secret }) };
}

async function loadSecret(sql: Sql, masterKey: Buffer, userId: string): Promise<{ secret: Buffer; confirmed: boolean; lastStep: number | null } | undefined> {
  const [row] = await sql.query('SELECT secret_enc, confirmed_at, last_step FROM user_totp WHERE user_id = ?', [userId]);
  if (!row) return undefined;
  try {
    const secret = base32Decode(decryptSecret(String(row.secret_enc), masterKey, totpAad(userId)));
    if (!secret || secret.length === 0) return undefined;
    return { secret, confirmed: row.confirmed_at !== null, lastStep: row.last_step === null ? null : Number(row.last_step) };
  } catch {
    return undefined;
  }
}

export type CodeResult = { ok: true } | { ok: false; reason: 'invalid' | 'replay' | 'malformed' | 'not_enrolled' };

/**
 * Checks a typed code. `want` is 'pending' while enrolling (the first code confirms the secret) and 'active' afterwards. A code is
 * accepted once: the step it matched is written by an UPDATE that only succeeds if no later step was accepted first.
 */
export async function checkTotpCode(
  db: Database,
  input: { masterKey: Buffer; userId: string; code: string; want: 'pending' | 'active' },
  now: number,
): Promise<CodeResult> {
  const row = await loadSecret(db, input.masterKey, input.userId);
  if (!row || row.confirmed !== (input.want === 'active')) return { ok: false, reason: 'not_enrolled' };
  const checked = checkTotp(row.secret, input.code, now, row.lastStep);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  const moved =
    input.want === 'pending'
      ? await db.execute('UPDATE user_totp SET confirmed_at = ?, last_step = ? WHERE user_id = ? AND confirmed_at IS NULL', [now, checked.step, input.userId])
      : await db.execute('UPDATE user_totp SET last_step = ? WHERE user_id = ? AND confirmed_at IS NOT NULL AND (last_step IS NULL OR last_step < ?)', [checked.step, input.userId, checked.step]);
  return moved === 1 ? { ok: true } : { ok: false, reason: 'replay' };
}

export async function removeTotp(db: Database, userId: string): Promise<boolean> {
  return (await db.execute('DELETE FROM user_totp WHERE user_id = ?', [userId])) === 1;
}

// ---------------------------------------------------------------------------------------------
// The verified address

export type MailRow = { email: string; verifiedAt: number | null };

export async function userMail(sql: Sql, userId: string): Promise<MailRow | undefined> {
  const [row] = await sql.query('SELECT email, verified_at FROM user_mail WHERE user_id = ?', [userId]);
  return row ? { email: String(row.email), verifiedAt: row.verified_at === null ? null : Number(row.verified_at) } : undefined;
}

/**
 * The address email codes may go to: the one this person verified, and (on a server with accounts) only while it is still the account
 * email. A single-user database has no password and its account email is a placeholder, so the verified address stands alone there.
 */
export async function activeEmail(sql: Sql, userId: string): Promise<string | undefined> {
  const [row] = await sql.query(
    'SELECT m.email AS email, m.verified_at AS verified_at, u.email AS account_email, u.password_hash AS password_hash FROM user_mail m JOIN users u ON u.id = m.user_id WHERE m.user_id = ?',
    [userId],
  );
  if (!row || row.verified_at === null) return undefined;
  if (row.password_hash !== null && String(row.account_email).toLowerCase() !== String(row.email).toLowerCase()) return undefined;
  return String(row.email);
}

export const maskEmail = (email: string): string => {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(6, at - 1)))}${email.slice(at)}`;
};

export async function removeMail(db: Database, userId: string, now: number): Promise<boolean> {
  await db.execute('UPDATE mail_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [now, userId]);
  return (await db.execute('DELETE FROM user_mail WHERE user_id = ?', [userId])) === 1;
}

// ---------------------------------------------------------------------------------------------
// Mailed codes

export type MailPurpose = 'verify_email' | 'step_up' | 'login';

const macKey = (masterKey: Buffer) => createHmac('sha256', masterKey).update('mrm-mail-code-v1').digest();
const codeMac = (masterKey: Buffer, id: string, code: string) => createHmac('sha256', macKey(masterKey)).update(`${id}:${code}`).digest('hex');

export type SendFailure =
  | { ok: false; error: 'mail_not_configured' }
  | { ok: false; error: 'rate_limited'; retryAfterSeconds: number }
  | { ok: false; error: 'mail_failed'; code: MailErrorCode; hint?: MailHint }
  | { ok: false; error: 'busy' };
export type SendResult = { ok: true; expiresAt: number; resendAfterSeconds: number; to: string } | SendFailure;

const sending = new Set<string>();

async function mailLimit(sql: Sql, userId: string, workspaceId: string | undefined, now: number): Promise<number> {
  const [last] = await sql.query('SELECT MAX(created_at) AS at FROM mail_codes WHERE user_id = ?', [userId]);
  if (last?.at != null && now - Number(last.at) < MAIL_RESEND_COOLDOWN_MS) return Math.ceil((MAIL_RESEND_COOLDOWN_MS - (now - Number(last.at))) / 1000);
  const since = now - HOUR;
  const wait = async (sqlText: string, params: (string | number)[], cap: number): Promise<number> => {
    const [n] = await sql.query(`SELECT COUNT(*) AS n, MIN(created_at) AS first FROM mail_codes WHERE ${sqlText}`, params);
    return Number(n?.n ?? 0) >= cap && n?.first != null ? Math.max(1, Math.ceil((Number(n.first) + HOUR - now) / 1000)) : 0;
  };
  const perUser = await wait('user_id = ? AND created_at > ?', [userId, since], MAIL_USER_PER_HOUR);
  if (perUser > 0) return perUser;
  return workspaceId
    ? wait('workspace_id = ? AND created_at > ?', [workspaceId, since], MAIL_WORKSPACE_PER_HOUR)
    : wait('workspace_id IS NULL AND created_at > ?', [since], MAIL_INSTANCE_PER_HOUR);
}

export const codeMessage = (purpose: MailPurpose, code: string): { subject: string; text: string } => {
  const minutes = EMAIL_CODE_TTL_MS / 60_000;
  const what = purpose === 'verify_email' ? 'verify your email address' : purpose === 'login' ? 'finish signing in' : 'confirm an action';
  return {
    subject: `${code} is your Mobile Release Manager code`,
    text: [
      `Your code to ${what} is ${code}.`,
      '',
      `It works once and expires in ${minutes} minutes. Anyone who has it can ${what}, so do not share it.`,
      'If you did not ask for it, you can ignore this message; nothing changes until the code is entered.',
      '',
      'Mobile Release Manager',
    ].join('\n'),
  };
};

/** Makes a code, records its HMAC and mails it. Any code still open for this person and purpose stops working. */
export async function issueMailCode(
  db: Database,
  deps: { masterKey: Buffer; mailer: Mailer },
  input: { userId: string; purpose: MailPurpose; email: string; workspaceId?: string; binding?: string; action?: string; targetId?: string; targetHash?: string },
  now: number,
): Promise<SendResult> {
  if (!(await deps.mailer.configured())) return { ok: false, error: 'mail_not_configured' };
  if (sending.has(input.userId)) return { ok: false, error: 'busy' };
  sending.add(input.userId);
  try {
    const wait = await mailLimit(db, input.userId, input.workspaceId, now);
    if (wait > 0) return { ok: false, error: 'rate_limited', retryAfterSeconds: wait };
    const id = randomBytes(16).toString('hex');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await db.transaction(async (tx) => {
      await tx.execute('UPDATE mail_codes SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL', [now, input.userId, input.purpose]);
      await tx.execute(
        `INSERT INTO mail_codes (id, user_id, purpose, workspace_id, binding, action, target_id, target_hash, email, code_mac, attempts, created_at, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`,
        [id, input.userId, input.purpose, nullIfUndefined(input.workspaceId), nullIfUndefined(input.binding), nullIfUndefined(input.action), nullIfUndefined(input.targetId), nullIfUndefined(input.targetHash), input.email, codeMac(deps.masterKey, id, code), now, now + EMAIL_CODE_TTL_MS],
      );
    });
    const message = codeMessage(input.purpose, code);
    const sent = await deps.mailer.send({ to: input.email, subject: message.subject, text: message.text });
    if (!sent.ok) {
      // The code never left: it is closed (and still counts toward the hourly cap, so a broken server cannot be hammered).
      await db.execute('UPDATE mail_codes SET used_at = ? WHERE id = ?', [now, id]);
      return { ok: false, error: 'mail_failed', code: sent.code, ...(sent.hint ? { hint: sent.hint } : {}) };
    }
    return { ok: true, expiresAt: now + EMAIL_CODE_TTL_MS, resendAfterSeconds: MAIL_RESEND_COOLDOWN_MS / 1000, to: maskEmail(input.email) };
  } finally {
    sending.delete(input.userId);
  }
}

export type MailCodeMatch = {
  userId: string;
  purpose: MailPurpose;
  /** The session (step_up) or login challenge the code was made for. */
  binding?: string;
  workspaceId?: string;
  action?: string;
  targetId?: string | null;
  targetHash?: string | null;
};
export type MailCodeResult = { ok: true; email: string } | { ok: false; reason: 'invalid' | 'missing' | 'too_many_attempts' | 'malformed' };

const same = (stored: unknown, wanted: string | null | undefined) => (stored === null || stored === undefined ? null : String(stored)) === (wanted ?? null);

/**
 * Checks a typed code against the NEWEST open code of the person for this purpose, which must have been made for exactly this
 * session, workspace, action and target. The attempt is counted BEFORE the comparison and in the same statement that checks the
 * limit, so parallel guesses cannot exceed five; the right code is spent by one conditional UPDATE.
 */
export async function checkMailCode(db: Database, masterKey: Buffer, match: MailCodeMatch, typed: string, now: number): Promise<MailCodeResult> {
  const code = normalizeTotpCode(typed);
  const [row] = await db.query(
    'SELECT id, email, binding, workspace_id, action, target_id, target_hash, code_mac, expires_at FROM mail_codes WHERE user_id = ? AND purpose = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1',
    [match.userId, match.purpose],
  );
  if (!row || Number(row.expires_at) <= now) return { ok: false, reason: 'missing' };
  // Whatever the caller names must match what the code was made for (step-up names all of them; signing in names the challenge).
  if (match.binding !== undefined && !same(row.binding, match.binding)) return { ok: false, reason: 'missing' };
  if (match.workspaceId !== undefined && !same(row.workspace_id, match.workspaceId)) return { ok: false, reason: 'missing' };
  if (match.action !== undefined && !same(row.action, match.action)) return { ok: false, reason: 'missing' };
  if (match.targetId !== undefined && !same(row.target_id, match.targetId)) return { ok: false, reason: 'missing' };
  if (match.targetHash !== undefined && !same(row.target_hash, match.targetHash)) return { ok: false, reason: 'missing' };
  const counted = await db.execute('UPDATE mail_codes SET attempts = attempts + 1 WHERE id = ? AND used_at IS NULL AND attempts < ?', [String(row.id), EMAIL_CODE_MAX_ATTEMPTS]);
  if (counted !== 1) return { ok: false, reason: 'too_many_attempts' };
  if (code === undefined) return { ok: false, reason: 'malformed' };
  const expected = Buffer.from(String(row.code_mac), 'hex');
  const given = Buffer.from(codeMac(masterKey, String(row.id), code), 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'invalid' };
  const spent = await db.execute('UPDATE mail_codes SET used_at = ? WHERE id = ? AND used_at IS NULL', [now, String(row.id)]);
  return spent === 1 ? { ok: true, email: String(row.email) } : { ok: false, reason: 'missing' };
}

// ---------------------------------------------------------------------------------------------
// Verifying the address

export type BeginEmailResult = SendResult | { ok: false; error: 'email_required' | 'invalid_email' | 'already_verified' };

/**
 * Sends a code to the address that is being verified. On a server with accounts the address is the account email (nothing else can be
 * verified, so a code can only ever reach the person's own mailbox); in single-user mode, which has no account email, the person gives one.
 */
export async function beginEmailVerification(
  db: Database,
  deps: { masterKey: Buffer; mailer: Mailer },
  input: { userId: string; workspaceId?: string; requested?: string },
  now: number,
): Promise<BeginEmailResult> {
  const [user] = await db.query('SELECT email, password_hash FROM users WHERE id = ?', [input.userId]);
  if (!user) return { ok: false, error: 'invalid_email' };
  let email: string;
  if (user.password_hash !== null) email = String(user.email);
  else {
    if (input.requested === undefined || input.requested.trim() === '') return { ok: false, error: 'email_required' };
    const plain = plainAddress(input.requested);
    if (!plain) return { ok: false, error: 'invalid_email' };
    email = plain.toLowerCase();
  }
  const existing = await userMail(db, input.userId);
  if (existing?.verifiedAt !== null && existing !== undefined && existing.email.toLowerCase() === email.toLowerCase()) return { ok: false, error: 'already_verified' };
  if (!(await deps.mailer.configured())) return { ok: false, error: 'mail_not_configured' };
  await db.execute(
    `INSERT INTO user_mail (user_id, email, verified_at, created_at) VALUES (?, ?, NULL, ?)
     ON CONFLICT (user_id) DO UPDATE SET email = excluded.email, verified_at = NULL`,
    [input.userId, email, now],
  );
  return issueMailCode(db, deps, { userId: input.userId, purpose: 'verify_email', email, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}) }, now);
}

export async function confirmEmailVerification(db: Database, masterKey: Buffer, userId: string, typed: string, now: number): Promise<MailCodeResult> {
  const checked = await checkMailCode(db, masterKey, { userId, purpose: 'verify_email' }, typed, now);
  if (!checked.ok) return checked;
  const marked = await db.execute('UPDATE user_mail SET verified_at = ? WHERE user_id = ? AND lower(email) = lower(?)', [now, userId, checked.email]);
  return marked === 1 ? checked : { ok: false, reason: 'missing' };
}

// ---------------------------------------------------------------------------------------------
// Status

export type TwoFactorStatus = {
  totp: TotpStatus;
  email: { address: string; verified: boolean; verifiedAt: number | null; usable: boolean } | null;
};

export async function twoFactorStatus(sql: Sql, userId: string): Promise<TwoFactorStatus> {
  const mail = await userMail(sql, userId);
  return {
    totp: await totpStatus(sql, userId),
    email: mail ? { address: mail.email, verified: mail.verifiedAt !== null, verifiedAt: mail.verifiedAt, usable: (await activeEmail(sql, userId)) !== undefined } : null,
  };
}

export async function resetTwoFactor(db: Database, userId: string, now: number): Promise<void> {
  await db.execute('DELETE FROM user_totp WHERE user_id = ?', [userId]);
  await removeMail(db, userId, now);
  await db.execute('DELETE FROM login_challenges WHERE user_id = ?', [userId]);
}

// ---------------------------------------------------------------------------------------------
// The sign-in policy

export const loginModes = ['off', 'optional', 'admins', 'all'] as const;
export type LoginMode = (typeof loginModes)[number];
export const isLoginMode = (v: unknown): v is LoginMode => typeof v === 'string' && (loginModes as readonly string[]).includes(v);
const POLICY_KEY = 'security.twoFactor';

export async function getLoginMode(sql: Sql, workspaceId: string): Promise<LoginMode> {
  const [row] = await sql.query('SELECT value_json FROM workspace_settings WHERE workspace_id = ? AND key = ?', [workspaceId, POLICY_KEY]);
  if (!row) return 'off';
  try {
    const raw = JSON.parse(String(row.value_json)) as { mode?: unknown };
    return isLoginMode(raw.mode) ? raw.mode : 'off';
  } catch {
    return 'off';
  }
}

export async function setLoginMode(db: Database, input: { workspaceId: string; userId: string; mode: LoginMode }, now: number): Promise<{ from: LoginMode; to: LoginMode }> {
  return db.transaction(async (tx) => {
    const from = await getLoginMode(tx, input.workspaceId);
    await tx.execute(
      `INSERT INTO workspace_settings (workspace_id, key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [input.workspaceId, POLICY_KEY, JSON.stringify({ mode: input.mode }), now, input.userId],
    );
    await recordAudit(tx, { workspaceId: input.workspaceId, actor: { type: 'user', id: input.userId }, action: 'two_factor.policy_changed', target: { type: 'workspace', id: input.workspaceId }, detail: { from, to: input.mode }, at: now });
    return { from, to: input.mode };
  });
}

/** How many members of the workspace have no second factor (for the screen, before the policy is raised). */
export async function membersWithoutSecondFactor(sql: Sql, workspaceId: string): Promise<number> {
  const [row] = await sql.query(
    `SELECT COUNT(*) AS n FROM workspace_members m
      WHERE m.workspace_id = ?
        AND NOT EXISTS (SELECT 1 FROM user_totp t WHERE t.user_id = m.user_id AND t.confirmed_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM user_mail e WHERE e.user_id = m.user_id AND e.verified_at IS NOT NULL)`,
    [workspaceId],
  );
  return Number(row?.n ?? 0);
}

export type LoginNeed = 'none' | 'verify' | 'enroll';

/**
 * What signing in asks of this person after the password: nothing (every workspace of theirs has the policy off, or it is not
 * required of them and they have no factor), a second factor ('verify': they have one and the policy is not off), or to set one up
 * first ('enroll': the policy requires it of them and they have none). A person who HAS a factor is never offered enrollment here,
 * so a stolen password cannot add a second factor of its own to an account that already has one.
 */
export async function loginNeed(sql: Sql, userId: string): Promise<LoginNeed> {
  const rows = await sql.query('SELECT workspace_id, role FROM workspace_members WHERE user_id = ?', [userId]);
  let active = false;
  let required = false;
  for (const row of rows) {
    const mode = await getLoginMode(sql, String(row.workspace_id));
    if (mode === 'off') continue;
    active = true;
    const role = String(row.role);
    if (mode === 'all' || (mode === 'admins' && (role === 'owner' || role === 'admin'))) required = true;
  }
  if (!active) return 'none';
  const status = await twoFactorStatus(sql, userId);
  if (status.totp.state === 'active' || status.email?.verified) return 'verify';
  return required ? 'enroll' : 'none';
}

/** Writes an audit row for every workspace the person belongs to (signing in happens before any workspace is chosen). */
export async function auditForUser(db: Database, userId: string, action: string, detail: Record<string, unknown>, now: number): Promise<void> {
  const rows = await db.query('SELECT workspace_id FROM workspace_members WHERE user_id = ?', [userId]);
  for (const row of rows) {
    await recordAudit(db, { workspaceId: String(row.workspace_id), actor: { type: 'user', id: userId }, action, detail, at: now });
  }
}

// ---------------------------------------------------------------------------------------------
// The state between the password and the second factor

export type ChallengeKind = 'verify' | 'enroll';

/** A token the browser holds for five minutes. Only its SHA-256 is stored. */
export async function createLoginChallenge(db: Database, userId: string, kind: ChallengeKind, now: number): Promise<string> {
  await db.execute('DELETE FROM login_challenges WHERE expires_at <= ?', [now]);
  // Signing in again replaces an older open challenge of the same person.
  await db.execute('DELETE FROM login_challenges WHERE user_id = ?', [userId]);
  const token = `lgc_${randomBytes(32).toString('base64url')}`;
  await db.execute('INSERT INTO login_challenges (id, user_id, kind, attempts, created_at, expires_at) VALUES (?, ?, ?, 0, ?, ?)', [sha256hex(token), userId, kind, now, now + LOGIN_CHALLENGE_TTL_MS]);
  return token;
}

export type LoginChallenge = { id: string; userId: string; kind: ChallengeKind };

export async function loadLoginChallenge(sql: Sql, token: string, now: number): Promise<LoginChallenge | undefined> {
  if (typeof token !== 'string' || !token.startsWith('lgc_') || token.length > 100) return undefined;
  const id = sha256hex(token);
  const [row] = await sql.query('SELECT user_id, kind, attempts, expires_at FROM login_challenges WHERE id = ?', [id]);
  if (!row || Number(row.expires_at) <= now || Number(row.attempts) >= LOGIN_CHALLENGE_MAX_ATTEMPTS) return undefined;
  return { id, userId: String(row.user_id), kind: row.kind === 'enroll' ? 'enroll' : 'verify' };
}

/** Counts one second-factor attempt. False when the challenge has used its five (it then cannot be used at all). */
export async function countChallengeAttempt(db: Database, id: string): Promise<boolean> {
  return (await db.execute('UPDATE login_challenges SET attempts = attempts + 1 WHERE id = ? AND attempts < ?', [id, LOGIN_CHALLENGE_MAX_ATTEMPTS])) === 1;
}

/** Spends the challenge (single use). True for the one request that deletes it. */
export async function spendLoginChallenge(db: Database, id: string): Promise<boolean> {
  return (await db.execute('DELETE FROM login_challenges WHERE id = ?', [id])) === 1;
}

// ---------------------------------------------------------------------------------------------
// What the second step offers

export type LoginMethod = 'totp' | 'email' | 'recovery';

/**
 * The ways this person can pass the second step now: their authenticator app, an emailed code (only when a mail server is set up and
 * the address is verified) and a recovery code if they still have one. For an enrolment (the policy requires a factor and they have none)
 * it is the ways they can SET ONE UP: the app always, email when a mail server is set up.
 */
export async function loginMethods(sql: Sql, userId: string, need: ChallengeKind, mailConfigured: boolean): Promise<LoginMethod[]> {
  if (need === 'enroll') return mailConfigured ? ['totp', 'email'] : ['totp'];
  const methods: LoginMethod[] = [];
  if ((await totpStatus(sql, userId)).state === 'active') methods.push('totp');
  if (mailConfigured && (await activeEmail(sql, userId)) !== undefined) methods.push('email');
  const [left] = await sql.query('SELECT COUNT(*) AS n FROM step_up_recovery_codes WHERE user_id = ? AND used_at IS NULL', [userId]);
  if (Number(left?.n ?? 0) > 0) methods.push('recovery');
  return methods;
}
