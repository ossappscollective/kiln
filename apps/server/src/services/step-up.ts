import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Database, Sql } from '@kiln/db';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from '../http.ts';
import { hashPassword, type ScryptCost, verifyPassword } from '../passwords.ts';
import { recordAudit } from './audit.ts';
import { activeEmail, checkMailCode, checkTotpCode, hasActiveTotp } from './two-factor.ts';
import {
  b64u,
  isValidRpId,
  SUPPORTED_ALGS,
  verifyAssertion,
  verifyRegistration,
  WebAuthnError,
} from './webauthn.ts';

/**
 * Step-up confirmation (docs/adr/0019-step-up-confirmation.md): a second, fresh proof before a hard
 * action. A person proves themselves with a passkey (WebAuthn, user verification required) or a
 * password and receives a GRANT: a random string, stored only as its SHA-256, bound to the session,
 * the person, the workspace, the action class and optionally a target id and hash, valid for 5
 * minutes and spent by the first use. The gated apply routes call `requireStepUp` before they do
 * anything; previews stay free. With the policy off (the default) `requireStepUp` returns at once
 * and nothing changes.
 */

export const SESSION_COOKIE_NAME = 'mrm_session';

/** The classes of hard actions a policy can cover. */
export const stepUpActions = [
  'store.publish',
  'store.submit',
  'store.release',
  'rollout',
  'internal_sharing',
  'analytics.enable_apple',
  'credential.delete',
  'flags',
  'store.push_draft',
] as const;
export type StepUpAction = (typeof stepUpActions)[number];
export const isStepUpAction = (value: unknown): value is StepUpAction =>
  typeof value === 'string' && (stepUpActions as readonly string[]).includes(value);

/** Covered by default when the policy is switched on. A draft push never reaches users, so it is opt-in. */
export const defaultCoveredActions: readonly StepUpAction[] = stepUpActions.filter(
  (a) => a !== 'store.push_draft',
);

/** Changing factors or the policy. Not a policy class: it is enforced whenever the person has a factor. */
export const MANAGE_ACTION = 'step_up.manage';
export type GrantAction = StepUpAction | typeof MANAGE_ACTION;
export const isGrantAction = (value: unknown): value is GrantAction =>
  value === MANAGE_ACTION || isStepUpAction(value);

export const GRANT_TTL_MS = 5 * 60_000;
export const CHALLENGE_TTL_MS = 2 * 60_000;
export const MAX_PASSKEYS = 10;
export const MAX_OPEN_CHALLENGES = 20;
/** Consecutive failures before the lockout starts; then 30 s, doubling, at most 15 minutes. */
export const LOCKOUT_AFTER = 5;
export const LOCKOUT_BASE_MS = 30_000;
export const LOCKOUT_MAX_MS = 15 * 60_000;

const sha256hex = (value: string) => createHash('sha256').update(value).digest('hex');
const SETTING_KEY = 'security.stepUp';

// ---------------------------------------------------------------------------------------------
// Demo hook: the demo server has no real person to ask. One flag per database object.

const autoApproved = new WeakSet<object>();
/** Makes `requireStepUp` pass for this database (demo mode only). */
export const enableStepUpAutoApprove = (db: object) => void autoApproved.add(db);

// ---------------------------------------------------------------------------------------------
// Policy

export type StepUpMode = 'off' | 'hard_actions';
export type StepUpPolicy = {
  mode: StepUpMode;
  actions: StepUpAction[];
  unattended: StepUpAction[];
};

export const defaultPolicy = (): StepUpPolicy => ({
  mode: 'off',
  actions: [...defaultCoveredActions],
  unattended: [],
});

const onlyActions = (raw: unknown): StepUpAction[] =>
  Array.isArray(raw) ? stepUpActions.filter((a) => raw.includes(a)) : [];

export async function getPolicy(sql: Sql, workspaceId: string): Promise<StepUpPolicy> {
  const [row] = await sql.query(
    'SELECT value_json FROM workspace_settings WHERE workspace_id = ? AND key = ?',
    [workspaceId, SETTING_KEY],
  );
  const policy = defaultPolicy();
  if (!row) return policy;
  try {
    const raw = JSON.parse(String(row.value_json)) as Record<string, unknown>;
    if (raw.mode === 'hard_actions') policy.mode = 'hard_actions';
    if (Array.isArray(raw.actions)) policy.actions = onlyActions(raw.actions);
    if (Array.isArray(raw.unattended)) policy.unattended = onlyActions(raw.unattended);
  } catch {
    // An unreadable value is the default (off), as for other settings.
  }
  return policy;
}

