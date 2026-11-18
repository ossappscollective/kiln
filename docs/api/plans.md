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

| Action | viewer | member | admin / owner |
| --- | --- | --- | --- |
| `plans.read`: read plans, checklists, release notes and templates | yes | yes | yes |
| `plans.write`: create, change and delete plans, checklists, notes and templates | no | yes | yes |

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
        "limit": 500, "locales": 2, "filled": 1,
        "missing": ["de-DE"], "tooLong": [], "complete": false
      },
      "reasons": ["3 required items are not done.", "Release notes are missing for de-DE."]
    },
    "checklist": { "total": 10, "done": 5 },
    "items": [
      {
        "id": "i-1", "position": 0, "text": "Privacy policy URL is set and opens",
        "required": true, "done": true,
        "doneBy": { "id": "u-2", "name": "Sam" }, "doneAt": 1799583000000
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
  No reminder or notification is sent; this is data only.
- **Readiness** is a summary, not a gate: `ready` is true when every required item is done and the
  plan has at least one locale of release notes, all written (not empty) and within the limit.
  `reasons` says in plain sentences what is missing. The store runs its own checks too.
- `blocked` is a flag on the plan with a reason a person wrote (`blockedReason` is always set while
  blocked). It is not a lifecycle state.

## Plans

| Method and path | Right | Purpose |
| --- | --- | --- |
| `GET /plans` | read | Every plan of the workspace (summaries), soonest target date first, plans without one last. For the dashboard. |
| `GET /apps/:id/plans` | read | The plans of one app (summaries) |
| `POST /apps/:id/plans` | write | Create a plan, `201 { plan }` |
| `GET /apps/:id/plans/:planId` | read | One plan with its items and release notes |
| `PATCH /apps/:id/plans/:planId` | write | Change the date, the blocked flag or the notes |
| `DELETE /apps/:id/plans/:planId` | write | Delete a plan with its items and notes, `204` |

Create body:

```json
{ "version": "2.4.0", "platform": null, "targetDate": "2027-01-15", "notes": "Holiday launch",
  "templateId": "builtin:first-ios" }
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

| Method and path | Purpose |
| --- | --- |
| `POST /apps/:id/plans/:planId/items` | Add at the end: `{ "text": "…", "required": true }` (`required` defaults to false). `201 { plan, itemId }` |
| `PATCH …/items/:itemId` | Change `text`, `required` or `done`. Ticking records the user and the time; ticking an item that is already done keeps the first person and time; `done: false` clears them |
| `DELETE …/items/:itemId` | Remove an item |
| `PUT …/items/order` | `{ "order": ["i-3", "i-1", "i-2"] }`: every item id of the plan exactly once, else `422 order_mismatch` (reload and retry) |
| `POST …/apply-template` | `{ "templateId": "…" }`: appends the template's items the checklist does not have yet (same text). `200 { plan, added, skipped }` |

Every one of them answers `{ "plan": … }` (the whole updated plan) unless noted.

## Release notes

One text per locale, drafts kept in our database (nothing is sent to a store).

| Method and path | Purpose |
| --- | --- |
| `PUT /apps/:id/plans/:planId/notes/:locale` | `{ "text": "…" }`: adds the locale or replaces its text. An empty text adds the locale as "expected, not written yet" |
| `DELETE …/notes/:locale` | Remove the locale and its text |

A locale is `default` or a code such as `en-US`, `de`, `pt_BR` (`400` otherwise); at most 80 per
plan (`422 too_many_locales`). The text is checked against the store limit, counted in Unicode code
points like the listing rules: **4000 for a plan on iOS** (App Store "What's new"), **500 for a
plan on Android** (Play release notes) and **500 for a plan on both platforms** (the stricter one).
The limits come from `@mrm/core` (`releaseNotesLimit`, built on the listing rules). Too long gives:

```json
{ "error": "notes_too_long", "message": "Release notes for en-US are 501 characters. Google Play allows 500.",
  "locale": "en-US", "limit": 500, "actual": 501 }
```

(status `422`, and nothing is saved).

## Checklist templates

| Method and path | Purpose |
| --- | --- |
| `GET /checklist-templates` | The templates that ship with the product, then the workspace's own by name |
| `POST /checklist-templates` | `{ "name": "Hotfix", "items": [{ "text": "Smoke test", "required": true }] }`, `201 { template }` |
| `PATCH /checklist-templates/:templateId` | Change `name` and/or `items` |
| `DELETE /checklist-templates/:templateId` | `204`. Plans that used it keep their items |

```json
{ "templates": [
  { "id": "builtin:first-ios", "name": "First iOS release", "description": "…", "builtin": true,
    "items": [{ "text": "Privacy policy URL is set and opens", "required": true }], "createdAt": null, "updatedAt": null },
  { "id": "7d2c…", "name": "Hotfix", "description": null, "builtin": false,
    "items": [{ "text": "Smoke test", "required": true }], "createdAt": 1799583000000, "updatedAt": 1799583000000 }
] }
```

- **Shipped templates** are `builtin:first-ios`, `builtin:first-android` and
  `builtin:routine-update`. They are defined in `@mrm/core` (`DEFAULT_CHECKLIST_TEMPLATES`), not
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
`checklist.reorder`, `checklist_template.create`, `checklist_template.update` and
`checklist_template.delete`, with the target `release_plan` (or `checklist_template`).
`plan.notes_set` records the locale and the length of the text, never the text; `checklist.item_add`
records the text of the new item. A change that changes nothing, and a refused request, writes no
event. No webhook or notification is emitted.

## Data

Tables `release_plans`, `checklist_items`, `release_notes` and `checklist_templates` (migration 11 when this was written; see `packages/db/src/migrations.ts`).
`release_plans.app_id` has no foreign key, so deleting an app stays possible; the plans of a deleted
app are not shown. `purgePlansOfApp` in `apps/server/src/services/plans.ts` removes them and is
meant to be called from the app deletion (it is not wired in yet).
