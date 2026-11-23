# Troubleshooting analytics sources

Insights, Data sources lists every source with its last result. For Sales and Trends, subscription reports and the Play Console reports, press
**Test access** under the source: it makes one cheap call and tells you what is missing, without waiting for a sync. Nothing is stored by the test.
Real Apple and Google calls were not recorded when this page was written: the status codes below follow the vendors' documentation and are marked
(UNVERIFIED) where Kiln has not seen the vendor's exact answer.

## Apple: Sales and Trends, Subscription and Subscription Event reports

What Kiln calls: `GET /v1/salesReports` with `filter[vendorNumber]`, `frequency=DAILY`, `reportType` SALES (version 1_0) or SUBSCRIPTION and
SUBSCRIPTION_EVENT (version 1_3), `reportSubType=SUMMARY` and `reportDate`; the answer is a gzip table.

**What Apple needs**

1. An App Store Connect API key with the role **Sales**, **Finance**, **Admin** or **Account Holder**. Roles without access to sales (for example Developer or
   Marketing) are refused; Apple's role table also lists App Manager (UNVERIFIED for the API). (The analytics report requests of the App Store analytics source use a different permission: Admin to create the request.)
   Set it under App Store Connect, [Users and Access](https://appstoreconnect.apple.com/access/users), Integrations.
2. The **vendor number of the same Apple team as the key**: App Store Connect, [Payments and Financial Reports](https://appstoreconnect.apple.com/itc/payments_and_financial_reports),
   top left next to the team name (about 8 digits). Enter it under Insights, Data sources, on the Sales and Trends source. It is stored per
   Apple credential: two teams, two numbers. The workspace setting `analytics.appleVendorNumber` is only the default for a credential without its own.

**Days.** Apple sales days run on Pacific Time and the report of a day is posted the next day: Kiln asks up to yesterday in Pacific Time. A day without
sales or not yet published (HTTP 404, or a 400 about the report date, UNVERIFIED) is "nothing for that day", not a failure.

| You see | Meaning | Do |
| --- | --- | --- |
| Optional: enter the vendor number | No number for this team. | Enter it. |
| Apple does not accept this vendor number (`vendor_number_invalid`) | HTTP 400 about the number: another team's, or mistyped. | Compare with Payments and Financial Reports. |
| Apple refused the key (`sales_forbidden`, HTTP 403) | Wrong role, or the number belongs to another team (UNVERIFIED which one Apple reports). | Check the role and the number. |
| The store refused the request (`store_rejected`) | An HTTP 4xx without a meaning of its own. | Check credential and number, then Test access. |
| The store did not answer (`store_unavailable`) | Network, timeout or HTTP 5xx. | Nothing: the next sync retries. |

## Google Play: statistics, sales, earnings, subscription statistics

Google keeps one private Cloud Storage bucket per Play developer account, `pubsite_prod_rev_<developer account number>`, with these folders (Kiln reads them
for the package of the app only):

| Source | Object | Appears |
| --- | --- | --- |
| Play Console reports (installs, ratings, store listing) | `stats/<report>/<report>_<package>_YYYYMM_<dimension>.csv` | Monthly file, grows daily, a few days late. |
| Sales reports | `sales/salesreport_YYYYMM.zip` | During the month, extended daily. |
| Earnings reports | `earnings/earnings_YYYYMM.zip` | About the 5th of the next month. |
| Subscription statistics | `financial-stats/subscriptions/subscriptions_<package>_<product>_YYYYMM_<dimension>.csv` | Monthly. |

A file that does not exist yet (HTTP 404 on the object) is "nothing yet", never a permission error.

**What Google needs** (for the service account of the Play credential of the app, address shown in the guide)

1. Invite the service account in Play Console, [Users and permissions](https://play.google.com/console/u/0/developers/), of the account that **owns the app**, with
   the account permission **View app information and download bulk reports (read-only)**: statistics.
2. For sales, earnings and subscription statistics also **View financial data, orders and cancellation survey responses**, set to **Global** (all apps),
   not for one app.
3. Cloud Storage: the bucket belongs to a Google-managed project for most accounts, so the Play Console invitation is normally what grants access. If
   you can open the bucket's permissions page (`https://console.cloud.google.com/storage/browser/<bucket>;tab=permissions`), the service account
   may need to be listed there with **Storage Object Viewer** (UNVERIFIED: Kiln has not seen a case where this was required).
4. A new permission can take **24 to 48 hours** to apply.
5. One bucket id **per Play account**. A workspace with two Play credentials must set the bucket on each credential (Insights, Data sources, the bucket
   field under the guide, or App settings): a workspace-wide bucket is read by every app and is refused for the apps of the other account.

| You see | Meaning | Do |
| --- | --- | --- |
| Optional: set the bucket | No bucket id. | Copy the Cloud Storage URI from Play Console, Download reports, Statistics. |
| Bucket refused (`bucket_forbidden`, 403 on the bucket) | Another account's bucket, or the invitation is missing or not applied yet. The guide says when the bucket is the workspace default of a workspace with several Play accounts. | Fix the bucket id, then the invitation. |
| Financial reports refused (`play_sales_forbidden`) | The statistics folder can be read but the financial one cannot. | Grant View financial data (Global); wait. |
| No bucket with this id (`bucket_not_found`) | Mistyped, or not a Play reports bucket. | Copy it again. |
| Not in this bucket (`package_not_in_bucket`) | The bucket is readable but holds nothing of the app: another account's bucket. | Set the owning account's bucket. |

## Reading the answer of Test access

`ok`: access works. `no_report_yet`: the call worked, the store has no file for the day or month asked (normal for a new app or period). Any other code
is in the table above. The same classes are returned by `POST /apps/:id/analytics/access-test` ([API](api/analytics.md)).
