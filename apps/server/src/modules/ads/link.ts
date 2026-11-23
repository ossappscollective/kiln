import { listAppleAdsAccounts, getAppleAdsAccount, type AdsAccount } from '@kiln/connectors';
import { type ActorType, listingStoreOf } from '@kiln/core';
import { type Database, nullableString, type Sql } from '@kiln/db';
import { coded } from '../../i18n/problem.ts';
import { getApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { type Failure, failure, type Outcome } from '../../services/repositories.ts';
import { adsClientFor, adsFailure } from './client.ts';
import type { AdsDeps } from './index.ts';

/**
 * The link between an app record and an Apple Ads ad account (docs/adr/0058-apple-ads.md, docs/api/apple-ads.md): which Apple Ads
 * credential reads it, which ad account, and the Apple id of the app whose campaigns are read. Saving it asks Apple Ads, with that
 * credential, whether the key may read the account, and stores what Apple said (id, name, currency, time zone), never what the person
 * typed. The key is read for that one call and never stored here.
 */
type Actor = { type: ActorType; id: string };

export const ADS_LINK_PURPOSE = 'ads.link';
export const ADS_ACCOUNTS_PURPOSE = 'ads.accounts';
export const ADAM_ID = /^[0-9]{5,15}$/;

export type AdsLinkView = {
  appId: string;
  credentialId: string;
  credentialLabel: string | null;
  /** The credential still exists and is an Apple Ads credential. */
  credentialAvailable: boolean;
  adAccountId: string;
  adAccountName: string;
  orgId: string | null;
  /** The account's currency: every amount of this app is in it. */
  currency: string | null;
  timezone: string | null;
  /** The Apple id of the promoted app. */
  adamId: string;
  verifiedAt: number;
  linkedBy: string;
  createdAt: number;
  updatedAt: number;
};

const SELECT = `SELECT l.app_id, l.credential_id, l.ad_account_id, l.ad_account_name, l.org_id, l.currency, l.timezone, l.adam_id,
                       l.verified_at, l.linked_by, l.created_at, l.updated_at, c.label AS credential_label, c.kind AS credential_kind
                  FROM app_ads_links l
                  LEFT JOIN credentials c ON c.id = l.credential_id AND c.workspace_id = l.workspace_id`;

const toView = (r: Record<string, unknown>): AdsLinkView => ({
  appId: String(r.app_id),
  credentialId: String(r.credential_id),
  credentialLabel: nullableString(r.credential_label),
  credentialAvailable: nullableString(r.credential_kind) === 'apple_ads',
  adAccountId: String(r.ad_account_id),
  adAccountName: String(r.ad_account_name),
  orgId: nullableString(r.org_id),
  currency: nullableString(r.currency),
  timezone: nullableString(r.timezone),
  adamId: String(r.adam_id),
  verifiedAt: Number(r.verified_at),
  linkedBy: String(r.linked_by),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

/** The link of an app record, or null. Database only: Apple is not called. */
export async function getAdsLink(sql: Sql, workspaceId: string, appId: string): Promise<AdsLinkView | null> {
  const [row] = await sql.query(`${SELECT} WHERE l.app_id = ? AND l.workspace_id = ?`, [appId, workspaceId]);
  return row ? toView(row) : null;
}

/** Deletes the stored Apple Ads data of an app record: its link was removed or now names another account or app. */
export async function clearAdsData(sql: Sql, workspaceId: string, appId: string): Promise<void> {
  for (const table of ['ads_campaign_daily', 'ads_term_daily', 'ads_sync']) {
    await sql.execute(`DELETE FROM ${table} WHERE app_id = ? AND workspace_id = ?`, [appId, workspaceId]);
  }
}

export const notSupportedFailure = (): Failure =>
  failure(422, 'ads_not_supported', 'Apple Ads is for App Store apps. This app is not one.', coded('ads.notSupported'));

export type AdsLinkContext = { db: Database; masterKey: Buffer; now: () => number; deps: AdsDeps | undefined };

/** The ad accounts a credential may read (a read of Apple Ads, audited as `credential.use`, purpose `ads.accounts`). */
export async function readAdAccounts(
  ctx: AdsLinkContext,
  input: { workspaceId: string; appId: string; credentialId: string },
  actor: Actor,
): Promise<Outcome<{ accounts: AdsAccount[] }>> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  if (listingStoreOf(app.platform) !== 'app_store') return notSupportedFailure();
  const opened = await adsClientFor(ctx.db, ctx.masterKey, input.workspaceId, input.credentialId, ctx.deps, {
    actor,
    purpose: ADS_ACCOUNTS_PURPOSE,
    now: ctx.now(),
  });
  if (!opened.ok) return opened;
  try {
    const accounts = await listAppleAdsAccounts(opened.client);
    return { ok: true, accounts };
  } catch (error) {
    return adsFailure(error, opened.secret);
  }
}

export type SetAdsLinkInput = { workspaceId: string; appId: string; credentialId: string; adAccountId: string; adamId?: string | undefined };

/** Saves (or replaces) the link. The account is confirmed with Apple Ads first. Audited as `ads.link_set` (ids, never a key). */
export async function setAdsLink(ctx: AdsLinkContext, input: SetAdsLinkInput, actor: Actor): Promise<Outcome<{ link: AdsLinkView }>> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  if (listingStoreOf(app.platform) !== 'app_store') return notSupportedFailure();
  const adamId = (input.adamId ?? app.storeAppId ?? '').trim();
  if (!ADAM_ID.test(adamId)) {
    return failure(
      422,
      'ads_adam_required',
      "Enter the Apple id of the app (the number in its App Store address, after id). It is the app's store id, which this record does not have yet.",
      coded('ads.adamRequired'),
    );
  }
  const opened = await adsClientFor(ctx.db, ctx.masterKey, input.workspaceId, input.credentialId, ctx.deps, {
    actor,
    purpose: ADS_LINK_PURPOSE,
    now: ctx.now(),
  });
  if (!opened.ok) return opened;
  let detail: Awaited<ReturnType<typeof getAppleAdsAccount>>;
  let orgId: string | null;
  try {
    const accounts = await listAppleAdsAccounts(opened.client);
    const found = accounts.find((a) => a.id === input.adAccountId);
    if (!found) {
      return failure(422, 'ads_account_missing', 'That ad account is not one the key can read. Choose one from the list.', coded('ads.accountMissing'));
    }
    orgId = found.orgId;
    detail = await getAppleAdsAccount(opened.client, found.id);
  } catch (error) {
    return adsFailure(error, opened.secret);
  }
  const at = ctx.now();
  await ctx.db.transaction(async (tx) => {
    const [before] = await tx.query('SELECT ad_account_id, adam_id FROM app_ads_links WHERE app_id = ? AND workspace_id = ?', [app.id, input.workspaceId]);
    await tx.execute(
      `INSERT INTO app_ads_links
         (app_id, workspace_id, credential_id, ad_account_id, ad_account_name, org_id, currency, timezone, adam_id, verified_at, linked_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (app_id) DO UPDATE SET
         credential_id = excluded.credential_id, ad_account_id = excluded.ad_account_id, ad_account_name = excluded.ad_account_name,
         org_id = excluded.org_id, currency = excluded.currency, timezone = excluded.timezone, adam_id = excluded.adam_id,
         verified_at = excluded.verified_at, linked_by = excluded.linked_by, updated_at = excluded.updated_at`,
      [app.id, input.workspaceId, input.credentialId, detail.id, detail.name, orgId, detail.currency, detail.timezone, adamId, at, actor.id, at, at],
    );
    // Data read for another account or app is not this link's.
    if (before && (String(before.ad_account_id) !== detail.id || String(before.adam_id) !== adamId)) {
      await clearAdsData(tx, input.workspaceId, app.id);
    }
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'ads.link_set',
      target: { type: 'app', id: app.id },
      detail: { appId: app.id, credentialId: input.credentialId, adAccountId: detail.id, replaced: before !== undefined },
      at,
    });
  });
  const link = await getAdsLink(ctx.db, input.workspaceId, app.id);
  if (!link) return failure(404, 'not_found');
  return { ok: true, link };
}

/** Removes the link and the data read through it. Nothing at Apple is changed. False when the app had none. Audited as `ads.link_remove`. */
export async function removeAdsLink(ctx: Pick<AdsLinkContext, 'db' | 'now'>, input: { workspaceId: string; appId: string }, actor: Actor): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const [before] = await tx.query('SELECT ad_account_id FROM app_ads_links WHERE app_id = ? AND workspace_id = ?', [input.appId, input.workspaceId]);
    if (!before) return false;
    await tx.execute('DELETE FROM app_ads_links WHERE app_id = ? AND workspace_id = ?', [input.appId, input.workspaceId]);
    await clearAdsData(tx, input.workspaceId, input.appId);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'ads.link_remove',
      target: { type: 'app', id: input.appId },
      detail: { appId: input.appId, adAccountId: String(before.ad_account_id) },
      at: ctx.now(),
    });
    return true;
  });
}
