import { AnalyticsError } from '@kiln/connectors';
import {
  type AccessTestCode,
  type AccessTestSource,
  type ActorType,
  addDays,
  analyticsErrorMessages,
  normalizeVendorNumber,
  sourcesForPlatform,
} from '@kiln/core';
import type { Database } from '@kiln/db';
import { getApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { serviceAccountEmail, useCredentialSecret } from '../../services/credentials.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { getSettings } from '../../services/workspace-settings.ts';
import { resolveAppleVendor, resolvePlayBucket, setCredentialVendor } from './store.ts';
import { type AnalyticsContext, classifyAnalyticsError, pacificDay } from './sync.ts';

/**
 * Per-credential setup of the Sales and financial sources, and "Test access": ONE cheap call per source that answers with the classified
 * reason, so a person sees what is missing without waiting for a sync (docs/api/analytics.md). Nothing is stored by the test; the vendor
 * number is a number App Store Connect shows (not a secret) and is never written to the audit log.
 */

type Actor = { type: ActorType; id: string };

/** Sets (or, with null, clears) the vendor number of the App Store Connect credential of an iOS or macOS app. */
export async function setAppleVendorNumber(
  db: Database,
  now: () => number,
  input: { workspaceId: string; appId: string; vendorNumber: string | null },
  actor: Actor,
): Promise<{ ok: true; vendorNumber: string | null } | Failure> {
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  if (app.platform === 'android')
    return failure(422, 'not_apple_app', 'The vendor number is for iOS and macOS apps.');
  const number = input.vendorNumber === null ? null : normalizeVendorNumber(input.vendorNumber);
  if (input.vendorNumber !== null && number === undefined)
    return failure(422, 'vendor_number_invalid', analyticsErrorMessages.vendor_number_invalid);
  const at = now();
  await db.transaction(async (tx) => {
    await setCredentialVendor(tx, {
      workspaceId: input.workspaceId,
      credentialId: app.credentialId,
      vendorNumber: number ?? null,
      by: actor.id,
      now: at,
    });
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'analytics.vendor_number_set',
      target: { type: 'app', id: app.id },
      detail: { appId: app.id, credentialId: app.credentialId, cleared: number === null },
      at,
    });
  });
  return { ok: true, vendorNumber: number ?? null };
}

export type AccessTestResult = {
  source: AccessTestSource;
  ok: boolean;
  code: AccessTestCode;
  message: string;
  /** Google: the address to invite in Play Console (the service account's `client_email`, not a secret). */
  serviceAccountEmail?: string;
};

const okMessages = {
  ok: 'The store answered: access works.',
  no_report_yet:
    'The store answered and access works. It has no file for the day or month asked yet, which is normal for a new app or a new period.',
} as const;

const done = (
  source: AccessTestSource,
  code: AccessTestCode,
  email?: string,
): { ok: true; result: AccessTestResult } => ({
  ok: true,
  result: {
    source,
    ok: code === 'ok' || code === 'no_report_yet',
    code,
    message:
      code === 'ok' || code === 'no_report_yet'
        ? okMessages[code]
        : (analyticsErrorMessages[code] ?? analyticsErrorMessages.sync_failed),
    ...(email ? { serviceAccountEmail: email } : {}),
  },
});

export async function testSourceAccess(
  ctx: AnalyticsContext,
  input: { workspaceId: string; appId: string; source: AccessTestSource },
  actor: Actor,
): Promise<{ ok: true; result: AccessTestResult } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  if (!(sourcesForPlatform(app.platform) as string[]).includes(input.source))
    return failure(422, 'source_not_for_platform', 'This source does not exist for this platform.');
  const settings = (await getSettings(ctx.db, input.workspaceId)).values;
  const google = app.platform === 'android';
  const email = google
    ? await serviceAccountEmail(ctx.db, ctx.masterKey, {
        workspaceId: input.workspaceId,
        id: app.credentialId,
      })
    : undefined;
  const bucketId = google
    ? (await resolvePlayBucket(ctx.db, { workspaceId: input.workspaceId, app, settings })).bucketId
    : null;
  const vendorNumber = google
    ? ''
    : (await resolveAppleVendor(ctx.db, { workspaceId: input.workspaceId, app, settings }))
        .vendorNumber;
  if (google && bucketId === null) return done(input.source, 'bucket_missing', email);
  if (!google && vendorNumber === '') return done(input.source, 'vendor_number_missing');
  let secret: string | undefined;
  try {
    secret = await useCredentialSecret(
      ctx.db,
      ctx.masterKey,
      { workspaceId: input.workspaceId, id: app.credentialId, purpose: 'analytics.access_test' },
      actor,
      ctx.now(),
    );
  } catch {
    return done(input.source, 'credential_unreadable', email);
  }
  if (secret === undefined) return done(input.source, 'credential_not_found', email);
  const month = (() => {
    const d = new Date(ctx.now());
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  })();
  try {
    switch (input.source) {
      case 'apple_sales':
      case 'apple_subscriptions': {
        const port = ctx.connectors.apple({ secret, fetch: globalThis.fetch });
        // Two days back in Pacific Time: a day Apple has surely finished.
        const date = addDays(pacificDay(ctx.now()), -2);
        const text =
          input.source === 'apple_sales'
            ? await port.fetchSalesReport({ vendorNumber, date })
            : await port.fetchSubscriptionReport({ kind: 'subscription', vendorNumber, date });
        return done(input.source, text === null ? 'no_report_yet' : 'ok');
      }
      default: {
        const wanted = {
          secret,
          packageName: app.identifier,
          bucketId: bucketId as string,
          fetch: globalThis.fetch,
        };
        const port =
          input.source === 'play_reports'
            ? ctx.connectors.playReports(wanted)
            : input.source === 'play_sales'
              ? ctx.connectors.playSales(wanted)
              : input.source === 'play_earnings'
                ? ctx.connectors.playEarnings(wanted)
                : ctx.connectors.playSubscriptions(wanted);
        if (port.checkAccess) await port.checkAccess();
        else await (port as { readMonth(m: string): Promise<unknown> }).readMonth(month);
        return done(input.source, 'ok', email);
      }
    }
  } catch (error) {
    if (error instanceof AnalyticsError && error.code === 'reports_not_found')
      return done(input.source, 'no_report_yet', email);
    const code = error instanceof AnalyticsError ? error.code : classifyAnalyticsError(error).code;
    return done(input.source, code, email);
  }
}
