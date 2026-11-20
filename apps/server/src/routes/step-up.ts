import { type Action, can } from '@mrm/core';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody, type Services } from '../http.ts';
import { memberRole } from '../services/accounts.ts';
import { recordAudit } from '../services/audit.ts';
import {
  addPasskey,
  assertionOptions,
  consumeChallenge,
  creationOptions,
  defaultCoveredActions,
  GRANT_TTL_MS,
  generateRecoveryCodes,
  getPolicy,
  isEnrolled,
  isStepUpAction,
  issueChallenge,
  listPasskeys,
  lockState,
  MAX_PASSKEYS,
  passwordKind,
  RECOVERY_CODE_COUNT,
  recoveryStatus,
  relyingParty,
  removePasskey,
  requireManage,
  sessionIdOf,
  setConfirmationPassword,
  setPolicy,
  stepUpActions,
  verifyFactor,
} from '../services/step-up.ts';

/**
 * Step-up confirmation (docs/api/step-up.md, docs/adr/0019-step-up-confirmation.md). Mounted under
 * /api/workspaces. Every route is a person's: closed to API tokens in the registry.
 */
export type StepUpRoutesContext = {
  services: Services;
  /** MRM_PUBLIC_ORIGIN: the origin passkeys are bound to. Default: the origin of the request. */
  publicOrigin?: string | undefined;
  trustedOrigins?: string[] | undefined;
};

const ws = (c: Context<AppEnv>) => c.req.param('workspaceId') ?? '';

const actionSchema = z.enum([...stepUpActions, 'step_up.manage']);
const targetSchema = z
  .object({
    id: z.string().min(1).max(200).optional(),
    hash: z.string().min(1).max(200).optional(),
  })
  .strict();
const b64 = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[A-Za-z0-9_-]+$/);

const verifyBody = z.discriminatedUnion('factor', [
  z.object({
    factor: z.literal('password'),
    action: actionSchema,
    target: targetSchema.optional(),
    password: z.string().min(1).max(200),
  }),
  z.object({
    factor: z.literal('passkey'),
    action: actionSchema,
    target: targetSchema.optional(),
    challengeId: z.string().min(1).max(100),
    assertion: z.object({ id: b64, clientDataJSON: b64, authenticatorData: b64, signature: b64 }),
  }),
  z.object({
    factor: z.literal('recovery'),
    action: actionSchema,
    target: targetSchema.optional(),
    code: z.string().min(1).max(64),
  }),
  z.object({
    factor: z.literal('totp'),
    action: actionSchema,
    target: targetSchema.optional(),
    code: z.string().min(1).max(16),
  }),
  z.object({
    factor: z.literal('email'),
    action: actionSchema,
    target: targetSchema.optional(),
    code: z.string().min(1).max(16),
  }),
]);
export const stepUpVerifyBody = verifyBody;

const assertionOptionsBody = z.object({ action: actionSchema, target: targetSchema.optional() });
const registerOptionsBody = z.object({}).strict().optional();
const recoveryBody = z.object({}).strict().optional();
export const stepUpRecoveryBody = recoveryBody;
const registerVerifyBody = z.object({
  challengeId: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(60),
  credential: z.object({
    id: b64,
    attestationObject: b64,
    clientDataJSON: b64,
    transports: z.array(z.string().max(16)).max(8).optional(),
  }),
});
const passwordBody = z.object({
  password: z.string().min(12, 'Use at least 12 characters').max(200),
});
const policyBody = z.object({
  mode: z.enum(['off', 'hard_actions']),
  actions: z.array(z.enum(stepUpActions)).max(stepUpActions.length).optional(),
  unattended: z.array(z.enum(stepUpActions)).max(stepUpActions.length).optional(),
});
export const stepUpPolicyBody = policyBody;
export const stepUpPasswordBody = passwordBody;
export const stepUpRegisterVerifyBody = registerVerifyBody;
export const stepUpAssertionOptionsBody = assertionOptionsBody;

