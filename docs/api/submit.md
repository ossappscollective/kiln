# Submit the pushed draft for store review (a store write, irreversible, off by default)

Hands the draft that was [pushed](staged-changes.md) to the store to **the store's review**: an App Review
submission of the editable App Store version, or a Google Play commit that sends the held back changes for review.
It is a different action from pushing a draft and has its own switch, its own right and its own confirmation.
Design and the arguments: [ADR 0010](../adr/0010-store-submit.md).

- **It cannot be taken back from this server.** A submission is cancelled only in App Store Connect, a review
  is cancelled only in Play Console.
- **It never releases anything.** Releasing is a separate step with its own switch and right ([releases-write](releases-write.md)). An App Store version stays unreleased after approval until somebody
  releases it in App Store Connect; a version whose release type is not manual is _blocked_, not changed. Google
  Play tracks are read, never written: a submit cannot start, raise or complete a rollout.
- **Never run against a real store**: the connectors are tested with fakes only. See
  [UNVERIFIED](#unverified-check-with-a-real-account).

Routes are under `/api/workspaces/{workspaceId}`. A non-member gets 404, a member without the right gets 403. For
`preview` and `submit` the kill switch is checked after the rights check, before anything else.

## Switch and right

| Setting                     | Value                                                                                                                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KILN_STORE_SUBMIT_ENABLED` | Default `false`; only `true` and `false`; blank is off. **Independent of** `KILN_STORE_DRAFT_WRITE_ENABLED`: drafts on does not turn submitting on. See [deployment](../deployment.md#submitting-a-draft-for-store-review-a-store-write-off-by-default). |
| `store.submit`              | **admin and up** (owner, admin). Explicit-only on API tokens: the token's `actions` must name it (a token with no list never gets it) and the role ceiling still applies. Not `store.push_draft`: being allowed to push is not being allowed to submit.  |

## The flow

1. Stage and **push** a draft ([staged-changes](staged-changes.md)). A successful push records what it wrote
   (hashes and ids only, `store_draft_pushes`); later pushes of the same version merge into the record.
   A refused or partial push records nothing.
2. `POST .../store-submit/preview`: reads the store, shows what would go to review, the checks, and gives a
   `confirmHash` and the **phrase to type**. Writes nothing.
3. `POST .../store-submit` with `confirmHash` and `confirmation` (the typed phrase). The store is read again
   right before the write.

No push recorded (or one already submitted): `409 nothing_pushed`. A successful submit deletes the record: a
second submit needs a second push.

## `GET /store-submit/config`

Needs `apps.read`. `{ enabled, envName, action: "store.submit", minimumRole: "admin", irreversible: true,
releases: false, note }`.

## `GET /apps/{id}/store-submit`

Needs `store.submit`. **Reads the database only**, works with the switch off. `{ submit: { enabled, pushed,
push { pushedAt, pushedBy, versionString, texts, assetSets } | null, inFlight { submit, push },
unknownOutcome { submit, push } } }`.

## `POST /apps/{id}/store-submit/preview`

Needs `store.submit` and the switch. Body `{}`. Reads the store; a successful read also settles an unknown outcome
of an earlier submit. Returns `{ preview }`:

- `app { id, name, platform, store }`.
- `version`: App Store `{ id, versionString, state, releaseType }`; Google Play `null`.
- `build`: App Store `{ id, version, processingState, expired }` or `null`; Google Play `null`.
- `contents`: `locales[] { locale, textFields, screenshotSets[] { target, device, images } }` (counts, never
  text), `pushed { pushedAt, pushedBy, texts, assetSets }`, `includesChangesNotPushedHere` (Google Play: `true`:
  changes made in Play Console go to review too and Google lists none of them).
- `tracks[] { track, releases[] { name, status, userFraction, versionCodes } }`: Google Play, **read only**.
- `irreversible[]`: sentences for the confirmation dialog: what cannot be undone from here.
- `submits: true`, `releases: false`.
- `checks { blocking[], warnings[], canSubmit }`; each item `{ code, severity, message, locale?, item?, rule?,
  source?, verified? }`.
- `confirmHash` and `confirmation { phrase, instruction }`: **both `null` while anything blocks.**
- `readAt`.

### Typed confirmation (for the screen)

Show `irreversible[]`, the version and build, the checks, then an input that must equal `confirmation.phrase`
(`submit <store identifier>` plus ` <version>` for the App Store, for example `submit com.acme.app 2.1`).
Enable the button when it matches; send `{ confirmHash, confirmation }`. The server compares again (surrounding
spaces are ignored, case is not) and refuses a different text with `422 confirmation_mismatch` before it reads
or writes anything.

### Checks

A version set to release **automatically after approval** (or by a schedule) can be submitted: that is the person's own setting in App Store Connect. The preview carries the warnings `releases_after_approval` / `releases_by_itself` (the version goes live once Apple approves it, with no further step here). This server still releases nothing itself, and `releases` stays `false`.

Blocking (nothing can be submitted until fixed): `draft_differs` (the store's draft no longer holds what was
pushed: text or screenshots; `locale`, `item`), `version_changed` (the editable version is not the one pushed
to), `no_version`, `already_submitted`, `release_not_manual` (App Store only: the release type of the version could not be read), `no_build`, `build_expired`, `build_not_valid`, `no_locales`,
`no_screenshots`, `missing_text` (a field the listing specs mark as required and verified is empty),
`image_not_ready` (an image that is not processed), `asset_spec` (a documented spec is broken: sizes and counts
as the store lists them, `rule` and `source` are those of the spec; only a _verified_ rule blocks),
`draft_unreadable`, `push_in_progress`, `push_outcome_unknown`, `no_review_contact` (App Store: the version's App Review contact first and last
name, phone number or email address is missing or blank; `params.missing`, `params.from`) and `no_review_demo_account` (a demo account is required and its user name
or password is blank). The last two are judged from presence facts only and are not judged when the review information could not be read
([review-information](review-information.md)).

Warnings: `locale_without_screenshots`, `missing_text` / `asset_spec` for unverified rules, `open_review_submission`
(App Store: unsubmitted review submissions exist; this server makes its own), `play_review_state_unknown`,
`play_pending_changes`, `play_rollout_in_progress` (Google Play; a submit does not change it).

## `POST /apps/{id}/store-submit`

Body `{ confirmHash, confirmation }` (64 lower-case hex characters and the typed phrase; anything else is `400`).
Returns `{ result }`: `{ app, version { id, versionString } | null, submission { id, state } | null, via
(review_submission|edit_commit), submitted: true, released: false, confirmedByReread, submittedAt, note }`.

What happens, in this order: rights, switch, the typed phrase, the recorded push, a push in flight, the claim, the
credential, then **one read of the store** inside the connector. If a check blocks or the store is not what was
previewed, nothing is written. Otherwise exactly one submit is sent. **It is never retried**, not even on a 429.

- **App Store:** `POST /v1/reviewSubmissions`, `POST /v1/reviewSubmissionItems` with the version, then `PATCH
  /v1/reviewSubmissions/{id}` with `submitted: true`. Only the last request is irreversible; if one of the first two
  fails nothing was submitted (an unsubmitted review submission may remain in App Store Connect).
- **Google Play:** `edits.commit` of a fresh edit **without** `changesNotSentForReview` and with
  `changesInReviewBehavior=ERROR_IF_IN_REVIEW` (a review in progress is never cancelled). No track, listing or image
  is written.

| Status | `error`                                                                                     | Meaning                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 409    | `store_submit_disabled`                                                                     | The kill switch is off.                                                                                                       |
| 409    | `nothing_pushed`                                                                            | No successful draft push is recorded.                                                                                         |
| 422    | `confirmation_mismatch` (`phrase`)                                                          | The typed text is not the phrase. Nothing was read or written.                                                                |
| 409    | `blocked` (`checks`)                                                                        | A blocking check stands on the fresh read. Nothing was submitted.                                                             |
| 409    | `state_changed` (`preview`)                                                                 | The store is not what was previewed (version, build, listing, draft, tracks). Nothing was submitted; confirm the new preview. |
| 409    | `write_in_progress`                                                                         | A submit, or a draft push, for this app is running.                                                                           |
| 409    | `push_outcome_unknown`                                                                      | The last draft push has an unknown outcome. Preview that push again first.                                                    |
| 409    | `outcome_unknown`                                                                           | The submit's answer was lost and could not be settled (see below). Look in the console, then preview again.                   |
| 502    | `write_failed` (`outcome: not_applied`)                                                     | App Store: the store did not answer, and reading it back shows the version was not submitted.                                 |
| 409    | `changes_in_review`                                                                         | Google Play: changes are already in review; nothing was sent.                                                                 |
| 422    | `no_editable_version`, `store_auth`, `store_forbidden`, `store_not_found`, `store_rejected` | The store refused; the message is redacted.                                                                                   |
| 429    | `rate_limited`                                                                              | `Retry-After` is set. Never retried here.                                                                                     |
| 502    | `store_unavailable`                                                                         | Network or 5xx before anything was sent.                                                                                      |
| 504    | `timeout`                                                                                   | A read did not answer in time.                                                                                                |
| 422    | `credential_*`, `app_not_synced`                                                            | The credential is of the wrong kind, cannot be read, or the App Store id is unknown.                                          |

### A refused submit says why (`explain`)

Apple answers a version that cannot be reviewed with `409 STATE_ERROR.ENTITY_STATE_INVALID` ("This resource cannot be reviewed, please check
associated errors to see why"); the reasons are in `errors[].meta.associatedErrors`, keyed by resource (`/v1/appStoreReviewDetails/<id>`).
The connector keeps each as an entry of `store.details` (up to 13: Apple's own error, then the reasons): `code`, `title`, `detail`, `pointer`
(`source.pointer`) and `resource` (the KIND of resource, the id is dropped). The refusal body adds

```json
{ "error": "store_rejected", "message": "Apple refused (409). Apple's reasons: The content rights declaration is not set.",
  "explain": { "source": "apple", "blockers": [{ "code": "apple_content_rights", "message": "The content rights declaration is not set." }] } }
```

`explain.blockers` are the ONE core mapper's answer (`explainAppleSubmitErrors`, `@kiln/core`): a table of rules that reuses the readiness
codes where a check exists (`no_review_contact`, `no_review_demo_account`, `no_build`, `build_expired`, `build_not_valid`, `no_screenshots`,
`already_submitted`) and adds `apple_age_rating`, `apple_content_rights`, `apple_export_compliance`, `apple_privacy_policy`, `apple_copyright`,
`apple_pricing`, `apple_category`, `apple_privacy_labels`; a reason no rule knows is `apple_reason` with Apple's own words and its resource.
`source` is `apple` (Apple listed reasons), `read` (it listed none, so Kiln read the usual suspects read-only through
`readCompliance`: content rights, age rating questions still null, the build's compliance, the privacy policy URL, the primary category;
an empty `blockers` then means nothing Kiln can read is missing, the reason is one only App Store Connect shows) or `none` (nothing could be
read). The run keeps the blockers on the failed step (`lastPublish.results[].blockers`, HISTORY: current readiness is shown separately).
`GET /apps/{id}/publish/readiness` carries the same compliance codes (read-only, App Store only) so they are said BEFORE a push. Kiln cannot
write these fields (content rights, age rating, privacy labels...): the blocker names the App Store Connect page.

### An unknown outcome

A lost answer or a 5xx on the submit is **read back, not repeated**:

- App Store: the version is in review now (`200`, `confirmedByReread: true`, `submission` is `null`: the id was
  lost with the answer), or it is not (`502 write_failed`, `not_applied`), or the store cannot be read
  (`409 outcome_unknown`).
- Google Play shows **no review state** through its API, so reading cannot settle it: the answer is always
  `409 outcome_unknown`. Check Play Console. Google itself refuses a second send while changes are in review
  (`changes_in_review`), which is why a new preview and a new confirmation are allowed afterwards.

`outcome_unknown` blocks submitting this app until a **preview** has read the store successfully.

## Audit and events

Audit: `listing.submitted` (`appId, store, platform, versionId, buildId, submissionId, via, confirmedByReread,
hash`), `listing.submit_failed` (`code`, `outcome`: `refused`, `failed` or `unknown`, ids and the hash), and
`credential.use` with purpose `store.submit`. Event: [`listing.submitted`](events.md) (`appId, store, platform,
versionString?, submissionId?, via, released: false, confirmedByReread, actor`). Never a text, a credential, a token
or a store response body.

## UNVERIFIED (check with a real account)

Read on Apple's and Google's pages on 2026-11-18: the names `reviewSubmissions`, `reviewSubmissionItems` (with the
relationships `reviewSubmission` and `appStoreVersion`), "Create/Modify a Review Submission", the build of a version,
and Play's `edits.commit` with `changesNotSentForReview` and `changesInReviewBehavior` (`ERROR_IF_IN_REVIEW`). Not
verified (nothing was run):

- App Store: the shape of `meta.associatedErrors` and the attribute names read by `readCompliance` (`contentRightsDeclaration`, the null questions
  of `ageRatingDeclarations`, `usesNonExemptEncryption`, `privacyPolicyUrl`, `primaryCategory`) are Apple's documented ones, built into fixtures, never
  seen in a live answer; the request bodies of the three review submission calls (Apple's pages for them are almost empty), the
  `releaseType` values, the states in which a version counts as "in review", the build attributes, the filter used to
  count unsubmitted review submissions.
- Google Play: whether a commit of an edit with no change of its own sends the changes an earlier push held back
  (Google says held changes are "added to any other unsent changes"); whether held back changes show in a later
  edit (the server's re-read, and so `draft_differs`, depends on it); that no API call shows the review state.
