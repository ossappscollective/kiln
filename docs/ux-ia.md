# UX and information architecture (proposal)

Status: sections 0 to 0c are built (shell, page internals, collapsible sections, workspace Settings views). Sections 1 to 6 are the
original proposal from the mockups on the design canvas (R1 to R8), kept as rationale; where they disagree with sections 0 to 0c,
those win. It replaced "portfolio, then one app with tabs". Visual language stays as in design-system.md.

## 0. Shell and navigation, phase 1 (built)

An audit of the running app found a header that took a third of every app page, the same control in two places (Sync, Start
release, Prepare release) and the same state said four times. Phase 1 changes the shell only; the page internals are unchanged
(phase 2: Store listing, Reviews and Insights). Pure logic: `apps/web/src/lib/app-nav.ts`, `next-step.ts`, `app-page.ts`, `demo.ts`.

- **Left panel of an app** (`AppNav`): the app switcher on top (search as you type, Cmd or Ctrl + K), then exactly six entries:
  Overview, Releases, Store listing, Reviews, Insights, Builds. At the bottom: All apps, Inbox, Settings, and a collapsed "More"
  with Repositories, Credentials, Members, API tokens, Webhooks, Audit log and the other workspace pages the role may open.
  App settings (stores, credentials) is the gear in the page header and the link in the Status popover.
- **Readable pass, left panel and overview (2026-11-20, [readability](design/readability.md))**: the panel opens with one soft card, the
  app (icon, name, switcher) and one line per platform with its tint, name and state ("iOS In review 2.9.0", "Android Live 2.8.1";
  `lib/app-status.ts`, from the releases the app screen loaded: `navSignals.setReleases`). Groups are labelled "This app" and
  "Workspace". Counts say what needs you: Releases (left unfinished), Store listing (changes waiting to publish), Reviews (unanswered),
  All apps (apps that need attention), Inbox (unanswered, workspace). The current page has a bar, a tint and a heavier label. Text is 15px.
  The header of an app page is the page name (24px) over the app name and bundle id.
- **Views inside a page** (`ViewSwitch`, `?view=` in the address, platform, version and locale stay): Store listing = Text, Graphics;
  Insights = Overview, Keywords, Search terms (phase 2, see 0a); Builds = Builds,
  Workflows, Test builds.
- **Old addresses redirect** (`canonicalAppHash`, replaces the history entry): `/workflows` to `/builds?view=workflows`,
  `/test-builds` to `/builds?view=tests`, `/assets` to `/listing?view=graphics`, `/analytics` to `/insights`, `/aso[?view=x]` to
  `/insights?view=keywords|x`. `/pending`, `/settings` and `/release/<version>` stay. The `g` chords keep their letters
  (`g i` is Insights; `g a`, `g o`, `g n`, `g w`, `g t` still work through the redirects).
- **One slim header per page** (`AppShell`): page name and app name, the platform control (only for an app on several platforms, not
  on app settings), the version and locale pickers only on Releases and Store listing, and a **Status** button (`StatusPopover`) that
  holds the Repository and Store live chips, each store record with its full bundle id (wraps, never truncated), the last sync and the
  one **Sync now** action.
- **Pending bar** (`PendingBar`): while an app has changes waiting, one quiet strip under the header on every app page, "N changes
  waiting. Nothing is published until you review them." and one "Review and publish" button to `/pending`. Hidden with nothing pending
  and on the pending page. Pending changes is not a navigation entry any more. The bar is no longer yellow (a blocking error keeps the
  warning colour). **On the Overview it is not a bar:** the changes are one link under the primary button of the Next step card
  ("2 changes waiting. Review and publish", `pendingPlacement` in `lib/app-page.ts`); a blocking error stays a bar there too.
- **Next step card** (`NextStep`, Overview and Releases): one primary button chosen by state, in this order: a release whose step
  failed (rejected), a release that waits for you (finish, attach a build, release it), a release in store review (quiet "Start release"
  beside it), then with nothing on its way "Start release" (or "Prepare release" without a linked repository). The five release steps,
  the other releases on their way are inside the card ("Your next step", 30px title, one large button); on the Overview the rest of "Needs attention" is its own card "Also worth a look" under the platform cards (Releases keeps it in the card), so the old "waiting for you" strip, the separate
  "Needs attention" card and the Prepare release / Open the release steps buttons are gone. Overview then shows the platform
  cards side by side (tint on the left edge, name, what is on the store, the version in flight with its status, "Open releases") and a collapsed Details (bundle ids, last sync, analytics).
  **Promote** ([ADR 0025](adr/0025-play-release-checks.md)): on an Android app a release that serves users from a track that is not production
  gets "Promote to production" in its Releases row (platform cell), in the row's details and as one quiet line in the Next step card. It
  opens Prepare release on the Build step with the source track, the target and the version codes selected (`&from=internal&to=production&codes=241`).
  In the Confirm step and in the release dialog "Check this release" shows local checks and "Check with Google Play" (errors only: the result says
  "Google found no errors. The Play Console may still show warnings", never "no warnings").
