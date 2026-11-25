import { type Action, can, canToken } from '@kiln/core';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody } from '../../http.ts';
import { coded } from '../../i18n/problem.ts';
import { memberRole } from '../../services/accounts.ts';
import { getApp } from '../../services/apps.ts';
import type { TestLimiter } from '../../services/credential-tests.ts';
import {
  auditNotesTranslation,
  isNoteLocale,
  NOTES_TRANSLATE_LIMITS,
  type NotesTranslateContext,
  translateReleaseNotes,
} from './release-notes-translate.ts';
export type ReleaseNotesTranslateRoutesContext = NotesTranslateContext & {
  /** Requests per workspace per minute (default built in createApp: 10). */
  limiter: TestLimiter;
};

const locale = z
  .string()
  .max(35)
  .refine(isNoteLocale, 'A language tag such as en-US, de or pt-BR.');

export const translateNotesBody = z
  .object({
    engine: z.enum(['machine', 'ai']),
    sourceLocale: locale,
    text: z.string().min(1).max(NOTES_TRANSLATE_LIMITS.maxChars),
    targetLocales: z.array(locale).min(1).max(NOTES_TRANSLATE_LIMITS.maxTargets),
  })
  .strict();

const ws = (c: Context<AppEnv>) => c.req.param('workspaceId') ?? '';
const norm = (value: string) => value.trim().toLowerCase().replace(/_/g, '-');

/**
 * Translating the "what is new" text of a release (docs/api/releases-write.md, docs/adr/0028-release-notes-translation.md). One request
 * for both engines. It returns text and stores nothing; a person puts it in the editor and stages it like any other note. Mounted under
 * /api/workspaces.
 */
export function releaseNotesTranslateRoutes(ctx: ReleaseNotesTranslateRoutesContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();

  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  /** The role (already lowered to a token's ceiling) AND, for a token, its own list of actions. */
  const allowed = (c: Context<AppEnv>, action: Action) => {
    const token = c.get('token');
    return (
      can(c.get('role'), action) &&
      (token === undefined || canToken(token.ceiling, token.actions as Action[] | null, action))
    );
  };

  routes.post(
    '/:workspaceId/apps/:id/release-notes/translate',
    needs('changesets.write'),
    async (c) => {
      const app = await getApp(db, ws(c), c.req.param('id') ?? '');
      if (!app) return c.json({ error: 'not_found' }, 404);
      const body = await parseBody(c, translateNotesBody);
      if (!body.ok) return body.response;
      const { engine, sourceLocale, text } = body.data;
      // The machine engine is the translation provider (`reviews.translate`), the AI engine the AI provider (`ai.use`, explicit for a token).
      if (!allowed(c, engine === 'ai' ? 'ai.use' : 'reviews.translate')) {
        return c.json({ error: 'forbidden' }, 403);
      }
      const issues: { path: string; message: string }[] = [];
      if (text.trim() === '')
        issues.push({ path: 'text', message: 'Write the text to translate.' });
      const seen = new Set<string>([norm(sourceLocale)]);
      const targets: string[] = [];
      for (const t of body.data.targetLocales) {
        if (seen.has(norm(t))) continue;
        seen.add(norm(t));
        targets.push(t.trim().replace(/_/g, '-'));
      }
      if (targets.length === 0)
        issues.push({
          path: 'targetLocales',
          message: 'Choose at least one language other than the source language.',
        });
      if (issues.length > 0) return c.json({ error: 'invalid_request', issues }, 400);

      const wait = ctx.limiter.take(ws(c));
      if (wait > 0) {
        c.header('Retry-After', String(wait));
        return c.json(
          {
            error: 'rate_limited',
            message: `Too many translation requests. Try again in ${wait} seconds.`,
            ...coded('rate.translation', { count: wait }),
            retryAfterSeconds: wait,
          },
          429,
        );
      }
      const actor = { type: 'user' as const, id: c.get('user').id };
      const done = await translateReleaseNotes(ctx, {
        workspaceId: ws(c),
        app,
        actor,
        engine,
        sourceLocale: sourceLocale.trim().replace(/_/g, '-'),
        text,
        targetLocales: targets,
      });
      const audit = {
        workspaceId: ws(c),
        appId: app.id,
        actor,
        at: ctx.now(),
        engine,
        sourceLocale,
        targets: targets.length,
      };
      if (!done.ok) {
        await auditNotesTranslation(db, {
          ...audit,
          ok: false,
          code: String(done.body.error),
        }).catch(() => undefined);
        for (const [name, value] of Object.entries(done.headers ?? {})) c.header(name, value);
        c.header('Cache-Control', 'no-store');
        return c.json(done.body, done.status);
      }
      await auditNotesTranslation(db, { ...audit, ok: true, result: done.result }).catch(
        () => undefined,
      );
      c.header('Cache-Control', 'no-store');
      return c.json(done.result);
    },
  );

  return routes;
}
