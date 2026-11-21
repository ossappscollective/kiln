# API: release plans and checklist templates

Planning data in our own database. **Nothing here reads a store with a credential or writes to
one**; no store write exists anywhere in the product yet. This is groundwork for the later phases
that prepare and submit releases (the planning half of Phase 4): a person plans a version here, then
does the store step in App Store Connect or Google Play Console.

Everything is under `/api/workspaces/:workspaceId`, needs a session, and follows the usual rules: a
non-member (or an unknown workspace, app, plan, item or template) gets `404 {"error":"not_found"}`,
a member without the right gets `403 {"error":"forbidden"}`, a bad body gets
`400 {"error":"invalid_request","issues":[{"path":"version","message":"..."}]}`, no session gets
`401`, a body over the limit gets `413 {"error":"payload_too_large"}`. Times are epoch
milliseconds; a target date is a calendar day written `YYYY-MM-DD`. Every change is audited.

## Rights

| Action                                                                          | viewer | member | admin / owner |
| ------------------------------------------------------------------------------- | ------ | ------ | ------------- |
| `plans.read`: read plans, checklists, release notes and templates               | yes    | yes    | yes           |
| `plans.write`: create, change and delete plans, checklists, notes and templates | no     | yes    | yes           |

Why: a plan is coordination data that mirrors what everyone who can read the portfolio already
sees, nothing in it is a secret, nothing in it reaches a store, and every change is audited. So
viewers read it and members (who already sync apps and draft listing changes) write it. Templates
need the same right: a template only supplies items when applied, and changing one touches no
existing plan.

## What a plan is

One plan belongs to one **app** (one platform, see [apps](apps.md)) and one **version**, at most one
per app and version. `platform` is `"ios"`, `"android"` or `null` for a plan that covers both
platforms; it must be the app's own platform or `null` (`422 platform_mismatch` otherwise). The
platform decides the release notes limit (below). The iOS and Android apps of one product keep
their own plans; the web release page shows them side by side.

```json
{
  "plan": {
    "id": "c0a1…",
    "appId": "6f1c…",
    "appName": "Acme Mobile",
    "appPlatform": "ios",
    "appIdentifier": "com.acme.app",
    "version": "2.4.0",
    "platform": null,
    "targetDate": "2027-01-15",
    "blocked": false,
    "blockedReason": null,
    "notes": "Holiday launch",
    "createdBy": "u-1",
    "createdAt": 1799582400000,
    "updatedAt": 1799582400000,
    "released": false,
    "due": { "dueSoon": true, "overdue": false, "daysLeft": 3 },
    "readiness": {
      "ready": false,
      "required": { "total": 8, "done": 5, "open": 3 },
      "notes": {
        "limit": 500,
        "locales": 2,
        "filled": 1,
        "missing": ["de-DE"],
        "tooLong": [],
        "complete": false
      },
      "reasons": ["3 required items are not done.", "Release notes are missing for de-DE."]
    },
    "checklist": { "total": 10, "done": 5 },
    "rollout": null,
    "items": [
      {
        "id": "i-1",
        "position": 0,
        "text": "Privacy policy URL is set and opens",
        "required": true,
        "done": true,
        "doneBy": { "id": "u-2", "name": "Sam" },
        "doneAt": 1799583000000
      }
    ],
    "releaseNotes": [
      { "locale": "en-US", "text": "Bug fixes.", "length": 10, "updatedAt": 1799583100000 }
    ]
  }
}
```

- `items` and `releaseNotes` are only in the single plan (`GET .../plans/:planId` and every write).
  The lists return the same object without them (the counts in `readiness` and `checklist` stay).