- **Demo bar**: when `GET /demo/status` answers `demo: true` (only the `pnpm demo` server has that route), a slim, permanent bar says
  "Demo workspace — simulated stores, nothing leaves your machine" above the top bar.

## 0a. Page internals, phase 2 (built)

Same principles as phase 1: quiet by default, the important thing first, one primary action, sentence case, no id is cut off, fine at
800 px, no new navigation entries. Pure logic: `reviews-toolbar.ts`, `app-nav.ts` (`insightsViewOf`), `aso.ts` (`keywordMainViews`,
`keywordMoreViews`), `analytics-view.ts` (`splitHeadline`), `listing-matrix.ts` (`listingStatusLine`, `listingContext`),
`app-overview.ts` (`rowStatus`), `popover-place.ts`.

- **Reviews** (per app and the inbox): one slim line of numbers (average, stars, stored count, trend word, a tiny weekly sparkline,
  "About the numbers" with the distribution, versions and the basis of each figure), then one toolbar row: search, the status chips
  New / Triaged / Replied / Ignored with counts (the inbox counts only New), and a Filters popover (rating, low ratings only, sort,
  developer response, language, country, version, written; the inbox adds store, assignee, apps; the translation toggle lives
  there). The list and the detail view start right under the toolbar. Triage behaviour (`reviews.ts`, `review-split.ts`) is unchanged.
  The inbox is the **combined reviews feed** for "follow the reviews of iOS and Android in one place": every app and both stores,
  newest first, with the app name and a store badge on each review, "Load more" paging and an "Open app" link to the app's own Reviews
  page (where the reply dialog lives). It is the "Inbox" entry at the All apps level, not an item of the six-item app rail. A new
  review can also raise the alert `review.new` (inbox only by default; [alerts](alerts.md)).
