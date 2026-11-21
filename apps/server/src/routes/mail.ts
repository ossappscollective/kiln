import { type Action, can } from '@kiln/core';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody, type Services } from '../http.ts';
import { memberRole } from '../services/accounts.ts';
import { recordAudit } from '../services/audit.ts';
import {
  clearSmtp,
  effectiveSmtp,
  type SmtpEnv,
  saveSmtp,
  smtpInputSchema,
  smtpView,
} from '../services/mail-config.ts';
import { plainAddress } from '../services/mail-mime.ts';
import { mailBar, mailButton, mailFooter, mailLink, mailShell } from '../services/mail-template.ts';
import { MAIL_ERROR_MESSAGES, type Mailer } from '../services/mailer.ts';
import { requireManage } from '../services/step-up.ts';
import { activeEmail } from '../services/two-factor.ts';
import type { Resolver } from '../services/webhook-transport.ts';

/**
 * Mail settings (docs/api/mail.md). Mounted under /api/workspaces. The setting is for the whole server, not for the workspace: the
 * workspace id in the path is only the door (an owner or admin of it may change the server's mail setting). Closed to API tokens.
 * Saving or clearing it needs a fresh step-up confirmation whenever the person has a way to confirm: whoever controls the mail server
 * receives the emailed codes, so a stolen session must not be able to repoint it.
 */
export type MailRoutesContext = {
  services: Services;
  mailer: Mailer;
  env: SmtpEnv;
  resolve?: Resolver;
};

const ws = (c: Context<AppEnv>) => c.req.param('workspaceId') ?? '';

export const mailTestBody = z
  .object({ to: z.string().trim().max(254).optional() })
  .strict()
  .optional();
export const mailSettingsBody = smtpInputSchema;

const TEST_WINDOW_MS = 10 * 60_000;
const TEST_MAX = 5;

export function mailRoutes(ctx: MailRoutesContext) {
  const { services, mailer, env } = ctx;
  const { db, now, masterKey } = services;
  const routes = new Hono<AppEnv>();
  const guard = { db, now };
  const tests = new Map<string, number[]>();

  const needs = (action: Action | 'member') => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (action !== 'member' && !can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };

  const view = async () => smtpView(await effectiveSmtp(db, masterKey, env), env);

  routes.get('/:workspaceId/mail/settings', needs('settings.write'), async (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(await view());
  });

  routes.put('/:workspaceId/mail/settings', needs('settings.write'), async (c) => {
    const body = await parseBody(c, smtpInputSchema);
    if (!body.ok) return body.response;
    const refusal = await requireManage(guard, c);
    if (refusal) return refusal;
    const done = await saveSmtp(db, {
      masterKey,
      env,
      value: body.data,
      workspaceId: ws(c),
      userId: c.get('user').id,
      now: now(),
      ...(ctx.resolve ? { resolve: ctx.resolve } : {}),
    });
    if (!done.ok) {
      if (done.error === 'smtp_locked')
        return c.json(
          {
            error: 'smtp_locked',
            message:
              'The mail server is set by the server environment (MRM_SMTP_HOST). Change it there.',
          },
          409,
        );
      if (done.error === 'password_required')
        return c.json(
          {
            error: 'password_required',
            message: 'Type the password again when the host, the port or the user name changes.',
          },
          400,
        );
      return c.json(
        {
          error: 'address_not_allowed',
          hint: done.hint,
          message:
            done.hint === 'private_address_blocked'
              ? 'This server only sends mail to public addresses. For a mail server on this machine or your network, the person who runs this server sets MRM_SMTP_ALLOW_PRIVATE_HOSTS=true and restarts it.'
              : 'That address cannot be used for mail.',
        },
        400,
      );
    }
    return c.json(done.view);
  });

  routes.delete('/:workspaceId/mail/settings', needs('settings.write'), async (c) => {
    const refusal = await requireManage(guard, c);
    if (refusal) return refusal;
    const done = await clearSmtp(db, {
      env,
      workspaceId: ws(c),
      userId: c.get('user').id,
      now: now(),
    });
    if (done === 'smtp_locked')
      return c.json(
        {
          error: 'smtp_locked',
          message:
            'The mail server is set by the server environment (MRM_SMTP_HOST). Change it there.',
        },
        409,
      );
    return c.json(await view());
  });

  // A test message goes to the signed-in person only: on a server with accounts, to their own account email (this route is not a way to
  // mail anyone else); in single-user mode, where there is no account email, to the address they type.
  routes.post('/:workspaceId/mail/test', needs('settings.write'), async (c) => {
    const body = await parseBody(c, mailTestBody);
    if (!body.ok) return body.response;
    const user = c.get('user');
    const at = now();
    const recent = (tests.get(user.id) ?? []).filter((t) => at - t < TEST_WINDOW_MS);
    if (recent.length >= TEST_MAX) {
      const wait = Math.max(1, Math.ceil(((recent[0] as number) + TEST_WINDOW_MS - at) / 1000));
      c.header('Retry-After', String(wait));
      return c.json(
        {
          error: 'rate_limited',
          retryAfterSeconds: wait,
          message: 'Too many test messages. Try again later.',
        },
        429,
      );
    }
    let to: string | undefined;
    if (services.singleUser) {
      to = body.data?.to
        ? plainAddress(body.data.to)
        : ((await activeEmail(db, user.id)) ?? undefined);
      if (!to)
        return c.json(
          { error: 'email_required', message: 'Enter the address to send the test message to.' },
          400,
        );
    } else {
      to = user.email;
      if (body.data?.to && body.data.to.trim().toLowerCase() !== user.email.toLowerCase()) {
        return c.json(
          { error: 'forbidden', message: 'A test message goes to your own account email only.' },
          403,
        );
      }
    }
    recent.push(at);
    tests.set(user.id, recent);
    const sent = await mailer.send({
      to,
      subject: 'Test message from Kiln',
      text: 'This is a test message. If you can read it, this server can send email.\n\nNo action is needed.',
      html: testMessageHtml(),
    });
    await recordAudit(db, {
      workspaceId: ws(c),
      actor: { type: 'user', id: user.id },
      action: 'mail.test_sent',
      detail: sent.ok ? { ok: true } : { ok: false, code: sent.code },
      at,
    });
    c.header('Cache-Control', 'no-store');
    if (sent.ok) return c.json({ ok: true, to });
    return c.json({
      ok: false,
      code: sent.code,
      ...(sent.hint ? { hint: sent.hint } : {}),
      message: MAIL_ERROR_MESSAGES[sent.code],
    });
  });

  return routes;
}

/** The HTML of the test message: a plain confirmation with a way back to the mail settings. */
function testMessageHtml(): string {
  const back = {
    label: 'Back to the mail settings',
    href: mailLink('#/settings?view=security'),
    where: 'Settings, Security, Mail server',
  };
  return mailShell(
    `${mailBar('#1f9d55')}
<tr><td style="padding:24px 28px 0;">
<h1 style="margin:0 0 8px;font-size:20px;line-height:1.3;">Email works</h1>
<p style="margin:0;font-size:15px;line-height:1.55;color:#323f4b;">This is a test message. If you can read it, this server can send email, so alerts and sign-in codes will reach you. No action is needed.</p>
</td></tr>
<tr><td style="padding:20px 28px 24px;">${mailButton(back, '#1f9d55')}</td></tr>
${mailFooter('You sent this test yourself from the mail settings.')}`,
    'This server can send email',
  );
}