export async function setPolicy(
  db: Database,
  input: { workspaceId: string; policy: StepUpPolicy; userId: string },
  now: number,
): Promise<StepUpPolicy> {
  const next: StepUpPolicy = {
    mode: input.policy.mode,
    actions: onlyActions(input.policy.actions),
    unattended: onlyActions(input.policy.unattended),
  };
  return db.transaction(async (tx) => {
    const before = await getPolicy(tx, input.workspaceId);
    await tx.execute(
      `INSERT INTO workspace_settings (workspace_id, key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [input.workspaceId, SETTING_KEY, JSON.stringify(next), now, input.userId],
    );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: { type: 'user', id: input.userId },
      action: 'step_up.policy_changed',
      target: { type: 'workspace', id: input.workspaceId },
      detail: { from: before, to: next },
      at: now,
    });
    return next;
  });
}

// ---------------------------------------------------------------------------------------------
// Factors

export type PasskeyRow = {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  transports: string[];
};

export async function listPasskeys(sql: Sql, userId: string): Promise<PasskeyRow[]> {
  const rows = await sql.query(
    'SELECT id, name, created_at, last_used_at, transports FROM step_up_credentials WHERE user_id = ? ORDER BY created_at, id',
    [userId],
  );
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    createdAt: Number(r.created_at),
    lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at),
    transports: r.transports ? String(r.transports).split(',').filter(Boolean) : [],
  }));
}

/** 'confirmation' (the separate password), 'account' (the sign-in password) or none. */
export async function passwordKind(
  sql: Sql,
  userId: string,
): Promise<'confirmation' | 'account' | undefined> {
  const [own] = await sql.query('SELECT confirmation_hash FROM step_up_users WHERE user_id = ?', [
    userId,
  ]);
  if (own?.confirmation_hash) return 'confirmation';
  const [user] = await sql.query('SELECT password_hash FROM users WHERE id = ?', [userId]);
  return user?.password_hash ? 'account' : undefined;
}

export type LockState = { failedCount: number; lockedUntil: number | null };
export async function lockState(sql: Sql, userId: string): Promise<LockState> {
  const [row] = await sql.query(
    'SELECT failed_count, locked_until FROM step_up_users WHERE user_id = ?',
    [userId],
  );
  return {
    failedCount: row ? Number(row.failed_count) : 0,
    lockedUntil: row?.locked_until == null ? null : Number(row.locked_until),
  };
}

export const lockoutMs = (failures: number) =>
  failures < LOCKOUT_AFTER
    ? 0
    : Math.min(LOCKOUT_MAX_MS, LOCKOUT_BASE_MS * 2 ** (failures - LOCKOUT_AFTER));

async function recordFailure(sql: Sql, userId: string, now: number): Promise<number> {
  await sql.execute(
    `INSERT INTO step_up_users (user_id, failed_count, updated_at) VALUES (?, 1, ?)
     ON CONFLICT (user_id) DO UPDATE SET failed_count = step_up_users.failed_count + 1, updated_at = excluded.updated_at`,
    [userId, now],
  );
  const { failedCount } = await lockState(sql, userId);
  const wait = lockoutMs(failedCount);
  if (wait > 0)
    await sql.execute('UPDATE step_up_users SET locked_until = ? WHERE user_id = ?', [
      now + wait,
      userId,
    ]);
  return failedCount;
}

async function resetFailures(sql: Sql, userId: string, now: number): Promise<void> {
  await sql.execute(
    'UPDATE step_up_users SET failed_count = 0, locked_until = NULL, updated_at = ? WHERE user_id = ?',
    [now, userId],
  );
}

export async function setConfirmationPassword(
  db: Database,
  userId: string,
  password: string,
  now: number,
  cost?: ScryptCost | undefined,
): Promise<void> {
  const hash = await hashPassword(password, cost);
  await db.execute(
    `INSERT INTO step_up_users (user_id, confirmation_hash, failed_count, updated_at) VALUES (?, ?, 0, ?)
     ON CONFLICT (user_id) DO UPDATE SET confirmation_hash = excluded.confirmation_hash, failed_count = 0, locked_until = NULL, updated_at = excluded.updated_at`,
    [userId, hash, now],
  );
}

export async function isEnrolled(sql: Sql, userId: string): Promise<boolean> {
  if ((await listPasskeys(sql, userId)).length > 0) return true;
  // An authenticator app or a verified address is a way to confirm too (docs/adr/0021-two-factor-and-smtp.md).
  if (await hasActiveTotp(sql, userId)) return true;
  if ((await activeEmail(sql, userId)) !== undefined) return true;
  return (await passwordKind(sql, userId)) !== undefined;
}

// ---------------------------------------------------------------------------------------------
// Recovery codes: ten one-time codes a person can keep offline. A code is a THIRD way to confirm (one use, then it is gone), and the
// way back in when the only passkey or confirmation password is lost: confirm with a code for `step_up.manage`, remove or replace the
// lost factor. A code is 100 random bits, so a salted SHA-256 is enough to store (nothing to guess offline). They are shown once.

export const RECOVERY_CODE_COUNT = 10;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_SYMBOLS = 20;

/** `XXXXX-XXXXX-XXXXX-XXXXX`: 20 symbols of 5 bits each = 100 random bits. */
export function newRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_SYMBOLS);
  let out = '';
  for (let i = 0; i < RECOVERY_SYMBOLS; i++) {
    out += CROCKFORD[(bytes[i] as number) & 31];
    if (i % 5 === 4 && i < RECOVERY_SYMBOLS - 1) out += '-';
  }
  return out;
}

/** What was typed, as the 20 symbols it stands for (case, dashes and spaces do not matter; O is 0, I and L are 1), or undefined. */
export function normalizeRecoveryCode(input: string): string | undefined {
  const folded = input
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return folded.length === RECOVERY_SYMBOLS && [...folded].every((c) => CROCKFORD.includes(c))
    ? folded
    : undefined;
}

const recoveryHash = (userId: string, normalized: string) =>
  sha256hex(`mrm-recovery-v1:${userId}:${normalized}`);

export type RecoveryStatus = { remaining: number; total: number; generatedAt: number | null };

export async function recoveryStatus(sql: Sql, userId: string): Promise<RecoveryStatus> {
  const [row] = await sql.query(
    'SELECT COUNT(*) AS n, MIN(created_at) AS at FROM step_up_recovery_codes WHERE user_id = ?',
    [userId],
  );
  const [left] = await sql.query(
    'SELECT COUNT(*) AS n FROM step_up_recovery_codes WHERE user_id = ? AND used_at IS NULL',
    [userId],
  );
  return {
    remaining: Number(left?.n ?? 0),
    total: Number(row?.n ?? 0),
    generatedAt: row?.at == null ? null : Number(row.at),
  };
}

/** Replaces every code of the person (the old ones stop working at once) with ten new ones. The codes are returned here and nowhere else. */
export async function generateRecoveryCodes(
  db: Database,
  userId: string,
  now: number,
): Promise<{ codes: string[]; replaced: number }> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  const replaced = await db.transaction(async (tx) => {
    const [before] = await tx.query(
      'SELECT COUNT(*) AS n FROM step_up_recovery_codes WHERE user_id = ? AND used_at IS NULL',
      [userId],
    );
    await tx.execute('DELETE FROM step_up_recovery_codes WHERE user_id = ?', [userId]);
    for (const code of codes) {
      const normalized = normalizeRecoveryCode(code) ?? '';
      await tx.execute(
        'INSERT INTO step_up_recovery_codes (id, user_id, code_hash, created_at, used_at) VALUES (?, ?, ?, ?, NULL)',
        [randomUUID(), userId, recoveryHash(userId, normalized), now],
      );
    }
    return Number(before?.n ?? 0);
  });
  return { codes, replaced };
}

/**
 * Spends the code if it is one of this person's unused ones. Every unused hash is compared in constant time (no early exit), then ONE
 * statement marks the match used, so two requests with the same code cannot both pass.
 */
export async function spendRecoveryCode(
  db: Database,
  userId: string,
  typed: string,
  now: number,
): Promise<boolean> {
  const candidate = Buffer.from(recoveryHash(userId, normalizeRecoveryCode(typed) ?? ''), 'hex');
  const rows = await db.query(
    'SELECT id, code_hash FROM step_up_recovery_codes WHERE user_id = ? AND used_at IS NULL',
    [userId],
  );
  let matched: string | undefined;
  for (const row of rows) {
    const stored = Buffer.from(String(row.code_hash), 'hex');
    if (stored.length === candidate.length && timingSafeEqual(stored, candidate))
      matched = String(row.id);
  }
  if (matched === undefined || normalizeRecoveryCode(typed) === undefined) return false;
  return (
    (await db.execute(
      'UPDATE step_up_recovery_codes SET used_at = ? WHERE id = ? AND user_id = ? AND used_at IS NULL',
      [now, matched, userId],
    )) === 1
  );
}

// ---------------------------------------------------------------------------------------------
// Origin and relying party

export type RpInfo = {
  rpId: string;
  origin: string;
  origins: string[];
  webauthnAvailable: boolean;
};

/**
 * The relying party is this server: the configured public origin, else the origin the request came
 * to (Host, or X-Forwarded-Host behind a trusted proxy). Origins of the same host with another port
 * that are trusted (a dev server) are accepted too: the rp id is a host name, not a port.
 */
export function relyingParty(
  c: Context,
  opts: {
    publicOrigin?: string | undefined;
    trustProxy?: boolean | undefined;
    trustedOrigins?: string[] | undefined;
  },
): RpInfo {
  let origin: string;
  if (opts.publicOrigin) {
    origin = new URL(opts.publicOrigin).origin;
  } else {
    const url = new URL(c.req.url);
    const proto =
      (opts.trustProxy ? c.req.header('x-forwarded-proto') : undefined) ??
      url.protocol.replace(':', '');
    const host =
      (opts.trustProxy ? c.req.header('x-forwarded-host') : undefined) ??
      c.req.header('host') ??
      url.host;
    origin = `${proto}://${host}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return { rpId: '', origin, origins: [], webauthnAvailable: false };
  }
  const rpId = parsed.hostname;
  const origins = [parsed.origin];
  for (const t of opts.trustedOrigins ?? []) {
    try {
      const u = new URL(t);
      if (u.hostname === rpId && !origins.includes(u.origin)) origins.push(u.origin);
    } catch {
      // Ignore a malformed trusted origin.
    }
  }
  const secure = parsed.protocol === 'https:' || rpId === 'localhost';
  return { rpId, origin: parsed.origin, origins, webauthnAvailable: secure && isValidRpId(rpId) };
}

// ---------------------------------------------------------------------------------------------
// Sessions and challenges

export function sessionIdOf(c: Context): string | undefined {
  const token = getCookie(c, SESSION_COOKIE_NAME);
  return token ? sha256hex(token) : undefined;
}

type Challenge = {
  id: string;
  userId: string;
  sessionId: string;
  purpose: 'register' | 'assert';
  challenge: string;
  action: string | null;
  targetId: string | null;
  targetHash: string | null;
  workspaceId: string | null;
};

export async function issueChallenge(
  db: Database,
  input: {
    userId: string;
    sessionId: string;
    purpose: 'register' | 'assert';
    workspaceId?: string;
    action?: string;
    targetId?: string;
    targetHash?: string;
  },
  now: number,
): Promise<{ id: string; challenge: string; expiresAt: number } | undefined> {
  await db.execute('DELETE FROM step_up_challenges WHERE expires_at <= ?', [now]);
  const [open] = await db.query('SELECT COUNT(*) AS n FROM step_up_challenges WHERE user_id = ?', [
    input.userId,
  ]);
  if (Number(open?.n ?? 0) >= MAX_OPEN_CHALLENGES) return undefined;
  const id = randomUUID();
  const challenge = b64u(randomBytes(32));
  const expiresAt = now + CHALLENGE_TTL_MS;
  await db.execute(
    `INSERT INTO step_up_challenges (id, user_id, session_id, purpose, challenge, workspace_id, action, target_id, target_hash, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.userId,
      input.sessionId,
      input.purpose,
      challenge,
      input.workspaceId ?? null,
      input.action ?? null,
      input.targetId ?? null,
      input.targetHash ?? null,
      expiresAt,
    ],
  );
  return { id, challenge, expiresAt };
}

/** Single use: the row is deleted by the same statement that claims it. Undefined when unknown, spent, expired or someone else's. */
export async function consumeChallenge(
  db: Database,
  id: string,
  match: {
    userId: string;
    sessionId: string;
    purpose: 'register' | 'assert';
    action?: string;
    targetId?: string | null;
    targetHash?: string | null;
    workspaceId?: string;
  },
  now: number,
): Promise<Challenge | undefined> {
  return db.transaction(async (tx) => {
    const [row] = await tx.query('SELECT * FROM step_up_challenges WHERE id = ?', [id]);
    if (!row) return undefined;
    const claimed = await tx.execute(
      'DELETE FROM step_up_challenges WHERE id = ? AND expires_at > ?',
      [id, now],
    );
    if (claimed !== 1) return undefined;
    const c: Challenge = {
      id: String(row.id),
      userId: String(row.user_id),
      sessionId: String(row.session_id),
      purpose: String(row.purpose) as 'register' | 'assert',
      challenge: String(row.challenge),
      action: (row.action as string | null) ?? null,
      targetId: (row.target_id as string | null) ?? null,
      targetHash: (row.target_hash as string | null) ?? null,
      workspaceId: (row.workspace_id as string | null) ?? null,
    };
    if (c.userId !== match.userId || c.sessionId !== match.sessionId || c.purpose !== match.purpose)
      return undefined;
    if (match.action !== undefined && c.action !== match.action) return undefined;
    if (match.targetId !== undefined && c.targetId !== (match.targetId ?? null)) return undefined;
    if (match.targetHash !== undefined && c.targetHash !== (match.targetHash ?? null))
      return undefined;
    if (match.workspaceId !== undefined && c.workspaceId !== match.workspaceId) return undefined;
    return c;
  });
}

// ---------------------------------------------------------------------------------------------
// Passkey ceremonies

export type CreationOptions = ReturnType<typeof creationOptions>;
export function creationOptions(input: {
  rp: RpInfo;
  userId: string;
  email: string;
  displayName: string;
  challenge: string;
  exclude: string[];
}) {
  return {
    rp: { id: input.rp.rpId, name: 'Kiln' },
    user: {
      id: b64u(createHash('sha256').update(`mrm-step-up:${input.userId}`).digest()),
      name: input.email,
      displayName: input.displayName,
    },
    challenge: input.challenge,
    pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: 'public-key' as const, alg })),
    timeout: CHALLENGE_TTL_MS,
    attestation: 'none' as const,
    authenticatorSelection: {
      residentKey: 'preferred' as const,
      userVerification: 'required' as const,
    },
    excludeCredentials: input.exclude.map((id) => ({ type: 'public-key' as const, id })),
  };
}

export async function addPasskey(
  db: Database,
  input: {
    userId: string;
    name: string;
    challenge: string;
    rp: RpInfo;
    clientDataJSON: string;
    attestationObject: string;
    claimedId: string;
    transports: string[];
  },
  now: number,
): Promise<{ ok: true; passkey: PasskeyRow } | { ok: false; code: string }> {
  let reg: ReturnType<typeof verifyRegistration>;
  try {
    reg = verifyRegistration(input, {
      challenge: input.challenge,
      origins: input.rp.origins,
      rpId: input.rp.rpId,
    });
  } catch (error) {
    if (error instanceof WebAuthnError) return { ok: false, code: error.code };
    throw error;
  }
  if (reg.credentialId !== input.claimedId) return { ok: false, code: 'credential_id_mismatch' };
  const [dup] = await db.query('SELECT id FROM step_up_credentials WHERE credential_id = ?', [
    reg.credentialId,
  ]);
  if (dup) return { ok: false, code: 'already_registered' };
  const [count] = await db.query(
    'SELECT COUNT(*) AS n FROM step_up_credentials WHERE user_id = ?',
    [input.userId],
  );
  if (Number(count?.n ?? 0) >= MAX_PASSKEYS) return { ok: false, code: 'too_many_passkeys' };
  const id = randomUUID();
  const transports = input.transports.filter((t) => /^[a-z-]{2,16}$/.test(t)).slice(0, 6);
  await db.execute(
    `INSERT INTO step_up_credentials (id, user_id, credential_id, public_key, alg, sign_count, name, transports, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      input.userId,
      reg.credentialId,
      reg.publicKey,
      reg.alg,
      reg.signCount,
      input.name,
      transports.join(','),
      now,
    ],
  );
  return {
    ok: true,
    passkey: { id, name: input.name, createdAt: now, lastUsedAt: null, transports },
  };
}

export async function removePasskey(db: Database, userId: string, id: string): Promise<boolean> {
  return (
    (await db.execute('DELETE FROM step_up_credentials WHERE id = ? AND user_id = ?', [
      id,
      userId,
    ])) === 1
  );
}

export async function assertionOptions(
  db: Database,
  userId: string,
  rp: RpInfo,
  challenge: string,
) {
  const rows = await db.query(
    'SELECT credential_id, transports FROM step_up_credentials WHERE user_id = ? ORDER BY created_at',
    [userId],
  );
  return {
    challenge,
    rpId: rp.rpId,
    timeout: CHALLENGE_TTL_MS,
    userVerification: 'required' as const,
    allowCredentials: rows.map((r) => ({
      type: 'public-key' as const,
      id: String(r.credential_id),
      ...(r.transports ? { transports: String(r.transports).split(',').filter(Boolean) } : {}),
    })),
  };
}

export type AssertionInput = {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
};

async function checkAssertion(
  db: Database,
  userId: string,
  input: AssertionInput,
  challenge: string,
  rp: RpInfo,
  now: number,
): Promise<string | undefined> {
  const [cred] = await db.query(
    'SELECT id, public_key, alg, sign_count FROM step_up_credentials WHERE credential_id = ? AND user_id = ?',
    [input.id, userId],
  );
  if (!cred) return 'unknown_credential';
  let result: { signCount: number };
  try {
    result = verifyAssertion(
      input,
      {
        publicKey: String(cred.public_key),
        alg: Number(cred.alg),
        signCount: Number(cred.sign_count),
      },
      { challenge, origins: rp.origins, rpId: rp.rpId },
    );
  } catch (error) {
    if (error instanceof WebAuthnError) return error.code;
    throw error;
  }
  // The counter moves only if nobody else moved it first (two parallel uses of one assertion).
  const moved = await db.execute(
    'UPDATE step_up_credentials SET sign_count = ?, last_used_at = ? WHERE id = ? AND sign_count = ?',
    [result.signCount, now, String(cred.id), Number(cred.sign_count)],
  );
  return moved === 1 ? undefined : 'counter_rollback';
}

// ---------------------------------------------------------------------------------------------
// Verification: a factor in, a grant out

export type Target = { id?: string | undefined; hash?: string | undefined };
export type VerifyInput = {
  workspaceId: string;
  userId: string;
  sessionId: string;
  action: GrantAction;
  target: Target;
  rp: RpInfo;
  cost?: ScryptCost | undefined;
} & (
  | { factor: 'password'; password: string }
  | { factor: 'passkey'; challengeId: string; assertion: AssertionInput }
  | { factor: 'recovery'; code: string }
  | { factor: 'totp'; code: string; masterKey: Buffer }
  | { factor: 'email'; code: string; masterKey: Buffer }
);

export type VerifyResult =
  | { ok: true; grant: string; expiresAt: number }
  | {
      ok: false;
      status: 403 | 409 | 429;
      error: 'step_up_failed' | 'step_up_locked' | 'step_up_busy' | 'factor_not_enrolled';
      reason?: string;
      retryAfterSeconds?: number;
    };

const inFlight = new Set<string>();

export async function verifyFactor(
  db: Database,
  input: VerifyInput,
  now: number,
): Promise<VerifyResult> {
  const { userId } = input;
  // One check at a time per person: parallel guesses cannot all pass the lockout check before the first failure is counted.
  if (inFlight.has(userId))
    return { ok: false, status: 429, error: 'step_up_busy', retryAfterSeconds: 1 };
  inFlight.add(userId);
  try {
    const lock = await lockState(db, userId);
    if (lock.lockedUntil !== null && lock.lockedUntil > now) {
      return {
        ok: false,
        status: 429,
        error: 'step_up_locked',
        retryAfterSeconds: Math.ceil((lock.lockedUntil - now) / 1000),
      };
    }
    let reason: string | undefined;
    if (input.factor === 'password') {
      const kind = await passwordKind(db, userId);
      if (!kind)
        return { ok: false, status: 409, error: 'factor_not_enrolled', reason: 'password' };
      const column =
        kind === 'confirmation'
          ? 'SELECT confirmation_hash AS h FROM step_up_users WHERE user_id = ?'
          : 'SELECT password_hash AS h FROM users WHERE id = ?';
      const [row] = await db.query(column, [userId]);
      const good = row?.h ? await verifyPassword(input.password, String(row.h)) : false;
      if (!good) reason = 'invalid_password';
    } else if (input.factor === 'recovery') {
      if ((await recoveryStatus(db, userId)).remaining === 0)
        return { ok: false, status: 409, error: 'factor_not_enrolled', reason: 'recovery' };
      // A wrong code counts like a wrong password (same failure count and lockout). A right one is spent here, before the grant exists.
      if (!(await spendRecoveryCode(db, userId, input.code, now))) reason = 'invalid_recovery_code';
    } else if (input.factor === 'totp') {
      if (!(await hasActiveTotp(db, userId)))
        return { ok: false, status: 409, error: 'factor_not_enrolled', reason: 'totp' };
      // A wrong or replayed code counts like a wrong password (same failure count and lockout).
      const checked = await checkTotpCode(
        db,
        { masterKey: input.masterKey, userId, code: input.code, want: 'active' },
        now,
      );
      if (!checked.ok) reason = checked.reason === 'replay' ? 'code_already_used' : 'invalid_code';
    } else if (input.factor === 'email') {
      if ((await activeEmail(db, userId)) === undefined)
        return { ok: false, status: 409, error: 'factor_not_enrolled', reason: 'email' };
      // The code was mailed for THIS session, workspace, action and target; five wrong guesses kill it.
      const checked = await checkMailCode(
        db,
        input.masterKey,
        {
          userId,
          purpose: 'step_up',
          binding: input.sessionId,
          workspaceId: input.workspaceId,
          action: input.action,
          targetId: input.target.id ?? null,
          targetHash: input.target.hash ?? null,
        },
        input.code,
        now,
      );
      if (!checked.ok)
        reason =
          checked.reason === 'missing'
            ? 'code_not_sent'
            : checked.reason === 'too_many_attempts'
              ? 'code_locked'
              : 'invalid_code';
    } else {
      const challenge = await consumeChallenge(
        db,
        input.challengeId,
        {
          userId,
          sessionId: input.sessionId,
          purpose: 'assert',
          action: input.action,
          targetId: input.target.id ?? null,
          targetHash: input.target.hash ?? null,
          workspaceId: input.workspaceId,
        },
        now,
      );
      if (!challenge) reason = 'challenge_invalid';
      else
        reason = await checkAssertion(
          db,
          userId,
          input.assertion,
          challenge.challenge,
          input.rp,
          now,
        );
    }
    if (reason) {
      const failures = await recordFailure(db, userId, now);
      await recordAudit(db, {
        workspaceId: input.workspaceId,
        actor: { type: 'user', id: userId },
        action: 'step_up.failed',
        detail: { factor: input.factor, action: input.action, reason, failedCount: failures },
        at: now,
      });
      return {
        ok: false,
        status: 403,
        error: 'step_up_failed',
        reason: input.factor === 'passkey' ? 'invalid_passkey' : reason,
      };
    }
    await resetFailures(db, userId, now);
    const grant = await createGrant(db, input, now);
    await recordAudit(db, {
      workspaceId: input.workspaceId,
      actor: { type: 'user', id: userId },
      action: 'step_up.verified',
      detail: {
        factor: input.factor,
        action: input.action,
        ...(input.target.id ? { targetId: input.target.id } : {}),
      },
      at: now,
    });
    if (input.factor === 'recovery') {
      // Ids and a count only: never the code. A used code is worth an alert (a stolen laptop would use one), so it has its own event.
      await recordAudit(db, {
        workspaceId: input.workspaceId,
        actor: { type: 'user', id: userId },
        action: 'step_up.recovery_used',
        detail: { action: input.action, remaining: (await recoveryStatus(db, userId)).remaining },
        at: now,
      });
    }
    return { ok: true, grant: grant.grant, expiresAt: grant.expiresAt };
  } finally {
    inFlight.delete(userId);
  }
}

async function createGrant(
  db: Database,
  input: VerifyInput,
  now: number,
): Promise<{ grant: string; expiresAt: number }> {
  const grant = `sug_${b64u(randomBytes(32))}`;
  const expiresAt = now + GRANT_TTL_MS;
  await db.execute('DELETE FROM step_up_grants WHERE expires_at <= ?', [now - 24 * 3600_000]);
  await db.execute(
    `INSERT INTO step_up_grants (id, workspace_id, user_id, session_id, action, target_id, target_hash, factor, created_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      sha256hex(grant),
      input.workspaceId,
      input.userId,
      input.sessionId,
      input.action,
      input.target.id ?? null,
      input.target.hash ?? null,
      input.factor,
      now,
      expiresAt,
    ],
  );
  return { grant, expiresAt };
}

export type GrantCheck =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'expired' | 'used' | 'mismatch' };

/** Spends a grant if, and only if, it is unused, unexpired and bound to exactly this request. One statement: two requests cannot both win. */
export async function consumeGrant(
  db: Database,
  grant: string,
  want: {
    workspaceId: string;
    userId: string;
    sessionId: string;
    action: GrantAction;
    target: Target;
  },
  now: number,
): Promise<GrantCheck> {
  const id = sha256hex(grant);
  const spent = await db.execute(
    `UPDATE step_up_grants SET used_at = ?
      WHERE id = ? AND used_at IS NULL AND expires_at > ? AND workspace_id = ? AND user_id = ? AND session_id = ? AND action = ?
        AND (target_id IS NULL OR target_id = ?) AND (target_hash IS NULL OR target_hash = ?)`,
    [
      now,
      id,
      now,
      want.workspaceId,
      want.userId,
      want.sessionId,
      want.action,
      want.target.id ?? '',
      want.target.hash ?? '',
    ],
  );
  if (spent === 1) return { ok: true };
  const [row] = await db.query('SELECT used_at, expires_at FROM step_up_grants WHERE id = ?', [id]);
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.used_at !== null) return { ok: false, reason: 'used' };
  if (Number(row.expires_at) <= now) return { ok: false, reason: 'expired' };
  return { ok: false, reason: 'mismatch' };
}

// ---------------------------------------------------------------------------------------------
// The guard

export type GuardCtx = { db: Database; now: () => number };
export type GuardTarget = {
  /** The app (or credential, or setting) the action is about. */
  id?: string;
  /** The field of the JSON body that holds the confirm or plan hash the person saw. */
  hashField?: string;
};

export const GRANT_HEADER = 'x-step-up-grant';

async function bodyOf(c: Context): Promise<Record<string, unknown> | undefined> {
  const raw: unknown = await c.req.json().catch(() => undefined);
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

async function factorsOf(sql: Sql, userId: string) {
  const passkeys = (await listPasskeys(sql, userId)).length;
  const password = await passwordKind(sql, userId);
  const list = [
    ...(passkeys > 0 ? ['passkey'] : []),
    ...(password ? ['password'] : []),
    ...((await hasActiveTotp(sql, userId)) ? ['totp'] : []),
    ...((await activeEmail(sql, userId)) !== undefined ? ['email'] : []),
  ];
  // A recovery code is offered beside a real factor, never instead of one (a person with no factor has nothing to recover).
  if (list.length > 0 && (await recoveryStatus(sql, userId)).remaining > 0) list.push('recovery');
  return { passkeys, password, list };
}

async function enforce(
  ctx: GuardCtx,
  c: Context<AppEnv>,
  action: GrantAction,
  target: GuardTarget,
  covered: { unattended: boolean },
): Promise<Response | undefined> {
  const workspaceId = c.req.param('workspaceId') ?? '';
  const user = c.get('user');
  const now = ctx.now();
  const info = { action, ...(target.id ? { target: target.id } : {}) };
  if (c.get('token')) {
    // API tokens are not people: they cannot satisfy a step-up unless an admin allowed this class for unattended use.
    if (covered.unattended) return undefined;
    await recordAudit(ctx.db, {
      workspaceId,
      actor: { type: 'user', id: user.id },
      action: 'step_up.refused',
      detail: { action, reason: 'token' },
      at: now,
    });
    return c.json(
      {
        error: 'step_up_required_human',
        message: 'This action needs a person to confirm it in the app. An API token cannot.',
        ...info,
      },
      403,
    );
  }
  const factors = await factorsOf(ctx.db, user.id);
  if (factors.list.length === 0) {
    return c.json(
      {
        error: 'step_up_not_enrolled',
        message:
          'This action needs a confirmation, and you have no way to confirm yet. Add a passkey or set a confirmation password in Settings, Security.',
        ...info,
      },
      403,
    );
  }
  const body = await bodyOf(c);
  const presented =
    c.req.header(GRANT_HEADER) ?? (typeof body?.stepUp === 'string' ? body.stepUp : undefined);
  const hash =
    target.hashField && typeof body?.[target.hashField] === 'string'
      ? (body[target.hashField] as string)
      : undefined;
  const required = (reason: string) =>
    c.json(
      {
        error: 'step_up_required',
        message:
          'Confirm this action with a passkey, your password, an authenticator code or an emailed code.',
        reason,
        factors: factors.list,
        ...info,
      },
      403,
    );
  const sessionId = sessionIdOf(c);
  if (!presented) return required('missing');
  if (!sessionId) return required('mismatch');
  const done = await consumeGrant(
    ctx.db,
    presented,
    {
      workspaceId,
      userId: user.id,
      sessionId,
      action,
      target: { ...(target.id ? { id: target.id } : {}), ...(hash ? { hash } : {}) },
    },
    now,
  );
  return done.ok ? undefined : required(done.reason);
}

/**
 * Call at the top of a hard action's apply route, before it does anything. Returns a Response to
 * send (403 `step_up_required`, `step_up_not_enrolled` or `step_up_required_human`), or undefined to go on.
 * With the policy off, or for a class the policy does not cover, it returns undefined without reading the body.
 */
export async function requireStepUp(
  ctx: GuardCtx,
  c: Context<AppEnv>,
  action: StepUpAction,
  target: GuardTarget = {},
): Promise<Response | undefined> {
  if (autoApproved.has(ctx.db)) return undefined;
  const policy = await getPolicy(ctx.db, c.req.param('workspaceId') ?? '');
  if (policy.mode !== 'hard_actions' || !policy.actions.includes(action)) return undefined;
  return enforce(ctx, c, action, target, { unattended: policy.unattended.includes(action) });
}

/**
 * Whether a person's own confirmation (a passkey or the confirmation password, bound to the plan they saw) stands in for a typed
 * phrase on `action`: the policy covers the action, the caller is a person (an API token cannot confirm) and has a way to confirm.
 * Only then may a screen leave out the typed phrase; `requireStepUp` still runs first on the apply route and refuses without a grant.
 */
export async function stepUpCovers(
  ctx: GuardCtx,
  c: Context<AppEnv>,
  action: StepUpAction,
): Promise<boolean> {
  if (autoApproved.has(ctx.db)) return false;
  if (c.get('token')) return false;
  const policy = await getPolicy(ctx.db, c.req.param('workspaceId') ?? '');
  if (policy.mode !== 'hard_actions' || !policy.actions.includes(action)) return false;
  return isEnrolled(ctx.db, c.get('user').id);
}

/**
 * Changing factors or the policy needs a fresh confirmation whenever the person already has a way to confirm
 * (so a stolen session cannot swap in its own passkey), whatever the policy says. The first factor of someone
 * with none needs nothing. Not open to tokens (the routes are closed to them).
 */
export async function requireManage(
  ctx: GuardCtx,
  c: Context<AppEnv>,
  opts: { onlyWhenPolicyOn?: boolean } = {},
): Promise<Response | undefined> {
  if (autoApproved.has(ctx.db)) return undefined;
  const user = c.get('user');
  if (opts.onlyWhenPolicyOn) {
    // Weakening a policy that is on: always a confirmation (and `step_up_not_enrolled` if there is no way to give one).
    if ((await getPolicy(ctx.db, c.req.param('workspaceId') ?? '')).mode !== 'hard_actions')
      return undefined;
  } else if (!(await isEnrolled(ctx.db, user.id))) return undefined;
  return enforce(ctx, c, MANAGE_ACTION, {}, { unattended: false });
}
