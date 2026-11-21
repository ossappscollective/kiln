# ADR 0038: Sales analytics (Google Play estimated sales, sales by product)

Status: accepted. Builds on [ADR 0017](0017-analytics-foundation.md) (the analytics store and its vocabularies) and [ADR 0034](0034-in-app-products.md)
(the Products page).

## Context

Until now analytics had daily units and **proceeds** per currency for iOS and macOS (Apple Sales and Trends, needs the vendor number), never converted across
currencies. Android had no sales, and no sales were known per product or subscription.

## Decision

1. **Android sales come from the reports bucket that is already configured.** The Google Play "Estimated sales" reports are
   `sales/salesreport_YYYYMM.zip` in the same Cloud Storage bucket as the statistics (`analytics.playBucketId`, per app, per Play credential or per workspace). The
   file holds every app of the developer account, so rows are filtered by the `Package ID` column. A new source `play_sales` reads the current and the previous month
   every sync (three months on the first read), through the same bucket reading, token and error mapping as `play_reports` (`PlayReportsConnector.listObjects` and
   `downloadObject`). No new setting and no new migration.
2. **What the numbers are, said everywhere.** Google estimated sales are what the **buyer paid**: tax included, Google's fee not deducted, "not recommended for
   accounting". They are not developer proceeds, so they are never called proceeds. New metrics: `sales_gross:<CUR>` (charged amounts), `sales_refunds:<CUR>`
   (refunded amounts, positive) and `sales_orders` (charged orders); Apple's `sales_units` and `sales_proceeds:<CUR>` are unchanged (`sales_units` stays Apple's
   because a metric belongs to one source). Money is one series per currency of sale and is never converted or added. The web card is "Sales (buyer-paid,
   estimated)" next to Apple's "Proceeds". New coverage notes: `play_estimated_sales_gross`, `play_sales_latency`, `play_sales_utc`, `play_sales_per_currency`.
3. **Permission.** Reading financial data needs the Play Console permission View financial data, set to Global. A refused `sales/` folder is the error and setup code
   `play_sales_forbidden` (next step `grant_play_financial_permission`, optional): the statistics of the same bucket keep working. A month with no file is normal
   (`reports_not_found` is skipped), so an app that never sold anything shows no sales and no error.
4. **Sales by product, both stores, in the existing table.** `analytics_daily` already keys a fact by an optional ONE dimension; a new dimension `product` holds the
   store product id (Apple `SKU`, Google `SKU ID`). A money fact is stored as `<CUR>:<product id>`, so the currency is part of the key and currencies never mix.
   No migration was needed (`dim_type` is free text). `GET overview?breakdown=product` lists the top 10 products per series (a money series only its own
   currency); `GET product-sales` returns every product of a range with units (Apple net units, Google orders) and amounts per currency, with `measure` saying what
   the amount is. Apple per-product rows include in-app purchases and subscriptions, matched to the app by `Parent Identifier` (the app's SKU, read from the app's own
   rows of the same report) or by a SKU of the stored Products snapshot; the total chart still counts the app itself only (`apple_in_app_not_included`), which is
   said by `apple_product_sales_include_in_app`.
5. **Bounded storage.** At most 200 distinct products per app and source (`productSalesLimits`): known products stay, new ones are taken by volume, totals and
   per-currency facts are never dropped (`sales_products_capped`). An id over 90 characters is not stored. No title or other text is stored.
6. **Products page.** A "Sales (28 days)" column and a "Sales" section in the open product read the stored analytics only (no store call on page load), for roles that
   may read analytics (`analytics.read`), and only when the app has a stored sales day; otherwise one line says how to turn it on. The tooltip says what the number
   is. The open product detail stays inside its table row.
7. **MCP and OpenAPI.** `GET product-sales` is an operation (`getAppAnalyticsProductSales`) and the read tool `get_analytics_product_sales`; the overview text says that
   Apple proceeds and Google estimated sales are different things.

## Not done

The monthly **Earnings** report (`earnings/earnings_YYYYMM*.zip`: net of Google's fee, Pacific Time, merchant currency, "Charge", "Google fee", "Tax" lines, sent
about the fifth of the following month) is the figure for accounting. It is a possible follow-up as a separate, monthly, net series; it is not read here.
Subscription metrics (active subscribers, churn, MRR) are not built: neither report holds them.

## UNVERIFIED (marked as such in the code and in [the API page](../api/analytics.md#not-verified-unverified))

Confirmed from Google's help pages (answers 6135870 and 2482017): the object name, the column names, UTC days, the amounts being buyer amounts with no tax or fee
deducted, and the permission. Not confirmed, and handled defensively:

- that the zip holds exactly one CSV, and its encoding (a byte order mark is honoured; UTF-16 and UTF-8 both read);
- the spelling of `Financial Status` (case-insensitive `charged`; anything containing `refund` is a refund; every other value is left out);
- the sign of a refund amount (absolute value used) and the day a refund row carries;
- `Package ID` (current page) versus `Product ID` (older exports): both are read;
- the answer of Cloud Storage when View financial data is missing (assumed HTTP 403, shown as `play_sales_forbidden`);
- that the 10 MiB file cap fits a large account's month file (`file_too_large` otherwise);
- Apple: that the `SKU` of an in-app row equals the `productId` of the store product, that `Parent Identifier` is the app's SKU for every in-app type
  (Apple documents it as "SKU of the app associated with the In-App Purchase"), and the full list of product type identifiers.
