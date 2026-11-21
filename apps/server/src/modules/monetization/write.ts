import { createHash } from 'node:crypto';
import {
  cleanLocale,
  isStoreProductId,
  localizationHash,
  ProductLocaleMissingError,
  ProductLocalizationDriftError,
  ProductOutcomeUnknownError,
  type StoreProductLocalization,
  type StoreProductRef,
} from '@kiln/connectors';
import { supports } from '@kiln/core';
import type { Sql } from '@kiln/db';
import { getApp, type ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { storeFor } from '../reviews/sync.ts';
import {
  type Actor,
  type Connection,
  connect,
  DEFAULT_PRODUCT_CLAIM_TTL_MS,
  type MonetizationContext,
  mapStoreError,
  notSupportedFailure,
  PRODUCT_WRITE_PURPOSE,
  productWriteDisabledFailure,
  StoreTimeout,
  withConnector,
} from './shared.ts';
import { readStoredProductRef, storeLocalizationText } from './snapshot.ts';

/**
 * Changing the localized display name and description of ONE in-app purchase or subscription in ONE locale: the only store write of this feature,
 * written down in docs/adr/0034-in-app-products.md and docs/api/products.md. The design copies the store writes before it (ADR 0007, 0008, 0009):
 *
 * - Off unless `writeEnabled` (MRM_STORE_PRODUCT_WRITE_ENABLED, default false): preview and apply answer `409 store_product_write_disabled` and
 *   no connector is built. The route checks the role action `monetization.write` (owner and admin) before it looks at the switch.
 * - Preview reads the store's localization NOW and returns it with the proposed texts and `previewHash`, a SHA-256 over the app, the product,
 *   the locale, the texts that were read and the texts proposed. Apply needs that hash and the connector READS THE STORE AGAIN right before
 *   writing: if the texts are not the ones the person saw, nothing is written (`409 state_changed`, with the new preview).
 * - Only the display name and description of a locale the product already has. No price, availability, state, new locale or product is touched.
 * - One write in flight per app, decided by the database (`store_product_claims`), so it holds across processes. Never retried: after a lost
 *   answer the store is read back (the texts are there: success, `confirmedByReread`; not there or unreadable: `409 outcome_unknown`, which
 *   a successful preview clears).
 * - Audit (`monetization.localization_changed`, `monetization.localization_failed`) holds ids, the locale and hashes of the texts. Never a text,
 *   a credential, a token or a store response.
 */

export type LocalizationTexts = { name: string; description: string };

export type LocalizationPreview = {
  app: { id: string; name: string; platform: ManagedApp['platform']; store: string };
  product: { productId: string; kind: StoreProductRef['kind']; referenceName: string };
  /** The locale as the store writes it. */
  locale: string;
  current: LocalizationTexts;
  proposed: LocalizationTexts;
  changes: { name: boolean; description: boolean };
  /** True when the proposed texts are the ones the store has: there is nothing to apply. */
  unchanged: boolean;
  previewHash: string;
  warnings: string[];
  readAt: number;
};

export type LocalizationResult = {
  app: LocalizationPreview['app'];
  product: LocalizationPreview['product'];
  locale: string;
  before: LocalizationTexts;
  after: LocalizationTexts;
  changes: { name: boolean; description: boolean };
  confirmedByReread: boolean;
  appliedAt: number;
  note: string;
};

const NOTE =
  'The texts were changed in the store. Prices, availability and everything else of the product were not touched. A store may show a change in its console or in apps after a short delay.';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export const localizationPreviewHash = (input: {
  workspaceId: string;
  appId: string;
  store: string;
  productId: string;
  kind: string;
  locale: string;
  current: LocalizationTexts;
  proposed: LocalizationTexts;
}): string =>
  sha256(
    JSON.stringify([
      'product.localization.v1',
      input.workspaceId,
      input.appId,
      input.store,
      input.productId,
      input.kind,
      input.locale.toLowerCase(),
      localizationHash(input.current.name, input.current.description),
      localizationHash(input.proposed.name, input.proposed.description),
    ]),
  );

const textsOf = (l: StoreProductLocalization): LocalizationTexts => ({
  name: l.name,
  description: l.description,
});
const sameTexts = (a: LocalizationTexts, b: LocalizationTexts) =>
  a.name === b.name && a.description === b.description;
const changesOf = (from: LocalizationTexts, to: LocalizationTexts) => ({
  name: from.name !== to.name,
  description: from.description !== to.description,
});

/** Control characters other than a line break have no place in a display text; the stores would refuse or mangle them. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const MAX_NAME = 200;
const MAX_DESCRIPTION = 2000;

/** The texts as they are compared and sent: line breaks are `\n`, no space around. The stores' own length limits are theirs to enforce. */
export function cleanTexts(input: {
  name: string;
  description: string;
}): { ok: true; texts: LocalizationTexts } | Failure {
  const name = input.name.replace(/\r\n?/g, '\n').trim();
  const description = input.description.replace(/\r\n?/g, '\n').trim();
  if (name === '') return failure(422, 'invalid_text', 'The display name cannot be empty.');
  if (name.includes('\n'))
    return failure(
      422,
      'invalid_text',
      'The display name is one line: it cannot hold a line break.',
    );
  if (name.length > MAX_NAME)
    return failure(422, 'invalid_text', `The display name is at most ${MAX_NAME} characters.`);
  if (description.length > MAX_DESCRIPTION)
    return failure(
      422,
      'invalid_text',
      `The description is at most ${MAX_DESCRIPTION} characters.`,
    );
  if (CONTROL.test(name) || CONTROL.test(description))
    return failure(422, 'invalid_text', 'The texts cannot hold control characters.');
  return { ok: true, texts: { name, description } };
}

// ---------------------------------------------------------------------------------------------
// The claim: one write in flight per app

type Claim = { appId: string; at: number };

async function takeClaim(
  ctx: MonetizationContext,
  input: { workspaceId: string; app: ManagedApp; productId: string; actor: Actor },
): Promise<{ ok: true; claim: Claim } | Failure> {
  const { db } = ctx;
  const ttl = ctx.claimTtlMs || DEFAULT_PRODUCT_CLAIM_TTL_MS;
  const claim: Claim = { appId: input.app.id, at: ctx.now() };
  const busy = () =>
    failure(
      409,
      'write_in_progress',
      'A product text change for this app is in progress. Wait for it to finish.',
    );
  const insert = () =>
    db.execute(
      `INSERT INTO store_product_claims (app_id, workspace_id, product_id, status, claimed_by, claim_at)
       VALUES (?, ?, ?, 'writing', ?, ?) ON CONFLICT (app_id) DO NOTHING`,
      [claim.appId, input.workspaceId, input.productId, input.actor.id, claim.at],
    );
  if ((await insert()) === 1) return { ok: true, claim };
  const [existing] = await db.query(
    'SELECT status, claim_at FROM store_product_claims WHERE app_id = ?',
    [claim.appId],
  );
  if (!existing) return (await insert()) === 1 ? { ok: true, claim } : busy();
  if (String(existing.status) === 'unknown') {
    return failure(
      409,
      'outcome_unknown',
      'It is not known whether the last text change of this app reached the store. Preview the change again: that reads the store and shows where it stands. Nothing is changed until you confirm a new preview.',
    );
  }
  const startedAt = Number(existing.claim_at);
  if (claim.at - startedAt < ttl) return busy();
  // A write that started long ago and never finished (a process died): its outcome is unknown, so it is not trusted, but the re-read and the
  // hash refuse a change that no longer fits the store's texts.
  const taken = await db.execute(
    `UPDATE store_product_claims SET claim_at = ?, claimed_by = ?, product_id = ?, workspace_id = ?
      WHERE app_id = ? AND status = 'writing' AND claim_at = ?`,
    [claim.at, input.actor.id, input.productId, input.workspaceId, claim.appId, startedAt],
  );
  return taken === 1 ? { ok: true, claim } : busy();
}

const releaseClaim = (sql: Sql, claim: Claim) =>
  sql.execute(
    "DELETE FROM store_product_claims WHERE app_id = ? AND claim_at = ? AND status = 'writing'",
    [claim.appId, claim.at],
  );

const markUnknown = (sql: Sql, claim: Claim) =>
  sql.execute(
    "UPDATE store_product_claims SET status = 'unknown' WHERE app_id = ? AND claim_at = ? AND status = 'writing'",
    [claim.appId, claim.at],
  );

/** A successful read of the store settles an unknown outcome: the person sees where things stand. */
const clearUnknown = (sql: Sql, appId: string) =>
  sql.execute("DELETE FROM store_product_claims WHERE app_id = ? AND status = 'unknown'", [appId]);

// ---------------------------------------------------------------------------------------------
// Resolving the request

type Resolved = {
  app: ManagedApp;
  appView: LocalizationPreview['app'];
  ref: StoreProductRef;
  product: LocalizationPreview['product'];
  /** The locales the stored copy has, for a message. */
  locales: string[];
  locale: string;
  texts: LocalizationTexts;
};

async function resolve(
  ctx: MonetizationContext,
  input: {
    workspaceId: string;
    appId: string;
    productId: string;
    locale: string;
  } & LocalizationTexts,
): Promise<{ ok: true; resolved: Resolved } | Failure> {
  if (!ctx.writeEnabled) return productWriteDisabledFailure();
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  if (!supports(app.platform, 'inAppPurchases')) return notSupportedFailure();
  const locale = cleanLocale(input.locale);
  if (!locale)
    return failure(422, 'invalid_locale', 'Not a locale: use a tag such as en-US or de-DE.');
  if (!isStoreProductId(input.productId))
    return failure(404, 'product_not_found', 'No such product. Sync the app first.');
  const stored = await readStoredProductRef(ctx.db, input.workspaceId, app.id, input.productId);
  if (!stored) return failure(404, 'product_not_found', 'No such product. Sync the app first.');
  const texts = cleanTexts(input);
  if (!('texts' in texts)) return texts;
  return {
    ok: true,
    resolved: {
      app,
      appView: {
        id: app.id,
        name: app.name,
        platform: app.platform,
        store: storeFor(app.platform),
      },
      ref: { productId: stored.productId, kind: stored.kind, storeRef: stored.storeRef },
      product: {
        productId: stored.productId,
        kind: stored.kind,
        referenceName: stored.referenceName,
      },
      locales: stored.locales.map((l) => l.locale),
      locale,
      texts: texts.texts,
    },
  };
}

const localeMissing = (locale: string, locales: readonly string[]): Failure =>
  failure(
    422,
    'locale_not_found',
    `The product has no localization for ${locale} in the store. Adding a locale is not built: add it in the store's console, then sync the app.`,
    { locales: [...locales] },
  );

/** Reads the localization from the store. A failure is the answer to give. Changes nothing. */
async function readLive(
  ctx: MonetizationContext,
  connection: Connection,
  r: Resolved,
): Promise<{ ok: true; current: StoreProductLocalization | undefined } | Failure> {
  try {
    const current = await withConnector(
      ctx.writeFactory,
      connection.input,
      ctx.writeTimeoutMs,
      (connector) => connector.readLocalization(r.ref, r.locale),
    );
    return { ok: true, current };
  } catch (error) {
    if (error instanceof StoreTimeout)
      return failure(504, 'timeout', 'The store did not answer in time. Nothing was changed.');
    return mapStoreError(error, connection.secret).failure;
  }
}

// ---------------------------------------------------------------------------------------------
// Preview

export async function previewLocalization(
  ctx: MonetizationContext,
  input: {
    workspaceId: string;
    appId: string;
    productId: string;
    locale: string;
    name: string;
    description: string;
    actor: Actor;
  },
): Promise<{ ok: true; preview: LocalizationPreview } | Failure> {
  const resolved = await resolve(ctx, input);
  if (!resolved.ok) return resolved;
  const r = resolved.resolved;
  const connected = await connect(
    ctx,
    input.workspaceId,
    r.app,
    PRODUCT_WRITE_PURPOSE,
    input.actor,
  );
  if (!connected.ok) return connected;
  const read = await readLive(ctx, connected.connection, r);
  if (!read.ok) return read;
  await clearUnknown(ctx.db, r.app.id);
  if (!read.current) return localeMissing(r.locale, r.locales);
  const current = textsOf(read.current);
  const locale = read.current.locale;
  const changes = changesOf(current, r.texts);
  return {
    ok: true,
    preview: {
      app: r.appView,
      product: r.product,
      locale,
      current,
      proposed: r.texts,
      changes,
      unchanged: !changes.name && !changes.description,
      previewHash: localizationPreviewHash({
        workspaceId: input.workspaceId,
        appId: r.app.id,
        store: r.appView.store,
        productId: r.product.productId,
        kind: r.product.kind,
        locale,
        current,
        proposed: r.texts,
      }),
      warnings: [
        'This changes what customers see for this product in the store, in this locale only.',
        ...(r.product.kind === 'subscription'
          ? ['Subscribers see the new texts too. Prices and terms are not changed.']
          : []),
      ],
      readAt: ctx.now(),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Apply

async function audit(
  ctx: MonetizationContext,
  input: { workspaceId: string; actor: Actor; previewHash: string },
  r: Resolved,
  action: 'monetization.localization_changed' | 'monetization.localization_failed',
  extra: Record<string, unknown>,
  state: LocalizationTexts | undefined,
  sql: Sql = ctx.db,
): Promise<void> {
  await recordAudit(sql, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action,
    target: { type: 'app', id: r.app.id },
    // Ids and hashes: never a text, a credential, a token or a store response.
    detail: {
      appId: r.app.id,
      store: r.appView.store,
      platform: r.app.platform,
      productId: r.product.productId,
      kind: r.product.kind,
      locale: r.locale,
      ...(state ? { fromHash: localizationHash(state.name, state.description) } : {}),
      toHash: localizationHash(r.texts.name, r.texts.description),
      ...(state ? { changes: changesOf(state, r.texts) } : {}),
      previewHash: input.previewHash,
      ...extra,
    },
    at: ctx.now(),
  });
}

export async function applyLocalization(
  ctx: MonetizationContext,
  input: {
    workspaceId: string;
    appId: string;
    productId: string;
    locale: string;
    name: string;
    description: string;
    previewHash: string;
    actor: Actor;
  },
): Promise<{ ok: true; result: LocalizationResult } | Failure> {
  const resolved = await resolve(ctx, input);
  if (!resolved.ok) return resolved;
  const r = resolved.resolved;
  const { db } = ctx;
  const hashFor = (current: StoreProductLocalization) =>
    localizationPreviewHash({
      workspaceId: input.workspaceId,
      appId: r.app.id,
      store: r.appView.store,
      productId: r.product.productId,
      kind: r.product.kind,
      locale: current.locale,
      current: textsOf(current),
      proposed: r.texts,
    });

  const taken = await takeClaim(ctx, {
    workspaceId: input.workspaceId,
    app: r.app,
    productId: r.product.productId,
    actor: input.actor,
  });
  if (!taken.ok) return taken;
  const claim = taken.claim;
  // Anything that returns before the write is attempted gives the claim back.
  const stop = async (f: Failure): Promise<Failure> => {
    await releaseClaim(db, claim);
    return f;
  };

  const connected = await connect(
    ctx,
    input.workspaceId,
    r.app,
    PRODUCT_WRITE_PURPOSE,
    input.actor,
  );
  if (!connected.ok) return stop(connected);
  const { connection } = connected;

  /** The texts the guard accepted: what the person confirmed. */
  let accepted: StoreProductLocalization | undefined;
  let outcome: { before: StoreProductLocalization; after: StoreProductLocalization } | undefined;
  let cause: string | undefined;
  /** The person previewed texts the store already has: nothing is written. */
  let noChange = false;
  try {
    outcome = await withConnector(ctx.writeFactory, connection.input, ctx.writeTimeoutMs, (c) =>
      c.updateLocalization({
        product: r.ref,
        locale: r.locale,
        name: r.texts.name,
        description: r.texts.description,
        guard: (current) => {
          const same = hashFor(current) === input.previewHash;
          if (same && sameTexts(textsOf(current), r.texts)) {
            noChange = true;
            return false;
          }
          if (same) accepted = current;
          return same;
        },
      }),
    );
  } catch (error) {
    if (error instanceof ProductLocalizationDriftError && noChange) {
      await releaseClaim(db, claim);
      return failure(
        422,
        'no_change',
        'The store already shows these texts. There is nothing to change.',
        { current: textsOf(error.current) },
      );
    }
    if (error instanceof ProductLocalizationDriftError) {
      await audit(
        ctx,
        input,
        r,
        'monetization.localization_failed',
        { code: 'state_changed', outcome: 'refused' },
        textsOf(error.current),
      );
      await releaseClaim(db, claim);
      const current = textsOf(error.current);
      const changes = changesOf(current, r.texts);
      return failure(
        409,
        'state_changed',
        'The store shows other texts than the ones that were previewed, so nothing was changed. Review the current texts and preview again.',
        {
          current,
          proposed: r.texts,
          changes,
          unchanged: !changes.name && !changes.description,
          previewHash: hashFor(error.current),
        },
      );
    }
    if (error instanceof ProductOutcomeUnknownError || error instanceof StoreTimeout) {
      cause = error instanceof StoreTimeout ? 'timeout' : 'network';
    } else if (error instanceof ProductLocaleMissingError) {
      await audit(
        ctx,
        input,
        r,
        'monetization.localization_failed',
        { code: 'locale_not_found', outcome: 'failed' },
        undefined,
      );
      return stop(localeMissing(r.locale, r.locales));
    } else {
      const mapped = mapStoreError(error, connection.secret);
      // The guard may not have run (the store refused earlier): there is then no state to report.
      await audit(
        ctx,
        input,
        r,
        'monetization.localization_failed',
        { code: mapped.code, outcome: 'failed' },
        accepted,
      );
      return stop(mapped.failure);
    }
  }

  const succeed = async (
    before: StoreProductLocalization,
    after: StoreProductLocalization,
    via: 'store' | 'reread',
  ): Promise<{ ok: true; result: LocalizationResult }> => {
    const at = ctx.now();
    const beforeTexts = textsOf(before);
    const afterTexts = textsOf(after);
    await db.transaction(async (tx) => {
      await audit(
        { ...ctx, now: () => at },
        input,
        r,
        'monetization.localization_changed',
        { via, ...(cause ? { cause } : {}) },
        beforeTexts,
        tx,
      );
      await storeLocalizationText(tx, {
        workspaceId: input.workspaceId,
        appId: r.app.id,
        productId: r.product.productId,
        locale: after.locale,
        ...afterTexts,
      });
    });
    await releaseClaim(db, claim);
    return {
      ok: true,
      result: {
        app: r.appView,
        product: r.product,
        locale: after.locale,
        before: beforeTexts,
        after: afterTexts,
        changes: changesOf(beforeTexts, afterTexts),
        confirmedByReread: via === 'reread',
        appliedAt: at,
        note: NOTE,
      },
    };
  };

  if (outcome) return succeed(outcome.before, outcome.after, 'store');

  // ----- an unknown outcome is checked, not sent again
  const before = accepted as StoreProductLocalization | undefined;
  const readBack = await readLive(ctx, connection, r);
  if (!readBack.ok || before === undefined || readBack.current === undefined) {
    await markUnknown(db, claim);
    await audit(
      ctx,
      input,
      r,
      'monetization.localization_failed',
      {
        code: cause ?? 'unknown',
        outcome: 'unknown',
        ...(readBack.ok ? {} : { readBack: 'failed' }),
      },
      before,
    );
    return failure(
      409,
      'outcome_unknown',
      'It is not known whether the change reached the store: the store did not answer and its texts could not be read back. Preview the change again to see where it stands; nothing is changed until you confirm a new preview.',
    );
  }
  const now = textsOf(readBack.current);
  if (sameTexts(now, r.texts)) return succeed(before, readBack.current, 'reread');
  if (sameTexts(now, textsOf(before))) {
    // The old texts are not proof that the write was not applied: a store can be slow to show a change.
    await markUnknown(db, claim);
    await audit(
      ctx,
      input,
      r,
      'monetization.localization_failed',
      { code: 'not_visible', outcome: 'unknown', cause: cause ?? 'unknown' },
      before,
    );
    return failure(
      409,
      'outcome_unknown',
      'The store did not answer, and it still shows the old texts. A change can take a moment to show: check the store, then preview the change again. Nothing is changed until you confirm a new preview.',
      { current: now },
    );
  }
  // Neither the old texts nor the asked ones: somebody else changed them too. Nothing more is done.
  await audit(
    ctx,
    input,
    r,
    'monetization.localization_failed',
    { code: 'state_changed', outcome: 'diverged', cause: cause ?? 'unknown' },
    before,
  );
  await releaseClaim(db, claim);
  return failure(
    409,
    'state_changed',
    'The store shows texts that are neither the old ones nor the requested ones. Nothing more was done. Review them and preview again.',
    { current: now },
  );
}
