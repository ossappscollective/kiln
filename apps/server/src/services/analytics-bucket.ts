import { AnalyticsError } from '@mrm/connectors';
import {
  type ActorType,
  type PlayBucketSource,
  type PlayBucketTestCode,
  isApplePlatform,
  normalizeBucketId,
  playBucketTestMessages,
} from '@mrm/core';
import type { Database, Sql } from '@mrm/db';
import { type AnalyticsContext, classifyAnalyticsError } from './analytics-sync.ts';
import { resolvePlayBucket } from './analytics-store.ts';
import { getApp } from './apps.ts';
import type { ManagedApp } from './apps.ts';
import { recordAudit } from './audit.ts';
import { useCredentialSecret } from './credentials.ts';
import { type Failure, failure } from './repositories.ts';
import { getSettings } from './workspace-settings.ts';

/**
 * The Google Play reports bucket (docs/api/analytics.md, docs/research/analytics-apis.md). Google keeps ONE private Cloud Storage bucket
 * per Play developer account and organises the reports inside by package name. A workspace can hold apps of SEVERAL Play accounts, so
 * the id is per app, with defaults. Three places can hold it, the narrowest wins:
 *   1. the app (`analytics_app_config.play_bucket_id`, an override),
 *   2. the Play credential (`analytics_credential_config`, the developer account),
 *   3. the workspace setting `analytics.playBucketId` (the older, workspace-wide way).
 * The id is not a secret (it is a name), but it is never written to the audit log: the entries hold ids and what was done.
 */

type Actor = { type: ActorType; id: string };

export type PlayBucketView = {
  /** The bucket the app reads now, normalised (no `gs://`), or null. */
  bucketId: string | null;
  source: PlayBucketSource | null;
  /** What each place holds (null: nothing). */
  app: string | null;
  account: string | null;
  workspace: string | null;
  /** What the app reads when it has no override of its own (its Play credential's bucket, else the workspace default). */
  inherited: { bucketId: string | null; source: PlayBucketSource | null };
  credentialId: string;
  /** How many Android apps of the workspace use the same Play credential (they share `account`). */
  sharedWith: number;
};

export async function getPlayBucket(db: Database, workspaceId: string, app: ManagedApp): Promise<PlayBucketView> {
  const settings = (await getSettings(db, workspaceId)).values;
  const found = await resolvePlayBucket(db, { workspaceId, app, settings });
  const [count] = await db.query("SELECT COUNT(*) AS n FROM apps WHERE workspace_id = ? AND credential_id = ? AND platform = 'android'", [workspaceId, app.credentialId]);
  return { ...found, credentialId: app.credentialId, sharedWith: Number(count?.n ?? 0) };
}

export type SetBucketInput = {
  workspaceId: string;
  appId: string;
  /** The bucket as pasted (`gs://pubsite_prod_rev_…/` or the bare id), or null to clear. */
  bucket: string | null;
  /** `app`: only this app (an override; null falls back to the credential or workspace default). `account`: the Play credential, shared by its Android apps. */
  scope: 'account' | 'app';
};

const notAndroid = () => failure(422, 'not_an_android_app', 'The Play reports bucket is for Android apps.');

export async function setPlayBucket(db: Database, now: () => number, input: SetBucketInput, actor: Actor): Promise<{ ok: true; view: PlayBucketView } | Failure> {
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  if (isApplePlatform(app.platform)) return notAndroid();
  const id = input.bucket === null ? null : normalizeBucketId(input.bucket);
  if (input.bucket !== null && id === undefined) return failure(422, 'bucket_invalid', playBucketTestMessages.bucket_invalid);
  const at = now();
  await db.transaction(async (tx) => {
    if (input.scope === 'app') {
      await tx.execute(
        `INSERT INTO analytics_app_config (app_id, workspace_id, apple_mode, play_bucket_id, updated_by, updated_at) VALUES (?, ?, 'off', ?, ?, ?)
         ON CONFLICT (app_id) DO UPDATE SET play_bucket_id = excluded.play_bucket_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        [app.id, input.workspaceId, id ?? null, actor.id, at],
      );
    } else {
      await tx.execute(
        `INSERT INTO analytics_credential_config (credential_id, workspace_id, play_bucket_id, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (credential_id) DO UPDATE SET play_bucket_id = excluded.play_bucket_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        [app.credentialId, input.workspaceId, id ?? null, actor.id, at],
      );
    }
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'analytics.play_bucket_set',
      target: { type: 'app', id: app.id },
      // Ids and what was done. The bucket id itself is not written to the log.
      detail: { appId: app.id, credentialId: app.credentialId, scope: input.scope, cleared: id === null },
      at,
    });
  });
  return { ok: true, view: await getPlayBucket(db, input.workspaceId, app) };
}

