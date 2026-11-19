import { type Action, can } from '@mrm/core';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { z } from 'zod';
import { type AppEnv, type Services, parseBody } from '../http.ts';
import { memberRole } from '../services/accounts.ts';
import { recordAudit } from '../services/audit.ts';
import { type Mailer, MAIL_ERROR_MESSAGES } from '../services/mailer.ts';
import { recoveryStatus, requireManage, sessionIdOf, stepUpActions } from '../services/step-up.ts';
import { isEnrolled } from '../services/step-up.ts';
import {
  type BeginEmailResult,
  type MailCodeResult,
  beginEmailVerification,
  beginTotp,
  checkTotpCode,
  confirmEmailVerification,
  getLoginMode,
  isLoginMode,
  issueMailCode,
  loginModes,
  membersWithoutSecondFactor,
  activeEmail,
  removeMail,
  removeTotp,
  resetTwoFactor,
  setLoginMode,
  twoFactorStatus,
} from '../services/two-factor.ts';

/**
 * Two-factor routes (docs/api/two-factor.md, docs/adr/0021-two-factor-and-smtp.md). Mounted under /api/workspaces. Every route is a
 * person's: closed to API tokens in the registry. Changing a factor needs a fresh step-up confirmation (class `step_up.manage`) whenever
 * the person already has a way to confirm, exactly as for passkeys, so a stolen session cannot enrol an authenticator of its own.
 */
export type TwoFactorRoutesContext = { services: Services; mailer: Mailer };

const ws = (c: Context<AppEnv>) => c.req.param('workspaceId') ?? '';
const codeText = z.string().trim().min(1).max(16);

export const totpConfirmBody = z.object({ code: codeText });
export const emailBeginBody = z.object({ email: z.string().trim().max(254).optional() }).strict().optional();
export const emailConfirmBody = z.object({ code: codeText });
export const stepUpEmailCodeBody = z.object({
  action: z.enum([...stepUpActions, 'step_up.manage']),
  target: z.object({ id: z.string().min(1).max(200).optional(), hash: z.string().min(1).max(200).optional() }).strict().optional(),
});
export const loginPolicyBody = z.object({ mode: z.enum(loginModes) });

/** The answer for a mail code that could not be sent. Fixed codes and sentences; nothing a mail server said. */
export function sendFailure(c: Context, result: Exclude<BeginEmailResult, { ok: true }>): Response {
  switch (result.error) {
    case 'mail_not_configured':
      return c.json({ error: 'mail_not_configured', message: MAIL_ERROR_MESSAGES.smtp_not_configured }, 409);
    case 'rate_limited':
      c.header('Retry-After', String(result.retryAfterSeconds));
      return c.json({ error: 'rate_limited', retryAfterSeconds: result.retryAfterSeconds, message: 'A code was sent a moment ago, or too many were sent. Try again later.' }, 429);
    case 'busy':
      c.header('Retry-After', '1');
      return c.json({ error: 'busy', message: 'Another code is being sent. Try again in a moment.' }, 429);
    case 'mail_failed':
      return c.json({ error: 'mail_failed', code: result.code, ...(result.hint ? { hint: result.hint } : {}), message: MAIL_ERROR_MESSAGES[result.code] }, 502);
    case 'email_required':
      return c.json({ error: 'email_required', message: 'Enter the email address to send the code to.' }, 400);
    case 'invalid_email':
      return c.json({ error: 'invalid_email', message: 'That does not look like an email address.' }, 400);
    case 'already_verified':
      return c.json({ error: 'already_verified', message: 'This address is already verified.' }, 409);
  }
}

/** The answer for a typed code that was refused. */
export function codeFailure(c: Context, result: Extract<MailCodeResult, { ok: false }>): Response {
  if (result.reason === 'too_many_attempts') return c.json({ error: 'too_many_attempts', message: 'Too many wrong codes. Ask for a new one.' }, 429);
  if (result.reason === 'missing') return c.json({ error: 'code_expired', message: 'That code expired or was never sent. Ask for a new one.' }, 400);
  return c.json({ error: 'invalid_code', message: 'That code is not right.' }, 400);
}

