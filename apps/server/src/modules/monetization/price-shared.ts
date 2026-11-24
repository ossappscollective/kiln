import {
  AppleProductPriceConnector,
  connectorFactory,
  PlayProductPriceConnector,
  type StorePriceWriteConnector,
} from '@kiln/connectors';
import {
  type CurrentPrice,
  DEFAULT_PRICE_LIMITS,
  type PriceChange,
  type PriceIssue,
  type PriceLimits,
} from '@kiln/core';
import type { Database } from '@kiln/db';
import { coded } from '../../i18n/problem.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { getSettings } from '../../services/workspace-settings.ts';
import {
  DEFAULT_PRODUCT_CLAIM_TTL_MS,
  DEFAULT_PRODUCT_WRITE_TIMEOUT_MS,
  type ProductsConnectorInput,
} from './shared.ts';

/**
 * What the price writes share (docs/adr/0062-price-writes.md): the context, the gates that are not per request (server switch and workspace
 * setting), the connector, and the words for the problems the pure validation reports. A price write is the strictest write of the app.
 */

export const PRICE_ENV = 'KILN_PRICE_WRITES_ENABLED';
export const PRICE_SETTING = 'prices.writeEnabled';
/** The purpose recorded when a credential is used (the audit row `credential.use`). */
export const PRICE_PURPOSE = 'monetization.price';
/** The step-up class of sending prices. */
export const PRICE_STEP_UP = 'store.price';
/** Reading, writing and reading back every territory of several products can take a while. */
export const DEFAULT_PRICE_TIMEOUT_MS = DEFAULT_PRODUCT_WRITE_TIMEOUT_MS * 2;

export type PriceLimitsConfig = {
  relativeChangePercent: number;
  absoluteChangeMajor: number;
  maxTerritories: number;
};
export type PriceConnectorFactory = (input: ProductsConnectorInput) => StorePriceWriteConnector;

export const defaultPriceConnectorFactory: PriceConnectorFactory =
  connectorFactory<StorePriceWriteConnector>({
    app_store_connect: (input) =>
      AppleProductPriceConnector.fromSecret(input.secret, { fetch: input.fetch }),
    google_play: (input) =>
      new PlayProductPriceConnector({
        serviceAccount: input.secret,
        packageName: input.identifier,
        fetch: input.fetch,
      }),
  });

/** What the app is given (`AppDeps.prices`): the switch and limits come from the configuration, the rest are seams for tests. */
export type PriceDeps = {
  enabled?: boolean | undefined;
  limits?: PriceLimitsConfig | undefined;
  connectorFactory?: PriceConnectorFactory | undefined;
  timeoutMs?: number | undefined;
  claimTtlMs?: number | undefined;
};

export type PriceContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  /** KILN_PRICE_WRITES_ENABLED. */
  enabled: boolean;
  limits: PriceLimits;
  factory: PriceConnectorFactory;
  timeoutMs: number;
  claimTtlMs: number;
};

export function limitsFrom(config: PriceLimitsConfig | undefined): PriceLimits {
  if (!config) return DEFAULT_PRICE_LIMITS;
  return {
    ...DEFAULT_PRICE_LIMITS,
    relativeBp: config.relativeChangePercent * 100,
    absoluteMajor: config.absoluteChangeMajor,
    // A currency with a larger default keeps it unless the operator lowers the generic amount below the usual one.
    absoluteMajorByCurrency:
      config.absoluteChangeMajor === DEFAULT_PRICE_LIMITS.absoluteMajor
        ? DEFAULT_PRICE_LIMITS.absoluteMajorByCurrency
        : Object.keys(DEFAULT_PRICE_LIMITS.absoluteMajorByCurrency).reduce<Record<string, number>>(
            (out, code) => {
              out[code] = Math.round(
                ((DEFAULT_PRICE_LIMITS.absoluteMajorByCurrency[code] as number) /
                  DEFAULT_PRICE_LIMITS.absoluteMajor) *
                  config.absoluteChangeMajor,
              );
              return out;
            },
            {},
          ),
    maxTerritories: config.maxTerritories,
  };
}