- **Deadline flags** are computed on every read from the server clock (injectable in tests).
  The date is a calendar day compared in UTC: `dueSoon` is true from 3 days before the target date
  (today included) until the day is over; `overdue` is true once it is over. `daysLeft` counts whole
  days from today (UTC) to the date: 0 on the day, negative after. When the last sync saw this
  version `live` (`released: true`) both flags are false, since the deadline no longer matters.
  The flags are data; a reminder about a close or passed deadline is sent as an **event**
  (`plan.deadline_due_soon`, `plan.deadline_overdue`, see [events](events.md#plan-reminders)), never
  as email or a push notification. Checklist items have no due date of their own: the deadline of
  the checklist is the plan's target date.
- **Readiness** is a summary, not a gate: `ready` is true when every required item is done and the
  plan has at least one locale of release notes, all written (not empty) and within the limit.
  `reasons` says in plain sentences what is missing. The store runs its own checks too.
- `blocked` is a flag on the plan with a reason a person wrote (`blockedReason` is always set while
  blocked). It is not a lifecycle state.

## Plans

| Method and path                  | Right | Purpose                                                                                                        |
| -------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------- |
| `GET /plans`                     | read  | Every plan of the workspace (summaries), soonest target date first, plans without one last. For the dashboard. |
| `GET /apps/:id/plans`            | read  | The plans of one app (summaries)                                                                               |
| `POST /apps/:id/plans`           | write | Create a plan, `201 { plan }`                                                                                  |
| `GET /apps/:id/plans/:planId`    | read  | One plan with its items and release notes                                                                      |
| `PATCH /apps/:id/plans/:planId`  | write | Change the date, the blocked flag or the notes                                                                 |
| `DELETE /apps/:id/plans/:planId` | write | Delete a plan with its items and notes, `204`                                                                  |

Create body:

```json
{
  "version": "2.4.0",
  "platform": null,
  "targetDate": "2027-01-15",
  "notes": "Holiday launch",
  "templateId": "builtin:first-ios"
}
```

Only `version` is required. `version` is 1 to 64 characters: a letter or digit, then letters, digits
and `. _ + -`. `templateId` (a workspace template id or a `builtin:` id) fills the checklist.
Errors: `409 already_exists` (the app already has a plan for that version; the body has `planId`),
`422 platform_mismatch`, `404 template_not_found`, `404 not_found` (no such app).

Patch body (at least one field; the version and platform cannot change):

```json
{ "targetDate": "2027-02-01", "blocked": true, "blockedReason": "Waiting for legal", "notes": "…" }
```

`targetDate: null` clears the date. `blocked: true` needs a non-empty `blockedReason` (`422
reason_required`), which may already be stored; `blocked: false` clears the reason. The reason is at
most 500 characters, the notes at most 4000.

## Checklist

Items keep an order (`position`, 0 first). At most 100 per plan (`422 too_many_items`). Text is one
line, 1 to 300 characters.

| Method and path                      | Purpose                                                                                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /apps/:id/plans/:planId/items` | Add at the end: `{ "text": "…", "required": true }` (`required` defaults to false). `201 { plan, itemId }`                                                                  |
| `PATCH …/items/:itemId`              | Change `text`, `required` or `done`. Ticking records the user and the time; ticking an item that is already done keeps the first person and time; `done: false` clears them |
| `DELETE …/items/:itemId`             | Remove an item                                                                                                                                                              |
| `PUT …/items/order`                  | `{ "order": ["i-3", "i-1", "i-2"] }`: every item id of the plan exactly once, else `422 order_mismatch` (reload and retry)                                                  |
| `POST …/apply-template`              | `{ "templateId": "…" }`: appends the template's items the checklist does not have yet (same text). `200 { plan, added, skipped }`                                           |

Every one of them answers `{ "plan": … }` (the whole updated plan) unless noted.

## Release notes

One text per locale, drafts kept in our database (nothing is sent to a store).

| Method and path                             | Purpose                                                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `PUT /apps/:id/plans/:planId/notes/:locale` | `{ "text": "…" }`: adds the locale or replaces its text. An empty text adds the locale as "expected, not written yet" |
| `DELETE …/notes/:locale`                    | Remove the locale and its text                                                                                        |

A locale is `default` or a code such as `en-US`, `de`, `pt_BR` (`400` otherwise); at most 80 per
plan (`422 too_many_locales`). The text is checked against the store limit, counted in Unicode code
points like the listing rules: **4000 for a plan on iOS** (App Store "What's new"), **500 for a
plan on Android** (Play release notes) and **500 for a plan on both platforms** (the stricter one).
The limits come from `@kiln/core` (`releaseNotesLimit`, built on the listing rules). Too long gives:

```json
{
  "error": "notes_too_long",
  "message": "Release notes for en-US are 501 characters. Google Play allows 500.",
  "locale": "en-US",
  "limit": 500,
  "actual": 501
}
```

(status `422`, and nothing is saved).

## Staged rollout (planning data only)

A plan can carry a **rollout plan**: the steps a person intends to take after the release (for
example 1%, 5%, 20%, 50%, 100%), each with an optional planned time, a note and a status. **It is our
own planning data. Nothing here starts, changes, pauses or stops a rollout in App Store Connect or
Google Play, and nothing is read back into it by itself**: marking a step done only records that a
person says so. The web UI says this on the card.

| Method and path                          | Right | Purpose                                                                          |
| ---------------------------------------- | ----- | -------------------------------------------------------------------------------- |
| `GET /apps/:id/plans/:planId/rollout`    | read  | The rollout plan, with what the store last reported beside it                    |
| `PUT /apps/:id/plans/:planId/rollout`    | write | Set the plan (replaces the list of steps, or switches to Apple's phased release) |
| `DELETE /apps/:id/plans/:planId/rollout` | write | Remove the rollout plan and its steps                                            |
| `POST …/rollout/steps/:stepId/complete`  | write | Mark a step done. Optional body `{ "fromStore": true }`, see below               |
| `POST …/rollout/steps/:stepId/skip`      | write | Skip an open step                                                                |
| `POST …/rollout/steps/:stepId/reopen`    | write | Put a done or skipped step back to planned                                       |

Every one answers `{ "rollout": … }`. The plan itself (`GET .../plans/:planId` and the lists) carries
only a short `rollout` summary (`kind`, `total`, `done`, `skipped`, `planned`, `planPercent`,
`current`, `next`, `dueSteps`, `nextPlannedAt`), `null` when there is no rollout plan.

```json
{
  "rollout": {
    "planningOnly": true,
    "kind": "steps",
    "template": "builtin:play-default",
    "steps": [
      {
        "id": "s-1",
        "position": 1,
        "percent": 5,
        "plannedAt": 1799668800000,
        "note": "watch crash rate",
        "status": "done",
        "doneAt": 1799669000000,
        "doneBy": { "id": "u-2", "name": "Sam" },
        "doneSource": "manual",
        "due": false
      },
      {
        "id": "s-2",
        "position": 2,
        "percent": 20,
        "plannedAt": 1799755200000,
        "note": null,
        "status": "planned",
        "doneAt": null,
        "doneBy": null,
        "doneSource": null,
        "due": false
      }
    ],
    "apple": null,
    "summary": {
      "kind": "steps",
      "total": 2,
      "done": 1,
      "skipped": 0,
      "planned": 1,
      "planPercent": 5,
      "current": { "index": 1, "percent": 5 },
      "next": { "id": "s-2", "index": 2, "percent": 20, "plannedAt": 1799755200000 },
      "dueSteps": 0,
      "nextPlannedAt": 1799755200000
    },
    "store": {
      "platform": "android",
      "status": "rolling_out",
      "rawState": "inProgress",
      "fraction": 0.2,
      "syncedAt": 1799670000000,
      "percent": 20,
      "inferred": false
    },
    "comparison": {
      "verdict": "store_ahead",
      "mismatch": true,
      "planPercent": 5,
      "planStep": { "index": 1, "total": 2, "percent": 5 },
      "storePercent": 20,
      "halted": false,
      "confirmStepId": "s-2",
      "message": "Store says 20%, ahead of the plan: the plan has step 1 of 2 (5%) done. You can confirm the next step from the store."
    }
  }
}
```

- **Kinds.** `null` (no rollout plan), `steps` or `apple_phased`. Times are epoch milliseconds like
  everywhere else; `PUT` also accepts an ISO 8601 date-time with an offset.
- **`PUT` body, kind `steps`:** `{ "kind": "steps", "template": "builtin:play-default", "steps":
  [{ "id"?, "percent": 5, "plannedAt"?: …, "note"?: "…" }, …] }`. A step sent with an `id` keeps its
  status, who completed it and when; a step without one is new and open; a stored step that is left
  out is removed. `status`, `doneAt` and `doneBy` cannot be sent: they change only through the
  step routes. `template` is optional and only records where the plan started (an unknown id, or one
  that does not fit the app, is `422 template_not_found`).
- **Rules** (`422 invalid_rollout` with `issues: [{ path, message }]`, `path` like `steps.2.percent`):
  1 to 12 steps; each `percent` a whole number from 1 to 100, **strictly increasing** from one step
  to the next (so only the last can be 100, and the steps are in percentage order); `plannedAt` a
  real date-time **not before the plan was created** (a step that is already done keeps its time) and
  not earlier than the step above it; `note` one line of at most 200 characters; a step that is
  **done keeps its percentage and cannot be left out**; no open step may sit before a done step.
- **Templates in code** (`@kiln/core`: `ROLLOUT_TEMPLATES`): `builtin:play-default` (1, 5, 20, 50,
  100%; our suggestion, Play has no default and accepts any share), `builtin:immediate` (one step at
  100%) and `builtin:apple-phased`. They are not stored per workspace and cannot be edited.
- **Apple's phased release is informational.** Apple's schedule is fixed: **1, 2, 5, 10, 20, 50 and
  100% of users with automatic updates on days 1 to 7** (App Store Connect Help, "Release a version
  update in phases", checked when this was written; a phased release can also be paused for up to
  30 days, and the developer can release to everyone at any time). So `kind: "apple_phased"` has **no
  editable percentages and no steps**: `PUT { "kind": "apple_phased", "startsAt"?: … }` records the
  expected day 1, and `apple.schedule` lists the seven days (`date` is the UTC calendar day when
  `startsAt` is set). It is allowed only on an iOS app (`422 rollout_platform_mismatch`), and an iOS
  app may otherwise only plan a single step at 100%, since custom percentages cannot be done there.
  Switching from `steps` to the phased release needs the done steps reopened (`409
  rollout_has_done_steps`). **Our connector does not read Apple's phased release** (see
  [phase 2](../phase-2.md)), so for an iOS app the share Apple has reached is unknown: `store.percent`
  is `null`, `comparison.verdict` is `unknown`, and nothing is inferred, not even for a version that
  is `live`.
- **Moving a step.** `complete` needs the earlier steps done or skipped (`409 earlier_steps_open`);
  `skip` only works on an open step (`409 invalid_transition`); `reopen` needs no later step to be
  done (`409 later_steps_done`). Asking for the state a step is already in is accepted and changes
  nothing (no audit entry, no event). A step cannot move to the same state twice at once from two
  places: the write is guarded by the old status (`409 step_changed`, reload and try again).
  `409 no_rollout_steps` for a plan whose rollout is not `steps`.
- **Store next to plan.** `store` is what the **last sync** saw of this version (the snapshot in
  `app_releases`; no store call is made): on Google Play the production track, else a release that is
  rolling out or live. `percent` is the reported `rolloutFraction` as a percent; a Play release that
  is `live` with no share is 100% (`inferred: true`). `comparison` puts the plan's position (its last
  step that is done) beside it: `match`, `store_ahead`, `store_behind` (the last two are
  `mismatch: true`) or `unknown` (no synced release, no share, or Apple). A `halted` store state is
  reported in `halted` and the message. `store` and `comparison` are `null` when the plan has no
  rollout.
- **Confirm from the store.** The plan never marks a step done by itself. When the store's share has
  reached the first open step, `comparison.confirmStepId` names it and a person may call
  `complete` with `{ "fromStore": true }`: the step becomes `done` with `doneSource: "store"`, but
  only if the store's share is at least the step's percentage (`409 store_not_at_step`) and one is
  known (`409 store_share_unknown`). A plain `complete` records `doneSource: "manual"`. The body is
  optional (`{}` or none).
- **Limits:** bodies of 32 KB; a rollout plan is one row on the plan plus at most 12 step rows.

## Checklist templates

| Method and path                           | Purpose                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /checklist-templates`                | The templates that ship with the product, then the workspace's own by name                        |
| `POST /checklist-templates`               | `{ "name": "Hotfix", "items": [{ "text": "Smoke test", "required": true }] }`, `201 { template }` |
| `PATCH /checklist-templates/:templateId`  | Change `name` and/or `items`                                                                      |
| `DELETE /checklist-templates/:templateId` | `204`. Plans that used it keep their items                                                        |

```json
{
  "templates": [
    {
      "id": "builtin:first-ios",
      "name": "First iOS release",
      "description": "…",
      "builtin": true,
      "items": [{ "text": "Privacy policy URL is set and opens", "required": true }],
      "createdAt": null,
      "updatedAt": null
    },
    {
      "id": "7d2c…",
      "name": "Hotfix",
      "description": null,
      "builtin": false,
      "items": [{ "text": "Smoke test", "required": true }],
      "createdAt": 1799583000000,
      "updatedAt": 1799583000000
    }
  ]
}
```

- **Shipped templates** are `builtin:first-ios`, `builtin:first-android` and
  `builtin:routine-update`. They are defined in `@kiln/core` (`DEFAULT_CHECKLIST_TEMPLATES`), not
  stored per workspace, so every workspace has them, they improve with an upgrade, and they cannot
  be changed or deleted (`409 builtin_template`). To change the wording, save your own template.
  The first-release lists cover the privacy policy URL, screenshots, export compliance (iOS),
  content rating or age rating, the data safety form (Android), test account for review and
  release notes and "what's new" for every locale. They follow what the stores ask for before a first
  release; the store console is the authority.
- A name is unique per workspace (`409 already_exists`), 1 to 100 characters on one line. 1 to 100
  items. At most 50 saved templates per workspace (`422 too_many_templates`).

## Limits

Bodies: 32 KB on plan, checklist and notes routes, 64 KB on template routes, 1 MB everywhere
(`413 payload_too_large`).

## Audit

`plan.create`, `plan.update`, `plan.delete`, `plan.apply_template`, `plan.notes_set`,
`plan.notes_delete`, `checklist.item_add`, `checklist.item_update`, `checklist.item_delete`,
`checklist.reorder`, `plan.rollout_set`, `plan.rollout_clear`, `plan.rollout_step_done`,
`plan.rollout_step_skipped`, `plan.rollout_step_reopened`, `checklist_template.create`,
`checklist_template.update` and `checklist_template.delete`, with the target `release_plan` (or
`checklist_template`). A reminder sent by the server is audited as `plan.reminder` with the actor
type `system` and id `plan.reminders` (a background job has no person; the sync job's `app.sync` is
the same convention). `plan.rollout_set` records the kind, the template and the percentages, never a
note.
`plan.notes_set` records the locale and the length of the text, never the text; `checklist.item_add`
records the text of the new item. A change that changes nothing, and a refused request, writes no
audit entry. Moving a rollout step and the reminders also emit events (`plan.rollout_step_done`,
`plan.rollout_step_skipped`, `plan.rollout_step_reopened`, `plan.deadline_due_soon`,
`plan.deadline_overdue`, `plan.rollout_step_due`): see [events](events.md). Nothing else here emits
an event, and no email or push notification exists.

## Data

Tables `release_plans`, `checklist_items`, `release_notes` and `checklist_templates` (migration 11 when this was written; see `packages/db/src/migrations.ts`).
Migration 15 adds `release_plans.rollout_kind`, `rollout_template` and `rollout_start_at`, the table
`plan_rollout_steps` (a row per step, so a step's state change is one guarded `UPDATE` and the
reminder scan finds due steps by an index instead of parsing every plan) and `plan_reminders` (the
reminder log, below). Postgres has **not** run them.
`release_plans.app_id` has no foreign key, so deleting an app stays possible; the plans of a deleted
app are not shown. `purgePlansOfApp` in `apps/server/src/services/plans.ts` removes them and is
meant to be called from the app deletion (it is not wired in yet).
