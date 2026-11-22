import { Hono } from 'hono';
import { z } from 'zod';
import { SERVER_LOCALES } from '../i18n/runtime.ts';
import { parseUserLocale } from '../i18n/user-locale.ts';
import { type AppEnv, parseBody, type Services } from '../http.ts';

/**
 * `PATCH /api/me`: the person sets the language they read (ADR 0045, amendment of 2026-11-22). The language is used by emails that
 * have no request to read it from (alerts, the digest). `locale` is `en`, `fr`, `es` or `de` (a region is accepted and dropped: `fr-CA`
 * is `fr`), or null to go back to "no choice" (English). Anything else is `400 invalid_request`. Session cookie only; mounted after
 * `meRoute` under the same `requireUser`.
 */
export const updateMeBody = z.object({
  locale: z
    .string()
    .max(35)
    .nullable()
    .refine((v) => v === null || parseUserLocale(v) !== undefined, {
      message: `Use one of: ${SERVER_LOCALES.join(', ')}, or null.`,
    }),
});

export function meLocaleRoute(services: Services) {
  const app = new Hono<AppEnv>();
  app.patch('/', async (c) => {
    const body = await parseBody(c, updateMeBody);
    if (!body.ok) return body.response;
    const user = c.get('user');
    const locale = body.data.locale === null ? null : (parseUserLocale(body.data.locale) ?? null);
    await services.db.execute('UPDATE users SET locale = ? WHERE id = ?', [locale, user.id]);
    return c.json({ user: { ...user, locale } });
  });
  return app;
}
