import { randomBytes } from 'node:crypto';
import type {
  ListExperimentsResult,
  StoreCustomPage,
  StoreExperiment,
  StoreExperimentsConnector,
} from '@kiln/connectors';
import type { Platform } from '@kiln/core';
import type { Database } from '@kiln/db';
import { bootRepoApp } from '../../repo-test-helpers.ts';
import { ASC_SECRET, PLAY_SECRET } from '../reviews/test-helpers.ts';
import type { ExperimentsDeps } from './index.ts';
import type { ExperimentsConnectorInput } from './shared.ts';

/** Shared by the experiments tests. Everything runs against fakes: no store is ever contacted. */

export { ASC_SECRET, PLAY_SECRET };

const locale = (code: string, screenshots = 0, promo: boolean | null = null) => ({
  locale: code,
  ref: `loc-${code}`,
  assets: { screenshots, previews: 0, other: 0, screenshotSets: 0 },
  hasPromotionalText: promo,
});

export const experiment = (over: Partial<StoreExperiment> = {}): StoreExperiment => ({
  id: 'e1',
  name: 'Icon test',
  platform: 'IOS',
  state: 'approved',
  rawState: 'APPROVED',
  trafficProportion: 30,
  reviewRequired: true,
  startedAt: Date.UTC(2026, 9, 1),
  endedAt: null,
  treatments: [
    { id: 't1', name: 'Blue icon', iconName: 'blue', promotedAt: null, locales: [locale('en-US', 3)] },
    { id: 't2', name: 'New shots', iconName: null, promotedAt: null, locales: [] },
  ],
  ...over,
});

export const customPage = (over: Partial<StoreCustomPage> = {}): StoreCustomPage => ({
  id: 'c1',
  name: 'Spring campaign',
  visible: true,
  url: 'https://apps.apple.com/app/id1234567890?ppid=c1',
  state: 'approved',
  rawState: 'APPROVED',
  deepLink: 'myapp://spring',
  versions: [{ id: 'v1', version: '1', state: 'approved', rawState: 'APPROVED', deepLink: 'myapp://spring' }],
  locales: [locale('en-US', 5, true), locale('fr-FR', 4, false)],
  ...over,
});

/** A store that lists experiments and pages, and can be told how to fail. */
export class FakeExperimentsStore implements StoreExperimentsConnector {
  readonly store = 'appstoreconnect' as const;
  result: ListExperimentsResult = {
    experiments: [experiment(), experiment({ id: 'e0', name: 'Old test', state: 'completed', rawState: 'COMPLETED', startedAt: Date.UTC(2026, 5, 1), endedAt: Date.UTC(2026, 8, 1) })],
    customPages: [customPage(), customPage({ id: 'c2', name: 'Autumn', state: 'in_review', rawState: 'IN_REVIEW', deepLink: null })],
    complete: true,
    warnings: [],
    experimentsRead: true,
    customPagesRead: true,
  };
  listError: unknown;
  reads = 0;
  /** When set, a list waits for it: lets a test make a sync time out. */
  gate: Promise<void> | undefined;

  async listExperiments(): Promise<ListExperimentsResult> {
    this.reads++;
    if (this.gate) await this.gate;
    if (this.listError) throw this.listError;
    return structuredClone(this.result);
  }
}

export async function bootExperiments(
  db: Database,
  deps: ExperimentsDeps = {},
  overrides: NonNullable<Parameters<typeof bootRepoApp>[2]> = {},
) {
  const store = new FakeExperimentsStore();
  const built: ExperimentsConnectorInput[] = [];
  const pick = (input: ExperimentsConnectorInput) => {
    built.push(input);
    return input.kind === 'app_store_connect' ? store : null;
  };
  const t = await bootRepoApp(db, undefined, {
    masterKey: randomBytes(32),
    ...overrides,
    experiments: { ...deps, read: { connectorFactory: pick, ...deps.read } },
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
  const path = (appId: string, rest = '') => `/apps/${appId}/experiments${rest}`;
  const sync = (appId: string, cookie = t.owner) => t.call(cookie, 'POST', path(appId, '/sync'));
  const list = (appId: string, cookie = t.owner) => t.call(cookie, 'GET', path(appId));
  const audit = async (like = 'experiments.%') =>
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
  return { ...t, store, built, addApp, path, sync, list, audit, iosCredential, playCredential };
}
export type ExperimentsBoot = Awaited<ReturnType<typeof bootExperiments>>;
