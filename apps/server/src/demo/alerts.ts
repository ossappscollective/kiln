import type { Database } from '@mrm/db';
import { alertCatalog } from '../services/alert-catalog.ts';
import { markRead } from '../services/alert-inbox.ts';
import { setPreference, setRule } from '../services/alert-prefs.ts';
import { raiseAlert } from '../services/alerts.ts';
import { DEMO_USERS } from './routes.ts';

/**
 * The demo's alerts, made through the same services the app uses (`setRule`, `raiseAlert`, `markRead`, `setPreference`), never by
 * writing rows. Two steps: `seedAlertRules` before anything happens (so the seed's own events do not flood the inbox), and
 * `seedAlerts` at the end with a handful of things that went wrong over the last two days, a few read and a few not.
 */

const HOUR = 3_600_000;

/**
 * The workspace rules of the demo: nobody can receive email here (no mail server is set), so no rule asks for it; and "a competitor
 * changed its listing", which the 60 simulated days of ASO refreshes would raise hundreds of times, is off.
 */
export async function seedAlertRules(db: Database, workspaceId: string, ownerId: string, now: () => number): Promise<string[]> {
  const warnings: string[] = [];
  const actor = { type: 'user', id: ownerId } as const;
  for (const def of alertCatalog) {
    if (def.source.kind === 'internal') continue;
    const noisy = def.id === 'aso.competitor_changed';
    const hasEmail = def.defaultChannels.includes('email' as never);
    if (!noisy && !hasEmail) continue;
    const result = await setRule({ db, now }, { workspaceId, alertType: def.id, rule: { ...(noisy ? { enabled: false } : {}), channels: def.defaultChannels.filter((c) => c !== 'email') } }, actor);
    if (!result.ok) warnings.push(`alert rule ${def.id}: ${result.error}`);
  }
  return warnings;
}

type Sample = {
  type: Parameters<typeof raiseAlert>[1]['type'];
  app: string | null;
  hoursAgo: number;
  data: Record<string, string | number | boolean | null>;
  /** Read by the owner already. */
  read: boolean;
};

/** Raises the sample alerts, marks the older ones read, and gives the owner one preference of their own. Returns the warnings. */
export async function seedAlerts(input: {
  db: Database;
  workspaceId: string;
  /** The record ids by `<app>:<platform>`. */
  apps: Record<string, string>;
  /** The Google Play credential (the one the failed test is about). */
  playCredentialId: string;
  seededAt: number;
  now: () => number;
}): Promise<string[]> {
  const { db, workspaceId, apps, seededAt } = input;
  const warnings: string[] = [];
  const owner = (await db.query('SELECT id FROM users WHERE email = ?', [DEMO_USERS[0].email]))[0];
  if (!owner) return ['alerts: the demo owner was not found'];
  const ownerId = String(owner.id);
  const app = (key: string) => apps[key] ?? null;

  const samples: Sample[] = [
    { type: 'release.rejected', app: app('focus:macos'), hoursAgo: 30, read: true, data: { version: '1.7.0', track: '', build: '412', from: 'in_review', to: 'rejected' } },
    { type: 'credential.invalid', app: null, hoursAgo: 26, read: true, data: { credentialId: input.playCredentialId, kind: 'google_play', label: 'Demo Google Play service account' } },
    { type: 'store.sync_failed', app: app('weather:android'), hoursAgo: 20, read: true, data: {} },
    { type: 'analytics.sync_failing', app: app('weather:android'), hoursAgo: 14, read: false, data: { failures: 3, code: 'report_bucket_unreadable' } },
    { type: 'release.halted', app: app('weather:ios'), hoursAgo: 9, read: false, data: { version: '3.2.0', track: '' } },
    { type: 'review.low_rating', app: app('notes:ios'), hoursAgo: 5, read: false, data: { reviewId: 'demo-review-low-1', rating: 1, store: 'App Store' } },
  ];

  const raised: { id: string; read: boolean }[] = [];
  for (const s of samples) {
    const result = await raiseAlert(db, { workspaceId, type: s.type, appId: s.app, data: s.data, at: seededAt - s.hoursAgo * HOUR });
    if (result.status === 'raised' || result.status === 'collapsed') raised.push({ id: result.alertId, read: s.read });
    else warnings.push(`alert ${s.type}: ${result.status}`);
  }
  // The owner has read the older ones; the admin has read none, so the bell shows something for either of them.
  const readIds = raised.filter((r) => r.read).map((r) => r.id);
  if (readIds.length > 0) await markRead(db, { workspaceId, userId: ownerId, ids: readIds, at: seededAt - 4 * HOUR });

  // One choice of the owner's own: a rejected macOS release is worth a desktop notification as well.
  const focus = app('focus:macos');
  if (focus) {
    const pref = await setPreference({ db, now: input.now }, { workspaceId, userId: ownerId, alertType: 'release.rejected', appId: focus, channels: ['in_app', 'desktop'] });
    if (!pref.ok) warnings.push(`alert preference: ${pref.error}`);
  }
  return warnings;
}