export type BucketTestResult = { ok: boolean; code: PlayBucketTestCode; message: string; months: string[] };

const monthOf = (ms: number, back: number): string => {
  const d = new Date(ms);
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1));
  return `${m.getUTCFullYear()}${String(m.getUTCMonth() + 1).padStart(2, '0')}`;
};

const done = (code: PlayBucketTestCode, months: string[] = []): BucketTestResult => ({
  ok: code === 'ok' || code === 'no_reports_yet',
  code,
  message: playBucketTestMessages[code],
  months,
});

/**
 * "Test the bucket": reads the file LIST of the current and the previous month for this app, once (no file is stored). The answer is a
 * code of a fixed vocabulary; nothing Google said is passed on. `bucket` tests a pasted value before it is saved.
 */
export async function testPlayBucket(
  ctx: AnalyticsContext,
  input: { workspaceId: string; appId: string; bucket?: string },
  actor: Actor,
): Promise<{ ok: true; result: BucketTestResult } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  if (isApplePlatform(app.platform)) return notAndroid();
  let bucketId: string | null;
  if (input.bucket !== undefined) {
    bucketId = normalizeBucketId(input.bucket) ?? null;
    if (bucketId === null) return { ok: true, result: done('bucket_invalid') };
  } else {
    bucketId = (await getPlayBucket(ctx.db, input.workspaceId, app)).bucketId;
    if (bucketId === null) return { ok: true, result: done('not_set') };
  }
  let secret: string | undefined;
  try {
    secret = await useCredentialSecret(ctx.db, ctx.masterKey, { workspaceId: input.workspaceId, id: app.credentialId, purpose: 'analytics.bucket_test' }, actor, ctx.now());
  } catch {
    return { ok: true, result: done('credential_problem') };
  }
  if (secret === undefined) return { ok: true, result: done('credential_problem') };
  const months = [monthOf(ctx.now(), 1), monthOf(ctx.now(), 0)];
  try {
    const port = ctx.connectors.playReports({ secret, packageName: app.identifier, bucketId, fetch: globalThis.fetch });
    let found = 0;
    for (const month of months) {
      try {
        found += (await port.readMonth(month)).files.length;
      } catch (error) {
        if (error instanceof AnalyticsError && error.code === 'reports_not_found') continue;
        throw error;
      }
    }
    if (found === 0 && port.hasPackage && !(await port.hasPackage())) return { ok: true, result: done('package_not_found', months) };
    return { ok: true, result: done(found > 0 ? 'ok' : 'no_reports_yet', months) };
  } catch (error) {
    const code = error instanceof AnalyticsError ? error.code : classifyAnalyticsError(error).code;
    switch (code) {
      case 'bucket_forbidden':
      case 'store_forbidden':
        return { ok: true, result: done('bucket_forbidden') };
      case 'bucket_not_found':
      case 'store_not_found':
        return { ok: true, result: done('bucket_not_found') };
      case 'package_not_in_bucket':
        return { ok: true, result: done('package_not_found') };
      case 'bucket_invalid':
      case 'bucket_missing':
        return { ok: true, result: done('bucket_invalid') };
      case 'store_auth':
        return { ok: true, result: done('credential_problem') };
      default:
        return { ok: true, result: done('unreachable') };
    }
  }
}
