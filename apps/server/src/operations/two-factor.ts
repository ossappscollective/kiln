import { z } from 'zod';
import {
  loginChallengeBody,
  loginChallengeCodeBody,
  loginSecondFactorBody,
} from '../routes/login-two-factor.ts';
import { mailSettingsBody, mailTestBody } from '../routes/mail.ts';
import {
  emailBeginBody,
  emailConfirmBody,
  loginPolicyBody,
  stepUpEmailCodeBody,
  totpConfirmBody,
} from '../routes/two-factor.ts';
import { mailErrorCodes } from '../services/mailer.ts';
import type { Operation } from './openapi.ts';

/**
 * Two-factor authentication and mail (docs/api/two-factor.md, docs/api/mail.md). Every operation is for a person in the app: none is
 * open to an API token (a token cannot confirm anything, and must not read or change mail settings). Added to the registry in
 * api-operations.ts.
 */

const W = '/api/workspaces/{workspaceId}';
const timestamp = z.number().int().describe('Epoch milliseconds.');
const noToken = { token: false } as const;
const grantNote =
  'Needs a fresh confirmation (`X-Step-Up-Grant` for action `step_up.manage`) when the person already has a way to confirm.';

const totpStatus = z.object({
  state: z.enum(['none', 'pending', 'active']),
  confirmedAt: timestamp.nullable(),
});
const emailStatus = z
  .object({
    address: z.string(),
    verified: z.boolean(),
    verifiedAt: timestamp.nullable(),
    usable: z.boolean(),
  })
  .nullable();
const loginMode = z.enum(['off', 'optional', 'admins', 'all']);
const sent = z.object({
  expiresAt: timestamp,
  resendAfterSeconds: z.number().int(),
  to: z.string().describe('The address with most of it hidden.'),
});
const smtpView = z.object({
  source: z.enum(['env', 'settings', 'none']),
  configured: z.boolean(),
  locked: z
    .boolean()
    .describe('The server environment decides (KILN_SMTP_HOST): the screen cannot change it.'),
  host: z.string().nullable(),
  port: z.number().int().nullable(),
  secure: z.enum(['none', 'starttls', 'tls']).nullable(),
  user: z.string().nullable(),
  from: z.string().nullable(),
  passwordSet: z
    .boolean()
    .describe('Whether a password is saved. The password itself is never returned.'),
  allowPrivateHosts: z.boolean(),
});