export function twoFactorRoutes(ctx: TwoFactorRoutesContext) {
  const { services, mailer } = ctx;
  const { db, now, masterKey } = services;
  const routes = new Hono<AppEnv>();
  const guard = { db, now };

  const needs = (action: Action | 'member') => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (action !== 'member' && !can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const accountLabel = (c: Context<AppEnv>) => (services.singleUser ? 'This computer' : c.get('user').email);

  routes.get('/:workspaceId/two-factor/status', needs('member'), async (c) => {
    const user = c.get('user');
    const status = await twoFactorStatus(db, user.id);
    const admin = can(c.get('role'), 'settings.write');
    c.header('Cache-Control', 'no-store');
    return c.json({
      totp: status.totp,
      email: status.email,
      mailConfigured: await mailer.configured(),
      /** Single-user mode has no account email: the person says which address the codes go to. */
      emailAddressEditable: services.singleUser !== undefined,
      recovery: await recoveryStatus(db, user.id),
      login: {
        /** Signing in with a second factor exists only on a server with accounts. */
        supported: services.singleUser === undefined,
        mode: await getLoginMode(db, ws(c)),
        ...(admin && !services.singleUser ? { membersWithoutSecondFactor: await membersWithoutSecondFactor(db, ws(c)) } : {}),
      },
    });
  });

  // ----- authenticator app ----------------------------------------------------------------------
  routes.post('/:workspaceId/two-factor/totp/begin', needs('member'), async (c) => {
    const refusal = await requireManage(guard, c);
    if (refusal) return refusal;
    const user = c.get('user');
    const started = await beginTotp(db, { masterKey, userId: user.id, account: accountLabel(c) }, now());
    if (!started) return c.json({ error: 'already_enrolled', message: 'An authenticator app is already set up. Remove it first to set up another.' }, 409);
    c.header('Cache-Control', 'no-store');
    // The secret is in THIS answer only (it is shown as a QR code and as text, to be typed in once).
    return c.json({ secret: started.secret, uri: started.uri, issuer: 'Mobile Release Manager', account: accountLabel(c) }, 201);
  });

  routes.post('/:workspaceId/two-factor/totp/confirm', needs('member'), async (c) => {
    const body = await parseBody(c, totpConfirmBody);
    if (!body.ok) return body.response;
    const user = c.get('user');
    const checked = await checkTotpCode(db, { masterKey, userId: user.id, code: body.data.code, want: 'pending' }, now());
    if (!checked.ok) {
      if (checked.reason === 'not_enrolled') return c.json({ error: 'not_started', message: 'Start setting up the authenticator app first.' }, 409);
      return c.json({ error: 'invalid_code', message: 'That code is not right. Check the clock on your phone and try the next code.' }, 400);
    }
    await recordAudit(db, { workspaceId: ws(c), actor: { type: 'user', id: user.id }, action: 'two_factor.totp_enrolled', at: now() });
    return c.json({ totp: (await twoFactorStatus(db, user.id)).totp });
  });

  routes.delete('/:workspaceId/two-factor/totp', needs('member'), async (c) => {
    const refusal = await requireManage(guard, c);
    if (refusal) return refusal;
    const user = c.get('user');
    if (!(await removeTotp(db, user.id))) return c.json({ error: 'not_found' }, 404);
    await recordAudit(db, { workspaceId: ws(c), actor: { type: 'user', id: user.id }, action: 'two_factor.totp_removed', at: now() });
    return c.body(null, 204);
  });

  // ----- email ----------------------------------------------------------------------------------
  routes.post('/:workspaceId/two-factor/email/begin', needs('member'), async (c) => {
    const body = await parseBody(c, emailBeginBody);
    if (!body.ok) return body.response;
    const user = c.get('user');
    if (await isEnrolled(db, user.id)) {
      const refusal = await requireManage(guard, c);
      if (refusal) return refusal;
    }
    const sent = await beginEmailVerification(db, { masterKey, mailer }, { userId: user.id, workspaceId: ws(c), ...(body.data?.email ? { requested: body.data.email } : {}) }, now());
    if (!sent.ok) return sendFailure(c, sent);
    await recordAudit(db, { workspaceId: ws(c), actor: { type: 'user', id: user.id }, action: 'two_factor.email_code_sent', detail: { purpose: 'verify_email' }, at: now() });
    return c.json({ expiresAt: sent.expiresAt, resendAfterSeconds: sent.resendAfterSeconds, to: sent.to }, 202);
  });

  routes.post('/:workspaceId/two-factor/email/confirm', needs('member'), async (c) => {
    const body = await parseBody(c, emailConfirmBody);
    if (!body.ok) return body.response;
    const user = c.get('user');
    const done = await confirmEmailVerification(db, masterKey, user.id, body.data.code, now());
    if (!done.ok) return codeFailure(c, done);
    await recordAudit(db, { workspaceId: ws(c), actor: { type: 'user', id: user.id }, action: 'two_factor.email_verified', at: now() });
    return c.json({ email: (await twoFactorStatus(db, user.id)).email });
  });

  routes.delete('/:workspaceId/two-factor/email', needs('member'), async (c) => {
    const refusal = await requireManage(guard, c);
    if (refusal) return refusal;
    const user = c.get('user');
    if (!(await removeMail(db, user.id, now()))) return c.json({ error: 'not_found' }, 404);
    await recordAudit(db, { workspaceId: ws(c), actor: { type: 'user', id: user.id }, action: 'two_factor.email_removed', at: now() });
    return c.body(null, 204);
  });

  // ----- an emailed code for one hard action ----------------------------------------------------
  routes.post('/:workspaceId/step-up/email-code', needs('member'), async (c) => {
    const body = await parseBody(c, stepUpEmailCodeBody);
    if (!body.ok) return body.response;
    const user = c.get('user');
    const sessionId = sessionIdOf(c);
    if (!sessionId) return c.json({ error: 'unauthenticated' }, 401);
    const address = await activeEmail(db, user.id);
    if (!address) return c.json({ error: 'factor_not_enrolled', reason: 'email', message: 'No verified email address is set up for codes.' }, 409);
    const { action, target } = body.data;
    const sent = await issueMailCode(
      db,
      { masterKey, mailer },
      { userId: user.id, purpose: 'step_up', email: address, workspaceId: ws(c), binding: sessionId, action, ...(target?.id ? { targetId: target.id } : {}), ...(target?.hash ? { targetHash: target.hash } : {}) },
      now(),
    );
    if (!sent.ok) return sendFailure(c, sent);
    await recordAudit(db, { workspaceId: ws(c), actor: { type: 'user', id: user.id }, action: 'two_factor.email_code_sent', detail: { purpose: 'step_up', action }, at: now() });
    c.header('Cache-Control', 'no-store');
    return c.json({ expiresAt: sent.expiresAt, resendAfterSeconds: sent.resendAfterSeconds, to: sent.to }, 202);
  });

  // ----- the sign-in policy ---------------------------------------------------------------------
  routes.put('/:workspaceId/two-factor/policy', needs('settings.write'), async (c) => {
    if (services.singleUser) return c.json({ error: 'single_user_mode', message: 'Signing in with a second factor needs a server with accounts. Here, the authenticator app and email codes confirm hard actions.' }, 409);
    const body = await parseBody(c, loginPolicyBody);
    if (!body.ok) return body.response;
    const user = c.get('user');
    // Raising the bar without having a factor yourself would lock you out at the next sign-in.
    if (body.data.mode === 'admins' || body.data.mode === 'all') {
      const mine = await twoFactorStatus(db, user.id);
      if (mine.totp.state !== 'active' && !mine.email?.verified) {
        return c.json({ error: 'two_factor_not_enrolled', message: 'Set up an authenticator app or verify your email first, so you can still sign in.' }, 409);
      }
    }
    const refusal = await requireManage(guard, c);
    if (refusal) return refusal;
    const changed = await setLoginMode(db, { workspaceId: ws(c), userId: user.id, mode: body.data.mode }, now());
    return c.json({ mode: changed.to, membersWithoutSecondFactor: await membersWithoutSecondFactor(db, ws(c)) });
  });

  // An owner or admin removes another member's second factors (a lost phone), after a confirmation of their own. The member then signs in
  // with the password alone, or, where the policy requires one, sets a new one at the next sign-in.
  routes.delete('/:workspaceId/two-factor/members/:userId', needs('members.manage'), async (c) => {
    const actor = c.get('user');
    const target = c.req.param('userId') ?? '';
    if (target === actor.id) return c.json({ error: 'forbidden', message: 'Use the Security settings to change your own second factor.' }, 403);
    const targetRole = await memberRole(db, ws(c), target);
    if (!targetRole) return c.json({ error: 'not_found' }, 404);
    const mine = c.get('role');
    if (targetRole === 'owner' && mine !== 'owner') return c.json({ error: 'forbidden', message: 'Only an owner can reset an owner.' }, 403);
    if (targetRole === 'admin' && mine !== 'owner') return c.json({ error: 'forbidden', message: 'Only an owner can reset an admin.' }, 403);
    const refusal = await requireManage(guard, c);
    if (refusal) return refusal;
    await resetTwoFactor(db, target, now());
    await recordAudit(db, { workspaceId: ws(c), actor: { type: 'user', id: actor.id }, action: 'two_factor.reset', target: { type: 'user', id: target }, at: now() });
    return c.body(null, 204);
  });

  return routes;
}

export { isLoginMode };