export function buildPriceContext(
  base: Pick<PriceContext, 'db' | 'masterKey' | 'now'>,
  deps: PriceDeps | undefined,
): PriceContext {
  return {
    ...base,
    enabled: deps?.enabled ?? false,
    limits: limitsFrom(deps?.limits),
    factory: deps?.connectorFactory ?? defaultPriceConnectorFactory,
    timeoutMs: deps?.timeoutMs ?? DEFAULT_PRICE_TIMEOUT_MS,
    claimTtlMs: deps?.claimTtlMs ?? DEFAULT_PRODUCT_CLAIM_TTL_MS,
  };
}

export type PriceSwitch = {
  enabled: boolean;
  envName: string;
  workspaceEnabled: boolean;
  reason: 'server_switch' | 'workspace_setting' | null;
};

/** Both switches, in the order they are reported: the server's first. */
export async function priceSwitch(
  ctx: Pick<PriceContext, 'db' | 'enabled'>,
  workspaceId: string,
): Promise<PriceSwitch> {
  const settings = await getSettings(ctx.db, workspaceId);
  const workspaceEnabled = settings.values[PRICE_SETTING] === true;
  return {
    enabled: ctx.enabled && workspaceEnabled,
    envName: PRICE_ENV,
    workspaceEnabled,
    reason: !ctx.enabled ? 'server_switch' : !workspaceEnabled ? 'workspace_setting' : null,
  };
}

export const priceDisabledFailure = (sw: PriceSwitch): Failure =>
  sw.reason === 'workspace_setting'
    ? failure(
        409,
        'price_writes_disabled',
        `Price changes are switched off for this workspace. An owner or admin can turn on the setting ${PRICE_SETTING}.`,
        {
          envName: PRICE_ENV,
          reason: sw.reason,
          ...coded('prices.disabledWorkspace'),
        },
      )
    : failure(
        409,
        'price_writes_disabled',
        `Price changes are switched off on this server. Set ${PRICE_ENV}=true to turn it on (see docs/deployment.md).`,
        {
          envName: PRICE_ENV,
          reason: 'server_switch',
          ...coded('prices.disabledServer'),
        },
      );

/** The sentence of each problem the pure validation can report, with its code. Never a store's text. */
const ISSUE: Record<
  PriceIssue['code'],
  { status: 409 | 422; error: string; message: string; code: string }
