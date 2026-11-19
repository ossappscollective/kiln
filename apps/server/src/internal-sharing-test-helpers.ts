import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { type CiArtifact, type CiArtifactDownload, type CiArtifactList, type InternalSharingConnector, type InternalSharingKind } from '@mrm/connectors';
import type { Database } from '@mrm/db';
import { zip } from '../../../packages/connectors/src/play-search-terms.fixtures.ts';
import { bootCi, FakeCi, run } from './ci-test-helpers.ts';
import { PLAY_SECRET } from './review-test-helpers.ts';
import { clearBuildCaches } from './services/builds.ts';
import { PASSWORD } from './testkit.ts';

/** A fake GitHub, a fake artifact storage and a fake Google for the internal app sharing tests. Not a test file. */

export class FakeBuildsCi extends FakeCi {
  artifacts: CiArtifact[] = [];
  storage = new Map<string, CiArtifactDownload>();
  async listArtifacts(): Promise<CiArtifactList> {
    this.calls.push({ name: 'listArtifacts', args: [] });
    return { artifacts: this.artifacts, truncated: false, notModified: false };
  }
  async openArtifactDownload(id: string): Promise<CiArtifactDownload> {
    this.calls.push({ name: 'openArtifactDownload', args: [id] });
    return this.storage.get(id) ?? { status: 'missing' };
  }
}

export const LINK = 'https://play.google.com/apps/test/com.acme.android/241?SECRETLINKTOKEN=abc123';
export const T0 = 1_900_000_000_000;
export const DAY = 24 * 60 * 60_000;
export const START = Date.now();
export const AAB = new Uint8Array(Array.from({ length: 300 }, (_, i) => (i * 7) % 251));
export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
export const art = (id: string, name: string, extra: Partial<CiArtifact> = {}): CiArtifact => ({
  id, name, sizeInBytes: 1000, expired: false, createdAt: T0 - Number(id), expiresAt: T0 + 30 * DAY, runId: '102', headBranch: 'main', headSha: '1'.repeat(40), digest: `sha256:${'d'.repeat(64)}`, ...extra,
});
export const streamOf = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });

export type Upload = { kind: InternalSharingKind; size: number; sha: string };
export class FakeGoogle implements InternalSharingConnector {
  readonly store = 'googleplay' as const;
  packageName = '';
  uploads: Upload[] = [];
  /** What the next upload does instead of answering: throw, wait, or answer something else. */
  next: (() => Promise<{ downloadUrl: string; certificateFingerprint: string | null; sha256: string | null }>) | undefined;
  async upload(kind: InternalSharingKind, bytes: Uint8Array) {
    this.uploads.push({ kind, size: bytes.byteLength, sha: sha256(bytes) });
    if (this.next) return this.next();
    return { downloadUrl: LINK, certificateFingerprint: 'AA:BB:CC', sha256: sha256(bytes) };
  }
}

export async function bootSharing(db: Database, settings: Record<string, unknown> = {}) {
  clearBuildCaches();
  const fake = new FakeBuildsCi();
  const google = new FakeGoogle();
  const built: { packageName: string; hasSecret: boolean }[] = [];
  const clock = { now: START };
  const t = await bootCi(db, {}, {
    now: () => clock.now,
    connectorFactory: () => fake,
    builds: {
      downloadEnabled: false,
      internalSharingEnabled: true,
      allowHttpRedirects: true,
      internalSharingConnectorFactory: (input) => {
        built.push({ packageName: input.packageName, hasSecret: input.secret.includes('client_email') });
        google.packageName = input.packageName;
        return google;
      },
      ...settings,
    },
  });
  fake.runs = [run('101', { name: 'iOS release' }), run('102', { name: 'Android release' })];
  await t.call(t.owner, 'GET', `${t.base}/workflows/runs?refresh=true`);
  const play = await t.addCredential('google_play', PLAY_SECRET);
  const appId = await t.seedApp('android', [{ version: '2.4.0', build: '240' }], { identifier: 'com.acme.android' });
  await db.execute('UPDATE apps SET credential_id = ? WHERE id = ?', [play, appId]);
  const send = async (cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await t.app.request(`/api/workspaces/${t.workspaceId}${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    // biome-ignore lint/suspicious/noExplicitAny: test responses are inspected loosely
    return { status: res.status, headers: res.headers, text, body: (text ? JSON.parse(text) : null) as any };
  };
  const base = (id = appId, artifact = '1') => `/apps/${id}/builds/artifacts/${artifact}/internal-share`;
  /** An artifact that holds the given files in a zip, served by the fake storage. */
  const serve = (id: string, files = [{ name: 'app-release.aab', data: AAB }], extra: Partial<CiArtifact> = {}) => {
    const archive = zip(files);
    fake.artifacts = [...fake.artifacts.filter((a) => a.id !== id), art(id, 'android-release', { sizeInBytes: archive.length, ...extra })];
    clearBuildCaches(); // the artifact list is kept 30 seconds; a test changes it at once
    fake.storage.set(id, { status: 'ok', body: streamOf(archive), contentLength: archive.length });
  };
  const preview = (id = '1', body: unknown = {}, cookie = t.owner) => send(cookie, 'POST', `${base(appId, id)}/preview`, body);
  const apply = (id: string, over: Record<string, unknown>, cookie = t.owner, headers: Record<string, string> = {}) => send(cookie, 'POST', base(appId, id), over, headers);
  /** Preview, then apply with what the preview said. */
  const share = async (id = '1', over: Record<string, unknown> = {}, cookie = t.owner, headers: Record<string, string> = {}, entry?: string) => {
    const p = await preview(id, entry ? { entry } : {}, cookie);
    assert.equal(p.status, 200, p.text);
    return { preview: p, res: await apply(id, { confirmHash: p.body.preview.confirmHash, confirmation: p.body.preview.confirmation.phrase, ...(entry ? { entry } : {}), ...over }, cookie, headers) };
  };
  const grantFor = async (action: string, target: { id?: string; hash?: string }) => {
    const res = await send(t.owner, 'POST', '/step-up/verify', { factor: 'password', action, target, password: PASSWORD });
    assert.equal(res.status, 200, res.text);
    return res.body.grant as string;
  };
  const audit = async () => (await db.query('SELECT action, detail FROM audit_events ORDER BY created_at, id')).map((r) => ({ action: String(r.action), detail: String(r.detail ?? '') }));
  const events = async () => JSON.stringify(await db.query('SELECT type, payload FROM events'));
  const claim = async () => (await db.query('SELECT status FROM play_internal_share_claims WHERE app_id = ?', [appId]))[0];
  return { ...t, fake, google, built, clock, play, appId, send, base, serve, preview, apply, share, grantFor, audit, events, claim };
}

export type SharingBoot = Awaited<ReturnType<typeof bootSharing>>;
