import { type Action, can, type Role, translationProviderInfo } from '@kiln/core';
import type { Database } from '@kiln/db';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import type { AppEnv } from '../http.ts';
import { memberRole } from '../services/accounts.ts';
import { requireStepUp } from '../services/step-up.ts';
import { effectiveSync, lastScheduledSyncAt, loadSyncPrefs } from '../services/sync-schedule.ts';
import { translationCredentialId, translationUsageToday } from '../services/translation.ts';
import {
  describeSettings,
  getSettings,
  type SettingsContext,
  updateSettings,
  type WorkspaceSettings,
} from '../services/workspace-settings.ts';

export type SettingsRoutesContext = SettingsContext & {
  db: Database;
  now: () => number;
  /** KILN_SYNC_INTERVAL_MINUTES: 0 is off for every workspace. Default 30. */
  syncIntervalMinutes?: number;
};

/** The settings that switch a feature on. Turning one on is a hard action when step-up is on. */
export const FEATURE_SWITCHES = [
  'analytics.enabled',
  'translation.enabled',
  'prices.writeEnabled',
] as const;

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

  /** The scheduled refresh of this workspace as the screen needs it: what applies, why not, when it last ran. */
  async function syncInfo(workspaceId: string, settings: WorkspaceSettings) {
    const serverMinutes = ctx.syncIntervalMinutes ?? 30;
    const prefs = (await loadSyncPrefs(db)).get(workspaceId);
    const mine = effectiveSync(serverMinutes, prefs);
    return {
      serverMinutes,
      enabled: settings.values['sync.enabled'] === true,
      /** What applies: the workspace's choice, else the server's interval. */
      intervalMinutes:
        prefs?.intervalMinutes ??
        (serverMinutes > 0 ? serverMinutes : Number(settings.values['sync.intervalMinutes'])),
      running: mine.enabled,
      ...(mine.reason ? { off: mine.reason } : {}),
      lastScheduledAt: await lastScheduledSyncAt(db, workspaceId),
    };
  }

  /** `values['sync.intervalMinutes']` shows what applies: the server's interval until the workspace chooses its own. */
  const shown = (settings: WorkspaceSettings, role: Role, info: { intervalMinutes: number }) => {
    const described = describeSettings(settings, role);
    return {
      ...described,
      values: { ...described.values, 'sync.intervalMinutes': info.intervalMinutes },
    };
  };

  routes.get('/:workspaceId/settings', needs('settings.read'), async (c) => {
    const role = c.get('role');
    const settings = await getSettings(db, ws(c));
    const provider = settings.values[
      'translation.provider'
    ] as keyof typeof translationProviderInfo;
    const credentialId = await translationCredentialId(db, ws(c), provider);
    // Which credential is in use is shown to those who may see credentials; everyone sees whether there is one.
    let credential: { id: string; label: string } | undefined;
    if (credentialId && can(role, 'credentials.read')) {
      const [row] = await db.query(
        'SELECT label FROM credentials WHERE id = ? AND workspace_id = ?',
        [credentialId, ws(c)],
      );
      if (row) credential = { id: credentialId, label: String(row.label) };
    }
    const sync = await syncInfo(ws(c), settings);
    return c.json({
      ...shown(settings, role, sync),
      sync,
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
        {
          error: 'invalid_request',
          issues: [
            {
              path: '',
              message: 'Send an object of setting keys to values (null resets one to its default).',
            },
          ],
        },
        400,
      );
    }
    // Switching a feature ON (step-up class `flags`, docs/adr/0019-step-up-confirmation.md): a store-facing or paid feature that was off.
    // `stepUp` is the grant (docs/api/step-up.md), not a setting.
    const { stepUp: _grant, ...changes } = raw as Record<string, unknown>;
    const current = (await getSettings(db, ws(c))).values;
    const turnedOn = FEATURE_SWITCHES.find((key) => changes[key] === true && current[key] !== true);
    if (turnedOn) {
      const refusal = await requireStepUp({ db, now: ctx.now }, c, 'flags', { id: turnedOn });
      if (refusal) return refusal;
    }
    const done = await updateSettings(
      db,
      { workspaceId: ws(c), role: c.get('role'), changes },
      { type: 'user', id: c.get('user').id },
      ctx.now(),
      {
        ...(ctx.allowPrivateUrls ? { allowPrivateUrls: true } : {}),
        ...(ctx.resolve ? { resolve: ctx.resolve } : {}),
      },
    );
    if (!done.ok) return c.json(done.body, done.status);
    const sync = await syncInfo(ws(c), done.settings);
    return c.json({
      changed: done.changes.map((x) => x.key),
      ...shown(done.settings, c.get('role'), sync),
      sync,
    });
  });

  return routes;
}
