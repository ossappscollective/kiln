import { randomBytes } from 'node:crypto';
import {
  type AppleRolloutState,
  type PlayRolloutState,
  planAppleRollout,
  planPlayRollout,
  type RolloutApplyInput,
  type RolloutApplyResult,
  RolloutDriftError,
  RolloutOutcomeUnknownError,
  type RolloutState,
  type RolloutTarget,
  StoreError,
  type StoreRolloutConnector,
} from '@mrm/connectors';
import type { Platform } from '@mrm/core';
import type { Database } from '@mrm/db';
import { ASC_SECRET, PLAY_SECRET } from '../reviews/test-helpers.ts';
import { bootRepoApp } from '../../repo-test-helpers.ts';
import type { RolloutConnectorFactory, RolloutConnectorInput } from './store-rollout.ts';

/** Shared by the rollout tests. Everything runs against fakes: no store is ever contacted. */

export { ASC_SECRET, PLAY_SECRET };
export const PLAY_TARGET = { track: 'production', versionCodes: ['240'] };
export const IOS_TARGET = { version: '2.4.0' };

export const playState = (over: Partial<PlayRolloutState> = {}): PlayRolloutState => ({
  store: 'googleplay',
  platform: 'android',
  track: 'production',
  versionCodes: ['240'],
  name: '2.4.0',
  status: 'inProgress',
  userFraction: 0.1,
  otherReleases: 1,
  ...over,
});
export const appleState = (over: Partial<AppleRolloutState> = {}): AppleRolloutState => ({
  store: 'appstoreconnect',
  platform: 'ios',
  version: '2.4.0',
  storeVersionId: 'v-240',
  versionState: 'READY_FOR_DISTRIBUTION',
  phasedReleaseId: 'pr-1',
  phasedReleaseState: 'ACTIVE',
  currentDayNumber: 3,
  startDate: 1_700_000_000_000,
  totalPauseDays: 0,
  ...over,
});

export type WriteBehavior =
  | { kind: 'ok' }
  | { kind: 'refuse'; error: StoreError }
  /** The write is sent and the store does not answer; `applied` says whether it applied it anyway. */
  | { kind: 'unknown'; applied: boolean };

/** A store with one release or version, that can be read and changed, remembers every write, and can be told how to fail. */
export class FakeRolloutStore implements StoreRolloutConnector {
  readonly store: 'appstoreconnect' | 'googleplay';
  readonly platform: Platform;
  state: RolloutState;
  behavior: WriteBehavior = { kind: 'ok' };
  readError: unknown;
  /** After a write attempt the store cannot be read (the read back fails). */
  readFailsAfterWrite = false;
  writes: RolloutApplyInput['change'][] = [];
  reads = 0;
  /** When set, a write waits for it after the guard accepted: lets a test hold a write in flight. */
  gate: Promise<void> | undefined;
  constructor(platform: Platform) {
    this.platform = platform;
    this.store = platform === 'ios' ? 'appstoreconnect' : 'googleplay';
    this.state = platform === 'ios' ? appleState() : playState();
  }
  async readState(_target: RolloutTarget): Promise<RolloutState> {
    this.reads++;
    if (this.readError) throw this.readError;
    return structuredClone(this.state);
  }
  async applyChange(input: RolloutApplyInput): Promise<RolloutApplyResult> {
    const current = structuredClone(this.state);
    if (!input.guard(current)) throw new RolloutDriftError(current);
    const plan =
      current.store === 'googleplay'
        ? planPlayRollout(current, input.change as Parameters<typeof planPlayRollout>[1])
        : planAppleRollout(current, input.change as Parameters<typeof planAppleRollout>[1]);
    if (!plan.ok) {
      throw new StoreError(this.store, 'invalid_input', plan.message);
    }
    this.writes.push(input.change);
    if (this.gate) await this.gate;
    const b = this.behavior;
    if (b.kind === 'refuse') throw b.error;
    if (b.kind === 'unknown') {
      if (b.applied) this.state = plan.proposed;
      if (this.readFailsAfterWrite) this.readError = new Error('down');
      throw new RolloutOutcomeUnknownError(this.store, 'timed out');
    }
    this.state = plan.proposed;
    return { before: current, after: structuredClone(plan.proposed) };
  }
}

type Deps = NonNullable<Parameters<typeof import('../../app.ts').createApp>[0]['rollout']>;

export async function bootRollout(db: Database, rollout: Deps = {}) {
  const stores = { ios: new FakeRolloutStore('ios'), android: new FakeRolloutStore('android') };
  const built: RolloutConnectorInput[] = [];
  const factory: RolloutConnectorFactory = (input) => {
    built.push(input);
    return input.kind === 'app_store_connect' ? stores.ios : stores.android;
  };
  const t = await bootRepoApp(db, undefined, {
    masterKey: randomBytes(32),
    rollout: { enabled: true, connectorFactory: factory, ...rollout },
  });
  const iosCredential = await t.addCredential('app_store_connect', ASC_SECRET);
  const playCredential = await t.addCredential('google_play', PLAY_SECRET);
  let appCount = 0;
  const addApp = async (platform: Platform, name?: string) => {
    appCount++;
    const res = await t.call(t.owner, 'POST', '/apps', {
      platform,
      identifier: `com.acme.app${appCount}`,
      credentialId: platform === 'ios' ? iosCredential : playCredential,
      name: name ?? `App ${appCount}`,
    });
    const id = res.body.app.id as string;
    if (platform === 'ios')
      await db.execute('UPDATE apps SET store_app_id = ? WHERE id = ?', ['1234567890', id]);
    return id;
  };
  const events = async (type?: string) =>
    (await t.call(t.owner, 'GET', `/events?since=0&limit=200${type ? `&type=${type}` : ''}`)).body
      .events as {
      type: string;
      payload: Record<string, unknown>;
    }[];
  const rp = (appId: string, rest: string) => `/apps/${appId}/rollout${rest}`;
  const preview = (appId: string, body: Record<string, unknown>, cookie = t.owner) =>
    t.call(cookie, 'POST', rp(appId, '/preview'), body);
  const apply = (
    appId: string,
    body: Record<string, unknown>,
    confirmHash: string,
    cookie = t.owner,
  ) => t.call(cookie, 'POST', rp(appId, '/apply'), { ...body, confirmHash });
  /** A preview followed by the apply of what it said, as a person would. */
  const previewHash = async (appId: string, body: Record<string, unknown>): Promise<string> => {
    const res = await preview(appId, body);
    if (res.status !== 200) throw new Error(`preview ${res.status}: ${res.text}`);
    return res.body.preview.confirmHash as string;
  };
  const audit = async (like = 'release.rollout_%') =>
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
  const claims = async () =>
    db.query('SELECT app_id, platform, status, action FROM store_rollout_claims');
  return {
    ...t,
    stores,
    built,
    addApp,
    events,
    rp,
    preview,
    apply,
    previewHash,
    audit,
    claims,
    iosCredential,
    playCredential,
  };
}
export type RolloutBoot = Awaited<ReturnType<typeof bootRollout>>;