export function stepUpRoutes(ctx: StepUpRoutesContext) {
  const { services } = ctx;
  const { db, now } = services;
  const routes = new Hono<AppEnv>();
  const rp = (c: Context<AppEnv>) =>
    relyingParty(c, {
      publicOrigin: ctx.publicOrigin,
      trustProxy: services.trustProxy,
      trustedOrigins: ctx.trustedOrigins,
    });

  const needs = (action: Action | 'member') => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (action !== 'member' && !can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const guard = { db, now };

  routes.get('/:workspaceId/step-up/status', needs('member'), async (c) => {
    const user = c.get('user');
    const policy = await getPolicy(db, ws(c));
    const passkeys = await listPasskeys(db, user.id);
    const kind = await passwordKind(db, user.id);
    const lock = await lockState(db, user.id);
    const party = rp(c);
    c.header('Cache-Control', 'no-store');
    return c.json({
      policy: { ...policy, classes: stepUpActions, defaults: defaultCoveredActions },
      factors: {
        passkeys,
        password: kind ? { kind } : null,
        /** Only in single-user mode can a separate confirmation password be set. */
        confirmationPasswordSettable: services.singleUser !== undefined,
      },
      enrolled: passkeys.length > 0 || kind !== undefined,
      /** Only counts: a code is shown once, when it is made, and never again. */
      recovery: await recoveryStatus(db, user.id),
      lockedUntil: lock.lockedUntil !== null && lock.lockedUntil > now() ? lock.lockedUntil : null,
      supported: { webauthn: party.webauthnAvailable, rpId: party.rpId, maxPasskeys: MAX_PASSKEYS },
      grantTtlSeconds: GRANT_TTL_MS / 1000,
    });
  });

  // ----- passkey registration -----------------------------------------------------------------
  routes.post('/:workspaceId/step-up/passkeys/register/options', needs('member'), async (c) => {
    const body = await parseBody(c, registerOptionsBody);
    if (!body.ok) return body.response;
    const party = rp(c);
    if (!party.webauthnAvailable)
      return c.json(
        {
          error: 'webauthn_unavailable',
          message: 'Passkeys need https, or http://localhost. Use a confirmation password here.',
        },
        409,
      );
    const user = c.get('user');
    const sessionId = sessionIdOf(c);
    if (!sessionId) return c.json({ error: 'unauthenticated' }, 401);
    const issued = await issueChallenge(
      db,
      { userId: user.id, sessionId, purpose: 'register', workspaceId: ws(c) },
      now(),
    );
    if (!issued) return c.json({ error: 'too_many_attempts' }, 429);
    const existing = await db.query(
      'SELECT credential_id FROM step_up_credentials WHERE user_id = ?',
      [user.id],
    );
    return c.json({
      challengeId: issued.id,
      expiresAt: issued.expiresAt,
      publicKey: creationOptions({
        rp: party,
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        challenge: issued.challenge,
        exclude: existing.map((r) => String(r.credential_id)),
      }),
    });
  });

  routes.post('/:workspaceId/step-up/passkeys/register/verify', needs('member'), async (c) => {
    const refusal = await requireManage(guard, c);
    if (refusal) return refusal;
    const body = await parseBody(c, registerVerifyBody);
    if (!body.ok) return body.response;
    const user = c.get('user');
    const sessionId = sessionIdOf(c);
    if (!sessionId) return c.json({ error: 'unauthenticated' }, 401);
    const challenge = await consumeChallenge(
      db,
      body.data.challengeId,
      { userId: user.id, sessionId, purpose: 'register', workspaceId: ws(c) },
      now(),
    );
    if (!challenge)
      return c.json(
        {
          error: 'challenge_invalid',
          message: 'The request expired or was already used. Start again.',
        },
        400,
      );
    const added = await addPasskey(
      db,
      {
        userId: user.id,
        name: body.data.name,
        challenge: challenge.challenge,
        rp: rp(c),
        clientDataJSON: body.data.credential.clientDataJSON,
        attestationObject: body.data.credential.attestationObject,
        claimedId: body.data.credential.id,
        transports: body.data.credential.transports ?? [],
      },
      now(),
    );
    if (!added.ok)
      return c.json(
        {
          error: 'passkey_rejected',
          reason: added.code,
          message: 'This passkey could not be added.',
        },
        400,
      );
    await recordAudit(db, {
      workspaceId: ws(c),
      actor: { type: 'user', id: user.id },
      action: 'step_up.passkey_added',
      target: { type: 'passkey', id: added.passkey.id },
      at: now(),
    });
    return c.json({ passkey: added.passkey }, 201);
  });

  routes.delete('/:workspaceId/step-up/passkeys/:id', needs('member'), async (c) => {
    const refusal = await requireManage(guard, c);
    if (refusal) return refusal;
    const user = c.get('user');
    const id = c.req.param('id') ?? '';
    if (!(await removePasskey(db, user.id, id))) return c.json({ error: 'not_found' }, 404);
    await recordAudit(db, {
      workspaceId: ws(c),
      actor: { type: 'user', id: user.id },
      action: 'step_up.passkey_removed',
      target: { type: 'passkey', id },
      at: now(),
    });
    return c.body(null, 204);
  });

  // ----- confirmation password (single-user mode) ----------------------------------------------
  routes.put('/:workspaceId/step-up/confirmation-password', needs('member'), async (c) => {
    if (!services.singleUser) {
      return c.json(
        {
          error: 'account_password_used',
          message: 'This server confirms with your account password. Change that password instead.',
        },
        409,
      );
    }
    const refusal = await requireManage(guard, c);
    if (refusal) return refusal;
    const body = await parseBody(c, passwordBody);
    if (!body.ok) return body.response;
    const user = c.get('user');
    await setConfirmationPassword(db, user.id, body.data.password, now(), services.cost);
    await recordAudit(db, {
      workspaceId: ws(c),
      actor: { type: 'user', id: user.id },
      action: 'step_up.password_set',
      at: now(),
    });
    return c.body(null, 204);
  });

  // ----- recovery codes ------------------------------------------------------------------------
  // Owners and admins only (the people who confirm hard actions). Needs a fresh confirmation (a passkey, the password or a code that is
  // left), so a stolen session cannot mint codes for itself. The codes are in THIS answer only and are never stored in the clear.
  routes.post('/:workspaceId/step-up/recovery-codes', needs('settings.write'), async (c) => {
    const body = await parseBody(c, recoveryBody);
    if (!body.ok) return body.response;
    const user = c.get('user');
    if (!(await isEnrolled(db, user.id))) {
      return c.json(
        {
          error: 'factor_not_enrolled',
          message:
            'Recovery codes stand in for a passkey or a confirmation password. Add one of those first.',
        },
        409,
      );
    }
    const refusal = await requireManage(guard, c);
    if (refusal) return refusal;
    const made = await generateRecoveryCodes(db, user.id, now());
    await recordAudit(db, {
      workspaceId: ws(c),
      actor: { type: 'user', id: user.id },
      action: 'step_up.recovery_generated',
      detail: { count: made.codes.length, replaced: made.replaced },
      at: now(),
    });
    c.header('Cache-Control', 'no-store');
    return c.json({ codes: made.codes, remaining: RECOVERY_CODE_COUNT, generatedAt: now() }, 201);
  });

  // ----- verify ---------------------------------------------------------------------------------
  routes.post('/:workspaceId/step-up/passkeys/assertion/options', needs('member'), async (c) => {
    const body = await parseBody(c, assertionOptionsBody);
    if (!body.ok) return body.response;
    const user = c.get('user');
    const sessionId = sessionIdOf(c);
    if (!sessionId) return c.json({ error: 'unauthenticated' }, 401);
    const party = rp(c);
    if (!party.webauthnAvailable)
      return c.json(
        {
          error: 'webauthn_unavailable',
          message: 'Passkeys need https, or http://localhost. Use your password.',
        },
        409,
      );
    if ((await listPasskeys(db, user.id)).length === 0)
      return c.json({ error: 'factor_not_enrolled', reason: 'passkey' }, 409);
    const { action, target } = body.data;
    const issued = await issueChallenge(
      db,
      {
        userId: user.id,
        sessionId,
        purpose: 'assert',
        workspaceId: ws(c),
        action,
        ...(target?.id ? { targetId: target.id } : {}),
        ...(target?.hash ? { targetHash: target.hash } : {}),
      },
      now(),
    );
    if (!issued) return c.json({ error: 'too_many_attempts' }, 429);
    return c.json({
      challengeId: issued.id,
      expiresAt: issued.expiresAt,
      publicKey: await assertionOptions(db, user.id, party, issued.challenge),
    });
  });

  routes.post('/:workspaceId/step-up/verify', needs('member'), async (c) => {
    const body = await parseBody(c, verifyBody);
    if (!body.ok) return body.response;
    const user = c.get('user');
    const sessionId = sessionIdOf(c);
    if (!sessionId) return c.json({ error: 'unauthenticated' }, 401);
    const common = {
      workspaceId: ws(c),
      userId: user.id,
      sessionId,
      action: body.data.action,
      target: body.data.target ?? {},
      rp: rp(c),
      ...(services.cost ? { cost: services.cost } : {}),
    };
    const input =
      body.data.factor === 'password'
        ? { ...common, factor: 'password' as const, password: body.data.password }
        : body.data.factor === 'recovery'
          ? { ...common, factor: 'recovery' as const, code: body.data.code }
          : body.data.factor === 'totp'
            ? {
                ...common,
                factor: 'totp' as const,
                code: body.data.code,
                masterKey: services.masterKey,
              }
            : body.data.factor === 'email'
              ? {
                  ...common,
                  factor: 'email' as const,
                  code: body.data.code,
                  masterKey: services.masterKey,
                }
              : {
                  ...common,
                  factor: 'passkey' as const,
                  challengeId: body.data.challengeId,
                  assertion: body.data.assertion,
                };
    const done = await verifyFactor(db, input, now());
    c.header('Cache-Control', 'no-store');
    if (done.ok) return c.json({ grant: done.grant, expiresAt: done.expiresAt });
    if (done.retryAfterSeconds) c.header('Retry-After', String(done.retryAfterSeconds));
    const message =
      done.error === 'step_up_locked'
        ? 'Too many wrong attempts. Try again later.'
        : done.error === 'step_up_failed'
          ? 'That did not confirm. Try again.'
          : done.error === 'step_up_busy'
            ? 'Another confirmation is in progress.'
            : 'That way of confirming is not set up.';
    return c.json(
      {
        error: done.error,
        ...(done.reason ? { reason: done.reason } : {}),
        ...(done.retryAfterSeconds ? { retryAfterSeconds: done.retryAfterSeconds } : {}),
        message,
      },
      done.status,
    );
  });

  // ----- policy ---------------------------------------------------------------------------------
  routes.put('/:workspaceId/step-up/policy', needs('settings.write'), async (c) => {
    const body = await parseBody(c, policyBody);
    if (!body.ok) return body.response;
    const refusal = await requireManage(guard, c, { onlyWhenPolicyOn: true });
    if (refusal) return refusal;
    const current = await getPolicy(db, ws(c));
    const next = await setPolicy(
      db,
      {
        workspaceId: ws(c),
        userId: c.get('user').id,
        policy: {
          mode: body.data.mode,
          actions: body.data.actions ?? current.actions,
          unattended: body.data.unattended ?? current.unattended,
        },
      },
      now(),
    );
    const enrolled = await isEnrolled(db, c.get('user').id);
    return c.json({
      policy: { ...next, classes: stepUpActions, defaults: defaultCoveredActions },
      enrolled,
    });
  });

  return routes;
}

export { isStepUpAction };
