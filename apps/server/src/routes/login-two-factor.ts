import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, clientIp, parseBody, type Services } from '../http.ts';
import { normalizeEmail } from '../services/accounts.ts';
import type { Mailer } from '../services/mailer.ts';
import { spendRecoveryCode } from '../services/step-up.ts';
import {
  activeEmail,
  auditForUser,
  beginEmailVerification,
  beginTotp,
  checkMailCode,
  checkTotpCode,
  confirmEmailVerification,
  countChallengeAttempt,
  issueMailCode,
  type LoginChallenge,
  loadLoginChallenge,
  spendLoginChallenge,
} from '../services/two-factor.ts';
import { startLoginSession } from './auth.ts';
import { codeFailure, sendFailure } from './two-factor.ts';

/**
 * The second step of signing in (docs/api/two-factor.md, docs/adr/0021-two-factor-and-smtp.md). Mounted under /api/auth, only on a server
 * with accounts. `POST /api/auth/login` answers `twoFactorRequired` with a `challenge` token INSTEAD of starting a session; these routes
 * take that token. The session cookie is set only here, after the second factor. The token lives 5 minutes, allows 5 wrong tries, is
 * spent by the one request that completes the sign-in, and every attempt also counts against the same per-email and per-address
 * limiters as passwords. Wrong answers are one fixed code; nothing says which of the password or the code was the problem.
 */
export type LoginTwoFactorContext = { services: Services; mailer: Mailer };

const token = z.string().min(1).max(100);
const code = z.string().trim().min(1).max(64);
export const loginSecondFactorBody = z.object({
  challenge: token,
  method: z.enum(['totp', 'email', 'recovery']),
  code,
});
export const loginChallengeBody = z.object({ challenge: token });
export const loginChallengeCodeBody = z.object({ challenge: token, code });

const gone = (c: Context) =>
  c.json(
    { error: 'challenge_invalid', message: 'This sign-in expired or was used up. Sign in again.' },
    401,
  );

