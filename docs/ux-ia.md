# UX and information architecture (proposal)

Status: proposal from the revised mockups on the design canvas (R1 to R8). Nothing here is built.
It replaces "portfolio, then one app with tabs". Visual language stays as in design-system.md.

## 1. IA tree

```
All apps (workspace)                 left rail
  Apps                               overview: one row per app, iOS and Android merged
  Reviews                            inbox across apps
  Releases                           cross-app calendar, rollouts in flight
  Builds and CI
  Repositories
  Credentials
  Members
  API tokens and webhooks
  Audit log
  Settings                           workspace: low-rating threshold, translation provider, retention

App (entering an app replaces the whole left panel)
  header: app switcher, icon, name, bundle ids, "All apps" link back
  Dashboard
  Releases
  Store listing
  Assets                             icon / Google Play graphics / screenshots
  Reviews
  Builds and CI
  Repository                         link, local clone, change sets
  Settings                           stores and credentials, repository targets, release defaults,
                                     notifications, danger zone
```

Top right of every app page: the platform control `iOS | macOS | Android | Both` (`All` from three platforms; generic glyphs, no
brand logos) and, on listing, assets, dashboard and releases, a "Staged changes" button.

## 2. Platform scope rules

- An app is one entity with up to three platforms (iOS, macOS, Android). Each platform is a separate app
  row; the web layer merges them (data model decision: an app group with one record per platform). An iOS
  and a macOS record are the same App Store Connect app when they share the App Store id (universal
  purchase) and may or may not share the bundle id; they merge by identifier, then by name.
- `Both` (`All` with three platforms) is the default when the app has several platforms. Lists show merged rows; every row that
  belongs to one platform carries a platform chip (glyph plus the word iOS or Android).
- `iOS` or `Android` shows only that store: columns, rows, counts and the staged tray follow it.
- An app with one platform shows the control with the missing options disabled and a reason
  ("This app is not on that store"); `Both` is disabled. The macOS option is quiet by default: it
  exists only for an app with a macOS record, and an app with a macOS record shows only the platforms
  it has. Adding the platform is in Settings ("Add the macOS version" on an iOS app).
- Customer reviews belong to the App Store Connect app, so they are read and triaged under iOS; the
  macOS tab says so and links there (the server answers `reviews_shared` for the macOS record).
- Fields that exist on one store only are labelled "iOS only" or "Android only" (subtitle,
  keywords, promotional text: iOS; short description, feature graphic, promo graphic, TV banner:
  Android). Shared fields with different limits show one counter per store (what is new: 4000 vs 500).

## 3. Where does data live (chips on every page header)

| Chip | Meaning |
| --- | --- |
| Repository | Files in the linked repository (fastlane metadata, images). Source for edits. |
| Store live | What the store serves or reports now. Read from the connector. |
| Store draft | The editable, unpublished version in the store (App Store Connect prepare-for-submission version, Google Play edit). |

Other chips: "Triage stored here" (internal notes and status), "Planning data only", and
"Store write, gated" (see section 5).

## 4. Staged-changes model

Edits to listing fields and assets are collected in one tray per app, shared by Store listing and
Assets. Pushing is separate from submitting.

1. Edit locally (field edit, replaced file, reordered screenshot). Items join the tray.
2. Push to the store as a draft, per store, in one batch:
   - App Store Connect: values are written to the editable version (Prepare for submission).
     If no editable version exists, the tray says so and offers to create the next one (a store
     write). Nothing is submitted.
   - Google Play: all items are collected in one Play edit, validated, and committed once. The
     option "commit as changes not sent for review" is offered where the API allows it for the
     app; otherwise the tray says what the commit will do.
3. Submit or publish is a separate, explicit step on Releases (submit for review, send for review,
   release). The tray never does it.
4. Repository direction: "Commit to branch" or "Open PR" writes the edits as files; "Pull from
   store into repo" brings store values back (existing change set flow).