> = {
  no_lines: {
    status: 422,
    error: 'invalid_price',
    message: 'Name at least one territory.',
    code: 'prices.noLines',
  },
  too_many_territories: {
    status: 422,
    error: 'invalid_price',
    message: 'Too many territories in one change.',
    code: 'prices.tooManyTerritories',
  },
  duplicate_territory: {
    status: 422,
    error: 'invalid_price',
    message: 'A territory is named twice.',
    code: 'prices.duplicateTerritory',
  },
  bad_territory: {
    status: 422,
    error: 'invalid_price',
    message: 'Not a territory of this store.',
    code: 'prices.badTerritory',
  },
  bad_product: {
    status: 422,
    error: 'invalid_price',
    message: 'Not a valid product.',
    code: 'prices.badProduct',
  },
  bad_amount: {
    status: 422,
    error: 'invalid_price',
    message: 'An amount must be whole minor units, such as 499 for 4.99.',
    code: 'prices.badAmount',
  },
  not_positive: {
    status: 422,
    error: 'invalid_price',
    message: 'A price must be greater than zero.',
    code: 'prices.notPositive',
  },
  too_high: {
    status: 422,
    error: 'invalid_price',
    message: 'That price is above the highest price Kiln allows.',
    code: 'prices.tooHigh',
  },
  no_change: {
    status: 422,
    error: 'invalid_price',
    message: 'The new price is the price the store already shows.',
    code: 'prices.noChange',
  },
  currency_mismatch: {
    status: 422,
    error: 'currency_mismatch',
    message: 'The currency is not the currency of that territory.',
    code: 'prices.currencyMismatch',
  },
  unknown_territory: {
    status: 422,
    error: 'invalid_price',
    message: 'The product has no price in that territory.',
    code: 'prices.unknownTerritory',
  },
  price_point_missing: {
    status: 422,
    error: 'price_point_invalid',
    message: 'Apple prices are chosen from price points: pick one.',
    code: 'prices.pricePointMissing',
  },
  price_point_unknown: {
    status: 422,
    error: 'price_point_invalid',
    message: 'That price point does not exist for this product.',
    code: 'prices.pricePointUnknown',
  },
  price_point_territory: {
    status: 422,
    error: 'price_point_invalid',
    message: 'That price point belongs to another territory.',
    code: 'prices.pricePointTerritory',
  },
  price_point_mismatch: {
    status: 422,
    error: 'price_point_invalid',
    message: 'The amount is not the amount of that price point.',
    code: 'prices.pricePointMismatch',
  },
  amount_not_price_point: {
    status: 422,
    error: 'price_point_invalid',
    message: 'Apple only sells at its price points. This amount is not one: pick the nearest.',
    code: 'prices.amountNotPricePoint',
  },
  price_point_not_allowed: {
    status: 422,
    error: 'invalid_price',
    message: 'Google Play prices are amounts, not price points.',
    code: 'prices.pricePointNotAllowed',
  },
  plan_missing: {
    status: 422,
    error: 'invalid_price',
    message: 'Name the base plan or purchase option.',
    code: 'prices.planMissing',
  },
  plan_not_allowed: {
    status: 422,
    error: 'invalid_price',
    message: 'This product has no such plan.',
    code: 'prices.planNotAllowed',
  },
  effective_date_invalid: {
    status: 422,
    error: 'invalid_price',
    message: 'Not a date: use YYYY-MM-DD.',
    code: 'prices.dateInvalid',
  },
  effective_date_past: {
    status: 422,
    error: 'invalid_price',
    message: 'The date is in the past.',
    code: 'prices.datePast',
  },
  effective_date_unsupported: {
    status: 422,
    error: 'invalid_price',
    message: 'This store applies a price when it is sent: it cannot be dated.',
    code: 'prices.dateUnsupported',
  },
  subscriber_rule_invalid: {
    status: 422,
    error: 'invalid_price',
    message: 'That choice for existing subscribers does not exist in this store.',
    code: 'prices.subscriberRule',
  },
  ack_required: {
    status: 422,
    error: 'acknowledgement_required',
    message: 'This change needs an explicit acknowledgement.',
    code: 'prices.ackRequired',
  },
  ack_unknown: {
    status: 422,
    error: 'invalid_price',
    message: 'Not a known acknowledgement.',
    code: 'prices.ackUnknown',
  },
  stale_price: {
    status: 409,
    error: 'stale_price',
    message: 'The price changed since you looked at it. Sync the app and review again.',
    code: 'prices.stale',
  },
};

export const issueFailure = (issues: readonly PriceIssue[]): Failure => {
  const first = issues[0] as PriceIssue;
  const spec = ISSUE[first.code];
  return failure(spec.status, spec.error, spec.message, {
    issues: issues.map((i) => ({
      code: i.code,
      ...(i.territory ? { territory: i.territory } : {}),
      ...(i.detail ? { detail: i.detail } : {}),
    })),
    ...coded(spec.code, first.territory ? { territory: first.territory } : undefined),
  });
};

/** The snapshot's price rows of one product and plan as the current prices of the pure validation. */
export const currentOf = (
  rows: readonly { territory: string; currency: string; amount: string }[],
): CurrentPrice[] =>
  rows.map((r) => ({ territory: r.territory, currency: r.currency, amount: r.amount }));

export type StagedPrice = {
  id: string;
  change: PriceChange;
  syncedAt: number;
  createdBy: string;
  createdAt: number;
  valueHash: string;
};
