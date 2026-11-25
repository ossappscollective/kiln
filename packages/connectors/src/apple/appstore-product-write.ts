import { StoreError } from '../errors.ts';
import { isRecord, type Json, text } from '../store-http.ts';
import {
  ProductLocaleMissingError,
  ProductLocalizationDriftError,
  type ProductLocalizationResult,
  type ProductLocalizationUpdate,
  ProductMissingError,
  ProductOutcomeUnknownError,
  type StoreProductLocalization,
  type StoreProductRef,
  type StoreProductWriteConnector,
  sameLocale,
} from '../store-products-types.ts';
import { parseAppleLocalizations } from './appstore-products.ts';
import { AppleProductsHttp, type AppleProductsHttpOptions, seg } from './appstore-products-http.ts';

export type AppleProductWriteConnectorOptions = AppleProductsHttpOptions;

/**
 * App Store Connect: change the display name and description of ONE localization of an in-app purchase or a subscription. A STORE WRITE
 * (what customers read in the store), reversible, and the only one of this feature. Only called by the server's monetization service, after a rights
 * check, a preview, a confirmation hash and a read of the live texts right before the write (docs/adr/0034-in-app-products.md). Never retried.
 *
 * - `PATCH /v2/inAppPurchaseLocalizations/{id}`: "Update the display name and description for a specific locale of an In-App Purchase configured
 *   with the v2 API" (VERIFIED, 200 with `InAppPurchaseLocalizationV2Response`; 409 and 422 are documented refusals).
 *   The request is `InAppPurchaseLocalizationV2UpdateRequest`: `data.type` `inAppPurchaseLocalizations`, `data.id`, `data.attributes` with
 *   `name` and `description` (VERIFIED, from the object pages).
 * - `PATCH /v2/subscriptionLocalizations/{id}` (VERIFIED the same way; `data.type` `subscriptionLocalizations`, attributes `name`, `description`).
 *   The v1 PATCH of both is deprecated since API 4.4.1.
 * - The live read before the write is the product's own read with `include` of its localizations (`GET /v2/inAppPurchases/{id}`,
 *   `GET /v1/subscriptions/{id}`; both VERIFIED, both list the include).
 *
 * UNVERIFIED: that the localization ids that `include` returns are the ids the v2 PATCH takes (the v2 resources belong to a "version" of the
 * product, new in API 4.4.1); whether Apple lets the texts of an APPROVED product be changed in place (a refusal comes back as a 409 and is shown
 * as is, nothing changed); the length limits of both texts (the store enforces them; a 4xx is reported); which key role may do it.
 *
 * A timeout, a cut connection or a 5xx on the PATCH is `ProductOutcomeUnknownError`: the caller reads the localization back.
 */

export class AppleProductWriteConnector implements StoreProductWriteConnector {
  readonly store = 'appstoreconnect' as const;
  readonly #api: AppleProductsHttp;

  constructor(options: AppleProductWriteConnectorOptions) {
    this.#api = new AppleProductsHttp(options);
  }

  static fromSecret(
    secret: string,
    options: Omit<AppleProductWriteConnectorOptions, 'credential'>,
  ): AppleProductWriteConnector {
    return new AppleProductWriteConnector({
      ...options,
      credential: AppleProductsHttp.credentialOf(secret),
    });
  }

  #ref(product: StoreProductRef): string {
    if (!product.storeRef || !/^[A-Za-z0-9._~=-]{1,200}$/.test(product.storeRef)) {
      throw new StoreError(
        'appstoreconnect',
        'invalid_input',
        'The App Store id of the product is not known. Sync the app first.',
      );
    }
    return product.storeRef;
  }

  async readLocalization(
    product: StoreProductRef,
    locale: string,
  ): Promise<StoreProductLocalization | undefined> {
    const ref = this.#ref(product);
    const subscription = product.kind === 'subscription';
    const type = subscription ? 'subscriptionLocalizations' : 'inAppPurchaseLocalizations';
    const path = subscription
      ? `/v1/subscriptions/${seg(ref)}?include=subscriptionLocalizations&limit[subscriptionLocalizations]=50`
      : `/v2/inAppPurchases/${seg(ref)}?include=inAppPurchaseLocalizations&limit[inAppPurchaseLocalizations]=50`;
    const body = await this.#api.get(path, 'reading the localizations of a product', true);
    if (body === undefined) throw new ProductMissingError('appstoreconnect');
    const data: Json = isRecord(body.data) ? body.data : {};
    const included = Array.isArray(body.included) ? body.included.filter(isRecord) : [];
    return parseAppleLocalizations(data, included, type).find((l) => sameLocale(l.locale, locale));
  }

  async updateLocalization(input: ProductLocalizationUpdate): Promise<ProductLocalizationResult> {
    const current = await this.readLocalization(input.product, input.locale);
    if (!current) throw new ProductLocaleMissingError('appstoreconnect', input.locale);
    if (!current.ref) {
      throw new StoreError(
        'appstoreconnect',
        'unexpected',
        'App Store Connect did not name the localization, so it cannot be changed from here.',
      );
    }
    if (!input.guard(current)) throw new ProductLocalizationDriftError('appstoreconnect', current);
    const subscription = input.product.kind === 'subscription';
    const type = subscription ? 'subscriptionLocalizations' : 'inAppPurchaseLocalizations';
    const result = await this.#api.write(
      'PATCH',
      `/v2/${type}/${seg(current.ref)}`,
      'changing the texts of a product',
      {
        data: {
          type,
          id: current.ref,
          attributes: { name: input.name, description: input.description },
        },
      },
    );
    if (!result.ok) {
      throw new ProductOutcomeUnknownError('appstoreconnect', result.message, result.status);
    }
    const answered = isRecord(result.json) && isRecord(result.json.data) ? result.json.data : {};
    const a = isRecord(answered.attributes) ? answered.attributes : {};
    return {
      before: current,
      after: {
        locale: current.locale,
        name: text(a.name) ?? input.name,
        description: text(a.description) ?? input.description,
        ref: current.ref,
      },
    };
  }
}
