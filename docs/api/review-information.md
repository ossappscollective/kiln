# App Review Information: carried over to a new version, checked before a submit, copied when missing

In App Store Connect the **App Review Information** of a version (the contact first and last name, phone number and email address, the
demo account, the notes) belongs to **one version**. Apple's documentation lists the contact first name, last name, phone number and email
address as what App Review needs ([App Store Review Details](https://developer.apple.com/documentation/appstoreconnectapi/app-store-review-details)).
In the API it is the resource `appStoreReviewDetails`, related to the `appStoreVersion`.

## What Kiln did before this page existed (read from the code)

- Creating a version (`POST /v1/appStoreVersions`) sent only `platform`, `versionString`, `releaseType?` and the app. **Kiln never created,
  copied, read or wrote a review detail**: no `appStoreReviewDetails` request existed anywhere, and the listing read skipped the resource on
  purpose (personal data).
- No check looked at it: Kiln's submit checks had no code for the reviewer contact, so a submit that passed them could still be refused by
  Apple.

So a version created from Kiln had whatever App Store Connect gave a version made through the API. **UNVERIFIED** (no real account was
available): the likeliest explanation of "the contact fields are blank on the version Kiln created" is that Apple does not copy the
previous version's review detail onto a version made through the API, as the App Store Connect website does. Kiln's change is the fix for that
case, whatever the exact cause: it copies the previous version's information onto the new version and refuses to say "ready" when it is
missing.

## What Kiln does now

Everything below is `store.push_draft` work behind `KILN_STORE_DRAFT_WRITE_ENABLED=true`, like creating the version. Routes are under
`/api/workspaces/{workspaceId}`; a non-member gets 404, a member without the right 403; Google Play gets `422 not_supported`.

### 1. Creating a version carries the information over

`POST /apps/{id}/store-version/preview` also returns `reviewInformation`, and `POST /apps/{id}/store-version` carries the information over
right after the version exists:

1. The versions of the platform are already read. The best **source** is chosen: the live version (`READY_FOR_SALE`, `READY_FOR_DISTRIBUTION`),
   then the other versions that cannot be edited, then the editable ones, each newest first, the new version left out; at most 4 versions are
   looked at (`GET /v1/appStoreVersions/{id}/appStoreReviewDetail`). The first whose detail holds any text is the source.
2. The new version's own detail is read. If it has none, one is created: `POST /v1/appStoreReviewDetails` with the source's non-blank
   attributes and the `appStoreVersion` relationship. If it has one, **only its blank attributes are patched**
   (`PATCH /v1/appStoreReviewDetails/{id}`): a value that is already filled in is never overwritten, a whitespace-only value counts as blank.
   `demoAccountRequired` is copied only when the new detail does not say (or is an untouched default `false` with no text at all).
3. **Attachments are not copied** (they are not read either).
4. It never fails the create: the version stays created. A failure, or a source that does not exist, is `reviewInformation.outcome` and a
   warning (`review_information_not_copied`, `review_information_missing`).

`reviewInformation` is `{ outcome, from, fieldsCopied, summary, code? }`:

| Field          | Meaning                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `outcome`      | `created`, `merged`, `already_complete`, `no_source`, `failed`, `not_read`. In a preview: what would happen.                              |
| `from`         | The version string it comes from (`1.19.0`), or null.                                                                                     |
| `fieldsCopied` | How many attributes are written (a count).                                                                                                |
| `summary`      | The SOURCE as a screen may show it: `{ contact: "M. G.", phone, email, demoAccount, demoCredentials, notes }`: initials and yes/no only. |
| `code`         | `failed`: the kind of the failure (`store_rejected`, `network`, ...).                                                                     |

### 2. The submit checks `no_review_contact` and `no_review_demo_account`

Judged by one pure rule (`evaluateReviewInformation` in `@kiln/core`), from **presence facts** read with the submit state (one extra
`GET .../appStoreReviewDetail` of the editable version, in the same read as the rest). The values themselves are never kept: the connector
returns booleans only.

- `no_review_contact` (blocking): the version has no review detail, or the first name, last name, phone number or email address is missing or
  blank (whitespace only). `params.missing` lists the attributes (`contactFirstName,contactPhone`); `params.from` names the previous version
  the information can be copied from, when there is one. Fix kind `review`.
- `no_review_demo_account` (blocking): the detail says `demoAccountRequired: true` and the demo user name or password is blank.
- A version already in review, Google Play, and a read that failed or came back with no resource are **not judged**: the checks say nothing
  rather than guess.

They are in the submit preview `checks` (`POST /apps/{id}/submit/preview`), in the `readiness.submit.blockers` of the publish plan (with
`fix: { kind: 'review', href: null }`), in the `blockers` kept with a skipped submit step, and so in the failure block and in what the app
state model counts as blockers. The 16 earlier codes are unchanged.

### 3. The repair: copy the information to a version that already exists

For a version made before this existed (or one whose copy failed).

`POST /apps/{id}/review-information/preview` (right `store.push_draft`, a store READ, writes nothing). Needs exactly one editable version
(`409 no_editable_version`, `409 several_editable_versions`). Returns `{ preview }`:
`{ app, version { versionString, state }, reviewInformation, canCopy, confirmHash, note }`. `canCopy` is true when something would be written
(`created` or `merged`); `confirmHash` is null otherwise. Masked as above.

`POST /apps/{id}/review-information` with `{ confirmHash }`. Needs the right, the switch and, when the workspace covers `store.push_draft` with
a [step-up](step-up.md), the confirmation (grant bound to the app and the `confirmHash`). The store is READ AGAIN: a different state, or nothing
left to copy, is `409 state_changed` with a new `preview`. One write per app and platform at a time, shared with the draft push and the version
create (`409 write_in_progress`); refused while a batch publish of the app runs. It is **idempotent** (blank attributes only), so it can be done
again after a timeout. Apple's refusal is `502 store_rejected` with `cause` (the kind) and no value: Apple's own sentence is left out because it
may quote the value that was refused. Returns `{ result: { app, version, reviewInformation, copiedAt, note } }`.

In the web app the button "Copy review information from 1.19.0" sits next to these blockers: in the submit checklist ("Fix the blockers, then
submit" opens it) and in the publish plan's readiness list. It first shows the masked source ("Contact: M. G., phone and email present."), then
copies.

## Personal data

A contact name, phone number, email address, demo account user name or password and a note are **never** written to a log, an audit entry, a
run, an error, an API answer or the browser. The server reads them to copy them (one server-side step), every value read is added to the redaction
set of the HTTP client, and what leaves is counts, outcomes, the source's version string and the masked summary (initials, yes/no).

**Audit**: `store.version_created` carries `reviewInformation { outcome, fromVersion, fromVersionId, fieldsCopied, code? }`;
`store.review_information_copied` / `store.review_information_copy_failed` carry `versionId`, `versionString`, `outcome`, `fromVersion`,
`fromVersionId`, `fieldsCopied`, `code`, `hash`. No event is emitted.

## UNVERIFIED: check with a real account

- Every request body and path of `appStoreReviewDetails` follows Apple's JSON:API form and was only run against fakes (no network when this was
  written): `GET /v1/appStoreVersions/{id}/appStoreReviewDetail`, `POST /v1/appStoreReviewDetails` (`attributes`: `contactFirstName`,
  `contactLastName`, `contactPhone`, `contactEmail`, `demoAccountRequired`, `demoAccountName`, `demoAccountPassword`, `notes`; relationship
  `appStoreVersion`) and `PATCH /v1/appStoreReviewDetails/{id}`. A 404 or an empty `data` is read as "the version has none".
- Whether Apple fills a review detail itself for a version made through the API (then the copy is a `PATCH` of its blank attributes, which is
  handled), and whether it returns the demo account password in a read (it is copied only when it does).
- That a key of the role Kiln already needs may write the review detail.
