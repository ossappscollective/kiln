import { z } from 'zod';
import {
  stepUpAssertionOptionsBody,
  stepUpPasswordBody,
  stepUpPolicyBody,
  stepUpRecoveryBody,
  stepUpRegisterVerifyBody,
  stepUpVerifyBody,
} from '../routes/step-up.ts';
import type { Operation } from './openapi.ts';
import { stepUpActions } from './step-up.ts';

/**
 * Step-up confirmation (docs/api/step-up.md). Every operation is for a person in the app: none is open to an API token (a token cannot
 * confirm anything, by design). Added to the registry in api-operations.ts.
 */

const W = '/api/workspaces/{workspaceId}';
const timestamp = z.number().int().describe('Epoch milliseconds.');
const action = z.enum(stepUpActions);

const passkeySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: timestamp,
  lastUsedAt: timestamp.nullable(),
  transports: z.array(z.string()),
});
const policySchema = z.object({
  mode: z.enum(['off', 'hard_actions']),
  actions: z.array(action),
  unattended: z.array(action),
  classes: z.array(action).optional(),
  defaults: z.array(action).optional(),
});
const statusSchema = z.object({
  policy: policySchema,
  factors: z.object({
    passkeys: z.array(passkeySchema),
    password: z.object({ kind: z.enum(['account', 'confirmation']) }).nullable(),
    confirmationPasswordSettable: z.boolean(),
  }),
  enrolled: z.boolean(),
  recovery: z.object({
    remaining: z
      .number()
      .int()
      .describe(
        'Recovery codes of this person that are unused. A code is never returned after it was made.',
      ),
    total: z.number().int(),
    generatedAt: timestamp.nullable(),
  }),
  lockedUntil: timestamp.nullable(),
  supported: z.object({
    webauthn: z
      .boolean()
      .describe(
        'The server can verify passkeys for this origin (https or localhost). The browser must support them too.',
      ),
    rpId: z.string(),
    maxPasskeys: z.number().int(),
  }),
  grantTtlSeconds: z.number().int(),
});

const noToken = { token: false } as const;

