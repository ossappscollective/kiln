import { randomBytes } from 'node:crypto';
import type {
  BetaScreenshotLink,
  ListBetaFeedbackResult,
  StoreBetaFeedback,
  StoreTestFlightFeedbackConnector,
} from '@kiln/connectors';
import type { Platform } from '@kiln/core';
import type { Database } from '@kiln/db';
import { bootRepoApp } from '../../repo-test-helpers.ts';
import { ASC_SECRET, PLAY_SECRET } from '../reviews/test-helpers.ts';
import type { TestflightDeps } from './index.ts';
import type { TestflightConnectorInput } from './shared.ts';

/** Shared by the TestFlight tests. Everything runs against fakes: Apple is never contacted. */

export { ASC_SECRET, PLAY_SECRET };

export const CRASH_LOG = `Exception Type:  EXC_BAD_ACCESS (SIGSEGV)
Triggered by Thread:  0

Thread 0 Crashed:
0   Example                       \t0x0000000102abc123 -[SettingsViewController reload] + 84 (SettingsViewController.m:42)
1   UIKitCore                     \t0x00000001a1b2c3d4 -[UIViewController _sendViewDidLoad] + 100
`;

export const item = (over: Partial<StoreBetaFeedback> = {}): StoreBetaFeedback => ({
  id: 'f1',
  kind: 'feedback',
  createdAt: Date.UTC(2026, 10, 20, 9, 30),
  comment: 'The button does nothing',
  email: 'tester@example.com',
  buildId: 'b1',
  buildNumber: '42',
  version: '2.5.0',
  platform: 'IOS',
  bundleId: 'com.example.app',
  deviceModel: 'iPhone16,2',
  deviceFamily: 'IPHONE',
  osVersion: '18.1',
  locale: 'fr_FR',
  timeZone: 'Europe/Paris',
  architecture: 'arm64e',
  connectionType: 'WIFI',
  pairedWatch: null,
  appUptimeMs: 61_000,
  diskFreeBytes: 12_000_000_000,
  diskTotalBytes: 128_000_000_000,
  batteryPercent: 80,
  screenWidth: 430,
  screenHeight: 932,
  screenshots: [{ width: 1290, height: 2796 }],
  ...over,
});

export const crash = (over: Partial<StoreBetaFeedback> = {}): StoreBetaFeedback =>
  item({
    id: 'c1',
    kind: 'crash',
    comment: 'It crashed',
    screenshots: [],
    createdAt: Date.UTC(2026, 10, 21, 9, 30),
    ...over,
  });

/** A store that lists feedback and crashes, and can be told how to fail. */
export class FakeTestflightStore implements StoreTestFlightFeedbackConnector {
  readonly store = 'appstoreconnect' as const;
  items: StoreBetaFeedback[] = [
    item(),
    item({ id: 'f2', email: null, buildNumber: '43', createdAt: Date.UTC(2026, 10, 19) }),
    crash(),
  ];
  warnings: string[] = [];
  complete = true;
  /** Crash logs by Apple id; an id without an entry has none (null). */
  logs = new Map<string, string | null>([['c1', CRASH_LOG]]);
  logErrors = new Map<string, unknown>();
  screenshots: BetaScreenshotLink[] = [
    {
      url: 'https://example.invalid/shot.png?token=SECRET-LINK',
      width: 10,
      height: 20,
      expiresAt: Date.UTC(2026, 10, 22, 13),
    },
  ];
  listError: unknown;
  reads = 0;
  logReads: string[] = [];
  gate: Promise<void> | undefined;

  async listFeedback(): Promise<ListBetaFeedbackResult> {
    this.reads++;
    if (this.gate) await this.gate;
    if (this.listError) throw this.listError;
    return structuredClone({
      items: this.items,
      complete: this.complete,
      warnings: this.warnings,
      feedbackRead: true,
      crashesRead: true,
    });
  }
  async readCrashLog(id: string): Promise<string | null> {
    this.logReads.push(id);
    const error = this.logErrors.get(id);
    if (error) throw error;
    return this.logs.get(id) ?? null;
  }
  async readScreenshots(): Promise<BetaScreenshotLink[]> {
    this.reads++;
    return structuredClone(this.screenshots);
  }
}

export async function bootTestflight(
  db: Database,
  deps: TestflightDeps = {},
  overrides: NonNullable<Parameters<typeof bootRepoApp>[2]> = {},
) {
  const store = new FakeTestflightStore();
  const built: TestflightConnectorInput[] = [];
  const pick = (input: TestflightConnectorInput) => {
    built.push(input);
    return input.kind === 'app_store_connect' ? store : null;
  };
  const t = await bootRepoApp(db, undefined, {
    masterKey: randomBytes(32),
    ...overrides,
    testflight: { ...deps, read: { connectorFactory: pick, ...deps.read } },
  });
  const iosCredential = await t.addCredential('app_store_connect', ASC_SECRET);
  const playCredential = await t.addCredential('google_play', PLAY_SECRET);
  let appCount = 0;
  const addApp = async (platform: Platform, name?: string) => {
    appCount++;
    const res = await t.call(t.owner, 'POST', '/apps', {
      platform,
      identifier: `com.acme.app${appCount}`,
      credentialId: platform === 'android' ? playCredential : iosCredential,
      name: name ?? `App ${appCount}`,
    });
    const id = res.body.app.id as string;
    if (platform !== 'android')
      await db.execute('UPDATE apps SET store_app_id = ? WHERE id = ?', ['1234567890', id]);
    return id;
  };
  const path = (appId: string, rest = '') => `/apps/${appId}/testflight${rest}`;
  const sync = (appId: string, cookie = t.owner) => t.call(cookie, 'POST', path(appId, '/sync'));
  const list = (appId: string, query = '', cookie = t.owner) =>
    t.call(cookie, 'GET', path(appId, query ? `?${query}` : ''));
  const events = async (type: string) =>
    (await db.query('SELECT payload FROM events WHERE type = ? ORDER BY id', [type])).map(
      (r) => JSON.parse(String(r.payload)) as Record<string, unknown>,
    );
  const audit = async (like = 'testflight.%') =>
    (
      await db.query(
        'SELECT action, actor_type, detail FROM audit_events WHERE action LIKE ? ORDER BY created_at',
        [like],
      )
    ).map((r) => ({
      action: String(r.action),
      actorType: String(r.actor_type),
      detail: JSON.parse(String(r.detail ?? '{}')) as Record<string, unknown>,
    }));
  return {
    ...t,
    store,
    built,
    addApp,
    path,
    sync,
    list,
    events,
    audit,
    iosCredential,
    playCredential,
  };
}
export type TestflightBoot = Awaited<ReturnType<typeof bootTestflight>>;
