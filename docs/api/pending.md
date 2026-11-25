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
      "platforms": ["ios"],
      "nextSteps": ["push_draft", "release"]
    },
    "lastSyncedAt": 1700000000000,
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
- The summary (`GET /pending/summary`) and this view are built from the same items by the same rule, so `count`, `waiting` and `blocking`
  of an app's summary line equal `totals.actionable`, `totals.items - totals.actionable` and `totals.blocking` of its view at the same
  moment. The web app shows the banner and the chips from the newer of the two reads and reads the view again when the summary is
  newer and says something else.
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
      "blocking": 0,
      "waiting": 1,
      "kinds": ["listing_text", "in_review"],
      "nextSteps": ["push_draft"]
    }
  ],
  "totals": { "apps": 1, "count": 2, "blocking": 0 },
  "generatedAt": 1700000000000
}
```

Only apps with something pending or in review are listed (an app that is not listed has nothing); sorted with blocking first, then
by count and name. `count` is the items that wait for a step, `waiting` the informational ones. A token limited to some apps sees
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

**Expiry.** Every step start and end renews the claim (`step_at`). A claim nobody touched for 15 minutes (more than a step's backstop) is a
process that died: it is not reported, it does not block a new publish (which takes it over), and the guards below ignore it.

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

| Right                                                                   | Who                                                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `store.publish`                                                         | **admin and up** (owner, admin). **Explicit-only on API tokens.**                                                   |
| `store.push_draft`, `store.submit`, `store.release`, `releases.rollout` | the step's own right, unchanged. A token needs each one it includes **in its actions**, as well as `store.publish`. |

### `POST /apps/{id}/publish/preview`

Google Play: without `steps`, when **only release fields are staged** (track, version codes, name, notes; no listing text or graphics),
the plan is ONE `release` step with `direct: true` (`plan.defaultedToDirect: true`, `plan.direct` names the staged track, codes and
intended share; the other steps are `not_requested`); the share is still never implied (`needs_input`). Send `steps:
[{ "type": "push_draft" }]` to save only as a draft. When the push held only release fields, the `submit` step is `nothing_to_do`:
Google Play has nothing to submit for them, the release step sends them to Google.

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