export const stepUpOperations: Operation[] = [
  {
    id: 'getStepUpStatus',
    method: 'get',
    path: `${W}/step-up/status`,
    tags: ['step-up'],
    summary: 'The step-up policy, and the ways the signed-in person can confirm',
    description: 'Any member. Never returns a key or a hash.',
    risk: 'read',
    access: 'member',
    ...noToken,
    responses: {
      '200': { description: 'Policy, factors and what the server supports.', schema: statusSchema },
    },
  },
  {
    id: 'startPasskeyRegistration',
    method: 'post',
    path: `${W}/step-up/passkeys/register/options`,
    tags: ['step-up'],
    summary: 'Start adding a passkey: a one-time challenge and the WebAuthn creation options',
    description:
      'The challenge is single use and lasts 2 minutes. `409 webauthn_unavailable` when the origin is not https or localhost.',
    risk: 'write',
    access: 'member',
    ...noToken,
    body: z.object({}),
    bodyOptional: true,
    partial: true,
    responses: {
      '200': {
        description:
          '`challengeId`, `expiresAt` and `publicKey` (options for `navigator.credentials.create`, base64url fields).',
      },
    },
  },
  {
    id: 'finishPasskeyRegistration',
    method: 'post',
    path: `${W}/step-up/passkeys/register/verify`,
    tags: ['step-up'],
    summary: 'Finish adding a passkey: verify the attestation and store the public key',
    description:
      'Needs a fresh confirmation (`X-Step-Up-Grant` for action `step_up.manage`) when the person already has a way to confirm (always in multi-user mode: the account password). Only attestation `none`, ES256 or EdDSA, user verification required. `400 passkey_rejected` with a fixed `reason`.',
    risk: 'write',
    access: 'member',
    ...noToken,
    body: stepUpRegisterVerifyBody,
    partial: true,
    responses: {
      '201': { description: 'The new passkey.', schema: z.object({ passkey: passkeySchema }) },
    },
  },
  {
    id: 'deletePasskey',
    method: 'delete',
    path: `${W}/step-up/passkeys/{id}`,
    tags: ['step-up'],
    summary: 'Remove one of your passkeys',
    description: 'Needs a fresh confirmation (`step_up.manage`).',
    risk: 'destructive',
    access: 'member',
    ...noToken,
    responses: { '204': { description: 'Removed.' } },
  },
  {
    id: 'setConfirmationPassword',
    method: 'put',
    path: `${W}/step-up/confirmation-password`,
    tags: ['step-up'],
    summary: 'Set the confirmation password (single-user mode, where there is no sign-in password)',
    description:
      '`409 account_password_used` on a server with accounts: there the account password confirms. At least 12 characters, hashed like account passwords. Needs a fresh confirmation (`step_up.manage`) when one exists already.',
    risk: 'write',
    access: 'member',
    ...noToken,
    body: stepUpPasswordBody,
    responses: { '204': { description: 'Set.' } },
  },
  {
    id: 'startStepUpAssertion',
    method: 'post',
    path: `${W}/step-up/passkeys/assertion/options`,
    tags: ['step-up'],
    summary: 'Start confirming with a passkey: a one-time challenge bound to the action and target',
    description: 'Single use, 2 minutes. `409 factor_not_enrolled` without a passkey.',
    risk: 'write',
    access: 'member',
    ...noToken,
    body: stepUpAssertionOptionsBody,
    partial: true,
    responses: {
      '200': {
        description:
          '`challengeId`, `expiresAt` and `publicKey` (options for `navigator.credentials.get`).',
      },
    },
  },
  {
    id: 'generateRecoveryCodes',
    method: 'post',
    path: `${W}/step-up/recovery-codes`,
    tags: ['step-up'],
    summary: 'Make ten one-time recovery codes (shown once); any older codes stop working',
    description:
      'Owner and admin (`settings.write`), for the signed-in person. Needs a fresh confirmation (`X-Step-Up-Grant` for action `step_up.manage`: a passkey, the password or a recovery code that is left) and at least one passkey or password (`409 factor_not_enrolled`). The codes are in this answer ONLY (100 random bits each; stored as salted hashes), with `Cache-Control: no-store`. A code satisfies any step-up verification once (`factor: "recovery"` on `POST /step-up/verify`), and lets a person remove or replace a lost only factor. Audited as `step_up.recovery_generated` (counts only); each use as `step_up.recovery_used` and the event `stepup.recovery_used`.',
    risk: 'write',
    access: { action: 'settings.write' },
    ...noToken,
    body: stepUpRecoveryBody,
    bodyOptional: true,
    partial: true,
    responses: {
      '201': {
        description: 'The ten codes, shown once.',
        schema: z.object({
          codes: z.array(z.string()),
          remaining: z.number().int(),
          generatedAt: timestamp,
        }),
      },
    },
  },
  {
    id: 'verifyStepUp',
    method: 'post',
    path: `${W}/step-up/verify`,
    tags: ['step-up'],
    summary: 'Confirm with a passkey assertion or a password and receive a grant',
    description:
      'The grant is a random string valid 5 minutes and for ONE use, bound to this session, the action and the optional target id and hash. Send it as the header `X-Step-Up-Grant` (or the body field `stepUp`) on the action. `factor: "recovery"` takes `code`: one of the ten recovery codes, spent by its first use (also for `step_up.manage`, which is how a lost only passkey or confirmation password is removed or replaced). Wrong attempts are counted (a wrong recovery code too): 5 in a row lock confirmation for 30 seconds, doubling up to 15 minutes (`429 step_up_locked`, `Retry-After`). `403 step_up_failed` with a fixed `reason`.',
    risk: 'write',
    access: 'member',
    ...noToken,
    rateLimited: true,
    body: stepUpVerifyBody,
    responses: {
      '200': {
        description: 'The grant.',
        schema: z.object({ grant: z.string(), expiresAt: timestamp }),
      },
    },
  },
  {
    id: 'setStepUpPolicy',
    method: 'put',
    path: `${W}/step-up/policy`,
    tags: ['step-up'],
    summary:
      'Switch step-up confirmation on or off, choose the covered actions and the unattended ones',
    description:
      'Owner and admin (`settings.write`). Changing a policy that is on needs a fresh confirmation (`step_up.manage`). `unattended` lets API tokens perform those classes WITHOUT a person confirming: it is the CI trade-off, and default empty. Audited as `step_up.policy_changed`.',
    risk: 'write',
    access: { action: 'settings.write' },
    ...noToken,
    body: stepUpPolicyBody,
    responses: {
      '200': {
        description: 'The policy.',
        schema: z.object({ policy: policySchema, enrolled: z.boolean() }),
      },
    },
  },
];
