import { type Action, can, translationProviderInfo } from '@mrm/core';
import type { Database } from '@mrm/db';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { AppEnv } from '../http.ts';
import { memberRole } from '../services/accounts.ts';
import { translationCredentialId, translationUsageToday } from '../services/translation.ts';
import {
  type SettingsContext,
  describeSettings,
  getSettings,
  updateSettings,
} from '../services/workspace-settings.ts';

export type SettingsRoutesContext = SettingsContext & {
  db: Database;
  now: () => number;
};

const ws = (c: Context<AppEnv>) => c.req.param('workspaceId') ?? '';

/**
 * Workspace settings (docs/api/settings.md): a typed registry of a few keys, readable by every
 * member, changeable by admins. Secrets are never settings: they live in the vault.
 * Mounted under /api/workspaces.
 */
export function settingsRoutes(ctx: SettingsRoutesContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();

  /** Not a member and no such workspace look the same (404). A member without the right gets 403. */
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };

  routes.get('/:workspaceId/settings', needs('settings.read'), async (c) => {
    const role = c.get('role');
    const settings = await getSettings(db, ws(c));
    const provider = settings.values['translation.provider'] as keyof typeof translationProviderInfo;
    const credentialId = await translationCredentialId(db, ws(c), provider);
    // Which credential is in use is shown to those who may see credentials; everyone sees whether there is one.
    let credential: { id: string; label: string } | undefined;
    if (credentialId && can(role, 'credentials.read')) {
      const [row] = await db.query('SELECT label FROM credentials WHERE id = ? AND workspace_id = ?', [credentialId, ws(c)]);
      if (row) credential = { id: credentialId, label: String(row.label) };
    }
    return c.json({
      ...describeSettings(settings, role),
      translation: {
        provider,
        credentialRequired: translationProviderInfo[provider].credentialRequired,
        credentialConfigured: credentialId !== undefined,
        ...(credential ? { credential } : {}),
        usage: await translationUsageToday(db, ws(c), ctx.now()),
      },
    });
  });

  routes.put('/:workspaceId/settings', needs('settings.write'), async (c) => {
    const raw: unknown = await c.req.json().catch(() => undefined);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return c.json(
        { error: 'invalid_request', issues: [{ path: '', message: 'Send an object of setting keys to values (null resets one to its default).' }] },
        400,
      );
    }
    const done = await updateSettings(
      db,
      { workspaceId: ws(c), role: c.get('role'), changes: raw as Record<string, unknown> },
      { type: 'user', id: c.get('user').id },
      ctx.now(),
      { ...(ctx.allowPrivateUrls ? { allowPrivateUrls: true } : {}), ...(ctx.resolve ? { resolve: ctx.resolve } : {}) },
    );
    if (!done.ok) return c.json(done.body, done.status);
    return c.json({
      changed: done.changes.map((x) => x.key),
      ...describeSettings(done.settings, c.get('role')),
    });
  });

  return routes;
}
