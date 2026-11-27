# Pending changes and publishing them in one go

Everything an app has pending in one place, and one final step that publishes it. Design: [ADR 0015](../adr/0015-pending-and-batch-publish.md).
Not run against a real store: see [not verified](../adr/0015-pending-and-batch-publish.md#not-verified-unverified). Mounted under
`/api/workspaces/{workspaceId}`; all of it is in `GET /api/openapi.json`.

| Route                                                                             | Needs                                     | Does                                                                                                       |
| --------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /apps/{id}/pending`                                                          | `listing.read`                            | The pending items of the app. Stored state only.                                                           |
| `GET /pending/summary`                                                            | `listing.read`                            | Which apps have something pending. Stored state only.                                                      |
| `GET /store-publish/config`                                                       | `apps.read`                               | The switch, the action, the phrase and each step's switch.                                                 |
| `GET /apps/{id}/pending/cart`, `POST …/pending/publish`, `POST …/pending/discard` | see [the pending cart](#the-pending-cart) | The cart: unsent items, publish and discard a subset.                                                      |
| `GET /pending/cart-summary`                                                       | `listing.read`                            | How many items every app's cart holds (the nav badge). Counts only. See [below](#get-pendingcart-summary). |
| `POST /apps/{id}/publish/preview`                                                 | `store.publish`                           | The plan. Reads the stores through the steps' previews. Writes nothing.                                    |
| `POST /apps/{id}/publish`                                                         | `store.publish` + each step's right       | Runs the plan's steps in order.                                                                            |

## Pending view (read only)

No store and no repository is read, no switch applies, and nothing here is staged, pushed or submitted. `Cache-Control: no-store`;
there is no ETag (no summary in this API has one).

### `GET /apps/{id}/pending`

```json
{
  "pending": {
    "app": { "id": "…", "name": "Weather", "platform": "ios", "store": "appstoreconnect" },
    "platforms": [
      {
        "platform": "ios",
        "store": "appstoreconnect",
        "totals": { "items": 2, "actionable": 2, "blocking": 0 },
        "items": [
          {
            "kind": "listing_text",
            "platform": "ios",
            "id": "listing_text",
            "label": "2 listing text changes in 2 languages",
            "state": "staged",
            "problems": [],
            "nextStep": "push_draft",
            "counts": { "changes": 2, "locales": 2, "invalid": 0 },
            "refs": [{ "id": "…", "locale": "en-US", "field": "description" }],
            "truncated": false,
            "since": 1700000000000
          }
        ]
      }
    ],
    "totals": {
      "items": 2,
      "actionable": 2,
      "blocking": 0,
      "count": 2,
      "stagedUnpushed": 2,
      "awaitingSubmit": 0,
      "awaitingRelease": 0,
      "platforms": ["ios"],
      "nextSteps": ["push_draft", "release"]
    },
    "lastSyncedAt": 1700000000000,
    "publishing": null,
    "lastPublish": null,
    "currentReadiness": null,
    "generatedAt": 1700000000000
  }
}
```

- `kind`: `listing_text` (all staged text changes of the app, one item), `asset_set` (one per staged set), `release_field`
  (notes, release type, build choice and the other release fields; the local-only Play share is not listed),
  `pushed_draft` (a draft pushed and not yet submitted; for Google Play only when the push held listing texts or graphics),
  `draft_release` (Google Play: a draft release in a track that waits for the release step, for example "Draft release in production
  with 1 version code 197, not released yet"; it comes from the push record of this app, so it shows at once, and from the draft
  releases of the last sync: in `production`, or in any track when this app pushed something; `nextStep` is `release`, which needs the
  track and the share typed; releasing it removes it), `in_review` (a version in review: informational), `approved` (an approved
  version waiting for release), `rollout_step` (a due step of a release plan).
- `label` of an `asset_set` names the language: `Feature graphic (en-US): 1 file`, so two sets of two languages are told apart (the platform is the group the item sits in; a release field already carries its locale).
- `state`: `staged`, `invalid` (an error blocks the push), `pushed`, `in_review`, `approved`, `due`.
- `nextStep`: `push_draft`, `submit`, `release`, `rollout`, or `null` (informational). `totals.actionable` counts the items with a
  next step; `totals.blocking` the items with an `error` problem. `refs` hold ids (at most 200, `truncated` says more exist).
- **One projection, one count.** The view, `GET /pending/summary`, `GET /pending/cart-summary`, `GET /apps/{id}/pending/cart`,
  `GET /pending/publishing` and the alert `pending.stale` are views of ONE read of the stored state (`apps/server/src/modules/publish/app-facts.ts`,
  `readAppFacts`); `state-contract.test.ts` keeps them equal. The numbers (`totals` of the view, each line of the summary):
  - `count`: THE pending count: the length of the app's cart: one item per staged text, per staged graphics SET (never a row per file) and per
    staged release field, plus staged prices and reply drafts. What a publish writes. The list above folds the texts of an app into ONE
    `listing_text` item (`counts.changes` says how many): the list is rows to read, `count` is the number to show.
  - `stagedUnpushed`: the staged part of `count` (a row is unpushed when it was never pushed or was edited after its push: `pushed_hash IS NULL OR
    pushed_hash <> value_hash`, `isUnpushed` of `@kiln/core`).
  - `awaitingSubmit`: `1` when a draft was pushed to the store and waits for its SUBMIT, else `0`. It is NOT in `count` (there is nothing to
    publish for it). Every screen says it apart: "waiting to be submitted".
  - `awaitingRelease`: draft releases, approved versions and due rollout steps that wait for a person. Not in `count`.
  - `actionable`, `items`, `blocking` (of `totals` and of each platform): counts of the LIST rows (`actionable`: rows with a next step); do not use
    them as the pending count. `blocking` is a quality of the same items. On a summary line `waiting` is `items - actionable` (informational rows).
- **Changed (state domain, Wave 2):** `count` of a summary line and of `totals` of the summary used to be the number of list rows that wait for
  a step (so 1 for three staged texts, and 1 for a pushed draft with an empty cart). It is now the cart count above, the same number as `cart-summary`
  and the length of `GET /apps/{id}/pending/cart`; the pushed draft and the release steps moved to `awaitingSubmit` and `awaitingRelease`.
  An app with only a pushed draft is still listed (with `count: 0, awaitingSubmit: 1`). Additive: `stagedUnpushed`, `awaitingSubmit`,
  `awaitingRelease`, `currentReadiness` and, on the summary `totals`, `awaitingSubmit` and `awaitingRelease`.
- `currentReadiness`: `null`, or the reading of `GET /apps/{id}/publish/readiness` when one is still fresh (kept 30 seconds). It starts no store read.
  The blockers of `lastPublish` are those of the RUN (history): show `currentReadiness.blockers` when it is not null (see "Why a publish failed").
- What is said about versions is as of the last store sync (`lastSyncedAt`). Never a staged text, a build or a credential.
- `publishing` (additive): `null`, or `{ startedAt, steps, currentStep, stepStartedAt, by }` while a batch publish of this app runs: see [Publishing now](#publishing-now). The same field is on each line of `GET /pending/summary` and in `cart` of `GET /apps/{id}/pending/cart`.
- `404 not_found` for an app that does not exist or is not visible (a token limited to other apps).

### `GET /pending/summary`

```json
{
  "apps": [
    {
      "appId": "…",
      "id": "…",
      "app": { "id": "…", "name": "Weather", "platform": "ios", "store": "appstoreconnect" },
      "count": 2,
      "stagedUnpushed": 2,
      "awaitingSubmit": 0,
      "awaitingRelease": 0,
      "blocking": 0,
      "waiting": 1,
      "kinds": ["listing_text", "in_review"],
      "nextSteps": ["push_draft"],
      "publishing": null,
      "lastPublish": null,
      "currentReadiness": null
    }
  ],
  "totals": { "apps": 1, "count": 2, "blocking": 0, "awaitingSubmit": 0, "awaitingRelease": 0 },
  "generatedAt": 1700000000000
}
```

Only apps with something pending, waiting for a submit or a release, or in review are listed (an app that is not listed has nothing); sorted with blocking first, then
by count and name. `count` is the cart count (see above), `awaitingSubmit` and `awaitingRelease` the steps that wait, `waiting` the informational rows. A token limited to some apps sees
only those apps. An app with a publish running is listed even when it has nothing left pending (`count` 0), and its line carries `publishing`.

## The pending cart

What was prepared here and not sent yet, as one typed list, and a subset publish or discard. Design: [ADR 0054](../adr/0054-pending-cart.md).
It adds no state and no store write of its own: items are adapters over `staged_changes` and `review_reply_drafts`, publishing calls
the push of staged changes and the reply send, and each keeps its switch, right, step-up, claim, re-read and audit.

| Route                             | Needs                                                                 | Does                                                         |
| --------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| `GET /apps/{id}/pending/cart`     | `listing.read`                                                        | The items, with `publishable` and a `reason` per item.       |
| `POST /apps/{id}/pending/publish` | per item: `store.push_draft`, `reviews.reply` or `monetization.price` | Sends the named items. `200` with a result per item.         |
| `POST /apps/{id}/pending/discard` | per item: `changesets.write` or `reviews.triage`                      | Removes Kiln's draft of the named items. No store is called. |

An item without the caller's right is listed (`publishable: false`, `reason.code: no_right`) and skipped by publish. A token also needs
the action in its list (explicit-only actions stay explicit). A non-member gets 404.

### `GET /pending/cart-summary`

The count behind the "Pending" entry of the left navigation ([ADR 0064](../adr/0064-pending-count-and-asset-hint.md)). Stored state only, `Cache-Control: no-store`.

```json
{
  "apps": [
    {
      "appId": "…",
      "id": "…",
      "app": { "id": "…", "name": "Weather", "platform": "ios", "store": "appstoreconnect" },
      "count": 4,
      "kinds": { "listing": 2, "graphics": 1, "review_reply": 1 }
    }
  ],
  "totals": { "apps": 1, "count": 4 },
  "generatedAt": 1700000000000
}
```

- An app's `count` is the length of its own cart (`GET /apps/{id}/pending/cart`: same function, so staged listing texts, graphics sets, release
  fields, prices and reply drafts in a listed state). Only apps with something are listed, most items first, then by name. `kinds` counts per cart kind.
  There is no item, title or text in it. An item the caller may not publish still counts (the cart lists it with a reason).
- Needs `listing.read`; a token limited to some apps sees only those apps (the apps outside are not read); a non-member, or another
  workspace, gets `404` / an empty answer for its own workspace only. At most 200 apps are read per request; apps without a staged change, staged
  price or reply draft cost no cart at all.
- The web app reads it on first paint, on window focus (at most every 30 seconds) and once, debounced, after `kiln:staged-changed`; it does not poll.

### `GET /apps/{id}/pending/cart`

`{ cart: { items, can, publishing, generatedAt } }`. `can` is `{ push, reply, discardStaged, discardReply }` for the caller. An item:
`id` (`<kind>:<id>`), `kind` (`listing`, `graphics`, `release`, `review_reply`), `title`, `summary` (short excerpt of the new text; null
for graphics), `before`, `platform`, `store`, `locale`, `createdAt`, `author { id, name }`, `risk` (`store_draft`: written as a draft,
nothing is submitted; `public_reply`: public at once), `needsApproval` (the step-up policy covers `store.push_draft`), `publishable`,
`reason { code, action?, envName? }` (`no_right`, `switch_off`, `metadata_locked` (the app's live version locks its listing, see staged-changes.md), `invalid`, `bundle_blocked`, `in_progress`, `outcome_unknown`),
`canDiscard`, `bundle`, `version`, `counts` (graphics: `files` after, `uploads`, `before` when a store read of the set is remembered), `thumbs` (graphics: addresses, relative to the server, of up to four uploaded files: `GET /staged/assets/blob?oid=`), `problems`, `ref` (where it was made) and, for replies, `review { rating, excerpt, language,
territory, status }`. Ordered by kind (listing, graphics, release, review_reply), then age. Stored state only; `Cache-Control: no-store`.
Texts and excerpts are shown to people who can already read them in the staged view and the review inbox; they are never audited or put in events.
Not in the cart: pushed drafts waiting for submit, versions in review, approved versions, rollout steps (see [Pending view](#pending-view-read-only)).

### `GET /apps/{id}/pending/cart/detail?id=<kind>:<id>`

The full before and after of ONE cart item, for the row preview of the cart drawer and of the workspace Pending page ([ADR 0067](../adr/0067-diff-and-preview.md)).
Same right as the cart (`listing.read`), stored state only (no store or repository is read), `Cache-Control: no-store`. `{ detail: { id, kind, version, text?, graphics?, reply? } }`:

- `text` (kinds `listing`, `release`): `{ field, locale, before, after, limit, unit, truncated }`. `before` is the text last known in the store (`null`: none stored; always `null`
  for a release field, the store is not read), `after` the staged text, `limit` and `unit` the store limit (`characters` or `bytes`).
- `graphics`: `{ before, beforeReadAt, after, truncated }`. `before` is the images of the set in the last store read this server remembers (`null`: there was none), `after` the staged
  files in order. Each image is `{ position, name, width, height, bytes, url }`; `url` is always a same origin address of Kiln's own routes (`.../staged/assets/blob?oid=` for an upload,
  `.../assets/file?path=&commit=` for a repository file, `.../assets/store/thumb?ref=&size=640` for a store image), never a store address.
- `reply`: `{ text, truncated, review: { rating, title, body, language, territory, truncated } }`, the draft and the review it answers.
- A `price` item carries no extra: its before and after per territory are in the cart item (`price`).

Bounds: a text is cut at 8000 characters (`truncated: true`), at most 30 images per side. `version` is the item's `version` in the cart; the web keeps a detail only for that version.
`404 not_found` when the app is not in this workspace, or the id is not in THIS app's cart (unknown, discarded, published, or another app's or workspace's); `400 invalid_request` for a missing `id`.
Nothing is written and nothing is audited. The workspace Pending page lists the changes of an app by reading `GET /apps/{id}/pending/cart` (lazily, when its row is expanded) and the detail per row;
`GET /pending/cart-summary` stays counts only.

### `GET /apps/{id}/pending/detail?kind=<kind>&id=<id>`

What one item of the [Pending view](#pending-view-read-only) that is NOT a staged change contains, for the row preview of the per-app Pending changes page
([ADR 0067](../adr/0067-diff-and-preview.md)). `kind` is `pushed_draft`, `draft_release`, `in_review`, `approved` or `rollout_step`; `id` is the item's `id` in the view
(`pushed_draft`, `draft_release:<track>:<codes>`, `release:<id>`, `rollout:<id>`). Same right as the view (`listing.read`), stored state only (no store is contacted),
`Cache-Control: no-store`. `{ detail: { kind, id, pushedDraft?, draftRelease?, release?, rolloutStep? } }`:

- `pushedDraft`: `{ versionString, pushedAt, texts: [{ locale, field }], sets: [{ locale, key, kind, device, files }], release: { track, codes } | null, truncated }`: what the push wrote, never a
  text, a file or a hash; at most 200 texts and 200 sets (`truncated`).
- `draftRelease`: `{ track, codes, since }`. `release`: `{ version, track | null, status: in_review | approved, since }` as of the last sync. `rolloutStep`: `{ planVersion, percent, plannedAt }`.
- `404 not_found` when the item is not in THIS app's view now (a staged kind, a wrong kind for the id, another app's or workspace's item, a token limited to other apps); `400 invalid_request` for
  an unknown `kind` or a missing `id`. Nothing is written or audited.

The staged kinds are read as cart items: `listing_text` has one cart item per `refs[].id` (`listing:<ref id>`), `asset_set` is `graphics:<id>` and `release_field` is `release:<id>`, each through
`GET /apps/{id}/pending/cart/detail`. The web page reads the app's cart (`GET /apps/{id}/pending/cart`) for those ids, versions and thumbnails.

### `POST /apps/{id}/pending/publish`

Body `{ "items": [ { "id": "listing:…", "version": "…" } ] }` (1 to 200; id and version as listed). Staged items (`listing`, `graphics`,
`release`) are written by ONE push of the app as a store **draft** (`KILN_STORE_DRAFT_WRITE_ENABLED`, `store.push_draft`, step-up policy:
`403 step_up_required` before anything is read; nothing is submitted). They form a bundle (`bundle`): all items of the bundle must be named
at their listed `version`, or all are skipped. Replies are sent one by one through the reply send (`KILN_REVIEW_REPLY_ENABLED`,
`reviews.reply`, rate limit, claim, read-back).

```json
{
  "result": {
    "results": [
      { "id": "listing:…", "status": "ok", "reason": null },
      {
        "id": "review_reply:…",
        "status": "failed",
        "reason": "store_forbidden",
        "httpStatus": 422
      },
      { "id": "release:…", "status": "skipped", "reason": "not_pending" }
    ],
    "remaining": 1
  }
}
```

`status`: `ok`, `failed` (`reason` is the code the underlying step answered), `skipped` (`not_pending`, `changed_since_review`,
`bundle_incomplete`, or the item's reason code). One failure never blocks the others; repeating a request is safe. Audit `pending.cart_published`
(ids and outcome codes). The underlying steps write their own audit entries and events.

### `POST /apps/{id}/pending/discard`

Body `{ "ids": ["listing:…", "review_reply:…"] }`. Same result shape (`remaining` counts what is still in the cart). Discarding removes the
staged change or the reply draft; a reply in flight or with an unknown outcome is kept. Audit `pending.cart_discarded`.

## Publishing now

While `POST /apps/{id}/publish` runs (it can take minutes: a draft push alone may take four, each step has an 8 minute backstop) the
claim the batch took in `store_publish_claims` says what it is doing. Migration 71 added the steps it runs, the step that runs now and
a heartbeat to that row, so every server instance sees the same.

### `GET /pending/publishing`

```json
{
  "apps": [
    {
      "appId": "…",
      "publishing": {
        "startedAt": 1700000000000,
        "steps": ["push_draft", "submit"],
        "currentStep": "push_draft",
        "stepStartedAt": 1700000000000,
        "by": { "id": "…", "name": "Alex" }
      }
    }
  ],
  "generatedAt": 1700000004000
}
```

One small read of the claims (no pending state is built), meant to be polled every few seconds while something publishes; `listing.read`,
`Cache-Control: no-store`, a token limited to some apps sees only those. Apps that are not listed are not publishing.
`currentStep` is null before the first step starts and between steps; `steps` is empty for a claim older than migration 71. Ids, step
names and times only: never a text.

**Liveness (migration 74).** A running batch renews `heartbeat_at` by a timer every 20 seconds, also while one step waits for the store.
A claim whose last sign of life (`heartbeat_at`, `step_at`, `claim_at`) is older than 2 minutes is a process that died: it is not
reported, it does not block a new publish, and the guards below ignore it. The poll (and the next publish) turn it into a kept run whose
running step failed with `interrupted` and outcome `unknown` ("The publish was interrupted: the server restarted or lost the request.
Check the store, then review again."); the steps that ended applied before stay `applied` (`partial`). A claim also carries the boot id
of the server process that took it (`instance_id`): at start the server ends every claim of another process the same way, so a restart
never leaves a publish that reads as running. One server process runs per database; a second one would have its claims ended at its
start.

`publishing` also has `heartbeatAt`, `stepsDone`, `interruptible` and `detail`: `{ phase, done, total, at }` with `phase` one of
`writing_texts`, `uploading_images`, `processing_images`, `placing_images` (what the running step says it is doing, throttled to one write
every 2 seconds per phase; a fixed word and two counts, never a file name or a store text; null when the step says nothing). Apple pushes
upload a few files of a set at a time and wait for Apple to process each one (at most 20 checks, then `store.apple.processingSlow`: the
file stays in the asset library without a placement and the next push uses it).

### `POST /apps/{id}/publish/interrupt`

For a person who sees "Publishing…" and nothing moves. `store.publish`. Allowed only when the claim says `interruptible` (no heartbeat for
a minute, or running for more than 15 minutes); a batch that is alive and recent is never stopped (`409 still_running`). `404
not_publishing` when none runs. Nothing is sent to a store: the claim is ended and the interrupted run is kept, so the person looks at the
store and reviews again. A batch that is in fact still running goes on; its own writes find no claim.

**Refusals.** While an app is publishing, a second `POST /apps/{id}/publish`, `POST .../store-release`, `.../store-submit`,
`.../rollout/apply`, `.../store-version`, `.../staged/push`, `DELETE .../staged` and `.../staged/items`, `POST .../pending/publish` and
`.../pending/discard` answer `409 publish_in_progress` with `startedAt`, code `publish.inProgress.since` and a message that says since
when (UTC). Previews and reads are not refused. The batch itself calls the services, not these routes, so it is never held up by its own
claim. The web app shows the items as "being published" and disables the buttons that would send these requests.

## Publishing

`KILN_STORE_PUBLISH_BATCH_ENABLED=true` turns the batch on (default `false`). It turns **no step on**: every included step needs its
own switch (`KILN_STORE_DRAFT_WRITE_ENABLED`, `KILN_STORE_SUBMIT_ENABLED`, `KILN_STORE_RELEASE_ENABLED`,
`KILN_STORE_ROLLOUT_ENABLED`) and its own role right. While the batch is off, preview and publish answer `409 publish_batch_disabled`
after the rights check; no store is reached.

| Right                                                                                              | Who                                                                                                                                |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `store.publish`                                                                                    | **admin and up** (owner, admin). **Explicit-only on API tokens.**                                                                  |
| `store.push_draft`, `store.submit`, `store.release`, `releases.rollout`                            | the step's own right, unchanged. A token needs each one it includes **in its actions**, as well as `store.publish`.                |
| `push_and_submit` (Google Play, see [the combined step](#push-and-submit-in-one-step-google-play)) | **both** `store.push_draft` AND `store.submit`, and both switches (`KILN_STORE_DRAFT_WRITE_ENABLED`, `KILN_STORE_SUBMIT_ENABLED`). |

### Push and submit in one step (Google Play)

Step type `push_and_submit` (`order` 2; the steps are `push_draft`, `push_and_submit`, `submit`, `release`, `rollout`, numbered 1 to 5).
Google decides per app whether changes can be kept as a draft: for some apps the commit with `changesNotSentForReview=true` is refused
(`400`, "Changes are sent for review automatically. The query parameter changesNotSentForReview must not be set."), and the draft push
fails as `409 draft_not_allowed` (nothing committed). A person who wanted the changes reviewed anyway is offered the push and the submit as
ONE explicit step: the same edit (texts, graphics, the draft release of the track, in one edit) committed **without** the hold-back, so Google
sends it for review as part of the commit. A draft release stays a draft (no track or rollout is started).

- It is **never a fallback**: a refused draft push stays a failed step, and the combined step runs only when the plan names it
  (`steps: [{ "type": "push_and_submit" }]`), the person confirmed that plan (the typed `phrase`, or the step-up grant for `store.publish`
  bound to the plan hash: it is irreversible like `submit`, `irreversibleSteps` lists it) and every right and switch holds. It cannot share
  a plan with `push_draft` or `submit` (`combined_with_pair`, not confirmable), and it is Google Play only (`blocked` when asked for on
  the App Store, `nothing_to_do` otherwise).
- Its `preview` and `confirmHash` are the push's own (`staged/push/preview`): what the person saw is what is written, and the store is read
  again right before the commit (`state_changed` when it changed; `blocked` for a blocking check). Anything else pending for the app in Play
  Console goes to review with it (a plan warning, `sends_everything_pending`).
- The plan says whether drafts are possible: `plan.combined = { offered, draftRefused, defaulted }`. `draftRefused` is learned from the
  kept runs (`store_publish_runs`): the newest run whose `push_draft` step failed with `draft_not_allowed` (and no later run in which a draft
  push went through). With no `steps` and `draftRefused`, the plan is made with `push_and_submit` instead of `push_draft` + `submit`
  (`defaulted: true`); the pair stays selectable by naming it. `POST .../publish` never defaults: it runs the steps it is given.
- Result and records: the step answers like a push with `commit: "sent_for_review"`, `submitted: true`, `draft: false`. It writes the audit
  entries `listing.draft_pushed` (`commit`, `combined: true`, `submitted: true`) and `listing.submitted` (`via: edit_commit`, `combined:
  true`), the events `listing.draft_pushed` and `listing.submitted`, and `pending.published` lists the step type. A refusal is audited as
  `listing.draft_push_failed` with `combined: true`. No draft record is kept (there is no draft left to submit). A lost answer is
  `outcome_unknown` (Google Play shows no review state): look in Play Console; nothing is sent again until a new plan is confirmed.

### One edit, one commit: `push_and_submit` with `release` (Google Play)

Asked together, `push_and_submit` and `release` are ONE step in the same Play edit (texts, graphics, the release on the track with the
share, `:validate`, one `:commit`), never two sending commits: the plan says `oneCommit: true`, has one irreversibility confirmation, the
union of the rights and switches (`store.release`, `KILN_STORE_RELEASE_ENABLED` as well), and the `release` row says it is carried by the
push. The share is still never implied (`needs_input`). `submit` with `release` is `blocked` (`two_review_commits`). The staged track and
codes must match (`one_commit_release_not_staged`, `one_commit_release_mismatch`). A refusal leaves nothing partial: the edit is deleted.

`push_and_submit` also takes `replaceReview: true`: the commit is sent with `CANCEL_IN_REVIEW_AND_SUBMIT`, which cancels the review in
progress and sends all changes, so the app loses its place in the queue. The plan says `replacesReview: true` (problem `replaces_review`),
has its own `planHash` (a step-up grant for the plain plan does not cover it) and its own confirmation. Without it Kiln always sends
`ERROR_IF_IN_REVIEW`, and Google answers `409 changes_in_review` with nothing applied. After such a failure `recommended` has
`why: "one_commit"` and `replacesReview: true`; it is only a suggestion and nothing runs until the plan is confirmed. See
[ADR 0069](../adr/0069-one-play-commit.md) for the recovery of a half-published state.

### `POST /apps/{id}/publish/preview`

Google Play: without `steps`, when **only release fields are staged** (track, version codes, name, notes; no listing text or graphics),
the plan is ONE `release` step with `direct: true` (`plan.defaultedToDirect: true`, `plan.direct` names the staged track, codes and
intended share; the other steps are `not_requested`); the share is still never implied (`needs_input`). Send `steps:
[{ "type": "push_draft" }]` to save only as a draft. When the push held only release fields, the `submit` step is `nothing_to_do`:
Google Play has nothing to submit for them, the release step sends them to Google.

Every plan carries `recommended` (the step or steps to start from, never an empty plan while a valid step exists) and, on Google Play,
`promotion` (`from`: another track of the app that holds all the staged codes as the last sync saw it, `version`: the version name of a
synced build; both null when the sync does not say). `recommended` is `{ types, steps, why, needsShare }`; `steps` are the requests to send
back (a release in them still needs the person's `userFraction`, which is never implied). The rules, in order:

| Facts (Google Play)                                                                       | `why`                                                                       | `types`                                                                             |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| a build staged for a track, no listing text or graphics, release switch on and right held | `promotion` (the sync shows the codes in another track) or `direct_release` | `release` (direct: one edit, committed without the hold-back, so Google reviews it) |
| texts or graphics staged, a draft was refused by Google last time                         | `draft_refused`                                                             | `push_and_submit`                                                                   |
| texts or graphics, or release fields, staged otherwise                                    | `draft`                                                                     | `push_draft`                                                                        |
| another platform                                                                          | `default`                                                                   | the steps the plan included                                                         |

A step whose switch is off, whose right is missing or that the plan found unavailable is never recommended; none left: `recommended: null`.
A `release` step asked for WITHOUT `direct`, with no draft release to start and a build staged, is `blocked` with that reason (it used to be
`nothing_to_do`, which hid it); the direct release is what to ask for.

Body (optional): `{ "steps": [ { "type": "push_draft" }, { "type": "submit" }, { "type": "release", "track": "production", "userFraction": 0.1 },
{ "type": "rollout", "action": "set_fraction", "track": "production", "versionCodes": ["240"], "userFraction": 0.5 } ] }`.
`release` takes `version` (App Store), or `track`, `userFraction`, optional `versionCodes` and `direct` (Google Play; `direct: true` releases
the staged release fields in one step, see [releases-write](releases-write.md#request-fields-preview-and-release); it cannot share a plan
with a `push_draft` step); `rollout` takes `action`
and the same target fields as [rollout](rollout.md). One step of each type at most; a field a step does not take is `400`
(`422 invalid_steps` for a duplicate). Without `steps`, every step that is available and has work is included (a release or a rollout
needs input, so it is only included when named).

```json
{
  "plan": {
    "app": { "id": "…", "name": "Weather", "platform": "ios", "store": "appstoreconnect" },
    "steps": [
      {
        "type": "push_draft",
        "platform": "ios",
        "order": 1,
        "label": "Push the staged changes to the store as a draft",
        "requested": true,
        "included": true,
        "availability": "available",
        "reason": null,
        "requires": {
          "action": "store.push_draft",
          "envName": "KILN_STORE_DRAFT_WRITE_ENABLED",
          "enabled": true,
          "allowed": true
        },
        "irreversible": false,
        "deferred": false,
        "summary": { "textChanged": 1, "assetSetsChanged": 1 },
        "request": { "type": "push_draft" },
        "preview": { "…": "the preview of POST …/staged/push/preview" },
        "confirmHash": "…",
        "stepPhrase": null,
        "problems": []
      }
    ],
    "publishSteps": [{ "type": "push_draft" }, { "type": "submit" }],
    "included": 2,
    "irreversible": true,
    "irreversibleSteps": ["submit"],
    "warnings": [],
    "confirmable": true,
    "planHash": "…64 hex…",
    "confirmationRequired": true,
    "confirmation": {
      "phrase": "publish Weather 2 steps",
      "instruction": "Type … to publish these 2 steps. …"
    },
    "readAt": 1700000000000
  }
}
```

- `availability`: `available`, `feature_disabled` (the step's own switch is off), `forbidden` (the caller or token lacks the
  step's right), `nothing_to_do`, `blocked` (errors; see `problems`), `needs_input` (for example a Google Play release without a
  track or share), `not_requested`.
- `preview` is exactly what the step's own preview route gives (`push`: `staged/push/preview`, `submit`: `store-submit/preview`,
  `release`: `store-release/preview`, `rollout`: `rollout/preview`), `confirmHash` is its hash and `stepPhrase` the phrase its own
  gate asks for (shown so the person sees what is released; the batch phrase stands in for it).
- `deferred: true` (submit after a push; a Google Play release after a push): the step is previewed again after the earlier steps
  applied, `preview` and `confirmHash` may be null, and `summary` is a **promise** it must keep.
- `confirmable` is true when at least one step is included and every requested step is available. `planHash` is null while it is
  not. `confirmation.phrase` is the ONE phrase to type, present when any included step is irreversible (submit, release, rollout) and the caller has to type it. It is absent (`confirmationRequired: false`, `irreversible` still true) when the workspace's step-up policy covers `store.publish` and the caller is a person with a way to confirm: the step-up grant bound to `planHash` stands in for it (ADR 0019, amended 2026-11-20); the apply route then needs the grant and no `phrase`. Tokens always type it.
- `warnings` carry combinations that are likely to fail (Google Play: submit then release).
- `combined` (Google Play): `{ offered, draftRefused, defaulted }`, see [push and submit in one step](#push-and-submit-in-one-step-google-play).

### `POST /apps/{id}/publish`

Body: `{ "planHash": "…", "phrase": "publish Weather 2 steps", "steps": <the plan's publishSteps> }`.

Checks, in this order, each before anything else is read: the right of every step (`403 forbidden`, `missing` lists the steps and
actions), the switch of every step (`409 step_disabled`), the typed phrase (`422 confirmation_mismatch`, `phrase` holds the one
expected), the lock (`409 publish_in_progress`), then the plan is rebuilt from the same steps: not confirmable is `409 plan_blocked`,
another hash is `409 plan_changed` (both carry the new `plan`). Then the steps run in order.

```json
{
  "result": {
    "app": { "id": "…", "name": "Weather", "platform": "ios", "store": "appstoreconnect" },
    "planHash": "…",
    "completed": false,
    "applied": 1,
    "skipped": 1,
    "failed": 0,
    "stoppedAt": "submit",
    "steps": [
      {
        "type": "push_draft",
        "status": "applied",
        "confirmedByReread": false,
        "result": { "…": "the result of POST …/staged/push" }
      },
      { "type": "submit", "status": "skipped", "reason": "plan_drifted", "message": "…" }
    ],
    "pending": { "items": 1, "actionable": 1, "blocking": 0 },
    "publishedAt": 1700000000000
  }
}
```

- `status`: `applied` (`result` is what the individual route returns), `skipped` (`reason`: `previous_step_not_applied`,
  `plan_drifted`, `blocked` with `checks` codes, `preview_failed` with `code`), `failed` (`error` is the individual error code:
  `state_changed`, `blocked`, `outcome_unknown`, `write_in_progress`, `store_forbidden`, …; `httpStatus`; `outcome`: `refused`,
  `not_applied`, `unknown`, `partial`; `detail` holds the rest of the individual error body, for example a new `preview`).
- The answer is `200` even when a step failed: look at `completed`, `stoppedAt` and `steps`. The batch stops at the first step that
  is not applied and never retries; for `outcome: "unknown"` look at the store, then preview again.
- `pending` is the stored pending state after the batch (no store read).

### Price items (`price:…`, kind `price`, risk `financial`)

A staged price change of one product ([ADR 0062](../adr/0062-price-writes.md), [products](products.md#price-changes)). It is **not** part of the draft
push and has no bundle: each item is sent on its own, a subset is allowed, and one failure never blocks another. The item carries `price`:
`productId`, `planId`, `effectiveDate`, `existingSubscribers`, `acknowledgements`, `currencies`, `largestBp` and `lines[]` (`territory`, `currency`,
`before`, `after` in minor units as text, `percentBp`, `direction`). `needsApproval` is always `true`. Not publishable (`publishable: false`) with
`reason.code` `switch_off` (server switch, `envName` `KILN_PRICE_WRITES_ENABLED`), `workspace_off`, `no_right`, `in_progress`, `outcome_unknown` or
`invalid` (the synced price moved since it was staged).

Publishing one needs, in this order: both switches, `monetization.price`, step-up `store.price` (`403 step_up_required`, before anything is read) and
the body field `confirmation`: the phrase `CHANGE <n> PRICE(S) MAX <p>%` for exactly the price items of the request that can be sent (their number,
and the largest change rounded up to a whole percent). A wrong or missing phrase is `422 confirmation_mismatch` and **nothing of any kind is
sent**. Each item is then claimed (one price write in flight per app), validated again against a LIVE read of the store (`stale_price`,
`currency_mismatch`), written once (never retried) and read back. Its result carries `price`:

```json
{
  "id": "price:…",
  "status": "ok",
  "reason": null,
  "price": {
    "productId": "…",
    "verification": "confirmed",
    "mismatches": [],
    "lines": [
      {
        "territory": "USA",
        "currency": "USD",
        "before": "499",
        "after": "599",
        "outcome": "applied"
      }
    ]
  }
}
```

`verification`: `confirmed` (the read back shows the asked prices: "confirmed by the store"), `store_shows` (it shows other prices: `mismatches` has
`expected` and `actual` per territory), `unverified` (it could not be read) or `not_sent`. Line `outcome`: `applied`, `already_applied`, `failed`,
`unknown`, `not_sent`. `reason`: `partial`, `outcome_unknown`, `write_in_progress`, `stale_price`, `currency_mismatch`, `price_point_invalid`,
`acknowledgement_required`, `invalid_price`, or the store's translated code (`price_change_not_allowed`, `existing_subscriber_rule`,
`unsupported_territory`, `rate_limited`, `forbidden`, `rejected`, `product_not_found`). The draft is removed only when confirmed. Discarding a price
item removes only Kiln's draft (it needs `changesets.write`, like the other staged items; audit `price.discarded`); no store is called. Audit per item: `price.changed` or `price.change_failed`, with the
before and after amounts and the actor.

### What the typed phrase covers

The batch phrase is checked, and bound into `planHash`, for **exactly the steps the plan lists**. Submit and release each have their
own phrase; the batch never invents one: it passes a step the phrase **that step's own preview** produced (recorded in the plan as
`stepPhrase`, re-checked against the fresh preview for a deferred step), only after the batch phrase was typed. Each step still
refuses a hash that does not match the store as it is read right before the write (`409 state_changed`), a blocking check
(`409 blocked`) and a phrase that is not its own. Rollout has no phrase of its own (its `confirmHash` is its gate).

### Audit and events

Audit `pending.published` and the event `pending.published` carry ids, the plan hash, totals and per step outcome codes
(see [events](events.md)). Each step also writes its own audit entry and event.

### Errors

`400 invalid_request` (shape), `403 forbidden`, `404 not_found`, `409 publish_batch_disabled`, `409 step_disabled`,
`409 publish_in_progress` (also from the writes listed under [Publishing now](#publishing-now)), `409 plan_blocked`, `409 plan_changed`, `422 confirmation_mismatch`, `422 invalid_steps`.

## Why a publish failed

The answer of `POST /apps/{id}/publish` used to live only in the browser that sent it. Migration 72 adds `store_publish_runs`: one row per
finished run, the newest five per app (deleted with the app), with when it started and finished, who ran it, the steps, and one result
per step. The result carries what a person needs to act: the error code (`store_rejected`, `state_changed`, `step_timeout`, ...), the HTTP
status of this API, the outcome (`refused`, `not_applied`, `unknown`, `partial`), this server's sentence, the catalogue `code` and `params`
of that sentence or of the store's cause (`store.google.draftApp`), and `store`: the connector's kind of error, the HTTP status the
store answered and up to 13 entries of its own error body (`code`, `title`, `detail`: Google's `reason`, `status` and `message`; Apple's error then its
`meta.associatedErrors` reasons, each with `pointer` and `resource`). A submit the store refused also keeps `blockers` on its step: what Apple said
was missing, mapped by `explainAppleSubmitErrors` (docs/api/submit.md "A refused submit says why"). They are HISTORY like every run blocker.

All of it is sanitised before it is kept, logged or sent: the credential of the app, token-shaped strings (`ya29.`, `eyJ...`, `Bearer ...`,
private keys, any 40 character opaque string) are replaced by `[redacted]`, control characters and runs of white space collapse, the
server's sentence is cut to 500 characters and the store's to 600. A request body, a header or an upload is never kept.

- `lastPublish` in the answer of `POST .../publish`, in `GET /apps/{id}/pending`, in each line of `GET /pending/summary`, and
  `GET /pending/publishing` (`lastPublish: [{ appId, lastPublish }]`) is the LATEST run of an app **when it did not complete** (`outcome`
  `failed` or `partial`); null when the latest run went through, so a later successful publish clears the failure. `dismissed` is true once
  a person hid it (the polling read leaves dismissed runs out).
- `GET /apps/{id}/publish/runs`: the newest five runs, newest first (`listing.read`).
- `POST /apps/{id}/publish/runs/{runId}/dismiss`: hides the failure of that run until a newer run (`store.publish`; `404 not_found` for a run
  that is not the app's). A newer run is never hidden by an older dismissal.
- The server log line of a failed step reads `publish: step 1/2 push_draft failed (store_rejected, refused, http 422, badRequest): Only
  releases with status draft ...` (code, outcome, HTTP status, Google's reason, the store's sentence cut to 200 characters). The audit
  entry `pending.published` carries, per failed step, `code`, `outcome`, `httpStatus` and `cause` (the catalogue code), never a text.

### A submit that did not run: `blocked` with its blockers

A deferred `submit` (or `release`) is previewed again right after the push; when the store's checks block it, the step is `skipped` with
`reason: 'blocked'`. The step now keeps WHAT blocked it: `blockers: [{ code, message, locale?, item? }]` (at most 20; the `message` is this
server's sentence, sanitised), in the answer, in the kept run (`store_publish_runs`, `lastPublish`) and in the server log line
(`publish: step 2/2 submit skipped (blocked: no_build, missing_text fr-FR) after 812ms`: the codes and where, never a store's sentence). A run kept before this existed has none.

The codes of the App Store checks (`store-submit.ts` `evaluateChecks`): `push_in_progress`, `push_outcome_unknown`, `already_submitted`,
`no_version`, `version_changed`, `release_not_manual`, `no_build`, `build_expired`, `build_not_valid`, `draft_unreadable`, `draft_differs`,
`no_locales`, `missing_text`, `text_problem` (a listing text over its limit, under its minimum or a URL that is none: the same check and severity as `validateListing`), `release_notes_too_long`, `image_not_ready`, `no_screenshots`, `asset_spec`, and for the App Store `no_review_contact` and `no_review_demo_account`
(the version's App Review contact and demo account, [review-information](review-information.md); the blocker's `fix.kind` is `review`, with
`params.from` naming the previous version it can be copied from). Kiln does NOT check what Apple also needs for a review beyond that (age
rating, export compliance, pricing, privacy answers): a submit that passes Kiln's checks can still be refused by Apple, and then says so as a
store refusal.

The plan (`POST .../publish/preview`) says BEFORE the push what is already known to block the submit: a version that cannot be submitted, a
build that is missing, expired or not processed (from one read of the store; a push of the staged release fields attaches a build, so the
build codes are not warned about when such a push is staged; the review information codes are not changed by a push). These are `problems` of severity `warning` with the code `submit_will_block_<check code>` (they are not part of `planHash`);
the checks that depend on the push (the draft, texts, screenshots) cannot be known yet and are not listed.

### Current readiness: what blocks the submit NOW (`GET /apps/{id}/publish/readiness`)

The blockers a run kept are HISTORY: true when the run ended, not necessarily now (a person removes screenshots, fills a text, attaches a
build). This read answers what blocks the submit at this moment, with the same pure rules (`@kiln/core` `evaluateDraftContent`,
`predictDraft`, `readinessOf`) from a store read, so the app can drop the blockers that no longer hold.

- Right: `store.submit`. Operation `getStoreSubmitReadiness` (risk `read`). 409 `store_submit_disabled` when the workspace does not submit.
- Answer: `{ readiness: { appId, ready, blockers[], unknown[], predicted, versionString, storeReadAt, cached }, generatedAt }`. `blockers`
  have the shape of a run's, plus `params` and `fix`. For a count over the limit `params` is `{ count, max, device, set }`.
- Cache: the answer is kept 30 seconds per app (`cached: true`). `?fresh=1` (or `true`) drops every store read cache of the app (the store-image
  view, the draft read) and reads again; the "Check again" button sends it.
- It is also dropped by everything that may have changed the store: a push, a submit, a sync (`POST /apps/{id}/sync` re-reads the
  screenshots, not only the texts) and the "Read again" of the Graphics tab (`GET .../store-images?fresh=1`).
- Screenshots are counted PER STORE SET (an App Store placement group: `APP_IPAD_PRO_3GEN_129` and `APP_IPAD_PRO_129` are two sets), never
  summed across the sibling display types that the listing shows as one (iPad 13" / 12.9"). Apple's limit is 10 per set, so 10 + 2 is not 12.
  The message names the set (`... iPad 13" / 12.9" (APP_IPAD_PRO_3GEN_129): 12 found.`), the finding's `item` is `apple.screenshot.count:<set>`.
  A staged replacement of a display removes every other set of that display in that locale, as the push does.

### Causes Kiln names for Google Play

The Google connectors (draft, submit, release, rollout) read the error body (`error.message`, `error.errors[].reason`, `error.status`) and,
when it matches, name the cause with a catalogue code and an actionable sentence (`apps/web/locales/errors`, `store.google.*`), keeping
Google's own words beside it: `draftApp` (only a draft release can be created on an app that was never published), `versionCodeUsed`,
`versionCodeLow`, `notesTooLong` (more than 500 characters per language), `listingIncomplete` (graphics, descriptions, content rating,
data safety), `editConflict`, `releasePermission` (the service account lacks the permission to release to production),
`sendForReview` ("Cannot send for review because ..."). Changes already in review (`CHANGES_ALREADY_IN_REVIEW`) and the commit
refused without `changesNotSentForReview` keep their own codes (`changes_in_review`, `draft_not_allowed`; the latter carries the catalogue code
`store.google.draftNotAllowed`, Google's own sentence in `store.details[0].detail`, and the plan then offers the combined step above). **UNVERIFIED**: Google
documents reasons, not sentences, so the patterns are loose, tested on invented bodies, and an unknown body keeps Google's sentence with
the HTTP status and reason; extend `packages/connectors/src/google/play-causes.ts` when a real body is seen.
