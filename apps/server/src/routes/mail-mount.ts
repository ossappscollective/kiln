import type { ConnectionOptions } from 'node:tls';
import { Hono } from 'hono';
import type { AppEnv, Services } from '../http.ts';
import { type SmtpEnv, createConfiguredMailer } from '../services/mail-config.ts';
import { type Mailer, setMailer } from '../services/mailer.ts';
import type { Resolver } from '../services/webhook-transport.ts';
import { loginTwoFactorRoutes } from './login-two-factor.ts';
import { mailRoutes } from './mail.ts';
import { twoFactorRoutes } from './two-factor.ts';

/**
 * Wires the mailer, the mail settings routes and the two-factor routes into the app (docs/adr/0021-two-factor-and-smtp.md), so app.ts
 * only needs three lines. `MailDeps` is the optional `mail` entry of `AppDeps`.
 */
export type MailDeps = {
  /** The SMTP environment (MRM_SMTP_*), parsed by `parseSmtpEnv`. Default: none, and private mail hosts are refused. */
  env?: SmtpEnv;
  /** Replaces the whole mailer (tests install `createFakeMailer()`). */
  mailer?: Mailer;
  /** DNS for the address check (tests). */
  resolve?: Resolver;
  /** Tests: TLS trust for a fake SMTP server, and short time limits. */
  tls?: ConnectionOptions;
  timeoutMs?: number;
  totalTimeoutMs?: number;
};

export type MailSetup = { mailer: Mailer; env: SmtpEnv; resolve?: Resolver };

/** Builds the mailer for this app and makes it the one `sendMail` uses. */
export function setUpMail(services: Services, deps: MailDeps | undefined): MailSetup {
  const env: SmtpEnv = deps?.env ?? { allowPrivateHosts: false };
  const mailer =
    deps?.mailer ??
    createConfiguredMailer({
      db: services.db,
      masterKey: services.masterKey,
      env,
      now: services.now,
      ...(deps?.resolve ? { resolve: deps.resolve } : {}),
      ...(deps?.tls ? { tls: deps.tls } : {}),
      ...(deps?.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
      ...(deps?.totalTimeoutMs ? { totalTimeoutMs: deps.totalTimeoutMs } : {}),
    });
  setMailer(mailer);
  return { mailer, env, ...(deps?.resolve ? { resolve: deps.resolve } : {}) };
}

/** `/api/auth/login/...`: the second step of signing in. Not mounted in single-user mode (there is no sign-in there). */
export const loginSecondFactorRoutes = (setup: MailSetup, services: Services) => loginTwoFactorRoutes({ services, mailer: setup.mailer });

/** `/api/workspaces/:workspaceId/two-factor/...`, `/step-up/email-code` and `/mail/...`. */
export function mailAndTwoFactorRoutes(setup: MailSetup, services: Services) {
  const app = new Hono<AppEnv>();
  app.route('/', twoFactorRoutes({ services, mailer: setup.mailer }));
  app.route('/', mailRoutes({ services, mailer: setup.mailer, env: setup.env, ...(setup.resolve ? { resolve: setup.resolve } : {}) }));
  return app;
}