- **Insights** has three views. Overview: the figures and ONE chart (downloads, or installs on Google Play; the others behind "More
  charts"), then the ranked ASO next steps (two per platform, "Show all") and any open AI suggestions, then the sources. Keywords:
  a switch of Keywords and Rank and downloads, and a "More" menu with the rest. Search terms: Google Play apps only.
  Every old address still works and redirects once (`canonicalAppHash`).

  | Address (`?view=`)                                          | Now                                                                     |
  | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
  | none, `analytics`, `overview`                               | Insights, Overview                                                      |
  | `aso`, `keywords`                                           | Keywords, Keywords (written `keywords`)                                 |
  | `rank`                                                      | Keywords, Rank and downloads                                            |
  | `listing`, `competitors`, `ideas`, `fit`, `gaps`, `markets` | Keywords, More menu entry of that name                                  |
  | `terms`                                                     | Search terms (an app with no Google Play record falls back to Keywords) |
  | `/aso`, `/aso?view=x`, `/analytics`                         | redirect to `/insights?view=keywords                                    | x`, `/insights` |

- **Keywords your listing uses now** (Insights, Keywords, first block; `UsedKeywords.svelte`, `keyword-use.ts`, `listing-edit.ts`): per app and
  one locale at a time, what the STORED listing says today. App Store: the 100 byte keyword field plus the words and phrases of the name
  (shown as "title") and subtitle. Google Play has no keyword field, so the words and phrases of the title, short description and full
  description are DERIVED by the tool and the view says so. Each keyword shows where it appears (title, subtitle, keyword field,
  description), whether it is tracked and its latest rank, and (Google Play, when a Play Console search terms file was imported) the
  visitors that came from searching it (not search volume). "Track" is one click (the existing keywords endpoint); "Edit" opens the
  field editor on that field and locale. A locale with no stored text gets an empty state that points to Sync. The tracker is below it.
- **Field editor** (`FieldEditor.svelte`): one dialog for one field of one locale (title or name, subtitle, short description, keyword
  field, promotional text, description). A live counter against the store's limit (characters, bytes for the keyword field), the store
  text and the new text side by side with the changes marked, "Suggest with AI" (before and after, then Stage or Dismiss), "Copy text"
  and "Stage in <field>". Staging saves in our own database; a push to a store stays the gated step of the tray. It opens from the pencil
  in each cell of the Store listing grid, from "Edit" on each field of the locale drawer (kept), from the Keywords view and from "Stage in
  title" under an AI keyword idea. The App Store name and subtitle cannot be written by a draft push: their editor is for working the text
  out and copying it, and says so.
- **Store listing** (Text view): the context line (stores and locale count) and ONE status line ("3 locales need attention, 1 with
  missing fields", with "Show them"), then the toolbar: locale filters, search, "Legend and sources" (legend, where each side was
  read) and a "More" menu (Read repository, Pull differences). The matrix header and the locale column are sticky inside the grid.
  There is no second Sync button: the page says "Open Status to sync" and opens the Status popover (`openStatusPopover`).
- **All apps**: App (name, bundle id, rating), Platforms (every platform with its name and latest version), Status (the status pill,
  one per platform in flight, each named), Next (ONE action, `rowNextAction`: fix the rejection, check the sync, finish the release,
  release it, review pending, read new reviews, or a dash) and Last synced with its button. Pending, unfinished and new reviews are
  not separate badges any more. See `docs/design/readability.md`.
- **Overview** details are one group per platform. `PipelineStrip` is gone (the Next step card replaced it). The ASO and test build
  addresses used by the app (`asoViewHref`, `testBuildsHref`) point at the new places, so they do not redirect.
- **Popovers** (InfoTip, the app switcher, the version picker, menus, the account menu) are drawn by the `floating` action
  (`lib/floating.ts`): the native top layer (`popover="manual"`) plus `position: fixed`, placed by `placePopover`: clamped to the
  window, above the anchor when there is no room below, scrolling inside when tall. No container with `overflow` or a transform can
  clip them.

## 0b. Collapsible sections, scroll and app switching, phase 3 (built)

Pure logic: `section-state.ts`, `scroll-keep.ts`, `app-switcher.ts` (`appSwitchHash`), `review-split.ts` (`splitLayout`),
`virtual-anchor.ts`; the host is `section-host.svelte.ts`.

- **Collapsible sections** (`ui/Section.svelte`, one primitive; `Card` and `SettingsCard` take it with `collapseKey`): the head is a button
  inside the heading (`aria-expanded`, Enter and Space), with a count chip and, while collapsed, a one-line summary ("12 locales · 3 need
  attention"). The state is remembered per workspace, person, page and section key in `localStorage` (`kiln.sections.v1:...`, in a
  try/catch; storage that refuses means the default). A page is `listing.text`, `insights.keywords`, `reviews`... not the app, so a choice
  holds for every app. `SectionsToggle` ("Collapse all" or "Expand all") appears from three sections on a page. The body is not drawn while
  collapsed. Applied to: Store listing (locales grid, the sections beyond the texts, graphics per locale, problems, checks), Releases
  (current, older), Builds, Test builds, Workflows and runs, Insights (each chart, more charts, next steps, sources), Reviews summary,
  App and workspace Settings cards (danger zone starts closed), Pending changes (per kind), Credentials, Audit (per day), Overview details,
  and the per platform blocks of the Keywords sub-views (Next steps, Fit, Gaps and the others).
  Not yet: `Disclosure` (kept for notes; its state is in memory only).
- **Scroll**: only a different route path (`shouldResetScroll`: page, app, opened release) scrolls to the top. A change of the query alone
  (`?view=`, `?platform=`, `?version=`, `?locale=`, filters) keeps the position, and the shell keeps the page height while the new view
  loads, because a short placeholder used to clamp the scroll position. No component is keyed on the address.
- **Changing app keeps the page** (`appSwitchHash`): the left panel switcher, Cmd or Ctrl + K and Cmd or Ctrl + digit open the same
  page of the other app. The view and the platform scope carry over when valid there (Search terms needs a Google Play record, a scope
  the app does not have becomes all platforms); version, locale and an open release are dropped; a page the role cannot open, and every
  address that is not an app, open the Overview.
- **Reviews at 800 to 1100 px**: the list takes the whole width and the review opens as a drawer from the right (Escape or Close shuts
  it, j and k keep moving). From 1100 px it stays side by side, below 800 px the cards.
- **All apps, Board**: one status pill per card plus the "N pending" badge; the deadline and rollout plan are quiet text unless late.
- **Tooltips and chart tips** are drawn by the `floating` action (top layer), centred or beside the crosshair; nothing clips them.

## 0c. Workspace Settings in views (built)

`#/settings` was one list of twelve cards. It is now four views behind the same small segmented control (`ViewSwitch`), kept in the
address as `?view=`. Pure logic: `settings-views.ts` (`settingsViews`, `settingsViewOf`, `resolveSettingsView`, `withSettingsView`).

| Address                                 | View      | Cards                                                                             |
| --------------------------------------- | --------- | --------------------------------------------------------------------------------- |
| `#/settings` (also an unknown `?view=`) | General   | Reviews, Releases, Translation                                                    |
| `#/settings?view=analytics`             | Analytics | the opt-in, the Apple vendor number, the Play bucket                              |
| `#/settings?view=security`              | Security  | Security: confirm hard actions, Recovery codes, Authenticator app and email, Mail |
| `#/settings?view=ai`                    | AI        | AI assistant (with "What is sent" per task), Connect an AI assistant              |

- General is the default and is not written, so the old address keeps working. The links from Analytics ("Open Settings", the Play bucket
  link) open the Analytics view.
- Role gating is unchanged. A role without `settings.read` only gets the AI view (Connect an AI assistant is open to every role; the AI
  assistant card needs `ai.use`), and with a single view there is no switch.
- General and Analytics are one form with one state, held by the page, and one "Save settings" bar (with "Discard changes") under the
  open form view. A switch of view keeps what was typed. On Security and AI a note says that changes are still waiting in General or
  Analytics, with a link. A save that is blocked by a value on the other form view says which view to fix. The AI assistant card and
  the Security cards keep their own saves.
- Sections keep their collapse state (keys unique per card, page `settings`); "Collapse all" appears from three sections on a view.
  The scroll position stays across a switch of view (query-only change, section 0b).

## 1. IA tree (original proposal; the built navigation is in section 0)

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

| Chip        | Meaning                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| Repository  | Files in the linked repository (fastlane metadata, images). Source for edits.                                        |
| Store live  | What the store serves or reports now. Read from the connector.                                                       |
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

| Control                                                                               | Kind                      | Gate                                                                                                                                  |
| ------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Increase Android staged rollout %, halt, resume, release to 100%                      | store write               | `KILN_STORE_ROLLOUT_ENABLED` (server done, [api/rollout](api/rollout.md))                                                             |
| Apple phased release: pause, resume, release to all                                   | store write               | `KILN_STORE_ROLLOUT_ENABLED` (server done, [api/rollout](api/rollout.md))                                                             |
| Push listing text as draft                                                            | store write               | `KILN_STORE_DRAFT_WRITE_ENABLED` (server done, [api/staged-changes](api/staged-changes.md))                                           |
| Push assets as draft                                                                  | store write               | `KILN_STORE_DRAFT_WRITE_ENABLED` (same switch and route; server done)                                                                 |
| Release (App Store version, or a Google Play draft release at a share)                | store write, irreversible | `KILN_STORE_RELEASE_ENABLED` and `store.release` (server done, [api/releases-write](api/releases-write.md))                           |
| Submit the pushed draft for store review                                              | store write, irreversible | `KILN_STORE_SUBMIT_ENABLED` and `store.submit` (server done, [api/submit](api/submit.md))                                             |
| Publish several steps at once (push draft, submit, release, rollout) after one review | store write, irreversible | `KILN_STORE_PUBLISH_BATCH_ENABLED`, `store.publish` and each step's own switch and right (server done, [api/pending](api/pending.md)) |
| See everything an app has pending; which apps have pending changes                    | read only                 | `listing.read` (server done, [api/pending](api/pending.md))                                                                           |
| Reply to a review                                                                     | store write               | `KILN_REVIEW_REPLY_ENABLED` (exists), plus the credential role                                                                        |
| Commit or push to a local clone                                                       | repository write          | `KILN_LOCAL_REPO_WRITE` (exists)                                                                                                      |
| Rollout step plan, mark step done, reminders, checklist                               | planning data             | none                                                                                                                                  |
| Triage status, assignee, note                                                         | internal data             | role `reviews.triage`                                                                                                                 |

The screens for these exist (rollout controls on a release, the publish dialogs, Pending changes). Every store write asks for confirmation with the sentence "This changes the live store" (or, for a
reply, "This will be published publicly in the store"), names the store, app, version and the
exact change, and is audited. Reply text is never logged.

## 6. Gaps in the web app, per screen (historical)

This list was written before sections 0 to 0c and describes the app as it was then, not today. Do not use it as a status report.

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