export const twoFactorOperations: Operation[] = [
  {
    id: 'getTwoFactorStatus',
    method: 'get',
    path: `${W}/two-factor/status`,
    tags: ['two-factor'],
    summary:
      'Your authenticator app and email factor, whether the server can send mail, and the sign-in policy',
    description:
      'Any member. Never returns a secret or a code. `login.membersWithoutSecondFactor` is for owners and admins.',
    risk: 'read',
    access: 'member',
    ...noToken,
    partial: true,
    responses: {
      '200': {
        description: 'Status.',
        schema: z
          .object({
            totp: totpStatus,
            email: emailStatus,
            mailConfigured: z.boolean(),
            emailAddressEditable: z.boolean(),
            login: z.object({
              supported: z.boolean(),
              mode: loginMode,
              membersWithoutSecondFactor: z.number().int().optional(),
            }),
          })
          .passthrough(),
      },
    },
  },
  {
    id: 'startTotpEnrollment',
    method: 'post',
    path: `${W}/two-factor/totp/begin`,
    tags: ['two-factor'],
    summary: 'Start setting up an authenticator app: a new secret and its otpauth:// link',
    description: `${grantNote} The secret is in this answer ONLY (stored encrypted), with \`Cache-Control: no-store\`; show it as a QR code and as text. \`409 already_enrolled\` while one is active: remove it first. A new call replaces an unconfirmed secret.`,
    risk: 'write',
    access: 'member',
    ...noToken,
    body: z.object({}),
    bodyOptional: true,
    partial: true,
    responses: {
      '201': { description: '`secret` (base32), `uri` (otpauth://totp/...), `issuer`, `account`.' },
    },
  },
  {
    id: 'confirmTotpEnrollment',
    method: 'post',
    path: `${W}/two-factor/totp/confirm`,
    tags: ['two-factor'],
    summary: 'Finish setting up the authenticator app with the first code it shows',
    description:
      'SHA-1, 6 digits, 30 seconds, one step either way. `400 invalid_code`. The accepted code cannot be used again.',
    risk: 'write',
    access: 'member',
    ...noToken,
    body: totpConfirmBody,
    responses: {
      '200': { description: 'The new status.', schema: z.object({ totp: totpStatus }) },
    },
  },
  {
    id: 'removeTotp',
    method: 'delete',
    path: `${W}/two-factor/totp`,
    tags: ['two-factor'],
    summary: 'Remove your authenticator app',
    description: grantNote,
    risk: 'destructive',
    access: 'member',
    ...noToken,
    responses: { '204': { description: 'Removed.' } },
  },
  {
    id: 'startEmailVerification',
    method: 'post',
    path: `${W}/two-factor/email/begin`,
    tags: ['two-factor'],
    summary: 'Send a code to verify your address for emailed codes',
    description: `${grantNote} On a server with accounts the code goes to your account email only; in single-user mode the body takes \`email\`. A code is six digits, lasts 10 minutes and allows 5 tries. At most one a minute, 6 an hour per person and 30 an hour per workspace (\`429 rate_limited\`). \`409 mail_not_configured\`; \`502 mail_failed\` with a fixed \`code\`.`,
    risk: 'write',
    access: 'member',
    ...noToken,
    rateLimited: true,
    body: emailBeginBody,
    bodyOptional: true,
    responses: { '202': { description: 'A code was sent.', schema: sent } },
  },
  {
    id: 'confirmEmailVerification',
    method: 'post',
    path: `${W}/two-factor/email/confirm`,
    tags: ['two-factor'],
    summary: 'Verify your address with the code that was mailed',
    description:
      '`400 invalid_code` or `code_expired`, `429 too_many_attempts` after 5 wrong tries (ask for a new code).',
    risk: 'write',
    access: 'member',
    ...noToken,
    body: emailConfirmBody,
    partial: true,
    responses: { '200': { description: 'The address is verified and can confirm hard actions.' } },
  },
  {
    id: 'removeEmailFactor',
    method: 'delete',
    path: `${W}/two-factor/email`,
    tags: ['two-factor'],
    summary: 'Remove your verified address (and open codes)',
    description: grantNote,
    risk: 'destructive',
    access: 'member',
    ...noToken,
    responses: { '204': { description: 'Removed.' } },
  },
  {
    id: 'sendStepUpEmailCode',
    method: 'post',
    path: `${W}/step-up/email-code`,
    tags: ['step-up'],
    summary: 'Email a code that confirms one hard action',
    description:
      'The code goes only to your VERIFIED address and works only for this session, this action and this target. Then confirm with `POST /step-up/verify` and `factor: "email"`. Same limits as the verification code.',
    risk: 'write',
    access: 'member',
    ...noToken,
    rateLimited: true,
    body: stepUpEmailCodeBody,
    responses: { '202': { description: 'A code was sent.', schema: sent } },
  },
  {
    id: 'setTwoFactorPolicy',
    method: 'put',
    path: `${W}/two-factor/policy`,
    tags: ['two-factor'],
    summary:
      'Choose whether signing in asks for a second factor: off, optional, required for admins, required for all',
    description: `Owner and admin (\`settings.write\`). \`optional\`: people who have a factor must use it. \`admins\` and \`all\`: owners and admins (everyone) must have one and, if they have none, set one up at the next sign-in. ${grantNote} Refused (\`409 two_factor_not_enrolled\`) unless you have a factor yourself. \`409 single_user_mode\` in single-user mode.`,
    risk: 'write',
    access: { action: 'settings.write' },
    ...noToken,
    body: loginPolicyBody,
    responses: {
      '200': {
        description: 'The policy.',
        schema: z.object({ mode: loginMode, membersWithoutSecondFactor: z.number().int() }),
      },
    },
  },
  {
    id: 'resetMemberTwoFactor',
    method: 'delete',
    path: `${W}/two-factor/members/{userId}`,
    tags: ['two-factor'],
    summary: "Remove another member's authenticator app and email factor (a lost phone)",
    description: `Needs \`members.manage\`; only an owner can reset an owner or an admin. ${grantNote} Audited as \`two_factor.reset\`.`,
    risk: 'destructive',
    access: { action: 'members.manage' },
    ...noToken,
    responses: { '204': { description: 'Reset.' } },
  },
  {
    id: 'getMailSettings',
    method: 'get',
    path: `${W}/mail/settings`,
    tags: ['mail'],
    summary: 'The SMTP settings in force (never the password)',
    description:
      'Owner and admin (`settings.write`). The setting is for the whole server. `source` is `env` (KILN_SMTP_HOST; read only), `settings` or `none`.',
    risk: 'read',
    access: { action: 'settings.write' },
    ...noToken,
    responses: { '200': { description: 'Settings.', schema: smtpView } },
  },
  {
    id: 'saveMailSettings',
    method: 'put',
    path: `${W}/mail/settings`,
    tags: ['mail'],
    summary: 'Save the SMTP settings (encrypted at rest)',
    description: `Owner and admin. ${grantNote} \`password\` omitted keeps the saved one only while host, port and user are unchanged (\`400 password_required\` otherwise); an empty string removes it. \`400 address_not_allowed\` with \`hint: private_address_blocked\` for a loopback or private host unless KILN_SMTP_ALLOW_PRIVATE_HOSTS=true; \`409 smtp_locked\` when the environment decides.`,
    risk: 'write',
    access: { action: 'settings.write' },
    ...noToken,
    body: mailSettingsBody,
    responses: { '200': { description: 'Settings.', schema: smtpView } },
  },
  {
    id: 'clearMailSettings',
    method: 'delete',
    path: `${W}/mail/settings`,
    tags: ['mail'],
    summary: 'Remove the saved SMTP settings',
    description: `Owner and admin. ${grantNote}`,
    risk: 'destructive',
    access: { action: 'settings.write' },
    ...noToken,
    responses: { '200': { description: 'Settings now in force.', schema: smtpView } },
  },
  {
    id: 'sendTestEmail',
    method: 'post',
    path: `${W}/mail/test`,
    tags: ['mail'],
    summary: 'Send a test email to yourself',
    description:
      'Owner and admin. On a server with accounts the message goes to your own account email only; in single-user mode to the address in `to`. At most 5 in 10 minutes (`429`). The answer is `{ ok: true }` or `{ ok: false, code, hint?, message }` with `code` one of the fixed list. Nothing a mail server said is returned.',
    risk: 'write',
    access: { action: 'settings.write' },
    ...noToken,
    rateLimited: true,
    body: mailTestBody,
    bodyOptional: true,
    responses: {
      '200': {
        description: 'The result of the attempt.',
        schema: z.object({
          ok: z.boolean(),
          to: z.string().optional(),
          code: z.enum(mailErrorCodes).optional(),
          hint: z.string().optional(),
          message: z.string().optional(),
        }),
      },
    },
  },
  // The second step of signing in (public like login: the challenge token is the credential, and it is worth 5 minutes and 5 tries).
  {
    id: 'loginSecondFactor',
    method: 'post',
    path: '/api/auth/login/two-factor',
    tags: ['auth'],
    summary:
      'Finish signing in with the second factor (authenticator code, emailed code or recovery code)',
    description:
      '`POST /api/auth/login` answers `{ twoFactorRequired: true, enrollmentRequired, challenge, methods }` INSTEAD of a session when the policy asks for a second factor. Send the `challenge`, a `method` (`totp`, `email` or `recovery`) and the `code`. The challenge lasts 5 minutes, allows 5 wrong tries and is spent by the request that completes the sign-in; wrong tries also count against the per-email and per-address limits. Sets the session cookie. `401 invalid_second_factor` or `challenge_invalid`.',
    risk: 'write',
    access: 'public',
    body: loginSecondFactorBody,
    bodyLimit: 256 * 1024,
    rateLimited: true,
    responses: {
      '200': {
        description: 'Signed in; the session cookie is set.',
        schema: z.object({
          user: z.object({ id: z.string(), email: z.string(), displayName: z.string() }),
        }),
      },
    },
  },
  {
    id: 'loginEmailCode',
    method: 'post',
    path: '/api/auth/login/two-factor/email-code',
    tags: ['auth'],
    summary: 'Email a sign-in code to the verified address',
    description:
      'For a sign-in challenge of a person who has a verified address. One a minute, 6 an hour per person, 60 an hour for the whole server (`429 rate_limited`). `409 mail_not_configured`, `502 mail_failed` with a fixed `code`.',
    risk: 'write',
    access: 'public',
    body: loginChallengeBody,
    bodyLimit: 256 * 1024,
    rateLimited: true,
    responses: { '202': { description: 'A code was sent.', schema: sent } },
  },
  {
    id: 'loginEnrollTotp',
    method: 'post',
    path: '/api/auth/login/enroll/totp',
    tags: ['auth'],
    summary:
      'Set up an authenticator app during sign-in (the policy requires one and you have none)',
    description:
      'Only for a challenge with `enrollmentRequired`. A person who already has a factor never gets one of these, so a known password cannot add a factor to an account that has one. The secret is in this answer only.',
    risk: 'write',
    access: 'public',
    body: loginChallengeBody,
    bodyLimit: 256 * 1024,
    partial: true,
    responses: { '201': { description: '`secret`, `uri`, `issuer`, `account`.' } },
  },
  {
    id: 'loginEnrollTotpConfirm',
    method: 'post',
    path: '/api/auth/login/enroll/totp/confirm',
    tags: ['auth'],
    summary: 'Confirm the new authenticator app with its first code; signs you in',
    description: "Counts as one of the challenge's 5 tries. Sets the session cookie.",
    risk: 'write',
    access: 'public',
    body: loginChallengeCodeBody,
    bodyLimit: 256 * 1024,
    rateLimited: true,
    responses: { '200': { description: 'Signed in.' } },
  },
  {
    id: 'loginEnrollEmail',
    method: 'post',
    path: '/api/auth/login/enroll/email',
    tags: ['auth'],
    summary: 'Send a code to your account email during sign-in, to use email as your second factor',
    description:
      'Only for a challenge with `enrollmentRequired`, and only when a mail server is set up (`409 mail_not_configured`).',
    risk: 'write',
    access: 'public',
    body: loginChallengeBody,
    bodyLimit: 256 * 1024,
    rateLimited: true,
    responses: { '202': { description: 'A code was sent.', schema: sent } },
  },
  {
    id: 'loginEnrollEmailConfirm',
    method: 'post',
    path: '/api/auth/login/enroll/email/confirm',
    tags: ['auth'],
    summary:
      'Verify the emailed code; the address becomes your second factor and you are signed in',
    description: "Counts as one of the challenge's 5 tries. Sets the session cookie.",
    risk: 'write',
    access: 'public',
    body: loginChallengeCodeBody,
    bodyLimit: 256 * 1024,
    rateLimited: true,
    responses: { '200': { description: 'Signed in.' } },
  },
];