Per item status: in repo only, in store only, both and identical, differs, invalid (with the exact
rule, for example "1024 by 500 px"). Invalid items cannot be staged.

## 5. Store writes (gated) vs planning data

| Control | Kind | Gate |
| --- | --- | --- |
| Increase Android staged rollout %, halt, resume, release to 100% | store write | `MRM_STORE_ROLLOUT_ENABLED` (server done, [api/rollout](api/rollout.md); screens not built) |
| Apple phased release: pause, resume, release to all | store write | `MRM_STORE_ROLLOUT_ENABLED` (server done, [api/rollout](api/rollout.md); screens not built) |
| Push listing text as draft | store write | `MRM_STORE_DRAFT_WRITE_ENABLED` (server done, [api/staged-changes](api/staged-changes.md); screens not built) |
| Push assets as draft | store write | `MRM_STORE_DRAFT_WRITE_ENABLED` (same switch and route; server done; screens not built) |
| Release (App Store version, or a Google Play draft release at a share) | store write, irreversible | `MRM_STORE_RELEASE_ENABLED` and `store.release` (server done, [api/releases-write](api/releases-write.md); screens not built: pick build or codes, edit fields, preview, a typed confirmation that names the share) |
| Submit the pushed draft for store review | store write, irreversible | `MRM_STORE_SUBMIT_ENABLED` and `store.submit` (server done, [api/submit](api/submit.md); screens not built: preview, checks, then a typed confirmation) |
| Reply to a review | store write | `MRM_REVIEW_REPLY_ENABLED` (exists), plus the credential role |
| Commit or push to a local clone | repository write | `MRM_LOCAL_REPO_WRITE` (exists) |
| Rollout step plan, mark step done, reminders, checklist | planning data | none |
| Triage status, assignee, note | internal data | role `reviews.triage` |

Every store write asks for confirmation with the sentence "This changes the live store" (or, for a
reply, "This will be published publicly in the store"), names the store, app, version and the
exact change, and is audited. Reply text is never logged.

## 6. Gaps in the current web app, per screen

Based on `apps/web/src` and `docs/` at the time of writing. Check the working tree before relying on
an item marked "in progress".

- Shell and navigation: one flat list (Portfolio, Repositories, Credentials, Members, API tokens,
  Webhooks, Audit). No per-app shell, app switcher, all-apps reviews, releases or builds level, no
  platform control, no Staged changes tray. Builds and CI and Repository live inside app detail.
- All apps overview: apps are listed one platform per row (`AppTable`). No merged row, no rating or
  unanswered-review columns, no problems column, no summary strip, no sort or filter on state.
- App dashboard: nothing equivalent. The portfolio board shows releases by status, not per app.
- Releases: release detail is a page of panels. Rollout is planning data only: no store write
  (increase, halt, resume, release to 100%) and Apple phased release is read-only. No compact
  table of releases per platform with expandable rows. No store-versus-plan comparison on one row.
- Store listing: pull from store into repo exists (change sets). Missing: locale grid with
  per-field completeness and drift dots, locale search and bulk select, Store draft column, push
  to store as draft, per-store tray, character counters per store for shared fields,
  copy between locales.
- Assets: a read-only index checked against documented specs. Missing: comparison with the store
  ("not yet compared"), replace, upload, delete, reorder, copy to locale, sync in either
  direction, per-item status, bulk actions. Today it sits in a tab, not in a group of three.
- Reviews: read side, triage, rating overview exist. Translation and reply dialog are in progress
  in the working tree. Missing: side-by-side original and translated view with provider shown,
  an all-apps inbox, "reply disabled" explanation per store, assigned-to-me and needs-translation
  filters.
- Settings: credentials, repositories and webhooks are workspace pages. No per-app settings page
  (stores, listing targets, release defaults, notifications, danger zone) and no workspace
  settings page for threshold, translation provider and retention (API exists in part).

Open: merge apps in the data model or only in the web layer (pair records on bundle id); names of the
new flags; whether Google Play "changes not sent for review" works for the connected apps (verify).
