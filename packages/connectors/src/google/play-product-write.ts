import { StoreError } from '../errors.ts';
import { enc, isRecord, type Json, records, text } from '../store-http.ts';
import {
  type ProductLocalizationResult,
  type ProductLocalizationUpdate,
  ProductLocaleMissingError,
  ProductLocalizationDriftError,
  ProductMissingError,
  ProductOutcomeUnknownError,
  sameLocale,
  type StoreProductLocalization,
  type StoreProductRef,
  type StoreProductWriteConnector,
} from '../store-products-types.ts';
import { parsePlayListings } from './play-products.ts';
import { PlayProductsHttp, type PlayProductsHttpOptions } from './play-products-http.ts';

/**
 * Google Play: change the title and description of ONE listing of a subscription or a one-time product. A STORE WRITE (what customers read in
 * the store), reversible, the only one of this feature. Only called by the server's monetization service, after a rights check, a preview, a
 * confirmation hash and a read of the live listing right before the write (docs/adr/0034-in-app-products.md). Never retried.
 *
 * - `PATCH /androidpublisher/v3/applications/{packageName}/subscriptions/{productId}` (`monetization.subscriptions.patch`) and
 *   `PATCH .../onetimeproducts/{productId}` (lowercase, as the discovery document has it; the list and get paths use `oneTimeProducts`).
 *   Query: `updateMask` (required), `regionsVersion.version` (required), `allowMissing` (optional: NEVER sent, so the call cannot create a product),
 *   `latencyTolerance` (optional, left at its default). Body: the resource. Answer: the resource. VERIFIED on Google's pages and discovery document.
 * - This connector sends `updateMask=listings` and a body of `listings` only: the whole list as it was read, with the one listing's `title` and
 *   `description` replaced (every other field of every listing, such as `benefits`, is sent back as read). Nothing else is in the mask, so no price,
 *   plan, availability or tax setting can change. UNVERIFIED: that Play accepts a body without the other fields when only `listings` is masked.
 * - The `regionsVersion.version` of a one-time product is the one its own `regionsVersion` field holds. A subscription has none: the version comes
 *   from `POST .../pricing:convertRegionPrices` (`regionVersion`: "the region version at which the prices were generated"; VERIFIED that it
 *   exists; UNVERIFIED that Play accepts it as the value for a subscription patch). That POST changes nothing.
 * - Whether Play's Console permission "Manage store presence" or "Manage orders and subscriptions" is what a service account needs is UNVERIFIED.
 *
 * A timeout, a cut connection or a 5xx on the PATCH is `ProductOutcomeUnknownError`: the caller reads the listing back.
 */

export type PlayProductWriteConnectorOptions = PlayProductsHttpOptions;

const PRODUCT_ID = /^[a-z0-9][a-z0-9._]{0,39}$/;

export class PlayProductWriteConnector implements StoreProductWriteConnector {
  readonly store = 'googleplay' as const;
  readonly #api: PlayProductsHttp;

  constructor(options: PlayProductWriteConnectorOptions) {
    this.#api = new PlayProductsHttp(options);
  }

  #id(product: StoreProductRef): string {
    if (!PRODUCT_ID.test(product.productId)) {
      throw new StoreError('googleplay', 'invalid_input', 'Not a valid Google Play product id.');
    }
    return product.productId;
  }

  /** The product as Google has it now (the resource), and where it lives. */
  async #read(product: StoreProductRef): Promise<{ resource: Json; subscription: boolean }> {
    const id = this.#id(product);
    const subscription = product.kind === 'subscription';
    const url = this.#api.url(
      subscription ? `/subscriptions/${enc(id)}` : `/oneTimeProducts/${enc(id)}`,
    );
    const body = await this.#api.get(url, 'reading a product', true);
    if (body === undefined) throw new ProductMissingError('googleplay');
    return { resource: body, subscription };
  }

  async readLocalization(
    product: StoreProductRef,
    locale: string,
  ): Promise<StoreProductLocalization | undefined> {
    const { resource } = await this.#read(product);
    return parsePlayListings(resource.listings).find((l) => sameLocale(l.locale, locale));
  }

  /** The regions version to send: the product's own, else the one Play reports for a price conversion. */
  async #regionsVersion(resource: Json): Promise<string> {
    const own = isRecord(resource.regionsVersion)
      ? text(resource.regionsVersion.version)
      : undefined;
    if (own) return own;
    const converted = await this.#api.postRead(
      this.#api.url('/pricing:convertRegionPrices'),
      { price: { currencyCode: 'USD', units: '1', nanos: 0 } },
      'reading the current regions version',
    );
    const version = isRecord(converted.regionVersion)
      ? text(converted.regionVersion.version)
      : undefined;
    if (!version) {
      throw new StoreError(
        'googleplay',
        'unexpected',
        'Google Play did not say which regions version to use, so the texts were not changed.',
      );
    }
    return version;
  }

  async updateLocalization(input: ProductLocalizationUpdate): Promise<ProductLocalizationResult> {
    const { resource, subscription } = await this.#read(input.product);
    const listings = records(resource.listings);
    const index = listings.findIndex((l) => {
      const code = text(l.languageCode);
      return code !== undefined && sameLocale(code, input.locale);
    });
    const entry = index >= 0 ? listings[index] : undefined;
    const current = parsePlayListings(entry ? [entry] : [])[0];
    if (!entry || !current) throw new ProductLocaleMissingError('googleplay', input.locale);
    if (!input.guard(current)) throw new ProductLocalizationDriftError('googleplay', current);

    const next = listings.map((l, i) =>
      i === index ? { ...l, title: input.name, description: input.description } : l,
    );
    const version = await this.#regionsVersion(resource);
    const id = this.#id(input.product);
    const path = subscription ? `/subscriptions/${enc(id)}` : `/onetimeproducts/${enc(id)}`;
    const url = `${this.#api.url(path)}?updateMask=listings&regionsVersion.version=${enc(version)}`;
    const result = await this.#api.patch(
      url,
      { listings: next },
      'changing the texts of a product',
    );
    if (!result.ok) {
      throw new ProductOutcomeUnknownError('googleplay', result.message, result.status);
    }
    const after =
      isRecord(result.json) &&
      parsePlayListings(result.json.listings).find((l) => sameLocale(l.locale, input.locale));
    return {
      before: current,
      after: after || { locale: current.locale, name: input.name, description: input.description },
    };
  }
}
