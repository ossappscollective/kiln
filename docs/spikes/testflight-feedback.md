# Spike: TestFlight beta feedback and crash submissions (App Store Connect API)

Read 2026-11-22 on the official pages. The Apple reference pages are JavaScript pages: the readable form is the JSON behind them
(`developer.apple.com/tutorials/data/documentation/appstoreconnectapi/<page>.json`), which lists endpoints, parameters, allowed values,
schema names and the attributes of each object (names and types), but NOT descriptions of attributes and NEVER a real response. No real
Apple account was available, so no response was seen from App Store Connect. Everything below is VERIFIED (read on the page named) or
UNVERIFIED. The build rests on the VERIFIED parts only; UNVERIFIED shapes are parsed tolerantly and listed in
[api/testflight-feedback](../api/testflight-feedback.md#unverified-check-with-a-real-account).

## Endpoints (VERIFIED)

Group pages: [Beta feedback screenshot submissions](https://developer.apple.com/documentation/appstoreconnectapi/beta-feedback-screenshot-submissions),
[Beta feedback crash submissions](https://developer.apple.com/documentation/appstoreconnectapi/beta-feedback-crash-submissions). Available
since App Store Connect API 4.0.

| Method and path | Use |
| --- | --- |
| `GET /v1/apps/{id}/betaFeedbackScreenshotSubmissions` | list an app's screenshot feedback |
| `GET /v1/apps/{id}/betaFeedbackCrashSubmissions` | list an app's crash submissions |
| `GET /v1/apps/{id}/relationships/betaFeedback...Submissions` | ids only (not used) |
| `GET /v1/betaFeedbackScreenshotSubmissions/{id}` | one screenshot feedback |
| `GET /v1/betaFeedbackCrashSubmissions/{id}` | one crash submission |
| `GET /v1/betaFeedbackCrashSubmissions/{id}/crashLog` | the crash log of a submission (resource `betaCrashLogs`; `fields[betaCrashLogs]=logText`) |
| `GET /v1/betaFeedbackCrashSubmissions/{id}/relationships/crashLog` | the crash log id (not used) |
| `GET /v1/betaCrashLogs/{id}` | a crash log by its id (not used) |
| `DELETE /v1/betaFeedbackScreenshotSubmissions/{id}`, `DELETE /v1/betaFeedbackCrashSubmissions/{id}` | delete feedback (NOT built: Kiln is read only toward the store) |
| `GET /v1/builds/{id}/preReleaseVersion` | the version of a build (`fields[preReleaseVersions]=version,platform`) |
| `GET /v1/apps/{id}/preReleaseVersions` | an app's prerelease versions (`fields[preReleaseVersions]=version,platform,builds,app`, `limit` max 200; no filter or sort documented) |

Webhooks: Apple can notify a server of new feedback ([Webhook notifications](https://developer.apple.com/documentation/appstoreconnectapi/webhook-notifications)).
The event type names were not read (UNVERIFIED); Kiln does not use webhooks: it reads (a sync), like every other Apple read.

## List parameters (VERIFIED, both list endpoints identical)

`limit` max **200**. `sort`: `createdDate`, `-createdDate`. `include`: `build`, `tester`. Filters (all `[string]`): `filter[appPlatform]` and
`filter[devicePlatform]` (`IOS`, `MAC_OS`, `TV_OS`, `VISION_OS`), `filter[build]`, `filter[build.preReleaseVersion]`, `filter[deviceModel]`,
`filter[osVersion]`, `filter[tester]`. Sparse fields: `fields[betaFeedbackScreenshotSubmissions]` / `fields[betaFeedbackCrashSubmissions]`,
`fields[builds]` (`version`, `preReleaseVersion`, `uploadedDate`, ... `app`, ...), `fields[betaTesters]` (`firstName`, `lastName`, `email`,
`inviteType`, `state`, ...). Response codes 200, 400, 401, 403, 404, 429 (`ErrorResponse`). Paging: Apple's usual `links.next` (the page does
not describe it; Kiln follows it like every other list, UNVERIFIED for these two). Whether comma separated filter values are accepted is not
said. There is no filter on creation date: Kiln reads newest first and stops after a cap.

## Attributes (VERIFIED names and types; no descriptions on the pages)

Both submission kinds: `createdDate` (date-time), `comment`, `email`, `deviceModel`, `osVersion`, `locale`, `timeZone`, `architecture`,
`connectionType` (`WIFI`, `MOBILE_DATA`, `WIRE`, `UNKNOWN`, `NONE`), `pairedAppleWatch`, `appUptimeInMilliseconds` (int64),
`diskBytesAvailable`, `diskBytesTotal` (int64), `batteryPercentage`, `screenWidthInPoints`, `screenHeightInPoints`, `appPlatform`,
`devicePlatform` (`Platform`: `IOS`, `MAC_OS`, `TV_OS`, `VISION_OS`), `deviceFamily` (`IPHONE`, `IPAD`, `APPLE_TV`, `APPLE_WATCH`, `MAC`, `VISION`),
`buildBundleId`. Screenshot submissions add `screenshots`: an array of `{ url, width, height, expirationDate }` (the object is
`BetaFeedbackScreenshotImage`; names and types read, **the host of `url` and the lifetime of the link are UNVERIFIED**; the field is
`expirationDate`, so the links expire). Relationships on both: `build`, `tester`; crash submissions also `crashLog`. `betaCrashLogs` has one
attribute, `logText` (string).
A build (`builds`) has `version` (the build number, as a string) and a relationship `preReleaseVersion`; a `preReleaseVersions` resource has
`version` (the marketing version) and `platform`.

## Role of the API key (VERIFIED)

Both pages: `ADMIN`, `APP MANAGER` or `DEVELOPER`; both Team and Individual keys work. The same roles as the keys Kiln asks for elsewhere,
but a key with e.g. `MARKETING` or `CUSTOMER_SUPPORT` is refused (403). App Store Connect itself shows feedback to Account Holder, Admin,
App Manager, Developer and Marketing ([Help: View tester feedback](https://developer.apple.com/help/app-store-connect/test-a-beta-version/view-tester-feedback)).

## An app without TestFlight use, a key without the role (UNVERIFIED)

Not documented. The pages list 403 and 404 for the list endpoints with no explanation. Kiln treats 403 and 404 on the lists as "nothing
readable" (a warning, an empty result, the stored copy kept), as it does for experiments, and treats an empty `data` as "no feedback yet". The
screen explains both requirements (the app must have been distributed with TestFlight; the key's role). A 404 on one crash log is a log that is
gone (the stored row keeps no log).

## Retention (VERIFIED, two sources that differ)

- [TestFlight & Privacy](https://www.apple.com/legal/privacy/data/en/test-flight/): "Apple keeps beta feedback for one year" (crash logs and
  usage data "may be kept until bugs are resolved").
- Help: View tester feedback: "Crash reports can be downloaded for 120 days". No period for screenshot feedback.
So the API may stop returning an item after 120 days (crash log) or one year (feedback): Kiln stores what it has read and keeps it until its
own retention (`KILN_REVIEW_RETENTION_DAYS`, the same setting as reviews), so a sync more often than every 120 days keeps the log. Items
deleted in App Store Connect are NOT removed from Kiln (no deletion signal is read); the retention removes them.

## Tester identity and privacy (VERIFIED)

Help: an invited tester's email is shown in the detail view in App Store Connect; a tester who joined through a public link is anonymous unless
they typed an email into that feedback. The privacy page: feedback "may be linked to your name and email address"; testers who joined by public
link are not visible to the developer. The API exposes `email` as an attribute of each submission and `betaTesters.firstName/lastName/email` by
include. Decision (ADR 0049): Kiln stores the email of the submission (nullable), never the tester's name, and only an administrator (`settings.write`)
is shown it; everybody else sees a stable pseudonym derived from it ("Tester 3FA9C1") that still filters and groups. The comment is free
text written by a person: personal data of a third party, never logged, audited or put in an alert.

## Screenshot links (VERIFIED: expire; UNVERIFIED: host)

The response carries `expirationDate` per image, so links expire. Kiln's CSP is `img-src 'self' data:` (apps/server/src/app.ts `SECURE_HEADERS`):
an `<img>` of an Apple address would be blocked, and the host is unverified so it must not be added to the policy. Decision: store only
the size (width and height) and the count, never the link; the screen shows the count and offers "Open screenshot" (a plain link, which a CSP
does not restrict) after a read on demand of that one submission (`GET /v1/betaFeedbackScreenshotSubmissions/{id}`), plus a link to App
Store Connect.

## Crash logs (UNVERIFIED format)

`logText` is a string; whether it is symbolicated is not said (the privacy page lists "symbolicated crash logs" among the beta data Apple
collects, which is not a promise for each log). Kiln says neither: it shows the text as it is, with a note that frames may be addresses
when the build's symbols were not available. Grouping is derived from the text by a documented, deterministic rule (the exception type
line and the first frame of the crashed thread in Apple's usual `.crash` text layout); a log in another layout has no signature and is
grouped under "unknown" only by build.

## Not verified at all

- Any real response (field presence, null handling, paging links, the ordering of `included`).
- The host and lifetime of screenshot links; the layout of `logText`.
- The webhook event names. The behaviour of an app with no TestFlight use. Whether `filter[build]` takes the build id or the build number.