export function loginTwoFactorRoutes(ctx: LoginTwoFactorContext) {
  const { services, mailer } = ctx;
  const { db, now, masterKey, limiter, ipLimiter } = services;
  const app = new Hono<AppEnv>();

  type Opened = {
    challenge: LoginChallenge;
    user: { id: string; email: string; displayName: string };
  };
  const open = async (
    c: Context,
    raw: string,
    kind: 'verify' | 'enroll',
  ): Promise<Opened | Response> => {
    const challenge = await loadLoginChallenge(db, raw, now());
    if (!challenge) return gone(c);
    if (challenge.kind !== kind)
      return c.json(
        {
          error: 'wrong_challenge',
          message: 'This step does not apply to your sign-in. Sign in again.',
        },
        409,
      );
    const [row] = await db.query('SELECT id, email, display_name FROM users WHERE id = ?', [
      challenge.userId,
    ]);
    if (!row) return gone(c);
    return {
      challenge,
      user: { id: String(row.id), email: String(row.email), displayName: String(row.display_name) },
    };
  };

  /** A guess: counted against the email and the address like a password, and against the challenge's five. */
  const guess = async (c: Context, opened: Opened): Promise<Response | undefined> => {
    const key = normalizeEmail(opened.user.email);
    const ip = clientIp(c, services.trustProxy);
    const wait = Math.max(limiter.attempt(key), ip ? ipLimiter.attempt(ip) : 0);
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return c.json({ error: 'too_many_attempts' }, 429);
    }
    if (!(await countChallengeAttempt(db, opened.challenge.id))) return gone(c);
    return undefined;
  };

  const failed = async (c: Context, opened: Opened, method: string, reason: string) => {
    await auditForUser(db, opened.user.id, 'auth.second_factor_failed', { method, reason }, now());
    return c.json(
      {
        error: 'invalid_second_factor',
        message: 'That code did not work. Try again, or sign in again.',
      },
      401,
    );
  };

  const complete = async (c: Context, opened: Opened, method: string, enrolled?: string) => {
    if (!(await spendLoginChallenge(db, opened.challenge.id))) return gone(c);
    limiter.reset(normalizeEmail(opened.user.email));
    const ip = clientIp(c, services.trustProxy);
    if (ip) ipLimiter.refund(ip);
    await startLoginSession(services, c, opened.user.id);
    await auditForUser(
      db,
      opened.user.id,
      enrolled ? 'two_factor.enrolled_at_login' : 'auth.second_factor_verified',
      { method, ...(enrolled ? { factor: enrolled } : {}) },
      now(),
    );
    c.header('Cache-Control', 'no-store');
    return c.json({ user: opened.user });
  };

  app.post('/login/two-factor', async (c) => {
    const body = await parseBody(c, loginSecondFactorBody);
    if (!body.ok) return body.response;
    const opened = await open(c, body.data.challenge, 'verify');
    if (opened instanceof Response) return opened;
    const stop = await guess(c, opened);
    if (stop) return stop;
    const { method } = body.data;
    const at = now();
    let good = false;
    let reason = 'invalid_code';
    if (method === 'totp') {
      const checked = await checkTotpCode(
        db,
        { masterKey, userId: opened.user.id, code: body.data.code, want: 'active' },
        at,
      );
      good = checked.ok;
      if (!checked.ok && checked.reason === 'replay') reason = 'code_already_used';
    } else if (method === 'email') {
      const checked = await checkMailCode(
        db,
        masterKey,
        { userId: opened.user.id, purpose: 'login', binding: opened.challenge.id },
        body.data.code,
        at,
      );
      good = checked.ok;
      if (!checked.ok) reason = checked.reason === 'missing' ? 'code_not_sent' : checked.reason;
    } else {
      good = await spendRecoveryCode(db, opened.user.id, body.data.code, at);
      if (!good) reason = 'invalid_recovery_code';
    }
    if (!good) return failed(c, opened, method, reason);
    return complete(c, opened, method);
  });

  app.post('/login/two-factor/email-code', async (c) => {
    const body = await parseBody(c, loginChallengeBody);
    if (!body.ok) return body.response;
    const opened = await open(c, body.data.challenge, 'verify');
    if (opened instanceof Response) return opened;
    const address = await activeEmail(db, opened.user.id);
    if (!address)
      return c.json(
        {
          error: 'factor_not_enrolled',
          reason: 'email',
          message: 'No verified email address is set up for codes.',
        },
        409,
      );
    const sent = await issueMailCode(
      db,
      { masterKey, mailer },
      { userId: opened.user.id, purpose: 'login', email: address, binding: opened.challenge.id },
      now(),
    );
    if (!sent.ok) return sendFailure(c, sent);
    c.header('Cache-Control', 'no-store');
    return c.json(
      { expiresAt: sent.expiresAt, resendAfterSeconds: sent.resendAfterSeconds, to: sent.to },
      202,
    );
  });

  // ----- setting up a factor at sign-in (the policy requires one and the person has none) ----------
  app.post('/login/enroll/totp', async (c) => {
    const body = await parseBody(c, loginChallengeBody);
    if (!body.ok) return body.response;
    const opened = await open(c, body.data.challenge, 'enroll');
    if (opened instanceof Response) return opened;
    const started = await beginTotp(
      db,
      { masterKey, userId: opened.user.id, account: opened.user.email },
      now(),
    );
    if (!started) return c.json({ error: 'already_enrolled' }, 409);
    c.header('Cache-Control', 'no-store');
    return c.json(
      {
        secret: started.secret,
        uri: started.uri,
        issuer: 'Mobile Release Manager',
        account: opened.user.email,
      },
      201,
    );
  });

  app.post('/login/enroll/totp/confirm', async (c) => {
    const body = await parseBody(c, loginChallengeCodeBody);
    if (!body.ok) return body.response;
    const opened = await open(c, body.data.challenge, 'enroll');
    if (opened instanceof Response) return opened;
    const stop = await guess(c, opened);
    if (stop) return stop;
    const checked = await checkTotpCode(
      db,
      { masterKey, userId: opened.user.id, code: body.data.code, want: 'pending' },
      now(),
    );
    if (!checked.ok)
      return failed(
        c,
        opened,
        'totp',
        checked.reason === 'not_enrolled' ? 'not_started' : 'invalid_code',
      );
    return complete(c, opened, 'totp', 'totp');
  });

  app.post('/login/enroll/email', async (c) => {
    const body = await parseBody(c, loginChallengeBody);
    if (!body.ok) return body.response;
    const opened = await open(c, body.data.challenge, 'enroll');
    if (opened instanceof Response) return opened;
    const sent = await beginEmailVerification(
      db,
      { masterKey, mailer },
      { userId: opened.user.id },
      now(),
    );
    if (!sent.ok) return sendFailure(c, sent);
    c.header('Cache-Control', 'no-store');
    return c.json(
      { expiresAt: sent.expiresAt, resendAfterSeconds: sent.resendAfterSeconds, to: sent.to },
      202,
    );
  });

  app.post('/login/enroll/email/confirm', async (c) => {
    const body = await parseBody(c, loginChallengeCodeBody);
    if (!body.ok) return body.response;
    const opened = await open(c, body.data.challenge, 'enroll');
    if (opened instanceof Response) return opened;
    const stop = await guess(c, opened);
    if (stop) return stop;
    const done = await confirmEmailVerification(
      db,
      masterKey,
      opened.user.id,
      body.data.code,
      now(),
    );
    if (!done.ok) {
      if (done.reason === 'too_many_attempts') return codeFailure(c, done);
      return failed(
        c,
        opened,
        'email',
        done.reason === 'missing' ? 'code_not_sent' : 'invalid_code',
      );
    }
    return complete(c, opened, 'email', 'email');
  });

  return app;
}
