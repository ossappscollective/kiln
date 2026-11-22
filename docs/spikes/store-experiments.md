# Spike: store experiments and custom product pages (Apple and Google Play)

Read 2026-11-22 on the official pages. The Apple reference pages are JavaScript pages: the readable form is the JSON behind them
(`developer.apple.com/tutorials/data/documentation/appstoreconnectapi/<page>.json`), which lists endpoints, parameters, allowed values
and schema names but NOT every attribute description. No real Apple or Google account was available, so no response was seen from a
real store. Everything below is marked VERIFIED (read on the page named) or UNVERIFIED.

## Apple: App Store Connect API

### Product Page Optimization (experiments, "tests")

Since API 2.4 ([release notes](https://developer.apple.com/documentation/appstoreconnectapi/app-store-connect-api-2-4-release-notes))
the experiment resource is `appStoreVersionExperiments` v2: it is tied to the app, not to a version, so a test is not interrupted by a new
version. The v1 endpoints (`/v1/appStoreVersionExperiments...`) and `GET /v1/appStoreVersions/{id}/appStoreVersionExperiments` are DEPRECATED.
Endpoint list ([Managing App Store version experiments](https://developer.apple.com/documentation/appstoreconnectapi/app-store-version-experiments)), VERIFIED:

| Method and path | Use |
| --- | --- |
| `GET /v1/apps/{id}/appStoreVersionExperimentsV2` | list an app's experiments. `filter[state]`, `include` = `app`, `latestControlVersion`, `controlVersions`, `appStoreVersionExperimentTreatments`; `limit` max 200, `limit[appStoreVersionExperimentTreatments]` max 50 |
| `GET /v1/appStoreVersions/{id}/appStoreVersionExperimentsV2` | the same per version |
| `GET /v2/appStoreVersionExperiments/{id}` | one experiment |
| `GET /v2/appStoreVersionExperiments/{id}/appStoreVersionExperimentTreatments` | its treatments |
| `POST /v2/appStoreVersionExperiments` | create: attributes `name`, `platform`, `trafficProportion` (all required), relationship `app` (required) |
| `PATCH /v2/appStoreVersionExperiments/{id}` | attributes `name`, `started` (boolean), `trafficProportion` |
| `DELETE /v2/appStoreVersionExperiments/{id}` | "before it starts" |
| `POST /v1/appStoreVersionExperimentTreatments` | attributes `name` (required), `appIconName` |
| `PATCH /v1/appStoreVersionExperimentTreatments/{id}`, `DELETE` | name and icon name; delete |
| `GET /v1/appStoreVersionExperimentTreatments/{id}/appStoreVersionExperimentTreatmentLocalizations` | treatment locales; `include` = `appScreenshotSets`, `appPreviewSets`, `placements` (limits max 50), `filter[locale]`, `limit` max 200 |
| `POST /v1/appStoreVersionExperimentTreatmentLocalizations`, `DELETE .../{id}` | add and remove a treatment locale |
| `GET /v1/appStoreVersionExperimentTreatmentLocalizations/{id}/placements` | the asset-library placements of a locale |

Attributes (VERIFIED, names and types from the schema pages; no descriptions):

- Experiment v2: `name`, `platform`, `trafficProportion` (integer), `state`, `reviewRequired` (boolean), `startDate`, `endDate` (date-time).
  `state` values: `PREPARE_FOR_SUBMISSION`, `READY_FOR_REVIEW`, `WAITING_FOR_REVIEW`, `IN_REVIEW`, `ACCEPTED`, `APPROVED`, `REJECTED`, `COMPLETED`, `STOPPED`.
  Relationships: `app`, `appStoreVersionExperimentTreatments`, `controlVersions`, `latestControlVersion`.
- Treatment: `name`, `appIconName`, `appIcon` (image asset), `promotedDate`. Treatment localization: `locale` only.
- Limits ([Create a test](https://www.developer.apple.com/help/app-store-connect/create-product-page-optimization-tests/create-a-test),
  [Run a test](https://developer-mdn.apple.com/help/app-store-connect/create-product-page-optimization-tests/run-a-test)), VERIFIED: up to 3 treatments per test;
  the app must be live (Ready for Distribution or Pre-Order Ready for Distribution); a test runs 90 days or until stopped; a stopped test cannot be restarted;
  roles Account Holder, Admin, App Manager, Marketing; metadata that needs review is submitted ("Add for Review"), and the status turns to Running after approval.
  The help pages state no limit on concurrent tests.

### Custom product pages

All VERIFIED unless noted ([Custom Product Pages and Localizations](https://developer.apple.com/documentation/appstoreconnectapi/custom-product-pages-and-localizations)):

| Method and path | Use |
| --- | --- |
| `GET /v1/apps/{id}/appCustomProductPages` | list. `include` = `app`, `appCustomProductPageVersions`; `limit` max 200, `limit[appCustomProductPageVersions]` max 50; `filter[visible]` |
| `POST /v1/appCustomProductPages`, `PATCH .../{id}` (name, visibility), `DELETE` | page |
| `GET /v1/appCustomProductPages/{id}/appCustomProductPageVersions`, `POST /v1/appCustomProductPageVersions`, `PATCH` | versions |
| `GET /v1/appCustomProductPageVersions/{id}/appCustomProductPageLocalizations` | locales; `include` = `appScreenshotSets`, `appPreviewSets`, `searchKeywords`, `placements`; `filter[locale]`; limit max 200 |
| `POST /v1/appCustomProductPageLocalizations`, `PATCH` (promotional text), `DELETE` | locale |
| `GET /v1/appCustomProductPageLocalizations/{id}/placements` | asset-library placements (screenshots, previews) of a locale |

- Page attributes: `name`, `url` (the shareable address), `visible`. Version attributes: `version`, `state` (`PREPARE_FOR_SUBMISSION`, `READY_FOR_REVIEW`,
  `WAITING_FOR_REVIEW`, `IN_REVIEW`, `ACCEPTED`, `APPROVED`, `REPLACED_WITH_NEW_VERSION`, `REJECTED`), `deepLink` (uri). Localization: `locale`, `promotionalText`.
- Limit: up to 70 additional custom product pages per app ([Apple](https://developer.apple.com/app-store/custom-product-pages/)); a deep link needs iOS 18 or later;
  every change is submitted for review independently of an app update.
- Screenshots: the screenshot-set endpoints (`POST /v1/appScreenshotSets`, and the sets under a custom page or treatment locale) are all marked DEPRECATED:
  "Use the App Asset Library and placements instead". The replacement (`appAssetLibraryPlacements`, filter `placementType` = `APP_SCREENSHOT`, `APP_PREVIEW`, ...) is read
  with `include=placements` or `GET .../placements`. The asset-library upload and placement-create endpoints were NOT read (their schema pages did not load): UNVERIFIED.
- A custom page has no "state" of its own: the state is on its versions; the page is `visible` or not.

### Results (impressions, conversion, confidence)

- In App Store Connect the PPO results table shows Unique Impressions, Conversion Rate, Improvement and Confidence per variant, only after 5 first-time downloads, updated daily
  ([PPO analytics](https://developer.apple.com/help/app-store-connect-analytics/acquisition/product-page-optimization/)). Custom page analytics (impressions, downloads, conversion,
  retention, proceeds) are in App Analytics > Acquisition ([Apple](https://developer.apple.com/app-store/custom-product-pages/)).
- NO experiment-results or custom-page-metrics object exists in the endpoint lists above: VERIFIED that none is listed. The Analytics Reports API
  ([App Store Discovery and Engagement](https://developer.apple.com/documentation/analytics-reports/app-store-discovery-and-engagement)) has the detailed-report field
  `Page Title` ("the name of the product page or in-app event page ... the name you set in App Store Connect, default product page, no page, or null"), with events
  Impression, Page view and Tap and engagement Get, so impressions and taps by custom page name are probably derivable. It has no treatment or confidence field.
  Whether `Page Title` carries a treatment name, and whether the report works for a given app (a forum thread reports empty instances) are UNVERIFIED.
- Decision: Kiln shows no results for Apple experiments (a link to App Store Connect and an explanation). Custom-page metrics from the Analytics Reports are a follow-up.

## Google Play

- The Google Play Developer API v3 ([reference index](https://developers.google.com/android-publisher/api-ref/rest)) has `edits.listings` (localized default listing: get, list, patch,
  update, delete) and no resource for store listing experiments or custom store listings: VERIFIED by the resource index (applications, apprecovery, appsigning, edits and its
  sub-resources, externaltransactions, generatedapks, grants, inappproducts, internalappsharingartifacts, monetization, orders, purchases.*, reviews, systemapks, users).
  So Google is not readable and not writable from Kiln.
- Facts for the tracker and the texts ([experiments](https://support.google.com/googleplay/android-developer/answer/6227309?hl=en),
  [custom listings](https://support.google.com/googleplay/android-developer/answer/9867158)): one default-graphics experiment or up to five localized experiments at a time per
  app; up to 2 variants against the current listing; stops automatically after 6 months; results are "which option performs best" with confidence interval and minimum detectable
  effect. Up to 50 custom store listings per app; shareable address `https://play.google.com/store/apps/details?id=<package>&listing=<parameter>` (parameter: lowercase letters,
  digits, `.`, `-`, `_`, `~`); the app must be published. Console path: Grow users > Store presence > Store listings / Custom store listings.
- The Console addresses of an app need the developer account id and the numeric app id, which the API does not give (see `apps/web/src/lib/store-links.ts`), so the link-out is the
  Console itself; the public custom-listing address is built from the package name.

## What Kiln builds (from the verified part)

- READ: Apple experiments (state, dates, traffic, review flag, treatments with their locales and asset counts) and custom pages (name, visible, url, versions with state and deep link,
  locales with promotional-text presence and asset counts) into a stored snapshot; no results for Apple; a manual tracker plus link-outs and the public listing address for Google.
- WRITE: not built. The shapes are verified on paper but a safe slice cannot be tested against a real account, the screenshot path moved to the App Asset Library whose endpoints
  were not read, and starting a test spends real traffic and needs a review submission. The design is in docs/adr/0048-store-experiments.md.

## UNVERIFIED list (also in docs/api/experiments.md)

1. The JSON:API `type` strings of the included resources (`appStoreVersionExperimentTreatments`, `appCustomProductPageVersions`, `appStoreVersionExperimentTreatmentLocalizations`,
   `appCustomProductPageLocalizations`, `appAssetLibraryPlacements`): read by the names the pages give, tolerant of unknown ones.
2. That `include` on the list endpoints really returns the related resources with the relationship linkage (`relationships.<name>.data`) and that `limit[...]` as documented works.
3. The attributes of a placement (`placementType`, `mediaType`, `state`) are read from the `fields[...]` list; the values `APP_SCREENSHOT` and `APP_PREVIEW` from the filter list.
4. What `reviewRequired`, `trafficProportion` (an integer percent, 1 to 100?), `controlVersions`, `latestControlVersion` and `promotedDate` mean exactly; whether `startDate` is set before the test runs.
5. Whether the experiment list needs `filter[platform]` (not documented) to separate iOS from macOS: Kiln filters on the `platform` attribute (`IOS`, `MAC_OS`, `TV_OS`).
6. Whether an app that is not live answers an empty list or an error; both are read as "no experiments" for 403 and 404 of the experiment list only.
7. Everything about Apple writes (the order of the calls to create a test, how a start is reviewed, the asset-library calls).
